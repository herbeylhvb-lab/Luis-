const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { generateJoinCode, asyncHandler, personalizeTemplate, phoneDigits } = require('../utils');
const { getProvider } = require('../providers');

const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many send requests, slow down.' } });

// ========== HELPERS ==========

function getOnlineVolunteers(sessionId) {
  return db.prepare('SELECT * FROM p2p_volunteers WHERE session_id = ? AND is_online = 1').all(sessionId);
}

function getLeastLoadedVolunteer(sessionId, excludeId) {
  const vols = getOnlineVolunteers(sessionId).filter(v => v.id !== excludeId);
  if (vols.length === 0) return null;
  let best = null;
  let bestCount = Infinity;
  for (const v of vols) {
    const count = (db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status IN ('pending', 'sent', 'in_conversation')").get(v.id) || { c: 0 }).c;
    if (count < bestCount) { bestCount = count; best = v; }
  }
  return best;
}

const _redistributeContacts = db.transaction((sessionId, fromVolunteerId, onlineVols) => {
  const pending = db.prepare("SELECT * FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status = 'pending'").all(fromVolunteerId, sessionId);
  const conversations = db.prepare("SELECT * FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')").all(fromVolunteerId, sessionId);

  // Redistribute pending contacts round-robin
  for (let i = 0; i < pending.length; i++) {
    const target = onlineVols[i % onlineVols.length];
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = COALESCE(original_volunteer_id, ?) WHERE id = ?')
      .run(target.id, fromVolunteerId, pending[i].id);
  }

  // Route active conversations to least-loaded
  for (const conv of conversations) {
    const target = getLeastLoadedVolunteer(sessionId, fromVolunteerId);
    if (target) {
      db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = COALESCE(original_volunteer_id, ?) WHERE id = ?')
        .run(target.id, fromVolunteerId, conv.id);
    }
  }
});

function redistributeContacts(sessionId, fromVolunteerId) {
  const onlineVols = getOnlineVolunteers(sessionId).filter(v => v.id !== fromVolunteerId);
  if (onlineVols.length === 0) return;
  _redistributeContacts(sessionId, fromVolunteerId, onlineVols);
}

const _snapBackConversations = db.transaction((sessionId, volunteerId) => {
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')")
    .run(volunteerId, volunteerId, sessionId);
  db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?")
    .run(volunteerId, sessionId);
});

function snapBackConversations(sessionId, volunteerId) {
  _snapBackConversations(sessionId, volunteerId);
}

const _assignFreshBatch = db.transaction((sessionId, volunteerId) => {
  const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 20").all(sessionId);
  for (const a of unassigned) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volunteerId, a.id);
  }
  return unassigned.length;
});
function assignFreshBatch(sessionId, volunteerId) {
  return _assignFreshBatch(sessionId, volunteerId);
}

// ========== SESSIONS ==========

