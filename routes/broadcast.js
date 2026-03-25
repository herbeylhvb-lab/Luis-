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

  // Gather recipients
  let recipients = [];
  if (list_id) {
    let sql = `
      SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL
    `;
    const params = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      sql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      params.push(...precinct_filter);
    }
    recipients = db.prepare(sql).all(...params);
  } else {
    // All contacts with phone numbers
    const voters = db.prepare("SELECT id as voter_id, phone, first_name, last_name, city FROM voters WHERE phone != '' AND phone IS NOT NULL").all();
    const contacts = db.prepare("SELECT id, phone, first_name, last_name, city FROM contacts WHERE phone != '' AND phone IS NOT NULL").all();
    // Deduplicate by normalized phone digits
    const seen = new Set();
    for (const v of voters) { const d = phoneDigits(v.phone); if (d && !seen.has(d)) { seen.add(d); recipients.push(v); } }
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
  const validCols = ['navigation_port','port_authority','city_district','school_district','college_district','state_rep','state_senate','us_congress','county_commissioner','justice_of_peace'];

  let raceFilter = '';
  const raceParams = [];
  if (race_col && validCols.includes(race_col) && race_val) {
    raceFilter = ` AND ${race_col} = ?`;
    raceParams.push(race_val);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM voters WHERE 1=1${raceFilter}`).get(...raceParams) || { c: 0 }).c;
  const earlyVoted = (db.prepare(`SELECT COUNT(*) as c FROM voters WHERE early_voted = 1${raceFilter}`).get(...raceParams) || { c: 0 }).c;
  const notVoted = total - earlyVoted;

  const supportersNotVoted = (db.prepare(`
    SELECT COUNT(*) as c FROM voters
    WHERE early_voted != 1 AND support_level IN ('strong_support', 'lean_support', 'supporter')${raceFilter}
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
      SUM(CASE WHEN early_voted != 1 AND support_level IN ('strong_support', 'lean_support', 'supporter') THEN 1 ELSE 0 END) as supporters_remaining
    FROM voters WHERE precinct != ''${raceFilter}
    GROUP BY precinct ORDER BY supporters_remaining DESC
  `).all(...raceParams);

  const withPhone = (db.prepare(`
    SELECT COUNT(*) as c FROM voters
    WHERE early_voted != 1 AND phone != '' AND phone IS NOT NULL${raceFilter}
  `).get(...raceParams) || { c: 0 }).c;

  res.json({ total, earlyVoted, notVoted, supportersNotVoted, withPhone, bySupport, byPrecinct });
});

// GOTV Chase list — get voters who haven't voted, filtered
router.get('/gotv/chase', (req, res) => {
  const { support, precinct, has_phone, limit: lim } = req.query;
  let sql = 'SELECT id, first_name, last_name, phone, address, city, precinct, support_level, party FROM voters WHERE early_voted != 1';
  const params = [];

  if (support) {
    const levels = support.split(',');
    const supportLevels = levels.filter(l => l !== 'refused');
    const includesRefused = levels.includes('refused');

    if (supportLevels.length && includesRefused) {
      sql += ' AND (support_level IN (' + supportLevels.map(() => '?').join(',') + ') OR id IN (SELECT DISTINCT wa.voter_id FROM walk_addresses wa JOIN walk_attempts wt ON wt.address_id = wa.id WHERE wt.result = ? AND wa.voter_id IS NOT NULL))';
      params.push(...supportLevels, 'refused');
    } else if (includesRefused) {
      sql += ' AND id IN (SELECT DISTINCT wa.voter_id FROM walk_addresses wa JOIN walk_attempts wt ON wt.address_id = wa.id WHERE wt.result = ? AND wa.voter_id IS NOT NULL)';
      params.push('refused');
    } else if (supportLevels.length) {
      sql += ' AND support_level IN (' + supportLevels.map(() => '?').join(',') + ')';
      params.push(...supportLevels);
    }
  }
  if (precinct) {
    sql += ' AND precinct = ?';
    params.push(precinct);
  }
  if (has_phone === '1') {
    sql += " AND phone != '' AND phone IS NOT NULL";
  }

  sql += ' ORDER BY support_level, last_name, first_name';
  sql += ' LIMIT ?';
  params.push(parseInt(lim, 10) || 500);

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
    const supportOnly = support_levels.filter(l => l !== 'refused');
    const includesRefused = support_levels.includes('refused');
    if (supportOnly.length && includesRefused) {
      sql += ' AND (support_level IN (' + supportOnly.map(() => '?').join(',') + ') OR id IN (SELECT DISTINCT wa.voter_id FROM walk_addresses wa JOIN walk_attempts wt ON wt.address_id = wa.id WHERE wt.result = ? AND wa.voter_id IS NOT NULL))';
      params.push(...supportOnly, 'refused');
    } else if (includesRefused) {
      sql += ' AND id IN (SELECT DISTINCT wa.voter_id FROM walk_addresses wa JOIN walk_attempts wt ON wt.address_id = wa.id WHERE wt.result = ? AND wa.voter_id IS NOT NULL)';
      params.push('refused');
    } else if (supportOnly.length) {
      sql += ' AND support_level IN (' + supportOnly.map(() => '?').join(',') + ')';
      params.push(...supportOnly);
    }
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
