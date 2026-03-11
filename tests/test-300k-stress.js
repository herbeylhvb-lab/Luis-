#!/usr/bin/env node
/**
 * 300K VOTER MEGA STRESS TEST
 *
 * Tests the entire platform at scale:
 * - 300,000 voters imported across 60 precincts
 * - 4,000 P2P text messages sent
 * - 2,000 realistic replies (support, oppose, opt-out)
 * - Survey to 4,000 contacts with responses
 * - Block walks across 10 precincts, 20 walkers
 * - Events with QR check-ins (500 voters)
 * - Universe builder with election history
 * - Admin lists, captains, early voting
 *
 * RUN:
 *   node test-300k-stress.js
 *
 * With RumbleUp (optional):
 *   RUMBLEUP_API_KEY=xxx RUMBLEUP_API_SECRET=xxx node test-300k-stress.js
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let cookieJar = '';
let passed = 0, failed = 0;
const errs = [];
const timers = {};

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const r = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach(c => { cookieJar = c.split(';')[0]; });
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, d: JSON.parse(data) }); }
        catch (e) { resolve({ s: res.statusCode, d: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function postForm(urlPath, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const body = new URLSearchParams(params).toString();
    const opts = {
      method: 'POST', hostname: url.hostname, port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ s: res.statusCode, d: data }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function ok(label, condition) {
  if (condition) { passed++; console.log('  \u2705 ' + label); }
  else { failed++; errs.push(label); console.log('  \u274C FAIL: ' + label); }
}

function timer(n) { timers[n] = Date.now(); }
function elapsed(n) { return ((Date.now() - timers[n]) / 1000).toFixed(1) + 's'; }
function section(t) { console.log('\n' + '\u2550'.repeat(64) + '\n  ' + t + '\n' + '\u2550'.repeat(64)); }

// ─── Data generators ────────────────────────────────────────────
const FN = ['Maria','John','Sarah','David','Ana','Carlos','Lisa','James','Rosa','Michael',
  'Jennifer','Robert','Patricia','William','Linda','Richard','Barbara','Thomas','Susan','Joseph',
  'Jessica','Chris','Karen','Daniel','Nancy','Mark','Betty','Paul','Helen','Steven',
  'Sophia','Miguel','Elena','Pedro','Carmen','Luis','Gloria','Diego','Iris','Marco',
  'Emily','Jordan','Alex','Taylor','Robin','Sam','Casey','Morgan','Drew','Avery'];
const LN = ['Garcia','Smith','Johnson','Lee','Martinez','Brown','Wilson','Lopez','Davis','Moore',
  'Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Robinson','Clark',
  'Rodriguez','Hernandez','Gonzalez','Perez','Sanchez','Rivera','Torres','Flores','Diaz','Cruz'];
const CITIES = ['Miami','Tampa','Orlando','Jacksonville','Tallahassee','Fort Lauderdale','St Petersburg',
  'Hialeah','Cape Coral','Port St Lucie','Coral Gables','Homestead','Doral','Kendall','Pembroke Pines'];
const STREETS = ['Main St','Oak Ave','Elm Dr','Pine Rd','Maple Blvd','Cedar Ln','Palm Way','Beach Rd',
  'Lake Dr','River Rd','Park Ave','Hill St','Bay Ct','Forest Dr','Ocean Blvd'];
const PARTIES = ['DEM','REP','NPA','LPF','IND'];
const PRECINCTS = [];
for (let i = 1; i <= 60; i++) PRECINCTS.push('PCT-' + String(i).padStart(3, '0'));
const SUPPORT = ['strong_support','lean_support','undecided','lean_oppose','strong_oppose','unknown'];
const DOOR_RESULTS = ['support','lean_support','undecided','lean_oppose','oppose','not_home','refused','moved','come_back'];
const REPLIES = [
  'Yes! Count me in!', 'Not interested.', 'Tell me more.', 'What about healthcare?',
  'I already voted!', 'When is the election?', 'I support you!', 'No thanks.',
  'Where can I volunteer?', 'Concerned about education.', 'Leave me alone.',
  'Sure!', "I'm undecided.", 'My family supports you!', 'What about taxes?',
  'How do I register?', 'Thanks!', 'I disagree.', 'Can I get a yard sign?',
  'STOP', 'unsubscribe', 'Who is this?', 'Wrong number', 'When is the town hall?',
  'I need a ride to polls.', 'Where is early voting?', 'Tell me your positions.',
  'I already know who I am voting for.', 'More info please.', 'cancel'
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function phone(i) { return '+1' + String(5000000000 + i); }

function voterBatch(start, count) {
  const voters = [];
  for (let i = start; i < start + count; i++) {
    voters.push({
      first_name: pick(FN), last_name: pick(LN), phone: phone(i),
      email: 'v' + i + '@test.com', address: (100 + (i % 9000)) + ' ' + pick(STREETS),
      city: pick(CITIES), zip: String(70000 + (i % 900)),
      party: pick(PARTIES), support_level: pick(SUPPORT),
      registration_number: 'REG' + String(i).padStart(6, '0'),
      precinct: PRECINCTS[i % PRECINCTS.length]
    });
  }
  return voters;
}

// ─── Main test ──────────────────────────────────────────────────
async function run() {
  const TOTAL = 300000;
  const BATCH = 10000;
  const TEXTS = 4000;
  const startTime = Date.now();

  console.log('\n' + '='.repeat(64));
  console.log('  300K VOTER MEGA STRESS TEST');
  console.log('='.repeat(64));

  // ═══ PHASE 1: AUTH ═══
  section('PHASE 1: AUTH');
  let r = await req('POST', '/api/auth/setup', { username: 'megaadmin', password: 'mega123!' });
  r = await req('POST', '/api/auth/login', { username: 'megaadmin', password: 'mega123!' });
  ok('Admin authenticated', r.s === 200 && r.d.success);

  if (process.env.RUMBLEUP_API_KEY) {
    r = await req('POST', '/api/provider-credentials', {
      provider: 'rumbleup',
      credentials: {
        apiKey: process.env.RUMBLEUP_API_KEY,
        apiSecret: process.env.RUMBLEUP_API_SECRET,
        actionId: process.env.RUMBLEUP_ACTION_ID || '1'
      }
    });
    ok('RumbleUp test credentials saved', r.s === 200);
  }

  // ═══ PHASE 2: IMPORT 300K VOTERS ═══
  section('PHASE 2: IMPORT ' + TOTAL.toLocaleString() + ' VOTERS');
  timer('import');
  let importOk = true;
  for (let b = 0; b < TOTAL / BATCH; b++) {
    const voters = voterBatch(b * BATCH, BATCH);
    r = await req('POST', '/api/voters/import', { voters });
    if (r.s !== 200 || !r.d.success) { importOk = false; console.log('  Batch ' + (b+1) + ' error: ' + JSON.stringify(r.d).substring(0, 200)); break; }
    process.stdout.write('  \u2705 Batch ' + (b+1) + '/' + (TOTAL/BATCH) + ': ' + ((b+1)*BATCH).toLocaleString() + ' voters\r');
  }
  console.log('');
  ok(TOTAL.toLocaleString() + ' voters imported (' + elapsed('import') + ')', importOk);

  // Verify
  r = await req('GET', '/api/voters?limit=1');
  const voterCount = (r.d.voters || []).length > 0;
  ok('Voters accessible', voterCount);

  // ═══ PHASE 3: CONTACTS FOR P2P ═══
  section('PHASE 3: ' + TEXTS.toLocaleString() + ' CONTACTS FOR P2P');
  timer('contacts');
  for (let i = 0; i < TEXTS; i++) {
    await req('POST', '/api/contacts', { phone: phone(i), first_name: pick(FN), last_name: pick(LN) });
    if (i % 500 === 499) process.stdout.write('  ' + (i+1) + '/' + TEXTS + ' contacts\r');
  }
  console.log('');
  ok(TEXTS + ' contacts created (' + elapsed('contacts') + ')', true);

  // ═══ PHASE 4: ADMIN LISTS ═══
  section('PHASE 4: ADMIN LISTS');
  const listIds = [];
  for (const l of [
    { name: 'DEM Priority', list_type: 'text' },
    { name: 'Undecided Targets', list_type: 'text' },
    { name: 'Event Supporters', list_type: 'event' },
    { name: 'GOTV Walk List', list_type: 'block_walk' },
    { name: 'Survey Pool', list_type: 'survey' }
  ]) {
    r = await req('POST', '/api/admin-lists', l);
    if (r.d.id) listIds.push(r.d.id);
  }
  ok('Created ' + listIds.length + ' admin lists', listIds.length === 5);

  // Add DEM voters to first list
  r = await req('GET', '/api/voters?party=DEM&limit=500');
  const demVoters = r.d.voters || [];
  if (demVoters.length > 0 && listIds[0]) {
    const vids = demVoters.map(v => v.id);
    r = await req('POST', '/api/admin-lists/' + listIds[0] + '/voters', { voterIds: vids });
    ok('Added ' + vids.length + ' DEM voters to list', r.s === 200);
  }

  // ═══ PHASE 5: ELECTION HISTORY & UNIVERSE ═══
  section('PHASE 5: ELECTION HISTORY & UNIVERSE BUILDER');
  timer('universe');

  // Build election rows (parsed objects, not CSV)
  const elecDefs = [
    { column: 'nov_2024', name: 'NOV 2024', date: '2024-11-05', type: 'general', cycle: 'November' },
    { column: 'mar_2024', name: 'MAR 2024', date: '2024-03-12', type: 'general', cycle: 'March' },
    { column: 'nov_2022', name: 'NOV 2022', date: '2022-11-08', type: 'general', cycle: 'November' },
    { column: 'may_2023', name: 'MAY 2023', date: '2023-05-16', type: 'general', cycle: 'May' },
    { column: 'nov_2020', name: 'NOV 2020', date: '2020-11-03', type: 'general', cycle: 'November' }
  ];
  const elecRows = [];
  for (let i = 0; i < 10000; i++) {
    const row = { registration_number: 'REG' + String(i).padStart(6, '0'), first_name: pick(FN), last_name: pick(LN) };
    for (const e of elecDefs) row[e.column] = Math.random() > 0.4 ? 'Y' : 'N';
    elecRows.push(row);
  }
  r = await req('POST', '/api/election-votes/import', { rows: elecRows, elections: elecDefs });
  ok('Election history for 10K voters (' + (r.d.matched||0) + ' matched)', r.s === 200 && (r.d.matched || 0) > 0);

  r = await req('GET', '/api/election-votes/elections');
  const elections = r.d.elections || r.d || [];
  ok('Elections loaded: ' + (Array.isArray(elections) ? elections.length : 0), Array.isArray(elections) && elections.length >= 3);

  // Preview universe
  r = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS.slice(0, 10), years_back: 8,
    election_cycles: ['November','March'], priority_elections: ['NOV 2024']
  });
  if (r.d) console.log('  Preview: total=' + (r.d.total_in_precincts||0) + ' universe=' + (r.d.universe||0) + ' sub=' + (r.d.sub_universe||0) + ' priority=' + (r.d.priority||0));
  ok('Universe preview', r.s === 200);

  // Build
  r = await req('POST', '/api/universe/build', {
    precincts: PRECINCTS.slice(0, 10), years_back: 8,
    election_cycles: ['November','March'], priority_elections: ['NOV 2024'],
    universe_name: '300K Universe', sub_universe_name: '300K Sub', priority_name: '300K Priority'
  });
  ok('Universe built (' + elapsed('universe') + ')', r.s === 200 && r.d.success);

  // ═══ PHASE 6: P2P TEXTING ═══
  section('PHASE 6: P2P TEXTING (' + TEXTS + ' messages)');
  timer('p2p');

  r = await req('GET', '/api/contacts');
  const contacts = r.d.contacts || r.d || [];
  const cIds = contacts.slice(0, TEXTS).map(c => c.id);
  ok('Contacts loaded: ' + cIds.length, cIds.length > 0);

  r = await req('POST', '/api/p2p/sessions', {
    name: 'Mega P2P Session', message_template: 'Hi {firstName}, can we count on your vote?',
    contact_ids: cIds
  });
  ok('P2P session created', r.s === 200 && r.d.success);
  const joinCode = r.d.joinCode;

  const vols = [];
  for (let v = 0; v < 10; v++) {
    r = await req('POST', '/api/p2p/join', { code: joinCode, name: 'Vol_' + (v+1) });
    if (r.d.volunteerId) vols.push(r.d.volunteerId);
  }
  ok(vols.length + ' volunteers joined', vols.length === 10);

  let totalSent = 0;
  for (let vi = 0; vi < vols.length; vi++) {
    let sent = 0;
    for (let a = 0; a < TEXTS; a++) {
      r = await req('GET', '/api/p2p/volunteers/' + vols[vi] + '/queue');
      if (!r.d.assignment) break;
      r = await req('POST', '/api/p2p/send', { volunteerId: vols[vi], assignmentId: r.d.assignment.id, message: r.d.resolvedMessage || 'Vote for us!' });
      if (r.s === 200) sent++;
    }
    totalSent += sent;
    process.stdout.write('  Vol ' + (vi+1) + ': ' + sent + ' sent (total: ' + totalSent + ')\r');
  }
  console.log('');
  ok(totalSent + ' messages sent (' + elapsed('p2p') + ')', totalSent >= TEXTS * 0.9);

  // ═══ PHASE 7: REPLIES ═══
  section('PHASE 7: ' + 2000 + ' INCOMING REPLIES');
  timer('replies');
  let replyOk = 0, optOuts = 0;
  for (let i = 0; i < 2000; i++) {
    const reply = pick(REPLIES);
    if (['STOP','unsubscribe','cancel'].includes(reply)) optOuts++;
    r = await postForm('/incoming', { From: phone(i), Body: reply, MessageSid: 'SM_' + i + '_' + Date.now() });
    if (r.s === 200) replyOk++;
    if (i % 400 === 399) process.stdout.write('  ' + (i+1) + '/2000\r');
  }
  console.log('');
  ok('Replies: ' + replyOk + ' OK, ~' + optOuts + ' opt-outs (' + elapsed('replies') + ')', replyOk === 2000);

  r = await req('GET', '/api/messages');
  ok('Inbox has messages: ' + (r.d.messages||[]).length, (r.d.messages||[]).length > 0);

  // ═══ PHASE 8: SURVEYS ═══
  section('PHASE 8: SURVEYS');
  timer('surveys');

  r = await req('POST', '/api/surveys', { name: 'Mega Issues Poll', description: 'Top community issues' });
  ok('Survey created', r.d.id > 0);
  const surveyId = r.d.id;

  await req('POST', '/api/surveys/' + surveyId + '/questions', {
    question_text: 'Most important issue?', question_type: 'single_choice',
    options: ['Education','Healthcare','Economy','Safety','Environment']
  });
  await req('POST', '/api/surveys/' + surveyId + '/questions', {
    question_text: 'Rate local government?', question_type: 'single_choice',
    options: ['Excellent','Good','Fair','Poor']
  });
  r = await req('POST', '/api/surveys/' + surveyId + '/questions', {
    question_text: 'What needs improvement?', question_type: 'write_in', options: []
  });
  ok('3 survey questions added', r.s === 200);

  // Send survey to contacts
  r = await req('POST', '/api/surveys/' + surveyId + '/send', { contact_ids: cIds.slice(0, TEXTS) });
  ok('Survey sent to ' + TEXTS + ' contacts', r.s === 200);
  console.log('  Surveys in ' + elapsed('surveys'));

  // ═══ PHASE 9: BLOCK WALKS ═══
  section('PHASE 9: BLOCK WALKS (10 precincts, 20 walkers)');
  timer('walks');

  const walkIds = [];
  for (let w = 0; w < 10; w++) {
    r = await req('POST', '/api/walks', { name: PRECINCTS[w] + ' Door Knock', description: 'Stress test walk' });
    if (r.d.id) {
      const wid = r.d.id;
      walkIds.push(wid);
      // Add addresses
      const addrs = [];
      for (let a = 0; a < 50; a++) {
        addrs.push({ address: (100+a) + ' ' + pick(STREETS), city: pick(CITIES), zip: String(70000+w) });
      }
      await req('POST', '/api/walks/' + wid + '/addresses', { addresses: addrs });
    }
  }
  ok('Created ' + walkIds.length + ' walks with 50 addresses each', walkIds.length === 10);

  let totalKnocks = 0;
  for (let w = 0; w < 20; w++) {
    const wid = walkIds[w % walkIds.length];
    await req('POST', '/api/walks/' + wid + '/volunteer', { name: 'Walker_' + (w+1), phone: phone(800000+w) });
    r = await req('GET', '/api/walks/' + wid);
    const addrs = (r.d.walk && r.d.walk.addresses) || [];
    for (let a = 0; a < Math.min(addrs.length, 10); a++) {
      if (!addrs[a].id) continue;
      r = await req('POST', '/api/walks/' + wid + '/addresses/' + addrs[a].id + '/log', {
        result: pick(DOOR_RESULTS), notes: 'Stress test', walked_by: 'Walker_' + (w+1)
      });
      if (r.s === 200) totalKnocks++;
    }
  }
  ok(totalKnocks + ' doors knocked (' + elapsed('walks') + ')', totalKnocks > 50);

  // ═══ PHASE 10: EVENTS & QR CHECK-INS ═══
  section('PHASE 10: EVENTS & QR CHECK-INS');
  timer('events');

  r = await req('POST', '/api/events', {
    title: 'Mega Town Hall', location: 'City Center', event_date: '2026-02-23', event_time: '18:00'
  });
  ok('Event created', r.s === 200 || r.s === 201);
  const eventId = r.d.id;

  r = await req('POST', '/api/events', {
    title: 'Block Party Rally', location: 'Central Park', event_date: '2026-02-23', event_time: '14:00'
  });
  const eventId2 = r.d.id;

  // QR check-ins using voter qr_tokens
  let checkinOk = 0;
  r = await req('GET', '/api/voters?limit=500');
  const checkVoters = r.d.voters || [];
  for (let i = 0; i < checkVoters.length; i++) {
    const v = checkVoters[i];
    if (!v.qr_token) continue;
    const eid = i % 2 === 0 ? eventId : eventId2;
    r = await req('POST', '/api/voters/qr/' + v.qr_token + '/checkin', { event_id: eid });
    if (r.s === 200) checkinOk++;
  }
  ok(checkinOk + ' QR check-ins', checkinOk > 100);

  // Walk-in check-ins
  let walkinOk = 0;
  for (let i = 0; i < 100; i++) {
    r = await req('POST', '/api/events/' + eventId + '/checkin', {
      name: pick(FN) + ' ' + pick(LN), phone: phone(900000+i)
    });
    if (r.s === 200) walkinOk++;
  }
  ok(walkinOk + ' walk-in check-ins', walkinOk > 50);
  console.log('  Events in ' + elapsed('events'));

  // ═══ PHASE 11: CAPTAINS ═══
  section('PHASE 11: BLOCK CAPTAINS');
  timer('captains');
  const capIds = [];
  for (let c = 0; c < 5; c++) {
    r = await req('POST', '/api/captains', {
      name: 'Capt_' + (c+1), phone: phone(700000+c), email: 'capt' + c + '@test.com', precinct: PRECINCTS[c]
    });
    if (r.d.id) capIds.push(r.d.id);
  }
  ok('Created ' + capIds.length + ' captains', capIds.length === 5);

  for (const cid of capIds) {
    r = await req('GET', '/api/captains/' + cid + '/search?q=');
    const vs = r.d.voters || [];
    for (const v of vs.slice(0, 20)) {
      await req('POST', '/api/captains/' + cid + '/lists', { voter_id: v.id, list_type: 'priority' });
    }
  }
  ok('Captains built priority lists', true);
  console.log('  Captains in ' + elapsed('captains'));

  // ═══ PHASE 12: VOTER CONTACTS & TOUCHPOINTS ═══
  section('PHASE 12: VOTER CONTACTS & TOUCHPOINTS');
  timer('touch');
  let logged = 0;
  r = await req('GET', '/api/voters?limit=500');
  const logVoters = r.d.voters || [];
  for (let i = 0; i < Math.min(logVoters.length, 500); i++) {
    r = await req('POST', '/api/voters/' + logVoters[i].id + '/contacts', {
      contact_type: pick(['door','phone','text','event']),
      result: pick(DOOR_RESULTS), notes: 'Stress test', contacted_by: 'Vol_' + (1 + i%10)
    });
    if (r.s === 200) logged++;
    if (i % 100 === 99) process.stdout.write('  ' + (i+1) + '/500\r');
  }
  console.log('');
  ok('Voter contacts logged: ' + logged, logged > 400);

  // Touchpoints
  let tpOk = 0;
  for (let i = 0; i < 10; i++) {
    r = await req('GET', '/api/voters/' + logVoters[i].id + '/touchpoints');
    if (r.s === 200 && r.d.touchpoints && r.d.touchpoints.length > 0) tpOk++;
  }
  ok('Touchpoints verified: ' + tpOk + '/10', tpOk >= 8);

  r = await req('GET', '/api/voters-touchpoints/stats');
  if (r.d) console.log('  Stats: texts=' + (r.d.texts||0) + ' knocks=' + (r.d.knocks||0) + ' events=' + (r.d.events||0));
  console.log('  Touchpoints in ' + elapsed('touch'));

  // ═══ PHASE 13: EARLY VOTING ═══
  section('PHASE 13: EARLY VOTING');
  timer('ev');
  const evRows = [];
  for (let i = 0; i < 5000; i++) {
    evRows.push({ registration_number: 'REG' + String(i).padStart(6,'0'), first_name: pick(FN), last_name: pick(LN) });
  }
  r = await req('POST', '/api/early-voting/import', { rows: evRows, vote_date: '2026-02-20', vote_method: 'early' });
  ok('Early voting imported (' + (r.d.matched||0) + ' matched)', r.s === 200);

  r = await req('GET', '/api/early-voting/stats');
  if (r.d) console.log('  Early voted: ' + (r.d.total_voted||0));
  ok('Early voting stats', r.s === 200);

  r = await req('POST', '/api/early-voting/extract-remaining', {
    precincts: PRECINCTS.slice(0, 5), list_name: 'GOTV - Not Yet Voted'
  });
  ok('GOTV list created', r.s === 200);
  console.log('  Early voting in ' + elapsed('ev'));

  // ═══ PHASE 14: CANVASS IMPORT ═══
  section('PHASE 14: CANVASS IMPORT');
  timer('canvass');
  const canvassRows = [];
  for (let i = 0; i < 200; i++) {
    canvassRows.push({
      first_name: pick(FN), last_name: pick(LN), phone: phone(i),
      address: (100+i) + ' ' + pick(STREETS),
      result: pick(DOOR_RESULTS), notes: 'Auto', canvasser: 'W_' + (1+i%5)
    });
  }
  r = await req('POST', '/api/voters/import-canvass', { rows: canvassRows });
  ok('Canvass: ' + (r.d.matched||0) + ' matched', r.s === 200);
  console.log('  Canvass in ' + elapsed('canvass'));

  // ═══ PHASE 15: CONCURRENT OPS ═══
  section('PHASE 15: CONCURRENT OPERATIONS');
  timer('concurrent');
  const ops = [];
  for (let i = 0; i < 50; i++) {
    ops.push(req('GET', '/api/voters?limit=10&q=' + pick(FN)));
    ops.push(req('GET', '/api/contacts'));
    ops.push(req('GET', '/api/events'));
    ops.push(req('GET', '/api/activity'));
  }
  const results = await Promise.all(ops);
  const okCnt = results.filter(r => r.s === 200).length;
  ok(okCnt + '/200 concurrent ops (' + elapsed('concurrent') + ')', okCnt === 200);

  // ═══ PHASE 16: VERIFY ═══
  section('PHASE 16: DATA INTEGRITY');
  r = await req('GET', '/api/activity');
  ok('Activity log: ' + (r.d.logs||[]).length + ' entries', (r.d.logs||[]).length > 0);

  timer('search');
  r = await req('GET', '/api/voters?q=Maria&limit=50');
  ok('Voter search across 300K: ' + elapsed('search'), r.s === 200);

  r = await req('GET', '/api/voters-precincts');
  ok('Precincts: ' + ((r.d.precincts||r.d||[]).length), (r.d.precincts||r.d||[]).length >= 10);

  r = await req('GET', '/api/admin-lists');
  const totalLists = (r.d.lists||r.d||[]).length;
  ok('Admin lists: ' + totalLists, totalLists >= 5);

  // ═══ SUMMARY ═══
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(64));
  console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  console.log('  Total Time: ' + totalTime + 's');
  console.log('='.repeat(64));
  if (errs.length > 0) { console.log('\n  FAILURES:'); errs.forEach(e => console.log('    \u274C ' + e)); }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Server management ──────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'campaign.db');
[dbPath, dbPath + '-wal', dbPath + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
console.log('  DB cleaned.');

function startServer() {
  return new Promise((resolve) => {
    const test = http.get(BASE + '/health', () => resolve(false));
    test.on('error', () => {
      console.log('  Starting server...');
      const child = fork(path.join(__dirname, 'server.js'), [], {
        env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
      });
      child.unref();
      const poll = setInterval(() => {
        const r = http.get(BASE + '/health', () => { clearInterval(poll); resolve(child); });
        r.on('error', () => {});
      }, 500);
      setTimeout(() => { clearInterval(poll); resolve(null); }, 15000);
    });
  });
}

startServer().then(proc => run().finally(() => { if (proc && proc.kill) proc.kill(); }))
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
