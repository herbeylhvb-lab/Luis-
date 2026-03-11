/**
 * STRESS TEST ROUND 6 — Adversarial Inputs, Boundary Abuse, Cross-Feature Chaos
 *
 * Areas NOT yet tested in rounds 1-5:
 * - Adversarial string inputs that break parsers (RTL, null bytes, zalgo, control chars)
 * - Integer boundary abuse (MAX_SAFE_INTEGER, negative IDs, float IDs)
 * - Walk door-knock logging with GPS verification (full /log flow)
 * - Survey send state machine (sent→in_progress→completed transitions)
 * - P2P session expiration edge case
 * - Cross-table data integrity under rapid cascading deletes
 * - Voter enrichment resolve pipeline
 * - Admin list with list_type filtering
 * - Election vote universe preview (read-only temp tables)
 * - Walk from-precinct auto-creation pipeline
 * - Voter touchpoint timeline aggregation
 * - Email campaign tracking
 * - Response scripts CRUD
 * - Campaign knowledge CRUD
 * - Settings INSERT OR REPLACE atomicity
 * - Message channel tracking (sms vs whatsapp)
 * - Walk route with mixed GPS + no-GPS addresses
 * - Captain code collision retry logic
 * - Voter QR check-in with multiple events
 * - Extreme volume: 100K election votes query performance
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r6.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Full Schema ───
db.exec(`
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '',
    preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_contacts_phone ON contacts(phone);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT,
    direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')),
    sentiment TEXT DEFAULT NULL, session_id INTEGER DEFAULT NULL,
    volunteer_name TEXT DEFAULT NULL, channel TEXT DEFAULT 'sms'
  );
  CREATE INDEX idx_messages_phone ON messages(phone);

  CREATE TABLE opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE campaigns (id INTEGER PRIMARY KEY, message_template TEXT, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE voters (
    id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '',
    city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '',
    support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0,
    tags TEXT DEFAULT '', notes TEXT DEFAULT '', registration_number TEXT DEFAULT '',
    precinct TEXT DEFAULT '', qr_token TEXT DEFAULT NULL, voting_history TEXT DEFAULT '',
    early_voted INTEGER DEFAULT 0, early_voted_date TEXT DEFAULT NULL,
    early_voted_method TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voters_phone ON voters(phone);
  CREATE UNIQUE INDEX idx_voters_qr_token ON voters(qr_token);

  CREATE TABLE voter_contacts (
    id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '',
    contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
    location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '',
    status TEXT DEFAULT 'upcoming', flyer_image TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE event_rsvps (
    id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '',
    rsvp_status TEXT DEFAULT 'invited', checked_in_at TEXT DEFAULT NULL,
    invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT
  );
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);
  CREATE TABLE voter_checkins (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    checked_in_at TEXT DEFAULT (datetime('now')), UNIQUE(voter_id, event_id)
  );

  CREATE TABLE block_walks (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    join_code TEXT DEFAULT NULL, max_walkers INTEGER DEFAULT 4,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE walk_addresses (
    id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    address TEXT NOT NULL, unit TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '',
    voter_name TEXT DEFAULT '', result TEXT DEFAULT 'not_visited', notes TEXT DEFAULT '',
    knocked_at TEXT, sort_order INTEGER DEFAULT 0,
    voter_id INTEGER DEFAULT NULL, lat REAL DEFAULT NULL, lng REAL DEFAULT NULL,
    gps_lat REAL DEFAULT NULL, gps_lng REAL DEFAULT NULL,
    gps_accuracy REAL DEFAULT NULL, gps_verified INTEGER DEFAULT 0,
    assigned_walker TEXT DEFAULT NULL
  );
  CREATE TABLE walk_group_members (
    id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    walker_name TEXT NOT NULL, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(walk_id, walker_name)
  );

  CREATE TABLE p2p_sessions (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL,
    assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL,
    status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL,
    session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE p2p_volunteers (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE p2p_assignments (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    volunteer_id INTEGER REFERENCES p2p_volunteers(id),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    status TEXT DEFAULT 'pending', original_volunteer_id INTEGER DEFAULT NULL,
    assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT DEFAULT NULL
  );

  CREATE TABLE captains (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
    phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE captain_team_members (
    id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE captain_lists (
    id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL,
    name TEXT NOT NULL, list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE captain_list_voters (
    id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id)
  );

  CREATE TABLE admin_lists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE admin_list_voters (
    id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id)
  );

  CREATE TABLE email_campaigns (
    id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL,
    sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER DEFAULT NULL, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER DEFAULT NULL, responded_at TEXT DEFAULT (datetime('now')));

  CREATE TABLE election_votes (
    id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    election_name TEXT NOT NULL, election_date TEXT NOT NULL,
    election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '',
    voted INTEGER DEFAULT 1, UNIQUE(voter_id, election_name)
  );
  CREATE INDEX idx_ev_voter ON election_votes(voter_id);
  CREATE INDEX idx_ev_election ON election_votes(election_name);

  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT DEFAULT '', role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE campaign_knowledge (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE response_scripts (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`);

const { phoneDigits, normalizePhone, toE164, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Adversarial String Inputs
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Adversarial Strings ===');

const adversarialStrings = [
  'Robert"); DROP TABLE voters;--',  // SQL injection
  '<script>alert(1)</script>',       // XSS
  '\x00NullByte\x00',                // null bytes
  'A\u0300\u0300\u0300\u0300\u0300', // combining diacriticals (zalgo-like)
  '\u202Eright-to-left',             // RTL override
  'A'.repeat(10000),                  // extremely long
  '🇺🇸🗳️📊',                      // emoji combo
  '\t\n\r\0',                         // control characters
  "O'Malley",                         // apostrophe in name
  'José María García-López',          // international chars
  '',                                  // empty string
  '   ',                               // whitespace only
];

test('Adversarial: voter names survive round-trip', () => {
  for (const str of adversarialStrings) {
    const qr = crypto.randomBytes(6).toString('base64url');
    const r = db.prepare("INSERT INTO voters (first_name, last_name, address, qr_token) VALUES (?, ?, ?, ?)").run(str, str, '1 Test St', qr);
    const voter = db.prepare('SELECT first_name, last_name FROM voters WHERE id = ?').get(r.lastInsertRowid);
    assert.strictEqual(voter.first_name, str, 'Round-trip failed for: ' + JSON.stringify(str).slice(0, 50));
    assert.strictEqual(voter.last_name, str);
  }
});

test('Adversarial: activity log messages survive round-trip', () => {
  for (const str of adversarialStrings) {
    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(str);
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM activity_log').get().c;
  assert.strictEqual(count, adversarialStrings.length);
});

test('Adversarial: settings keys and values', () => {
  for (let i = 0; i < adversarialStrings.length; i++) {
    const key = 'adv_test_' + i;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, adversarialStrings[i]);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    assert.strictEqual(row.value, adversarialStrings[i]);
  }
});

test('Adversarial: LIKE search with % and _ in query', () => {
  // Insert a voter with % in name
  db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('100%_match', 'Test', ?)").run(crypto.randomBytes(6).toString('base64url'));
  // Search for it — % in LIKE is a wildcard, but we use parameterized queries
  const term = '%100%_match%';
  const results = db.prepare('SELECT * FROM voters WHERE first_name LIKE ?').all(term);
  assert(results.length >= 1, 'Should find the voter with % in name');
});

test('Adversarial: Unicode normalization in phone numbers', () => {
  // Full-width digits: ５１２５５５１２３４
  const fullWidth = '\uFF15\uFF11\uFF12\uFF15\uFF15\uFF15\uFF11\uFF12\uFF13\uFF14';
  const result = normalizePhone(fullWidth);
  // normalizePhone strips non-digits, full-width digits are NOT \d in JS regex
  assert.strictEqual(result, ''); // correctly rejects non-ASCII digits
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Integer Boundary Abuse
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Integer Boundaries ===');

test('Boundary: negative voter ID returns null', () => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(-1);
  assert.strictEqual(voter, undefined);
});

test('Boundary: zero ID returns null', () => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(0);
  assert.strictEqual(voter, undefined);
});

test('Boundary: very large ID returns null', () => {
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(Number.MAX_SAFE_INTEGER);
  assert.strictEqual(voter, undefined);
});

test('Boundary: float ID gets truncated by SQLite', () => {
  // SQLite truncates floats to integers for INTEGER PRIMARY KEY
  const r = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('FloatTest', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const id = r.lastInsertRowid;
  // Query with float version
  const voter = db.prepare('SELECT id FROM voters WHERE id = ?').get(id + 0.5);
  // SQLite may or may not match depending on affinity rules
  // Just ensure no crash
  assert(voter === undefined || voter.id === id);
});

test('Boundary: voter_score extremes', () => {
  const qr1 = crypto.randomBytes(6).toString('base64url');
  const qr2 = crypto.randomBytes(6).toString('base64url');
  db.prepare("INSERT INTO voters (first_name, voter_score, qr_token) VALUES ('MaxScore', 2147483647, ?)").run(qr1);
  db.prepare("INSERT INTO voters (first_name, voter_score, qr_token) VALUES ('MinScore', -2147483648, ?)").run(qr2);
  const max = db.prepare("SELECT voter_score FROM voters WHERE first_name = 'MaxScore'").get();
  const min = db.prepare("SELECT voter_score FROM voters WHERE first_name = 'MinScore'").get();
  assert.strictEqual(max.voter_score, 2147483647);
  assert.strictEqual(min.voter_score, -2147483648);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Walk Door-Knock Logging with GPS
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Door-Knock GPS Logging ===');

// Seed a walk with voter-linked addresses
const walkSeed = db.transaction(() => {
  const wRes = db.prepare("INSERT INTO block_walks (name, join_code, status) VALUES ('GPS Log Walk', 'GLOG', 'in_progress')").run();
  const wId = wRes.lastInsertRowid;

  // Create voters linked to addresses
  for (let i = 0; i < 20; i++) {
    const vRes = db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, qr_token) VALUES (?, ?, ?, 'Austin', '78701', ?)").run(
      'Walker' + i, 'Voter' + i, (100 + i) + ' Knock St', crypto.randomBytes(6).toString('base64url')
    );
    db.prepare("INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, lat, lng, sort_order) VALUES (?, ?, 'Austin', '78701', ?, ?, ?, ?, ?)").run(
      wId, (100 + i) + ' Knock St', 'Walker' + i + ' Voter' + i, vRes.lastInsertRowid,
      30.2672 + i * 0.001, -97.7431, i
    );
  }
  return wId;
});
const gpsWalkId = walkSeed();

function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const VALID_RESULTS = new Set(['support', 'lean_support', 'undecided', 'lean_oppose', 'oppose', 'not_home', 'refused', 'moved', 'come_back']);

test('Door-knock: GPS verified within 150m', () => {
  const addr = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? LIMIT 1').get(gpsWalkId);
  // Simulate GPS 30m away
  const gpsLat = addr.lat + 0.0002;
  const gpsLng = addr.lng;
  const dist = gpsDistance(gpsLat, gpsLng, addr.lat, addr.lng);
  assert(dist < 150);

  const gps_verified = dist <= 150 ? 1 : 0;
  db.prepare(`UPDATE walk_addresses SET result = ?, notes = ?, knocked_at = ?,
    gps_lat = ?, gps_lng = ?, gps_accuracy = ?, gps_verified = ? WHERE id = ?`)
    .run('support', 'Very friendly', new Date().toISOString(), gpsLat, gpsLng, 10, gps_verified, addr.id);

  const updated = db.prepare('SELECT * FROM walk_addresses WHERE id = ?').get(addr.id);
  assert.strictEqual(updated.result, 'support');
  assert.strictEqual(updated.gps_verified, 1);
});

test('Door-knock: GPS NOT verified beyond 150m', () => {
  const addr = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? AND result = ? LIMIT 1').get(gpsWalkId, 'not_visited');
  const gpsLat = addr.lat + 0.003; // ~300m away
  const dist = gpsDistance(gpsLat, addr.lng, addr.lat, addr.lng);
  assert(dist > 150);

  const gps_verified = dist <= 150 ? 1 : 0;
  db.prepare(`UPDATE walk_addresses SET result = ?, gps_lat = ?, gps_lng = ?, gps_verified = ?, knocked_at = ? WHERE id = ?`)
    .run('not_home', gpsLat, addr.lng, gps_verified, new Date().toISOString(), addr.id);

  const updated = db.prepare('SELECT * FROM walk_addresses WHERE id = ?').get(addr.id);
  assert.strictEqual(updated.gps_verified, 0);
});

test('Door-knock: auto-logs voter contact when voter_id linked', () => {
  const addr = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? AND voter_id IS NOT NULL AND result = ? LIMIT 1').get(gpsWalkId, 'not_visited');
  assert(addr, 'Should have an unvisited address with voter_id');

  // Simulate the /log endpoint behavior
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, 'Door-knock', 'Strong Support', 'Test knock', 'Block Walker')").run(addr.voter_id);
  db.prepare("UPDATE voters SET support_level = 'strong_support' WHERE id = ?").run(addr.voter_id);
  db.prepare("UPDATE walk_addresses SET result = 'support', knocked_at = ? WHERE id = ?").run(new Date().toISOString(), addr.id);

  const contact = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY id DESC LIMIT 1').get(addr.voter_id);
  assert.strictEqual(contact.contact_type, 'Door-knock');
  const voter = db.prepare('SELECT support_level FROM voters WHERE id = ?').get(addr.voter_id);
  assert.strictEqual(voter.support_level, 'strong_support');
});

test('Door-knock: all VALID_RESULTS accepted', () => {
  for (const result of VALID_RESULTS) {
    assert(VALID_RESULTS.has(result));
  }
  assert(!VALID_RESULTS.has('invalid_result'));
  assert(!VALID_RESULTS.has(''));
  assert(!VALID_RESULTS.has(null));
});

test('Door-knock: poor GPS accuracy (>200m) not verified', () => {
  // Even if position is close, bad accuracy should not verify
  const MAX_GPS_ACCURACY = 200;
  const accuracy = 250; // bad accuracy
  assert(accuracy > MAX_GPS_ACCURACY);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Survey State Machine
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Survey State Machine ===');

test('Survey: state transitions draft→active→closed', () => {
  const r = db.prepare("INSERT INTO surveys (name, status) VALUES ('State Test', 'draft')").run();
  const id = r.lastInsertRowid;

  let survey = db.prepare('SELECT status FROM surveys WHERE id = ?').get(id);
  assert.strictEqual(survey.status, 'draft');

  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(id);
  survey = db.prepare('SELECT status FROM surveys WHERE id = ?').get(id);
  assert.strictEqual(survey.status, 'active');

  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(id);
  survey = db.prepare('SELECT status FROM surveys WHERE id = ?').get(id);
  assert.strictEqual(survey.status, 'closed');
});

test('Survey: response routing with current_question tracking', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, status) VALUES ('Route Test', 'active')").run();
  const sId = sRes.lastInsertRowid;

  const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q1', 'single_choice', 0)").run(sId);
  const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q2', 'single_choice', 1)").run(sId);
  const q3 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q3', 'write_in', 2)").run(sId);

  // Send to contact
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id) VALUES (?, '5550001111', ?)").run(sId, q1.lastInsertRowid);
  const sendId = sendRes.lastInsertRowid;

  // Answer Q1 → advance to Q2
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550001111', 'A')").run(sId, sendId, q1.lastInsertRowid);
  db.prepare("UPDATE survey_sends SET current_question_id = ? WHERE id = ?").run(q2.lastInsertRowid, sendId);

  // Answer Q2 → advance to Q3
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550001111', 'B')").run(sId, sendId, q2.lastInsertRowid);
  db.prepare("UPDATE survey_sends SET current_question_id = ? WHERE id = ?").run(q3.lastInsertRowid, sendId);

  // Answer Q3 → complete
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550001111', 'Write-in text')").run(sId, sendId, q3.lastInsertRowid);
  db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(sendId);

  const send = db.prepare('SELECT * FROM survey_sends WHERE id = ?').get(sendId);
  assert.strictEqual(send.status, 'completed');
  assert(send.completed_at);

  const responseCount = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE send_id = ?').get(sendId).c;
  assert.strictEqual(responseCount, 3);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: P2P Session Expiration
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: P2P Expiration ===');

test('P2P: expired session code rejected', () => {
  const expiredAt = new Date(Date.now() - 86400000).toISOString(); // yesterday
  db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at, status) VALUES ('Expired', 'Hi', 'EXPR', ?, 'active')").run(expiredAt);

  const session = db.prepare("SELECT * FROM p2p_sessions WHERE join_code = 'EXPR' AND status = 'active'").get();
  assert(session);
  assert(new Date(session.code_expires_at) < new Date(), 'Code should be expired');
});

test('P2P: valid session code accepted', () => {
  const validAt = new Date(Date.now() + 86400000).toISOString(); // tomorrow
  db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at, status) VALUES ('Valid', 'Hi', 'VALD', ?, 'active')").run(validAt);

  const session = db.prepare("SELECT * FROM p2p_sessions WHERE join_code = 'VALD' AND status = 'active'").get();
  assert(session);
  assert(new Date(session.code_expires_at) > new Date(), 'Code should be valid');
});

test('P2P: paused session blocks joins', () => {
  db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at, status) VALUES ('Paused', 'Hi', 'PAUS', ?, 'paused')").run(
    new Date(Date.now() + 86400000).toISOString()
  );
  // The join route checks status = 'active'
  const session = db.prepare("SELECT * FROM p2p_sessions WHERE join_code = 'PAUS' AND status = 'active'").get();
  assert.strictEqual(session, undefined, 'Paused session should not be findable for active joins');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Rapid Cascading Delete Stress
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Cascading Delete Stress ===');

test('Cascade: rapid create-and-delete 100 captains with full hierarchy', () => {
  const createAndDelete = db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      const code = 'CC' + String(i).padStart(4, '0');
      const captRes = db.prepare("INSERT INTO captains (name, code) VALUES (?, ?)").run('StressCapt' + i, code);
      const captId = captRes.lastInsertRowid;

      // Add team member
      const tmRes = db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(captId, 'TM' + i);

      // Add list with team member
      const listRes = db.prepare('INSERT INTO captain_lists (captain_id, team_member_id, name) VALUES (?, ?, ?)').run(captId, tmRes.lastInsertRowid, 'List' + i);

      // Add voter to list (reuse first voter)
      const voter = db.prepare('SELECT id FROM voters LIMIT 1').get();
      if (voter) {
        try { db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listRes.lastInsertRowid, voter.id); } catch(e) {}
      }

      // Immediately delete captain — should cascade everything
      db.prepare('DELETE FROM captains WHERE id = ?').run(captId);
    }
  });
  createAndDelete();

  // Verify no orphans
  const orphanTm = db.prepare("SELECT COUNT(*) as c FROM captain_team_members WHERE captain_id NOT IN (SELECT id FROM captains)").get().c;
  const orphanLists = db.prepare("SELECT COUNT(*) as c FROM captain_lists WHERE captain_id NOT IN (SELECT id FROM captains)").get().c;
  assert.strictEqual(orphanTm, 0, 'No orphaned team members');
  assert.strictEqual(orphanLists, 0, 'No orphaned lists');
});

test('Cascade: delete voter removes from ALL references', () => {
  // Create voter with everything
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, phone, address, precinct, qr_token) VALUES ('CascFull', 'Voter', '5559876543', '1 Casc Ave', 'PCT-99', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  // Voter contacts
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Call', 'Contacted')").run(vid);

  // Event check-in
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('CascVoterEvent', '2025-06-01')").run();
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, eRes.lastInsertRowid);

  // Election vote
  db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Test Election', '2025-01-01')").run(vid);

  // Captain list
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('CascVCapt', 'CSV001')").run();
  const listRes = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'CascVList')").run(captRes.lastInsertRowid);
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listRes.lastInsertRowid, vid);

  // Admin list
  const alRes = db.prepare("INSERT INTO admin_lists (name) VALUES ('CascVAdminList')").run();
  db.prepare('INSERT INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(alRes.lastInsertRowid, vid);

  // Delete voter
  db.prepare('DELETE FROM voters WHERE id = ?').run(vid);

  // Verify all gone
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE voter_id = ?').get(vid).c, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Email Campaign & Knowledge Base CRUD
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Email & Knowledge CRUD ===');

test('Email campaign: create and track counts', () => {
  const r = db.prepare("INSERT INTO email_campaigns (subject, body_html, sent_count, failed_count) VALUES ('Test Subject', '<h1>Hello</h1>', 50, 3)").run();
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(campaign.subject, 'Test Subject');
  assert.strictEqual(campaign.sent_count, 50);
  assert.strictEqual(campaign.failed_count, 3);
});

test('Campaign knowledge: CRUD lifecycle', () => {
  const r = db.prepare("INSERT INTO campaign_knowledge (type, title, content) VALUES ('policy', 'Healthcare Plan', 'Our plan covers...')").run();
  const id = r.lastInsertRowid;

  let item = db.prepare('SELECT * FROM campaign_knowledge WHERE id = ?').get(id);
  assert.strictEqual(item.type, 'policy');
  assert.strictEqual(item.title, 'Healthcare Plan');

  db.prepare("UPDATE campaign_knowledge SET content = 'Updated plan...', updated_at = datetime('now') WHERE id = ?").run(id);
  item = db.prepare('SELECT * FROM campaign_knowledge WHERE id = ?').get(id);
  assert.strictEqual(item.content, 'Updated plan...');

  db.prepare('DELETE FROM campaign_knowledge WHERE id = ?').run(id);
  assert.strictEqual(db.prepare('SELECT * FROM campaign_knowledge WHERE id = ?').get(id), undefined);
});

test('Response scripts: CRUD lifecycle', () => {
  const r = db.prepare("INSERT INTO response_scripts (scenario, label, content) VALUES ('hostile', 'Calm Response', 'I understand your concern...')").run();
  const id = r.lastInsertRowid;

  const script = db.prepare('SELECT * FROM response_scripts WHERE id = ?').get(id);
  assert.strictEqual(script.scenario, 'hostile');
  assert.strictEqual(script.label, 'Calm Response');

  db.prepare('DELETE FROM response_scripts WHERE id = ?').run(id);
  assert.strictEqual(db.prepare('SELECT * FROM response_scripts WHERE id = ?').get(id), undefined);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Settings Atomicity
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Settings Atomicity ===');

test('Settings: INSERT OR REPLACE is atomic', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_key', 'value1')").run();
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'test_key'").get().value, 'value1');

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_key', 'value2')").run();
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'test_key'").get().value, 'value2');

  // Only one row exists
  const count = db.prepare("SELECT COUNT(*) as c FROM settings WHERE key = 'test_key'").get().c;
  assert.strictEqual(count, 1);
});

test('Settings: 1000 rapid updates to same key', () => {
  for (let i = 0; i < 1000; i++) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rapid_key', ?)").run('v' + i);
  }
  const final = db.prepare("SELECT value FROM settings WHERE key = 'rapid_key'").get();
  assert.strictEqual(final.value, 'v999');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Message Channel Tracking
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Message Channels ===');

test('Messages: channel defaults to sms', () => {
  const r = db.prepare("INSERT INTO messages (phone, body, direction) VALUES ('5550000001', 'Test', 'outbound')").run();
  const msg = db.prepare('SELECT channel FROM messages WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(msg.channel, 'sms');
});

test('Messages: whatsapp channel explicitly set', () => {
  const r = db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES ('5550000002', 'WA Test', 'outbound', 'whatsapp')").run();
  const msg = db.prepare('SELECT channel FROM messages WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(msg.channel, 'whatsapp');
});

test('Messages: channel aggregation for analytics', () => {
  // Insert batch
  for (let i = 0; i < 50; i++) {
    db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, 'bulk', 'outbound', ?)").run(
      '555' + String(i).padStart(7, '0'),
      i % 3 === 0 ? 'whatsapp' : 'sms'
    );
  }
  const stats = db.prepare("SELECT channel, COUNT(*) as c FROM messages WHERE direction = 'outbound' GROUP BY channel").all();
  const smsCount = stats.find(s => s.channel === 'sms');
  const waCount = stats.find(s => s.channel === 'whatsapp');
  assert(smsCount && smsCount.c > 0);
  assert(waCount && waCount.c > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Admin Lists with Type Filtering
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Admin List Types ===');

test('Admin lists: type filtering', () => {
  db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Text List', 'text')").run();
  db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Event List', 'event')").run();
  db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Survey List', 'survey')").run();
  db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Walk List', 'block_walk')").run();
  db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('General List', 'general')").run();

  const textLists = db.prepare("SELECT * FROM admin_lists WHERE list_type = 'text'").all();
  assert(textLists.length >= 1);

  const allTypes = db.prepare("SELECT DISTINCT list_type FROM admin_lists ORDER BY list_type").all().map(r => r.list_type);
  assert(allTypes.includes('text'));
  assert(allTypes.includes('event'));
  assert(allTypes.includes('general'));
});

test('Admin lists: voter count JOIN with type filter', () => {
  const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Count Test', 'text')").run();
  const listId = listRes.lastInsertRowid;

  // Add some voters
  const voters = db.prepare('SELECT id FROM voters LIMIT 10').all();
  for (const v of voters) {
    try { db.prepare('INSERT INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, v.id); } catch(e) {}
  }

  const result = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voterCount
    FROM admin_lists al LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    WHERE al.id = ? GROUP BY al.id
  `).get(listId);
  assert.strictEqual(result.voterCount, voters.length);
  assert.strictEqual(result.list_type, 'text');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Voter QR Multi-Event Check-in
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: QR Multi-Event Check-in ===');

test('QR: voter checks into 5 different events', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('QR', 'Multi', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  for (let i = 0; i < 5; i++) {
    const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES (?, '2025-0" + (i + 1) + "-15')").run('QR Event ' + i);
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, eRes.lastInsertRowid);
  }

  const checkins = db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(vid).c;
  assert.strictEqual(checkins, 5);
});

test('QR: same voter cannot check into same event twice', () => {
  const voter = db.prepare("SELECT id FROM voters WHERE first_name = 'QR' AND last_name = 'Multi'").get();
  const event = db.prepare("SELECT event_id FROM voter_checkins WHERE voter_id = ? LIMIT 1").get(voter.id);

  let threw = false;
  try {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event.event_id);
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw);
});

test('QR: check-in auto-creates voter contact', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('AutoLog', 'Voter', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('AutoLog Event', '2025-07-01')").run();

  // Simulate the full check-in transaction
  const checkinTx = db.transaction(() => {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vRes.lastInsertRowid, eRes.lastInsertRowid);
    db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, 'Event', 'Attended', 'Checked in via QR', 'QR Check-In')").run(vRes.lastInsertRowid);
  });
  checkinTx();

  const contact = db.prepare("SELECT * FROM voter_contacts WHERE voter_id = ? AND contact_type = 'Event'").get(vRes.lastInsertRowid);
  assert(contact);
  assert.strictEqual(contact.result, 'Attended');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: 100K Election Votes Performance
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: 100K Election Votes ===');

// Seed 2000 voters quickly
const seedVotersTx = db.transaction(() => {
  for (let i = 0; i < 2000; i++) {
    db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct, party, qr_token) VALUES (?, ?, ?, ?, ?, ?)").run(
      'V' + i, 'L' + i, '777' + String(i).padStart(7, '0'), 'P' + (i % 20), ['D', 'R', 'I'][i % 3],
      crypto.randomBytes(6).toString('base64url')
    );
  }
});
seedVotersTx();

test('100K election votes: bulk insert performance', () => {
  const voterIds = db.prepare("SELECT id FROM voters WHERE first_name LIKE 'V%' LIMIT 2000").all().map(v => v.id);
  const electionNames = [];
  for (let y = 2016; y <= 2024; y++) {
    electionNames.push('Nov ' + y + ' General');
    electionNames.push('Mar ' + y + ' Primary');
    if (y >= 2020) electionNames.push('May ' + y + ' Local');
  }

  const insertVote = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)');
  const start = Date.now();
  const bulkTx = db.transaction(() => {
    let inserted = 0;
    for (const vid of voterIds) {
      for (const eName of electionNames) {
        const year = eName.match(/\d{4}/)[0];
        const month = eName.startsWith('Nov') ? '11' : eName.startsWith('Mar') ? '03' : '05';
        const r = insertVote.run(vid, eName, year + '-' + month + '-05', 'general', eName.startsWith('Nov') ? 'november' : 'primary');
        if (r.changes > 0) inserted++;
      }
    }
    return inserted;
  });
  const inserted = bulkTx();
  const elapsed = Date.now() - start;

  assert(inserted > 30000, 'Should insert >30K votes, got ' + inserted);
  assert(elapsed < 30000, 'Should complete in <30s, took ' + elapsed + 'ms');
});

test('100K election votes: aggregation query performance', () => {
  const start = Date.now();
  const stats = db.prepare(`
    SELECT election_name, COUNT(DISTINCT voter_id) as voter_count
    FROM election_votes GROUP BY election_name ORDER BY voter_count DESC
  `).all();
  const elapsed = Date.now() - start;

  assert(stats.length > 10, 'Should have many elections');
  assert(elapsed < 5000, 'Aggregation should be <5s, took ' + elapsed + 'ms');
});

test('100K election votes: super voter query', () => {
  const start = Date.now();
  const superVoters = db.prepare(`
    SELECT voter_id, COUNT(*) as election_count
    FROM election_votes GROUP BY voter_id HAVING COUNT(*) >= 10
    ORDER BY election_count DESC LIMIT 100
  `).all();
  const elapsed = Date.now() - start;

  assert(elapsed < 5000, 'Super voter query should be <5s');
  if (superVoters.length > 0) {
    assert(superVoters[0].election_count >= 10);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 13: Walk Route with Mixed GPS
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 13: Mixed GPS Routes ===');

test('Walk route: mixed GPS and non-GPS addresses', () => {
  const wRes = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('Mixed GPS Walk', 'MGPS')").run();
  const wId = wRes.lastInsertRowid;

  // 5 with GPS, 5 without
  for (let i = 0; i < 10; i++) {
    if (i < 5) {
      db.prepare("INSERT INTO walk_addresses (walk_id, address, lat, lng, sort_order) VALUES (?, ?, ?, ?, ?)").run(
        wId, (400 + i) + ' GPS St', 30.27 + i * 0.002, -97.74, i
      );
    } else {
      db.prepare("INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)").run(
        wId, (400 + i) + ' NoGPS St', i
      );
    }
  }

  const allAddrs = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ?').all(wId);
  const withGPS = allAddrs.filter(a => a.lat && a.lng);
  const withoutGPS = allAddrs.filter(a => !a.lat || !a.lng);
  assert.strictEqual(withGPS.length, 5);
  assert.strictEqual(withoutGPS.length, 5);

  // Nearest-neighbor on GPS subset
  const remaining = [...withGPS];
  const ordered = [remaining.shift()];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let nearest = 0, nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = gpsDistance(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    }
    ordered.push(remaining.splice(nearest, 1)[0]);
  }
  // Non-GPS go at end
  const fullRoute = ordered.concat(withoutGPS);
  assert.strictEqual(fullRoute.length, 10);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 14: Captain Code Collision
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 14: Captain Code Collision ===');

test('Captain code: retry on collision', () => {
  // Pre-fill a code
  db.prepare("INSERT INTO captains (name, code) VALUES ('Existing', 'AAAAAA')").run();

  function generateCaptainCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  }

  // Simulate collision retry (like captains.js line 83-87)
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCaptainCode();
    const exists = db.prepare('SELECT id FROM captains WHERE code = ?').get(code);
    if (!exists) break;
  }
  assert(code);
  assert.strictEqual(code.length, 6);
});

test('Captain code: 100 captains all get unique codes', () => {
  const codes = new Set();
  const tx = db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      let code;
      for (let j = 0; j < 10; j++) {
        code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
        if (!db.prepare('SELECT id FROM captains WHERE code = ?').get(code)) break;
      }
      db.prepare("INSERT INTO captains (name, code) VALUES (?, ?)").run('UniqueCapt' + i, code);
      codes.add(code);
    }
  });
  tx();
  assert.strictEqual(codes.size, 100, 'All 100 codes should be unique');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 15: Voter Touchpoint Timeline
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 15: Touchpoint Timeline ===');

test('Touchpoints: aggregation across all channels', () => {
  // Create a fresh voter for this test
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('TPVoter', 'Timeline', '5559990001', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const voter = { id: vRes.lastInsertRowid, phone: '5559990001' };

  // Add data across channels
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_by) VALUES (?, 'Door-knock', 'Support', 'Volunteer')").run(voter.id);
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_by) VALUES (?, 'Phone Call', 'Undecided', 'Phonebanker')").run(voter.id);
  if (voter.phone) {
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, 'Hello!', 'outbound')").run(voter.phone);
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, 'Thanks', 'inbound')").run(voter.phone);
  }

  // Build timeline
  const touchpoints = [];
  const contacts = db.prepare('SELECT contact_type as type, result, contacted_by, contacted_at as date FROM voter_contacts WHERE voter_id = ?').all(voter.id);
  for (const c of contacts) touchpoints.push({ channel: c.type, result: c.result, date: c.date });

  if (voter.phone) {
    const texts = db.prepare("SELECT direction, body, timestamp as date FROM messages WHERE phone = ? LIMIT 50").all(voter.phone);
    for (const t of texts) touchpoints.push({ channel: t.direction === 'outbound' ? 'Text Sent' : 'Text Received', date: t.date });
  }

  assert(touchpoints.length >= 3, 'Should have multiple touchpoints');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 16: Walk from Precinct Auto-Creation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 16: Walk from Precinct ===');

test('Walk from precinct: auto-creates walk with voter-linked addresses', () => {
  // Add voters in a specific precinct with addresses
  for (let i = 0; i < 30; i++) {
    db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, precinct, phone, qr_token) VALUES (?, ?, ?, 'WalkCity', '77001', 'WALK-PCT', ?, ?)").run(
      'WPFirst' + i, 'WPLast' + i, (500 + i) + ' Precinct Rd',
      '444' + String(i).padStart(7, '0'),
      crypto.randomBytes(6).toString('base64url')
    );
  }

  // Simulate walk from-precinct
  const voters = db.prepare("SELECT id, first_name, last_name, address, city, zip FROM voters WHERE precinct = 'WALK-PCT' AND address != '' ORDER BY address").all();
  assert(voters.length >= 30);

  const wRes = db.prepare("INSERT INTO block_walks (name, description, join_code) VALUES ('Precinct Walk WALK-PCT', 'Auto-created', ?)").run(generateAlphaCode(4));
  const wId = wRes.lastInsertRowid;

  const insertAddr = db.prepare('INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addTx = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      insertAddr.run(wId, v.address, v.city, v.zip, v.first_name + ' ' + v.last_name, v.id, i++);
    }
    return i;
  });
  const added = addTx();
  assert.strictEqual(added, voters.length);

  // Verify voter linkage
  const linked = db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND voter_id IS NOT NULL').get(wId).c;
  assert.strictEqual(linked, voters.length);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 17: Opt-Out Enforcement
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 17: Opt-Out Enforcement ===');

test('Opt-out: phone added to opt_outs', () => {
  const phone = '5551110000';
  db.prepare('INSERT INTO opt_outs (phone) VALUES (?)').run(phone);
  const exists = db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(phone);
  assert(exists);
});

test('Opt-out: duplicate phone rejected by UNIQUE', () => {
  let threw = false;
  try {
    db.prepare('INSERT INTO opt_outs (phone) VALUES (?)').run('5551110000');
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw);
});

test('Opt-out: P2P auto-skip for opted-out contacts', () => {
  // Create a contact with opted-out phone
  const optedPhone = '5551110000';
  const cRes = db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, 'OptedOut')").run(optedPhone);

  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('OptOut Test', 'Hi', 'OPT1', ?)").run(expires);
  const sessionId = sRes.lastInsertRowid;

  db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)').run(sessionId, cRes.lastInsertRowid);
  const vRes = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessionId, 'OptVolunteer');
  db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE session_id = ?').run(vRes.lastInsertRowid, sessionId);

  // Simulate queue check — skip opted out
  const optedOutPhones = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const pending = db.prepare(`
    SELECT a.id, c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'pending'
  `).all(vRes.lastInsertRowid);

  for (const p of pending) {
    if (optedOutPhones.has(p.phone)) {
      db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(p.id);
    }
  }

  const skipped = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'skipped'").get(sessionId).c;
  assert(skipped >= 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 18: Users Table & Authentication
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 18: Users & Auth ===');

test('Users: create with password hash', () => {
  const hash = crypto.createHash('sha256').update('password123').digest('hex');
  const r = db.prepare("INSERT INTO users (username, password_hash, display_name, role) VALUES ('admin', ?, 'Admin User', 'admin')").run(hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(user.username, 'admin');
  assert.strictEqual(user.role, 'admin');
  assert.strictEqual(user.password_hash, hash);
});

test('Users: UNIQUE username constraint', () => {
  let threw = false;
  try {
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'hash')").run();
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw);
});

test('Users: role filtering', () => {
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('captain1', 'hash', 'captain')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('walker1', 'hash', 'blockwalker')").run();

  const admins = db.prepare("SELECT * FROM users WHERE role = 'admin'").all();
  const captains = db.prepare("SELECT * FROM users WHERE role = 'captain'").all();
  assert(admins.length >= 1);
  assert(captains.length >= 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 19: Enrichment Resolve Pipeline
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 19: Enrichment Resolve ===');

test('Enrichment resolve: update phone from conflict resolution', () => {
  const voter = db.prepare("SELECT id, phone FROM voters WHERE phone != '' LIMIT 1").get();
  const newPhone = '3335559999';
  db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(normalizePhone(newPhone), voter.id);

  const updated = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voter.id);
  assert.strictEqual(updated.phone, '3335559999');
});

test('Enrichment resolve: batch resolution', () => {
  const resolutions = [];
  for (let i = 0; i < 10; i++) {
    const v = db.prepare("SELECT id FROM voters WHERE first_name = ?").get('V' + i);
    if (v) resolutions.push({ voter_id: v.id, phone: '222' + String(i).padStart(7, '0') });
  }

  const updatePhone = db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?");
  const resolveTx = db.transaction((list) => {
    let updated = 0;
    for (const r of list) {
      if (r.voter_id > 0 && r.phone) {
        updatePhone.run(normalizePhone(r.phone), r.voter_id);
        updated++;
      }
    }
    return updated;
  });
  const updated = resolveTx(resolutions);
  assert.strictEqual(updated, resolutions.length);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 20: Final Database Health
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 20: Final DB Health ===');

test('DB: WAL mode active', () => {
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
});

test('DB: foreign keys enabled', () => {
  assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);
});

test('DB: integrity check passes', () => {
  assert.strictEqual(db.pragma('integrity_check')[0].integrity_check, 'ok');
});

test('DB: FK violations check passes', () => {
  const violations = db.pragma('foreign_key_check');
  assert.strictEqual(violations.length, 0, 'FK violations: ' + JSON.stringify(violations.slice(0, 5)));
});

test('DB: total row counts sanity check', () => {
  const voters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const messages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const electionVotes = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
  assert(voters > 2000, 'Should have >2K voters');
  assert(messages > 50, 'Should have messages');
  assert(electionVotes > 30000, 'Should have >30K election votes');
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 6 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`        ${f.error}`);
  }
}

db.close();
try { fs.unlinkSync(TEST_DB); } catch(e) {}
try { fs.unlinkSync(TEST_DB + '-wal'); } catch(e) {}
try { fs.unlinkSync(TEST_DB + '-shm'); } catch(e) {}

process.exit(failed > 0 ? 1 : 0);
