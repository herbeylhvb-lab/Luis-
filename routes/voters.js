const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { generateQrToken } = require('../db');
const { phoneDigits, normalizePhone } = require('../utils');
const { queueSync } = require('../lib/google-sheets-sync');

// Fire-and-forget sync after data mutations
function triggerSync(req) {
  if (req.session?.userId) setImmediate(() => queueSync(req.session.userId));
}

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many delete requests, try again later.' } });

// Search/list voters (with engagement scoring)
router.get('/voters', (req, res) => {
  const { q, party, support, precinct, early_voting, city, zip, address, election, election_exclude } = req.query;
  let sql = 'SELECT voters.* FROM voters';
  const params = [];

  // JOIN for "voted in election" filter
  if (election) {
    sql += ' INNER JOIN election_votes ev_inc ON voters.id = ev_inc.voter_id AND ev_inc.election_name = ?';
    params.push(election);
  }
  // Subquery for "did NOT vote in election" filter
  if (election_exclude) {
    sql += ' LEFT JOIN election_votes ev_exc ON voters.id = ev_exc.voter_id AND ev_exc.election_name = ?';
    params.push(election_exclude);
  }

  sql += ' WHERE 1=1';

  if (election_exclude) {
    sql += ' AND ev_exc.id IS NULL';
  }

  if (q) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    for (const w of words) {
      const escaped = w.replace(/[\\%_]/g, '\\$&');
      const term = '%' + escaped + '%';
      sql += " AND (voters.first_name LIKE ? ESCAPE '\\' OR voters.last_name LIKE ? ESCAPE '\\' OR voters.address LIKE ? ESCAPE '\\' OR voters.city LIKE ? ESCAPE '\\' OR voters.phone LIKE ? ESCAPE '\\' OR voters.precinct LIKE ? ESCAPE '\\' OR voters.registration_number LIKE ? ESCAPE '\\' OR voters.vanid LIKE ? ESCAPE '\\' OR voters.county_file_id LIKE ? ESCAPE '\\' OR voters.state_file_id LIKE ? ESCAPE '\\')";
      params.push(term, term, term, term, term, term, term, term, term, term);
    }
  }
  if (party) { sql += ' AND voters.party = ?'; params.push(party); }
  if (support) { sql += ' AND voters.support_level = ?'; params.push(support); }
  if (precinct) { sql += ' AND voters.precinct = ?'; params.push(precinct); }
  if (city) {
    const cityEsc = city.replace(/[\\%_]/g, '\\$&');
    sql += " AND voters.city LIKE ? ESCAPE '\\'"; params.push('%' + cityEsc + '%');
  }
  if (zip) {
    const zipEsc = zip.replace(/[\\%_]/g, '\\$&');
    sql += " AND voters.zip LIKE ? ESCAPE '\\'"; params.push(zipEsc + '%');
  }
  if (address) {
    const addrEsc = address.replace(/[\\%_]/g, '\\$&');
    sql += " AND voters.address LIKE ? ESCAPE '\\'"; params.push('%' + addrEsc + '%');
  }
  if (early_voting === 'voted') { sql += ' AND voters.early_voted = 1'; }
  else if (early_voting === 'not_voted') { sql += ' AND voters.early_voted = 0'; }
  sql += ' ORDER BY voters.last_name, voters.first_name LIMIT 500';
  const voters = db.prepare(sql).all(...params);

  // Compute touchpoint counts and engagement scores in bulk
  const voterIds = voters.map(v => v.id);
  if (voterIds.length > 0) {
    // Contact log counts
    const contactCounts = {};
    const contactRows = db.prepare(
      'SELECT voter_id, COUNT(*) as cnt FROM voter_contacts WHERE voter_id IN (' + voterIds.map(() => '?').join(',') + ') GROUP BY voter_id'
    ).all(...voterIds);
    for (const r of contactRows) contactCounts[r.voter_id] = r.cnt;

    // Event check-in counts
    const checkinCounts = {};
    const checkinRows = db.prepare(
      'SELECT voter_id, COUNT(*) as cnt FROM voter_checkins WHERE voter_id IN (' + voterIds.map(() => '?').join(',') + ') GROUP BY voter_id'
    ).all(...voterIds);
    for (const r of checkinRows) checkinCounts[r.voter_id] = r.cnt;

    // Text message counts (by phone)
    const phonesToVoter = {};
    for (const v of voters) {
      if (v.phone) phonesToVoter[v.phone] = v.id;
    }
    const phones = Object.keys(phonesToVoter);
    const textCounts = {};
    if (phones.length > 0) {
      const textRows = db.prepare(
        'SELECT phone, COUNT(*) as cnt FROM messages WHERE phone IN (' + phones.map(() => '?').join(',') + ') GROUP BY phone'
      ).all(...phones);
      for (const r of textRows) {
        const vid = phonesToVoter[r.phone];
        if (vid) textCounts[vid] = r.cnt;
      }
    }

    // Captain list membership counts (personal relationship = touchpoint)
    const captainListCounts = {};
    const captainRows = db.prepare(
      'SELECT voter_id, COUNT(*) as cnt FROM captain_list_voters WHERE voter_id IN (' + voterIds.map(() => '?').join(',') + ') GROUP BY voter_id'
    ).all(...voterIds);
    for (const r of captainRows) captainListCounts[r.voter_id] = r.cnt;

    // Election participation with party_voted (for turnout tags)
    const electionVotes = {};
    const evRows = db.prepare(
      'SELECT voter_id, election_name, election_type, party_voted FROM election_votes WHERE voter_id IN (' + voterIds.map(() => '?').join(',') + ')'
    ).all(...voterIds);
    for (const r of evRows) {
      if (!electionVotes[r.voter_id]) electionVotes[r.voter_id] = [];
      electionVotes[r.voter_id].push({ election_name: r.election_name, election_type: r.election_type, party_voted: r.party_voted || '' });
    }

    // Attach to each voter
    for (const v of voters) {
      const contacts = contactCounts[v.id] || 0;
      const checkins = checkinCounts[v.id] || 0;
      const texts = textCounts[v.id] || 0;
      const captainLists = captainListCounts[v.id] || 0;
      v.touchpoint_count = contacts + checkins + texts + captainLists;
      // Engagement score: contacts=3pts, events=5pts, texts=1pt, captain list=4pts (personal relationship), cap at 100
      v.engagement_score = Math.min(100, contacts * 3 + checkins * 5 + texts * 1 + captainLists * 4);
      v.election_votes = electionVotes[v.id] || [];
    }
  }

  res.json({ voters });
});

