const express = require('express');
const router = express.Router();
const db = require('../db');
const { getProvider } = require('../providers');
const { phoneDigits, asyncHandler, personalizeTemplate } = require('../utils');

// ── Broadcast (Mass) Texting ──

const rateLimit = require('express-rate-limit');
const broadcastLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many broadcast sends. Please wait.' } });

// Create a broadcast campaign — sends to all contacts in a list or all contacts with phone
router.post('/broadcast/send', broadcastLimiter, asyncHandler(async (req, res) => {
  const { message, list_id, footer, name, precinct_filter } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });

  // Gather recipients — include secondary_phone as a separate entry so both numbers get texted
  let recipients = [];
  if (list_id) {
    let sql = `
      SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL AND COALESCE(v.phone_type,'') NOT IN ('landline','invalid')
    `;
    const params = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      sql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      params.push(...precinct_filter);
    }
    recipients = db.prepare(sql).all(...params);
    // Add secondary phone entries
    let secSql = `
      SELECT v.id as voter_id, v.secondary_phone as phone, v.first_name, v.last_name, v.city
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.secondary_phone != '' AND v.secondary_phone IS NOT NULL AND COALESCE(v.secondary_phone_type,'') NOT IN ('landline','invalid')
    `;
    const secParams = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      secSql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      secParams.push(...precinct_filter);
    }
    const secRecipients = db.prepare(secSql).all(...secParams);
    recipients.push(...secRecipients);
    // Add tertiary phone entries
    let terSql = `
      SELECT v.id as voter_id, v.tertiary_phone as phone, v.first_name, v.last_name, v.city
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.tertiary_phone != '' AND v.tertiary_phone IS NOT NULL AND COALESCE(v.tertiary_phone_type,'') NOT IN ('landline','invalid')
    `;
    const terParams = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      terSql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      terParams.push(...precinct_filter);
    }
    const terRecipients = db.prepare(terSql).all(...terParams);
    recipients.push(...terRecipients);
  } else {
    // All contacts with phone numbers
    const voters = db.prepare("SELECT id as voter_id, phone, first_name, last_name, city FROM voters WHERE phone != '' AND phone IS NOT NULL AND COALESCE(phone_type,'') NOT IN ('landline','invalid')").all();
    // Also grab secondary phones
    const secVoters = db.prepare("SELECT id as voter_id, secondary_phone as phone, first_name, last_name, city FROM voters WHERE secondary_phone != '' AND secondary_phone IS NOT NULL AND COALESCE(secondary_phone_type,'') NOT IN ('landline','invalid')").all();
    // Also grab tertiary phones
    const terVoters = db.prepare("SELECT id as voter_id, tertiary_phone as phone, first_name, last_name, city FROM voters WHERE tertiary_phone != '' AND tertiary_phone IS NOT NULL AND COALESCE(tertiary_phone_type,'') NOT IN ('landline','invalid')").all();
    const contacts = db.prepare("SELECT id, phone, first_name, last_name, city FROM contacts WHERE phone != '' AND phone IS NOT NULL").all();
    // Deduplicate by normalized phone digits
    const seen = new Set();
    for (const v of voters) { const d = phoneDigits(v.phone); if (d && !seen.has(d)) { seen.add(d); recipients.push(v); } }
    for (const v of secVoters) { const d = phoneDigits(v.phone); if (d && !seen.has(d)) { seen.add(d); recipients.push(v); } }
    for (const v of terVoters) { const d = phoneDigits(v.phone); if (d && !seen.has(d)) { seen.add(d); recipients.push(v); } }
    for (const c of contacts) { const d = phoneDigits(c.phone); if (d && !seen.has(d)) { seen.add(d); recipients.push(c); } }
  }

  if (recipients.length === 0) return res.status(400).json({ error: 'No recipients with phone numbers found.' });

  // Filter out opted-out contacts
  const optedOut = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => phoneDigits(r.phone)));
  // Dedup recipients by normalized phone + filter opted out
  const seenPhones = new Set();
  recipients = recipients.filter(r => {
    const d = phoneDigits(r.phone);
    if (!d || optedOut.has(d) || seenPhones.has(d)) return false;
    seenPhones.add(d);
    return true;
  });

  if (recipients.length === 0) return res.status(400).json({ error: 'All recipients have opted out.' });

  // Create broadcast campaign record
  const fullMsg = message + (footer ? '\n' + footer : '');
  const campaignName = name || 'Broadcast ' + new Date().toLocaleDateString();
  const campaign = db.prepare(
    'INSERT INTO broadcast_campaigns (name, message, list_id, total_recipients, status) VALUES (?, ?, ?, ?, ?)'
  ).run(campaignName, fullMsg, list_id || null, recipients.length, 'sending');
  const campaignId = campaign.lastInsertRowid;

  // Send messages in batches (wrapped in try/finally to ensure status is updated)
  let sent = 0;
  let failed = 0;
  const errors = [];

  try {
    for (const r of recipients) {
      // Personalize message (uses shared utility with anti-double-substitution protection)
      const personalMsg = personalizeTemplate(fullMsg, r);

      if (!phoneDigits(r.phone)) { failed++; continue; }

      try {
        await provider.sendMessage(r.phone, personalMsg);
        db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, ?, 'outbound', 'sms')").run(phoneDigits(r.phone), personalMsg);
        // Log to voter profile if this is a voter (has voter_id)
        if (r.voter_id) {
          db.prepare(
            'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
          ).run(r.voter_id, 'Broadcast Text', 'Sent', campaignName + ': ' + personalMsg.substring(0, 100), 'Broadcast');
        }
        sent++;
      } catch (err) {
        failed++;
        if (errors.length < 5) errors.push(r.phone + ': ' + (err.message || 'Unknown error'));
      }

      // Small delay to avoid rate limits (100ms every 10 messages, regardless of success/failure)
      if ((sent + failed) % 10 === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    // Always update campaign record, even if an unexpected error aborts the loop
    const status = sent === 0 ? 'failed' : (failed > 0 ? 'partial' : 'completed');
    db.prepare('UPDATE broadcast_campaigns SET sent_count = ?, failed_count = ?, status = ? WHERE id = ?')
      .run(sent, failed, status, campaignId);
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Broadcast "' + campaignName + '": ' + sent + ' sent, ' + failed + ' failed'
  );

  res.json({ success: true, sent, failed, total: recipients.length, errors, campaignId });
}));

