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
    'SELECT voter_id, election_name, election_type, party_voted, vote_method FROM election_votes WHERE voter_id IN (' + ids.map(() => '?').join(',') + ')'
  ).all(...ids);
  const map = {};
  for (const r of evRows) {
    if (!map[r.voter_id]) map[r.voter_id] = [];
    map[r.voter_id].push({ election_name: r.election_name, election_type: r.election_type, party_voted: r.party_voted || '', vote_method: r.vote_method || '' });
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

// Reassign captain to different candidate and/or parent captain
router.put('/captains/:id/reassign', (req, res) => {
  const { candidate_id, parent_captain_id } = req.body;
  const captain = db.prepare('SELECT id, name, candidate_id, parent_captain_id FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });

  // Prevent setting parent to self or own descendant (cycle detection)
  if (parent_captain_id !== undefined && parent_captain_id !== null) {
    // Validate parent exists
    const parentExists = db.prepare('SELECT id FROM captains WHERE id = ?').get(parent_captain_id);
    if (!parentExists) return res.status(404).json({ error: 'Parent captain not found.' });
    // Walk up from proposed parent to make sure we don't hit this captain
    let current = parent_captain_id;
    while (current) {
      if (current === captain.id) return res.status(400).json({ error: 'Cannot move captain under its own descendant.' });
      const row = db.prepare('SELECT parent_captain_id FROM captains WHERE id = ?').get(current);
      current = row ? row.parent_captain_id : null;
    }
  }

  try {
    const doReassign = db.transaction(() => {
      // Update parent_captain_id if provided
      if (parent_captain_id !== undefined) {
        db.prepare('UPDATE captains SET parent_captain_id = ? WHERE id = ?').run(parent_captain_id, captain.id);
      }

      // Update candidate_id if provided — also recursively update all descendants
      if (candidate_id !== undefined) {
        db.prepare('UPDATE captains SET candidate_id = ? WHERE id = ?').run(candidate_id, captain.id);
        // Get all descendant IDs
        const descendants = db.prepare(`
          WITH RECURSIVE subs AS (
            SELECT id FROM captains WHERE parent_captain_id = ?
            UNION ALL
            SELECT c.id FROM captains c JOIN subs s ON c.parent_captain_id = s.id
          ) SELECT id FROM subs
        `).all(captain.id);
        for (const d of descendants) {
          db.prepare('UPDATE captains SET candidate_id = ? WHERE id = ?').run(candidate_id, d.id);
        }

        // Clean up captain_candidates conflicts:
        // If captain is now primary for this candidate, remove the share entry
        db.prepare('DELETE FROM captain_candidates WHERE captain_id = ? AND candidate_id = ?').run(captain.id, candidate_id);
        // Same for all descendants
        for (const d of descendants) {
          db.prepare('DELETE FROM captain_candidates WHERE captain_id = ? AND candidate_id = ?').run(d.id, candidate_id);
        }
      }
    });
    doReassign();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to reassign captain: ' + e.message });
  }

  const parts = [];
  if (candidate_id !== undefined) parts.push('candidate');
  if (parent_captain_id !== undefined) parts.push('parent captain');
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Captain "' + captain.name + '" reassigned (' + parts.join(' & ') + ')'
  );
  res.json({ success: true });
});

// Share captain with additional candidate
router.post('/captains/:id/share', (req, res) => {
  const { candidate_id } = req.body;
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required.' });
  const captain = db.prepare('SELECT id, name, candidate_id FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  if (captain.candidate_id === candidate_id) return res.status(400).json({ error: 'Captain already belongs to this candidate.' });
  const candidate = db.prepare('SELECT id, name FROM candidates WHERE id = ?').get(candidate_id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  try {
    db.prepare('INSERT INTO captain_candidates (captain_id, candidate_id) VALUES (?, ?)').run(captain.id, candidate_id);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already shared with this candidate.' });
    throw e;
  }
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Captain "' + captain.name + '" shared with candidate "' + candidate.name + '"'
  );
  res.json({ success: true });
});

// Unshare captain from candidate
router.delete('/captains/:id/share/:candidateId', (req, res) => {
  const result = db.prepare('DELETE FROM captain_candidates WHERE captain_id = ? AND candidate_id = ?')
    .run(req.params.id, req.params.candidateId);
  if (result.changes === 0) return res.status(404).json({ error: 'Share not found.' });
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Captain share removed');
  res.json({ success: true });
});

// Get candidates a captain is shared with
router.get('/captains/:id/shared-candidates', (req, res) => {
  const shared = db.prepare(`
    SELECT cc.candidate_id, c.name, c.office, cc.shared_at
    FROM captain_candidates cc
    JOIN candidates c ON cc.candidate_id = c.id
    WHERE cc.captain_id = ?
  `).all(req.params.id);
  res.json({ shared });
});

// Admin delete a captain's list (no captain auth required)
router.delete('/captains/:captainId/admin-lists/:listId', (req, res) => {
  const list = db.prepare('SELECT id, name FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.captainId);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('DELETE FROM captain_lists WHERE id = ?').run(list.id);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Admin deleted captain list: ' + list.name);
  res.json({ success: true });
});

// Delete captain (cascades lists via FK, re-parents orphaned sub-captains)
router.delete('/captains/:id', (req, res) => {
  const captain = db.prepare('SELECT id, name, parent_captain_id FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  const removeCaptain = db.transaction(() => {
    // Re-parent sub-captains to this captain's parent (or NULL if top-level), preventing orphans
    db.prepare('UPDATE captains SET parent_captain_id = ? WHERE parent_captain_id = ?').run(captain.parent_captain_id || null, captain.id);
    // Clean up admin lists and shared candidate entries
    db.prepare('UPDATE admin_lists SET assigned_captain_id = NULL WHERE assigned_captain_id = ?').run(captain.id);
    db.prepare('DELETE FROM captain_candidates WHERE captain_id = ?').run(captain.id);
    db.prepare('DELETE FROM captains WHERE id = ?').run(captain.id);
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Block Captain removed: ' + captain.name);
  });
  removeCaptain();
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
  // Include candidate race info for race filter (direct or shared)
  if (captain.candidate_id) {
    const cand = db.prepare('SELECT race_type, race_value FROM candidates WHERE id = ?').get(captain.candidate_id);
    if (cand) { captain.race_type = cand.race_type; captain.race_value = cand.race_value; }
  }
  if (!captain.race_type) {
    const sharedCand = db.prepare("SELECT c.race_type, c.race_value FROM captain_candidates cc JOIN candidates c ON cc.candidate_id = c.id WHERE cc.captain_id = ? AND c.race_type IS NOT NULL AND c.race_type != '' LIMIT 1").get(captain.id);
    if (sharedCand) { captain.race_type = sharedCand.race_type; captain.race_value = sharedCand.race_value; }
  }
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

  // Sub-captain lists — all descendant captains' lists (recursive CTE)
  captain.sub_captain_lists = db.prepare(`
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

// Refresh captain data without consuming login rate limit
router.get('/captains/:id/refresh', requireCaptainAuth, (req, res) => {
  const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  captain.team_members = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ? ORDER BY name').all(captain.id);
  if (captain.candidate_id) {
    const cand = db.prepare('SELECT race_type, race_value FROM candidates WHERE id = ?').get(captain.candidate_id);
    if (cand) { captain.race_type = cand.race_type; captain.race_value = cand.race_value; }
  }
  if (!captain.race_type) {
    const sharedCand = db.prepare("SELECT c.race_type, c.race_value FROM captain_candidates cc JOIN candidates c ON cc.candidate_id = c.id WHERE cc.captain_id = ? AND c.race_type IS NOT NULL AND c.race_type != '' LIMIT 1").get(captain.id);
    if (sharedCand) { captain.race_type = sharedCand.race_type; captain.race_value = sharedCand.race_value; }
  }
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
    SELECT cl.*, COUNT(clv.id) as voter_count, ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ? GROUP BY cl.id ORDER BY cl.created_at DESC
  `).all(captain.id);
  captain.assigned_lists = db.prepare(`
    SELECT al.id, al.name, al.description, al.list_type, COUNT(alv.id) as voter_count
    FROM admin_lists al LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.assigned_captain_id = ? GROUP BY al.id ORDER BY al.created_at DESC
  `).all(captain.id);
  res.json({ success: true, captain });
});

// Admin bulk-upload voters to a captain's list by identifier
// Checks if voters are already on ANY of this captain's lists (de-duplicates)
router.post('/captains/:id/lists/:listId/bulk-upload', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Admin login required.' });
  const captainId = parseInt(req.params.id, 10);
  const listId = parseInt(req.params.listId, 10);
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(listId, captainId);
  if (!list) return res.status(404).json({ error: 'List not found for this captain.' });
  const { identifiers } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });

  // Find all voter IDs already on ANY of this captain's lists
  const existingVoterIds = new Set(
    db.prepare(`
      SELECT DISTINCT clv.voter_id FROM captain_list_voters clv
      JOIN captain_lists cl ON clv.list_id = cl.id
      WHERE cl.captain_id = ?
    `).all(captainId).map(r => r.voter_id)
  );

  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');

  const tx = db.transaction(() => {
    let added = 0, duplicates = 0, alreadyOnList = 0;
    const notFound = [];
    for (const ident of identifiers) {
      const trimmed = String(ident).trim();
      if (!trimmed) continue;
      const voter = lookup.get(trimmed, trimmed, trimmed);
      if (!voter) { notFound.push(trimmed); continue; }
      if (existingVoterIds.has(voter.id)) { alreadyOnList++; continue; }
      const r = insert.run(listId, voter.id);
      if (r.changes > 0) added++; else duplicates++;
    }
    return { added, duplicates, alreadyOnList, notFound, total: identifiers.length };
  });
  const result = tx();
  res.json(result);
});