router.post('/p2p/sessions', (req, res) => {
  const { name, message_template, assignment_mode, contact_ids, list_id, exclude_contacted, precinct_filter } = req.body;
  if (!name || !message_template) return res.status(400).json({ error: 'Name and message template required.' });

  // Gather contact IDs — from list or direct array
  let ids = [];
  let listTotal = 0;
  let skippedNoPhone = 0;
  let skippedContacted = 0;
  if (list_id) {
    // Count total voters on list (with and without phone)
    listTotal = (db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list_id) || { c: 0 }).c;

    // Build contacted voter set if excluding already-contacted
    let contactedSet = null;
    if (exclude_contacted) {
      contactedSet = new Set();
      // Voter contacts (texts, calls, door-knocks)
      db.prepare('SELECT DISTINCT voter_id FROM voter_contacts').all().forEach(r => contactedSet.add(r.voter_id));
      // P2P assignments already sent
      db.prepare("SELECT DISTINCT c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id WHERE a.status IN ('sent', 'in_conversation', 'completed')").all()
        .forEach(r => contactedSet.add('phone:' + r.phone));
    }

    // Get voters from admin list, auto-create contacts if needed
    let listSql = `
      SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city, v.email
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != ''
    `;
    const listParams = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      listSql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      listParams.push(...precinct_filter);
    }
    const listVoters = db.prepare(listSql).all(...listParams);

    skippedNoPhone = listTotal - listVoters.length;

    // Ensure each voter has a contacts table entry (P2P assignments reference contacts)
    const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
    const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?, ?, ?, ?, ?)');
    for (const v of listVoters) {
      // Skip already-contacted voters
      if (contactedSet && (contactedSet.has(v.voter_id) || contactedSet.has('phone:' + v.phone))) {
        skippedContacted++;
        continue;
      }
      let contact = findContact.get(v.phone);
      if (!contact) {
        try {
          const r = insertContact.run(v.phone, v.first_name || '', v.last_name || '', v.city || '', v.email || '');
          ids.push(r.lastInsertRowid);
        } catch (e) {
          // Handle race condition: another request inserted this phone between our check and insert
          contact = findContact.get(v.phone);
          if (contact) ids.push(contact.id);
        }
      } else {
        ids.push(contact.id);
      }
    }
  } else if (contact_ids && contact_ids.length > 0) {
    ids = contact_ids;
  }

  if (ids.length === 0 && skippedContacted > 0) {
    // All contacts were excluded — return success with stats but no session
    return res.json({ success: true, id: null, joinCode: null, contactCount: 0, listTotal, skippedNoPhone, skippedContacted });
  }
  if (ids.length === 0) return res.status(400).json({ error: 'No contacts with phone numbers found.' });

  const joinCode = generateJoinCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare('INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at, session_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, message_template, assignment_mode || 'auto_split', joinCode, expiresAt, 'campaign');

  const sessionId = result.lastInsertRowid;

  const insert = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const addAll = db.transaction((cids) => { for (const id of cids) insert.run(sessionId, id); });
  addAll(ids);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('P2P session created: ' + name + ' (' + ids.length + ' contacts)');

  res.json({ success: true, id: sessionId, joinCode, contactCount: ids.length, listTotal, skippedNoPhone, skippedContacted });
});

router.get('/p2p/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM p2p_sessions ORDER BY id DESC').all();

  if (sessions.length > 0) {
    // Batch assignment stats
    const assignStats = db.prepare(`
      SELECT session_id,
        COUNT(*) as totalContacts,
        SUM(CASE WHEN status != 'pending' AND status != 'skipped' THEN 1 ELSE 0 END) as sent
      FROM p2p_assignments GROUP BY session_id
    `).all();
    const assignMap = {};
    for (const s of assignStats) assignMap[s.session_id] = s;

    // Batch volunteer stats
    const volStats = db.prepare(`
      SELECT session_id,
        COUNT(*) as volunteerCount,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as onlineCount
      FROM p2p_volunteers GROUP BY session_id
    `).all();
    const volMap = {};
    for (const v of volStats) volMap[v.session_id] = v;

    for (const s of sessions) {
      const as = assignMap[s.id] || {};
      s.totalContacts = as.totalContacts || 0;
      s.sent = as.sent || 0;
      const vs = volMap[s.id] || {};
      s.volunteerCount = vs.volunteerCount || 0;
      s.onlineCount = vs.onlineCount || 0;
    }
  }

  res.json({ sessions });
});

