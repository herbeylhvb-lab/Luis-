const express = require('express');
const router = express.Router();
const db = require('../db');

// List all admin lists with counts and captain assignment info
router.get('/admin-lists', (req, res) => {
  const lists = db.prepare(`
    SELECT al.*,
      COUNT(alv.id) as voterCount,
      SUM(CASE WHEN v.phone != '' AND v.phone IS NOT NULL THEN 1 ELSE 0 END) as withPhone,
      c.name as assigned_captain_name
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    LEFT JOIN voters v ON alv.voter_id = v.id
    LEFT JOIN captains c ON al.assigned_captain_id = c.id
    GROUP BY al.id
    ORDER BY al.id DESC
  `).all();
  for (const l of lists) {
    l.withoutPhone = l.voterCount - (l.withPhone || 0);
  }
  res.json({ lists });
});

// Create a list
router.post('/admin-lists', (req, res) => {
  const { name, description, list_type } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });
  const result = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)').run(name, description || '', list_type || 'general');
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
  const { name, description, list_type } = req.body;
  const result = db.prepare('UPDATE admin_lists SET name = COALESCE(?, name), description = COALESCE(?, description), list_type = COALESCE(?, list_type) WHERE id = ?')
    .run(name, description, list_type, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
  res.json({ success: true });
});

// Assign list to a captain (or unassign with captain_id=null)
router.put('/admin-lists/:id/assign', (req, res) => {
  const { captain_id } = req.body;
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  if (captain_id) {
    const captain = db.prepare('SELECT id, name FROM captains WHERE id = ?').get(captain_id);
    if (!captain) return res.status(404).json({ error: 'Captain not found.' });
    db.prepare('UPDATE admin_lists SET assigned_captain_id = ? WHERE id = ?').run(captain_id, req.params.id);
    res.json({ success: true, captain_name: captain.name });
  } else {
    db.prepare('UPDATE admin_lists SET assigned_captain_id = NULL WHERE id = ?').run(req.params.id);
    res.json({ success: true, captain_name: null });
  }
});

// Delete list
router.delete('/admin-lists/:id', (req, res) => {
  const result = db.prepare('DELETE FROM admin_lists WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
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

// Get list contacts as phone targets (for campaigns, surveys, events)
router.get('/admin-lists/:id/contacts', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const contacts = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.phone, v.email, v.city
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  res.json({ contacts, total: contacts.length, listName: list.name });
});

// Export for mailer — one row per household (dedup by address)
router.get('/admin-lists/:id/export-mailer', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const households = db.prepare(`
    SELECT
      TRIM(v.address) as address,
      TRIM(v.city) as city,
      TRIM(v.zip) as zip,
      v.precinct,
      GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
      COUNT(*) as household_size
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
    ORDER BY v.city, v.address
  `).all(req.params.id);

  res.json({
    list_name: list.name,
    total_voters: households.reduce((s, h) => s + h.household_size, 0),
    total_households: households.length,
    households
  });
});

// Get household summary for a list
router.get('/admin-lists/:id/households', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const households = db.prepare(`
    SELECT
      TRIM(v.address) as address,
      TRIM(v.city) as city,
      TRIM(v.zip) as zip,
      v.precinct,
      GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
      GROUP_CONCAT(v.id) as voter_ids,
      COUNT(*) as household_size
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
    ORDER BY v.city, v.address
  `).all(req.params.id);

  res.json({ households, total_households: households.length });
});

// Create a block walk from list voters
router.post('/admin-lists/:id/create-walk', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const voters = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.address, v.city, v.zip, v.phone
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
  `).all(req.params.id);

  if (voters.length === 0) return res.status(400).json({ error: 'List has no voters.' });

  // Generate a join code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let joinCode = '';
  for (let i = 0; i < 6; i++) joinCode += chars[Math.floor(Math.random() * chars.length)];

  const walkName = req.body.name || ('Walk from: ' + list.name);

  // Create the walk
  const walkResult = db.prepare(
    'INSERT INTO block_walks (name, join_code, status) VALUES (?, ?, ?)'
  ).run(walkName, joinCode, 'active');
  const walkId = walkResult.lastInsertRowid;

  // Add addresses from voters (group by household)
  const insertAddr = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const addrMap = {};
  for (const v of voters) {
    const key = (v.address || '').toLowerCase().trim() + '|' + (v.city || '').toLowerCase().trim() + '|' + (v.zip || '').trim();
    if (!addrMap[key]) {
      addrMap[key] = { address: v.address, city: v.city, zip: v.zip, names: [] };
    }
    addrMap[key].names.push((v.first_name + ' ' + v.last_name).trim());
  }
  let addedAddresses = 0;
  const addrs = Object.values(addrMap);
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs[i];
    insertAddr.run(walkId, a.address || '', a.city || '', a.zip || '', a.names.join(', '), i);
    addedAddresses++;
  }

  res.json({
    success: true,
    walk_id: walkId,
    join_code: joinCode,
    walk_name: walkName,
    added_addresses: addedAddresses,
    total_voters: voters.length
  });
});

module.exports = router;
