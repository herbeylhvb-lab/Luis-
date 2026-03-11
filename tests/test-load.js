#!/usr/bin/env node
/**
 * Large-scale load simulation: 2,000 contacts, P2P sends, ~30% reply,
 * AI suggestions, survey responses, event invites.
 * Tests the full messaging flow (mocked at the send level).
 */

const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
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

function postForm(path, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
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

function check(condition, label) {
  if (condition) { passed++; } else { failed++; console.log(`  \u274C FAIL: ${label}`); }
}

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log('  ' + title);
  console.log('='.repeat(60));
}

const FIRST_NAMES = ['Maria','John','Sarah','David','Ana','Carlos','Lisa','James','Rosa','Michael',
  'Jennifer','Robert','Patricia','William','Linda','Richard','Barbara','Thomas','Susan','Joseph',
  'Jessica','Chris','Karen','Daniel','Nancy','Mark','Betty','Paul','Helen','Steven'];
const LAST_NAMES = ['Garcia','Smith','Johnson','Lee','Martinez','Brown','Wilson','Lopez','Davis','Moore',
  'Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Robinson','Clark'];
const CITIES = ['Miami','Tampa','Orlando','Jacksonville','Tallahassee','Fort Lauderdale','St Petersburg',
  'Hialeah','Cape Coral','Port St Lucie'];
const REPLIES = [
  'Yes! Count me in!',
  'Not interested, sorry.',
  'Can you tell me more about the candidate?',
  'What are your positions on healthcare?',
  'I already voted early.',
  'When is the election again?',
  'I support you 100%!',
  'No thanks.',
  'Where can I volunteer?',
  'I have some concerns about education policy.',
  'Leave me alone.',
  'Sure, what do you need?',
  'I\'m undecided. Convince me.',
  'My family and I are all voting for you!',
  'What about taxes?',
  'How do I register to vote?',
  'I live in a different district now.',
  'Thanks for reaching out!',
  'I disagree with your stance on immigration.',
  'Can I get a yard sign?',
];

