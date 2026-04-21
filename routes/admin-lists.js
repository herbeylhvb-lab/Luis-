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
    SELECT v.*, alv.added_at, alv.parent_voter_id,
      (SELECT ev.party_voted FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_party,
      (SELECT ev.vote_method FROM election_votes ev WHERE ev.voter_id = v.id AND ev.election_name = 'Primary 2026' LIMIT 1) as p26_method
    FROM admin_list_voters alv
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

// Bulk add voters by registration number and nest under a parent voter
router.post('/admin-lists/:id/bulk-add-under', (req, res) => {
  const { identifiers, parent_voter_id } = req.body;
  if (!identifiers || !identifiers.length) return res.status(400).json({ error: 'No identifiers provided.' });
  if (!parent_voter_id) return res.status(400).json({ error: 'parent_voter_id required.' });
  const listId = req.params.id;

  // Verify parent is on the list
  const parentOnList = db.prepare('SELECT id FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, parent_voter_id);
  if (!parentOnList) return res.status(400).json({ error: 'Parent voter is not on this list.' });

  const lookup = db.prepare('SELECT id FROM voters WHERE registration_number = ? OR county_file_id = ? OR vanid = ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id, parent_voter_id) VALUES (?, ?, ?)');
  const setParent = db.prepare('UPDATE admin_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?');

  const bulkAdd = db.transaction((ids) => {
    let added = 0, duplicates = 0, nested = 0;
    const notFound = [];
    for (const ident of ids) {
      const trimmed = String(ident).trim();
      if (!trimmed) continue;
      const voter = lookup.get(trimmed, trimmed, trimmed);
      if (!voter) { notFound.push(trimmed); continue; }
      const r = insert.run(listId, voter.id, parent_voter_id);
      if (r.changes > 0) { added++; nested++; }
      else {
        // Already on list — just update the parent
        setParent.run(parent_voter_id, listId, voter.id);
        duplicates++;
        nested++;
      }
    }
    return { added, duplicates, nested, notFound, total: ids.length };
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
    : "AND v.phone != '' AND v.phone IS NOT NULL AND COALESCE(v.phone_type,'') NOT IN ('landline','invalid')";
  // Primary phones
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email, v.phone_type
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? ${phoneFilter}
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  // Secondary phones — person appears twice with both numbers
  if (!mobileOnly) {
    const secVoters = db.prepare(`
      SELECT v.first_name, v.last_name, v.secondary_phone as phone, v.city, v.zip, v.email, v.secondary_phone_type as phone_type
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.secondary_phone != '' AND v.secondary_phone IS NOT NULL AND COALESCE(v.secondary_phone_type,'') NOT IN ('landline','invalid')
      ORDER BY v.last_name, v.first_name
    `).all(req.params.id);
    voters.push(...secVoters);
    // Tertiary phones
    const terVoters = db.prepare(`
      SELECT v.first_name, v.last_name, v.tertiary_phone as phone, v.city, v.zip, v.email, v.tertiary_phone_type as phone_type
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.tertiary_phone != '' AND v.tertiary_phone IS NOT NULL AND COALESCE(v.tertiary_phone_type,'') NOT IN ('landline','invalid')
      ORDER BY v.last_name, v.first_name
    `).all(req.params.id);
    voters.push(...terVoters);
  }

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

// Export for SimpleTexting (mass texting platform) — phone, first_name, last_name, city
router.get('/admin-lists/:id/export-simpletext', (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  // Primary phones
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.precinct, v.registration_number
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL AND COALESCE(v.phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  // Secondary phones — person appears twice with both numbers
  const secVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.secondary_phone as phone, v.city, v.zip, v.precinct, v.registration_number
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.secondary_phone != '' AND v.secondary_phone IS NOT NULL AND COALESCE(v.secondary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  voters.push(...secVoters);
  // Tertiary phones — person appears again with third number
  const terVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.tertiary_phone as phone, v.city, v.zip, v.precinct, v.registration_number
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.tertiary_phone != '' AND v.tertiary_phone IS NOT NULL AND COALESCE(v.tertiary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);
  voters.push(...terVoters);

  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  // Phone as digits only (SimpleTexting expects clean numbers)
  const cleanPhone = (p) => (p || '').replace(/\D/g, '');

  const header = 'phone,first_name,last_name,city,zip,precinct,registration_number';
  const rows = voters.map(v =>
    [cleanPhone(v.phone), v.first_name, v.last_name, v.city, v.zip, v.precinct, v.registration_number || ''].map(csvEscape).join(',')
  );
  const csv = header + '\n' + rows.join('\n');

  const safeName = (list.name || 'list').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_simpletext.csv"');
  res.send(csv);
});

// Export mailing list CSV — one row per household (dedup by address)
router.get('/admin-lists/:id/export-mailing-csv', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found.' });

    const households = db.prepare(`
      SELECT
        TRIM(COALESCE(v.mailing_address, v.address, '')) as mail_addr,
        TRIM(v.address) as res_addr,
        TRIM(COALESCE(v.unit, '')) as unit,
        TRIM(COALESCE(v.mailing_city, v.city, '')) as mail_city,
        TRIM(v.city) as res_city,
        COALESCE(TRIM(COALESCE(v.mailing_state, v.state)), 'TX') as state,
        TRIM(COALESCE(v.mailing_zip, v.zip, '')) as mail_zip,
        TRIM(v.zip) as res_zip,
        v.precinct,
        GROUP_CONCAT(v.first_name || ' ' || v.last_name, ', ') as members,
        GROUP_CONCAT(COALESCE(v.registration_number, ''), '; ') as reg_numbers,
        MIN(v.last_name) as last_name,
        COUNT(*) as household_size
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.address != '' AND v.address IS NOT NULL
      GROUP BY LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.unit,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))
      ORDER BY res_zip, res_city, res_addr, unit
    `).all(req.params.id);

    function esc(val) {
      const s = (val || '').toString().replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
    }

    // Clean embedded city/state/zip from address string
    // Handles: "PO BOX 4590 BROWNSVILLE TX 78523 -4590" → "PO BOX 4590"
    // Handles: "341 JOSE MARTI BROWNSVILLE TX 78526 -" → "341 JOSE MARTI"
    function clean(addr) {
      if (!addr) return '';
      let c = addr.trim();
      // Remove pattern: [CITY] TX [ZIP] [-ZIP4] at the end
      c = c.replace(/\s+[A-Z]{2,}\s+TX\s+\d{5}[\s\-]*\d*\s*$/i, '').trim();
      // Also try without city: just " TX 78520 -1234"
      c = c.replace(/\s+TX\s+\d{5}[\s\-]*\d*\s*$/i, '').trim();
      // Remove trailing dash
      c = c.replace(/\s*-\s*$/, '').trim();
      return c;
    }

    const header = 'Name,Address,Unit,City,State,Zip,Precinct,Household Size,Registration Numbers';
    const rows = households.map(h => {
      const name = h.household_size > 1 ? 'The ' + h.last_name + ' Family' : h.members;
      // Use mailing address if different from residential, otherwise residential
      const useMailAddr = h.mail_addr && h.mail_addr !== h.res_addr;
      const addr = clean(useMailAddr ? h.mail_addr : h.res_addr);
      const city = (useMailAddr && h.mail_city) ? h.mail_city : h.res_city;
      const zip = (useMailAddr && h.mail_zip) ? h.mail_zip : h.res_zip;
      // Clean reg numbers: drop empty entries from the GROUP_CONCAT
      const regNums = (h.reg_numbers || '').split(';').map(s => s.trim()).filter(Boolean).join('; ');
      return [name, addr, h.unit, city, h.state, zip, h.precinct, h.household_size, regNums].map(esc).join(',');
    });

    const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_mailing_list.csv"');
    res.send(header + '\n' + rows.join('\n'));
  } catch (e) {
    console.error('[mailing-csv] Error:', e.message);
    res.status(500).json({ error: 'Failed to generate mailing list: ' + e.message });
  }
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

  // 4-CATEGORY WALK STATUS per voter in the universe:
  //
  //   1. direct_contact:    walker talked to THIS voter (voters.support_level recorded)
  //   2. household_contact: walker talked to SOMEONE at this address, but not this
  //                         voter specifically — house was really reached but we
  //                         don't know this voter's personal support level
  //   3. nobody_home:       walker knocked but got no answer
  //   4. not_walked:        no walk record for this address at all
  //
  // The categories are mutually exclusive and partition the universe: total =
  // direct_contact + household_contact + nobody_home + not_walked.
  // "Walked" (any category 1-3) = direct + household + nobody_home.
  const walkFunnel = db.prepare(`
    WITH list_voters AS (
      SELECT
        v.id as voter_id,
        v.early_voted,
        v.support_level,
        LOWER(TRIM(COALESCE(v.address, ''))) as addr,
        LOWER(TRIM(COALESCE(v.unit, ''))) as unit
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ?
    ),
    walked_addrs AS (
      SELECT
        LOWER(TRIM(address)) as addr,
        LOWER(TRIM(COALESCE(unit, ''))) as unit,
        MAX(CASE
          WHEN result IN ('support','lean_support','undecided','lean_oppose','oppose','refused') THEN 3
          WHEN result = 'not_home' THEN 2
          WHEN result IN ('moved','deceased','come_back') THEN 1
          ELSE 0
        END) as status
      FROM walk_addresses
      WHERE result IS NOT NULL AND result != '' AND result != 'not_visited'
      GROUP BY LOWER(TRIM(address)), LOWER(TRIM(COALESCE(unit, '')))
    ),
    classified AS (
      SELECT
        lv.voter_id, lv.early_voted,
        CASE
          -- Direct contact takes priority: if this voter's support_level is
          -- recorded, they were personally walked (even if house_status is null
          -- due to address format differences).
          WHEN lv.support_level IS NOT NULL AND lv.support_level != '' AND lv.support_level != 'unknown'
            THEN 'direct_contact'
          WHEN wa.status = 3 THEN 'household_contact'
          WHEN wa.status = 2 THEN 'nobody_home'
          ELSE 'not_walked'
        END as cat
      FROM list_voters lv
      LEFT JOIN walked_addrs wa ON wa.addr = lv.addr AND wa.unit = lv.unit
    )
    SELECT
      SUM(CASE WHEN cat = 'direct_contact' THEN 1 ELSE 0 END) as direct_contact,
      SUM(CASE WHEN cat = 'household_contact' THEN 1 ELSE 0 END) as household_contact,
      SUM(CASE WHEN cat = 'nobody_home' THEN 1 ELSE 0 END) as nobody_home,
      SUM(CASE WHEN cat = 'not_walked' THEN 1 ELSE 0 END) as not_walked,
      SUM(CASE WHEN early_voted = 1 AND cat = 'direct_contact' THEN 1 ELSE 0 END) as voted_direct_contact,
      SUM(CASE WHEN early_voted = 1 AND cat = 'household_contact' THEN 1 ELSE 0 END) as voted_household_contact,
      SUM(CASE WHEN early_voted = 1 AND cat = 'nobody_home' THEN 1 ELSE 0 END) as voted_nobody_home,
      SUM(CASE WHEN early_voted = 1 AND cat = 'not_walked' THEN 1 ELSE 0 END) as voted_not_walked
    FROM classified
  `).get(req.params.id) || {};

  // Aggregated "walked" counts (any of the 3 walked categories) for the existing
  // stat cards and backward compatibility with earlier consumers.
  const walkedTotal = (walkFunnel.direct_contact || 0) + (walkFunnel.household_contact || 0) + (walkFunnel.nobody_home || 0);
  const walkedContact = (walkFunnel.direct_contact || 0) + (walkFunnel.household_contact || 0);
  const earlyVotedWalked = (walkFunnel.voted_direct_contact || 0) + (walkFunnel.voted_household_contact || 0) + (walkFunnel.voted_nobody_home || 0);
  const earlyVotedContact = (walkFunnel.voted_direct_contact || 0) + (walkFunnel.voted_household_contact || 0);

  // Mailer reach — ADDRESS-LEVEL, with per-household mailer count so we can
  // break down "got 1 mailer", "got 2 mailers", etc. One mailer physically
  // arrives at a household and reaches everyone in the house.
  //
  // Distinct mailers per household = COUNT(DISTINCT notes || '|' || contacted_at)
  // — each log-mailer call writes rows with the same mailer_name ('notes')
  // and same timestamp, so that pair uniquely identifies a mailer drop.
  const mailerPerAddr = db.prepare(`
    SELECT
      LOWER(TRIM(COALESCE(v.address, ''))) as addr,
      LOWER(TRIM(COALESCE(v.unit, ''))) as unit,
      COUNT(DISTINCT vc.notes || '|' || vc.contacted_at) as mailer_count
    FROM voters v
    JOIN voter_contacts vc ON vc.voter_id = v.id
    WHERE vc.contact_type = 'Mailer'
    GROUP BY LOWER(TRIM(COALESCE(v.address, ''))), LOWER(TRIM(COALESCE(v.unit, '')))
  `).all();
  // Build a lookup: address+unit → count
  const mailerByAddr = new Map();
  for (const r of mailerPerAddr) {
    mailerByAddr.set(r.addr + '||' + r.unit, r.mailer_count);
  }
  // Now classify every voter in the universe by their household's mailer count
  const listVoters = db.prepare(`
    SELECT
      v.id, v.early_voted,
      LOWER(TRIM(COALESCE(v.address, ''))) as addr,
      LOWER(TRIM(COALESCE(v.unit, ''))) as unit
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ?
  `).all(req.params.id);
  // Bucket by mailer count: 0 = none, 1 = one mailer, 2 = two, etc.
  const mailerBuckets = new Map();
  let mailerSent = 0;        // total voters who got >=1 mailer
  let earlyVotedMailer = 0;  // early voters who got >=1 mailer
  for (const v of listVoters) {
    const cnt = mailerByAddr.get(v.addr + '||' + v.unit) || 0;
    if (!mailerBuckets.has(cnt)) mailerBuckets.set(cnt, { count: cnt, voters: 0, voted: 0 });
    const b = mailerBuckets.get(cnt);
    b.voters++;
    if (v.early_voted === 1) b.voted++;
    if (cnt > 0) {
      mailerSent++;
      if (v.early_voted === 1) earlyVotedMailer++;
    }
  }
  // Array sorted by mailer count ascending
  const mailerBreakdown = Array.from(mailerBuckets.values()).sort((a, b) => a.count - b.count);

  // RACE-SCOPED counterfactuals — universes are built for a specific race
  // (navigation_port, city_district, state_rep, etc.). Compare early-voter
  // counts against the race's full electorate, not the whole DB.
  //
  // Infer race column+value by testing each known race column: if 95%+ of
  // the universe's voters share the same value, that column is the race.
  // First match wins (ordered most specific → most general).
  const raceColumns = [
    'navigation_port', 'port_authority', 'single_member_city', 'city_district',
    'school_district', 'hospital_district', 'college_district',
    'justice_of_peace', 'county_commissioner', 'constable', 'school_board',
    'city_council', 'water_district', 'drainage_district', 'municipal_utility',
    'court_of_appeals', 'state_board_ed', 'state_rep', 'state_senate', 'us_congress'
  ];
  let detectedRaceCol = null;
  let detectedRaceVal = null;
  for (const col of raceColumns) {
    try {
      const row = db.prepare(`
        SELECT v.${col} as val, COUNT(*) as n
        FROM admin_list_voters alv
        JOIN voters v ON alv.voter_id = v.id
        WHERE alv.list_id = ? AND v.${col} IS NOT NULL AND v.${col} != ''
        GROUP BY v.${col}
        ORDER BY n DESC
        LIMIT 1
      `).get(req.params.id);
      if (row && row.n >= totalVoters * 0.95 && row.val) {
        detectedRaceCol = col;
        detectedRaceVal = row.val;
        break;
      }
    } catch(e) { /* column doesn't exist — ignore */ }
  }

  // District context: total voters, early voters, and early voters NOT in this
  // universe — all scoped to the detected race. Falls back to whole-DB scope
  // if no race was detected (e.g., a hand-built universe across races).
  let districtTotal = 0;
  let districtEarlyVoted = 0;
  let earlyVotedOutsideUniverse = 0;
  if (detectedRaceCol && detectedRaceVal) {
    districtTotal = (db.prepare(`SELECT COUNT(*) as n FROM voters WHERE ${detectedRaceCol} = ?`).get(detectedRaceVal) || { n: 0 }).n;
    districtEarlyVoted = (db.prepare(`SELECT COUNT(*) as n FROM voters WHERE ${detectedRaceCol} = ? AND early_voted = 1`).get(detectedRaceVal) || { n: 0 }).n;
    earlyVotedOutsideUniverse = (db.prepare(`
      SELECT COUNT(*) as n FROM voters v
      WHERE v.${detectedRaceCol} = ? AND v.early_voted = 1
        AND v.id NOT IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)
    `).get(detectedRaceVal, req.params.id) || { n: 0 }).n;
  } else {
    // No race detected — fall back to whole-DB counts
    districtTotal = (db.prepare('SELECT COUNT(*) as n FROM voters').get() || { n: 0 }).n;
    districtEarlyVoted = (db.prepare('SELECT COUNT(*) as n FROM voters WHERE early_voted = 1').get() || { n: 0 }).n;
    earlyVotedOutsideUniverse = (db.prepare(`
      SELECT COUNT(*) as n FROM voters v
      WHERE v.early_voted = 1
        AND v.id NOT IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)
    `).get(req.params.id) || { n: 0 }).n;
  }

  // Support-level breakdown restricted to people who actually voted early.
  // This uses individual voters.support_level (not address-level) because
  // we can't infer Jane's support from her husband John's recorded answer.
  // Only shows levels we explicitly know per-voter.
  const earlyVotedSupportBreakdown = db.prepare(`
    SELECT COALESCE(v.support_level, 'unknown') as level, COUNT(*) as count
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.early_voted = 1
    GROUP BY v.support_level ORDER BY count DESC
  `).all(req.params.id);

  res.json({
    total_voters: totalVoters,
    with_phone: withPhone,
    households,
    early_voted: earlyVoted,

    // 4-category walk status (mutually exclusive, sums to total_voters):
    direct_contact: walkFunnel.direct_contact || 0,          // walker spoke to THIS voter
    household_contact: walkFunnel.household_contact || 0,    // walker spoke to someone at this address, not this voter
    nobody_home: walkFunnel.nobody_home || 0,                // knocked but no answer
    not_walked: walkFunnel.not_walked || 0,                  // no walk record

    // Same 4-way split filtered to early voters only
    voted_direct_contact: walkFunnel.voted_direct_contact || 0,
    voted_household_contact: walkFunnel.voted_household_contact || 0,
    voted_nobody_home: walkFunnel.voted_nobody_home || 0,
    voted_not_walked: walkFunnel.voted_not_walked || 0,

    // Aggregate rollups (any walked = direct + household + nobody_home)
    walked_total: walkedTotal,
    walked_contact: walkedContact,                // spoke with someone in the house (direct OR household)
    walked_not_home: walkFunnel.nobody_home || 0,
    early_voted_walked: earlyVotedWalked,
    early_voted_contact: earlyVotedContact,
    early_voted_not_home: walkFunnel.voted_nobody_home || 0,

    // Mailer reach (address-level halo — same as walk logic)
    mailer_sent: mailerSent,
    early_voted_mailer: earlyVotedMailer,
    // Per-household mailer-count histogram: [{count:0, voters:N, voted:N}, {count:1, ...}, ...]
    mailer_breakdown: mailerBreakdown,

    // District context (race-scoped — inferred from universe contents)
    detected_race_column: detectedRaceCol,
    detected_race_value: detectedRaceVal,
    district_total: districtTotal,
    district_early_voted: districtEarlyVoted,
    // Counterfactual: early voters in this district NOT in this universe
    early_voted_outside: earlyVotedOutsideUniverse,

    // Voter-level breakdowns (individual records, not propagated to household)
    party_breakdown: partyBreakdown,
    support_breakdown: supportBreakdown,
    early_voted_support_breakdown: earlyVotedSupportBreakdown
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

// Log a mailer sent to all voters in a list
// Creates a voter_contact touchpoint (type: Mailer) for each voter
router.post('/admin-lists/:id/log-mailer', (req, res) => {
  const { mailer_name, candidate_id } = req.body;
  if (!mailer_name) return res.status(400).json({ error: 'Mailer name is required.' });

  const list = db.prepare('SELECT id, name FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // Get all voter_ids in this list
  const voters = db.prepare('SELECT voter_id FROM admin_list_voters WHERE list_id = ?').all(req.params.id);
  if (voters.length === 0) return res.status(400).json({ error: 'List has no voters.' });

  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by, contacted_at) VALUES (?, 'Mailer', 'sent', ?, ?, ?)"
  );
  const contactedBy = candidate_id ? 'Candidate #' + candidate_id : 'Admin';
  const logAll = db.transaction(() => {
    let count = 0;
    for (const v of voters) {
      insert.run(v.voter_id, mailer_name, contactedBy, now);
      count++;
    }
    return count;
  });
  const logged = logAll();

  // Log activity
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Mailer "' + mailer_name + '" logged for ' + logged + ' voters from list "' + list.name + '"'
  );

  res.json({ success: true, logged, list_name: list.name, mailer_name });
});

// Get mailer history for a list (or all lists for a candidate)
router.get('/mailer-history', (req, res) => {
  const { candidate_id } = req.query;
  let sql = `
    SELECT notes as mailer_name, contacted_by, contacted_at, COUNT(*) as voter_count
    FROM voter_contacts WHERE contact_type = 'Mailer'
  `;
  const params = [];
  if (candidate_id) {
    sql += " AND contacted_by = ?";
    params.push('Candidate #' + candidate_id);
  }
  sql += ' GROUP BY notes, contacted_at ORDER BY contacted_at DESC';
  const mailers = db.prepare(sql).all(...params);
  res.json({ mailers });
});

// Delete a logged mailer (removes all voter_contacts with that mailer name + timestamp)
router.delete('/mailer-history/:timestamp', (req, res) => {
  const { mailer_name } = req.query;
  if (!mailer_name) return res.status(400).json({ error: 'mailer_name required.' });
  const result = db.prepare("DELETE FROM voter_contacts WHERE contact_type = 'Mailer' AND notes = ? AND contacted_at = ?").run(mailer_name, req.params.timestamp);
  res.json({ success: true, deleted: result.changes });
});

// Retag a mailer to a different candidate
router.put('/mailer-history/:timestamp/retag', (req, res) => {
  const { mailer_name, candidate_id } = req.body;
  if (!mailer_name) return res.status(400).json({ error: 'mailer_name required.' });
  const newTag = candidate_id ? 'Candidate #' + candidate_id : 'Admin';
  const result = db.prepare("UPDATE voter_contacts SET contacted_by = ? WHERE contact_type = 'Mailer' AND notes = ? AND contacted_at = ?").run(newTag, mailer_name, req.params.timestamp);
  res.json({ success: true, updated: result.changes });
});

module.exports = router;
// deploy 1776098577
