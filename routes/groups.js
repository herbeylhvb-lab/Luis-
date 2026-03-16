const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { randomBytes } = require('crypto');

const MAX_GROUPS = 10;

const groupLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// Generate a 6-char alphanumeric group code
function generateGroupCode() {
  return randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

// ===================== ADMIN ENDPOINTS =====================

// List all groups
router.get('/groups', (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all();
  res.json({ groups });
});

// Create group (max 10)
router.post('/groups', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  const count = (db.prepare('SELECT COUNT(*) as c FROM groups').get() || { c: 0 }).c;
  if (count >= MAX_GROUPS) return res.status(400).json({ error: 'Maximum of ' + MAX_GROUPS + ' groups allowed.' });

  let code;
  let unique = false;
  for (let i = 0; i < 10; i++) {
    code = generateGroupCode();
    const exists = db.prepare('SELECT id FROM groups WHERE code = ?').get(code);
    if (!exists) { unique = true; break; }
  }
  if (!unique) return res.status(500).json({ error: 'Could not generate a unique group code. Please try again.' });

  const result = db.prepare('INSERT INTO groups (name, code) VALUES (?, ?)').run(name.trim(), code);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Group created: ' + name.trim() + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update group
router.put('/groups/:id', (req, res) => {
  const { name, is_active } = req.body;
  const result = db.prepare(`UPDATE groups SET
    name = COALESCE(?, name),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name || null, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Group not found.' });
  res.json({ success: true });
});

// Delete group
router.delete('/groups/:id', (req, res) => {
  const result = db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Group not found.' });
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Group deleted (ID: ' + req.params.id + ')');
  res.json({ success: true });
});

// Regenerate group code
router.post('/groups/:id/regenerate-code', (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  let code;
  let unique = false;
  for (let i = 0; i < 10; i++) {
    code = generateGroupCode();
    const exists = db.prepare('SELECT id FROM groups WHERE code = ?').get(code);
    if (!exists) { unique = true; break; }
  }
  if (!unique) return res.status(500).json({ error: 'Could not generate a unique code.' });

  db.prepare('UPDATE groups SET code = ? WHERE id = ?').run(code, req.params.id);
  res.json({ success: true, code });
});

// ===================== PUBLIC PORTAL ENDPOINTS =====================

// Group login (public — code-based)
router.post('/groups/login', groupLoginLimiter, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(code.trim().toUpperCase());
  if (!group) return res.status(404).json({ error: 'Invalid group code.' });
  if (!group.is_active) return res.status(403).json({ error: 'This group has been deactivated. Contact the campaign admin.' });

  req.session.groupId = group.id;
  res.json({ success: true, group: { id: group.id, name: group.name } });
});

// List active block walks (for group portal — public after login)
router.get('/groups/:id/walks', (req, res) => {
  const walks = db.prepare(`
    SELECT id, name, description, status, join_code,
      (SELECT COUNT(*) FROM walk_addresses WHERE walk_id = block_walks.id) as total_addresses,
      (SELECT COUNT(*) FROM walk_addresses WHERE walk_id = block_walks.id AND result != 'not_visited') as completed_addresses
    FROM block_walks
    WHERE status = 'active'
    ORDER BY created_at DESC
  `).all();
  res.json({ walks });
});

module.exports = router;
