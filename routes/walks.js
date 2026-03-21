const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { generateAlphaCode, normalizePhone } = require('../utils');

// ===================== DOOR COUNTING =====================
// Count unique doors (address+unit) instead of individual voter rows
// People living together at the same address count as ONE door
function countDoors(addresses) {
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

// Build household members from walk_addresses — groups by address+unit
// so apartment residents only see people in their same unit, not the whole building
function buildHouseholdFromWalkAddresses(addresses) {
  const grouped = {};
  for (const addr of addresses) {
    const key = (addr.address || '').trim().toLowerCase() + '\0' + (addr.unit || '').trim().toLowerCase() + '\0' + (addr.city || '').trim().toLowerCase();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(addr);
  }
  for (const addr of addresses) {
    const key = (addr.address || '').trim().toLowerCase() + '\0' + (addr.unit || '').trim().toLowerCase() + '\0' + (addr.city || '').trim().toLowerCase();
    const others = grouped[key].filter(a => a.id !== addr.id && a.voter_name);
    addr.household = others.map(a => {
      const parts = (a.voter_name || '').split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      return { voter_id: a.voter_id || null, first_name: firstName, last_name: lastName, age: a.voter_age || null, unit: a.unit || '' };
    });
  }
}

// ===================== GEOCODING =====================

// Geocode a single address using OpenStreetMap Nominatim (free, no API key)
// Uses structured query params for house-level accuracy instead of free-text search
// State is configurable via GEOCODE_STATE env var (defaults to empty for auto-detection)
const GEOCODE_STATE = process.env.GEOCODE_STATE || '';

async function geocodeAddress(address, city, zip) {
  if (!address || !address.trim()) return null;

  const headers = { 'User-Agent': 'CampaignTextBlockWalker/1.0' };

  // Strategy 1: Structured query (most accurate when Nominatim knows the address)
  const params = {
    street: address.trim(),
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    addressdetails: '1'
  };
  if (city) params.city = city.trim();
  if (zip) params.postalcode = zip.trim();
  if (GEOCODE_STATE) params.state = GEOCODE_STATE;

  try {
    const url1 = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(params);
    const res1 = await fetch(url1, { headers });
    const data1 = await res1.json();
    if (data1 && data1.length > 0) {
      return { lat: parseFloat(data1[0].lat), lng: parseFloat(data1[0].lon) };
    }
  } catch (e) { /* fall through to next strategy */ }

  // Strategy 2: Free-text query (catches addresses Nominatim can't parse structurally)
  await new Promise(r => setTimeout(r, 1100)); // respect rate limit
  try {
    let q = address.trim();
    if (city) q += ', ' + city.trim();
    if (zip) q += ' ' + zip.trim();
    if (GEOCODE_STATE) q += ', ' + GEOCODE_STATE;
    q += ', USA';
    const url2 = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: q,
      format: 'json',
      limit: '1',
      countrycodes: 'us',
      addressdetails: '1'
    });
    const res2 = await fetch(url2, { headers });
    const data2 = await res2.json();
    if (data2 && data2.length > 0) {
      return { lat: parseFloat(data2[0].lat), lng: parseFloat(data2[0].lon) };
    }
  } catch (e) { /* fall through */ }

  // Strategy 3: Try without unit/apt numbers (e.g. "123 Main St Apt 4" → "123 Main St")
  const stripped = address.trim().replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, '').trim();
  if (stripped !== address.trim()) {
    await new Promise(r => setTimeout(r, 1100));
    try {
      const params3 = { street: stripped, format: 'json', limit: '1', countrycodes: 'us' };
      if (GEOCODE_STATE) params3.state = GEOCODE_STATE;
      if (city) params3.city = city.trim();
      if (zip) params3.postalcode = zip.trim();
      const url3 = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(params3);
      const res3 = await fetch(url3, { headers });
      const data3 = await res3.json();
      if (data3 && data3.length > 0) {
        return { lat: parseFloat(data3[0].lat), lng: parseFloat(data3[0].lon) };
      }
    } catch (e) { /* geocoding failure is non-fatal */ }
  }

  return null;
}