// List broadcast campaigns
router.get('/broadcast/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT bc.*, al.name as list_name
    FROM broadcast_campaigns bc
    LEFT JOIN admin_lists al ON bc.list_id = al.id
    ORDER BY bc.id DESC LIMIT 50
  `).all();
  res.json({ campaigns });
});

// ── GOTV (Get Out The Vote) Chase Tools ──

// GOTV Dashboard stats
router.get('/gotv/stats', (req, res) => {
  const { race_col, race_val } = req.query;
  const candidate_id = req.query.candidate_id ? parseInt(req.query.candidate_id) : null;
  const validCols = ['navigation_port','navigation_district','port_authority','city_district','school_district','college_district','state_rep','state_senate','us_congress','county_commissioner','justice_of_peace','state_board_ed','hospital_district'];

  let raceFilter = '';
  const raceParams = [];
  const list_id = req.query.list_id;
  // Resolve race from candidate if not sent by frontend
  let effectiveRaceCol = race_col;
  let effectiveRaceVal = race_val;
  if (!effectiveRaceCol && candidate_id) {
    const cand = db.prepare('SELECT race_type, race_value FROM candidates WHERE id = ?').get(candidate_id);
    if (cand && cand.race_type && cand.race_value && validCols.includes(cand.race_type)) {
      effectiveRaceCol = cand.race_type;
      effectiveRaceVal = cand.race_value;
    }
  }
  if (effectiveRaceCol && validCols.includes(effectiveRaceCol) && effectiveRaceVal) {
    raceFilter += ` AND ${effectiveRaceCol} = ?`;
    raceParams.push(effectiveRaceVal);
  }
  if (list_id) {
    raceFilter += ' AND id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    raceParams.push(list_id);
  } else if (candidate_id) {
    raceFilter += ` AND id IN (
      SELECT voter_id FROM admin_list_voters alv JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
      UNION
      SELECT voter_id FROM walk_addresses wa JOIN block_walks bw ON wa.walk_id = bw.id WHERE bw.candidate_id = ? AND wa.voter_id IS NOT NULL
    )`;
    raceParams.push(candidate_id, candidate_id);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM voters WHERE 1=1${raceFilter}`).get(...raceParams) || { c: 0 }).c;
  const earlyVoted = (db.prepare(`SELECT COUNT(*) as c FROM voters WHERE early_voted = 1${raceFilter}`).get(...raceParams) || { c: 0 }).c;
  const notVoted = total - earlyVoted;

  const supportersNotVoted = (db.prepare(`
    SELECT COUNT(*) as c FROM voters
    WHERE early_voted != 1 AND support_level IN ('strong_support', 'lean_support', 'supporter', 'support')${raceFilter}
  `).get(...raceParams) || { c: 0 }).c;

  const bySupport = db.prepare(`
    SELECT support_level, COUNT(*) as count
    FROM voters WHERE early_voted != 1${raceFilter}
    GROUP BY support_level ORDER BY count DESC
  `).all(...raceParams);

  const byPrecinct = db.prepare(`
    SELECT precinct, COUNT(*) as total,
      SUM(CASE WHEN early_voted = 1 THEN 1 ELSE 0 END) as voted,
      SUM(CASE WHEN early_voted != 1 THEN 1 ELSE 0 END) as not_voted,
      SUM(CASE WHEN early_voted != 1 AND support_level IN ('strong_support', 'lean_support', 'supporter', 'support') THEN 1 ELSE 0 END) as supporters_remaining
    FROM voters WHERE precinct != ''${raceFilter}
    GROUP BY precinct ORDER BY supporters_remaining DESC
  `).all(...raceParams);

  const withPhone = (db.prepare(`
    SELECT COUNT(*) as c FROM voters
    WHERE early_voted != 1 AND phone != '' AND phone IS NOT NULL${raceFilter}
  `).get(...raceParams) || { c: 0 }).c;

  res.json({ total, earlyVoted, notVoted, supportersNotVoted, withPhone, bySupport, byPrecinct });
});

