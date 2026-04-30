const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { generateAlphaCode, normalizePhone, getCentralNow, getCentralOffsetSql } = require('../utils');

// Skip privacy-redacted or empty addresses (e.g., "*** *** Privacy *** -***")
function isPrivacyAddress(addr) {
  if (!addr) return true;
  const s = addr.trim();
  return s.length < 4 || s.includes('***') || s.toLowerCase().includes('privacy');
}

// ===================== PRECINCT BOUNDARIES =====================

// Load precinct GeoJSON for point-in-polygon checks
let _precinctFeatures = null;
function getPrecinctFeatures() {
  if (_precinctFeatures) return _precinctFeatures;
  try {
    const geojsonPath = path.join(__dirname, '..', 'public', 'cameron-precincts.geojson');
    const data = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
    _precinctFeatures = data.features || [];
    console.log('[walks] Loaded', _precinctFeatures.length, 'precinct boundaries from GeoJSON');
  } catch (e) {
    console.warn('[walks] Could not load precinct GeoJSON:', e.message);
    _precinctFeatures = [];
  }
  return _precinctFeatures;
}

// Ray-casting point-in-polygon test
function pointInPolygon(lat, lng, polygon) {
  // polygon is an array of rings; first ring is the outer boundary
  const ring = polygon[0];
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1], yi = ring[i][0]; // GeoJSON is [lng, lat]
    const xj = ring[j][1], yj = ring[j][0];
    if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Check if a point falls inside any of the given precinct polygons
function pointInPrecincts(lat, lng, precinctIds) {
  const features = getPrecinctFeatures();
  const targetSet = new Set(precinctIds.map(String));
  for (const f of features) {
    if (!targetSet.has(String(f.properties.precinct))) continue;
    const geom = f.geometry;
    if (geom.type === 'Polygon') {
      if (pointInPolygon(lat, lng, geom.coordinates)) return true;
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (pointInPolygon(lat, lng, poly)) return true;
      }
    }
  }
  return false;
}

// ===================== HELPERS =====================

// Fetch election votes in chunks of 500 to stay under SQLite's 999-variable limit
function fetchElectionVotes(voterIds) {
  const evMap = {};
  for (let i = 0; i < voterIds.length; i += 500) {
    const chunk = voterIds.slice(i, i + 500);
    const rows = db.prepare(
      'SELECT voter_id, election_name, election_type, party_voted, vote_method FROM election_votes WHERE voter_id IN (' + chunk.map(() => '?').join(',') + ') ORDER BY election_date DESC'
    ).all(...chunk);
    for (const r of rows) {
      if (!evMap[r.voter_id]) evMap[r.voter_id] = [];
      evMap[r.voter_id].push({ name: r.election_name, type: r.election_type, party: r.party_voted || '', method: r.vote_method || '' });
    }
  }
  return evMap;
}

// ===================== DOOR COUNTING =====================
// Count unique doors (address+unit) instead of individual voter rows
// People living together at the same address count as ONE door
function countDoors(addresses) {
  if (!addresses || !addresses.length) return { total: 0, knocked: 0, remaining: 0 };
  var doors = {};
  for (var i = 0; i < addresses.length; i++) {
    var a = addresses[i];
    var key = (a.address || '').trim().toLowerCase() + '||' + (a.unit || '').trim().toLowerCase();
    if (!doors[key]) {
      doors[key] = { knocked: false };
    }
    if (a.result && a.result !== 'not_visited') {
      doors[key].knocked = true;
    }
  }
  var total = Object.keys(doors).length;
  var knocked = 0;
  var keys = Object.keys(doors);
  for (var j = 0; j < keys.length; j++) {
    if (doors[keys[j]].knocked) knocked++;
  }
  return { total: total, knocked: knocked, remaining: total - knocked };
}

// Build household members from walk_addresses — groups by street address + unit
// so residents in the SAME unit are shown together (roommates/family), not the whole building
function buildHouseholdFromWalkAddresses(addresses) {
  if (!addresses || !addresses.length) return;
  const grouped = {};
  for (const addr of addresses) {
    // Group by street address + unit + city — keeps apartment units separate
    const key = (addr.address || '').trim().toLowerCase().replace(/\s+/g, ' ') + '\0' + (addr.unit || '').trim().toLowerCase();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(addr);
  }
  for (const addr of addresses) {
    const key = (addr.address || '').trim().toLowerCase().replace(/\s+/g, ' ') + '\0' + (addr.unit || '').trim().toLowerCase();
    const others = grouped[key].filter(a => a.id !== addr.id && (a.voter_name || '').trim());
    addr.household = others.map(a => {
      const parts = (a.voter_name || '').trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      return { voter_id: a.voter_id || null, first_name: firstName, last_name: lastName, age: a.voter_age || null, unit: a.unit || '', party_score: a.voter_party_score || '', election_votes: a.election_votes || [] };
    });
  }
}

