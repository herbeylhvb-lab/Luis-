const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { Jimp } = require('jimp');

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many delete requests, try again later.' } });
const QRCode = require('qrcode');
const { asyncHandler, phoneDigits } = require('../utils');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

// List all events (includes has_flyer flag, excludes full base64) — single query with RSVP stats
router.get('/events', (req, res) => {
  const events = db.prepare(`
    SELECT e.id, e.title, e.description, e.location, e.event_date, e.event_end_date, e.event_time, e.event_end_time, e.status, e.created_at,
      e.latitude, e.longitude, e.checkin_radius, e.mms_project_id,
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
router.post('/events', requireAuth, (req, res) => {
  const { title, description, location, event_date, event_end_date, event_time, event_end_time, flyer_image, mms_project_id, latitude, longitude, checkin_radius } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Title and date are required.' });
  const result = db.prepare(
    'INSERT INTO events (title, description, location, event_date, event_end_date, event_time, event_end_time, flyer_image, mms_project_id, latitude, longitude, checkin_radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title, description || '', location || '', event_date, event_end_date || '', event_time || '', event_end_time || '',
    flyer_image || null, mms_project_id || null,
    latitude != null ? latitude : null, longitude != null ? longitude : null,
    checkin_radius != null ? checkin_radius : 500);
  res.json({ success: true, id: result.lastInsertRowid });
});

// ─── Saved QR Codes CRUD (must be before /events/:id) ───
router.get('/events/saved-qr-codes', (req, res) => {
  const rows = db.prepare('SELECT * FROM saved_qr_codes ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/events/saved-qr-codes', (req, res) => {
  const { name, type, qr_data_url, ics_url, config_json } = req.body;
  if (!name || !qr_data_url) return res.status(400).json({ error: 'Name and QR data required' });
  const result = db.prepare('INSERT INTO saved_qr_codes (name, type, qr_data_url, ics_url, config_json) VALUES (?, ?, ?, ?, ?)').run(name, type || 'voting-reminder', qr_data_url, ics_url || null, config_json || null);
  res.json({ id: result.lastInsertRowid });
});

router.delete('/events/saved-qr-codes/:id', (req, res) => {
  db.prepare('DELETE FROM saved_qr_codes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Get event detail with RSVPs
router.get('/events/:id', (req, res) => {
  const event = db.prepare('SELECT id, title, description, location, event_date, event_end_date, event_time, event_end_time, status, created_at, latitude, longitude, checkin_radius, mms_project_id, (flyer_image IS NOT NULL) as has_flyer FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  event.rsvps = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? ORDER BY id').all(req.params.id);
  res.json({ event });
});

// Update event (now accepts flyer_image)
router.put('/events/:id', requireAuth, (req, res) => {
  const { title, description, location, event_date, event_end_date, event_time, event_end_time, status, flyer_image, mms_project_id, latitude, longitude, checkin_radius } = req.body;
  // If flyer_image is explicitly provided, update it. Otherwise leave existing.
  let result;
  if (flyer_image !== undefined) {
    result = db.prepare(`UPDATE events SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      location = COALESCE(?, location), event_date = COALESCE(?, event_date),
      event_end_date = COALESCE(?, event_end_date),
      event_time = COALESCE(?, event_time), event_end_time = COALESCE(?, event_end_time),
      status = COALESCE(?, status),
      flyer_image = ?, mms_project_id = ?, latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), checkin_radius = COALESCE(?, checkin_radius) WHERE id = ?`
    ).run(title, description, location, event_date, event_end_date, event_time, event_end_time, status, flyer_image,
      mms_project_id !== undefined ? (mms_project_id || null) : null,
      latitude !== undefined ? latitude : null, longitude !== undefined ? longitude : null,
      checkin_radius !== undefined ? checkin_radius : null, req.params.id);
  } else {
    result = db.prepare(`UPDATE events SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      location = COALESCE(?, location), event_date = COALESCE(?, event_date),
      event_end_date = COALESCE(?, event_end_date),
      event_time = COALESCE(?, event_time), event_end_time = COALESCE(?, event_end_time),
      status = COALESCE(?, status),
      mms_project_id = ?, latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), checkin_radius = COALESCE(?, checkin_radius) WHERE id = ?`
    ).run(title, description, location, event_date, event_end_date, event_time, event_end_time, status,
      mms_project_id !== undefined ? (mms_project_id || null) : null,
      latitude !== undefined ? latitude : null, longitude !== undefined ? longitude : null,
      checkin_radius !== undefined ? checkin_radius : null, req.params.id);
  }
  if (result.changes === 0) return res.status(404).json({ error: 'Event not found.' });

  // Propagate MMS project change to any active P2P sessions for this event
  if (mms_project_id !== undefined) {
    db.prepare("UPDATE p2p_sessions SET rumbleup_action_id = ? WHERE source_id = ? AND session_type = 'event' AND status = 'active'")
      .run(mms_project_id || null, req.params.id);
  }

  res.json({ success: true });
});

// Delete event
router.delete('/events/:id', requireAuth, (req, res) => {
  const event = db.prepare('SELECT title FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  // Cascade: clean up associated P2P sessions (by source_id first, fallback to name match)
  db.transaction(() => {
    const sessions = db.prepare("SELECT id FROM p2p_sessions WHERE (source_id = ? AND session_type = 'event') OR name = ?").all(req.params.id, 'Event Invite: ' + event.title);
    for (const s of sessions) {
      db.prepare('DELETE FROM p2p_assignments WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM p2p_volunteers WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(s.id);
    }
    db.prepare('DELETE FROM event_rsvps WHERE event_id = ?').run(req.params.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  })();
  res.json({ success: true });
});

// Bulk delete events
router.post('/events/bulk-delete', requireAuth, bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No event IDs provided.' });
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) {
      const event = db.prepare('SELECT title FROM events WHERE id = ?').get(id);
      if (!event) continue;
      // Cascade: clean up associated sessions
      const sessions = db.prepare("SELECT id FROM p2p_sessions WHERE (source_id = ? AND session_type = 'event') OR name = ?").all(id, 'Event Invite: ' + event.title);
      for (const s of sessions) {
        db.prepare('DELETE FROM p2p_assignments WHERE session_id = ?').run(s.id);
        db.prepare('DELETE FROM p2p_volunteers WHERE session_id = ?').run(s.id);
        db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(s.id);
      }
      db.prepare('DELETE FROM event_rsvps WHERE event_id = ?').run(id);
      if (db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0) removed++;
    }
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
// Support both /flyer/:token and /flyer/:token.jpg so MMS providers recognize the image URL
router.get('/events/:eventId/flyer/:voterToken', asyncHandler(async (req, res) => {
  try {
    const event = db.prepare('SELECT flyer_image, title FROM events WHERE id = ?').get(req.params.eventId);
    if (!event || !event.flyer_image) return res.status(404).send('No flyer');

    // Strip .jpg extension if present (added for MMS provider compatibility)
    const token = req.params.voterToken.replace(/\.jpg$/, '');
    const voter = db.prepare("SELECT id FROM voters WHERE qr_token = ?").get(token);
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

    // Output as JPEG to stay under RumbleUp's 750KB MMS limit
    let outputBuffer = await flyer.getBuffer('image/jpeg', { quality: 85 });
    // If still over 750KB, reduce quality further
    if (outputBuffer.length > 750 * 1024) {
      outputBuffer = await flyer.getBuffer('image/jpeg', { quality: 60 });
    }
    if (outputBuffer.length > 750 * 1024) {
      // Last resort: resize down
      flyer.resize({ w: Math.round(flyer.width * 0.7) });
      outputBuffer = await flyer.getBuffer('image/jpeg', { quality: 60 });
    }

    res.set('Content-Type', 'image/jpeg');
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

// Bulk invite from an admin list
router.post('/events/:id/invite-from-list', requireAuth, (req, res) => {
  const { list_id, rsvp_status } = req.body;
  if (!list_id) return res.status(400).json({ error: 'list_id is required.' });

  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Get voters from the list that have a phone number
  const voters = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.phone
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone IS NOT NULL AND v.phone != ''
  `).all(list_id);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with phone numbers in this list.' });

  const insert = db.prepare(
    'INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)'
  );
  const addAll = db.transaction(() => {
    let added = 0;
    for (const v of voters) {
      const name = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
      if (insert.run(req.params.id, v.phone, name, rsvp_status || 'invited').changes > 0) added++;
    }
    return added;
  });
  const added = addAll();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Bulk invited ' + added + ' voters from list #' + list_id + ' to event #' + req.params.id
  );

  res.json({ success: true, invited: added, already_invited: voters.length - added });
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
  const { name } = req.body;
  const phone = phoneDigits(req.body.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Time window enforcement
  const now = new Date();
  const isMultiDay = event.event_end_date && event.event_end_date !== event.event_date;
  if (isMultiDay) {
    // Multi-day event: check-in open from start date through end of end date
    const startDay = new Date(event.event_date + 'T00:00:00');
    const endDay = new Date(event.event_end_date + 'T23:59:59');
    if (!isNaN(startDay.getTime()) && now < startDay) {
      return res.status(400).json({ error: 'Check-in has not opened yet. Event starts on ' + event.event_date });
    }
    if (!isNaN(endDay.getTime()) && now > endDay) {
      return res.status(400).json({ error: 'Check-in has closed. Event ended on ' + event.event_end_date });
    }
  } else {
    if (event.event_time) {
      const startDT = new Date(event.event_date + 'T' + event.event_time);
      if (!isNaN(startDT.getTime()) && now < startDT) {
        return res.status(400).json({ error: 'Check-in has not opened yet. Event starts at ' + event.event_time });
      }
    }
    if (event.event_end_time) {
      const endDT = new Date(event.event_date + 'T' + event.event_end_time);
      if (!isNaN(endDT.getTime()) && now > endDT) {
        return res.status(400).json({ error: 'Check-in has closed. Event ended at ' + event.event_end_time });
      }
    }
  }

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
  const session = db.prepare("SELECT id, name, join_code, status, code_expires_at FROM p2p_sessions WHERE (source_id = ? AND session_type = 'event') OR name = ? ORDER BY id DESC LIMIT 1")
    .get(req.params.id, 'Event Invite: ' + event.title);
  res.json({ session: session || null });
});

