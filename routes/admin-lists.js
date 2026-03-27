const express = require('express');
const router = express.Router();
const db = require('../db');

// List all admin lists with counts and captain assignment info
router.get('/admin-lists', (req, res) => {
  const lists = db.prepare(`
    SELECT al.*,
      COUNT(alv.id) as voterCount,
      SUM(CASE WHEN v.phone != '' AND v.phone IS NOT NULL THEN 1 ELSE 0 END) as withPhone,
      c.name as assigned_captain_name
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    LEFT JOIN voters v ON alv.voter_id = v.id
    LEFT JOIN captains c ON al.assigned_captain_id = c.id
    GROUP BY al.id
    ORDER BY al.id DESC
  `).all();
  for (const l of lists) {
    l.withoutPhone = l.voterCount - (l.withPhone || 0);
  }
  res.json({ lists });
});

// Create a list
router.post('/admin-lists', (req, res) => {
  const { name, description, list_type } = req.body;
  if (!name) return res.status(400).json({ error: 'List name is required.' });
  const result = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)').run(name, description || '', list_type || 'general');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get list detail with voters
router.get('/admin-lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  list.voters = db.prepare(`
    SELECT v.*, alv.added_at, alv.parent_voter_id FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ORDER BY alv.parent_voter_id NULLS FIRST, alv.added_at DESC
  `).all(req.params.id);
  res.json({ list });
});

// Update list
router.put('/admin-lists/:id', (req, res) => {
  const { name, description, list_type } = req.body;
  const result = db.prepare('UPDATE admin_lists SET name = COALESCE(?, name), description = COALESCE(?, description), list_type = COALESCE(?, list_type) WHERE id = ?')
    .run(name, description, list_type, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
  res.json({ success: true });
});

// Assign list to a captain (or unassign with captain_id=null)
router.put('/admin-lists/:id/assign', (req, res) => {
  const { captain_id } = req.body;
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  if (captain_id) {
    const captain = db.prepare('SELECT id, name FROM captains WHERE id = ?').get(captain_id);
    if (!captain) return res.status(404).json({ error: 'Captain not found.' });
    db.prepare('UPDATE admin_lists SET assigned_captain_id = ? WHERE id = ?').run(captain_id, req.params.id);
    res.json({ success: true, captain_name: captain.name });
  } else {
    db.prepare('UPDATE admin_lists SET assigned_captain_id = NULL WHERE id = ?').run(req.params.id);
    res.json({ success: true, captain_name: null });
  }
});

// Delete list
router.delete('/admin-lists/:id', (req, res) => {
  const result = db.prepare('DELETE FROM admin_lists WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'List not found.' });
  res.json({ success: true });
});

// Add voters to list
router.post('/admin-lists/:id/voters', (req, res) => {
  const { voterIds } = req.body;
  if (!voterIds || !voterIds.length) return res.status(400).json({ error: 'No voters provided.' });
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addMany = db.transaction((ids) => {
    let added = 0;
    for (const vid of ids) {
      const r = insert.run(req.params.id, vid);
      if (r.changes > 0) added++;
    }
    return added;
  });
  const added = addMany(voterIds);
  res.json({ success: true, added });
});

// Bulk upload voters by identifier (registration_number, county_file_id, or vanid)
router.post('/admin-lists/:id/bulk-upload', (req, res) => {
  const { identifiers } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const listId = req.params.id;
  const bulkAdd = db.transaction((ids) => {
    let added = 0, duplicates = 0;
    const notFound = [];
    for (const ident of ids) {
      const trimmed = String(ident).trim();
      if (!trimmed) continue;
      const voter = lookup.get(trimmed, trimmed, trimmed);
      if (!voter) { notFound.push(trimmed); continue; }
      const r = insert.run(listId, voter.id);
      if (r.changes > 0) added++; else duplicates++;
    }
    return { added, notFound, duplicates, total: ids.length };
  });
  const result = bulkAdd(identifiers);
  res.json(result);
});

// Remove voter from list
router.delete('/admin-lists/:id/voters/:voterId', (req, res) => {
  // Also unparent any children of this voter
  db.prepare('UPDATE admin_list_voters SET parent_voter_id = NULL WHERE list_id = ? AND parent_voter_id = ?').run(req.params.id, req.params.voterId);
  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(req.params.id, req.params.voterId);
  res.json({ success: true });
});

// Set parent (nest voter under another voter on the same list)
router.put('/admin-lists/:id/voters/:voterId/parent', (req, res) => {
  const { parent_voter_id } = req.body;
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  // Verify both voters are on this list
  const child = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.id, req.params.voterId);
  const parent = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.id, parent_voter_id);
  if (!child || !parent) return res.status(404).json({ error: 'Both voters must be on this list.' });
  // Don't allow nesting under a voter who is already a child
  const parentIsChild = db.prepare('SELECT parent_voter_id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(req.params.id, parent_voter_id);
  if (parentIsChild && parentIsChild.parent_voter_id) {
    return res.status(400).json({ error: 'Cannot nest under a sub-member. Move to a top-level voter.' });
  }
  db.prepare('UPDATE admin_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?').run(parent_voter_id, req.params.id, req.params.voterId);
  res.json({ success: true });
});

// Remove parent (un-nest voter back to top level)
router.delete('/admin-lists/:id/voters/:voterId/parent', (req, res) => {
  db.prepare('UPDATE admin_list_voters SET parent_voter_id = NULL WHERE list_id = ? AND voter_id = ?').run(req.params.id, req.params.voterId);
  res.json({ success: true });
});

// Get list contacts as phone targets (for campaigns, surveys, events)
router.get('/admin-lists/:id/contacts', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const contacts = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.phone, v.email, v.city
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  res.json({ contacts, total: contacts.length, listName: list.name });
});

// Export list as CSV for RumbleUp import (first_name, last_name, phone, city, zip)
router.get('/admin-lists/:id/export-rumbleup', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const mobileOnly = req.query.mobile === '1';
  const phoneFilter = mobileOnly
    ? "AND v.phone_type = 'mobile'"
    : "AND v.phone != '' AND v.phone IS NOT NULL";
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email, v.phone_type
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ${phoneFilter}
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);

  // Build CSV
  const header = 'first_name,last_name,phone,city,zip,email';
  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  const rows = voters.map(v =>
    [v.first_name, v.last_name, v.phone, v.city, v.zip, v.email].map(csvEscape).join(',')
  );
  const csv = header + '\n' + rows.join('\n');

  const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_rumbleup.csv"');
  res.send(csv);
});

// Export mailing list CSV — one row per household (dedup by address)
router.get('/admin-lists/:id/export-mailing-csv', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const households = db.prepare(`
    SELECT
      TRIM(v.address) as address,
      TRIM(v.city) as city,
      COALESCE(TRIM(v.state), 'TX') as state,
      TRIM(v.zip) as zip,
      v.precinct,
      GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
      MIN(v.last_name) as last_name,
      COUNT(*) as household_size
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.address != '' AND v.address IS NOT NULL
    GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
    ORDER BY v.zip, v.city, v.address
  `).all(req.params.id);

  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };

  const header = 'Name,Address,City,State,Zip,Precinct,Household Size';
  const rows = households.map(h => {
    // Use "The [LastName] Family" for multi-person households, full name for single
    const name = h.household_size > 1 ? 'The ' + h.last_name + ' Family' : h.members;
    return [name, h.address, h.city, h.state, h.zip, h.precinct, h.household_size].map(csvEscape).join(',');
  });
  const csv = header + '\n' + rows.join('\n');

  const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_mailing_list.csv"');
  res.send(csv);
});

// Export L2-formatted CSV for phone append service
router.get('/admin-lists/:id/export-l2', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const voters = db.prepare(`
    SELECT v.registration_number, v.county_file_id, v.state_file_id, v.vanid,
           v.first_name, v.middle_name, v.last_name, v.suffix,
           v.address, v.city, COALESCE(v.state, 'TX') as state, v.zip, v.zip4,
           v.phone, v.secondary_phone, v.email,
           v.party, v.precinct, v.phone_type
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);

  if (voters.length === 0) return res.status(404).json({ error: 'No voters in this list' });

  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };

  const header = 'LALVOTERID,COUNTY_FILE_ID,STATE_FILE_ID,VANID,FIRST_NAME,MIDDLE_NAME,LAST_NAME,SUFFIX,ADDRESS,CITY,STATE,ZIP,ZIP4,PHONE,SECONDARY_PHONE,EMAIL,PARTY,PRECINCT,PHONE_STATUS';
  const rows = voters.map(v =>
    [v.registration_number, v.county_file_id, v.state_file_id, v.vanid,
     v.first_name, v.middle_name, v.last_name, v.suffix,
     v.address, v.city, v.state, v.zip, v.zip4,
     v.phone, v.secondary_phone, v.email,
     v.party, v.precinct, v.phone_type].map(csvEscape).join(',')
  );
  const csv = header + '\n' + rows.join('\n');

  const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_l2_phone_append.csv"');
  res.send(csv);
});