// Middleware: verify the caller is the captain identified by :id (or an admin, or ancestor captain)
function requireCaptainAuth(req, res, next) {
  const captainId = parseInt(req.params.id, 10);
  if (isNaN(captainId)) return res.status(400).json({ error: 'Invalid captain ID.' });
  // Admin users can access any captain's data
  if (req.session && req.session.userId) return next();
  // Captain portal users must match their session
  if (req.session && req.session.captainId === captainId) return next();
  // Ancestor captains can access any descendant's data (check both directions)
  if (req.session && req.session.captainId) {
    // Walk UP from requested captain — is logged-in captain an ancestor?
    const isAncestor = db.prepare(`
      WITH RECURSIVE ancestors AS (
        SELECT parent_captain_id FROM captains WHERE id = ?
        UNION ALL
        SELECT c.parent_captain_id FROM captains c JOIN ancestors a ON c.id = a.parent_captain_id
        WHERE c.parent_captain_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE parent_captain_id = ?
    `).get(captainId, req.session.captainId);
    if (isAncestor) return next();

    // Walk DOWN from logged-in captain — is requested captain a descendant?
    const isDescendant = db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT id FROM captains WHERE parent_captain_id = ?
        UNION ALL
        SELECT c.id FROM captains c JOIN descendants d ON c.parent_captain_id = d.id
      )
      SELECT 1 FROM descendants WHERE id = ?
    `).get(req.session.captainId, captainId);
    if (isDescendant) return next();

    // Also check if they share the same candidate (team members under same campaign)
    const sameCandidate = db.prepare(`
      SELECT 1 FROM captains a, captains b
      WHERE a.id = ? AND b.id = ? AND a.candidate_id = b.candidate_id AND a.candidate_id IS NOT NULL
    `).get(req.session.captainId, captainId);
    if (sameCandidate) return next();
  }
  return res.status(401).json({ error: 'Captain authentication required. Please log in with your code.' });
}

// Search voters (captain portal) — name search + dedicated filters for phone, vanid, etc.
router.get('/captains/:id/search', requireCaptainAuth, (req, res) => {
  const { q, phone, vanid, city, zip, precinct, address, scope, race } = req.query;
  const hasFilter = phone || vanid || city || zip || precinct || address || race;
  if ((!q || q.trim().length < 2) && !hasFilter) return res.json({ voters: [] });

  // Captains can search the full voter database to build their lists
  const restrictToLists = false;

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
  // Race/district filter: "race_type:race_value" format (e.g. "state_rep:42")
  if (race && race.includes(':')) {
    const [raceType, raceValue] = race.split(':', 2);
    const VALID_RACE_COLS = new Set(['navigation_port','port_authority','city_district','county_commissioner','justice_of_peace','state_board_ed','state_rep','state_senate','us_congress','school_district','college_district','hospital_district']);
    if (VALID_RACE_COLS.has(raceType) && raceValue) {
      conditions.push(raceType + ' = ?');
      params.push(raceValue);
    }
  }

  // Restrict to captain's own voters (from their lists and full descendant tree)
  if (restrictToLists) {
    conditions.push(`id IN (
      SELECT voter_id FROM captain_list_voters WHERE list_id IN (
        SELECT id FROM captain_lists WHERE captain_id = ? OR captain_id IN (
          WITH RECURSIVE team_tree AS (
            SELECT id FROM captains WHERE parent_captain_id = ?
            UNION ALL
            SELECT c.id FROM captains c JOIN team_tree t ON c.parent_captain_id = t.id
          )
          SELECT id FROM team_tree
        )
      )
    )`);
    params.push(req.params.id, req.params.id);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  // Build ORDER BY that prioritizes exact/starts-with matches over contains matches
  let orderClause = 'last_name, first_name';
  if (q && q.trim().length >= 2) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    const orderCases = [];
    const orderParams = [];
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      // Exact match on last_name gets highest priority (score 3)
      orderCases.push("CASE WHEN last_name = ? THEN 3 WHEN last_name LIKE ? ESCAPE '\\' THEN 2 WHEN first_name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END");
      orderParams.push(w, escaped + '%', escaped + '%');
    }
    const priorityExpr = orderCases.join(' + ');
    orderClause = '(' + priorityExpr + ') DESC, last_name, first_name';
    params.push(...orderParams);
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

// Get household members for a voter (same address + same unit)
router.get('/captains/:id/household', requireCaptainAuth, (req, res) => {
  const { voter_id } = req.query;
  if (!voter_id) return res.json({ household: [] });
  const voter = db.prepare('SELECT address, unit, zip, city FROM voters WHERE id = ?').get(voter_id);
  if (!voter || !voter.address) return res.json({ household: [] });

  // Clean address: strip embedded city/state/zip (e.g. "123 MAIN ST BROWNSVILLE TX 78520 -")
  const cleanAddr = (voter.address || '').trim()
    .replace(/\s+(TX|TEXAS)\s+\d{5}.*$/i, '')  // strip "TX 78520 -"
    .replace(/\s+(BROWNSVILLE|HARLINGEN|LOS FRESNOS|PORT ISABEL|SAN BENITO|LAGUNA VISTA|SOUTH PADRE ISLAND|RANCHO VIEJO|MERCEDES|LA FERIA|RIO HONDO|COMBES|OLMITO|SANTA ROSA|SANTA MARIA|BAYVIEW|LOZANO|SEBASTIAN|LYFORD|LOS INDIOS)\s*$/i, '')  // strip city name
    .trim()
    .replace(/\s*-\s*$/, ''); // strip trailing dash

  const voterUnit = (voter.unit || '').trim().toLowerCase();

  // Match by cleaned address + unit
  const candidates = db.prepare(`
    SELECT * FROM voters
    WHERE id != ?
      AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(?)
      AND (
        LOWER(TRIM(address)) = LOWER(?)
        OR LOWER(TRIM(address)) LIKE LOWER(?) || '%'
        OR LOWER(?) LIKE LOWER(TRIM(address)) || '%'
      )
      AND (voter_status = 'ACTIVE' OR voter_status = '' OR voter_status IS NULL)
    ORDER BY last_name, first_name LIMIT 50
  `).all(voter_id, voterUnit, cleanAddr, cleanAddr, cleanAddr);

  // Deduplicate by registration_number
  const seen = new Set();
  const household = candidates.filter(c => {
    const key = (c.registration_number || c.id).toString().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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

  // Include candidate race info for race filter (check direct candidate_id AND shared captain_candidates)
  const captain = db.prepare('SELECT candidate_id FROM captains WHERE id = ?').get(req.params.id);
  let race_type = '', race_value = '';
  if (captain && captain.candidate_id) {
    const cand = db.prepare('SELECT race_type, race_value FROM candidates WHERE id = ?').get(captain.candidate_id);
    if (cand) { race_type = cand.race_type || ''; race_value = cand.race_value || ''; }
  }
  if (!race_type) {
    // Shared captain: look up via captain_candidates
    const sharedCand = db.prepare('SELECT c.race_type, c.race_value FROM captain_candidates cc JOIN candidates c ON cc.candidate_id = c.id WHERE cc.captain_id = ? AND c.race_type IS NOT NULL AND c.race_type != \'\' LIMIT 1').get(req.params.id);
    if (sharedCand) { race_type = sharedCand.race_type || ''; race_value = sharedCand.race_value || ''; }
  }
  res.json({ lists, sub_captain_lists: subCaptainLists, assigned_lists: assignedLists, team_members: teamMembers, sub_captains: subCaptains, race_type, race_value });
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
    SELECT v.*, clv.added_at, clv.parent_voter_id, clv.notes as captain_notes,
      (SELECT ev.party_voted FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_party,
      (SELECT ev.vote_method FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_method
    FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id
    WHERE clv.list_id = ?
    ORDER BY clv.parent_voter_id NULLS FIRST, v.last_name, v.first_name
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

  const voterId = parseInt(voter_id, 10);
  if (isNaN(voterId) || voterId <= 0) return res.status(400).json({ error: 'Invalid voter_id.' });

  if (email && !email.includes('@')) return res.status(400).json({ error: 'Invalid email format.' });

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
      params.push(voterId);
      db.prepare(`UPDATE voters SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Captain ' + req.params.id + ' updated voter ' + voterId + ': ' + updates.map(u => u.split(' =')[0]).join(', '));
    }
  }

  const existing = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, voterId);
  if (existing) return res.json({ success: true, already: true });
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(req.params.listId, voterId);
  res.json({ success: true });
});

