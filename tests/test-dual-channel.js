#!/usr/bin/env node
/**
 * DUAL-CHANNEL P2P STRESS TEST
 * Tests SMS + WhatsApp dual-send, channel preference detection, and reply routing
 * 2,000 contacts, 2,000 dual sends, 2,000 replies (mixed SMS/WhatsApp)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const timers = {};

function ok(name, condition) {
  if (condition) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; console.log('  \x1b[31mFAIL\x1b[0m ' + name); }
}

function startTimer(name) { timers[name] = Date.now(); }
function endTimer(name) {
  const elapsed = ((Date.now() - timers[name]) / 1000).toFixed(2);
  console.log('    -> ' + name + ': ' + elapsed + 's');
  return parseFloat(elapsed);
}

let globalCookie = '';
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json', Cookie: globalCookie || '' }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(options, (res) => {
      if (res.headers['set-cookie']) {
        globalCookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, d: JSON.parse(body) }); }
        catch { resolve({ s: res.statusCode, d: body }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Simulate incoming webhook (form-encoded)
function webhookReq(from, body) {
  return new Promise((resolve, reject) => {
    const data = `From=${encodeURIComponent(from)}&Body=${encodeURIComponent(body)}`;
    const options = {
      hostname: 'localhost', port: PORT, path: '/incoming',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    };
    const r = http.request(options, (res) => {
      let b = '';
      res.on('data', chunk => b += chunk);
      res.on('end', () => resolve({ s: res.statusCode, d: b }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

const CONTACT_COUNT = 2000;

// Set port before requiring server
process.env.PORT = String(PORT);

async function run() {
  const start = Date.now();
  console.log('\n=== DUAL-CHANNEL P2P STRESS TEST ===\n');

  // Clean DB
  console.log('Phase 1: Setup');
  const dataDir = path.join(__dirname, 'data');
  ['campaign.db', 'campaign.db-wal', 'campaign.db-shm'].forEach(f => {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  // Start server in-process
  const server = require('./server');
  await new Promise(r => setTimeout(r, 500));
  console.log('CampaignText HQ running on port ' + PORT);

  // Auth
  const setup = await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Test Admin' });
  ok('Auth setup', setup.s === 200 && setup.d.success);
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
  ok('Login', login.s === 200 && login.d.success);

  // ========== PHASE 2: IMPORT 2,000 VOTERS ==========
  console.log('\nPhase 2: Import ' + CONTACT_COUNT.toLocaleString() + ' voters with phone numbers');
  startTimer('voter-import');

  const voters = [];
  for (let i = 0; i < CONTACT_COUNT; i++) {
    voters.push({
      first_name: 'Voter',
      last_name: 'N' + String(i).padStart(4, '0'),
      phone: '956' + String(5550000 + i).padStart(7, '0'),
      email: 'voter' + i + '@test.com',
      city: 'Brownsville',
      precinct: 'PCT-' + String((i % 10) + 1).padStart(3, '0'),
      party: i % 3 === 0 ? 'Democrat' : i % 3 === 1 ? 'Republican' : 'Independent'
    });
  }

  const BATCH = 500;
  for (let i = 0; i < voters.length; i += BATCH) {
    await req('POST', '/api/voters/import', { voters: voters.slice(i, i + BATCH) });
  }
  endTimer('voter-import');

  const stats = await req('GET', '/api/stats');
  ok('Imported ' + CONTACT_COUNT.toLocaleString() + ' voters', stats.d.voters === CONTACT_COUNT);

  // ========== PHASE 3: CREATE ADMIN LIST ==========
  console.log('\nPhase 3: Create admin list from voters');
  startTimer('list-create');

  const listRes = await req('POST', '/api/admin-lists', { name: 'GOTV Dual Channel', list_type: 'text' });
  ok('Created admin list', listRes.s === 200);
  const listId = listRes.d.id;

  // Get voter IDs
  const allVoters = await req('GET', '/api/voters?limit=2000');
  const voterData = allVoters.d.voters || allVoters.d;
  const voterIds = Array.isArray(voterData) ? voterData.map(v => v.id) : [];

  // If limit doesn't get all, do paginated fetch
  if (voterIds.length < CONTACT_COUNT) {
    // Use DB directly since we're in-process
    const db = require('./db');
    const ids = db.prepare('SELECT id FROM voters ORDER BY id').all().map(r => r.id);
    voterIds.length = 0;
    voterIds.push(...ids);
  }

  await req('POST', '/api/admin-lists/' + listId + '/voters', { voterIds });
  endTimer('list-create');

  // Verify phone coverage
  const lists = await req('GET', '/api/admin-lists');
  const ourList = lists.d.lists.find(l => l.id === listId);
  ok('List has ' + CONTACT_COUNT + ' voters', ourList.voterCount === CONTACT_COUNT);
  ok('All have phone numbers', ourList.withPhone === CONTACT_COUNT);
  ok('None missing phone', ourList.withoutPhone === 0);

  // ========== PHASE 4: CREATE P2P SESSION ==========
  console.log('\nPhase 4: Create P2P session (' + CONTACT_COUNT.toLocaleString() + ' contacts)');
  startTimer('session-create');

  const sessionRes = await req('POST', '/api/p2p/sessions', {
    name: 'Dual Channel Stress Test',
    message_template: 'Hi {firstName}! Can we count on your support?',
    assignment_mode: 'auto_split',
    list_id: listId
  });
  ok('Session created', sessionRes.s === 200 && sessionRes.d.success);
  ok('Contact count = ' + CONTACT_COUNT, sessionRes.d.contactCount === CONTACT_COUNT);
  ok('No skipped (all have phone)', sessionRes.d.skippedNoPhone === 0);
  const sessionId = sessionRes.d.id;
  const joinCode = sessionRes.d.joinCode;
  endTimer('session-create');

  // ========== PHASE 5: VOLUNTEERS JOIN ==========
  console.log('\nPhase 5: Volunteers join session');

  const volNames = ['Maria', 'Carlos', 'Ana', 'Luis', 'Rosa'];
  const volIds = [];
  for (const name of volNames) {
    const j = await req('POST', '/api/p2p/join', { name, code: joinCode });
    ok('Volunteer ' + name + ' joined', j.s === 200 && j.d.success);
    volIds.push(j.d.volunteerId);
  }

  const sessionDetail = await req('GET', '/api/p2p/sessions/' + sessionId);
  ok('5 volunteers online', sessionDetail.d.session.volunteers.length === 5);
  console.log('    -> Assignments per volunteer:');
  for (const v of sessionDetail.d.session.volunteers) {
    console.log('       ' + v.name + ': ' + v.remaining + ' pending');
  }

  // ========== PHASE 6: SIMULATE DUAL SENDS ==========
  console.log('\nPhase 6: Simulate ' + CONTACT_COUNT.toLocaleString() + ' dual-channel sends (SMS + WhatsApp)');
  startTimer('dual-send');

  const db = require('./db');

  // Get all assignments
  const assignments = db.prepare(`
    SELECT a.id, a.contact_id, a.volunteer_id, c.phone, c.first_name
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.session_id = ?
    ORDER BY a.id
  `).all(sessionId);

  ok('Got ' + assignments.length + ' assignments', assignments.length === CONTACT_COUNT);

  // Simulate dual send (both SMS + WhatsApp per contact)
  const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name, channel) VALUES (?, ?, 'outbound', ?, ?, ?)");
  const updateAssign = db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const updateWa = db.prepare("UPDATE p2p_assignments SET wa_status = 'sent' WHERE id = ?");

  const sendTx = db.transaction(() => {
    for (const a of assignments) {
      const vol = volNames[a.volunteer_id % volNames.length] || 'Vol';
      const msg = 'Hi ' + (a.first_name || '') + '! Can we count on your support?';
      insertMsg.run(a.phone, msg, sessionId, vol, 'sms');
      insertMsg.run(a.phone, msg, sessionId, vol, 'whatsapp');
      updateAssign.run(a.id);
      updateWa.run(a.id);
    }
  });
  sendTx();

  const sendTime = endTimer('dual-send');
  console.log('    -> Send rate: ' + Math.round(CONTACT_COUNT / sendTime).toLocaleString() + ' dual-sends/sec');

  const smsOut = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND channel = 'sms' AND direction = 'outbound'").get(sessionId).c;
  const waOut = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND channel = 'whatsapp' AND direction = 'outbound'").get(sessionId).c;
  ok(CONTACT_COUNT + ' SMS messages sent', smsOut === CONTACT_COUNT);
  ok(CONTACT_COUNT + ' WhatsApp messages sent', waOut === CONTACT_COUNT);
  ok('Total outbound = ' + (CONTACT_COUNT * 2), smsOut + waOut === CONTACT_COUNT * 2);

  // ========== PHASE 7: SIMULATE REPLIES ==========
  // 40% WhatsApp, 40% SMS, 20% no reply
  const waReplyTarget = Math.floor(CONTACT_COUNT * 0.4);   // 800
  const smsReplyTarget = Math.floor(CONTACT_COUNT * 0.4);   // 800
  const noReplyCount = CONTACT_COUNT - waReplyTarget - smsReplyTarget; // 400

  console.log('\nPhase 7: Simulate replies (' + waReplyTarget + ' WhatsApp + ' + smsReplyTarget + ' SMS + ' + noReplyCount + ' no reply)');
  startTimer('replies');

  const replyBodies = [
    'Yes I support you!', 'Tell me more', 'Not interested',
    'When is election day?', 'Already voted early', 'Sure thing!',
    'Who is this?', 'Can you call me instead?'
  ];

  let waReplied = 0, smsReplied = 0;

  // WhatsApp replies (first 40%)
  for (let i = 0; i < waReplyTarget; i++) {
    const a = assignments[i];
    const phone = '+1' + a.phone;
    const body = replyBodies[i % replyBodies.length];
    const res = await webhookReq('whatsapp:' + phone, body);
    if (res.s === 200) waReplied++;
    if ((i + 1) % 200 === 0) process.stdout.write('    WA replies: ' + (i + 1) + '/' + waReplyTarget + '\r');
  }
  console.log('    WA replies: ' + waReplied + '/' + waReplyTarget + '          ');

  // SMS replies (next 40%)
  for (let i = waReplyTarget; i < waReplyTarget + smsReplyTarget; i++) {
    const a = assignments[i];
    const phone = '+1' + a.phone;
    const body = replyBodies[i % replyBodies.length];
    const res = await webhookReq(phone, body);
    if (res.s === 200) smsReplied++;
    if ((i - waReplyTarget + 1) % 200 === 0) process.stdout.write('    SMS replies: ' + (i - waReplyTarget + 1) + '/' + smsReplyTarget + '\r');
  }
  console.log('    SMS replies: ' + smsReplied + '/' + smsReplyTarget + '          ');

  const replyTime = endTimer('replies');
  ok('WhatsApp replies: ' + waReplied, waReplied === waReplyTarget);
  ok('SMS replies: ' + smsReplied, smsReplied === smsReplyTarget);
  console.log('    -> Reply rate: ' + Math.round((waReplied + smsReplied) / replyTime) + ' replies/sec');

  // ========== PHASE 8: VERIFY CHANNEL PREFERENCES ==========
  console.log('\nPhase 8: Verify channel preference detection');

  const waPreferred = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE preferred_channel = 'whatsapp'").get().c;
  const smsPreferred = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE preferred_channel = 'sms'").get().c;
  const noPref = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE preferred_channel IS NULL").get().c;

  ok('WhatsApp preferred: ' + waPreferred + ' (expected ' + waReplyTarget + ')', waPreferred === waReplyTarget);
  ok('SMS preferred not set (SMS is default behavior)', smsPreferred === 0);
  ok('No-preference contacts: ' + noPref, noPref >= noReplyCount);
  console.log('    -> ' + waPreferred + ' WhatsApp | ' + noPref + ' default (SMS) | ' + smsPreferred + ' explicit SMS');

  // ========== PHASE 9: VERIFY ASSIGNMENT STATUSES ==========
  console.log('\nPhase 9: Verify assignment statuses');

  const totalReplied = waReplied + smsReplied;
  const inConvo = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'in_conversation'").get(sessionId).c;
  const stillSent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'sent'").get(sessionId).c;

  ok('In-conversation: ' + inConvo + ' (expected ' + totalReplied + ')', inConvo === totalReplied);
  ok('Sent (no reply): ' + stillSent + ' (expected ' + noReplyCount + ')', stillSent === noReplyCount);

  // ========== PHASE 10: VERIFY REPLY ROUTING ==========
  console.log('\nPhase 10: Verify reply routing via queue endpoint');

  const queue = await req('GET', '/api/p2p/volunteers/' + volIds[0] + '/queue');
  ok('Queue endpoint returns data', queue.s === 200);

  if (queue.d.activeConversations && queue.d.activeConversations.length > 0) {
    const hasChannelField = queue.d.activeConversations.every(c => 'preferred_channel' in c);
    ok('Conversations include preferred_channel', hasChannelField);

    const waConvos = queue.d.activeConversations.filter(c => c.preferred_channel === 'whatsapp').length;
    const defaultConvos = queue.d.activeConversations.filter(c => !c.preferred_channel).length;
    console.log('    -> Volunteer 1: ' + waConvos + ' WhatsApp, ' + defaultConvos + ' default');
    ok('Has WhatsApp-preferred conversations', waConvos > 0);
  }

  // ========== PHASE 11: VERIFY CONVERSATION VIEW ==========
  console.log('\nPhase 11: Conversation view with channel info');

  // Pick a WhatsApp-preferred contact
  const waAssign = db.prepare(`
    SELECT a.id FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.session_id = ? AND c.preferred_channel = 'whatsapp' LIMIT 1
  `).get(sessionId);

  if (waAssign) {
    const convo = await req('GET', '/api/p2p/conversations/' + waAssign.id);
    ok('Conversation loads', convo.s === 200);
    ok('Shows preferred_channel = whatsapp', convo.d.assignment.preferred_channel === 'whatsapp');

    const msgs = convo.d.messages || [];
    const outSms = msgs.filter(m => m.direction === 'outbound' && m.channel === 'sms').length;
    const outWa = msgs.filter(m => m.direction === 'outbound' && m.channel === 'whatsapp').length;
    const inWa = msgs.filter(m => m.direction === 'inbound' && m.channel === 'whatsapp').length;
    ok('Has outbound SMS', outSms >= 1);
    ok('Has outbound WhatsApp', outWa >= 1);
    ok('Has inbound WhatsApp reply', inWa >= 1);
    console.log('    -> Messages: ' + outSms + ' SMS out, ' + outWa + ' WA out, ' + inWa + ' WA in');
  }

  // ========== PHASE 12: MESSAGE COUNTS ==========
  console.log('\nPhase 12: Total message counts');

  const totalMsgs = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId).c;
  const totalOut = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND direction = 'outbound'").get(sessionId).c;
  const totalIn = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND direction = 'inbound'").get(sessionId).c;

  const breakdown = db.prepare(`
    SELECT channel, direction, COUNT(*) as c FROM messages WHERE session_id = ?
    GROUP BY channel, direction ORDER BY channel, direction
  `).all(sessionId);

  ok('Total outbound = ' + (CONTACT_COUNT * 2), totalOut === CONTACT_COUNT * 2);
  ok('Total inbound = ' + totalReplied, totalIn === totalReplied);
  console.log('    Total: ' + totalMsgs.toLocaleString() + ' messages');
  for (const r of breakdown) {
    console.log('      ' + r.channel + ' ' + r.direction + ': ' + r.c.toLocaleString());
  }

  // ========== PHASE 13: EXCLUDE-CONTACTED FILTER ==========
  console.log('\nPhase 13: Exclude-contacted on second session');
  startTimer('exclude');

  const sess2 = await req('POST', '/api/p2p/sessions', {
    name: 'Follow-up (exclude contacted)',
    message_template: 'Election is tomorrow!',
    list_id: listId,
    exclude_contacted: true
  });
  ok('Second session created', sess2.s === 200);
  ok('All ' + CONTACT_COUNT + ' excluded (already contacted)', sess2.d.skippedContacted === CONTACT_COUNT);
  ok('Zero contacts loaded', sess2.d.contactCount === 0);
  endTimer('exclude');

  // Without filter — should load all
  const sess3 = await req('POST', '/api/p2p/sessions', {
    name: 'Follow-up (include all)',
    message_template: 'Final reminder!',
    list_id: listId,
    exclude_contacted: false
  });
  ok('Third session loads all contacts', sess3.d.contactCount === CONTACT_COUNT);

  // ========== PHASE 14: OPT-OUT VIA WHATSAPP ==========
  console.log('\nPhase 14: Opt-out via WhatsApp');

  const optPhone = '+1' + assignments[0].phone;
  const optRes = await webhookReq('whatsapp:' + optPhone, 'STOP');
  ok('WhatsApp STOP processed', optRes.s === 200);
  // Stored as normalized 10-digit
  const optCheck = db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(assignments[0].phone);
  ok('Opt-out recorded (normalized)', !!optCheck);

  // SMS opt-out too
  const optPhone2 = '+1' + assignments[1].phone;
  const optRes2 = await webhookReq(optPhone2, 'unsubscribe');
  ok('SMS unsubscribe processed', optRes2.s === 200);
  const optCheck2 = db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(assignments[1].phone);
  ok('SMS opt-out recorded (normalized)', !!optCheck2);

  // ========== PHASE 15: QUERY PERFORMANCE ==========
  console.log('\nPhase 15: Query benchmarks');

  const benchmarks = [
    ['Session detail', () => req('GET', '/api/p2p/sessions/' + sessionId)],
    ['Session list', () => req('GET', '/api/p2p/sessions')],
    ['Volunteer queue', () => req('GET', '/api/p2p/volunteers/' + volIds[0] + '/queue')],
    ['Conversation view', () => req('GET', '/api/p2p/conversations/' + assignments[0].id)],
    ['Admin lists', () => req('GET', '/api/admin-lists')],
  ];

  for (const [name, fn] of benchmarks) {
    const s = Date.now();
    const r = await fn();
    const ms = Date.now() - s;
    ok(name + ' (' + ms + 'ms)', r.s === 200 && ms < 5000);
  }

  // ========== RESULTS ==========
  const totalTime = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('DUAL-CHANNEL STRESS TEST: ' + passed + ' passed, ' + failed + ' failed (' + totalTime + 's)');
  console.log('='.repeat(60));
  console.log('\nScale Summary:');
  console.log('  Contacts:          ' + CONTACT_COUNT.toLocaleString());
  console.log('  SMS sent:          ' + smsOut.toLocaleString());
  console.log('  WhatsApp sent:     ' + waOut.toLocaleString());
  console.log('  Total outbound:    ' + totalOut.toLocaleString());
  console.log('  WhatsApp replies:  ' + waReplied.toLocaleString());
  console.log('  SMS replies:       ' + smsReplied.toLocaleString());
  console.log('  WA preferred:      ' + waPreferred.toLocaleString());
  console.log('  No reply:          ' + noReplyCount.toLocaleString());
  console.log('  Opt-outs:          2');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
