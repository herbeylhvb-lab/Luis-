#!/usr/bin/env node
/**
 * Remove voters not in the Cameron County CSV (no longer registered)
 * Sends all valid VUIDs to server, server deletes everyone else
 */
const fs = require('fs');

const CSV_PATH = process.argv[2] || '/Users/luisvillarreal/Desktop/VR-HIST-03262026.csv';
const SERVER = process.argv[3] || 'https://campaigntext-production.up.railway.app';
const USERNAME = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASS || '';

function parseCsvLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQuotes && line[i+1]==='"') { current+='"'; i++; } else inQuotes=!inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current=''; }
    else current += c;
  }
  result.push(current.trim());
  return result;
}

let sessionCookie = '';

async function login() {
  const resp = await fetch(SERVER + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  if (resp.status >= 400) throw new Error('Login failed: ' + resp.status);
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  if (!sessionCookie) sessionCookie = (resp.headers.get('set-cookie') || '').split(';')[0];
}

async function main() {
  console.log('Reading CSV...');
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = parseCsvLine(lines[0]);
  const vuidIdx = headers.findIndex(h => h.replace(/^\uFEFF/, '').trim() === 'VUID');

  const vuids = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const vuid = (cols[vuidIdx] || '').trim();
    if (vuid) vuids.push(vuid);
  }
  console.log('VUIDs in CSV:', vuids.length);

  console.log('Logging in...');
  await login();

  // Send VUIDs in chunks (238K VUIDs is too big for one request)
  // Actually send all at once — the server handles it in a transaction
  // But 238K strings might be too large for JSON body. Send in chunks of 50K
  const CHUNK = 50000;
  const chunks = Math.ceil(vuids.length / CHUNK);

  // For safety, send all VUIDs to a single endpoint that does the delete
  // We need all VUIDs at once for the NOT IN query to work
  // Let's just send them all — 238K short strings should be ~5MB, within limits
  console.log('Sending', vuids.length, 'VUIDs to cleanup endpoint...');

  const resp = await fetch(SERVER + '/api/voters/cleanup-by-vuids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie },
    body: JSON.stringify({ vuids })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Cleanup failed: ' + resp.status + ' ' + text.slice(0, 500));
  }

  const result = await resp.json();
  console.log('\nResult:', JSON.stringify(result, null, 2));
  console.log('\nDone! Removed', result.deleted, 'voters not in county file.');
  if (result.noRegistration > 0) {
    console.log('Note:', result.noRegistration, 'voters without registration numbers were kept (manually added contacts).');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