// "Confirmed Mine" + "Projected Mine" — count of unique voters who voted
// and are confirmed yours, plus a projection that adds a fraction of
// undecided/unknown universe voters who voted.
//
// Default split rates:
//   undecided_split = 0.50 — they were asked and didn't commit; truly 50/50
//   unknown_split   = 0.20 — never reached / never asked; mostly opposition
//                            territory but some lean yours
// Both are query-string overridable (?undecided_split=0.6&unknown_split=0.3)
// so you can tune per-race without code changes.
//
// CONFIRMED set = (universe voters with strong/lean support AND voted)
//                 ∪ (captain-list voters under candidate AND voted),
//                 deduplicated.
//
// PROJECTED EXTRA = 50% of (universe voters with undecided AND voted,
//                            NOT already on a captain list)
//                 + 50% of (universe voters with unknown/empty AND voted,
//                            NOT already on a captain list).
// The "NOT on captain list" exclusion prevents double-counting voters
// who are already in the confirmed set via the captain path.
//
// projected_mine = confirmed_mine + projected_extra (rounded).
//
// Either parameter is optional. If both missing, returns zeros.
router.get('/gotv/confirmed-mine', (req, res) => {
  const universeId = req.query.universe_id ? parseInt(req.query.universe_id, 10) : null;
  const candidateId = req.query.candidate_id ? parseInt(req.query.candidate_id, 10) : null;
  // Parse split rates with sensible defaults. Clamp to [0, 1] so a typo
  // can't produce negative projections or > 100% leans.
  const undecidedSplit = Math.max(0, Math.min(1, parseFloat(req.query.undecided_split) || 0.5));
  const unknownSplit = Math.max(0, Math.min(1, parseFloat(req.query.unknown_split) || 0.2));

  if (!universeId && !candidateId) {
    return res.json({
      confirmed_mine: 0,
      universe_supporters_voted: 0,
      captain_list_voted: 0,
      overlap: 0,
      universe_undecided_voted: 0,
      universe_unknown_voted: 0,
      projected_mine: 0,
      undecided_split: undecidedSplit,
      unknown_split: unknownSplit,
    });
  }

  // CTE for universe SUPPORTERS (strong/lean) — counted at 100%.
  const universeSupportersCte = universeId
    ? `SELECT v.id FROM voters v
        JOIN admin_list_voters alv ON v.id = alv.voter_id
        WHERE alv.list_id = ?
          AND v.early_voted = 1
          AND v.support_level IN ('strong_support', 'lean_support', 'supporter', 'support')`
    : `SELECT NULL AS id WHERE 1=0`;

  // CTE for universe UNDECIDED — counted at 50% in projection.
  const universeUndecidedCte = universeId
    ? `SELECT v.id FROM voters v
        JOIN admin_list_voters alv ON v.id = alv.voter_id
        WHERE alv.list_id = ?
          AND v.early_voted = 1
          AND v.support_level = 'undecided'`
    : `SELECT NULL AS id WHERE 1=0`;

  // CTE for universe UNKNOWN (explicit 'unknown', empty string, or NULL)
  // — counted at 50% in projection.
  const universeUnknownCte = universeId
    ? `SELECT v.id FROM voters v
        JOIN admin_list_voters alv ON v.id = alv.voter_id
        WHERE alv.list_id = ?
          AND v.early_voted = 1
          AND (v.support_level = 'unknown' OR v.support_level = '' OR v.support_level IS NULL)`
    : `SELECT NULL AS id WHERE 1=0`;

  // CTE for captain-list voters under the candidate (primary or shared).
  const captainCte = candidateId
    ? `SELECT DISTINCT v.id FROM voters v
        JOIN captain_list_voters clv ON v.id = clv.voter_id
        JOIN captain_lists cl ON clv.list_id = cl.id
        JOIN captains c ON cl.captain_id = c.id
        WHERE v.early_voted = 1
          AND (
            c.candidate_id = ?
            OR c.id IN (SELECT captain_id FROM captain_candidates WHERE candidate_id = ?)
          )`
    : `SELECT NULL AS id WHERE 1=0`;

  // Param order must match CTE placeholder order.
  const params = [];
  if (universeId) params.push(universeId);            // universe_supporters
  if (universeId) params.push(universeId);            // universe_undecided
  if (universeId) params.push(universeId);            // universe_unknown
  if (candidateId) params.push(candidateId, candidateId); // captain (2 params)

  const sql = `
    WITH universe_supporters AS (${universeSupportersCte}),
         universe_undecided  AS (${universeUndecidedCte}),
         universe_unknown    AS (${universeUnknownCte}),
         captain_voters      AS (${captainCte})
    SELECT
      (SELECT COUNT(*) FROM universe_supporters) AS universe_supporters_voted,
      (SELECT COUNT(*) FROM captain_voters)      AS captain_list_voted,
      (SELECT COUNT(*) FROM (
         SELECT id FROM universe_supporters UNION SELECT id FROM captain_voters
       ))                                         AS confirmed_mine,
      (SELECT COUNT(*) FROM universe_supporters
         WHERE id IN (SELECT id FROM captain_voters)) AS overlap,
      -- Undecided/unknown counts EXCLUDE voters already on a captain list,
      -- otherwise we'd add 50% on top of someone counted at 100%. Net is
      -- only the projection-eligible voters.
      (SELECT COUNT(*) FROM universe_undecided
         WHERE id NOT IN (SELECT id FROM captain_voters)) AS universe_undecided_voted,
      (SELECT COUNT(*) FROM universe_unknown
         WHERE id NOT IN (SELECT id FROM captain_voters)) AS universe_unknown_voted
  `;

  try {
    const row = db.prepare(sql).get(...params) || {};
    const confirmedMine = row.confirmed_mine || 0;
    const undecided = row.universe_undecided_voted || 0;
    const unknown = row.universe_unknown_voted || 0;
    // Apply per-category split rates. Defaults: 50% on undecided, 20% on
    // unknown (unknown voters are mostly opposition territory but some
    // lean yours — 20% is more realistic than 50/50 for cold contacts).
    const projectedExtra = Math.round(undecided * undecidedSplit + unknown * unknownSplit);
    const projectedMine = confirmedMine + projectedExtra;
    res.json({
      confirmed_mine: confirmedMine,
      universe_supporters_voted: row.universe_supporters_voted || 0,
      captain_list_voted: row.captain_list_voted || 0,
      overlap: row.overlap || 0,
      universe_undecided_voted: undecided,
      universe_unknown_voted: unknown,
      projected_mine: projectedMine,
      undecided_split: undecidedSplit,
      unknown_split: unknownSplit,
    });
  } catch (e) {
    console.error('confirmed-mine error:', e.message);
    res.status(500).json({ error: 'Failed to compute confirmed-mine count.' });
  }
});

