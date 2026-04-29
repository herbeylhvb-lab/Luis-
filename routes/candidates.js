const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { randomBytes } = require('crypto');

const candidateLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// Generate 8-char hex code for candidates (distinct from 6-char captain codes)
function generateCandidateCode() {
  return randomBytes(4).toString('hex').toUpperCase();
}

// Generate 6-char hex code for captains (same as captains.js)
function generateCaptainCode() {
  return randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

// Attach election vote history to voter objects (same pattern as captains.js)
function attachElectionVotes(voters) {
  if (!voters || voters.length === 0) return;
  const ids = voters.map(v => v.id);
  const evRows = db.prepare(
    'SELECT voter_id, election_name, election_type, party_voted, voted FROM election_votes WHERE voter_id IN (' + ids.map(() => '?').join(',') + ')'
  ).all(...ids);
  const map = {};
  for (const r of evRows) {
    if (!map[r.voter_id]) map[r.voter_id] = [];
    map[r.voter_id].push({ election_name: r.election_name, election_type: r.election_type, party_voted: r.party_voted || '', voted: r.voted });
  }
  for (const v of voters) {
    v.election_votes = map[v.id] || [];
  }
}

// Middleware: verify caller is the candidate or an admin
function requireCandidateAuth(req, res, next) {
  const candidateId = parseInt(req.params.id, 10);
  if (isNaN(candidateId)) return res.status(400).json({ error: 'Invalid candidate ID.' });
  // Admin users can access any candidate's data
  if (req.session && req.session.userId) return next();
  // Candidate portal users must match their session
  if (req.session && req.session.candidateId === candidateId) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

// Admin auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

// ===================== ADMIN ENDPOINTS =====================

// List all candidates with stats (batched queries instead of N+1)
router.get('/candidates', requireAuth, (req, res) => {
  const candidates = db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all();

  // Batch: captain counts per candidate
  const captainCounts = {};
  db.prepare('SELECT candidate_id, COUNT(*) as n FROM captains GROUP BY candidate_id').all()
    .forEach(r => { captainCounts[r.candidate_id] = r.n; });

  // Batch: admin list counts per candidate
  const listCounts = {};
  db.prepare('SELECT candidate_id, COUNT(*) as n FROM admin_lists GROUP BY candidate_id').all()
    .forEach(r => { listCounts[r.candidate_id] = r.n; });

  // Batch: captain list counts per candidate
  const captainListCounts = {};
  db.prepare(`
    SELECT cap.candidate_id, COUNT(*) as n FROM captain_lists cl
    JOIN captains cap ON cl.captain_id = cap.id
    GROUP BY cap.candidate_id
  `).all().forEach(r => { captainListCounts[r.candidate_id] = r.n; });

  // Batch: total unique voters per candidate (captain + admin lists combined)
  const voterCounts = {};
  db.prepare(`
    SELECT candidate_id, COUNT(DISTINCT voter_id) as n FROM (
      SELECT cap.candidate_id, clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id
      UNION
      SELECT al.candidate_id, alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id
    ) GROUP BY candidate_id
  `).all().forEach(r => { voterCounts[r.candidate_id] = r.n; });

  for (const c of candidates) {
    c.captain_count = captainCounts[c.id] || 0;
    c.list_count = listCounts[c.id] || 0;
    c.captain_list_count = captainListCounts[c.id] || 0;
    c.total_voters = voterCounts[c.id] || 0;
  }
  res.json({ candidates });
});

// Create candidate
router.post('/candidates', requireAuth, (req, res) => {
  const { name, office, phone, email, race_type, race_value } = req.body;
  if (!name) return res.status(400).json({ error: 'Candidate name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCandidateCode();
    if (!db.prepare('SELECT id FROM candidates WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code.' });
  }
  const result = db.prepare(
    'INSERT INTO candidates (name, office, code, phone, email, race_type, race_value) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, office || '', code, phone || '', email || '', race_type || '', race_value || '');
  // Auto-create a default "Main" list for the candidate
  db.prepare('INSERT INTO admin_lists (name, description, list_type, candidate_id) VALUES (?, ?, ?, ?)')
    .run('Main', 'Default list for ' + name, 'general', result.lastInsertRowid);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Candidate created: ' + name + ' (' + (office || 'No office') + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update candidate
router.put('/candidates/:id', requireAuth, (req, res) => {
  const { name, office, phone, email, is_active, race_type, race_value, default_list_id } = req.body;
  const setListId = default_list_id !== undefined;
  const listIdVal = !setListId ? null : (default_list_id === null || default_list_id === '' || default_list_id === 0 ? null : parseInt(default_list_id));
  const sql = `UPDATE candidates SET
    name = COALESCE(?, name),
    office = COALESCE(?, office),
    phone = COALESCE(?, phone),
    email = COALESCE(?, email),
    is_active = COALESCE(?, is_active),
    race_type = COALESCE(?, race_type),
    race_value = COALESCE(?, race_value)${setListId ? ',\n    default_list_id = ?' : ''}
    WHERE id = ?`;
  const baseArgs = [name, office, phone, email, is_active !== undefined ? (is_active ? 1 : 0) : null, race_type, race_value];
  const args = setListId ? [...baseArgs, listIdVal, req.params.id] : [...baseArgs, req.params.id];
  const result = db.prepare(sql).run(...args);
  if (result.changes === 0) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ success: true });
});

// Delete (deactivate) candidate — also deactivates their captains
router.delete('/candidates/:id', requireAuth, (req, res) => {
  const candidate = db.prepare('SELECT name FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
  const deactivate = db.transaction(() => {
    db.prepare('UPDATE candidates SET is_active = 0 WHERE id = ?').run(req.params.id);
    db.prepare('UPDATE captains SET is_active = 0 WHERE candidate_id = ?').run(req.params.id);
    db.prepare('DELETE FROM captain_candidates WHERE candidate_id = ?').run(req.params.id);
    db.prepare('UPDATE admin_lists SET candidate_id = NULL WHERE candidate_id = ?').run(req.params.id);
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Candidate deactivated: ' + candidate.name);
  });
  deactivate();
  res.json({ success: true });
});

// List captains for a candidate (admin view) — includes shared captains
router.get('/candidates/:id/captains', (req, res) => {
  const ownCaptains = db.prepare(`
    SELECT c.*, pc.name as parent_captain_name, 0 as is_shared
    FROM captains c
    LEFT JOIN captains pc ON c.parent_captain_id = pc.id
    WHERE c.candidate_id = ?
    ORDER BY c.created_at DESC
  `).all(req.params.id);
  const sharedCaptains = db.prepare(`
    SELECT c.*, pc.name as parent_captain_name, 1 as is_shared
    FROM captains c
    LEFT JOIN captains pc ON c.parent_captain_id = pc.id
    JOIN captain_candidates cc ON c.id = cc.captain_id
    WHERE cc.candidate_id = ?
    ORDER BY c.created_at DESC
  `).all(req.params.id);
  const captains = ownCaptains.concat(sharedCaptains);

  for (const c of captains) {
    c.lists = db.prepare(`
      SELECT cl.*, COUNT(clv.id) as voter_count
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      WHERE cl.captain_id = ?
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all(c.id);
    c.total_voters = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM captain_list_voters
      WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?)
    `).get(c.id) || { n: 0 }).n;
    c.voted_count = (db.prepare(`
      SELECT COUNT(DISTINCT clv.voter_id) as n
      FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN voters v ON clv.voter_id = v.id
      WHERE cl.captain_id = ? AND v.early_voted = 1
    `).get(c.id) || { n: 0 }).n;
  }

  // Aggregate totals across all captains (own + shared)
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT clv.voter_id) as total_voters,
      COUNT(DISTINCT CASE WHEN v.early_voted = 1 THEN clv.voter_id END) as total_voted
    FROM captain_list_voters clv
    JOIN captain_lists cl ON clv.list_id = cl.id
    JOIN captains c ON cl.captain_id = c.id
    JOIN voters v ON clv.voter_id = v.id
    WHERE c.candidate_id = ? OR EXISTS (
      SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
    )
  `).get(req.params.id, req.params.id) || { total_voters: 0, total_voted: 0 };

  res.json({ captains, total_voters: totals.total_voters, total_voted: totals.total_voted });
});

// Admin creates captain under a candidate
router.post('/candidates/:id/captains', (req, res) => {
  const candidate = db.prepare('SELECT id, name FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Captain name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    if (!db.prepare('SELECT id FROM captains WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code.' });
  }
  const result = db.prepare(
    'INSERT INTO captains (name, code, phone, email, candidate_id) VALUES (?, ?, ?, ?, ?)'
  ).run(name, code, phone || '', email || '', candidate.id);
  // Auto-create a default list named after the captain
  db.prepare('INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)').run(result.lastInsertRowid, name.trim(), 'general');
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Captain created for ' + candidate.name + ': ' + name);
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// List all lists for a candidate (admin + captain lists)
router.get('/candidates/:id/lists', (req, res) => {
  // Admin lists scoped to this candidate
  const adminLists = db.prepare(`
    SELECT al.id, al.name, al.description, al.list_type, al.created_at,
      COUNT(alv.id) as voter_count, 'admin' as source
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(req.params.id);

  // Captain lists through captains under this candidate
  const captainLists = db.prepare(`
    SELECT cl.id, cl.name, cl.list_type, cl.created_at,
      c.name as captain_name, c.id as captain_id,
      COUNT(clv.id) as voter_count, 'captain' as source
    FROM captain_lists cl
    JOIN captains c ON cl.captain_id = c.id
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    WHERE c.candidate_id = ?
    GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(req.params.id);

  res.json({ lists: [...adminLists, ...captainLists] });
});

// ===================== CANDIDATE PORTAL ENDPOINTS =====================

// Login with 8-char code
router.post('/candidates/login', candidateLoginLimiter, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE code = ?').get(code.trim().toUpperCase());
  if (!candidate) return res.status(404).json({ error: 'Invalid candidate code.' });
  if (!candidate.is_active) return res.status(403).json({ error: 'Your access has been disabled. Contact the admin.' });

  req.session.candidateId = candidate.id;

  // Load dashboard data — own captains + shared captains
  const ownCaptains = db.prepare(`
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id, 0 as is_shared
    FROM captains c WHERE c.candidate_id = ? ORDER BY c.name
  `).all(candidate.id);
  const sharedCaptainsLogin = db.prepare(`
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id, 1 as is_shared
    FROM captains c
    JOIN captain_candidates cc ON c.id = cc.captain_id
    WHERE cc.candidate_id = ? ORDER BY c.name
  `).all(candidate.id);
  const captains = ownCaptains.concat(sharedCaptainsLogin);

  for (const c of captains) {
    // Captain-created lists + admin-assigned lists (same as portal endpoint)
    const capLists = db.prepare(`
      SELECT cl.id, cl.name, '' as description, 'captain' as source, COUNT(clv.id) as voter_count
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      WHERE cl.captain_id = ?
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all(c.id);
    const asnLists = db.prepare(`
      SELECT al.id, al.name, al.description, 'assigned' as source, COUNT(alv.id) as voter_count
      FROM admin_lists al
      LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
      WHERE al.assigned_captain_id = ?
      GROUP BY al.id ORDER BY al.created_at DESC
    `).all(c.id);
    c.lists = capLists.concat(asnLists);
    c.total_voters = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM (
        SELECT voter_id FROM captain_list_voters WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?)
        UNION
        SELECT voter_id FROM admin_list_voters WHERE list_id IN (SELECT id FROM admin_lists WHERE assigned_captain_id = ?)
      )
    `).get(c.id, c.id) || { n: 0 }).n;
    c.voted_count = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM (
        SELECT clv.voter_id FROM captain_list_voters clv
        JOIN captain_lists cl ON clv.list_id = cl.id
        JOIN voters v ON clv.voter_id = v.id
        WHERE cl.captain_id = ? AND v.early_voted = 1
        UNION
        SELECT alv.voter_id FROM admin_list_voters alv
        JOIN admin_lists al ON alv.list_id = al.id
        JOIN voters v ON alv.voter_id = v.id
        WHERE al.assigned_captain_id = ? AND v.early_voted = 1
      )
    `).get(c.id, c.id) || { n: 0 }).n;
  }

  const lists = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(candidate.id);

  // Aggregate stats (include shared captain voters)
  const allVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    )
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;
  const totalVoted = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.early_voted = 1
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;
  const totalUndecided1 = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.support_level = 'undecided'
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;
  const stats = {
    total_captains: captains.length,
    total_voters: allVoterCount,
    total_voted: totalVoted,
    total_undecided: totalUndecided1,
    total_lists: lists.length,
    captain_lists: captains.reduce((sum, c) => sum + (c.lists || []).length, 0)
  };

  res.json({ candidate, captains, lists, stats });
});

