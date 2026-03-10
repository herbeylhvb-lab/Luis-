const express = require('express');
const router = express.Router();
const db = require('../db');

// List all block walks with stats
router.get('/walks', (req, res) => {
  const walks = db.prepare('SELECT * FROM block_walks ORDER BY id DESC').all();
  for (const w of walks) {
    const stats = db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN result != \'not_visited\' THEN 1 ELSE 0 END) as knocked FROM walk_addresses WHERE walk_id = ?'
    ).get(w.id);
    w.totalAddresses = stats.total;
    w.knocked = stats.knocked;
  }
  res.json({ walks });
});

// Create a walk (generates join code for group walking)
router.post('/walks', (req, res) => {
  const { name, description, assigned_to } = req.body;
  if (!name) return res.status(400).json({ error: 'Walk name is required.' });
  const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
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
  db.prepare(
    'UPDATE block_walks SET name = COALESCE(?, name), description = COALESCE(?, description), assigned_to = COALESCE(?, assigned_to), status = COALESCE(?, status) WHERE id = ?'
  ).run(name, description, assigned_to, status, req.params.id);
  res.json({ success: true });
});

// Delete a walk
router.delete('/walks/:id', (req, res) => {
  db.prepare('DELETE FROM block_walks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add addresses to walk
router.post('/walks/:id/addresses', (req, res) => {
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
  res.json({ success: true, added });
});

// Update address result
router.put('/walks/:walkId/addresses/:addrId', (req, res) => {
  const { result, notes } = req.body;
  const knocked_at = result && result !== 'not_visited' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE walk_addresses SET result = COALESCE(?, result), notes = COALESCE(?, notes), knocked_at = COALESCE(?, knocked_at) WHERE id = ? AND walk_id = ?'
  ).run(result, notes, knocked_at, req.params.addrId, req.params.walkId);
  res.json({ success: true });
});

// Delete an address
router.delete('/walks/:walkId/addresses/:addrId', (req, res) => {
  db.prepare('DELETE FROM walk_addresses WHERE id = ? AND walk_id = ?').run(req.params.addrId, req.params.walkId);
  res.json({ success: true });
});

// ===================== VOLUNTEER WALKING INTERFACE =====================

// Get walk for volunteer view (simplified, no admin data)
router.get('/walks/:id/volunteer', (req, res) => {
  const walk = db.prepare('SELECT id, name, description, assigned_to, status FROM block_walks WHERE id = ?').get(req.params.id);
  if (!walk) return res.status(404).json({ error: 'Walk not found.' });
  walk.addresses = db.prepare(
    'SELECT id, address, unit, city, zip, voter_name, result, notes, knocked_at, sort_order, gps_verified FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id'
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

  const walk = db.prepare("SELECT * FROM block_walks WHERE join_code = ? AND status != 'completed'").get(joinCode.toUpperCase());
  if (!walk) return res.status(404).json({ error: 'Invalid join code or walk is completed.' });

  // Check member count
  const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walk.id);
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
    'SELECT id, address, unit, city, zip, voter_name, result, notes, knocked_at, sort_order, gps_verified, assigned_walker FROM walk_addresses WHERE walk_id = ? AND assigned_walker = ? ORDER BY sort_order, id'
  ).all(req.params.id, req.params.name);

  const allAddresses = db.prepare(
    'SELECT id, result, assigned_walker FROM walk_addresses WHERE walk_id = ?'
  ).all(req.params.id);

  const total = allAddresses.length;
  const knocked = allAddresses.filter(a => a.result !== 'not_visited').length;

  res.json({ walk, addresses: myAddresses, progress: { total, knocked, remaining: total - knocked } });
});

// Re-split addresses when group members change
function splitAddresses(walkId) {
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
  if (members.length === 0) return;

  const addresses = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id').all(walkId);

  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  const split = db.transaction(() => {
    for (let i = 0; i < addresses.length; i++) {
      const walker = members[i % members.length].walker_name;
      update.run(walker, addresses[i].id);
    }
  });
  split();
}

// Leave a walk group
router.delete('/walks/:id/group/:name', (req, res) => {
  db.prepare('DELETE FROM walk_group_members WHERE walk_id = ? AND walker_name = ?').run(req.params.id, req.params.name);
  // Re-split remaining addresses
  splitAddresses(parseInt(req.params.id));
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

module.exports = router;
