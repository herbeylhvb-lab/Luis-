const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { generateAlphaCode } = require('../utils');

// ===================== GEOCODING =====================

// Geocode a single address using OpenStreetMap Nominatim (free, no API key)
// Uses structured query params for house-level accuracy instead of free-text search
async function geocodeAddress(address, city, zip) {
  if (!address || !address.trim()) return null;

  // Structured query gives Nominatim much better accuracy than free-text
  const params = {
    street: address.trim(),
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    addressdetails: '1'
  };
  if (city) params.city = city.trim();
  if (zip) params.postalcode = zip.trim();
  params.state = 'Texas';

  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(params);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CampaignTextBlockWalker/1.0' }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) {
    // Geocoding failure is non-fatal — address just won't appear on the map
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

// Create a walk (generates join code for group walking)
router.post('/walks', (req, res) => {
  const { name, description, assigned_to } = req.body;
  if (!name) return res.status(400).json({ error: 'Walk name is required.' });
  const joinCode = generateAlphaCode(4);
  const result = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code) VALUES (?, ?, ?, ?)'
  ).run(name, description || '', assigned_to || '', joinCode);
  res.json({ success: true, id: result.lastInsertRowid, joinCode });
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
  const { name, description, assigned_to, status } = req.body;
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
  }
  const result = db.prepare(
    'UPDATE block_walks SET name = COALESCE(?, name), description = COALESCE(?, description), assigned_to = COALESCE(?, assigned_to), status = COALESCE(?, status) WHERE id = ?'
  ).run(name, description, assigned_to, status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Walk not found.' });
  res.json({ success: true });
});

// Delete a walk
router.delete('/walks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM block_walks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Walk not found.' });
  res.json({ success: true });
});

// Bulk delete walks
router.post('/walks/bulk-delete', bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No walk IDs provided.' });
  const del = db.prepare('DELETE FROM block_walks WHERE id = ?');
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) { if (del.run(id).changes > 0) removed++; }
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
  const walk = db.prepare('SELECT id, name, description, assigned_to, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  walk.addresses = db.prepare(
    'SELECT id, address, unit, city, zip, voter_name, result, notes, knocked_at, sort_order, gps_verified, lat, lng FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
  ).all(req.params.id);
  const total = walk.addresses.length;
  const knocked = walk.addresses.filter(a => a.result !== 'not_visited').length;
  walk.progress = { total, knocked, remaining: total - knocked };
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
  'oppose', 'not_home', 'refused', 'moved', 'come_back'
]);

const MAX_GPS_ACCURACY = 200; // ignore GPS worse than 200m

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    isFinite(lat) && isFinite(lng);
}

// Log a door knock result with GPS verification
router.post('/walks/:walkId/addresses/:addrId/log', (req, res) => {
  const { result, notes, gps_lat, gps_lng, gps_accuracy, walker_name } = req.body;
  if (!result) return res.status(400).json({ error: 'Result is required.' });
  if (!VALID_RESULTS.has(result)) return res.status(400).json({ error: 'Invalid result value.' });

  // Verify walker is a group member (if walker_name provided and group exists)
  if (walker_name) {
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
      // No address coords to compare — GPS was provided with good accuracy
      gps_verified = 1;
    }
  }

  const knocked_at = new Date().toISOString();

  // Update the walk address
  db.prepare(`
    UPDATE walk_addresses SET
      result = ?, notes = ?, knocked_at = ?,
      gps_lat = ?, gps_lng = ?, gps_accuracy = ?, gps_verified = ?
    WHERE id = ? AND walk_id = ?
  `).run(result, notes || '', knocked_at, gps_lat || null, gps_lng || null, gps_accuracy || null, gps_verified, req.params.addrId, req.params.walkId);

  // Auto-log voter contact if voter_id is linked
  if (addr.voter_id) {
    // Map walk results to voter contact results
    const contactResult = {
      'support': 'Strong Support', 'lean_support': 'Lean Support',
      'undecided': 'Undecided', 'lean_oppose': 'Lean Oppose',
      'oppose': 'Strong Oppose', 'not_home': 'Not Home',
      'refused': 'Refused', 'moved': 'Moved', 'come_back': 'Come Back'
    }[result] || result;

    db.prepare(
      'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
    ).run(addr.voter_id, 'Door-knock', contactResult, notes || '', walker_name || 'Block Walker');

    // Update support level if it's a support disposition
    const supportMap = {
      'support': 'strong_support', 'lean_support': 'lean_support',
      'undecided': 'undecided', 'lean_oppose': 'lean_oppose', 'oppose': 'strong_oppose'
    };
    if (supportMap[result]) {
      db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?").run(supportMap[result], addr.voter_id);
    }
  }

  res.json({ success: true, gps_verified });
});

// ===================== GROUP WALKING =====================

// Join a walk group by join code
router.post('/walks/join', (req, res) => {
  const { joinCode, walkerName } = req.body;
  if (!joinCode || !walkerName) return res.status(400).json({ error: 'Join code and walker name required.' });

  const walk = db.prepare("SELECT * FROM block_walks WHERE join_code = ? AND status != 'completed'").get(String(joinCode).toUpperCase());
  if (!walk) return res.status(404).json({ error: 'Invalid join code or walk is completed.' });

  // Check member count
  const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walk.id) || { c: 0 };
  if (members.c >= (walk.max_walkers || 4)) return res.status(400).json({ error: 'Group is full (max ' + (walk.max_walkers || 4) + ' walkers).' });

  // Add member
  try {
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walk.id, walkerName);
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) {
      // Already a member
    } else throw e;
  }

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

