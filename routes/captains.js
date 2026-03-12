const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { randomBytes } = require('crypto');
const { phoneDigits, normalizePhone } = require('../utils');

const captainLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// Attach election_votes (turnout with party) to a list of voters
function attachElectionVotes(voters) {
  if (!voters || voters.length === 0) return;
  const ids = voters.map(v => v.id);
  const evRows = db.prepare(
    'SELECT voter_id, election_name, election_type, party_voted FROM election_votes WHERE voter_id IN (' + ids.map(() => '?').join(',') + ')'
  ).all(...ids);
  const map = {};
  for (const r of evRows) {
    if (!map[r.voter_id]) map[r.voter_id] = [];
    map[r.voter_id].push({ election_name: r.election_name, election_type: r.election_type, party_voted: r.party_voted || '' });
  }
  for (const v of voters) {
    v.election_votes = map[v.id] || [];
  }
}

// Generate a 6-char alphanumeric captain code (e.g., "A3F82C")
function generateCaptainCode() {
  return randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

// Normalize address for household matching: lowercase, strip apt/unit/suite suffixes, collapse whitespace
function normalizeAddress(address) {
  if (!address) return '';
  return address.trim().toLowerCase()
    .replace(/\b(apt|unit|suite|ste|#|lot|spc|space|bldg|building|fl|floor|rm|room)\b\.?\s*\S*/gi, '')
    .replace(/\b(street|st)\b\.?/gi, 'st')
    .replace(/\b(avenue|ave)\b\.?/gi, 'ave')
    .replace(/\b(boulevard|blvd)\b\.?/gi, 'blvd')
    .replace(/\b(drive|dr)\b\.?/gi, 'dr')
    .replace(/\b(lane|ln)\b\.?/gi, 'ln')
    .replace(/\b(road|rd)\b\.?/gi, 'rd')
    .replace(/\b(court|ct)\b\.?/gi, 'ct')
    .replace(/\b(circle|cir)\b\.?/gi, 'cir')
    .replace(/\b(place|pl)\b\.?/gi, 'pl')
    .replace(/\b(terrace|ter)\b\.?/gi, 'ter')
    .replace(/\b(way)\b\.?/gi, 'way')
    .replace(/\b(north|n)\b\.?/gi, 'n')
    .replace(/\b(south|s)\b\.?/gi, 's')
    .replace(/\b(east|e)\b\.?/gi, 'e')
    .replace(/\b(west|w)\b\.?/gi, 'w')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract street number from address for household matching
function extractStreetNumber(address) {
  const match = (address || '').match(/^(\d+)/);
  return match ? match[1] : null;
}

// ===================== ADMIN ENDPOINTS =====================

// List all captains with stats (batched queries to avoid N+1)
router.get('/captains', (req, res) => {
  // Optional candidate_id filter — when provided, only show captains under that candidate
  const candidateFilter = req.query.candidate_id;
  let captainQuery = 'SELECT c.*, pc.name as parent_captain_name, cand.name as candidate_name FROM captains c LEFT JOIN captains pc ON c.parent_captain_id = pc.id LEFT JOIN candidates cand ON c.candidate_id = cand.id';
  const queryParams = [];
  if (candidateFilter === 'none') {
    captainQuery += ' WHERE c.candidate_id IS NULL';
  } else if (candidateFilter) {
    captainQuery += ' WHERE c.candidate_id = ?';
    queryParams.push(candidateFilter);
  }
  captainQuery += ' ORDER BY c.created_at DESC';
  const captains = db.prepare(captainQuery).all(...queryParams);
  const captainIds = captains.map(c => c.id);

  if (captainIds.length > 0) {
    // Batch-load team members for all captains
    const allTeamMembers = db.prepare('SELECT * FROM captain_team_members ORDER BY name').all();
    const teamByCapt = {};
    for (const tm of allTeamMembers) {
      (teamByCapt[tm.captain_id] || (teamByCapt[tm.captain_id] = [])).push(tm);
    }

    // Batch-load lists for all captains
    const allLists = db.prepare(`
      SELECT cl.*, COUNT(clv.id) as voter_count,
        ctm.name as team_member_name
      FROM captain_lists cl
      LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
      LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `).all();
    const listsByCapt = {};
    for (const l of allLists) {
      (listsByCapt[l.captain_id] || (listsByCapt[l.captain_id] = [])).push(l);
    }

    // Batch-load voter counts per captain
    const voterCounts = db.prepare(`
      SELECT cl.captain_id, COUNT(DISTINCT clv.voter_id) as c
      FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      GROUP BY cl.captain_id
    `).all();
    const voterCountByCapt = {};
    for (const vc of voterCounts) {
      voterCountByCapt[vc.captain_id] = vc.c;
    }

    // Assign to each captain
    for (const c of captains) {
      c.team_members = teamByCapt[c.id] || [];
      c.lists = listsByCapt[c.id] || [];
      c.total_voters = voterCountByCapt[c.id] || 0;
    }
  }

  // Global overlap stats
  const overlap = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT voter_id FROM captain_list_voters GROUP BY voter_id HAVING COUNT(DISTINCT list_id) >= 2
    )
  `).get() || { c: 0 }).c;
  const totalUniqueVoters = (db.prepare('SELECT COUNT(DISTINCT voter_id) as c FROM captain_list_voters').get() || { c: 0 }).c;
  const totalLists = (db.prepare('SELECT COUNT(*) as c FROM captain_lists').get() || { c: 0 }).c;
  res.json({ captains, stats: { overlap, totalUniqueVoters, totalLists } });
});

// Create captain
router.post('/captains', (req, res) => {
  const { name, phone, email, candidate_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  let code;
  let unique = false;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) { unique = true; break; }
  }
  if (!unique) return res.status(500).json({ error: 'Could not generate a unique captain code. Please try again.' });
  const result = db.prepare(
    'INSERT INTO captains (name, code, phone, email, candidate_id) VALUES (?, ?, ?, ?, ?)'
  ).run(name, code, phone || '', email || '', candidate_id || null);
  // Auto-create a default list named after the captain
  db.prepare(
    'INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)'
  ).run(result.lastInsertRowid, name.trim(), 'general');
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block Captain created: ' + name + ' (code: ' + code + ')');
  res.json({ success: true, id: result.lastInsertRowid, code });
});

// Update captain
router.put('/captains/:id', (req, res) => {
  const { name, phone, email, is_active } = req.body;
  const result = db.prepare(`UPDATE captains SET
    name = COALESCE(?, name),
    phone = COALESCE(?, phone),
    email = COALESCE(?, email),
    is_active = COALESCE(?, is_active)
    WHERE id = ?`
  ).run(name, phone, email, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Captain not found.' });
  res.json({ success: true });
});

// Delete captain (cascades lists via FK)
router.delete('/captains/:id', (req, res) => {
  const captain = db.prepare('SELECT name FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block Captain removed: ' + captain.name);
  res.json({ success: true });
});

// All lists rollup — master view of every list (captain + admin)
router.get('/captains/all-lists', (req, res) => {
  const candidateFilter = req.query.candidate_id;

  // Captain lists with captain name and voter count
  let clQuery = `
    SELECT cl.id, cl.name, cl.list_type, cl.created_at,
      c.name as captain_name, c.id as captain_id,
      c.candidate_id, cand.name as candidate_name,
      COUNT(clv.id) as voter_count,
      ctm.name as team_member_name
    FROM captain_lists cl
    JOIN captains c ON cl.captain_id = c.id
    LEFT JOIN candidates cand ON c.candidate_id = cand.id
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id`;
  const clParams = [];
  if (candidateFilter === 'none') { clQuery += ' WHERE c.candidate_id IS NULL'; }
  else if (candidateFilter) { clQuery += ' WHERE c.candidate_id = ?'; clParams.push(candidateFilter); }
  clQuery += ' GROUP BY cl.id ORDER BY cl.created_at DESC';
  const captainLists = db.prepare(clQuery).all(...clParams);

  // Admin lists with voter count
  let alQuery = `
    SELECT al.id, al.name, al.description, al.list_type, al.created_at,
      al.candidate_id, cand.name as candidate_name,
      COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN candidates cand ON al.candidate_id = cand.id
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id`;
  const alParams = [];
  if (candidateFilter === 'none') { alQuery += ' WHERE al.candidate_id IS NULL'; }
  else if (candidateFilter) { alQuery += ' WHERE al.candidate_id = ?'; alParams.push(candidateFilter); }
  alQuery += ' GROUP BY al.id ORDER BY al.created_at DESC';
  const adminLists = db.prepare(alQuery).all(...alParams);

  // Combine into unified format
  const allLists = [];
  for (const cl of captainLists) {
    allLists.push({
      id: cl.id, name: cl.name, list_type: cl.list_type || 'general',
      source: 'captain', captain_name: cl.captain_name, captain_id: cl.captain_id,
      candidate_name: cl.candidate_name || null, candidate_id: cl.candidate_id || null,
      team_member: cl.team_member_name || null,
      voter_count: cl.voter_count, created_at: cl.created_at
    });
  }
  for (const al of adminLists) {
    allLists.push({
      id: al.id, name: al.name, list_type: al.list_type || 'general',
      source: 'admin', captain_name: null, captain_id: null,
      candidate_name: al.candidate_name || null, candidate_id: al.candidate_id || null,
      description: al.description, team_member: null,
      voter_count: al.voter_count, created_at: al.created_at
    });
  }

  // Summary stats (deduplicate voters that appear in both captain and admin lists)
  const totalVoters = (db.prepare('SELECT COUNT(DISTINCT voter_id) as c FROM (SELECT voter_id FROM captain_list_voters UNION SELECT voter_id FROM admin_list_voters)').get() || { c: 0 }).c;
  const byType = {};
  for (const l of allLists) {
    byType[l.list_type] = (byType[l.list_type] || 0) + 1;
  }

  res.json({ lists: allLists, stats: { totalLists: allLists.length, totalVoters, byType } });
});

// ===================== CAPTAIN PORTAL ENDPOINTS =====================

// Login with permanent code — sets session for captain auth
router.post('/captains/login', captainLoginLimiter, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const captain = db.prepare('SELECT * FROM captains WHERE code = ?').get(code.trim().toUpperCase());
  if (!captain) return res.status(404).json({ error: 'Invalid captain code.' });
  if (!captain.is_active) return res.status(403).json({ error: 'Your access has been disabled. Contact the campaign admin.' });

  // Set captain session for portal auth
  req.session.captainId = captain.id;

  captain.team_members = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ? ORDER BY name').all(captain.id);
  // Sub-captains — full descendant tree (recursive CTE) with parent_captain_id for hierarchy rendering
  captain.sub_captains = db.prepare(`
    WITH RECURSIVE team_tree AS (
      SELECT id, name, code, is_active, created_at, parent_captain_id
      FROM captains WHERE parent_captain_id = ?
      UNION ALL
      SELECT c.id, c.name, c.code, c.is_active, c.created_at, c.parent_captain_id
      FROM captains c JOIN team_tree t ON c.parent_captain_id = t.id
    )
    SELECT * FROM team_tree ORDER BY name
  `).all(captain.id);

  captain.lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count,
      ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ?
    GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(captain.id);

  // Sub-captain lists (lists belonging to team members who are real captains)
  captain.sub_captain_lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count,
      c.name as sub_captain_name, c.id as sub_captain_id
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    JOIN captains c ON cl.captain_id = c.id
    WHERE c.parent_captain_id = ?
    GROUP BY cl.id ORDER BY c.name, cl.created_at DESC
  `).all(captain.id);

  // Also include admin lists assigned to this captain
  captain.assigned_lists = db.prepare(`
    SELECT al.id, al.name, al.description, al.list_type,
      COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.assigned_captain_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(captain.id);
  res.json({ success: true, captain });
});

// Middleware: verify the caller is the captain identified by :id (or an admin, or parent captain)
function requireCaptainAuth(req, res, next) {
  const captainId = parseInt(req.params.id, 10);
  if (isNaN(captainId)) return res.status(400).json({ error: 'Invalid captain ID.' });
  // Admin users can access any captain's data
  if (req.session && req.session.userId) return next();
  // Captain portal users must match their session
  if (req.session && req.session.captainId === captainId) return next();
  // Parent captains can access their sub-captain's data (read-only team visibility)
  if (req.session && req.session.captainId) {
    const target = db.prepare('SELECT parent_captain_id FROM captains WHERE id = ?').get(captainId);
    if (target && target.parent_captain_id === req.session.captainId) return next();
  }
  return res.status(401).json({ error: 'Captain authentication required. Please log in with your code.' });
}

// Search voters (captain portal) — name search + dedicated filters for phone, vanid, etc.
router.get('/captains/:id/search', requireCaptainAuth, (req, res) => {
  const { q, phone, vanid, city, zip, precinct, address } = req.query;
  const hasFilter = phone || vanid || city || zip || precinct || address;
  if ((!q || q.trim().length < 2) && !hasFilter) return res.json({ voters: [] });

  const conditions = [];
  const params = [];

  // Name-only search: split into words — each word must match first or last name
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

  // Build ORDER BY that prioritizes name matches over address/city matches
  let orderClause = 'last_name, first_name';
  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      // Prioritize: both words match name fields first, then one word matches a name field
      const namePriorityCases = [];
      const namePriorityParams = [];
      for (const w of words) {
        const escaped = w.replace(/[\\%_]/g, '\\$&');
        const term = '%' + escaped + '%';
        namePriorityCases.push("(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\')");
        namePriorityParams.push(term, term);
      }
      // Count how many search words match a name field — more matches = higher priority (lower sort value)
      const priorityExpr = namePriorityCases.map(c => 'CASE WHEN ' + c + ' THEN 1 ELSE 0 END').join(' + ');
      orderClause = '(' + priorityExpr + ') DESC, last_name, first_name';
      params.push(...namePriorityParams);
    }
  }

  const voters = db.prepare(`
    SELECT * FROM voters
    WHERE ${whereClause}
    ORDER BY ${orderClause} LIMIT 50
  `).all(...params);
  // Attach election vote data (turnout tags)
  attachElectionVotes(voters);
  res.json({ voters });
});

// Get household members for a voter (normalized address match)
router.get('/captains/:id/household', requireCaptainAuth, (req, res) => {
  const { voter_id } = req.query;
  if (!voter_id) return res.json({ household: [] });
  const voter = db.prepare('SELECT address, zip, city FROM voters WHERE id = ?').get(voter_id);
  if (!voter || !voter.address) return res.json({ household: [] });
  const streetNum = extractStreetNumber(voter.address);
  if (!streetNum) return res.json({ household: [] });

  // Strategy: find candidates by street number, then filter by normalized address match
  // This handles apt/unit differences, abbreviation differences (St vs Street), etc.
  const normalizedAddr = normalizeAddress(voter.address);

  // Build query: street number prefix match + at least one location anchor (zip, city, or precinct)
  let candidates;
  if (voter.zip) {
    // Primary match: same zip + same street number prefix
    const zipShort = voter.zip.replace(/-\d+$/, ''); // handle 78701-1234 → 78701
    candidates = db.prepare(`
      SELECT * FROM voters
      WHERE (zip = ? OR zip LIKE ? OR zip = ?) AND address LIKE ? AND id != ?
      ORDER BY last_name, first_name LIMIT 100
    `).all(voter.zip, zipShort + '%', zipShort, streetNum + ' %', voter_id);
  } else if (voter.city) {
    // Fallback: same city + same street number prefix
    candidates = db.prepare(`
      SELECT * FROM voters
      WHERE LOWER(city) = LOWER(?) AND address LIKE ? AND id != ?
      ORDER BY last_name, first_name LIMIT 100
    `).all(voter.city, streetNum + ' %', voter_id);
  } else {
    // Last resort: just street number prefix (less precise)
    candidates = db.prepare(`
      SELECT * FROM voters
      WHERE address LIKE ? AND id != ?
      ORDER BY last_name, first_name LIMIT 100
    `).all(streetNum + ' %', voter_id);
  }

  // Filter candidates: normalized address must match (ignores apt/unit differences)
  const household = candidates.filter(c => normalizeAddress(c.address) === normalizedAddr);

  res.json({ household });
});

// ===================== LIST MANAGEMENT =====================

// Get all lists for this captain (own + sub-captain + assigned admin lists)
router.get('/captains/:id/lists', requireCaptainAuth, (req, res) => {
  const lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count,
      ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ?
    GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(req.params.id);

  // Sub-captain lists — all descendant captains' lists (recursive CTE)
  const subCaptainLists = db.prepare(`
    WITH RECURSIVE team_tree AS (
      SELECT id FROM captains WHERE parent_captain_id = ?
      UNION ALL
      SELECT c.id FROM captains c JOIN team_tree t ON c.parent_captain_id = t.id
    )
    SELECT cl.*, COUNT(clv.id) as voter_count,
      c.name as sub_captain_name, c.id as sub_captain_id
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    JOIN captains c ON cl.captain_id = c.id
    WHERE c.id IN (SELECT id FROM team_tree)
    GROUP BY cl.id ORDER BY c.name, cl.created_at DESC
  `).all(req.params.id);

  const assignedLists = db.prepare(`
    SELECT al.id, al.name, al.description, al.list_type,
      COUNT(alv.id) as voter_count
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.assigned_captain_id = ?
    GROUP BY al.id ORDER BY al.created_at DESC
  `).all(req.params.id);
  const teamMembers = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ? ORDER BY name').all(req.params.id);
  // Full descendant tree with parent_captain_id for hierarchy rendering
  const subCaptains = db.prepare(`
    WITH RECURSIVE team_tree AS (
      SELECT id, name, code, is_active, created_at, parent_captain_id
      FROM captains WHERE parent_captain_id = ?
      UNION ALL
      SELECT c.id, c.name, c.code, c.is_active, c.created_at, c.parent_captain_id
      FROM captains c JOIN team_tree t ON c.parent_captain_id = t.id
    )
    SELECT * FROM team_tree ORDER BY name
  `).all(req.params.id);

  res.json({ lists, sub_captain_lists: subCaptainLists, assigned_lists: assignedLists, team_members: teamMembers, sub_captains: subCaptains });
});

// Create list — blocked for captains (each captain gets one auto-created "My Voters" list)
router.post('/captains/:id/lists', requireCaptainAuth, (req, res) => {
  return res.status(403).json({ error: 'Captains are limited to one list. Your "My Voters" list was created automatically.' });
});

// Rename list
router.put('/captains/:id/lists/:listId', requireCaptainAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const result = db.prepare('UPDATE captain_lists SET name = ? WHERE id = ? AND captain_id = ?').run(name, req.params.listId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
  res.json({ success: true });
});

// Delete list (voters removed via FK cascade)
router.delete('/captains/:id/lists/:listId', requireCaptainAuth, (req, res) => {
  const result = db.prepare('DELETE FROM captain_lists WHERE id = ? AND captain_id = ?').run(req.params.listId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
  res.json({ success: true });
});

// Get voters in a list
router.get('/captains/:id/lists/:listId/voters', requireCaptainAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const voters = db.prepare(`
    SELECT v.*, clv.added_at
    FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id
    WHERE clv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.listId);
  // Attach election vote data (turnout tags)
  attachElectionVotes(voters);
  // Cross-list info hidden from captains — only admin sees overlap
  res.json({ voters });
});

// Add voter to list with optional contact info update
router.post('/captains/:id/lists/:listId/voters', requireCaptainAuth, (req, res) => {
  const { voter_id, phone, email } = req.body;
  if (!voter_id) return res.status(400).json({ error: 'voter_id is required.' });

  // Verify list belongs to this captain
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // Update phone/email if provided
  if (phone || email) {
    const updates = [];
    const params = [];
    if (phone) { updates.push('phone = ?'); params.push(normalizePhone(phone)); }
    if (email) { updates.push('email = ?'); params.push(email); }
    if (updates.length > 0) {
      params.push(voter_id);
      db.prepare(`UPDATE voters SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  const existing = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, voter_id);
  if (existing) return res.json({ success: true, already: true });
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(req.params.listId, voter_id);
  res.json({ success: true });
});

// Remove voter from list
router.delete('/captains/:id/lists/:listId/voters/:voterId', requireCaptainAuth, (req, res) => {
  // Verify list belongs to this captain
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('DELETE FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// ===================== CSV IMPORT & CROSS-MATCH =====================

// Import CSV: cross-match uploaded rows against voter database
router.post('/captains/:id/lists/:listId/import-csv', requireCaptainAuth, (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // Verify list belongs to this captain
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // Pre-build lookup maps
  const allVoters = db.prepare(
    "SELECT id, phone, first_name, last_name, address, city, zip, party, support_level, registration_number FROM voters"
  ).all();

  // Phone map: digits -> array of voters (array to detect ambiguity)
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) {
      if (!phoneMap[d]) phoneMap[d] = [];
      phoneMap[d].push(v);
    }
  }

  // Registration number map: trimmed string -> voter
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim()] = v;
    }
  }

  // Name + address query (LIMIT 3 to detect ambiguity)
  const findByNameAddr = db.prepare(
    "SELECT id, first_name, last_name, phone, address, city, zip, party FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 3"
  );
  const checkExisting = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?');
  const insertToList = db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');

  const results = { auto_added: 0, already_on_list: 0, needs_review: [], no_match: [] };

  const importTx = db.transaction((rowList) => {
    for (const row of rowList) {
      let candidates = [];
      let matchMethod = '';

      // Tier 1: Phone match
      const digits = phoneDigits(row.phone);
      if (digits.length >= 7 && phoneMap[digits]) {
        candidates = phoneMap[digits];
        matchMethod = 'phone';
      }

      // Tier 2: Registration number match
      if (candidates.length === 0 && row.registration_number && row.registration_number.trim()) {
        const found = regMap[row.registration_number.trim()];
        if (found) {
          candidates = [found];
          matchMethod = 'registration';
        }
      }

      // Tier 3: Name + address match
      if (candidates.length === 0 && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          candidates = findByNameAddr.all(row.first_name, row.last_name, addrWords + '%');
          matchMethod = 'name_address';
        }
      }

      // Disposition
      if (candidates.length === 1) {
        // Confident single match — auto-add
        const voter = candidates[0];
        const exists = checkExisting.get(req.params.listId, voter.id);
        if (exists) {
          results.already_on_list++;
        } else {
          insertToList.run(req.params.listId, voter.id);
          results.auto_added++;
        }
      } else if (candidates.length > 1) {
        // Multiple matches — needs captain review
        results.needs_review.push({
          csv_row: {
            first_name: row.first_name || '', last_name: row.last_name || '',
            phone: row.phone || '', address: row.address || '',
            city: row.city || '', zip: row.zip || ''
          },
          candidates: candidates.map(c => ({
            id: c.id, first_name: c.first_name, last_name: c.last_name,
            phone: c.phone, address: c.address, city: c.city,
            zip: c.zip, party: c.party, match_method: matchMethod
          }))
        });
      } else {
        // No match
        results.no_match.push({
          first_name: row.first_name || '', last_name: row.last_name || '',
          phone: row.phone || '', address: row.address || ''
        });
      }
    }
  });

  importTx(rows);
  // Cross-list info hidden from captains — only admin sees overlap
  res.json({ success: true, ...results });
});

// Confirm manually verified matches from CSV import
router.post('/captains/:id/lists/:listId/confirm-matches', requireCaptainAuth, (req, res) => {
  const { matches } = req.body;
  if (!matches || !matches.length) return res.status(400).json({ error: 'No matches provided.' });

  // Verify list belongs to this captain
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const checkExisting = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?');
  const checkVoter = db.prepare('SELECT id FROM voters WHERE id = ?');
  const insertToList = db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');

  const confirmTx = db.transaction((matchList) => {
    let added = 0, already = 0;
    for (const m of matchList) {
      const voterIdInt = parseInt(m.voter_id, 10);
      if (!(voterIdInt > 0)) continue;
      if (!checkVoter.get(voterIdInt)) continue;
      if (checkExisting.get(req.params.listId, voterIdInt)) {
        already++;
      } else {
        insertToList.run(req.params.listId, voterIdInt);
        added++;
      }
    }
    return { added, already };
  });

  const result = confirmTx(matches);
  res.json({ success: true, ...result });
});

// ===================== ASSIGNED ADMIN LISTS (captain can add/view/remove voters) =====================

// Verify admin list is assigned to this captain
function verifyAssignedList(captainId, listId) {
  return db.prepare('SELECT id, name FROM admin_lists WHERE id = ? AND assigned_captain_id = ?').get(listId, captainId);
}

// Get voters in an assigned admin list
router.get('/captains/:id/assigned-lists/:listId/voters', requireCaptainAuth, (req, res) => {
  const list = verifyAssignedList(req.params.id, req.params.listId);
  if (!list) return res.status(404).json({ error: 'Assigned list not found.' });
  const voters = db.prepare(`
    SELECT v.*, alv.added_at
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.listId);
  attachElectionVotes(voters);
  res.json({ voters });
});

// Add voter to an assigned admin list
router.post('/captains/:id/assigned-lists/:listId/voters', requireCaptainAuth, (req, res) => {
  const { voter_id, phone, email } = req.body;
  if (!voter_id) return res.status(400).json({ error: 'voter_id is required.' });
  const list = verifyAssignedList(req.params.id, req.params.listId);
  if (!list) return res.status(404).json({ error: 'Assigned list not found.' });
  // Update phone/email if provided
  if (phone || email) {
    const updates = [];
    const params = [];
    if (phone) { updates.push('phone = ?'); params.push(normalizePhone(phone)); }
    if (email) { updates.push('email = ?'); params.push(email); }
    if (updates.length > 0) {
      params.push(voter_id);
      db.prepare(`UPDATE voters SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  }
  const existing = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, voter_id);
  if (existing) return res.json({ success: true, already: true });
  db.prepare('INSERT INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(req.params.listId, voter_id);
  res.json({ success: true });
});

// Remove voter from an assigned admin list
router.delete('/captains/:id/assigned-lists/:listId/voters/:voterId', requireCaptainAuth, (req, res) => {
  const list = verifyAssignedList(req.params.id, req.params.listId);
  if (!list) return res.status(404).json({ error: 'Assigned list not found.' });
  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// ===================== TEAM MANAGEMENT =====================

// Get all voters across all sub-captain lists (master team view)
router.get('/captains/:id/team-voters', requireCaptainAuth, (req, res) => {
  // Get all sub-captain IDs under this captain
  const subCaptainIds = db.prepare('SELECT id FROM captains WHERE parent_captain_id = ?').all(req.params.id).map(r => r.id);
  // Also get legacy team member list voters (lists owned by this captain with team_member_id set)
  const teamMemberListIds = db.prepare('SELECT id FROM captain_lists WHERE captain_id = ? AND team_member_id IS NOT NULL').all(req.params.id).map(r => r.id);

  let voters = [];
  if (subCaptainIds.length > 0 || teamMemberListIds.length > 0) {
    // Collect all relevant list IDs
    let allListIds = [...teamMemberListIds];
    if (subCaptainIds.length > 0) {
      const subListIds = db.prepare(
        'SELECT id FROM captain_lists WHERE captain_id IN (' + subCaptainIds.map(() => '?').join(',') + ')'
      ).all(...subCaptainIds).map(r => r.id);
      allListIds = allListIds.concat(subListIds);
    }
    if (allListIds.length > 0) {
      voters = db.prepare(
        'SELECT v.*, MAX(clv.added_at) as added_at FROM captain_list_voters clv JOIN voters v ON clv.voter_id = v.id WHERE clv.list_id IN (' + allListIds.map(() => '?').join(',') + ') GROUP BY v.id ORDER BY v.last_name, v.first_name'
      ).all(...allListIds);
      attachElectionVotes(voters);
    }
  }
  res.json({ voters });
});

// Add team member — creates a real captain with their own code under this leader
router.post('/captains/:id/team', requireCaptainAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  // Generate unique captain code for the new team member
  let code;
  let unique = false;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) { unique = true; break; }
  }
  if (!unique) return res.status(500).json({ error: 'Could not generate a unique code. Please try again.' });

  // Inherit candidate_id from parent captain so sub-captains appear on candidate dashboard
  const parentCaptain = db.prepare('SELECT candidate_id FROM captains WHERE id = ?').get(req.params.id);
  const inheritedCandidateId = parentCaptain ? parentCaptain.candidate_id : null;

  // Create as a real captain with parent_captain_id + inherited candidate_id
  const result = db.prepare(
    'INSERT INTO captains (name, code, parent_captain_id, candidate_id) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), code, req.params.id, inheritedCandidateId);

  // Auto-create a default list named after the team member
  db.prepare(
    'INSERT INTO captain_lists (captain_id, name, list_type) VALUES (?, ?, ?)'
  ).run(result.lastInsertRowid, name.trim(), 'general');

  // Also add to captain_team_members for backwards compat with list assignment
  const tmResult = db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(req.params.id, name.trim());

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Team member created: ' + name.trim() + ' (code: ' + code + ') under captain #' + req.params.id
  );

  res.json({ success: true, id: result.lastInsertRowid, team_member_id: tmResult.lastInsertRowid, code });
});

// Remove team member and deactivate their captain login
router.delete('/captains/:id/team/:memberId', requireCaptainAuth, (req, res) => {
  const member = db.prepare('SELECT * FROM captain_team_members WHERE id = ? AND captain_id = ?').get(req.params.memberId, req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found.' });

  // Delete the team member record
  db.prepare('DELETE FROM captain_team_members WHERE id = ?').run(req.params.memberId);

  // Also deactivate the corresponding sub-captain (created with parent_captain_id)
  // so the removed member can no longer log in with their code
  const subCaptain = db.prepare('SELECT id FROM captains WHERE name = ? AND parent_captain_id = ?').get(member.name, req.params.id);
  if (subCaptain) {
    db.prepare('DELETE FROM captains WHERE id = ?').run(subCaptain.id);
  }

  res.json({ success: true });
});

module.exports = router;
