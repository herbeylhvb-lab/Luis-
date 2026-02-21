const express = require('express');
const router = express.Router();
const db = require('../db');
const { randomBytes } = require('crypto');

// Generate a 6-char alphanumeric captain code (e.g., "A3F82C")
function generateCaptainCode() {
  return randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

// Extract street number from address for household matching
function extractStreetNumber(address) {
  const match = (address || '').match(/^(\d+)/);
  return match ? match[1] : null;
}

// ===================== ADMIN ENDPOINTS =====================

// List all captains with stats
router.get('/captains', (req, res) => {
  const captains = db.prepare('SELECT * FROM captains ORDER BY created_at DESC').all();
  for (const c of captains) {
    c.team_members = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ? ORDER BY name').all(c.id);
    c.lists = db.prepare(`
      SELECT cl.*, COUNT(clv.id) as voter_count,
        ctm.name as team_member_name
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
      WHERE cl.captain_id = ?
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all(c.id);
    c.total_voters = db.prepare(`
      SELECT COUNT(DISTINCT clv.voter_id) as c
      FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      WHERE cl.captain_id = ?
    `).get(c.id).c;
  }
  // Global overlap stats
  const overlap = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT voter_id FROM captain_list_voters GROUP BY voter_id HAVING COUNT(DISTINCT list_id) >= 2
    )
  `).get().c;
  const totalUniqueVoters = db.prepare('SELECT COUNT(DISTINCT voter_id) as c FROM captain_list_voters').get().c;
  const totalLists = db.prepare('SELECT COUNT(*) as c FROM captain_lists').get().c;
  res.json({ captains, stats: { overlap, totalUniqueVoters, totalLists } });
});

// Create captain
router.post('/captains', (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) break;
  }
  const result = db.prepare(
    'INSERT INTO captains (name, code, phone, email) VALUES (?, ?, ?, ?)'
  ).run(name, code, phone || '', email || '');
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block Captain created: ' + name + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update captain
router.put('/captains/:id', (req, res) => {
  const { name, phone, email, is_active } = req.body;
  db.prepare(`UPDATE captains SET
    name = COALESCE(?, name),
    phone = COALESCE(?, phone),
    email = COALESCE(?, email),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name, phone, email, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  res.json({ success: true });
});

// Delete captain (cascades lists via FK)
router.delete('/captains/:id', (req, res) => {
  const captain = db.prepare('SELECT name FROM captains WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.id);
  if (captain) db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block Captain removed: ' + captain.name);
  res.json({ success: true });
});

// ===================== CAPTAIN PORTAL ENDPOINTS =====================

// Login with permanent code
router.post('/captains/login', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const captain = db.prepare('SELECT * FROM captains WHERE code = ?').get(code.trim().toUpperCase());
  if (!captain) return res.status(404).json({ error: 'Invalid captain code.' });
  if (!captain.is_active) return res.status(403).json({ error: 'Your access has been disabled. Contact the campaign admin.' });
  captain.team_members = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ? ORDER BY name').all(captain.id);
  captain.lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count,
      ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ?
    GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(captain.id);
  res.json({ success: true, captain });
});

// Search voters (captain portal)
router.get('/captains/:id/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ voters: [] });
  const term = '%' + q + '%';
  const voters = db.prepare(`
    SELECT * FROM voters
    WHERE first_name LIKE ? OR last_name LIKE ? OR address LIKE ? OR phone LIKE ?
    ORDER BY last_name, first_name LIMIT 50
  `).all(term, term, term, term);
  // Cross-list info hidden from captains — only admin sees overlap
  res.json({ voters });
});

// Get household members for a voter (street number + zip match)
router.get('/captains/:id/household', (req, res) => {
  const { voter_id } = req.query;
  if (!voter_id) return res.json({ household: [] });
  const voter = db.prepare('SELECT address, zip FROM voters WHERE id = ?').get(voter_id);
  if (!voter || !voter.address) return res.json({ household: [] });
  const streetNum = extractStreetNumber(voter.address);
  if (!streetNum || !voter.zip) return res.json({ household: [] });
  const household = db.prepare(`
    SELECT * FROM voters
    WHERE zip = ? AND address LIKE ? AND id != ?
    ORDER BY last_name, first_name
  `).all(voter.zip, streetNum + ' %', voter_id);
  // Cross-list info hidden from captains — only admin sees overlap
  res.json({ household });
});

// ===================== LIST MANAGEMENT =====================

// Get all lists for this captain
router.get('/captains/:id/lists', (req, res) => {
  const lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count,
      ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ?
    GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(req.params.id);
  res.json({ lists });
});

// Create list
router.post('/captains/:id/lists', (req, res) => {
  const { name, team_member_id } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });
  const result = db.prepare(
    'INSERT INTO captain_lists (captain_id, team_member_id, name) VALUES (?, ?, ?)'
  ).run(req.params.id, team_member_id || null, name);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Rename list
router.put('/captains/:id/lists/:listId', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  db.prepare('UPDATE captain_lists SET name = ? WHERE id = ? AND captain_id = ?').run(name, req.params.listId, req.params.id);
  res.json({ success: true });
});

// Delete list (voters removed via FK cascade)
router.delete('/captains/:id/lists/:listId', (req, res) => {
  db.prepare('DELETE FROM captain_lists WHERE id = ? AND captain_id = ?').run(req.params.listId, req.params.id);
  res.json({ success: true });
});

// Get voters in a list
router.get('/captains/:id/lists/:listId/voters', (req, res) => {
  const voters = db.prepare(`
    SELECT v.*, clv.added_at
    FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id
    WHERE clv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.listId);
  // Cross-list info hidden from captains — only admin sees overlap
  res.json({ voters });
});

// Add voter to list (returns cross-list notifications)
router.post('/captains/:id/lists/:listId/voters', (req, res) => {
  const { voter_id } = req.body;
  if (!voter_id) return res.status(400).json({ error: 'voter_id is required.' });
  const existing = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, voter_id);
  if (existing) return res.json({ success: true, already: true });
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(req.params.listId, voter_id);
  // Cross-list notifications hidden from captains — only admin sees overlap
  res.json({ success: true });
});

// Remove voter from list
router.delete('/captains/:id/lists/:listId/voters/:voterId', (req, res) => {
  db.prepare('DELETE FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// ===================== TEAM MANAGEMENT =====================

// Add team member
router.post('/captains/:id/team', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const result = db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(req.params.id, name);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Remove team member
router.delete('/captains/:id/team/:memberId', (req, res) => {
  db.prepare('DELETE FROM captain_team_members WHERE id = ? AND captain_id = ?').run(req.params.memberId, req.params.id);
  res.json({ success: true });
});

module.exports = router;