router.get('/p2p/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM p2p_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  // Single aggregation query replaces 3 queries per volunteer
  session.volunteers = db.prepare(`
    SELECT v.*,
      COALESCE(SUM(CASE WHEN a.status IN ('sent', 'in_conversation', 'completed') THEN 1 ELSE 0 END), 0) as sent,
      COALESCE(SUM(CASE WHEN a.status = 'in_conversation' THEN 1 ELSE 0 END), 0) as activeChats,
      COALESCE(SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END), 0) as remaining
    FROM p2p_volunteers v
    LEFT JOIN p2p_assignments a ON a.volunteer_id = v.id
    WHERE v.session_id = ?
    GROUP BY v.id
  `).all(session.id);

  // Single aggregation for session-level stats
  const sessionStats = db.prepare(`
    SELECT
      COUNT(*) as totalContacts,
      COALESCE(SUM(CASE WHEN status IN ('sent', 'in_conversation', 'completed') THEN 1 ELSE 0 END), 0) as totalSent,
      COALESCE(SUM(CASE WHEN status = 'in_conversation' THEN 1 ELSE 0 END), 0) as totalReplies,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as remaining
    FROM p2p_assignments WHERE session_id = ?
  `).get(session.id);
  session.totalContacts = sessionStats.totalContacts;
  session.totalSent = sessionStats.totalSent;
  session.totalReplies = sessionStats.totalReplies;
  session.remaining = sessionStats.remaining;

  res.json({ session });
});

router.patch('/p2p/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT id FROM p2p_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const { status, assignment_mode } = req.body;
  const validStatuses = ['active', 'paused', 'completed'];
  const validModes = ['auto_split', 'claim'];
  if (status) {
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
    db.prepare('UPDATE p2p_sessions SET status = ? WHERE id = ?').run(status, req.params.id);
  }
  if (assignment_mode) {
    if (!validModes.includes(assignment_mode)) return res.status(400).json({ error: 'Invalid mode. Must be: ' + validModes.join(', ') });
    db.prepare('UPDATE p2p_sessions SET assignment_mode = ? WHERE id = ?').run(assignment_mode, req.params.id);
  }
  res.json({ success: true });
});

// Delete a P2P session (cascade deletes volunteers + assignments via foreign keys)
router.delete('/p2p/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT id, name FROM p2p_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('P2P session deleted: ' + session.name);
  res.json({ success: true });
});

// ========== VOLUNTEERS ==========