// Add single voter
router.post('/voters', (req, res) => {
  const { first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct } = req.body;
  if (!first_name && !last_name) return res.status(400).json({ error: 'At least first name or last name is required.' });
  const qr_token = generateQrToken();
  const result = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(first_name || '', last_name || '', normalizePhone(phone), email || '', address || '', city || '', zip || '', party || '', support_level || 'unknown', voter_score || 0, tags || '', notes || '', registration_number || '', precinct || '', qr_token);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Bulk import voters
router.post('/voters/import', (req, res) => {
  try {
    const { voters } = req.body;
    if (!voters || !voters.length) return res.status(400).json({ error: 'No voters provided.' });
    const insert = db.prepare(
      'INSERT INTO voters (first_name, last_name, middle_name, suffix, phone, secondary_phone, email, address, city, state, zip, zip4, party, support_level, tags, registration_number, precinct, county_file_id, vanid, address_id, state_file_id, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const customCols = getCustomVoterColumns();
    const importMany = db.transaction((list) => {
      let added = 0;
      for (const v of list) {
        const r = insert.run(v.first_name || '', v.last_name || '', v.middle_name || '', v.suffix || '', normalizePhone(v.phone), normalizePhone(v.secondary_phone), v.email || '', v.address || '', v.city || '', v.state || '', v.zip || '', v.zip4 || '', v.party || '', v.support_level || 'unknown', v.tags || '', v.registration_number || '', v.precinct || '', v.county_file_id || '', v.vanid || '', v.address_id || '', v.state_file_id || '', generateQrToken());
        if (customCols.length > 0) updateCustomFields(r.lastInsertRowid, v, customCols);
        added++;
      }
      return added;
    });
    const added = importMany(voters);
    res.json({ success: true, added });
  } catch (err) {
    console.error('Voter import error:', err);
    res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }
});

// --- Import full county voter file (with election history) ---
// Accepts voter records with election history columns. Upserts by VANID or CountyFileID.
// Election history fields are stored in election_votes table.
router.post('/voters/import-voter-file', (req, res) => {
  try {
    const { voters } = req.body;
    if (!voters || !voters.length) return res.status(400).json({ error: 'No voters provided.' });

    // Election column pattern: matches General24, Primary22Party, MayElection21, NovRunoff13, etc.
    const ELECTION_RE = /^(general|primary|municipal|special|mayelection|mayrunoff|novelection|novrunoff|primaryrunoff|specrunoff)(\d{2})(party)?$/i;

    // Classify election type from prefix
    function electionType(prefix) {
      const p = prefix.toLowerCase();
      if (p === 'general') return 'general';
      if (p === 'primary' || p === 'primaryrunoff') return 'primary';
      if (p === 'municipal') return 'municipal';
      if (p === 'special' || p === 'specrunoff') return 'special';
      if (p === 'mayelection' || p === 'mayrunoff') return 'may';
      if (p === 'novelection' || p === 'novrunoff') return 'november';
      return 'other';
    }

    function electionName(prefix, yr) {
      const p = prefix.toLowerCase();
      const year = yr.length === 2 ? (parseInt(yr) > 50 ? '19' + yr : '20' + yr) : yr;
      const names = {
        'general': 'General ' + year,
        'primary': 'Primary ' + year,
        'primaryrunoff': 'Primary Runoff ' + year,
        'municipal': 'Municipal ' + year,
        'special': 'Special ' + year,
        'specrunoff': 'Special Runoff ' + year,
        'mayelection': 'May Election ' + year,
        'mayrunoff': 'May Runoff ' + year,
        'novelection': 'November Election ' + year,
        'novrunoff': 'November Runoff ' + year
      };
      return names[p] || prefix + ' ' + year;
    }

    // Prepared statements
    const findByVanid = db.prepare("SELECT id FROM voters WHERE vanid = ? AND vanid != '' LIMIT 1");
    const findByCounty = db.prepare("SELECT id FROM voters WHERE county_file_id = ? AND county_file_id != '' LIMIT 1");
    const findByStateFileId = db.prepare("SELECT id FROM voters WHERE state_file_id = ? AND state_file_id != '' LIMIT 1");

    const insertVoter = db.prepare(
      `INSERT INTO voters (first_name, last_name, middle_name, suffix, phone, secondary_phone, email,
        address, city, state, zip, zip4, party, support_level, tags, registration_number, precinct,
        county_file_id, vanid, address_id, state_file_id, qr_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updateVoter = db.prepare(
      `UPDATE voters SET first_name=?, last_name=?, middle_name=?, suffix=?,
        phone=CASE WHEN ?!='' THEN ? ELSE phone END,
        secondary_phone=CASE WHEN ?!='' THEN ? ELSE secondary_phone END,
        address=?, city=?, state=?, zip=?, zip4=?, address_id=?,
        county_file_id=CASE WHEN ?!='' THEN ? ELSE county_file_id END,
        state_file_id=CASE WHEN ?!='' THEN ? ELSE state_file_id END,
        precinct=CASE WHEN ?!='' THEN ? ELSE precinct END,
        party=CASE WHEN ?!='' THEN ? ELSE party END,
        updated_at=datetime('now')
       WHERE id=?`
    );

    const insertVote = db.prepare(
      'INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)'
    );

    // Update party_voted on existing election records (don't destroy election_date with INSERT OR REPLACE)
    const updateVoteParty = db.prepare(
      'UPDATE election_votes SET party_voted = ? WHERE voter_id = ? AND election_name = ?'
    );

    const customCols = getCustomVoterColumns();
    const results = { total: voters.length, added: 0, updated: 0, elections_recorded: 0 };

    const importTx = db.transaction((list) => {
      for (const v of list) {
        let voterId = null;

        // Try to find existing voter by StateFileID, VANID, or CountyFileID
        if (v.state_file_id) {
          const existing = findByStateFileId.get(v.state_file_id);
          if (existing) voterId = existing.id;
        }
        if (!voterId && v.vanid) {
          const existing = findByVanid.get(v.vanid);
          if (existing) voterId = existing.id;
        }
        if (!voterId && v.county_file_id) {
          const existing = findByCounty.get(v.county_file_id);
          if (existing) voterId = existing.id;
        }

        const phone = normalizePhone(v.phone || v.preferred_phone);
        const secondaryPhone = normalizePhone(v.secondary_phone || v.home_phone);

        if (voterId) {
          // Update existing voter
          updateVoter.run(
            v.first_name || '', v.last_name || '', v.middle_name || '', v.suffix || '',
            phone, phone, secondaryPhone, secondaryPhone,
            v.address || '', v.city || '', v.state || '', v.zip || '', v.zip4 || '', v.address_id || '',
            v.county_file_id || '', v.county_file_id || '',
            v.state_file_id || '', v.state_file_id || '',
            v.precinct || '', v.precinct || '',
            v.party || '', v.party || '',
            voterId
          );
          if (customCols.length > 0) updateCustomFields(voterId, v, customCols);
          results.updated++;
        } else {
          // Insert new voter
          const r = insertVoter.run(
            v.first_name || '', v.last_name || '', v.middle_name || '', v.suffix || '',
            phone, secondaryPhone, v.email || '',
            v.address || '', v.city || '', v.state || '', v.zip || '', v.zip4 || '',
            v.party || '', v.support_level || 'unknown', v.tags || '',
            v.registration_number || '', v.precinct || '',
            v.county_file_id || '', v.vanid || '', v.address_id || '', v.state_file_id || '', generateQrToken()
          );
          voterId = r.lastInsertRowid;
          if (customCols.length > 0) updateCustomFields(voterId, v, customCols);
          results.added++;
        }

        // Process election history columns
        const partyData = {}; // e.g. { 'Primary 2024': 'D' }

        for (const [key, val] of Object.entries(v)) {
          if (!val || typeof val !== 'string') continue;
          const m = key.match(ELECTION_RE);
          if (!m) continue;

          const [, prefix, yr, isParty] = m;
          const name = electionName(prefix, yr);
          const fullYear = yr.length === 2 ? (parseInt(yr) > 50 ? '19' + yr : '20' + yr) : yr;

          if (isParty) {
            // This is a party column (e.g., Primary24Party = "D")
            partyData[name] = val.trim();
          } else {
            // This is a participation column — check if voted
            const upper = val.trim().toUpperCase();
            if (upper && upper !== 'N' && upper !== 'NO' && upper !== '0' && upper !== '') {
              const r = insertVote.run(voterId, name, fullYear + '-01-01', electionType(prefix), '');
              if (r.changes > 0) results.elections_recorded++;
            }
          }
        }

        // Apply party data to matching election records
        for (const [name, party] of Object.entries(partyData)) {
          if (party) {
            updateVoteParty.run(party, voterId, name);
          }
        }
      }
    });

    importTx(voters);

    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      `Voter file imported: ${results.added} added, ${results.updated} updated, ${results.elections_recorded} election records`
    );

    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Voter file import error:', err);
    res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }
});

// --- Import canvass data (match existing voters, log contacts, optionally create new) ---
router.post('/voters/import-canvass', (req, res) => {
  const { rows, create_new } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // Pre-build a phone lookup map: digits -> voter {id, support_level}
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address, registration_number FROM voters").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) phoneMap[d] = v.id;
  }
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number) regMap[v.registration_number.trim()] = v.id;
  }

  // Prepared statements
  const updateSupport = db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?");
  const insertContact = db.prepare(
    "INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by, contacted_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertVoter = db.prepare(
    "INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, registration_number, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );

  const results = {
    matched: 0, updated: 0, new_created: 0, skipped: 0, total: rows.length,
    details: { matched_by_phone: 0, matched_by_name_address: 0, matched_by_registration: 0 }
  };

  const importCanvass = db.transaction((rowList) => {
    for (const row of rowList) {
      const digits = phoneDigits(row.phone);
      let voterId = null;
      let matchMethod = '';

      // 1. Phone match
      if (digits.length >= 7 && phoneMap[digits]) {
        voterId = phoneMap[digits];
        matchMethod = 'phone';
      }

      // 2. Registration number match
      if (!voterId && row.registration_number && row.registration_number.trim()) {
        const regId = regMap[row.registration_number.trim()];
        if (regId) { voterId = regId; matchMethod = 'registration'; }
      }

      // 3. Name + address match (first 3 words of address for fuzzy match)
      if (!voterId && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
          if (found) { voterId = found.id; matchMethod = 'name_address'; }
        }
      }

      if (voterId) {
        results.matched++;
        results.details['matched_by_' + matchMethod]++;

        // Update support level if provided
        if (row.support_level && row.support_level !== 'unknown') {
          updateSupport.run(row.support_level, voterId);
          results.updated++;
        }

        // Log contact
        insertContact.run(
          voterId,
          row.contact_type || 'Door-knock',
          row.contact_result || '',
          row.notes || '',
          row.canvasser || 'CSV Import',
          row.canvass_date || new Date().toISOString().split('T')[0]
        );
      } else if (create_new) {
        // Create new voter record
        const newResult = insertVoter.run(
          row.first_name || '', row.last_name || '', normalizePhone(row.phone),
          row.email || '', row.address || '', row.city || '',
          row.zip || '', row.party || '', row.support_level || 'unknown',
          row.registration_number || '', generateQrToken()
        );
        // Log contact for new voter too
        insertContact.run(
          newResult.lastInsertRowid,
          row.contact_type || 'Door-knock',
          row.contact_result || '',
          row.notes || '',
          row.canvasser || 'CSV Import',
          row.canvass_date || new Date().toISOString().split('T')[0]
        );
        results.new_created++;
      } else {
        results.skipped++;
      }
    }
  });

  importCanvass(rows);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Canvass data imported: ' + results.matched + ' matched, ' + results.new_created + ' new, ' + results.skipped + ' skipped'
  );

  res.json({ success: true, ...results });
});

// --- Enrich voter data from purchased lists ---
router.post('/voters/enrich', (req, res) => {
  const { rows, enrich_fields } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // enrich_fields: optional list of field names to enrich (beyond phone). e.g. ['phone','email','custom_col']
  const fieldsToEnrich = enrich_fields || ['phone'];

  const allVoters = db.prepare("SELECT id, first_name, last_name, phone, email, address, registration_number FROM voters").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim()] = v;
    }
  }

  const findByNameAddr = db.prepare(
    "SELECT id, phone, email FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );
  const updatePhone = db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?");

  // Get custom columns for enrichment
  const customCols = getCustomVoterColumns();

  const results = {
    total: rows.length, filled: 0, skipped: 0,
    conflicts: [], unmatched: [],
    match_details: { by_voter_id: 0, by_name_address: 0 },
    custom_fields_updated: 0
  };

  const enrichTx = db.transaction((rowList) => {
    for (const row of rowList) {
      let voter = null;
      let matchMethod = '';

      // 1. Voter ID / registration number match
      if (row.voter_id && row.voter_id.trim()) {
        const found = regMap[row.voter_id.trim()];
        if (found) { voter = found; matchMethod = 'voter_id'; }
      }

      // 2. Name + address fallback
      if (!voter && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
          if (found) { voter = found; matchMethod = 'name_address'; }
        }
      }

      if (!voter) {
        results.unmatched.push({
          first_name: row.first_name || '', last_name: row.last_name || '',
          phone: row.phone || '', address: row.address || '',
          city: row.city || '', zip: row.zip || '', voter_id: row.voter_id || ''
        });
        continue;
      }

      results.match_details['by_' + matchMethod]++;
      const newPhone = (row.phone || '').trim();
      const currentPhone = (voter.phone || '').trim();

      if (!currentPhone && newPhone) {
        updatePhone.run(normalizePhone(newPhone), voter.id);
        results.filled++;
      } else if (currentPhone && newPhone && phoneDigits(currentPhone) !== phoneDigits(newPhone)) {
        results.conflicts.push({
          voter_id: voter.id,
          name: (voter.first_name || row.first_name || '') + ' ' + (voter.last_name || row.last_name || ''),
          current_phone: currentPhone,
          new_phone: newPhone
        });
      } else {
        results.skipped++;
      }

      // Update custom fields and other enrichment fields (email, etc.)
      if (voter.id) {
        // Update email if provided and voter doesn't have one
        if (row.email && row.email.trim()) {
          try {
            db.prepare("UPDATE voters SET email = CASE WHEN email = '' OR email IS NULL THEN ? ELSE email END, updated_at = datetime('now') WHERE id = ?")
              .run(row.email.trim(), voter.id);
          } catch (e) { /* ignore */ }
        }
        // Update any custom columns
        if (customCols.length > 0) {
          let updated = false;
          for (const col of customCols) {
            if (row[col] !== undefined && row[col] !== '') {
              try {
                db.prepare('UPDATE voters SET ' + col + " = CASE WHEN " + col + " = '' OR " + col + " IS NULL THEN ? ELSE " + col + " END WHERE id = ?")
                  .run(row[col], voter.id);
                updated = true;
              } catch (e) { /* column may not exist */ }
            }
          }
          if (updated) results.custom_fields_updated++;
        }
      }
    }
  });

  enrichTx(rows);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Data enrichment: ' + results.filled + ' phones added, ' + results.conflicts.length + ' conflicts, ' + results.unmatched.length + ' unmatched' +
    (results.custom_fields_updated > 0 ? ', ' + results.custom_fields_updated + ' custom fields updated' : '')
  );

  res.json({ success: true, ...results });
});

// Resolve phone conflicts from enrichment
router.post('/voters/enrich/resolve', (req, res) => {
  const { resolutions } = req.body;
  if (!resolutions || !resolutions.length) return res.status(400).json({ error: 'No resolutions provided.' });

  const updatePhone = db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?");
  const resolveTx = db.transaction((list) => {
    let updated = 0;
    for (const r of list) {
      const voterIdInt = parseInt(r.voter_id, 10);
      if (voterIdInt > 0 && r.phone && typeof r.phone === 'string') {
        updatePhone.run(normalizePhone(r.phone), voterIdInt);
        updated++;
      }
    }
    return updated;
  });

  const updated = resolveTx(resolutions);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Enrichment conflicts resolved: ' + updated + ' phone numbers updated'
  );

  res.json({ success: true, updated });
});

// --- QR Code Check-In Endpoints ---
// NOTE: These static-path routes MUST be registered before the /:id wildcard below,
// otherwise Express matches "qr" and "checkins" as :id parameters.

// Look up voter by QR token (public, used by check-in page)
router.get('/voters/qr/:token', (req, res) => {
  const voter = db.prepare("SELECT id, first_name, last_name, qr_token FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  // Get active/upcoming events (today or future, limited to recent)
  const events = db.prepare(`
    SELECT id, title, event_date, event_time, location FROM events
    WHERE status = 'upcoming' AND event_date >= date('now', '-1 day')
    ORDER BY event_date ASC LIMIT 5
  `).all();

  // Get this voter's past check-ins
  const checkins = db.prepare(`
    SELECT vc.event_id, vc.checked_in_at, e.title
    FROM voter_checkins vc JOIN events e ON vc.event_id = e.id
    WHERE vc.voter_id = ? ORDER BY vc.checked_in_at DESC
  `).all(voter.id);

  res.json({ voter: { id: voter.id, first_name: voter.first_name, last_name: voter.last_name }, events, checkins });
});

// Check in a voter to an event via QR token (public endpoint)
router.post('/voters/qr/:token/checkin', (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'Event ID is required.' });

  const voter = db.prepare("SELECT id, first_name, last_name FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Check if already checked in
  const existing = db.prepare('SELECT id FROM voter_checkins WHERE voter_id = ? AND event_id = ?').get(voter.id, event_id);
  if (existing) {
    return res.json({ success: true, already: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
  }

  // Record check-in + auto-log contact
  const checkinTx = db.transaction(() => {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event_id);
    db.prepare(
      'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
    ).run(voter.id, 'Event', 'Attended', 'Checked in via QR at: ' + event.title, 'QR Check-In');
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      voter.first_name + ' ' + voter.last_name + ' checked in via QR to: ' + event.title
    );
  });
  checkinTx();

  res.json({ success: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
});

// --- Volunteer QR Scanner: Scan check-in endpoint ---
router.post('/voters/qr/:token/scan-checkin', (req, res) => {
  const { event_id, scanned_by } = req.body;
  if (!event_id) return res.status(400).json({ error: 'Event ID is required.' });

  const voter = db.prepare("SELECT id, first_name, last_name FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Check if already checked in
  const existing = db.prepare('SELECT id FROM voter_checkins WHERE voter_id = ? AND event_id = ?').get(voter.id, event_id);
  if (existing) {
    return res.json({ success: true, already: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
  }

  // Record check-in + contact log in a transaction
  const scanTx = db.transaction(() => {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event_id);
    db.prepare(
      'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
    ).run(voter.id, 'Event', 'Attended', 'Checked in via QR scan at: ' + event.title, scanned_by || 'QR Scanner');
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      voter.first_name + ' ' + voter.last_name + ' scanned in by ' + (scanned_by || 'volunteer') + ' at: ' + event.title
    );
  });
  scanTx();

  res.json({ success: true, eventTitle: event.title, voterName: voter.first_name + ' ' + voter.last_name });
});

// --- Today's events for volunteer scanner auto-detect ---
router.get('/voters/checkins/today-events', (req, res) => {
  const events = db.prepare(`
    SELECT id, title, event_date, event_time, location FROM events
    WHERE event_date = date('now', 'localtime') AND status IN ('upcoming', 'in_progress')
    ORDER BY event_time ASC
  `).all();
  res.json({ events });
});

// Get check-in stats for an event (admin endpoint)
router.get('/voters/checkins/event/:eventId', (req, res) => {
  const checkins = db.prepare(`
    SELECT vc.*, v.first_name, v.last_name, v.phone
    FROM voter_checkins vc JOIN voters v ON vc.voter_id = v.id
    WHERE vc.event_id = ? ORDER BY vc.checked_in_at DESC
  `).all(req.params.eventId);
  res.json({ checkins, total: checkins.length });
});

// Get all voter columns (must be before :id wildcard)
router.get('/voters/columns', (req, res) => {
  const all = getVoterColumns();
  const custom = all.filter(c => !BUILTIN_VOTER_COLS.has(c));
  res.json({ columns: all, custom_columns: custom });
});

// --- Filter options for universe builder (dynamic distinct values) ---
router.get('/voters/filter-options', (req, res) => {
  const opt = (col) => db.prepare(`SELECT DISTINCT ${col} as v FROM voters WHERE ${col} != '' AND ${col} IS NOT NULL ORDER BY ${col}`).all().map(r => r.v);
  res.json({
    genders: opt('gender'),
    cities: opt('city_district'),
    school_districts: opt('school_district'),
    college_districts: opt('college_district'),
    navigation_ports: opt('navigation_port'),
    port_authorities: opt('port_authority'),
    state_reps: opt('state_rep'),
    state_senates: opt('state_senate'),
    us_congress: opt('us_congress'),
    parties: db.prepare("SELECT DISTINCT party_voted as v FROM election_votes WHERE party_voted != '' AND party_voted IS NOT NULL ORDER BY party_voted").all().map(r => r.v),
    voter_statuses: opt('voter_status'),
  });
});

// Race-to-precinct mapping: which precincts fall under each district/race
router.get('/voters/race-precincts', (req, res) => {
  const mapCol = (col, label) => {
    const rows = db.prepare(`SELECT ${col} as district, GROUP_CONCAT(DISTINCT precinct) as precincts
      FROM voters WHERE ${col} != '' AND ${col} IS NOT NULL AND precinct != '' AND precinct IS NOT NULL
      GROUP BY ${col} ORDER BY ${col}`).all();
    return rows.map(r => ({
      race: label + ': ' + r.district,
      district: r.district,
      type: col,
      precincts: r.precincts.split(',')
    }));
  };
  const races = [
    ...mapCol('navigation_port', 'Navigation Port'),
    ...mapCol('port_authority', 'Port Authority'),
    ...mapCol('city_district', 'City'),
    ...mapCol('school_district', 'School District'),
    ...mapCol('college_district', 'College'),
    ...mapCol('state_rep', 'State Rep'),
    ...mapCol('state_senate', 'State Senate'),
    ...mapCol('us_congress', 'US Congress'),
    ...mapCol('county_commissioner', 'County Commissioner'),
    ...mapCol('justice_of_peace', 'Justice of the Peace'),
  ];
  res.json({ races });
});

// --- Wildcard :id routes MUST come after all static-segment routes above ---

// Get voter detail with contact history and election votes
router.get('/voters/:id', (req, res) => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  voter.contactHistory = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY contacted_at DESC').all(req.params.id);
  voter.election_history = db.prepare('SELECT election_name, election_date, election_type, election_cycle, party_voted FROM election_votes WHERE voter_id = ? ORDER BY election_date DESC').all(req.params.id);
  res.json({ voter });
});

// Toggle a single election vote for a voter
router.post('/voters/:id/election-votes', (req, res) => {
  const voter = db.prepare('SELECT id FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  const { election_name, action } = req.body;
  if (!election_name || !action) return res.status(400).json({ error: 'election_name and action (add/remove) required.' });

  if (action === 'add') {
    // Look up election details from elections table or existing votes
    const elInfo = db.prepare('SELECT election_date, election_type, election_cycle FROM elections WHERE election_name = ?').get(election_name)
      || db.prepare('SELECT election_date, election_type, election_cycle FROM election_votes WHERE election_name = ? LIMIT 1').get(election_name)
      || {};
    db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, election_name, elInfo.election_date || '', elInfo.election_type || '', elInfo.election_cycle || '');
    res.json({ success: true, action: 'added' });
  } else if (action === 'remove') {
    db.prepare('DELETE FROM election_votes WHERE voter_id = ? AND election_name = ?').run(req.params.id, election_name);
    res.json({ success: true, action: 'removed' });
  } else {
    res.status(400).json({ error: 'action must be "add" or "remove".' });
  }
});

// Update voter
router.put('/voters/:id', (req, res) => {
  const { first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct } = req.body;
  const result = db.prepare(`UPDATE voters SET
    first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
    phone = COALESCE(?, phone), email = COALESCE(?, email),
    address = COALESCE(?, address), city = COALESCE(?, city), zip = COALESCE(?, zip),
    party = COALESCE(?, party), support_level = COALESCE(?, support_level),
    voter_score = COALESCE(?, voter_score), tags = COALESCE(?, tags), notes = COALESCE(?, notes),
    registration_number = COALESCE(?, registration_number), precinct = COALESCE(?, precinct),
    updated_at = datetime('now') WHERE id = ?`
  ).run(first_name, last_name, phone ? normalizePhone(phone) : null, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Voter not found.' });
  res.json({ success: true });
});

// Delete voter
router.delete('/voters/:id', (req, res) => {
  const result = db.prepare('DELETE FROM voters WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Voter not found.' });
  res.json({ success: true });
});

// Bulk delete voters
router.post('/voters/bulk-delete', bulkDeleteLimiter, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No voter IDs provided.' });
  const del = db.prepare('DELETE FROM voters WHERE id = ?');
  const bulkDel = db.transaction((list) => {
    let removed = 0;
    for (const id of list) { if (del.run(id).changes > 0) removed++; }
    return removed;
  });
  const removed = bulkDel(ids);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Bulk deleted ' + removed + ' voters');
  res.json({ success: true, removed });
});

// Log a contact attempt
router.post('/voters/:id/contacts', (req, res) => {
  const { contact_type, result, notes, contacted_by } = req.body;
  if (!contact_type) return res.status(400).json({ error: 'Contact type is required.' });
  const voter = db.prepare('SELECT id FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  const r = db.prepare(
    'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, contact_type, result || '', notes || '', contacted_by || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

// --- Voter touchpoint timeline (all interactions: text, email, call, door-knock, event, mailer) ---
router.get('/voters/:id/touchpoints', (req, res) => {
  const voter = db.prepare('SELECT id, first_name, last_name, phone, email FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });

  const touchpoints = [];

  // 1. Voter contacts (door-knocks, calls, mailers, etc.)
  const contacts = db.prepare(
    'SELECT contact_type as type, result, notes, contacted_by, contacted_at as date FROM voter_contacts WHERE voter_id = ? ORDER BY contacted_at DESC'
  ).all(req.params.id);
  for (const c of contacts) {
    touchpoints.push({
      channel: c.type,
      result: c.result,
      notes: c.notes,
      by: c.contacted_by,
      date: c.date
    });
  }

  // 2. Text messages (outbound + inbound by phone)
  if (voter.phone) {
    const texts = db.prepare(
      "SELECT direction, body, timestamp as date FROM messages WHERE phone = ? ORDER BY timestamp DESC LIMIT 50"
    ).all(voter.phone);
    for (const t of texts) {
      touchpoints.push({
        channel: t.direction === 'outbound' ? 'Text Sent' : 'Text Received',
        result: t.direction,
        notes: t.body ? t.body.substring(0, 120) : '',
        by: t.direction === 'outbound' ? 'Campaign' : voter.first_name,
        date: t.date
      });
    }
  }

  // 3. Event check-ins
  const checkins = db.prepare(`
    SELECT e.title, vc.checked_in_at as date FROM voter_checkins vc
    JOIN events e ON vc.event_id = e.id
    WHERE vc.voter_id = ? ORDER BY vc.checked_in_at DESC
  `).all(req.params.id);
  for (const c of checkins) {
    touchpoints.push({
      channel: 'Event',
      result: 'Attended',
      notes: c.title,
      by: '',
      date: c.date
    });
  }

  // 4. Captain list membership (personal relationship)
  const captainLists = db.prepare(`
    SELECT cl.name as list_name, c.name as captain_name, clv.added_at as date
    FROM captain_list_voters clv
    JOIN captain_lists cl ON clv.list_id = cl.id
    JOIN captains c ON cl.captain_id = c.id
    WHERE clv.voter_id = ? ORDER BY clv.added_at DESC
  `).all(req.params.id);
  for (const cl of captainLists) {
    touchpoints.push({
      channel: 'Captain List',
      result: 'Personal Contact',
      notes: cl.list_name,
      by: cl.captain_name,
      date: cl.date
    });
  }

  // Sort all touchpoints by date descending
  touchpoints.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  // Summary counts
  const summary = {};
  for (const tp of touchpoints) {
    summary[tp.channel] = (summary[tp.channel] || 0) + 1;
  }

  res.json({ voter, touchpoints, summary, totalTouchpoints: touchpoints.length });
});

// --- Voter touchpoint stats (aggregate across all voters, single query) ---
const _touchpointStatsQuery = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') as texts,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'Door-knock') as doorKnocks,
    (SELECT COUNT(*) FROM voter_checkins) as events,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'Phone Call') as calls,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'Mailer') as mailers,
    (SELECT COUNT(*) FROM email_campaigns) as emailCampaigns
`);
router.get('/voters-touchpoints/stats', (req, res) => {
  res.json(_touchpointStatsQuery.get());
});

// --- Distinct precincts for filter dropdown ---
router.get('/voters-precincts', (req, res) => {
  // Filter out obvious bad data (phone numbers are 10 digits with no letters)
  // Real precincts: numeric 1-4 digits, or short alphanumeric codes
  const rows = db.prepare(`SELECT precinct, COUNT(*) as cnt FROM voters
    WHERE precinct != '' AND precinct IS NOT NULL
    AND precinct NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'
    GROUP BY precinct ORDER BY CAST(precinct AS INTEGER), precinct`).all();
  const total = db.prepare("SELECT COUNT(*) as c FROM voters").get().c;
  res.json({ precincts: rows.map(r => r.precinct), counts: rows.map(r => r.cnt), total });
});

// Get distinct cities for dropdown filters
router.get('/voters-cities', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT city FROM voters WHERE city != '' ORDER BY city").all();
  res.json({ cities: rows.map(r => r.city) });
});

// --- Precinct analytics (engagement rollup by precinct) ---
router.get('/analytics/precincts', (req, res) => {
  // Get all precincts with voter counts and party breakdown
  const precinctRows = db.prepare(`
    SELECT precinct,
      COUNT(*) as total_voters,
      SUM(CASE WHEN party = 'D' THEN 1 ELSE 0 END) as dem,
      SUM(CASE WHEN party = 'R' THEN 1 ELSE 0 END) as rep,
      SUM(CASE WHEN party NOT IN ('D','R') OR party = '' THEN 1 ELSE 0 END) as other,
      SUM(CASE WHEN support_level IN ('strong_support','lean_support') THEN 1 ELSE 0 END) as supporters,
      SUM(CASE WHEN support_level = 'undecided' THEN 1 ELSE 0 END) as undecided
    FROM voters WHERE precinct != ''
    GROUP BY precinct ORDER BY precinct
  `).all();

  // Compute touchpoints per precinct using JOINs (scalable to 300K+)
  const contactsByPct = db.prepare(`
    SELECT v.precinct, COUNT(vc.id) as c FROM voter_contacts vc
    JOIN voters v ON vc.voter_id = v.id WHERE v.precinct != ''
    GROUP BY v.precinct
  `).all();
  const contactMap = {};
  for (const r of contactsByPct) contactMap[r.precinct] = r.c;

  const checkinsByPct = db.prepare(`
    SELECT v.precinct, COUNT(vck.id) as c FROM voter_checkins vck
    JOIN voters v ON vck.voter_id = v.id WHERE v.precinct != ''
    GROUP BY v.precinct
  `).all();
  const checkinMap = {};
  for (const r of checkinsByPct) checkinMap[r.precinct] = r.c;

  const captainByPct = db.prepare(`
    SELECT v.precinct, COUNT(clv.id) as c FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id WHERE v.precinct != ''
    GROUP BY v.precinct
  `).all();
  const captainMap = {};
  for (const r of captainByPct) captainMap[r.precinct] = r.c;

  for (const p of precinctRows) {
    const contacts = contactMap[p.precinct] || 0;
    const checkins = checkinMap[p.precinct] || 0;
    const captainLists = captainMap[p.precinct] || 0;
    p.total_touchpoints = contacts + checkins + captainLists;
    p.avg_engagement = p.total_voters > 0 ? Math.round((contacts * 3 + checkins * 5 + captainLists * 4) / p.total_voters) : 0;
  }

  res.json({ precincts: precinctRows });
});

// --- Early Voting Tracking ---

// Get early voting stats
router.get('/early-voting/stats', (req, res) => {
  const total = (db.prepare('SELECT COUNT(*) as c FROM voters').get() || { c: 0 }).c;
  const earlyVoted = (db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get() || { c: 0 }).c;
  const remaining = total - earlyVoted;
  const byDate = db.prepare(`
    SELECT early_voted_date as date, COUNT(*) as count
    FROM voters WHERE early_voted = 1 AND early_voted_date IS NOT NULL
    GROUP BY early_voted_date ORDER BY early_voted_date DESC
  `).all();
  const byMethod = db.prepare(`
    SELECT COALESCE(early_voted_method, 'unknown') as method, COUNT(*) as count
    FROM voters WHERE early_voted = 1
    GROUP BY early_voted_method ORDER BY count DESC
  `).all();
  const byPrecinct = db.prepare(`
    SELECT precinct, COUNT(*) as total,
      SUM(CASE WHEN early_voted = 1 THEN 1 ELSE 0 END) as voted
    FROM voters WHERE precinct != ''
    GROUP BY precinct ORDER BY precinct
  `).all();
  const byBallot = db.prepare(`
    SELECT COALESCE(early_voted_ballot, 'Unknown') as ballot, COUNT(*) as count
    FROM voters WHERE early_voted = 1
    GROUP BY early_voted_ballot ORDER BY count DESC
  `).all();
  res.json({ total, earlyVoted, remaining, byDate, byMethod, byPrecinct, byBallot });
});

// Import/update early voting data (bulk — match by registration number, name+address, or phone)
router.post('/early-voting/import', (req, res) => {
  const { rows, vote_date, vote_method, list_type } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });
  const ballotLabel = { dem: 'Democrat', rep: 'Republican', nonpartisan: 'Non-Partisan' }[list_type] || null;

  // Build lookup maps
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address, registration_number, county_file_id, state_file_id FROM voters").all();
  const regMap = {};
  const countyMap = {};
  const stateMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim().toUpperCase()] = v.id;
    }
    if (v.county_file_id && v.county_file_id.trim()) {
      countyMap[v.county_file_id.trim().toUpperCase()] = v.id;
    }
    if (v.state_file_id && v.state_file_id.trim()) {
      stateMap[v.state_file_id.trim().toUpperCase()] = v.id;
    }
  }
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) phoneMap[d] = v.id;
  }
  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );

  const markEarly = db.prepare(
    "UPDATE voters SET early_voted = 1, early_voted_date = COALESCE(?, early_voted_date), early_voted_method = COALESCE(?, early_voted_method), early_voted_ballot = COALESCE(?, early_voted_ballot), updated_at = datetime('now') WHERE id = ?"
  );

  const results = { total: rows.length, matched: 0, already_voted: 0, not_found: 0, details: { by_registration: 0, by_county_file_id: 0, by_state_file_id: 0, by_phone: 0, by_name_address: 0 } };

  const importTx = db.transaction((rowList) => {
    for (const row of rowList) {
      let voterId = null;
      let matchMethod = '';

      // 1. Registration number / VUID match
      const reg = (row.registration_number || row.voter_id || row.vuid || row.reg_num || '').trim().toUpperCase();
      if (reg && regMap[reg]) {
        voterId = regMap[reg];
        matchMethod = 'registration';
      }

      // 2. County File ID match
      if (!voterId) {
        const cfid = (row.county_file_id || row.countyfileid || '').trim().toUpperCase();
        if (cfid && countyMap[cfid]) {
          voterId = countyMap[cfid];
          matchMethod = 'county_file_id';
        }
      }

      // 3. State File ID match
      if (!voterId) {
        const sfid = (row.state_file_id || row.statefileid || row.state_id || '').trim().toUpperCase();
        if (sfid && stateMap[sfid]) {
          voterId = stateMap[sfid];
          matchMethod = 'state_file_id';
        }
      }

      // 4. Phone match
      if (!voterId) {
        const digits = phoneDigits(row.phone);
        if (digits.length >= 7 && phoneMap[digits]) {
          voterId = phoneMap[digits];
          matchMethod = 'phone';
        }
      }

      // 3. Name + address match
      if (!voterId && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
          if (found) { voterId = found.id; matchMethod = 'name_address'; }
        }
      }

      if (voterId) {
        // Check if already marked
        const existing = db.prepare('SELECT early_voted FROM voters WHERE id = ?').get(voterId);
        if (existing && existing.early_voted === 1) {
          results.already_voted++;
        } else {
          const dateVal = row.vote_date || vote_date || new Date().toISOString().split('T')[0];
          const methodVal = row.vote_method || vote_method || 'early';
          markEarly.run(dateVal, methodVal, ballotLabel, voterId);
          results.matched++;
          results.details['by_' + matchMethod]++;
        }
      } else {
        results.not_found++;
      }
    }
  });

  importTx(rows);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Early voting import (' + (ballotLabel || 'General') + ' list): ' + results.matched + ' marked, ' + results.already_voted + ' already voted, ' + results.not_found + ' not found'
  );

  res.json({ success: true, ...results });
});

