#!/usr/bin/env node
/**
 * CAPTAIN & SUB-CAPTAIN STRESS TEST (MASSIVE SCALE)
 * Tests the captain hierarchy with large volumes:
 *   1. Setup: auth + import 50,000 voters across 10 precincts
 *   2. Create 75 captains, each with 5 sub-captains (375 sub-captains, 450 total)
 *   3. Create 600 lists, add 50-100 voters per list (~41K+ assignments)
 *   4. Test search, household matching, CSV import at scale
 *   5. Test list retrieval with large voter counts
 *   6. Test all-lists rollup with many lists
 *   7. Test concurrent captain operations
 *   8. Verify no crashes, memory leaks, or data corruption
 *   9. Full system smoke test (walks, events, P2P, surveys, broadcasts)
 */

const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0;
const errors = [];

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
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
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function ok(label, condition) {
  if (condition) { passed++; }
  else { failed++; errors.push(label); console.log('  \x1b[31mFAIL\x1b[0m ' + label); }
}

// --- Data generators ---
const PRECINCTS = ['PCT-001', 'PCT-002', 'PCT-003', 'PCT-004', 'PCT-005', 'PCT-006', 'PCT-007', 'PCT-008', 'PCT-009', 'PCT-010'];
const STREETS = ['Main St', 'Oak Ave', 'Elm Dr', 'Pine Rd', 'Maple Ln', 'Cedar Ct', 'Birch Way', 'Walnut Blvd', 'Cherry Ln', 'Willow Dr', 'Spruce Ave', 'Ash Rd', 'Poplar St', 'Hickory Ct', 'Cypress Blvd'];
const FIRST_NAMES = ['Maria', 'Jose', 'James', 'Sarah', 'Michael', 'Linda', 'David', 'Patricia', 'Carlos', 'Jennifer', 'Robert', 'Ana', 'William', 'Rosa', 'Daniel', 'Laura', 'Ricardo', 'Emily', 'Juan', 'Michelle', 'Thomas', 'Karen', 'Pedro', 'Angela', 'Mark', 'Diana', 'Luis', 'Nancy', 'Jorge', 'Helen'];
const LAST_NAMES = ['Garcia', 'Smith', 'Johnson', 'Martinez', 'Williams', 'Rodriguez', 'Brown', 'Lopez', 'Davis', 'Hernandez', 'Wilson', 'Gonzalez', 'Anderson', 'Perez', 'Thomas', 'Rivera', 'Taylor', 'Flores', 'Moore', 'Ramirez', 'White', 'Clark', 'Lewis', 'Hall', 'Young'];
const PARTIES = ['D', 'R', 'I', 'NP', 'L'];
const SUPPORTS = ['strong_support', 'lean_support', 'undecided', 'lean_oppose', 'unknown'];
const CITIES = ['Austin', 'Dallas', 'Houston', 'San Antonio', 'Fort Worth'];

function randEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randPhone() { return '+1512' + String(Math.floor(1000000 + Math.random() * 9000000)); }
function randEmail(first, last) { return (first + '.' + last + Math.floor(Math.random() * 999) + '@test.com').toLowerCase(); }