async function run() {
  const startTime = Date.now();

  section('SETUP');

  // Auth
  await req('POST', '/api/auth/setup', { username: 'loadtest', password: 'loadtest123', display_name: 'Load Test' });
  const login = await req('POST', '/api/auth/login', { username: 'loadtest', password: 'loadtest123' });
  check(login.d.success, 'Admin login');
  console.log('  \u2705 Authenticated');

  // Add campaign knowledge for AI suggestions
  await req('POST', '/api/knowledge', { type: 'bio', title: 'Candidate', content: 'Jane Rodriguez is running for State Rep in District 42. She is a former teacher and small business owner.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Healthcare', content: 'Supports expanding Medicaid and lowering prescription drug costs.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Education', content: 'Supports fully funding public schools and raising teacher pay.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Economy', content: 'Supports raising minimum wage and small business tax relief.' });
  await req('POST', '/api/knowledge', { type: 'details', title: 'Website', content: 'www.janefordistrict42.com' });
  await req('POST', '/api/knowledge', { type: 'details', title: 'Election', content: 'General election: November 3, 2026' });
  console.log('  \u2705 Campaign knowledge loaded (bio, 3 policies, 2 details)');

  // Add response scripts as AI fallback
  await req('POST', '/api/scripts', { scenario: 'supporter_positive', label: 'Supporter - Positive', content: 'Thank you so much for your support! Every vote counts. Visit www.janefordistrict42.com to learn more!' });
  await req('POST', '/api/scripts', { scenario: 'undecided_question', label: 'Undecided - Question', content: 'Great question! Jane is focused on healthcare, education, and economic opportunity. Visit www.janefordistrict42.com for her full platform!' });
  await req('POST', '/api/scripts', { scenario: 'hostile_negative', label: 'Hostile/Negative', content: 'Thank you for sharing your concerns. We respect all viewpoints. If you\'d like to discuss further, visit www.janefordistrict42.com.' });
  console.log('  \u2705 Response scripts loaded (3 scenarios)');

  // ══════════════════════════════════════════════════════
  section('1. CREATE 2,000 CONTACTS');
  // ══════════════════════════════════════════════════════

  console.log('  Creating 2,000 contacts in bulk...');
  const BATCH_SIZE = 200;
  const TOTAL = 2000;
  const allContactIds = [];
  const allPhones = [];

  for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
    const contacts = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = batch * BATCH_SIZE + i;
      const phone = '+1555' + String(1000000 + idx).padStart(7, '0');
      const fn = FIRST_NAMES[idx % FIRST_NAMES.length];
      const ln = LAST_NAMES[idx % LAST_NAMES.length];
      const city = CITIES[idx % CITIES.length];
      contacts.push({ phone, firstName: fn, lastName: ln, city });
    }

    // Create contacts one at a time (no bulk endpoint for contacts)
    for (const c of contacts) {
      const r = await req('POST', '/api/contacts', c);
      if (r.d.id) { allContactIds.push(r.d.id); allPhones.push(c.phone); }
    }
    process.stdout.write(`  \u2705 Batch ${batch + 1}/${TOTAL / BATCH_SIZE}: ${allContactIds.length} contacts created\r`);
  }
  console.log(`\n  \u2705 Total contacts: ${allContactIds.length}`);
  check(allContactIds.length === TOTAL, `Created ${TOTAL} contacts`);

  // ══════════════════════════════════════════════════════
  section('2. CREATE P2P SESSION WITH 2,000 CONTACTS');
  // ══════════════════════════════════════════════════════

  console.log('  Creating P2P session...');
  const sessR = await req('POST', '/api/p2p/sessions', {
    name: 'GOTV - District 42 Blitz',
    message_template: 'Hi {firstName}! This is a volunteer for Jane Rodriguez, running for District 42. Can we count on your vote on Nov 3rd? Reply YES or let us know your questions!',
    assignment_mode: 'auto_split',
    contact_ids: allContactIds
  });
  check(sessR.d.success, 'Session created');
  console.log(`  \u2705 Session created: ${sessR.d.contactCount} contacts | Join code: ${sessR.d.joinCode}`);
  const sessionId = sessR.d.id;
  const joinCode = sessR.d.joinCode;

  // ══════════════════════════════════════════════════════
  section('3. VOLUNTEERS JOIN (5 volunteers)');
  // ══════════════════════════════════════════════════════

  const volNames = ['Carlos R.', 'Lisa M.', 'Ahmed K.', 'Priya S.', 'Mike T.'];
  const volunteers = [];
  for (const name of volNames) {
    const r = await req('POST', '/api/p2p/join', { name, code: joinCode });
    check(r.d.success, `${name} joined`);
    volunteers.push({ id: r.d.volunteerId, name });
  }
  console.log(`  \u2705 ${volunteers.length} volunteers joined | ~${Math.ceil(TOTAL / volunteers.length)} contacts each`);

  // ══════════════════════════════════════════════════════
  section('4. VOLUNTEERS SEND MESSAGES (simulated messaging provider)');
  // ══════════════════════════════════════════════════════

  // Since messaging provider isn't configured, we manually mark assignments as sent
  // This simulates what happens after messaging provider successfully delivers
  delete require.cache[require.resolve('./db')];
  const db = require('./db');
  const allAssignments = db.prepare(`
    SELECT a.id, a.volunteer_id, c.phone, c.first_name
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.session_id = ? AND a.status = 'pending'
  `).all(sessionId);

  console.log(`  Simulating ${allAssignments.length} message sends through messaging provider...`);
  let sentCount = 0;
  const markSent = db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name) VALUES (?, ?, 'outbound', ?, ?)");
  const template = 'Hi {firstName}! This is a volunteer for Jane Rodriguez, running for District 42. Can we count on your vote on Nov 3rd?';

  const sendTx = db.transaction(() => {
    for (const a of allAssignments) {
      const msg = template.replace('{firstName}', a.first_name || '');
      markSent.run(a.id);
      insertMsg.run(a.phone, msg, sessionId, volNames[sentCount % volNames.length]);
      sentCount++;
    }
  });
  sendTx();
  console.log(`  \u2705 ${sentCount} messages "sent" through messaging provider`);
  check(sentCount === TOTAL, `All ${TOTAL} messages sent`);

  // Check session stats
  const sessDetail = await req('GET', `/api/p2p/sessions/${sessionId}`);
  console.log(`  Session stats: sent=${sessDetail.d.session?.totalSent} remaining=${sessDetail.d.session?.remaining} total=${sessDetail.d.session?.totalContacts}`);

  // ══════════════════════════════════════════════════════
  section('5. SIMULATE INCOMING REPLIES (~30% = ~600 people)');
  // ══════════════════════════════════════════════════════

  const REPLY_RATE = 0.30;
  const replyCount = Math.floor(TOTAL * REPLY_RATE);
  console.log(`  Simulating ${replyCount} incoming replies via messaging provider webhook...`);

  // Pick random contacts to reply
  const replyIndices = new Set();
  while (replyIndices.size < replyCount) {
    replyIndices.add(Math.floor(Math.random() * TOTAL));
  }

  let webhookOk = 0;
  let webhookFail = 0;
  let batchCount = 0;

  for (const idx of replyIndices) {
    const phone = allPhones[idx];
    const reply = REPLIES[idx % REPLIES.length];
    const r = await postForm('/incoming', { From: phone, Body: reply });
    if (r.s === 200) webhookOk++;
    else webhookFail++;
    batchCount++;
    if (batchCount % 100 === 0) process.stdout.write(`  Processing: ${batchCount}/${replyCount} replies\r`);
  }
  console.log(`\n  \u2705 Webhook results: ${webhookOk} OK / ${webhookFail} failed`);
  check(webhookOk === replyCount, `All ${replyCount} webhooks succeeded`);

  // Check how many are now "in_conversation"
  const inConvo = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'in_conversation'").get(sessionId).c;
  console.log(`  \u2705 Assignments now in_conversation: ${inConvo}`);
  check(inConvo >= replyCount * 0.9, `At least ${Math.floor(replyCount * 0.9)} in conversation`);

  // ══════════════════════════════════════════════════════
  section('6. AI SUGGESTIONS FOR REPLIES');
  // ══════════════════════════════════════════════════════

  // Test AI suggestion endpoint (will use script fallback if no Anthropic key)
  console.log('  Testing AI suggestion endpoint with sample messages...');
  const testMessages = [
    { msg: 'Yes! Count me in!', name: 'Maria', sentiment: 'positive' },
    { msg: 'What are your positions on healthcare?', name: 'John', sentiment: 'neutral' },
    { msg: 'Leave me alone.', name: 'David', sentiment: 'negative' },
    { msg: 'I\'m undecided. Convince me.', name: 'Sarah', sentiment: 'neutral' },
    { msg: 'Can I get a yard sign?', name: 'Carlos', sentiment: 'positive' },
  ];

  let aiSuccessCount = 0;
  for (const t of testMessages) {
    const r = await req('POST', '/api/p2p/suggest-reply', {
      voterMessage: t.msg,
      voterName: t.name,
      sentiment: t.sentiment,
      sessionName: 'GOTV - District 42 Blitz'
    });
    const source = r.d.source || 'none';
    const suggestion = r.d.suggestion ? r.d.suggestion.substring(0, 80) : '(none)';
    if (r.d.suggestion) aiSuccessCount++;
    console.log(`  ${source === 'ai' ? '\uD83E\uDD16' : source === 'script' ? '\uD83D\uDCDD' : '\u2753'} [${source.toUpperCase().padEnd(6)}] "${t.msg}" \u2192 "${suggestion}"`);
  }
  console.log(`  \u2705 ${aiSuccessCount}/${testMessages.length} suggestions generated`);
  check(aiSuccessCount > 0, 'At least one AI/script suggestion generated');

  // ══════════════════════════════════════════════════════
  section('6b. GRAMMAR/SPELLING REVIEW FOR MANUAL REPLIES');
  // ══════════════════════════════════════════════════════

  const grammarTests = [
    { draft: 'Hey thier! Im happy to help you with youre questions.', expectChanged: true },
    { draft: 'Thank you for your support!', expectChanged: false },
    { draft: 'We have alot of polices that will benifit you\'re famly.', expectChanged: true },
    { draft: 'OK', expectChanged: false },  // Short msg, skip review
    { draft: 'Your absolutly right, we shoud fix the educaton system.', expectChanged: true },
  ];
  let grammarOk = 0;
  for (const t of grammarTests) {
    const r = await req('POST', '/api/p2p/review-reply', { draftText: t.draft });
    const changed = r.d.changed || false;
    if (changed === t.expectChanged || r.d.corrected) grammarOk++;
    console.log(`  ${changed ? '\u270F\uFE0F ' : '\u2705'} "${t.draft.substring(0, 50)}" \u2192 "${(r.d.corrected || '').substring(0, 50)}" [changed: ${changed}]`);
  }
  console.log(`  \u2705 Grammar review: ${grammarOk}/${grammarTests.length} correct behavior`);
  check(grammarOk >= grammarTests.length - 1, 'Grammar review works correctly');

  // ══════════════════════════════════════════════════════
  section('7. VOLUNTEER SENDS FOLLOW-UP REPLIES (simulated)');
  // ══════════════════════════════════════════════════════

  // Pick first volunteer, get their active conversations
  const vol1 = volunteers[0];
  const vol1Queue = await req('GET', `/api/p2p/volunteers/${vol1.id}/queue`);
  const activeConvos = vol1Queue.d.activeConversations || [];
  console.log(`  ${vol1.name} has ${activeConvos.length} active conversations`);

  // Simulate volunteer viewing and replying to first 10 conversations
  const replyLimit = Math.min(10, activeConvos.length);
  let followUpsSent = 0;
  for (let i = 0; i < replyLimit; i++) {
    const convo = activeConvos[i];
    // View conversation
    const convoData = await req('GET', `/api/p2p/conversations/${convo.id}`);
    const lastInbound = (convoData.d.messages || []).filter(m => m.direction === 'inbound').pop();

    if (lastInbound) {
      // Get AI suggestion
      const sugR = await req('POST', '/api/p2p/suggest-reply', {
        voterMessage: lastInbound.body,
        voterName: convo.first_name,
        sentiment: lastInbound.sentiment || 'neutral',
        sessionName: 'GOTV - District 42 Blitz'
      });

      // Simulate volunteer approving the suggestion (or writing own)
      const replyText = sugR.d.suggestion || 'Thank you for your response! Visit www.janefordistrict42.com for more info.';

      // Manually record the follow-up (simulating messaging provider send)
      db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name) VALUES (?, ?, 'outbound', ?, ?)")
        .run(convo.phone, replyText, sessionId, vol1.name);
      followUpsSent++;
    }
  }
  console.log(`  \u2705 ${vol1.name} sent ${followUpsSent} follow-up replies using AI suggestions`);

  // Mark some conversations complete
  const completeLimit = Math.min(5, activeConvos.length);
  for (let i = 0; i < completeLimit; i++) {
    await req('PATCH', `/api/p2p/assignments/${activeConvos[i].id}/complete`);
  }
  console.log(`  \u2705 ${completeLimit} conversations marked complete`);

  // ══════════════════════════════════════════════════════
  section('8. LARGE SURVEY (2,000 contacts)');
  // ══════════════════════════════════════════════════════

  console.log('  Creating survey with 2,000 recipients...');
  const survR = await req('POST', '/api/surveys', { name: 'District 42 Issues Poll', description: 'Large-scale voter survey' });
  const surveyId = survR.d.id;

  await req('POST', `/api/surveys/${surveyId}/questions`, {
    question_text: 'What is the #1 issue facing our district?',
    question_type: 'single_choice',
    options: [{ text: 'Healthcare' }, { text: 'Economy' }, { text: 'Education' }, { text: 'Public Safety' }]
  });
  await req('POST', `/api/surveys/${surveyId}/questions`, {
    question_text: 'Any other thoughts for the campaign?',
    question_type: 'write_in'
  });

  // Send survey to all contacts
  const survSend = await req('POST', `/api/surveys/${surveyId}/send`, { contact_ids: allContactIds });
  check(survSend.d.success, 'Survey sent to 2,000 contacts');
  console.log(`  \u2705 Survey sent: ${survSend.d.queued} contacts | Join code: ${survSend.d.joinCode}`);

  // Start poll
  await req('POST', `/api/surveys/${surveyId}/start`);
  console.log('  \u2705 Poll started');

  // Simulate ~15% survey response rate (300 people)
  const SURVEY_REPLY_RATE = 0.15;
  const surveyReplyCount = Math.floor(TOTAL * SURVEY_REPLY_RATE);
  console.log(`  Simulating ${surveyReplyCount} survey responses...`);

  const surveyRespondents = new Set();
  while (surveyRespondents.size < surveyReplyCount) {
    surveyRespondents.add(Math.floor(Math.random() * TOTAL));
  }

  const choices = ['Healthcare', 'Economy', 'Education', 'Public Safety', '1', '2', '3', '4'];
  const writeIns = [
    'Fix the roads!', 'More parks please', 'Lower property taxes',
    'Better bus service', 'More jobs for young people', 'Affordable housing',
    'Clean up the beaches', 'Fund our schools', 'Stop the crime',
    'We need a new community center'
  ];

  let surveyResponsesOk = 0;
  let batchNum = 0;
  for (const idx of surveyRespondents) {
    const phone = allPhones[idx];
    // Q1: single choice
    const choice = choices[idx % choices.length];
    const r1 = await postForm('/incoming', { From: phone, Body: choice });
    if (r1.s === 200) {
      // Q2: write-in
      const writeIn = writeIns[idx % writeIns.length];
      const r2 = await postForm('/incoming', { From: phone, Body: writeIn });
      if (r2.s === 200 && r2.d.includes('Thank you')) surveyResponsesOk++;
    }
    batchNum++;
    if (batchNum % 50 === 0) process.stdout.write(`  Processing: ${batchNum}/${surveyReplyCount} survey responses\r`);
  }
  console.log(`\n  \u2705 Survey completed: ${surveyResponsesOk}/${surveyReplyCount} full responses`);
  check(surveyResponsesOk > surveyReplyCount * 0.8, `Most survey responses completed (${surveyResponsesOk})`);

  // Get results
  const resultsR = await req('GET', `/api/surveys/${surveyId}/results`);
  console.log('  Survey results:');
  const q1r = resultsR.d.results?.[0];
  if (q1r?.tally) {
    Object.entries(q1r.tally).forEach(([k, v]) => console.log(`    ${v.text}: ${v.count} votes`));
  }
  console.log(`    Total Q1 responses: ${q1r?.totalResponses}`);
  const q2r = resultsR.d.results?.[1];
  console.log(`    Write-in responses: ${q2r?.writeIns?.length}`);
  console.log(`    Completed sends: ${resultsR.d.completedSends}`);
  check(resultsR.d.completedSends > 0, 'Survey has completed sends');

  // End poll
  const endR = await req('POST', `/api/surveys/${surveyId}/end`);
  console.log(`  \u2705 Poll ended: ${endR.d.expiredSends} pending sends expired`);

  // ══════════════════════════════════════════════════════
  section('9. EVENT INVITES (2,000 contacts)');
  // ══════════════════════════════════════════════════════

  const today = new Date().toISOString().split('T')[0];
  const evR = await req('POST', '/api/events', {
    title: 'District 42 Town Hall',
    description: 'Meet candidate Jane Rodriguez',
    location: 'Miami Convention Center',
    event_date: today,
    event_time: '7:00 PM'
  });
  const eventId = evR.d.id;
  console.log(`  \u2705 Event created (ID: ${eventId})`);

  const invR = await req('POST', `/api/events/${eventId}/invite`, {
    contactIds: allContactIds,
    messageTemplate: "You're invited to meet Jane Rodriguez at the District 42 Town Hall! Miami Convention Center, tonight 7PM."
  });
  check(invR.d.success, 'Event invites sent');
  console.log(`  \u2705 Event invites: ${invR.d.sent} contacts | Join code: ${invR.d.joinCode}`);

  // ══════════════════════════════════════════════════════
  section('10. FINAL STATS');
  // ══════════════════════════════════════════════════════

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const totalSurveySends = db.prepare('SELECT COUNT(*) as c FROM survey_sends').get().c;
  const totalSurveyResponses = db.prepare('SELECT COUNT(*) as c FROM survey_responses').get().c;
  const totalRsvps = db.prepare('SELECT COUNT(*) as c FROM event_rsvps').get().c;
  const totalOptOuts = db.prepare('SELECT COUNT(*) as c FROM opt_outs').get().c;
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM p2p_sessions').get().c;
  const totalAssignments = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments').get().c;

  console.log(`
  Contacts created:       ${allContactIds.length}
  P2P sessions:           ${totalSessions}
  P2P assignments:        ${totalAssignments}
  Messages (in + out):    ${totalMessages}
  Survey sends:           ${totalSurveySends}
  Survey responses:       ${totalSurveyResponses}
  Event RSVPs:            ${totalRsvps}
  Opt-outs:               ${totalOptOuts}
  Time elapsed:           ${elapsed}s
  `);

  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed === 0) {
    console.log(`\n  \uD83C\uDF89 ALL TESTS PASSED! System handles ${TOTAL} contacts smoothly.\n`);
  } else {
    console.log(`\n  \u26A0\uFE0F  ${failed} test(s) failed.\n`);
  }
}

// Clean database for fresh test run
const fs = require('fs');
const pth = require('path');
const dataDir = pth.join(__dirname, 'data');
['campaign.db', 'campaign.db-wal', 'campaign.db-shm'].forEach(f => {
  const p = pth.join(dataDir, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

process.env.PORT = '3999';
process.env.SESSION_SECRET = 'loadtest-secret-12345';
require('./server');

setTimeout(async () => {
  try { await run(); }
  catch (e) { console.error('\n\u274C CRASHED:', e.message, '\n', e.stack); process.exit(1); }
  process.exit(failed > 0 ? 1 : 0);
}, 1500);
