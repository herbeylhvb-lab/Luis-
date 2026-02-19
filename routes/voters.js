const express = require('express');
const router = express.Router();
const db = require('../db');

// Search/list voters
router.get('/voters', (req, res) => {
  const { q, party, support } = req.query;
  let sql = 'SELECT * FROM voters WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR address LIKE ? OR phone LIKE ?)';
    const term = '%' + q + '%';
    params.push(term, term, term, term);
  }
  if (party) { sql += ' AND party = ?'; params.push(party); }
  if (support) { sql += ' AND support_level = ?'; params.push(support); }
  sql += ' ORDER BY last_name, first_name LIMIT 500';
  const voters = db.prepare(sql).all(...params);
  res.json({ voters });
});

// Add single voter
router.post('/voters', (req, res) => {
  const { first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number } = req.body;
  const result = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(first_name || '', last_name || '', phone || '', email || '', address || '', city || '', zip || '', party || '', support_level || 'unknown', voter_score || 0, tags || '', notes || '', registration_number || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Bulk import voters
router.post('/voters/import', (req, res) => {
  const { voters } = req.body;
  if (!voters || !voters.length) return res.status(400).json({ error: 'No voters provided.' });
  const insert = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, tags, registration_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const importMany = db.transaction((list) => {
    let added = 0;
    for (const v of list) {
      insert.run(v.first_name || '', v.last_name || '', v.phone || '', v.email || '', v.address || '', v.city || '', v.zip || '', v.party || '', v.support_level || 'unknown', v.tags || '', v.registration_number || '');
      added++;
    }
    return added;
  });
  const added = importMany(voters);
  res.json({ success: true, added });
});

// Get voter detail with contact history
router.get('/voters/:id', (req, res) => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  voter.contactHistory = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY contacted_at DESC').all(req.params.id);
  res.json({ voter });
});

// Update voter
router.put('/voters/:id', (req, res) => {
  const { first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number } = req.body;
  db.prepare(`UPDATE voters SET
    first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
    phone = COALESCE(?, phone), email = COALESCE(?, email),
    address = COALESCE(?, address), city = COALESCE(?, city), zip = COALESCE(?, zip),
    party = COALESCE(?, party), support_level = COALESCE(?, support_level),
    voter_score = COALESCE(?, voter_score), tags = COALESCE(?, tags), notes = COALESCE(?, notes),
    registration_number = COALESCE(?, registration_number),
    updated_at = datetime('now') WHERE id = ?`
  ).run(first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, req.params.id);
  res.json({ success: true });
});

// Delete voter
router.delete('/voters/:id', (req, res) => {
  db.prepare('DELETE FROM voters WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Log a contact attempt
router.post('/voters/:id/contacts', (req, res) => {
  const { contact_type, result, notes, contacted_by } = req.body;
  if (!contact_type) return res.status(400).json({ error: 'Contact type is required.' });
  const r = db.prepare(
    'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, contact_type, result || '', notes || '', contacted_by || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

module.exports = router;
