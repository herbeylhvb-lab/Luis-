#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://127.0.0.1:3999';
let passed = 0, failed = 0;
let serverProc;
let cookieJar = '';

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      method, hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const r = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach(c => { cookieJar = c.split(';')[0]; });
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  cond ? passed++ : failed++;
}

async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try { await req('GET', '/health'); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('server did not come up');
}

(async () => {
  // Use an isolated DATABASE_DIR so this test does not touch the real campaign.db.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-match-'));
  process.env.DATABASE_DIR = tmpDir;
  process.env.PORT = '3999';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-captain-match';

  serverProc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  serverProc.stdout.on('data', () => {}); // drain
  await waitForServer();

  // Bootstrap admin auth (server requires session for /api/* by default)
  await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Test Admin' });
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
  ok('admin login', login.status === 200 && login.body && login.body.success);

  const db = require('../db');
  const insert = db.prepare('INSERT INTO voters (first_name, last_name, age, phone, address, city, zip) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('Robert', 'Smith', 57, '', '123 Main', 'Cameron', '43009');
  insert.run('Robert', 'Smith', 32, '', '456 Oak', 'Cameron', '43009');
  insert.run('Maria', 'Lopez', 45, '', '789 Pine', 'Cameron', '43009');
  insert.run('William', 'Johnson', 60, '', '12 Elm', 'Cameron', '43009');
  insert.run('Patricia', 'Brown', 28, '', '34 Birch', 'Cameron', '43009');

  let r = await req('POST', '/api/captain/match-candidates', { firstName: 'Bob', lastName: 'Smith', age: 55 });
  ok('returns 200', r.status === 200);
  ok('returns candidates array', Array.isArray(r.body.candidates));
  ok('top candidate is age-57 Robert', r.body.candidates[0] && r.body.candidates[0].age === 57);

  r = await req('POST', '/api/captain/match-candidates', { firstName: 'Maria', lastName: 'Lopes', age: 45 });
  ok('typo match works', r.body.candidates[0] && r.body.candidates[0].lastName === 'Lopez');

  r = await req('POST', '/api/captain/match-candidates', { firstName: 'Zachariah', lastName: 'Q', age: 99 });
  ok('no match returns empty candidates', r.body.candidates.length === 0);

  r = await req('POST', '/api/captain/confirm-match', { voterId: 1, phone: '(555) 123-4567' });
  ok('confirm-match returns 200', r.status === 200);
  ok('confirm-match returns success', r.body.success === true);
  const updated = db.prepare('SELECT phone, phone_validated_at, phone_type FROM voters WHERE id = ?').get(1);
  ok('voter phone updated', updated.phone && updated.phone.includes('555'));
  ok('phone_validated_at set', !!updated.phone_validated_at);
  ok('phone_type set to mobile', updated.phone_type === 'mobile');

  r = await req('POST', '/api/captain/confirm-match', { phone: '5551112222' });
  ok('rejects missing voterId', r.status === 400);

  console.log(`\n${passed} passed, ${failed} failed`);
  serverProc.kill();
  // Best-effort cleanup of the tmp DB dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (serverProc) serverProc.kill(); process.exit(1); });
