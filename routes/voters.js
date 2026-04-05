const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { generateQrToken } = require('../db');
const { phoneDigits, normalizePhone, toE164 } = require('../utils');
const { queueSync } = require('../lib/google-sheets-sync');

// Fire-and-forget sync after data mutations
function triggerSync(req) {
  if (req.session?.userId) setImmediate(() => queueSync(req.session.userId));
}

const bulkDeleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: { error: 'Too many delete requests, try again later.' } });
const checkinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { error: 'Too many check-in attempts. Please wait.' } });
const voterCreateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many voter creation requests. Please wait.' } });
const importLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many import requests. Please wait.' } });

// Auth middleware for admin-only endpoints
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}

// Valid district/race columns for filtering (voters table columns).
// Used across /voters/race-precincts, /voters/all-districts, /voters/district-values,
// /voters/precinct-counts, and /analytics/precincts.
const DISTRICT_COLUMNS = [
  { col: 'navigation_port', label: 'Navigation Port' },
  { col: 'navigation_district', label: 'Navigation District' },
  { col: 'port_authority', label: 'Port Authority' },
  { col: 'county_commissioner', label: 'County Commissioner' },
  { col: 'justice_of_peace', label: 'Justice of the Peace' },
  { col: 'state_board_ed', label: 'State Board of Education' },
  { col: 'state_rep', label: 'State Representative' },
  { col: 'state_senate', label: 'State Senate' },
  { col: 'us_congress', label: 'US Congress' },
  { col: 'city_district', label: 'City' },
  { col: 'school_district', label: 'School District' },
  { col: 'college_district', label: 'College District' },
  { col: 'hospital_district', label: 'Hospital District' }
];
const DISTRICT_COLS_SET = new Set(DISTRICT_COLUMNS.map(d => d.col));

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
  const limit = parseInt(req.query.limit, 10) || 500;
  sql += ' ORDER BY voters.last_name, voters.first_name LIMIT ' + limit;
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
      'SELECT voter_id, election_name, election_type, party_voted, vote_method FROM election_votes WHERE voter_id IN (' + voterIds.map(() => '?').join(',') + ')'
    ).all(...voterIds);
    for (const r of evRows) {
      if (!electionVotes[r.voter_id]) electionVotes[r.voter_id] = [];
      electionVotes[r.voter_id].push({ election_name: r.election_name, election_type: r.election_type, party_voted: r.party_voted || '', vote_method: r.vote_method || '' });
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
router.post('/voters', requireAuth, voterCreateLimiter, (req, res) => {
  const { first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct } = req.body;
  if (!first_name && !last_name) return res.status(400).json({ error: 'At least first name or last name is required.' });
  const qr_token = generateQrToken();
  const result = db.prepare(
    'INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, voter_score, tags, notes, registration_number, precinct, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(first_name || '', last_name || '', normalizePhone(phone), email || '', address || '', city || '', zip || '', party || '', support_level || 'unknown', voter_score || 0, tags || '', notes || '', registration_number || '', precinct || '', qr_token);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Quick patch: update specific fields by registration_number
router.post('/voters/patch-fields', requireAuth, (req, res) => {
  const { voters } = req.body;
  if (!voters || !Array.isArray(voters)) return res.status(400).json({ error: 'voters array required' });

  const validCols = ['unit_type', 'single_member_city', 'city_council', 'drainage_district',
    'school_board', 'constable', 'ballot_box', 'mailing_address', 'mailing_city',
    'mailing_state', 'mailing_zip', 'college_single_member', 'not_incorporated'];

  let updated = 0;
  const tx = db.transaction(() => {
    for (const v of voters) {
      const regNum = v.registration_number || v.vuid;
      if (!regNum) continue;
      const setClauses = [];
      const params = [];
      for (const [col, val] of Object.entries(v)) {
        if (col === 'registration_number' || col === 'vuid') continue;
        if (!validCols.includes(col)) continue;
        if (val && val.trim()) { setClauses.push(col + ' = ?'); params.push(val.trim()); }
      }
      if (setClauses.length === 0) continue;
      params.push(regNum);
      const r = db.prepare('UPDATE voters SET ' + setClauses.join(', ') + ' WHERE registration_number = ?').run(...params);
      if (r.changes > 0) updated++;
    }
  });
  tx();
  res.json({ success: true, updated, total: voters.length });
});

// Bulk import voters
router.post('/voters/import', requireAuth, importLimiter, (req, res) => {
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
    res.status(500).json({ error: 'Import failed. Please check your data and try again.' });
  }
});

// --- Import full county voter file (with election history) ---
// Accepts voter records with election history columns. Upserts by VANID or CountyFileID.
// Election history fields are stored in election_votes table.
router.post('/voters/import-voter-file', requireAuth, importLimiter, (req, res) => {
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
    const findByRegistration = db.prepare("SELECT id FROM voters WHERE registration_number = ? AND registration_number != '' LIMIT 1");

    const insertVoter = db.prepare(
      `INSERT INTO voters (first_name, last_name, middle_name, suffix, phone, secondary_phone, email,
        address, city, state, zip, zip4, party, support_level, tags, registration_number, precinct,
        county_file_id, vanid, address_id, state_file_id, gender, age, qr_token, unit, voter_status, navigation_district)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        gender=CASE WHEN ?!='' THEN ? ELSE gender END,
        age=CASE WHEN ? IS NOT NULL THEN ? ELSE age END,
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

    // Update vote_method on existing election records
    const updateVoteMethod = db.prepare(
      'UPDATE election_votes SET vote_method = ? WHERE voter_id = ? AND election_name = ?'
    );

    // Update voter fields from Cameron County format
    const updateVoterExtra = db.prepare(
      "UPDATE voters SET unit=CASE WHEN ?!='' THEN ? ELSE unit END, voter_status=CASE WHEN ?!='' THEN ? ELSE voter_status END, navigation_district=CASE WHEN ?!='' THEN ? ELSE navigation_district END WHERE id=?"
    );

    const customCols = getCustomVoterColumns();
    const results = { total: voters.length, added: 0, updated: 0, elections_recorded: 0 };

    const importTx = db.transaction((list) => {
      for (const v of list) {
        let voterId = null;

        // Try to find existing voter by StateFileID, VANID, CountyFileID, or Registration Number (VUID)
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
        if (!voterId && v.registration_number) {
          const existing = findByRegistration.get(v.registration_number);
          if (existing) voterId = existing.id;
        }

        const phone = normalizePhone(v.phone || v.preferred_phone);
        const secondaryPhone = normalizePhone(v.secondary_phone || v.home_phone);
        const voterAge = v.age ? parseInt(v.age) || null : null;
        const voterGender = v.gender || v.sex || '';

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
            voterGender, voterGender,
            voterAge, voterAge,
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
            v.county_file_id || '', v.vanid || '', v.address_id || '', v.state_file_id || '',
            voterGender, voterAge, generateQrToken(),
            v.unit || '', v.voter_status || '', v.navigation_district || ''
          );
          voterId = r.lastInsertRowid;
          if (customCols.length > 0) updateCustomFields(voterId, v, customCols);
          results.added++;
        }

        // Process election history columns
        const partyData = {}; // e.g. { 'Primary 2024': 'D' }
        const voteMethodData = {}; // e.g. { 'Primary 2024': 'early' }

        // Format 1: Old format — General24, Primary22Party, etc.
        for (const [key, val] of Object.entries(v)) {
          if (!val || typeof val !== 'string') continue;
          const m = key.match(ELECTION_RE);
          if (!m) continue;

          const [, prefix, yr, isParty] = m;
          const name = electionName(prefix, yr);
          const fullYear = yr.length === 2 ? (parseInt(yr) > 50 ? '19' + yr : '20' + yr) : yr;

          if (isParty) {
            partyData[name] = val.trim();
          } else {
            const upper = val.trim().toUpperCase();
            if (upper && upper !== 'N' && upper !== 'NO' && upper !== '0' && upper !== '') {
              const r = insertVote.run(voterId, name, fullYear + '-01-01', electionType(prefix), '');
              if (r.changes > 0) results.elections_recorded++;
            }
          }
        }

        // Format 2: Cameron County format — "Election01 Code", "Election01 Party Code", "Election01 Vote Type"
        // Election codes are short: P26=Primary 2026, GN24=General Nov 2024, 525=May 2025, PR24=Primary Runoff 2024
        // CA25=Constitutional Amendment 2025, SP25=Special 2025, R624=Runoff Jun 2024, CDD5=Drainage District
        // Complete election code to name+date mapping
        const ELECTION_LOOKUP = {
          'P26': { name: 'Primary 2026', date: '2026-03-03', type: 'primary' },
          'P24': { name: 'Primary 2024', date: '2024-03-05', type: 'primary' },
          'P22': { name: 'Primary 2022', date: '2022-03-01', type: 'primary' },
          'P20': { name: 'Primary 2020', date: '2020-03-03', type: 'primary' },
          'P18': { name: 'Primary 2018', date: '2018-03-06', type: 'primary' },
          'P16': { name: 'Primary 2016', date: '2016-03-01', type: 'primary' },
          'GN24': { name: 'General 2024', date: '2024-11-05', type: 'general' },
          'GN22': { name: 'General 2022', date: '2022-11-08', type: 'general' },
          'GN20': { name: 'General 2020', date: '2020-11-03', type: 'general' },
          'GN18': { name: 'General 2018', date: '2018-11-06', type: 'general' },
          'GN16': { name: 'General 2016', date: '2016-11-08', type: 'general' },
          'PR24': { name: 'Primary Runoff 2024', date: '2024-05-28', type: 'runoff' },
          'PR22': { name: 'Primary Runoff 2022', date: '2022-05-24', type: 'runoff' },
          'PR20': { name: 'Primary Runoff 2020', date: '2020-07-14', type: 'runoff' },
          'PR18': { name: 'Primary Runoff 2018', date: '2018-05-22', type: 'runoff' },
          'GR24': { name: 'General Runoff 2024', date: '2024-12-14', type: 'runoff' },
          'GR20': { name: 'General Runoff 2020', date: '2020-12-15', type: 'runoff' },
          'CA25': { name: 'Constitutional Amendment 2025', date: '2025-05-03', type: 'special' },
          'CA2023': { name: 'Constitutional Amendment 2023', date: '2023-11-07', type: 'special' },
          'CA21': { name: 'Constitutional Amendment 2021', date: '2021-11-02', type: 'special' },
          'CA19': { name: 'Constitutional Amendment 2019', date: '2019-11-05', type: 'special' },
          'SP26': { name: 'Special 2026', date: '2026-01-01', type: 'special' },
          'SP25': { name: 'Special 2025', date: '2025-01-01', type: 'special' },
          'SP34': { name: 'Special Election CD34 2022', date: '2022-06-14', type: 'special' },
          'SPI24': { name: 'Special Election SPI 2024', date: '2024-01-20', type: 'special' },
          'R625': { name: 'Runoff Jun 2025', date: '2025-06-17', type: 'runoff' },
          'R624': { name: 'Runoff Jun 2024', date: '2024-06-18', type: 'runoff' },
          'R622': { name: 'Runoff Jun 2022', date: '2022-06-14', type: 'runoff' },
          'CDD5': { name: 'Drainage District 5', date: '2024-01-01', type: 'special' },
          '525': { name: 'Local May 2025', date: '2025-05-03', type: 'local' },
          '524': { name: 'Local May 2024', date: '2024-05-04', type: 'local' },
          '523': { name: 'Local May 2023', date: '2023-05-06', type: 'local' },
          '522': { name: 'Local May 2022', date: '2022-05-07', type: 'local' },
          '521': { name: 'Local May 2021', date: '2021-05-01', type: 'local' },
          '519': { name: 'Local May 2019', date: '2019-05-04', type: 'local' },
          '518': { name: 'Local May 2018', date: '2018-05-05', type: 'local' },
          '517': { name: 'Local May 2017', date: '2017-05-06', type: 'local' },
          '516': { name: 'Local May 2016', date: '2016-05-07', type: 'local' },
          '623': { name: 'Local Jun 2023', date: '2023-06-10', type: 'local' },
          '621': { name: 'Local Jun 2021', date: '2021-06-05', type: 'local' },
          '619': { name: 'Local Jun 2019', date: '2019-06-08', type: 'local' },
          '618': { name: 'Local Jun 2018', date: '2018-06-09', type: 'local' },
          '616': { name: 'Local Jun 2016', date: '2016-06-18', type: 'local' },
        };
        const VOTE_METHODS_SET = new Set(['EV', 'ED', 'MAIL', 'VOTED EARLY', 'ELECTION DAY', 'PROVISIONAL', 'ABSENTEE']);
        const PARTIES_SET = new Set(['DEM', 'REP', 'LIB', 'GRN']);

        for (let eIdx = 1; eIdx <= 44; eIdx++) {
          const padded = eIdx < 10 ? '0' + eIdx : String(eIdx);
          const codeKey = 'Election' + padded + ' Code';
          const partyKey = 'Election' + padded + ' Party Code';
          const voteTypeKey = 'Election' + padded + ' Vote Type';
          const codeVal = (v[codeKey] || '').trim();
          const partyVal = (v[partyKey] || '').trim();
          const typeVal = (v[voteTypeKey] || '').trim();
          const codeUpper = codeVal.toUpperCase();
          const partyUpper = partyVal.toUpperCase();
          const typeUpper = typeVal.toUpperCase();

          // Column mapping is CONSISTENT across all elections:
          //   Code = election identifier (P26, GN24, 525, etc.)
          //   Party Code = party voted (DEM, REP) — only for primaries
          //   Vote Type = vote method (EV, ED, MAIL, Voted Early, Election Day, etc.)
          let elInfo = ELECTION_LOOKUP[codeVal] || ELECTION_LOOKUP[codeUpper];
          if (!elInfo) continue;

          // Party is in Party Code column
          let partyVoted = '';
          if (PARTIES_SET.has(partyUpper)) partyVoted = partyUpper;

          // Vote method is in Vote Type column
          let method = '';
          if (typeUpper === 'EV' || typeUpper === 'VOTED EARLY' || typeUpper === 'EARLY') method = 'early';
          else if (typeUpper === 'ED' || typeUpper === 'ELECTION DAY' || typeUpper === 'IN PERSON') method = 'election_day';
          else if (typeUpper === 'MAIL' || typeUpper === 'ABSENTEE') method = 'mail';
          else if (typeUpper === 'PROVISIONAL') method = 'provisional';
          else if (typeUpper === '1') method = 'voted';

          const r = insertVote.run(voterId, elInfo.name, elInfo.date, elInfo.type, '');
          if (r.changes > 0) results.elections_recorded++;

          // Save party and vote method
          if (partyVoted) partyData[elInfo.name] = partyVoted;
          if (method) voteMethodData[elInfo.name] = method;
        }

        // Update voter extra fields
        const rawUnit = (v['Unit'] || v['unit'] || '').trim();
        const unitType = (v['Unit Type'] || v['unit_type'] || '').trim();
        const unitVal = unitType && rawUnit ? unitType + ' ' + rawUnit : rawUnit;
        const statusVal = (v['Status'] || v['status'] || v['voter_status'] || '').trim();
        const navVal = (v['NAVIGATION DISTRICT'] || v['NAVIGATION AND PORT DISTRICT'] || v['navigation_district'] || '').trim();
        if (unitVal || statusVal || navVal) {
          updateVoterExtra.run(unitVal, unitVal, statusVal, statusVal, navVal, navVal, voterId);
        }

        // Update additional district columns
        const extraDistricts = {
          court_of_appeals: (v['COURT OF APPEALS DISTRICT'] || '').trim(),
          municipal_utility: (v['MUNICIPAL UTILITY'] || '').trim(),
          water_district: (v['WATER'] || '').trim(),
          college_single_member: (v['COLLEGE SINGLE MEMBER'] || v['COLLEGE.1'] || '').trim(),
          not_incorporated: (v['NOT INCORPORATED'] || '').trim(),
          single_member_city: (v['SINGLE MEMBER CITY'] || '').trim(),
          drainage_district: (v['DRAINAGE DISTRICT'] || '').trim(),
          school_board: (v['SCHOOLBOARD'] || '').trim(),
          city_council: (v['CITYCOUNCIL'] || '').trim(),
          constable: (v['CONSTABLE'] || v['CONSTA'] || '').trim(),
          ballot_box: (v['BOX'] || '').trim(),
          mailing_address: (v['Mailing Address'] || v['mailing_address'] || '').trim(),
          mailing_city: (v['Mail City'] || v['mailing_city'] || '').trim(),
          mailing_state: (v['Mail State'] || v['mailing_state'] || '').trim(),
          mailing_zip: (v['Mail Zip Code5'] || v['mailing_zip'] || '').trim(),
        };
        const setClauses = [];
        const setParams = [];
        for (const [col, val] of Object.entries(extraDistricts)) {
          if (val) { setClauses.push(col + " = ?"); setParams.push(val); }
        }
        if (setClauses.length > 0) {
          setParams.push(voterId);
          db.prepare('UPDATE voters SET ' + setClauses.join(', ') + ' WHERE id = ?').run(...setParams);
        }

        // Apply party data to matching election records
        for (const [name, party] of Object.entries(partyData)) {
          if (party) {
            updateVoteParty.run(party, voterId, name);
          }
        }

        // Apply vote method data
        for (const [name, method] of Object.entries(voteMethodData)) {
          if (method) {
            updateVoteMethod.run(method, voterId, name);
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
    res.status(500).json({ error: 'Import failed: ' + (err.message || err).toString().slice(0, 500) });
  }
});

// --- Import canvass data (match existing voters, log contacts, optionally create new) ---
router.post('/voters/import-canvass', requireAuth, importLimiter, (req, res) => {
  const { rows, create_new } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  // Pre-build a phone lookup map: digits -> voter {id, support_level}
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address, registration_number FROM voters").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 10) phoneMap[d] = v.id;
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
      if (digits.length >= 10 && phoneMap[digits]) {
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

  try {
    importCanvass(rows);
  } catch (err) {
    console.error('Canvass import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Canvass data imported: ' + results.matched + ' matched, ' + results.new_created + ' new, ' + results.skipped + ' skipped'
  );

  res.json({ success: true, ...results });
});

// --- Enrich voter data from purchased lists ---
router.post('/voters/enrich', requireAuth, importLimiter, (req, res) => {
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
    SELECT id, title, event_date, event_end_date, event_time, event_end_time, location, latitude, longitude, checkin_radius FROM events
    WHERE status = 'upcoming' AND (event_date >= date('now', '-1 day') OR (event_end_date != '' AND event_end_date >= date('now')))
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

// Haversine distance in meters between two lat/lng points
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Check in a voter to an event via QR token (public endpoint)
router.post('/voters/qr/:token/checkin', checkinLimiter, (req, res) => {
  const { event_id, latitude, longitude } = req.body;
  if (!event_id) return res.status(400).json({ error: 'Event ID is required.' });

  const voter = db.prepare("SELECT id, first_name, last_name FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Time window check: only allow check-in during the event
  if (event.event_time) {
    const now = new Date();
    const eventStart = new Date(event.event_date + 'T' + event.event_time);
    if (!isNaN(eventStart.getTime()) && now < eventStart) {
      return res.status(403).json({ error: 'Check-in hasn\'t opened yet. The event starts at ' + event.event_time + '.' });
    }
  }
  if (event.event_end_time) {
    const now = new Date();
    const eventEnd = new Date(event.event_date + 'T' + event.event_end_time);
    if (!isNaN(eventEnd.getTime()) && now > eventEnd) {
      return res.status(403).json({ error: 'Check-in is closed. The event ended at ' + event.event_end_time + '.' });
    }
  }

  // Geofence check: if event has coordinates, verify voter is within radius
  if (event.latitude && event.longitude) {
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'Location is required to check in. Please enable location services.' });
    }
    const distance = haversineMeters(event.latitude, event.longitude, latitude, longitude);
    const radius = event.checkin_radius || 500; // default 500 meters
    if (distance > radius) {
      return res.status(403).json({
        error: 'You need to be at the event location to check in. You are about ' + Math.round(distance) + ' meters away.',
        distance: Math.round(distance),
        radius: radius
      });
    }
  }

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
router.post('/voters/qr/:token/scan-checkin', checkinLimiter, (req, res) => {
  const { event_id, scanned_by } = req.body;
  if (!event_id) return res.status(400).json({ error: 'Event ID is required.' });

  const voter = db.prepare("SELECT id, first_name, last_name FROM voters WHERE qr_token = ?").get(req.params.token);
  if (!voter) return res.status(404).json({ error: 'Invalid QR code.' });

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Time window check: only allow check-in during the event
  if (event.event_time) {
    const now = new Date();
    const eventStart = new Date(event.event_date + 'T' + event.event_time);
    if (!isNaN(eventStart.getTime()) && now < eventStart) {
      return res.status(403).json({ error: 'Check-in hasn\'t opened yet. The event starts at ' + event.event_time + '.' });
    }
  }
  if (event.event_end_time) {
    const now = new Date();
    const eventEnd = new Date(event.event_date + 'T' + event.event_end_time);
    if (!isNaN(eventEnd.getTime()) && now > eventEnd) {
      return res.status(403).json({ error: 'Check-in is closed. The event ended at ' + event.event_end_time + '.' });
    }
  }

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
    SELECT id, title, event_date, event_end_date, event_time, event_end_time, location, latitude, longitude, checkin_radius FROM events
    WHERE (event_date = date('now', 'localtime') OR (event_end_date != '' AND event_date <= date('now', 'localtime') AND event_end_date >= date('now', 'localtime')))
    AND status IN ('upcoming', 'in_progress')
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
    county_commissioners: opt('county_commissioner'),
    justice_of_peace: opt('justice_of_peace'),
    state_board_eds: opt('state_board_ed'),
    hospital_districts: opt('hospital_district'),
    parties: db.prepare("SELECT DISTINCT party_voted as v FROM election_votes WHERE party_voted != '' AND party_voted IS NOT NULL ORDER BY party_voted").all().map(r => r.v),
    voter_statuses: opt('voter_status'),
    single_member_cities: opt('single_member_city'),
    drainage_districts: opt('drainage_district'),
    school_boards: opt('school_board'),
    city_councils: opt('city_council'),
    constables: opt('constable'),
    court_of_appeals_dists: opt('court_of_appeals'),
    not_incorporated_areas: opt('not_incorporated'),
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
      precincts: (r.precincts || '').split(',').filter(Boolean)
    }));
  };
  const races = DISTRICT_COLUMNS.flatMap(d => mapCol(d.col, d.label));
  res.json({ races });
});

// Get all distinct values for a district column
router.get('/voters/district-values', (req, res) => {
  const col = req.query.column;
  if (!col || !DISTRICT_COLS_SET.has(col)) return res.status(400).json({ error: 'Invalid column. Valid: ' + [...DISTRICT_COLS_SET].join(', ') });

  const rows = db.prepare(`SELECT ${col} as value, COUNT(*) as count FROM voters WHERE ${col} != '' AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY ${col}`).all();
  res.json({ column: col, values: rows });
});

// Get all district columns with their values for filters
router.get('/voters/all-districts', (req, res) => {
  const districts = DISTRICT_COLUMNS.map(c => {
    const rows = db.prepare(`SELECT ${c.col} as value, COUNT(*) as count FROM voters WHERE ${c.col} != '' AND ${c.col} IS NOT NULL GROUP BY ${c.col} ORDER BY count DESC`).all();
    return { column: c.col, label: c.label, values: rows };
  }).filter(d => d.values.length > 0);

  res.json({ districts });
});

// Precinct voter counts with full filter support
router.get('/voters/precinct-counts', (req, res) => {
  const { race_col, race_val, election, party, party_score, support_level, voted_in, did_not_vote, min_elections, exclude_contacted, has_voted, min_age, max_age, exclude_early_voted } = req.query;

  let sql = "SELECT precinct, COUNT(*) as cnt FROM voters WHERE precinct != '' AND precinct IS NOT NULL";
  const params = [];

  // Race/district filter
  if (race_col && DISTRICT_COLS_SET.has(race_col) && race_val) {
    sql += ` AND ${race_col} = ?`;
    params.push(race_val);
  }

  // Party filter — matches voters who voted in a party primary (from election_votes)
  if (party) {
    if (party === 'NP') {
      sql += " AND id NOT IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.party_voted IN ('D','R'))";
    } else {
      sql += ' AND id IN (SELECT ev.voter_id FROM election_votes ev WHERE ev.party_voted = ?)';
      params.push(party);
    }
  }

  // VAN-style party score filter (DDD/DD/D/R/RR/RRR/SWING)
  if (party_score) {
    if (party_score === 'NONE') {
      sql += " AND (party_score = '' OR party_score IS NULL)";
    } else if (party_score === 'SWING') {
      sql += " AND party_score = 'SWING'";
    } else if (party_score === 'DD') {
      sql += " AND party_score IN ('DD','DDD')";
    } else if (party_score === 'D') {
      sql += " AND party_score IN ('D','DD','DDD')";
    } else if (party_score === 'RR') {
      sql += " AND party_score IN ('RR','RRR')";
    } else if (party_score === 'R') {
      sql += " AND party_score IN ('R','RR','RRR')";
    } else {
      sql += ' AND party_score = ?';
      params.push(party_score);
    }
  }

  // Support level filter
  if (support_level) {
    sql += ' AND support_level = ?';
    params.push(support_level);
  }

  // Election participation (legacy single param)
  if (election) {
    sql += ' AND id IN (SELECT voter_id FROM election_votes WHERE election_name = ?)';
    params.push(election);
  }

  // Voted in specific election(s) — supports comma-separated for multiple
  if (voted_in) {
    const elections = voted_in.split(',').map(e => e.trim()).filter(Boolean);
    if (elections.length === 1) {
      sql += ' AND id IN (SELECT voter_id FROM election_votes WHERE election_name = ?)';
      params.push(elections[0]);
    } else if (elections.length > 1) {
      sql += ' AND id IN (SELECT voter_id FROM election_votes WHERE election_name IN (' + elections.map(() => '?').join(',') + '))';
      elections.forEach(e => params.push(e));
    }
  }

  // Did NOT vote in specific election(s) — supports comma-separated
  if (did_not_vote) {
    const elections = did_not_vote.split(',').map(e => e.trim()).filter(Boolean);
    if (elections.length === 1) {
      sql += ' AND id NOT IN (SELECT voter_id FROM election_votes WHERE election_name = ?)';
      params.push(elections[0]);
    } else if (elections.length > 1) {
      sql += ' AND id NOT IN (SELECT voter_id FROM election_votes WHERE election_name IN (' + elections.map(() => '?').join(',') + '))';
      elections.forEach(e => params.push(e));
    }
  }

  // Minimum elections voted in
  if (min_elections && parseInt(min_elections) > 0) {
    sql += ' AND id IN (SELECT voter_id FROM election_votes GROUP BY voter_id HAVING COUNT(DISTINCT election_name) >= ?)';
    params.push(parseInt(min_elections));
  }

  // Only voters with voting history
  if (has_voted === '1') {
    sql += ' AND id IN (SELECT DISTINCT voter_id FROM election_votes)';
  }

  // Exclude already contacted
  if (exclude_contacted === '1') {
    sql += ' AND id NOT IN (SELECT DISTINCT voter_id FROM voter_contacts)';
  }

  // Age filters (based on birth_date column)
  if (min_age && parseInt(min_age) > 0) {
    sql += " AND birth_date != '' AND birth_date IS NOT NULL AND (strftime('%Y','now') - substr(birth_date,1,4)) >= ?";
    params.push(parseInt(min_age));
  }
  if (max_age && parseInt(max_age) > 0) {
    sql += " AND birth_date != '' AND birth_date IS NOT NULL AND (strftime('%Y','now') - substr(birth_date,1,4)) <= ?";
    params.push(parseInt(max_age));
  }

  // Exclude early voters (already voted in current election)
  if (exclude_early_voted === '1') {
    sql += " AND (early_voted IS NULL OR early_voted = 0 OR early_voted = '')";
  }

  sql += " AND precinct NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]*' GROUP BY precinct ORDER BY cnt DESC";

  const rows = db.prepare(sql).all(...params);
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  res.json({ precincts: rows.map(r => ({ precinct: r.precinct, count: r.cnt })), total });
});

// ===================== Twilio Phone Validation =====================
// MUST be before /voters/:id wildcard routes

// In-memory progress tracker for bulk lookups
let phoneCleanupProgress = { running: false, total: 0, done: 0, results: {} };

function getTwilioClient() {
  const sid = (db.prepare("SELECT value FROM settings WHERE key = 'twilio_account_sid'").get() || {}).value;
  const token = (db.prepare("SELECT value FROM settings WHERE key = 'twilio_auth_token'").get() || {}).value;
  if (!sid || !token) return null;
  const twilio = require('twilio');
  return twilio(sid, token);
}

router.get('/voters/phone-cleanup-stats', requireAuth, (req, res) => {
  const listId = req.query.listId;
  const fromClause = listId
    ? 'FROM voters v JOIN admin_list_voters alv ON alv.voter_id = v.id WHERE alv.list_id = ?'
    : 'FROM voters v WHERE 1=1';
  const params = listId ? [listId] : [];
  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN v.phone != '' THEN 1 END) as total_with_phone,
      COUNT(CASE WHEN v.phone_type = 'mobile' THEN 1 END) as mobile,
      COUNT(CASE WHEN v.phone_type = 'landline' THEN 1 END) as landline,
      COUNT(CASE WHEN v.phone_type = 'voip' THEN 1 END) as voip,
      COUNT(CASE WHEN v.phone_type = 'invalid' THEN 1 END) as invalid,
      COUNT(CASE WHEN v.phone_type = 'unknown' THEN 1 END) as unknown_type,
      COUNT(CASE WHEN v.phone != '' AND (v.phone_validated_at = '' OR v.phone_validated_at IS NULL) THEN 1 END) as not_checked
    ${fromClause}
  `).get(...params);
  res.json({ ...stats, progress: phoneCleanupProgress });
});

router.get('/voters/phone-cleanup-progress', requireAuth, (req, res) => {
  res.json(phoneCleanupProgress);
});

router.post('/voters/phone-lookup', requireAuth, async (req, res) => {
  const client = getTwilioClient();
  if (!client) return res.status(400).json({ error: 'Twilio credentials not configured.' });
  const { phone } = req.body;
  const e164 = toE164(phone);
  if (!e164.startsWith('+1') || e164.length !== 12) return res.status(400).json({ error: 'Invalid phone number' });
  try {
    const result = await client.lookups.v2.phoneNumbers(e164).fetch({ fields: 'line_type_intelligence' });
    const lineType = result.lineTypeIntelligence?.type || 'unknown';
    const carrier = result.lineTypeIntelligence?.carrier_name || '';
    const valid = result.valid;
    const phoneType = !valid ? 'invalid' : (lineType === 'mobile' ? 'mobile' : lineType === 'landline' ? 'landline' : lineType === 'voip' || lineType === 'nonFixedVoip' ? 'voip' : 'unknown');
    res.json({ phone: e164, phoneType, carrier, valid, rawType: lineType });
  } catch (err) {
    res.status(500).json({ error: 'Twilio lookup failed: ' + err.message });
  }
});

router.post('/voters/phone-cleanup', requireAuth, async (req, res) => {
  try {
    if (phoneCleanupProgress.running) return res.json({ message: 'Cleanup already running', progress: phoneCleanupProgress });
    const client = getTwilioClient();
    if (!client) return res.status(400).json({ error: 'Twilio credentials not configured.' });
    const listId = req.body ? req.body.listId : null;
    let voters;
    if (listId) {
      voters = db.prepare(`SELECT v.id, v.phone FROM voters v JOIN admin_list_voters alv ON alv.voter_id = v.id WHERE alv.list_id = ? AND v.phone != '' AND (v.phone_validated_at = '' OR v.phone_validated_at IS NULL)`).all(listId);
    } else {
      voters = db.prepare("SELECT id, phone FROM voters WHERE phone != '' AND (phone_validated_at = '' OR phone_validated_at IS NULL)").all();
    }
    if (voters.length === 0) return res.json({ message: 'All phone numbers already validated', progress: phoneCleanupProgress });
    phoneCleanupProgress = { running: true, total: voters.length, done: 0, results: { mobile: 0, landline: 0, voip: 0, invalid: 0, unknown: 0, error: 0 } };
    res.json({ message: 'Cleanup started for ' + voters.length + ' numbers', progress: phoneCleanupProgress });
    (async () => {
      try {
        const update = db.prepare("UPDATE voters SET phone_type = ?, phone_carrier = ?, phone_validated_at = datetime('now') WHERE id = ?");
        const batchSize = 30;
        for (let i = 0; i < voters.length; i += batchSize) {
          const batch = voters.slice(i, i + batchSize);
          await Promise.all(batch.map(async (v) => {
            const e164 = toE164(v.phone);
            if (!e164.startsWith('+1') || e164.length !== 12) { update.run('invalid', '', v.id); phoneCleanupProgress.results.invalid++; phoneCleanupProgress.done++; return; }
            try {
              const result = await client.lookups.v2.phoneNumbers(e164).fetch({ fields: 'line_type_intelligence' });
              const lt = result.lineTypeIntelligence?.type || 'unknown';
              const carrier = result.lineTypeIntelligence?.carrier_name || '';
              const pt = !result.valid ? 'invalid' : (lt === 'mobile' ? 'mobile' : lt === 'landline' ? 'landline' : lt === 'voip' || lt === 'nonFixedVoip' ? 'voip' : 'unknown');
              update.run(pt, carrier, v.id);
              phoneCleanupProgress.results[pt] = (phoneCleanupProgress.results[pt] || 0) + 1;
            } catch (err) { update.run('unknown', 'error', v.id); phoneCleanupProgress.results.error = (phoneCleanupProgress.results.error || 0) + 1; }
            phoneCleanupProgress.done++;
          }));
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (bgErr) { console.error('[phone-cleanup] Error:', bgErr.message); phoneCleanupProgress.error = bgErr.message; }
      phoneCleanupProgress.running = false;
    })();
  } catch (err) {
    phoneCleanupProgress.running = false;
    res.status(500).json({ error: 'Phone cleanup failed: ' + err.message });
  }
});

router.post('/voters/phone-remove-bad', requireAuth, (req, res) => {
  const result = db.prepare("UPDATE voters SET phone = '', phone_type = '', phone_carrier = '', phone_validated_at = '' WHERE phone_type = 'invalid'").run();
  triggerSync(req);
  res.json({ removed: result.changes });
});

// Cross-reference a list of names against the voter database
router.post('/voters/match-contacts', requireAuth, (req, res) => {
  const { names } = req.body;
  if (!names || !Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'Provide an array of names to match.' });
  }
  if (names.length > 5000) return res.status(400).json({ error: 'Maximum 5000 names per request.' });

  const exactMatch = db.prepare(`
    SELECT id, first_name, last_name, registration_number, address, city, zip,
           phone, party_score, support_level, precinct, age, gender, navigation_district,
           early_voted, voter_status
    FROM voters
    WHERE LOWER(TRIM(first_name)) = LOWER(?) AND LOWER(TRIM(last_name)) = LOWER(?)
    AND (voter_status = 'ACTIVE' OR voter_status = '' OR voter_status IS NULL)
  `);
  const fuzzyMatch = db.prepare(`
    SELECT id, first_name, last_name, registration_number, address, city, zip,
           phone, party_score, support_level, precinct, age, gender, navigation_district,
           early_voted, voter_status
    FROM voters
    WHERE LOWER(TRIM(last_name)) = LOWER(?) AND LOWER(TRIM(first_name)) LIKE ?
    AND (voter_status = 'ACTIVE' OR voter_status = '' OR voter_status IS NULL)
    LIMIT 5
  `);

  function parseName(full) {
    let clean = full.replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '')
      .replace(/^(Dr|Dra|Mr|Mrs|Ms|Coach|Judge|Mayor|Commissioner)\.?\s+/i, '').trim();
    if (/^(El |La |Los |Las |Club |Team )/i.test(clean)) return null;
    if (clean.includes('@') || clean.includes('.com')) return null;
    const parts = clean.split(/\s+/).filter(p => p.length > 0);
    if (parts.length < 2) return null;
    const combos = [{ first: parts[0], last: parts[parts.length - 1] }];
    if (parts.length >= 3) combos.push({ first: parts[0], last: parts[parts.length - 2] });
    return combos;
  }

  const results = [];
  let matched = 0, skipped = 0, noMatch = 0;

  for (const name of names) {
    const n = (name || '').trim();
    if (!n || n.length < 3) { skipped++; continue; }
    const combos = parseName(n);
    if (!combos) { skipped++; continue; }

    let found = false;
    for (const { first, last } of combos) {
      const exact = exactMatch.all(first, last);
      if (exact.length > 0) {
        matched++;
        for (const v of exact) results.push({ contact_name: n, quality: 'exact', ...v });
        found = true;
        break;
      }
    }
    if (!found) {
      for (const { first, last } of combos) {
        if (first.length >= 3) {
          const fuzzy = fuzzyMatch.all(last, first.substring(0, 3) + '%');
          if (fuzzy.length > 0) {
            matched++;
            for (const v of fuzzy) results.push({ contact_name: n, quality: 'fuzzy', ...v });
            found = true;
            break;
          }
        }
      }
    }
    if (!found) noMatch++;
  }

  res.json({ total: names.length, matched, skipped, noMatch, results });
});

// --- Wildcard :id routes MUST come after all static-segment routes above ---

// Get voter detail with contact history and election votes
router.get('/voters/:id', (req, res) => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found.' });
  voter.contactHistory = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY contacted_at DESC').all(req.params.id);
  voter.election_history = db.prepare('SELECT election_name, election_date, election_type, election_cycle, party_voted, vote_method FROM election_votes WHERE voter_id = ? ORDER BY election_date DESC').all(req.params.id);

  // Household — other registered voters at same address + unit
  if (voter.address) {
    voter.household = db.prepare(`
      SELECT id, first_name, last_name, age, unit, party_score, voter_status, phone, early_voted, early_voted_ballot, early_voted_date
      FROM voters
      WHERE id != ?
        AND LOWER(TRIM(address)) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(unit,''))) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(city,''))) = LOWER(TRIM(?))
        AND (voter_status = 'ACTIVE' OR voter_status = '' OR voter_status IS NULL)
      ORDER BY last_name, first_name
    `).all(voter.id, voter.address, voter.unit || '', voter.city || '');
  } else {
    voter.household = [];
  }

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
// Cleanup: delete voters whose registration_number is NOT in the provided list
router.post('/voters/cleanup-by-vuids', requireAuth, (req, res) => {
  const { vuids } = req.body;
  if (!vuids || !vuids.length) return res.status(400).json({ error: 'No VUIDs provided.' });

  const cleanup = db.transaction(() => {
    db.prepare('DROP TABLE IF EXISTS _valid_vuids').run();
    db.prepare('CREATE TEMP TABLE _valid_vuids (vuid TEXT PRIMARY KEY)').run();
    const ins = db.prepare('INSERT OR IGNORE INTO _valid_vuids (vuid) VALUES (?)');
    for (const v of vuids) ins.run(v);

    const toDelete = db.prepare("SELECT COUNT(*) as c FROM voters WHERE registration_number NOT IN (SELECT vuid FROM _valid_vuids) AND registration_number != '' AND registration_number IS NOT NULL").get();
    const noReg = db.prepare("SELECT COUNT(*) as c FROM voters WHERE registration_number = '' OR registration_number IS NULL").get();
    const result = db.prepare("DELETE FROM voters WHERE registration_number NOT IN (SELECT vuid FROM _valid_vuids) AND registration_number != '' AND registration_number IS NOT NULL").run();

    db.prepare('DROP TABLE IF EXISTS _valid_vuids').run();
    return { deleted: result.changes, noRegistration: noReg.c, expected: toDelete.c };
  });

  const result = cleanup();
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Voter cleanup: removed ' + result.deleted + ' voters not in county file');
  res.json({ success: true, ...result });
});

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
  const voterPhoneNorm = phoneDigits(voter.phone);
  if (voterPhoneNorm) {
    const texts = db.prepare(
      "SELECT direction, body, timestamp as date FROM messages WHERE phone = ? ORDER BY timestamp DESC LIMIT 50"
    ).all(voterPhoneNorm);
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

  // 4. Survey responses (matched by phone)
  if (voterPhoneNorm) {
    const surveyData = db.prepare(`
      SELECT s.name as survey_name, ss.status, ss.sent_at, ss.completed_at,
        GROUP_CONCAT(sq.question_text || ': ' || sr.response_text, '; ') as responses
      FROM survey_sends ss
      JOIN surveys s ON ss.survey_id = s.id
      LEFT JOIN survey_responses sr ON sr.send_id = ss.id
      LEFT JOIN survey_questions sq ON sr.question_id = sq.id
      WHERE ss.phone = ?
      GROUP BY ss.id
      ORDER BY ss.sent_at DESC
    `).all(voterPhoneNorm);
    for (const sv of surveyData) {
      touchpoints.push({
        channel: 'Survey',
        result: sv.status === 'completed' ? 'Completed' : 'Sent',
        notes: sv.survey_name + (sv.responses ? ' — ' + sv.responses.substring(0, 150) : ''),
        by: 'Campaign',
        date: sv.completed_at || sv.sent_at
      });
    }
  }

  // 5. Captain list membership (personal relationship)
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
  const { race_col, race_val, list_id, candidate_id } = req.query;

  // Build optional filters
  let raceFilter = '';
  const raceParams = [];

  // candidate_id is the primary scope — limits to voters in that candidate's admin_lists
  let listFilter = '';
  let joinListFilter = '';
  if (candidate_id) {
    listFilter = ' AND id IN (SELECT voter_id FROM admin_list_voters alv JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?)';
    joinListFilter = ' AND v.id IN (SELECT voter_id FROM admin_list_voters alv JOIN admin_lists al ON alv.list_id = al.id WHERE al.candidate_id = ?)';
    raceParams.push(candidate_id);
  } else if (list_id) {
    listFilter = ' AND id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    joinListFilter = ' AND v.id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    raceParams.push(list_id);
  }
  if (race_col && DISTRICT_COLS_SET.has(race_col) && race_val) {
    raceFilter += ` AND ${race_col} = ?`;
    raceParams.push(race_val);
  }

  // Get all precincts with voter counts and party breakdown
  const precinctRows = db.prepare(`
    SELECT precinct,
      COUNT(*) as total_voters,
      SUM(CASE WHEN party = 'D' THEN 1 ELSE 0 END) as dem,
      SUM(CASE WHEN party = 'R' THEN 1 ELSE 0 END) as rep,
      SUM(CASE WHEN party NOT IN ('D','R') OR party = '' THEN 1 ELSE 0 END) as other,
      SUM(CASE WHEN support_level IN ('strong_support','lean_support') THEN 1 ELSE 0 END) as supporters,
      SUM(CASE WHEN support_level = 'undecided' THEN 1 ELSE 0 END) as undecided
    FROM voters WHERE precinct != ''${raceFilter}${listFilter}
    GROUP BY precinct ORDER BY precinct
  `).all(...raceParams);

  // Compute touchpoints per precinct using JOINs (scalable to 300K+)
  const contactsByPct = db.prepare(`
    SELECT v.precinct, COUNT(vc.id) as c FROM voter_contacts vc
    JOIN voters v ON vc.voter_id = v.id WHERE v.precinct != ''${raceFilter}${joinListFilter}
    GROUP BY v.precinct
  `).all(...raceParams);
  const contactMap = {};
  for (const r of contactsByPct) contactMap[r.precinct] = r.c;

  const checkinsByPct = db.prepare(`
    SELECT v.precinct, COUNT(vck.id) as c FROM voter_checkins vck
    JOIN voters v ON vck.voter_id = v.id WHERE v.precinct != ''${raceFilter}${joinListFilter}
    GROUP BY v.precinct
  `).all(...raceParams);
  const checkinMap = {};
  for (const r of checkinsByPct) checkinMap[r.precinct] = r.c;

  const captainByPct = db.prepare(`
    SELECT v.precinct, COUNT(clv.id) as c FROM captain_list_voters clv
    JOIN voters v ON clv.voter_id = v.id WHERE v.precinct != ''${raceFilter}${joinListFilter}
    GROUP BY v.precinct
  `).all(...raceParams);
  const captainMap = {};
  for (const r of captainByPct) captainMap[r.precinct] = r.c;

  // Walk universe progress by precinct — count unique houses (address+unit), not voter rows
  const doorsByPct = db.prepare(`
    SELECT v.precinct,
      COUNT(DISTINCT LOWER(TRIM(wa.address)) || '||' || LOWER(TRIM(COALESCE(wa.unit, ''))) || '||' || wa.walk_id) as total_doors,
      COUNT(DISTINCT CASE WHEN wa.result != 'not_visited' THEN LOWER(TRIM(wa.address)) || '||' || LOWER(TRIM(COALESCE(wa.unit, ''))) || '||' || wa.walk_id END) as knocked_doors
    FROM walk_addresses wa
    JOIN voters v ON wa.voter_id = v.id
    WHERE v.precinct != ''${raceFilter}${joinListFilter}
    GROUP BY v.precinct
  `).all(...raceParams);
  const doorsMap = {};
  for (const r of doorsByPct) doorsMap[r.precinct] = r;

  for (const p of precinctRows) {
    const contacts = contactMap[p.precinct] || 0;
    const checkins = checkinMap[p.precinct] || 0;
    const captainLists = captainMap[p.precinct] || 0;
    p.total_touchpoints = contacts + checkins + captainLists;
    p.avg_engagement = p.total_voters > 0 ? Math.round((contacts * 3 + checkins * 5 + captainLists * 4) / p.total_voters) : 0;
    const doors = doorsMap[p.precinct] || { total_doors: 0, knocked_doors: 0 };
    p.doors_total = doors.total_doors;
    p.doors_knocked = doors.knocked_doors;
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

// Delete ALL election_votes — used before full reimport from CSV
router.post('/bulk-delete-election-votes', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
  db.prepare('DELETE FROM election_votes').run();
  db.prepare("DELETE FROM elections").run();
  console.log('[bulk] Deleted', count, 'election_votes records');
  res.json({ deleted: count });
});

// Bulk insert election records from CSV data
router.post('/bulk-insert-election-votes', (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) return res.status(400).json({ error: 'records array required' });

  const ELECTION_DATES = {
    'Primary 2026':'2026-03-03','Primary 2024':'2024-03-05','Primary 2022':'2022-03-01','Primary 2020':'2020-03-03','Primary 2018':'2018-03-06','Primary 2016':'2016-03-01',
    'General 2024':'2024-11-05','General 2022':'2022-11-08','General 2020':'2020-11-03','General 2018':'2018-11-06','General 2016':'2016-11-08',
    'Primary Runoff 2024':'2024-05-28','Primary Runoff 2022':'2022-05-24','Primary Runoff 2020':'2020-07-14','Primary Runoff 2018':'2018-05-22',
    'General Runoff 2024':'2024-12-14','General Runoff 2020':'2020-12-15',
    'Constitutional Amendment 2025':'2025-05-03','Constitutional Amendment 2023':'2023-11-07','Constitutional Amendment 2021':'2021-11-02','Constitutional Amendment 2019':'2019-11-05',
    'Special 2026':'2026-01-01','Special 2025':'2025-01-01','Special Election CD34 2022':'2022-06-14',
    'Special Election SPI 2024':'2024-01-20','Drainage District 5 Election':'2024-01-01',
    'Runoff Jun 2025':'2025-06-17','Runoff Jun 2024':'2024-06-18','Runoff Jun 2022':'2022-06-14',
    'Local May 2025':'2025-05-03','Local May 2024':'2024-05-04','Local May 2023':'2023-05-06','Local May 2022':'2022-05-07','Local May 2021':'2021-05-01',
    'Local May 2019':'2019-05-04','Local May 2018':'2018-05-05','Local May 2017':'2017-05-06','Local May 2016':'2016-05-07',
    'Local Jun 2023':'2023-06-10','Local Jun 2021':'2021-06-05','Local Jun 2019':'2019-06-08','Local Jun 2018':'2018-06-09','Local Jun 2016':'2016-06-11',
  };

  const findVoter = db.prepare('SELECT id FROM voters WHERE registration_number = ?');
  const insertVote = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle, party_voted, vote_method) VALUES (?, ?, ?, ?, ?, ?, ?)');

  let inserted = 0, notFound = 0;
  const tx = db.transaction(() => {
    for (const rec of records) {
      const voter = findVoter.get(rec.vuid);
      if (!voter) { notFound++; continue; }
      for (const el of (rec.elections || [])) {
        const date = ELECTION_DATES[el.name] || '2000-01-01';
        const type = el.name.includes('Primary') ? 'primary' : el.name.includes('General') ? 'general' : el.name.includes('Runoff') ? 'runoff' : el.name.includes('Local') ? 'local' : 'special';
        const r = insertVote.run(voter.id, el.name, date, type, '', el.party || '', el.method || '');
        if (r.changes > 0) inserted++;
      }
    }
  });
  tx();
  res.json({ inserted, notFound, processed: records.length });
});

// Bulk update party_voted on existing election_votes records
// Bulk update mailing addresses
router.post('/bulk-update-mailing', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
  const findVoter = db.prepare('SELECT id FROM voters WHERE registration_number = ?');
  const updateMail = db.prepare('UPDATE voters SET mailing_address = ?, mailing_unit = ?, mailing_city = ?, mailing_state = ?, mailing_zip = ? WHERE id = ?');
  let updated = 0, notFound = 0;
  const tx = db.transaction(() => {
    for (const u of updates) {
      const voter = findVoter.get(u.vuid);
      if (!voter) { notFound++; continue; }
      const r = updateMail.run(u.address || '', u.unit || '', u.city || '', u.state || '', u.zip || '', voter.id);
      if (r.changes > 0) updated++;
    }
  });
  tx();
  res.json({ updated, notFound, processed: updates.length });
});

router.post('/bulk-update-party', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
  const findVoter = db.prepare('SELECT id FROM voters WHERE registration_number = ?');
  const updateParty = db.prepare('UPDATE election_votes SET party_voted = ? WHERE voter_id = ? AND election_name = ?');
  let updated = 0, notFound = 0;
  const tx = db.transaction(() => {
    for (const u of updates) {
      const voter = findVoter.get(u.vuid);
      if (!voter) { notFound++; continue; }
      for (const [elName, party] of Object.entries(u.parties || {})) {
        const r = updateParty.run(party, voter.id, elName);
        if (r.changes > 0) updated++;
      }
    }
  });
  tx();
  res.json({ updated, notFound, processed: updates.length });
});

