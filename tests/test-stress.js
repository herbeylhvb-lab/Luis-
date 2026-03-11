#!/usr/bin/env node
/**
 * FULL-PLATFORM STRESS TEST
 * Exercises every feature simultaneously:
 * - 5,000 P2P messages sent, 2,000 replies, 5 volunteers
 * - Block walkers knocking doors with GPS
 * - QR scanner checking in voters at events
 * - Captains searching voters and building lists
 * - Surveys to 5,000 contacts, ~15% response
 * - Event invites to 5,000
 * - AI suggestions + grammar review
 * - Admin lists, voter import, contact logging
 * - Opt-outs, touchpoints, activity log
 */

const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0, warnings = 0;

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

function warn(label) { warnings++; console.log(`  \u26A0\uFE0F  WARN: ${label}`); }

function section(title) {
  console.log('\n' + '\u2550'.repeat(60));
  console.log('  ' + title);
  console.log('\u2550'.repeat(60));
}

const FIRST_NAMES = ['Maria','John','Sarah','David','Ana','Carlos','Lisa','James','Rosa','Michael',
  'Jennifer','Robert','Patricia','William','Linda','Richard','Barbara','Thomas','Susan','Joseph',
  'Jessica','Chris','Karen','Daniel','Nancy','Mark','Betty','Paul','Helen','Steven',
  'Sophia','Miguel','Elena','Pedro','Carmen','Luis','Gloria','Diego','Iris','Marco'];
const LAST_NAMES = ['Garcia','Smith','Johnson','Lee','Martinez','Brown','Wilson','Lopez','Davis','Moore',
  'Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Robinson','Clark',
  'Rodriguez','Hernandez','Gonzalez','Perez','Sanchez','Rivera','Torres','Flores','Diaz','Cruz'];
const CITIES = ['Miami','Tampa','Orlando','Jacksonville','Tallahassee','Fort Lauderdale','St Petersburg',
  'Hialeah','Cape Coral','Port St Lucie','Coral Gables','Homestead','Doral','Kendall','Pembroke Pines'];
const STREETS = ['Main St','Oak Ave','Elm Dr','Pine Rd','Maple Blvd','Cedar Ln','Palm Way','Beach Rd',
  'Lake Dr','River Rd','Park Ave','Hill St','Bay Ct','Forest Dr','Ocean Blvd'];
const PARTIES = ['DEM','REP','NPA','LPF','GRE','IND'];
const REPLIES = [
  'Yes! Count me in!', 'Not interested, sorry.', 'Can you tell me more about the candidate?',
  'What are your positions on healthcare?', 'I already voted early.', 'When is the election again?',
  'I support you 100%!', 'No thanks.', 'Where can I volunteer?',
  'I have some concerns about education policy.', 'Leave me alone.',
  'Sure, what do you need?', "I'm undecided. Convince me.", 'My family and I are all voting for you!',
  'What about taxes?', 'How do I register to vote?', 'I live in a different district now.',
  'Thanks for reaching out!', 'I disagree with your stance on immigration.', 'Can I get a yard sign?',
  'STOP', 'Who is this?', 'Wrong number', 'I moved out of state.',
  'Are you a real person?', 'What district is this for?', 'When is the town hall?',
  'I need a ride to the polls.', 'Tell me about early voting locations.', 'Do you support term limits?'
];
const DOOR_RESULTS = ['support','lean_support','undecided','lean_oppose','oppose','not_home','refused','moved','come_back'];
const WRITE_INS = [
  'Fix the roads!', 'More parks please', 'Lower property taxes',
  'Better bus service', 'More jobs for young people', 'Affordable housing',
  'Clean up the beaches', 'Fund our schools', 'Stop the crime',
  'We need a new community center', 'Better public transit',
  'Fix the potholes on Main St', 'More after-school programs',
  'Lower insurance costs', 'Protect the environment'
];

