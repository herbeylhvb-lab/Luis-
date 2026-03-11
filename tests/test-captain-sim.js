#!/usr/bin/env node
/**
 * CAPTAIN LIST-BUILDING SIMULATION
 * Tests the full captain flow with fake data:
 * 1. Setup: auth + import voters with precincts
 * 2. Create captain + team members
 * 3. Search voters, add to lists with phone/email
 * 4. Add household members
 * 5. Verify list contents and engagement scoring
 * 6. Test precinct analytics
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0;

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
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const r = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach(c => { cookieJar = c.split(';')[0]; });
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
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

const PRECINCTS = ['PCT-101', 'PCT-102', 'PCT-103', 'PCT-104', 'PCT-105'];
const STREETS = ['Main St', 'Oak Ave', 'Elm Dr', 'Pine Rd', 'Maple Ln', 'Cedar Ct', 'Birch Way', 'Walnut Blvd'];
const FIRST_NAMES = ['Maria', 'Jose', 'James', 'Sarah', 'Michael', 'Linda', 'David', 'Patricia', 'Carlos', 'Jennifer', 'Robert', 'Ana', 'William', 'Rosa', 'Daniel', 'Laura', 'Ricardo', 'Emily', 'Juan', 'Michelle'];
const LAST_NAMES = ['Garcia', 'Smith', 'Johnson', 'Martinez', 'Williams', 'Rodriguez', 'Brown', 'Lopez', 'Davis', 'Hernandez', 'Wilson', 'Gonzalez', 'Anderson', 'Perez', 'Thomas', 'Rivera', 'Taylor', 'Flores', 'Moore', 'Ramirez'];
const PARTIES = ['D', 'R', 'I', 'NP'];
const SUPPORTS = ['strong_support', 'lean_support', 'undecided', 'lean_oppose', 'unknown'];

function randEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randPhone() { return '+1512' + String(Math.floor(1000000 + Math.random() * 9000000)); }
function randEmail(first, last) { return (first + '.' + last + Math.floor(Math.random() * 99) + '@email.com').toLowerCase(); }

// Set port before requiring server
process.env.PORT = '3999';

async function run() {
  const start = Date.now();
  console.log('\n=== CAPTAIN LIST-BUILDING SIMULATION ===\n');

  // --- Phase 1: Clean DB and setup auth ---
  console.log('Phase 1: Setup');
  const dataDir = path.join(__dirname, 'data');
  ['campaign.db', 'campaign.db-wal', 'campaign.db-shm'].forEach(f => {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  // Start server
  const server = require('./server');
  await new Promise(r => setTimeout(r, 500));

  // Auth setup
  const setup = await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Test Admin' });
  ok('Auth setup', setup.s === 200 && setup.d.success);

  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
  ok('Login', login.s === 200 && login.d.success);

  // --- Phase 2: Import 200 voters with precincts across 5 precincts ---
  console.log('\nPhase 2: Import voters with precincts');
  const voters = [];
  // Create family clusters at same addresses for household testing
  const addresses = [];
  for (let i = 0; i < 60; i++) {
    addresses.push(String(100 + i) + ' ' + randEl(STREETS));
  }

  for (let i = 0; i < 200; i++) {
    const firstName = randEl(FIRST_NAMES);
    const lastName = randEl(LAST_NAMES);
    const addr = addresses[Math.floor(i / 3.5)]; // ~3-4 voters per address for household clusters
    voters.push({
      first_name: firstName,
      last_name: lastName,
      phone: randPhone(),
      email: randEmail(firstName, lastName),
      address: addr,
      city: 'Austin',
      zip: '78701',
      party: randEl(PARTIES),
      support_level: randEl(SUPPORTS),
      precinct: PRECINCTS[Math.floor(i / 40)], // ~40 per precinct
      registration_number: 'REG' + String(10000 + i)
    });
  }

  const importRes = await req('POST', '/api/voters/import', { voters });
  ok('Import 200 voters', importRes.s === 200 && importRes.d.added === 200);

  // Verify voters have precincts
  const voterList = await req('GET', '/api/voters?precinct=PCT-101');
  ok('Precinct filter works', voterList.s === 200 && voterList.d.voters && voterList.d.voters.length > 0);
  ok('Voters have precinct field', voterList.d.voters && voterList.d.voters[0] && voterList.d.voters[0].precinct === 'PCT-101');

  // --- Phase 3: Log some touchpoints for engagement scoring ---
  console.log('\nPhase 3: Create touchpoints for scoring');
  const allVotersRes = await req('GET', '/api/voters');
  const allVoters = (allVotersRes.d && allVotersRes.d.voters) || [];
  ok('Loaded ' + allVoters.length + ' voters for touchpoints', allVoters.length === 200);

  // Log door knocks for first 50 voters
  let contactsLogged = 0;
  for (let i = 0; i < 50; i++) {
    await req('POST', '/api/voters/' + allVoters[i].id + '/contacts', {
      contact_type: 'Door-knock', result: 'Supportive', notes: 'Good conversation', contacted_by: 'Vol-' + (i % 5)
    });
    contactsLogged++;
  }
  // Log phone calls for voters 20-70
  for (let i = 20; i < 70; i++) {
    await req('POST', '/api/voters/' + allVoters[i].id + '/contacts', {
      contact_type: 'Phone Call', result: 'Answered', notes: 'Discussed policy', contacted_by: 'Caller-' + (i % 3)
    });
    contactsLogged++;
  }
  ok('Logged ' + contactsLogged + ' contacts', contactsLogged === 100);

  // Create an event and check in some voters
  const eventRes = await req('POST', '/api/events', {
    title: 'Town Hall Meeting', location: 'City Hall', event_date: '2026-02-22', event_time: '18:00'
  });
  ok('Created event', eventRes.s === 200);
  const eventId = eventRes.d.id;

  let checkins = 0;
  for (let i = 0; i < 30; i++) {
    const voter = allVoters[i];
    const qrRes = await req('GET', '/api/voters/' + voter.id);
    const token = qrRes.d.voter.qr_token;
    if (token) {
      const ci = await req('POST', '/api/voters/qr/' + token + '/checkin', { event_id: eventId });
      if (ci.s === 200 && ci.d.success) checkins++;
    }
  }
  ok('Checked in ' + checkins + ' voters', checkins >= 25);

  // --- Phase 4: Verify engagement scores are computed ---
  console.log('\nPhase 4: Verify engagement scoring');
  const scoredVoters = (await req('GET', '/api/voters')).d.voters;
  const withScore = scoredVoters.filter(v => v.engagement_score > 0);
  ok('Voters have engagement scores', withScore.length > 0);
  console.log('    -> ' + withScore.length + ' voters have scores > 0');

  // Check that heavily-touched voters have higher scores
  const topVoter = scoredVoters.reduce((best, v) => v.engagement_score > best.engagement_score ? v : best, { engagement_score: 0 });
  ok('Top voter score is meaningful (' + topVoter.engagement_score + ')', topVoter.engagement_score >= 10);
  ok('Touchpoint counts present', scoredVoters.some(v => v.touchpoint_count > 0));

  // --- Phase 5: Test precinct analytics ---
  console.log('\nPhase 5: Precinct analytics');
  const analytics = await req('GET', '/api/analytics/precincts');
  ok('Precinct analytics returns data', analytics.s === 200 && analytics.d.precincts.length === 5);

  const pct101 = analytics.d.precincts.find(p => p.precinct === 'PCT-101');
  ok('PCT-101 has voters (' + (pct101 ? pct101.total_voters : 0) + ')', pct101 && pct101.total_voters > 0);
  ok('PCT-101 has party breakdown', pct101 && (pct101.dem + pct101.rep + pct101.other) === pct101.total_voters);
  ok('PCT-101 has touchpoints', pct101 && pct101.total_touchpoints >= 0);
  console.log('    -> Precinct analytics:', analytics.d.precincts.map(p => p.precinct + ': ' + p.total_voters + ' voters, score ' + p.avg_engagement).join('; '));

  // --- Phase 6: Create captains and teams ---
  console.log('\nPhase 6: Captain setup');
  const captain1 = await req('POST', '/api/captains', { name: 'Maria Garcia', phone: '+15125550001', email: 'maria@campaign.com' });
  ok('Created captain 1', captain1.s === 200 && captain1.d.id);
  const capId1 = captain1.d.id;
  const capCode1 = captain1.d.code;

  const captain2 = await req('POST', '/api/captains', { name: 'James Wilson', phone: '+15125550002', email: 'james@campaign.com' });
  ok('Created captain 2', captain2.s === 200 && captain2.d.id);
  const capId2 = captain2.d.id;

  // Add team members
  const tm1 = await req('POST', '/api/captains/' + capId1 + '/team', { name: 'Ana Rodriguez' });
  ok('Added team member 1', tm1.s === 200);
  const tm2 = await req('POST', '/api/captains/' + capId1 + '/team', { name: 'Carlos Lopez' });
  ok('Added team member 2', tm2.s === 200);
  const tm3 = await req('POST', '/api/captains/' + capId2 + '/team', { name: 'Sarah Johnson' });
  ok('Added team member 3', tm3.s === 200);

  // --- Phase 7: Captain portal login and list creation ---
  console.log('\nPhase 7: Captain portal - login and create lists');
  // Verify captain can access portal
  const capPortal = await req('POST', '/api/captains/login', { code: capCode1 });
  ok('Captain portal login', capPortal.s === 200 && capPortal.d.captain && capPortal.d.captain.name === 'Maria Garcia');

  // Create lists
  const list1 = await req('POST', '/api/captains/' + capId1 + '/lists', { name: 'PCT-101 Block Walk List' });
  ok('Created list 1', list1.s === 200 && list1.d.id);
  const listId1 = list1.d.id;

  const list2 = await req('POST', '/api/captains/' + capId1 + '/lists', { name: 'PCT-102 Undecided Outreach' });
  ok('Created list 2', list2.s === 200);
  const listId2 = list2.d.id;

  const list3 = await req('POST', '/api/captains/' + capId2 + '/lists', { name: 'Event Follow-up List' });
  ok('Created list 3', list3.s === 200);
  const listId3 = list3.d.id;

  // --- Phase 8: Captain searches voters and adds to lists ---
  console.log('\nPhase 8: Search and add voters to lists');

  // Search by name
  const search1 = await req('GET', '/api/captains/' + capId1 + '/search?q=Garcia');
  ok('Captain search by name', search1.s === 200 && search1.d.voters && search1.d.voters.length > 0);
  console.log('    -> Found ' + (search1.d.voters ? search1.d.voters.length : 0) + ' voters named Garcia');

  // Add voters to list 1 with phone/email updates
  let addedToList1 = 0;
  const pct101Voters = allVoters.filter(v => v.precinct === 'PCT-101').slice(0, 15);
  for (const v of pct101Voters) {
    const addRes = await req('POST', '/api/captains/' + capId1 + '/lists/' + listId1 + '/voters', {
      voter_id: v.id,
      phone: v.phone || randPhone(),
      email: v.email || randEmail(v.first_name, v.last_name)
    });
    if (addRes.s === 200 && addRes.d.success) addedToList1++;
  }
  ok('Added ' + addedToList1 + ' voters to list 1', addedToList1 === 15);

  // Add undecided voters from PCT-102 to list 2
  const pct102Undecided = allVoters.filter(v => v.precinct === 'PCT-102' && v.support_level === 'undecided').slice(0, 10);
  let addedToList2 = 0;
  for (const v of pct102Undecided) {
    const addRes = await req('POST', '/api/captains/' + capId1 + '/lists/' + listId2 + '/voters', {
      voter_id: v.id
    });
    if (addRes.s === 200 && addRes.d.success) addedToList2++;
  }
  ok('Added ' + addedToList2 + ' undecided to list 2', addedToList2 === pct102Undecided.length);

  // Captain 2 adds voters from events to list 3
  let addedToList3 = 0;
  for (let i = 0; i < 20 && i < allVoters.length; i++) {
    const addRes = await req('POST', '/api/captains/' + capId2 + '/lists/' + listId3 + '/voters', {
      voter_id: allVoters[i].id,
      phone: allVoters[i].phone,
      email: randEmail(allVoters[i].first_name, allVoters[i].last_name)
    });
    if (addRes.s === 200 && addRes.d.success) addedToList3++;
  }
  ok('Captain 2 added ' + addedToList3 + ' to list 3', addedToList3 === 20);

  // --- Phase 9: Test duplicate add (should succeed with already flag) ---
  console.log('\nPhase 9: Duplicate handling');
  const dupRes = await req('POST', '/api/captains/' + capId1 + '/lists/' + listId1 + '/voters', {
    voter_id: pct101Voters[0].id
  });
  ok('Duplicate add returns already=true', dupRes.s === 200 && dupRes.d.already === true);

  // --- Phase 10: Verify list contents ---
  console.log('\nPhase 10: Verify list contents');
  const listDetail1 = await req('GET', '/api/captains/' + capId1 + '/lists/' + listId1 + '/voters');
  ok('List 1 has ' + (listDetail1.d.voters ? listDetail1.d.voters.length : 0) + ' voters',
     listDetail1.s === 200 && listDetail1.d.voters && listDetail1.d.voters.length === 15);

  const listDetail3 = await req('GET', '/api/captains/' + capId2 + '/lists/' + listId3 + '/voters');
  ok('List 3 has 20 voters', listDetail3.s === 200 && listDetail3.d.voters && listDetail3.d.voters.length === 20);

  // Verify phone/email were updated on voters added with contact info
  const updatedVoter = (await req('GET', '/api/voters/' + pct101Voters[0].id)).d.voter;
  ok('Voter phone was preserved/updated', updatedVoter.phone && updatedVoter.phone.length > 0);
  ok('Voter email was preserved/updated', updatedVoter.email && updatedVoter.email.length > 0);

  // --- Phase 11: Household search ---
  console.log('\nPhase 11: Household search');
  // Pick a voter and look up household (same address via API)
  const sampleVoter = allVoters[0];
  const hhSearch = await req('GET', '/api/captains/' + capId1 + '/household?voter_id=' + sampleVoter.id);
  const hhMembers = (hhSearch.d && hhSearch.d.household) || [];
  console.log('    -> Voter: ' + sampleVoter.first_name + ' ' + sampleVoter.last_name + ' at "' + sampleVoter.address + '"');
  console.log('    -> Household members found: ' + hhMembers.length);
  if (hhMembers.length > 0) {
    hhMembers.forEach(function(m) {
      console.log('       - ' + m.first_name + ' ' + m.last_name + ' (' + m.address + ')');
    });
  }
  ok('Household lookup returns results', hhSearch.s === 200);

  // Also test address search to find people at same address
  const addrSearch = await req('GET', '/api/captains/' + capId1 + '/search?q=' + encodeURIComponent(sampleVoter.address.split(' ').slice(0, 2).join(' ')));
  const addrResults = (addrSearch.d && addrSearch.d.voters) || [];
  const sameAddr = addrResults.filter(v => v.address === sampleVoter.address);
  console.log('    -> Address search found ' + sameAddr.length + ' voters at same address');
  ok('Address search finds household', sameAddr.length >= 1);

  // Add household members to a list
  let hhAdded = 0;
  for (const m of hhMembers.slice(0, 5)) {
    const addRes = await req('POST', '/api/captains/' + capId1 + '/lists/' + listId1 + '/voters', {
      voter_id: m.id, phone: m.phone, email: m.email
    });
    if (addRes.s === 200 && addRes.d.success && !addRes.d.already) hhAdded++;
  }
  ok('Added ' + hhAdded + ' household members to list', hhAdded >= 0);

  // --- Phase 12: Precinct filter dropdown ---
  console.log('\nPhase 12: Precinct filter');
  const precinctList = await req('GET', '/api/voters-precincts');
  ok('Precinct list returns 5', precinctList.s === 200 && precinctList.d.precincts.length === 5);
  ok('Precincts are correct', precinctList.d.precincts.includes('PCT-101') && precinctList.d.precincts.includes('PCT-105'));

  // --- Phase 13: Voter detail with precinct ---
  console.log('\nPhase 13: Voter detail with precinct');
  const voterDetail = await req('GET', '/api/voters/' + allVoters[0].id);
  ok('Voter detail includes precinct', voterDetail.s === 200 && voterDetail.d.voter.precinct !== undefined);

  // Update voter precinct
  const updateRes = await req('PUT', '/api/voters/' + allVoters[0].id, { precinct: 'PCT-999' });
  ok('Update voter precinct', updateRes.s === 200);
  const afterUpdate = await req('GET', '/api/voters/' + allVoters[0].id);
  ok('Precinct was updated', afterUpdate.d.voter.precinct === 'PCT-999');

  // --- Phase 14: List types and all-lists endpoint ---
  console.log('\nPhase 14: List types and all-lists rollup');

  // Create admin lists with different types
  const adminList1 = await req('POST', '/api/admin-lists', { name: 'Rally Invite List', list_type: 'event', description: 'Voters to invite to rally' });
  ok('Created event admin list', adminList1.s === 200 && adminList1.d.id);
  const adminList2 = await req('POST', '/api/admin-lists', { name: 'Phone Bank Targets', list_type: 'text' });
  ok('Created text admin list', adminList2.s === 200);
  const adminList3 = await req('POST', '/api/admin-lists', { name: 'Satisfaction Survey', list_type: 'survey' });
  ok('Created survey admin list', adminList3.s === 200);

  // Add some voters to admin lists
  await req('POST', '/api/admin-lists/' + adminList1.d.id + '/voters', { voterIds: allVoters.slice(0, 10).map(v => v.id) });
  await req('POST', '/api/admin-lists/' + adminList2.d.id + '/voters', { voterIds: allVoters.slice(10, 25).map(v => v.id) });

  // Create a captain list with a type
  const typedList = await req('POST', '/api/captains/' + capId1 + '/lists', { name: 'Event Follow-up Calls', list_type: 'event' });
  ok('Created typed captain list', typedList.s === 200);

  // Test all-lists rollup
  const allLists = await req('GET', '/api/captains/all-lists');
  ok('All-lists endpoint returns data', allLists.s === 200 && allLists.d.lists && allLists.d.lists.length > 0);
  console.log('    -> Total lists: ' + allLists.d.lists.length);

  const captainSrcLists = allLists.d.lists.filter(l => l.source === 'captain');
  const adminSrcLists = allLists.d.lists.filter(l => l.source === 'admin');
  ok('Has captain-sourced lists (' + captainSrcLists.length + ')', captainSrcLists.length > 0);
  ok('Has admin-sourced lists (' + adminSrcLists.length + ')', adminSrcLists.length >= 3);

  // Verify type filtering works client-side
  const eventLists = allLists.d.lists.filter(l => l.list_type === 'event');
  ok('Event type lists found (' + eventLists.length + ')', eventLists.length >= 2);
  const textLists = allLists.d.lists.filter(l => l.list_type === 'text');
  ok('Text type lists found (' + textLists.length + ')', textLists.length >= 1);

  // Verify stats
  ok('All-lists stats present', allLists.d.stats && allLists.d.stats.totalLists > 0);
  console.log('    -> By type:', JSON.stringify(allLists.d.stats.byType));

  // --- Phase 15: Early Voting tracking ---
  console.log('\nPhase 15: Early voting tracking');

  // Check initial stats — 0 early voters
  const evStats1 = await req('GET', '/api/early-voting/stats');
  ok('Initial early voting stats', evStats1.s === 200 && evStats1.d.earlyVoted === 0 && evStats1.d.total === 200);

  // Import early voting data using registration numbers
  const evRows = [];
  for (let i = 0; i < 30; i++) {
    evRows.push({
      registration_number: 'REG' + String(10000 + i),
      vote_date: '2026-02-20',
      vote_method: 'early'
    });
  }
  const evImport1 = await req('POST', '/api/early-voting/import', { rows: evRows, vote_date: '2026-02-20', vote_method: 'early' });
  ok('Early voting import matched ' + evImport1.d.matched, evImport1.s === 200 && evImport1.d.matched === 30);
  ok('Import details by registration', evImport1.d.details && evImport1.d.details.by_registration === 30);

  // Verify stats updated
  const evStats2 = await req('GET', '/api/early-voting/stats');
  ok('Early voting stats updated (30 voted)', evStats2.s === 200 && evStats2.d.earlyVoted === 30);
  ok('Remaining count correct', evStats2.d.remaining === 170);
  ok('By-date data present', evStats2.d.byDate && evStats2.d.byDate.length > 0);

  // Re-import same voters — should show already_voted
  const evImport2 = await req('POST', '/api/early-voting/import', { rows: evRows.slice(0, 5), vote_date: '2026-02-21' });
  ok('Duplicate import shows already_voted', evImport2.s === 200 && evImport2.d.already_voted === 5 && evImport2.d.matched === 0);

  // Get non-early voters to pick test subjects
  const notVotedYet = (await req('GET', '/api/voters?early_voting=not_voted')).d.voters;

  // Import by phone match — pick a voter we know hasn't voted
  const phoneVoter = notVotedYet[0];
  const evPhoneImport = await req('POST', '/api/early-voting/import', {
    rows: [{ phone: phoneVoter.phone, vote_date: '2026-02-21', vote_method: 'mail' }],
    vote_date: '2026-02-21', vote_method: 'mail'
  });
  ok('Phone match import', evPhoneImport.s === 200 && evPhoneImport.d.matched === 1);

  // Import by name+address match — pick another non-voted voter
  const nameVoter = notVotedYet[10];
  const evNameImport = await req('POST', '/api/early-voting/import', {
    rows: [{
      first_name: nameVoter.first_name, last_name: nameVoter.last_name,
      address: nameVoter.address, vote_date: '2026-02-22'
    }],
    vote_date: '2026-02-22'
  });
  ok('Name+address match import', evNameImport.s === 200 && evNameImport.d.matched === 1);

  // Verify voter file filter — get only early voters (30 + phone + name = 32)
  const earlyVotersList = await req('GET', '/api/voters?early_voting=voted');
  ok('Early voting filter (voted) = 32', earlyVotersList.s === 200 && earlyVotersList.d.voters.length === 32);

  // Get only non-early voters
  const notVotedList = await req('GET', '/api/voters?early_voting=not_voted');
  ok('Early voting filter (not_voted) = 168', notVotedList.s === 200 && notVotedList.d.voters.length === 168);

  // Mark individual voter as early voted
  const indVoter = allVoters[60];
  const markRes = await req('POST', '/api/voters/' + indVoter.id + '/early-voted', { vote_date: '2026-02-22', vote_method: 'early' });
  ok('Mark individual early voted', markRes.s === 200 && markRes.d.success);

  // Clear early voted for the individual
  const clearRes = await req('DELETE', '/api/voters/' + indVoter.id + '/early-voted');
  ok('Clear early voted', clearRes.s === 200 && clearRes.d.success);

  // Extract remaining voters to a new admin list
  const extractRes = await req('POST', '/api/early-voting/extract-remaining', { list_name: 'GOTV Test List' });
  ok('Extract remaining to list', extractRes.s === 200 && extractRes.d.success && extractRes.d.added > 0);
  console.log('    -> Extracted ' + extractRes.d.added + ' non-early-voters to "' + extractRes.d.listName + '"');

  // Extract with precinct filter
  const extractPct = await req('POST', '/api/early-voting/extract-remaining', { list_name: 'GOTV PCT-103', precinct: 'PCT-103' });
  ok('Extract with precinct filter', extractPct.s === 200 && extractPct.d.success && extractPct.d.added > 0);
  console.log('    -> PCT-103 remaining: ' + extractPct.d.added);

  // Early voting by precinct stats
  ok('By-precinct stats present', evStats2.d.byPrecinct && evStats2.d.byPrecinct.length > 0);

  // --- Phase 16: Universe Builder ---
  console.log('\nPhase 16: Universe builder - election history import');

  // Import election history: column-based mode (like a county voter file)
  const electionRows = [];
  for (let i = 0; i < 200; i++) {
    const v = allVoters[i];
    electionRows.push({
      registration_number: v.registration_number || ('REG' + String(10000 + i)),
      first_name: v.first_name, last_name: v.last_name, address: v.address,
      nov_2024: i < 120 ? 'Y' : 'N',     // 120 voted in Nov 2024
      mar_2024: i < 80 ? 'Y' : 'N',      // 80 voted in Mar 2024
      may_2023: i < 60 ? 'Y' : 'N',      // 60 voted in May 2023
      nov_2022: i < 150 ? 'Y' : 'N',     // 150 voted in Nov 2022
      port_2023: i < 40 ? 'Y' : 'N',     // 40 voted in Port 2023
      nov_2018: i < 180 ? 'Y' : 'N'      // 180 voted in Nov 2018 (old but within 8 years)
    });
  }

  const electionImport = await req('POST', '/api/election-votes/import', {
    rows: electionRows,
    elections: [
      { column: 'nov_2024', name: 'November 2024 General', date: '2024-11-05', type: 'general', cycle: 'november' },
      { column: 'mar_2024', name: 'March 2024 Primary', date: '2024-03-05', type: 'primary', cycle: 'march' },
      { column: 'may_2023', name: 'May 2023 Municipal', date: '2023-05-06', type: 'municipal', cycle: 'may' },
      { column: 'nov_2022', name: 'November 2022 General', date: '2022-11-08', type: 'general', cycle: 'november' },
      { column: 'port_2023', name: 'Port Authority 2023', date: '2023-11-07', type: 'special', cycle: 'november' },
      { column: 'nov_2018', name: 'November 2018 General', date: '2018-11-06', type: 'general', cycle: 'november' }
    ]
  });
  ok('Election import matched voters', electionImport.s === 200 && electionImport.d.matched === 200);
  ok('Election votes recorded', electionImport.d.votes_recorded > 0);
  console.log('    -> ' + electionImport.d.votes_recorded + ' vote records added');

  // Get elections list
  const electionsData = await req('GET', '/api/election-votes/elections');
  ok('Elections listed (6)', electionsData.s === 200 && electionsData.d.elections.length === 6);

  // Preview universe: all precincts, last 8 years
  console.log('\nPhase 17: Universe builder - segmentation');
  const preview1 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8
  });
  ok('Universe preview - all precincts', preview1.s === 200 && preview1.d.total_in_precincts > 0);
  ok('Universe has active voters', preview1.d.universe > 0);
  console.log('    -> Precincts: ' + preview1.d.total_in_precincts + ', Universe: ' + preview1.d.universe);

  // Preview with cycle filter (november only)
  const preview2 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['november']
  });
  ok('Sub-universe with november cycle', preview2.s === 200 && preview2.d.sub_universe > 0);
  console.log('    -> November sub-universe: ' + preview2.d.sub_universe);

  // Preview with priority (Port Authority voters)
  const preview3 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['november'],
    priority_elections: ['Port Authority 2023']
  });
  ok('Priority voters identified', preview3.s === 200 && preview3.d.priority > 0);
  ok('Extra voters = sub - priority', preview3.d.extra === preview3.d.sub_universe - preview3.d.priority);
  console.log('    -> Priority: ' + preview3.d.priority + ', Extra: ' + preview3.d.extra);

  // Build universe and create lists
  const build = await req('POST', '/api/universe/build', {
    precincts: ['PCT-101', 'PCT-102'], years_back: 8,
    election_cycles: ['november'],
    priority_elections: ['Port Authority 2023'],
    list_name_universe: 'Test Universe',
    list_name_sub: 'Test Sub-Universe',
    list_name_priority: 'Test Priority'
  });
  ok('Build universe succeeded', build.s === 200 && build.d.success);
  ok('Universe list created', build.d.created && build.d.created.universe && build.d.created.universe.added > 0);
  ok('Sub-universe list created', build.d.created && build.d.created.sub_universe && build.d.created.sub_universe.added > 0);
  ok('Priority list created', build.d.created && build.d.created.priority && build.d.created.priority.added > 0);
  console.log('    -> Lists created: Universe=' + (build.d.created.universe ? build.d.created.universe.added : 0) +
    ', Sub=' + (build.d.created.sub_universe ? build.d.created.sub_universe.added : 0) +
    ', Priority=' + (build.d.created.priority ? build.d.created.priority.added : 0));

  // Single precinct filter
  const preview4 = await req('POST', '/api/universe/preview', {
    precincts: ['PCT-101'], years_back: 8
  });
  ok('Single precinct filter', preview4.s === 200 && preview4.d.total_in_precincts <= 40);
  console.log('    -> PCT-101 only: ' + preview4.d.total_in_precincts + ' voters, ' + preview4.d.universe + ' universe');

  // --- Phase 18: Dashboard stats ---
  console.log('\nPhase 18: Dashboard stats');
  const stats = await req('GET', '/api/stats');
  ok('Stats show 200 voters', stats.s === 200 && stats.d.voters === 200);

  // --- Summary ---
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log(`RESULTS: ${passed} passed, ${failed} failed (${elapsed}s)`);
  console.log('='.repeat(50) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
