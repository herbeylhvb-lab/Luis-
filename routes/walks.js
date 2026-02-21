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

// Create a walk
router.post('/walks', (req, res) => {
  const { name, description, assigned_to } = req.body;
  if (!name) return res.status(400).json({ error: 'Walk name is required.' });
  const result = db.prepare(
    'INSERT INTO block_walks (name, description, assigned_to) VALUES (?, ?, ?)'
  ).run(name, description || '', assigned_to || '');
  res.json({ success: true, id: result.lastInsertRowid });
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

module.exports = router;