// Mark individual voter as early voted
router.post('/voters/:id/early-voted', (req, res) => {
  const { vote_date, vote_method } = req.body;
  const voter = db.prepare('SELECT id, first_name, last_name FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  db.prepare(
    "UPDATE voters SET early_voted = 1, early_voted_date = ?, early_voted_method = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(vote_date || new Date().toISOString().split('T')[0], vote_method || 'early', req.params.id);
  res.json({ success: true });
});

// Clear early voted status for a voter
router.delete('/voters/:id/early-voted', (req, res) => {
  const result = db.prepare("UPDATE voters SET early_voted = 0, early_voted_date = NULL, early_voted_method = NULL, early_voted_ballot = NULL, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Voter not found.' });
  res.json({ success: true });
});

// Extract non-early-voters to a new admin list (for continued outreach)
router.post('/early-voting/extract-remaining', (req, res) => {
  const { list_name, precinct, party, support } = req.body;
  const name = list_name || 'GOTV - Not Yet Voted (' + new Date().toISOString().split('T')[0] + ')';

  // Create the admin list
  const listResult = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)').run(
    name, 'Auto-extracted: voters who have not yet voted early', 'text'
  );
  const listId = listResult.lastInsertRowid;

  // Build query for non-early voters
  let sql = 'SELECT id FROM voters WHERE early_voted = 0';
  const params = [];
  if (precinct) { sql += ' AND precinct = ?'; params.push(precinct); }
  if (party) { sql += ' AND party = ?'; params.push(party); }
  if (support) { sql += ' AND support_level = ?'; params.push(support); }

  const voterIds = db.prepare(sql).all(...params).map(v => v.id);

  // Add to list
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addTx = db.transaction((ids) => {
    let added = 0;
    for (const vid of ids) {
      const r = insert.run(listId, vid);
      if (r.changes > 0) added++;
    }
    return added;
  });
  const added = addTx(voterIds);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'GOTV list created: "' + name + '" with ' + added + ' voters who have not voted early'
  );

  res.json({ success: true, listId, listName: name, added, total: voterIds.length });
});