// Enrich household with other registered voters at the same address from the voter file
// These are people NOT on the walk list but who live at the same address
// Enrich household with other registered voters in the SAME unit/apartment
// Shows roommates/family not on the walk list but registered at the same address+unit
function enrichHouseholdFromVoterFile(addresses) {
  if (!addresses || !addresses.length) return;

  // Collect all voter_ids already on the walk to skip them
  const walkVoterIds = new Set();
  for (const addr of addresses) {
    if (addr.voter_id) walkVoterIds.add(addr.voter_id);
    if (addr.household) {
      for (const m of addr.household) {
        if (m.voter_id) walkVoterIds.add(m.voter_id);
      }
    }
  }

  // Collect unique cleaned addresses from the walk
  const addrMap = {}; // cleanAddr+unit -> [walk address objects]
  for (const addr of addresses) {
    const cleanAddr = (addr.address || '').trim()
      .replace(/\s+(TX|TEXAS)\s+\d{5}.*$/i, '')
      .replace(/\s+(BROWNSVILLE|HARLINGEN|LOS FRESNOS|PORT ISABEL|SAN BENITO|LAGUNA VISTA|SOUTH PADRE ISLAND|RANCHO VIEJO|MERCEDES|LA FERIA|RIO HONDO|COMBES|OLMITO|SANTA ROSA|SANTA MARIA)\s*$/i, '')
      .trim().replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').toUpperCase();
    const unit = (addr.unit || '').trim().toUpperCase();
    const key = cleanAddr + '\0' + unit;
    if (!addrMap[key]) addrMap[key] = { cleanAddr, unit, walkAddrs: [] };
    addrMap[key].walkAddrs.push(addr);
  }

  const uniqueKeys = Object.values(addrMap);
  if (uniqueKeys.length === 0) return;

  // Batch query: one query per unique address (exact match, index-friendly)
  // Addresses were already standardized by the migration so exact match works
  // COLLATE NOCASE lets the index on voters(address) be used while still being case-insensitive
  const findByAddr = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.age, v.unit, v.party_score
    FROM voters v
    WHERE v.address COLLATE NOCASE = ? COLLATE NOCASE
      AND COALESCE(v.unit,'') COLLATE NOCASE = ? COLLATE NOCASE
      AND (v.voter_status = 'ACTIVE' OR v.voter_status = '' OR v.voter_status IS NULL)
    ORDER BY v.last_name
  `);

  // Find all enriched voters in one pass
  const enrichedVoterIds = [];
  const enrichByKey = {};
  for (const entry of uniqueKeys) {
    const others = findByAddr.all(entry.cleanAddr, entry.unit);
    const newVoters = others.filter(v => !walkVoterIds.has(v.id));
    if (newVoters.length > 0) {
      enrichByKey[entry.cleanAddr + '\0' + entry.unit] = newVoters;
      for (const v of newVoters) {
        enrichedVoterIds.push(v.id);
        walkVoterIds.add(v.id);
      }
    }
  }

  // Batch fetch election votes for ALL enriched voters at once (one query instead of N)
  const evByVoter = {};
  if (enrichedVoterIds.length > 0) {
    // Process in chunks of 500 to avoid SQLite variable limit
    for (let i = 0; i < enrichedVoterIds.length; i += 500) {
      const chunk = enrichedVoterIds.slice(i, i + 500);
      const evRows = db.prepare(
        'SELECT voter_id, election_name as name, election_type as type, party_voted as party, vote_method as method FROM election_votes WHERE voter_id IN (' + chunk.map(() => '?').join(',') + ') ORDER BY election_date DESC'
      ).all(...chunk);
      for (const r of evRows) {
        if (!evByVoter[r.voter_id]) evByVoter[r.voter_id] = [];
        evByVoter[r.voter_id].push({ name: r.name, type: r.type, party: r.party || '', method: r.method || '' });
      }
    }
  }

  // Attach enriched members to walk addresses
  for (const entry of uniqueKeys) {
    const key = entry.cleanAddr + '\0' + entry.unit;
    const newVoters = enrichByKey[key];
    if (!newVoters || newVoters.length === 0) continue;

    const members = newVoters.map(v => ({
      voter_id: v.id,
      first_name: v.first_name || '',
      last_name: v.last_name || '',
      age: v.age || null,
      unit: v.unit || '',
      party_score: v.party_score || '',
      not_on_list: true,
      election_votes: evByVoter[v.id] || []
    }));

    for (const addr of entry.walkAddrs) {
      if (!addr.household) addr.household = [];
      addr.household.push(...members.filter(m => m.voter_id !== addr.voter_id));
    }
  }
}

// Parse apartment/unit number from an address string
// e.g. "600 Jose Marti Blvd Apt 4" -> { street: "600 Jose Marti Blvd", unit: "Apt 4" }
// e.g. "123 Main St #2B" -> { street: "123 Main St", unit: "#2B" }
// e.g. "456 Oak Ave" -> { street: "456 Oak Ave", unit: "" }
function parseAddressUnit(address) {
  if (!address) return { street: '', unit: '' };
  const addr = address.trim();
  // Match common apartment/unit patterns at the end of the address
  const match = addr.match(/^(.+?)\s+((?:apt|apartment|unit|ste|suite|#|rm|room|fl|floor|bldg|building|lot|space|trlr|trailer)\s*\.?\s*\S+)$/i);
  if (match) {
    return { street: match[1].trim(), unit: match[2].trim() };
  }
  return { street: addr, unit: '' };
}

// ===================== GEOCODING =====================

// State is configurable via GEOCODE_STATE env var (defaults to empty for auto-detection)
const GEOCODE_STATE = process.env.GEOCODE_STATE || '';
const GOOGLE_GEOCODE_KEY = process.env.GOOGLE_GEOCODE_KEY || '';

// Google Geocoding API — most accurate, $5 per 1000 requests
async function geocodeAddressGoogle(address, city, zip) {
  if (!GOOGLE_GEOCODE_KEY || !address || !address.trim()) return null;
  const street = address.trim().replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, '').trim();
  const parts = [street];
  if (city) parts.push(city.trim());
  if (GEOCODE_STATE) parts.push(GEOCODE_STATE);
  if (zip) parts.push(zip.trim());
  const fullAddress = parts.join(', ');

  try {
    const params = new URLSearchParams({
      address: fullAddress,
      key: GOOGLE_GEOCODE_KEY
    });
    const res = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + params);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    if (data.status === 'OVER_QUERY_LIMIT' || data.status === 'REQUEST_DENIED') {
      console.error('Google Geocoding error:', data.status, data.error_message || '');
    }
  } catch (e) { console.error('Google geocoder error for:', address, '-', e.message); }
  return null;
}

// Census Bureau batch geocoder — processes up to 10,000 addresses in ONE request
// Returns a map of input line -> { lat, lng }
async function censusBatchGeocode(addressLines) {
  // Census batch format: each line is "id,street,city,state,zip"
  // CSV-escape a field: wrap in quotes if it contains commas or quotes
  function csvField(val) {
    const s = (val || '').trim();
    if (s.includes(',') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const csvLines = addressLines.map((a, i) => {
    const street = (a.address || '').trim().replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, '').trim();
    return `${i},${csvField(street)},${csvField(a.city)},${GEOCODE_STATE},${csvField(a.zip)}`;
  });
  const csvBody = csvLines.join('\n');

  const form = new FormData();
  form.append('benchmark', 'Public_AR_Current');
  form.append('addressFile', new Blob([csvBody], { type: 'text/csv' }), 'addresses.csv');

  const res = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
    method: 'POST',
    body: form
  });

  if (!res.ok) throw new Error('Census batch HTTP ' + res.status);
  const text = await res.text();
  const results = {};

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Format: "id","input address","match/no match","exact/non-exact","matched address","lon,lat","tiger line id","side"
    const parts = line.split(/","/);
    if (parts.length < 6) continue;
    const id = parseInt(parts[0].replace(/"/g, ''));
    const matchType = (parts[2] || '').replace(/"/g, '').trim();
    if (matchType === 'Match') {
      const coordStr = (parts[5] || '').replace(/"/g, '').trim();
      const coords = coordStr.split(',');
      if (coords.length === 2) {
        const lng = parseFloat(coords[0]);
        const lat = parseFloat(coords[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          results[id] = { lat, lng };
        }
      }
    }
  }
  return results;
}

// Single-address geocoder using Census Bureau (fallback for small batches)
async function geocodeAddressCensus(address, city, zip) {
  if (!address || !address.trim()) return null;
  const street = address.trim().replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, '').trim();
  try {
    const params = new URLSearchParams({
      address: street,
      city: (city || '').trim(),
      state: GEOCODE_STATE || '',
      zip: (zip || '').trim(),
      benchmark: 'Public_AR_Current',
      format: 'json'
    });
    const res = await fetch('https://geocoding.geo.census.gov/geocoder/locations/address?' + params);
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data && data.result && data.result.addressMatches;
    if (matches && matches.length > 0) {
      return { lat: matches[0].coordinates.y, lng: matches[0].coordinates.x };
    }
  } catch (e) { console.error('Census geocoder error for:', address, '-', e.message); }
  return null;
}

// Nominatim single-address fallback (only used if Census fails, with proper rate limiting)
async function geocodeAddressNominatim(address, city, zip) {
  if (!address || !address.trim()) return null;
  const headers = { 'User-Agent': 'CampaignTextBlockWalker/1.0' };
  const street = address.trim().replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, '').trim();

  try {
    const params = { street, format: 'json', limit: '1', countrycodes: 'us' };
    if (city) params.city = city.trim();
    if (zip) params.postalcode = zip.trim();
    if (GEOCODE_STATE) params.state = GEOCODE_STATE;
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(params);
    const res = await fetch(url, { headers });
    if (res.status === 429) { console.log('Nominatim rate limited, waiting 30s before continuing'); await new Promise(r => setTimeout(r, 30000)); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) { /* Nominatim failure is non-fatal */ }
  return null;
}

// Track which walks are currently being geocoded to prevent duplicate runs
const geocodingInProgress = {};

// Geocode walk addresses in the background (non-blocking)
// Uses Census Bureau BATCH geocoder for speed, Nominatim as fallback
// If sourcePrecincts is provided, removes addresses that geocode outside those precinct boundaries
function geocodeWalkAddresses(walkId, sourcePrecincts) {
  // Prevent multiple concurrent geocode runs for the same walk
  if (geocodingInProgress[walkId]) {
    console.log('Geocoding already in progress for walk', walkId);
    return;
  }

  // Set the flag FIRST to prevent race conditions with concurrent calls
  geocodingInProgress[walkId] = true;

  const allMissing = db.prepare(
    'SELECT id, address, city, zip FROM walk_addresses WHERE walk_id = ? AND lat IS NULL'
  ).all(walkId).filter(r => {
    // Skip privacy-redacted addresses (e.g., "*** *** Privacy *** -***")
    const addr = (r.address || '').trim();
    return addr && !addr.includes('***') && !addr.toLowerCase().includes('privacy') && addr.length > 3;
  });

  if (allMissing.length === 0) { delete geocodingInProgress[walkId]; return; }

  // De-duplicate: group rows by unique address+city+zip
  const groups = {};
  for (const row of allMissing) {
    const key = (row.address || '').trim().toLowerCase() + '||' + (row.city || '').trim().toLowerCase() + '||' + (row.zip || '').trim().toLowerCase();
    if (!groups[key]) groups[key] = { address: row.address, city: row.city, zip: row.zip, ids: [] };
    groups[key].ids.push(row.id);
  }
  const uniqueAddresses = Object.values(groups);
  console.log('Geocoding walk', walkId, ':', allMissing.length, 'rows,', uniqueAddresses.length, 'unique addresses');

  const update = db.prepare('UPDATE walk_addresses SET lat = ?, lng = ? WHERE id = ?');

  (async () => {
    let resolved = 0;
    let failed = 0;

    // Step 1: Try Google Geocoding API (most accurate)
    if (GOOGLE_GEOCODE_KEY) {
      console.log('Geocoding', uniqueAddresses.length, 'addresses via Google Maps API...');
      for (const group of uniqueAddresses) {
        try {
          const coords = await geocodeAddressGoogle(group.address, group.city, group.zip);
          if (coords) {
            for (const id of group.ids) {
              update.run(coords.lat, coords.lng, id);
            }
            resolved += group.ids.length;
          }
        } catch (e) {
          console.error('Google geocode error for', group.address, ':', e.message);
        }
        // Small delay to stay within rate limits
        await new Promise(r => setTimeout(r, 50));
      }
      console.log('Google geocoding resolved', resolved, '/', allMissing.length, 'addresses');
    } else {
      // No Google key — fall back to Census Bureau BATCH geocoder
      try {
        console.log('No GOOGLE_GEOCODE_KEY set — using Census Bureau batch geocode for', uniqueAddresses.length, 'addresses...');
        // Census batch geocoder has a limit of ~10,000 addresses; chunk into batches of 5000
        let batchResults = {};
        const CENSUS_BATCH_SIZE = 5000;
        for (let bStart = 0; bStart < uniqueAddresses.length; bStart += CENSUS_BATCH_SIZE) {
          const chunk = uniqueAddresses.slice(bStart, bStart + CENSUS_BATCH_SIZE);
          const chunkResults = await censusBatchGeocode(chunk);
          // Re-key results to global indices
          for (const [localIdx, coords] of Object.entries(chunkResults)) {
            batchResults[bStart + parseInt(localIdx)] = coords;
          }
        }
        const matched = Object.keys(batchResults).length;
        console.log('Census batch returned', matched, '/', uniqueAddresses.length, 'matches');

        for (let i = 0; i < uniqueAddresses.length; i++) {
          const coords = batchResults[i];
          if (coords) {
            for (const id of uniqueAddresses[i].ids) {
              update.run(coords.lat, coords.lng, id);
            }
            resolved += uniqueAddresses[i].ids.length;
          }
        }
      } catch (e) {
        console.error('Census batch geocoding failed:', e.message, '— falling back to individual requests');
      }
    }

    // Step 2: For any addresses still missing, try individual fallbacks
    const stillMissing = uniqueAddresses.filter((group, i) => {
      const hasCoords = db.prepare('SELECT lat FROM walk_addresses WHERE id = ? AND lat IS NOT NULL').get(group.ids[0]);
      return !hasCoords;
    });

    if (stillMissing.length > 0) {
      console.log('Individual geocoding for', stillMissing.length, 'remaining addresses...');
      for (const group of stillMissing) {
        try {
          // Try Google first (if key available), then Census, then Nominatim
          let coords = null;
          if (GOOGLE_GEOCODE_KEY) {
            coords = await geocodeAddressGoogle(group.address, group.city, group.zip);
          }
          if (!coords) {
            coords = await geocodeAddressCensus(group.address, group.city, group.zip);
          }
          if (!coords) {
            await new Promise(r => setTimeout(r, 2000));
            coords = await geocodeAddressNominatim(group.address, group.city, group.zip);
          }
          if (coords) {
            for (const id of group.ids) {
              update.run(coords.lat, coords.lng, id);
            }
            resolved += group.ids.length;
          } else {
            failed += group.ids.length;
          }
        } catch (e) {
          failed += group.ids.length;
          console.error('Geocode error for', group.address, ':', e.message);
        }
        // Small delay between individual requests
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log('Geocoding complete for walk', walkId, ':', resolved, 'resolved,', failed, 'failed out of', allMissing.length);

    // Flag addresses that geocoded outside the source precinct boundaries
    if (sourcePrecincts && sourcePrecincts.length > 0 && getPrecinctFeatures().length > 0) {
      const geocoded = db.prepare(
        'SELECT id, lat, lng, address FROM walk_addresses WHERE walk_id = ? AND lat IS NOT NULL'
      ).all(walkId);
      let flagged = 0;
      const flagStmt = db.prepare('UPDATE walk_addresses SET outside_precinct = 1 WHERE id = ?');
      const clearStmt = db.prepare('UPDATE walk_addresses SET outside_precinct = 0 WHERE id = ?');
      for (const addr of geocoded) {
        if (!pointInPrecincts(addr.lat, addr.lng, sourcePrecincts)) {
          flagStmt.run(addr.id);
          flagged++;
        } else {
          clearStmt.run(addr.id);
        }
      }
      if (flagged > 0) {
        console.log('[walks] Flagged', flagged, 'addresses outside precinct boundaries for walk', walkId,
          '(precincts:', sourcePrecincts.join(','), ')');
      }
    }
  })().catch(e => console.error('Geocode batch error:', e.message)).finally(() => {
    delete geocodingInProgress[walkId];
  });
}

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many delete requests, try again later.' } });

// ===================== VOTING HISTORY FILTER HELPER =====================
// Builds SQL clauses to filter voters by election participation
// Used by from-precinct, universe claim, and turf refresh
function buildVotingHistorySQL(filters, params) {
  let sql = '';
  // "voted in at least N elections" — targets frequent voters
  if (filters.min_elections && parseInt(filters.min_elections) > 0) {
    sql += ' AND (SELECT COUNT(*) FROM election_votes ev WHERE ev.voter_id = voters.id) >= ?';
    params.push(parseInt(filters.min_elections));
  }
  // "voted in specific election(s)" — supports multiple comma-separated elections (ANY match)
  if (filters.voted_in_election) {
    const elections = filters.voted_in_election.split(',').map(e => e.trim()).filter(Boolean);
    if (elections.length === 1) {
      sql += ' AND voters.id IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.election_name = ?)';
      params.push(elections[0]);
    } else if (elections.length > 1) {
      sql += ' AND voters.id IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.election_name IN (' + elections.map(() => '?').join(',') + '))';
      elections.forEach(e => params.push(e));
    }
  }
  // "did NOT vote in specific election(s)" — supports multiple comma-separated elections
  if (filters.did_not_vote_in) {
    const elections = filters.did_not_vote_in.split(',').map(e => e.trim()).filter(Boolean);
    if (elections.length === 1) {
      sql += ' AND voters.id NOT IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.election_name = ?)';
      params.push(elections[0]);
    } else if (elections.length > 1) {
      sql += ' AND voters.id NOT IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.election_name IN (' + elections.map(() => '?').join(',') + '))';
      elections.forEach(e => params.push(e));
    }
  }
  // "has any voting history at all" — filters out brand new registrants
  if (filters.has_voted) {
    sql += ' AND voters.id IN (SELECT DISTINCT ev.voter_id FROM election_votes ev)';
  }
  // "voted in a specific party primary" — e.g. only voters who pulled a D or R ballot
  if (filters.party_voted) {
    sql += ' AND voters.id IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.party_voted = ?)';
    params.push(filters.party_voted);
  }
  // VAN-style party score filter (D/DD/DDD, R/RR/RRR, SWING, NONE)
  if (filters.party_score) {
    const ps = filters.party_score;
    if (ps === 'NONE') {
      sql += " AND (voters.party_score = '' OR voters.party_score IS NULL)";
    } else if (ps === 'SWING') {
      sql += " AND voters.party_score = 'SWING'";
    } else if (ps === 'DD') {
      sql += " AND voters.party_score IN ('DD','DDD')";
    } else if (ps === 'D') {
      sql += " AND voters.party_score IN ('D','DD','DDD')";
    } else if (ps === 'RR') {
      sql += " AND voters.party_score IN ('RR','RRR')";
    } else if (ps === 'R') {
      sql += " AND voters.party_score IN ('R','RR','RRR')";
    } else {
      sql += ' AND voters.party_score = ?';
      params.push(ps);
    }
  }
  // "voter score range" — if you've scored voters 0-100
  if (filters.min_voter_score != null && parseInt(filters.min_voter_score) > 0) {
    sql += ' AND voters.voter_score >= ?';
    params.push(parseInt(filters.min_voter_score));
  }
  // Vote frequency percentage filters (VAN-style turnout propensity)
  // Overall: "voted in at least X% of elections they were eligible for"
  if (filters.min_vote_frequency != null && parseInt(filters.min_vote_frequency) > 0) {
    sql += ' AND voters.vote_frequency >= ?';
    params.push(parseInt(filters.min_vote_frequency));
  }
  if (filters.max_vote_frequency != null && parseInt(filters.max_vote_frequency) < 100) {
    sql += ' AND voters.vote_frequency <= ?';
    params.push(parseInt(filters.max_vote_frequency));
  }
  // General election frequency: "votes in X% of generals"
  if (filters.min_general_frequency != null && parseInt(filters.min_general_frequency) > 0) {
    sql += ' AND voters.general_frequency >= ?';
    params.push(parseInt(filters.min_general_frequency));
  }
  // Primary election frequency: "votes in X% of primaries"
  if (filters.min_primary_frequency != null && parseInt(filters.min_primary_frequency) > 0) {
    sql += ' AND voters.primary_frequency >= ?';
    params.push(parseInt(filters.min_primary_frequency));
  }
  // May election frequency: "votes in X% of May elections"
  if (filters.min_may_frequency != null && parseInt(filters.min_may_frequency) > 0) {
    sql += ' AND voters.may_frequency >= ?';
    params.push(parseInt(filters.min_may_frequency));
  }
  return sql;
}

// ===================== DAILY REPORT (must be before /walks/:id) =====================
router.get('/walks/daily-report', (req, res) => {
  const date = req.query.date; // YYYY-MM-DD, defaults to today
  const candidate_id = req.query.candidate_id ? parseInt(req.query.candidate_id) : null;
  // Default to today in Central Time (CDT/CST aware)
  const centralNow = getCentralNow();
  const targetDate = date || centralNow.toISOString().split('T')[0];
  const tzSql = getCentralOffsetSql();

  // Optional candidate filter
  // Include unassigned walks (NULL candidate_id) alongside the selected candidate
  const cJoin = candidate_id ? ' JOIN block_walks bw ON walk_attempts.walk_id = bw.id' : '';
  const cWhere = candidate_id ? ' AND bw.candidate_id = ?' : '';
  const cJoinWa = candidate_id ? ' JOIN block_walks bw ON wa.walk_id = bw.id' : '';
  const cWhereWa = candidate_id ? ' AND bw.candidate_id = ?' : '';
  const cParam = candidate_id ? [candidate_id] : [];

  // Per-walker stats for the selected day
  const walkers = db.prepare(`
    SELECT
      walk_attempts.walker_name as name,
      COUNT(*) as doors,
      SUM(CASE WHEN walk_attempts.result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN walk_attempts.result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      SUM(CASE WHEN walk_attempts.result = 'undecided' THEN 1 ELSE 0 END) as undecided,
      SUM(CASE WHEN walk_attempts.result = 'oppose' THEN 1 ELSE 0 END) as oppose,
      SUM(CASE WHEN walk_attempts.result = 'lean_oppose' THEN 1 ELSE 0 END) as lean_oppose,
      SUM(CASE WHEN walk_attempts.result = 'refused' THEN 1 ELSE 0 END) as refused,
      SUM(CASE WHEN walk_attempts.result = 'not_home' THEN 1 ELSE 0 END) as not_home,
      MIN(walk_attempts.attempted_at) as first_knock,
      MAX(walk_attempts.attempted_at) as last_knock,
      COUNT(DISTINCT walk_attempts.walk_id) as walks_worked
    FROM walk_attempts${cJoin}
    WHERE walk_attempts.walker_name != '' AND date(walk_attempts.attempted_at, '${tzSql}') = ?${cWhere}
    GROUP BY walk_attempts.walker_name
    ORDER BY doors DESC
  `).all(targetDate, ...cParam);

  for (const w of walkers) {
    w.contact_rate = w.doors > 0 ? Math.round(w.contacts / w.doors * 100) : 0;
    if (w.first_knock && w.last_knock && w.first_knock !== w.last_knock) {
      const hours = (new Date(w.last_knock) - new Date(w.first_knock)) / 3600000;
      w.doors_per_hour = hours > 0 ? Math.round(w.doors / hours * 10) / 10 : 0;
    } else {
      w.doors_per_hour = 0;
    }
  }

  // Day totals
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_doors,
      COUNT(DISTINCT walk_attempts.address_id) as unique_addresses,
      SUM(CASE WHEN walk_attempts.result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as total_contacts,
      SUM(CASE WHEN walk_attempts.result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as total_supporters,
      SUM(CASE WHEN walk_attempts.result = 'undecided' THEN 1 ELSE 0 END) as total_undecided,
      SUM(CASE WHEN walk_attempts.result = 'oppose' THEN 1 ELSE 0 END) as total_oppose,
      SUM(CASE WHEN walk_attempts.result = 'lean_oppose' THEN 1 ELSE 0 END) as total_lean_oppose,
      SUM(CASE WHEN walk_attempts.result = 'not_home' THEN 1 ELSE 0 END) as total_not_home,
      COUNT(DISTINCT walk_attempts.walker_name) as total_walkers,
      COUNT(DISTINCT walk_attempts.walk_id) as total_walks
    FROM walk_attempts${cJoin}
    WHERE walk_attempts.walker_name != '' AND date(walk_attempts.attempted_at, '${tzSql}') = ?${cWhere}
  `).get(targetDate, ...cParam);
  totals.contact_rate = totals.total_doors > 0 ? Math.round(totals.total_contacts / totals.total_doors * 100) : 0;

  // Day-over-day history (last 30 days with activity)
  const history = db.prepare(`
    SELECT
      date(walk_attempts.attempted_at, '${tzSql}') as day,
      COUNT(*) as doors,
      SUM(CASE WHEN walk_attempts.result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN walk_attempts.result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      COUNT(DISTINCT walk_attempts.walker_name) as walkers
    FROM walk_attempts${cJoin}
    WHERE walk_attempts.walker_name != ''${cWhere}
    GROUP BY date(walk_attempts.attempted_at, '${tzSql}')
    ORDER BY day DESC
    LIMIT 30
  `).all(...cParam);

  // Per-walk breakdown for the day
  const walkBreakdown = db.prepare(`
    SELECT
      wa.walk_id,
      bw2.name as walk_name,
      COUNT(*) as doors,
      SUM(CASE WHEN wa.result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN wa.result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = wa.walk_id) as total_addresses
    FROM walk_attempts wa
    LEFT JOIN block_walks bw2 ON wa.walk_id = bw2.id
    WHERE wa.walker_name != '' AND date(wa.attempted_at, '${tzSql}') = ?${candidate_id ? ' AND bw2.candidate_id = ?' : ''}
    GROUP BY wa.walk_id
    ORDER BY doors DESC
  `).all(targetDate, ...cParam);

  // Available dates (days with any activity)
  const activeDays = db.prepare(`
    SELECT DISTINCT date(walk_attempts.attempted_at, '${tzSql}') as day
    FROM walk_attempts${cJoin}
    WHERE walk_attempts.walker_name != ''${cWhere}
    ORDER BY day DESC
    LIMIT 90
  `).all(...cParam).map(r => r.day);

  res.json({ date: targetDate, walkers, totals, history: history.reverse(), walkBreakdown, activeDays });
});

// ===================== WEEKLY HOURS (must be before /walks/:id) =====================
router.get('/walks/weekly-hours', (req, res) => {
  // week_of = Monday date (YYYY-MM-DD). Default to current week's Monday in Central Time.
  const central = getCentralNow();
  const tzSql = getCentralOffsetSql();
  const day = central.getDay(); // 0=Sun
  const diffToMon = day === 0 ? -6 : 1 - day;
  const defaultMonday = new Date(central);
  defaultMonday.setDate(central.getDate() + diffToMon);
  const weekOf = req.query.week_of || defaultMonday.toISOString().split('T')[0];
  const candidate_id = req.query.candidate_id ? parseInt(req.query.candidate_id) : null;

  // Get all knocks for the 7-day window (Mon-Sun), excluding knocks after 20:30 Central
  const weekEnd = new Date(weekOf);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  // Optional candidate filter — JOIN block_walks to scope by candidate.
  // Also include unassigned walks (NULL candidate_id) so no data is hidden.
  const candidateJoin = candidate_id ? ' JOIN block_walks bw ON wa.walk_id = bw.id' : '';
  const candidateWhere = candidate_id ? ' AND bw.candidate_id = ?' : '';
  const baseParams = candidate_id ? [weekOf, weekEndStr, candidate_id] : [weekOf, weekEndStr];

  const rows = db.prepare(`
    SELECT
      wa.walker_name,
      date(wa.attempted_at, '${tzSql}') as knock_date,
      time(wa.attempted_at, '${tzSql}') as knock_time,
      wa.attempted_at
    FROM walk_attempts wa${candidateJoin}
    WHERE wa.walker_name != ''
      AND date(wa.attempted_at, '${tzSql}') >= ?
      AND date(wa.attempted_at, '${tzSql}') < ?
      AND time(wa.attempted_at, '${tzSql}') <= '20:30:00'${candidateWhere}
    ORDER BY wa.walker_name, wa.attempted_at
  `).all(...baseParams);

  // Group by walker + day, find first/last knock per day
  const walkerDays = {}; // { walkerName: { 'YYYY-MM-DD': { first, last } } }
  for (const r of rows) {
    if (!walkerDays[r.walker_name]) walkerDays[r.walker_name] = {};
    const wd = walkerDays[r.walker_name];
    if (!wd[r.knock_date]) wd[r.knock_date] = { first: r.attempted_at, last: r.attempted_at, knocks: 0 };
    const entry = wd[r.knock_date];
    if (r.attempted_at < entry.first) entry.first = r.attempted_at;
    if (r.attempted_at > entry.last) entry.last = r.attempted_at;
    entry.knocks++;
  }

  // Build per-walker weekly summary
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekOf);
    d.setDate(d.getDate() + i);
    weekDates.push(d.toISOString().split('T')[0]);
  }

  // Get approved gap deductions for this week
  const gapRows = db.prepare(`
    SELECT walker_name, gap_date, SUM(gap_minutes) as deducted_minutes
    FROM walker_time_gaps
    WHERE status = 'approved' AND gap_date >= ? AND gap_date < ?
    GROUP BY walker_name, gap_date
  `).all(weekOf, weekEndStr);
  const gapDeductions = {};
  for (const g of gapRows) {
    if (!gapDeductions[g.walker_name]) gapDeductions[g.walker_name] = {};
    gapDeductions[g.walker_name][g.gap_date] = (g.deducted_minutes || 0) / 60; // convert to hours
  }

  const walkers = [];
  for (const [name, days] of Object.entries(walkerDays)) {
    const dailyHours = [];
    const dailyRawHours = [];
    const dailyDeducted = [];
    let totalHours = 0;
    let totalRawHours = 0;
    let totalDeducted = 0;
    let totalDoors = 0;
    let daysWorked = 0;

    for (const dateStr of weekDates) {
      const entry = days[dateStr];
      const deduction = (gapDeductions[name] && gapDeductions[name][dateStr]) || 0;
      if (entry && entry.first !== entry.last) {
        const rawHrs = (new Date(entry.last) - new Date(entry.first)) / 3600000;
        const netHrs = Math.max(0, rawHrs - deduction);
        dailyRawHours.push(Math.round(rawHrs * 100) / 100);
        dailyHours.push(Math.round(netHrs * 100) / 100);
        dailyDeducted.push(Math.round(deduction * 100) / 100);
        totalRawHours += rawHrs;
        totalHours += netHrs;
        totalDeducted += deduction;
        totalDoors += entry.knocks;
        daysWorked++;
      } else if (entry) {
        dailyRawHours.push(0);
        dailyHours.push(0);
        dailyDeducted.push(0);
        totalDoors += entry.knocks;
        daysWorked++;
      } else {
        dailyRawHours.push(0);
        dailyHours.push(0);
        dailyDeducted.push(0);
      }
    }

    walkers.push({
      walker_name: name,
      daily_hours: dailyHours,
      daily_raw_hours: dailyRawHours,
      daily_deducted: dailyDeducted,
      total_hours: Math.round(totalHours * 100) / 100,
      total_raw_hours: Math.round(totalRawHours * 100) / 100,
      total_deducted: Math.round(totalDeducted * 100) / 100,
      total_doors: totalDoors,
      days_worked: daysWorked
    });
  }

  // Sort by total hours descending
  walkers.sort((a, b) => b.total_hours - a.total_hours);

  // Available weeks (weeks that have any activity)
  const activeWeeks = db.prepare(`
    SELECT DISTINCT date(attempted_at, '${tzSql}', 'weekday 1', '-7 days') as monday
    FROM walk_attempts
    WHERE walker_name != ''
    ORDER BY monday DESC
    LIMIT 26
  `).all().map(r => r.monday);

  res.json({ week_of: weekOf, week_dates: weekDates, day_names: dayNames, walkers, activeWeeks });
});