// Geocode walk addresses in the background (non-blocking)
// Nominatim requires max 1 request/second, so we batch with delays
function geocodeWalkAddresses(walkId) {
  const addresses = db.prepare(
    'SELECT id, address, city, zip FROM walk_addresses WHERE walk_id = ? AND lat IS NULL'
  ).all(walkId);

  if (addresses.length === 0) return;

  const update = db.prepare('UPDATE walk_addresses SET lat = ?, lng = ? WHERE id = ?');

  (async () => {
    for (const addr of addresses) {
      try {
        const coords = await geocodeAddress(addr.address, addr.city, addr.zip);
        if (coords) {
          update.run(coords.lat, coords.lng, addr.id);
        }
      } catch (e) {
        console.error('Geocode error for address', addr.id, ':', e.message);
      }
      // Nominatim rate limit: 1 request per second
      await new Promise(r => setTimeout(r, 1100));
    }
  })().catch(e => console.error('Geocode batch error:', e.message));
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
  // "voter score range" — if you've scored voters 0-100
  if (filters.min_voter_score != null && parseInt(filters.min_voter_score) > 0) {
    sql += ' AND voters.voter_score >= ?';
    params.push(parseInt(filters.min_voter_score));
  }
  return sql;
}

// ===================== DAILY REPORT (must be before /walks/:id) =====================
router.get('/walks/daily-report', (req, res) => {
  const date = req.query.date; // YYYY-MM-DD, defaults to today
  const targetDate = date || new Date().toISOString().split('T')[0];

  // Per-walker stats for the selected day
  const walkers = db.prepare(`
    SELECT
      walker_name as name,
      COUNT(*) as doors,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      SUM(CASE WHEN result = 'undecided' THEN 1 ELSE 0 END) as undecided,
      SUM(CASE WHEN result IN ('oppose', 'lean_oppose') THEN 1 ELSE 0 END) as oppose,
      SUM(CASE WHEN result = 'not_home' THEN 1 ELSE 0 END) as not_home,
      MIN(attempted_at) as first_knock,
      MAX(attempted_at) as last_knock,
      COUNT(DISTINCT walk_id) as walks_worked
    FROM walk_attempts
    WHERE walker_name != '' AND date(attempted_at) = ?
    GROUP BY walker_name
    ORDER BY doors DESC
  `).all(targetDate);

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
      COUNT(DISTINCT address_id) as unique_addresses,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as total_contacts,
      SUM(CASE WHEN result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as total_supporters,
      SUM(CASE WHEN result = 'undecided' THEN 1 ELSE 0 END) as total_undecided,
      SUM(CASE WHEN result = 'not_home' THEN 1 ELSE 0 END) as total_not_home,
      COUNT(DISTINCT walker_name) as total_walkers,
      COUNT(DISTINCT walk_id) as total_walks
    FROM walk_attempts
    WHERE walker_name != '' AND date(attempted_at) = ?
  `).get(targetDate);
  totals.contact_rate = totals.total_doors > 0 ? Math.round(totals.total_contacts / totals.total_doors * 100) : 0;

  // Day-over-day history (last 30 days with activity)
  const history = db.prepare(`
    SELECT
      date(attempted_at) as day,
      COUNT(*) as doors,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      COUNT(DISTINCT walker_name) as walkers
    FROM walk_attempts
    WHERE walker_name != ''
    GROUP BY date(attempted_at)
    ORDER BY day DESC
    LIMIT 30
  `).all();

  // Per-walk breakdown for the day
  const walkBreakdown = db.prepare(`
    SELECT
      wa.walk_id,
      bw.name as walk_name,
      COUNT(*) as doors,
      SUM(CASE WHEN wa.result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN wa.result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters,
      (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = wa.walk_id) as total_addresses
    FROM walk_attempts wa
    LEFT JOIN block_walks bw ON wa.walk_id = bw.id
    WHERE wa.walker_name != '' AND date(wa.attempted_at) = ?
    GROUP BY wa.walk_id
    ORDER BY doors DESC
  `).all(targetDate);

  // Available dates (days with any activity)
  const activeDays = db.prepare(`
    SELECT DISTINCT date(attempted_at) as day
    FROM walk_attempts
    WHERE walker_name != ''
    ORDER BY day DESC
    LIMIT 90
  `).all().map(r => r.day);

  res.json({ date: targetDate, walkers, totals, history: history.reverse(), walkBreakdown, activeDays });
});

// ===================== LEADERBOARD (must be before /walks/:id) =====================
router.get('/walks/leaderboard', (req, res) => {
  const leaderboard = db.prepare(`
    SELECT
      walker_name as name,
      COUNT(*) as total_doors,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as contacts,
      SUM(CASE WHEN result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as supporters_found,
      MIN(attempted_at) as first_door,
      MAX(attempted_at) as last_door,
      COUNT(DISTINCT walk_id) as walks_participated
    FROM walk_attempts
    WHERE walker_name != ''
    GROUP BY walker_name
    ORDER BY total_doors DESC
    LIMIT 50
  `).all();

  for (const w of leaderboard) {
    w.contact_rate = w.total_doors > 0 ? Math.round(w.contacts / w.total_doors * 100) : 0;
    if (w.first_door && w.last_door && w.first_door !== w.last_door) {
      const hours = (new Date(w.last_door) - new Date(w.first_door)) / 3600000;
      w.doors_per_hour = hours > 0 ? Math.round(w.total_doors / hours * 10) / 10 : 0;
    } else {
      w.doors_per_hour = 0;
    }
  }

  const overall = db.prepare(`
    SELECT
      COUNT(*) as total_attempts,
      COUNT(DISTINCT address_id) as unique_doors,
      SUM(CASE WHEN result NOT IN ('not_home', 'moved', 'deceased', 'refused', 'come_back') THEN 1 ELSE 0 END) as total_contacts,
      SUM(CASE WHEN result IN ('support', 'lean_support') THEN 1 ELSE 0 END) as total_supporters,
      COUNT(DISTINCT walker_name) as total_walkers,
      COUNT(DISTINCT walk_id) as total_walks
    FROM walk_attempts WHERE walker_name != ''
  `).get();
  overall.contact_rate = overall.total_attempts > 0 ? Math.round(overall.total_contacts / overall.total_attempts * 100) : 0;

  res.json({ leaderboard, overall });
});

// List all block walks with stats (single query instead of N+1)
router.get('/walks', (req, res) => {
  const walks = db.prepare(`
    SELECT b.*,
      COUNT(wa.id) as totalAddresses,
      SUM(CASE WHEN wa.result != 'not_visited' THEN 1 ELSE 0 END) as knocked
    FROM block_walks b
    LEFT JOIN walk_addresses wa ON b.id = wa.walk_id
    GROUP BY b.id
    ORDER BY b.id DESC
  `).all();
  res.json({ walks });
});

// Create a walk
router.post('/walks', (req, res) => {
  const { name, description, assigned_to } = req.body;
  if (!name) return res.status(400).json({ error: 'Walk name is required.' });
  const joinCode = generateAlphaCode(4);
  const result = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code) VALUES (?, ?, ?, ?)'
  ).run(name, description || '', assigned_to || '', joinCode);
  // Auto-assign all active walkers to the new walk
  const walkId = result.lastInsertRowid;
  const activeWalkers = db.prepare('SELECT id, name, phone FROM walkers WHERE is_active = 1').all();
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
  walk.addresses = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id').all(req.params.id);
  const stats = {};
  for (const a of walk.addresses) {
    stats[a.result] = (stats[a.result] || 0) + 1;
  }
  walk.resultStats = stats;
  res.json({ walk });
});

// Update walk metadata
router.put('/walks/:id', (req, res) => {
  const { name, description, assigned_to, status, script_id } = req.body;
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
  }
  // Handle script_id separately since COALESCE can't set null
  if (script_id !== undefined) {
    db.prepare('UPDATE block_walks SET script_id = ? WHERE id = ?').run(script_id || null, req.params.id);
  }
  const result = db.prepare(
    'UPDATE block_walks SET name = COALESCE(?, name), description = COALESCE(?, description), assigned_to = COALESCE(?, assigned_to), status = COALESCE(?, status) WHERE id = ?'
  ).run(name, description, assigned_to, status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Walk not found.' });
  res.json({ success: true });
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
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const addMany = db.transaction((list) => {
    let i = 0;
    for (const a of list) {
      if (a.address) {
        insert.run(req.params.id, a.address, a.unit || '', a.city || '', a.zip || '', a.voter_name || '', i++);
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

// ===================== VOLUNTEER WALKING INTERFACE =====================

// Get walk for volunteer view (simplified, no admin data)
router.get('/walks/:id/volunteer', (req, res) => {
  const walk = db.prepare('SELECT id, name, description, assigned_to, status, script_id FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  walk.addresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.notes,
            wa.knocked_at, wa.sort_order, wa.gps_verified, wa.lat, wa.lng, wa.voter_id,
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  // Build household members — group by address+unit so apartments only show people in the same unit
  buildHouseholdFromWalkAddresses(walk.addresses);

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

  // Determine GPS verification
  let gps_verified = 0;
  if (gps_lat != null && gps_lng != null && isValidCoord(gps_lat, gps_lng)) {
    // Skip verification if accuracy is too poor
    if (gps_accuracy != null && gps_accuracy > MAX_GPS_ACCURACY) {
      gps_verified = 0;
    } else if (addr.lat != null && addr.lng != null) {
      // If address has known coords, verify volunteer is within 150m
      const dist = gpsDistance(gps_lat, gps_lng, addr.lat, addr.lng);
      gps_verified = dist <= 150 ? 1 : 0;
    } else {
      // No address coords to compare — only verify if accuracy is known and acceptable
      gps_verified = (gps_accuracy != null && gps_accuracy <= MAX_GPS_ACCURACY) ? 1 : 0;
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
    `).run(result, notes || '', knocked_at, gps_lat || null, gps_lng || null, gps_accuracy || null, gps_verified, req.params.addrId, req.params.walkId);

    // Record attempt in attempt history (with walker_id if available)
    db.prepare(
      'INSERT INTO walk_attempts (address_id, walk_id, result, notes, walker_name, walker_id, gps_lat, gps_lng, gps_accuracy, gps_verified, survey_responses_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.addrId, req.params.walkId, result, notes || '', walker_name || '', walker_id || null, gps_lat || null, gps_lng || null, gps_accuracy || null, gps_verified, survey_responses ? JSON.stringify(survey_responses) : null);

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

    // Auto-log voter contact if voter_id is linked
    if (addr.voter_id) {
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
        'undecided': 'undecided', 'lean_oppose': 'lean_oppose', 'oppose': 'strong_oppose'
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

  // Determine overall address result from member results
  // If anyone was contacted (not not_home), address is contacted
  const contactedMembers = members.filter(m => m.result && m.result !== 'not_home');
  const overallResult = contactedMembers.length > 0 ? contactedMembers[0].result : 'not_home';

  // GPS verification
  let gps_verified = 0;
  if (gps_lat != null && gps_lng != null && isValidCoord(gps_lat, gps_lng)) {
    if (gps_accuracy != null && gps_accuracy > MAX_GPS_ACCURACY) {
      gps_verified = 0;
    } else if (addr.lat != null && addr.lng != null) {
      const dist = gpsDistance(gps_lat, gps_lng, addr.lat, addr.lng);
      gps_verified = dist <= 150 ? 1 : 0;
    } else {
      gps_verified = (gps_accuracy != null && gps_accuracy <= MAX_GPS_ACCURACY) ? 1 : 0;
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
    `).run(overallResult, allNotes, knocked_at, gps_lat || null, gps_lng || null, gps_accuracy || null, gps_verified, req.params.addrId, req.params.walkId);

    // Record attempt
    db.prepare(
      'INSERT INTO walk_attempts (address_id, walk_id, result, notes, walker_name, walker_id, gps_lat, gps_lng, gps_accuracy, gps_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.addrId, req.params.walkId, overallResult, allNotes, walker_name || '', walker_id || null, gps_lat || null, gps_lng || null, gps_accuracy || null, gps_verified);

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

    // Log individual voter contacts for each member
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
        'undecided': 'undecided', 'lean_oppose': 'lean_oppose', 'oppose': 'strong_oppose'
      };
      if (supportMap[m.result]) {
        db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?").run(supportMap[m.result], m.voter_id);
      }
    }

    // Also log for the primary voter on the address — but only if they were explicitly
    // included in the members list. Don't auto-log "Not Home" for missing primary voters
    // as this could corrupt data if the members list was incomplete.
    if (addr.voter_id) {
      const primaryMember = members.find(m => m.voter_id === addr.voter_id);
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

  // Check member count + add member atomically to prevent race condition
  const maxWalkers = walk.max_walkers || 4;
  const joinResult = db.transaction(() => {
    const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walk.id) || { c: 0 };
    if (members.c >= maxWalkers) return { full: true };
    try {
      db.prepare('INSERT INTO walk_group_members (walk_id, walker_name, phone) VALUES (?, ?, ?)').run(walk.id, walkerName, normPhone);
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        return { duplicate: true };
      }
      throw e;
    }
    return { success: true };
  })();

  if (joinResult.full) return res.status(400).json({ error: 'Group is full (max ' + maxWalkers + ' walkers).' });

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
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

  // Mark which addresses are assigned to THIS walker
  const walkerName = req.params.name;
  for (const addr of allAddresses) {
    addr.assigned_to_me = addr.assigned_walker === walkerName;
  }

  // Build household members — group by address+unit so apartments only show people in the same unit
  buildHouseholdFromWalkAddresses(allAddresses);

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
  const { precincts, name, description, filters } = req.body;
  if (!precincts || !precincts.length) return res.status(400).json({ error: 'At least one precinct is required.' });

  // Build voter query with optional filters
  let sql = "SELECT id, first_name, last_name, address, city, zip, phone FROM voters WHERE precinct IN (" + precincts.map(() => '?').join(',') + ") AND address != ''";
  const params = [...precincts];

  if (filters) {
    if (filters.party) { sql += ' AND party = ?'; params.push(filters.party); }
    if (filters.support_level) { sql += ' AND support_level = ?'; params.push(filters.support_level); }
    if (filters.exclude_contacted) {
      sql += ' AND id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
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
    'INSERT INTO block_walks (name, description, assigned_to, join_code, source_precincts, source_filters_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(walkName, description || 'Auto-created from precincts: ' + precincts.join(', '), '', joinCode, precincts.join(','), JSON.stringify(filters || {}));
  const walkId = walkResult.lastInsertRowid;

  // Add voter addresses to the walk, linked to voter_id for auto-contact-logging
  const insert = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const addAll = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      insert.run(walkId, v.address, '', v.city || '', v.zip || '', voterName, v.id, i++);
    }
    return i;
  });
  const added = addAll();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Walk created from precincts [' + precincts.join(', ') + ']: ' + added + ' addresses'
  );

  geocodeWalkAddresses(walkId);
  res.json({ success: true, id: walkId, added, precincts });
});

// ===================== CREATE WALK FROM VOTER LIST =====================

// Auto-create a walk from selected voter IDs (from the main voter list)
router.post('/walks/from-voters', (req, res) => {
  const { voter_ids, name, description } = req.body;
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
    'INSERT INTO block_walks (name, description, assigned_to, join_code) VALUES (?, ?, ?, ?)'
  ).run(walkName, description || '', '', joinCode);
  const walkId = walkResult.lastInsertRowid;

  const insert = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const addAll = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      insert.run(walkId, v.address, '', v.city || '', v.zip || '', voterName, v.id, i++);
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
    'SELECT id, address, voter_name, result, assigned_walker, knocked_at, lat, lng FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
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
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.assigned_walker, wa.lat, wa.lng,
            v.age as voter_age
     FROM walk_addresses wa
     LEFT JOIN voters v ON wa.voter_id = v.id
     WHERE wa.walk_id = ? ORDER BY wa.sort_order, wa.id`
  ).all(req.params.id);

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

  // Force mode: clear all existing coords so they get re-geocoded with improved logic
  if (req.query.force === 'true' || req.body.force) {
    db.prepare('UPDATE walk_addresses SET lat = NULL, lng = NULL WHERE walk_id = ?').run(req.params.id);
  }

  const missing = db.prepare(
    'SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND lat IS NULL'
  ).get(req.params.id);

  if (missing.c === 0) return res.json({ message: 'All addresses already have coordinates.', pending: 0 });

  geocodeWalkAddresses(parseInt(req.params.id));
  res.json({ message: 'Geocoding started for ' + missing.c + ' addresses. Map will update as coordinates are resolved.', pending: missing.c });
});

// ===================== WALKER LOCATION TRACKING =====================

// Walker broadcasts GPS position (called every 60 seconds from walk app)
router.post('/walks/:id/location', (req, res) => {
  const { walker_name, lat, lng, accuracy } = req.body;
  if (!walker_name || lat == null || lng == null) {
    return res.status(400).json({ error: 'walker_name, lat, and lng are required.' });
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

  if (filters.party) { sql += ' AND v.party = ?'; params.push(filters.party); }
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
    sql += votingSql.replace(/voters\.id/g, 'v.id').replace(/voters\.voter_score/g, 'v.voter_score');
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
      'INSERT INTO block_walks (name, description, assigned_to, join_code, script_id, source_precincts, source_filters_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
      insert.run(walkId, v.address, '', v.city || '', v.zip || '', voterName, v.id, i++, universe.id);
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

  if (filters.party) { sql += ' AND party = ?'; params.push(filters.party); }
  if (filters.support_level) { sql += ' AND support_level = ?'; params.push(filters.support_level); }
  if (filters.exclude_contacted) {
    sql += ' AND id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
  }
  // Voting history filters
  sql += buildVotingHistorySQL(filters, params);
  // Also exclude early voted
  sql += ' AND early_voted = 0';
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
        insertAddr.run(req.params.id, v.address, '', v.city || '', v.zip || '', voterName, v.id, sortIdx++);
        added++;
      }
    }

    return { removed, added };
  });
  const result = refreshResult();

  // Re-geocode any new addresses
  if (result.added > 0) {
    geocodeWalkAddresses(parseInt(req.params.id));
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

  const count = (db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(req.params.id) || { c: 0 }).c;
  if (count >= (walk.max_walkers || 10)) return res.status(400).json({ error: 'Walk is full (max ' + (walk.max_walkers || 10) + ' walkers).' });

  const existing = db.prepare('SELECT id FROM walk_group_members WHERE walk_id = ? AND walker_id = ?').get(req.params.id, walker_id);
  if (existing) return res.status(400).json({ error: 'Walker already assigned to this walk.' });

  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)').run(req.params.id, walker.name, walker.id, walker.phone || '');
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

  const walk = db.prepare('SELECT id, name, description, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const addresses = db.prepare(
    `SELECT wa.id, wa.address, wa.unit, wa.city, wa.zip, wa.voter_name, wa.result, wa.notes,
            wa.knocked_at, wa.sort_order, wa.gps_verified, wa.lat, wa.lng, wa.voter_id,
            v.age as voter_age, v.first_name as voter_first, v.last_name as voter_last
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

  // Build household members — group by address+unit so apartments only show people in the same unit
  buildHouseholdFromWalkAddresses(addresses);

  // Attempt counts
  const attemptCounts = db.prepare('SELECT address_id, COUNT(*) as c FROM walk_attempts WHERE walk_id = ? GROUP BY address_id').all(req.params.id);
  const countMap = {};
  for (const a of attemptCounts) countMap[a.address_id] = a.c;
  for (const addr of addresses) addr.attempt_count = countMap[addr.id] || 0;

  res.json({ walk, addresses, progress: countDoors(addresses) });
});

module.exports = router;
module.exports.geocodeWalkAddresses = geocodeWalkAddresses;