// Reset all early voting data (for testing or new cycle — requires confirmation)
router.post('/early-voting/reset', (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Destructive action: pass { "confirm": true } to confirm reset of all early voting data.' });
  }
  const count = (db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get() || { c: 0 }).c;
  db.prepare("UPDATE voters SET early_voted = 0, early_voted_date = NULL, early_voted_method = NULL, early_voted_ballot = NULL, updated_at = datetime('now')").run();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Early voting data reset: ' + count + ' voters cleared');
  res.json({ success: true, cleared: count });
});

// --- Custom Voter Columns ---

// Known built-in columns that should not be treated as custom
const BUILTIN_VOTER_COLS = new Set([
  'id', 'first_name', 'last_name', 'middle_name', 'suffix', 'phone', 'secondary_phone',
  'email', 'address', 'city', 'state', 'zip', 'zip4', 'party', 'support_level',
  'voter_score', 'tags', 'notes', 'created_at', 'updated_at', 'registration_number',
  'county_file_id', 'vanid', 'address_id', 'precinct', 'voting_history',
  'early_voted', 'early_voted_date', 'early_voted_method', 'early_voted_ballot', 'qr_token',
  'state_file_id'
]);

// Get all column names from the voters table
function getVoterColumns() {
  const cols = db.prepare("PRAGMA table_info(voters)").all();
  return cols.map(c => c.name);
}

