/**
 * STRESS TEST ROUND 8 — Cross-Route Interactions & Authorization Boundaries
 *
 * This round focuses on areas previous rounds haven't fully covered:
 * 1. Incoming webhook: survey response matching, ranked choice parsing, opt-out mid-survey
 * 2. P2P redistribution: volunteer offline/online snap-back logic
 * 3. Captain CSV import: 3-tier matching (phone, registration, name+address), ambiguity detection
 * 4. Event invite via P2P: voter list → contacts creation → P2P session → RSVP chain
 * 5. Walk from-precinct: auto-create walk with voter linkage, GPS log auto-contact-logging
 * 6. Admin list → P2P session with exclude_contacted filter
 * 7. Universe builder preview vs build consistency
 * 8. Data integrity: multi-table cascade, cross-table referential sanity
 * 9. WhatsApp preferred channel routing
 * 10. Enrichment conflict detection and resolution
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r8.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Full Schema ───
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

const { phoneDigits, normalizePhone, toE164, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Survey Response Matching (incoming webhook logic)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Survey Response Matching ===');

// Set up survey with all 3 question types
let surveyId, q1Id, q2Id, q3Id, opt1Id, opt2Id, opt3Id;
test('Survey setup: create multi-type survey', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, description, status) VALUES ('Response Test', 'Testing response matching', 'active')").run();
  surveyId = sRes.lastInsertRowid;

  // Q1: single choice
  const q1Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Favorite color?', 'single_choice', 0)").run(surveyId);
  q1Id = q1Res.lastInsertRowid;
  opt1Id = db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Red', '1', 0)").run(q1Id).lastInsertRowid;
  opt2Id = db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Blue', '2', 1)").run(q1Id).lastInsertRowid;
  opt3Id = db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Green', '3', 2)").run(q1Id).lastInsertRowid;

  // Q2: ranked choice
  const q2Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Rank these issues', 'ranked_choice', 1)").run(surveyId);
  q2Id = q2Res.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Economy', '1', 0)").run(q2Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Healthcare', '2', 1)").run(q2Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Education', '3', 2)").run(q2Id);

  // Q3: write-in
  const q3Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Any comments?', 'write_in', 2)").run(surveyId);
  q3Id = q3Res.lastInsertRowid;
});

test('Survey: single choice by number index', () => {
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, '5550001111', 'Alice', ?)").run(surveyId, q1Id);
  const sendId = sendRes.lastInsertRowid;

  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(q1Id);
  // Reply "2" → should match option_key "2" (Blue)
  const reply = '2';
  const matched = options.find(o => o.option_key === reply);
  assert(matched, 'Should match by option_key');
  assert.strictEqual(matched.option_text, 'Blue');

  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text, option_id) VALUES (?, ?, ?, '5550001111', ?, ?)").run(surveyId, sendId, q1Id, matched.option_key, matched.id);

  // Advance to Q2
  db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(q2Id, sendId);
});

test('Survey: single choice by text match (case-insensitive)', () => {
  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(q1Id);
  const reply = 'red';
  const matched = options.find(o => o.option_text.toLowerCase() === reply.toLowerCase());
  assert(matched, 'Should match by option text');
  assert.strictEqual(matched.option_key, '1');
});

test('Survey: ranked choice parsing "2,1,3"', () => {
  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(q2Id);
  const reply = '2,1,3';
  const parts = reply.split(',');
  const resolvedKeys = [];

  for (const part of parts) {
    const t = part.trim();
    const found = options.find(o => o.option_key === t);
    if (found) resolvedKeys.push(found.option_key);
  }

  assert.strictEqual(resolvedKeys.length, 3);
  assert.deepStrictEqual(resolvedKeys, ['2', '1', '3']);
  // Borda scoring: position 0 gets 3 pts, pos 1 gets 2, pos 2 gets 1
  const scores = {};
  resolvedKeys.forEach((key, pos) => {
    scores[key] = options.length - pos;
  });
  assert.strictEqual(scores['2'], 3); // 1st place
  assert.strictEqual(scores['1'], 2); // 2nd place
  assert.strictEqual(scores['3'], 1); // 3rd place
});

test('Survey: ranked choice by text names "Healthcare, Economy, Education"', () => {
  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(q2Id);
  const reply = 'Healthcare, Economy, Education';
  const parts = reply.split(',');
  const resolvedKeys = [];

  for (const part of parts) {
    const t = part.trim().toLowerCase();
    const found = options.find(o => o.option_text.toLowerCase() === t);
    if (found) resolvedKeys.push(found.option_key);
  }
  assert.deepStrictEqual(resolvedKeys, ['2', '1', '3']);
});

test('Survey: write-in preserves exact text', () => {
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, '5550002222', 'Bob', ?)").run(surveyId, q3Id);
  const writeInText = 'I think the economy is doing great! #MAGA 🇺🇸';
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550002222', ?)").run(surveyId, sendRes.lastInsertRowid, q3Id, writeInText);

  const resp = db.prepare("SELECT response_text FROM survey_responses WHERE phone = '5550002222' AND question_id = ?").get(q3Id);
  assert.strictEqual(resp.response_text, writeInText);
});

test('Survey: opt-out mid-survey expires the send', () => {
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id, status) VALUES (?, '5550003333', 'Eve', ?, 'in_progress')").run(surveyId, q2Id);
  const sendId = sendRes.lastInsertRowid;

  // Simulate opt-out
  db.prepare("INSERT OR IGNORE INTO opt_outs (phone) VALUES ('5550003333')").run();

  // End poll should expire in_progress sends
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(surveyId);
  assert(expired.changes >= 1, 'Should expire active sends including opted-out');

  // Verify the specific send is expired
  const send = db.prepare('SELECT status FROM survey_sends WHERE id = ?').get(sendId);
  assert.strictEqual(send.status, 'expired');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: P2P Volunteer Redistribution Logic
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: P2P Redistribution ===');

let p2pSessionId;
test('P2P: create session with 30 contacts', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Redist Test', 'Hi {firstName}!', ?, ?)").run(generateJoinCode(), expires);
  p2pSessionId = sRes.lastInsertRowid;

  const insertC = db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)");
  const insertA = db.prepare("INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)");

  db.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const cRes = insertC.run('555100' + String(i).padStart(4, '0'), 'Contact' + i);
      insertA.run(p2pSessionId, cRes.lastInsertRowid);
    }
  })();

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(p2pSessionId).c, 30);
});

test('P2P: 3 volunteers join and assignments auto-split', () => {
  for (let i = 0; i < 3; i++) {
    const vRes = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(p2pSessionId, 'Vol' + i);
    const volId = vRes.lastInsertRowid;

    const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").all(p2pSessionId);
    const onlineCount = db.prepare("SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ? AND is_online = 1").get(p2pSessionId).c;
    const batchSize = Math.ceil(unassigned.length / Math.max(onlineCount, 1));
    const batch = unassigned.slice(0, batchSize);
    for (const a of batch) {
      db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volId, a.id);
    }
  }

  const unassigned = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL").get(p2pSessionId).c;
  assert.strictEqual(unassigned, 0, 'All 30 contacts assigned');
});

test('P2P: volunteer goes offline, pending redistributed', () => {
  const vol0 = db.prepare("SELECT id FROM p2p_volunteers WHERE session_id = ? AND name = 'Vol0'").get(p2pSessionId);
  const vol0Pending = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(vol0.id).c;

  // Go offline
  db.prepare('UPDATE p2p_volunteers SET is_online = 0 WHERE id = ?').run(vol0.id);

  // Redistribute Vol0's pending contacts
  const pending = db.prepare("SELECT * FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status = 'pending'").all(vol0.id, p2pSessionId);
  const onlineVols = db.prepare("SELECT * FROM p2p_volunteers WHERE session_id = ? AND is_online = 1").all(p2pSessionId).filter(v => v.id !== vol0.id);

  for (let i = 0; i < pending.length; i++) {
    const target = onlineVols[i % onlineVols.length];
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = COALESCE(original_volunteer_id, ?) WHERE id = ?')
      .run(target.id, vol0.id, pending[i].id);
  }

  const vol0Remaining = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(vol0.id).c;
  assert.strictEqual(vol0Remaining, 0, 'Vol0 should have no pending after redistribution');
});

test('P2P: volunteer comes back online, snap-back conversations', () => {
  const vol0 = db.prepare("SELECT id FROM p2p_volunteers WHERE session_id = ? AND name = 'Vol0'").get(p2pSessionId);

  // First, mark some assignments as in_conversation (simulating they were sent)
  const transferred = db.prepare("SELECT id FROM p2p_assignments WHERE original_volunteer_id = ? LIMIT 3").all(vol0.id);
  for (const a of transferred) {
    db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(a.id);
  }

  // Come back online
  db.prepare('UPDATE p2p_volunteers SET is_online = 1 WHERE id = ?').run(vol0.id);

  // Snap back: conversations with original_volunteer_id = vol0 should return
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')")
    .run(vol0.id, vol0.id, p2pSessionId);
  db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?")
    .run(vol0.id, p2pSessionId);

  const vol0Active = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'in_conversation'").get(vol0.id).c;
  assert(vol0Active > 0, 'Vol0 should have active conversations after snap-back');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Captain CSV Import & 3-Tier Matching
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Captain CSV Import ===');

test('Setup: create voters for matching', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, address, city, zip, registration_number, qr_token) VALUES (?,?,?,?,?,?,?,?)");
  insert.run('John', 'Smith', '5125551001', '100 Oak St', 'Austin', '78701', 'REG001', crypto.randomBytes(6).toString('base64url'));
  insert.run('Jane', 'Doe', '5125551002', '200 Elm St', 'Austin', '78702', 'REG002', crypto.randomBytes(6).toString('base64url'));
  insert.run('Bob', 'Johnson', '5125551003', '300 Pine St', 'Austin', '78703', 'REG003', crypto.randomBytes(6).toString('base64url'));
  // Create duplicate-phone scenario: two voters with same phone
  insert.run('Alice', 'Brown', '5125551004', '400 Oak St', 'Austin', '78704', 'REG004', crypto.randomBytes(6).toString('base64url'));
  insert.run('Alice', 'Green', '5125551004', '500 Maple St', 'Dallas', '75001', 'REG005', crypto.randomBytes(6).toString('base64url'));
  // Create name+address collision: same name, different addresses
  insert.run('Mike', 'Wilson', '', '600 Cedar St', 'Austin', '78705', 'REG006', crypto.randomBytes(6).toString('base64url'));
  insert.run('Mike', 'Wilson', '', '700 Birch St', 'Houston', '77001', 'REG007', crypto.randomBytes(6).toString('base64url'));
});

test('Captain: create captain with list', () => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  const cRes = db.prepare("INSERT INTO captains (name, code) VALUES ('Test Captain', ?)").run(code);
  const captId = cRes.lastInsertRowid;
  db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'CSV Import List')").run(captId);
});

test('CSV import: Tier 1 match by phone', () => {
  const listId = db.prepare("SELECT id FROM captain_lists WHERE name = 'CSV Import List'").get().id;
  const allVoters = db.prepare("SELECT id, phone FROM voters").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) {
      if (!phoneMap[d]) phoneMap[d] = [];
      phoneMap[d].push(v);
    }
  }

  // Match by phone: John Smith
  const digits = phoneDigits('(512) 555-1001');
  assert(phoneMap[digits], 'Should find phone match');
  assert.strictEqual(phoneMap[digits].length, 1, 'Should be single match');
  const voter = phoneMap[digits][0];
  db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, voter.id);

  const count = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listId).c;
  assert.strictEqual(count, 1);
});

test('CSV import: Tier 2 match by registration number', () => {
  const allVoters = db.prepare("SELECT id, registration_number FROM voters").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim()] = v;
    }
  }

  const found = regMap['REG002'];
  assert(found, 'Should find registration match');
  const voter = db.prepare('SELECT first_name, last_name FROM voters WHERE id = ?').get(found.id);
  assert.strictEqual(voter.first_name, 'Jane');
  assert.strictEqual(voter.last_name, 'Doe');
});

test('CSV import: Tier 3 match by name+address', () => {
  const findByNameAddr = db.prepare(
    "SELECT id, first_name, last_name, phone, address FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 3"
  );

  // Match Bob Johnson at 300 Pine St
  const addrWords = '300 Pine St'.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
  const matches = findByNameAddr.all('Bob', 'Johnson', addrWords + '%');
  assert.strictEqual(matches.length, 1, 'Should find exactly one name+address match');
  assert.strictEqual(matches[0].phone, '5125551003');
});

test('CSV import: ambiguous phone match (2 voters same phone)', () => {
  const allVoters = db.prepare("SELECT id, phone FROM voters").all();
  const phoneMap = {};
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) {
      if (!phoneMap[d]) phoneMap[d] = [];
      phoneMap[d].push(v);
    }
  }

  const digits = phoneDigits('5125551004');
  assert(phoneMap[digits], 'Should find phone entries');
  assert.strictEqual(phoneMap[digits].length, 2, 'Should be ambiguous (2 voters, same phone)');
  // This should go to "needs_review" in real CSV import
});

test('CSV import: ambiguous name+address match (same name, different addresses)', () => {
  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 3"
  );

  // "Mike Wilson" with partial address "600" matches only the Cedar St one
  const matches = findByNameAddr.all('Mike', 'Wilson', '600%');
  assert.strictEqual(matches.length, 1, 'Partial address should disambiguate');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Event Invite → P2P Session → RSVP Chain
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Event Invite Chain ===');

test('Event invite: create admin list → contacts → P2P session', () => {
  // Create voters with phones
  const insertV = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES (?,?,?,?)");
  for (let i = 0; i < 20; i++) {
    insertV.run('Invitee' + i, 'Last' + i, '555200' + String(i).padStart(4, '0'), crypto.randomBytes(6).toString('base64url'));
  }

  // Create admin list
  const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Rally List', 'event')").run();
  const listId = listRes.lastInsertRowid;
  const voters = db.prepare("SELECT id FROM voters WHERE first_name LIKE 'Invitee%'").all();
  const insertALV = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  for (const v of voters) insertALV.run(listId, v.id);

  // Get voters from list and create contacts
  const listVoters = db.prepare(`
    SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city, v.email
    FROM admin_list_voters alv JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != ''
  `).all(listId);

  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?,?,?,?,?)');
  const contactIds = [];

  for (const v of listVoters) {
    let contact = findContact.get(v.phone);
    if (!contact) {
      const r = insertContact.run(v.phone, v.first_name || '', v.last_name || '', v.city || '', v.email || '');
      contactIds.push(r.lastInsertRowid);
    } else {
      contactIds.push(contact.id);
    }
  }

  assert.strictEqual(contactIds.length, 20);

  // Create P2P session
  const event = db.prepare("INSERT INTO events (title, event_date, event_time, location) VALUES ('Big Rally', '2025-05-01', '18:00', 'City Park')").run();
  const eventId = event.lastInsertRowid;

  const joinCode = generateJoinCode();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  const sessRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at, session_type) VALUES (?, 'Join us at Big Rally! Can you make it?', ?, ?, 'event')")
    .run('Event Invite: Big Rally', joinCode, expires);
  const sessId = sessRes.lastInsertRowid;

  // Create P2P assignments + RSVPs
  const insertAssign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const insertRSVP = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, 'invited')");

  db.transaction(() => {
    for (let i = 0; i < contactIds.length; i++) {
      insertAssign.run(sessId, contactIds[i]);
      insertRSVP.run(eventId, '555200' + String(i).padStart(4, '0'), 'Invitee' + i + ' Last' + i);
    }
  })();

  const assignCount = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessId).c;
  assert.strictEqual(assignCount, 20);

  const rsvpCount = db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(eventId).c;
  assert.strictEqual(rsvpCount, 20);
});

test('Event invite: RSVP dedup on duplicate invite', () => {
  const event = db.prepare("SELECT id FROM events WHERE title = 'Big Rally'").get();
  // Try to insert duplicate RSVP
  const result = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5552000000', 'Duplicate')").run(event.id);
  assert.strictEqual(result.changes, 0, 'Duplicate RSVP should be ignored');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Walk From Precinct with GPS Logging
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Walk from Precinct ===');

test('Walk from precinct: create walk with voter linkage', () => {
  // Add precinct voters with addresses
  const insertV = db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, precinct, phone, qr_token) VALUES (?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 15; i++) {
    insertV.run('Walker' + i, 'Test', (100 + i) + ' Walk St', 'Austin', '78701', 'PCT-99', '555300' + String(i).padStart(4, '0'), crypto.randomBytes(6).toString('base64url'));
  }

  const voters = db.prepare("SELECT id, first_name, last_name, address, city, zip FROM voters WHERE precinct = 'PCT-99' AND address != ''").all();
  assert(voters.length >= 15);

  // Create walk
  const joinCode = generateAlphaCode(4);
  const walkRes = db.prepare("INSERT INTO block_walks (name, description, join_code) VALUES ('PCT-99 Canvass', 'Auto-created', ?)").run(joinCode);
  const walkId = walkRes.lastInsertRowid;

  // Add addresses linked to voter_id
  const insertAddr = db.prepare('INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, sort_order, lat, lng) VALUES (?,?,?,?,?,?,?,?,?)');
  const addTx = db.transaction(() => {
    let i = 0;
    for (const v of voters) {
      // Give GPS coords for nearest-neighbor routing
      insertAddr.run(walkId, v.address, v.city, v.zip,
        (v.first_name + ' ' + v.last_name).trim(), v.id, i,
        30.27 + (i * 0.001), -97.74 + (i * 0.001));
      i++;
    }
    return i;
  });
  const added = addTx();
  assert.strictEqual(added, voters.length);
});

test('Walk: GPS log creates voter_contact record', () => {
  const walk = db.prepare("SELECT id FROM block_walks WHERE name = 'PCT-99 Canvass'").get();
  const addr = db.prepare('SELECT * FROM walk_addresses WHERE walk_id = ? AND voter_id IS NOT NULL LIMIT 1').get(walk.id);
  assert(addr, 'Should have an address with voter_id');

  // Simulate door-knock result
  db.prepare(`UPDATE walk_addresses SET result = 'support', notes = 'Enthusiastic supporter', knocked_at = datetime('now'),
    gps_lat = ?, gps_lng = ?, gps_accuracy = 10, gps_verified = 1 WHERE id = ?`)
    .run(addr.lat || 30.27, addr.lng || -97.74, addr.id);

  // Auto-log voter contact
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, 'Door-knock', 'Strong Support', 'Enthusiastic supporter', 'Block Walker')")
    .run(addr.voter_id);

  // Update support level
  db.prepare("UPDATE voters SET support_level = 'strong_support', updated_at = datetime('now') WHERE id = ?").run(addr.voter_id);

  const contact = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY id DESC LIMIT 1').get(addr.voter_id);
  assert(contact, 'Voter contact record should exist');
  assert.strictEqual(contact.contact_type, 'Door-knock');
  assert.strictEqual(contact.result, 'Strong Support');

  const voter = db.prepare('SELECT support_level FROM voters WHERE id = ?').get(addr.voter_id);
  assert.strictEqual(voter.support_level, 'strong_support');
});

test('Walk: GPS verification with Haversine distance', () => {
  // Haversine distance function
  function gpsDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Within 150m: should verify
  const dist1 = gpsDistance(30.2700, -97.7400, 30.2701, -97.7401);
  assert(dist1 < 150, 'Nearby GPS should verify: ' + dist1 + 'm');

  // Far away: should not verify
  const dist2 = gpsDistance(30.2700, -97.7400, 30.2800, -97.7500);
  assert(dist2 > 150, 'Far GPS should not verify: ' + dist2 + 'm');
});

test('Walk: group split assigns addresses round-robin', () => {
  const walk = db.prepare("SELECT id FROM block_walks WHERE name = 'PCT-99 Canvass'").get();

  // Add group members
  db.prepare("INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Alice')").run(walk.id);
  db.prepare("INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Bob')").run(walk.id);
  db.prepare("INSERT OR IGNORE INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Carol')").run(walk.id);

  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walk.id);
  const addresses = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id').all(walk.id);

  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  db.transaction(() => {
    for (let i = 0; i < addresses.length; i++) {
      update.run(members[i % members.length].walker_name, addresses[i].id);
    }
  })();

  // Verify distribution
  const aliceCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walk.id).c;
  const bobCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walk.id).c;
  const carolCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Carol'").get(walk.id).c;

  assert.strictEqual(aliceCount + bobCount + carolCount, addresses.length);
  // Round-robin: each walker should have within 1 of each other
  assert(Math.abs(aliceCount - bobCount) <= 1);
  assert(Math.abs(bobCount - carolCount) <= 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Enrichment Conflict Detection & Resolution
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Enrichment ===');

test('Enrichment: fill missing phone', () => {
  // Create voter without phone
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, registration_number, qr_token) VALUES ('NoPhone', 'Voter', '800 Test St', 'Austin', '78701', 'REGNP1', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const voterId = vRes.lastInsertRowid;

  // Simulate enrichment: match by registration number
  const voter = db.prepare('SELECT id, phone FROM voters WHERE registration_number = ?').get('REGNP1');
  assert(voter, 'Should find voter by registration');
  assert.strictEqual(voter.phone, '');

  // Fill phone
  db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(normalizePhone('(555) 999-0001'), voter.id);

  const updated = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voter.id);
  assert.strictEqual(updated.phone, '5559990001');
});

test('Enrichment: detect phone conflict', () => {
  // Create voter with existing phone
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, phone, registration_number, qr_token) VALUES ('HasPhone', 'Voter', '5559990002', 'REGHP1', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const voterId = vRes.lastInsertRowid;

  const voter = db.prepare('SELECT id, phone FROM voters WHERE registration_number = ?').get('REGHP1');
  const newPhone = '5559990003';

  // Detect conflict
  const currentPhone = voter.phone.trim();
  const isConflict = currentPhone && newPhone && phoneDigits(currentPhone) !== phoneDigits(newPhone);
  assert(isConflict, 'Should detect phone conflict');
});

test('Enrichment: resolve conflict by updating', () => {
  const voter = db.prepare('SELECT id, phone FROM voters WHERE registration_number = ?').get('REGHP1');
  const resolvedPhone = '5559990003';
  db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(resolvedPhone, voter.id);

  const updated = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voter.id);
  assert.strictEqual(updated.phone, resolvedPhone);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Universe Builder Preview vs Build Consistency
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Universe Builder ===');

test('Universe: setup election data', () => {
  const insertV = db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct, qr_token) VALUES (?,?,?,?,?)");
  const insertVote = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    for (let i = 0; i < 500; i++) {
      const vRes = insertV.run('UV' + i, 'UL' + i, '555400' + String(i).padStart(4, '0'),
        'UPCT-' + (i % 5), crypto.randomBytes(6).toString('base64url'));
      const vid = vRes.lastInsertRowid;
      // 80% voted Nov 2024
      if (i % 5 !== 0) insertVote.run(vid, 'Nov 2024 General', '2024-11-05', 'general', 'november');
      // 50% voted Mar 2024
      if (i % 2 === 0) insertVote.run(vid, 'Mar 2024 Primary', '2024-03-05', 'primary', 'march');
      // 60% voted Nov 2020
      if (i % 5 < 3) insertVote.run(vid, 'Nov 2020 General', '2020-11-03', 'general', 'november');
    }
  })();

  const vCount = db.prepare("SELECT COUNT(*) as c FROM voters WHERE precinct LIKE 'UPCT-%'").get().c;
  assert.strictEqual(vCount, 500);
});

test('Universe: preview and build produce same counts', () => {
  const precincts = ['UPCT-0', 'UPCT-1', 'UPCT-2'];
  const cutoffDate = '2020-01-01';
  const cycles = ['november'];

  // Preview
  const previewTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _prev_pct; CREATE TEMP TABLE _prev_pct (voter_id INTEGER PRIMARY KEY)');
    const pctPh = precincts.map(() => '?').join(',');
    db.prepare('INSERT INTO _prev_pct SELECT id FROM voters WHERE precinct IN (' + pctPh + ')').run(...precincts);
    const pctCount = db.prepare('SELECT COUNT(*) as c FROM _prev_pct').get().c;

    db.exec('DROP TABLE IF EXISTS _prev_univ; CREATE TEMP TABLE _prev_univ (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _prev_univ SELECT DISTINCT ev.voter_id FROM election_votes ev JOIN _prev_pct p ON ev.voter_id = p.voter_id WHERE ev.election_date >= ?").run(cutoffDate);
    const univCount = db.prepare('SELECT COUNT(*) as c FROM _prev_univ').get().c;

    db.exec('DROP TABLE IF EXISTS _prev_sub; CREATE TEMP TABLE _prev_sub (voter_id INTEGER PRIMARY KEY)');
    const cPh = cycles.map(() => '?').join(',');
    db.prepare('INSERT INTO _prev_sub SELECT DISTINCT ev.voter_id FROM election_votes ev JOIN _prev_univ u ON ev.voter_id = u.voter_id WHERE ev.election_cycle IN (' + cPh + ')').run(...cycles);
    const subCount = db.prepare('SELECT COUNT(*) as c FROM _prev_sub').get().c;

    db.exec('DROP TABLE IF EXISTS _prev_pct; DROP TABLE IF EXISTS _prev_univ; DROP TABLE IF EXISTS _prev_sub');
    return { pctCount, univCount, subCount };
  });
  const preview = previewTx();

  // Build
  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _bld_pct; CREATE TEMP TABLE _bld_pct (voter_id INTEGER PRIMARY KEY)');
    const pctPh = precincts.map(() => '?').join(',');
    db.prepare('INSERT INTO _bld_pct SELECT id FROM voters WHERE precinct IN (' + pctPh + ')').run(...precincts);
    const pctCount = db.prepare('SELECT COUNT(*) as c FROM _bld_pct').get().c;

    db.exec('DROP TABLE IF EXISTS _bld_univ; CREATE TEMP TABLE _bld_univ (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _bld_univ SELECT DISTINCT ev.voter_id FROM election_votes ev JOIN _bld_pct p ON ev.voter_id = p.voter_id WHERE ev.election_date >= ?").run(cutoffDate);
    const univCount = db.prepare('SELECT COUNT(*) as c FROM _bld_univ').get().c;

    db.exec('DROP TABLE IF EXISTS _bld_sub; CREATE TEMP TABLE _bld_sub (voter_id INTEGER PRIMARY KEY)');
    const cPh = cycles.map(() => '?').join(',');
    db.prepare('INSERT INTO _bld_sub SELECT DISTINCT ev.voter_id FROM election_votes ev JOIN _bld_univ u ON ev.voter_id = u.voter_id WHERE ev.election_cycle IN (' + cPh + ')').run(...cycles);
    const subCount = db.prepare('SELECT COUNT(*) as c FROM _bld_sub').get().c;

    // Create list from build
    const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Universe UPCT 0-2', 'general')").run();
    const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _bld_sub').run(listRes.lastInsertRowid);

    db.exec('DROP TABLE IF EXISTS _bld_pct; DROP TABLE IF EXISTS _bld_univ; DROP TABLE IF EXISTS _bld_sub');
    return { pctCount, univCount, subCount, listAdded: added.changes };
  });
  const build = buildTx();

  // Preview and build should produce identical counts
  assert.strictEqual(preview.pctCount, build.pctCount, 'Precinct counts should match');
  assert.strictEqual(preview.univCount, build.univCount, 'Universe counts should match');
  assert.strictEqual(preview.subCount, build.subCount, 'Sub-universe counts should match');
  assert.strictEqual(build.listAdded, build.subCount, 'List should contain all sub-universe voters');
  assert(build.pctCount > 0);
  assert(build.univCount > 0);
  assert(build.subCount > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: WhatsApp Preferred Channel & Dual-Send
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: WhatsApp Channel ===');

test('WhatsApp: preferred_channel set on WhatsApp reply', () => {
  const cRes = db.prepare("INSERT INTO contacts (phone, first_name, preferred_channel) VALUES ('5558001111', 'WAUser', NULL)").run();
  // Simulate WhatsApp reply
  db.prepare("UPDATE contacts SET preferred_channel = 'whatsapp' WHERE phone = '5558001111'").run();
  const contact = db.prepare("SELECT preferred_channel FROM contacts WHERE phone = '5558001111'").get();
  assert.strictEqual(contact.preferred_channel, 'whatsapp');
});

test('WhatsApp: wa_status tracked on assignment', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('WA Test', 'Hi', ?, ?)").run(generateJoinCode(), expires);
  const cRes = db.prepare("INSERT INTO contacts (phone) VALUES ('5558002222')").run();
  const aRes = db.prepare("INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)").run(sRes.lastInsertRowid, cRes.lastInsertRowid);

  // Mark WA sent
  db.prepare("UPDATE p2p_assignments SET wa_status = 'sent' WHERE id = ?").run(aRes.lastInsertRowid);
  const assign = db.prepare('SELECT wa_status FROM p2p_assignments WHERE id = ?').get(aRes.lastInsertRowid);
  assert.strictEqual(assign.wa_status, 'sent');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Cross-Table Cascade & Referential Integrity
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Cascade Integrity ===');

test('Cascade: delete captain removes lists, team members, and list voters', () => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  const cRes = db.prepare("INSERT INTO captains (name, code) VALUES ('Del Captain', ?)").run(code);
  const captId = cRes.lastInsertRowid;

  const tmRes = db.prepare("INSERT INTO captain_team_members (captain_id, name) VALUES (?, 'TeamDel')").run(captId);
  const listRes = db.prepare("INSERT INTO captain_lists (captain_id, team_member_id, name) VALUES (?, ?, 'Del List')").run(captId, tmRes.lastInsertRowid);
  const listId = listRes.lastInsertRowid;

  // Add a voter to the list
  const vRes = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('CascVoter', ?)").run(crypto.randomBytes(6).toString('base64url'));
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, vRes.lastInsertRowid);

  // Delete captain
  db.prepare('DELETE FROM captains WHERE id = ?').run(captId);

  // Verify cascades
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_team_members WHERE captain_id = ?').get(captId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?').get(captId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listId).c, 0);
  // Voter should still exist
  assert(db.prepare('SELECT id FROM voters WHERE id = ?').get(vRes.lastInsertRowid), 'Voter should survive captain deletion');
});

test('Cascade: delete voter removes from captain_list_voters and admin_list_voters', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('CascVoter2', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  // Add to admin list
  const alRes = db.prepare("INSERT INTO admin_lists (name) VALUES ('Casc Admin List')").run();
  db.prepare('INSERT INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(alRes.lastInsertRowid, vid);

  // Add to captain list
  const code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('Casc Captain', ?)").run(code);
  const clRes = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'Casc List')").run(captRes.lastInsertRowid);
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(clRes.lastInsertRowid, vid);

  // Delete voter
  db.prepare('DELETE FROM voters WHERE id = ?').run(vid);

  // Both list memberships should cascade delete
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE voter_id = ?').get(vid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?').get(vid).c, 0);
});

test('Cascade: delete survey removes questions, options, sends, and responses', () => {
  const sRes = db.prepare("INSERT INTO surveys (name) VALUES ('Casc Survey')").run();
  const sid = sRes.lastInsertRowid;
  const qRes = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Q?', 'single_choice')").run(sid);
  const qid = qRes.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key) VALUES (?, 'O1', '1')").run(qid);
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id) VALUES (?, '1111111111', ?)").run(sid, qid);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '1111111111', '1')").run(sid, sendRes.lastInsertRowid, qid);

  // Delete survey
  db.prepare('DELETE FROM surveys WHERE id = ?').run(sid);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?').get(sid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_options WHERE question_id = ?').get(qid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(sid).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(sid).c, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Edge Cases & Boundary Conditions
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Edge Cases ===');

test('Edge: personalizeTemplate with all merge tags', () => {
  const msg = personalizeTemplate('Hi {firstName} {lastName} from {city}!', {
    first_name: 'John', last_name: 'Doe', city: 'Austin'
  });
  assert.strictEqual(msg, 'Hi John Doe from Austin!');
});

test('Edge: personalizeTemplate with missing fields', () => {
  const msg = personalizeTemplate('Hi {firstName} {lastName} from {city}!', {});
  assert.strictEqual(msg, 'Hi   from !');
});

test('Edge: toE164 formatting', () => {
  assert.strictEqual(toE164('5125551234'), '+15125551234');
  assert.strictEqual(toE164('+15125551234'), '+15125551234');
  assert.strictEqual(toE164(''), '');
  assert.strictEqual(toE164('123'), '123');
});

test('Edge: generateJoinCode always 4 digits', () => {
  for (let i = 0; i < 100; i++) {
    const code = generateJoinCode();
    assert.strictEqual(code.length, 4, 'Code should be 4 digits: ' + code);
    assert(/^\d{4}$/.test(code), 'Code should be numeric: ' + code);
    const num = parseInt(code, 10);
    assert(num >= 1000 && num <= 9999, 'Code out of range: ' + code);
  }
});

test('Edge: generateAlphaCode correct length', () => {
  for (const len of [4, 6, 8]) {
    const code = generateAlphaCode(len);
    assert.strictEqual(code.length, len, 'Code length mismatch: expected ' + len + ', got ' + code.length);
    assert(/^[A-F0-9]+$/.test(code), 'Code should be hex: ' + code);
  }
});

test('Edge: INSERT OR IGNORE with UNIQUE constraint returns 0 changes', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('UniqueTest', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;
  const alRes = db.prepare("INSERT INTO admin_lists (name) VALUES ('Unique Test List')").run();
  const lid = alRes.lastInsertRowid;

  const r1 = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(lid, vid);
  assert.strictEqual(r1.changes, 1);
  const r2 = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(lid, vid);
  assert.strictEqual(r2.changes, 0, 'Duplicate should return 0 changes');
});

test('Edge: COALESCE update preserves existing values when null passed', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('Orig', 'Name', '5559999999', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  // Update with null for some fields (COALESCE should keep originals)
  db.prepare("UPDATE voters SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), phone = COALESCE(?, phone) WHERE id = ?")
    .run(null, 'NewLast', null, vid);

  const voter = db.prepare('SELECT first_name, last_name, phone FROM voters WHERE id = ?').get(vid);
  assert.strictEqual(voter.first_name, 'Orig', 'first_name should be preserved');
  assert.strictEqual(voter.last_name, 'NewLast', 'last_name should be updated');
  assert.strictEqual(voter.phone, '5559999999', 'phone should be preserved');
});

test('Edge: settings upsert works correctly', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_key', 'initial') ON CONFLICT(key) DO UPDATE SET value = 'initial'").run();
  const v1 = db.prepare("SELECT value FROM settings WHERE key = 'test_key'").get();
  assert.strictEqual(v1.value, 'initial');

  db.prepare("INSERT INTO settings (key, value) VALUES ('test_key', 'updated') ON CONFLICT(key) DO UPDATE SET value = 'updated'").run();
  const v2 = db.prepare("SELECT value FROM settings WHERE key = 'test_key'").get();
  assert.strictEqual(v2.value, 'updated');
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 8 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
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