// --- Voting Reminder QR Codes ---
// Generate .ics calendar file for a voting reminder
router.get('/voting-reminders/ics', (req, res) => {
  const { title, date, end_date, start_time, end_time, location, description } = req.query;
  if (!title || !date) return res.status(400).send('title and date are required');

  // Track scan
  try {
    const urlHash = require('crypto').createHash('md5').update(req.originalUrl).digest('hex');
    db.prepare('INSERT INTO qr_scans (url_hash, ip, user_agent) VALUES (?, ?, ?)').run(urlHash, req.ip, req.get('user-agent') || '');
    db.prepare('UPDATE saved_qr_codes SET scan_count = scan_count + 1 WHERE ics_url LIKE ?').run('%' + req.path + '%');
  } catch(e) {}

  // Format date for iCal (YYYYMMDD or YYYYMMDDTHHMMSS)
  const dateClean = date.replace(/-/g, '');
  let dtStart, dtEnd;
  // Multi-day event with end_date: always all-day spanning all days
  if (end_date && end_date !== date) {
    dtStart = dateClean;
    // iCal DTEND for all-day is exclusive, so add 1 day past end_date
    const endDayExclusive = new Date(end_date);
    endDayExclusive.setDate(endDayExclusive.getDate() + 1);
    dtEnd = endDayExclusive.toISOString().slice(0, 10).replace(/-/g, '');
  } else if (start_time) {
    const st = start_time.replace(/:/g, '');
    dtStart = dateClean + 'T' + st + '00';
    if (end_time) {
      const et = end_time.replace(/:/g, '');
      dtEnd = dateClean + 'T' + et + '00';
    } else {
      // Default 1 hour duration
      const startH = parseInt(start_time.split(':')[0], 10);
      const startM = start_time.split(':')[1] || '00';
      dtEnd = dateClean + 'T' + String(startH + 1).padStart(2, '0') + startM + '00';
    }
  } else {
    // All-day event (single day)
    dtStart = dateClean;
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    dtEnd = nextDay.toISOString().slice(0, 10).replace(/-/g, '');
  }

  const uid = 'voting-reminder-' + dateClean + '@campaigntext';
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CampaignText//Voting Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + now,
  ];

  if ((end_date && end_date !== date) || !start_time) {
    // All-day event (single or multi-day)
    ics.push('DTSTART;VALUE=DATE:' + dtStart);
    ics.push('DTEND;VALUE=DATE:' + dtEnd);
  } else {
    ics.push('DTSTART:' + dtStart);
    ics.push('DTEND:' + dtEnd);
  }

  ics.push('SUMMARY:' + (title || 'Vote Today!').replace(/[,;\\]/g, ''));
  if (description) ics.push('DESCRIPTION:' + description.replace(/\n/g, '\\n').replace(/[,;\\]/g, ''));
  if (location) ics.push('LOCATION:' + location.replace(/[,;\\]/g, ''));

  const isAllDay = (end_date && end_date !== date) || !start_time;
  if (isAllDay) {
    // All-day event starts at midnight — use positive offsets from start
    // 7 PM night before
    ics.push('BEGIN:VALARM', 'TRIGGER:-PT5H', 'ACTION:DISPLAY', 'DESCRIPTION:Tomorrow: ' + title + '! Get ready to vote!', 'END:VALARM');
    // Noon day-of
    ics.push('BEGIN:VALARM', 'TRIGGER;RELATED=START:PT12H', 'ACTION:DISPLAY', 'DESCRIPTION:Go vote! ' + title, 'END:VALARM');
  } else {
    // Timed event — remind 1 hour and 3 hours before
    ics.push('BEGIN:VALARM');
    ics.push('TRIGGER:-PT1H');
    ics.push('ACTION:DISPLAY');
    ics.push('DESCRIPTION:Reminder: ' + title);
    ics.push('END:VALARM');
    ics.push('BEGIN:VALARM');
    ics.push('TRIGGER:-PT3H');
    ics.push('ACTION:DISPLAY');
    ics.push('DESCRIPTION:Coming up: ' + title);
    ics.push('END:VALARM');
  }

  ics.push('END:VEVENT');
  ics.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="' + title.replace(/[^a-zA-Z0-9]/g, '_') + '.ics"');
  res.send(ics.join('\r\n'));
});

