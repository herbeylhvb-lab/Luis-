const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateJoinCode, phoneDigits } = require('../utils');

// ========== SURVEYS CRUD ==========

// List all surveys with stats (single query instead of N+1)
router.get('/surveys', (req, res) => {
  const surveys = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM survey_questions sq WHERE sq.survey_id = s.id) as questionCount,
      (SELECT COUNT(*) FROM survey_sends ss WHERE ss.survey_id = s.id) as sendCount,
      (SELECT COUNT(DISTINCT sr.send_id) FROM survey_responses sr WHERE sr.survey_id = s.id) as responseCount
    FROM surveys s
    ORDER BY s.id DESC
  `).all();
  res.json({ surveys });
});

// Create survey
router.post('/surveys', (req, res) => {
  const { name, description, completion_message } = req.body;
  if (!name) return res.status(400).json({ error: 'Survey name is required.' });
  const result = db.prepare('INSERT INTO surveys (name, description, completion_message) VALUES (?, ?, ?)').run(name, description || '', completion_message || '');
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Survey created: ' + name);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get survey detail with questions, options, and response stats
router.get('/surveys/:id', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });

  survey.questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(survey.id);
  for (const q of survey.questions) {
    q.options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(q.id);
  }

  // Send stats
  survey.sends = {
    total: (db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(survey.id) || { c: 0 }).c,
    completed: (db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(survey.id) || { c: 0 }).c,
    in_progress: (db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'in_progress'").get(survey.id) || { c: 0 }).c,
  };

  res.json({ survey });
});

// Update survey metadata
router.put('/surveys/:id', (req, res) => {
  const { name, description, status, completion_message } = req.body;
  const validStatuses = ['draft', 'active', 'closed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
  }
  const result = db.prepare('UPDATE surveys SET name = COALESCE(?, name), description = COALESCE(?, description), status = COALESCE(?, status), completion_message = COALESCE(?, completion_message) WHERE id = ?')
    .run(name, description, status, completion_message, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Survey not found.' });
  res.json({ success: true });
});

// Delete survey
router.delete('/surveys/:id', (req, res) => {
  const survey = db.prepare('SELECT name FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });
  db.prepare('DELETE FROM surveys WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Survey deleted: ' + survey.name);
  res.json({ success: true });
});

// ========== QUESTIONS ==========

// Add question to survey
router.post('/surveys/:id/questions', (req, res) => {
  const { question_text, question_type, options } = req.body;
  if (!question_text) return res.status(400).json({ error: 'Question text is required.' });
  const validTypes = ['single_choice', 'ranked_choice', 'write_in'];
  const type = validTypes.includes(question_type) ? question_type : 'single_choice';

  const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM survey_questions WHERE survey_id = ?').get(req.params.id) || { m: 0 }).m || 0;

  const qResult = db.prepare('INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, ?, ?, ?)')
    .run(req.params.id, question_text, type, maxOrder + 1);
  const questionId = qResult.lastInsertRowid;

  // Add options for choice-based questions
  if ((type === 'single_choice' || type === 'ranked_choice') && options && options.length > 0) {
    const insertOpt = db.prepare('INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, ?, ?, ?)');
    const addOpts = db.transaction((opts) => {
      opts.forEach((opt, i) => {
        const key = String(i + 1); // "1", "2", "3"...
        insertOpt.run(questionId, opt.text || opt, key, i);
      });
    });
    addOpts(options);
  }

  res.json({ success: true, questionId });
});

// Update question
router.put('/surveys/:surveyId/questions/:qId', (req, res) => {
  const { question_text, question_type } = req.body;
  const result = db.prepare('UPDATE survey_questions SET question_text = COALESCE(?, question_text), question_type = COALESCE(?, question_type) WHERE id = ? AND survey_id = ?')
    .run(question_text, question_type, req.params.qId, req.params.surveyId);
  if (result.changes === 0) return res.status(404).json({ error: 'Question not found.' });
  res.json({ success: true });
});

// Delete question
router.delete('/surveys/:surveyId/questions/:qId', (req, res) => {
  const result = db.prepare('DELETE FROM survey_questions WHERE id = ? AND survey_id = ?').run(req.params.qId, req.params.surveyId);
  if (result.changes === 0) return res.status(404).json({ error: 'Question not found.' });
  res.json({ success: true });
});

// ========== SEND SURVEY ==========

// Send survey via P2P session (TCPA compliant)
router.post('/surveys/:id/send', (req, res) => {
  const { contact_ids, list_id, precinct_filter } = req.body;
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });
  if (survey.status === 'closed') return res.status(400).json({ error: 'Cannot send a closed survey. Reopen it first.' });

  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(survey.id);
  if (questions.length === 0) return res.status(400).json({ error: 'Survey has no questions. Add questions first.' });

  // Gather contacts - either from list_id or contact_ids
  let contacts = [];
  if (list_id) {
    // Get contacts from admin list (voters with phones)
    let listSql = `
      SELECT v.id, v.phone, v.first_name, v.last_name
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != ''
    `;
    const listParams = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      listSql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      listParams.push(...precinct_filter);
    }
    contacts = db.prepare(listSql).all(...listParams);
  } else if (contact_ids && contact_ids.length > 0) {
    const getContact = db.prepare('SELECT id, phone, first_name, last_name FROM contacts WHERE id = ?');
    for (const cid of contact_ids) {
      const c = getContact.get(cid);
      if (c && c.phone) contacts.push(c);
    }
  }

  if (contacts.length === 0) return res.status(400).json({ error: 'No contacts with phone numbers found.' });

  // Build the first question message
  const firstQ = questions[0];
  let firstQOptions = [];
  if (firstQ.question_type !== 'write_in') {
    firstQOptions = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(firstQ.id);
  }

  // Create a P2P session for survey delivery
  const joinCode = generateJoinCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const msgTemplate = buildSurveyMessage(survey.name, firstQ, firstQOptions);

  const sessionResult = db.prepare(
    'INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at, session_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('Survey: ' + survey.name, msgTemplate, 'auto_split', joinCode, expiresAt, 'survey');
  const sessionId = sessionResult.lastInsertRowid;

  // Queue sends and P2P assignments
  const insertSend = db.prepare('INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, ?, ?, ?)');
  const insertAssign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)');
  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));

  let queued = 0;
  const sendTx = db.transaction(() => {
    for (const c of contacts) {
      const normalizedPhone = phoneDigits(c.phone);
      if (!normalizedPhone || optedOutSet.has(normalizedPhone)) continue;
      insertSend.run(survey.id, normalizedPhone, ((c.first_name || '') + ' ' + (c.last_name || '')).trim(), firstQ.id);
      // Ensure contact exists for P2P assignment
      let contactId = c.id;
      if (list_id) {
        const existing = findContact.get(c.phone);
        if (existing) { contactId = existing.id; }
        else {
          const r = insertContact.run(c.phone, c.first_name || '', c.last_name || '', c.city || '');
          contactId = r.lastInsertRowid;
        }
      }
      try { insertAssign.run(sessionId, contactId); } catch (e) { if (!e.message.includes('UNIQUE')) throw e; }
      queued++;
    }
  });
  sendTx();

  // Update survey status to active
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(survey.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Survey "' + survey.name + '" sent to ' + queued + ' contacts');

  res.json({ success: true, queued, joinCode, sessionId });
});

// Get the P2P session linked to this survey (for showing join code to admin)
router.get('/surveys/:id/session', (req, res) => {
  const survey = db.prepare('SELECT name FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });
  const session = db.prepare("SELECT id, name, join_code, status, code_expires_at FROM p2p_sessions WHERE name = ? ORDER BY id DESC LIMIT 1")
    .get('Survey: ' + survey.name);
  res.json({ session: session || null });
});

// ========== START / END POLL ==========

// Start a poll (activate response collection)
router.post('/surveys/:id/start', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });

  const qCount = (db.prepare('SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?').get(req.params.id) || { c: 0 }).c;
  if (qCount === 0) return res.status(400).json({ error: 'Add at least one question before starting.' });

  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Poll started: ' + survey.name);
  res.json({ success: true, status: 'active' });
});

// End a poll (stop collecting responses, expire pending sends)
router.post('/surveys/:id/end', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });

  // Close the survey
  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(req.params.id);

  // Expire any sends that haven't completed
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')")
    .run(req.params.id);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Poll ended: ' + survey.name + ' (' + expired.changes + ' pending sends expired)');
  res.json({ success: true, status: 'closed', expiredSends: expired.changes });
});

// ========== RESULTS ==========

// Get survey results
router.get('/surveys/:id/results', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found.' });

  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(survey.id);
  const results = [];

  for (const q of questions) {
    const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(q.id);
    const responses = db.prepare('SELECT * FROM survey_responses WHERE question_id = ? ORDER BY responded_at DESC').all(q.id);

    // Tally results
    const tally = {};
    for (const opt of options) {
      tally[opt.option_key] = { text: opt.option_text, count: 0 };
    }
    const writeIns = [];

    // Ranked choice: track by position (1st, 2nd, 3rd...) with weighted score
    let rankings = null;
    if (q.question_type === 'ranked_choice') {
      rankings = {};
      for (const opt of options) {
        rankings[opt.option_key] = { text: opt.option_text, positions: {}, score: 0 };
      }
    }

    for (const r of responses) {
      if (!r.response_text) continue;  // Skip null/empty responses
      if (q.question_type === 'write_in') {
        writeIns.push({ phone: r.phone, text: r.response_text, date: r.responded_at });
      } else if (q.question_type === 'ranked_choice' && r.response_text.includes(',')) {
        // Ranked choice: "1,3,2" — each position gets weighted points
        const picks = r.response_text.split(',');
        const totalOpts = options.length;
        picks.forEach((key, pos) => {
          const k = key.trim();
          if (rankings[k]) {
            const posLabel = String(pos + 1);
            rankings[k].positions[posLabel] = (rankings[k].positions[posLabel] || 0) + 1;
            // Borda count: 1st place gets N points, 2nd gets N-1, etc.
            rankings[k].score += Math.max(0, totalOpts - pos);
          }
        });
        // Also count 1st choice in the regular tally for the bar chart
        const firstPick = picks[0] && picks[0].trim();
        if (firstPick && tally[firstPick]) tally[firstPick].count++;
      } else if (tally[r.response_text]) {
        tally[r.response_text].count++;
      } else {
        writeIns.push({ phone: r.phone, text: r.response_text, date: r.responded_at });
      }
    }

    results.push({
      question: q,
      options,
      tally,
      rankings,
      writeIns,
      totalResponses: responses.length
    });
  }

  const totalSends = (db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(survey.id) || { c: 0 }).c;
  const completedSends = (db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(survey.id) || { c: 0 }).c;

  res.json({ survey, results, totalSends, completedSends });
});

// ========== HELPERS ==========

function buildSurveyMessage(surveyName, question, options) {
  let msg = 'Survey: ' + surveyName + '\n\n' + question.question_text;
  if (question.question_type === 'single_choice' && options.length > 0) {
    msg += '\n\nReply with the number or name of your choice:';
    options.forEach((opt, i) => {
      msg += '\n' + (i + 1) + ') ' + opt.option_text;
    });
  } else if (question.question_type === 'ranked_choice' && options.length > 0) {
    msg += '\n\nRank your choices from favorite to least. Reply with numbers or names separated by commas (e.g. "2,1,3" or "' + options[0].option_text + ', ' + (options[1] ? options[1].option_text : '...') + '"):';
    options.forEach((opt, i) => {
      msg += '\n' + (i + 1) + ') ' + opt.option_text;
    });
  } else if (question.question_type === 'write_in') {
    msg += '\n\nReply with your answer.';
  }
  msg += '\n\nReply STOP to opt out.';
  return msg;
}

module.exports = router;
module.exports.buildSurveyMessage = buildSurveyMessage;
