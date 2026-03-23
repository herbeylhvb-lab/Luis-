const express = require('express');
const router = express.Router();
const { randomBytes } = require('crypto');
const db = require('../db');
const { generateAlphaCode } = require('../utils');
const { geocodeWalkAddresses, parseAddressUnit } = require('./walks');

function generateVolCode() { return randomBytes(3).toString('hex').toUpperCase().slice(0, 6); }

// List all volunteers (admin)
// Fixed: use LEFT JOINs + GROUP BY instead of correlated subqueries for O(1) instead of O(N)
router.get('/volunteers', (req, res) => {
  const volunteers = db.prepare(`
    SELECT v.*,
      COALESCE(pv_stats.sessions_joined, 0) as sessions_joined,
      COALESCE(pa_stats.texts_sent, 0) as texts_sent,
      COALESCE(wa_stats.doors_knocked, 0) as doors_knocked,
      COALESCE(wa_stats.walks_participated, 0) as walks_participated,
      pv_stats.last_active
    FROM volunteers v
    LEFT JOIN (
      SELECT pv.volunteer_id, COUNT(*) as sessions_joined, MAX(pv.last_active) as last_active
      FROM p2p_volunteers pv
      GROUP BY pv.volunteer_id
    ) pv_stats ON pv_stats.volunteer_id = v.id
    LEFT JOIN (
      SELECT pv2.volunteer_id, COUNT(*) as texts_sent
      FROM p2p_assignments pa
      JOIN p2p_volunteers pv2 ON pa.session_id = pv2.session_id AND pa.volunteer_id = pv2.id
      WHERE pa.status IN ('sent','in_conversation','completed')
      GROUP BY pv2.volunteer_id
    ) pa_stats ON pa_stats.volunteer_id = v.id
    LEFT JOIN (
      SELECT wa.walker_id, COUNT(*) as doors_knocked, COUNT(DISTINCT wa.walk_id) as walks_participated
      FROM walk_attempts wa
      WHERE wa.walker_id IS NOT NULL
      GROUP BY wa.walker_id
    ) wa_stats ON wa_stats.walker_id = (SELECT w.id FROM walkers w WHERE w.code = v.code LIMIT 1)
    ORDER BY v.created_at DESC
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

// Volunteer self-registration (public — for block walkers to sign up without admin)
router.post('/volunteers/register', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });

  const trimmedName = name.trim();

  // Check if a volunteer with this name already exists
  const existing = db.prepare('SELECT code FROM volunteers WHERE LOWER(name) = LOWER(?)').get(trimmedName);
  if (existing) {
    return res.status(409).json({ error: 'A volunteer with that name already exists. Try signing in with your code, or use a different name.' });
  }

  // Ensure at least one candidate exists (auto-create a default if not)
  let candidate = db.prepare('SELECT id FROM candidates WHERE is_active = 1 LIMIT 1').get();
  if (!candidate) {
    const candCode = randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
    const result = db.prepare('INSERT INTO candidates (name, office, code) VALUES (?, ?, ?)').run('My Campaign', '', candCode);
    candidate = { id: result.lastInsertRowid };
  }

  // Generate unique volunteer code
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateVolCode();
    if (!db.prepare('SELECT id FROM volunteers WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code. Try again.' });
  }

  // Create volunteer + walker in a transaction to ensure atomicity and consistent phone normalization
  const registerResult = db.transaction(() => {
    const result = db.prepare('INSERT INTO volunteers (name, phone, code, can_text, can_walk) VALUES (?, ?, ?, 0, 1)').run(
      trimmedName, phone || null, code
    );
    const normalizedPhone = phone || '';
    const wResult = db.prepare('INSERT INTO walkers (candidate_id, name, phone, code, is_active) VALUES (?, ?, ?, ?, 1)').run(
      candidate.id, trimmedName, normalizedPhone, code
    );
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Walker self-registered: ' + trimmedName + ' (code: ' + code + ')');
    return { volunteerId: result.lastInsertRowid, walkerId: wResult.lastInsertRowid };
  })();

  res.json({ success: true, code, name: trimmedName, volunteerId: registerResult.volunteerId, walkerId: registerResult.walkerId });
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
      // Backfill and auto-assign in a single transaction to prevent race conditions
      db.transaction(() => {
        db.prepare(`UPDATE walk_group_members SET walker_id = ?, phone = COALESCE(NULLIF(phone, ''), ?)
          WHERE walker_name = ? AND (walker_id IS NULL OR walker_id != ?)`).run(walkerId, vol.phone || '', vol.name, walkerId);

        const unassigned = db.prepare(`SELECT bw.id FROM block_walks bw
          WHERE bw.status != 'completed'
          AND bw.id NOT IN (SELECT walk_id FROM walk_group_members WHERE walker_id = ? OR walker_name = ?)`).all(walkerId, vol.name);
        if (unassigned.length > 0) {
          const ins = db.prepare('INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)');
          for (const w of unassigned) { ins.run(w.id, vol.name, walkerId, vol.phone || ''); }
        }
      })();

      walks = db.prepare(`SELECT bw.id, bw.name, bw.description, bw.status,
        (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = bw.id) as total_addresses,
        (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = bw.id AND result != 'not_visited') as completed_addresses
        FROM block_walks bw
        JOIN walk_group_members wgm ON wgm.walk_id = bw.id AND (wgm.walker_id = ? OR wgm.walker_name = ?)
        WHERE bw.status != 'completed' ORDER BY bw.created_at DESC`).all(walkerId, vol.name);
    }
  }

  res.json({
    success: true,
    volunteer: { id: vol.id, name: vol.name, code: vol.code, can_text: !!vol.can_text, can_walk: !!vol.can_walk, walkerId: walkerId },
    sessions,
    walks
  });
});

// Walker-accessible: create a walk with addresses (no admin required)
router.post('/volunteers/create-walk', (req, res) => {
  const { walkerId, walkerName, walkName, addresses } = req.body;
  if (!walkerId) return res.status(400).json({ error: 'Walker ID is required.' });
  if (!walkName || !walkName.trim()) return res.status(400).json({ error: 'Walk name is required.' });
  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'At least one address is required.' });
  }

  // Verify the walker exists
  const walker = db.prepare('SELECT id, name, phone FROM walkers WHERE id = ?').get(walkerId);
  if (!walker) return res.status(404).json({ error: 'Walker not found.' });

  // Create the walk
  const joinCode = generateAlphaCode(4);
  const walkResult = db.prepare(
    'INSERT INTO block_walks (name, description, join_code) VALUES (?, ?, ?)'
  ).run(walkName.trim(), '', joinCode);
  const walkId = walkResult.lastInsertRowid;

  // Add addresses — parse unit from address string for proper apartment grouping
  const insAddr = db.prepare('INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let order = 0;
  for (const addr of addresses) {
    if (!addr.address || !addr.address.trim()) continue;
    const parsed = parseAddressUnit(addr.address.trim());
    insAddr.run(walkId, parsed.street || addr.address.trim(), parsed.unit || '', addr.city || '', addr.zip || '', addr.voter_name || '', order++);
  }

  // Assign all active walkers (including this one)
  const activeWalkers = db.prepare('SELECT id, name, phone FROM walkers WHERE is_active = 1').all();
  const insMember = db.prepare('INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)');
  for (const w of activeWalkers) {
    insMember.run(walkId, w.name, w.id, w.phone || '');
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Walk created by walker: ' + walkName.trim() + ' (' + order + ' addresses)');

  // Geocode addresses in background so they appear on the map
  geocodeWalkAddresses(walkId);

  res.json({ success: true, walkId, joinCode, addressCount: order });
});

// Volunteer dashboard (public)
router.get('/volunteers/:id/dashboard', (req, res) => {
  const vol = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  // Find the corresponding walkers.id for walking stats
  const walker = db.prepare('SELECT id FROM walkers WHERE code = ?').get(vol.code);
  const wId = walker ? walker.id : null; // null = no walking stats (don't cross ID spaces)

  const stats = {
    sessions_joined: (db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE volunteer_id = ?').get(vol.id) || {}).c || 0,
    texts_sent: (db.prepare(`SELECT COUNT(*) as c FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id AND pv.volunteer_id = ? WHERE pa.status IN ('sent','in_conversation','completed')`).get(vol.id) || {}).c || 0,
    doors_knocked: wId ? (db.prepare('SELECT COUNT(*) as c FROM walk_attempts WHERE walker_id = ?').get(wId) || {}).c || 0 : 0,
    walks_participated: wId ? (db.prepare('SELECT COUNT(DISTINCT walk_id) as c FROM walk_attempts WHERE walker_id = ?').get(wId) || {}).c || 0 : 0
  };

  // Leaderboard
  const leaderboard = db.prepare(`
    SELECT v.id, v.name,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id AND pv.volunteer_id = v.id WHERE pa.status IN ('sent','in_conversation','completed')) as texts_sent,
      (SELECT COUNT(*) FROM walk_attempts wa WHERE wa.walker_id = COALESCE((SELECT w.id FROM walkers w WHERE w.code = v.code), -1)) as doors_knocked
    FROM volunteers v WHERE v.is_active = 1
    ORDER BY (texts_sent + doors_knocked) DESC LIMIT 15
  `).all();

  res.json({ volunteer: vol, stats, leaderboard });
});

module.exports = router;
