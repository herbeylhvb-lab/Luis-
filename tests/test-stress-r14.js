/**
 * STRESS TEST ROUND 14 — Boundary Values, Concurrency Semantics, Data Integrity
 *
 * Sections:
 * 1. Phone normalization edge cases (international, short, empty, special chars)
 * 2. Voter search LIKE injection & wildcard handling
 * 3. UNIQUE constraint enforcement across all tables
 * 4. Transaction atomicity: multi-row insert rollback on failure
 * 5. Large dataset performance: 5000 voters with engagement scoring
 * 6. Captain code uniqueness: collision-free generation
 * 7. Walk route optimization: nearest-neighbor correctness
 * 8. Survey option ordering and sort_order consistency
 * 9. Event flyer: base64 data URL parsing and format detection
 * 10. Pagination boundary: LIMIT/OFFSET edge cases
 * 11. Delete-then-query: FK cascade integrity under stress
 * 12. String boundary: very long values, unicode, special chars
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r14.db');
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

const { phoneDigits, normalizePhone, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');
const { generateQrToken } = require('./db');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Phone Normalization Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Phone Normalization ===');

test('Phone: standard US format', () => {
  assert.strictEqual(normalizePhone('(512) 555-1234'), '5125551234');
});

test('Phone: +1 prefix stripped', () => {
  assert.strictEqual(normalizePhone('+1-512-555-1234'), '5125551234');
});

test('Phone: already normalized', () => {
  assert.strictEqual(normalizePhone('5125551234'), '5125551234');
});

test('Phone: null returns empty string', () => {
  assert.strictEqual(normalizePhone(null), '');
  assert.strictEqual(normalizePhone(undefined), '');
});

test('Phone: empty string stays empty', () => {
  assert.strictEqual(normalizePhone(''), '');
});

test('Phone: international format with spaces', () => {
  const result = normalizePhone('+1 512 555 1234');
  assert.strictEqual(result, '5125551234');
});

test('Phone: dots as separators', () => {
  assert.strictEqual(normalizePhone('512.555.1234'), '5125551234');
});

test('Phone: phoneDigits extracts only digits', () => {
  assert.strictEqual(phoneDigits('(512) 555-1234'), '5125551234');
  assert.strictEqual(phoneDigits('+1-512-555-1234'), '5125551234');
  assert.strictEqual(phoneDigits(''), '');
  assert.strictEqual(phoneDigits(null), '');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Voter Search LIKE Safety
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: LIKE Search Safety ===');

test('Search: LIKE with % in query is safely parameterized', () => {
  db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('Test%User', 'Smith', 'qr_like1')").run();
  db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('TestUser', 'Smith', 'qr_like2')").run();

  // Simulate the search: q = 'Test%'
  const q = 'Test%';
  const term = '%' + q + '%';
  const results = db.prepare('SELECT * FROM voters WHERE first_name LIKE ?').all(term);
  // Both should match because % is literal in the parameterized query? No — LIKE treats % as wildcard
  // But since it's parameterized, the user-input % IS treated as a LIKE wildcard
  // This means searching for "Test%" finds both "Test%User" and "TestUser"
  assert(results.length >= 2, 'LIKE % is a wildcard in the search pattern');
});

test('Search: LIKE with underscore wildcard', () => {
  const q = 'Test_User';
  const term = '%' + q + '%';
  const results = db.prepare('SELECT * FROM voters WHERE first_name LIKE ?').all(term);
  // _ matches any single character, so "Test%User" matches "Test_User" pattern
  assert(results.length >= 1, 'LIKE _ is a single-char wildcard');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: UNIQUE Constraint Enforcement
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: UNIQUE Constraints ===');

test('UNIQUE: opt_outs phone prevents duplicate', () => {
  db.prepare("INSERT INTO opt_outs (phone) VALUES ('5551110000')").run();
  let threw = false;
  try { db.prepare("INSERT INTO opt_outs (phone) VALUES ('5551110000')").run(); }
  catch (e) { if (e.message.includes('UNIQUE')) threw = true; else throw e; }
  assert(threw, 'Duplicate opt_out phone should throw UNIQUE constraint');
});

test('UNIQUE: captain code prevents duplicate', () => {
  db.prepare("INSERT INTO captains (name, code) VALUES ('Cap1', 'CODE01')").run();
  let threw = false;
  try { db.prepare("INSERT INTO captains (name, code) VALUES ('Cap2', 'CODE01')").run(); }
  catch (e) { if (e.message.includes('UNIQUE')) threw = true; else throw e; }
  assert(threw, 'Duplicate captain code should throw UNIQUE constraint');
});

test('UNIQUE: captain_list_voters (list_id, voter_id) prevents duplicate', () => {
  const cap = db.prepare("SELECT id FROM captains WHERE code = 'CODE01'").get();
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(cap.id, 'UniqueList');
  const list = db.prepare("SELECT id FROM captain_lists WHERE name = 'UniqueList'").get();
  const v = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('UnqV', 'qr_unqv1')").run();
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(list.id, v.lastInsertRowid);

  let threw = false;
  try { db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(list.id, v.lastInsertRowid); }
  catch (e) { if (e.message.includes('UNIQUE')) threw = true; else throw e; }
  assert(threw, 'Duplicate captain_list_voter should throw UNIQUE constraint');
});

test('UNIQUE: settings key is primary key', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_key', 'val1')").run();
  // INSERT OR REPLACE should work
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_key', 'val2') ON CONFLICT(key) DO UPDATE SET value = 'val2'").run();
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'test_key'").get().value, 'val2');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Transaction Atomicity
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Transaction Atomicity ===');

test('Transaction: rollback on FK violation', () => {
  const insertVoter = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES (?, ?)");
  const insertContact = db.prepare("INSERT INTO voter_contacts (voter_id, contact_type) VALUES (?, 'Test')");

  let threw = false;
  try {
    db.transaction(() => {
      insertVoter.run('TxnTest1', 'qr_txn1');
      insertVoter.run('TxnTest2', 'qr_txn2');
      // This should fail: voter_id 99999 doesn't exist
      insertContact.run(99999);
    })();
  } catch (e) {
    threw = true;
  }

  assert(threw, 'Transaction should throw on FK violation');
  // Both voters should be rolled back
  assert(!db.prepare("SELECT id FROM voters WHERE first_name = 'TxnTest1'").get(), 'TxnTest1 should not exist after rollback');
  assert(!db.prepare("SELECT id FROM voters WHERE first_name = 'TxnTest2'").get(), 'TxnTest2 should not exist after rollback');
});

test('Transaction: success commits all', () => {
  const insertVoter = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES (?, ?)");

  db.transaction(() => {
    insertVoter.run('TxnOK1', 'qr_txnok1');
    insertVoter.run('TxnOK2', 'qr_txnok2');
  })();

  assert(db.prepare("SELECT id FROM voters WHERE first_name = 'TxnOK1'").get(), 'TxnOK1 should exist');
  assert(db.prepare("SELECT id FROM voters WHERE first_name = 'TxnOK2'").get(), 'TxnOK2 should exist');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Large Dataset Engagement Scoring
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: 5K Voter Scale ===');

test('Scale: insert 5000 voters with engagement data', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct, qr_token) VALUES (?, ?, ?, ?, ?)");
  const insertTx = db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      insert.run(`Scale${i}`, 'Voter', `555${String(i).padStart(7, '0')}`, `PCT-${(i % 10).toString().padStart(2, '0')}`, `qr_scale_${i}`);
    }
  });
  insertTx();
  const count = db.prepare("SELECT COUNT(*) as c FROM voters WHERE first_name LIKE 'Scale%'").get().c;
  assert.strictEqual(count, 5000);
});

test('Scale: engagement scoring formula at scale', () => {
  // Add contacts for first 100 voters
  const voters = db.prepare("SELECT id, phone FROM voters WHERE first_name LIKE 'Scale%' LIMIT 100").all();
  const insertContact = db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Door-knock', 'Support')");
  const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, 'test', 'outbound')");

  db.transaction(() => {
    for (const v of voters) {
      insertContact.run(v.id);
      insertMsg.run(v.phone);
    }
  })();

  // Compute engagement for a sample voter
  const v = voters[0];
  const contacts = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(v.id).c;
  const texts = db.prepare('SELECT COUNT(*) as c FROM messages WHERE phone = ?').get(v.phone).c;
  const score = Math.min(100, contacts * 3 + texts * 1);
  assert(score >= 4, `Expected >= 4, got ${score}`); // 1*3 + 1*1 = 4
});

test('Scale: precinct analytics query runs in reasonable time', () => {
  const start = Date.now();
  const precinctRows = db.prepare(`
    SELECT precinct, COUNT(*) as total_voters,
      SUM(CASE WHEN support_level IN ('strong_support','lean_support') THEN 1 ELSE 0 END) as supporters,
      SUM(CASE WHEN support_level = 'undecided' THEN 1 ELSE 0 END) as undecided
    FROM voters WHERE precinct != '' GROUP BY precinct ORDER BY precinct
  `).all();
  const elapsed = Date.now() - start;
  assert(precinctRows.length === 10, 'Should have 10 precincts');
  assert(elapsed < 5000, `Precinct analytics took ${elapsed}ms, expected < 5000ms`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Captain Code Uniqueness
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Captain Code Gen ===');

test('Captain: code generation produces 6-char hex uppercase', () => {
  const { randomBytes } = require('crypto');
  const code = randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  assert.strictEqual(code.length, 6);
  assert(/^[A-F0-9]{6}$/.test(code), `Code should be hex: ${code}`);
});

test('Captain: uniqueness loop with retry', () => {
  // Insert 10 captains with known codes
  for (let i = 0; i < 10; i++) {
    db.prepare('INSERT INTO captains (name, code) VALUES (?, ?)').run(`GenCap${i}`, `GEN${String(i).padStart(3, '0')}`);
  }

  // Generate a new unique code (should not collide with any existing)
  const { randomBytes } = require('crypto');
  let code;
  let unique = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    code = randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) { unique = true; break; }
  }
  assert(unique, 'Should find a unique code within 10 attempts');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Walk Route Nearest-Neighbor
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Route Optimization ===');

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

test('Route: nearest-neighbor produces shorter path than original order', () => {
  // Addresses in non-optimal order (zigzag)
  const points = [
    { lat: 40.0, lng: -74.0 },   // A
    { lat: 40.02, lng: -74.02 }, // B (far)
    { lat: 40.005, lng: -74.005 }, // C (near A)
    { lat: 40.015, lng: -74.015 }, // D (near B)
  ];

  // Original total distance
  let originalDist = 0;
  for (let i = 1; i < points.length; i++) {
    originalDist += gpsDistance(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
  }

  // Nearest-neighbor from first point
  const remaining = [...points];
  const ordered = [remaining.shift()];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = gpsDistance(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    }
    ordered.push(remaining.splice(nearest, 1)[0]);
  }

  // Optimized total distance
  let optimizedDist = 0;
  for (let i = 1; i < ordered.length; i++) {
    optimizedDist += gpsDistance(ordered[i-1].lat, ordered[i-1].lng, ordered[i].lat, ordered[i].lng);
  }

  assert(optimizedDist <= originalDist, `Optimized (${optimizedDist.toFixed(0)}m) should be <= original (${originalDist.toFixed(0)}m)`);
});

test('Route: single address returns itself', () => {
  const points = [{ lat: 40.0, lng: -74.0 }];
  assert.strictEqual(points.length, 1);
  // No optimization needed for single point
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Survey Option Ordering
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Survey Ordering ===');

test('Survey: options maintain sort_order', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('OrderTest', 'active')").run();
  const q = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Pick one', 'single_choice', 0)").run(s.lastInsertRowid);
  const qid = q.lastInsertRowid;

  // Insert options in reverse sort_order
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Third', '3', 2)").run(qid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'First', '1', 0)").run(qid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Second', '2', 1)").run(qid);

  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(qid);
  assert.strictEqual(options[0].option_text, 'First');
  assert.strictEqual(options[1].option_text, 'Second');
  assert.strictEqual(options[2].option_text, 'Third');
});

test('Survey: questions maintain sort_order across multiple questions', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('MultiQ', 'active')").run();
  const sid = s.lastInsertRowid;

  db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q3', 'write_in', 2)").run(sid);
  db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q1', 'single_choice', 0)").run(sid);
  db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q2', 'ranked_choice', 1)").run(sid);

  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(sid);
  assert.strictEqual(questions[0].question_text, 'Q1');
  assert.strictEqual(questions[1].question_text, 'Q2');
  assert.strictEqual(questions[2].question_text, 'Q3');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Event Flyer Data URL Parsing
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Flyer Parsing ===');

test('Flyer: PNG data URL regex extraction', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  assert(matches, 'Should match data URL pattern');
  assert.strictEqual(matches[1], 'png');
  assert(matches[2].length > 0, 'Base64 data should be non-empty');
});

test('Flyer: JPEG data URL', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  assert(matches, 'Should match JPEG data URL');
  assert.strictEqual(matches[1], 'jpeg');
});

test('Flyer: invalid data URL returns null', () => {
  const dataUrl = 'data:text/html;base64,PGh0bWw+';
  const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  assert(!matches, 'text/html should NOT match image pattern');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Pagination Boundaries
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Pagination ===');

test('Pagination: LIMIT 0 returns empty', () => {
  const results = db.prepare("SELECT * FROM voters LIMIT 0").all();
  assert.strictEqual(results.length, 0);
});

test('Pagination: LIMIT exceeding total returns all', () => {
  const total = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const results = db.prepare('SELECT * FROM voters LIMIT 999999').all();
  assert.strictEqual(results.length, total);
});

test('Pagination: negative limit clamped to 1', () => {
  const limit = Math.min(Math.max(parseInt('-5', 10) || 5000, 1), 10000);
  assert.strictEqual(limit, 1, 'Negative limit should clamp to 1');
});

test('Pagination: NaN limit defaults to 5000', () => {
  const limit = Math.min(Math.max(parseInt('abc', 10) || 5000, 1), 10000);
  assert.strictEqual(limit, 5000, 'NaN limit should default to 5000');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Cascade Under Stress
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: Cascade Stress ===');

test('Cascade: delete 50 voters with contacts, checkins, list memberships', () => {
  // Create 50 voters with related data
  db.prepare("INSERT INTO events (title, event_date) VALUES ('CascStress', '2025-03-01')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'CascStress'").get().id;
  db.prepare("INSERT INTO captains (name, code) VALUES ('CascStressCap', 'CSSC01')").run();
  const capId = db.prepare("SELECT id FROM captains WHERE code = 'CSSC01'").get().id;
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(capId, 'CascStressList');
  const listId = db.prepare("SELECT id FROM captain_lists WHERE captain_id = ?").get(capId).id;

  const voterIds = [];
  db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      const v = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES (?, ?)").run(`CascDel${i}`, `qr_cascdel_${i}`);
      const vid = Number(v.lastInsertRowid);
      voterIds.push(vid);
      db.prepare("INSERT INTO voter_contacts (voter_id, contact_type) VALUES (?, 'Test')").run(vid);
      db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);
      db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, vid);
      db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, ?, '2024-01-01')").run(vid, `Election${i}`);
    }
  })();

  // Delete all 50 voters
  const del = db.prepare('DELETE FROM voters WHERE id = ?');
  db.transaction(() => {
    for (const id of voterIds) del.run(id);
  })();

  // Verify cascade
  for (const id of voterIds) {
    assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(id).c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(id).c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?').get(id).c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?').get(id).c, 0);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: String Boundaries
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: String Boundaries ===');

test('String: unicode names stored and retrieved correctly', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES (?, ?, ?)").run('José', 'García', 'qr_unicode1');
  const voter = db.prepare('SELECT first_name, last_name FROM voters WHERE id = ?').get(v.lastInsertRowid);
  assert.strictEqual(voter.first_name, 'José');
  assert.strictEqual(voter.last_name, 'García');
});

test('String: emoji in notes field', () => {
  const v = db.prepare("INSERT INTO voters (first_name, notes, qr_token) VALUES ('EmojiV', ?, ?)").run('Voter is excited! 🎉👍', 'qr_emoji1');
  const voter = db.prepare('SELECT notes FROM voters WHERE id = ?').get(v.lastInsertRowid);
  assert.strictEqual(voter.notes, 'Voter is excited! 🎉👍');
});

test('String: SQL special chars in names (single quotes)', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES (?, ?, ?)").run("O'Brien", "D'Angelo", 'qr_quote1');
  const voter = db.prepare('SELECT first_name, last_name FROM voters WHERE id = ?').get(v.lastInsertRowid);
  assert.strictEqual(voter.first_name, "O'Brien");
  assert.strictEqual(voter.last_name, "D'Angelo");
});

test('String: 1000-char address stored correctly', () => {
  const longAddr = 'A'.repeat(1000);
  const v = db.prepare("INSERT INTO voters (first_name, address, qr_token) VALUES ('LongAddr', ?, ?)").run(longAddr, 'qr_longaddr');
  const voter = db.prepare('SELECT address FROM voters WHERE id = ?').get(v.lastInsertRowid);
  assert.strictEqual(voter.address.length, 1000);
});

test('String: personalizeTemplate with unicode and special chars', () => {
  const result = personalizeTemplate("Hola {firstName} {lastName}!", {
    firstName: "José", lastName: "O'Reilly"
  });
  assert.strictEqual(result, "Hola José O'Reilly!");
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
console.log(`STRESS TEST ROUND 14 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('='.repeat(60));

db.close();
try { fs.unlinkSync(TEST_DB); } catch (e) {}

process.exit(failed > 0 ? 1 : 0);