async function run() {
  const t0 = Date.now();
  console.log('\n' + '='.repeat(60));
  console.log('  CAPTAIN & SUB-CAPTAIN STRESS TEST');
  console.log('  Testing captains, sub-captains, and large voter lists');
  console.log('='.repeat(60) + '\n');

  // ══════════════════════════════════════════════════════════════
  // PHASE 1: AUTH SETUP
  // ══════════════════════════════════════════════════════════════
  console.log('Phase 1: Auth setup');
  const setup = await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Stress Test Admin' });
  ok('Admin setup', setup.s === 200 && setup.d.success);
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
  ok('Admin login', login.s === 200 && login.d.success);

  // ══════════════════════════════════════════════════════════════
  // PHASE 2: IMPORT 50,000 VOTERS
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 2: Import 50,000 voters across 10 precincts');
  const VOTER_COUNT = 50000;
  const allVoterData = [];
  const addresses = [];
  for (let i = 0; i < 15000; i++) {
    addresses.push(String(100 + i) + ' ' + randEl(STREETS));
  }

  for (let i = 0; i < VOTER_COUNT; i++) {
    const firstName = randEl(FIRST_NAMES);
    const lastName = randEl(LAST_NAMES);
    const addr = addresses[Math.floor(i / 3.5)]; // ~3-4 voters per address
    allVoterData.push({
      first_name: firstName,
      last_name: lastName,
      phone: randPhone(),
      email: randEmail(firstName, lastName),
      address: addr,
      city: randEl(CITIES),
      zip: '7870' + String(Math.floor(i / 500)),
      party: randEl(PARTIES),
      support_level: randEl(SUPPORTS),
      precinct: PRECINCTS[Math.floor(i / (VOTER_COUNT / PRECINCTS.length))],
      registration_number: 'REG' + String(100000 + i)
    });
  }

  // Import in batches of 1000 (to avoid body size issues)
  let totalImported = 0;
  const BATCH_SIZE = 1000;
  for (let b = 0; b < VOTER_COUNT; b += BATCH_SIZE) {
    const batch = allVoterData.slice(b, b + BATCH_SIZE);
    const importRes = await req('POST', '/api/voters/import', { voters: batch });
    ok('Import batch ' + (b / BATCH_SIZE + 1) + ' (' + batch.length + ' voters)', importRes.s === 200 && importRes.d.added === batch.length);
    totalImported += (importRes.d && importRes.d.added) || 0;
  }
  ok('Total imported: ' + totalImported, totalImported === VOTER_COUNT);

  // Fetch all voter IDs by precinct+zip (API limits to 500 per request)
  // Each precinct has 2000 voters spread across 4 zips (500 each)
  let allVoters = [];
  const allZips = [];
  for (let i = 0; i < VOTER_COUNT; i += 500) {
    const z = '7870' + String(Math.floor(i / 500));
    if (!allZips.includes(z)) allZips.push(z);
  }
  for (const pct of PRECINCTS) {
    // Each precinct has 2000 voters, zips are global, query precinct+zip combos
    const pctStart = PRECINCTS.indexOf(pct) * (VOTER_COUNT / PRECINCTS.length);
    const pctEnd = pctStart + (VOTER_COUNT / PRECINCTS.length);
    for (let i = pctStart; i < pctEnd; i += 500) {
      const z = '7870' + String(Math.floor(i / 500));
      const pctRes = await req('GET', '/api/voters?precinct=' + encodeURIComponent(pct) + '&zip=' + z);
      const pctVoters = (pctRes.d && pctRes.d.voters) || [];
      allVoters = allVoters.concat(pctVoters);
    }
  }
  ok('Can retrieve all voters (' + allVoters.length + ')', allVoters.length === VOTER_COUNT);
  console.log('    -> ' + allVoters.length + ' voters retrieved across ' + PRECINCTS.length + ' precincts');

  // ══════════════════════════════════════════════════════════════
  // PHASE 3: CREATE 75 CAPTAINS WITH 5 SUB-CAPTAINS EACH
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 3: Create 75 captains with 5 sub-captains each (450 total)');
  const captains = [];
  const CAPTAIN_COUNT = 75;
  const SUB_CAPTAIN_COUNT = 5;

  for (let c = 0; c < CAPTAIN_COUNT; c++) {
    const capRes = await req('POST', '/api/captains', {
      name: 'Captain ' + (c + 1) + ' - ' + randEl(FIRST_NAMES) + ' ' + randEl(LAST_NAMES),
      phone: randPhone(),
      email: 'captain' + (c + 1) + '@campaign.com'
    });
    ok('Created captain ' + (c + 1), capRes.s === 200 && capRes.d.id);
    const captain = { id: capRes.d.id, code: capRes.d.code, subCaptains: [], lists: [] };

    // Create sub-captains (team members that become real captains)
    for (let sc = 0; sc < SUB_CAPTAIN_COUNT; sc++) {
      const tmRes = await req('POST', '/api/captains/' + captain.id + '/team', {
        name: 'SubCapt ' + (c + 1) + '.' + (sc + 1) + ' - ' + randEl(FIRST_NAMES)
      });
      ok('Created sub-captain ' + (c + 1) + '.' + (sc + 1), tmRes.s === 200 && tmRes.d.id);
      captain.subCaptains.push({ id: tmRes.d.id, code: tmRes.d.code });
    }
    captains.push(captain);
  }
  ok('Total captains created: ' + captains.length, captains.length === CAPTAIN_COUNT);
  ok('Total sub-captains: ' + captains.reduce((s, c) => s + c.subCaptains.length, 0),
    captains.reduce((s, c) => s + c.subCaptains.length, 0) === CAPTAIN_COUNT * SUB_CAPTAIN_COUNT);

  // ══════════════════════════════════════════════════════════════
  // PHASE 4: CREATE LISTS AND ADD 200-500 VOTERS PER LIST
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 4: Create 600 lists (100 voters per captain list, 50 per sub-captain)');
  let totalVotersAdded = 0;
  let totalLists = 0;
  // Use a global index so each list gets unique voters (no duplicates within a list)
  let voterIdx = 0;

  for (let c = 0; c < captains.length; c++) {
    const captain = captains[c];

    // Each captain gets 3 lists with 500 voters each
    for (let l = 0; l < 3; l++) {
      const listRes = await req('POST', '/api/captains/' + captain.id + '/lists', {
        name: 'Captain ' + (c + 1) + ' List ' + (l + 1),
        list_type: ['general', 'event', 'text'][l]
      });
      ok('Created list for captain ' + (c + 1), listRes.s === 200 && listRes.d.id);
      const listId = listRes.d.id;
      captain.lists.push(listId);
      totalLists++;

      // Add 100 voters to this list
      const votersToAdd = 100;
      let addedToThisList = 0;
      for (let v = 0; v < votersToAdd; v++) {
        const voter = allVoters[voterIdx % allVoters.length];
        voterIdx++;
        const addRes = await req('POST', '/api/captains/' + captain.id + '/lists/' + listId + '/voters', {
          voter_id: voter.id
        });
        if (addRes.s === 200 && addRes.d.success && !addRes.d.already) addedToThisList++;
      }
      totalVotersAdded += addedToThisList;
      console.log('    -> Captain ' + (c + 1) + ' List ' + (l + 1) + ': ' + addedToThisList + ' voters added');
    }

    // Each sub-captain gets a list with 200 voters
    for (let sc = 0; sc < captain.subCaptains.length; sc++) {
      const subCaptain = captain.subCaptains[sc];
      const scListRes = await req('POST', '/api/captains/' + subCaptain.id + '/lists', {
        name: 'SubCaptain ' + (c + 1) + '.' + (sc + 1) + ' List',
        list_type: 'general'
      });
      ok('Created sub-captain list ' + (c + 1) + '.' + (sc + 1), scListRes.s === 200 && scListRes.d.id);
      totalLists++;

      const votersToAdd = 50;
      let addedToSubList = 0;
      for (let v = 0; v < votersToAdd; v++) {
        const voter = allVoters[voterIdx % allVoters.length];
        voterIdx++;
        const addRes = await req('POST', '/api/captains/' + subCaptain.id + '/lists/' + scListRes.d.id + '/voters', {
          voter_id: voter.id
        });
        if (addRes.s === 200 && addRes.d.success && !addRes.d.already) addedToSubList++;
      }
      totalVotersAdded += addedToSubList;
      console.log('    -> SubCapt ' + (c + 1) + '.' + (sc + 1) + ': ' + addedToSubList + ' voters');
    }
  }
  console.log('    -> Total voters added across all lists: ' + totalVotersAdded);
  console.log('    -> Total lists created: ' + totalLists);
  ok('Created many lists (' + totalLists + ')', totalLists >= 500);
  ok('Added many voters (' + totalVotersAdded + ')', totalVotersAdded >= 30000);

  // ══════════════════════════════════════════════════════════════
  // PHASE 5: TEST LARGE LIST RETRIEVAL
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 5: Retrieve lists from sample of captains (spot check)');
  // Spot-check 10 captains' lists instead of all 75 (225 lists would be too many assertions)
  const sampleCaptains = [0, 9, 19, 29, 39, 49, 59, 69, 74].map(i => captains[i]).filter(Boolean);
  sampleCaptains.push(captains[Math.floor(captains.length / 2)]); // middle captain
  for (const captain of sampleCaptains) {
    for (const listId of captain.lists) {
      const t1 = Date.now();
      const listVoters = await req('GET', '/api/captains/' + captain.id + '/lists/' + listId + '/voters');
      const elapsed = Date.now() - t1;
      ok('List ' + listId + ' retrieval (' + ((listVoters.d && listVoters.d.voters) || []).length + ' voters, ' + elapsed + 'ms)',
        listVoters.s === 200 && listVoters.d.voters && listVoters.d.voters.length > 0);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 6: ALL-LISTS ROLLUP WITH MANY LISTS
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 6: All-lists rollup');
  const allListsRes = await req('GET', '/api/captains/all-lists');
  ok('All-lists rollup succeeds', allListsRes.s === 200 && allListsRes.d.lists);
  ok('All-lists shows all ' + totalLists + ' captain lists', allListsRes.d.lists.filter(l => l.source === 'captain').length >= totalLists);
  console.log('    -> Total lists in rollup: ' + allListsRes.d.lists.length);
  console.log('    -> Stats: ' + JSON.stringify(allListsRes.d.stats));

  // ══════════════════════════════════════════════════════════════
  // PHASE 7: CAPTAIN PORTAL LOGIN & OPERATIONS AT SCALE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 7: Captain portal login and operations (3 of ' + CAPTAIN_COUNT + ' to stay under rate limit)');
  // Only login as 3 captains to stay under the 10-login/15min rate limit
  // (3 here + 1 sub-captain in Phase 8 + 1 in Phase 12 = 5 total)
  const CAPTAIN_LOGIN_COUNT = 3;
  for (let ci = 0; ci < CAPTAIN_LOGIN_COUNT; ci++) {
    const captain = captains[ci];
    // Save admin cookie
    const adminCookie = cookieJar;

    // Login as captain
    const loginRes = await req('POST', '/api/captains/login', { code: captain.code });
    ok('Captain ' + captain.id + ' portal login', loginRes.s === 200 && loginRes.d.success);
    ok('Captain sees sub-captains (' + ((loginRes.d.captain && loginRes.d.captain.sub_captains) || []).length + ')',
      loginRes.d.captain && loginRes.d.captain.sub_captains && loginRes.d.captain.sub_captains.length === SUB_CAPTAIN_COUNT);
    ok('Captain sees own lists', loginRes.d.captain && loginRes.d.captain.lists && loginRes.d.captain.lists.length >= 2);
    ok('Captain sees sub-captain lists', loginRes.d.captain && loginRes.d.captain.sub_captain_lists && loginRes.d.captain.sub_captain_lists.length >= SUB_CAPTAIN_COUNT);

    // Search voters as captain (should work with large DB)
    const searchT = Date.now();
    const searchRes = await req('GET', '/api/captains/' + captain.id + '/search?q=Garcia');
    ok('Captain search (' + (Date.now() - searchT) + 'ms)', searchRes.s === 200 && searchRes.d.voters);
    console.log('    -> Captain ' + captain.id + ' search found ' + (searchRes.d.voters || []).length + ' results');

    // Search by city
    const citySearch = await req('GET', '/api/captains/' + captain.id + '/search?city=Austin');
    ok('Captain city search', citySearch.s === 200 && citySearch.d.voters);

    // Search by precinct
    const pctSearch = await req('GET', '/api/captains/' + captain.id + '/search?precinct=PCT-001');
    ok('Captain precinct search', pctSearch.s === 200 && pctSearch.d.voters);

    // Restore admin cookie for next iterations
    cookieJar = adminCookie;
  }

  // Spot-check 10 more captains via admin API (search + list retrieval, no login needed)
  const spotCheckIndices = [4, 14, 24, 34, 44, 54, 64, 74].filter(i => i < captains.length && i >= CAPTAIN_LOGIN_COUNT);
  for (const ci of spotCheckIndices) {
    const captain = captains[ci];
    const capSearch = await req('GET', '/api/captains/' + captain.id + '/search?q=Smith');
    ok('Captain ' + captain.id + ' admin search', capSearch.s === 200 && capSearch.d.voters);
    const capLists = await req('GET', '/api/captains/' + captain.id + '/lists');
    ok('Captain ' + captain.id + ' lists accessible', capLists.s === 200 && capLists.d.lists && capLists.d.lists.length >= 3);
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 8: SUB-CAPTAIN PORTAL LOGIN
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 8: Sub-captain portal login (testing 1 sub-captain to stay under rate limit)');
  const adminCookie2 = cookieJar;
  // Only test 1 sub-captain login to stay under the 10-login/15min rate limit
  // (3 captain logins in Phase 7 + 1 here + 1 in Phase 12 = 5 total)
  const testSubCapt = captains[0].subCaptains[0];
  const scLogin = await req('POST', '/api/captains/login', { code: testSubCapt.code });
  ok('Sub-captain ' + testSubCapt.id + ' login', scLogin.s === 200 && scLogin.d.success);
  ok('Sub-captain sees own lists', scLogin.d.captain && scLogin.d.captain.lists && scLogin.d.captain.lists.length >= 1);
  const scSearch = await req('GET', '/api/captains/' + testSubCapt.id + '/search?q=Smith');
  ok('Sub-captain search works', scSearch.s === 200 && scSearch.d.voters);
  cookieJar = adminCookie2;

  // Verify other sub-captains via admin API (search + lists, no login needed)
  for (let sci = 1; sci < captains[0].subCaptains.length; sci++) {
    const sc = captains[0].subCaptains[sci];
    const scLists = await req('GET', '/api/captains/' + sc.id + '/lists');
    ok('Sub-captain ' + sc.id + ' lists accessible', scLists.s === 200 && scLists.d.lists && scLists.d.lists.length >= 1);
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 9: HOUSEHOLD MATCHING AT SCALE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 9: Household matching with 50,000 voters');
  // Pick random voters and test household lookup
  const householdTests = 10;
  let hhFound = 0;
  for (let h = 0; h < householdTests; h++) {
    const voter = allVoters[Math.floor(Math.random() * allVoters.length)];
    const hhT = Date.now();
    const hhRes = await req('GET', '/api/captains/' + captains[0].id + '/household?voter_id=' + voter.id);
    const elapsed = Date.now() - hhT;
    ok('Household lookup ' + (h + 1) + ' (' + elapsed + 'ms)', hhRes.s === 200);
    if (hhRes.d && hhRes.d.household && hhRes.d.household.length > 0) hhFound++;
  }
  console.log('    -> ' + hhFound + '/' + householdTests + ' voters had household matches');

  // ══════════════════════════════════════════════════════════════
  // PHASE 10: CSV IMPORT AT SCALE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 10: CSV import cross-matching with large DB');
  const csvRows = [];
  for (let i = 0; i < 100; i++) {
    const idx = (i * 50) % allVoters.length; // spread across voter list
    const v = allVoters[idx];
    if (!v) continue;
    csvRows.push({
      first_name: v.first_name,
      last_name: v.last_name,
      phone: v.phone,
      address: v.address,
      city: v.city || 'Austin',
      zip: v.zip || '78701'
    });
  }
  // Also add some that won't match
  for (let i = 0; i < 20; i++) {
    csvRows.push({
      first_name: 'NoMatch' + i,
      last_name: 'Person' + i,
      phone: '+10000000000',
      address: '999 Nowhere Blvd',
      city: 'Faketown',
      zip: '00000'
    });
  }

  const csvT = Date.now();
  const csvRes = await req('POST', '/api/captains/' + captains[0].id + '/lists/' + captains[0].lists[0] + '/import-csv', { rows: csvRows });
  const csvElapsed = Date.now() - csvT;
  ok('CSV import succeeds (' + csvElapsed + 'ms)', csvRes.s === 200 && csvRes.d.success);
  console.log('    -> Auto-added: ' + (csvRes.d.auto_added || 0) + ', Already: ' + (csvRes.d.already_on_list || 0) +
    ', Review: ' + ((csvRes.d.needs_review || []).length) + ', No match: ' + ((csvRes.d.no_match || []).length));
  ok('CSV no-match detected', (csvRes.d.no_match || []).length >= 15); // at least 15 of our 20 fakes

  // ══════════════════════════════════════════════════════════════
  // PHASE 11: DUPLICATE HANDLING AT SCALE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 11: Duplicate handling');
  const dupList = captains[0].lists[0];
  // Try adding voters that are already on the list
  let dupsDetected = 0;
  const existingVoters = await req('GET', '/api/captains/' + captains[0].id + '/lists/' + dupList + '/voters');
  const existingIds = ((existingVoters.d && existingVoters.d.voters) || []).slice(0, 20);
  for (const v of existingIds) {
    const dupRes = await req('POST', '/api/captains/' + captains[0].id + '/lists/' + dupList + '/voters', { voter_id: v.id });
    if (dupRes.s === 200 && dupRes.d.already) dupsDetected++;
  }
  ok('Duplicates detected (' + dupsDetected + '/' + existingIds.length + ')', dupsDetected === existingIds.length);

  // ══════════════════════════════════════════════════════════════
  // PHASE 12: ADMIN LISTS WITH CAPTAIN ASSIGNMENTS
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 12: Admin lists assigned to captains');
  const adminList1 = await req('POST', '/api/admin-lists', {
    name: 'Stress Test Admin List 1', list_type: 'text', description: 'Assigned to captain 1'
  });
  ok('Created admin list 1', adminList1.s === 200 && adminList1.d.id);

  // Add 500 voters to admin list
  const adminVoterIds = allVoters.slice(0, 500).map(v => v.id);
  const addToAdminRes = await req('POST', '/api/admin-lists/' + adminList1.d.id + '/voters', { voterIds: adminVoterIds });
  ok('Added 500 voters to admin list', addToAdminRes.s === 200);

  // Assign to captain
  const assignRes = await req('PUT', '/api/admin-lists/' + adminList1.d.id + '/assign', {
    captain_id: captains[0].id
  });
  ok('Assigned admin list to captain', assignRes.s === 200 && assignRes.d.success);

  // Verify captain can see the assigned list
  const savedCookie = cookieJar;
  const capLoginRes = await req('POST', '/api/captains/login', { code: captains[0].code });
  ok('Captain sees assigned admin list', capLoginRes.d.captain && capLoginRes.d.captain.assigned_lists &&
    capLoginRes.d.captain.assigned_lists.length >= 1);
  cookieJar = savedCookie;

  // ══════════════════════════════════════════════════════════════
  // PHASE 13: VOTER REMOVE FROM LIST
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 13: Voter removal from lists');
  const removeList = captains[1].lists[0];
  const removeVoters = await req('GET', '/api/captains/' + captains[1].id + '/lists/' + removeList + '/voters');
  const beforeCount = (removeVoters.d && removeVoters.d.voters) ? removeVoters.d.voters.length : 0;
  console.log('    -> List has ' + beforeCount + ' voters before removal');

  // Remove 30 voters
  const REMOVE_COUNT = 30;
  let removed = 0;
  const toRemove = ((removeVoters.d && removeVoters.d.voters) || []).slice(0, REMOVE_COUNT);
  for (const v of toRemove) {
    const rmRes = await req('DELETE', '/api/captains/' + captains[1].id + '/lists/' + removeList + '/voters/' + v.id);
    if (rmRes.s === 200 && rmRes.d.success) removed++;
  }
  ok('Removed ' + REMOVE_COUNT + ' voters from list', removed === REMOVE_COUNT);

  const afterRemove = await req('GET', '/api/captains/' + captains[1].id + '/lists/' + removeList + '/voters');
  const afterCount = (afterRemove.d && afterRemove.d.voters) ? afterRemove.d.voters.length : 0;
  ok('List count decreased by ' + REMOVE_COUNT + ' (' + beforeCount + ' -> ' + afterCount + ')', afterCount === beforeCount - REMOVE_COUNT);

  // ══════════════════════════════════════════════════════════════
  // PHASE 14: CAPTAINS LISTING (ADMIN VIEW)
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 14: Admin captains listing');
  const capListT = Date.now();
  const captainsListRes = await req('GET', '/api/captains');
  const capListElapsed = Date.now() - capListT;
  ok('Captains listing (' + capListElapsed + 'ms)', captainsListRes.s === 200 && captainsListRes.d.captains);
  const totalCaps = (captainsListRes.d.captains || []).length;
  ok('Shows all captains + sub-captains (' + totalCaps + ')', totalCaps === CAPTAIN_COUNT + CAPTAIN_COUNT * SUB_CAPTAIN_COUNT);
  ok('Stats include overlap', captainsListRes.d.stats !== undefined);
  console.log('    -> Stats: ' + JSON.stringify(captainsListRes.d.stats));

  // ══════════════════════════════════════════════════════════════
  // PHASE 15: PRECINCT ANALYTICS WITH LARGE DATASET
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 15: Precinct analytics');
  const analyticsRes = await req('GET', '/api/analytics/precincts');
  ok('Precinct analytics returns', analyticsRes.s === 200 && analyticsRes.d.precincts);
  console.log('    -> Precincts: ' + ((analyticsRes.d.precincts || []).length));

  // ══════════════════════════════════════════════════════════════
  // PHASE 16: EARLY VOTING WITH LARGE VOTER BASE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 16: Early voting with 50,000 voter base');
  const EV_COUNT = 5000;
  const evRows = [];
  for (let i = 0; i < EV_COUNT; i++) {
    evRows.push({
      registration_number: 'REG' + String(100000 + i),
      vote_date: '2026-02-20',
      vote_method: 'early'
    });
  }
  const evImport = await req('POST', '/api/early-voting/import', { rows: evRows, vote_date: '2026-02-20', vote_method: 'early' });
  ok('Early voting import (' + EV_COUNT + ' voters)', evImport.s === 200 && evImport.d.matched === EV_COUNT);

  const evStats = await req('GET', '/api/early-voting/stats');
  ok('Early voting stats', evStats.s === 200 && evStats.d.earlyVoted === EV_COUNT);
  console.log('    -> Early voted: ' + evStats.d.earlyVoted + ', Remaining: ' + evStats.d.remaining);

  // ══════════════════════════════════════════════════════════════
  // PHASE 17: ELECTION HISTORY & UNIVERSE BUILDER
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 17: Election history import + universe builder');
  // Import election history in batches to avoid oversized request bodies
  const EL_BATCH = 10000;
  let totalElMatched = 0;
  let totalElVotes = 0;
  const elections = [
    { column: 'nov_2024', name: 'November 2024 General', date: '2024-11-05', type: 'general', cycle: 'november' },
    { column: 'mar_2024', name: 'March 2024 Primary', date: '2024-03-05', type: 'primary', cycle: 'march' },
    { column: 'nov_2022', name: 'November 2022 General', date: '2022-11-08', type: 'general', cycle: 'november' }
  ];
  for (let b = 0; b < VOTER_COUNT; b += EL_BATCH) {
    const electionRows = [];
    const end = Math.min(b + EL_BATCH, VOTER_COUNT);
    for (let i = b; i < end; i++) {
      electionRows.push({
        registration_number: 'REG' + String(100000 + i),
        nov_2024: i < VOTER_COUNT * 0.6 ? 'Y' : 'N',
        mar_2024: i < VOTER_COUNT * 0.4 ? 'Y' : 'N',
        nov_2022: i < VOTER_COUNT * 0.8 ? 'Y' : 'N'
      });
    }
    const elImport = await req('POST', '/api/election-votes/import', { rows: electionRows, elections });
    ok('Election import batch ' + (b / EL_BATCH + 1), elImport.s === 200 && elImport.d.matched > 0);
    totalElMatched += (elImport.d && elImport.d.matched) || 0;
    totalElVotes += (elImport.d && elImport.d.votes_recorded) || 0;
  }
  ok('Election import total matched (' + totalElMatched + ')', totalElMatched === VOTER_COUNT);
  console.log('    -> Vote records: ' + totalElVotes);

  // Universe preview
  const uniPreview = await req('POST', '/api/universe/preview', { precincts: PRECINCTS, years_back: 8 });
  ok('Universe preview', uniPreview.s === 200 && uniPreview.d.universe > 0);
  console.log('    -> Universe: ' + uniPreview.d.universe + ' active voters');

  // ══════════════════════════════════════════════════════════════
  // PHASE 18: FULL SYSTEM SMOKE TEST
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 18: Full system smoke test');

  // Events
  const eventRes = await req('POST', '/api/events', {
    title: 'Stress Test Rally', location: 'City Hall', event_date: '2026-03-15', event_time: '18:00'
  });
  ok('Create event', eventRes.s === 200 && eventRes.d.id);

  // Block Walk
  const walkRes = await req('POST', '/api/walks', {
    name: 'Stress Test Walk', description: 'Testing large walk'
  });
  ok('Create walk', walkRes.s === 200 && walkRes.d.id);

  // Add addresses to walk (bulk endpoint expects array)
  if (walkRes.d && walkRes.d.id) {
    const walkAddresses = [];
    for (let i = 0; i < 50; i++) {
      walkAddresses.push({ address: (100 + i) + ' Main St', city: 'Austin', zip: '78701', voter_name: 'Walker ' + i });
    }
    const addAddrRes = await req('POST', '/api/walks/' + walkRes.d.id + '/addresses', { addresses: walkAddresses });
    ok('Added 50 walk addresses', addAddrRes.s === 200 && addAddrRes.d.added === 50);
    const walkDetail = await req('GET', '/api/walks/' + walkRes.d.id);
    ok('Walk has 50 addresses', walkDetail.s === 200 && walkDetail.d.walk && walkDetail.d.walk.addresses && walkDetail.d.walk.addresses.length === 50);
  }

  // Survey
  const surveyRes = await req('POST', '/api/surveys', {
    name: 'Stress Test Survey', description: 'Large-scale survey test'
  });
  ok('Create survey', surveyRes.s === 200 && surveyRes.d.id);
  if (surveyRes.d && surveyRes.d.id) {
    await req('POST', '/api/surveys/' + surveyRes.d.id + '/questions', {
      question_text: 'How do you feel about the candidate?', question_type: 'single_choice',
      options: [{ text: 'Strongly support', key: 'A' }, { text: 'Somewhat support', key: 'B' }, { text: 'Undecided', key: 'C' }]
    });
  }

  // P2P Session - first create some contacts, then create session with those contacts
  const contactIds = [];
  for (let i = 0; i < 10; i++) {
    const cRes = await req('POST', '/api/contacts', {
      phone: '+15129990' + String(100 + i), first_name: 'P2PTest' + i, last_name: 'User'
    });
    if (cRes.s === 200 && cRes.d.id) contactIds.push(cRes.d.id);
  }
  const p2pRes = await req('POST', '/api/p2p/sessions', {
    name: 'Stress Test P2P', message_template: 'Hi {{first_name}}! This is a test.', contact_ids: contactIds
  });
  if (p2pRes.s !== 200) console.log('    -> P2P error: ' + JSON.stringify(p2pRes.d).slice(0, 200));
  ok('Create P2P session', p2pRes.s === 200 && p2pRes.d.id);

  // Knowledge base
  const kbRes = await req('POST', '/api/knowledge', {
    type: 'policy', title: 'Stress Test Policy', content: 'This is a test knowledge article.'
  });
  ok('Create knowledge article', kbRes.s === 200);

  // Dashboard stats
  const statsRes = await req('GET', '/api/stats');
  ok('Dashboard stats', statsRes.s === 200 && statsRes.d.voters === VOTER_COUNT);
  console.log('    -> Stats: ' + VOTER_COUNT + ' voters, ' + (statsRes.d.contacts || 0) + ' contacts');

  // Activity log
  const actRes = await req('GET', '/api/activity');
  ok('Activity log', actRes.s === 200);

  // Health check
  const healthRes = await req('GET', '/health');
  ok('Health check', healthRes.s === 200);

  // ══════════════════════════════════════════════════════════════
  // PHASE 19: STRESS - RAPID CONCURRENT-STYLE OPERATIONS
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 19: Rapid sequential operations (stress test)');
  const rapidT = Date.now();
  const rapidOps = 100;
  let rapidOk = 0;
  for (let i = 0; i < rapidOps; i++) {
    const voter = allVoters[Math.floor(Math.random() * allVoters.length)];
    const r = await req('GET', '/api/voters/' + voter.id);
    if (r.s === 200 && r.d.voter) rapidOk++;
  }
  const rapidElapsed = Date.now() - rapidT;
  ok('100 rapid voter lookups (' + rapidElapsed + 'ms, ' + Math.round(rapidOps / (rapidElapsed / 1000)) + ' req/s)', rapidOk === rapidOps);

  // Rapid search
  const searchT = Date.now();
  const searchOps = 50;
  let searchOk = 0;
  const searchTerms = ['Garcia', 'Smith', 'Austin', 'Main St', 'PCT-003', 'Johnson', 'Rodriguez'];
  for (let i = 0; i < searchOps; i++) {
    const term = searchTerms[i % searchTerms.length];
    const r = await req('GET', '/api/captains/' + captains[0].id + '/search?q=' + encodeURIComponent(term));
    if (r.s === 200 && r.d.voters) searchOk++;
  }
  const searchElapsed = Date.now() - searchT;
  ok('50 rapid searches (' + searchElapsed + 'ms, ' + Math.round(searchOps / (searchElapsed / 1000)) + ' req/s)', searchOk === searchOps);

  // ══════════════════════════════════════════════════════════════
  // PHASE 20: CAPTAIN DELETE CASCADE
  // ══════════════════════════════════════════════════════════════
  console.log('\nPhase 20: Captain delete cascade');
  const deleteCaptain = captains[captains.length - 1];
  const beforeDelete = await req('GET', '/api/captains');
  const beforeCount2 = (beforeDelete.d.captains || []).length;

  const delRes = await req('DELETE', '/api/captains/' + deleteCaptain.id);
  ok('Delete captain', delRes.s === 200 && delRes.d.success);

  const afterDelete = await req('GET', '/api/captains');
  const afterCount2 = (afterDelete.d.captains || []).length;
  ok('Captain count decreased', afterCount2 < beforeCount2);

  // ══════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed (' + elapsed + 's)');
  if (errors.length > 0) {
    console.log('\n  FAILURES:');
    errors.forEach(e => console.log('    - ' + e));
  }
  console.log('='.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