// Bulk add voters by registration number and nest under a parent voter
router.post('/captains/:id/lists/:listId/bulk-add-under', requireCaptainAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { identifiers, parent_voter_id } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const listId = req.params.listId;
  const parentOnList = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, parent_voter_id);
  if (!parentOnList) return res.status(400).json({ error: 'Parent voter not on this list.' });
  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id, parent_voter_id) VALUES (?, ?, ?)');
  const setParent = db.prepare('UPDATE captain_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?');
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

// Remove voter from list
router.delete('/captains/:id/lists/:listId/voters/:voterId', requireCaptainAuth, (req, res) => {
  // Verify list belongs to this captain
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('DELETE FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// Set parent voter (group under another voter)
router.put('/captains/:id/lists/:listId/voters/:voterId/parent', requireCaptainAuth, (req, res) => {
  const { parent_voter_id } = req.body;
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const child = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, req.params.voterId);
  const parent = db.prepare('SELECT id, parent_voter_id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, parent_voter_id);
  if (!child || !parent) return res.status(404).json({ error: 'Both voters must be on this list.' });
  if (parent.parent_voter_id) return res.status(400).json({ error: 'Cannot nest under a sub-member.' });
  db.prepare('UPDATE captain_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?').run(parent_voter_id, req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// Remove parent (ungroup)
router.delete('/captains/:id/lists/:listId/voters/:voterId/parent', requireCaptainAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  db.prepare('UPDATE captain_list_voters SET parent_voter_id = NULL WHERE list_id = ? AND voter_id = ?').run(req.params.listId, req.params.voterId);
  res.json({ success: true });
});

// Save captain notes on a voter (personal reminders, how they know them)
router.put('/captains/:id/lists/:listId/voters/:voterId/notes', requireCaptainAuth, (req, res) => {
  const { notes } = req.body;
  const list = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(req.params.listId, req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const row = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.listId, req.params.voterId);
  if (!row) return res.status(404).json({ error: 'Voter not on this list.' });
  db.prepare('UPDATE captain_list_voters SET notes = ? WHERE list_id = ? AND voter_id = ?').run(notes || '', req.params.listId, req.params.voterId);
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

  // Per-row indexed lookups (no bulk load into memory)
  const findByPhone = db.prepare(
    "SELECT id, phone, first_name, last_name, address, city, zip, party, support_level, registration_number FROM voters WHERE phone = ? LIMIT 3"
  );
  const findByReg = db.prepare(
    "SELECT id, phone, first_name, last_name, address, city, zip, party, support_level, registration_number FROM voters WHERE registration_number = ? LIMIT 1"
  );
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

      // Tier 1: Phone match (indexed lookup)
      const digits = phoneDigits(row.phone);
      if (digits.length >= 7) {
        candidates = findByPhone.all(digits);
        if (candidates.length > 0) matchMethod = 'phone';
      }

      // Tier 2: Registration number match (indexed lookup)
      if (candidates.length === 0 && row.registration_number && row.registration_number.trim()) {
        const found = findByReg.get(row.registration_number.trim());
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

  try {
    importTx(rows);
  } catch (err) {
    console.error('Captain CSV import error:', err);
    return res.status(500).json({ error: 'Import failed. Please check your data and try again.' });
  }
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
    SELECT v.*, alv.added_at, alv.parent_voter_id,
      (SELECT ev.party_voted FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_party,
      (SELECT ev.vote_method FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_method
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY alv.parent_voter_id NULLS FIRST, v.last_name, v.first_name
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
      db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Captain ' + req.params.id + ' updated voter ' + voter_id + ': ' + updates.map(u => u.split(' =')[0]).join(', '));
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

// Bulk add voters by ID and nest under a parent (assigned admin lists)
router.post('/captains/:id/assigned-lists/:listId/bulk-add-under', requireCaptainAuth, (req, res) => {
  const list = verifyAssignedList(req.params.id, req.params.listId);
  if (!list) return res.status(404).json({ error: 'Assigned list not found.' });
  const { identifiers, parent_voter_id } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const listId = req.params.listId;
  const parentOnList = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, parent_voter_id);
  if (!parentOnList) return res.status(400).json({ error: 'Parent voter not on this list.' });
  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ? LIMIT 1');
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

// ===================== TEAM MANAGEMENT =====================

// Get all voters across all sub-captain lists (master team view)
router.get('/captains/:id/team-voters', requireCaptainAuth, (req, res) => {
  // Get ALL descendant sub-captain IDs under this captain (recursive)
  const subCaptainIds = db.prepare(`
    WITH RECURSIVE team_tree AS (
      SELECT id FROM captains WHERE parent_captain_id = ?
      UNION ALL
      SELECT c.id FROM captains c JOIN team_tree t ON c.parent_captain_id = t.id
    )
    SELECT id FROM team_tree
  `).all(req.params.id).map(r => r.id);
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

  const doRemove = db.transaction(() => {
    // Delete the team member record
    db.prepare('DELETE FROM captain_team_members WHERE id = ?').run(req.params.memberId);

    // Find matching sub-captain by name AND parent — use LIMIT 1 for safety
    const subCaptain = db.prepare('SELECT id FROM captains WHERE name = ? AND parent_captain_id = ? LIMIT 1').get(member.name, req.params.id);
    if (subCaptain) {
      // Re-parent any sub-sub-captains to the current captain (grandparent) before deleting
      db.prepare('UPDATE captains SET parent_captain_id = ? WHERE parent_captain_id = ?').run(req.params.id, subCaptain.id);
      db.prepare('UPDATE admin_lists SET assigned_captain_id = NULL WHERE assigned_captain_id = ?').run(subCaptain.id);
      db.prepare('DELETE FROM captain_candidates WHERE captain_id = ?').run(subCaptain.id);
      db.prepare('DELETE FROM captains WHERE id = ?').run(subCaptain.id);
    }
  });

  try {
    doRemove();
  } catch (e) {
    console.error('Team member removal error:', e.message);
    return res.status(500).json({ error: 'Failed to remove team member.' });
  }

  res.json({ success: true });
});

// Transfer voters from one captain list to another (target must belong to a sub-captain)
router.post('/captains/:id/transfer-voters', requireCaptainAuth, (req, res) => {
  const captainId = parseInt(req.params.id, 10);
  const { voterIds, targetListId, removeFromSource, sourceListId } = req.body;

  if (!voterIds || !Array.isArray(voterIds) || voterIds.length === 0) {
    return res.status(400).json({ error: 'voterIds array is required. Got: ' + JSON.stringify(voterIds) });
  }
  if (!targetListId) return res.status(400).json({ error: 'targetListId is required. Got: ' + targetListId });
  if (!sourceListId) return res.status(400).json({ error: 'sourceListId is required. Got: ' + sourceListId + '. Make sure a list is selected.' });

  // Validate source and target lists are accessible by this captain
  // Uses broad check: own lists + full descendant tree + same candidate team
  const accessibleCaptains = db.prepare(`
    WITH RECURSIVE team AS (
      SELECT ? as id
      UNION ALL
      SELECT c.id FROM captains c JOIN team t ON c.parent_captain_id = t.id
    )
    SELECT id FROM team
    UNION
    SELECT id FROM captains WHERE candidate_id = (SELECT candidate_id FROM captains WHERE id = ?) AND candidate_id IS NOT NULL
  `).all(captainId, captainId).map(r => r.id);

  const accessibleSet = new Set(accessibleCaptains);

  const sourceList = db.prepare('SELECT cl.id, cl.captain_id FROM captain_lists cl WHERE cl.id = ?').get(sourceListId);
  if (!sourceList || !accessibleSet.has(sourceList.captain_id)) {
    return res.status(404).json({ error: 'Source list not found or not accessible.' });
  }

  const targetList = db.prepare('SELECT cl.id, cl.captain_id FROM captain_lists cl WHERE cl.id = ?').get(targetListId);
  if (!targetList || !accessibleSet.has(targetList.captain_id)) {
    return res.status(404).json({ error: 'Target list not found or not accessible.' });
  }

  const doTransfer = db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');
    let transferred = 0;
    for (const voterId of voterIds) {
      const r = insert.run(targetListId, voterId);
      transferred += r.changes;
    }

    if (removeFromSource) {
      const del = db.prepare('DELETE FROM captain_list_voters WHERE list_id = ? AND voter_id = ?');
      for (const voterId of voterIds) {
        del.run(sourceListId, voterId);
      }
    }

    return transferred;
  });

  try {
    const transferred = doTransfer();
    res.json({ success: true, transferred, removed: !!removeFromSource });
  } catch (e) {
    console.error('Voter transfer error:', e.message);
    res.status(500).json({ error: 'Failed to transfer voters.' });
  }
});

module.exports = router;