// Get custom (non-built-in) columns
function getCustomVoterColumns() {
  return getVoterColumns().filter(c => !BUILTIN_VOTER_COLS.has(c));
}

// Create a new custom column on the voters table
router.post('/voters/custom-columns', (req, res) => {
  const { column_name } = req.body;
  if (!column_name) return res.status(400).json({ error: 'column_name is required.' });

  // Sanitize: only allow alphanumeric + underscores, must start with letter
  const clean = column_name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').replace(/_+/g, '_').replace(/_$/, '');
  if (!clean || clean.length < 2) return res.status(400).json({ error: 'Invalid column name. Must be at least 2 characters, start with a letter, and contain only letters, numbers, and underscores.' });

  // Check if it already exists
  const existing = getVoterColumns();
  if (existing.includes(clean)) return res.json({ success: true, column_name: clean, already_exists: true });

  try {
    db.exec('ALTER TABLE voters ADD COLUMN ' + clean + " TEXT DEFAULT ''");
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Custom voter column created: ' + clean);
    res.json({ success: true, column_name: clean, created: true });
  } catch (e) {
    if (e.message && e.message.includes('duplicate column name')) {
      return res.json({ success: true, column_name: clean, already_exists: true });
    }
    res.status(500).json({ error: 'Failed to create column: ' + e.message });
  }
});

