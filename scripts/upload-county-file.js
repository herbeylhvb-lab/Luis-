#!/usr/bin/env node
/**
 * Local script to process VR-ALL-2.xlsx and upload to production in batches.
 * Usage: node scripts/upload-county-file.js /path/to/VR-ALL-2.xlsx https://villarrealjr.com TOKEN
 */
const XLSX = require('xlsx');
const path = require('path');

const filePath = process.argv[2] || path.join(require('os').homedir(), 'Downloads', 'VR-ALL-2.xlsx');
const baseUrl = process.argv[3] || 'https://villarrealjr.com';
const token = process.argv[4] || process.env.IMPORT_TOKEN;
if (!token) { console.error('Error: Import token required. Pass as 3rd argument or set IMPORT_TOKEN env var.'); process.exit(1); }
const BATCH_SIZE = 2000;

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
} = require('../district-codes');

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

async function sendBatch(batchNum, voters, votes) {
  const body = JSON.stringify({
    voters,
    votes,
    ensure_elections: batchNum === 1 ? Object.values(ELECTION_MAP) : undefined
  });

  const resp = await fetch(`${baseUrl}/api/voters/import-county-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Import-Token': token
    },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Batch ${batchNum} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function main() {
  console.log(`Reading ${filePath}...`);
  const workbook = XLSX.readFile(filePath, { dense: false });
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
  const rows = data.slice(1);
  console.log(`${rows.length} rows loaded. Processing and uploading in batches of ${BATCH_SIZE}...`);

  let totalCreated = 0, totalUpdated = 0, totalVotes = 0;
  let batchNum = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batchNum++;
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const voters = [];
    const votes = [];

    for (const row of chunk) {
      const vuid = String(row[C.VUID] || '').trim();
      if (!vuid) continue;

      const { last, first, middle } = parseName(row[C.NAME]);
      const cityCode = String(row[C.CITY_DISTRICT] || '').trim();
      const schoolCode = String(row[C.SCHOOL] || '').trim();
      const navCode = String(row[C.NAVIGATION_PORT] || '').trim();
      const portCode = String(row[C.PORT_AUTHORITY] || '').trim();

      voters.push({
        vuid, first, last, middle,
        gender: String(row[C.GENDER] || '').trim(),
        age: row[C.AGE] ? Number(row[C.AGE]) : null,
        status: String(row[C.STATUS] || '').trim(),
        precinct: String(row[C.PRECINCT] || '').trim(),
        address: buildAddress(row),
        city: CITY_LABELS[cityCode] || cityCode,
        zip: String(row[C.ZIP5] || '').trim(),
        zip4: String(row[C.ZIP4] || '').trim(),
        commish: String(row[C.COUNTY_COMMISSIONER] || '').trim(),
        jp: String(row[C.JUSTICE_OF_PEACE] || '').trim(),
        sboe: String(row[C.STATE_BOARD_ED] || '').trim(),
        stateRep: String(row[C.STATE_REP] || '').trim(),
        stateSen: String(row[C.STATE_SENATE] || '').trim(),
        congress: String(row[C.US_CONGRESS] || '').trim(),
        school: SCHOOL_LABELS[schoolCode] || schoolCode,
        college: String(row[C.COLLEGE] || '').trim(),
        hospital: String(row[C.HOSPITAL] || '').trim(),
        navPort: NAV_PORT_LABELS[navCode] || navCode,
        portAuth: PORT_AUTH_LABELS[portCode] || portCode,
      });

      // Election history
      for (let j = C.ELECTION_START; j < 236; j += 3) {
        const code = String(row[j] || '').trim();
        if (!code) continue;
        const info = ELECTION_MAP[code];
        if (!info) continue;
        votes.push({
          vuid,
          name: info.name, date: info.date, type: info.type, cycle: info.cycle,
          party: String(row[j + 1] || '').trim() || null
        });
      }
    }

    try {
      const result = await sendBatch(batchNum, voters, votes);
      totalCreated += result.created || 0;
      totalUpdated += result.updated || 0;
      totalVotes += result.votesInserted || 0;
      console.log(`  Batch ${batchNum}: ${voters.length} voters (${result.created} new, ${result.updated} updated, ${result.votesInserted} votes) — ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
    } catch (err) {
      console.error(`  ERROR batch ${batchNum}:`, err.message);
      // Continue with next batch
    }
  }

  console.log(`\nDone! ${totalCreated} created, ${totalUpdated} updated, ${totalVotes} election votes inserted.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