// Portal dashboard refresh
router.get('/candidates/:id/portal', requireCandidateAuth, (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  // Own captains + shared captains
  // Get captains for this candidate + full sub-captain tree (recursive)
  // Sub-captains may have NULL candidate_id if created before inheritance was added
  const ownCapsPortal = db.prepare(`
    WITH RECURSIVE captain_tree AS (
      SELECT id FROM captains WHERE candidate_id = ?
      UNION ALL
      SELECT c.id FROM captains c JOIN captain_tree ct ON c.parent_captain_id = ct.id
    )
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id, 0 as is_shared
    FROM captains c WHERE c.id IN (SELECT id FROM captain_tree)
    ORDER BY c.name
  `).all(candidate.id);
  const sharedCapsPortal = db.prepare(`
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id, 1 as is_shared
    FROM captains c
    JOIN captain_candidates cc ON c.id = cc.captain_id
    WHERE cc.candidate_id = ? ORDER BY c.name
  `).all(candidate.id);
  const captains = ownCapsPortal.concat(sharedCapsPortal);

  // Backfill: set candidate_id on sub-captains that are missing it
  const fixOrphans = db.prepare('UPDATE captains SET candidate_id = ? WHERE id = ? AND candidate_id IS NULL');
  for (const c of captains) {
    if (!c.candidate_id) fixOrphans.run(candidate.id, c.id);
  }

  for (const c of captains) {
    // Captain-created lists + admin-assigned lists
    const captainLists = db.prepare(`
      SELECT cl.id, cl.name, '' as description, 'captain' as source, COUNT(clv.id) as voter_count
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      WHERE cl.captain_id = ?
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all(c.id);
    const assignedLists = db.prepare(`
      SELECT al.id, al.name, al.description, 'assigned' as source, COUNT(alv.id) as voter_count
      FROM admin_lists al
      LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
      WHERE al.assigned_captain_id = ?
      GROUP BY al.id ORDER BY al.created_at DESC
    `).all(c.id);
    c.lists = captainLists.concat(assignedLists);
    c.total_voters = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM (
        SELECT voter_id FROM captain_list_voters WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?)
        UNION
        SELECT voter_id FROM admin_list_voters WHERE list_id IN (SELECT id FROM admin_lists WHERE assigned_captain_id = ?)
      )
    `).get(c.id, c.id) || { n: 0 }).n;
    c.voted_count = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM (
        SELECT clv.voter_id FROM captain_list_voters clv
        JOIN captain_lists cl ON clv.list_id = cl.id
        JOIN voters v ON clv.voter_id = v.id
        WHERE cl.captain_id = ? AND v.early_voted = 1
        UNION
        SELECT alv.voter_id FROM admin_list_voters alv
        JOIN admin_lists al ON alv.list_id = al.id
        JOIN voters v ON alv.voter_id = v.id
        WHERE al.assigned_captain_id = ? AND v.early_voted = 1
      )
    `).get(c.id, c.id) || { n: 0 }).n;
  }

  let lists = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(candidate.id);

  // Auto-create a default "My Voters" list if the candidate has none
  if (lists.length === 0) {
    db.prepare('INSERT INTO admin_lists (name, description, candidate_id, list_type) VALUES (?, ?, ?, ?)').run('My Voters', 'Default voter list', candidate.id, 'general');
    lists = db.prepare(`
      SELECT al.*, COUNT(alv.id) as voter_count FROM admin_lists al
      LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
      WHERE al.candidate_id = ? GROUP BY al.id ORDER BY al.created_at DESC
    `).all(candidate.id);
  }

  // Aggregate stats for dashboard (include shared captain voters)
  const allVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    )
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;
  const totalVoted = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.early_voted = 1
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;
  const totalUndecided2 = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captain_candidates cc ON cl.captain_id = cc.captain_id WHERE cc.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.support_level = 'undecided'
  `).get(candidate.id, candidate.id, candidate.id) || { n: 0 }).n;

  const stats = {
    total_captains: captains.length,
    total_voters: allVoterCount,
    total_voted: totalVoted,
    total_undecided: totalUndecided2,
    total_lists: lists.length,
    captain_lists: captains.reduce((sum, c) => sum + (c.lists || []).length, 0)
  };

  res.json({ candidate, captains, lists, stats });
});

