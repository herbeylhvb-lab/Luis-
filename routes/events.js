const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { Jimp } = require('jimp');

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many delete requests, try again later.' } });
const QRCode = require('qrcode');
const { asyncHandler } = require('../utils');

// List all events (includes has_flyer flag, excludes full base64) — single query with RSVP stats
router.get('/events', (req, res) => {
  const events = db.prepare(`
    SELECT e.id, e.title, e.description, e.location, e.event_date, e.event_time, e.status, e.created_at,
      (e.flyer_image IS NOT NULL) as has_flyer,
      COUNT(er.id) as rsvp_total,
      SUM(CASE WHEN er.rsvp_status = 'confirmed' THEN 1 ELSE 0 END) as rsvp_confirmed,
      SUM(CASE WHEN er.rsvp_status = 'declined' THEN 1 ELSE 0 END) as rsvp_declined,
      SUM(CASE WHEN er.rsvp_status = 'attended' THEN 1 ELSE 0 END) as rsvp_attended
    FROM events e
    LEFT JOIN event_rsvps er ON e.id = er.event_id
    GROUP BY e.id
    ORDER BY e.event_date DESC
  `).all();
  for (const e of events) {
    e.rsvpStats = { total: e.rsvp_total, confirmed: e.rsvp_confirmed, declined: e.rsvp_declined, attended: e.rsvp_attended };
    delete e.rsvp_total; delete e.rsvp_confirmed; delete e.rsvp_declined; delete e.rsvp_attended;
  }
  res.json({ events });
});

// Create event (now accepts flyer_image)
router.post('/events', (req, res) => {
  const { title, description, location, event_date, event_time, event_end_time, flyer_image, latitude, longitude, checkin_radius } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Title and date are required.' });
  const result = db.prepare(
    'INSERT INTO events (title, description, location, event_date, event_time, event_end_time, flyer_image, latitude, longitude, checkin_radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title, description || '', location || '', event_date, event_time || '', event_end_time || '',
    flyer_image || null, latitude || null, longitude || null, checkin_radius || 500);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get event detail with RSVPs
router.get('/events/:id', (req, res) => {
  const event = db.prepare('SELECT id, title, description, location, event_date, event_time, event_end_time, status, created_at, latitude, longitude, checkin_radius, (flyer_image IS NOT NULL) as has_flyer FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  event.rsvps = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? ORDER BY id').all(req.params.id);
  res.json({ event });
});

// Update event (now accepts flyer_image)
router.put('/events/:id', (req, res) => {
  const { title, description, location, event_date, event_time, event_end_time, status, flyer_image, latitude, longitude, checkin_radius } = req.body;
  // If flyer_image is explicitly provided, update it. Otherwise leave existing.
  let result;
  if (flyer_image !== undefined) {
    result = db.prepare(`UPDATE events SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      location = COALESCE(?, location), event_date = COALESCE(?, event_date),
      event_time = COALESCE(?, event_time), event_end_time = COALESCE(?, event_end_time),
      status = COALESCE(?, status),
      flyer_image = ?, latitude = ?, longitude = ?, checkin_radius = ? WHERE id = ?`
    ).run(title, description, location, event_date, event_time, event_end_time, status, flyer_image,
      latitude !== undefined ? latitude : null, longitude !== undefined ? longitude : null,
      checkin_radius || 500, req.params.id);
  } else {
    result = db.prepare(`UPDATE events SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      location = COALESCE(?, location), event_date = COALESCE(?, event_date),
      event_time = COALESCE(?, event_time), event_end_time = COALESCE(?, event_end_time),
      status = COALESCE(?, status),
      latitude = ?, longitude = ?, checkin_radius = ? WHERE id = ?`
    ).run(title, description, location, event_date, event_time, event_end_time, status,
      latitude !== undefined ? latitude : null, longitude !== undefined ? longitude : null,
      checkin_radius || 500, req.params.id);
  }
  if (result.changes === 0) return res.status(404).json({ error: 'Event not found.' });
  res.json({ success: true });
});

// Delete event
router.delete('/events/:id', (req, res) => {
  const result = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Event not found.' });
  res.json({ success: true });
});

// Bulk delete events
router.post('/events/bulk-delete', bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No event IDs provided.' });
  const del = db.prepare('DELETE FROM events WHERE id = ?');
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) { if (del.run(id).changes > 0) removed++; }
    return removed;
  });
  const removed = bulkDel(ids);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Bulk deleted ' + removed + ' events');
  res.json({ success: true, removed });
});

// --- Serve raw flyer image (for admin preview) ---
router.get('/events/:id/flyer', (req, res) => {
  const event = db.prepare('SELECT flyer_image FROM events WHERE id = ?').get(req.params.id);
  if (!event || !event.flyer_image) return res.status(404).json({ error: 'No flyer image.' });

  try {
    // flyer_image stored as "data:image/png;base64,..." or "data:image/jpeg;base64,..."
    const matches = event.flyer_image.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (matches) {
      const mimeType = matches[1] === 'jpg' ? 'jpeg' : matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      res.set('Content-Type', 'image/' + mimeType);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } else {
      // Assume raw base64 PNG
      const buffer = Buffer.from(event.flyer_image, 'base64');
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    }
  } catch (err) {
    console.error('Flyer decode error:', err.message);
    res.status(500).json({ error: 'Failed to decode flyer image.' });
  }
});

