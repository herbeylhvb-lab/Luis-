const express = require('express');
const router = express.Router();
const db = require('../db');

// List all contacts
router.get('/contacts', (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY id DESC').all();
  res.json({ contacts });
});

// Add one contact
router.post('/contacts', (req, res) => {
  const { phone, firstName, lastName, city } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required.' });
  const result = db.prepare(
    'INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)'
  ).run(phone, firstName || '', lastName || '', city || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Bulk import contacts
router.post('/contacts/import', (req, res) => {
  const { contacts } = req.body;
  if (!contacts || !contacts.length) return res.status(400).json({ error: 'No contacts provided.' });
  const insert = db.prepare(
    'INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)'
  );
  const importMany = db.transaction((list) => {
    let added = 0;
    for (const c of list) {
      if (c.phone) {
        insert.run(c.phone, c.firstName || '', c.lastName || '', c.city || '');
        added++;
      }
    }
    return added;
  });
  const added = importMany(contacts);
  res.json({ success: true, added });
});

// Delete one contact
router.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Clear all contacts
router.delete('/contacts', (req, res) => {
  db.prepare('DELETE FROM contacts').run();
  res.json({ success: true });
});

module.exports = router;
