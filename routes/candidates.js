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

// List all candidates with stats
router.get('/candidates', (req, res) => {
  const candidates = db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all();
  for (const c of candidates) {
    c.captain_count = (db.prepare('SELECT COUNT(*) as n FROM captains WHERE candidate_id = ?').get(c.id) || { n: 0 }).n;
    c.list_count = (db.prepare('SELECT COUNT(*) as n FROM admin_lists WHERE candidate_id = ?').get(c.id) || { n: 0 }).n;
    // Captain lists under this candidate's captains
    c.captain_list_count = (db.prepare(`
      SELECT COUNT(*) as n FROM captain_lists cl
      JOIN captains cap ON cl.captain_id = cap.id
      WHERE cap.candidate_id = ?
    `).get(c.id) || { n: 0 }).n;
    c.total_voters = (db.prepare(`
      SELECT COUNT(DISTINCT voter_id) as n FROM (
        SELECT clv.voter_id FROM captain_list_voters clv
        JOIN captain_lists cl ON clv.list_id = cl.id
        JOIN captains cap ON cl.captain_id = cap.id
        WHERE cap.candidate_id = ?
        UNION
        SELECT alv.voter_id FROM admin_list_voters alv
        JOIN admin_lists al ON alv.list_id = al.id
        WHERE al.candidate_id = ?
      )
    `).get(c.id, c.id) || { n: 0 }).n;
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
  }
  res.json({ captains });
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
  // Auto-create a default list
  db.prepare('INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)').run(result.lastInsertRowid, 'My Voters', 'general');
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
  const stats = {
    total_captains: captains.length,
    active_captains: captains.filter(c => c.is_active).length,
    total_voters: allVoterCount,
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
  }

  const lists = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.candidate_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(candidate.id);

  // Aggregate stats for dashboard
  const adminVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT alv.voter_id) as n FROM admin_list_voters alv
    JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?
  `).get(candidate.id) || { n: 0 }).n;
  const captainVoterCount = (db.prepare(`
    SELECT COUNT(DISTINCT clv.voter_id) as n FROM captain_list_voters clv
    JOIN captain_lists cl ON clv.list_id = cl.id
    JOIN captains cap ON cl.captain_id = cap.id WHERE cap.candidate_id = ?
  `).get(candidate.id) || { n: 0 }).n;
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

  const stats = {
    total_captains: captains.length,
    active_captains: captains.filter(c => c.is_active).length,
    total_voters: allVoterCount,
    admin_voters: adminVoterCount,
    captain_voters: captainVoterCount,
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
  db.prepare('INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)').run(result.lastInsertRowid, 'My Voters', 'general');
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

// Voter search (same as captain search — queries shared voters table)
router.get('/candidates/:id/search', requireCandidateAuth, (req, res) => {
  const { q, city, zip, precinct, address } = req.query;
  const hasFilter = city || zip || precinct || address;
  if ((!q || q.length < 2) && !hasFilter) return res.json({ voters: [] });

  const conditions = [];
  const params = [];

  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      const term = '%' + escaped + '%';
      conditions.push("(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR precinct LIKE ? ESCAPE '\\')");
      params.push(term, term, term, term, term, term);
    }
  }
  if (city) { conditions.push("city LIKE ? ESCAPE '\\'"); params.push('%' + city.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (zip) { conditions.push("zip LIKE ? ESCAPE '\\'"); params.push(zip.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (precinct) { conditions.push("precinct LIKE ? ESCAPE '\\'"); params.push('%' + precinct.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (address) { conditions.push("address LIKE ? ESCAPE '\\'"); params.push('%' + address.replace(/[\\%_]/g, '\\$&') + '%'); }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  const voters = db.prepare(`SELECT * FROM voters WHERE ${whereClause} ORDER BY last_name, first_name LIMIT 50`).all(...params);
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