// Candidate creates their own captain
router.post('/candidates/:id/portal/captains', requireCandidateAuth, (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Captain name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    if (!db.prepare('SELECT id FROM captains WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code.' });
  }
  const result = db.prepare(
    'INSERT INTO captains (name, code, phone, email, candidate_id) VALUES (?, ?, ?, ?, ?)'
  ).run(name, code, phone || '', email || '', req.params.id);
  db.prepare('INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)').run(result.lastInsertRowid, name.trim(), 'general');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Candidate updates their captain
router.put('/candidates/:id/portal/captains/:captainId', requireCandidateAuth, (req, res) => {
  const captain = db.prepare('SELECT id FROM captains WHERE id = ? AND candidate_id = ?').get(req.params.captainId, req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found under this candidate.' });
  const { name, phone, email, is_active } = req.body;
  db.prepare(`UPDATE captains SET
    name = COALESCE(?, name), phone = COALESCE(?, phone),
    email = COALESCE(?, email), is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name, phone, email, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.captainId);
  res.json({ success: true });
});

// Delete a captain from the candidate portal
router.delete('/candidates/:id/portal/captains/:captainId', requireCandidateAuth, (req, res) => {
  const captain = db.prepare('SELECT id, name, parent_captain_id FROM captains WHERE id = ? AND candidate_id = ?').get(req.params.captainId, req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found under this candidate.' });
  // Check if captain is shared with other candidates — if so, just unlink from this candidate instead of hard deleting
  const shares = db.prepare('SELECT COUNT(*) as n FROM captain_candidates WHERE captain_id = ?').get(req.params.captainId);
  if (shares && shares.n > 0) {
    // Remove the sharing entry for this candidate, keep the captain's primary candidate_id intact
    db.prepare('DELETE FROM captain_candidates WHERE captain_id = ? AND candidate_id = ?').run(req.params.captainId, req.params.id);
    // If this candidate is the primary owner, reassign to first shared candidate
    const cap = db.prepare('SELECT candidate_id FROM captains WHERE id = ?').get(req.params.captainId);
    if (cap && String(cap.candidate_id) === String(req.params.id)) {
      const nextShare = db.prepare('SELECT candidate_id FROM captain_candidates WHERE captain_id = ? LIMIT 1').get(req.params.captainId);
      if (nextShare) {
        db.prepare('UPDATE captains SET candidate_id = ? WHERE id = ?').run(nextShare.candidate_id, req.params.captainId);
        db.prepare('DELETE FROM captain_candidates WHERE captain_id = ? AND candidate_id = ?').run(req.params.captainId, nextShare.candidate_id);
      } else {
        db.prepare('UPDATE captains SET candidate_id = NULL WHERE id = ?').run(req.params.captainId);
      }
    }
    return res.json({ success: true, message: 'Captain "' + captain.name + '" removed from your campaign.' });
  }
  // Re-parent sub-captains before deleting
  db.prepare('UPDATE captains SET parent_captain_id = ? WHERE parent_captain_id = ?').run(captain.parent_captain_id || null, captain.id);
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.captainId);
  res.json({ success: true, message: 'Captain "' + captain.name + '" deleted.' });
});

// Voter search — name-only q, dedicated filters, priority ordering (matches captain search)
router.get('/candidates/:id/search', requireCandidateAuth, (req, res) => {
  const { q, phone, vanid, city, zip, precinct, address, party, support } = req.query;
  const hasFilter = phone || vanid || city || zip || precinct || address || party || support;
  if ((!q || q.trim().length < 2) && !hasFilter) return res.json({ voters: [] });

  const conditions = [];
  const params = [];

  // Name search: each word must match first, middle, OR last name.
  // Middle-name matching was missing — searching "John Michael Smith"
  // failed because "Michael" wasn't checked against middle_name.
  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      const term = '%' + escaped + '%';
      conditions.push("(first_name LIKE ? ESCAPE '\\' OR middle_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\')");
      params.push(term, term, term);
    }
  }

  // Dedicated filters
  if (phone) {
    const phoneEsc = phone.replace(/[\\%_]/g, '\\$&');
    conditions.push("phone LIKE ? ESCAPE '\\'"); params.push('%' + phoneEsc + '%');
  }
  if (vanid) {
    const vanidEsc = vanid.replace(/[\\%_]/g, '\\$&');
    conditions.push("(vanid LIKE ? ESCAPE '\\' OR registration_number LIKE ? ESCAPE '\\' OR county_file_id LIKE ? ESCAPE '\\' OR state_file_id LIKE ? ESCAPE '\\')");
    params.push('%' + vanidEsc + '%', '%' + vanidEsc + '%', '%' + vanidEsc + '%', '%' + vanidEsc + '%');
  }
  if (city) {
    const cityEsc = city.replace(/[\\%_]/g, '\\$&');
    conditions.push("city LIKE ? ESCAPE '\\'"); params.push('%' + cityEsc + '%');
  }
  if (zip) {
    const zipEsc = zip.replace(/[\\%_]/g, '\\$&');
    conditions.push("zip LIKE ? ESCAPE '\\'"); params.push(zipEsc + '%');
  }
  if (precinct) {
    const precEsc = precinct.replace(/[\\%_]/g, '\\$&');
    conditions.push("precinct LIKE ? ESCAPE '\\'"); params.push('%' + precEsc + '%');
  }
  if (address) {
    const addrEsc = address.replace(/[\\%_]/g, '\\$&');
    conditions.push("address LIKE ? ESCAPE '\\'"); params.push('%' + addrEsc + '%');
  }
  if (party) {
    conditions.push("party = ?"); params.push(party);
  }
  if (support) {
    conditions.push("support_level = ?"); params.push(support);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  // Priority ordering: exact last_name=3, starts-with=2, first_name match=1
  let orderClause = 'last_name, first_name';
  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    const orderCases = [];
    const orderParams = [];
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      orderCases.push("CASE WHEN last_name = ? THEN 3 WHEN last_name LIKE ? ESCAPE '\\' THEN 2 WHEN first_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END");
      orderParams.push(w, escaped + '%', escaped + '%');
    }
    const priorityExpr = orderCases.join(' + ');
    orderClause = '(' + priorityExpr + ') DESC, last_name, first_name';
    params.push(...orderParams);
  }

  const voters = db.prepare(`SELECT * FROM voters WHERE ${whereClause} ORDER BY ${orderClause} LIMIT 50`).all(...params);
  attachElectionVotes(voters);
  res.json({ voters });
});

// Household lookup
router.get('/candidates/:id/household', requireCandidateAuth, (req, res) => {
  const { voter_id } = req.query;
  if (!voter_id) return res.json({ household: [] });
  const voter = db.prepare('SELECT address, unit, zip, city FROM voters WHERE id = ?').get(voter_id);
  if (!voter || !voter.address) return res.json({ household: [] });

  // Match by address + unit — only people in the SAME apartment/unit
  const voterUnit = (voter.unit || '').trim().toLowerCase();

  let candidates;
  if (voter.zip) {
    candidates = db.prepare(`
      SELECT * FROM voters
      WHERE LOWER(TRIM(address)) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(TRIM(?))
        AND (zip = ? OR zip LIKE ?)
        AND id != ?
      ORDER BY last_name, first_name LIMIT 50
    `).all(voter.address, voterUnit, voter.zip, voter.zip.replace(/-\d+$/, '') + '%', voter_id);
  } else {
    candidates = db.prepare(`
      SELECT * FROM voters
      WHERE LOWER(TRIM(address)) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(city,''))) = LOWER(TRIM(?))
        AND id != ?
      ORDER BY last_name, first_name LIMIT 50
    `).all(voter.address, voterUnit, voter.city || '', voter_id);
  }

  const seen = new Set();
  const household = candidates.filter(c => {
    const key = (c.registration_number || c.id).toString().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json({ household });
});

// ===================== CANDIDATE LIST MANAGEMENT =====================

// Create admin list scoped to candidate
router.post('/candidates/:id/lists', requireCandidateAuth, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });
  const result = db.prepare('INSERT INTO admin_lists (name, description, candidate_id, list_type) VALUES (?, ?, ?, ?)').run(name, description || '', req.params.id, 'general');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get voters on a candidate's list
router.get('/candidates/:id/lists/:listId/voters', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  // alv.notes is the per-list note attached to this voter for this list.
  // Aliased as `list_notes` so it doesn't collide with voters.notes (the
  // global voter-level note column) — UIs can show both side by side.
  const voters = db.prepare(`
    SELECT v.*, alv.added_at, alv.parent_voter_id,
      alv.notes AS list_notes,
      (SELECT ev.party_voted FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_party,
      (SELECT ev.vote_method FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_method
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ORDER BY alv.parent_voter_id NULLS FIRST, v.last_name, v.first_name
  `).all(req.params.listId);
  attachElectionVotes(voters);
  res.json({ list, voters });
});

// Update per-list note for a voter.  Mirrors the captain-side
// /captains/:id/lists/:listId/voters/:voterId/notes endpoint exactly so
// the candidate portal can adopt the same UX with no surprises.
router.put('/candidates/:id/lists/:listId/voters/:voterId/notes', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const notes = (req.body && typeof req.body.notes === 'string') ? req.body.notes.slice(0, 4000) : '';
  const r = db.prepare(
    'UPDATE admin_list_voters SET notes = ? WHERE list_id = ? AND voter_id = ?'
  ).run(notes, req.params.listId, req.params.voterId);
  if (r.changes === 0) return res.status(404).json({ error: 'Voter not on this list.' });
  res.json({ success: true });
});

// Add voters to a candidate's list
router.post('/candidates/:id/lists/:listId/voters', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { voterIds } = req.body;
  if (!voterIds || !voterIds.length) return res.status(400).json({ error: 'No voters provided.' });
  const validIds = voterIds.filter(id => Number.isInteger(id) && id > 0);
  if (validIds.length !== voterIds.length) return res.status(400).json({ error: 'Invalid voter IDs.' });
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0;
  for (const vid of validIds) {
    const r = insert.run(req.params.listId, vid);
    added += r.changes;
  }
  res.json({ success: true, added });
});

// Bulk upload voters to a candidate's list by identifier
router.post('/candidates/:id/lists/:listId/bulk-upload', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { identifiers } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0, duplicates = 0, notFound = [];
  const tx = db.transaction(() => {
    for (const ident of identifiers) {
      const voter = lookup.get(ident, ident, ident);
      if (!voter) { notFound.push(ident); continue; }
      const r = insert.run(req.params.listId, voter.id);
      if (r.changes) added++; else duplicates++;
    }
  });
  tx();
  res.json({ added, duplicates, notFound, total: identifiers.length });
});

// Bulk add voters by ID and nest under a parent voter
router.post('/candidates/:id/lists/:listId/bulk-add-under', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { identifiers, parent_voter_id } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const listId = req.params.listId;
  const parentOnList = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, parent_voter_id);
  if (!parentOnList) return res.status(400).json({ error: 'Parent voter not on this list.' });
  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id, parent_voter_id) VALUES (?, ?, ?)');
  const setParent = db.prepare('UPDATE admin_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?');
  let added = 0, duplicates = 0, nested = 0, notFound = [];
  const tx = db.transaction(() => {
    for (const ident of identifiers) {
      const trimmed = String(ident).trim();
      if (!trimmed) continue;
      const voter = lookup.get(trimmed, trimmed, trimmed);
      if (!voter) { notFound.push(trimmed); continue; }
      const r = insert.run(listId, voter.id, parent_voter_id);
      if (r.changes) { added++; nested++; }
      else { setParent.run(parent_voter_id, listId, voter.id); duplicates++; nested++; }
    }
  });
  tx();
  res.json({ added, duplicates, nested, notFound, total: identifiers.length });
});

// Remove voter from a candidate's list
router.delete('/candidates/:id/lists/:listId/voters/:voterId', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// Bulk-remove voters from a list (admin OR captain list under this candidate),
// gated by the same shared admin password used for phone-edit unlocks.
// Voter records remain in the voter file; only list memberships are dropped.
router.post('/candidates/:id/lists/:listId/bulk-remove-with-password', requireCandidateAuth, (req, res) => {
  const { voterIds, adminPassword } = req.body || {};
  const listId = parseInt(req.params.listId, 10);
  const candidateId = parseInt(req.params.id, 10);
  if (!listId || !Array.isArray(voterIds) || voterIds.length === 0 || !adminPassword) {
    return res.status(400).json({ error: 'voterIds[], adminPassword required' });
  }
  // Same shared password as captain phone-edit and bulk-remove flows.
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'phone_update_password'").get();
  const current = setting && setting.value ? setting.value : '';
  if (!current || current === 'CHANGE_ME') {
    return res.status(503).json({ error: 'Admin password not set yet — set it under HQ admin settings.' });
  }
  if (String(adminPassword) !== current) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }

  // Figure out which table the list lives in. Right-panel can show either an
  // admin_list owned by this candidate OR a captain_list whose captain is
  // owned by / shared with this candidate.
  let tableName = null;
  const adminList = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(listId, candidateId);
  if (adminList) {
    tableName = 'admin_list_voters';
  } else {
    const captainList = db.prepare(`
      SELECT cl.id FROM captain_lists cl
      JOIN captains c ON cl.captain_id = c.id
      WHERE cl.id = ?
        AND (c.candidate_id = ? OR EXISTS (
          SELECT 1 FROM captain_candidates cc
          WHERE cc.captain_id = c.id AND cc.candidate_id = ?
        ))
    `).get(listId, candidateId, candidateId);
    if (captainList) tableName = 'captain_list_voters';
  }
  if (!tableName) {
    // Admin session bypasses ownership for either table — last-resort fallback.
    if (req.session.userId) {
      const anyAdmin = db.prepare('SELECT id FROM admin_lists WHERE id = ?').get(listId);
      if (anyAdmin) tableName = 'admin_list_voters';
      else {
        const anyCaptain = db.prepare('SELECT id FROM captain_lists WHERE id = ?').get(listId);
        if (anyCaptain) tableName = 'captain_list_voters';
      }
    }
  }
  if (!tableName) return res.status(404).json({ error: 'List not found in your campaign' });

  const remove = db.prepare(`DELETE FROM ${tableName} WHERE list_id = ? AND voter_id = ?`);
  let removed = 0;
  const tx = db.transaction(() => {
    for (const id of voterIds) {
      const vid = parseInt(id, 10);
      if (!vid) continue;
      const r = remove.run(listId, vid);
      if (r.changes) removed++;
    }
  });
  tx();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Candidate ' + (req.session.candidateId || req.session.userId || '?') +
    ' bulk-removed ' + removed + ' voter(s) from ' + tableName + ' list ' + listId
  );
  res.json({ success: true, removed, table: tableName });
});

// View voters on a captain's list (read-only for candidate)
router.get('/candidates/:id/captain-lists/:listId/voters', requireCandidateAuth, (req, res) => {
  const listId = req.params.listId;
  const candidateId = req.params.id;
  // Try captain_lists first (owned or shared captains)
  let list = db.prepare(`
    SELECT cl.*, c.name as captain_name, 'captain' as source FROM captain_lists cl
    JOIN captains c ON cl.captain_id = c.id
    WHERE cl.id = ? AND (c.candidate_id = ? OR EXISTS (
      SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
    ))
  `).get(listId, candidateId, candidateId);
  let voters;
  if (list) {
    voters = db.prepare(`
      SELECT v.*, clv.added_at, clv.parent_voter_id FROM captain_list_voters clv
      JOIN voters v ON clv.voter_id = v.id
      WHERE clv.list_id = ? ORDER BY clv.parent_voter_id NULLS FIRST, clv.added_at DESC
    `).all(listId);
  } else {
    // Try admin_lists (assigned to a captain under this candidate)
    list = db.prepare(`
      SELECT al.*, c.name as captain_name, 'assigned' as source FROM admin_lists al
      JOIN captains c ON al.assigned_captain_id = c.id
      WHERE al.id = ? AND (al.candidate_id = ? OR c.candidate_id = ?)
    `).get(listId, candidateId, candidateId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    voters = db.prepare(`
      SELECT v.*, alv.added_at, alv.parent_voter_id FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? ORDER BY alv.parent_voter_id NULLS FIRST, alv.added_at DESC
    `).all(listId);
  }
  attachElectionVotes(voters);
  res.json({ list, voters });
});

// Get ALL voters under a captain + their sub-captains (full tree)
router.get('/candidates/:id/captains/:captainId/all-voters', requireCandidateAuth, (req, res) => {
  const captainId = parseInt(req.params.captainId, 10);
  const captain = db.prepare('SELECT id, name, parent_captain_id FROM captains WHERE id = ?').get(captainId);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });

  // Collect all captain IDs in the tree (this captain + all sub-captains recursively)
  const allCaptains = db.prepare('SELECT id, name, parent_captain_id FROM captains WHERE candidate_id = (SELECT candidate_id FROM captains WHERE id = ?)').all(captainId);
  const captainIds = [captainId];
  const captainNameMap = {};
  captainNameMap[captainId] = captain.name;
  // BFS to find all descendants
  let queue = [captainId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const c of allCaptains) {
      if (c.parent_captain_id === parentId && !captainIds.includes(c.id)) {
        captainIds.push(c.id);
        captainNameMap[c.id] = c.name;
        queue.push(c.id);
      }
    }
  }

  // Get all voters from all lists belonging to these captains
  const ph = captainIds.map(() => '?').join(',');
  const voters = db.prepare(`
    SELECT v.*, clv.parent_voter_id, c.name as captain_name, c.id as captain_id
    FROM captain_list_voters clv
    JOIN captain_lists cl ON clv.list_id = cl.id
    JOIN captains c ON cl.captain_id = c.id
    JOIN voters v ON clv.voter_id = v.id
    WHERE c.id IN (${ph})
    ORDER BY c.name, clv.parent_voter_id NULLS FIRST, v.last_name, v.first_name
  `).all(...captainIds);

  res.json({ captain: captain.name, sub_captains: captainIds.map(id => captainNameMap[id]), voters, total: voters.length });
});

// Set/remove parent voter grouping on any list type
router.put('/candidates/:id/lists/:listId/voters/:voterId/parent', requireCandidateAuth, (req, res) => {
  const { parent_voter_id, list_type } = req.body;
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const table = list_type === 'captain' ? 'captain_list_voters' : 'admin_list_voters';
  const child = db.prepare('SELECT id FROM ' + table + ' WHERE list_id = ? AND voter_id = ?').get(req.params.listId, req.params.voterId);
  const parent = db.prepare('SELECT id, parent_voter_id FROM ' + table + ' WHERE list_id = ? AND voter_id = ?').get(req.params.listId, parent_voter_id);
  if (!child || !parent) return res.status(404).json({ error: 'Both voters must be on this list.' });
  if (parent.parent_voter_id) return res.status(400).json({ error: 'Cannot nest under a sub-member.' });
  db.prepare('UPDATE ' + table + ' SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?').run(parent_voter_id, req.params.listId, req.params.voterId);
  res.json({ success: true });
});

router.delete('/candidates/:id/lists/:listId/voters/:voterId/parent', requireCandidateAuth, (req, res) => {
  const list_type = req.query.list_type || 'admin';
  const table = list_type === 'captain' ? 'captain_list_voters' : 'admin_list_voters';
  db.prepare('UPDATE ' + table + ' SET parent_voter_id = NULL WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// Master list: all unique voters across ALL lists with source info
router.get('/candidates/:id/master-list', requireCandidateAuth, (req, res) => {
  const candidateIdParam = req.params.id;
  // Default high enough to cover most candidates' full voter pool in one
  // request. Cap at 100k to protect the server from a runaway query.
  // Smaller campaigns can still request a smaller page via ?limit=.
  const limit = Math.min(parseInt(req.query.limit) || 100000, 100000);
  const offset = parseInt(req.query.offset) || 0;

  // Step 1: Get unique voter IDs with proper pagination
  const allVoterIds = db.prepare(`
    SELECT DISTINCT voter_id FROM (
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
      UNION
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains c ON cl.captain_id = c.id
      WHERE c.candidate_id = ? OR EXISTS (
        SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
      )
    )
  `).all(candidateIdParam, candidateIdParam, candidateIdParam);
  const totalUniqueVoters = allVoterIds.length;

  // Step 2: Get paginated voters with their info
  const voterRows = db.prepare(`
    SELECT v.* FROM voters v WHERE v.id IN (
      SELECT DISTINCT voter_id FROM (
        SELECT alv.voter_id FROM admin_list_voters alv
        JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
        UNION
        SELECT clv.voter_id FROM captain_list_voters clv
        JOIN captain_lists cl ON clv.list_id = cl.id
        JOIN captains c ON cl.captain_id = c.id
        WHERE c.candidate_id = ? OR EXISTS (
          SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
        )
      )
    )
    ORDER BY v.last_name, v.first_name
    LIMIT ? OFFSET ?
  `).all(candidateIdParam, candidateIdParam, candidateIdParam, limit, offset);

  // Step 3: Get source info for these voters
  const voterIdSet = new Set(voterRows.map(v => v.id));
  const sourceRows = voterIdSet.size > 0 ? db.prepare(`
    SELECT voter_id, source_name, source_type, list_name, added_at, parent_voter_id FROM (
      SELECT alv.voter_id, 'My List' as source_name, 'admin' as source_type,
             al.name as list_name, alv.added_at, alv.parent_voter_id
      FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
      UNION ALL
      SELECT clv.voter_id, c.name as source_name, 'captain' as source_type,
             cl.name as list_name, clv.added_at, clv.parent_voter_id
      FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains c ON cl.captain_id = c.id
      WHERE c.candidate_id = ? OR EXISTS (
        SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
      )
    ) WHERE voter_id IN (${voterRows.map(() => '?').join(',')})
  `).all(candidateIdParam, candidateIdParam, candidateIdParam, ...voterRows.map(v => v.id)) : [];

  // Build voter map with lists
  const voterMap = new Map();
  for (const v of voterRows) {
    voterMap.set(v.id, {
      id: v.id, first_name: v.first_name, last_name: v.last_name,
      middle_name: v.middle_name, suffix: v.suffix,
      address: v.address, city: v.city, zip: v.zip,
      phone: v.phone, party: v.party, party_score: v.party_score,
      precinct: v.precinct, state_file_id: v.state_file_id, vanid: v.vanid,
      early_voted: v.early_voted, early_voted_date: v.early_voted_date,
      lists: []
    });
  }
  for (const s of sourceRows) {
    if (voterMap.has(s.voter_id)) {
      const v = voterMap.get(s.voter_id);
      v.lists.push({
        source_name: s.source_name, source_type: s.source_type,
        list_name: s.list_name, added_at: s.added_at,
        parent_voter_id: s.parent_voter_id || null
      });
      // Track parent relationship (first one found wins)
      if (s.parent_voter_id && !v.parent_voter_id) {
        v.parent_voter_id = s.parent_voter_id;
      }
    }
  }

  const voters = Array.from(voterMap.values());
  attachElectionVotes(voters);
  const uniqueVoters = voters.length;
  const overlaps = voters.filter(v => v.lists.length > 1).length;

  res.json({ voters, totalUniqueVoters, uniqueVoters, overlaps });
});

// Assign a candidate's list to one of their captains
router.post('/candidates/:id/lists/:listId/assign', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { captain_id } = req.body;
  if (!captain_id) {
    db.prepare('UPDATE admin_lists SET assigned_captain_id = NULL WHERE id = ?').run(req.params.listId);
    return res.json({ success: true });
  }
  // Verify captain belongs to this candidate (own or shared)
  const captain = db.prepare(`SELECT c.id, c.name FROM captains c WHERE c.id = ? AND (c.candidate_id = ? OR EXISTS (
    SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
  ))`).get(captain_id, req.params.id, req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found under this candidate.' });
  db.prepare('UPDATE admin_lists SET assigned_captain_id = ? WHERE id = ?').run(captain_id, req.params.listId);
  res.json({ success: true, captain_name: captain.name });
});

// ===================== WALKERS (per-candidate, persistent identity) =====================

const walkerLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// List walkers for a candidate (with aggregated stats)
router.get('/candidates/:id/walkers', (req, res) => {
  const walkers = db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM walk_attempts wa WHERE wa.walker_id = w.id) as total_doors,
      (SELECT COALESCE(SUM(CASE WHEN wa.result NOT IN ('not_home','moved','deceased','refused','come_back') THEN 1 ELSE 0 END),0) FROM walk_attempts wa WHERE wa.walker_id = w.id) as total_contacts,
      (SELECT COUNT(DISTINCT wa.walk_id) FROM walk_attempts wa WHERE wa.walker_id = w.id) as walks_participated,
      (SELECT MAX(wa.attempted_at) FROM walk_attempts wa WHERE wa.walker_id = w.id) as last_active
    FROM walkers w WHERE w.candidate_id = ? ORDER BY w.created_at DESC
  `).all(req.params.id);
  res.json({ walkers });
});

// Create walker for a candidate
router.post('/candidates/:id/walkers', (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Walker name is required.' });
  const candidate = db.prepare('SELECT id, name FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    if (!db.prepare('SELECT id FROM walkers WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code. Try again.' });
  }

  const result = db.prepare('INSERT INTO walkers (candidate_id, name, phone, code) VALUES (?, ?, ?, ?)').run(req.params.id, name.trim(), phone || null, code);
  // Sync to unified volunteers table
  db.prepare('INSERT OR IGNORE INTO volunteers (name, phone, code, can_text, can_walk) VALUES (?, ?, ?, 0, 1)').run(name.trim(), phone || null, code);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Walker created for ' + candidate.name + ': ' + name.trim() + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update walker
router.put('/walkers/:id', (req, res) => {
  const { name, phone, is_active } = req.body;
  const result = db.prepare(`UPDATE walkers SET
    name = COALESCE(?, name),
    phone = COALESCE(?, phone),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name || null, phone !== undefined ? phone : null, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Walker not found.' });
  res.json({ success: true });
});

// Delete walker
router.delete('/walkers/:id', (req, res) => {
  const walker = db.prepare('SELECT name FROM walkers WHERE id = ?').get(req.params.id);
  if (!walker) return res.status(404).json({ error: 'Walker not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM walk_group_members WHERE walker_id = ?').run(req.params.id);
    db.prepare('DELETE FROM walker_locations WHERE walker_name = ?').run(walker.name);
    db.prepare('DELETE FROM walkers WHERE id = ?').run(req.params.id);
  })();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Walker deleted: ' + walker.name);
  res.json({ success: true });
});

// Walker login (public — code-based)
router.post('/walkers/login', walkerLoginLimiter, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const walker = db.prepare(`
    SELECT w.*, c.name as candidate_name, c.office as candidate_office
    FROM walkers w JOIN candidates c ON w.candidate_id = c.id
    WHERE w.code = ?
  `).get(code.trim().toUpperCase());
  if (!walker) return res.status(404).json({ error: 'Invalid walker code.' });
  if (!walker.is_active) return res.status(403).json({ error: 'This walker has been deactivated. Contact the campaign admin.' });
  res.json({ success: true, walker: { id: walker.id, name: walker.name, candidate_id: walker.candidate_id, candidate_name: walker.candidate_name, candidate_office: walker.candidate_office, code: walker.code } });
});

// Walker dashboard (stats + leaderboard + assigned walks)
router.get('/walkers/:id/dashboard', (req, res) => {
  const walker = db.prepare(`
    SELECT w.*, c.name as candidate_name, c.office as candidate_office
    FROM walkers w LEFT JOIN candidates c ON w.candidate_id = c.id
    WHERE w.id = ?
  `).get(req.params.id);
  if (!walker) return res.status(404).json({ error: 'Walker not found.' });

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_doors,
      COALESCE(SUM(CASE WHEN result NOT IN ('not_home','moved','deceased','refused','come_back') THEN 1 ELSE 0 END),0) as total_contacts,
      COALESCE(SUM(CASE WHEN result IN ('support','lean_support') THEN 1 ELSE 0 END),0) as supporters_found,
      COUNT(DISTINCT walk_id) as walks_participated
    FROM walk_attempts WHERE walker_id = ?
  `).get(walker.id);
  stats.contact_rate = stats.total_doors > 0 ? Math.round(stats.total_contacts / stats.total_doors * 100) : 0;

  const leaderboard = db.prepare(`
    SELECT w.id, w.name,
      COUNT(wa.id) as total_doors,
      COALESCE(SUM(CASE WHEN wa.result NOT IN ('not_home','moved','deceased','refused','come_back') THEN 1 ELSE 0 END),0) as total_contacts,
      COUNT(DISTINCT wa.walk_id) as walks_participated
    FROM walkers w
    LEFT JOIN walk_attempts wa ON wa.walker_id = w.id
    WHERE w.candidate_id = ? AND w.is_active = 1
    GROUP BY w.id
    ORDER BY total_doors DESC
  `).all(walker.candidate_id);

  // Auto-assign walker to active walks for their candidate
  // If walker has no candidate_id, assign to ALL active walks (backward compat)
  const unassignedSql = walker.candidate_id
    ? `SELECT bw.id FROM block_walks bw
       WHERE bw.status != 'completed'
         AND (bw.candidate_id IS NULL OR bw.candidate_id = ?)
         AND bw.id NOT IN (SELECT walk_id FROM walk_group_members WHERE walker_id = ?)`
    : `SELECT bw.id FROM block_walks bw
       WHERE bw.status != 'completed'
         AND bw.id NOT IN (SELECT walk_id FROM walk_group_members WHERE walker_id = ?)`;
  const unassigned = walker.candidate_id
    ? db.prepare(unassignedSql).all(walker.candidate_id, walker.id)
    : db.prepare(unassignedSql).all(walker.id);
  if (unassigned.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name, walker_id, phone) VALUES (?, ?, ?, ?)');
    for (const w of unassigned) {
      ins.run(w.id, walker.name, walker.id, walker.phone || '');
    }
  }

  const walks = db.prepare(`
    SELECT bw.id, bw.name, bw.description, bw.status, bw.join_code,
      (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = bw.id) as total_addresses,
      (SELECT COUNT(DISTINCT LOWER(address) || '||' || LOWER(COALESCE(unit, ''))) FROM walk_addresses WHERE walk_id = bw.id AND result != 'not_visited') as completed_addresses,
      (SELECT COUNT(*) FROM walk_attempts WHERE walk_id = bw.id AND walker_id = ?) as my_doors
    FROM block_walks bw
    JOIN walk_group_members wgm ON wgm.walk_id = bw.id AND wgm.walker_id = ?
    WHERE bw.status != 'completed'
    ORDER BY bw.created_at DESC
  `).all(walker.id, walker.id);

  res.json({ walker, stats, leaderboard, walks });
});

// Transfer voters between any of the candidate's lists. Two list namespaces
// exist — admin_lists (candidate's own, voters in admin_list_voters) and
// captain_lists (captain-owned, voters in captain_list_voters). The client
// MUST specify sourceListType + targetListType so we mutate the correct
// table. Backward compat: missing types default to 'captain' (the original
// behavior). All 4 source/target combinations are handled.
router.post('/candidates/:id/transfer-voters', requireCandidateAuth, (req, res) => {
  const candidateId = parseInt(req.params.id, 10);
  const {
    voterIds,
    targetListId,
    sourceListId,
    removeFromSource,
    sourceListType, // 'admin' | 'captain' (default 'captain')
    targetListType, // 'admin' | 'captain' (default 'captain')
  } = req.body;

  if (!voterIds || !Array.isArray(voterIds) || voterIds.length === 0) {
    return res.status(400).json({ error: 'voterIds array is required.' });
  }
  const validIds = voterIds.filter(id => Number.isInteger(id) && id > 0);
  if (validIds.length !== voterIds.length) return res.status(400).json({ error: 'Invalid voter IDs.' });
  if (!targetListId) return res.status(400).json({ error: 'targetListId is required.' });
  if (!sourceListId) return res.status(400).json({ error: 'sourceListId is required.' });

  const srcType = sourceListType || 'captain';
  const tgtType = targetListType || 'captain';
  if (srcType !== 'admin' && srcType !== 'captain') return res.status(400).json({ error: 'Invalid sourceListType.' });
  if (tgtType !== 'admin' && tgtType !== 'captain') return res.status(400).json({ error: 'Invalid targetListType.' });

  // Validate ownership for each list type. Admin lists must belong to this
  // candidate directly. Captain lists must belong to a captain under this
  // candidate (owned via captains.candidate_id OR shared via captain_candidates).
  function ownsAdminList(listId) {
    return !!db.prepare('SELECT 1 FROM admin_lists WHERE id = ? AND candidate_id = ?').get(listId, candidateId);
  }
  function ownsCaptainList(listId) {
    return !!db.prepare(`
      SELECT 1 FROM captain_lists cl
      JOIN captains c ON cl.captain_id = c.id
      WHERE cl.id = ? AND (c.candidate_id = ? OR EXISTS (
        SELECT 1 FROM captain_candidates cc WHERE cc.captain_id = c.id AND cc.candidate_id = ?
      ))
    `).get(listId, candidateId, candidateId);
  }

  const sourceOk = (srcType === 'admin') ? ownsAdminList(sourceListId) : ownsCaptainList(sourceListId);
  if (!sourceOk) return res.status(404).json({ error: 'Source list not found or not under this candidate.' });
  const targetOk = (tgtType === 'admin') ? ownsAdminList(targetListId) : ownsCaptainList(targetListId);
  if (!targetOk) return res.status(404).json({ error: 'Target list not found or not under this candidate.' });

  // Pick the right INSERT and DELETE per type.
  const insertSql = (tgtType === 'admin')
    ? 'INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)'
    : 'INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)';
  const deleteSql = (srcType === 'admin')
    ? 'DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?'
    : 'DELETE FROM captain_list_voters WHERE list_id = ? AND voter_id = ?';

  const doTransfer = db.transaction(() => {
    const insert = db.prepare(insertSql);
    let transferred = 0;
    for (const voterId of validIds) {
      const r = insert.run(targetListId, voterId);
      transferred += r.changes;
    }

    let removed = 0;
    if (removeFromSource) {
      const del = db.prepare(deleteSql);
      for (const voterId of validIds) {
        const r = del.run(sourceListId, voterId);
        removed += r.changes;
      }
    }

    return { transferred, removed };
  });

  try {
    const { transferred, removed } = doTransfer();
    res.json({ success: true, transferred, removed, removeFromSource: !!removeFromSource });
  } catch (e) {
    console.error('Voter transfer error:', e.message);
    res.status(500).json({ error: 'Failed to transfer voters.' });
  }
});

module.exports = router;