// ===================== TIME GAP DETECTION & REVIEW =====================

// Scan for gaps > 15 min and insert new ones as pending
router.post('/walks/time-gaps/scan', (req, res) => {
  const GAP_THRESHOLD = 15; // minutes

  // Get date range to scan (default: last 7 days)
  const central = getCentralNow();
  const tzSql = getCentralOffsetSql();
  const daysBack = parseInt(req.query.days) || 7;
  const startDate = new Date(central);
  startDate.setDate(central.getDate() - daysBack);
  const startStr = startDate.toISOString().split('T')[0];

  // Get all knocks ordered by walker + time
  const rows = db.prepare(`
    SELECT walker_name, attempted_at, date(attempted_at, '${tzSql}') as knock_date
    FROM walk_attempts
    WHERE walker_name != ''
      AND date(attempted_at, '${tzSql}') >= ?
      AND time(attempted_at, '${tzSql}') <= '20:30:00'
    ORDER BY walker_name, attempted_at
  `).all(startStr);

  // Find gaps per walker per day
  const insertGap = db.prepare(`
    INSERT INTO walker_time_gaps (walker_name, gap_date, gap_start, gap_end, gap_minutes)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM walker_time_gaps
      WHERE walker_name = ? AND gap_date = ? AND gap_start = ? AND gap_end = ?
    )
  `);

  let newGaps = 0;
  let prevWalker = null;
  let prevTime = null;
  let prevDate = null;

  for (const r of rows) {
    if (r.walker_name === prevWalker && r.knock_date === prevDate && prevTime) {
      const diffMs = new Date(r.attempted_at) - new Date(prevTime);
      const diffMin = diffMs / 60000;
      if (diffMin > GAP_THRESHOLD) {
        const result = insertGap.run(
          r.walker_name, r.knock_date, prevTime, r.attempted_at, Math.round(diffMin * 10) / 10,
          r.walker_name, r.knock_date, prevTime, r.attempted_at
        );
        if (result.changes > 0) newGaps++;
      }
    }
    if (r.walker_name !== prevWalker || r.knock_date !== prevDate) {
      prevWalker = r.walker_name;
      prevDate = r.knock_date;
    }
    prevTime = r.attempted_at;
  }

  res.json({ scanned: rows.length, new_gaps_found: newGaps });
});

// List time gaps with filters
router.get('/walks/time-gaps', (req, res) => {
  const status = req.query.status || ''; // pending, approved, denied, or '' for all
  const walker = req.query.walker || '';

  let sql = `SELECT * FROM walker_time_gaps WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND status = ?`; params.push(status); }
  if (walker) { sql += ` AND walker_name = ?`; params.push(walker); }
  sql += ` ORDER BY gap_date DESC, walker_name, gap_start`;

  const gaps = db.prepare(sql).all(...params);

  // Get summary stats
  const summary = db.prepare(`
    SELECT status, COUNT(*) as count, SUM(gap_minutes) as total_minutes
    FROM walker_time_gaps
    GROUP BY status
  `).all();

  res.json({ gaps, summary });
});

