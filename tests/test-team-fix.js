#!/usr/bin/env node
const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookie = '';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body) opts.headers['Content-Type'] = 'application/json';
    const r = http.request(opts, res => {
      if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, d: JSON.parse(d) }); } catch(e) { resolve({ s: res.statusCode, d }); } });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  let pass = 0, fail = 0;
  function ok(msg, cond) {
    if (cond) { pass++; console.log('  PASS: ' + msg); }
    else { fail++; console.log('  FAIL: ' + msg); }
  }

  // Setup admin
  const setupRes = await req('POST', '/api/auth/setup', { username: 'admin', password: 'admin123', campaign_name: 'Test' });
  console.log('Setup:', setupRes.s, JSON.stringify(setupRes.d).slice(0, 200));
  const loginRes = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  console.log('Login:', loginRes.s, JSON.stringify(loginRes.d).slice(0, 200));
  console.log('Cookie:', cookie.slice(0, 60));

  // Create a captain
  const cap = await req('POST', '/api/captains', { name: 'Leader Captain' });
  console.log('Captain:', cap.s, JSON.stringify(cap.d).slice(0, 200));
  ok('Captain created', cap.s === 200 && cap.d.id);

  // Create 3 sub-captains via the team endpoint
  const sub1 = await req('POST', '/api/captains/' + cap.d.id + '/team', { name: 'Alice Sub' });
  ok('Sub-captain Alice created', sub1.d.success && sub1.d.code);
  const sub2 = await req('POST', '/api/captains/' + cap.d.id + '/team', { name: 'Bob Sub' });
  ok('Sub-captain Bob created', sub2.d.success && sub2.d.code);
  const sub3 = await req('POST', '/api/captains/' + cap.d.id + '/team', { name: 'Carol Sub' });
  ok('Sub-captain Carol created', sub3.d.success && sub3.d.code);

  // KEY TEST: GET /api/captains/:id/lists should now include team_members and sub_captains
  const listsRes = await req('GET', '/api/captains/' + cap.d.id + '/lists');
  ok('Lists endpoint returns team_members', Array.isArray(listsRes.d.team_members));
  ok('Lists endpoint returns sub_captains', Array.isArray(listsRes.d.sub_captains));
  ok('Lists shows 3 team_members', (listsRes.d.team_members || []).length === 3);
  ok('Lists shows 3 sub_captains', (listsRes.d.sub_captains || []).length === 3);

  // Verify sub_captain details
  var subNames = (listsRes.d.sub_captains || []).map(s => s.name).sort();
  ok('Sub-captains have correct names', subNames.join(',') === 'Alice Sub,Bob Sub,Carol Sub');
  ok('Sub-captains have codes', (listsRes.d.sub_captains || []).every(s => s.code && s.code.length === 6));

  // Verify login also returns them
  const capLogin = await req('POST', '/api/captains/login', { code: cap.d.code });
  ok('Login returns sub_captains', (capLogin.d.captain.sub_captains || []).length === 3);
  ok('Login returns team_members', (capLogin.d.captain.team_members || []).length === 3);

  // Now create another sub-captain and verify refresh picks it up
  const sub4 = await req('POST', '/api/captains/' + cap.d.id + '/team', { name: 'Dave Sub' });
  ok('Sub-captain Dave created', sub4.d.success);

  const listsRes2 = await req('GET', '/api/captains/' + cap.d.id + '/lists');
  ok('After add: Lists shows 4 sub_captains', (listsRes2.d.sub_captains || []).length === 4);
  ok('After add: Lists shows 4 team_members', (listsRes2.d.team_members || []).length === 4);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
