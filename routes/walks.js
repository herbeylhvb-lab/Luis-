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

module.exports = router;