// Auto-derive projection split rates from survey response data.
//
// Scans surveys for questions whose options use support-level option_keys
// (strong_support, lean_support, undecided, lean_oppose, strong_oppose,
// unknown). For each such survey, computes the actual support distribution
// among respondents, then derives:
//   undecided_split = supports / (supports + opposes)        — among voters
//                                                             who SAID undecided,
//                                                             how do they actually
//                                                             lean if forced?
//   unknown_split   = supports / total responded             — among UNKNOWN
//                                                             voters who responded,
//                                                             what % support us?
//
// The "unknown" rate uses total because unknown voters could land anywhere;
// the "undecided" rate uses only supports + opposes because undecided is
// already its own bucket and we want the lean-when-forced split.
//
// Returns the latest survey's derived rates (most recent). Lists all
// candidate surveys with their distributions so the UI can let the captain
// pick a different survey to calibrate from.
router.get('/gotv/survey-derived-splits', (req, res) => {
  const surveyIdParam = req.query.survey_id ? parseInt(req.query.survey_id, 10) : null;

  // Find all surveys that have at least one question with support-level
  // option_keys. These are the candidate-preference surveys.
  const supportKeys = ['strong_support', 'lean_support', 'support', 'supporter',
                       'undecided', 'lean_oppose', 'strong_oppose', 'oppose', 'unknown'];
  const placeholders = supportKeys.map(() => '?').join(',');

  let candidateSurveys;
  try {
    candidateSurveys = db.prepare(`
      SELECT DISTINCT s.id, s.name, s.status, s.created_at,
        (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) AS response_count
      FROM surveys s
      WHERE EXISTS (
        SELECT 1 FROM survey_questions q
        JOIN survey_options o ON o.question_id = q.id
        WHERE q.survey_id = s.id AND o.option_key IN (${placeholders})
      )
      ORDER BY s.created_at DESC
    `).all(...supportKeys);
  } catch (e) {
    console.error('survey-derived-splits list error:', e.message);
    return res.status(500).json({ error: 'Failed to scan surveys.' });
  }

  if (!candidateSurveys.length) {
    return res.json({
      surveys: [],
      derived: null,
      message: 'No surveys found with support-level option keys. Default rates remain in effect.'
    });
  }

  // Pick the requested survey, or the most recent one with responses.
  const targetSurvey = surveyIdParam
    ? candidateSurveys.find(s => s.id === surveyIdParam)
    : candidateSurveys.find(s => s.response_count > 0) || candidateSurveys[0];

  if (!targetSurvey) {
    return res.json({ surveys: candidateSurveys, derived: null });
  }

  // Distribution of responses by support category for the target survey.
  const distRows = db.prepare(`
    SELECT o.option_key, COUNT(*) AS count
    FROM survey_responses r
    JOIN survey_options o ON o.id = r.option_id
    WHERE r.survey_id = ? AND o.option_key IN (${placeholders})
    GROUP BY o.option_key
  `).all(targetSurvey.id, ...supportKeys);

  const dist = { strong_support: 0, lean_support: 0, undecided: 0,
                 lean_oppose: 0, strong_oppose: 0, unknown: 0 };
  for (const r of distRows) {
    // Normalize 'support'/'supporter' into strong_support, 'oppose' into strong_oppose
    const k = r.option_key;
    if (k === 'support' || k === 'supporter') dist.strong_support += r.count;
    else if (k === 'oppose') dist.strong_oppose += r.count;
    else if (dist.hasOwnProperty(k)) dist[k] += r.count;
  }

  const supports = dist.strong_support + dist.lean_support;
  const opposes  = dist.lean_oppose + dist.strong_oppose;
  const undecidedCount = dist.undecided;
  const total = supports + opposes + undecidedCount + dist.unknown;

  // Derive rates. Guard against divide-by-zero — if a category has 0
  // respondents, fall back to the standard defaults (0.5 / 0.2).
  let undecidedSplit = 0.5;
  let unknownSplit = 0.2;
  if (supports + opposes > 0) {
    // When forced to choose, what % of "undecided" likely actually lean ours?
    // Use the supports/(supports+opposes) ratio as the proxy.
    undecidedSplit = supports / (supports + opposes);
  }
  if (total > 0) {
    // For never-asked unknowns, what % naturally support us?
    // Use total response support rate (raw % of survey takers who back us).
    unknownSplit = supports / total;
  }

  res.json({
    surveys: candidateSurveys,
    selected_survey: { id: targetSurvey.id, name: targetSurvey.name, response_count: targetSurvey.response_count },
    distribution: dist,
    totals: { supports, opposes, undecided: undecidedCount, unknown: dist.unknown, total },
    derived: {
      undecided_split: Math.round(undecidedSplit * 100) / 100,
      unknown_split: Math.round(unknownSplit * 100) / 100
    }
  });
});