router.post('/p2p/join', (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and join code required.' });

  const session = db.prepare("SELECT * FROM p2p_sessions WHERE join_code = ? AND status = 'active'").get(code);
  if (!session) return res.status(404).json({ error: 'Invalid or expired code.' });
  if (new Date(session.code_expires_at) < new Date()) return res.status(410).json({ error: 'Join code has expired.' });

  let volunteer = db.prepare('SELECT * FROM p2p_volunteers WHERE session_id = ? AND name = ?').get(session.id, name);
  if (volunteer) {
    db.prepare('UPDATE p2p_volunteers SET is_online = 1 WHERE id = ?').run(volunteer.id);
    snapBackConversations(session.id, volunteer.id);
    assignFreshBatch(session.id, volunteer.id);
  } else {
    const result = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(session.id, name);
    volunteer = { id: result.lastInsertRowid, session_id: session.id, name, is_online: 1 };

    if (session.assignment_mode === 'auto_split') {
      const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").all(session.id);
      const onlineCount = (db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ? AND is_online = 1').get(session.id) || { c: 0 }).c;
      const batchSize = Math.ceil(unassigned.length / Math.max(onlineCount, 1));
      const batch = unassigned.slice(0, batchSize);
      for (const a of batch) {
        db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volunteer.id, a.id);
      }
    }
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(name + ' joined P2P session: ' + session.name);
  res.json({ success: true, volunteerId: volunteer.id, sessionId: session.id, sessionName: session.name, sessionType: session.session_type || 'campaign' });
});

router.patch('/p2p/volunteers/:id/status', (req, res) => {
  const { is_online } = req.body;
  const vol = db.prepare('SELECT * FROM p2p_volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  db.prepare('UPDATE p2p_volunteers SET is_online = ? WHERE id = ?').run(is_online ? 1 : 0, req.params.id);

  if (!is_online) {
    redistributeContacts(vol.session_id, vol.id);
  } else {
    snapBackConversations(vol.session_id, vol.id);
    assignFreshBatch(vol.session_id, vol.id);
  }

  res.json({ success: true });
});

router.get('/p2p/volunteers/:id/queue', (req, res) => {
  const vol = db.prepare('SELECT * FROM p2p_volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  const session = db.prepare('SELECT * FROM p2p_sessions WHERE id = ?').get(vol.session_id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  if (session.assignment_mode === 'claim') {
    // Atomic claim: UPDATE directly with WHERE volunteer_id IS NULL to prevent race conditions
    db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE id = (SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 1)").run(vol.id, vol.session_id);
  }

  // Skip opted-out contacts automatically (TCPA compliance)
  const optedOutPhones = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const pendingAll = db.prepare(`
    SELECT a.id, c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'pending' ORDER BY a.id ASC
  `).all(req.params.id);
  for (const p of pendingAll) {
    if (optedOutPhones.has(phoneDigits(p.phone))) {
      db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(p.id);
    }
  }

  const assignment = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.city, c.preferred_channel, v.qr_token
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    LEFT JOIN voters v ON v.phone = c.phone AND v.phone != ''
    WHERE a.volunteer_id = ? AND a.status = 'pending'
    ORDER BY a.id ASC LIMIT 1
  `).get(req.params.id);

  const activeConversations = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.city, c.preferred_channel
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'in_conversation'
    ORDER BY a.id ASC
  `).all(req.params.id);

  // Attach last 3 messages to each conversation for preview
  for (const convo of activeConversations) {
    const np = phoneDigits(convo.phone);
    convo.recentMessages = db.prepare(`
      SELECT body, direction, timestamp as created_at FROM messages
      WHERE (phone = ? OR phone = ? OR REPLACE(REPLACE(REPLACE(phone,'+1',''),'+',''),'-','') = ?)
        AND (session_id = ? OR (session_id IS NULL AND direction = 'inbound'))
      ORDER BY id DESC LIMIT 3
    `).all(convo.phone, np, np, convo.session_id).reverse();
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status IN ('sent', 'in_conversation', 'completed') THEN 1 ELSE 0 END), 0) as sent,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as remaining
    FROM p2p_assignments WHERE volunteer_id = ?
  `).get(req.params.id);

  let resolvedMessage = null;
  if (assignment) {
    resolvedMessage = personalizeTemplate(session.message_template, assignment);
  }

  res.json({ assignment, resolvedMessage, activeConversations, stats, messageTemplate: session.message_template, sessionType: session.session_type || 'campaign' });
});

// ========== MESSAGING ==========

router.post('/p2p/send', sendLimiter, asyncHandler(async (req, res) => {
  const { volunteerId, assignmentId, message, isReply } = req.body;
  if (!volunteerId || !assignmentId || !message) return res.status(400).json({ error: 'volunteerId, assignmentId, and message required.' });

  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured. Set them in Messaging Setup.' });

  const vol = db.prepare('SELECT * FROM p2p_volunteers WHERE id = ?').get(volunteerId);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  const assignment = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.city FROM p2p_assignments a
    JOIN contacts c ON a.contact_id = c.id WHERE a.id = ?
  `).get(assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

  // Verify this volunteer owns the assignment (loose comparison: SQLite returns int, client may send string)
  if (String(assignment.volunteer_id) !== String(volunteerId)) {
    return res.status(403).json({ error: 'This assignment belongs to another volunteer.' });
  }

  // Idempotency: prevent double-sends of the initial message (but allow replies)
  if (!isReply && (assignment.status === 'sent' || assignment.status === 'in_conversation' || assignment.status === 'completed')) {
    return res.json({ success: true, skipped: true, reason: 'Message already sent for this assignment.' });
  }

  // Check opt-out list before sending (TCPA compliance) — normalize phone for consistent matching
  const optedOut = db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(phoneDigits(assignment.phone));
  if (optedOut) {
    db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(assignmentId);
    return res.json({ success: true, skipped: true, reason: 'Contact has opted out.' });
  }

  try {
    // Auto-sync contact to RumbleUp before sending (ensures phone exists in their system)
    if (provider.syncContact) {
      await provider.syncContact({
        phone: phoneDigits(assignment.phone),
        first_name: assignment.first_name || '',
        last_name: assignment.last_name || '',
        city: assignment.city || ''
      });
    }
    await provider.sendMessage(assignment.phone, message);
    // Atomic: log message + update assignment status together
    db.transaction(() => {
      db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name, channel) VALUES (?, ?, 'outbound', ?, ?, 'sms')")
        .run(phoneDigits(assignment.phone) || assignment.phone, message, vol.session_id, vol.name);
      if (isReply) {
        // Reply: keep in conversation state
        db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(assignmentId);
      } else {
        // Initial send: mark as sent
        db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status = 'pending'").run(assignmentId);
      }
    })();

    res.json({ success: true, smsSent: true });
  } catch (err) {
    console.error('P2P send error:', err.message);
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
}));