// Delete a custom column — SQLite doesn't support DROP COLUMN easily, so we just document this
// In practice custom columns stay once created

// Helper: update custom fields on a voter after standard insert/update
function updateCustomFields(voterId, voterData, customCols) {
  if (!customCols || customCols.length === 0) return;
  for (const col of customCols) {
    if (voterData[col] !== undefined && voterData[col] !== '') {
      try {
        db.prepare('UPDATE voters SET ' + col + ' = ? WHERE id = ?').run(voterData[col], voterId);
      } catch (e) { /* column may not exist yet, skip */ }
    }
  }
}

// --- Universe Builder: Election History Import & Segmentation ---

// Import election participation data (CSV with voter + which elections they voted in)
router.post('/election-votes/import', (req, res) => {
  const { rows, elections } = req.body;
  // Two modes:
  // A) `elections` array: each row is a voter, elections are column headers mapped to election names
  //    { rows: [{registration_number, first_name, last_name, address, nov_2024: "Y", mar_2024: "Y"...}],
  //      elections: [{column: "nov_2024", name: "November 2024 General", date: "2024-11-05", type: "general", cycle: "november"}] }
  // B) Simple: each row has election_name, election_date, + voter identifiers

  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // Build voter lookup maps
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address, registration_number FROM voters").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim().toUpperCase()] = v.id;
    }
  }
  const phoneMapLocal = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) phoneMapLocal[d] = v.id;
  }
  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );

  const insertVote = db.prepare(
    'INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)'
  );

  const results = { total: rows.length, matched: 0, not_found: 0, votes_recorded: 0 };

  function matchVoter(row) {
    // 1. Registration
    const reg = (row.registration_number || row.voter_id || row.vuid || row.reg_num || '').trim().toUpperCase();
    if (reg && regMap[reg]) return regMap[reg];
    // 2. Phone
    const digits = phoneDigits(row.phone);
    if (digits.length >= 7 && phoneMapLocal[digits]) return phoneMapLocal[digits];
    // 3. Name+address
    if (row.first_name && row.last_name && row.address) {
      const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
      if (addrWords) {
        const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
        if (found) return found.id;
      }
    }
    return null;
  }

  const importTx = db.transaction(() => {
    if (elections && elections.length > 0) {
      // Mode A: election columns in the CSV
      for (const row of rows) {
        const voterId = matchVoter(row);
        if (!voterId) { results.not_found++; continue; }
        results.matched++;
        for (const el of elections) {
          const val = (row[el.column] || '').trim().toUpperCase();
          if (val === 'Y' || val === 'YES' || val === '1' || val === 'X' || val === 'V') {
            const r = insertVote.run(voterId, el.name, el.date || '', el.type || 'general', el.cycle || '');
            if (r.changes > 0) results.votes_recorded++;
          }
        }
      }
    } else {
      // Mode B: each row has election_name
      for (const row of rows) {
        const voterId = matchVoter(row);
        if (!voterId) { results.not_found++; continue; }
        results.matched++;
        if (row.election_name) {
          const r = insertVote.run(voterId, row.election_name, row.election_date || '', row.election_type || 'general', row.election_cycle || '');
          if (r.changes > 0) results.votes_recorded++;
        }
      }
    }
  });

  importTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Election history imported: ' + results.matched + ' voters matched, ' + results.votes_recorded + ' vote records added'
  );

  res.json({ success: true, ...results });
});

// Import turnout list from county (match by State File ID / registration_number / county_file_id / vanid)
// For primaries: party_voted = 'R' or 'D'. For nonpartisan races: party_voted = '' (shown as blue tag).
router.post('/election-votes/import-turnout', (req, res) => {
  const { rows, election_name, election_date, election_type, party_voted } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });
  if (!election_name) return res.status(400).json({ error: 'Election name is required.' });

  // Build lookup maps for matching by state_file_id, registration_number, county_file_id, vanid
  const allVoters = db.prepare("SELECT id, state_file_id, registration_number, county_file_id, vanid FROM voters").all();
  const stateFileMap = {};
  const regMap = {};
  const countyMap = {};
  const vanidMap = {};
  for (const v of allVoters) {
    const sfid = (v.state_file_id || '').trim().toUpperCase();
    if (sfid) stateFileMap[sfid] = v.id;
    const reg = (v.registration_number || '').trim().toUpperCase();
    if (reg) regMap[reg] = v.id;
    const cfid = (v.county_file_id || '').trim().toUpperCase();
    if (cfid) countyMap[cfid] = v.id;
    const vid = (v.vanid || '').trim().toUpperCase();
    if (vid) vanidMap[vid] = v.id;
  }

  const insertVote = db.prepare(
    'INSERT OR REPLACE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle, party_voted, voted) VALUES (?, ?, ?, ?, ?, ?, 1)'
  );

  // Ensure election definition exists
  try {
    db.prepare('INSERT OR IGNORE INTO elections (election_name, election_date, election_type) VALUES (?, ?, ?)')
      .run(election_name, election_date || '', election_type || 'general');
  } catch (e) { /* already exists */ }

  const results = { total: rows.length, matched: 0, not_found: 0, votes_recorded: 0,
    details: { by_state_file_id: 0, by_registration: 0, by_county_file_id: 0, by_vanid: 0 } };

  const importTx = db.transaction(() => {
    for (const row of rows) {
      let voterId = null;
      let matchMethod = '';

      // Normalize the ID field from the row (could be any column name)
      const id = (row.state_file_id || row.statefileid || row.voter_id || row.voterid ||
                  row.registration_number || row.reg_num || row.county_file_id || row.countyfileid ||
                  row.vanid || row.van_id || '').trim().toUpperCase();

      if (!id) { results.not_found++; continue; }

      // Try matching in priority order: state_file_id, registration_number, county_file_id, vanid
      if (stateFileMap[id]) { voterId = stateFileMap[id]; matchMethod = 'state_file_id'; }
      else if (regMap[id]) { voterId = regMap[id]; matchMethod = 'registration'; }
      else if (countyMap[id]) { voterId = countyMap[id]; matchMethod = 'county_file_id'; }
      else if (vanidMap[id]) { voterId = vanidMap[id]; matchMethod = 'vanid'; }

      if (!voterId) { results.not_found++; continue; }

      // Determine party_voted: row-level overrides global, default to global
      const rowParty = (row.party_voted || row.party || '').trim().toUpperCase();
      let partyVal = party_voted || '';
      if (rowParty === 'R' || rowParty === 'REP' || rowParty === 'REPUBLICAN') partyVal = 'R';
      else if (rowParty === 'D' || rowParty === 'DEM' || rowParty === 'DEMOCRAT' || rowParty === 'DEMOCRATIC') partyVal = 'D';

      const r = insertVote.run(voterId, election_name, election_date || '', election_type || 'general', '', partyVal);
      if (r.changes > 0) results.votes_recorded++;
      results.matched++;
      if (matchMethod) results.details['by_' + matchMethod]++;
    }
  });

  importTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Turnout list imported for ' + election_name + ': ' + results.matched + ' matched, ' + results.votes_recorded + ' recorded, ' + results.not_found + ' not found'
  );

  res.json({ success: true, ...results });
});