// GOTV Chase list — get voters who haven't voted, filtered
router.get('/gotv/chase', (req, res) => {
  const { support, precinct, has_phone, limit: lim } = req.query;
  let sql = 'SELECT id, first_name, last_name, phone, address, city, precinct, support_level, party FROM voters WHERE early_voted != 1';
  const params = [];

  if (support) {
    const levels = support.split(',');
    sql += ' AND support_level IN (' + levels.map(() => '?').join(',') + ')';
    params.push(...levels);
  }
  if (precinct) {
    sql += ' AND precinct = ?';
    params.push(precinct);
  }
  if (has_phone === '1') {
    sql += " AND phone != '' AND phone IS NOT NULL AND COALESCE(phone_type,'') NOT IN ('landline','invalid')";
  }

  sql += ' ORDER BY support_level, last_name, first_name';
  if (lim && parseInt(lim, 10) > 0) {
    sql += ' LIMIT ?';
    params.push(parseInt(lim, 10));
  }

  const voters = db.prepare(sql).all(...params);
  res.json({ voters, count: voters.length });
});

// GOTV Create chase list (save as admin list for texting)
router.post('/gotv/create-chase-list', (req, res) => {
  const { name, support_levels, precinct, has_phone } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });

  let sql = 'SELECT id FROM voters WHERE early_voted != 1';
  const params = [];

  if (support_levels && support_levels.length) {
    sql += ' AND support_level IN (' + support_levels.map(() => '?').join(',') + ')';
    params.push(...support_levels);
  }
  if (precinct) {
    sql += ' AND precinct = ?';
    params.push(precinct);
  }
  if (has_phone) {
    sql += " AND phone != '' AND phone IS NOT NULL";
  }

  const voterIds = db.prepare(sql).all(...params).map(v => v.id);
  if (voterIds.length === 0) return res.status(400).json({ error: 'No matching voters found.' });

  // Create admin list
  const list = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, 'text')")
    .run(name, 'GOTV chase list - ' + voterIds.length + ' voters who haven\'t voted');
  const listId = list.lastInsertRowid;

  // Add voters
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addAll = db.transaction((ids) => {
    let added = 0;
    for (const id of ids) {
      const r = insert.run(listId, id);
      if (r.changes > 0) added++;
    }
    return added;
  });
  const added = addAll(voterIds);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'GOTV chase list "' + name + '" created with ' + added + ' voters'
  );

  res.json({ success: true, listId, added });
});