// Save VBM matched voters as a mail universe list
router.post('/admin-lists/vbm-save', (req, res) => {
  const { name, voter_ids } = req.body;
  if (!name || !Array.isArray(voter_ids) || voter_ids.length === 0) {
    return res.status(400).json({ error: 'name and voter_ids array required' });
  }

  const saveTx = db.transaction(() => {
    const r = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)').run(
      name, 'Vote by Mail mailing list', 'mail'
    );
    const listId = r.lastInsertRowid;
    const ins = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
    let added = 0;
    for (const vid of voter_ids) {
      const result = ins.run(listId, vid);
      added += result.changes;
    }
    return { listId, added };
  });

  const result = saveTx();
  const householdCount = (db.prepare(`
    SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
    FROM voters v INNER JOIN admin_list_voters alv ON v.id = alv.voter_id WHERE alv.list_id = ?
  `).get(result.listId) || { c: 0 }).c;

  res.json({ success: true, listId: result.listId, added: result.added, households: householdCount });
});

// Get stats for a specific admin list (dashboard view)
router.get('/admin-lists/:id/stats', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const totalVoters = (db.prepare(`
    SELECT COUNT(*) as n FROM admin_list_voters WHERE list_id = ?
  `).get(req.params.id) || { n: 0 }).n;

  const withPhone = (db.prepare(`
    SELECT COUNT(*) as n FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL
  `).get(req.params.id) || { n: 0 }).n;

  const households = (db.prepare(`
    SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as n
    FROM voters v INNER JOIN admin_list_voters alv ON v.id = alv.voter_id WHERE alv.list_id = ?
  `).get(req.params.id) || { n: 0 }).n;

  const earlyVoted = (db.prepare(`
    SELECT COUNT(*) as n FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.early_voted = 1
  `).get(req.params.id) || { n: 0 }).n;

  const partyBreakdown = db.prepare(`
    SELECT COALESCE(v.party, 'Unknown') as party, COUNT(*) as count
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY v.party ORDER BY count DESC
  `).all(req.params.id);

  const supportBreakdown = db.prepare(`
    SELECT COALESCE(v.support_level, 'unknown') as level, COUNT(*) as count
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY v.support_level ORDER BY count DESC
  `).all(req.params.id);

  res.json({
    total_voters: totalVoters,
    with_phone: withPhone,
    households,
    early_voted: earlyVoted,
    party_breakdown: partyBreakdown,
    support_breakdown: supportBreakdown
  });
});