// Get all distinct elections in the database
router.get('/election-votes/elections', (req, res) => {
  // Combine election definitions with actual vote data so empty elections still appear
  const elections = db.prepare(`
    SELECT election_name, election_date, election_type, election_cycle, voter_count
    FROM (
      SELECT election_name, election_date, election_type, election_cycle, COUNT(DISTINCT voter_id) as voter_count
      FROM election_votes
      GROUP BY election_name
      UNION ALL
      SELECT e.election_name, e.election_date, e.election_type, e.election_cycle, 0 as voter_count
      FROM elections e
      WHERE e.election_name NOT IN (SELECT DISTINCT election_name FROM election_votes)
    )
    ORDER BY election_date DESC
  `).all();
  res.json({ elections });
});

// Create a new election definition
router.post('/elections', (req, res) => {
  const { name, date, type, cycle } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'Election name and date are required.' });
  try {
    db.prepare('INSERT INTO elections (election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?)')
      .run(name.trim(), date, type || 'general', cycle || '');
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Election created: ' + name.trim());
    res.json({ success: true });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'An election with that name already exists.' });
    throw e;
  }
});

// Delete an election definition and all its vote records
router.delete('/elections/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  db.prepare('DELETE FROM elections WHERE election_name = ?').run(name);
  const result = db.prepare('DELETE FROM election_votes WHERE election_name = ?').run(name);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Election deleted: ' + name + ' (' + result.changes + ' vote records removed)');
  res.json({ success: true, votes_removed: result.changes });
});

// Bulk mark voters as voted in an election
router.post('/election-votes/bulk', (req, res) => {
  const { voter_ids, election_name, election_date, election_type, election_cycle } = req.body;
  if (!voter_ids || !voter_ids.length || !election_name) return res.status(400).json({ error: 'voter_ids and election_name are required.' });
  const insert = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)');
  const addMany = db.transaction((ids) => {
    let added = 0;
    for (const vid of ids) {
      const r = insert.run(vid, election_name, election_date || '', election_type || 'general', election_cycle || '');
      if (r.changes > 0) added++;
    }
    return added;
  });
  const added = addMany(voter_ids);
  res.json({ success: true, added });
});

// Bulk unmark voters from an election
router.post('/election-votes/bulk-remove', (req, res) => {
  const { voter_ids, election_name } = req.body;
  if (!voter_ids || !voter_ids.length || !election_name) return res.status(400).json({ error: 'voter_ids and election_name are required.' });
  const del = db.prepare('DELETE FROM election_votes WHERE voter_id = ? AND election_name = ?');
  const removeMany = db.transaction((ids) => {
    let removed = 0;
    for (const vid of ids) {
      const r = del.run(vid, election_name);
      if (r.changes > 0) removed++;
    }
    return removed;
  });
  const removed = removeMany(voter_ids);
  res.json({ success: true, removed });
});

// --- Universe Builder: Step-by-step segmentation ---
// Uses temp tables to avoid SQLite bind parameter limits at scale (300K+ voters)

// Build the WHERE clause + params for Step 1 (precincts + demographic/district filters)
function buildStep1Filter(filters) {
  const clauses = [];
  const params = [];
  const { precincts, genders, age_min, age_max, cities, school_districts, college_districts,
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses } = filters;

  // Handle precincts: "*" means all, string with GLOB means LIKE, array means IN
  if (precincts && precincts !== '*') {
    const pArr = Array.isArray(precincts) ? precincts : [precincts];
    if (pArr.length === 1 && (pArr[0].includes('*') || pArr[0].includes('?'))) {
      // GLOB pattern: convert * to % and ? to _ for SQL LIKE
      clauses.push('precinct LIKE ?');
      params.push(pArr[0].replace(/\*/g, '%').replace(/\?/g, '_'));
    } else if (pArr.length > 0) {
      clauses.push('precinct IN (' + pArr.map(() => '?').join(',') + ')');
      params.push(...pArr);
    }
  }
  if (genders && genders.length > 0) {
    clauses.push('gender IN (' + genders.map(() => '?').join(',') + ')');
    params.push(...genders);
  }
  if (age_min != null) { clauses.push('age >= ?'); params.push(age_min); }
  if (age_max != null) { clauses.push('age <= ?'); params.push(age_max); }
  if (cities && cities.length > 0) {
    clauses.push('city_district IN (' + cities.map(() => '?').join(',') + ')');
    params.push(...cities);
  }
  if (school_districts && school_districts.length > 0) {
    clauses.push('school_district IN (' + school_districts.map(() => '?').join(',') + ')');
    params.push(...school_districts);
  }
  if (college_districts && college_districts.length > 0) {
    clauses.push('college_district IN (' + college_districts.map(() => '?').join(',') + ')');
    params.push(...college_districts);
  }
  if (navigation_ports && navigation_ports.length > 0) {
    clauses.push('navigation_port IN (' + navigation_ports.map(() => '?').join(',') + ')');
    params.push(...navigation_ports);
  }
  if (port_authorities && port_authorities.length > 0) {
    clauses.push('port_authority IN (' + port_authorities.map(() => '?').join(',') + ')');
    params.push(...port_authorities);
  }
  if (state_reps && state_reps.length > 0) {
    clauses.push('state_rep IN (' + state_reps.map(() => '?').join(',') + ')');
    params.push(...state_reps);
  }
  if (us_congress && us_congress.length > 0) {
    clauses.push('us_congress IN (' + us_congress.map(() => '?').join(',') + ')');
    params.push(...us_congress);
  }
  if (voter_statuses && voter_statuses.length > 0) {
    clauses.push('voter_status IN (' + voter_statuses.map(() => '?').join(',') + ')');
    params.push(...voter_statuses);
  }

  // Minimum elections filter: only voters who voted in at least N distinct elections
  if (min_elections != null && min_elections > 0) {
    clauses.push('voters.id IN (SELECT voter_id FROM election_votes GROUP BY voter_id HAVING COUNT(DISTINCT election_name) >= ?)');
    params.push(min_elections);
  }

  // Party filter requires a join to election_votes (voted DEM or REP in any primary)
  let partyJoin = '';
  if (parties && parties.length > 0) {
    partyJoin = ' INNER JOIN election_votes ev_party ON voters.id = ev_party.voter_id AND ev_party.party_voted IN (' + parties.map(() => '?').join(',') + ')';
    params.push(...parties);
  }

  return { where: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params, partyJoin };
}