// ── Enhanced Analytics ──

// Messages over time (for chart)
router.get('/analytics/messages-over-time', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const data = db.prepare(`
    SELECT DATE(timestamp) as date,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as received
    FROM messages
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(timestamp)
    ORDER BY date
  `).all(days);
  res.json({ data });
});

// Contact rate by hour of day
router.get('/analytics/hourly', (req, res) => {
  const data = db.prepare(`
    SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as received
    FROM messages
    GROUP BY hour ORDER BY hour
  `).all();
  res.json({ data });
});

// Support level distribution
router.get('/analytics/support-levels', (req, res) => {
  const data = db.prepare(`
    SELECT support_level, COUNT(*) as count
    FROM voters GROUP BY support_level ORDER BY count DESC
  `).all();
  res.json({ data });
});

// Voter engagement breakdown
router.get('/analytics/engagement', (req, res) => {
  const data = db.prepare(`
    SELECT
      CASE
        WHEN voter_score >= 50 THEN 'High (50+)'
        WHEN voter_score >= 20 THEN 'Medium (20-49)'
        WHEN voter_score > 0 THEN 'Low (1-19)'
        ELSE 'None (0)'
      END as tier,
      COUNT(*) as count
    FROM voters GROUP BY tier ORDER BY MIN(voter_score) DESC
  `).all();
  res.json({ data });
});