// --- Composite flyer with voter QR code overlay ---
router.get('/events/:eventId/flyer/:voterToken', asyncHandler(async (req, res) => {
  try {
    const event = db.prepare('SELECT flyer_image, title FROM events WHERE id = ?').get(req.params.eventId);
    if (!event || !event.flyer_image) return res.status(404).send('No flyer');

    const voter = db.prepare("SELECT id FROM voters WHERE qr_token = ?").get(req.params.voterToken);
    if (!voter) return res.status(404).send('Invalid voter token');

    // Build the check-in URL that the QR code will encode
    const origin = req.headers['x-forwarded-proto']
      ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
      : req.protocol + '://' + req.get('host');
    const checkinUrl = origin + '/v/' + req.params.voterToken;

    // Decode flyer from base64 to buffer
    const base64Data = event.flyer_image.replace(/^data:image\/\w+;base64,/, '');
    const flyerBuffer = Buffer.from(base64Data, 'base64');

    // Load flyer image with jimp (pure JS — no native deps)
    const flyer = await Jimp.fromBuffer(flyerBuffer);
    const flyerWidth = flyer.width || 800;
    const flyerHeight = flyer.height || 600;

    // QR code size: 25% of flyer width, min 150px, max 250px
    const qrSize = Math.max(150, Math.min(250, Math.floor(flyerWidth * 0.25)));

    // Generate QR code as PNG buffer
    const qrBuffer = await QRCode.toBuffer(checkinUrl, {
      width: qrSize,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' }
    });

    // Create white background rectangle behind QR (padding of 8px)
    const padding = 8;
    const bgSize = qrSize + padding * 2;
    const whiteBg = new Jimp({ width: bgSize, height: bgSize, color: 0xFFFFFFE6 });

    // Load and resize QR code
    const qrImage = await Jimp.fromBuffer(qrBuffer);
    qrImage.resize({ w: qrSize, h: qrSize });

    // Composite: white bg + QR code centered on it
    whiteBg.composite(qrImage, padding, padding);

    // Final composite: flyer + QR badge in bottom-right corner
    const margin = 12;
    flyer.composite(whiteBg, flyerWidth - bgSize - margin, flyerHeight - bgSize - margin);

    const outputBuffer = await flyer.getBuffer('image/png');

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(outputBuffer);
  } catch (err) {
    console.error('Flyer composite error:', err);
    res.status(500).send('Error generating image');
  }
}));

// Add RSVPs (invite contacts)
router.post('/events/:id/rsvps', (req, res) => {
  const { rsvps } = req.body;
  if (!rsvps || !rsvps.length) return res.status(400).json({ error: 'No RSVPs provided.' });
  const insert = db.prepare(
    'INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)'
  );
  const addMany = db.transaction((list) => {
    let added = 0;
    for (const r of list) {
      if (insert.run(req.params.id, r.contact_phone, r.contact_name || '', r.rsvp_status || 'invited').changes > 0) added++;
    }
    return added;
  });
  addMany(rsvps);
  res.json({ success: true });
});

// Update RSVP status
router.put('/events/:id/rsvps/:rsvpId', (req, res) => {
  const { rsvp_status } = req.body;
  const validStatuses = ['invited', 'confirmed', 'declined', 'attended', 'maybe'];
  if (!rsvp_status || !validStatuses.includes(rsvp_status)) {
    return res.status(400).json({ error: 'Invalid RSVP status. Must be: ' + validStatuses.join(', ') });
  }
  // Prevent changing status after check-in (attended)
  const existing = db.prepare('SELECT rsvp_status FROM event_rsvps WHERE id = ? AND event_id = ?').get(req.params.rsvpId, req.params.id);
  if (existing && existing.rsvp_status === 'attended' && rsvp_status !== 'attended') {
    return res.status(400).json({ error: 'Cannot change status after check-in.' });
  }
  const result = db.prepare(
    'UPDATE event_rsvps SET rsvp_status = ?, responded_at = datetime(\'now\') WHERE id = ? AND event_id = ?'
  ).run(rsvp_status, req.params.rsvpId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'RSVP not found.' });
  res.json({ success: true });
});

// QR Code check-in (public endpoint, no auth needed)
router.post('/events/:id/checkin', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Check if already checked in
  const existing = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? AND contact_phone = ?').get(req.params.id, phone);
  if (existing) {
    // Update to attended
    db.prepare("UPDATE event_rsvps SET rsvp_status = 'attended', checked_in_at = datetime('now'), contact_name = COALESCE(?, contact_name) WHERE id = ?")
      .run(name, existing.id);
  } else {
    // New walk-in attendee
    db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status, checked_in_at) VALUES (?, ?, ?, 'attended', datetime('now'))")
      .run(req.params.id, phone, name);
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(name + ' checked in to: ' + event.title);
  res.json({ success: true, eventTitle: event.title });
});

// Get the P2P session linked to this event invite (for showing join code)
router.get('/events/:id/session', (req, res) => {
  const event = db.prepare('SELECT title FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const session = db.prepare("SELECT id, name, join_code, status, code_expires_at FROM p2p_sessions WHERE name = ? ORDER BY id DESC LIMIT 1")
    .get('Event Invite: ' + event.title);
  res.json({ session: session || null });
});

module.exports = router;
