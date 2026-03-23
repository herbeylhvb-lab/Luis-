const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { validate, rules } = require('../middleware/validate');
const { normalizePhone, phoneDigits } = require('../utils');

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many delete requests, try again later.' } });

// List contacts (with optional limit, defaults to 5000 for safety)
router.get('/contacts', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 10000);
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY id DESC LIMIT ?').all(limit);
  const total = (db.prepare('SELECT COUNT(*) as c FROM contacts').get() || { c: 0 }).c;
  res.json({ contacts, total });
});

// Add one contact (normalize phone for consistent matching)
router.post('/contacts', validate({ phone: rules.required }), (req, res) => {
  try {
    const { phone, firstName, lastName, city, email } = req.body;
    const normalized = normalizePhone(phone) || phone;
    const result = db.prepare(
      'INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?, ?, ?, ?, ?)'
    ).run(normalized, firstName || '', lastName || '', city || '', email || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Add contact error:', err.message);
    res.status(500).json({ error: 'Failed to add contact.' });
  }
});

// Bulk import contacts
router.post('/contacts/import', validate({ contacts: rules.nonEmptyArray }), (req, res) => {
  try {
    const { contacts } = req.body;
    const insert = db.prepare(
      'INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?, ?, ?, ?, ?)'
    );
    const importMany = db.transaction((list) => {
      let added = 0;
      for (const c of list) {
        if (c.phone) {
          const normalized = normalizePhone(c.phone) || c.phone;
          insert.run(normalized, c.firstName || '', c.lastName || '', c.city || '', c.email || '');
          added++;
        }
      }
      return added;
    });
    const added = importMany(contacts);
    res.json({ success: true, added });
  } catch (err) {
    console.error('Bulk import contacts error:', err.message);
    res.status(500).json({ error: 'Import failed. Please check your data and try again.' });
  }
});

// Delete one contact and their message history
router.delete('/contacts/:id', (req, res) => {
  const contact = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(req.params.id);
  const delContact = db.transaction(() => {
    db.prepare('DELETE FROM p2p_assignments WHERE contact_id = ?').run(req.params.id);
    // Delete message history for this contact's phone (GDPR/data retention compliance)
    if (contact && contact.phone) {
      db.prepare('DELETE FROM messages WHERE phone = ?').run(phoneDigits(contact.phone) || contact.phone);
    }
    db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  });
  delContact();
  res.json({ success: true });
});

// Bulk delete contacts
router.post('/contacts/bulk-delete', bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No contact IDs provided.' });
  const delAssign = db.prepare('DELETE FROM p2p_assignments WHERE contact_id = ?');
  const del = db.prepare('DELETE FROM contacts WHERE id = ?');
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) { delAssign.run(id); if (del.run(id).changes > 0) removed++; }
    return removed;
  });
  const removed = bulkDel(ids);
  res.json({ success: true, removed });
});

// Clear all contacts (requires confirm=true in body for safety)
router.delete('/contacts', (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Destructive action: pass { "confirm": true } to confirm deletion of all contacts.' });
  }
  // Remove P2P assignments that reference contacts (FK constraint)
  const countBefore = (db.prepare('SELECT COUNT(*) as c FROM contacts').get() || { c: 0 }).c;
  db.prepare('DELETE FROM p2p_assignments WHERE contact_id IN (SELECT id FROM contacts)').run();
  db.prepare('DELETE FROM contacts').run();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Cleared all contacts (' + countBefore + ' removed)');
  res.json({ success: true });
});

module.exports = router;