router.get('/p2p/conversations/:assignmentId', (req, res) => {
  const assignment = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.preferred_channel FROM p2p_assignments a
    JOIN contacts c ON a.contact_id = c.id WHERE a.id = ?
  `).get(req.params.assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

  // Match messages by normalized phone (handles +1 vs 10-digit mismatches)
  // Also include messages where session_id matches OR phone matches without session_id (synced inbound)
  const normalizedPhone = phoneDigits(assignment.phone);
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE (phone = ? OR phone = ? OR REPLACE(REPLACE(REPLACE(phone,'+1',''),'+',''),'-','') = ?)
      AND (session_id = ? OR (session_id IS NULL AND direction = 'inbound'))
    ORDER BY id ASC
  `).all(assignment.phone, normalizedPhone, normalizedPhone, assignment.session_id);

  res.json({ messages, assignment });
});

router.patch('/p2p/assignments/:id/complete', (req, res) => {
  const result = db.prepare("UPDATE p2p_assignments SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ success: true });
});

router.patch('/p2p/assignments/:id/skip', (req, res) => {
  const result = db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ success: true });
});

// ===================== TEXTING VOLUNTEERS (persistent identity) =====================
const { randomBytes } = require('crypto');
function generateVolCode() { return randomBytes(3).toString('hex').toUpperCase().slice(0, 6); }

// List all texting volunteers
router.get('/texting-volunteers', (req, res) => {
  const volunteers = db.prepare(`
    SELECT tv.*,
      (SELECT COUNT(*) FROM p2p_volunteers pv WHERE pv.volunteer_id = tv.id) as sessions_joined,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pv.volunteer_id = tv.id WHERE pa.status IN ('sent','in_conversation','completed')) as total_sent,
      (SELECT MAX(pv.last_active) FROM p2p_volunteers pv WHERE pv.volunteer_id = tv.id) as last_active
    FROM texting_volunteers tv ORDER BY tv.created_at DESC
  `).all();
  res.json({ volunteers });
});