// Bulk update vote methods on existing election_votes records
router.post('/bulk-update-vote-methods', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });

  const findVoter = db.prepare('SELECT id FROM voters WHERE registration_number = ?');
  const updateMethod = db.prepare('UPDATE election_votes SET vote_method = ? WHERE voter_id = ? AND election_name = ?');

  let updated = 0, notFound = 0;
  const tx = db.transaction(() => {
    for (const u of updates) {
      const voter = findVoter.get(u.vuid);
      if (!voter) { notFound++; continue; }
      for (const [elName, method] of Object.entries(u.methods || {})) {
        const r = updateMethod.run(method, voter.id, elName);
        if (r.changes > 0) updated++;
      }
    }
  });
  tx();
  res.json({ updated, notFound, processed: updates.length });
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
    if (d.length >= 10) phoneMap[d] = v.id;
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
      const reg = (row.registration_number || row.voter_id || row.vuid || row.reg_num || row.voter_unique_id || row.id || row.vanid || '').trim().toUpperCase();
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
        if (digits.length >= 10 && phoneMap[digits]) {
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

  try {
    importTx(rows);
  } catch (err) {
    console.error('Early voting import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }

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
  if (!clean || clean.length < 2 || clean.length > 64) return res.status(400).json({ error: 'Invalid column name. Must be 2-64 characters, start with a letter, and contain only letters, numbers, and underscores.' });

  // Block SQLite reserved words to prevent SQL syntax issues
  const reserved = new Set(['select','from','where','insert','update','delete','drop','alter','create','table','index','join','left','right','inner','outer','on','and','or','not','null','default','primary','key','references','foreign','unique','check','constraint','group','order','by','having','limit','offset','union','all','as','case','when','then','else','end','in','between','like','is','exists','values','into','set','column','add','text','integer','real','blob']);
  if (reserved.has(clean)) return res.status(400).json({ error: 'Column name "' + clean + '" is a reserved word.' });

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
  // Validate column names against actual DB columns for defense-in-depth
  const validCols = new Set(getVoterColumns());
  for (const col of customCols) {
    if (voterData[col] !== undefined && voterData[col] !== '' && validCols.has(col)) {
      try {
        db.prepare('UPDATE voters SET ' + col + ' = ? WHERE id = ?').run(voterData[col], voterId);
      } catch (e) { /* column may not exist yet, skip */ }
    }
  }
}

// --- Universe Builder: Election History Import & Segmentation ---

// Import election participation data (CSV with voter + which elections they voted in)
router.post('/election-votes/import', requireAuth, importLimiter, (req, res) => {
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
    if (d.length >= 10) phoneMapLocal[d] = v.id;
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
    if (digits.length >= 10 && phoneMapLocal[digits]) return phoneMapLocal[digits];
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

  try {
    importTx();
  } catch (err) {
    console.error('Election history import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Election history imported: ' + results.matched + ' voters matched, ' + results.votes_recorded + ' vote records added'
  );

  res.json({ success: true, ...results });
});

// Import turnout list from county (match by State File ID / registration_number / county_file_id / vanid)
// For primaries: party_voted = 'R' or 'D'. For nonpartisan races: party_voted = '' (shown as blue tag).
router.post('/election-votes/import-turnout', requireAuth, importLimiter, (req, res) => {
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

  try {
    importTx();
  } catch (err) {
    console.error('Turnout import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + (err.message || 'Unknown error') });
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Turnout list imported for ' + election_name + ': ' + results.matched + ' matched, ' + results.votes_recorded + ' recorded, ' + results.not_found + ' not found'
  );

  res.json({ success: true, ...results });
});

// Get all distinct elections in the database
router.get('/election-votes/elections', (req, res) => {
  // Only show elections that have actual voter data
  const elections = db.prepare(`
    SELECT election_name, election_date, election_type, election_cycle, COUNT(DISTINCT voter_id) as voter_count
    FROM election_votes
    GROUP BY election_name
    HAVING voter_count > 0
    ORDER BY election_date DESC
  `).all();
  res.json({ elections });
});

// Get elections grouped by type for universe builder targeting
router.get('/election-votes/groups', (req, res) => {
  const rows = db.prepare(`
    SELECT election_type, election_name, election_date, COUNT(DISTINCT voter_id) as voter_count
    FROM election_votes
    GROUP BY election_name
    HAVING voter_count > 0
    ORDER BY election_type, election_date DESC
  `).all();

  // Group by type
  const groups = {};
  const typeLabels = {
    general: 'General Elections (Nov)',
    primary: 'Primary Elections (Mar)',
    local: 'Local Elections (May)',
    primary_runoff: 'Primary Runoffs',
    constitutional: 'Constitutional Amendments',
    runoff: 'Runoffs',
    general_runoff: 'General Runoffs',
    local_runoff: 'Local Runoffs',
    special: 'Special Elections'
  };
  for (const r of rows) {
    const t = r.election_type || 'other';
    if (!groups[t]) {
      groups[t] = { type: t, label: typeLabels[t] || t, elections: [], total_voters: 0 };
    }
    groups[t].elections.push({ name: r.election_name, date: r.election_date, voter_count: r.voter_count });
    groups[t].total_voters = Math.max(groups[t].total_voters, r.voter_count);
  }
  // Sort elections within each group by date descending
  for (const g of Object.values(groups)) {
    g.elections.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    g.election_count = g.elections.length;
  }
  res.json({ groups: Object.values(groups) });
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
  const delElection = db.transaction(() => {
    db.prepare('DELETE FROM elections WHERE election_name = ?').run(name);
    const result = db.prepare('DELETE FROM election_votes WHERE election_name = ?').run(name);
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Election deleted: ' + name + ' (' + result.changes + ' vote records removed)');
    return result.changes;
  });
  const votesRemoved = delElection();
  res.json({ success: true, votes_removed: votesRemoved });
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
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses,
          county_commissioners, justice_of_peace, state_senate, state_board_ed, hospital_districts,
          single_member_cities, drainage_districts, school_boards, city_councils, constables,
          court_of_appeals_dists, not_incorporated_areas } = filters;

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
  if (county_commissioners && county_commissioners.length > 0) {
    clauses.push('county_commissioner IN (' + county_commissioners.map(() => '?').join(',') + ')');
    params.push(...county_commissioners);
  }
  if (justice_of_peace && justice_of_peace.length > 0) {
    clauses.push('justice_of_peace IN (' + justice_of_peace.map(() => '?').join(',') + ')');
    params.push(...justice_of_peace);
  }
  if (state_senate && state_senate.length > 0) {
    clauses.push('state_senate IN (' + state_senate.map(() => '?').join(',') + ')');
    params.push(...state_senate);
  }
  if (state_board_ed && state_board_ed.length > 0) {
    clauses.push('state_board_ed IN (' + state_board_ed.map(() => '?').join(',') + ')');
    params.push(...state_board_ed);
  }
  if (hospital_districts && hospital_districts.length > 0) {
    clauses.push('hospital_district IN (' + hospital_districts.map(() => '?').join(',') + ')');
    params.push(...hospital_districts);
  }
  if (voter_statuses && voter_statuses.length > 0) {
    clauses.push('voter_status IN (' + voter_statuses.map(() => '?').join(',') + ')');
    params.push(...voter_statuses);
  }

  // Vote method filter: applied in election targeting query, NOT here
  // (so it combines with selected_elections to mean "voted by mail IN that election")

  // Minimum elections filter: only voters who voted in at least N distinct elections
  if (min_elections != null && min_elections > 0) {
    clauses.push('voters.id IN (SELECT voter_id FROM election_votes GROUP BY voter_id HAVING COUNT(DISTINCT election_name) >= ?)');
    params.push(min_elections);
  }

  // Vote frequency percentage filters (VAN-style turnout propensity)
  if (filters.min_vote_frequency != null && parseInt(filters.min_vote_frequency) > 0) {
    clauses.push('voters.vote_frequency >= ?');
    params.push(parseInt(filters.min_vote_frequency));
  }
  if (filters.max_vote_frequency != null && parseInt(filters.max_vote_frequency) < 100) {
    clauses.push('voters.vote_frequency <= ?');
    params.push(parseInt(filters.max_vote_frequency));
  }
  if (filters.min_general_frequency != null && parseInt(filters.min_general_frequency) > 0) {
    clauses.push('voters.general_frequency >= ?');
    params.push(parseInt(filters.min_general_frequency));
  }
  if (filters.min_primary_frequency != null && parseInt(filters.min_primary_frequency) > 0) {
    clauses.push('voters.primary_frequency >= ?');
    params.push(parseInt(filters.min_primary_frequency));
  }
  if (filters.min_may_frequency != null && parseInt(filters.min_may_frequency) > 0) {
    clauses.push('voters.may_frequency >= ?');
    params.push(parseInt(filters.min_may_frequency));
  }

  // Party filter: applied in election targeting query when elections are selected
  // Falls back to "ever voted with this party" when no elections selected
  let partyJoin = '';
  if (parties && parties.length > 0 && !(filters._hasSelectedElections)) {
    // No elections selected — filter by party across all elections
    clauses.push('voters.id IN (SELECT ev_party.voter_id FROM election_votes ev_party WHERE ev_party.party_voted IN (' + parties.map(() => '?').join(',') + '))');
    params.push(...parties);
  }

  return { where: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params, partyJoin };
}

router.post('/universe/build', (req, res) => {
  const { precincts, years_back, election_cycles, priority_elections, selected_elections, require_all_elections,
          list_name, list_name_universe, list_name_sub, list_name_priority,
          genders, age_min, age_max, cities, school_districts, college_districts,
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses,
          county_commissioners, justice_of_peace, state_senate, state_board_ed, hospital_districts, vote_methods,
          min_vote_frequency, max_vote_frequency, min_general_frequency, min_primary_frequency, min_may_frequency } = req.body;
  const cutoffYear = new Date().getFullYear() - (years_back || 8);
  const cutoffDate = cutoffYear + '-01-01';

  const step1 = buildStep1Filter({ precincts, genders, age_min, age_max, cities,
    school_districts, college_districts, navigation_ports, port_authorities,
    state_reps, us_congress, parties, min_elections, voter_statuses,
    county_commissioners, justice_of_peace, state_senate, state_board_ed, hospital_districts, vote_methods,
    min_vote_frequency, max_vote_frequency, min_general_frequency, min_primary_frequency, min_may_frequency,
    _hasSelectedElections: !!(selected_elections && selected_elections.filter(n => n && n.trim()).length > 0) });

  const hasElectionData = !!db.prepare('SELECT 1 FROM election_votes LIMIT 1').get();

  // Selected individual elections — voter must have voted in ALL (AND logic)
  const elecNames = (selected_elections || []).filter(n => n && n.trim());

  const buildTx = db.transaction(() => {
    // Step 1: filtered voters -> temp table
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO _univ_precinct SELECT DISTINCT voters.id FROM voters' + step1.partyJoin + ' WHERE ' + step1.where).run(...step1.params);
    const totalInPrecincts = (db.prepare('SELECT COUNT(*) as c FROM _univ_precinct').get() || { c: 0 }).c;

    // Basic mode: no election data
    if (!hasElectionData) {
      const insertList = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)');
      const created = {};
      const finalName = list_name || list_name_universe;
      if (finalName) {
        const r = insertList.run(finalName, 'All registered voters matching filters', 'universe');
        const listId = r.lastInsertRowid;
        const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_precinct').run(listId);
        created.universe = { listId, added: added.changes };
      }
      const basicHouseholdCount = (db.prepare(`
        SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
        FROM voters v INNER JOIN _univ_precinct up ON v.id = up.voter_id
      `).get() || { c: 0 }).c;
      db.exec('DROP TABLE IF EXISTS _univ_precinct');
      return { totalInPrecincts, universeCount: totalInPrecincts, targetedCount: totalInPrecincts, householdCount: basicHouseholdCount, created, basicMode: true };
    }

    // Step 2: universe — voted in last N years
    db.exec('DROP TABLE IF EXISTS _univ_universe');
    db.exec('CREATE TEMP TABLE _univ_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_precinct up ON ev.voter_id = up.voter_id
      WHERE ev.election_date >= ?`).run(cutoffDate);
    const universeCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_universe').get() || { c: 0 }).c;

    // Step 3: Election Targeting — OR or AND logic depending on require_all_elections
    let targetedCount = universeCount;
    db.exec('DROP TABLE IF EXISTS _univ_targeted');
    if (elecNames.length > 0) {
      const ph = elecNames.map(() => '?').join(',');
      let extraClauses = '';
      const targetParams = [...elecNames];
      if (vote_methods && vote_methods.length > 0) {
        extraClauses += ' AND vote_method IN (' + vote_methods.map(() => '?').join(',') + ')';
        targetParams.push(...vote_methods);
      }
      if (parties && parties.length > 0) {
        extraClauses += ' AND party_voted IN (' + parties.map(() => '?').join(',') + ')';
        targetParams.push(...parties);
      }
      db.exec('CREATE TEMP TABLE _univ_targeted (voter_id INTEGER PRIMARY KEY)');
      if (require_all_elections && elecNames.length > 1) {
        // AND logic: voter must have voted in ALL selected elections
        db.prepare(`INSERT INTO _univ_targeted
          SELECT voter_id FROM election_votes
          WHERE election_name IN (${ph})${extraClauses} AND voter_id IN (SELECT voter_id FROM _univ_universe)
          GROUP BY voter_id
          HAVING COUNT(DISTINCT election_name) = ?`).run(...targetParams, elecNames.length);
      } else {
        // OR logic: voter voted in ANY selected election
        db.prepare(`INSERT INTO _univ_targeted
          SELECT DISTINCT voter_id FROM election_votes
          WHERE election_name IN (${ph})${extraClauses} AND voter_id IN (SELECT voter_id FROM _univ_universe)`).run(...targetParams);
      }
      targetedCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_targeted').get() || { c: 0 }).c;
    } else if (vote_methods && vote_methods.length > 0 || parties && parties.length > 0) {
      let extraClauses = '';
      const targetParams = [];
      if (vote_methods && vote_methods.length > 0) {
        extraClauses += (extraClauses ? ' AND ' : '') + 'vote_method IN (' + vote_methods.map(() => '?').join(',') + ')';
        targetParams.push(...vote_methods);
      }
      if (parties && parties.length > 0) {
        extraClauses += (extraClauses ? ' AND ' : '') + 'party_voted IN (' + parties.map(() => '?').join(',') + ')';
        targetParams.push(...parties);
      }
      db.exec('CREATE TEMP TABLE _univ_targeted (voter_id INTEGER PRIMARY KEY)');
      db.prepare(`INSERT INTO _univ_targeted
        SELECT DISTINCT voter_id FROM election_votes
        WHERE ${extraClauses} AND voter_id IN (SELECT voter_id FROM _univ_universe)`).run(...targetParams);
      targetedCount = (db.prepare('SELECT COUNT(*) as c FROM _univ_targeted').get() || { c: 0 }).c;
    } else {
      db.exec('CREATE TEMP TABLE _univ_targeted AS SELECT * FROM _univ_universe');
    }

    // Backward compat: old cycle/priority system
    let subUniverseCount = universeCount;
    let priorityCount = 0;
    if (election_cycles && election_cycles.length > 0) {
      const cPh = election_cycles.map(() => '?').join(',');
      subUniverseCount = (db.prepare(`SELECT COUNT(DISTINCT ev.voter_id) as c FROM election_votes ev
        INNER JOIN _univ_universe uu ON ev.voter_id = uu.voter_id
        WHERE ev.election_cycle IN (${cPh})`).get(...election_cycles) || { c: 0 }).c;
    }
    if (priority_elections && priority_elections.length > 0) {
      const pPh = priority_elections.map(() => '?').join(',');
      priorityCount = (db.prepare(`SELECT COUNT(DISTINCT ev.voter_id) as c FROM election_votes ev
        INNER JOIN _univ_universe uu ON ev.voter_id = uu.voter_id
        WHERE ev.election_name IN (${pPh})`).get(...priority_elections) || { c: 0 }).c;
    }

    // Create lists
    const insertList = db.prepare('INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)');
    const created = {};
    const finalName = list_name || list_name_universe;
    if (finalName) {
      const descParts = ['Targeted voters matching filters'];
      if (elecNames.length > 0) {
        descParts.push('Elections: ' + elecNames.join(', '));
      }
      const r = insertList.run(finalName, descParts.join(' — '), 'universe');
      const listId = r.lastInsertRowid;
      const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_targeted').run(listId);
      created.universe = { listId, added: added.changes };
    }

    // Count unique households in the targeted list
    const householdCount = (db.prepare(`
      SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
      FROM voters v INNER JOIN _univ_targeted ut ON v.id = ut.voter_id
    `).get() || { c: 0 }).c;

    // Cleanup
    db.exec('DROP TABLE IF EXISTS _univ_precinct; DROP TABLE IF EXISTS _univ_universe; DROP TABLE IF EXISTS _univ_targeted');

    return { totalInPrecincts, universeCount, targetedCount, subUniverseCount, priorityCount, extraCount: subUniverseCount - priorityCount, householdCount, created, basicMode: false };
  });

  const result = buildTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Universe built: ' + result.totalInPrecincts + ' in precincts, ' + result.universeCount + ' universe, ' +
    result.targetedCount + ' targeted'
  );

  res.json({
    success: true,
    total_in_precincts: result.totalInPrecincts,
    universe: result.universeCount,
    targeted: result.targetedCount,
    households: result.householdCount || 0,
    sub_universe: result.subUniverseCount,
    priority: result.priorityCount,
    extra: result.extraCount,
    created: result.created
  });
});

// Preview universe counts without creating lists
router.post('/universe/preview', (req, res) => {
  const { precincts, years_back, selected_elections, require_all_elections,
          genders, age_min, age_max, cities, school_districts, college_districts,
          navigation_ports, port_authorities, state_reps, us_congress, parties, min_elections, voter_statuses,
          county_commissioners, justice_of_peace, state_senate, state_board_ed, hospital_districts, vote_methods,
          min_vote_frequency, max_vote_frequency, min_general_frequency, min_primary_frequency, min_may_frequency } = req.body;
  const cutoffYear = new Date().getFullYear() - (years_back || 8);
  const cutoffDate = cutoffYear + '-01-01';

  const step1 = buildStep1Filter({ precincts, genders, age_min, age_max, cities,
    school_districts, college_districts, navigation_ports, port_authorities,
    state_reps, us_congress, parties, min_elections, voter_statuses,
    county_commissioners, justice_of_peace, state_senate, state_board_ed, hospital_districts, vote_methods,
    min_vote_frequency, max_vote_frequency, min_general_frequency, min_primary_frequency, min_may_frequency,
    _hasSelectedElections: !!(selected_elections && selected_elections.filter(n => n && n.trim()).length > 0) });

  const hasElectionData = !!db.prepare('SELECT 1 FROM election_votes LIMIT 1').get();
  const elecNames = (selected_elections || []).filter(n => n && n.trim());

  const previewTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _prev_precinct');
    db.exec('CREATE TEMP TABLE _prev_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO _prev_precinct SELECT DISTINCT voters.id FROM voters' + step1.partyJoin + ' WHERE ' + step1.where).run(...step1.params);
    const totalInPrecincts = (db.prepare('SELECT COUNT(*) as c FROM _prev_precinct').get() || { c: 0 }).c;

    if (!hasElectionData) {
      const basicHouseholdCount = (db.prepare(`
        SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
        FROM voters v INNER JOIN _prev_precinct pp ON v.id = pp.voter_id
      `).get() || { c: 0 }).c;
      db.exec('DROP TABLE IF EXISTS _prev_precinct');
      return { totalInPrecincts, universeCount: totalInPrecincts, targetedCount: totalInPrecincts, householdCount: basicHouseholdCount, basicMode: true };
    }

    db.exec('DROP TABLE IF EXISTS _prev_universe');
    db.exec('CREATE TEMP TABLE _prev_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _prev_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _prev_precinct pp ON ev.voter_id = pp.voter_id
      WHERE ev.election_date >= ?`).run(cutoffDate);
    const universeCount = (db.prepare('SELECT COUNT(*) as c FROM _prev_universe').get() || { c: 0 }).c;

    // Election targeting: OR or AND logic depending on require_all_elections flag
    let targetedCount = universeCount;
    if (elecNames.length > 0) {
      const ph = elecNames.map(() => '?').join(',');
      let extraClauses = '';
      const targetParams = [...elecNames];
      if (vote_methods && vote_methods.length > 0) {
        extraClauses += ' AND vote_method IN (' + vote_methods.map(() => '?').join(',') + ')';
        targetParams.push(...vote_methods);
      }
      if (parties && parties.length > 0) {
        extraClauses += ' AND party_voted IN (' + parties.map(() => '?').join(',') + ')';
        targetParams.push(...parties);
      }
      if (require_all_elections && elecNames.length > 1) {
        // AND logic: voter must have voted in ALL selected elections
        targetedCount = (db.prepare(`
          SELECT COUNT(*) as c FROM (
            SELECT voter_id FROM election_votes
            WHERE election_name IN (${ph})${extraClauses} AND voter_id IN (SELECT voter_id FROM _prev_universe)
            GROUP BY voter_id
            HAVING COUNT(DISTINCT election_name) = ?
          )
        `).get(...targetParams, elecNames.length) || { c: 0 }).c;
      } else {
        // OR logic: voter voted in ANY selected election
        targetedCount = (db.prepare(`
          SELECT COUNT(DISTINCT voter_id) as c FROM election_votes
          WHERE election_name IN (${ph})${extraClauses} AND voter_id IN (SELECT voter_id FROM _prev_universe)
        `).get(...targetParams) || { c: 0 }).c;
      }
    } else if (vote_methods && vote_methods.length > 0 || parties && parties.length > 0) {
      // No elections selected but vote method or party filter set
      let extraClauses = '';
      const targetParams = [];
      if (vote_methods && vote_methods.length > 0) {
        extraClauses += (extraClauses ? ' AND ' : '') + 'vote_method IN (' + vote_methods.map(() => '?').join(',') + ')';
        targetParams.push(...vote_methods);
      }
      if (parties && parties.length > 0) {
        extraClauses += (extraClauses ? ' AND ' : '') + 'party_voted IN (' + parties.map(() => '?').join(',') + ')';
        targetParams.push(...parties);
      }
      targetedCount = (db.prepare(`
        SELECT COUNT(DISTINCT voter_id) as c FROM election_votes
        WHERE ${extraClauses} AND voter_id IN (SELECT voter_id FROM _prev_universe)
      `).get(...targetParams) || { c: 0 }).c;
    }

    // Count unique households based on address dedup
    let householdCount = totalInPrecincts;
    if (elecNames.length > 0 && require_all_elections && elecNames.length > 1) {
      // AND mode households
      householdCount = (db.prepare(`
        SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
        FROM voters v
        WHERE v.id IN (
          SELECT voter_id FROM election_votes
          WHERE election_name IN (${elecNames.map(() => '?').join(',')}) AND voter_id IN (SELECT voter_id FROM _prev_universe)
          GROUP BY voter_id HAVING COUNT(DISTINCT election_name) = ?
        )
      `).get(...elecNames, elecNames.length) || { c: 0 }).c;
    } else if (elecNames.length > 0) {
      householdCount = (db.prepare(`
        SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
        FROM voters v
        INNER JOIN election_votes ev ON v.id = ev.voter_id
        WHERE ev.election_name IN (${elecNames.map(() => '?').join(',')}) AND v.id IN (SELECT voter_id FROM _prev_universe)
      `).get(...elecNames) || { c: 0 }).c;
    } else {
      householdCount = (db.prepare(`
        SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(v.address,'')) || '|' || TRIM(COALESCE(v.city,'')) || '|' || TRIM(COALESCE(v.zip,'')))) as c
        FROM voters v
        INNER JOIN _prev_universe pu ON v.id = pu.voter_id
      `).get() || { c: 0 }).c;
    }

    db.exec('DROP TABLE IF EXISTS _prev_precinct; DROP TABLE IF EXISTS _prev_universe');

    return { totalInPrecincts, universeCount, targetedCount, householdCount, basicMode: false };
  });

  const r = previewTx();
  res.json({
    total_in_precincts: r.totalInPrecincts,
    universe: r.universeCount,
    targeted: r.targetedCount,
    households: r.householdCount || r.totalInPrecincts,
    basic_mode: r.basicMode || false
  });
});

// ===================== VOTE BY MAIL MATCHING =====================
router.post('/voters/vbm-match', (req, res) => {
  const { voters } = req.body; // array of { first_name, last_name, vuid, address, city, zip }
  if (!Array.isArray(voters) || voters.length === 0) {
    return res.status(400).json({ error: 'voters array required' });
  }

  // Prepare match queries
  const byVuid = db.prepare(`
    SELECT id, first_name, last_name, address, city, state, zip, zip4, phone, email,
           registration_number, precinct, party, support_level
    FROM voters WHERE registration_number = ? COLLATE NOCASE LIMIT 1
  `);
  const byStateFileId = db.prepare(`
    SELECT id, first_name, last_name, address, city, state, zip, zip4, phone, email,
           registration_number, precinct, party, support_level
    FROM voters WHERE state_file_id = ? COLLATE NOCASE LIMIT 1
  `);
  const byName = db.prepare(`
    SELECT id, first_name, last_name, address, city, state, zip, zip4, phone, email,
           registration_number, precinct, party, support_level
    FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) LIMIT 10
  `);
  const byNameCity = db.prepare(`
    SELECT id, first_name, last_name, address, city, state, zip, zip4, phone, email,
           registration_number, precinct, party, support_level
    FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND LOWER(city) = LOWER(?) LIMIT 5
  `);
  const byNameZip = db.prepare(`
    SELECT id, first_name, last_name, address, city, state, zip, zip4, phone, email,
           registration_number, precinct, party, support_level
    FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND zip = ? LIMIT 5
  `);

  const matched = [];
  const unmatched = [];
  const matchMethods = { vuid: 0, state_file_id: 0, name_address: 0, name_city: 0, name_zip: 0, name_only: 0 };

  for (const v of voters) {
    const firstName = (v.first_name || '').trim();
    const lastName = (v.last_name || '').trim();
    const vuid = (v.vuid || '').trim();
    const addr = (v.address || '').trim().toLowerCase();
    const city = (v.city || '').trim();
    const zip = (v.zip || '').trim();
    let found = null;
    let method = '';

    // 1. Match by VUID / registration number
    if (vuid && !found) {
      found = byVuid.get(vuid);
      if (!found) found = byStateFileId.get(vuid);
      if (found) method = found ? 'vuid' : '';
    }

    // 2. Match by name + city
    if (!found && firstName && lastName && city) {
      const candidates = byNameCity.all(firstName, lastName, city);
      if (candidates.length === 1) {
        found = candidates[0];
        method = 'name_city';
      } else if (candidates.length > 1 && addr) {
        // Try to narrow by address
        found = candidates.find(c => c.address && c.address.toLowerCase().includes(addr.substring(0, 10))) || null;
        if (found) method = 'name_address';
      }
    }

    // 3. Match by name + zip
    if (!found && firstName && lastName && zip) {
      const candidates = byNameZip.all(firstName, lastName, zip);
      if (candidates.length === 1) {
        found = candidates[0];
        method = 'name_zip';
      } else if (candidates.length > 1 && addr) {
        found = candidates.find(c => c.address && c.address.toLowerCase().includes(addr.substring(0, 10))) || null;
        if (found) method = 'name_address';
      }
    }

    // 4. Match by name only (only accept if unique)
    if (!found && firstName && lastName) {
      const candidates = byName.all(firstName, lastName);
      if (candidates.length === 1) {
        found = candidates[0];
        method = 'name_only';
      } else if (candidates.length > 1 && addr) {
        found = candidates.find(c => c.address && c.address.toLowerCase().includes(addr.substring(0, 10))) || null;
        if (found) method = 'name_address';
      }
    }

    if (found) {
      matchMethods[method]++;
      matched.push({
        input_first: firstName,
        input_last: lastName,
        input_vuid: vuid,
        match_method: method,
        voter_id: found.id,
        first_name: found.first_name,
        last_name: found.last_name,
        address: found.address,
        city: found.city,
        state: found.state || 'TX',
        zip: found.zip,
        zip4: found.zip4,
        phone: found.phone,
        email: found.email,
        registration_number: found.registration_number,
        precinct: found.precinct,
        party: found.party,
        support_level: found.support_level
      });
    } else {
      unmatched.push({
        first_name: firstName,
        last_name: lastName,
        vuid: vuid,
        address: v.address || '',
        city: city,
        zip: zip
      });
    }
  }

  res.json({
    total: voters.length,
    matched_count: matched.length,
    unmatched_count: unmatched.length,
    match_rate: voters.length > 0 ? Math.round(matched.length / voters.length * 100) : 0,
    match_methods: matchMethods,
    matched,
    unmatched
  });
});

// ===================== Universe/List CSV Download =====================

router.get('/admin-lists/:id/download', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.secondary_phone, v.email,
           v.address, v.city, v.zip, v.party, v.support_level, v.voter_score,
           v.phone_type, v.phone_carrier, v.precinct,
           v.registration_number, v.county_file_id
    FROM voters v
    JOIN admin_list_voters alv ON alv.voter_id = v.id
    WHERE alv.list_id = ?
    ORDER BY v.last_name, v.first_name
  `).all(req.params.id);

  if (voters.length === 0) return res.status(404).json({ error: 'No voters in this list' });

  // Build CSV
  const headers = Object.keys(voters[0]);
  const csvRows = [headers.join(',')];
  for (const v of voters) {
    csvRows.push(headers.map(h => {
      const val = (v[h] || '').toString().replace(/"/g, '""');
      return '"' + val + '"';
    }).join(','));
  }

  const safeName = (list.name || 'universe').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.send(csvRows.join('\n'));
});

module.exports = router;
