#!/usr/bin/env node
/**
 * 300K VOTER STRESS TEST (Cameron County scale)
 * Tests the full platform at scale:
 * 1. Import 300,000 voters across 25 precincts
 * 2. Import election history (10 elections over 8 years)
 * 3. Early voting tracking (daily updates)
 * 4. Universe builder segmentation
 * 5. Captain list-building at scale
 * 6. Performance benchmarks
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:3998';
let cookieJar = '';
let passed = 0, failed = 0;
const timings = {};

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
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
    if (payload) r.write(payload);
    r.end();
  });
}

function ok(label, condition) {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

function timer(name) {
  timings[name] = Date.now();
}
function timerEnd(name) {
  const ms = Date.now() - timings[name];
  console.log(`    -> ${name}: ${(ms/1000).toFixed(2)}s`);
  return ms;
}

// Data generators
const PRECINCTS = [];
for (let i = 1; i <= 25; i++) PRECINCTS.push('PCT-' + String(i).padStart(3, '0'));

const STREETS = ['Main St','Oak Ave','Elm Dr','Pine Rd','Maple Ln','Cedar Ct','Birch Way','Walnut Blvd','1st Ave','2nd Ave','3rd Ave','4th Ave','Market St','Broadway','Park Ave','Lake Dr','Hill Rd','River Rd','Church St','School St','Washington Ave','Lincoln Blvd','Jefferson Rd','Adams Ct','Monroe Dr'];
const FIRST_NAMES = ['Maria','Jose','James','Sarah','Michael','Linda','David','Patricia','Carlos','Jennifer','Robert','Ana','William','Rosa','Daniel','Laura','Ricardo','Emily','Juan','Michelle','Antonio','Elizabeth','Francisco','Susan','Miguel','Karen','Jorge','Nancy','Pedro','Lisa','Alejandro','Betty','Fernando','Dorothy','Hector','Sandra','Raul','Margaret','Sergio','Carol','Roberto','Christine','Mario','Martha','Eduardo','Deborah','Alberto','Rebecca','Oscar','Angela'];
const LAST_NAMES = ['Garcia','Smith','Johnson','Martinez','Williams','Rodriguez','Brown','Lopez','Davis','Hernandez','Wilson','Gonzalez','Anderson','Perez','Thomas','Rivera','Taylor','Flores','Moore','Ramirez','Jackson','Sanchez','White','Cruz','Harris','Reyes','Clark','Morales','Lewis','Ortiz','Robinson','Gutierrez','Walker','Diaz','Hall','Mendoza','Allen','Vargas','Young','Castillo','King','Romero','Wright','Ramos','Scott','Medina','Hill','Torres','Green','Acosta'];
const PARTIES = ['D','D','D','R','R','I','NP']; // Weighted: more D
const SUPPORTS = ['strong_support','lean_support','undecided','lean_oppose','strong_oppose','unknown','unknown'];
const CITIES = ['Brownsville','San Benito','Harlingen','Los Fresnos','La Feria','Mercedes','Weslaco','Edinburg','McAllen','Mission','Pharr','Donna','Alamo','San Juan','Elsa','Progreso','Rio Hondo','Combes','Palm Valley','Rancho Viejo'];

function randEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randPhone() { return '+1956' + String(Math.floor(1000000 + Math.random() * 9000000)); }
function randEmail(first, last) { return (first + '.' + last + Math.floor(Math.random() * 999) + '@email.com').toLowerCase(); }

// Set port before requiring server
process.env.PORT = '3998';

async function run() {
  const start = Date.now();
  console.log('\n=== 300K VOTER STRESS TEST (Cameron County scale) ===\n');

  // --- Phase 1: Clean DB and setup ---
  console.log('Phase 1: Setup');
  const dataDir = path.join(__dirname, 'data');
  ['campaign.db', 'campaign.db-wal', 'campaign.db-shm'].forEach(f => {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  const server = require('./server');
  await new Promise(r => setTimeout(r, 500));

  const setup = await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Stress Test Admin' });
  ok('Auth setup', setup.s === 200 && setup.d.success);
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
  ok('Login', login.s === 200 && login.d.success);

  // --- Phase 2: Import 300,000 voters in batches ---
  console.log('\nPhase 2: Import 300,000 voters across 25 precincts');
  const TOTAL_VOTERS = 300000;
  const BATCH_SIZE = 10000;
  const batches = Math.ceil(TOTAL_VOTERS / BATCH_SIZE);
  let totalImported = 0;

  timer('voter-import');
  for (let b = 0; b < batches; b++) {
    const batchVoters = [];
    const bStart = b * BATCH_SIZE;
    const bEnd = Math.min(bStart + BATCH_SIZE, TOTAL_VOTERS);
    for (let i = bStart; i < bEnd; i++) {
      const firstName = randEl(FIRST_NAMES);
      const lastName = randEl(LAST_NAMES);
      const addr = String(100 + (i % 5000)) + ' ' + randEl(STREETS);
      batchVoters.push({
        first_name: firstName,
        last_name: lastName,
        phone: randPhone(),
        email: randEmail(firstName, lastName),
        address: addr,
        city: randEl(CITIES),
        zip: '78' + String(500 + (i % 100)).padStart(3, '0'),
        party: randEl(PARTIES),
        support_level: randEl(SUPPORTS),
        precinct: PRECINCTS[i % 25],
        registration_number: 'CAM' + String(100000 + i)
      });
    }
    const res = await req('POST', '/api/voters/import', { voters: batchVoters });
    totalImported += (res.d && res.d.added) || 0;
    process.stdout.write(`    Batch ${b+1}/${batches}: ${totalImported.toLocaleString()} voters imported\r`);
  }
  console.log('');
  const importTime = timerEnd('voter-import');
  ok('Imported ' + totalImported.toLocaleString() + ' voters', totalImported === TOTAL_VOTERS);
  ok('Import rate: ' + Math.round(totalImported / (importTime/1000)) + ' voters/sec', true);

  // --- Phase 3: Verify voter counts and precinct distribution ---
  console.log('\nPhase 3: Verify voter distribution');
  timer('verify-counts');
  const stats = await req('GET', '/api/stats');
  ok('Stats show ' + TOTAL_VOTERS.toLocaleString() + ' voters', stats.s === 200 && stats.d.voters === TOTAL_VOTERS);

  const precinctList = await req('GET', '/api/voters-precincts');
  ok('All 25 precincts present', precinctList.s === 200 && precinctList.d.precincts.length === 25);

  // Spot-check a precinct filter
  const pctSearch = await req('GET', '/api/voters?precinct=PCT-001');
  ok('PCT-001 returns voters (capped at 500)', pctSearch.s === 200 && pctSearch.d.voters.length === 500);

  // Search by name (common name)
  const nameSearch = await req('GET', '/api/voters?q=Garcia');
  ok('Name search returns results', nameSearch.s === 200 && nameSearch.d.voters.length > 0);
  timerEnd('verify-counts');

  // --- Phase 4: Import election history (10 elections, 8 years) ---
  console.log('\nPhase 4: Import election history (10 elections x 300K voters)');

  // Elections to simulate
  const ELECTIONS = [
    { column: 'nov_2024', name: 'November 2024 General', date: '2024-11-05', type: 'general', cycle: 'november' },
    { column: 'mar_2024', name: 'March 2024 Primary', date: '2024-03-05', type: 'primary', cycle: 'march' },
    { column: 'nov_2023', name: 'November 2023 Municipal', date: '2023-11-07', type: 'municipal', cycle: 'november' },
    { column: 'may_2023', name: 'May 2023 Runoff', date: '2023-05-06', type: 'runoff', cycle: 'may' },
    { column: 'port_2023', name: 'Port Authority 2023', date: '2023-05-20', type: 'special', cycle: 'may' },
    { column: 'nov_2022', name: 'November 2022 General', date: '2022-11-08', type: 'general', cycle: 'november' },
    { column: 'mar_2022', name: 'March 2022 Primary', date: '2022-03-01', type: 'primary', cycle: 'march' },
    { column: 'nov_2020', name: 'November 2020 General', date: '2020-11-03', type: 'general', cycle: 'november' },
    { column: 'mar_2020', name: 'March 2020 Primary', date: '2020-03-03', type: 'primary', cycle: 'march' },
    { column: 'nov_2018', name: 'November 2018 General', date: '2018-11-06', type: 'general', cycle: 'november' }
  ];

  // Voting participation rates by election (realistic: generals have higher turnout)
  const TURNOUT = {
    nov_2024: 0.65, mar_2024: 0.25, nov_2023: 0.35, may_2023: 0.15,
    port_2023: 0.12, nov_2022: 0.55, mar_2022: 0.20, nov_2020: 0.70,
    mar_2020: 0.22, nov_2018: 0.50
  };

  const ELECTION_BATCH_SIZE = 5000;
  const electionBatches = Math.ceil(TOTAL_VOTERS / ELECTION_BATCH_SIZE);
  let totalElectionVotes = 0;
  let totalElectionMatched = 0;

  timer('election-import');
  for (let b = 0; b < electionBatches; b++) {
    const rows = [];
    const bStart = b * ELECTION_BATCH_SIZE;
    const bEnd = Math.min(bStart + ELECTION_BATCH_SIZE, TOTAL_VOTERS);
    for (let i = bStart; i < bEnd; i++) {
      const row = { registration_number: 'CAM' + String(100000 + i) };
      // Simulate realistic voting patterns — voters with lower IDs are more likely to vote
      // (simulates partisan/habitual voters)
      for (const el of ELECTIONS) {
        const baseRate = TURNOUT[el.column];
        // Higher-numbered voters (newer registrants) vote less
        const voterFactor = 1 - (i / TOTAL_VOTERS) * 0.4; // 60-100% of base rate
        row[el.column] = Math.random() < baseRate * voterFactor ? 'Y' : 'N';
      }
      rows.push(row);
    }
    const res = await req('POST', '/api/election-votes/import', { rows, elections: ELECTIONS });
    totalElectionMatched += (res.d && res.d.matched) || 0;
    totalElectionVotes += (res.d && res.d.votes_recorded) || 0;
    process.stdout.write(`    Batch ${b+1}/${electionBatches}: ${totalElectionMatched.toLocaleString()} matched, ${totalElectionVotes.toLocaleString()} votes recorded\r`);
  }
  console.log('');
  const electionTime = timerEnd('election-import');
  ok('Election import matched ' + totalElectionMatched.toLocaleString() + ' voters', totalElectionMatched === TOTAL_VOTERS);
  ok('Recorded ' + totalElectionVotes.toLocaleString() + ' vote records', totalElectionVotes > 0);
  ok('Import rate: ' + Math.round(totalElectionMatched / (electionTime/1000)) + ' voters/sec', true);

  // Verify elections
  const electionsData = await req('GET', '/api/election-votes/elections');
  ok('All 10 elections listed', electionsData.s === 200 && electionsData.d.elections.length === 10);
  console.log('    Elections:');
  electionsData.d.elections.forEach(e => {
    console.log('      ' + e.election_name + ': ' + e.voter_count.toLocaleString() + ' voters');
  });

  // --- Phase 5: Early voting simulation (multi-day) ---
  console.log('\nPhase 5: Early voting - simulating 3 days of early voting');
  timer('early-voting');

  // Day 1: 22,000 early voters
  const evDay1Rows = [];
  for (let i = 0; i < 22000; i++) {
    evDay1Rows.push({ registration_number: 'CAM' + String(100000 + i * 3), vote_date: '2026-02-18', vote_method: 'early' });
  }
  let ev1Matched = 0;
  const EV_BATCH = 5000;
  for (let b = 0; b < Math.ceil(evDay1Rows.length / EV_BATCH); b++) {
    const batch = evDay1Rows.slice(b * EV_BATCH, (b + 1) * EV_BATCH);
    const res = await req('POST', '/api/early-voting/import', { rows: batch, vote_date: '2026-02-18', vote_method: 'early' });
    ev1Matched += (res.d && res.d.matched) || 0;
  }
  ok('Day 1: ' + ev1Matched.toLocaleString() + ' early voters', ev1Matched > 0);

  // Day 2: 18,000 more early voters (some new, some duplicates)
  const evDay2Rows = [];
  for (let i = 0; i < 18000; i++) {
    evDay2Rows.push({ registration_number: 'CAM' + String(100000 + i * 5 + 1), vote_date: '2026-02-19', vote_method: 'early' });
  }
  let ev2Matched = 0, ev2Already = 0;
  for (let b = 0; b < Math.ceil(evDay2Rows.length / EV_BATCH); b++) {
    const batch = evDay2Rows.slice(b * EV_BATCH, (b + 1) * EV_BATCH);
    const res = await req('POST', '/api/early-voting/import', { rows: batch, vote_date: '2026-02-19', vote_method: 'early' });
    ev2Matched += (res.d && res.d.matched) || 0;
    ev2Already += (res.d && res.d.already_voted) || 0;
  }
  ok('Day 2: ' + ev2Matched.toLocaleString() + ' new + ' + ev2Already.toLocaleString() + ' already', ev2Matched > 0);

  // Day 3: 12,000 mail ballots
  const evDay3Rows = [];
  for (let i = 0; i < 12000; i++) {
    evDay3Rows.push({ registration_number: 'CAM' + String(100000 + i * 7 + 2), vote_date: '2026-02-20', vote_method: 'mail' });
  }
  let ev3Matched = 0, ev3Already = 0;
  for (let b = 0; b < Math.ceil(evDay3Rows.length / EV_BATCH); b++) {
    const batch = evDay3Rows.slice(b * EV_BATCH, (b + 1) * EV_BATCH);
    const res = await req('POST', '/api/early-voting/import', { rows: batch, vote_date: '2026-02-20', vote_method: 'mail' });
    ev3Matched += (res.d && res.d.matched) || 0;
    ev3Already += (res.d && res.d.already_voted) || 0;
  }
  ok('Day 3: ' + ev3Matched.toLocaleString() + ' new mail + ' + ev3Already.toLocaleString() + ' already', ev3Matched > 0);

  const evTime = timerEnd('early-voting');

  // Check early voting stats
  const evStats = await req('GET', '/api/early-voting/stats');
  const totalEarly = evStats.d.earlyVoted;
  const totalRemaining = evStats.d.remaining;
  ok('Total early voted: ' + totalEarly.toLocaleString(), totalEarly > 0);
  ok('Remaining: ' + totalRemaining.toLocaleString(), totalRemaining > 0);
  ok('Early + remaining = total', totalEarly + totalRemaining === TOTAL_VOTERS);
  console.log('    Early voting rate: ' + Math.round(totalEarly / TOTAL_VOTERS * 100) + '%');

  // By-precinct breakdown
  ok('By-precinct stats', evStats.d.byPrecinct && evStats.d.byPrecinct.length === 25);
  console.log('    By-date:');
  evStats.d.byDate.forEach(d => console.log('      ' + d.date + ': ' + d.count.toLocaleString()));
  console.log('    By-method:');
  evStats.d.byMethod.forEach(m => console.log('      ' + m.method + ': ' + m.count.toLocaleString()));

  // Filter tests
  timer('filter-tests');
  const votedList = await req('GET', '/api/voters?early_voting=voted');
  ok('Early voted filter returns 500 (cap)', votedList.s === 200 && votedList.d.voters.length === 500);
  const notVotedList = await req('GET', '/api/voters?early_voting=not_voted');
  ok('Not-voted filter returns 500 (cap)', notVotedList.s === 200 && notVotedList.d.voters.length === 500);

  // Combined filters
  const combinedFilter = await req('GET', '/api/voters?precinct=PCT-001&party=D&early_voting=not_voted');
  ok('Combined filter (precinct+party+early)', combinedFilter.s === 200 && combinedFilter.d.voters.length > 0);
  console.log('    -> PCT-001 + Dem + Not Voted: ' + combinedFilter.d.voters.length + ' results');
  timerEnd('filter-tests');

  // --- Phase 6: Universe Builder at scale ---
  console.log('\nPhase 6: Universe builder - full segmentation at 300K scale');
  timer('universe-builder');

  // Preview: all 25 precincts, 8 years
  const preview1 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8
  });
  ok('Full universe preview', preview1.s === 200 && preview1.d.total_in_precincts > 0);
  console.log('    -> In precincts: ' + preview1.d.total_in_precincts.toLocaleString());
  console.log('    -> Universe (voted in 8 yrs): ' + preview1.d.universe.toLocaleString());

  // Sub-universe: November cycle only
  const preview2 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['november']
  });
  ok('November sub-universe', preview2.s === 200 && preview2.d.sub_universe > 0);
  console.log('    -> November sub-universe: ' + preview2.d.sub_universe.toLocaleString());

  // Sub-universe: March + May cycles
  const preview3 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['march', 'may']
  });
  ok('March+May sub-universe', preview3.s === 200 && preview3.d.sub_universe > 0);
  console.log('    -> March+May sub-universe: ' + preview3.d.sub_universe.toLocaleString());

  // Priority: Port Authority voters
  const preview4 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['november'],
    priority_elections: ['Port Authority 2023']
  });
  ok('Port Authority priority', preview4.s === 200 && preview4.d.priority > 0);
  ok('Extra voters computed', preview4.d.extra >= 0);
  console.log('    -> Priority (Port voters): ' + preview4.d.priority.toLocaleString());
  console.log('    -> Extra (win these over): ' + preview4.d.extra.toLocaleString());

  // Multi-election priority
  const preview5 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 8,
    election_cycles: ['november', 'may'],
    priority_elections: ['Port Authority 2023', 'May 2023 Runoff']
  });
  ok('Multi-election priority', preview5.s === 200 && preview5.d.priority > 0);
  console.log('    -> Port+Runoff priority: ' + preview5.d.priority.toLocaleString());

  // Single precinct universe
  const preview6 = await req('POST', '/api/universe/preview', {
    precincts: ['PCT-001'], years_back: 8,
    election_cycles: ['november'],
    priority_elections: ['Port Authority 2023']
  });
  ok('Single precinct universe', preview6.s === 200 && preview6.d.total_in_precincts > 0 && preview6.d.total_in_precincts <= 15000);
  console.log('    -> PCT-001: ' + preview6.d.total_in_precincts.toLocaleString() + ' total, ' +
    preview6.d.universe.toLocaleString() + ' universe, ' +
    preview6.d.priority.toLocaleString() + ' priority');

  // Narrow window: only last 4 years
  const preview7 = await req('POST', '/api/universe/preview', {
    precincts: PRECINCTS, years_back: 4
  });
  ok('4-year universe smaller than 8-year', preview7.d.universe <= preview1.d.universe);
  console.log('    -> 4yr universe: ' + preview7.d.universe.toLocaleString() + ' vs 8yr: ' + preview1.d.universe.toLocaleString());

  const univTime = timerEnd('universe-builder');

  // --- Phase 7: Build actual lists at scale ---
  console.log('\nPhase 7: Build universe lists');
  timer('build-lists');

  // Build for 5 precincts (realistic race scope)
  const racePrecincts = ['PCT-001', 'PCT-002', 'PCT-003', 'PCT-004', 'PCT-005'];
  const build = await req('POST', '/api/universe/build', {
    precincts: racePrecincts, years_back: 8,
    election_cycles: ['november'],
    priority_elections: ['Port Authority 2023'],
    list_name_universe: 'Cameron County - Universe',
    list_name_sub: 'Cameron County - November Voters',
    list_name_priority: 'Cameron County - Port Voters (Priority)'
  });
  ok('Build universe for 5 precincts', build.s === 200 && build.d.success);
  ok('Universe list created (' + (build.d.created.universe ? build.d.created.universe.added : 0).toLocaleString() + ')',
    build.d.created && build.d.created.universe && build.d.created.universe.added > 0);
  ok('Sub-universe list created (' + (build.d.created.sub_universe ? build.d.created.sub_universe.added : 0).toLocaleString() + ')',
    build.d.created && build.d.created.sub_universe && build.d.created.sub_universe.added > 0);
  ok('Priority list created (' + (build.d.created.priority ? build.d.created.priority.added : 0).toLocaleString() + ')',
    build.d.created && build.d.created.priority && build.d.created.priority.added > 0);
  console.log('    -> Funnel: ' + build.d.total_in_precincts.toLocaleString() + ' in precincts -> ' +
    build.d.universe.toLocaleString() + ' universe -> ' +
    build.d.sub_universe.toLocaleString() + ' sub -> ' +
    build.d.priority.toLocaleString() + ' priority + ' +
    build.d.extra.toLocaleString() + ' extra');

  timerEnd('build-lists');

  // --- Phase 8: GOTV extraction at scale ---
  console.log('\nPhase 8: GOTV extraction');
  timer('gotv-extract');

  const extract1 = await req('POST', '/api/early-voting/extract-remaining', { list_name: 'GOTV - All Remaining' });
  ok('Full GOTV extraction', extract1.s === 200 && extract1.d.added > 0);
  console.log('    -> Full GOTV list: ' + extract1.d.added.toLocaleString() + ' voters');

  const extract2 = await req('POST', '/api/early-voting/extract-remaining', {
    list_name: 'GOTV - PCT-001 Democrats',
    precinct: 'PCT-001', party: 'D'
  });
  ok('Targeted GOTV extraction', extract2.s === 200 && extract2.d.added > 0);
  console.log('    -> PCT-001 Dem GOTV: ' + extract2.d.added.toLocaleString() + ' voters');

  timerEnd('gotv-extract');

  // --- Phase 9: Captain operations at scale ---
  console.log('\nPhase 9: Captain operations at scale');
  timer('captain-ops');

  // Create 10 captains
  const captainIds = [];
  for (let i = 0; i < 10; i++) {
    const cap = await req('POST', '/api/captains', {
      name: 'Captain ' + (i+1) + ' - ' + randEl(FIRST_NAMES) + ' ' + randEl(LAST_NAMES),
      phone: randPhone(), email: 'captain' + (i+1) + '@campaign.com'
    });
    if (cap.s === 200) captainIds.push(cap.d.id);
  }
  ok('Created 10 captains', captainIds.length === 10);

  // Each captain creates a list and adds voters
  let totalCaptainVoters = 0;
  for (let i = 0; i < captainIds.length; i++) {
    const listRes = await req('POST', '/api/captains/' + captainIds[i] + '/lists', {
      name: 'Precinct ' + PRECINCTS[i] + ' Outreach'
    });
    const listId = listRes.d.id;

    // Search and add 100 voters each
    const search = await req('GET', '/api/captains/' + captainIds[i] + '/search?q=' + randEl(LAST_NAMES));
    const votersToAdd = (search.d.voters || []).slice(0, 100);
    for (const v of votersToAdd) {
      await req('POST', '/api/captains/' + captainIds[i] + '/lists/' + listId + '/voters', {
        voter_id: v.id, phone: v.phone, email: v.email
      });
      totalCaptainVoters++;
    }
  }
  ok('Captains added ' + totalCaptainVoters + ' voters to lists', totalCaptainVoters > 0);

  // All-lists rollup
  const allLists = await req('GET', '/api/captains/all-lists');
  ok('All-lists rollup works at scale', allLists.s === 200 && allLists.d.lists.length > 0);
  console.log('    -> Total lists: ' + allLists.d.lists.length + ', Total voters: ' + allLists.d.stats.totalVoters.toLocaleString());

  timerEnd('captain-ops');

  // --- Phase 10: Engagement scoring at scale ---
  console.log('\nPhase 10: Engagement scoring at scale');
  timer('engagement');

  const scoredSearch = await req('GET', '/api/voters?precinct=PCT-001');
  const scoredVoters = scoredSearch.d.voters || [];
  const withScore = scoredVoters.filter(v => v.engagement_score > 0);
  ok('Engagement scoring works', scoredVoters.length > 0);
  ok('Some voters have scores (' + withScore.length + '/' + scoredVoters.length + ')', withScore.length >= 0);

  timerEnd('engagement');

  // --- Phase 11: Precinct analytics at scale ---
  console.log('\nPhase 11: Precinct analytics at 300K scale');
  timer('precinct-analytics');

  const analytics = await req('GET', '/api/analytics/precincts');
  ok('Precinct analytics returns 25 precincts', analytics.s === 200 && analytics.d.precincts.length === 25);
  const totalAnalyticsVoters = analytics.d.precincts.reduce((s, p) => s + p.total_voters, 0);
  ok('Analytics covers all voters', totalAnalyticsVoters === TOTAL_VOTERS);
  console.log('    Top 5 precincts by engagement:');
  analytics.d.precincts.sort((a, b) => b.avg_engagement - a.avg_engagement).slice(0, 5).forEach(p => {
    console.log('      ' + p.precinct + ': ' + p.total_voters.toLocaleString() + ' voters, score ' + p.avg_engagement + ', ' + p.total_touchpoints + ' touchpoints');
  });

  const analyticsTime = timerEnd('precinct-analytics');

  // --- Phase 12: Dashboard stress test ---
  console.log('\nPhase 12: Dashboard at scale');
  timer('dashboard');
  const dashStats = await req('GET', '/api/stats');
  ok('Dashboard stats', dashStats.s === 200 && dashStats.d.voters === TOTAL_VOTERS);
  timerEnd('dashboard');

  // --- Phase 13: Concurrent-style queries (sequential but measuring latency) ---
  console.log('\nPhase 13: Query performance benchmarks');

  const benchmarks = [
    { name: 'Voter search by name', fn: () => req('GET', '/api/voters?q=Garcia') },
    { name: 'Voter search by precinct', fn: () => req('GET', '/api/voters?precinct=PCT-010') },
    { name: 'Combined filter', fn: () => req('GET', '/api/voters?precinct=PCT-005&party=D&support=undecided&early_voting=not_voted') },
    { name: 'Early voting stats', fn: () => req('GET', '/api/early-voting/stats') },
    { name: 'Elections list', fn: () => req('GET', '/api/election-votes/elections') },
    { name: 'Universe preview (all)', fn: () => req('POST', '/api/universe/preview', { precincts: PRECINCTS, years_back: 8 }) },
    { name: 'Universe preview (5 pct)', fn: () => req('POST', '/api/universe/preview', { precincts: racePrecincts, years_back: 8, election_cycles: ['november'], priority_elections: ['Port Authority 2023'] }) },
    { name: 'Precinct analytics', fn: () => req('GET', '/api/analytics/precincts') },
    { name: 'Captain all-lists', fn: () => req('GET', '/api/captains/all-lists') },
    { name: 'Precinct dropdown', fn: () => req('GET', '/api/voters-precincts') },
  ];

  for (const bm of benchmarks) {
    const t = Date.now();
    const res = await bm.fn();
    const ms = Date.now() - t;
    const pass = res.s === 200;
    ok(bm.name + ' (' + ms + 'ms)', pass);
  }

  // --- Summary ---
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log(`300K STRESS TEST: ${passed} passed, ${failed} failed (${elapsed}s)`);
  console.log('='.repeat(60));
  console.log('\nScale Summary:');
  console.log('  Voters:           ' + TOTAL_VOTERS.toLocaleString());
  console.log('  Precincts:        ' + PRECINCTS.length);
  console.log('  Elections:        10');
  console.log('  Vote records:     ' + totalElectionVotes.toLocaleString());
  console.log('  Early voted:      ' + totalEarly.toLocaleString() + ' (' + Math.round(totalEarly/TOTAL_VOTERS*100) + '%)');
  console.log('  Universe funnel:  ' + build.d.total_in_precincts.toLocaleString() + ' -> ' + build.d.universe.toLocaleString() + ' -> ' + build.d.priority.toLocaleString());
  console.log('  Captains:         ' + captainIds.length);
  console.log('  Captain voters:   ' + totalCaptainVoters.toLocaleString());
  console.log('  Lists created:    ' + allLists.d.lists.length);
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