// Create texting volunteer
router.post('/texting-volunteers', (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Volunteer name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateVolCode();
    if (!db.prepare('SELECT id FROM texting_volunteers WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code. Try again.' });
  }
  const result = db.prepare('INSERT INTO texting_volunteers (name, phone, code) VALUES (?, ?, ?)').run(name.trim(), phone || null, code);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Texting volunteer created: ' + name.trim() + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update texting volunteer
router.put('/texting-volunteers/:id', (req, res) => {
  const { name, phone, is_active } = req.body;
  const result = db.prepare(`UPDATE texting_volunteers SET
    name = COALESCE(?, name),
    phone = COALESCE(?, phone),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name || null, phone !== undefined ? phone : null, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Volunteer not found.' });
  res.json({ success: true });
});

// Delete texting volunteer
router.delete('/texting-volunteers/:id', (req, res) => {
  const vol = db.prepare('SELECT name FROM texting_volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });
  db.prepare('UPDATE p2p_volunteers SET volunteer_id = NULL WHERE volunteer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM texting_volunteers WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Texting volunteer deleted: ' + vol.name);
  res.json({ success: true });
});

// Volunteer login (public — code-based, no auth required)
router.post('/texting-volunteers/login', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const vol = db.prepare('SELECT * FROM texting_volunteers WHERE code = ?').get(code.trim().toUpperCase());
  if (!vol) return res.status(404).json({ error: 'Invalid volunteer code.' });
  if (!vol.is_active) return res.status(403).json({ error: 'This volunteer has been deactivated. Contact your campaign admin.' });
  // Get their session history
  const sessions = db.prepare(`
    SELECT pv.session_id, s.name, s.status, s.join_code,
      (SELECT COUNT(*) FROM p2p_assignments pa WHERE pa.session_id = s.id AND pa.volunteer_name = pv.name AND pa.status IN ('sent','in_conversation','completed')) as sent,
      (SELECT COUNT(*) FROM p2p_assignments pa WHERE pa.session_id = s.id AND pa.volunteer_name = pv.name AND pa.status = 'in_conversation') as active_chats
    FROM p2p_volunteers pv
    JOIN p2p_sessions s ON pv.session_id = s.id
    WHERE pv.volunteer_id = ? AND s.status = 'active'
    ORDER BY pv.joined_at DESC
  `).all(vol.id);
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM p2p_volunteers pv WHERE pv.volunteer_id = ?) as sessions_joined,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pv.volunteer_id = ? WHERE pa.volunteer_name = (SELECT name FROM texting_volunteers WHERE id = ?) AND pa.status IN ('sent','in_conversation','completed')) as total_sent
  `).get(vol.id, vol.id, vol.id);
  res.json({ success: true, volunteer: { id: vol.id, name: vol.name, code: vol.code }, sessions, stats });
});

// Volunteer dashboard
router.get('/texting-volunteers/:id/dashboard', (req, res) => {
  const vol = db.prepare('SELECT * FROM texting_volunteers WHERE id = ?').get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });
  const stats = {
    sessions_joined: (db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE volunteer_id = ?').get(vol.id) || {}).c || 0,
    total_sent: (db.prepare(`SELECT COUNT(*) as c FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pv.volunteer_id = ? WHERE pa.volunteer_name = ? AND pa.status IN ('sent','in_conversation','completed')`).get(vol.id, vol.name) || {}).c || 0,
    active_chats: (db.prepare(`SELECT COUNT(*) as c FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pv.volunteer_id = ? WHERE pa.volunteer_name = ? AND pa.status = 'in_conversation'`).get(vol.id, vol.name) || {}).c || 0
  };
  // Leaderboard of all active texting volunteers
  const leaderboard = db.prepare(`
    SELECT tv.id, tv.name,
      (SELECT COUNT(*) FROM p2p_assignments pa JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pv.volunteer_id = tv.id WHERE pa.volunteer_name = tv.name AND pa.status IN ('sent','in_conversation','completed')) as total_sent,
      (SELECT COUNT(*) FROM p2p_volunteers pv WHERE pv.volunteer_id = tv.id) as sessions
    FROM texting_volunteers tv WHERE tv.is_active = 1
    ORDER BY total_sent DESC LIMIT 15
  `).all();
  // Active sessions
  const sessions = db.prepare(`
    SELECT s.id, s.name, s.status, s.join_code
    FROM p2p_volunteers pv
    JOIN p2p_sessions s ON pv.session_id = s.id
    WHERE pv.volunteer_id = ? AND s.status = 'active'
    ORDER BY pv.joined_at DESC
  `).all(vol.id);
  res.json({ volunteer: vol, stats, leaderboard, sessions });
});

module.exports = router;