// Get distinct precincts within a list (for precinct sub-filtering)
router.get('/admin-lists/:id/precincts', (req, res) => {
  const list = db.prepare('SELECT id FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const precincts = db.prepare(`
    SELECT v.precinct, COUNT(*) as count,
      SUM(CASE WHEN v.phone != '' AND v.phone IS NOT NULL THEN 1 ELSE 0 END) as withPhone
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.precinct != '' AND v.precinct IS NOT NULL
    GROUP BY v.precinct
    ORDER BY v.precinct
  `).all(req.params.id);
  res.json({ precincts });
});

// Export for mailer — one row per household (dedup by address)
router.get('/admin-lists/:id/export-mailer', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const households = db.prepare(`
    SELECT
      TRIM(v.address) as address,
      TRIM(v.city) as city,
      TRIM(v.zip) as zip,
      v.precinct,
      GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
      COUNT(*) as household_size
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
    ORDER BY v.city, v.address
  `).all(req.params.id);

  res.json({
    list_name: list.name,
    total_voters: households.reduce((s, h) => s + h.household_size, 0),
    total_households: households.length,
    households
  });
});

// Get household summary for a list
router.get('/admin-lists/:id/households', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const households = db.prepare(`
    SELECT
      TRIM(v.address) as address,
      TRIM(COALESCE(v.unit,'')) as unit,
      TRIM(v.city) as city,
      TRIM(v.zip) as zip,
      v.precinct,
      GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
      GROUP_CONCAT(v.id) as voter_ids,
      COUNT(*) as household_size
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
    ORDER BY v.city, v.address
  `).all(req.params.id);

  res.json({ households, total_households: households.length });
});

// Create a block walk from list voters
router.post('/admin-lists/:id/create-walk', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  const { name, split_by_precinct } = req.body || {};

  const voters = db.prepare(`
    SELECT v.id, v.first_name, v.last_name, v.address, v.unit, v.city, v.zip, v.phone, v.precinct
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.address != '' AND v.address IS NOT NULL
    ORDER BY v.precinct, v.address, v.unit, v.last_name
  `).all(req.params.id);

  if (voters.length === 0) return res.status(400).json({ error: 'List has no voters with addresses.' });

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function genCode(len) { let c = ''; for (let i = 0; i < (len||6); i++) c += chars[Math.floor(Math.random() * chars.length)]; return c; }

  const insertAddr = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, unit, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  if (split_by_precinct) {
    // Group voters by precinct, create one walk per precinct
    const byPrecinct = {};
    for (const v of voters) {
      const p = v.precinct || 'Unknown';
      if (!byPrecinct[p]) byPrecinct[p] = [];
      byPrecinct[p].push(v);
    }

    const walks = [];
    const createAll = db.transaction(() => {
      for (const [precinct, pVoters] of Object.entries(byPrecinct)) {
        const joinCode = genCode(4);
        const walkName = (name || list.name) + ' — ' + precinct;
        const walkResult = db.prepare(
          'INSERT INTO block_walks (name, join_code, status, source_precincts) VALUES (?, ?, ?, ?)'
        ).run(walkName, joinCode, 'pending', precinct);
        const walkId = walkResult.lastInsertRowid;

        let i = 0;
        for (const v of pVoters) {
          const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
          insertAddr.run(walkId, v.address, v.unit || '', v.city || '', v.zip || '', voterName, v.id, i++);
        }
        walks.push({ walk_id: walkId, join_code: joinCode, walk_name: walkName, precinct, addresses: i });
      }
    });
    createAll();

    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      'Created ' + walks.length + ' walks from list "' + list.name + '" split by precinct'
    );

    res.json({ success: true, walks, total_walks: walks.length, total_voters: voters.length });
  } else {
    // Single walk with all voters
    const joinCode = genCode(4);
    const walkName = name || ('Walk from: ' + list.name);
    const walkResult = db.prepare(
      'INSERT INTO block_walks (name, join_code, status) VALUES (?, ?, ?)'
    ).run(walkName, joinCode, 'pending');
    const walkId = walkResult.lastInsertRowid;

    let addedAddresses = 0;
    const addAll = db.transaction(() => {
      let i = 0;
      for (const v of voters) {
        const voterName = ((v.first_name || '') + ' ' + (v.last_name || '')).trim();
        insertAddr.run(walkId, v.address, v.unit || '', v.city || '', v.zip || '', voterName, v.id, i++);
        addedAddresses++;
      }
    });
    addAll();

    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      'Walk created from list "' + list.name + '": ' + addedAddresses + ' addresses'
    );

    res.json({
      success: true,
      walk_id: walkId,
      join_code: joinCode,
      walk_name: walkName,
      added_addresses: addedAddresses,
      total_voters: voters.length
    });
  }
});

// ========== FACEBOOK CUSTOM AUDIENCE EXPORT ==========
router.get('/admin-lists/:id/export-facebook', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // Facebook Custom Audience CSV format: email, phone, fn, ln, zip, ct, st, country
  // All values must be lowercase, trimmed. Phone must be digits with country code.
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.email,
           v.address, v.city, COALESCE(v.state, 'TX') as state, v.zip
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);

  if (voters.length === 0) return res.status(404).json({ error: 'No voters in this list.' });

  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };

  const header = 'email,phone,fn,ln,zip,ct,st,country';
  const rows = voters.map(v => {
    const phone = (v.phone || '').replace(/\D/g, '');
    const phoneFormatted = phone.length === 10 ? '1' + phone : phone;
    return [
      (v.email || '').toLowerCase().trim(),
      phoneFormatted,
      (v.first_name || '').toLowerCase().trim(),
      (v.last_name || '').toLowerCase().trim(),
      (v.zip || '').trim().substring(0, 5),
      (v.city || '').toLowerCase().trim(),
      (v.state || 'tx').toLowerCase().trim(),
      'us'
    ].map(csvEscape).join(',');
  });
  const csv = header + '\n' + rows.join('\n');

  const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_facebook_audience.csv"');
  res.send(csv);
});

// ========== OTT / EL TORO / CTV EXPORT ==========
router.get('/admin-lists/:id/export-ott', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // OTT/El Toro format: full address for IP matching
  // They need: First Name, Last Name, Full Address, City, State, Zip
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.address, v.city,
           COALESCE(v.state, 'TX') as state, v.zip, v.phone, v.email,
           v.precinct, v.party, v.gender, v.age
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.address != '' AND v.address IS NOT NULL
    ORDER BY v.zip, v.city, v.address
  `).all(req.params.id);

  if (voters.length === 0) return res.status(404).json({ error: 'No voters with addresses in this list.' });

  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };

  const header = 'first_name,last_name,address,city,state,zip,phone,email,precinct,party,gender,age';
  const rows = voters.map(v => [
    v.first_name, v.last_name, v.address, v.city, v.state,
    (v.zip || '').substring(0, 5), (v.phone || '').replace(/\D/g, ''),
    v.email, v.precinct, v.party, v.gender, v.age
  ].map(csvEscape).join(','));
  const csv = header + '\n' + rows.join('\n');

  const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_ott_targeting.csv"');
  res.send(csv);
});

module.exports = router;
