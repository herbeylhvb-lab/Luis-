#!/usr/bin/env node
/**
 * Stress Test Round 3 — CHAOS MODE
 * Tests: massive data volumes, WAL performance, interleaved reads/writes,
 *        FK constraint edge cases, data corruption resilience, query plans,
 *        memory pressure, CSV-like malformed data, survey edge cases,
 *        walk address GPS boundary conditions
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'data');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'test_stress_r3.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const db = new Database(testDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(name); process.stdout.write('F'); }
}

// Full schema
db.exec(`
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '', preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT, session_id INTEGER, volunteer_name TEXT, channel TEXT DEFAULT 'sms');
  CREATE INDEX idx_messages_direction_id ON messages(direction, id DESC);
  CREATE INDEX idx_messages_phone ON messages(phone);
  CREATE INDEX idx_messages_session_id ON messages(session_id);
  CREATE TABLE opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '', status TEXT DEFAULT 'upcoming', created_at TEXT DEFAULT (datetime('now')), flyer_image TEXT DEFAULT NULL);
  CREATE TABLE event_rsvps (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '', rsvp_status TEXT DEFAULT 'invited', invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT, checked_in_at TEXT);
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);
  CREATE TABLE voters (id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '', support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '', registration_number TEXT DEFAULT '', qr_token TEXT, voting_history TEXT DEFAULT '', precinct TEXT DEFAULT '', early_voted INTEGER DEFAULT 0, early_voted_date TEXT, early_voted_method TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_voters_phone ON voters(phone);
  CREATE INDEX idx_voters_name ON voters(last_name, first_name);
  CREATE INDEX idx_voters_support ON voters(support_level);
  CREATE TABLE voter_contacts (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '', contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL, assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL, status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL, session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_volunteers (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_assignments (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, volunteer_id INTEGER REFERENCES p2p_volunteers(id), contact_id INTEGER NOT NULL REFERENCES contacts(id), status TEXT DEFAULT 'pending', original_volunteer_id INTEGER, assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT);
  CREATE INDEX idx_p2p_assign_vol_status ON p2p_assignments(volunteer_id, status);
  CREATE INDEX idx_p2p_assign_session_status ON p2p_assignments(session_id, status);
  CREATE TABLE captains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_lists (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, team_member_id INTEGER, name TEXT NOT NULL, list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE captain_team_members (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE INDEX idx_survey_sends_phone_status ON survey_sends(phone, status);
  CREATE TABLE survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER, responded_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE block_walks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', assigned_to TEXT DEFAULT '', status TEXT DEFAULT 'pending', join_code TEXT, max_walkers INTEGER DEFAULT 4, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE walk_addresses (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, address TEXT NOT NULL, unit TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', voter_name TEXT DEFAULT '', result TEXT DEFAULT 'not_visited', notes TEXT DEFAULT '', knocked_at TEXT, sort_order INTEGER DEFAULT 0, voter_id INTEGER, lat REAL, lng REAL, gps_lat REAL, gps_lng REAL, gps_accuracy REAL, gps_verified INTEGER DEFAULT 0, assigned_walker TEXT);
  CREATE TABLE election_votes (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, election_name TEXT NOT NULL, election_date TEXT NOT NULL, election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '', voted INTEGER DEFAULT 1, UNIQUE(voter_id, election_name));
  CREATE TABLE campaigns (id INTEGER PRIMARY KEY, message_template TEXT, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`);

const { phoneDigits, normalizePhone, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');

console.log('=== STRESS TEST ROUND 3 — CHAOS MODE ===\n');

// =============================================================================
// TEST 1: 50K voter mass load + aggregation
// =============================================================================
console.log('\n[1] 50K voters mass load...');

const t1 = Date.now();
const insertV = db.prepare('INSERT INTO voters (first_name, last_name, phone, address, city, zip, party, support_level, precinct, registration_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const parties = ['D', 'R', 'I', 'L', 'G', 'NPA'];
const supports = ['strong_support', 'lean_support', 'undecided', 'lean_oppose', 'strong_oppose', 'unknown'];
db.transaction(() => {
  for (let i = 0; i < 50000; i++) {
    insertV.run(
      'First' + i, 'Last' + (i % 5000), '512' + String(i).padStart(7, '0'),
      (i * 3) + ' ' + ['Main', 'Oak', 'Elm', 'Pine', 'Cedar'][i % 5] + ' St',
      ['Austin', 'Dallas', 'Houston', 'SA', 'El Paso'][i % 5],
      '7' + String(i % 10000).padStart(4, '0'),
      parties[i % 6], supports[i % 6], 'PCT-' + (i % 100), 'REG' + String(i).padStart(8, '0')
    );
  }
})();
const t2 = Date.now();
assert(t2 - t1 < 15000, '50K voters insert < 15s (took ' + (t2 - t1) + 'ms)');

const vCount = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
assert(vCount === 50000, '50K voters confirmed');

// =============================================================================
// TEST 2: Complex aggregation queries at scale
// =============================================================================
console.log('\n[2] Complex aggregations on 50K voters...');

const t3 = Date.now();
const partyBreakdown = db.prepare('SELECT party, COUNT(*) as c FROM voters GROUP BY party ORDER BY c DESC').all();
const t4 = Date.now();
assert(partyBreakdown.length === 6, '6 parties found');
assert(t4 - t3 < 500, 'Party breakdown < 500ms (took ' + (t4 - t3) + 'ms)');

const t5 = Date.now();
const supportByCity = db.prepare('SELECT city, support_level, COUNT(*) as c FROM voters GROUP BY city, support_level ORDER BY city').all();
const t6 = Date.now();
assert(supportByCity.length === 30, '5 cities x 6 support levels = 30 groups (' + supportByCity.length + ')');
assert(t6 - t5 < 500, 'Support by city < 500ms (took ' + (t6 - t5) + 'ms)');

// Precinct analysis
const t7 = Date.now();
const precincts = db.prepare('SELECT precinct, party, COUNT(*) as c FROM voters GROUP BY precinct, party ORDER BY precinct').all();
const t8 = Date.now();
// LCM(100 precincts, 6 parties) = 300 unique (precinct, party) combos in modular assignment
assert(precincts.length === 300, '300 precinct-party groups from modular assignment (' + precincts.length + ')');
assert(t8 - t7 < 1000, 'Precinct analysis < 1s (took ' + (t8 - t7) + 'ms)');

// =============================================================================
// TEST 3: Full text search performance (LIKE queries)
// =============================================================================
console.log('\n[3] LIKE search performance on 50K voters...');

const t9 = Date.now();
const nameSearch = db.prepare("SELECT * FROM voters WHERE first_name LIKE ? OR last_name LIKE ? OR address LIKE ? LIMIT 50").all('%Main%', '%Last100%', '%Oak%');
const t10 = Date.now();
assert(nameSearch.length === 50, 'LIKE search returns 50');
assert(t10 - t9 < 1000, 'LIKE search < 1s (took ' + (t10 - t9) + 'ms)');

// Combined search with phone
const t11 = Date.now();
for (let i = 0; i < 100; i++) {
  db.prepare("SELECT * FROM voters WHERE phone = ?").get('512' + String(i * 100).padStart(7, '0'));
}
const t12 = Date.now();
assert(t12 - t11 < 200, '100 phone lookups < 200ms (took ' + (t12 - t11) + 'ms)');

// =============================================================================
// TEST 4: Walk with 2000 addresses — full lifecycle
// =============================================================================
console.log('\n[4] Walk with 2000 addresses...');

const walkId = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('Big Walk', 'ABCD')").run().lastInsertRowid;
const insertAddr = db.prepare('INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, lat, lng, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
db.transaction(() => {
  for (let i = 0; i < 2000; i++) {
    insertAddr.run(walkId, (i * 2) + ' Walk St', 'Austin', '78701', 'Walker' + i, i + 1, 30.267 + (i * 0.0001), -97.743 + (i * 0.0001), i);
  }
})();

const addrCount = db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(walkId).c;
assert(addrCount === 2000, '2000 walk addresses created');

// Simulate knocking with GPS
const updateAddr = db.prepare("UPDATE walk_addresses SET result = 'door_knock', knocked_at = datetime('now'), gps_lat = ?, gps_lng = ?, gps_accuracy = ?, gps_verified = 1 WHERE id = ?");
db.transaction(() => {
  const addrs = db.prepare('SELECT id, lat, lng FROM walk_addresses WHERE walk_id = ? LIMIT 500').all(walkId);
  for (const a of addrs) {
    updateAddr.run(a.lat + 0.00001, a.lng + 0.00001, Math.random() * 20, a.id);
  }
})();

const knocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND result = 'door_knock'").get(walkId).c;
assert(knocked === 500, '500 doors knocked');

// Walk stats query (like the JOIN in walks.js)
const walkStats = db.prepare(`
  SELECT b.*, COUNT(wa.id) as totalAddresses,
    SUM(CASE WHEN wa.result != 'not_visited' THEN 1 ELSE 0 END) as knocked
  FROM block_walks b LEFT JOIN walk_addresses wa ON b.id = wa.walk_id
  WHERE b.id = ? GROUP BY b.id
`).get(walkId);
assert(walkStats.totalAddresses === 2000, 'Walk stats totalAddresses=2000');
assert(walkStats.knocked === 500, 'Walk stats knocked=500');

// =============================================================================
// TEST 5: P2P session full lifecycle with 5000 contacts
// =============================================================================
console.log('\n[5] P2P session lifecycle (5000 contacts)...');

// Create contacts
const contactIds = [];
db.transaction(() => {
  const ins = db.prepare("INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 5000; i++) {
    contactIds.push(ins.run('888' + String(i).padStart(7, '0'), 'P2P' + i, 'Contact', 'Austin').lastInsertRowid);
  }
})();

const sessId = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Mega Session', 'Hi {firstName}!', '5555', '2026-12-31')").run().lastInsertRowid;

// Assign all contacts
db.transaction(() => {
  const ins = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  for (const cid of contactIds) ins.run(sessId, cid);
})();

// Add 10 volunteers
const volIds = [];
for (let i = 0; i < 10; i++) {
  volIds.push(db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessId, 'Vol' + i).lastInsertRowid);
}

// Auto-split: assign ~500 per volunteer
db.transaction(() => {
  const assigns = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' ORDER BY id").all(sessId);
  assigns.forEach((a, i) => {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volIds[i % 10], a.id);
  });
})();

// Check distribution
const distrib = db.prepare(`
  SELECT volunteer_id, COUNT(*) as c FROM p2p_assignments WHERE session_id = ? GROUP BY volunteer_id
`).all(sessId);
assert(distrib.length === 10, '10 volunteers have assignments');
assert(distrib.every(d => d.c === 500), 'Even distribution: 500 each');

// Simulate sending 2000 messages
db.transaction(() => {
  const assigns = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND status = 'pending' LIMIT 2000").all(sessId);
  const upd = db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  for (const a of assigns) upd.run(a.id);
})();

// Session stats
const sessStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status IN ('sent', 'in_conversation', 'completed') THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as remaining
  FROM p2p_assignments WHERE session_id = ?
`).get(sessId);
assert(sessStats.total === 5000, 'Session total=5000');
assert(sessStats.sent === 2000, 'Session sent=2000');
assert(sessStats.remaining === 3000, 'Session remaining=3000');

// Volunteer goes offline — redistribute
db.prepare('UPDATE p2p_volunteers SET is_online = 0 WHERE id = ?').run(volIds[0]);
const pendingFromVol0 = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").all(volIds[0]);
assert(pendingFromVol0.length > 0, 'Vol0 has pending contacts to redistribute');

// Redistribute round-robin
const onlineVols = volIds.slice(1);
db.transaction(() => {
  pendingFromVol0.forEach((a, i) => {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = ? WHERE id = ?')
      .run(onlineVols[i % onlineVols.length], volIds[0], a.id);
  });
})();

const vol0After = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(volIds[0]).c;
assert(vol0After === 0, 'Vol0 has 0 pending after redistribution');

// =============================================================================
// TEST 6: Election votes bulk import + analytics
// =============================================================================
console.log('\n[6] Election votes bulk import...');

const elections = ['2020 General', '2022 Primary', '2022 General', '2024 Primary', '2024 General'];
const t13 = Date.now();
db.transaction(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)');
  for (let vid = 1; vid <= 50000; vid++) {
    // Each voter voted in some elections
    const numElections = vid % 5 + 1; // 1-5 elections
    for (let e = 0; e < numElections; e++) {
      ins.run(vid, elections[e], '2020-11-03', 'general', '2020');
    }
  }
})();
const t14 = Date.now();
const evCount = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
assert(evCount > 100000, 'Election votes > 100K (' + evCount + ')');
assert(t14 - t13 < 20000, 'Election votes import < 20s (took ' + (t14 - t13) + 'ms)');

// Analytics: voter participation rate
const t15 = Date.now();
const participation = db.prepare(`
  SELECT election_name, COUNT(DISTINCT voter_id) as voters
  FROM election_votes GROUP BY election_name ORDER BY voters DESC
`).all();
const t16 = Date.now();
assert(participation.length === 5, '5 elections found');
assert(t16 - t15 < 1000, 'Participation query < 1s (took ' + (t16 - t15) + 'ms)');

// Super voters (voted in 4+ elections)
const t17 = Date.now();
const superVoters = db.prepare(`
  SELECT voter_id, COUNT(*) as elections_voted
  FROM election_votes GROUP BY voter_id HAVING elections_voted >= 4
`).all();
const t18 = Date.now();
assert(superVoters.length > 0, 'Found super voters (' + superVoters.length + ')');
assert(t18 - t17 < 2000, 'Super voter query < 2s (took ' + (t18 - t17) + 'ms)');

// =============================================================================
// TEST 7: Interleaved reads and writes (simulating concurrent requests)
// =============================================================================
console.log('\n[7] Interleaved reads/writes...');

const t19 = Date.now();
for (let cycle = 0; cycle < 500; cycle++) {
  // Write a message
  db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, ?, ?)").run(
    '512' + String(cycle).padStart(7, '0'), 'Cycle ' + cycle, cycle % 2 === 0 ? 'inbound' : 'outbound'
  );
  // Read stats
  if (cycle % 50 === 0) {
    db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'inbound'").get();
    db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 10').all();
  }
  // Update a voter
  db.prepare("UPDATE voters SET support_level = ? WHERE id = ?").run(supports[cycle % 6], (cycle % 50000) + 1);
}
const t20 = Date.now();
assert(t20 - t19 < 5000, '500 interleaved cycles < 5s (took ' + (t20 - t19) + 'ms)');

// =============================================================================
// TEST 8: Malformed CSV-like data resilience
// =============================================================================
console.log('\n[8] Malformed data resilience...');

const malformedPhones = [
  '', null, undefined, '0', '123', '555-CALL-NOW',
  '+44 7911 123456', '(   )   -    ', 'phone: 512-555-1234',
  '   ', '\t\n', '512555123456789', '+1+1+15125551234',
];

for (const phone of malformedPhones) {
  const result = normalizePhone(phone);
  assert(typeof result === 'string', 'normalizePhone returns string for: ' + JSON.stringify(phone));
}

// Malformed data in bulk insert (should not crash)
let insertErrors = 0;
for (const phone of malformedPhones) {
  try {
    const p = phone || '';
    db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)").run(p, 'Malformed');
  } catch (e) {
    insertErrors++;
  }
}
assert(insertErrors === 0, 'All malformed phones insert without error (db accepts any string)');

// =============================================================================
// TEST 9: Captain code collision stress
// =============================================================================
console.log('\n[9] Captain code collision test...');

// Create 100 captains with unique codes
const createdCodes = [];
for (let i = 0; i < 100; i++) {
  let code;
  for (let attempt = 0; attempt < 20; attempt++) {
    code = generateAlphaCode(6);
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) break;
  }
  try {
    db.prepare('INSERT INTO captains (name, code) VALUES (?, ?)').run('Captain' + i, code);
    createdCodes.push(code);
  } catch (e) {
    // Collision — extremely rare with 6 hex chars (16M combinations)
  }
}
assert(createdCodes.length >= 95, 'At least 95/100 captains created without collision (' + createdCodes.length + ')');

// Verify all codes are unique
const uniqueCodes = new Set(createdCodes);
assert(uniqueCodes.size === createdCodes.length, 'All captain codes are unique');

// =============================================================================
// TEST 10: Survey with many questions and partial responses
// =============================================================================
console.log('\n[10] Survey with many questions...');

const bigSurvey = db.prepare("INSERT INTO surveys (name, status) VALUES ('Big Survey', 'active')").run().lastInsertRowid;
const questionIds = [];
for (let i = 0; i < 20; i++) {
  const qid = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, ?, ?, ?)")
    .run(bigSurvey, 'Question ' + (i + 1) + '?', i < 15 ? 'single_choice' : 'write_in', i + 1).lastInsertRowid;
  questionIds.push(qid);
  if (i < 15) {
    for (let o = 0; o < 5; o++) {
      db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, ?, ?, ?)").run(qid, 'Option ' + (o + 1), String(o + 1), o);
    }
  }
}

// Simulate 200 respondents, some only answer partially
db.transaction(() => {
  for (let r = 0; r < 200; r++) {
    const phone = '333' + String(r).padStart(7, '0');
    const sendId = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id) VALUES (?, ?, ?)")
      .run(bigSurvey, phone, questionIds[0]).lastInsertRowid;

    // Each respondent answers a random number of questions (1 to 20)
    const answeredCount = Math.min(questionIds.length, (r % 20) + 1);
    for (let a = 0; a < answeredCount; a++) {
      const qid = questionIds[a];
      const resp = a < 15 ? String((r + a) % 5 + 1) : 'Write-in answer ' + r;
      db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)")
        .run(bigSurvey, sendId, qid, phone, resp);
    }

    if (answeredCount === 20) {
      db.prepare("UPDATE survey_sends SET status = 'completed', current_question_id = NULL WHERE id = ?").run(sendId);
    } else {
      db.prepare("UPDATE survey_sends SET status = 'in_progress', current_question_id = ? WHERE id = ?").run(questionIds[answeredCount - 1], sendId);
    }
  }
})();

const surveyStats = {
  totalSends: db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(bigSurvey).c,
  completed: db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(bigSurvey).c,
  inProgress: db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'in_progress'").get(bigSurvey).c,
  totalResponses: db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(bigSurvey).c,
};
assert(surveyStats.totalSends === 200, '200 survey sends');
assert(surveyStats.completed === 10, '10 completed (those who answered all 20)');
assert(surveyStats.inProgress === 190, '190 in progress');
assert(surveyStats.totalResponses > 1000, 'Over 1000 total responses (' + surveyStats.totalResponses + ')');

// Results aggregation (like /surveys/:id/results)
const t21 = Date.now();
for (const qid of questionIds) {
  db.prepare('SELECT response_text, COUNT(*) as c FROM survey_responses WHERE question_id = ? GROUP BY response_text').all(qid);
}
const t22 = Date.now();
assert(t22 - t21 < 1000, 'Survey results aggregation (20 questions) < 1s (took ' + (t22 - t21) + 'ms)');

// =============================================================================
// TEST 11: Stats query at full data scale
// =============================================================================
console.log('\n[11] Stats query at full scale...');

const t23 = Date.now();
for (let i = 0; i < 50; i++) {
  db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM contacts) as contacts,
      (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') as sent,
      (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') as responses,
      (SELECT COUNT(*) FROM opt_outs) as optedOut,
      (SELECT COUNT(*) FROM block_walks) as walks,
      (SELECT COUNT(*) FROM walk_addresses WHERE result != 'not_visited') as doorsKnocked,
      (SELECT COUNT(*) FROM voters) as voters,
      (SELECT COUNT(*) FROM events WHERE status = 'upcoming') as upcomingEvents
  `).get();
}
const t24 = Date.now();
assert(t24 - t23 < 3000, 'Stats x50 at full scale < 3s (took ' + (t24 - t23) + 'ms)');

// =============================================================================
// TEST 12: Memory pressure — large result sets
// =============================================================================
console.log('\n[12] Large result sets...');

const t25 = Date.now();
const allVoters = db.prepare('SELECT id, first_name, last_name, phone, city FROM voters').all();
const t26 = Date.now();
assert(allVoters.length === 50000, '50K voters fetched');
assert(t26 - t25 < 3000, '50K voter fetch < 3s (took ' + (t26 - t25) + 'ms)');

// Captain CSV import simulation: build phone map from all voters
const t27 = Date.now();
const phoneMap = {};
for (const v of allVoters) {
  const d = phoneDigits(v.phone);
  if (d.length >= 7) {
    if (!phoneMap[d]) phoneMap[d] = [];
    phoneMap[d].push(v);
  }
}
const t28 = Date.now();
assert(Object.keys(phoneMap).length > 40000, 'Phone map built (' + Object.keys(phoneMap).length + ' entries)');
assert(t28 - t27 < 2000, 'Phone map build < 2s (took ' + (t28 - t27) + 'ms)');

// =============================================================================
// TEST 13: Voter contacts (touchpoints) at scale
// =============================================================================
console.log('\n[13] Voter contacts at scale...');

db.transaction(() => {
  const ins = db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_by) VALUES (?, ?, ?, ?)");
  const types = ['text', 'call', 'door_knock', 'email', 'canvass'];
  const results = ['contacted', 'no_answer', 'refused', 'moved', 'wrong_number'];
  for (let i = 0; i < 20000; i++) {
    ins.run((i % 50000) + 1, types[i % 5], results[i % 5], 'Volunteer' + (i % 50));
  }
})();

// Touchpoint stats query (like server.js consolidated)
const t29 = Date.now();
const touchStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'text') as texts,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'call') as calls,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'door_knock') as knocks,
    (SELECT COUNT(*) FROM voter_contacts WHERE contact_type = 'email') as emails,
    (SELECT COUNT(DISTINCT voter_id) FROM voter_contacts) as uniqueVoters,
    (SELECT COUNT(*) FROM voter_contacts) as total
`).get();
const t30 = Date.now();
assert(touchStats.total === 20000, 'Touchpoints total=20K');
assert(touchStats.texts === 4000, 'Touchpoint texts=4K');
assert(t30 - t29 < 1000, 'Touchpoint stats < 1s (took ' + (t30 - t29) + 'ms)');

// =============================================================================
// TEST 14: FK constraint violations (should be rejected)
// =============================================================================
console.log('\n[14] FK constraint enforcement...');

// Try to create assignment with non-existent contact
let fkViolation = false;
try {
  db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)').run(sessId, 999999);
} catch (e) {
  fkViolation = e.message.includes('FOREIGN KEY');
}
assert(fkViolation, 'FK violation: non-existent contact rejected');

// Try to create walk address for non-existent walk
fkViolation = false;
try {
  db.prepare("INSERT INTO walk_addresses (walk_id, address) VALUES (?, ?)").run(999999, '123 Fake St');
} catch (e) {
  fkViolation = e.message.includes('FOREIGN KEY');
}
assert(fkViolation, 'FK violation: non-existent walk rejected');

// Try to create survey question for non-existent survey
fkViolation = false;
try {
  db.prepare("INSERT INTO survey_questions (survey_id, question_text) VALUES (?, ?)").run(999999, 'Bad Q');
} catch (e) {
  fkViolation = e.message.includes('FOREIGN KEY');
}
assert(fkViolation, 'FK violation: non-existent survey rejected');

// =============================================================================
// TEST 15: Database size and WAL health
// =============================================================================
console.log('\n[15] Database health...');

const walMode = db.pragma('journal_mode')[0].journal_mode;
assert(walMode === 'wal', 'WAL mode active');

const fkEnabled = db.pragma('foreign_keys')[0].foreign_keys;
assert(fkEnabled === 1, 'Foreign keys enabled');

const integrity = db.pragma('integrity_check')[0].integrity_check;
assert(integrity === 'ok', 'Integrity check passes');

// DB file size
const stats = fs.statSync(testDbPath);
const sizeMB = stats.size / 1024 / 1024;
console.log(' [DB size: ' + sizeMB.toFixed(1) + 'MB]');
assert(sizeMB < 200, 'DB size < 200MB (' + sizeMB.toFixed(1) + 'MB)');

// =============================================================================
// RESULTS
// =============================================================================
console.log('\n\n=== ROUND 3 RESULTS ===');
console.log('Passed: ' + passed + '/' + (passed + failed));
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log('  - ' + f));
}

db.close();
try { fs.unlinkSync(testDbPath); } catch (e) {}
process.exit(failed > 0 ? 1 : 0);
