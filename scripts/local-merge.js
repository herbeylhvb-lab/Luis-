#!/usr/bin/env node
/**
 * Local merge: reads VR-ALL-2.xlsx and imports into the downloaded production DB.
 * Usage: node scripts/local-merge.js
 */
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(require('os').homedir(), 'Downloads', 'campaign-production.db');
const XLSX_PATH = path.join(require('os').homedir(), 'Downloads', 'VR-ALL-2.xlsx');

console.log('Opening database:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Column map
const C = {
  VUID: 0, STATUS: 1, PRECINCT: 2, NAME: 3,
  STREET_NUM: 5, STREET_NAME: 6, PRE_DIR: 7, STREET_NAME2: 8, STREET_TYPE: 9, UNIT: 10,
  CITY: 13, STATE: 14, ZIP5: 15, ZIP4: 16, AGE: 24, GENDER: 25,
  COUNTY_COMMISSIONER: 26, JUSTICE_OF_PEACE: 27, STATE_BOARD_ED: 28,
  STATE_REP: 29, STATE_SENATE: 30, US_CONGRESS: 31, CITY_DISTRICT: 32,
  HOSPITAL: 34, COLLEGE: 35, SCHOOL: 49,
  NAVIGATION_PORT: 85, PORT_AUTHORITY: 90, SINGLE_MEMBER_PORT: 99,
  ELECTION_START: 113,
};

const ELECTION_MAP = {
  'GN16': { name: 'General Nov 2016', date: '2016-11-08', type: 'general', cycle: 'november' },
  'GN18': { name: 'General Nov 2018', date: '2018-11-06', type: 'general', cycle: 'november' },
  'GN20': { name: 'General Nov 2020', date: '2020-11-03', type: 'general', cycle: 'november' },
  'GN22': { name: 'General Nov 2022', date: '2022-11-08', type: 'general', cycle: 'november' },
  'GN24': { name: 'General Nov 2024', date: '2024-11-05', type: 'general', cycle: 'november' },
  'P16':  { name: 'Primary Mar 2016', date: '2016-03-01', type: 'primary', cycle: 'march' },
  'P18':  { name: 'Primary Mar 2018', date: '2018-03-06', type: 'primary', cycle: 'march' },
  'P20':  { name: 'Primary Mar 2020', date: '2020-03-03', type: 'primary', cycle: 'march' },
  'P22':  { name: 'Primary Mar 2022', date: '2022-03-01', type: 'primary', cycle: 'march' },
  'P24':  { name: 'Primary Mar 2024', date: '2024-03-05', type: 'primary', cycle: 'march' },
  'PR18': { name: 'Primary Runoff May 2018', date: '2018-05-22', type: 'primary_runoff', cycle: 'may' },
  'PR20': { name: 'Primary Runoff Jul 2020', date: '2020-07-14', type: 'primary_runoff', cycle: 'july' },
  'PR22': { name: 'Primary Runoff May 2022', date: '2022-05-24', type: 'primary_runoff', cycle: 'may' },
  'PR24': { name: 'Primary Runoff May 2024', date: '2024-05-28', type: 'primary_runoff', cycle: 'may' },
  'GR20': { name: 'General Runoff 2020', date: '2020-12-15', type: 'general_runoff', cycle: 'december' },
  'GR24': { name: 'General Runoff 2024', date: '2024-12-14', type: 'general_runoff', cycle: 'december' },
  'R622': { name: 'Runoff Jun 2022', date: '2022-06-14', type: 'runoff', cycle: 'june' },
  'R624': { name: 'Runoff Jun 2024', date: '2024-06-18', type: 'runoff', cycle: 'june' },
  'R625': { name: 'Runoff Jun 2025', date: '2025-06-17', type: 'runoff', cycle: 'june' },
  'CA19': { name: 'Constitutional Amendment 2019', date: '2019-11-05', type: 'constitutional', cycle: 'november' },
  'CA2023': { name: 'Constitutional Amendment 2023', date: '2023-11-07', type: 'constitutional', cycle: 'november' },
  'CA21': { name: 'Constitutional Amendment 2021', date: '2021-11-02', type: 'constitutional', cycle: 'november' },
  'CA25': { name: 'Constitutional Amendment 2025', date: '2025-05-03', type: 'constitutional', cycle: 'may' },
  'CDD5': { name: 'City/District Dec 5', date: '2020-12-05', type: 'local', cycle: 'december' },
  'SP34': { name: 'Special Election 2023', date: '2023-11-07', type: 'special', cycle: 'november' },
  '516':  { name: 'Local May 2016', date: '2016-05-07', type: 'local', cycle: 'may' },
  '517':  { name: 'Local May 2017', date: '2017-05-06', type: 'local', cycle: 'may' },
  '518':  { name: 'Local May 2018', date: '2018-05-05', type: 'local', cycle: 'may' },
  '519':  { name: 'Local May 2019', date: '2019-05-04', type: 'local', cycle: 'may' },
  '521':  { name: 'Local May 2021', date: '2021-05-01', type: 'local', cycle: 'may' },
  '522':  { name: 'Local May 2022', date: '2022-05-07', type: 'local', cycle: 'may' },
  '523':  { name: 'Local May 2023', date: '2023-05-06', type: 'local', cycle: 'may' },
  '524':  { name: 'Local May 2024', date: '2024-05-04', type: 'local', cycle: 'may' },
  '525':  { name: 'Local May 2025', date: '2025-05-03', type: 'local', cycle: 'may' },
  '616':  { name: 'Local Jun 2016', date: '2016-06-18', type: 'local_runoff', cycle: 'june' },
  '618':  { name: 'Local Jun 2018', date: '2018-06-16', type: 'local_runoff', cycle: 'june' },
  '619':  { name: 'Local Jun 2019', date: '2019-06-15', type: 'local_runoff', cycle: 'june' },
  '621':  { name: 'Local Jun 2021', date: '2021-06-05', type: 'local_runoff', cycle: 'june' },
  '623':  { name: 'Local Jun 2023', date: '2023-06-10', type: 'local_runoff', cycle: 'june' },
};

// Shared lookup tables — see ../district-codes.js
const {
  CITY_LABELS,
  SCHOOL_LABELS,
  NAVIGATION_PORT_LABELS: NAV_PORT_LABELS,
  PORT_AUTHORITY_LABELS: PORT_AUTH_LABELS,
} = require('../lib/district-codes');

function parseName(nameStr) {
  if (!nameStr) return { last: '', first: '', middle: '' };
  const parts = String(nameStr).split(',');
  const last = (parts[0] || '').trim();
  const rest = (parts[1] || '').trim().split(/\s+/);
  return { last, first: rest[0] || '', middle: rest.slice(1).join(' ') };
}

function buildAddress(row) {
  return [row[C.STREET_NUM], row[C.PRE_DIR], row[C.STREET_NAME],
    row[C.STREET_NAME2], row[C.STREET_TYPE],
    row[C.UNIT] ? `#${row[C.UNIT]}` : ''
  ].filter(Boolean).map(p => String(p).trim()).filter(Boolean).join(' ');
}

async function main() {
  // Step 1: Read XLSX
  console.log('Reading XLSX file:', XLSX_PATH);
  const t0 = Date.now();
  const workbook = XLSX.readFile(XLSX_PATH, { dense: false });
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
  const rows = data.slice(1);
  console.log(`  ${rows.length} rows loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Step 2: Build VUID lookup
  console.log('Building VUID lookup...');
  const allVoters = db.prepare("SELECT id, registration_number FROM voters WHERE registration_number != ''").all();
  const vuidMap = {};
  for (const v of allVoters) vuidMap[String(v.registration_number).trim()] = v.id;
  console.log(`  ${Object.keys(vuidMap).length} existing VUIDs mapped`);

  // Step 3: Prepare statements
  const insertVoterStmt = db.prepare(`INSERT INTO voters (
    registration_number, first_name, last_name, middle_name,
    gender, age, voter_status, precinct,
    address, city, state, zip, zip4,
    county_commissioner, justice_of_peace, state_board_ed,
    state_rep, state_senate, us_congress,
    city_district, school_district, college_district,
    hospital_district, navigation_port, port_authority
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const updateVoterStmt = db.prepare(`UPDATE voters SET
    gender = ?, age = ?, voter_status = ?, precinct = ?,
    address = CASE WHEN address = '' OR address IS NULL THEN ? ELSE address END,
    city = CASE WHEN city = '' OR city IS NULL THEN ? ELSE city END,
    zip = CASE WHEN zip = '' OR zip IS NULL THEN ? ELSE zip END,
    county_commissioner = ?, justice_of_peace = ?, state_board_ed = ?,
    state_rep = ?, state_senate = ?, us_congress = ?,
    city_district = ?, school_district = ?, college_district = ?,
    hospital_district = ?, navigation_port = ?, port_authority = ?,
    first_name = CASE WHEN first_name = '' OR first_name IS NULL THEN ? ELSE first_name END,
    last_name = CASE WHEN last_name = '' OR last_name IS NULL THEN ? ELSE last_name END,
    middle_name = CASE WHEN middle_name = '' OR middle_name IS NULL THEN ? ELSE middle_name END,
    zip4 = COALESCE(NULLIF(?, ''), zip4)
  WHERE id = ?`);

  const insertElectionStmt = db.prepare('INSERT OR IGNORE INTO elections (election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?)');
  const insertVoteStmt = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle, party_voted) VALUES (?, ?, ?, ?, ?, ?)');

  // Ensure all elections exist
  for (const info of Object.values(ELECTION_MAP)) {
    insertElectionStmt.run(info.name, info.date, info.type, info.cycle);
  }

  // Step 4: Process rows in batches
  let created = 0, updated = 0, skipped = 0, votesInserted = 0;
  const BATCH = 500;
  const t1 = Date.now();

  const runBatch = db.transaction((batchRows) => {
    for (const row of batchRows) {
      const vuid = String(row[C.VUID] || '').trim();
      if (!vuid) { skipped++; continue; }

      let voterId = vuidMap[vuid];
      const { last, first, middle } = parseName(row[C.NAME]);
      const cityCode = String(row[C.CITY_DISTRICT] || '').trim();
      const schoolCode = String(row[C.SCHOOL] || '').trim();
      const navCode = String(row[C.NAVIGATION_PORT] || '').trim();
      const portCode = String(row[C.PORT_AUTHORITY] || '').trim();
      const cityLabel = CITY_LABELS[cityCode] || cityCode;
      const schoolLabel = SCHOOL_LABELS[schoolCode] || schoolCode;
      const navPort = NAV_PORT_LABELS[navCode] || navCode;
      const portAuth = PORT_AUTH_LABELS[portCode] || portCode;
      const gender = String(row[C.GENDER] || '').trim();
      const age = row[C.AGE] ? Number(row[C.AGE]) : null;
      const status = String(row[C.STATUS] || '').trim();
      const precinct = String(row[C.PRECINCT] || '').trim();
      const address = buildAddress(row);
      const zip = String(row[C.ZIP5] || '').trim();
      const zip4 = String(row[C.ZIP4] || '').trim();
      const commish = String(row[C.COUNTY_COMMISSIONER] || '').trim();
      const jp = String(row[C.JUSTICE_OF_PEACE] || '').trim();
      const sboe = String(row[C.STATE_BOARD_ED] || '').trim();
      const stateRep = String(row[C.STATE_REP] || '').trim();
      const stateSen = String(row[C.STATE_SENATE] || '').trim();
      const congress = String(row[C.US_CONGRESS] || '').trim();
      const college = String(row[C.COLLEGE] || '').trim();
      const hospital = String(row[C.HOSPITAL] || '').trim();

      if (voterId) {
        updateVoterStmt.run(gender, age, status, precinct, address, cityLabel, zip,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth,
          first, last, middle, zip4, voterId);
        updated++;
      } else {
        const result = insertVoterStmt.run(vuid, first, last, middle,
          gender, age, status, precinct, address, cityLabel, zip, zip4,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth);
        voterId = result.lastInsertRowid;
        vuidMap[vuid] = voterId;
        created++;
      }

      // Election history (41 slots x 3 cols starting at col 113)
      for (let i = C.ELECTION_START; i < 236; i += 3) {
        const code = String(row[i] || '').trim();
        if (!code) continue;
        const info = ELECTION_MAP[code];
        if (!info) continue;
        const party = String(row[i + 1] || '').trim() || null;
        insertVoteStmt.run(voterId, info.name, info.date, info.type, info.cycle, party);
        votesInserted++;
      }
    }
  });

  for (let i = 0; i < rows.length; i += BATCH) {
    runBatch(rows.slice(i, i + BATCH));
    if ((i + BATCH) % 10000 === 0 || i + BATCH >= rows.length) {
      const pct = Math.min(100, ((i + BATCH) / rows.length * 100)).toFixed(0);
      console.log(`  ${pct}% — ${Math.min(i + BATCH, rows.length)}/${rows.length} (${created} new, ${updated} updated, ${votesInserted} votes)`);
    }
  }

  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\nImport complete in ${elapsed}s:`);
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Election votes: ${votesInserted}`);

  // Step 5: Ensure admin user exists
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    console.log('\nNo users found — creating admin account...');
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Admin', 'admin');
    console.log('  Created admin user (username: admin, password: admin123)');
    console.log('  ⚠️  Change this password immediately after upload!');
  }

  // Step 6: Final stats
  const totalVoters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const totalVotes = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
  const totalElections = db.prepare('SELECT COUNT(*) as c FROM elections').get().c;
  console.log(`\nFinal database stats:`);
  console.log(`  Total voters: ${totalVoters}`);
  console.log(`  Total election votes: ${totalVotes}`);
  console.log(`  Elections defined: ${totalElections}`);

  // Checkpoint WAL into main file for clean upload
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('\nDatabase closed and WAL checkpointed. Ready for upload!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