async function run() {
  const startTime = Date.now();
  const TOTAL = 5000;

  section('PHASE 1: SETUP & SEED DATA');

  // Auth
  await req('POST', '/api/auth/setup', { username: 'stresstest', password: 'stress123', display_name: 'Stress Test Admin' });
  const login = await req('POST', '/api/auth/login', { username: 'stresstest', password: 'stress123' });
  check(login.d.success, 'Admin login');
  console.log('  \u2705 Admin authenticated');

  // Campaign knowledge
  await req('POST', '/api/knowledge', { type: 'bio', title: 'Candidate', content: 'Jane Rodriguez is running for State Rep in District 42. Former teacher and small business owner focused on working families.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Healthcare', content: 'Expand Medicaid, lower prescription drug costs, protect pre-existing condition coverage.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Education', content: 'Fully fund public schools, raise teacher pay to $65K minimum, universal Pre-K.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Economy', content: 'Raise minimum wage to $18/hr, small business tax relief, job training programs.' });
  await req('POST', '/api/knowledge', { type: 'policy', title: 'Environment', content: 'Clean energy investment, protect Everglades, ban offshore drilling.' });
  await req('POST', '/api/knowledge', { type: 'details', title: 'Website', content: 'www.janefordistrict42.com' });
  await req('POST', '/api/knowledge', { type: 'details', title: 'Election', content: 'General election: November 3, 2026. Early voting starts October 20.' });
  await req('POST', '/api/knowledge', { type: 'details', title: 'Volunteer', content: 'Text JOIN to 555-JANE or visit www.janefordistrict42.com/volunteer' });
  console.log('  \u2705 Campaign knowledge: bio + 4 policies + 3 details');

  // Response scripts
  await req('POST', '/api/scripts', { scenario: 'supporter_positive', label: 'Supporter', content: 'Thank you for your support! Every vote counts. Visit www.janefordistrict42.com for updates!' });
  await req('POST', '/api/scripts', { scenario: 'undecided_question', label: 'Undecided', content: "Great question! Jane is focused on healthcare, education, and working families. Visit www.janefordistrict42.com for her full platform!" });
  await req('POST', '/api/scripts', { scenario: 'hostile_negative', label: 'Hostile', content: "Thank you for sharing your concerns. We respect all viewpoints. Visit www.janefordistrict42.com to learn more about Jane's positions." });
  await req('POST', '/api/scripts', { scenario: 'volunteer_interest', label: 'Volunteer', content: 'We would love your help! Text JOIN to 555-JANE or sign up at www.janefordistrict42.com/volunteer' });
  console.log('  \u2705 Response scripts: 4 scenarios');

  // ══════════════════════════════════════════════════
  section('PHASE 2: VOTER FILE IMPORT (5,000 voters)');
  // ══════════════════════════════════════════════════

  console.log('  Importing 5,000 voters in bulk batches...');
  const VOTER_BATCH = 500;
  const allVoterIds = [];
  const allVoterPhones = [];
  const allVoterTokens = [];

  for (let batch = 0; batch < TOTAL / VOTER_BATCH; batch++) {
    const voters = [];
    for (let i = 0; i < VOTER_BATCH; i++) {
      const idx = batch * VOTER_BATCH + i;
      voters.push({
        first_name: FIRST_NAMES[idx % FIRST_NAMES.length],
        last_name: LAST_NAMES[idx % LAST_NAMES.length],
        phone: '+1555' + String(2000000 + idx).padStart(7, '0'),
        email: `voter${idx}@example.com`,
        address: `${100 + (idx % 900)} ${STREETS[idx % STREETS.length]}`,
        city: CITIES[idx % CITIES.length],
        zip: String(33100 + (idx % 50)),
        party: PARTIES[idx % PARTIES.length],
        support_level: ['strong_support','lean_support','undecided','lean_oppose','strong_oppose'][idx % 5],
        registration_number: 'FL' + String(100000 + idx),
        tags: idx % 3 === 0 ? 'frequent_voter' : idx % 3 === 1 ? 'new_registration' : ''
      });
    }
    const r = await req('POST', '/api/voters/import', { voters });
    if (r.d.added) {
      // Get the IDs of newly added voters
      const dbVoters = await req('GET', `/api/voters?q=+1555${String(2000000 + batch * VOTER_BATCH).padStart(7, '0')}`);
    }
    process.stdout.write(`  \u2705 Batch ${batch + 1}/${TOTAL / VOTER_BATCH}: ${(batch + 1) * VOTER_BATCH} voters imported\r`);
  }

  // Get all voter IDs and tokens
  const db = require('./db');
  const allVoters = db.prepare('SELECT id, phone, qr_token FROM voters ORDER BY id').all();
  allVoters.forEach(v => { allVoterIds.push(v.id); allVoterPhones.push(v.phone); allVoterTokens.push(v.qr_token); });
  console.log(`\n  \u2705 Total voters in DB: ${allVoterIds.length}`);
  check(allVoterIds.length >= TOTAL, `Imported ${TOTAL} voters`);

  // ══════════════════════════════════════════════════
  section('PHASE 3: CONTACTS (5,000 for P2P)');
  // ══════════════════════════════════════════════════

  console.log('  Creating 5,000 contacts for P2P texting...');
  const allContactIds = [];
  const allContactPhones = [];
  const CONTACT_BATCH = 250;

  for (let batch = 0; batch < TOTAL / CONTACT_BATCH; batch++) {
    for (let i = 0; i < CONTACT_BATCH; i++) {
      const idx = batch * CONTACT_BATCH + i;
      const phone = '+1555' + String(3000000 + idx).padStart(7, '0');
      const r = await req('POST', '/api/contacts', {
        phone,
        firstName: FIRST_NAMES[idx % FIRST_NAMES.length],
        lastName: LAST_NAMES[idx % LAST_NAMES.length],
        city: CITIES[idx % CITIES.length]
      });
      if (r.d.id) { allContactIds.push(r.d.id); allContactPhones.push(phone); }
    }
    process.stdout.write(`  \u2705 Batch ${batch + 1}/${TOTAL / CONTACT_BATCH}: ${allContactIds.length} contacts\r`);
  }
  console.log(`\n  \u2705 Total contacts: ${allContactIds.length}`);
  check(allContactIds.length >= TOTAL, `Created ${TOTAL} contacts`);

  // ══════════════════════════════════════════════════
  section('PHASE 4: ADMIN LISTS');
  // ══════════════════════════════════════════════════

  // Create 3 admin lists with different voter segments
  const lists = [];
  const listNames = ['Miami DEM Voters', 'Tampa Undecided', 'All Frequent Voters'];
  for (const name of listNames) {
    const r = await req('POST', '/api/admin-lists', { name, description: `Auto-created for stress test: ${name}` });
    lists.push(r.d.id);
  }
  console.log(`  \u2705 Created ${lists.length} admin lists`);

  // Add voters to lists (1,500 Miami DEMs, 1,000 Tampa undecided, 2,000 frequent voters)
  const miamiDems = allVoterIds.filter((_, i) => i % CITIES.length === 0 && i % PARTIES.length === 0).slice(0, 1500);
  const tampaUndecided = allVoterIds.filter((_, i) => i % CITIES.length === 1 && i % 5 === 2).slice(0, 1000);
  const frequentVoters = allVoterIds.filter((_, i) => i % 3 === 0).slice(0, 2000);

  const addToList = async (listId, voterIds, label) => {
    const CHUNK = 500;
    for (let i = 0; i < voterIds.length; i += CHUNK) {
      await req('POST', `/api/admin-lists/${listId}/voters`, { voterIds: voterIds.slice(i, i + CHUNK) });
    }
    console.log(`  \u2705 ${label}: ${voterIds.length} voters added`);
  };
  await addToList(lists[0], miamiDems, 'Miami DEM Voters');
  await addToList(lists[1], tampaUndecided, 'Tampa Undecided');
  await addToList(lists[2], frequentVoters, 'All Frequent Voters');

  // Verify list counts
  const listDetail = await req('GET', '/api/admin-lists');
  check(listDetail.d.lists && listDetail.d.lists.length === 3, '3 admin lists created');
  const totalListVoters = (listDetail.d.lists || []).reduce((s, l) => s + (l.voterCount || 0), 0);
  console.log(`  \u2705 Total voters across lists: ${totalListVoters}`);

  // ══════════════════════════════════════════════════
  section('PHASE 5: CAPTAINS & TEAM BUILDING');
  // ══════════════════════════════════════════════════

  // Create 3 captains
  const captains = [];
  const captainNames = [
    { name: 'Captain Rodriguez', phone: '+15551110001', email: 'cap.rod@example.com' },
    { name: 'Captain Smith', phone: '+15551110002', email: 'cap.smith@example.com' },
    { name: 'Captain Lee', phone: '+15551110003', email: 'cap.lee@example.com' }
  ];
  for (const cn of captainNames) {
    const r = await req('POST', '/api/captains', cn);
    captains.push({ id: r.d.id, code: r.d.code, name: cn.name });
  }
  console.log(`  \u2705 Created ${captains.length} captains`);
  check(captains.length === 3 && captains[0].code, 'Captains created with codes');

  // Each captain logs in and builds a team
  for (const cap of captains) {
    const loginR = await req('POST', '/api/captains/login', { code: cap.code });
    check(loginR.d.success, `Captain ${cap.name} login`);

    // Add 3 team members each
    for (let t = 0; t < 3; t++) {
      await req('POST', `/api/captains/${cap.id}/team`, { name: `Team Member ${t + 1} (${cap.name})` });
    }
  }
  console.log('  \u2705 Each captain has 3 team members');

  // Captains search voters and build lists
  const searchQueries = ['Garcia', 'Smith', 'Miami', 'Tampa', 'Rodriguez', 'Johnson', 'Lee', 'Orlando'];
  let totalSearchResults = 0;
  for (const cap of captains) {
    for (const q of searchQueries) {
      const r = await req('GET', `/api/captains/${cap.id}/search?q=${encodeURIComponent(q)}`);
      totalSearchResults += (r.d.voters || []).length;
    }

    // Create a list and add first 50 search results
    const listR = await req('POST', `/api/captains/${cap.id}/lists`, { name: `${cap.name}'s Priority Voters` });
    const capListId = listR.d.id;
    const searchR = await req('GET', `/api/captains/${cap.id}/search?q=Garcia`);
    const foundVoters = (searchR.d.voters || []).slice(0, 50);
    for (const v of foundVoters) {
      await req('POST', `/api/captains/${cap.id}/lists/${capListId}/voters`, { voter_id: v.id });
    }

    // Get household for first voter
    if (foundVoters.length > 0) {
      await req('GET', `/api/captains/${cap.id}/household?voter_id=${foundVoters[0].id}`);
    }
  }
  console.log(`  \u2705 ${captains.length} captains searched (${totalSearchResults} total results), built priority lists`);
  check(totalSearchResults > 100, 'Captain searches returned results');

  // Captain CSV import with cross-matching
  const csvRows = [];
  for (let i = 0; i < 30; i++) {
    csvRows.push({
      first_name: FIRST_NAMES[i % FIRST_NAMES.length],
      last_name: LAST_NAMES[i % LAST_NAMES.length],
      phone: allVoterPhones[i] || '',  // Use existing voter phones for matching
      address: `${100 + i} ${STREETS[i % STREETS.length]}`,
      city: CITIES[i % CITIES.length]
    });
  }
  const capListsR = await req('GET', `/api/captains/${captains[0].id}/lists`);
  const capFirstList = (capListsR.d.lists || [])[0];
  if (capFirstList) {
    const csvR = await req('POST', `/api/captains/${captains[0].id}/lists/${capFirstList.id}/import-csv`, { rows: csvRows });
    console.log(`  \u2705 CSV import: ${csvR.d.auto_added || 0} auto-matched, ${(csvR.d.needs_review || []).length} need review, ${(csvR.d.no_match || []).length} no match`);
    check(csvR.d.success, 'CSV import completed');
  }

  // ══════════════════════════════════════════════════
  section('PHASE 6: P2P CAMPAIGN SESSION (5,000 contacts)');
  // ══════════════════════════════════════════════════

  const sessR = await req('POST', '/api/p2p/sessions', {
    name: 'GOTV Blitz - District 42',
    message_template: 'Hi {firstName}! This is a volunteer for Jane Rodriguez for District 42. Early voting starts Oct 20 - can we count on your vote? Reply YES or ask us anything!',
    assignment_mode: 'auto_split',
    contact_ids: allContactIds
  });
  check(sessR.d.success, 'P2P session created');
  const sessionId = sessR.d.id;
  const joinCode = sessR.d.joinCode;
  console.log(`  \u2705 P2P session: ${sessR.d.contactCount} contacts | Code: ${joinCode}`);

  // 5 volunteers join
  const volNames = ['Carlos R.', 'Lisa M.', 'Ahmed K.', 'Priya S.', 'Mike T.'];
  const volunteers = [];
  for (const name of volNames) {
    const r = await req('POST', '/api/p2p/join', { name, code: joinCode });
    check(r.d.success, `${name} joined P2P`);
    volunteers.push({ id: r.d.volunteerId, name });
  }
  console.log(`  \u2705 ${volunteers.length} volunteers joined | ~${Math.ceil(TOTAL / volunteers.length)} contacts each`);

  // Simulate sending all 5,000 messages
  console.log('  Simulating 5,000 message sends through RumbleUp...');
  const allAssignments = db.prepare(`
    SELECT a.id, a.volunteer_id, c.phone, c.first_name
    FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.session_id = ? AND a.status = 'pending'
  `).all(sessionId);

  const markSent = db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name) VALUES (?, ?, 'outbound', ?, ?)");
  const template = 'Hi {firstName}! This is a volunteer for Jane Rodriguez for District 42. Can we count on your vote?';

  let sentCount = 0;
  const sendTx = db.transaction(() => {
    for (const a of allAssignments) {
      markSent.run(a.id);
      insertMsg.run(a.phone, template.replace('{firstName}', a.first_name || ''), sessionId, volNames[sentCount % volNames.length]);
      sentCount++;
    }
  });
  sendTx();
  console.log(`  \u2705 ${sentCount} messages sent`);
  check(sentCount >= TOTAL, `All ${TOTAL} messages sent`);

  // ══════════════════════════════════════════════════
  section('PHASE 7: INCOMING REPLIES (2,000 / 40%)');
  // ══════════════════════════════════════════════════

  const REPLY_COUNT = 2000;
  console.log(`  Simulating ${REPLY_COUNT} incoming replies via RumbleUp webhook...`);

  const replyIndices = new Set();
  while (replyIndices.size < REPLY_COUNT) {
    replyIndices.add(Math.floor(Math.random() * TOTAL));
  }

  let webhookOk = 0, batchCount = 0;
  for (const idx of replyIndices) {
    const phone = allContactPhones[idx];
    const reply = REPLIES[idx % REPLIES.length];
    const r = await postForm('/incoming', { From: phone, Body: reply });
    if (r.s === 200) webhookOk++;
    batchCount++;
    if (batchCount % 200 === 0) process.stdout.write(`  Processing: ${batchCount}/${REPLY_COUNT} replies\r`);
  }
  console.log(`\n  \u2705 Webhooks: ${webhookOk} OK / ${REPLY_COUNT - webhookOk} failed`);
  check(webhookOk >= REPLY_COUNT * 0.95, `Most webhooks succeeded (${webhookOk})`);

  const inConvo = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'in_conversation'").get(sessionId).c;
  const optedOut = db.prepare("SELECT COUNT(*) as c FROM opt_outs").get().c;
  console.log(`  \u2705 In conversation: ${inConvo} | Opt-outs: ${optedOut}`);
  check(inConvo > 0, 'Some assignments in_conversation');

  // ══════════════════════════════════════════════════
  section('PHASE 8: AI SUGGESTIONS + GRAMMAR REVIEW');
  // ══════════════════════════════════════════════════

  // AI suggestions for varied messages
  const testMessages = [
    { msg: 'Yes! Count me in!', name: 'Maria', sentiment: 'positive' },
    { msg: 'What are your positions on healthcare?', name: 'John', sentiment: 'neutral' },
    { msg: 'Leave me alone.', name: 'David', sentiment: 'negative' },
    { msg: "I'm undecided. Convince me.", name: 'Sarah', sentiment: 'neutral' },
    { msg: 'Can I get a yard sign?', name: 'Carlos', sentiment: 'positive' },
    { msg: 'Where can I volunteer?', name: 'Ana', sentiment: 'positive' },
    { msg: 'What about the environment?', name: 'Lisa', sentiment: 'neutral' },
    { msg: 'I disagree with your stance on taxes.', name: 'James', sentiment: 'negative' },
  ];
  let aiOk = 0;
  for (const t of testMessages) {
    const r = await req('POST', '/api/p2p/suggest-reply', {
      voterMessage: t.msg, voterName: t.name, sentiment: t.sentiment, sessionName: 'GOTV Blitz'
    });
    if (r.d.suggestion) aiOk++;
  }
  console.log(`  \u2705 AI suggestions: ${aiOk}/${testMessages.length} generated`);
  check(aiOk > 0, 'AI/script suggestions work');

  // Grammar review
  const grammarTests = [
    { draft: 'Hey thier! Im happy to help you with youre questions about the campain.', expect: true },
    { draft: 'Thank you for your support!', expect: false },
    { draft: 'We have alot of polices that will benifit youre famly and comunity.', expect: true },
    { draft: 'OK', expect: false },
    { draft: 'Your absolutly right we shoud fix educaton its importent for our kids.', expect: true },
    { draft: 'Jane Rodriguez is committed to fighting for working families in District 42.', expect: false },
  ];
  let grammarOk = 0;
  for (const t of grammarTests) {
    const r = await req('POST', '/api/p2p/review-reply', { draftText: t.draft });
    if (r.d.corrected) grammarOk++;
  }
  console.log(`  \u2705 Grammar review: ${grammarOk}/${grammarTests.length} processed`);
  check(grammarOk === grammarTests.length, 'All grammar reviews returned results');

  // Volunteer follow-up replies
  const vol1 = volunteers[0];
  const vol1Queue = await req('GET', `/api/p2p/volunteers/${vol1.id}/queue`);
  const activeConvos = vol1Queue.d.activeConversations || [];
  console.log(`  ${vol1.name} has ${activeConvos.length} active conversations`);

  const replyLimit = Math.min(20, activeConvos.length);
  let followUps = 0;
  for (let i = 0; i < replyLimit; i++) {
    const convo = activeConvos[i];
    const convoData = await req('GET', `/api/p2p/conversations/${convo.id}`);
    const lastIn = (convoData.d.messages || []).filter(m => m.direction === 'inbound').pop();
    if (lastIn) {
      const sugR = await req('POST', '/api/p2p/suggest-reply', {
        voterMessage: lastIn.body, voterName: convo.first_name, sentiment: 'neutral', sessionName: 'GOTV Blitz'
      });
      const replyText = sugR.d.suggestion || 'Thank you! Visit www.janefordistrict42.com for more info.';
      db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name) VALUES (?, ?, 'outbound', ?, ?)")
        .run(convo.phone, replyText, sessionId, vol1.name);
      followUps++;
    }
  }
  console.log(`  \u2705 ${followUps} follow-up replies sent with AI suggestions`);

  // Mark some complete
  const completeLimit = Math.min(10, activeConvos.length);
  for (let i = 0; i < completeLimit; i++) {
    await req('PATCH', `/api/p2p/assignments/${activeConvos[i].id}/complete`);
  }
  console.log(`  \u2705 ${completeLimit} conversations marked complete`);

  // ══════════════════════════════════════════════════
  section('PHASE 9: BLOCK WALKING (3 walks, 5 walkers)');
  // ══════════════════════════════════════════════════

  // Create 3 walks with addresses
  const walks = [];
  const walkDefs = [
    { name: 'Miami Beach Canvass - Precinct 42A', addresses: 80 },
    { name: 'Coral Gables Sweep - Precinct 42B', addresses: 60 },
    { name: 'Hialeah Door-to-Door - Precinct 42C', addresses: 50 }
  ];
  for (const wd of walkDefs) {
    const r = await req('POST', '/api/walks', { name: wd.name });
    const walkId = r.d.id;
    const joinCode = r.d.joinCode;

    // Add addresses
    const addresses = [];
    for (let i = 0; i < wd.addresses; i++) {
      addresses.push({
        address: `${100 + i} ${STREETS[i % STREETS.length]}`,
        city: CITIES[walks.length % CITIES.length],
        zip: '33' + String(100 + (i % 50)),
        voter_name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[i % LAST_NAMES.length]}`
      });
    }
    await req('POST', `/api/walks/${walkId}/addresses`, { addresses });
    walks.push({ id: walkId, joinCode, name: wd.name, addressCount: wd.addresses });
  }
  console.log(`  \u2705 Created ${walks.length} walks: ${walks.map(w => w.addressCount).join(' + ')} = ${walks.reduce((s, w) => s + w.addressCount, 0)} addresses`);

  // 5 walkers join walks (group walking)
  const walkerNames = ['Diego V.', 'Carmen R.', 'Luis F.', 'Iris G.', 'Marco T.'];
  for (let i = 0; i < walkerNames.length; i++) {
    const walk = walks[i % walks.length];
    const r = await req('POST', '/api/walks/join', { joinCode: walk.joinCode, walkerName: walkerNames[i] });
    check(r.d.success, `${walkerNames[i]} joined ${walk.name}`);
  }
  console.log(`  \u2705 ${walkerNames.length} walkers joined group walks`);

  // Get group info and optimized routes
  for (const walk of walks) {
    const groupR = await req('GET', `/api/walks/${walk.id}/group`);
    const members = groupR.d.members || [];
    const routeR = await req('GET', `/api/walks/${walk.id}/route`);
    console.log(`  \u2705 ${walk.name}: ${members.length} members, route optimized: ${routeR.d.optimized || false}`);
  }

  // Walkers knock doors (simulate GPS-verified knocks)
  let totalKnocks = 0;
  for (const walk of walks) {
    const volR = await req('GET', `/api/walks/${walk.id}/volunteer`);
    const addresses = volR.d.walk?.addresses || [];
    const knockCount = Math.min(40, addresses.length);

    for (let i = 0; i < knockCount; i++) {
      const addr = addresses[i];
      const result = DOOR_RESULTS[i % DOOR_RESULTS.length];
      const r = await req('POST', `/api/walks/${walk.id}/addresses/${addr.id}/log`, {
        result,
        notes: result === 'support' ? 'Strong supporter, wants yard sign' : result === 'not_home' ? 'Left door hanger' : '',
        gps_lat: 25.7617 + (Math.random() * 0.01),
        gps_lng: -80.1918 + (Math.random() * 0.01),
        gps_accuracy: 5 + Math.random() * 20,
        walker_name: walkerNames[i % walkerNames.length]
      });
      if (r.d.success) totalKnocks++;
    }
  }
  console.log(`  \u2705 ${totalKnocks} doors knocked with GPS verification`);
  check(totalKnocks > 100, `Over 100 door knocks logged (${totalKnocks})`);

  // Check walk stats
  for (const walk of walks) {
    const detail = await req('GET', `/api/walks/${walk.id}`);
    const stats = detail.d.walk?.resultStats || {};
    console.log(`  \u2705 ${walk.name}: ${JSON.stringify(stats)}`);
  }

  // ══════════════════════════════════════════════════
  section('PHASE 10: EVENTS + QR CHECK-INS');
  // ══════════════════════════════════════════════════

  const today = new Date().toISOString().split('T')[0];

  // Create 2 events
  const events = [];
  const eventDefs = [
    { title: 'District 42 Town Hall', location: 'Miami Convention Center', time: '7:00 PM' },
    { title: 'Neighborhood Block Party', location: 'Bayfront Park', time: '2:00 PM' }
  ];
  for (const ed of eventDefs) {
    const r = await req('POST', '/api/events', {
      title: ed.title, description: `Campaign event for Jane Rodriguez - ${ed.title}`,
      location: ed.location, event_date: today, event_time: ed.time
    });
    events.push({ id: r.d.id, title: ed.title });
  }
  console.log(`  \u2705 Created ${events.length} events`);

  // Send event invites via P2P (admin list + individual contacts)
  const inv1 = await req('POST', `/api/events/${events[0].id}/invite`, {
    list_id: lists[0],  // Miami DEM voters list
    messageTemplate: "You're invited to the District 42 Town Hall! Meet Jane Rodriguez. Miami Convention Center, tonight 7PM."
  });
  console.log(`  \u2705 Town Hall invites: ${inv1.d.sent} contacts from Miami DEM list`);
  check(inv1.d.success, 'Town Hall invites sent');

  const inv2 = await req('POST', `/api/events/${events[1].id}/invite`, {
    contactIds: allContactIds.slice(0, 2000),
    messageTemplate: "Join us at the Neighborhood Block Party! Bayfront Park, 2PM today. Meet Jane Rodriguez!"
  });
  console.log(`  \u2705 Block Party invites: ${inv2.d.sent} individual contacts`);
  check(inv2.d.success, 'Block Party invites sent');

  // QR check-ins at event (simulate scanner)
  const todayEventsR = await req('GET', '/api/voters/checkins/today-events');
  const todayEvents = todayEventsR.d.events || [];
  console.log(`  \u2705 Today's events detected: ${todayEvents.length}`);
  check(todayEvents.length >= 2, "Today's events found for scanner");

  // Simulate 200 QR check-ins at Town Hall
  let checkinOk = 0, checkinDup = 0;
  const CHECKIN_COUNT = 200;
  for (let i = 0; i < CHECKIN_COUNT; i++) {
    const token = allVoterTokens[i];
    if (!token) continue;
    const r = await req('POST', `/api/voters/qr/${encodeURIComponent(token)}/scan-checkin`, {
      event_id: events[0].id,
      scanned_by: 'Scanner Volunteer'
    });
    if (r.d.success) checkinOk++;
    if (r.d.already) checkinDup++;
  }
  console.log(`  \u2705 QR check-ins: ${checkinOk} new, ${checkinDup} duplicates`);
  check(checkinOk >= CHECKIN_COUNT * 0.8, `Most check-ins succeeded (${checkinOk})`);

  // Try duplicate check-ins (should detect already checked in)
  let dupDetected = 0;
  for (let i = 0; i < 10; i++) {
    const token = allVoterTokens[i];
    if (!token) continue;
    const r = await req('POST', `/api/voters/qr/${encodeURIComponent(token)}/scan-checkin`, {
      event_id: events[0].id,
      scanned_by: 'Scanner Volunteer'
    });
    if (r.d.already) dupDetected++;
  }
  console.log(`  \u2705 Duplicate detection: ${dupDetected}/10 caught`);
  check(dupDetected >= 8, 'Duplicate check-ins properly detected');

  // Self-check-in at Block Party (voter uses their own QR code)
  let selfCheckins = 0;
  for (let i = 500; i < 550; i++) {
    const token = allVoterTokens[i];
    if (!token) continue;
    // First lookup voter info
    await req('GET', `/api/voters/qr/${encodeURIComponent(token)}`);
    const r = await req('POST', `/api/voters/qr/${encodeURIComponent(token)}/checkin`, { event_id: events[1].id });
    if (r.d.success) selfCheckins++;
  }
  console.log(`  \u2705 Self-check-ins at Block Party: ${selfCheckins}`);

  // Check event check-in stats
  for (const ev of events) {
    const statsR = await req('GET', `/api/voters/checkins/event/${ev.id}`);
    console.log(`  \u2705 ${ev.title}: ${statsR.d.total} check-ins`);
  }

  // ══════════════════════════════════════════════════
  section('PHASE 11: LARGE SURVEY (5,000 contacts)');
  // ══════════════════════════════════════════════════

  const survR = await req('POST', '/api/surveys', { name: 'District 42 Priority Issues Poll', description: 'Large-scale voter survey on key issues' });
  const surveyId = survR.d.id;

  await req('POST', `/api/surveys/${surveyId}/questions`, {
    question_text: 'What is the #1 issue facing District 42?',
    question_type: 'single_choice',
    options: [{ text: 'Healthcare' }, { text: 'Economy & Jobs' }, { text: 'Education' }, { text: 'Public Safety' }, { text: 'Environment' }]
  });
  await req('POST', `/api/surveys/${surveyId}/questions`, {
    question_text: 'How likely are you to vote in November?',
    question_type: 'single_choice',
    options: [{ text: 'Definitely voting' }, { text: 'Probably voting' }, { text: 'Might vote' }, { text: 'Unlikely' }]
  });
  await req('POST', `/api/surveys/${surveyId}/questions`, {
    question_text: 'Any message for Jane Rodriguez?',
    question_type: 'write_in'
  });
  console.log('  \u2705 Survey created with 3 questions (2 choice + 1 write-in)');

  // Send to all contacts
  const survSend = await req('POST', `/api/surveys/${surveyId}/send`, { contact_ids: allContactIds });
  check(survSend.d.success, 'Survey sent to 5,000 contacts');
  console.log(`  \u2705 Survey sent: ${survSend.d.queued} contacts`);

  // Start poll
  await req('POST', `/api/surveys/${surveyId}/start`);

  // ~15% response rate = 750 responses
  const SURVEY_REPLY_RATE = 0.15;
  const surveyReplyCount = Math.floor(TOTAL * SURVEY_REPLY_RATE);
  console.log(`  Simulating ${surveyReplyCount} survey responses (3 questions each)...`);

  const surveyRespondents = new Set();
  while (surveyRespondents.size < surveyReplyCount) {
    surveyRespondents.add(Math.floor(Math.random() * TOTAL));
  }

  const q1Choices = ['Healthcare', 'Economy & Jobs', 'Education', 'Public Safety', 'Environment', '1', '2', '3', '4', '5'];
  const q2Choices = ['Definitely voting', 'Probably voting', 'Might vote', 'Unlikely', '1', '2', '3', '4'];
  let surveyComplete = 0, sNum = 0;
  for (const idx of surveyRespondents) {
    const phone = allContactPhones[idx];
    // Q1
    await postForm('/incoming', { From: phone, Body: q1Choices[idx % q1Choices.length] });
    // Q2
    await postForm('/incoming', { From: phone, Body: q2Choices[idx % q2Choices.length] });
    // Q3 write-in
    const r3 = await postForm('/incoming', { From: phone, Body: WRITE_INS[idx % WRITE_INS.length] });
    if (r3.s === 200 && r3.d.includes('Thank you')) surveyComplete++;
    sNum++;
    if (sNum % 100 === 0) process.stdout.write(`  Processing: ${sNum}/${surveyReplyCount} survey responses\r`);
  }
  console.log(`\n  \u2705 Survey completed: ${surveyComplete}/${surveyReplyCount} full responses`);
  check(surveyComplete > surveyReplyCount * 0.7, `Most survey responses completed (${surveyComplete})`);

  // Get results
  const resultsR = await req('GET', `/api/surveys/${surveyId}/results`);
  const q1 = resultsR.d.results?.[0];
  if (q1?.tally) {
    console.log('  Survey Q1 Results:');
    Object.entries(q1.tally).forEach(([k, v]) => console.log(`    ${v.text}: ${v.count} votes`));
  }
  const q2 = resultsR.d.results?.[1];
  if (q2?.tally) {
    console.log('  Survey Q2 (Turnout):');
    Object.entries(q2.tally).forEach(([k, v]) => console.log(`    ${v.text}: ${v.count} votes`));
  }
  const q3 = resultsR.d.results?.[2];
  console.log(`  Write-in responses: ${q3?.writeIns?.length || 0}`);
  check(resultsR.d.completedSends > 0, 'Survey has completed sends');

  // End poll
  await req('POST', `/api/surveys/${surveyId}/end`);
  console.log('  \u2705 Poll closed');

  // ══════════════════════════════════════════════════
  section('PHASE 12: VOTER CONTACT LOGGING & TOUCHPOINTS');
  // ══════════════════════════════════════════════════

  // Log contacts for random voters
  const contactTypes = ['phone_call', 'door_knock', 'text', 'email', 'mailer'];
  const contactResults = ['support', 'lean_support', 'undecided', 'lean_oppose', 'oppose', 'not_home', 'refused'];
  let contactsLogged = 0;
  for (let i = 0; i < 200; i++) {
    const voterId = allVoterIds[i % allVoterIds.length];
    const r = await req('POST', `/api/voters/${voterId}/contacts`, {
      contact_type: contactTypes[i % contactTypes.length],
      result: contactResults[i % contactResults.length],
      notes: `Stress test contact #${i}`,
      contacted_by: volNames[i % volNames.length]
    });
    if (r.d.success) contactsLogged++;
  }
  console.log(`  \u2705 Voter contacts logged: ${contactsLogged}`);
  check(contactsLogged >= 180, `Most contacts logged (${contactsLogged})`);

  // Get touchpoints for a few voters
  let touchpointOk = 0;
  for (let i = 0; i < 10; i++) {
    const r = await req('GET', `/api/voters/${allVoterIds[i]}/touchpoints`);
    if (r.d.touchpoints && r.d.touchpoints.length > 0) touchpointOk++;
  }
  console.log(`  \u2705 Voter touchpoints: ${touchpointOk}/10 have history`);

  // Aggregate touchpoint stats
  const tpStats = await req('GET', '/api/voters-touchpoints/stats');
  console.log(`  \u2705 Aggregate stats: texts=${tpStats.d.texts}, knocks=${tpStats.d.doorKnocks}, events=${tpStats.d.events}, calls=${tpStats.d.calls}, mailers=${tpStats.d.mailers}`);

  // ══════════════════════════════════════════════════
  section('PHASE 13: DATA ENRICHMENT');
  // ══════════════════════════════════════════════════

  // Enrich voter data (simulate purchased list with phone numbers)
  const enrichRows = [];
  for (let i = 0; i < 100; i++) {
    enrichRows.push({
      first_name: FIRST_NAMES[i % FIRST_NAMES.length],
      last_name: LAST_NAMES[i % LAST_NAMES.length],
      phone: '+1555' + String(9000000 + i).padStart(7, '0'),
      address: `${100 + (i % 900)} ${STREETS[i % STREETS.length]}`,
      city: CITIES[i % CITIES.length],
      zip: String(33100 + (i % 50))
    });
  }
  const enrichR = await req('POST', '/api/voters/enrich', { rows: enrichRows });
  console.log(`  \u2705 Enrichment: ${enrichR.d.filled || 0} filled, ${enrichR.d.skipped || 0} skipped, ${(enrichR.d.conflicts || []).length} conflicts, ${(enrichR.d.unmatched || []).length} unmatched`);
  check(enrichR.d.success, 'Voter enrichment completed');

  // Import canvass data
  const canvassRows = [];
  for (let i = 0; i < 50; i++) {
    canvassRows.push({
      first_name: FIRST_NAMES[i % FIRST_NAMES.length],
      last_name: LAST_NAMES[i % LAST_NAMES.length],
      phone: allVoterPhones[i],
      support_level: ['strong_support','lean_support','undecided'][i % 3],
      contact_type: 'door_knock',
      contact_result: DOOR_RESULTS[i % DOOR_RESULTS.length],
      notes: 'Canvass data import test',
      canvasser: walkerNames[i % walkerNames.length],
      canvass_date: today
    });
  }
  const canvassR = await req('POST', '/api/voters/import-canvass', { rows: canvassRows });
  console.log(`  \u2705 Canvass import: ${canvassR.d.matched || 0} matched, ${canvassR.d.updated || 0} updated, ${canvassR.d.skipped || 0} skipped`);
  check(canvassR.d.success, 'Canvass import completed');

  // ══════════════════════════════════════════════════
  section('PHASE 14: CONCURRENT STRESS (everything at once)');
  // ══════════════════════════════════════════════════

  console.log('  Running parallel operations to stress all systems...');
  const concurrentOps = [];

  // P2P: 50 more incoming replies
  for (let i = 0; i < 50; i++) {
    const phone = allContactPhones[4000 + i];
    if (phone) concurrentOps.push(postForm('/incoming', { From: phone, Body: REPLIES[i % REPLIES.length] }));
  }

  // Captain searches
  for (const cap of captains) {
    concurrentOps.push(req('GET', `/api/captains/${cap.id}/search?q=Maria`));
    concurrentOps.push(req('GET', `/api/captains/${cap.id}/search?q=33101`));
  }

  // Volunteer queue polls
  for (const vol of volunteers) {
    concurrentOps.push(req('GET', `/api/p2p/volunteers/${vol.id}/queue`));
  }

  // QR check-ins
  for (let i = 300; i < 320; i++) {
    const token = allVoterTokens[i];
    if (token) concurrentOps.push(req('POST', `/api/voters/qr/${encodeURIComponent(token)}/scan-checkin`, {
      event_id: events[0].id, scanned_by: 'Speed Scanner'
    }));
  }

  // Walker door knocks
  for (let i = 0; i < 10; i++) {
    const walkVolR = await req('GET', `/api/walks/${walks[0].id}/volunteer`);
    const addrs = walkVolR.d.walk?.addresses || [];
    if (addrs[50 + i]) {
      concurrentOps.push(req('POST', `/api/walks/${walks[0].id}/addresses/${addrs[50 + i].id}/log`, {
        result: DOOR_RESULTS[i % DOOR_RESULTS.length], walker_name: 'Speed Walker',
        gps_lat: 25.76, gps_lng: -80.19
      }));
    }
  }

  // Voter detail lookups
  for (let i = 0; i < 10; i++) {
    concurrentOps.push(req('GET', `/api/voters/${allVoterIds[i]}`));
  }

  const results = await Promise.all(concurrentOps);
  const concurrentOk = results.filter(r => r.s === 200).length;
  console.log(`  \u2705 ${concurrentOk}/${results.length} concurrent operations succeeded`);
  check(concurrentOk >= results.length * 0.9, `Most concurrent ops succeeded (${concurrentOk}/${results.length})`);

  // ══════════════════════════════════════════════════
  section('PHASE 15: CLEANUP & BULK OPERATIONS');
  // ══════════════════════════════════════════════════

  // Bulk delete some walks
  const walkDeleteR = await req('POST', '/api/walks/bulk-delete', { ids: [walks[2].id] });
  check(walkDeleteR.d.success, 'Bulk delete walk');
  console.log(`  \u2705 Deleted walk: ${walks[2].name}`);

  // Delete a captain
  await req('DELETE', `/api/captains/${captains[2].id}`);
  const capsAfter = await req('GET', '/api/captains');
  check((capsAfter.d.captains || []).length === 2, 'Captain deleted, 2 remain');
  console.log('  \u2705 Deleted captain, 2 remain');

  // Remove voter from admin list
  if (miamiDems.length > 0) {
    await req('DELETE', `/api/admin-lists/${lists[0]}/voters/${miamiDems[0]}`);
    console.log('  \u2705 Removed voter from admin list');
  }

  // Delete admin list
  await req('DELETE', `/api/admin-lists/${lists[1]}`);
  const listsAfter = await req('GET', '/api/admin-lists');
  check((listsAfter.d.lists || []).length === 2, 'Admin list deleted, 2 remain');
  console.log('  \u2705 Deleted admin list, 2 remain');

  // ══════════════════════════════════════════════════
  section('FINAL RESULTS');
  // ══════════════════════════════════════════════════

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const totalSurveySends = db.prepare('SELECT COUNT(*) as c FROM survey_sends').get().c;
  const totalSurveyResponses = db.prepare('SELECT COUNT(*) as c FROM survey_responses').get().c;
  const totalCheckins = db.prepare('SELECT COUNT(*) as c FROM voter_checkins').get().c;
  const totalRsvps = db.prepare('SELECT COUNT(*) as c FROM event_rsvps').get().c;
  const totalOptOuts = db.prepare('SELECT COUNT(*) as c FROM opt_outs').get().c;
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM p2p_sessions').get().c;
  const totalAssignments = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments').get().c;
  const totalVoters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const totalContacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  const totalWalkAddrs = db.prepare('SELECT COUNT(*) as c FROM walk_addresses').get().c;
  const totalVoterContacts = db.prepare('SELECT COUNT(*) as c FROM voter_contacts').get().c;
  const totalActivityLog = db.prepare('SELECT COUNT(*) as c FROM activity_log').get().c;
  const totalCaptainLists = db.prepare('SELECT COUNT(*) as c FROM captain_lists').get().c;

  console.log(`
  \u2550\u2550\u2550 PLATFORM STATISTICS \u2550\u2550\u2550
  Voters:                 ${totalVoters}
  Contacts:               ${totalContacts}
  P2P Sessions:           ${totalSessions}
  P2P Assignments:        ${totalAssignments}
  Messages (in+out):      ${totalMessages}
  Survey Sends:           ${totalSurveySends}
  Survey Responses:       ${totalSurveyResponses}
  Event RSVPs:            ${totalRsvps}
  Event Check-Ins:        ${totalCheckins}
  Walk Addresses:         ${totalWalkAddrs}
  Voter Contacts:         ${totalVoterContacts}
  Captain Lists:          ${totalCaptainLists}
  Opt-Outs:               ${totalOptOuts}
  Activity Log Entries:   ${totalActivityLog}
  Time Elapsed:           ${elapsed}s
  `);

  console.log(`  \u2705 Passed: ${passed}`);
  if (warnings > 0) console.log(`  \u26A0\uFE0F  Warnings: ${warnings}`);
  if (failed > 0) console.log(`  \u274C Failed: ${failed}`);

  if (failed === 0) {
    console.log(`\n  \uD83C\uDF89 ALL ${passed} TESTS PASSED! Full platform stress test with ${TOTAL} contacts completed in ${elapsed}s.\n`);
  } else {
    console.log(`\n  \u26A0\uFE0F  ${failed} test(s) failed out of ${passed + failed}.\n`);
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
process.env.SESSION_SECRET = 'stresstest-secret-99999';
require('./server');

setTimeout(async () => {
  try { await run(); }
  catch (e) { console.error('\n\u274C CRASHED:', e.message, '\n', e.stack); process.exit(1); }
  process.exit(failed > 0 ? 1 : 0);
}, 1500);
