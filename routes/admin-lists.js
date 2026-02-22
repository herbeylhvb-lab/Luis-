const express = require('express');
const router = express.Router();
const db = require('../db');

// List all admin lists with counts
router.get('/admin-lists', (req, res) => {
  const lists = db.prepare('SELECT * FROM admin_lists ORDER BY id DESC').all();
  for (const l of lists) {
    l.voterCount = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(l.id).c;
  }
  res.json({ lists });
});

// Create a list
router.post('/admin-lists', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });
  const result = db.prepare('INSERT INTO admin_lists (name, description) VALUES (?, ?)').run(name, description || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get list detail with voters
router.get('/admin-lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  list.voters = db.prepare(`
    SELECT v.*, alv.added_at FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ORDER BY alv.added_at DESC
  `).all(req.params.id);
  res.json({ list });
});

// Update list
router.put('/admin-lists/:id', (req, res) => {
  const { name, description } = req.body;
  db.prepare('UPDATE admin_lists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .run(name, description, req.params.id);
  res.json({ success: true });
});

// Delete list
router.delete('/admin-lists/:id', (req, res) => {
  db.prepare('DELETE FROM admin_lists WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add voters to list
router.post('/admin-lists/:id/voters', (req, res) => {
  const { voterIds } = req.body;
  if (!voterIds || !voterIds.length) return res.status(400).json({ error: 'No voters provided.' });
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addMany = db.transaction((ids) => {
    let added = 0;
    for (const vid of ids) {
      const r = insert.run(req.params.id, vid);
      if (r.changes > 0) added++;
    }
    return added;
  });
  const added = addMany(voterIds);
  res.json({ success: true, added });
});

// Remove voter from list
router.delete('/admin-lists/:id/voters/:voterId', (req, res) => {
  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.id, req.params.voterId);
  res.json({ success: true });
});

module.exports = router;
