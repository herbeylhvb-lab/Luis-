const express = require('express');
const router = express.Router();
const { randomBytes } = require('crypto');
const db = require('../db');
const { asyncHandler } = require('../utils');

function generateVolCode() { return randomBytes(3).toString('hex').toUpperCase().slice(0, 6); }

// List all volunteers (admin)
router.get('/volunteers', (req, res) => {
  const volunteers = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM p2p_volunteers pv WHERE pv.volunteer_id = v.id) as sessions_joined,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id AND pv.volunteer_id = v.id WHERE pa.status IN ('sent','in_conversation','completed')) as texts_sent,
      (SELECT COUNT(*) FROM walk_attempts wa WHERE wa.walker_id = COALESCE((SELECT w.id FROM walkers w WHERE w.code = v.code), v.id)) as doors_knocked,
      (SELECT COUNT(DISTINCT wa.walk_id) FROM walk_attempts wa WHERE wa.walker_id = COALESCE((SELECT w.id FROM walkers w WHERE w.code = v.code), v.id)) as walks_participated,
      (SELECT MAX(pv.last_active) FROM p2p_volunteers pv WHERE pv.volunteer_id = v.id) as last_active
    FROM volunteers v ORDER BY v.created_at DESC
  `).all();
  res.json({ volunteers });
});

// Create volunteer (admin)
router.post('/volunteers', (req, res) => {
  const { name, phone, can_text, can_walk } = req.body;
  if (!name) return res.status(400).json({ error: 'Volunteer name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateVolCode();
    if (!db.prepare('SELECT id FROM volunteers WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code.' });
  }
  const result = db.prepare('INSERT INTO volunteers (name, phone, code, can_text, can_walk) VALUES (?, ?, ?, ?, ?)').run(
    name.trim(), phone || null, code,
    can_text !== undefined ? (can_text ? 1 : 0) : 1,
    can_walk !== undefined ? (can_walk ? 1 : 0) : 1
  );
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Volunteer created: ' + name.trim() + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update volunteer (admin)
router.put('/volunteers/:id', (req, res) => {
  const { name, phone, can_text, can_walk, is_active } = req.body;
  const vol = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });
  db.prepare(`UPDATE volunteers SET
    name = COALESCE(?, name),
    phone = COALESCE(?, phone),
    can_text = COALESCE(?, can_text),
    can_walk = COALESCE(?, can_walk),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(
    name || null,
    phone !== undefined ? phone : null,
    can_text !== undefined ? (can_text ? 1 : 0) : null,
    can_walk !== undefined ? (can_walk ? 1 : 0) : null,
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    req.params.id
  );
  res.json({ success: true });
});

// Delete volunteer (admin)
router.delete('/volunteers/:id', (req, res) => {
  const vol = db.prepare('SELECT name FROM volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });
  db.prepare('UPDATE p2p_volunteers SET volunteer_id = NULL WHERE volunteer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM volunteers WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Volunteer deleted: ' + vol.name);
  res.json({ success: true });
});

// Volunteer login (public — code-based)
router.post('/volunteers/login', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const vol = db.prepare('SELECT * FROM volunteers WHERE code = ?').get(code.trim().toUpperCase());
  if (!vol) return res.status(404).json({ error: 'Invalid volunteer code.' });
  if (!vol.is_active) return res.status(403).json({ error: 'This volunteer has been deactivated.' });

  // Get active P2P sessions (if can_text)
  let sessions = [];
  if (vol.can_text) {
    sessions = db.prepare(`SELECT s.id as session_id, s.name, s.status, s.join_code
      FROM p2p_sessions s WHERE s.status = 'active' ORDER BY s.created_at DESC`).all();
  }

  // For walking: find or create a matching walkers record (walkers table has different ID space)
  let walkerId = null;
  let walks = [];
  if (vol.can_walk) {
    // Find existing walker by code or name+phone
    let walker = db.prepare('SELECT id FROM walkers WHERE code = ?').get(vol.code);
    if (!walker) walker = db.prepare('SELECT id FROM walkers WHERE name = ? AND phone = ?').get(vol.name, vol.phone);
    if (!walker) {
      // Create a walkers entry linked to this volunteer
      const candidates = db.prepare('SELECT id FROM candidates WHERE is_active = 1 LIMIT 1').all();
      const candId = candidates.length > 0 ? candidates[0].id : null;
      if (candId) {
        const wResult = db.prepare('INSERT INTO walkers (candidate_id, name, phone, code, is_active) VALUES (?, ?, ?, ?, 1)').run(candId, vol.name, vol.phone || '', vol.code);
        walker = { id: wResult.lastInsertRowid };
      }
    }
    walkerId = walker ? walker.id : null;

    if (walkerId) {
      // Auto-assign to walks they're not in
      const unassigned = db.prepare(`SELECT bw.id FROM block_walks bw
        WHERE bw.status != 'completed'
        AND bw.id NOT IN (SELECT walk_id FROM walk_group_members WHERE walker_id = ?)`).all(walkerId);
      if (unassigned.length > 0) {
        const ins = db.prepare('INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)');
        for (const w of unassigned) { ins.run(w.id, vol.name, walkerId, vol.phone || ''); }
      }
      walks = db.prepare(`SELECT bw.id, bw.name, bw.description, bw.status,
        (SELECT COUNT(*) FROM walk_addresses WHERE walk_id = bw.id) as total_addresses,
        (SELECT COUNT(*) FROM walk_addresses WHERE walk_id = bw.id AND result != 'not_visited') as completed_addresses
        FROM block_walks bw
        JOIN walk_group_members wgm ON wgm.walk_id = bw.id AND wgm.walker_id = ?
        WHERE bw.status != 'completed' ORDER BY bw.created_at DESC`).all(walkerId);
    }
  }

  res.json({
    success: true,
    volunteer: { id: vol.id, name: vol.name, code: vol.code, can_text: !!vol.can_text, can_walk: !!vol.can_walk, walkerId: walkerId },
    sessions,
    walks
  });
});

// Volunteer dashboard (public)
router.get('/volunteers/:id/dashboard', (req, res) => {
  const vol = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  // Find the corresponding walkers.id for walking stats
  const walker = db.prepare('SELECT id FROM walkers WHERE code = ?').get(vol.code);
  const wId = walker ? walker.id : vol.id;

  const stats = {
    sessions_joined: (db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE volunteer_id = ?').get(vol.id) || {}).c || 0,
    texts_sent: (db.prepare(`SELECT COUNT(*) as c FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id AND pv.volunteer_id = ? WHERE pa.status IN ('sent','in_conversation','completed')`).get(vol.id) || {}).c || 0,
    doors_knocked: (db.prepare('SELECT COUNT(*) as c FROM walk_attempts WHERE walker_id = ?').get(wId) || {}).c || 0,
    walks_participated: (db.prepare('SELECT COUNT(DISTINCT walk_id) as c FROM walk_attempts WHERE walker_id = ?').get(wId) || {}).c || 0
  };

  // Leaderboard
  const leaderboard = db.prepare(`
    SELECT v.id, v.name,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id AND pv.volunteer_id = v.id WHERE pa.status IN ('sent','in_conversation','completed')) as texts_sent,
      (SELECT COUNT(*) FROM walk_attempts wa WHERE wa.walker_id = v.id) as doors_knocked
    FROM volunteers v WHERE v.is_active = 1
    ORDER BY (texts_sent + doors_knocked) DESC LIMIT 15
  `).all();

  res.json({ volunteer: vol, stats, leaderboard });
});

module.exports = router;
