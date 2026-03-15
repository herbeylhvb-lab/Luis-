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

// ===================== ADMIN ENDPOINTS =====================

// List all candidates with stats (batched queries instead of N+1)
router.get('/candidates', (req, res) => {
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
router.post('/candidates', (req, res) => {
  const { name, office, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Candidate name is required.' });
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCandidateCode();
    if (!db.prepare('SELECT id FROM candidates WHERE code = ?').get(code)) break;
    if (i === 9) return res.status(500).json({ error: 'Could not generate unique code.' });
  }
  const result = db.prepare(
    'INSERT INTO candidates (name, office, code, phone, email) VALUES (?, ?, ?, ?, ?)'
  ).run(name, office || '', code, phone || '', email || '');
  // Auto-create a default "Main" list for the candidate
  db.prepare('INSERT INTO admin_lists (name, description, list_type, candidate_id) VALUES (?, ?, ?, ?)')
    .run('Main', 'Default list for ' + name, 'general', result.lastInsertRowid);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Candidate created: ' + name + ' (' + (office || 'No office') + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update candidate
router.put('/candidates/:id', (req, res) => {
  const { name, office, phone, email, is_active } = req.body;
  const result = db.prepare(`UPDATE candidates SET
    name = COALESCE(?, name),
    office = COALESCE(?, office),
    phone = COALESCE(?, phone),
    email = COALESCE(?, email),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name, office, phone, email, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ success: true });
});

// Delete (deactivate) candidate — also deactivates their captains
router.delete('/candidates/:id', (req, res) => {
  const candidate = db.prepare('SELECT name FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
  db.prepare('UPDATE candidates SET is_active = 0 WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE captains SET is_active = 0 WHERE candidate_id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Candidate deactivated: ' + candidate.name);
  res.json({ success: true });
});

// List captains for a candidate (admin view)
router.get('/candidates/:id/captains', (req, res) => {
  const captains = db.prepare(`
    SELECT c.*, pc.name as parent_captain_name
    FROM captains c
    LEFT JOIN captains pc ON c.parent_captain_id = pc.id
    WHERE c.candidate_id = ?
    ORDER BY c.created_at DESC
  `).all(req.params.id);

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

  // Aggregate totals across all captains
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT clv.voter_id) as total_voters,
      COUNT(DISTINCT CASE WHEN v.early_voted = 1 THEN clv.voter_id END) as total_voted
    FROM captain_list_voters clv
    JOIN captain_lists cl ON clv.list_id = cl.id
    JOIN captains c ON cl.captain_id = c.id
    JOIN voters v ON clv.voter_id = v.id
    WHERE c.candidate_id = ?
  `).get(req.params.id) || { total_voters: 0, total_voted: 0 };

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

  // Load dashboard data
  const captains = db.prepare(`
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id
    FROM captains c WHERE c.candidate_id = ? ORDER BY c.name
  `).all(candidate.id);

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
      SELECT COUNT(DISTINCT clv.voter_id) as n FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN voters v ON clv.voter_id = v.id
      WHERE cl.captain_id = ? AND v.early_voted = 1
    `).get(c.id) || { n: 0 }).n;
  }

  const lists = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(candidate.id);

  // Aggregate stats
  const allVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    )
  `).get(candidate.id, candidate.id) || { n: 0 }).n;
  const totalVoted = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.early_voted = 1
  `).get(candidate.id, candidate.id) || { n: 0 }).n;
  const stats = {
    total_captains: captains.length,
    total_voters: allVoterCount,
    total_voted: totalVoted,
    total_lists: lists.length,
    captain_lists: captains.reduce((sum, c) => sum + (c.lists || []).length, 0)
  };

  res.json({ candidate, captains, lists, stats });
});

// Portal dashboard refresh
router.get('/candidates/:id/portal', requireCandidateAuth, (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  const captains = db.prepare(`
    SELECT c.id, c.name, c.code, c.phone, c.email, c.is_active, c.created_at, c.parent_captain_id
    FROM captains c WHERE c.candidate_id = ? ORDER BY c.name
  `).all(candidate.id);

  for (const c of captains) {
    c.lists = db.prepare(`
      SELECT cl.*, COUNT(clv.id) as voter_count
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      WHERE cl.captain_id = ?
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all(c.id);
    // Total unique voters across all captain's lists
    c.total_voters = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM captain_list_voters
      WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?)
    `).get(c.id) || { n: 0 }).n;
    c.voted_count = (db.prepare(`
      SELECT COUNT(DISTINCT clv.voter_id) as n FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN voters v ON clv.voter_id = v.id
      WHERE cl.captain_id = ? AND v.early_voted = 1
    `).get(c.id) || { n: 0 }).n;
  }

  const lists = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(candidate.id);

  // Aggregate stats for dashboard
  const allVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    )
  `).get(candidate.id, candidate.id) || { n: 0 }).n;
  const totalVoted = (db.prepare(`
    SELECT COUNT(DISTINCT sub.voter_id) as n FROM (
      SELECT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
      UNION
      SELECT alv.voter_id FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
    ) sub
    JOIN voters v ON sub.voter_id = v.id
    WHERE v.early_voted = 1
  `).get(candidate.id, candidate.id) || { n: 0 }).n;

  const stats = {
    total_captains: captains.length,
    total_voters: allVoterCount,
    total_voted: totalVoted,
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
  const captain = db.prepare('SELECT id, name FROM captains WHERE id = ? AND candidate_id = ?').get(req.params.captainId, req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found under this candidate.' });
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.captainId);
  res.json({ success: true, message: 'Captain "' + captain.name + '" deleted.' });
});

// Voter search — name-only q, dedicated filters, priority ordering (matches captain search)
router.get('/candidates/:id/search', requireCandidateAuth, (req, res) => {
  const { q, phone, vanid, city, zip, precinct, address } = req.query;
  const hasFilter = phone || vanid || city || zip || precinct || address;
  if ((!q || q.trim().length < 2) && !hasFilter) return res.json({ voters: [] });

  const conditions = [];
  const params = [];

  // Name-only search: each word must match first or last name
  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      const term = '%' + escaped + '%';
      conditions.push("(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\')");
      params.push(term, term);
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
  const voter = db.prepare('SELECT address, zip, city FROM voters WHERE id = ?').get(voter_id);
  if (!voter || !voter.address) return res.json({ household: [] });

  const streetNum = (voter.address.match(/^(\d+)/) || [])[1];
  if (!streetNum) return res.json({ household: [] });

  let candidates;
  if (voter.zip) {
    const zipShort = voter.zip.replace(/-\d+$/, '');
    candidates = db.prepare('SELECT * FROM voters WHERE (zip = ? OR zip LIKE ?) AND address LIKE ? AND id != ? ORDER BY last_name LIMIT 100').all(voter.zip, zipShort + '%', streetNum + ' %', voter_id);
  } else if (voter.city) {
    candidates = db.prepare('SELECT * FROM voters WHERE LOWER(city) = LOWER(?) AND address LIKE ? AND id != ? ORDER BY last_name LIMIT 100').all(voter.city, streetNum + ' %', voter_id);
  } else {
    candidates = db.prepare('SELECT * FROM voters WHERE address LIKE ? AND id != ? ORDER BY last_name LIMIT 100').all(streetNum + ' %', voter_id);
  }

  // Simple normalized address match
  const norm = voter.address.trim().toLowerCase().replace(/\b(apt|unit|suite|ste|#)\b\.?\s*\S*/gi, '').replace(/\s+/g, ' ').trim();
  const household = candidates.filter(c => {
    const cn = (c.address || '').trim().toLowerCase().replace(/\b(apt|unit|suite|ste|#)\b\.?\s*\S*/gi, '').replace(/\s+/g, ' ').trim();
    return cn === norm;
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
  const voters = db.prepare(`
    SELECT v.*, alv.added_at FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ORDER BY alv.added_at DESC
  `).all(req.params.listId);
  attachElectionVotes(voters);
  res.json({ list, voters });
});

// Add voters to a candidate's list
router.post('/candidates/:id/lists/:listId/voters', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { voterIds } = req.body;
  if (!voterIds || !voterIds.length) return res.status(400).json({ error: 'No voters provided.' });
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0;
  for (const vid of voterIds) {
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

// Remove voter from a candidate's list
router.delete('/candidates/:id/lists/:listId/voters/:voterId', requireCandidateAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ? AND candidate_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// View voters on a captain's list (read-only for candidate)
router.get('/candidates/:id/captain-lists/:listId/voters', requireCandidateAuth, (req, res) => {
  // Verify list belongs to a captain under this candidate
  const list = db.prepare(`
    SELECT cl.*, c.name as captain_name FROM captain_lists cl
    JOIN captains c ON cl.captain_id = c.id
    WHERE cl.id = ? AND c.candidate_id = ?
  `).get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'Captain list not found.' });
  const voters = db.prepare(`
    SELECT v.*, clv.added_at FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id
    WHERE clv.list_id = ? ORDER BY clv.added_at DESC
  `).all(req.params.listId);
  attachElectionVotes(voters);
  res.json({ list, voters });
});

// Master list: all unique voters across ALL lists with source info
router.get('/candidates/:id/master-list', requireCandidateAuth, (req, res) => {
  const candidateIdParam = req.params.id;

  // Gather all voter appearances from both admin and captain lists
  const rows = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.middle_name, v.suffix,
           v.address, v.city, v.zip, v.phone, v.party, v.precinct,
           v.state_file_id, v.vanid, v.early_voted, v.early_voted_date,
           source_name, source_type, list_name, added_at
    FROM (
      SELECT alv.voter_id, 'My List' as source_name, 'admin' as source_type,
             al.name as list_name, alv.added_at
      FROM admin_list_voters alv
      JOIN admin_lists al ON alv.list_id = al.id
      WHERE al.candidate_id = ?
      UNION ALL
      SELECT clv.voter_id, c.name as source_name, 'captain' as source_type,
             cl.name as list_name, clv.added_at
      FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      JOIN captains c ON cl.captain_id = c.id
      WHERE c.candidate_id = ?
    ) sources
    JOIN voters v ON sources.voter_id = v.id
    ORDER BY v.last_name, v.first_name
  `).all(candidateIdParam, candidateIdParam);

  // Group by voter_id — each voter gets an array of which lists they're on
  const voterMap = new Map();
  for (const row of rows) {
    if (!voterMap.has(row.id)) {
      voterMap.set(row.id, {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        middle_name: row.middle_name,
        suffix: row.suffix,
        address: row.address,
        city: row.city,
        zip: row.zip,
        phone: row.phone,
        party: row.party,
        precinct: row.precinct,
        state_file_id: row.state_file_id,
        vanid: row.vanid,
        early_voted: row.early_voted,
        early_voted_date: row.early_voted_date,
        lists: []
      });
    }
    voterMap.get(row.id).lists.push({
      source_name: row.source_name,
      source_type: row.source_type,
      list_name: row.list_name,
      added_at: row.added_at
    });
  }

  const voters = Array.from(voterMap.values());
  attachElectionVotes(voters);
  const totalAppearances = rows.length;
  const uniqueVoters = voters.length;
  const overlaps = voters.filter(v => v.lists.length > 1).length;

  res.json({ voters, totalAppearances, uniqueVoters, overlaps });
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
  // Verify captain belongs to this candidate
  const captain = db.prepare('SELECT id, name FROM captains WHERE id = ? AND candidate_id = ?').get(captain_id, req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found under this candidate.' });
  db.prepare('UPDATE admin_lists SET assigned_captain_id = ? WHERE id = ?').run(captain_id, req.params.listId);
  res.json({ success: true, captain_name: captain.name });
});

module.exports = router;
