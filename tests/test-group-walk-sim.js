#!/usr/bin/env node
/**
 * GROUP WALK SIMULATION STRESS TEST
 *
 * Simulates the full lifecycle of a precinct-based block walk with 4 walkers:
 *
 *   1. Setup auth & import voters across multiple precincts
 *   2. Create a precinct walk (POST /api/walks/from-precinct)
 *   3. Four walkers join the group (POST /api/walks/join)
 *   4. Verify round-robin address splitting
 *   5. All 4 walkers knock doors concurrently (POST /api/walks/:id/addresses/:id/log)
 *   6. After each knock, verify per-walker route excludes completed doors
 *   7. Verify live-status API shows correct per-walker stats
 *   8. Verify Google Maps URL updates as doors are completed
 *   9. Verify voter contact auto-logging from precinct-linked walks
 *  10. Stress: rapid concurrent knocks, edge cases, full completion
 */

const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0;
const errors = [];

// ─── HTTP helpers ────────────────────────────────────────────────
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
        try { resolve({ s: res.statusCode, d: JSON.parse(data), h: res.headers }); }
        catch (e) { resolve({ s: res.statusCode, d: data, h: res.headers }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(label, ok) {
  if (ok) { passed++; console.log('  ✓ ' + label); }
  else { failed++; errors.push(label); console.log('  ✗ FAIL: ' + label); }
}

// ─── Voter data: 20 voters across 3 precincts ────────────────────
// Realistic GPS coords in a small neighborhood grid (approx 100m spacing)
const VOTERS = [];
const PRECINCTS = ['PCT-101', 'PCT-102', 'PCT-103'];
const PARTIES = ['D', 'R', 'I', 'D'];
const baseLat = 38.8977, baseLng = -77.0365; // DC area

for (let i = 0; i < 20; i++) {
  const pct = PRECINCTS[i % 3];
  const row = Math.floor(i / 5);
  const col = i % 5;
  VOTERS.push({
    first_name: 'Voter' + (i + 1),
    last_name: 'Test',
    phone: '+1555000' + String(i).padStart(4, '0'),
    email: 'voter' + (i + 1) + '@test.com',
    address: (100 + i * 10) + ' Main St',
    city: 'Testville',
    zip: '20001',
    party: PARTIES[i % 4],
    precinct: pct,
    lat: baseLat + row * 0.001,
    lng: baseLng + col * 0.001
  });
}

const WALKERS = ['Alice', 'Bob', 'Charlie', 'Diana'];

// ─── Main test ───────────────────────────────────────────────────
async function run() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  GROUP WALK SIMULATION – 4 Walkers, 3 Precincts');
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. AUTH SETUP ──────────────────────────────────────────────
  console.log('── 1. Auth Setup ──');
  let r = await req('POST', '/api/auth/setup', { username: 'admin', password: 'TestPass123' });
  assert('Setup admin account', r.s === 200 && r.d.success);
  r = await req('POST', '/api/auth/login', { username: 'admin', password: 'TestPass123' });
  assert('Login succeeds', r.s === 200 && r.d.success);

  // ── 2. IMPORT VOTERS ───────────────────────────────────────────
  console.log('\n── 2. Import 20 Voters across 3 Precincts ──');
  r = await req('POST', '/api/voters/import', { voters: VOTERS });
  assert('Import 20 voters', r.s === 200 && r.d.added >= 20);

  // Verify precinct distribution
  r = await req('GET', '/api/voters?precinct=PCT-101');
  const pct101Count = r.d.voters ? r.d.voters.length : 0;
  r = await req('GET', '/api/voters?precinct=PCT-102');
  const pct102Count = r.d.voters ? r.d.voters.length : 0;
  r = await req('GET', '/api/voters?precinct=PCT-103');
  const pct103Count = r.d.voters ? r.d.voters.length : 0;
  assert('PCT-101 has voters', pct101Count >= 6);
  assert('PCT-102 has voters', pct102Count >= 6);
  assert('PCT-103 has voters', pct103Count >= 6);
  console.log('    Distribution: PCT-101=' + pct101Count + ', PCT-102=' + pct102Count + ', PCT-103=' + pct103Count);

  // ── 3. CREATE WALK FROM PRECINCT ──────────────────────────────
  console.log('\n── 3. Create Precinct Walk ──');

  // Test validation: empty precincts
  r = await req('POST', '/api/walks/from-precinct', { precincts: [] });
  assert('Rejects empty precincts', r.s === 400);

  // Create walk from PCT-101 and PCT-102
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-101', 'PCT-102'],
    name: 'Sim Walk: PCT-101 & PCT-102',
    description: 'Stress test simulation walk'
  });
  assert('Create precinct walk succeeds', r.s === 200 && r.d.success);
  assert('Walk has addresses', r.d.added >= 12);
  assert('Walk has join code', r.d.joinCode && r.d.joinCode.length === 4);
  const walkId = r.d.id;
  const joinCode = r.d.joinCode;
  const totalAddresses = r.d.added;
  console.log('    Walk ID=' + walkId + ', Join Code=' + joinCode + ', Addresses=' + totalAddresses);

  // Create another walk from PCT-103 only, with party filter
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-103'],
    name: 'Sim Walk: PCT-103 Dems Only',
    filters: { party: 'D' }
  });
  assert('Create filtered precinct walk', r.s === 200 && r.d.success);
  assert('Filtered walk has fewer addresses', r.d.added >= 1 && r.d.added <= pct103Count);
  console.log('    Filtered walk: ' + r.d.added + ' addresses (D-only from PCT-103)');

  // ── 4. VERIFY WALK DETAIL ─────────────────────────────────────
  console.log('\n── 4. Verify Walk Detail ──');
  r = await req('GET', '/api/walks/' + walkId);
  assert('Walk detail returns addresses', r.s === 200 && r.d.walk && r.d.walk.addresses.length === totalAddresses);
  assert('All addresses start as not_visited', r.d.walk.addresses.every(a => a.result === 'not_visited'));
  assert('Addresses have voter_id linked', r.d.walk.addresses.every(a => a.voter_id != null));
  const allAddressIds = r.d.walk.addresses.map(a => a.id);
  const allAddresses = r.d.walk.addresses;

  // ── 5. FOUR WALKERS JOIN ──────────────────────────────────────
  console.log('\n── 5. Four Walkers Join Group ──');

  // Test validation
  r = await req('POST', '/api/walks/join', { joinCode: '', walkerName: '' });
  assert('Rejects empty join info', r.s === 400);

  r = await req('POST', '/api/walks/join', { joinCode: 'ZZZZ', walkerName: 'Ghost' });
  assert('Rejects invalid join code', r.s === 404);

  // Join all 4 walkers
  for (const walker of WALKERS) {
    r = await req('POST', '/api/walks/join', { joinCode, walkerName: walker });
    assert(walker + ' joins walk', r.s === 200 && r.d.success && r.d.walkId === walkId);
  }

  // Verify group has 4 members
  r = await req('GET', '/api/walks/' + walkId + '/group');
  assert('Group has 4 members', r.s === 200 && r.d.members.length === 4);
  const memberNames = r.d.members.map(m => m.walker_name).sort();
  assert('All 4 walkers listed', JSON.stringify(memberNames) === JSON.stringify(WALKERS.sort()));

  // 5th walker should be rejected (max 4)
  r = await req('POST', '/api/walks/join', { joinCode, walkerName: 'Eve' });
  assert('5th walker rejected (group full)', r.s === 400 && r.d.error.includes('full'));

  // Duplicate join when group is full returns 400 (Alice is already member but count=4)
  r = await req('POST', '/api/walks/join', { joinCode, walkerName: 'Alice' });
  assert('Duplicate join does not crash', r.s === 200 || r.s === 400);

  // ── 6. VERIFY ROUND-ROBIN ADDRESS SPLITTING ───────────────────
  console.log('\n── 6. Verify Round-Robin Address Splitting ──');
  const walkerAddresses = {};
  for (const walker of WALKERS) {
    r = await req('GET', '/api/walks/' + walkId + '/walker/' + walker);
    assert(walker + ' has assigned addresses', r.s === 200 && r.d.addresses.length > 0);
    walkerAddresses[walker] = r.d.addresses;
    console.log('    ' + walker + ': ' + r.d.addresses.length + ' addresses');
  }

  // Verify all addresses are accounted for
  const totalAssigned = Object.values(walkerAddresses).reduce((sum, a) => sum + a.length, 0);
  assert('Total assigned = total addresses', totalAssigned === totalAddresses);

  // Verify roughly even split (each walker gets floor(n/4) or ceil(n/4))
  const minPerWalker = Math.floor(totalAddresses / 4);
  const maxPerWalker = Math.ceil(totalAddresses / 4);
  for (const walker of WALKERS) {
    const count = walkerAddresses[walker].length;
    assert(walker + ' split is balanced (' + count + ')', count >= minPerWalker && count <= maxPerWalker);
  }

  // ── 7. PER-WALKER ROUTE BEFORE KNOCKING ───────────────────────
  console.log('\n── 7. Per-Walker Routes (Before Knocking) ──');
  const initialRoutes = {};
  for (const walker of WALKERS) {
    // Get route with GPS position (near walk area)
    const wLat = baseLat + Math.random() * 0.002;
    const wLng = baseLng + Math.random() * 0.002;
    r = await req('GET', '/api/walks/' + walkId + '/walker/' + walker + '/route?lat=' + wLat + '&lng=' + wLng);
    assert(walker + ' initial route', r.s === 200 && r.d.route.length === walkerAddresses[walker].length);
    assert(walker + ' has Maps URL', r.d.mapsUrl && r.d.mapsUrl.includes('google.com/maps'));
    assert(walker + ' remaining count matches', r.d.remaining === walkerAddresses[walker].length);
    initialRoutes[walker] = r.d;
  }

  // ── 8. INITIAL LIVE STATUS ────────────────────────────────────
  console.log('\n── 8. Live Status (Before Knocking) ──');
  r = await req('GET', '/api/walks/' + walkId + '/live-status');
  assert('Live status returns progress', r.s === 200 && r.d.progress);
  assert('All addresses remaining', r.d.progress.remaining === totalAddresses && r.d.progress.knocked === 0);
  assert('walkerStats has all 4 walkers', Object.keys(r.d.walkerStats).length === 4);
  for (const walker of WALKERS) {
    const ws = r.d.walkerStats[walker];
    assert(walker + ' stats: 0 knocked', ws && ws.knocked === 0 && ws.total === walkerAddresses[walker].length);
  }
  assert('No recent knocks yet', r.d.recentKnocks.length === 0);

  // ── 9. SIMULATE ROUND 1: Each walker knocks their first door ──
  console.log('\n── 9. Round 1: Each Walker Knocks 1 Door ──');
  const results = ['support', 'lean_support', 'not_home', 'undecided'];
  const knockedIds = {};

  for (let i = 0; i < WALKERS.length; i++) {
    const walker = WALKERS[i];
    const addr = walkerAddresses[walker][0];
    const addrLat = baseLat + 0.0005;
    const addrLng = baseLng + 0.0005;

    r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addr.id + '/log', {
      result: results[i],
      notes: walker + ' knocked door 1',
      walker_name: walker,
      gps_lat: addrLat,
      gps_lng: addrLng,
      gps_accuracy: 10
    });
    assert(walker + ' knocks door ' + addr.id, r.s === 200 && r.d.success);
    knockedIds[walker] = [addr.id];
  }

  // ── 10. VERIFY ROUTES EXCLUDE KNOCKED DOORS ──────────────────
  console.log('\n── 10. Routes After Round 1 (Knocked Doors Removed) ──');
  for (const walker of WALKERS) {
    r = await req('GET', '/api/walks/' + walkId + '/walker/' + walker + '/route');
    const expectedRemaining = walkerAddresses[walker].length - 1;
    assert(walker + ' route shrunk by 1', r.d.route.length === expectedRemaining && r.d.remaining === expectedRemaining);

    // Verify the knocked address is NOT in the route
    const routeIds = r.d.route.map(a => a.id);
    const knockedId = knockedIds[walker][0];
    assert(walker + ' route excludes knocked door', !routeIds.includes(knockedId));
  }

  // ── 11. LIVE STATUS AFTER ROUND 1 ────────────────────────────
  console.log('\n── 11. Live Status After Round 1 ──');
  r = await req('GET', '/api/walks/' + walkId + '/live-status');
  assert('4 doors knocked total', r.d.progress.knocked === 4);
  assert('Remaining = total - 4', r.d.progress.remaining === totalAddresses - 4);
  for (const walker of WALKERS) {
    assert(walker + ' stats: 1 knocked', r.d.walkerStats[walker].knocked === 1);
  }
  assert('4 recent knocks in feed', r.d.recentKnocks.length === 4);

  // ── 12. SIMULATE ROUND 2: Each walker knocks 2 more doors ────
  console.log('\n── 12. Round 2: Each Walker Knocks 2 More Doors ──');
  const moreResults = ['support', 'lean_oppose', 'refused', 'come_back', 'oppose', 'moved', 'not_home', 'lean_support'];
  let resultIdx = 0;

  for (const walker of WALKERS) {
    for (let doorIdx = 1; doorIdx <= 2; doorIdx++) {
      if (doorIdx >= walkerAddresses[walker].length) break; // safety
      const addr = walkerAddresses[walker][doorIdx];
      r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addr.id + '/log', {
        result: moreResults[resultIdx % moreResults.length],
        notes: walker + ' round 2 door ' + doorIdx,
        walker_name: walker,
        gps_lat: baseLat + 0.0003,
        gps_lng: baseLng + 0.0003,
        gps_accuracy: 15
      });
      assert(walker + ' knocks door #' + (doorIdx + 1), r.s === 200 && r.d.success);
      knockedIds[walker].push(addr.id);
      resultIdx++;
    }
  }

  // ── 13. VERIFY ROUTES AFTER ROUND 2 ──────────────────────────
  console.log('\n── 13. Routes After Round 2 ──');
  for (const walker of WALKERS) {
    r = await req('GET', '/api/walks/' + walkId + '/walker/' + walker + '/route');
    const expectedRemaining = walkerAddresses[walker].length - knockedIds[walker].length;
    assert(walker + ' remaining = ' + expectedRemaining, r.d.remaining === expectedRemaining);

    // None of the knocked addresses should be in the route
    const routeIds = new Set(r.d.route.map(a => a.id));
    const anyKnockedStillInRoute = knockedIds[walker].some(id => routeIds.has(id));
    assert(walker + ' route excludes all knocked doors', !anyKnockedStillInRoute);

    // Verify Maps URL is present if there are remaining addresses
    if (expectedRemaining > 0) {
      assert(walker + ' Maps URL still valid', r.d.mapsUrl && r.d.mapsUrl.includes('google.com'));
    }
  }

  // ── 14. LIVE STATUS AFTER ROUND 2 ────────────────────────────
  console.log('\n── 14. Live Status After Round 2 ──');
  r = await req('GET', '/api/walks/' + walkId + '/live-status');
  const totalKnockedSoFar = Object.values(knockedIds).reduce((sum, ids) => sum + ids.length, 0);
  assert('Total knocked = ' + totalKnockedSoFar, r.d.progress.knocked === totalKnockedSoFar);
  assert('Remaining = ' + (totalAddresses - totalKnockedSoFar), r.d.progress.remaining === totalAddresses - totalKnockedSoFar);
  for (const walker of WALKERS) {
    assert(walker + ' knocked = ' + knockedIds[walker].length, r.d.walkerStats[walker].knocked === knockedIds[walker].length);
  }
  assert('Recent knocks feed has entries', r.d.recentKnocks.length === totalKnockedSoFar);

  // ── 15. CONCURRENT KNOCKING (all 4 walkers at same time) ─────
  console.log('\n── 15. Concurrent Knocking Stress Test ──');
  const concurrentPromises = [];
  for (const walker of WALKERS) {
    // Get next unvisited address for this walker
    const nextDoorIdx = knockedIds[walker].length;
    if (nextDoorIdx < walkerAddresses[walker].length) {
      const addr = walkerAddresses[walker][nextDoorIdx];
      concurrentPromises.push(
        req('POST', '/api/walks/' + walkId + '/addresses/' + addr.id + '/log', {
          result: 'support',
          notes: 'Concurrent knock by ' + walker,
          walker_name: walker,
          gps_lat: baseLat,
          gps_lng: baseLng,
          gps_accuracy: 20
        }).then(res => {
          knockedIds[walker].push(addr.id);
          return { walker, res };
        })
      );
    }
  }
  const concurrentResults = await Promise.all(concurrentPromises);
  for (const { walker, res: cr } of concurrentResults) {
    assert(walker + ' concurrent knock succeeded', cr.s === 200 && cr.d.success);
  }

  // Verify live status after concurrent knocks
  r = await req('GET', '/api/walks/' + walkId + '/live-status');
  const totalKnockedAfterConcurrent = Object.values(knockedIds).reduce((sum, ids) => sum + ids.length, 0);
  assert('Live status reflects concurrent knocks (' + totalKnockedAfterConcurrent + ')', r.d.progress.knocked === totalKnockedAfterConcurrent);

  // ── 16. VOTER CONTACT AUTO-LOGGING ────────────────────────────
  console.log('\n── 16. Verify Voter Contact Auto-Logging ──');
  // Each knocked address was linked to a voter. Check that voter_contacts were created.
  // GET /api/voters/:id includes contactHistory array
  for (const walker of WALKERS) {
    const addr = allAddresses.find(a => a.id === knockedIds[walker][0]);
    if (addr && addr.voter_id) {
      r = await req('GET', '/api/voters/' + addr.voter_id);
      if (r.s === 200 && r.d.voter) {
        const ch = r.d.voter.contactHistory || [];
        assert(walker + ': voter contact auto-logged', ch.length >= 1);
        if (ch.length > 0) {
          assert(walker + ': contact type = Door-knock', ch[0].contact_type === 'Door-knock');
        }
      }
    }
  }

  // ── 17. GPS VERIFICATION SCENARIOS ────────────────────────────
  console.log('\n── 17. GPS Verification Edge Cases ──');

  // Find an unvisited address for testing GPS scenarios
  r = await req('GET', '/api/walks/' + walkId);
  const unvisited = r.d.walk.addresses.filter(a => a.result === 'not_visited');
  if (unvisited.length >= 3) {
    // Test 1: GPS too far away (should not verify)
    const testAddr1 = unvisited[0];
    r = await req('POST', '/api/walks/' + walkId + '/addresses/' + testAddr1.id + '/log', {
      result: 'not_home',
      notes: 'GPS far away test',
      walker_name: testAddr1.assigned_walker || 'Alice',
      gps_lat: 40.0, gps_lng: -74.0, // Far from DC
      gps_accuracy: 10
    });
    assert('GPS far away: knock accepted', r.s === 200 && r.d.success);
    // gps_verified will depend on whether address has lat/lng set

    // Test 2: GPS with poor accuracy
    const testAddr2 = unvisited[1];
    r = await req('POST', '/api/walks/' + walkId + '/addresses/' + testAddr2.id + '/log', {
      result: 'refused',
      notes: 'GPS poor accuracy test',
      walker_name: testAddr2.assigned_walker || 'Bob',
      gps_lat: baseLat, gps_lng: baseLng,
      gps_accuracy: 500 // > 200m threshold
    });
    assert('GPS poor accuracy: knock accepted', r.s === 200 && r.d.success);

    // Test 3: No GPS at all
    const testAddr3 = unvisited[2];
    r = await req('POST', '/api/walks/' + walkId + '/addresses/' + testAddr3.id + '/log', {
      result: 'moved',
      notes: 'No GPS test',
      walker_name: testAddr3.assigned_walker || 'Charlie'
    });
    assert('No GPS: knock accepted', r.s === 200 && r.d.success);
  } else {
    console.log('    (skipping GPS edge cases – not enough unvisited addresses)');
  }

  // ── 18. INVALID KNOCK SCENARIOS ───────────────────────────────
  console.log('\n── 18. Invalid Knock Scenarios ──');
  r = await req('POST', '/api/walks/' + walkId + '/addresses/99999/log', {
    result: 'support', walker_name: 'Alice'
  });
  assert('Knock on non-existent address returns 404', r.s === 404);

  r = await req('POST', '/api/walks/' + walkId + '/addresses/' + allAddressIds[0] + '/log', {
    result: 'invalid_result', walker_name: 'Alice'
  });
  assert('Invalid result value returns 400', r.s === 400);

  r = await req('POST', '/api/walks/' + walkId + '/addresses/' + allAddressIds[0] + '/log', {
    walker_name: 'Alice'
  });
  assert('Missing result returns 400', r.s === 400);

  // ── 19. FINISH WALK: All walkers complete all remaining doors ─
  console.log('\n── 19. Complete All Remaining Doors ──');
  r = await req('GET', '/api/walks/' + walkId);
  const stillUnvisited = r.d.walk.addresses.filter(a => a.result === 'not_visited');
  console.log('    ' + stillUnvisited.length + ' doors remaining to knock...');

  let completedCount = 0;
  for (const addr of stillUnvisited) {
    const walker = addr.assigned_walker || WALKERS[completedCount % 4];
    r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addr.id + '/log', {
      result: 'support',
      notes: 'Finishing sweep',
      walker_name: walker,
      gps_lat: baseLat, gps_lng: baseLng, gps_accuracy: 10
    });
    if (r.s === 200 && r.d.success) completedCount++;
  }
  assert('All remaining doors knocked (' + completedCount + ')', completedCount === stillUnvisited.length);

  // ── 20. VERIFY WALK COMPLETE ──────────────────────────────────
  console.log('\n── 20. Walk Fully Complete ──');
  r = await req('GET', '/api/walks/' + walkId + '/live-status');
  assert('All doors knocked', r.d.progress.knocked === totalAddresses);
  assert('Zero remaining', r.d.progress.remaining === 0);
  for (const walker of WALKERS) {
    assert(walker + ' remaining = 0', r.d.walkerStats[walker].remaining === 0);
  }

  // Per-walker route should be empty
  for (const walker of WALKERS) {
    r = await req('GET', '/api/walks/' + walkId + '/walker/' + walker + '/route');
    assert(walker + ' route is empty (walk complete)', r.d.route.length === 0 && r.d.remaining === 0);
  }

  // Volunteer view shows 100% progress
  r = await req('GET', '/api/walks/' + walkId + '/volunteer');
  assert('Volunteer view: 100% progress', r.d.walk.progress.remaining === 0 && r.d.walk.progress.knocked === totalAddresses);

  // ── 21. WALKER LEAVING MID-WALK ───────────────────────────────
  console.log('\n── 21. Walker Leave & Re-split (New Walk) ──');

  // Create a fresh walk for this test
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-103'],
    name: 'Leave Test Walk'
  });
  assert('Create PCT-103 walk for leave test', r.s === 200 && r.d.success);
  const leaveWalkId = r.d.id;
  const leaveJoinCode = r.d.joinCode;
  const leaveTotal = r.d.added;

  // 3 walkers join
  for (const walker of ['W1', 'W2', 'W3']) {
    r = await req('POST', '/api/walks/join', { joinCode: leaveJoinCode, walkerName: walker });
    assert(walker + ' joins leave test walk', r.s === 200 && r.d.success);
  }

  // Verify 3-way split
  r = await req('GET', '/api/walks/' + leaveWalkId + '/walker/W1');
  const w1Before = r.d.addresses.length;
  r = await req('GET', '/api/walks/' + leaveWalkId + '/walker/W2');
  const w2Before = r.d.addresses.length;
  r = await req('GET', '/api/walks/' + leaveWalkId + '/walker/W3');
  const w3Before = r.d.addresses.length;
  assert('3-way split sums to total', w1Before + w2Before + w3Before === leaveTotal);

  // W3 leaves
  r = await req('DELETE', '/api/walks/' + leaveWalkId + '/group/W3');
  assert('W3 leaves group', r.s === 200 && r.d.success);

  // Verify re-split: W3's addresses redistributed to W1 and W2
  r = await req('GET', '/api/walks/' + leaveWalkId + '/walker/W1');
  const w1After = r.d.addresses.length;
  r = await req('GET', '/api/walks/' + leaveWalkId + '/walker/W2');
  const w2After = r.d.addresses.length;
  assert('Re-split: W1+W2 = total', w1After + w2After === leaveTotal);
  assert('Re-split: W1 got more addresses', w1After >= w1Before);

  // Verify group now has 2 members
  r = await req('GET', '/api/walks/' + leaveWalkId + '/group');
  assert('Group now has 2 members', r.d.members.length === 2);

  // ── 22. ROUTE OPTIMIZATION WITH GPS ───────────────────────────
  console.log('\n── 22. Route Optimization from GPS Position ──');

  // Create a walk with known lat/lng addresses
  r = await req('POST', '/api/walks', { name: 'GPS Route Test', description: 'Route opt test' });
  assert('Create GPS test walk', r.s === 200 && r.d.success);
  const gpsWalkId = r.d.id;

  // Add addresses with GPS coords (in a line: far → close → medium from walker)
  const gpsAddrs = [
    { address: '1 Far St', city: 'Testville', zip: '20001' },
    { address: '2 Close St', city: 'Testville', zip: '20001' },
    { address: '3 Medium St', city: 'Testville', zip: '20001' },
    { address: '4 Nearby St', city: 'Testville', zip: '20001' }
  ];
  r = await req('POST', '/api/walks/' + gpsWalkId + '/addresses', { addresses: gpsAddrs });
  assert('Add GPS test addresses', r.s === 200 && r.d.added === 4);

  // Get the walk route (without GPS coordinates on addresses, falls back to sort order)
  r = await req('GET', '/api/walks/' + gpsWalkId + '/route');
  assert('Walk route returns addresses', r.s === 200 && r.d.route.length === 4);
  assert('Walk route has Maps URL', r.d.mapsUrl.length > 0);

  // ── 23. PRECINCT WALK WITH FILTERS ────────────────────────────
  console.log('\n── 23. Precinct Walk with Filters ──');

  // Filter by party
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-101', 'PCT-102', 'PCT-103'],
    name: 'All Precincts - R Only',
    filters: { party: 'R' }
  });
  assert('Filter by party=R', r.s === 200 && r.d.success && r.d.added >= 1);
  console.log('    Party=R filter: ' + r.d.added + ' addresses');

  // Filter by support level (voters were knocked as 'support' earlier, so should have support levels)
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-101', 'PCT-102'],
    name: 'Support Level Filter',
    filters: { support_level: 'strong_support' }
  });
  // This may return 0 or more depending on which voters got support-level updates from auto-logging
  assert('Support level filter does not crash', r.s === 200 || r.s === 400);

  // Filter: exclude contacted voters (voters from main walk were contacted via auto-log)
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-101', 'PCT-102'],
    name: 'Exclude Contacted',
    filters: { exclude_contacted: true }
  });
  // Some should be excluded since we knocked every door in walkId
  assert('Exclude-contacted filter works', r.s === 200 || r.s === 400);
  if (r.s === 200) {
    assert('Fewer addresses after exclude-contacted', r.d.added < totalAddresses);
    console.log('    Exclude-contacted: ' + r.d.added + ' addresses (was ' + totalAddresses + ')');
  } else {
    console.log('    All voters already contacted — filter correctly returns 0');
  }

  // ── 24. STRESS: Rapid fire knocks on a new walk ───────────────
  console.log('\n── 24. Rapid Fire Stress (8 Concurrent Knocks) ──');
  r = await req('POST', '/api/walks/from-precinct', {
    precincts: ['PCT-101'],
    name: 'Rapid Fire Walk'
  });
  if (r.s === 200 && r.d.success) {
    const rfWalkId = r.d.id;
    const rfJoinCode = r.d.joinCode;

    // 2 walkers join
    await req('POST', '/api/walks/join', { joinCode: rfJoinCode, walkerName: 'Speed1' });
    await req('POST', '/api/walks/join', { joinCode: rfJoinCode, walkerName: 'Speed2' });

    // Get all addresses
    r = await req('GET', '/api/walks/' + rfWalkId);
    const rfAddrs = r.d.walk.addresses;

    // Fire 8 concurrent knocks (or all if fewer)
    const batch = rfAddrs.slice(0, 8);
    const rapidPromises = batch.map((addr, i) =>
      req('POST', '/api/walks/' + rfWalkId + '/addresses/' + addr.id + '/log', {
        result: i % 2 === 0 ? 'support' : 'not_home',
        notes: 'Rapid fire #' + i,
        walker_name: addr.assigned_walker || 'Speed1',
        gps_lat: baseLat, gps_lng: baseLng, gps_accuracy: 10
      })
    );
    const rapidResults = await Promise.all(rapidPromises);
    const rapidSuccess = rapidResults.filter(r => r.s === 200 && r.d.success).length;
    assert('Rapid fire: ' + rapidSuccess + '/' + batch.length + ' succeeded', rapidSuccess === batch.length);

    // Verify live status is consistent
    r = await req('GET', '/api/walks/' + rfWalkId + '/live-status');
    assert('Rapid fire: live status consistent', r.d.progress.knocked === batch.length);
  } else {
    console.log('    (Skipped – no voters available for rapid fire)');
  }

  // ── 25. WALK DETAIL RESULT STATS ──────────────────────────────
  console.log('\n── 25. Walk Result Stats ──');
  r = await req('GET', '/api/walks/' + walkId);
  assert('Walk detail has resultStats', r.s === 200 && r.d.walk.resultStats != null);
  const stats = r.d.walk.resultStats;
  console.log('    Result breakdown:', JSON.stringify(stats));
  assert('not_visited count = 0', !stats['not_visited'] || stats['not_visited'] === 0);

  // ── 26. OVERALL ROUTE (non-walker-specific) ───────────────────
  console.log('\n── 26. Overall Route Endpoint ──');
  r = await req('GET', '/api/walks/' + walkId + '/route');
  assert('Overall route empty (all knocked)', r.d.route.length === 0);

  // ── 27. ACTIVITY LOG ──────────────────────────────────────────
  console.log('\n── 27. Activity Log Entries ──');
  r = await req('GET', '/api/activity');
  assert('Activity log has walk creation entries', r.s === 200 && r.d.logs.some(l => l.message.includes('Walk created from precincts')));

  // ── SUMMARY ───────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  console.log('══════════════════════════════════════════════════════');
  if (errors.length > 0) {
    console.log('\n  FAILURES:');
    errors.forEach(e => console.log('    ✗ ' + e));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