// Generate QR code image (PNG) that links to the .ics download
router.get('/voting-reminders/qr', asyncHandler(async (req, res) => {
  const { title, date, start_time, end_time, location, description } = req.query;
  if (!title || !date) return res.status(400).json({ error: 'title and date are required' });

  const origin = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
    : req.protocol + '://' + req.get('host');

  const params = new URLSearchParams();
  params.set('title', title);
  params.set('date', date);
  if (start_time) params.set('start_time', start_time);
  if (end_time) params.set('end_time', end_time);
  if (location) params.set('location', location);
  if (description) params.set('description', description);

  const icsUrl = origin + '/api/voting-reminders/ics?' + params.toString();

  const qrBuffer = await QRCode.toBuffer(icsUrl, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(qrBuffer);
}));

// Get QR code as base64 data URL (for embedding in the admin UI)
router.get('/voting-reminders/qr-data', asyncHandler(async (req, res) => {
  const { title, date, start_time, end_time, location, description } = req.query;
  if (!title || !date) return res.status(400).json({ error: 'title and date are required' });

  const origin = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
    : req.protocol + '://' + req.get('host');

  const params = new URLSearchParams();
  params.set('title', title);
  params.set('date', date);
  if (start_time) params.set('start_time', start_time);
  if (end_time) params.set('end_time', end_time);
  if (location) params.set('location', location);
  if (description) params.set('description', description);

  const icsUrl = origin + '/api/voting-reminders/ics?' + params.toString();

  const qrDataUrl = await QRCode.toDataURL(icsUrl, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  res.json({ qr: qrDataUrl, icsUrl });
}));

// Public endpoint: get event details by IDs for push card calendar popups (no auth)
router.get('/pushcard', (req, res) => {
  const ids = (req.query.e || '').split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
  if (ids.length === 0) return res.json({ events: [] });

  const placeholders = ids.map(() => '?').join(',');
  const events = db.prepare(
    `SELECT id, title, event_date, event_end_date, event_time, event_end_time, location
     FROM events WHERE id IN (${placeholders})
     ORDER BY event_date, event_time`
  ).all(...ids);

  res.json({ events });
});

// Generate QR code for push card (encodes /pushcard?e=1,2 URL)
router.get('/pushcard/qr', asyncHandler(async (req, res) => {
  const ids = req.query.e;
  if (!ids) return res.status(400).json({ error: 'Event IDs required (e=1,2)' });

  const origin = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
    : req.protocol + '://' + req.get('host');

  const pushcardUrl = origin + '/pushcard?e=' + ids;

  const qrBuffer = await QRCode.toBuffer(pushcardUrl, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(qrBuffer);
}));

// Get push card QR as base64 (for embedding in admin UI)
router.get('/pushcard/qr-data', asyncHandler(async (req, res) => {
  const ids = req.query.e;
  if (!ids) return res.status(400).json({ error: 'Event IDs required (e=1,2)' });

  const origin = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
    : req.protocol + '://' + req.get('host');

  const pushcardUrl = origin + '/pushcard?e=' + ids;

  const qrDataUrl = await QRCode.toDataURL(pushcardUrl, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  res.json({ qr: qrDataUrl, url: pushcardUrl });
}));

// Combined voting push card: Early Voting + Election Day in one QR code
// The QR points directly to a combined .ics file so phones prompt "Add to Calendar" natively

// Generate combined .ics with both Early Voting + Election Day events
router.get('/voting-reminders/combined-ics', (req, res) => {
  const { ev_title, ev_date, ev_end_date, ev_start_time, ev_end_time, ev_location, ev_description,
          ed_title, ed_date, ed_start_time, ed_end_time, ed_location, ed_description } = req.query;
  if (!ev_title || !ev_date || !ed_title || !ed_date) {
    return res.status(400).send('Early Voting and Election Day title/date are required');
  }

  // Track scan
  try {
    const urlHash = require('crypto').createHash('md5').update(req.originalUrl).digest('hex');
    db.prepare('INSERT INTO qr_scans (url_hash, ip, user_agent) VALUES (?, ?, ?)').run(urlHash, req.ip, req.get('user-agent') || '');
    db.prepare('UPDATE saved_qr_codes SET scan_count = scan_count + 1 WHERE ics_url LIKE ?').run('%combined-ics%');
  } catch(e) {}

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  function buildVEvent(title, date, endDate, startTime, endTime, location, description, uidSuffix) {
    const dateClean = date.replace(/-/g, '');
    let dtStart, dtEnd;
    const isMultiDay = endDate && endDate !== date;

    if (isMultiDay) {
      dtStart = dateClean;
      const endExcl = new Date(endDate);
      endExcl.setDate(endExcl.getDate() + 1);
      dtEnd = endExcl.toISOString().slice(0, 10).replace(/-/g, '');
    } else if (startTime) {
      const st = startTime.replace(/:/g, '');
      dtStart = dateClean + 'T' + st + '00';
      if (endTime) {
        dtEnd = dateClean + 'T' + endTime.replace(/:/g, '') + '00';
      } else {
        const h = parseInt(startTime.split(':')[0], 10);
        const m = startTime.split(':')[1] || '00';
        dtEnd = dateClean + 'T' + String(h + 1).padStart(2, '0') + m + '00';
      }
    } else {
      dtStart = dateClean;
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      dtEnd = next.toISOString().slice(0, 10).replace(/-/g, '');
    }

    const isAllDay = isMultiDay || !startTime;
    const lines = [
      'BEGIN:VEVENT',
      'UID:voting-' + uidSuffix + '-' + dateClean + '@campaigntext',
      'DTSTAMP:' + now,
    ];
    if (isAllDay) {
      lines.push('DTSTART;VALUE=DATE:' + dtStart);
      lines.push('DTEND;VALUE=DATE:' + dtEnd);
    } else {
      lines.push('DTSTART:' + dtStart);
      lines.push('DTEND:' + dtEnd);
    }
    lines.push('SUMMARY:' + (title || 'Vote').replace(/[,;\\]/g, ''));
    if (description) lines.push('DESCRIPTION:' + description.replace(/\n/g, '\\n').replace(/[,;\\]/g, ''));
    if (location) lines.push('LOCATION:' + location.replace(/[,;\\]/g, ''));
    if (isAllDay) {
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT5H', 'ACTION:DISPLAY', 'DESCRIPTION:Tomorrow: ' + title + '! Get ready to vote!', 'END:VALARM');
      lines.push('BEGIN:VALARM', 'TRIGGER;RELATED=START:PT12H', 'ACTION:DISPLAY', 'DESCRIPTION:Go vote! ' + title, 'END:VALARM');
    } else {
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder: ' + title, 'END:VALARM');
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', 'DESCRIPTION:Coming up: ' + title, 'END:VALARM');
    }
    lines.push('END:VEVENT');
    return lines.join('\r\n');
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CampaignText//Voting Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    buildVEvent(ev_title, ev_date, ev_end_date || '', ev_start_time || '', ev_end_time || '', ev_location || '', ev_description || '', 'ev'),
    buildVEvent(ed_title, ed_date, '', ed_start_time || '', ed_end_time || '', ed_location || '', ed_description || '', 'ed'),
    'END:VCALENDAR'
  ].join('\r\n');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="voting-reminders.ics"');
  res.send(ics);
});

router.get('/events/voting-pushcard/qr-data', asyncHandler(async (req, res) => {
  const { ev_title, ev_date, ed_title, ed_date } = req.query;
  if (!ev_title || !ev_date || !ed_title || !ed_date) {
    return res.status(400).json({ error: 'Early Voting and Election Day title/date are required' });
  }

  const origin = req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'] + '://' + req.headers.host
    : req.protocol + '://' + req.get('host');

  // Build full ICS URL
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(req.query)) {
    if (val) params.set(key, val);
  }
  const fullUrl = origin + '/api/voting-reminders/combined-ics?' + params.toString();

  // Create short link for compact QR code
  const crypto = require('crypto');
  const code = crypto.randomBytes(3).toString('hex'); // 6 char code
  try {
    db.prepare('INSERT INTO short_links (code, target_url) VALUES (?, ?)').run(code, fullUrl);
  } catch(e) {}
  const shortUrl = origin + '/r/' + code;

  const qrDataUrl = await QRCode.toDataURL(shortUrl, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  res.json({ qr: qrDataUrl, url: shortUrl });
}));

module.exports = router;