// Campaign performance summary
router.get('/analytics/summary', (req, res) => {
  const totalSent = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'outbound'").get() || { c: 0 }).c;
  const totalReceived = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'inbound'").get() || { c: 0 }).c;
  const totalVoters = (db.prepare('SELECT COUNT(*) as c FROM voters').get() || { c: 0 }).c;
  const contacted = (db.prepare('SELECT COUNT(DISTINCT voter_id) as c FROM voter_contacts').get() || { c: 0 }).c;
  const doorsKnocked = (db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE result != 'not_visited'").get() || { c: 0 }).c;
  const eventsHeld = (db.prepare("SELECT COUNT(*) as c FROM events").get() || { c: 0 }).c;
  const checkins = (db.prepare("SELECT COUNT(*) as c FROM voter_checkins").get() || { c: 0 }).c;
  const surveysCompleted = (db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE status = 'completed'").get() || { c: 0 }).c;
  const optOuts = (db.prepare('SELECT COUNT(*) as c FROM opt_outs').get() || { c: 0 }).c;
  const earlyVoted = (db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get() || { c: 0 }).c;

  // Response rate
  const responseRate = totalSent > 0 ? Math.round(totalReceived / totalSent * 100) : 0;
  // Contact rate (voters contacted / total voters)
  const contactRate = totalVoters > 0 ? Math.round(contacted / totalVoters * 100) : 0;

  // Top performing precincts (highest contact rate)
  const topPrecincts = db.prepare(`
    SELECT v.precinct, COUNT(DISTINCT v.id) as total,
      COUNT(DISTINCT vc.voter_id) as contacted
    FROM voters v
    LEFT JOIN voter_contacts vc ON v.id = vc.voter_id
    WHERE v.precinct != ''
    GROUP BY v.precinct
    ORDER BY (CAST(COUNT(DISTINCT vc.voter_id) AS FLOAT) / COUNT(DISTINCT v.id)) DESC
    LIMIT 5
  `).all();

  res.json({
    totalSent, totalReceived, responseRate,
    totalVoters, contacted, contactRate,
    doorsKnocked, eventsHeld, checkins,
    surveysCompleted, optOuts, earlyVoted,
    topPrecincts
  });
});

// Volunteer leaderboard
router.get('/analytics/leaderboard', (req, res) => {
  const texters = db.prepare(`
    SELECT volunteer_name as name, COUNT(*) as messages_sent
    FROM messages
    WHERE direction = 'outbound' AND volunteer_name IS NOT NULL AND volunteer_name != ''
    GROUP BY volunteer_name ORDER BY messages_sent DESC LIMIT 20
  `).all();

  const walkers = db.prepare(`
    SELECT assigned_walker as name, COUNT(*) as doors_knocked
    FROM walk_addresses
    WHERE assigned_walker IS NOT NULL AND assigned_walker != '' AND result != 'not_visited'
    GROUP BY assigned_walker ORDER BY doors_knocked DESC LIMIT 20
  `).all();

  res.json({ texters, walkers });
});

module.exports = router;
