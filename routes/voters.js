const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateQrToken } = require('../db');

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
  const qr_token = generateQrToken();
  const result = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(first_name || '', last_name || '', phone || '', email || '', address || '', city || '', zip || '', party || '', support_level || 'unknown', voter_score || 0, tags || '', notes || '', registration_number || '', qr_token);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Bulk import voters
router.post('/voters/import', (req, res) => {
  const { voters } = req.body;
  if (!voters || !voters.length) return res.status(400).json({ error: 'No voters provided.' });
  const insert = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, tags, registration_number, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const importMany = db.transaction((list) => {
    let added = 0;
    for (const v of list) {
      insert.run(v.first_name || '', v.last_name || '', v.phone || '', v.email || '', v.address || '', v.city || '', v.zip || '', v.party || '', v.support_level || 'unknown', v.tags || '', v.registration_number || '', generateQrToken());
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

// --- QR Code Check-In Endpoints ---

// Look up voter by QR token (public, used by check-in page)
router.get('/voters/qr/:token', (req, res) => {
  const voter = db.prepare("SELECT id, first_name, last_name, qr_token FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  // Get active/upcoming events (today or future, limited to recent)
  const events = db.prepare(`
    SELECT id, title, event_date, event_time, location FROM events
    WHERE status = 'upcoming' AND event_date >= date('now', '-1 day')
    ORDER BY event_date ASC LIMIT 5
  `).all();

  // Get this voter's past check-ins
  const checkins = db.prepare(`
    SELECT vc.event_id, vc.checked_in_at, e.title
    FROM voter_checkins vc JOIN events e ON vc.event_id = e.id
    WHERE vc.voter_id = ? ORDER BY vc.checked_in_at DESC
  `).all(voter.id);

  res.json({ voter: { id: voter.id, first_name: voter.first_name, last_name: voter.last_name }, events, checkins });
});

// Check in a voter to an event via QR token (public endpoint)
router.post('/voters/qr/:token/checkin', (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'Event ID is required.' });

  const voter = db.prepare("SELECT id, first_name, last_name FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Check if already checked in
  const existing = db.prepare('SELECT id FROM voter_checkins WHERE voter_id = ? AND event_id = ?').get(voter.id, event_id);
  if (existing) {
    return res.json({ success: true, already: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
  }

  // Record check-in
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event_id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    voter.first_name + ' ' + voter.last_name + ' checked in via QR to: ' + event.title
  );

  res.json({ success: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
});

// Get check-in stats for an event (admin endpoint)
router.get('/voters/checkins/event/:eventId', (req, res) => {
  const checkins = db.prepare(`
    SELECT vc.*, v.first_name, v.last_name, v.phone
    FROM voter_checkins vc JOIN voters v ON vc.voter_id = v.id
    WHERE vc.event_id = ? ORDER BY vc.checked_in_at DESC
  `).all(req.params.eventId);
  res.json({ checkins, total: checkins.length });
});

module.exports = router;
