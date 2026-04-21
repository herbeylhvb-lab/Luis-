#!/usr/bin/env node
/**
 * Local merge: reads VR-ALL-2.csv (pre-converted from xlsx) and imports into production DB.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const DB_PATH = path.join(require('os').homedir(), 'Downloads', 'campaign-production.db');
const CSV_PATH = path.join(require('os').homedir(), 'Downloads', 'VR-ALL-2.csv');

console.log('Opening database:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Column indices (0-based, matching the xlsx column layout)
const C = {
  VUID: 0, STATUS: 1, PRECINCT: 2, NAME: 3,
  STREET_NUM: 5, STREET_NAME: 6, PRE_DIR: 7, STREET_NAME2: 8, STREET_TYPE: 9, UNIT: 10,
  CITY: 13, ZIP5: 15, ZIP4: 16, AGE: 24, GENDER: 25,
  COUNTY_COMMISSIONER: 26, JUSTICE_OF_PEACE: 27, STATE_BOARD_ED: 28,
  STATE_REP: 29, STATE_SENATE: 30, US_CONGRESS: 31, CITY_DISTRICT: 32,
  HOSPITAL: 34, COLLEGE: 35, SCHOOL: 49,
  NAVIGATION_PORT: 85, PORT_AUTHORITY: 90,
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

function buildAddress(cols) {
  return [cols[C.STREET_NUM], cols[C.PRE_DIR], cols[C.STREET_NAME],
    cols[C.STREET_NAME2], cols[C.STREET_TYPE],
    cols[C.UNIT] ? `#${cols[C.UNIT]}` : ''
  ].filter(Boolean).map(p => p.trim()).filter(Boolean).join(' ');
}

// Simple CSV parser (handles quoted fields with commas)
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

async function main() {
  // Build VUID lookup
  console.log('Building VUID lookup from existing voters...');
  const allVoters = db.prepare("SELECT id, registration_number FROM voters WHERE registration_number != ''").all();
  const vuidMap = {};
  for (const v of allVoters) vuidMap[String(v.registration_number).trim()] = v.id;
  console.log(`  ${Object.keys(vuidMap).length} existing VUIDs mapped`);

  // Prepared statements
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

  // Ensure elections
  for (const info of Object.values(ELECTION_MAP)) insertElectionStmt.run(info.name, info.date, info.type, info.cycle);

  // Stream CSV line by line
  console.log('Reading CSV and importing...');
  const t0 = Date.now();
  let lineNum = 0, created = 0, updated = 0, skipped = 0, votesInserted = 0;
  const batch = [];
  const BATCH_SIZE = 1000;

  const processBatch = db.transaction((rows) => {
    for (const cols of rows) {
      const vuid = (cols[C.VUID] || '').trim();
      if (!vuid) { skipped++; continue; }

      let voterId = vuidMap[vuid];
      const { last, first, middle } = parseName(cols[C.NAME]);
      const cityCode = (cols[C.CITY_DISTRICT] || '').trim();
      const schoolCode = (cols[C.SCHOOL] || '').trim();
      const navCode = (cols[C.NAVIGATION_PORT] || '').trim();
      const portCode = (cols[C.PORT_AUTHORITY] || '').trim();
      const cityLabel = CITY_LABELS[cityCode] || cityCode;
      const schoolLabel = SCHOOL_LABELS[schoolCode] || schoolCode;
      const navPort = NAV_PORT_LABELS[navCode] || navCode;
      const portAuth = PORT_AUTH_LABELS[portCode] || portCode;
      const gender = (cols[C.GENDER] || '').trim();
      const age = cols[C.AGE] ? Number(cols[C.AGE]) : null;
      const status = (cols[C.STATUS] || '').trim();
      const precinct = (cols[C.PRECINCT] || '').trim();
      const address = buildAddress(cols);
      const zip = (cols[C.ZIP5] || '').trim();
      const zip4 = (cols[C.ZIP4] || '').trim();
      const commish = (cols[C.COUNTY_COMMISSIONER] || '').trim();
      const jp = (cols[C.JUSTICE_OF_PEACE] || '').trim();
      const sboe = (cols[C.STATE_BOARD_ED] || '').trim();
      const stateRep = (cols[C.STATE_REP] || '').trim();
      const stateSen = (cols[C.STATE_SENATE] || '').trim();
      const congress = (cols[C.US_CONGRESS] || '').trim();
      const college = (cols[C.COLLEGE] || '').trim();
      const hospital = (cols[C.HOSPITAL] || '').trim();

      if (voterId) {
        updateVoterStmt.run(gender, age, status, precinct, address, cityLabel, zip,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth,
          first, last, middle, zip4, voterId);
        updated++;
      } else {
        const r = insertVoterStmt.run(vuid, first, last, middle,
          gender, age, status, precinct, address, cityLabel, zip, zip4,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth);
        voterId = r.lastInsertRowid;
        vuidMap[vuid] = voterId;
        created++;
      }

      // Election history
      for (let i = C.ELECTION_START; i < Math.min(cols.length, 236); i += 3) {
        const code = (cols[i] || '').trim();
        if (!code) continue;
        const info = ELECTION_MAP[code];
        if (!info) continue;
        const party = (cols[i + 1] || '').trim() || null;
        insertVoteStmt.run(voterId, info.name, info.date, info.type, info.cycle, party);
        votesInserted++;
      }
    }
  });

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(CSV_PATH), crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineNum++;
      if (lineNum === 1) return; // skip header
      batch.push(parseCSVLine(line));
      if (batch.length >= BATCH_SIZE) {
        processBatch(batch.splice(0));
        if (lineNum % 10000 === 0) {
          const pct = ((lineNum / 238133) * 100).toFixed(0);
          console.log(`  ${pct}% — ${lineNum} rows (${created} new, ${updated} updated, ${votesInserted} votes)`);
        }
      }
    });
    rl.on('close', () => {
      if (batch.length > 0) processBatch(batch);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\nImport complete in ${elapsed}s:`);
      console.log(`  Created: ${created}`);
      console.log(`  Updated: ${updated}`);
      console.log(`  Skipped: ${skipped}`);
      console.log(`  Election votes: ${votesInserted}`);

      // Ensure admin user
      const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
      if (userCount === 0) {
        console.log('\nCreating admin user...');
        const hash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Admin', 'admin');
        console.log('  username: admin, password: admin123');
        console.log('  CHANGE THIS PASSWORD after upload!');
      }

      // Final stats
      const totalVoters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
      const totalVotes = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
      const totalElections = db.prepare('SELECT COUNT(*) as c FROM elections').get().c;
      console.log(`\nFinal DB stats:`);
      console.log(`  Voters: ${totalVoters.toLocaleString()}`);
      console.log(`  Election votes: ${totalVotes.toLocaleString()}`);
      console.log(`  Elections: ${totalElections}`);

      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('\nDatabase ready for upload!');
      resolve();
    });
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
