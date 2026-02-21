const express = require('express');
const router = express.Router();
const db = require('../db');

// ========== HELPERS ==========

function generateJoinCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function getOnlineVolunteers(sessionId) {
  return db.prepare('SELECT * FROM p2p_volunteers WHERE session_id = ? AND is_online = 1').all(sessionId);
}

function getLeastLoadedVolunteer(sessionId, excludeId) {
  const vols = getOnlineVolunteers(sessionId).filter(v => v.id !== excludeId);
  if (vols.length === 0) return null;
  let best = null;
  let bestCount = Infinity;
  for (const v of vols) {
    const count = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status IN ('pending', 'sent', 'in_conversation')").get(v.id).c;
    if (count < bestCount) { bestCount = count; best = v; }
  }
  return best;
}

function redistributeContacts(sessionId, fromVolunteerId) {
  const pending = db.prepare("SELECT * FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status = 'pending'").all(fromVolunteerId, sessionId);
  const conversations = db.prepare("SELECT * FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')").all(fromVolunteerId, sessionId);

  const onlineVols = getOnlineVolunteers(sessionId).filter(v => v.id !== fromVolunteerId);
  if (onlineVols.length === 0) return;

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
}

function snapBackConversations(sessionId, volunteerId) {
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')")
    .run(volunteerId, volunteerId, sessionId);
  db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?")
    .run(volunteerId, sessionId);
}

function assignFreshBatch(sessionId, volunteerId) {
  const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 20").all(sessionId);
  for (const a of unassigned) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volunteerId, a.id);
  }
  return unassigned.length;
}

// ========== SESSIONS ==========

router.post('/p2p/sessions', (req, res) => {
  const { name, message_template, assignment_mode, contact_ids } = req.body;
  if (!name || !message_template) return res.status(400).json({ error: 'Name and message template required.' });
  if (!contact_ids || contact_ids.length === 0) return res.status(400).json({ error: 'Select contacts to text.' });

  const joinCode = generateJoinCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare('INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, message_template, assignment_mode || 'auto_split', joinCode, expiresAt);

  const sessionId = result.lastInsertRowid;

  const insert = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const addAll = db.transaction((ids) => { for (const id of ids) insert.run(sessionId, id); });
  addAll(contact_ids);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('P2P session created: ' + name + ' (' + contact_ids.length + ' contacts)');

  res.json({ success: true, id: sessionId, joinCode });
});

router.get('/p2p/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM p2p_sessions ORDER BY id DESC').all();
  for (const s of sessions) {
    s.totalContacts = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(s.id).c;
    s.sent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status != 'pending' AND status != 'skipped'").get(s.id).c;
    s.volunteerCount = db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?').get(s.id).c;
    s.onlineCount = db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ? AND is_online = 1').get(s.id).c;
  }
  res.json({ sessions });
});

router.get('/p2p/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM p2p_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  session.volunteers = db.prepare('SELECT * FROM p2p_volunteers WHERE session_id = ?').all(session.id);
  for (const v of session.volunteers) {
    v.sent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status IN ('sent', 'in_conversation', 'completed')").get(v.id).c;
    v.activeChats = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'in_conversation'").get(v.id).c;
    v.remaining = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(v.id).c;
  }

  session.totalContacts = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(session.id).c;
  session.totalSent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status IN ('sent', 'in_conversation', 'completed')").get(session.id).c;
  session.totalReplies = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'in_conversation'").get(session.id).c;
  session.remaining = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'pending'").get(session.id).c;

  res.json({ session });
});

router.patch('/p2p/sessions/:id', (req, res) => {
  const { status, assignment_mode } = req.body;
  if (status) db.prepare('UPDATE p2p_sessions SET status = ? WHERE id = ?').run(status, req.params.id);
  if (assignment_mode) db.prepare('UPDATE p2p_sessions SET assignment_mode = ? WHERE id = ?').run(assignment_mode, req.params.id);
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
      const onlineCount = db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ? AND is_online = 1').get(session.id).c;
      const batchSize = Math.ceil(unassigned.length / Math.max(onlineCount, 1));
      const batch = unassigned.slice(0, batchSize);
      for (const a of batch) {
        db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volunteer.id, a.id);
      }
    }
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(name + ' joined P2P session: ' + session.name);
  res.json({ success: true, volunteerId: volunteer.id, sessionId: session.id, sessionName: session.name });
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

  if (session.assignment_mode === 'claim') {
    const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 1").get(vol.session_id);
    if (unassigned) {
      db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(vol.id, unassigned.id);
    }
  }

  const assignment = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.city
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'pending'
    ORDER BY a.id ASC LIMIT 1
  `).get(req.params.id);

  const activeConversations = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name, c.city
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'in_conversation'
    ORDER BY a.id ASC
  `).all(req.params.id);

  const stats = {
    total: db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(req.params.id).c,
    sent: db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status IN ('sent', 'in_conversation', 'completed')").get(req.params.id).c,
    remaining: db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(req.params.id).c
  };

  let resolvedMessage = null;
  if (assignment) {
    resolvedMessage = session.message_template
      .replace(/{firstName}/g, assignment.first_name || '')
      .replace(/{lastName}/g, assignment.last_name || '')
      .replace(/{city}/g, assignment.city || '');
  }

  res.json({ assignment, resolvedMessage, activeConversations, stats, messageTemplate: session.message_template });
});

// ========== MESSAGING ==========

router.post('/p2p/send', async (req, res) => {
  const { volunteerId, assignmentId, message, accountSid, authToken, from } = req.body;
  if (!volunteerId || !assignmentId || !message) return res.status(400).json({ error: 'volunteerId, assignmentId, and message required.' });
  if (!accountSid || !authToken || !from) return res.status(400).json({ error: 'Twilio credentials required.' });

  const vol = db.prepare('SELECT * FROM p2p_volunteers WHERE id = ?').get(volunteerId);
  if (!vol) return res.status(404).json({ error: 'Volunteer not found.' });

  const assignment = db.prepare(`
    SELECT a.*, c.phone FROM p2p_assignments a
    JOIN contacts c ON a.contact_id = c.id WHERE a.id = ?
  `).get(assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

  try {
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body: message, from, to: assignment.phone });

    db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name) VALUES (?, ?, 'outbound', ?, ?)")
      .run(assignment.phone, message, vol.session_id, vol.name);

    db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(assignmentId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/p2p/conversations/:assignmentId', (req, res) => {
  const assignment = db.prepare(`
    SELECT a.*, c.phone, c.first_name, c.last_name FROM p2p_assignments a
    JOIN contacts c ON a.contact_id = c.id WHERE a.id = ?
  `).get(req.params.assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

  const messages = db.prepare('SELECT * FROM messages WHERE phone = ? AND session_id = ? ORDER BY id ASC')
    .all(assignment.phone, assignment.session_id);

  res.json({ messages, assignment });
});

router.patch('/p2p/assignments/:id/complete', (req, res) => {
  db.prepare("UPDATE p2p_assignments SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

router.patch('/p2p/assignments/:id/skip', (req, res) => {
  db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
