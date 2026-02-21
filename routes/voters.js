const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateQrToken } = require('../db');

// Strip phone to digits only (for matching across format variations)
function phoneDigits(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  // Strip leading 1 for US numbers so 15125551234 -> 5125551234
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

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

// --- Import canvass data (match existing voters, log contacts, optionally create new) ---
router.post('/voters/import-canvass', (req, res) => {
  const { rows, create_new } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // Pre-build a phone lookup map: digits -> voter {id, support_level}
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address, registration_number FROM voters").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) phoneMap[d] = v.id;
  }
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number) regMap[v.registration_number.trim()] = v.id;
  }

  // Prepared statements
  const updateSupport = db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?");
  const insertContact = db.prepare(
    "INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by, contacted_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertVoter = db.prepare(
    "INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, registration_number, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );

  const results = {
    matched: 0, updated: 0, new_created: 0, skipped: 0, total: rows.length,
    details: { matched_by_phone: 0, matched_by_name_address: 0, matched_by_registration: 0 }
  };

  const importCanvass = db.transaction((rowList) => {
    for (const row of rowList) {
      const digits = phoneDigits(row.phone);
      let voterId = null;
      let matchMethod = '';

      // 1. Phone match
      if (digits.length >= 7 && phoneMap[digits]) {
        voterId = phoneMap[digits];
        matchMethod = 'phone';
      }

      // 2. Registration number match
      if (!voterId && row.registration_number && row.registration_number.trim()) {
        const regId = regMap[row.registration_number.trim()];
        if (regId) { voterId = regId; matchMethod = 'registration'; }
      }

      // 3. Name + address match (first 3 words of address for fuzzy match)
      if (!voterId && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
          if (found) { voterId = found.id; matchMethod = 'name_address'; }
        }
      }

      if (voterId) {
        results.matched++;
        results.details['matched_by_' + matchMethod]++;

        // Update support level if provided
        if (row.support_level && row.support_level !== 'unknown') {
          updateSupport.run(row.support_level, voterId);
          results.updated++;
        }

        // Log contact
        insertContact.run(
          voterId,
          row.contact_type || 'Door-knock',
          row.contact_result || '',
          row.notes || '',
          row.canvasser || 'CSV Import',
          row.canvass_date || new Date().toISOString().split('T')[0]
        );
      } else if (create_new) {
        // Create new voter record
        const newResult = insertVoter.run(
          row.first_name || '', row.last_name || '', row.phone || '',
          row.email || '', row.address || '', row.city || '',
          row.zip || '', row.party || '', row.support_level || 'unknown',
          row.registration_number || '', generateQrToken()
        );
        // Log contact for new voter too
        insertContact.run(
          newResult.lastInsertRowid,
          row.contact_type || 'Door-knock',
          row.contact_result || '',
          row.notes || '',
          row.canvasser || 'CSV Import',
          row.canvass_date || new Date().toISOString().split('T')[0]
        );
        results.new_created++;
      } else {
        results.skipped++;
      }
    }
  });

  importCanvass(rows);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Canvass data imported: ' + results.matched + ' matched, ' + results.new_created + ' new, ' + results.skipped + ' skipped'
  );

  res.json({ success: true, ...results });
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

  // Record check-in + auto-log contact
  const checkinTx = db.transaction(() => {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event_id);
    db.prepare(
      'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
    ).run(voter.id, 'Event', 'Attended', 'Checked in via QR at: ' + event.title, 'QR Check-In');
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      voter.first_name + ' ' + voter.last_name + ' checked in via QR to: ' + event.title
    );
  });
  checkinTx();

  res.json({ success: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
});

// --- Volunteer QR Scanner: Scan check-in endpoint ---
router.post('/voters/qr/:token/scan-checkin', (req, res) => {
  const { event_id, scanned_by } = req.body;
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

  // Record check-in + contact log in a transaction
  const scanTx = db.transaction(() => {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event_id);
    db.prepare(
      'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
    ).run(voter.id, 'Event', 'Attended', 'Checked in via QR scan at: ' + event.title, scanned_by || 'QR Scanner');
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      voter.first_name + ' ' + voter.last_name + ' scanned in by ' + (scanned_by || 'volunteer') + ' at: ' + event.title
    );
  });
  scanTx();

  res.json({ success: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
});

// --- Today's events for volunteer scanner auto-detect ---
router.get('/voters/checkins/today-events', (req, res) => {
  const events = db.prepare(`
    SELECT id, title, event_date, event_time, location FROM events
    WHERE event_date = date('now', 'localtime') AND status IN ('upcoming', 'in_progress')
    ORDER BY event_time ASC
  `).all();
  res.json({ events });
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
