#!/usr/bin/env node
/**
 * Import Cameron County voter file CSV into CampaignText HQ
 * Maps Cameron County column names to system fields and sends in batches
 *
 * Usage: node scripts/import-cameron-county.js <csv-path> [server-url]
 */
const fs = require('fs');
const path = require('path');

const CSV_PATH = process.argv[2] || '/Users/luisvillarreal/Desktop/VR-HIST-03262026.csv';
const SERVER = process.argv[3] || 'https://campaigntext-production.up.railway.app';
const BATCH_SIZE = 500;
const SKIP_BATCHES = parseInt(process.env.SKIP_BATCHES || '0');

// Read credentials from env or hardcode for one-time use
const USERNAME = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASS || '';

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function parseName(fullName) {
  // Format: "LAST, FIRST MIDDLE"
  if (!fullName) return { first_name: '', last_name: '', middle_name: '' };
  const parts = fullName.split(',');
  const last = (parts[0] || '').trim();
  const firstMiddle = (parts[1] || '').trim().split(/\s+/);
  return {
    first_name: firstMiddle[0] || '',
    last_name: last,
    middle_name: firstMiddle.length > 1 ? firstMiddle.slice(1).join(' ') : ''
  };
}

let sessionCookie = '';

async function login() {
  if (!PASSWORD) {
    console.error('Set ADMIN_PASS env var to your admin password');
    process.exit(1);
  }
  const resp = await fetch(SERVER + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual'
  });
  if (!resp.ok) throw new Error('Login failed: ' + resp.status);
  // Get session cookie
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!sessionCookie) {
    // Try raw header
    const raw = resp.headers.get('set-cookie') || '';
    sessionCookie = raw.split(';')[0];
  }
  const data = await resp.json();
  console.log('Session cookie:', sessionCookie ? 'obtained' : 'MISSING');
  return data;
}

async function sendBatch(voters) {
  const resp = await fetch(SERVER + '/api/voters/import-voter-file', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({ voters })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Import failed (' + resp.status + '): ' + text.slice(0, 200));
  }
  return resp.json();
}

async function main() {
  console.log('Reading CSV:', CSV_PATH);
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = parseCsvLine(lines[0]);

  console.log('Headers:', headers.length, 'columns');
  console.log('Data rows:', lines.length - 1);

  // Build header index
  const hIdx = {};
  headers.forEach((h, i) => { hIdx[h.replace(/^\uFEFF/, '').trim()] = i; });

  // Map rows
  const allVoters = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols[0]) continue;

    const vuid = cols[hIdx['VUID']] || '';
    const name = parseName(cols[hIdx['NAME']] || '');
    const status = cols[hIdx['Status']] || '';
    const precinct = cols[hIdx['Precinct']] || '';
    const address = cols[hIdx['Residential Address']] || '';
    const unit = cols[hIdx['Unit']] || '';
    const unitType = cols[hIdx['Unit Type']] || '';
    const city = cols[hIdx['City']] || cols[hIdx['CITY']] || '';
    const state = cols[hIdx['State']] || 'TX';
    const zip = cols[hIdx['Zip Code 5']] || '';
    const zip4 = cols[hIdx['Zip Code 4']] || '';
    const age = cols[hIdx['Age']] || '';

    // Districts
    const navDistrict = cols[hIdx['NAVIGATION DISTRICT']] || '';
    const navPortDistrict = cols[hIdx['NAVIGATION AND PORT DISTRICT']] || '';
    const portAuth = cols[hIdx['PORT AUTHORITY']] || '';
    const countyComm = cols[hIdx['COUNTY COMMISSIONER']] || '';
    const jp = cols[hIdx['JUSTICE OF THE PEACE']] || '';
    const stateBoard = cols[hIdx['STATE BOARD OF EDUCATION']] || '';
    const stateRep = cols[hIdx['STATE REPRESENTATIVE']] || '';
    const stateSenate = cols[hIdx['STATE SENATE']] || '';
    const usCongress = cols[hIdx['US CONGRESS']] || '';
    const school = cols[hIdx['SCHOOL']] || '';
    const college = cols[hIdx['COLLEGE']] || '';
    const hospital = cols[hIdx['HOSPITAL']] || '';

    const voter = {
      registration_number: vuid,
      first_name: name.first_name,
      last_name: name.last_name,
      middle_name: name.middle_name,
      address: address,
      city: city,
      state: state,
      zip: zip,
      zip4: zip4,
      precinct: precinct,
      age: age,
      Unit: unit,
      'Unit Type': unitType,
      Status: status,
      'NAVIGATION DISTRICT': navDistrict || navPortDistrict,
      county_commissioner: countyComm,
      justice_of_peace: jp,
      state_board_ed: stateBoard,
      state_rep: stateRep,
      state_senate: stateSenate,
      us_congress: usCongress,
      school_district: school,
      college_district: college,
      hospital_district: hospital,
      navigation_port: navDistrict || navPortDistrict,
      port_authority: portAuth
    };

    // Election history (44 elections)
    for (let e = 1; e <= 44; e++) {
      const pad = e < 10 ? '0' + e : String(e);
      const codeKey = 'Election' + pad + ' Code';
      const partyKey = 'Election' + pad + ' Party Code';
      const voteTypeKey = 'Election' + pad + ' Vote Type';
      if (hIdx[codeKey] !== undefined) voter[codeKey] = cols[hIdx[codeKey]] || '';
      if (hIdx[partyKey] !== undefined) voter[partyKey] = cols[hIdx[partyKey]] || '';
      if (hIdx[voteTypeKey] !== undefined) voter[voteTypeKey] = cols[hIdx[voteTypeKey]] || '';
    }

    allVoters.push(voter);
  }

  console.log('Mapped', allVoters.length, 'voters');

  // Login
  console.log('Logging in...');
  await login();
  console.log('Logged in');

  // Send in batches
  let totalAdded = 0, totalUpdated = 0, totalElections = 0;
  const batches = Math.ceil(allVoters.length / BATCH_SIZE);

  if (SKIP_BATCHES > 0) console.log('Skipping first', SKIP_BATCHES, 'batches (' + (SKIP_BATCHES * BATCH_SIZE) + ' voters)');

  for (let b = SKIP_BATCHES; b < batches; b++) {
    const start = b * BATCH_SIZE;
    const batch = allVoters.slice(start, start + BATCH_SIZE);
    let retries = 0;
    while (retries < 5) {
      try {
        const result = await sendBatch(batch);
        totalAdded += result.added || 0;
        totalUpdated += result.updated || 0;
        totalElections += result.elections_recorded || 0;
        const pct = Math.round(((b + 1) / batches) * 100);
        process.stdout.write(`\r[${pct}%] Batch ${b + 1}/${batches} — Added: ${totalAdded}, Updated: ${totalUpdated}, Elections: ${totalElections}    `);
        break;
      } catch (err) {
        if (err.message.includes('429') || err.message.includes('Too many')) {
          retries++;
          const wait = retries * 3000;
          process.stdout.write(`\r[Rate limited] Waiting ${wait/1000}s...    `);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.error(`\nBatch ${b + 1} failed:`, err.message);
          break;
        }
      }
    }
    // No delay — rate limit disabled on server
  }

  console.log('\n\nDone!');
  console.log('Added:', totalAdded);
  console.log('Updated:', totalUpdated);
  console.log('Elections recorded:', totalElections);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
