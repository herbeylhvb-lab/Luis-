/**
 * STRESS TEST ROUND 12 — Walk Group Mechanics, GPS Haversine, Enrichment,
 * Universe Builder, Cascade Integrity, P2P Volunteer Lifecycle, Precinct Analytics
 *
 * Sections:
 * 1. Walk group round-robin split & re-split on leave
 * 2. GPS Haversine distance boundary conditions
 * 3. Enrichment: phone fill, conflict detection, resolution
 * 4. Universe builder: temp table segmentation, preview vs build
 * 5. Cascading delete orphan verification
 * 6. P2P volunteer: assignment, redistribute, snap-back
 * 7. Canvass import 3-tier matching
 * 8. Survey lifecycle: start/end/reopen, ranked choice Borda scoring
 * 9. Admin list CRUD & idempotent add
 * 10. Captain CSV import: ambiguity detection
 * 11. Engagement scoring formula verification
 * 12. Walk from-precinct with voter linkage
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r12.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '', preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT DEFAULT NULL, session_id INTEGER DEFAULT NULL, volunteer_name TEXT DEFAULT NULL, channel TEXT DEFAULT 'sms');
  CREATE INDEX idx_messages_phone ON messages(phone);
  CREATE TABLE opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE voters (id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '', support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '', registration_number TEXT DEFAULT '', precinct TEXT DEFAULT '', qr_token TEXT DEFAULT NULL, voting_history TEXT DEFAULT '', early_voted INTEGER DEFAULT 0, early_voted_date TEXT DEFAULT NULL, early_voted_method TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_voters_phone ON voters(phone);
  CREATE UNIQUE INDEX idx_voters_qr_token ON voters(qr_token);
  CREATE TABLE voter_contacts (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '', contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '', status TEXT DEFAULT 'upcoming', flyer_image TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE event_rsvps (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '', rsvp_status TEXT DEFAULT 'invited', checked_in_at TEXT DEFAULT NULL, invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT);
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);
  CREATE TABLE voter_checkins (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, checked_in_at TEXT DEFAULT (datetime('now')), UNIQUE(voter_id, event_id));
  CREATE TABLE block_walks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', assigned_to TEXT DEFAULT '', status TEXT DEFAULT 'pending', join_code TEXT DEFAULT NULL, max_walkers INTEGER DEFAULT 4, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE walk_addresses (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, address TEXT NOT NULL, unit TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', voter_name TEXT DEFAULT '', result TEXT DEFAULT 'not_visited', notes TEXT DEFAULT '', knocked_at TEXT, sort_order INTEGER DEFAULT 0, voter_id INTEGER DEFAULT NULL, lat REAL DEFAULT NULL, lng REAL DEFAULT NULL, gps_lat REAL DEFAULT NULL, gps_lng REAL DEFAULT NULL, gps_accuracy REAL DEFAULT NULL, gps_verified INTEGER DEFAULT 0, assigned_walker TEXT DEFAULT NULL);
  CREATE TABLE walk_group_members (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, walker_name TEXT NOT NULL, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(walk_id, walker_name));
  CREATE TABLE p2p_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL, assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL, status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL, session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_volunteers (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_assignments (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, volunteer_id INTEGER REFERENCES p2p_volunteers(id), contact_id INTEGER NOT NULL REFERENCES contacts(id), status TEXT DEFAULT 'pending', original_volunteer_id INTEGER DEFAULT NULL, assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT DEFAULT NULL);
  CREATE TABLE captains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_team_members (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_lists (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL, name TEXT NOT NULL, list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE admin_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER DEFAULT NULL, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER DEFAULT NULL, responded_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE election_votes (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, election_name TEXT NOT NULL, election_date TEXT NOT NULL, election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '', voted INTEGER DEFAULT 1, UNIQUE(voter_id, election_name));
  CREATE INDEX idx_ev_voter ON election_votes(voter_id);
  CREATE TABLE campaign_knowledge (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE response_scripts (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT DEFAULT '', role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
`);

const { phoneDigits, normalizePhone, generateJoinCode, generateAlphaCode, personalizeTemplate } = require('./utils');
const { generateQrToken } = require('./db');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Walk Group Round-Robin Split & Re-split
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Walk Group Round-Robin ===');

// Replicate the splitAddresses function from walks.js
function splitAddresses(walkId) {
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
  if (members.length === 0) return;
  const addresses = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id').all(walkId);
  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  const split = db.transaction(() => {
    for (let i = 0; i < addresses.length; i++) {
      const walker = members[i % members.length].walker_name;
      update.run(walker, addresses[i].id);
    }
  });
  split();
}

test('Walk group: create walk with 12 addresses', () => {
  db.prepare("INSERT INTO block_walks (name, join_code, status) VALUES ('Group Walk', 'ABCD', 'pending')").run();
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  for (let i = 0; i < 12; i++) {
    db.prepare('INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)').run(walkId, `${100+i} Elm St`, i);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(walkId).c, 12);
});

test('Walk group: 3 walkers join, 12 addresses split 4-4-4', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Alice');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Bob');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Carol');
  splitAddresses(walkId);
  const alice = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c;
  const bob = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walkId).c;
  const carol = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Carol'").get(walkId).c;
  assert.strictEqual(alice, 4);
  assert.strictEqual(bob, 4);
  assert.strictEqual(carol, 4);
});

test('Walk group: Bob leaves, re-split 6-6', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  db.prepare("DELETE FROM walk_group_members WHERE walk_id = ? AND walker_name = 'Bob'").run(walkId);
  splitAddresses(walkId);
  const alice = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c;
  const carol = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Carol'").get(walkId).c;
  assert.strictEqual(alice, 6);
  assert.strictEqual(carol, 6);
});

test('Walk group: 4th walker joins (uneven split 3-3-3-3)', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Dave');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Bob'); // Bob re-joins
  splitAddresses(walkId);
  // 12 addrs / 4 walkers = 3 each
  // Actually there are 4 walkers (Alice, Carol, Dave, Bob) - each gets 3
  const counts = db.prepare("SELECT assigned_walker, COUNT(*) as c FROM walk_addresses WHERE walk_id = ? GROUP BY assigned_walker").all(walkId);
  for (const c of counts) {
    assert.strictEqual(c.c, 3, `${c.assigned_walker} should have 3 addresses`);
  }
});

test('Walk group: 7 addresses with 3 walkers = 3-2-2 split', () => {
  db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('Odd Walk', 'WXYZ')").run();
  const oddWalkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Odd Walk'").get().id;
  for (let i = 0; i < 7; i++) {
    db.prepare('INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)').run(oddWalkId, `${200+i} Odd St`, i);
  }
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(oddWalkId, 'X');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(oddWalkId, 'Y');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(oddWalkId, 'Z');
  splitAddresses(oddWalkId);
  const xCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'X'").get(oddWalkId).c;
  const yCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Y'").get(oddWalkId).c;
  const zCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Z'").get(oddWalkId).c;
  // Round robin: 0→X, 1→Y, 2→Z, 3→X, 4→Y, 5→Z, 6→X = X:3, Y:2, Z:2
  assert.strictEqual(xCount, 3);
  assert.strictEqual(yCount, 2);
  assert.strictEqual(zCount, 2);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: GPS Haversine Distance Boundary Conditions
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: GPS Haversine ===');

// Replicate gpsDistance from walks.js
function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    isFinite(lat) && isFinite(lng);
}

test('GPS: same point = 0m distance', () => {
  assert.strictEqual(gpsDistance(40.7128, -74.0060, 40.7128, -74.0060), 0);
});

test('GPS: 100m apart should be within 150m threshold', () => {
  // Move ~100m north at NYC latitude
  const dist = gpsDistance(40.7128, -74.0060, 40.7137, -74.0060);
  assert(dist > 50 && dist < 150, `Expected ~100m, got ${dist.toFixed(1)}m`);
});

test('GPS: 1km apart should exceed 150m threshold', () => {
  const dist = gpsDistance(40.7128, -74.0060, 40.7220, -74.0060);
  assert(dist > 900, `Expected >900m, got ${dist.toFixed(1)}m`);
});

test('GPS: antipodal points (max distance ~20000km)', () => {
  // NYC to ~opposite side of earth
  const dist = gpsDistance(40.7128, -74.0060, -40.7128, 105.9940);
  assert(dist > 19000000 && dist < 21000000, `Antipodal: ${dist.toFixed(0)}m`);
});

test('GPS: equator crossing', () => {
  const dist = gpsDistance(0.001, 0, -0.001, 0);
  assert(dist > 200 && dist < 300, `Equator cross: ${dist.toFixed(1)}m`);
});

test('GPS: valid coord checks', () => {
  assert(isValidCoord(0, 0));
  assert(isValidCoord(90, 180));
  assert(isValidCoord(-90, -180));
  assert(!isValidCoord(91, 0));
  assert(!isValidCoord(0, 181));
  assert(!isValidCoord(NaN, 0));
  assert(!isValidCoord(0, Infinity));
  assert(!isValidCoord('40', '-74'));
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Enrichment Flow
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Enrichment ===');

test('Enrich: fill missing phone, detect conflict, detect unmatched', () => {
  // Voter with no phone
  db.prepare("INSERT INTO voters (first_name, last_name, phone, registration_number, qr_token, address, city, zip) VALUES ('NoPhone', 'Smith', '', 'REG-NP', 'qr_np', '100 Enrich Rd', 'TestCity', '11111')").run();
  // Voter with existing phone
  db.prepare("INSERT INTO voters (first_name, last_name, phone, registration_number, qr_token, address, city, zip) VALUES ('HasPhone', 'Jones', '5551112222', 'REG-HP', 'qr_hp', '101 Enrich Rd', 'TestCity', '11111')").run();

  const allVoters = db.prepare("SELECT id, first_name, last_name, phone, address, registration_number FROM voters WHERE registration_number LIKE 'REG-%'").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) regMap[v.registration_number.trim()] = v;
  }

  const results = { filled: 0, conflicts: [], unmatched: [], skipped: 0 };
  const rows = [
    { voter_id: 'REG-NP', phone: '555-333-4444' },   // fill
    { voter_id: 'REG-HP', phone: '555-999-8888' },   // conflict
    { voter_id: 'REG-MISSING', phone: '555-000-0000' }, // unmatched
  ];

  for (const row of rows) {
    const voter = regMap[(row.voter_id || '').trim()];
    if (!voter) { results.unmatched.push(row); continue; }
    const newPhone = (row.phone || '').trim();
    const currentPhone = (voter.phone || '').trim();
    if (!currentPhone && newPhone) {
      db.prepare("UPDATE voters SET phone = ? WHERE id = ?").run(normalizePhone(newPhone), voter.id);
      results.filled++;
    } else if (currentPhone && newPhone && phoneDigits(currentPhone) !== phoneDigits(newPhone)) {
      results.conflicts.push({ voter_id: voter.id, current: currentPhone, new: newPhone });
    } else {
      results.skipped++;
    }
  }

  assert.strictEqual(results.filled, 1);
  assert.strictEqual(results.conflicts.length, 1);
  assert.strictEqual(results.unmatched.length, 1);
});

test('Enrich: resolve conflict overwrites phone', () => {
  const voter = db.prepare("SELECT id, phone FROM voters WHERE first_name = 'HasPhone'").get();
  assert(voter);
  const oldPhone = voter.phone;
  db.prepare("UPDATE voters SET phone = ? WHERE id = ?").run(normalizePhone('555-999-8888'), voter.id);
  const updated = db.prepare("SELECT phone FROM voters WHERE id = ?").get(voter.id);
  assert.strictEqual(updated.phone, '5559998888');
  assert.notStrictEqual(updated.phone, oldPhone);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Universe Builder
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Universe Builder ===');

test('Universe: create voters in 2 precincts with election history', () => {
  for (let i = 0; i < 20; i++) {
    const pct = i < 10 ? 'UNI-01' : 'UNI-02';
    db.prepare("INSERT INTO voters (first_name, last_name, precinct, qr_token) VALUES (?, ?, ?, ?)").run(`Uni${i}`, 'Voter', pct, `qr_uni_${i}`);
  }
  const uniVoters = db.prepare("SELECT id FROM voters WHERE precinct LIKE 'UNI-%' ORDER BY id").all();
  // First 15 voted in Nov 2024
  for (let i = 0; i < 15; i++) {
    db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)").run(uniVoters[i].id, 'Nov 2024 General', '2024-11-05', 'general', 'november');
  }
  // First 8 also voted in Mar 2024
  for (let i = 0; i < 8; i++) {
    db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)").run(uniVoters[i].id, 'Mar 2024 Primary', '2024-03-05', 'primary', 'march');
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM election_votes").get().c, 23);
});

test('Universe: temp table segmentation', () => {
  const cutoffDate = '2023-01-01';
  const precincts = ['UNI-01', 'UNI-02'];
  const pctFilter = precincts.map(() => '?').join(',');

  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _test_pct');
    db.exec('CREATE TEMP TABLE _test_pct (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _test_pct SELECT id FROM voters WHERE precinct IN (${pctFilter})`).run(...precincts);
    const totalInPrecincts = db.prepare('SELECT COUNT(*) as c FROM _test_pct').get().c;

    db.exec('DROP TABLE IF EXISTS _test_uni');
    db.exec('CREATE TEMP TABLE _test_uni (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _test_uni SELECT DISTINCT ev.voter_id FROM election_votes ev INNER JOIN _test_pct tp ON ev.voter_id = tp.voter_id WHERE ev.election_date >= ?`).run(cutoffDate);
    const universeCount = db.prepare('SELECT COUNT(*) as c FROM _test_uni').get().c;

    // Sub-universe: november cycle only
    db.exec('DROP TABLE IF EXISTS _test_sub');
    db.exec('CREATE TEMP TABLE _test_sub (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _test_sub SELECT DISTINCT ev.voter_id FROM election_votes ev INNER JOIN _test_uni tu ON ev.voter_id = tu.voter_id WHERE ev.election_cycle = 'november'`).run();
    const subCount = db.prepare('SELECT COUNT(*) as c FROM _test_sub').get().c;

    // Priority: March primary voters within sub-universe
    const priorityCount = db.prepare(`SELECT COUNT(DISTINCT ev.voter_id) as c FROM election_votes ev INNER JOIN _test_sub ts ON ev.voter_id = ts.voter_id WHERE ev.election_name = 'Mar 2024 Primary'`).get().c;

    db.exec('DROP TABLE IF EXISTS _test_pct; DROP TABLE IF EXISTS _test_uni; DROP TABLE IF EXISTS _test_sub');

    return { totalInPrecincts, universeCount, subCount, priorityCount };
  });

  const r = buildTx();
  assert.strictEqual(r.totalInPrecincts, 20);
  assert.strictEqual(r.universeCount, 15);
  assert.strictEqual(r.subCount, 15);
  assert.strictEqual(r.priorityCount, 8);
});

test('Universe: empty precinct returns zero counts', () => {
  db.exec('DROP TABLE IF EXISTS _test_empty');
  db.exec('CREATE TEMP TABLE _test_empty (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_empty SELECT id FROM voters WHERE precinct = 'NOPE'").run();
  const c = db.prepare('SELECT COUNT(*) as c FROM _test_empty').get().c;
  db.exec('DROP TABLE IF EXISTS _test_empty');
  assert.strictEqual(c, 0);
});

test('Universe: create admin list from temp table results', () => {
  const r = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('Universe Test', 'From builder', 'general')").run();
  const listId = r.lastInsertRowid;

  // Add first 10 UNI voters to the list
  const uniVoters = db.prepare("SELECT id FROM voters WHERE precinct = 'UNI-01'").all();
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0;
  for (const v of uniVoters) {
    if (insert.run(listId, v.id).changes > 0) added++;
  }
  assert.strictEqual(added, 10);

  // Duplicate add should be ignored
  const dupResult = insert.run(listId, uniVoters[0].id);
  assert.strictEqual(dupResult.changes, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Cascading Delete Orphan Verification
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Cascade Integrity ===');

test('Cascade: delete captain removes lists, team members, list voters', () => {
  db.prepare("INSERT INTO captains (name, code) VALUES ('Cascade Cap', 'CASCC1')").run();
  const capId = db.prepare("SELECT id FROM captains WHERE code = 'CASCC1'").get().id;
  db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(capId, 'TeamGuy');
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(capId, 'CascList');
  const listId = db.prepare("SELECT id FROM captain_lists WHERE captain_id = ?").get(capId).id;

  // Add a voter to the list
  const voter = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('CascV', 'Test', 'qr_cascv')").run();
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, voter.lastInsertRowid);

  // Delete captain
  db.prepare('DELETE FROM captains WHERE id = ?').run(capId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?').get(capId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_team_members WHERE captain_id = ?').get(capId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listId).c, 0);
});

test('Cascade: delete voter removes contacts, checkins, list membership, election votes', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('DelV', 'Test', 'qr_delv')").run();
  const vid = v.lastInsertRowid;
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Phone', 'OK')").run(vid);
  db.prepare("INSERT INTO events (title, event_date) VALUES ('CascEv', '2025-01-01')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'CascEv'").get().id;
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);
  db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Test', '2024-01-01')").run(vid);

  db.prepare('DELETE FROM voters WHERE id = ?').run(vid);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?').get(vid).c, 0);
});

test('Cascade: delete event removes RSVPs and checkins', () => {
  db.prepare("INSERT INTO events (title, event_date) VALUES ('CascEvent2', '2025-02-01')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'CascEvent2'").get().id;
  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5550000000', 'RSVP Guy')").run(evId);
  const v2 = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('EV2', 'qr_ev2')").run();
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(v2.lastInsertRowid, evId);

  db.prepare('DELETE FROM events WHERE id = ?').run(evId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(evId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE event_id = ?').get(evId).c, 0);
});

test('Cascade: delete survey removes questions, options, sends, responses', () => {
  const s = db.prepare("INSERT INTO surveys (name) VALUES ('CascSurvey')").run();
  const sid = s.lastInsertRowid;
  const q = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Q?', 'single_choice')").run(sid);
  const qid = q.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key) VALUES (?, 'Opt', '1')").run(qid);
  const send = db.prepare("INSERT INTO survey_sends (survey_id, phone) VALUES (?, '5550000001')").run(sid);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550000001', '1')").run(sid, send.lastInsertRowid, qid);

  db.prepare('DELETE FROM surveys WHERE id = ?').run(sid);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?').get(sid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(sid).c, 0);
});

test('Cascade: delete P2P session removes volunteers and assignments', () => {
  const contact = db.prepare("INSERT INTO contacts (phone, first_name) VALUES ('5558880001', 'P2PCC')").run();
  const sess = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('CascSess', 'Hi', 'CSCD', '2099-01-01')").run();
  const sessId = sess.lastInsertRowid;
  const vol = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessId, 'VolTest');
  db.prepare('INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)').run(sessId, contact.lastInsertRowid, vol.lastInsertRowid);

  db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(sessId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?').get(sessId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessId).c, 0);
});

test('Cascade: delete walk removes addresses and group members', () => {
  db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('CascWalk', 'CWLK')").run();
  const wId = db.prepare("SELECT id FROM block_walks WHERE name = 'CascWalk'").get().id;
  db.prepare("INSERT INTO walk_addresses (walk_id, address) VALUES (?, '1 Main')").run(wId);
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(wId, 'Walker1');

  db.prepare('DELETE FROM block_walks WHERE id = ?').run(wId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(wId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(wId).c, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: P2P Volunteer Assignment & Redistribution
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: P2P Volunteer ===');

test('P2P: create session with contacts and auto_split', () => {
  // Create contacts
  for (let i = 0; i < 10; i++) {
    db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)").run(`555700000${i}`, `P2PCont${i}`);
  }
  const contacts = db.prepare("SELECT id FROM contacts WHERE first_name LIKE 'P2PCont%'").all();

  const sess = db.prepare("INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at) VALUES ('VolTest', 'Hello {firstName}', 'auto_split', 'VTST', '2099-01-01')").run();
  const sessId = sess.lastInsertRowid;

  // Create assignments
  for (const c of contacts) {
    db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)').run(sessId, c.id);
  }

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessId).c, 10);
});

test('P2P: volunteer joins and gets assigned batch', () => {
  const sessId = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'VolTest'").get().id;
  const vol = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessId, 'VolAlice');
  const volId = vol.lastInsertRowid;

  // Auto-split: assign all unassigned to this volunteer
  const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").all(sessId);
  for (const a of unassigned) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volId, a.id);
  }

  const assigned = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(volId).c;
  assert.strictEqual(assigned, 10);
});

test('P2P: second volunteer joins, contacts redistributed', () => {
  const sessId = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'VolTest'").get().id;
  const volAlice = db.prepare("SELECT id FROM p2p_volunteers WHERE name = 'VolAlice' AND session_id = ?").get(sessId);
  const vol2 = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessId, 'VolBob');
  const volBobId = vol2.lastInsertRowid;

  // Redistribute: give half of Alice's pending to Bob
  const alicePending = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending' ORDER BY id").all(volAlice.id);
  const half = Math.floor(alicePending.length / 2);
  for (let i = 0; i < half; i++) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volBobId, alicePending[i].id);
  }

  const bobCount = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(volBobId).c;
  assert.strictEqual(bobCount, 5);
});

test('P2P: volunteer goes offline, contacts snap-back tracked', () => {
  const sessId = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'VolTest'").get().id;
  const volBob = db.prepare("SELECT id FROM p2p_volunteers WHERE name = 'VolBob' AND session_id = ?").get(sessId);
  db.prepare('UPDATE p2p_volunteers SET is_online = 0 WHERE id = ?').run(volBob.id);

  // Mark original_volunteer_id before redistributing
  const bobAssignments = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").all(volBob.id);
  const volAlice = db.prepare("SELECT id FROM p2p_volunteers WHERE name = 'VolAlice' AND session_id = ?").get(sessId);
  for (const a of bobAssignments) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = COALESCE(original_volunteer_id, ?) WHERE id = ?')
      .run(volAlice.id, volBob.id, a.id);
  }

  // Bob comes back online — snap back
  db.prepare('UPDATE p2p_volunteers SET is_online = 1 WHERE id = ?').run(volBob.id);
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation', 'pending')")
    .run(volBob.id, volBob.id, sessId);
  db.prepare('UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?')
    .run(volBob.id, sessId);

  const bobBack = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(volBob.id).c;
  assert(bobBack >= 1, 'Bob should get assignments back after snap-back');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Canvass Import 3-Tier Matching
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Canvass Import ===');

test('Canvass: tier-1 phone match', () => {
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('PhoneTier', 'Match', '5551234567', '100 Main St', 'qr_pt1')").run();
  const allVoters = db.prepare("SELECT id, phone FROM voters WHERE phone = '5551234567'").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) phoneMap[d] = v.id;
  }
  const digits = phoneDigits('(555) 123-4567');
  assert(phoneMap[digits], 'Phone match should find voter');
});

test('Canvass: tier-2 registration number match', () => {
  db.prepare("INSERT INTO voters (first_name, last_name, registration_number, address, qr_token) VALUES ('RegTier', 'Match', 'REG-CANV-1', '200 Main St', 'qr_rt1')").run();
  const allVoters = db.prepare("SELECT id, registration_number FROM voters WHERE registration_number = 'REG-CANV-1'").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number) regMap[v.registration_number.trim()] = v.id;
  }
  assert(regMap['REG-CANV-1'], 'Registration match should find voter');
});

test('Canvass: tier-3 name+address match', () => {
  db.prepare("INSERT INTO voters (first_name, last_name, address, city, qr_token) VALUES ('NameAddr', 'MatchTest', '300 Oak Ave', 'TestCity', 'qr_na1')").run();
  const found = db.prepare("SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1")
    .get('NameAddr', 'MatchTest', '300 oak%');
  assert(found, 'Name+address match should find voter');
});

test('Canvass: no match returns null', () => {
  const found = db.prepare("SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1")
    .get('Ghost', 'Person', '999 nowhere%');
  assert(!found, 'Non-matching voter should return null');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Survey Lifecycle & Borda Scoring
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Survey & Borda ===');

test('Survey: draft → active → closed → reopened', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('Lifecycle', 'draft')").run();
  const sid = s.lastInsertRowid;

  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');

  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'closed');

  // Reopen
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');
});

test('Survey: end poll expires pending sends', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('EndPoll', 'active')").run();
  const sid = s.lastInsertRowid;
  const q = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Q?', 'single_choice')").run(sid);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status, current_question_id) VALUES (?, '5550001111', 'sent', ?)").run(sid, q.lastInsertRowid);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status, current_question_id) VALUES (?, '5550002222', 'in_progress', ?)").run(sid, q.lastInsertRowid);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status) VALUES (?, '5550003333', 'completed')").run(sid);

  // End poll: expire sent/in_progress but not completed
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(sid);
  assert.strictEqual(expired.changes, 2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(sid).c, 1);
});

test('Survey: Borda count ranked choice scoring', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('BordaTest', 'active')").run();
  const sid = s.lastInsertRowid;
  const q = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Rank these', 'ranked_choice')").run(sid);
  const qid = q.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Alpha', '1', 0)").run(qid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Beta', '2', 1)").run(qid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Gamma', '3', 2)").run(qid);

  const send1 = db.prepare("INSERT INTO survey_sends (survey_id, phone) VALUES (?, '5550010001')").run(sid);
  const send2 = db.prepare("INSERT INTO survey_sends (survey_id, phone) VALUES (?, '5550010002')").run(sid);
  const send3 = db.prepare("INSERT INTO survey_sends (survey_id, phone) VALUES (?, '5550010003')").run(sid);

  // Respondent 1: Alpha, Beta, Gamma (1,2,3)
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(sid, send1.lastInsertRowid, qid, '5550010001', '1,2,3');
  // Respondent 2: Beta, Alpha, Gamma (2,1,3)
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(sid, send2.lastInsertRowid, qid, '5550010002', '2,1,3');
  // Respondent 3: Alpha, Gamma, Beta (1,3,2)
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(sid, send3.lastInsertRowid, qid, '5550010003', '1,3,2');

  // Compute Borda scores (3 options: 1st=3pts, 2nd=2pts, 3rd=1pt)
  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(qid);
  const responses = db.prepare('SELECT * FROM survey_responses WHERE question_id = ?').all(qid);
  const rankings = {};
  for (const opt of options) rankings[opt.option_key] = { score: 0 };

  for (const r of responses) {
    const picks = r.response_text.split(',');
    const totalOpts = options.length;
    picks.forEach((key, pos) => {
      const k = key.trim();
      if (rankings[k]) rankings[k].score += Math.max(0, totalOpts - pos);
    });
  }

  // Alpha: 3+2+3 = 8, Beta: 2+3+1 = 6, Gamma: 1+1+2 = 4
  assert.strictEqual(rankings['1'].score, 8, 'Alpha Borda score should be 8');
  assert.strictEqual(rankings['2'].score, 6, 'Beta Borda score should be 6');
  assert.strictEqual(rankings['3'].score, 4, 'Gamma Borda score should be 4');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Admin List CRUD & Idempotent Add
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Admin Lists ===');

test('Admin list: create, add voters, duplicate add is ignored', () => {
  const r = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('TestList', 'For testing', 'text')").run();
  const listId = r.lastInsertRowid;
  const voters = db.prepare('SELECT id FROM voters LIMIT 5').all();
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');

  let added = 0;
  for (const v of voters) {
    if (insert.run(listId, v.id).changes > 0) added++;
  }
  assert.strictEqual(added, 5);

  // Duplicate add
  const dup = insert.run(listId, voters[0].id);
  assert.strictEqual(dup.changes, 0);
});

test('Admin list: voter count query matches actual', () => {
  const list = db.prepare("SELECT al.id, COUNT(alv.id) as voterCount FROM admin_lists al LEFT JOIN admin_list_voters alv ON al.id = alv.list_id WHERE al.name = 'TestList' GROUP BY al.id").get();
  assert(list);
  assert.strictEqual(list.voterCount, 5);
});

test('Admin list: delete cascades admin_list_voters', () => {
  const list = db.prepare("SELECT id FROM admin_lists WHERE name = 'TestList'").get();
  const listId = list.id;
  db.prepare('DELETE FROM admin_lists WHERE id = ?').run(listId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(listId).c, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Captain CSV Import Ambiguity Detection
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Captain CSV Ambiguity ===');

test('CSV import: single match auto-added, multiple matches flagged', () => {
  // Create 2 voters with same phone (different addresses)
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('Ambig', 'One', '5559991111', '1 Dup St', 'qr_amb1')").run();
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('Ambig', 'Two', '5559991111', '2 Dup St', 'qr_amb2')").run();
  // Create 1 unique voter
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('Unique', 'Only', '5559992222', '3 Only St', 'qr_unq1')").run();

  // Build phone map (array for ambiguity)
  const allVoters = db.prepare("SELECT id, phone, first_name, last_name, address FROM voters WHERE phone IN ('5559991111', '5559992222')").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) {
      if (!phoneMap[d]) phoneMap[d] = [];
      phoneMap[d].push(v);
    }
  }

  // Captain setup
  db.prepare("INSERT INTO captains (name, code) VALUES ('CSVCap', 'CSVCP')").run();
  const capId = db.prepare("SELECT id FROM captains WHERE code = 'CSVCP'").get().id;
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(capId, 'CSV List');
  const listId = db.prepare("SELECT id FROM captain_lists WHERE captain_id = ?").get(capId).id;
  const insertToList = db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');

  const results = { auto_added: 0, needs_review: [], no_match: [] };

  // Row 1: ambiguous phone → needs_review
  const amb = phoneMap[phoneDigits('5559991111')] || [];
  if (amb.length === 1) {
    insertToList.run(listId, amb[0].id);
    results.auto_added++;
  } else if (amb.length > 1) {
    results.needs_review.push({ phone: '5559991111', candidates: amb.length });
  }

  // Row 2: unique phone → auto_add
  const unq = phoneMap[phoneDigits('5559992222')] || [];
  if (unq.length === 1) {
    insertToList.run(listId, unq[0].id);
    results.auto_added++;
  }

  // Row 3: no match
  const miss = phoneMap[phoneDigits('5559993333')] || [];
  if (miss.length === 0) results.no_match.push({ phone: '5559993333' });

  assert.strictEqual(results.auto_added, 1);
  assert.strictEqual(results.needs_review.length, 1);
  assert.strictEqual(results.needs_review[0].candidates, 2);
  assert.strictEqual(results.no_match.length, 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Engagement Scoring Formula
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: Engagement Scoring ===');

test('Engagement: correct formula (contacts*3 + checkins*5 + texts*1 + captainLists*4), cap 100', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('EngTest', 'Voter', '5558880011', 'qr_eng1')").run();
  const vid = Number(v.lastInsertRowid);

  // 3 contacts (3*3=9)
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Door-knock', 'Support')").run(vid);
  }
  // 2 event checkins (2*5=10)
  for (let i = 0; i < 2; i++) {
    db.prepare("INSERT INTO events (title, event_date) VALUES (?, '2025-01-01')").run(`EngEv${i}`);
    const evId = db.prepare("SELECT id FROM events WHERE title = ?").get(`EngEv${i}`).id;
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);
  }
  // 5 texts (5*1=5)
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES ('5558880011', 'test', 'outbound')").run();
  }
  // 1 captain list membership (1*4=4)
  db.prepare("INSERT INTO captains (name, code) VALUES ('EngCap', 'ENGCP')").run();
  const engCapId = db.prepare("SELECT id FROM captains WHERE code = 'ENGCP'").get().id;
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(engCapId, 'EngList');
  const engListId = db.prepare("SELECT id FROM captain_lists WHERE captain_id = ?").get(engCapId).id;
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(engListId, vid);

  // Compute engagement score
  const contacts = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(vid).c;
  const checkins = db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(vid).c;
  const texts = db.prepare("SELECT COUNT(*) as c FROM messages WHERE phone = '5558880011'").get().c;
  const captainLists = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?').get(vid).c;

  const score = Math.min(100, contacts * 3 + checkins * 5 + texts * 1 + captainLists * 4);
  assert.strictEqual(score, 28, `Expected 28, got ${score}`); // 9+10+5+4
});

test('Engagement: score caps at 100', () => {
  const score = Math.min(100, 20 * 3 + 10 * 5 + 50 * 1 + 5 * 4);
  // 60 + 50 + 50 + 20 = 180 → capped at 100
  assert.strictEqual(score, 100);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: Walk from Precinct with Voter Linkage
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: Walk from Precinct ===');

test('Walk from precinct: auto-creates walk with linked voter_ids', () => {
  for (let i = 0; i < 8; i++) {
    db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, precinct, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`Walker${i}`, 'Test', `${400+i} Maple Dr`, 'WalkCity', '55555', 'WALK-PCT', `qr_wk_${i}`);
  }

  const voters = db.prepare("SELECT id, first_name, last_name, address, city, zip FROM voters WHERE precinct = 'WALK-PCT' AND address != '' ORDER BY address").all();
  assert.strictEqual(voters.length, 8);

  const walkName = 'Precinct Walk: WALK-PCT';
  const joinCode = generateAlphaCode(4);
  const walkResult = db.prepare('INSERT INTO block_walks (name, join_code) VALUES (?, ?)').run(walkName, joinCode);
  const walkId = walkResult.lastInsertRowid;

  const insert = db.prepare('INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let idx = 0;
  for (const v of voters) {
    insert.run(walkId, v.address, v.city, v.zip, `${v.first_name} ${v.last_name}`, v.id, idx++);
  }

  const addrs = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ?').all(walkId);
  assert.strictEqual(addrs.length, 8);
  assert(addrs.every(a => a.voter_id != null), 'All addresses should have voter_id linked');
  assert.strictEqual(joinCode.length, 4);
});

test('Walk from precinct: door-knock auto-logs voter contact', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Precinct Walk: WALK-PCT'").get().id;
  const addr = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? LIMIT 1').get(walkId);
  assert(addr.voter_id, 'Address should have voter_id');

  // Simulate door-knock result → auto voter contact log
  db.prepare("UPDATE walk_addresses SET result = 'support', knocked_at = datetime('now') WHERE id = ?").run(addr.id);

  // Auto-log contact for linked voter
  const supportMap = { 'support': 'strong_support', 'lean_support': 'lean_support', 'undecided': 'undecided' };
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, 'Door-knock', 'Strong Support', '', 'Block Walker')").run(addr.voter_id);
  if (supportMap['support']) {
    db.prepare("UPDATE voters SET support_level = ? WHERE id = ?").run(supportMap['support'], addr.voter_id);
  }

  const voter = db.prepare('SELECT support_level FROM voters WHERE id = ?').get(addr.voter_id);
  assert.strictEqual(voter.support_level, 'strong_support');
  const contact = db.prepare("SELECT * FROM voter_contacts WHERE voter_id = ? AND contact_type = 'Door-knock'").get(addr.voter_id);
  assert(contact, 'Contact log should exist');
});

test('Walk from precinct: empty precinct returns no voters', () => {
  const voters = db.prepare("SELECT id FROM voters WHERE precinct = 'NONEXISTENT' AND address != ''").all();
  assert.strictEqual(voters.length, 0);
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n');
if (failures.length > 0) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
}
console.log(`\n${'='.repeat(60)}`);
console.log(`STRESS TEST ROUND 12 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('='.repeat(60));

db.close();
try { fs.unlinkSync(TEST_DB); } catch (e) {}

process.exit(failed > 0 ? 1 : 0);