// Update gap status (approve or deny deduction)
router.put('/walks/time-gaps/:id', (req, res) => {
  const { status, notes } = req.body; // status: 'approved' (deduct time) or 'denied' (keep time)
  if (!['approved', 'denied', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved, denied, or pending' });
  }
  db.prepare(`
    UPDATE walker_time_gaps SET status = ?, notes = COALESCE(?, notes), reviewed_at = datetime('now')
    WHERE id = ?
  `).run(status, notes || null, req.params.id);
  res.json({ ok: true });
});

// Bulk update gaps
router.put('/walks/time-gaps-bulk', (req, res) => {
  const { ids, status, notes } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  if (!['approved', 'denied', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const stmt = db.prepare(`
    UPDATE walker_time_gaps SET status = ?, notes = COALESCE(?, notes), reviewed_at = datetime('now')
    WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(status, notes || null, id);
  });
  tx();
  res.json({ ok: true, updated: ids.length });
});

// Get approved deductions per walker per date (for weekly hours integration)
router.get('/walks/time-gaps/deductions', (req, res) => {
  const rows = db.prepare(`
    SELECT walker_name, gap_date, SUM(gap_minutes) as deducted_minutes
    FROM walker_time_gaps
    WHERE status = 'approved'
    GROUP BY walker_name, gap_date
  `).all();
  const deductions = {};
  for (const r of rows) {
    if (!deductions[r.walker_name]) deductions[r.walker_name] = {};
    deductions[r.walker_name][r.gap_date] = Math.round(r.deducted_minutes * 10) / 10;
  }
  res.json({ deductions });
});

// Google Civic Info — polling locations for a voter's address
// Uses the same GOOGLE_GEOCODE_KEY (enable Civic Information API in Google Cloud Console)
const civicInfoCache = {};
const CIVIC_CACHE_MAX = 2000; // evict oldest entries when cache exceeds this size
router.get('/walks/civic-info', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required.' });
  if (!GOOGLE_GEOCODE_KEY) return res.json({ error: 'No Google API key configured.', pollingLocations: [], earlyVoteSites: [] });

  // Check cache
  const cacheKey = address.trim().toLowerCase();
  if (civicInfoCache[cacheKey]) return res.json(civicInfoCache[cacheKey]);

  try {
    const url = 'https://www.googleapis.com/civicinfo/v2/voterinfo?key=' + encodeURIComponent(GOOGLE_GEOCODE_KEY) + '&address=' + encodeURIComponent(address) + '&returnAllAvailableData=true';
    const resp = await fetch(url);
    const data = await resp.json();

    const result = {
      election: data.election ? data.election.name : null,
      electionDay: data.election ? data.election.electionDay : null,
      pollingLocations: (data.pollingLocations || []).map(p => ({
        name: p.address ? p.address.locationName : '',
        address: p.address ? [p.address.line1, p.address.city, p.address.state, p.address.zip].filter(Boolean).join(', ') : '',
        hours: p.pollingHours || '',
        notes: p.notes || ''
      })),
      earlyVoteSites: (data.earlyVoteSites || []).map(s => ({
        name: s.address ? s.address.locationName : '',
        address: s.address ? [s.address.line1, s.address.city, s.address.state, s.address.zip].filter(Boolean).join(', ') : '',
        hours: s.pollingHours || '',
        startDate: s.startDate || '',
        endDate: s.endDate || ''
      })),
      dropOffLocations: (data.dropOffLocations || []).map(d => ({
        name: d.address ? d.address.locationName : '',
        address: d.address ? [d.address.line1, d.address.city, d.address.state, d.address.zip].filter(Boolean).join(', ') : ''
      }))
    };

    // Evict oldest entries when cache is full (simple LRU by dropping half)
    const keys = Object.keys(civicInfoCache);
    if (keys.length >= CIVIC_CACHE_MAX) {
      const toRemove = keys.slice(0, Math.floor(CIVIC_CACHE_MAX / 2));
      for (const k of toRemove) delete civicInfoCache[k];
    }
    civicInfoCache[cacheKey] = result;
    res.json(result);
  } catch (e) {
    res.json({ error: e.message, pollingLocations: [], earlyVoteSites: [] });
  }
});

// All addresses across walks — for the combined results map
// ?list_id=X filters to voters in an admin_list universe (shows all addresses including unvisited)
// Without list_id, shows only visited addresses across all walks
router.get('/walks/all-results-map', (req, res) => {
  const { list_id, race_col, race_val } = req.query;
  const candidate_id = req.query.candidate_id ? parseInt(req.query.candidate_id) : null;
  const validDistrictCols = new Set(['navigation_port','navigation_district','port_authority','city_district','school_district','college_district','state_rep','state_senate','us_congress','county_commissioner','justice_of_peace','state_board_ed','hospital_district']);
  let where = "wa.lat IS NOT NULL AND wa.lng IS NOT NULL AND wa.address NOT LIKE '%***%' AND wa.address NOT LIKE '%Privacy%'";
  const params = [];

  // candidate_id is the primary scope — shows ONLY walks tagged to this candidate
  if (candidate_id) {
    where += " AND bw.candidate_id = ? AND wa.result != 'not_visited'";
    params.push(candidate_id);
  } else if (list_id) {
    where += ' AND wa.voter_id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    params.push(list_id);
  } else {
    where += " AND wa.result != 'not_visited'";
  }

  // Race filter only when no candidate_id (candidate_id already scopes walks directly)
  if (!candidate_id && race_col && validDistrictCols.has(race_col) && race_val) {
    where += ` AND wa.voter_id IN (SELECT id FROM voters WHERE ${race_col} = ?)`;
    params.push(race_val);
  }

  // Fetch raw addresses then deduplicate with O(n) Map
  const rawAddresses = db.prepare(`
    SELECT wa.id, wa.address, wa.unit, wa.city, wa.result, wa.lat, wa.lng, wa.knocked_at,
           wa.voter_name, wa.walk_id, bw.name as walk_name
    FROM walk_addresses wa
    JOIN block_walks bw ON wa.walk_id = bw.id
    WHERE ${where}
    ORDER BY wa.knocked_at DESC
  `).all(...params);

  // O(n) dedup using Map (not O(n²) .filter)
  const houseMap = new Map();
  for (const a of rawAddresses) {
    const key = (a.address || '').toLowerCase().trim() + '||' + (a.unit || '').toLowerCase().trim() + '||' + a.walk_id;
    if (!houseMap.has(key)) {
      a.household_count = 1;
      houseMap.set(key, a);
    } else {
      houseMap.get(key).household_count++;
    }
  }
  const addresses = Array.from(houseMap.values());

  const stats = {};
  // Stats query uses its OWN params (not the addresses query params)
  let statsWhere = 'wa2.lat IS NOT NULL AND wa2.lng IS NOT NULL';
  const statsParams = [];
  if (candidate_id) {
    statsWhere += ' AND bw2.candidate_id = ?';
    statsParams.push(candidate_id);
  } else if (list_id) {
    statsWhere += ' AND wa2.voter_id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    statsParams.push(list_id);
  } else {
    statsWhere += " AND wa2.result != 'not_visited'";
  }
  db.prepare(`
    SELECT wa2.result, COUNT(DISTINCT LOWER(TRIM(wa2.address)) || '||' || LOWER(TRIM(COALESCE(wa2.unit, ''))) || '||' || wa2.walk_id) as count
    FROM walk_addresses wa2
    JOIN block_walks bw2 ON wa2.walk_id = bw2.id
    WHERE ${statsWhere}
    GROUP BY wa2.result
  `).all(...statsParams).forEach(r => { stats[r.result] = r.count; });

  res.json({ addresses, stats });
});

// List all block walks with stats (single query instead of N+1)
// Count unique doors (address+unit) not individual voter rows
router.get('/walks', (req, res) => {
  // PERF: previously this ran TWO correlated subqueries per walk against
  // walk_addresses, each doing COUNT(DISTINCT LOWER(TRIM(address))||...).
  // Function-on-column defeats indexes, and the per-walk correlation made
  // the cost N × (2 × full address scan).  At ~10 walks × 5K addresses
  // that was ~100K LOWER(TRIM) calls per page load — visibly slow.
  //
  // New shape: one CTE that walks `walk_addresses` exactly ONCE, GROUP BY
  // walk_id, and computes both counts (total + knocked) in the same pass
  // using a CASE expression inside the COUNT(DISTINCT).  block_walks then
  // LEFT JOINs the pre-aggregated stats — O(addresses) regardless of
  // walk count.  Typical 5–20x faster at production scale.
  const walks = db.prepare(`
    WITH walk_stats AS (
      -- Uses the indexed addr_norm generated column instead of the
      -- inline LOWER(TRIM())||'||'||LOWER(TRIM()) expression.  The
      -- (walk_id, addr_norm) composite index lets SQLite scan once
      -- per walk rather than full-table-scanning walk_addresses.
      SELECT walk_id,
        COUNT(DISTINCT addr_norm) AS totalAddresses,
        COUNT(DISTINCT CASE
          WHEN result != 'not_visited' THEN addr_norm
        END) AS knocked
      FROM walk_addresses
      WHERE addr_norm != ''
      GROUP BY walk_id
    )
    SELECT b.*, c.name AS candidate_name,
      COALESCE(ws.totalAddresses, 0) AS totalAddresses,
      COALESCE(ws.knocked, 0) AS knocked
    FROM block_walks b
    LEFT JOIN candidates c ON b.candidate_id = c.id
    LEFT JOIN walk_stats ws ON ws.walk_id = b.id
    ORDER BY b.id DESC
  `).all();
  res.json({ walks });
});

// Bulk assign unassigned walks to a candidate
router.post('/walks/bulk-assign-candidate', (req, res) => {
  const { candidate_id } = req.body;
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id required.' });
  const result = db.prepare('UPDATE block_walks SET candidate_id = ? WHERE candidate_id IS NULL').run(candidate_id);
  res.json({ success: true, updated: result.changes });
});

// Create a walk
router.post('/walks', (req, res) => {
  const { name, description, assigned_to, candidate_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Walk name is required.' });
  const joinCode = generateAlphaCode(4);
  const result = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code, candidate_id, max_walkers) VALUES (?, ?, ?, ?, ?, 10)'
  ).run(name, description || '', assigned_to || '', joinCode, candidate_id || null);
  // Auto-assign walkers from same candidate to the new walk
  const walkId = result.lastInsertRowid;
  const activeWalkers = candidate_id
    ? db.prepare('SELECT id, name, phone FROM walkers WHERE is_active = 1 AND candidate_id = ?').all(candidate_id)
    : db.prepare('SELECT id, name, phone FROM walkers WHERE is_active = 1').all();
  const insertMember = db.prepare('INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)');
  for (const w of activeWalkers) {
    insertMember.run(walkId, w.name, w.id, w.phone || '');
  }
  res.json({ success: true, id: walkId, autoAssigned: activeWalkers.length });
});

// Get walk detail with addresses
router.get('/walks/:id', (req, res) => {
  const walk = db.prepare('SELECT * FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  walk.addresses = db.prepare(`
    SELECT wa.*, v.phone as voter_phone, v.party_score as voter_party_score,
           v.age as voter_age, v.support_level as voter_support,
           v.registration_number as voter_registration, v.first_name as voter_first,
           v.last_name as voter_last, v.gender as voter_gender
    FROM walk_addresses wa
    LEFT JOIN voters v ON wa.voter_id = v.id
    WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id
  `).all(req.params.id);
  const stats = {};
  for (const a of walk.addresses) {
    stats[a.result] = (stats[a.result] || 0) + 1;
  }
  walk.resultStats = stats;
  walk.doorCounts = countDoors(walk.addresses);
  res.json({ walk });
});

// Update walk metadata
router.put('/walks/:id', (req, res) => {
  const { name, description, assigned_to, status, script_id, candidate_id } = req.body;
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
  }
  // Handle nullable fields separately since COALESCE can't set null
  if (script_id !== undefined) {
    db.prepare('UPDATE block_walks SET script_id = ? WHERE id = ?').run(script_id || null, req.params.id);
  }
  if (candidate_id !== undefined) {
    db.prepare('UPDATE block_walks SET candidate_id = ? WHERE id = ?').run(candidate_id || null, req.params.id);
  }
  const result = db.prepare(
    'UPDATE block_walks SET name = COALESCE(?, name), description = COALESCE(?, description), assigned_to = COALESCE(?, assigned_to), status = COALESCE(?, status) WHERE id = ?'
  ).run(name, description, assigned_to, status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Walk not found.' });
  res.json({ success: true });
});

// Toggle sandbox mode on an existing walk + undo any voter data it already logged
router.post('/walks/:id/sandbox', (req, res) => {
  const walk = db.prepare('SELECT id, name, sandbox FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  const { enable } = req.body;
  const newVal = enable ? 1 : 0;

  const result = db.transaction(() => {
    db.prepare('UPDATE block_walks SET sandbox = ? WHERE id = ?').run(newVal, walk.id);

    let undone = 0;
    if (enable) {
      // Undo: remove voter_contacts logged by this walk's attempts
      const attempts = db.prepare('SELECT DISTINCT address_id FROM walk_attempts WHERE walk_id = ?').all(walk.id);
      const addrIds = attempts.map(a => a.address_id);
      if (addrIds.length > 0) {
        // Get voter_ids from walk_addresses
        const addrs = db.prepare('SELECT voter_id FROM walk_addresses WHERE walk_id = ? AND voter_id IS NOT NULL').all(walk.id);
        const voterIds = [...new Set(addrs.map(a => a.voter_id))];
        for (const vid of voterIds) {
          // Remove door-knock contacts logged during this walk's timeframe
          const r = db.prepare(
            "DELETE FROM voter_contacts WHERE voter_id = ? AND contact_type = 'Door-knock' AND contacted_at >= (SELECT MIN(attempted_at) FROM walk_attempts WHERE walk_id = ?)"
          ).run(vid, walk.id);
          undone += r.changes;
        }
        // Reset support_level to 'unknown' for these voters (since we can't know what it was before)
        for (const vid of voterIds) {
          db.prepare("UPDATE voters SET support_level = 'unknown' WHERE id = ? AND support_level IN ('strong_support','lean_support','undecided','lean_oppose','strong_oppose','refused')").run(vid);
        }
      }
    }
    return { undone };
  })();

  res.json({ success: true, sandbox: !!newVal, undone: result.undone, walkName: walk.name });
});

// Delete a walk
router.delete('/walks/:id', (req, res) => {
  const walk = db.prepare('SELECT name FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM walk_addresses WHERE walk_id = ?').run(req.params.id);
    db.prepare('DELETE FROM walk_attempts WHERE walk_id = ?').run(req.params.id);
    db.prepare('DELETE FROM walk_group_members WHERE walk_id = ?').run(req.params.id);
    db.prepare('DELETE FROM walker_locations WHERE walk_id = ?').run(req.params.id);
    db.prepare('DELETE FROM block_walks WHERE id = ?').run(req.params.id);
  })();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block walk deleted: ' + (walk.name || req.params.id));
  res.json({ success: true });
});

// Bulk delete walks
router.post('/walks/bulk-delete', bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No walk IDs provided.' });
  const delAddrs = db.prepare('DELETE FROM walk_addresses WHERE walk_id = ?');
  const delAttempts = db.prepare('DELETE FROM walk_attempts WHERE walk_id = ?');
  const delMembers = db.prepare('DELETE FROM walk_group_members WHERE walk_id = ?');
  const delLocations = db.prepare('DELETE FROM walker_locations WHERE walk_id = ?');
  const del = db.prepare('DELETE FROM block_walks WHERE id = ?');
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) {
      delAddrs.run(id); delAttempts.run(id); delMembers.run(id); delLocations.run(id);
      if (del.run(id).changes > 0) removed++;
    }
    return removed;
  });
  const removed = bulkDel(ids);
  res.json({ success: true, removed });
});

// Add addresses to walk
router.post('/walks/:id/addresses', (req, res) => {
  const walk = db.prepare('SELECT id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  const { addresses } = req.body;
  if (!addresses || !addresses.length) return res.status(400).json({ error: 'No addresses provided.' });
  const insert = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const addMany = db.transaction((list) => {
    let i = 0;
    for (const a of list) {
      if (a.address) {
        insert.run(req.params.id, a.address, a.unit || '', a.city || '', a.zip || '', a.voter_name || '', a.voter_id || null, i++);
      }
    }
    return i;
  });
  const added = addMany(addresses);
  geocodeWalkAddresses(parseInt(req.params.id));
  res.json({ success: true, added });
});

// Update address result
router.put('/walks/:walkId/addresses/:addrId', (req, res) => {
  const { result, notes } = req.body;

  // Prevention guard: refuse to reset a knocked address to 'not_visited' if walk_attempts exist for it
  if (result === 'not_visited') {
    const hasAttempts = db.prepare(
      'SELECT COUNT(*) as c FROM walk_attempts WHERE address_id = ? AND walk_id = ?'
    ).get(req.params.addrId, req.params.walkId);
    if (hasAttempts && hasAttempts.c > 0) {
      console.warn(`[guard] Blocked reset of walk_address ${req.params.addrId} to 'not_visited' (has ${hasAttempts.c} knock attempts)`);
      return res.status(400).json({ error: 'Cannot reset a knocked address. Clear attempt history first.' });
    }
  }

  const knocked_at = result && result !== 'not_visited' ? new Date().toISOString() : null;
  const r = db.prepare(
    'UPDATE walk_addresses SET result = COALESCE(?, result), notes = COALESCE(?, notes), knocked_at = COALESCE(?, knocked_at) WHERE id = ? AND walk_id = ?'
  ).run(result, notes, knocked_at, req.params.addrId, req.params.walkId);
  if (r.changes === 0) return res.status(404).json({ error: 'Address not found.' });
  res.json({ success: true });
});

// Delete an address
router.delete('/walks/:walkId/addresses/:addrId', (req, res) => {
  const r = db.prepare('DELETE FROM walk_addresses WHERE id = ? AND walk_id = ?').run(req.params.addrId, req.params.walkId);
  if (r.changes === 0) return res.status(404).json({ error: 'Address not found.' });
  res.json({ success: true });
});

// ─── REMOVE ADDRESSES WHERE EVERYONE VOTED ────────────────────────
// Manual-click pruning: removes unvisited walk_addresses where EVERY
// voter at that address has already early-voted. If even one resident
// hasn't voted yet, the address stays on the walk so the walker can
// still knock and reach them.
//
// Idempotent: re-running after more voters vote will prune further.
// Only touches unvisited addresses (result='not_visited' or empty).
// Addresses with recorded walk results are never removed.
//
// Perf note: previous version used correlated NOT EXISTS subqueries
// that scanned voters O(N²) and timed out at Railway (502). Rewritten
// to scan voters once into an in-memory Map, then check walk_addresses
// against it. O(voters + walk_addresses) instead of O(walk × voters²).
router.post('/walks/:walkId/prune-voted-addresses', (req, res) => {
  const walk = db.prepare('SELECT id, name FROM block_walks WHERE id = ?').get(req.params.walkId);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  // Pull unvisited addresses for this walk (the only candidates for pruning)
  const walkAddrs = db.prepare(`
    SELECT id,
      LOWER(TRIM(COALESCE(address, ''))) as addr,
      LOWER(TRIM(COALESCE(unit, ''))) as unit
    FROM walk_addresses
    WHERE walk_id = ?
      AND (result IS NULL OR result = '' OR result = 'not_visited')
  `).all(req.params.walkId);
  const beforeCount = walkAddrs.length;

  if (walkAddrs.length === 0) {
    return res.json({
      success: true,
      removed: 0,
      unvisited_before: 0,
      unvisited_after: 0,
      walk_name: walk.name
    });
  }

  // Scan voters once, building a map of address → { voted, notVoted } counts.
  // O(N) over voters. Memory: ~30MB for 300K voters, well within budget.
  const voterRows = db.prepare(`
    SELECT
      LOWER(TRIM(COALESCE(address, ''))) as addr,
      LOWER(TRIM(COALESCE(unit, ''))) as unit,
      COALESCE(early_voted, 0) as voted
    FROM voters
    WHERE address IS NOT NULL AND TRIM(address) != ''
  `).all();
  const addrMap = new Map();
  for (const v of voterRows) {
    const key = v.addr + '||' + v.unit;
    let s = addrMap.get(key);
    if (!s) { s = { voted: 0, notVoted: 0 }; addrMap.set(key, s); }
    if (v.voted === 1) s.voted++; else s.notVoted++;
  }

  // Identify walk_addresses whose household is fully voted (voted > 0 AND
  // notVoted === 0). Skip addresses that have no voter records at all —
  // might be new residents or addresses we don't have data for.
  const toDeleteIds = [];
  for (const w of walkAddrs) {
    const s = addrMap.get(w.addr + '||' + w.unit);
    if (s && s.voted > 0 && s.notVoted === 0) {
      toDeleteIds.push(w.id);
    }
  }

  // Batch-delete by ID in a transaction (fast, no table scan).
  // FK ON DELETE CASCADE handles walk_attempts cleanup automatically.
  //
  // DEFENSE: the DELETE includes the `result IS NULL OR 'not_visited'`
  // condition even though we already filtered for it when we built
  // toDeleteIds. This prevents a race: a walker could knock an address
  // between SELECT and DELETE, changing its result to 'support' / etc.
  // Without this guard, we'd still delete that row and destroy the
  // walker's recorded knock. The double-check guarantees walked data
  // never gets pruned — belt and suspenders.
  let removed = 0;
  let preserved = 0;
  if (toDeleteIds.length > 0) {
    const delStmt = db.prepare(`
      DELETE FROM walk_addresses
      WHERE id = ?
        AND (result IS NULL OR result = '' OR result = 'not_visited')
    `);
    const tx = db.transaction((ids) => {
      for (const id of ids) {
        const r = delStmt.run(id);
        if (r.changes > 0) removed++;
        else preserved++; // walked between our SELECT and DELETE — leave it alone
      }
    });
    tx(toDeleteIds);
  }

  // Refresh SQLite's query-planner statistics after a large DELETE so
  // subsequent queries against walk_addresses and walk_attempts use
  // current cardinality estimates. Without this, walker-side endpoints
  // can be mysteriously slow for a while after a big prune.
  if (removed > 0) {
    try {
      db.prepare('ANALYZE walk_addresses').run();
      db.prepare('ANALYZE walk_attempts').run();
    } catch (e) { /* non-fatal */ }
  }

  const afterCount = beforeCount - removed;

  const logMsg = preserved > 0
    ? `Walk "${walk.name}": pruned ${removed} voted-household addresses; ${preserved} protected (walked between select and delete)`
    : `Walk "${walk.name}": pruned ${removed} addresses where all voters already voted`;
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(logMsg);

  res.json({
    success: true,
    removed,
    preserved,           // houses that walker knocked between select + delete — kept safe
    unvisited_before: beforeCount,
    unvisited_after: afterCount,
    walk_name: walk.name
  });
});

// ===================== VOLUNTEER WALKING INTERFACE =====================

// Get walk for volunteer view (simplified, no admin data)
router.get('/walks/:id/volunteer', (req, res) => {
  const walk = db.prepare('SELECT id, name, description, assigned_to, status, script_id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  walk.addresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.notes,
            wa.knocked_at, wa.sort_order, wa.gps_verified, wa.lat, wa.lng, wa.voter_id,
            wa.assigned_walker,
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last,
            v.party_score as voter_party_score, v.support_level as voter_support
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  // Attach election votes FIRST so household members get the data (chunked to avoid >999 variable limit)
  const voterIds = walk.addresses.map(a => a.voter_id).filter(Boolean);
  if (voterIds.length > 0) {
    const evMap = fetchElectionVotes(voterIds);
    for (const a of walk.addresses) {
      if (a.voter_id) a.election_votes = evMap[a.voter_id] || [];
    }
  }

  // NOW build households — election_votes are attached so household members get them
  buildHouseholdFromWalkAddresses(walk.addresses);
  // Add other registered voters at the same address from the full voter file
  enrichHouseholdFromVoterFile(walk.addresses);

  // Add attempt counts per address
  const attemptCounts = db.prepare(
    'SELECT address_id, COUNT(*) as c FROM walk_attempts WHERE walk_id = ? GROUP BY address_id'
  ).all(req.params.id);
  const countMap = {};
  for (const a of attemptCounts) countMap[a.address_id] = a.c;
  for (const addr of walk.addresses) addr.attempt_count = countMap[addr.id] || 0;

  walk.progress = countDoors(walk.addresses);
  res.json({ walk });
});

// Haversine distance between two GPS coords (returns meters)
function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Valid door-knock disposition values
const VALID_RESULTS = new Set([
  'support', 'lean_support', 'undecided', 'lean_oppose',
  'oppose', 'not_home', 'refused', 'moved', 'deceased', 'come_back'
]);
const VALID_RESULTS_SET = new Set(['support', 'lean_support', 'undecided', 'lean_oppose', 'oppose', 'not_home', 'refused', 'moved', 'deceased', 'come_back', 'not_visited']);

const MAX_GPS_ACCURACY = 200; // ignore GPS worse than 200m

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    isFinite(lat) && isFinite(lng);
}

// Log a door knock result with GPS verification and attempt tracking
router.post('/walks/:walkId/addresses/:addrId/log', (req, res) => {
  const { result, notes, gps_lat, gps_lng, gps_accuracy, walker_name, walker_id, survey_responses } = req.body;
  if (!result) return res.status(400).json({ error: 'Result is required.' });
  if (!VALID_RESULTS.has(result)) return res.status(400).json({ error: 'Invalid result value.' });

  // Verify walker is assigned to this walk (try walker_id first, fall back to walker_name)
  if (walker_id) {
    let member = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_id = ?').get(req.params.walkId, walker_id);
    if (!member && walker_name) {
      // Walker may have joined via join code (no walker_id on row) — try by name and backfill
      member = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_name = ? AND walker_id IS NULL').get(req.params.walkId, walker_name);
      if (member) db.prepare('UPDATE walk_group_members SET walker_id = ? WHERE id = ?').run(walker_id, member.id);
    }
    if (!member) return res.status(403).json({ error: 'Not assigned to this walk.' });
  } else if (walker_name) {
    const member = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? AND walker_name = ?').get(req.params.walkId, walker_name);
    if (!member) return res.status(403).json({ error: 'Not a member of this walk group.' });
  }

  const addr = db.prepare('SELECT * FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });

  // Check if this walk is sandboxed (external campaign — don't update voter data)
  const walkMeta = db.prepare('SELECT sandbox FROM block_walks WHERE id = ?').get(req.params.walkId);
  const isSandbox = walkMeta && walkMeta.sandbox;

  // Determine GPS verification. Require accuracy metadata — a phone that
  // reports coords without accuracy has unknown signal quality (e.g., cell
  // tower triangulation can be off by km). Treat unknown as "don't verify".
  let gps_verified = 0;
  if (gps_lat != null && gps_lng != null && isValidCoord(gps_lat, gps_lng)) {
    if (gps_accuracy == null || gps_accuracy > MAX_GPS_ACCURACY) {
      // Missing or too-poor accuracy → don't verify
      gps_verified = 0;
    } else if (addr.lat != null && addr.lng != null) {
      // If address has known coords, verify volunteer is within 150m
      const dist = gpsDistance(gps_lat, gps_lng, addr.lat, addr.lng);
      gps_verified = dist <= 150 ? 1 : 0;
    } else {
      // No address coords to compare — cannot verify location without reference point
      gps_verified = 0;
    }
  }

  const knocked_at = new Date().toISOString();

  // Wrap address update + voter contact log + attempt record in a transaction for atomicity
  const logKnock = db.transaction(() => {
    // Prevent double-knock: check if this address was already knocked in the last 10 seconds
    const recentAttempt = db.prepare(
      "SELECT id FROM walk_attempts WHERE address_id = ? AND walk_id = ? AND attempted_at > datetime('now', '-10 seconds')"
    ).get(req.params.addrId, req.params.walkId);
    if (recentAttempt) return { duplicate: true };

    // Update the walk address
    db.prepare(`
      UPDATE walk_addresses SET
        result = ?, notes = ?, knocked_at = ?,
        gps_lat = ?, gps_lng = ?, gps_accuracy = ?, gps_verified = ?
      WHERE id = ? AND walk_id = ?
    `).run(result, notes || '', knocked_at, gps_lat != null ? gps_lat : null, gps_lng != null ? gps_lng : null, gps_accuracy != null ? gps_accuracy : null, gps_verified, req.params.addrId, req.params.walkId);

    // Also update all other walk_address rows at the same address+unit so they don't show as "not_visited"
    db.prepare(`
      UPDATE walk_addresses SET
        result = ?, knocked_at = ?, gps_verified = ?
      WHERE walk_id = ? AND id != ?
        AND LOWER(TRIM(address)) = LOWER(TRIM((SELECT address FROM walk_addresses WHERE id = ?)))
        AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(TRIM(COALESCE((SELECT unit FROM walk_addresses WHERE id = ?),'')))
    `).run(result, knocked_at, gps_verified, req.params.walkId, req.params.addrId, req.params.addrId, req.params.addrId);

    // Record attempt in attempt history (with walker_id if available)
    db.prepare(
      'INSERT INTO walk_attempts (address_id, walk_id, result, notes, walker_name, walker_id, gps_lat, gps_lng, gps_accuracy, gps_verified, survey_responses_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.addrId, req.params.walkId, result, notes || '', walker_name || '', walker_id || null, gps_lat != null ? gps_lat : null, gps_lng != null ? gps_lng : null, gps_accuracy != null ? gps_accuracy : null, gps_verified, survey_responses ? JSON.stringify(survey_responses) : null);

    // Update walker performance metrics
    const NON_CONTACT = ['not_home', 'moved', 'refused', 'deceased', 'come_back'];
    if (walker_id) {
      const contactInc = !NON_CONTACT.includes(result) ? 1 : 0;
      db.prepare(`
        UPDATE walk_group_members SET
          doors_knocked = doors_knocked + 1,
          contacts_made = contacts_made + ?,
          first_knock_at = COALESCE(first_knock_at, ?),
          last_knock_at = ?
        WHERE walk_id = ? AND walker_id = ?
      `).run(contactInc, knocked_at, knocked_at, req.params.walkId, walker_id);
    } else if (walker_name) {
      const contactInc = !NON_CONTACT.includes(result) ? 1 : 0;
      db.prepare(`
        UPDATE walk_group_members SET
          doors_knocked = doors_knocked + 1,
          contacts_made = contacts_made + ?,
          first_knock_at = COALESCE(first_knock_at, ?),
          last_knock_at = ?
        WHERE walk_id = ? AND walker_name = ?
      `).run(contactInc, knocked_at, knocked_at, req.params.walkId, walker_name);
    }

    // Auto-log voter contact if voter_id is linked — SKIP for sandbox walks
    if (addr.voter_id && !isSandbox) {
      const contactResult = {
        'support': 'Strong Support', 'lean_support': 'Lean Support',
        'undecided': 'Undecided', 'lean_oppose': 'Lean Oppose',
        'oppose': 'Strong Oppose', 'not_home': 'Not Home',
        'refused': 'Refused', 'moved': 'Moved', 'deceased': 'Deceased', 'come_back': 'Come Back'
      }[result] || result;

      db.prepare(
        'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
      ).run(addr.voter_id, 'Door-knock', contactResult, notes || '', walker_name || 'Block Walker');

      const supportMap = {
        'support': 'strong_support', 'lean_support': 'lean_support',
        'undecided': 'undecided', 'lean_oppose': 'lean_oppose', 'oppose': 'strong_oppose',
        'refused': 'refused'
      };
      if (supportMap[result]) {
        db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?").run(supportMap[result], addr.voter_id);
      }
    }
    return { duplicate: false };
  });
  const knockResult = logKnock();
  if (knockResult && knockResult.duplicate) {
    return res.json({ success: true, gps_verified, duplicate: true });
  }

  res.json({ success: true, gps_verified });
});

// Log a household door knock — marks address result + individual household member results
router.post('/walks/:walkId/addresses/:addrId/log-household', (req, res) => {
  const { members, notes, gps_lat, gps_lng, gps_accuracy, walker_name, walker_id } = req.body;
  // members: [{ voter_id, name, result }] — each person at the address
  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'Members array is required.' });
  }

  for (const m of members) {
    if (m.result && !VALID_RESULTS_SET.has(m.result)) {
      return res.status(400).json({ error: 'Invalid result: ' + m.result });
    }
  }

  // Verify walker is assigned to this walk (try walker_id first, fall back to walker_name)
  if (walker_id) {
    let member = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_id = ?').get(req.params.walkId, walker_id);
    if (!member && walker_name) {
      member = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_name = ? AND walker_id IS NULL').get(req.params.walkId, walker_name);
      if (member) db.prepare('UPDATE walk_group_members SET walker_id = ? WHERE id = ?').run(walker_id, member.id);
    }
    if (!member) return res.status(403).json({ error: 'Not assigned to this walk.' });
  } else if (walker_name) {
    const member = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? AND walker_name = ?').get(req.params.walkId, walker_name);
    if (!member) return res.status(403).json({ error: 'Not a member of this walk group.' });
  }

  const addr = db.prepare('SELECT * FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });

  // Check sandbox
  const walkMeta2 = db.prepare('SELECT sandbox FROM block_walks WHERE id = ?').get(req.params.walkId);
  const isSandbox = walkMeta2 && walkMeta2.sandbox;

  // Determine overall address result from member results
  // If anyone was contacted (not not_home), address is contacted
  const contactedMembers = members.filter(m => m.result && m.result !== 'not_home');
  const overallResult = contactedMembers.length > 0 ? contactedMembers[0].result : 'not_home';

  // GPS verification. Same rules as single-knock path: missing accuracy
  // metadata = unknown signal quality = don't verify. See the sibling
  // block above for rationale.
  let gps_verified = 0;
  if (gps_lat != null && gps_lng != null && isValidCoord(gps_lat, gps_lng)) {
    if (gps_accuracy == null || gps_accuracy > MAX_GPS_ACCURACY) {
      gps_verified = 0;
    } else if (addr.lat != null && addr.lng != null) {
      const dist = gpsDistance(gps_lat, gps_lng, addr.lat, addr.lng);
      gps_verified = dist <= 150 ? 1 : 0;
    } else {
      // No address coords to compare — cannot verify location without reference point
      gps_verified = 0;
    }
  }

  const knocked_at = new Date().toISOString();
  const allNotes = notes || '';

  const logHousehold = db.transaction(() => {
    // Prevent double-knock: check if this address was already knocked in the last 10 seconds
    const recentAttempt = db.prepare(
      "SELECT id FROM walk_attempts WHERE address_id = ? AND walk_id = ? AND attempted_at > datetime('now', '-10 seconds')"
    ).get(req.params.addrId, req.params.walkId);
    if (recentAttempt) return { duplicate: true };

    // Update the walk address with overall result
    db.prepare(`
      UPDATE walk_addresses SET
        result = ?, notes = ?, knocked_at = ?,
        gps_lat = ?, gps_lng = ?, gps_accuracy = ?, gps_verified = ?
      WHERE id = ? AND walk_id = ?
    `).run(overallResult, allNotes, knocked_at, gps_lat != null ? gps_lat : null, gps_lng != null ? gps_lng : null, gps_accuracy != null ? gps_accuracy : null, gps_verified, req.params.addrId, req.params.walkId);

    // Also update all other walk_address rows at the same address+unit so they don't show as "not_visited"
    // (Multiple voters at the same door each have their own row)
    db.prepare(`
      UPDATE walk_addresses SET
        result = ?, knocked_at = ?, gps_verified = ?
      WHERE walk_id = ? AND id != ?
        AND LOWER(TRIM(address)) = LOWER(TRIM((SELECT address FROM walk_addresses WHERE id = ?)))
        AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(TRIM(COALESCE((SELECT unit FROM walk_addresses WHERE id = ?),'')))
    `).run(overallResult, knocked_at, gps_verified, req.params.walkId, req.params.addrId, req.params.addrId, req.params.addrId);

    // Record attempt
    db.prepare(
      'INSERT INTO walk_attempts (address_id, walk_id, result, notes, walker_name, walker_id, gps_lat, gps_lng, gps_accuracy, gps_verified, survey_responses_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.addrId, req.params.walkId, overallResult, allNotes, walker_name || '', walker_id || null, gps_lat != null ? gps_lat : null, gps_lng != null ? gps_lng : null, gps_accuracy != null ? gps_accuracy : null, gps_verified, req.body.survey_responses ? JSON.stringify(req.body.survey_responses) : null);

    // Update walker performance
    const NON_CONTACT_HH = ['not_home', 'moved', 'refused', 'deceased', 'come_back'];
    if (walker_id) {
      const contactInc = !NON_CONTACT_HH.includes(overallResult) ? 1 : 0;
      db.prepare(`
        UPDATE walk_group_members SET
          doors_knocked = doors_knocked + 1,
          contacts_made = contacts_made + ?,
          first_knock_at = COALESCE(first_knock_at, ?),
          last_knock_at = ?
        WHERE walk_id = ? AND walker_id = ?
      `).run(contactInc, knocked_at, knocked_at, req.params.walkId, walker_id);
    } else if (walker_name) {
      const contactInc = !NON_CONTACT_HH.includes(overallResult) ? 1 : 0;
      db.prepare(`
        UPDATE walk_group_members SET
          doors_knocked = doors_knocked + 1,
          contacts_made = contacts_made + ?,
          first_knock_at = COALESCE(first_knock_at, ?),
          last_knock_at = ?
        WHERE walk_id = ? AND walker_name = ?
      `).run(contactInc, knocked_at, knocked_at, req.params.walkId, walker_name);
    }

    // Log individual voter contacts — SKIP for sandbox walks
    if (!isSandbox) {
    for (const m of members) {
      if (!m.voter_id || !m.result) continue;
      if (!VALID_RESULTS.has(m.result)) continue;

      const contactResult = {
        'support': 'Strong Support', 'lean_support': 'Lean Support',
        'undecided': 'Undecided', 'lean_oppose': 'Lean Oppose',
        'oppose': 'Strong Oppose', 'not_home': 'Not Home',
        'refused': 'Refused', 'moved': 'Moved', 'deceased': 'Deceased', 'come_back': 'Come Back'
      }[m.result] || m.result;

      db.prepare(
        'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
      ).run(m.voter_id, 'Door-knock', contactResult, '', walker_name || 'Block Walker');

      const supportMap = {
        'support': 'strong_support', 'lean_support': 'lean_support',
        'undecided': 'undecided', 'lean_oppose': 'lean_oppose', 'oppose': 'strong_oppose',
        'refused': 'refused'
      };
      if (supportMap[m.result]) {
        db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?").run(supportMap[m.result], m.voter_id);
      }
    }
    } // end !isSandbox

    // Also log for the primary voter on the address — but only if they were explicitly
    // included in the members list. Don't auto-log "Not Home" for missing primary voters
    // as this could corrupt data if the members list was incomplete.
    if (addr.voter_id) {
      const primaryMember = members.find(m => parseInt(m.voter_id) === parseInt(addr.voter_id));
      if (!primaryMember) {
        // Primary voter wasn't in the members list — skip rather than assume not_home
        // The primary voter's contact will only be logged if explicitly included
      }
    }

    return { duplicate: false };
  });
  const hhResult = logHousehold();
  if (hhResult && hhResult.duplicate) {
    return res.json({ success: true, gps_verified, result: overallResult, duplicate: true });
  }

  res.json({ success: true, gps_verified, result: overallResult });
});

// ===================== GROUP WALKING =====================

// Join a walk group by join code
router.post('/walks/join', (req, res) => {
  const { joinCode, walkerName, phone } = req.body;
  if (!joinCode || !walkerName) return res.status(400).json({ error: 'Join code and walker name required.' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  if (String(walkerName).length > 100) return res.status(400).json({ error: 'Name is too long (max 100 characters).' });

  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });

  const walk = db.prepare("SELECT * FROM block_walks WHERE join_code = ? AND status != 'completed'").get(String(joinCode).toUpperCase());
  if (!walk) return res.status(404).json({ error: 'Invalid join code or walk is completed.' });

  // Check if this phone is already in the group (dedup by phone)
  const existing = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? AND phone = ?').get(walk.id, normPhone);
  if (existing) {
    // Same phone already joined — let them back in with their original name
    splitAddresses(walk.id);
    return res.json({ success: true, walkId: walk.id, walkName: walk.name, walkerName: existing.walker_name });
  }

  // Cap at 10 walkers per walk — coordinating larger groups gets messy
  // (each walker ends up with only 2-3 doors) and iOS group-text caps
  // around 30 anyway. 10 is a practical ceiling. Admin can still set
  // a lower cap per walk via walk.max_walkers if they want a tighter
  // group (neighborhood-specific small teams).
  const maxWalkers = walk.max_walkers || 10;
  const joinResult = db.transaction(() => {
    const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walk.id) || { c: 0 };
    if (members.c >= maxWalkers) return { full: true };
    const existing = db.prepare('SELECT 1 FROM walk_group_members WHERE walk_id = ? AND phone = ?').get(walk.id, normPhone);
    if (existing) return { duplicate: true };
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name, phone) VALUES (?, ?, ?)').run(walk.id, walkerName, normPhone);
    return { success: true };
  })();

  if (joinResult.full) return res.status(400).json({ error: 'Group is full (max ' + maxWalkers + ' walkers). Ask the admin to create another walk if more volunteers want to join.' });
  if (joinResult.duplicate) return res.status(400).json({ error: 'This phone number has already joined this walk.' });

  // Auto-split addresses among group members
  splitAddresses(walk.id);

  res.json({ success: true, walkId: walk.id, walkName: walk.name });
});

// Get group members for a walk
router.get('/walks/:id/group', (req, res) => {
  const walk = db.prepare('SELECT id, name, join_code, max_walkers FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  const members = db.prepare('SELECT * FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(req.params.id);
  res.json({ walk, members });
});

// Get all addresses in a walk for a specific walker (shows everything, marks assigned)
router.get('/walks/:id/walker/:name', (req, res) => {
  const walk = db.prepare('SELECT id, name, description, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  // Return ALL addresses so walkers can knock any door, not just their assigned split
  const allAddresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.notes,
            wa.knocked_at, wa.sort_order, wa.gps_verified, wa.assigned_walker, wa.lat, wa.lng, wa.voter_id,
            wa.outside_precinct,
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last,
            v.party_score as voter_party_score, v.support_level as voter_support
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  // Mark which addresses are assigned to THIS walker
  const walkerName = req.params.name;
  for (const addr of allAddresses) {
    addr.assigned_to_me = addr.assigned_walker === walkerName;
  }

  // Attach election votes FIRST so household members get the data
  const voterIds = allAddresses.map(a => a.voter_id).filter(Boolean);
  if (voterIds.length > 0) {
    const evMap = fetchElectionVotes(voterIds);
    for (const a of allAddresses) {
      if (a.voter_id) a.election_votes = evMap[a.voter_id] || [];
    }
  }

  // NOW build households — election_votes are attached so household members get them
  buildHouseholdFromWalkAddresses(allAddresses);
  // Add other registered voters at the same address from the full voter file
  enrichHouseholdFromVoterFile(allAddresses);

  // Add attempt counts per address
  const attemptCounts = db.prepare(
    'SELECT address_id, COUNT(*) as c FROM walk_attempts WHERE walk_id = ? GROUP BY address_id'
  ).all(req.params.id);
  const countMap = {};
  for (const a of attemptCounts) countMap[a.address_id] = a.c;
  for (const addr of allAddresses) addr.attempt_count = countMap[addr.id] || 0;

  res.json({ walk, addresses: allAddresses, progress: countDoors(allAddresses) });
});

// Re-split addresses when group members change (only reassign unvisited ones)
// Fixed: fetch members INSIDE transaction to prevent race condition if members join/leave mid-split
function splitAddresses(walkId) {
  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  const split = db.transaction(() => {
    const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
    if (members.length === 0) return;

    const unvisited = db.prepare("SELECT id FROM walk_addresses WHERE walk_id = ? AND result = 'not_visited' ORDER BY sort_order, id").all(walkId);

    for (let i = 0; i < unvisited.length; i++) {
      const walker = members[i % members.length].walker_name;
      update.run(walker, unvisited[i].id);
    }
  });
  split();
}

// Leave a walk group
router.delete('/walks/:id/group/:name', (req, res) => {
  const walkId = parseInt(req.params.id, 10);
  if (isNaN(walkId) || walkId <= 0) return res.status(400).json({ error: 'Invalid walk ID.' });
  db.prepare('DELETE FROM walk_group_members WHERE walk_id = ? AND walker_name = ?').run(walkId, req.params.name);
  // Re-split remaining addresses
  splitAddresses(walkId);
  res.json({ success: true });
});

// ===================== ROUTE OPTIMIZATION =====================

// Generate optimized route (nearest-neighbor) and Google Maps URL
router.get('/walks/:id/route', (req, res) => {
  const addresses = db.prepare(
    "SELECT id, address, city, zip, lat, lng FROM walk_addresses WHERE walk_id = ? AND result = 'not_visited' ORDER BY sort_order, id"
  ).all(req.params.id);

  if (addresses.length === 0) return res.json({ route: [], mapsUrl: '' });

  // If we have GPS coordinates, use nearest-neighbor optimization
  const hasCoords = addresses.filter(a => a.lat && a.lng);
  let ordered;

  if (hasCoords.length >= 2) {
    // Nearest-neighbor algorithm
    const remaining = [...hasCoords];
    ordered = [remaining.shift()];
    while (remaining.length > 0) {
      const last = ordered[ordered.length - 1];
      let nearest = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = gpsDistance(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
        if (d < nearestDist) { nearestDist = d; nearest = i; }
      }
      ordered.push(remaining.splice(nearest, 1)[0]);
    }
    // Add addresses without coords at the end
    const noCoords = addresses.filter(a => !a.lat || !a.lng);
    ordered = ordered.concat(noCoords);
  } else {
    ordered = addresses;
  }

  // Build Google Maps walking directions URL
  const waypoints = ordered.map(a => {
    if (a.lat && a.lng) return a.lat + ',' + a.lng;
    return encodeURIComponent((a.address || '') + ' ' + (a.city || '') + ' ' + (a.zip || ''));
  });

  let mapsUrl = '';
  if (waypoints.length >= 2) {
    const origin = waypoints[0];
    const dest = waypoints[waypoints.length - 1];
    const middle = waypoints.slice(1, -1).join('|');
    mapsUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + origin + '&destination=' + dest;
    if (middle) mapsUrl += '&waypoints=' + middle;
  } else if (waypoints.length === 1) {
    mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + waypoints[0];
  }

  // Return optimized route without modifying DB (GET should be read-only)
  res.json({
    route: ordered.map(a => ({ id: a.id, address: a.address, city: a.city })),
    mapsUrl,
    optimized: hasCoords.length >= 2
  });
});

// POST endpoint to persist optimized route order (explicit write action)
router.post('/walks/:id/route/save', (req, res) => {
  const { order } = req.body;
  if (!order || !Array.isArray(order)) return res.status(400).json({ error: 'Order array is required.' });
  const updateSort = db.prepare('UPDATE walk_addresses SET sort_order = ? WHERE id = ? AND walk_id = ?');
  const reorder = db.transaction(() => {
    order.forEach((id, i) => updateSort.run(i, id, req.params.id));
  });
  reorder();
  res.json({ success: true });
});

// ===================== CREATE WALK FROM PRECINCT =====================

// Auto-create a walk populated with voters from selected precincts
router.post('/walks/from-precinct', (req, res) => {
  const { precincts, name, description, candidate_id, sandbox } = req.body;
  let filters = req.body.filters;
  if (!precincts || !precincts.length) return res.status(400).json({ error: 'At least one precinct is required.' });

  // Build voter query with optional filters
  let sql = "SELECT id, first_name, last_name, address, city, zip, phone FROM voters WHERE precinct IN (" + precincts.map(() => '?').join(',') + ") AND address != ''";
  const params = [...precincts];

  if (filters) {
    if (filters.party && !filters.party_score && !filters.party_voted) { filters = Object.assign({}, filters, { party_voted: filters.party }); } // legacy party filter fallback
    if (filters.support_level) { sql += ' AND support_level = ?'; params.push(filters.support_level); }
    if (filters.exclude_contacted) {
      sql += ' AND id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
    }
    // Age filters
    if (filters.min_age && parseInt(filters.min_age) > 0) {
      sql += " AND birth_date != '' AND birth_date IS NOT NULL AND (strftime('%Y','now') - substr(birth_date,1,4)) >= ?";
      params.push(parseInt(filters.min_age));
    }
    if (filters.max_age && parseInt(filters.max_age) > 0) {
      sql += " AND birth_date != '' AND birth_date IS NOT NULL AND (strftime('%Y','now') - substr(birth_date,1,4)) <= ?";
      params.push(parseInt(filters.max_age));
    }
    // Exclude early voters
    if (filters.exclude_early_voted) {
      sql += " AND (early_voted IS NULL OR early_voted = 0 OR early_voted = '')";
    }
    // Voting history filters (nonpartisan targeting)
    sql += buildVotingHistorySQL(filters, params);
  }
  sql += ' ORDER BY address, last_name';

  const voters = db.prepare(sql).all(...params);
  if (voters.length === 0) return res.status(400).json({ error: 'No voters with addresses found in the selected precincts.' });

  // Create the walk (store source precincts + filters for turf refresh)
  const walkName = name || ('Precinct Walk: ' + precincts.join(', '));
  const joinCode = generateAlphaCode(4);
  const walkResult = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code, source_precincts, source_filters_json, candidate_id, sandbox, max_walkers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10)'
  ).run(walkName, description || 'Auto-created from precincts: ' + precincts.join(', '), '', joinCode, precincts.join(','), JSON.stringify(filters || {}), candidate_id || null, sandbox ? 1 : 0);
  const walkId = walkResult.lastInsertRowid;

  // Add voter addresses to the walk, linked to voter_id for auto-contact-logging
  const insert = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const addAll = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      if (isPrivacyAddress(v.address)) continue;
      const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      const parsed = parseAddressUnit(v.address);
      insert.run(walkId, parsed.street, parsed.unit, v.city || '', v.zip || '', voterName, v.id, i++);
    }
    return i;
  });
  const added = addAll();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Walk created from precincts [' + precincts.join(', ') + ']: ' + added + ' addresses'
  );

  geocodeWalkAddresses(walkId, precincts);
  res.json({ success: true, id: walkId, added, precincts });
});

// ===================== CREATE WALK FROM VOTER LIST =====================

// Auto-create a walk from selected voter IDs (from the main voter list)
router.post('/walks/from-voters', (req, res) => {
  const { voter_ids, name, description, candidate_id } = req.body;
  if (!voter_ids || !voter_ids.length) return res.status(400).json({ error: 'No voters selected.' });

  const placeholders = voter_ids.map(() => '?').join(',');
  const voters = db.prepare(
    `SELECT id, first_name, last_name, address, city, zip, precinct FROM voters WHERE id IN (${placeholders}) AND address != '' ORDER BY precinct, address, last_name`
  ).all(...voter_ids);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with addresses found in selection.' });

  const precincts = [...new Set(voters.map(v => v.precinct).filter(Boolean))];
  const walkName = name || (precincts.length > 0
    ? 'Walk: ' + precincts.join(', ')
    : 'Walk from voter list (' + voters.length + ' addresses)');
  const joinCode = generateAlphaCode(4);
  const walkResult = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code, candidate_id, max_walkers) VALUES (?, ?, ?, ?, ?, 10)'
  ).run(walkName, description || '', '', joinCode, candidate_id || null);
  const walkId = walkResult.lastInsertRowid;

  const insert = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const addAll = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      if (isPrivacyAddress(v.address)) continue;
      const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      const parsed = parseAddressUnit(v.address);
      insert.run(walkId, parsed.street, parsed.unit, v.city || '', v.zip || '', voterName, v.id, i++);
    }
    return i;
  });
  const added = addAll();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Walk created from voter list: ' + added + ' addresses' + (precincts.length > 0 ? ' (precincts: ' + precincts.join(', ') + ')' : '')
  );

  geocodeWalkAddresses(walkId);
  res.json({ success: true, id: walkId, added });
});

// ===================== PER-WALKER LIVE ROUTE =====================

// Get optimized route for a specific walker (all unvisited addresses in the walk)
// Supports starting from current GPS position via query params
router.get('/walks/:id/walker/:name/route', (req, res) => {
  const { lat, lng } = req.query;

  const addresses = db.prepare(
    "SELECT id, address, city, zip, lat, lng, assigned_walker FROM walk_addresses WHERE walk_id = ? AND result = 'not_visited' ORDER BY sort_order, id"
  ).all(req.params.id);

  if (addresses.length === 0) return res.json({ route: [], mapsUrl: '', remaining: 0 });

  // Nearest-neighbor from walker's current position (or first address)
  const hasCoords = addresses.filter(a => a.lat && a.lng);
  let ordered;

  if (hasCoords.length >= 2) {
    const remaining = [...hasCoords];
    // If walker's GPS position provided, start nearest to them
    let start;
    if (lat && lng && isValidCoord(parseFloat(lat), parseFloat(lng))) {
      const wLat = parseFloat(lat), wLng = parseFloat(lng);
      let nearestIdx = 0, nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = gpsDistance(wLat, wLng, remaining[i].lat, remaining[i].lng);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      start = remaining.splice(nearestIdx, 1)[0];
    } else {
      start = remaining.shift();
    }

    ordered = [start];
    while (remaining.length > 0) {
      const last = ordered[ordered.length - 1];
      let nearest = 0, nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = gpsDistance(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
        if (d < nearestDist) { nearestDist = d; nearest = i; }
      }
      ordered.push(remaining.splice(nearest, 1)[0]);
    }
    const noCoords = addresses.filter(a => !a.lat || !a.lng);
    ordered = ordered.concat(noCoords);
  } else {
    ordered = addresses;
  }

  // Build Google Maps URL
  const waypoints = ordered.map(a => {
    if (a.lat && a.lng) return a.lat + ',' + a.lng;
    return encodeURIComponent((a.address || '') + ' ' + (a.city || '') + ' ' + (a.zip || ''));
  });

  let mapsUrl = '';
  if (waypoints.length >= 2) {
    const origin = (lat && lng) ? lat + ',' + lng : waypoints[0];
    const dest = waypoints[waypoints.length - 1];
    // Exclude origin from waypoints if user GPS is used as origin, otherwise exclude last (it's the dest)
    const middle = (lat && lng) ? waypoints.slice(0, -1).join('|') : waypoints.slice(1, -1).join('|');
    mapsUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + origin + '&destination=' + dest;
    if (middle) mapsUrl += '&waypoints=' + middle;
  } else if (waypoints.length === 1) {
    const origin = (lat && lng) ? lat + ',' + lng : waypoints[0];
    mapsUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + origin + '&destination=' + waypoints[0];
  }

  // Return optimized route without modifying DB (GET should be read-only)
  res.json({
    route: ordered.map(a => ({ id: a.id, address: a.address, city: a.city, zip: a.zip })),
    mapsUrl,
    remaining: ordered.length,
    optimized: hasCoords.length >= 2
  });
});

// ===================== LIVE GROUP STATUS =====================

// Real-time group progress: shows all walkers' status and remaining counts
router.get('/walks/:id/live-status', (req, res) => {
  const walk = db.prepare('SELECT id, name, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const members = db.prepare('SELECT walker_name, joined_at FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(req.params.id);

  const allAddresses = db.prepare(
    'SELECT id, address, unit, voter_name, result, assigned_walker, knocked_at, lat, lng, geo_flagged, outside_precinct FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
  ).all(req.params.id);

  const doorProgress = countDoors(allAddresses);

  // Per-walker breakdown (count unique doors per walker)
  const walkerStats = {};
  for (const m of members) {
    walkerStats[m.walker_name] = { total: 0, knocked: 0, remaining: 0 };
  }
  const walkerDoors = {};
  for (const a of allAddresses) {
    if (a.assigned_walker && walkerStats[a.assigned_walker]) {
      const doorKey = (a.address || '').trim().toLowerCase() + '||' + (a.unit || '').trim().toLowerCase();
      const wk = a.assigned_walker + '||' + doorKey;
      if (!walkerDoors[wk]) {
        walkerDoors[wk] = { knocked: false };
        walkerStats[a.assigned_walker].total++;
      }
      if (a.result !== 'not_visited') {
        walkerDoors[wk].knocked = true;
      }
    }
  }
  for (const wName of Object.keys(walkerStats)) {
    const ws = walkerStats[wName];
    // Recount knocked from unique doors
    ws.knocked = 0;
    for (const dk of Object.keys(walkerDoors)) {
      if (dk.startsWith(wName + '||') && walkerDoors[dk].knocked) ws.knocked++;
    }
    ws.remaining = ws.total - ws.knocked;
  }

  // Recent knocks (last 20) for live feed
  const recentKnocks = allAddresses
    .filter(a => a.result !== 'not_visited' && a.knocked_at)
    .sort((a, b) => b.knocked_at.localeCompare(a.knocked_at))
    .slice(0, 20)
    .map(a => ({
      address: a.address,
      unit: a.unit || '',
      voter_name: a.voter_name,
      result: a.result,
      walker: a.assigned_walker,
      knocked_at: a.knocked_at
    }));

  // Walker GPS locations
  const locations = db.prepare(
    'SELECT walker_name, lat, lng, accuracy, updated_at FROM walker_locations WHERE walk_id = ? ORDER BY updated_at DESC'
  ).all(req.params.id);

  // Address results with coordinates for live map updates
  const addressResults = allAddresses
    .filter(a => a.lat && a.lng)
    .map(a => ({ id: a.id, address: a.address, voter_name: a.voter_name, result: a.result, lat: a.lat, lng: a.lng }));

  res.json({
    walk,
    progress: doorProgress,
    members,
    walkerStats,
    recentKnocks,
    locations,
    addressResults
  });
});

// ===================== MAP DATA FOR WALKERS =====================

// Lightweight endpoint returning all addresses with coords + status for the live map
// Used by walkers to see which houses have been visited by anyone in the group
router.get('/walks/:id/map-data', (req, res) => {
  const walk = db.prepare('SELECT id, name FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const addresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.voter_id, wa.result, wa.assigned_walker, wa.lat, wa.lng,
            v.age as voter_age, v.party_score as voter_party_score
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  buildHouseholdFromWalkAddresses(addresses);

  const locations = db.prepare(
    'SELECT walker_name, lat, lng, accuracy, updated_at FROM walker_locations WHERE walk_id = ? ORDER BY updated_at DESC'
  ).all(req.params.id);

  res.json({ addresses, locations, progress: countDoors(addresses) });
});

// ===================== GEOCODE WALK ADDRESSES =====================

// Trigger geocoding for a walk's addresses that are missing coordinates
// Pass ?force=true to clear existing coordinates and re-geocode everything
router.post('/walks/:id/geocode', (req, res) => {
  const walk = db.prepare('SELECT id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const wid = parseInt(req.params.id);

  // Force mode: clear all existing coords so they get re-geocoded with improved logic
  // But don't clear if geocoding is already in progress — that would destroy partial results
  if (req.query.force === 'true' || (req.body && req.body.force)) {
    if (geocodingInProgress[wid]) {
      return res.json({ message: 'Geocoding already in progress. Wait for it to finish before re-geocoding.', pending: 0, inProgress: true });
    }
    db.prepare('UPDATE walk_addresses SET lat = NULL, lng = NULL WHERE walk_id = ?').run(req.params.id);
  }

  const missing = db.prepare(
    'SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND lat IS NULL'
  ).get(req.params.id);

  if (missing.c === 0) return res.json({ message: 'All addresses already have coordinates.', pending: 0 });

  if (geocodingInProgress[wid]) {
    return res.json({ message: 'Geocoding already in progress — ' + missing.c + ' addresses remaining.', pending: missing.c, inProgress: true });
  }

  // Pass source precincts so out-of-boundary addresses get filtered after geocoding
  const walkRow = db.prepare('SELECT source_precincts FROM block_walks WHERE id = ?').get(wid);
  const srcPrecincts = (walkRow && walkRow.source_precincts) ? walkRow.source_precincts.split(',').map(s => s.trim()).filter(Boolean) : null;
  geocodeWalkAddresses(wid, srcPrecincts);
  res.json({ message: 'Geocoding started for ' + missing.c + ' addresses. Map will update as coordinates are resolved.', pending: missing.c });
});

// ===================== FLAG / FIX BAD GEOCODES =====================

// Flag an address as having a bad geocode location
router.post('/walks/:walkId/addresses/:addrId/flag-location', (req, res) => {
  const addr = db.prepare('SELECT id, walk_id FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });
  db.prepare('UPDATE walk_addresses SET geo_flagged = 1 WHERE id = ?').run(addr.id);
  res.json({ success: true, message: 'Location flagged as incorrect.' });
});

// Unflag an address
router.post('/walks/:walkId/addresses/:addrId/unflag-location', (req, res) => {
  const addr = db.prepare('SELECT id, walk_id FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });
  db.prepare('UPDATE walk_addresses SET geo_flagged = 0 WHERE id = ?').run(addr.id);
  res.json({ success: true });
});

// Manually set lat/lng for an address (admin drag-correct)
router.post('/walks/:walkId/addresses/:addrId/fix-location', (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required.' });
  if (!isValidCoord(lat, lng)) return res.status(400).json({ error: 'Invalid coordinates.' });
  const addr = db.prepare('SELECT id, walk_id FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });
  db.prepare('UPDATE walk_addresses SET lat = ?, lng = ?, geo_flagged = 0 WHERE id = ?').run(lat, lng, addr.id);
  res.json({ success: true, message: 'Location updated.' });
});

// Re-geocode a single flagged address
router.post('/walks/:walkId/addresses/:addrId/regeocode', async (req, res) => {
  try {
    const addr = db.prepare('SELECT id, walk_id, address, city, zip FROM walk_addresses WHERE id = ? AND walk_id = ?').get(req.params.addrId, req.params.walkId);
    if (!addr) return res.status(404).json({ error: 'Address not found.' });
    // Try all geocoders in order
    let coords = null;
    if (GOOGLE_GEOCODE_KEY) {
      coords = await geocodeAddressGoogle(addr.address, addr.city, addr.zip);
    }
    if (!coords) {
      coords = await geocodeAddressCensus(addr.address, addr.city, addr.zip);
    }
    if (!coords) {
      coords = await geocodeAddressNominatim(addr.address, addr.city, addr.zip);
    }
    if (coords) {
      db.prepare('UPDATE walk_addresses SET lat = ?, lng = ?, geo_flagged = 0 WHERE id = ?').run(coords.lat, coords.lng, addr.id);
      res.json({ success: true, lat: coords.lat, lng: coords.lng, message: 'Re-geocoded successfully.' });
    } else {
      res.json({ success: false, message: 'Could not geocode this address. Try manually correcting it on the map.' });
    }
  } catch (err) {
    console.error('Regeocode error:', err.message);
    res.status(500).json({ error: 'Geocoding failed.' });
  }
});

// Get all flagged addresses for a walk
router.get('/walks/:id/flagged-addresses', (req, res) => {
  const rows = db.prepare('SELECT id, address, unit, city, zip, voter_name, lat, lng FROM walk_addresses WHERE walk_id = ? AND geo_flagged = 1').all(req.params.id);
  res.json({ flagged: rows });
});

// ===================== WALKER LOCATION TRACKING =====================

// Walker broadcasts GPS position (called every 60 seconds from walk app)
router.post('/walks/:id/location', (req, res) => {
  const { walker_name, lat, lng, accuracy } = req.body;
  if (!walker_name || lat == null || lng == null) {
    return res.status(400).json({ error: 'walker_name, lat, and lng are required.' });
  }
  if (!isValidCoord(lat, lng)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  const walk = db.prepare('SELECT id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  // Verify the walker is a member of this walk group
  const member = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? AND walker_name = ?').get(req.params.id, walker_name);
  if (!member) return res.status(403).json({ error: 'Not a member of this walk group.' });

  db.prepare(`
    INSERT INTO walker_locations (walk_id, walker_name, lat, lng, accuracy, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(walk_id, walker_name) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = datetime('now')
  `).run(req.params.id, walker_name, lat, lng, accuracy || null);

  res.json({ ok: true });
});

// ===================== AVAILABLE ELECTIONS (for filter dropdowns) =====================
router.get('/walk-elections', (req, res) => {
  const elections = db.prepare(`
    SELECT election_name, election_date, election_type, COUNT(DISTINCT voter_id) as voter_count
    FROM election_votes
    GROUP BY election_name
    ORDER BY election_date DESC
  `).all();
  res.json({ elections });
});

// ===================== CANVASSING SCRIPTS =====================

// List all scripts
router.get('/walk-scripts', (req, res) => {
  const scripts = db.prepare('SELECT * FROM walk_scripts ORDER BY is_default DESC, id DESC').all();
  res.json({ scripts });
});

// Create a script
router.post('/walk-scripts', (req, res) => {
  const { name, description, elements, is_default } = req.body;
  if (!name) return res.status(400).json({ error: 'Script name is required.' });

  const result = db.prepare(
    'INSERT INTO walk_scripts (name, description, is_default) VALUES (?, ?, ?)'
  ).run(name, description || '', is_default ? 1 : 0);
  const scriptId = result.lastInsertRowid;

  // If set as default, unset other defaults
  if (is_default) {
    db.prepare('UPDATE walk_scripts SET is_default = 0 WHERE id != ?').run(scriptId);
  }

  // Insert elements
  if (elements && elements.length > 0) {
    const insertEl = db.prepare(
      'INSERT INTO walk_script_elements (script_id, element_type, sort_order, label, content, options_json, parent_element_id, parent_option_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const addElements = db.transaction((els) => {
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        insertEl.run(
          scriptId, el.element_type || 'text', i,
          el.label || '', el.content || '',
          JSON.stringify(el.options || []),
          el.parent_element_id || null, el.parent_option_key || null
        );
      }
    });
    addElements(elements);
  }

  res.json({ success: true, id: scriptId });
});

// Get script with elements
router.get('/walk-scripts/:id', (req, res) => {
  const script = db.prepare('SELECT * FROM walk_scripts WHERE id = ?').get(req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });
  script.elements = db.prepare(
    'SELECT * FROM walk_script_elements WHERE script_id = ? ORDER BY sort_order'
  ).all(req.params.id);
  // Parse options JSON
  for (const el of script.elements) {
    try { el.options = JSON.parse(el.options_json || '[]'); } catch { el.options = []; }
  }
  res.json({ script });
});

// Update a script
router.put('/walk-scripts/:id', (req, res) => {
  const { name, description, elements, is_default } = req.body;
  const script = db.prepare('SELECT id FROM walk_scripts WHERE id = ?').get(req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  db.prepare(
    'UPDATE walk_scripts SET name = COALESCE(?, name), description = COALESCE(?, description), is_default = COALESCE(?, is_default) WHERE id = ?'
  ).run(name, description, is_default != null ? (is_default ? 1 : 0) : null, req.params.id);

  if (is_default) {
    db.prepare('UPDATE walk_scripts SET is_default = 0 WHERE id != ?').run(req.params.id);
  }

  // Replace elements if provided
  if (elements) {
    const replaceElements = db.transaction(() => {
      db.prepare('DELETE FROM walk_script_elements WHERE script_id = ?').run(req.params.id);
      const insertEl = db.prepare(
        'INSERT INTO walk_script_elements (script_id, element_type, sort_order, label, content, options_json, parent_element_id, parent_option_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        insertEl.run(
          req.params.id, el.element_type || 'text', i,
          el.label || '', el.content || '',
          JSON.stringify(el.options || []),
          el.parent_element_id || null, el.parent_option_key || null
        );
      }
    });
    replaceElements();
  }

  res.json({ success: true });
});

// Delete a script
router.delete('/walk-scripts/:id', (req, res) => {
  // Clean up references: set script_id to NULL on walks and universes using this script
  db.prepare('UPDATE block_walks SET script_id = NULL WHERE script_id = ?').run(req.params.id);
  db.prepare('UPDATE walk_universes SET script_id = NULL WHERE script_id = ?').run(req.params.id);
  db.prepare('DELETE FROM walk_scripts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get script for a walk (public endpoint for volunteer app)
router.get('/walks/:id/script', (req, res) => {
  const walk = db.prepare('SELECT script_id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  let script = null;
  if (walk.script_id) {
    script = db.prepare('SELECT * FROM walk_scripts WHERE id = ?').get(walk.script_id);
  }
  if (!script) {
    // Fall back to default script
    script = db.prepare('SELECT * FROM walk_scripts WHERE is_default = 1').get();
  }
  if (!script) return res.json({ script: null });

  script.elements = db.prepare(
    'SELECT * FROM walk_script_elements WHERE script_id = ? ORDER BY sort_order'
  ).all(script.id);
  for (const el of script.elements) {
    try { el.options = JSON.parse(el.options_json || '[]'); } catch { el.options = []; }
  }
  res.json({ script });
});

// Assign a script to a walk
router.put('/walks/:id/script', (req, res) => {
  const { script_id } = req.body;
  db.prepare('UPDATE block_walks SET script_id = ? WHERE id = ?').run(script_id || null, req.params.id);
  res.json({ success: true });
});

// ===================== ATTEMPT TRACKING =====================

// Get attempt history for an address
router.get('/walks/:walkId/addresses/:addrId/attempts', (req, res) => {
  const attempts = db.prepare(
    'SELECT * FROM walk_attempts WHERE address_id = ? AND walk_id = ? ORDER BY attempted_at DESC'
  ).all(req.params.addrId, req.params.walkId);
  for (const a of attempts) {
    try { a.survey_responses = JSON.parse(a.survey_responses_json || 'null'); } catch { a.survey_responses = null; }
  }
  res.json({ attempts });
});

// Get all attempt stats for a walk
router.get('/walks/:id/attempt-stats', (req, res) => {
  const walk = db.prepare('SELECT id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_attempts,
      COUNT(DISTINCT address_id) as unique_addresses,
      SUM(CASE WHEN result = 'not_home' THEN 1 ELSE 0 END) as not_home_count,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts_made,
      COUNT(DISTINCT walker_name) as unique_walkers
    FROM walk_attempts WHERE walk_id = ?
  `).get(req.params.id);

  // Per-walker stats
  const walkerStats = db.prepare(`
    SELECT
      walker_name,
      COUNT(*) as attempts,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      MIN(attempted_at) as first_attempt,
      MAX(attempted_at) as last_attempt
    FROM walk_attempts WHERE walk_id = ? AND walker_name != ''
    GROUP BY walker_name ORDER BY attempts DESC
  `).all(req.params.id);

  // Calculate doors per hour for each walker
  for (const w of walkerStats) {
    if (w.first_attempt && w.last_attempt && w.first_attempt !== w.last_attempt) {
      const hours = (new Date(w.last_attempt) - new Date(w.first_attempt)) / 3600000;
      w.doors_per_hour = hours > 0 ? Math.round(w.attempts / hours * 10) / 10 : 0;
    } else {
      w.doors_per_hour = 0;
    }
    w.contact_rate = w.attempts > 0 ? Math.round(w.contacts / w.attempts * 100) : 0;
  }

  // Addresses needing re-knock (last attempt was not_home or come_back)
  const reknockNeeded = db.prepare(`
    SELECT wa.id, wa.address, wa.voter_name, wa.city, wa.zip,
      COUNT(at.id) as attempt_count,
      MAX(at.attempted_at) as last_attempt
    FROM walk_addresses wa
    JOIN walk_attempts at ON at.address_id = wa.id
    WHERE wa.walk_id = ? AND wa.result IN ('not_home', 'come_back')
    GROUP BY wa.id
    ORDER BY attempt_count ASC, last_attempt ASC
  `).all(req.params.id);

  res.json({ stats, walkerStats, reknockNeeded });
});

// ===================== DISTRIBUTED CANVASSING =====================

// Create a distributed canvassing universe
router.post('/walk-universes', (req, res) => {
  const { name, script_id, doors_per_turf, precincts, filters } = req.body;
  if (!name) return res.status(400).json({ error: 'Universe name is required.' });
  if (!precincts || !precincts.length) return res.status(400).json({ error: 'At least one precinct is required.' });

  const shareCode = generateAlphaCode(6);
  const filtersJson = JSON.stringify({ precincts, ...(filters || {}) });

  const result = db.prepare(
    'INSERT INTO walk_universes (name, share_code, script_id, doors_per_turf, filters_json) VALUES (?, ?, ?, ?, ?)'
  ).run(name, shareCode, script_id || null, doors_per_turf || 30, filtersJson);

  res.json({ success: true, id: result.lastInsertRowid, shareCode });
});

// List universes
router.get('/walk-universes', (req, res) => {
  const universes = db.prepare(`
    SELECT wu.*,
      (SELECT COUNT(DISTINCT wa.id) FROM walk_addresses wa WHERE wa.universe_id = wu.id) as assigned_doors,
      (SELECT COUNT(DISTINCT wa.id) FROM walk_addresses wa WHERE wa.universe_id = wu.id AND wa.result != 'not_visited') as knocked_doors
    FROM walk_universes wu ORDER BY wu.id DESC
  `).all();
  for (const u of universes) {
    try { u.filters = JSON.parse(u.filters_json || '{}'); } catch { u.filters = {}; }
  }
  res.json({ universes });
});

// Volunteer self-assigns turf from a universe based on GPS location
const distributedJoinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many requests, try again later.' } });

router.post('/walk-universes/claim', distributedJoinLimiter, (req, res) => {
  const { shareCode, walkerName, phone, lat, lng } = req.body;
  if (!shareCode || !walkerName) return res.status(400).json({ error: 'Share code and name are required.' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });

  // Check if this phone already claimed turf in this universe
  const universe0 = db.prepare("SELECT id FROM walk_universes WHERE share_code = ? AND status = 'active'").get(String(shareCode).toUpperCase());
  if (universe0) {
    const existingWalk = db.prepare(
      "SELECT bw.id, bw.name, bw.join_code FROM block_walks bw JOIN walk_addresses wa ON wa.walk_id = bw.id WHERE wa.universe_id = ? AND bw.assigned_to IN (SELECT walker_name FROM walk_group_members WHERE phone = ?) LIMIT 1"
    ).get(universe0.id, normPhone);
    if (!existingWalk) {
      // Also check assigned_to directly (distributed walks store walker name there)
      const existingByPhone = db.prepare(
        "SELECT bw.id, bw.name, bw.join_code FROM block_walks bw JOIN walk_addresses wa ON wa.walk_id = bw.id WHERE wa.universe_id = ? AND bw.id IN (SELECT walk_id FROM walk_group_members WHERE phone = ?) LIMIT 1"
      ).get(universe0.id, normPhone);
      if (existingByPhone) {
        return res.json({ success: true, walkId: existingByPhone.id, added: 0, walkName: existingByPhone.name, alreadyClaimed: true });
      }
    } else {
      return res.json({ success: true, walkId: existingWalk.id, added: 0, walkName: existingWalk.name, alreadyClaimed: true });
    }
  }

  const universe = db.prepare("SELECT * FROM walk_universes WHERE share_code = ? AND status = 'active'").get(String(shareCode).toUpperCase());
  if (!universe) return res.status(404).json({ error: 'Invalid share code or universe is closed.' });

  let filters;
  try { filters = JSON.parse(universe.filters_json || '{}'); } catch { filters = {}; }
  const precincts = filters.precincts || [];
  if (precincts.length === 0) return res.status(400).json({ error: 'Universe has no precincts configured.' });

  // Find voters in the universe precincts who aren't already assigned
  let sql = "SELECT v.id, v.first_name, v.last_name, v.address, v.city, v.zip FROM voters v WHERE v.precinct IN (" + precincts.map(() => '?').join(',') + ") AND v.address != ''";
  const params = [...precincts];

  // Exclude already assigned voters in this universe
  sql += " AND v.id NOT IN (SELECT wa.voter_id FROM walk_addresses wa WHERE wa.universe_id = ? AND wa.voter_id IS NOT NULL)";
  params.push(universe.id);

  if (filters.party && !filters.party_score && !filters.party_voted) { filters = Object.assign({}, filters, { party_voted: filters.party }); } // legacy party filter fallback
  if (filters.support_level) { sql += ' AND v.support_level = ?'; params.push(filters.support_level); }
  if (filters.exclude_contacted) {
    sql += ' AND v.id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
  }
  if (filters.exclude_early_voted) {
    sql += ' AND v.early_voted = 0';
  }
  // Voting history filters — the "v" alias maps to "voters" in the helper
  // We need to adjust for the alias
  const votingParams = [];
  let votingSql = buildVotingHistorySQL(filters, votingParams);
  if (votingSql) {
    sql += votingSql.replace(/voters\./g, 'v.');
    params.push(...votingParams);
  }

  // Wrap the entire claim in a transaction to prevent race conditions
  // (two concurrent claims could otherwise assign the same voters)
  const claimResult = db.transaction(() => {
    const available = db.prepare(sql).all(...params);
    if (available.length === 0) return { error: 'No more doors available in this universe. All have been assigned!' };

    const doorsToAssign = Math.min(universe.doors_per_turf || 30, available.length);
    const selected = available.slice(0, doorsToAssign);

    // Create a walk for this volunteer
    const joinCode = generateAlphaCode(4);
    const walkName = universe.name + ' - ' + walkerName;
    const walkResult = db.prepare(
      'INSERT INTO block_walks (name, description, assigned_to, join_code, script_id, source_precincts, source_filters_json, max_walkers) VALUES (?, ?, ?, ?, ?, ?, ?, 10)'
    ).run(walkName, 'Auto-assigned from universe: ' + universe.name, walkerName, joinCode, universe.script_id, precincts.join(','), universe.filters_json);
    const walkId = walkResult.lastInsertRowid;

    // Track walker with phone for dedup across claims
    try {
      db.prepare('INSERT INTO walk_group_members (walk_id, walker_name, phone) VALUES (?, ?, ?)').run(walkId, walkerName, normPhone);
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint')) throw e;
    }

    // Add addresses
    const insert = db.prepare(
      'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order, universe_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let i = 0;
    for (const v of selected) {
      const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      const parsed = parseAddressUnit(v.address);
      insert.run(walkId, parsed.street, parsed.unit, v.city || '', v.zip || '', voterName, v.id, i++, universe.id);
    }

    return { walkId, walkName, added: i, joinCode };
  })();

  if (claimResult.error) return res.status(400).json({ error: claimResult.error });
  const { walkId, walkName: claimedWalkName, added, joinCode: claimedJoinCode } = claimResult;

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Distributed canvass: ' + walkerName + ' claimed ' + added + ' doors from ' + universe.name
  );

  geocodeWalkAddresses(walkId);
  res.json({ success: true, walkId, added, walkName: claimedWalkName, joinCode: claimedJoinCode });
});

// Delete/close a universe
router.put('/walk-universes/:id', (req, res) => {
  const { status, name, doors_per_turf, script_id } = req.body;
  db.prepare(
    'UPDATE walk_universes SET status = COALESCE(?, status), name = COALESCE(?, name), doors_per_turf = COALESCE(?, doors_per_turf), script_id = COALESCE(?, script_id) WHERE id = ?'
  ).run(status, name, doors_per_turf, script_id, req.params.id);
  res.json({ success: true });
});

router.delete('/walk-universes/:id', (req, res) => {
  db.prepare('DELETE FROM walk_universes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===================== CANVASSER LEADERBOARD =====================

// ===================== TURF REFRESH =====================

// Refresh a walk's voter list — remove contacted/voted, add new matching voters
router.post('/walks/:id/refresh', (req, res) => {
  const walk = db.prepare('SELECT * FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  if (!walk.source_precincts) {
    return res.status(400).json({ error: 'This walk was not created from precincts, so it cannot be refreshed. Only precinct-based walks support refresh.' });
  }

  const precincts = walk.source_precincts.split(',').filter(Boolean);
  let filters;
  try { filters = JSON.parse(walk.source_filters_json || '{}'); } catch { filters = {}; }

  // Build the same query as from-precinct, to find current matching voters
  let sql = "SELECT id, first_name, last_name, address, city, zip FROM voters WHERE precinct IN (" + precincts.map(() => '?').join(',') + ") AND address != ''";
  const params = [...precincts];

  if (filters.party && !filters.party_score && !filters.party_voted) { filters = Object.assign({}, filters, { party_voted: filters.party }); } // legacy party filter fallback
  if (filters.support_level) { sql += ' AND support_level = ?'; params.push(filters.support_level); }
  if (filters.exclude_contacted) {
    sql += ' AND id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
  }
  // Voting history filters
  sql += buildVotingHistorySQL(filters, params);
  // Match the original walk creation: only exclude early voted if the filter was set
  if (filters.exclude_early_voted) {
    sql += " AND (early_voted IS NULL OR early_voted = 0 OR early_voted = '')";
  }
  sql += ' ORDER BY address, last_name';

  const freshVoters = db.prepare(sql).all(...params);
  const freshIds = new Set(freshVoters.map(v => v.id));

  // Current walk addresses with voter_id
  const currentAddrs = db.prepare('SELECT id, voter_id, result FROM walk_addresses WHERE walk_id = ?').all(req.params.id);

  const refreshResult = db.transaction(() => {
    let removed = 0;
    let added = 0;
    const existingVoterIds = new Set();

    // Remove addresses where voter no longer matches criteria (but keep already-knocked ones as history)
    for (const addr of currentAddrs) {
      if (addr.voter_id) {
        existingVoterIds.add(addr.voter_id);
        if (!freshIds.has(addr.voter_id) && addr.result === 'not_visited') {
          db.prepare('DELETE FROM walk_addresses WHERE id = ?').run(addr.id);
          removed++;
        }
      }
    }

    // Add new voters that aren't already in the walk
    const maxSort = (db.prepare('SELECT MAX(sort_order) as m FROM walk_addresses WHERE walk_id = ?').get(req.params.id) || { m: 0 }).m || 0;
    const insertAddr = db.prepare(
      'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let sortIdx = maxSort + 1;
    for (const v of freshVoters) {
      if (!existingVoterIds.has(v.id)) {
        const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
        const parsed = parseAddressUnit(v.address);
        insertAddr.run(req.params.id, parsed.street, parsed.unit, v.city || '', v.zip || '', voterName, v.id, sortIdx++);
        added++;
      }
    }

    return { removed, added };
  });
  const result = refreshResult();

  // Re-geocode any new addresses (with precinct filtering if applicable)
  if (result.added > 0) {
    const srcPrecincts = walk.source_precincts ? walk.source_precincts.split(',').map(s => s.trim()).filter(Boolean) : null;
    geocodeWalkAddresses(parseInt(req.params.id), srcPrecincts);
  }

  // Re-split if group walk
  const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(req.params.id);
  if (members && members.c > 0) {
    splitAddresses(parseInt(req.params.id));
  }

  res.json({
    success: true,
    removed: result.removed,
    added: result.added,
    message: 'Turf refreshed: ' + result.removed + ' removed, ' + result.added + ' added'
  });
});

// ===================== PRINT WALK LIST =====================

router.get('/walks/:id/print', (req, res) => {
  const walk = db.prepare('SELECT * FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const addresses = db.prepare(
    'SELECT * FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
  ).all(req.params.id);

  // Get attempt counts
  const attemptCounts = {};
  const attempts = db.prepare(
    'SELECT address_id, COUNT(*) as c FROM walk_attempts WHERE walk_id = ? GROUP BY address_id'
  ).all(req.params.id);
  for (const a of attempts) attemptCounts[a.address_id] = a.c;

  // Get script if attached
  let script = null;
  if (walk.script_id) {
    script = db.prepare('SELECT * FROM walk_scripts WHERE id = ?').get(walk.script_id);
    if (script) {
      script.elements = db.prepare(
        'SELECT * FROM walk_script_elements WHERE script_id = ? ORDER BY sort_order'
      ).all(script.id);
      for (const el of script.elements) {
        try { el.options = JSON.parse(el.options_json || '[]'); } catch { el.options = []; }
      }
    }
  }

  // Generate printable HTML
  const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Walk List: ${escH(walk.name)}</title>
<style>
@media print { @page { margin: 0.5in; } body { -webkit-print-color-adjust: exact; } .no-print { display: none !important; } }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; font-size: 12px; color: #000; background: #fff; padding: 20px; }
h1 { font-size: 18px; margin-bottom: 4px; }
.meta { color: #666; font-size: 11px; margin-bottom: 12px; }
.print-btn { position: fixed; top: 10px; right: 10px; padding: 10px 20px; background: #f59e0b; color: #000; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; z-index: 100; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th { background: #f3f4f6; padding: 6px 8px; text-align: left; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #000; }
td { padding: 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
tr:nth-child(even) { background: #f9fafb; }
.num { font-weight: 700; text-align: center; width: 30px; }
.addr { min-width: 200px; }
.voter { min-width: 120px; }
.result-box { width: 100px; border: 1px solid #999; height: 20px; }
.notes-box { width: 150px; border: 1px solid #999; height: 20px; }
.script-section { margin-top: 20px; padding: 12px; border: 1px solid #ccc; border-radius: 4px; background: #fefce8; page-break-inside: avoid; }
.script-section h3 { font-size: 14px; margin-bottom: 8px; }
.script-q { margin-bottom: 10px; }
.script-q label { font-weight: 700; }
.script-options { margin-top: 4px; }
.script-option { display: inline-block; margin-right: 16px; }
.script-option input[type=checkbox] { margin-right: 4px; }
.attempts-col { width: 40px; text-align: center; }
.disp-codes { margin-top: 6px; font-size: 10px; color: #666; }
.disp-code { display: inline-block; margin-right: 8px; }
</style></head><body>
<button class="print-btn no-print" onclick="window.print()">Print Walk List</button>
<h1>${escH(walk.name)}</h1>
<div class="meta">
  Walk #${walk.id} | ${addresses.length} doors | Assigned: ${escH(walk.assigned_to) || 'Unassigned'} | Printed: ${new Date().toLocaleDateString()}
  ${walk.join_code ? ' | Join Code: ' + walk.join_code : ''}
</div>
<div class="disp-codes">
  <strong>Result Codes:</strong>
  <span class="disp-code">S = Support</span>
  <span class="disp-code">LS = Lean Support</span>
  <span class="disp-code">U = Undecided</span>
  <span class="disp-code">LO = Lean Oppose</span>
  <span class="disp-code">O = Oppose</span>
  <span class="disp-code">NH = Not Home</span>
  <span class="disp-code">R = Refused</span>
  <span class="disp-code">M = Moved</span>
  <span class="disp-code">CB = Come Back</span>
</div>`;

  // Script talking points
  if (script && script.elements && script.elements.length > 0) {
    html += `<div class="script-section"><h3>Canvassing Script: ${escH(script.name)}</h3>`;
    for (const el of script.elements) {
      if (el.element_type === 'text') {
        html += `<p style="margin-bottom:8px">${escH(el.content)}</p>`;
      } else if (el.element_type === 'survey') {
        html += `<div class="script-q"><label>${escH(el.label)}</label>`;
        if (el.options && el.options.length > 0) {
          html += '<div class="script-options">';
          for (const opt of el.options) {
            html += `<span class="script-option">&#9633; ${escH(opt.label || opt)}</span>`;
          }
          html += '</div>';
        }
        html += '</div>';
      } else if (el.element_type === 'activist_code') {
        html += `<div class="script-q"><label>&#9633; ${escH(el.label)}</label> <span style="color:#666;font-size:10px">(check if applicable)</span></div>`;
      }
    }
    html += '</div>';
  }

  html += `<table>
<thead><tr>
  <th class="num">#</th>
  <th class="addr">Address</th>
  <th class="voter">Voter</th>
  <th class="attempts-col">Att.</th>
  <th>Result</th>
  <th>Notes</th>
</tr></thead><tbody>`;

  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    const fullAddr = a.address + (a.unit ? ' ' + a.unit : '') + (a.city ? ', ' + a.city : '') + (a.zip ? ' ' + a.zip : '');
    const attCount = attemptCounts[a.id] || 0;
    html += `<tr>
  <td class="num">${i + 1}</td>
  <td class="addr">${escH(fullAddr)}</td>
  <td class="voter">${escH(a.voter_name)}</td>
  <td class="attempts-col">${attCount || ''}</td>
  <td><div class="result-box"></div></td>
  <td><div class="notes-box"></div></td>
</tr>`;
  }

  html += '</tbody></table></body></html>';
  res.type('html').send(html);
});

// ===================== WALKER ASSIGNMENT (admin-controlled) =====================

// Admin-assign a walker to a walk
router.post('/walks/:id/assign-walker', (req, res) => {
  const { walker_id } = req.body;
  if (!walker_id) return res.status(400).json({ error: 'walker_id is required.' });

  const walk = db.prepare('SELECT * FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const walker = db.prepare('SELECT * FROM walkers WHERE id = ?').get(walker_id);
  if (!walker) return res.status(404).json({ error: 'Walker not found.' });

  // Cap at walk.max_walkers (default 10). The count-check + insert must
  // happen atomically in a transaction, otherwise two concurrent assigns
  // can both read count<cap and both insert, exceeding the cap. SQLite
  // serializes writes but not reads, so without the transaction the
  // SELECT and INSERT on different prepared statements can interleave.
  const cap = walk.max_walkers || 10;
  const result = db.transaction(() => {
    const count = (db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(req.params.id) || { c: 0 }).c;
    if (count >= cap) return { full: true };
    const existing = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_id = ?').get(req.params.id, walker_id);
    if (existing) return { duplicate: true };
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)').run(req.params.id, walker.name, walker.id, walker.phone || '');
    return { success: true };
  })();

  if (result.full) return res.status(400).json({ error: 'Walk is full (max ' + cap + ' walkers).' });
  if (result.duplicate) return res.status(400).json({ error: 'Walker already assigned to this walk.' });
  res.json({ success: true });
});

// Remove walker from walk
router.post('/walks/:id/remove-walker', (req, res) => {
  const { walker_id } = req.body;
  if (!walker_id) return res.status(400).json({ error: 'walker_id is required.' });
  db.prepare('DELETE FROM walk_group_members WHERE walk_id = ? AND walker_id = ?').run(req.params.id, walker_id);
  res.json({ success: true });
});

// List walkers assigned to a walk (with per-walk stats)
// Fixed: use LEFT JOIN to include legacy walkers without walker_id
router.get('/walks/:id/walkers', (req, res) => {
  const members = db.prepare(`
    SELECT wgm.walker_id, wgm.walker_name, wgm.joined_at, wgm.doors_knocked, wgm.contacts_made,
      wgm.first_knock_at, wgm.last_knock_at, wgm.phone,
      COALESCE(w.name, wgm.walker_name) as walker_name,
      w.code as walker_code, w.is_active, w.phone as walker_phone
    FROM walk_group_members wgm
    LEFT JOIN walkers w ON w.id = wgm.walker_id
    WHERE wgm.walk_id = ?
    ORDER BY wgm.joined_at
  `).all(req.params.id);
  res.json({ members });
});

// Get all addresses for a walker (no split — everyone sees everything, first-knock-gets-credit)
router.get('/walks/:id/walker-by-id/:walkerId', (req, res) => {
  const walkerId = parseInt(req.params.walkerId, 10);
  if (isNaN(walkerId) || walkerId <= 0) return res.status(400).json({ error: 'Invalid walker ID.' });

  const walk = db.prepare('SELECT id, name, description, status, script_id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const addresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.notes,
            wa.knocked_at, wa.sort_order, wa.gps_verified, wa.lat, wa.lng, wa.voter_id,
            wa.assigned_walker,
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last,
            v.party_score as voter_party_score, v.support_level as voter_support
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  // Mark which doors this walker knocked
  const myKnocks = new Set(
    db.prepare('SELECT address_id FROM walk_attempts WHERE walk_id = ? AND walker_id = ?')
      .all(req.params.id, walkerId)
      .map(r => r.address_id)
  );
  for (const addr of addresses) {
    addr.knocked_by_me = myKnocks.has(addr.id);
  }

  // Attach election votes FIRST so household members get the data (chunked to avoid >999 variable limit)
  const voterIds = addresses.map(a => a.voter_id).filter(Boolean);
  if (voterIds.length > 0) {
    const evMap = fetchElectionVotes(voterIds);
    for (const a of addresses) {
      if (a.voter_id) a.election_votes = evMap[a.voter_id] || [];
    }
  }

  // NOW build households — election_votes are attached so household members get them
  buildHouseholdFromWalkAddresses(addresses);
  // Add other registered voters at the same address from the full voter file
  enrichHouseholdFromVoterFile(addresses);

  // Attempt counts
  const attemptCounts = db.prepare('SELECT address_id, COUNT(*) as c FROM walk_attempts WHERE walk_id = ? GROUP BY address_id').all(req.params.id);
  const countMap = {};
  for (const a of attemptCounts) countMap[a.address_id] = a.c;
  for (const addr of addresses) addr.attempt_count = countMap[addr.id] || 0;

  res.json({ walk, addresses, progress: countDoors(addresses) });
});

// Repopulate all empty walks from voter file by precinct
router.post('/repopulate-walks', (req, res) => {
  const walks = db.prepare("SELECT id, name FROM block_walks").all();
  const insertAddr = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let totalRepopulated = 0;
  let totalAddresses = 0;
  const debug = [];

  const tx = db.transaction(() => {
    for (const walk of walks) {
      const existing = db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(walk.id);
      if (existing.c > 0) { debug.push(walk.name + ': has ' + existing.c + ' addrs, skip'); continue; }

      const match = walk.name.match(/Precinct Walk:\s*(.+)/);
      if (!match) { debug.push(walk.name + ': no precinct match'); continue; }
      const precinct = match[1].trim();

      // Get ALL voters in this precinct — no status filter
      const voters = db.prepare(`
        SELECT id, first_name, last_name, address, unit, city, zip
        FROM voters
        WHERE precinct = ? AND address IS NOT NULL AND address != ''
        ORDER BY address, unit, last_name
      `).all(precinct);

      if (voters.length === 0) { debug.push(walk.name + ': 0 voters in precinct ' + precinct); continue; }

      let i = 0;
      for (const v of voters) {
        const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
        insertAddr.run(walk.id, v.address, v.unit || '', v.city || '', v.zip || '', voterName, v.id, i++);
      }
      totalRepopulated++;
      totalAddresses += voters.length;
      debug.push(walk.name + ': added ' + voters.length + ' voters');
    }
  });
  tx();

  console.log('[repopulate] Repopulated', totalRepopulated, 'walks with', totalAddresses, 'addresses');
  res.json({ repopulated: totalRepopulated, addresses: totalAddresses, debug: debug.slice(0, 20) });
});

// ===================== RECOVER LOST KNOCKS =====================

// Admin endpoint: manually trigger knock recovery (also runs on startup via db.js)
router.post('/walks/recover-lost-knocks', (req, res) => {
  const { recoverLostKnocks } = require('../db');
  const result = recoverLostKnocks();
  const total = result.directRecovered + result.siblingRecovered;
  res.json({
    success: true,
    recovered: total,
    directRecovered: result.directRecovered,
    siblingRecovered: result.siblingRecovered,
    message: total > 0
      ? `Recovered ${result.directRecovered} lost knocks from attempt history + ${result.siblingRecovered} from sibling propagation`
      : 'No lost knocks found — all walk data is consistent'
  });
});

// Diagnostics: show walk_addresses that look like they should be knocked but aren't
router.get('/walks/diagnostics/walk-integrity', (req, res) => {
  // Addresses that are 'not_visited' but have walk_attempts → should have been recovered
  const directMismatch = db.prepare(`
    SELECT wa.id, wa.walk_id, wa.address, wa.unit, wa.voter_name,
           at.result as attempt_result, at.attempted_at, bw.name as walk_name
    FROM walk_addresses wa
    JOIN walk_attempts at ON at.address_id = wa.id AND at.walk_id = wa.walk_id
    JOIN block_walks bw ON bw.id = wa.walk_id
    WHERE wa.result = 'not_visited'
    ORDER BY at.attempted_at DESC
    LIMIT 100
  `).all();

  // Addresses that are 'not_visited' but a sibling at the same address was knocked
  const siblingMismatch = db.prepare(`
    SELECT unvisited.id, unvisited.walk_id, unvisited.address, unvisited.unit, unvisited.voter_name,
           knocked.result as sibling_result, knocked.knocked_at, bw.name as walk_name
    FROM walk_addresses unvisited
    JOIN walk_addresses knocked
      ON knocked.walk_id = unvisited.walk_id
      AND knocked.id != unvisited.id
      AND knocked.result != 'not_visited'
      AND LOWER(TRIM(knocked.address)) = LOWER(TRIM(unvisited.address))
      AND LOWER(TRIM(COALESCE(knocked.unit, ''))) = LOWER(TRIM(COALESCE(unvisited.unit, '')))
    JOIN block_walks bw ON bw.id = unvisited.walk_id
    WHERE unvisited.result = 'not_visited'
    LIMIT 100
  `).all();

  // Overall stats
  const totalAddresses = db.prepare('SELECT COUNT(*) as c FROM walk_addresses').get().c;
  const totalKnocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE result != 'not_visited'").get().c;
  const totalAttempts = db.prepare('SELECT COUNT(*) as c FROM walk_attempts').get().c;
  const uniqueAttemptAddrs = db.prepare('SELECT COUNT(DISTINCT address_id) as c FROM walk_attempts').get().c;

  res.json({
    overview: {
      totalAddresses,
      totalKnocked,
      totalNotVisited: totalAddresses - totalKnocked,
      totalAttempts,
      uniqueAttemptAddrs,
      directMismatchCount: directMismatch.length,
      siblingMismatchCount: siblingMismatch.length
    },
    directMismatches: directMismatch.slice(0, 20),
    siblingMismatches: siblingMismatch.slice(0, 20)
  });
});

module.exports = router;
module.exports.geocodeWalkAddresses = geocodeWalkAddresses;
module.exports.parseAddressUnit = parseAddressUnit;
