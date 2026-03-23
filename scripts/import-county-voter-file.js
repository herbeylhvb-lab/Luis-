#!/usr/bin/env node
/**
 * Import Cameron County Voter File (VR-ALL-2.xlsx)
 *
 * Reads the Texas Secretary of State voter registration file and imports:
 *  - Voter demographics (gender, age, status)
 *  - District assignments (Port of Brownsville, TSC, State Rep, Congress, etc.)
 *  - Full election voting history (39 election codes decoded)
 *
 * Usage:  node scripts/import-county-voter-file.js /path/to/VR-ALL-2.xlsx
 *
 * The script matches voters by VUID → registration_number in the DB.
 * Voters not already in the system are skipped (only enriches existing voters).
 */

const Database = require('better-sqlite3');
const path = require('path');
const XLSX = require('xlsx');

// --- Config ---
const XLSX_PATH = process.argv[2];
if (!XLSX_PATH) {
  console.error('Usage: node scripts/import-county-voter-file.js <path-to-xlsx>');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'data', 'campaign.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// --- Election code → human-readable name + metadata ---
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

// --- District code → human-readable labels ---
const CITY_LABELS = {
  'CBR': 'Brownsville', 'CBV': 'Bayview', 'CHG': 'Harlingen', 'CLA': 'La Feria',
  'CLV': 'Los Fresnos', 'CPR': 'Port Isabel', 'CRV': 'Rio Hondo', 'CSB': 'San Benito',
  'CSP': 'South Padre Island', 'CSX': 'Santa Rosa', 'CLI': 'Laguna Vista',
  'CLC': 'Los Indios', 'CCO': 'Combes', 'CRG': 'Rancho Viejo', 'CPT': 'Palm Valley',
};
const SCHOOL_LABELS = {
  'IBR': 'Brownsville ISD', 'IHG': 'Harlingen ISD', 'ILA': 'La Feria ISD',
  'ILO': 'Los Fresnos ISD', 'IPI': 'Point Isabel ISD', 'ISB': 'San Benito ISD',
  'IRH': 'Rio Hondo ISD', 'ISR': 'Santa Rosa ISD',
};
const NAV_PORT_LABELS = {
  'BND': 'Port of Brownsville', 'PIS': 'Port Isabel Navigation District',
};
const PORT_AUTH_LABELS = {
  'SAN': 'Port of San Benito',
};

// --- Column index map (from the 236-column voter file) ---
const COL = {
  VUID: 0,
  STATUS: 1,
  PRECINCT: 2,
  NAME: 3,         // "LAST, FIRST MIDDLE"
  STREET_NUM: 5,
  STREET_NAME: 6,
  PRE_DIR: 7,
  STREET_NAME2: 8,
  STREET_TYPE: 9,
  UNIT: 10,
  CITY: 13,
  STATE: 14,
  ZIP5: 15,
  ZIP4: 16,
  AGE: 24,
  GENDER: 25,
  // District assignments
  COUNTY_COMMISSIONER: 26,
  JUSTICE_OF_PEACE: 27,
  STATE_BOARD_ED: 28,
  STATE_REP: 29,
  STATE_SENATE: 30,
  US_CONGRESS: 31,
  CITY_DISTRICT: 32,
  HOSPITAL: 34,
  COLLEGE: 35,        // TSC
  SCHOOL: 49,
  NAVIGATION_PORT: 85,  // BND = Port of Brownsville, PIS = Port Isabel
  PORT_AUTHORITY: 90,    // SAN = San Benito
  SINGLE_MEMBER_PORT: 99,
  // Election history starts at col 113
  ELECTION_START: 113,
};

// --- Parse name field: "LAST, FIRST MIDDLE" or "LAST, FIRST" ---
function parseName(nameStr) {
  if (!nameStr) return { last: '', first: '', middle: '' };
  const parts = String(nameStr).split(',');
  const last = (parts[0] || '').trim();
  const rest = (parts[1] || '').trim().split(/\s+/);
  const first = rest[0] || '';
  const middle = rest.slice(1).join(' ');
  return { last, first, middle };
}

// --- Build full address from components ---
function buildAddress(row) {
  const parts = [
    row[COL.STREET_NUM],
    row[COL.PRE_DIR],
    row[COL.STREET_NAME],
    row[COL.STREET_NAME2],
    row[COL.STREET_TYPE],
    row[COL.UNIT] ? `#${row[COL.UNIT]}` : ''
  ].filter(Boolean).map(p => String(p).trim()).filter(Boolean);
  return parts.join(' ');
}

// --- Main import ---
async function main() {
  console.log(`Reading voter file: ${XLSX_PATH}`);
  console.log('This may take a minute for large files...\n');

  const workbook = XLSX.readFile(XLSX_PATH, { dense: false });
  const sheetName = workbook.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

  const header = data[0];
  const rows = data.slice(1);
  console.log(`Loaded ${rows.length} voter rows (${header.length} columns)\n`);

  // Build VUID → voter ID lookup from DB (for existing voters)
  const allVoters = db.prepare("SELECT id, registration_number FROM voters WHERE registration_number != ''").all();
  const vuidMap = {};
  for (const v of allVoters) {
    vuidMap[String(v.registration_number).trim()] = v.id;
  }
  console.log(`Found ${Object.keys(vuidMap).length} existing voters with registration numbers`);
  console.log(`Will CREATE new voter records for everyone in the county file\n`);

  // Prepare statements — INSERT new voters OR UPDATE existing ones
  const insertVoter = db.prepare(`
    INSERT INTO voters (
      registration_number, first_name, last_name, middle_name,
      gender, age, voter_status, precinct,
      address, city, state, zip, zip4,
      county_commissioner, justice_of_peace, state_board_ed,
      state_rep, state_senate, us_congress,
      city_district, school_district, college_district,
      hospital_district, navigation_port, port_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateVoter = db.prepare(`
    UPDATE voters SET
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
    WHERE id = ?
  `);

  const insertElection = db.prepare(
    'INSERT OR IGNORE INTO elections (election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?)'
  );

  const insertVote = db.prepare(
    'INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle, party_voted) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // Ensure all elections exist
  for (const [code, info] of Object.entries(ELECTION_MAP)) {
    insertElection.run(info.name, info.date, info.type, info.cycle);
  }
  console.log(`Ensured ${Object.keys(ELECTION_MAP).length} elections in DB\n`);

  // Process in batches
  let created = 0, updated = 0, skipped = 0, votesInserted = 0;
  const BATCH = 500;

  const runBatch = db.transaction((batchRows) => {
    for (const row of batchRows) {
      const vuid = String(row[COL.VUID] || '').trim();
      if (!vuid) { skipped++; continue; }

      let voterId = vuidMap[vuid];

      // Parse name
      const { last, first, middle } = parseName(row[COL.NAME]);

      // Decode district codes to human-readable labels
      const navCode = String(row[COL.NAVIGATION_PORT] || '').trim();
      const portCode = String(row[COL.PORT_AUTHORITY] || '').trim();
      const cityCode = String(row[COL.CITY_DISTRICT] || '').trim();
      const schoolCode = String(row[COL.SCHOOL] || '').trim();
      const navPort = NAV_PORT_LABELS[navCode] || navCode;         // "Port of Brownsville" or "Port Isabel Navigation District"
      const portAuth = PORT_AUTH_LABELS[portCode] || portCode;     // "Port of San Benito"
      const cityLabel = CITY_LABELS[cityCode] || cityCode;
      const schoolLabel = SCHOOL_LABELS[schoolCode] || schoolCode;

      const gender = String(row[COL.GENDER] || '').trim();
      const age = row[COL.AGE] ? Number(row[COL.AGE]) : null;
      const status = String(row[COL.STATUS] || '').trim();
      const precinct = String(row[COL.PRECINCT] || '').trim();
      const address = buildAddress(row);
      const zip = String(row[COL.ZIP5] || '').trim();
      const zip4 = String(row[COL.ZIP4] || '').trim();
      const commish = String(row[COL.COUNTY_COMMISSIONER] || '').trim();
      const jp = String(row[COL.JUSTICE_OF_PEACE] || '').trim();
      const sboe = String(row[COL.STATE_BOARD_ED] || '').trim();
      const stateRep = String(row[COL.STATE_REP] || '').trim();
      const stateSen = String(row[COL.STATE_SENATE] || '').trim();
      const congress = String(row[COL.US_CONGRESS] || '').trim();
      const college = String(row[COL.COLLEGE] || '').trim();
      const hospital = String(row[COL.HOSPITAL] || '').trim();

      if (voterId) {
        // Update existing voter
        updateVoter.run(
          gender, age, status, precinct,
          address, cityLabel, zip,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth,
          first, last, middle, zip4,
          voterId
        );
        updated++;
      } else {
        // Create new voter
        const result = insertVoter.run(
          vuid, first, last, middle,
          gender, age, status, precinct,
          address, cityLabel, zip, zip4,
          commish, jp, sboe, stateRep, stateSen, congress,
          cityLabel, schoolLabel, college, hospital, navPort, portAuth
        );
        voterId = result.lastInsertRowid;
        vuidMap[vuid] = voterId;
        created++;
      }

      // Extract election history (41 slots, 3 cols each, starting at col 113)
      for (let i = COL.ELECTION_START; i < 236; i += 3) {
        const code = String(row[i] || '').trim();
        if (!code) continue;

        const electionInfo = ELECTION_MAP[code];
        if (!electionInfo) continue; // unknown code, skip

        const party = String(row[i + 1] || '').trim() || null;
        // const voteType = String(row[i + 2] || '').trim(); // "Voted Early", "Election Day", "Mail" — stored as party_voted context

        insertVote.run(
          voterId,
          electionInfo.name,
          electionInfo.date,
          electionInfo.type,
          electionInfo.cycle,
          party || null
        );
        votesInserted++;
      }
    }
  });

  // Process all rows in batches
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    runBatch(batch);
    if ((i + BATCH) % 5000 === 0 || i + BATCH >= rows.length) {
      console.log(`  Processed ${Math.min(i + BATCH, rows.length)} / ${rows.length} rows...`);
    }
  }

  console.log('\n=== Import Complete ===');
  console.log(`Total voter rows:    ${rows.length}`);
  console.log(`New voters created:  ${created}`);
  console.log(`Existing updated:    ${updated}`);
  console.log(`Skipped (no VUID):   ${skipped}`);
  console.log(`Election votes added: ${votesInserted}`);

  // Print district summary
  const portStats = db.prepare("SELECT port_authority, COUNT(*) as cnt FROM voters WHERE port_authority != '' GROUP BY port_authority").all();
  if (portStats.length) {
    console.log('\n--- Port of Brownsville Districts ---');
    for (const r of portStats) console.log(`  Port Authority ${r.port_authority}: ${r.cnt} voters`);
  }

  const navStats = db.prepare("SELECT navigation_port, COUNT(*) as cnt FROM voters WHERE navigation_port != '' GROUP BY navigation_port").all();
  if (navStats.length) {
    console.log('\n--- Navigation/Port Districts ---');
    for (const r of navStats) console.log(`  Navigation ${r.navigation_port}: ${r.cnt} voters`);
  }

  const collegeStats = db.prepare("SELECT college_district, COUNT(*) as cnt FROM voters WHERE college_district != '' GROUP BY college_district").all();
  if (collegeStats.length) {
    console.log('\n--- College Districts (TSC) ---');
    for (const r of collegeStats) console.log(`  College ${r.college_district}: ${r.cnt} voters`);
  }

  const genderStats = db.prepare("SELECT gender, COUNT(*) as cnt FROM voters WHERE gender != '' GROUP BY gender").all();
  if (genderStats.length) {
    console.log('\n--- Gender Breakdown ---');
    for (const r of genderStats) console.log(`  ${r.gender}: ${r.cnt} voters`);
  }

  const electionStats = db.prepare("SELECT election_name, COUNT(*) as cnt FROM election_votes GROUP BY election_name ORDER BY cnt DESC LIMIT 15").all();
  if (electionStats.length) {
    console.log('\n--- Top Elections by Participation ---');
    for (const r of electionStats) console.log(`  ${r.election_name}: ${r.cnt} voters`);
  }

  db.close();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