router.post('/universe/build', (req, res) => {
  const { precincts, years_back, election_cycles, priority_elections,
          list_name_universe, list_name_sub, list_name_priority,
          genders, age_min, age_max, cities, school_districts, college_districts,
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses } = req.body;
  const cutoffYear = new Date().getFullYear() - (years_back || 8);
  const cutoffDate = cutoffYear + '-01-01';

  const step1 = buildStep1Filter({ precincts, genders, age_min, age_max, cities,
    school_districts, college_districts, navigation_ports, port_authorities,
    state_reps, us_congress, parties, min_elections, voter_statuses });

  // Check if election data exists
  const hasElectionData = (db.prepare('SELECT COUNT(*) as c FROM election_votes').get() || { c: 0 }).c > 0;

  const buildTx = db.transaction(() => {
    // Step 1: filtered voters -> temp table
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO _univ_precinct SELECT DISTINCT voters.id FROM voters' + step1.partyJoin + ' WHERE ' + step1.where).run(...step1.params);
    const totalInPrecincts = (db.prepare('SELECT COUNT(*) as c FROM _univ_precinct').get() || { c: 0 }).c;

    // Basic mode: no election data — use all Step 1 voters as the universe
    if (!hasElectionData) {
      const insertList = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)');
      const created = {};
      if (list_name_universe) {
        const r = insertList.run(list_name_universe, 'All registered voters matching filters', 'general');
        const listId = r.lastInsertRowid;
        const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_precinct').run(listId);
        created.universe = { listId, added: added.changes };
      }
      db.exec('DROP TABLE IF EXISTS _univ_precinct');
      return { totalInPrecincts, universeCount: totalInPrecincts, subUniverseCount: totalInPrecincts, priorityCount: 0, extraCount: totalInPrecincts, created, basicMode: true };
    }

    // Step 2: universe — voted in last N years
    db.exec('DROP TABLE IF EXISTS _univ_universe');
    db.exec('CREATE TEMP TABLE _univ_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_precinct up ON ev.voter_id = up.voter_id
      WHERE ev.election_date >= ?`).run(cutoffDate);
    const universeCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_universe').get() || { c: 0 }).c;

    // Step 3: sub-universe — voted in specific cycles
    db.exec('DROP TABLE IF EXISTS _univ_sub');
    let subUniverseCount;
    if (election_cycles && election_cycles.length > 0) {
      db.exec('CREATE TEMP TABLE _univ_sub (voter_id INTEGER PRIMARY KEY)');
      const cPh = election_cycles.map(() => '?').join(',');
      db.prepare(`INSERT INTO _univ_sub
        SELECT DISTINCT ev.voter_id FROM election_votes ev
        INNER JOIN _univ_universe uu ON ev.voter_id = uu.voter_id
        WHERE ev.election_cycle IN (${cPh})`).run(...election_cycles);
      subUniverseCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_sub').get() || { c: 0 }).c;
    } else {
      db.exec('CREATE TEMP TABLE _univ_sub AS SELECT * FROM _univ_universe');
      subUniverseCount = universeCount;
    }

    // Step 4: priority — voted in specific elections
    db.exec('DROP TABLE IF EXISTS _univ_priority');
    let priorityCount = 0;
    if (priority_elections && priority_elections.length > 0) {
      db.exec('CREATE TEMP TABLE _univ_priority (voter_id INTEGER PRIMARY KEY)');
      const pPh = priority_elections.map(() => '?').join(',');
      db.prepare(`INSERT INTO _univ_priority
        SELECT DISTINCT ev.voter_id FROM election_votes ev
        INNER JOIN _univ_sub us ON ev.voter_id = us.voter_id
        WHERE ev.election_name IN (${pPh})`).run(...priority_elections);
      priorityCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_priority').get() || { c: 0 }).c;
    } else {
      db.exec('CREATE TEMP TABLE _univ_priority (voter_id INTEGER PRIMARY KEY)');
    }

    const extraCount = subUniverseCount - priorityCount;

    // Create lists via INSERT...SELECT for efficiency
    const insertList = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)');
    const created = {};

    if (list_name_universe) {
      const r = insertList.run(list_name_universe, 'Universe: voters in precincts who voted in last ' + (years_back || 8) + ' years', 'general');
      const listId = r.lastInsertRowid;
      const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_universe').run(listId);
      created.universe = { listId, added: added.changes };
    }
    if (list_name_sub) {
      const r = insertList.run(list_name_sub, 'Sub-universe: voters who voted in ' + (election_cycles || []).join(', ') + ' elections', 'general');
      const listId = r.lastInsertRowid;
      const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_sub').run(listId);
      created.sub_universe = { listId, added: added.changes };
    }
    if (list_name_priority) {
      const r = insertList.run(list_name_priority, 'Priority: voters who voted in ' + (priority_elections || []).join(', '), 'general');
      const listId = r.lastInsertRowid;
      const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_priority').run(listId);
      created.priority = { listId, added: added.changes };
    }

    // Cleanup temp tables
    db.exec('DROP TABLE IF EXISTS _univ_precinct; DROP TABLE IF EXISTS _univ_universe; DROP TABLE IF EXISTS _univ_sub; DROP TABLE IF EXISTS _univ_priority');

    return { totalInPrecincts, universeCount, subUniverseCount, priorityCount, extraCount, created, basicMode: false };
  });

  const result = buildTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Universe built: ' + result.totalInPrecincts + ' in precincts, ' + result.universeCount + ' universe, ' +
    result.subUniverseCount + ' sub-universe, ' + result.priorityCount + ' priority, ' + result.extraCount + ' extra'
  );

  res.json({
    success: true,
    total_in_precincts: result.totalInPrecincts,
    universe: result.universeCount,
    sub_universe: result.subUniverseCount,
    priority: result.priorityCount,
    extra: result.extraCount,
    created: result.created
  });
});

// Preview universe counts without creating lists
router.post('/universe/preview', (req, res) => {
  const { precincts, years_back, election_cycles, priority_elections,
          genders, age_min, age_max, cities, school_districts, college_districts,
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses } = req.body;
  const cutoffYear = new Date().getFullYear() - (years_back || 8);
  const cutoffDate = cutoffYear + '-01-01';

  const step1 = buildStep1Filter({ precincts, genders, age_min, age_max, cities,
    school_districts, college_districts, navigation_ports, port_authorities,
    state_reps, us_congress, parties, min_elections, voter_statuses });

  // Check if election data exists — if not, use "basic mode" (all Step 1 voters)
  const hasElectionData = (db.prepare('SELECT COUNT(*) as c FROM election_votes').get() || { c: 0 }).c > 0;

  const previewTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _prev_precinct');
    db.exec('CREATE TEMP TABLE _prev_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO _prev_precinct SELECT DISTINCT voters.id FROM voters' + step1.partyJoin + ' WHERE ' + step1.where).run(...step1.params);
    const totalInPrecincts = (db.prepare('SELECT COUNT(*) as c FROM _prev_precinct').get() || { c: 0 }).c;

    // Basic mode: no election data — all Step 1 voters count as the universe
    if (!hasElectionData) {
      db.exec('DROP TABLE IF EXISTS _prev_precinct');
      return { totalInPrecincts, universeCount: totalInPrecincts, subUniverseCount: totalInPrecincts, priorityCount: 0, basicMode: true };
    }

    db.exec('DROP TABLE IF EXISTS _prev_universe');
    db.exec('CREATE TEMP TABLE _prev_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _prev_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _prev_precinct pp ON ev.voter_id = pp.voter_id
      WHERE ev.election_date >= ?`).run(cutoffDate);
    const universeCount = (db.prepare('SELECT COUNT(*) as c FROM _prev_universe').get() || { c: 0 }).c;

    let subUniverseCount;
    db.exec('DROP TABLE IF EXISTS _prev_sub');
    if (election_cycles && election_cycles.length > 0) {
      db.exec('CREATE TEMP TABLE _prev_sub (voter_id INTEGER PRIMARY KEY)');
      const cPh = election_cycles.map(() => '?').join(',');
      db.prepare(`INSERT INTO _prev_sub
        SELECT DISTINCT ev.voter_id FROM election_votes ev
        INNER JOIN _prev_universe pu ON ev.voter_id = pu.voter_id
        WHERE ev.election_cycle IN (${cPh})`).run(...election_cycles);
      subUniverseCount = (db.prepare('SELECT COUNT(*) as c FROM _prev_sub').get() || { c: 0 }).c;
    } else {
      subUniverseCount = universeCount;
    }

    let priorityCount = 0;
    if (priority_elections && priority_elections.length > 0 && subUniverseCount > 0) {
      const subTable = (election_cycles && election_cycles.length > 0) ? '_prev_sub' : '_prev_universe';
      if (!['_prev_sub', '_prev_universe'].includes(subTable)) throw new Error('Invalid table');
      const pPh = priority_elections.map(() => '?').join(',');
      priorityCount = (db.prepare(`SELECT COUNT(DISTINCT ev.voter_id) as c FROM election_votes ev
        INNER JOIN ${subTable} ps ON ev.voter_id = ps.voter_id
        WHERE ev.election_name IN (${pPh})`).get(...priority_elections) || { c: 0 }).c;
    }

    db.exec('DROP TABLE IF EXISTS _prev_precinct; DROP TABLE IF EXISTS _prev_universe; DROP TABLE IF EXISTS _prev_sub');

    return { totalInPrecincts, universeCount, subUniverseCount, priorityCount, basicMode: false };
  });

  const r = previewTx();
  res.json({
    total_in_precincts: r.totalInPrecincts,
    universe: r.universeCount,
    sub_universe: r.subUniverseCount,
    priority: r.priorityCount,
    extra: r.subUniverseCount - r.priorityCount,
    basic_mode: r.basicMode || false
  });
});

module.exports = router;