// Get addresses assigned to a specific walker
router.get('/walks/:id/walker/:name', (req, res) => {
  const walk = db.prepare('SELECT id, name, description, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });

  const myAddresses = db.prepare(
    'SELECT id, address, unit, city, zip, voter_name, result, notes, knocked_at, sort_order, gps_verified, assigned_walker, lat, lng FROM walk_addresses WHERE walk_id = ? AND assigned_walker = ? ORDER BY sort_order, id'
  ).all(req.params.id, req.params.name);

  const allAddresses = db.prepare(
    'SELECT id, result, assigned_walker FROM walk_addresses WHERE walk_id = ?'
  ).all(req.params.id);

  const total = allAddresses.length;
  const knocked = allAddresses.filter(a => a.result !== 'not_visited').length;

  res.json({ walk, addresses: myAddresses, progress: { total, knocked, remaining: total - knocked } });
});

// Re-split addresses when group members change (only reassign unvisited ones)
function splitAddresses(walkId) {
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
  if (members.length === 0) return;

  // Only reassign addresses that haven't been knocked yet
  const unvisited = db.prepare("SELECT id FROM walk_addresses WHERE walk_id = ? AND result = 'not_visited' ORDER BY sort_order, id").all(walkId);

  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  const split = db.transaction(() => {
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

  // Update sort order in DB
  const updateSort = db.prepare('UPDATE walk_addresses SET sort_order = ? WHERE id = ?');
  const reorder = db.transaction(() => {
    ordered.forEach((a, i) => updateSort.run(i, a.id));
  });
  reorder();

  res.json({
    route: ordered.map(a => ({ id: a.id, address: a.address, city: a.city })),
    mapsUrl,
    optimized: hasCoords.length >= 2
  });
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
  }
  sql += ' ORDER BY address, last_name';

  const voters = db.prepare(sql).all(...params);
  if (voters.length === 0) return res.status(400).json({ error: 'No voters with addresses found in the selected precincts.' });

  // Create the walk
  const walkName = name || ('Precinct Walk: ' + precincts.join(', '));
  const joinCode = generateAlphaCode(4);
  const walkResult = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to, join_code) VALUES (?, ?, ?, ?)'
  ).run(walkName, description || 'Auto-created from precincts: ' + precincts.join(', '), '', joinCode);
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
  res.json({ success: true, id: walkId, joinCode, added, precincts });
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
  res.json({ success: true, id: walkId, joinCode, added });
});

// ===================== PER-WALKER LIVE ROUTE =====================

// Get optimized route for a specific walker (only their unvisited addresses)
// Supports starting from current GPS position via query params
router.get('/walks/:id/walker/:name/route', (req, res) => {
  const { lat, lng } = req.query;

  const addresses = db.prepare(
    "SELECT id, address, city, zip, lat, lng FROM walk_addresses WHERE walk_id = ? AND assigned_walker = ? AND result = 'not_visited' ORDER BY sort_order, id"
  ).all(req.params.id, req.params.name);

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
    const middle = waypoints.slice(0, -1).join('|');
    mapsUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + origin + '&destination=' + dest;
    if (middle) mapsUrl += '&waypoints=' + middle;
  } else if (waypoints.length === 1) {
    const origin = (lat && lng) ? lat + ',' + lng : waypoints[0];
    mapsUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + origin + '&destination=' + waypoints[0];
  }

  // Update sort order for this walker's addresses
  const updateSort = db.prepare('UPDATE walk_addresses SET sort_order = ? WHERE id = ?');
  const reorder = db.transaction(() => {
    ordered.forEach((a, i) => updateSort.run(i, a.id));
  });
  reorder();

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

  const total = allAddresses.length;
  const knocked = allAddresses.filter(a => a.result !== 'not_visited').length;

  // Per-walker breakdown
  const walkerStats = {};
  for (const m of members) {
    walkerStats[m.walker_name] = { total: 0, knocked: 0, remaining: 0 };
  }
  for (const a of allAddresses) {
    if (a.assigned_walker && walkerStats[a.assigned_walker]) {
      walkerStats[a.assigned_walker].total++;
      if (a.result !== 'not_visited') {
        walkerStats[a.assigned_walker].knocked++;
      } else {
        walkerStats[a.assigned_walker].remaining++;
      }
    }
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
    progress: { total, knocked, remaining: total - knocked },
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
    'SELECT id, address, unit, city, zip, voter_name, result, assigned_walker, lat, lng FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
  ).all(req.params.id);

  const locations = db.prepare(
    'SELECT walker_name, lat, lng, accuracy, updated_at FROM walker_locations WHERE walk_id = ? ORDER BY updated_at DESC'
  ).all(req.params.id);

  const total = addresses.length;
  const knocked = addresses.filter(a => a.result !== 'not_visited').length;

  res.json({ addresses, locations, progress: { total, knocked, remaining: total - knocked } });
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

module.exports = router;
