const express = require('express');
const router = express.Router();
const db = require('../db');

// List all events
router.get('/events', (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY event_date DESC').all();
  for (const e of events) {
    const stats = db.prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rsvp_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN rsvp_status = 'declined' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN rsvp_status = 'attended' THEN 1 ELSE 0 END) as attended
    FROM event_rsvps WHERE event_id = ?`).get(e.id);
    e.rsvpStats = stats;
  }
  res.json({ events });
});

// Create event
router.post('/events', (req, res) => {
  const { title, description, location, event_date, event_time } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Title and date are required.' });
  const result = db.prepare(
    'INSERT INTO events (title, description, location, event_date, event_time) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description || '', location || '', event_date, event_time || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get event detail with RSVPs
router.get('/events/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  event.rsvps = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? ORDER BY id').all(req.params.id);
  res.json({ event });
});

// Update event
router.put('/events/:id', (req, res) => {
  const { title, description, location, event_date, event_time, status } = req.body;
  db.prepare(`UPDATE events SET
    title = COALESCE(?, title), description = COALESCE(?, description),
    location = COALESCE(?, location), event_date = COALESCE(?, event_date),
    event_time = COALESCE(?, event_time), status = COALESCE(?, status) WHERE id = ?`
  ).run(title, description, location, event_date, event_time, status, req.params.id);
  res.json({ success: true });
});

// Delete event
router.delete('/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add RSVPs (invite contacts)
router.post('/events/:id/rsvps', (req, res) => {
  const { rsvps } = req.body;
  if (!rsvps || !rsvps.length) return res.status(400).json({ error: 'No RSVPs provided.' });
  const insert = db.prepare(
    'INSERT INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)'
  );
  const addMany = db.transaction((list) => {
    for (const r of list) {
      insert.run(req.params.id, r.contact_phone, r.contact_name || '', r.rsvp_status || 'invited');
    }
  });
  addMany(rsvps);
  res.json({ success: true });
});

// Update RSVP status
router.put('/events/:id/rsvps/:rsvpId', (req, res) => {
  const { rsvp_status } = req.body;
  db.prepare(
    'UPDATE event_rsvps SET rsvp_status = ?, responded_at = datetime(\'now\') WHERE id = ? AND event_id = ?'
  ).run(rsvp_status, req.params.rsvpId, req.params.id);
  res.json({ success: true });
});

module.exports = router;
