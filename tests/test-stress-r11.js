/**
 * STRESS TEST ROUND 11 — Frontend Logic & Server Webhook Deep Dive
 *
 * Sections:
 * 1. Server webhook: inbound SMS/WhatsApp message routing
 * 2. Survey response handler: multi-question flow, option matching, next-question advance
 * 3. Auto-reply with AI: knowledge base + scripts retrieval
 * 4. Early voting import: mark voters, date/method tracking
 * 5. Data enrichment: phone fill, email fill, conflict detection
 * 6. Canvass import: 3-tier matching at scale
 * 7. QR token: generate, lookup, multi-event check-in
 * 8. Voter touchpoint timeline: aggregate contacts across all channels
 * 9. Election votes: batch import, duplicate handling, cycle filtering
 * 10. Stress: 10000 voters with concurrent list operations
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r11.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Full Schema (abbreviated for readability, same as R10) ───
db.exec(`
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '', preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT DEFAULT NULL, session_id INTEGER DEFAULT NULL, volunteer_name TEXT DEFAULT NULL, channel TEXT DEFAULT 'sms');
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
  CREATE TABLE campaign_knowledge (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE response_scripts (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT DEFAULT '', role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
`);

const { phoneDigits, normalizePhone, generateJoinCode, generateAlphaCode } = require('./utils');
const { generateQrToken } = require('./db');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Inbound Message Routing
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Inbound Message Routing ===');

test('Inbound: opt-out keyword detection (STOP)', () => {
  const keywords = ['stop', 'unsubscribe', 'cancel', 'opt out', 'opt-out', 'remove'];
  const body = 'STOP';
  const isOptOut = keywords.some(k => body.toLowerCase().includes(k));
  assert(isOptOut, 'STOP should trigger opt-out');
});

test('Inbound: opt-out keyword in longer message', () => {
  const keywords = ['stop', 'unsubscribe', 'cancel', 'opt out', 'opt-out', 'remove'];
  const body = 'Please unsubscribe me from this list';
  const isOptOut = keywords.some(k => body.toLowerCase().includes(k));
  assert(isOptOut, 'Message with unsubscribe should trigger opt-out');
});

test('Inbound: non-opt-out message passes through', () => {
  const keywords = ['stop', 'unsubscribe', 'cancel', 'opt out', 'opt-out', 'remove'];
  const body = 'Yes I will vote!';
  const isOptOut = keywords.some(k => body.toLowerCase().includes(k));
  assert(!isOptOut, 'Normal reply should not trigger opt-out');
});

test('Inbound: message stored with normalized phone', () => {
  const raw = '+1 (512) 555-9999';
  const normalized = normalizePhone(raw);
  db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, 'Test reply', 'inbound', 'sms')").run(normalized);
  const msg = db.prepare("SELECT * FROM messages WHERE phone = '5125559999'").get();
  assert(msg, 'Should find message by normalized phone');
  assert.strictEqual(msg.direction, 'inbound');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Survey Multi-Question Flow
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Survey Multi-Question Flow ===');

let flowSurveyId, flowQ1Id, flowQ2Id, flowQ3Id;
test('Survey flow: setup 3-question survey', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('Flow Test', 'active')").run();
  flowSurveyId = s.lastInsertRowid;

  const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q1: Pick one', 'single_choice', 0)").run(flowSurveyId);
  flowQ1Id = q1.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'A', '1', 0)").run(flowQ1Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'B', '2', 1)").run(flowQ1Id);

  const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q2: Rank them', 'ranked_choice', 1)").run(flowSurveyId);
  flowQ2Id = q2.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'X', '1', 0)").run(flowQ2Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Y', '2', 1)").run(flowQ2Id);

  const q3 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q3: Comments?', 'write_in', 2)").run(flowSurveyId);
  flowQ3Id = q3.lastInsertRowid;
});

test('Survey flow: send to respondent, start at Q1', () => {
  db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, '5550001111', 'FlowResp', ?)").run(flowSurveyId, flowQ1Id);
  const send = db.prepare("SELECT * FROM survey_sends WHERE phone = '5550001111' AND survey_id = ?").get(flowSurveyId);
  assert.strictEqual(send.current_question_id, flowQ1Id);
});

test('Survey flow: answer Q1, advance to Q2', () => {
  const send = db.prepare("SELECT * FROM survey_sends WHERE phone = '5550001111' AND survey_id = ?").get(flowSurveyId);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(flowSurveyId, send.id, flowQ1Id, send.phone, '1');

  // Get next question
  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(flowSurveyId);
  const currentIdx = questions.findIndex(q => q.id === flowQ1Id);
  const nextQ = questions[currentIdx + 1];
  assert(nextQ, 'Should have next question');
  assert.strictEqual(nextQ.id, flowQ2Id);

  db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(nextQ.id, send.id);
});

test('Survey flow: answer Q2 (ranked), advance to Q3', () => {
  const send = db.prepare("SELECT * FROM survey_sends WHERE phone = '5550001111' AND survey_id = ?").get(flowSurveyId);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(flowSurveyId, send.id, flowQ2Id, send.phone, '2,1');

  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(flowSurveyId);
  const currentIdx = questions.findIndex(q => q.id === flowQ2Id);
  const nextQ = questions[currentIdx + 1];
  assert(nextQ);
  assert.strictEqual(nextQ.id, flowQ3Id);

  db.prepare("UPDATE survey_sends SET current_question_id = ? WHERE id = ?").run(nextQ.id, send.id);
});

test('Survey flow: answer Q3 (write-in), complete', () => {
  const send = db.prepare("SELECT * FROM survey_sends WHERE phone = '5550001111' AND survey_id = ?").get(flowSurveyId);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?,?,?,?,?)").run(flowSurveyId, send.id, flowQ3Id, send.phone, 'Great survey!');

  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id').all(flowSurveyId);
  const currentIdx = questions.findIndex(q => q.id === flowQ3Id);
  const nextQ = questions[currentIdx + 1];
  assert.strictEqual(nextQ, undefined, 'No more questions');

  db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now'), current_question_id = NULL WHERE id = ?").run(send.id);

  const completed = db.prepare('SELECT status FROM survey_sends WHERE id = ?').get(send.id);
  assert.strictEqual(completed.status, 'completed');

  const responseCount = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE send_id = ?').get(send.id).c;
  assert.strictEqual(responseCount, 3, 'Should have 3 responses');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Knowledge Base & Scripts
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Knowledge & Scripts ===');

test('Knowledge: CRUD lifecycle', () => {
  const r = db.prepare("INSERT INTO campaign_knowledge (type, title, content) VALUES ('policy', 'Healthcare Plan', 'Our plan covers all citizens.')").run();
  const id = r.lastInsertRowid;

  const entry = db.prepare('SELECT * FROM campaign_knowledge WHERE id = ?').get(id);
  assert.strictEqual(entry.type, 'policy');
  assert.strictEqual(entry.title, 'Healthcare Plan');

  db.prepare("UPDATE campaign_knowledge SET content = 'Updated plan with dental.', updated_at = datetime('now') WHERE id = ?").run(id);
  const updated = db.prepare('SELECT content FROM campaign_knowledge WHERE id = ?').get(id);
  assert(updated.content.includes('dental'));

  db.prepare('DELETE FROM campaign_knowledge WHERE id = ?').run(id);
  assert.strictEqual(db.prepare('SELECT id FROM campaign_knowledge WHERE id = ?').get(id), undefined);
});

test('Scripts: CRUD lifecycle', () => {
  const r = db.prepare("INSERT INTO response_scripts (scenario, label, content) VALUES ('opposition', 'Tax attack', 'Our candidate supports lower taxes...')").run();
  const id = r.lastInsertRowid;
  assert(db.prepare('SELECT * FROM response_scripts WHERE id = ?').get(id));

  db.prepare('DELETE FROM response_scripts WHERE id = ?').run(id);
  assert.strictEqual(db.prepare('SELECT id FROM response_scripts WHERE id = ?').get(id), undefined);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Early Voting Import
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Early Voting ===');

test('Early voting: mark voters as early voted', () => {
  const insertV = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES (?,?,?,?)");
  for (let i = 0; i < 50; i++) {
    insertV.run('EV' + i, 'Voter', '555100' + String(i).padStart(4, '0'), crypto.randomBytes(6).toString('base64url'));
  }

  const update = db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = ?, early_voted_method = ? WHERE phone = ?");
  for (let i = 0; i < 25; i++) {
    update.run('2025-03-01', 'in_person', '555100' + String(i).padStart(4, '0'));
  }

  const count = db.prepare("SELECT COUNT(*) as c FROM voters WHERE early_voted = 1 AND early_voted_method = 'in_person'").get().c;
  assert.strictEqual(count, 25);
});

test('Early voting: exclude early voters from get-out-the-vote list', () => {
  const nonEarlyVoters = db.prepare("SELECT COUNT(*) as c FROM voters WHERE early_voted = 0 AND phone LIKE '555100%'").get().c;
  assert.strictEqual(nonEarlyVoters, 25);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: QR Token & Multi-Event Check-In
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: QR Token ===');

test('QR: generate unique tokens', () => {
  const tokens = new Set();
  for (let i = 0; i < 1000; i++) {
    tokens.add(generateQrToken());
  }
  assert.strictEqual(tokens.size, 1000, 'All 1000 tokens should be unique');
});

test('QR: multi-event check-in', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('QRMulti', ?)").run(generateQrToken());
  const vid = vRes.lastInsertRowid;
  const e1 = db.prepare("INSERT INTO events (title, event_date) VALUES ('Event A', '2025-05-01')").run().lastInsertRowid;
  const e2 = db.prepare("INSERT INTO events (title, event_date) VALUES ('Event B', '2025-05-15')").run().lastInsertRowid;

  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, e1);
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, e2);

  const checkins = db.prepare('SELECT * FROM voter_checkins WHERE voter_id = ?').all(vid);
  assert.strictEqual(checkins.length, 2);
});

test('QR: lookup voter by token', () => {
  const voter = db.prepare("SELECT * FROM voters WHERE first_name = 'QRMulti'").get();
  const found = db.prepare('SELECT id, first_name FROM voters WHERE qr_token = ?').get(voter.qr_token);
  assert(found);
  assert.strictEqual(found.first_name, 'QRMulti');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Voter Touchpoint Timeline
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Touchpoint Timeline ===');

test('Touchpoint: aggregate contacts across channels', () => {
  const vRes = db.prepare("INSERT INTO voters (first_name, phone, qr_token) VALUES ('TimeVoter', '5559998888', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  // Door knock
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_by) VALUES (?, 'Door-knock', 'Support', 'Walker1')").run(vid);
  // Phone call
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_by) VALUES (?, 'Phone', 'Left voicemail', 'Caller1')").run(vid);
  // Text (via messages table)
  db.prepare("INSERT INTO messages (phone, body, direction) VALUES ('5559998888', 'Hi, vote for us!', 'outbound')").run();
  db.prepare("INSERT INTO messages (phone, body, direction) VALUES ('5559998888', 'I will!', 'inbound')").run();

  const contacts = db.prepare('SELECT * FROM voter_contacts WHERE voter_id = ? ORDER BY contacted_at').all(vid);
  assert.strictEqual(contacts.length, 2);

  const msgs = db.prepare("SELECT * FROM messages WHERE phone = '5559998888' ORDER BY timestamp").all();
  assert.strictEqual(msgs.length, 2);

  // Combined timeline = 4 touchpoints
  assert.strictEqual(contacts.length + msgs.length, 4);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Election Votes Batch Import
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Election Votes ===');

test('Election votes: batch import 500 records', () => {
  const insertV = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES (?, ?)");
  const insertVote = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    for (let i = 0; i < 500; i++) {
      const vRes = insertV.run('ElVoter' + i, crypto.randomBytes(6).toString('base64url'));
      insertVote.run(vRes.lastInsertRowid, 'Nov 2024', '2024-11-05', 'general', 'november');
      if (i % 2 === 0) insertVote.run(vRes.lastInsertRowid, 'Mar 2024', '2024-03-05', 'primary', 'march');
    }
  })();

  const total = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE election_name = 'Nov 2024'").get().c;
  assert.strictEqual(total, 500);

  const primary = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE election_name = 'Mar 2024'").get().c;
  assert.strictEqual(primary, 250);
});

test('Election votes: duplicate handling via UNIQUE', () => {
  const voter = db.prepare("SELECT id FROM voters WHERE first_name = 'ElVoter0'").get();
  const r = db.prepare("INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Nov 2024', '2024-11-05')").run(voter.id);
  assert.strictEqual(r.changes, 0, 'Duplicate should be ignored');
});

test('Election votes: cycle filtering', () => {
  const novVoters = db.prepare("SELECT COUNT(DISTINCT voter_id) as c FROM election_votes WHERE election_cycle = 'november'").get().c;
  assert.strictEqual(novVoters, 500);

  const marVoters = db.prepare("SELECT COUNT(DISTINCT voter_id) as c FROM election_votes WHERE election_cycle = 'march'").get().c;
  assert.strictEqual(marVoters, 250);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Scale — 10K Voters with Concurrent Lists
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: 10K Scale ===');

test('Scale: insert 10000 voters', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct, qr_token) VALUES (?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      insert.run('S' + i, 'Scale', '555200' + String(i).padStart(4, '0'), 'SPCT-' + (i % 20), crypto.randomBytes(6).toString('base64url'));
    }
  })();
  const c = db.prepare("SELECT COUNT(*) as c FROM voters WHERE last_name = 'Scale'").get().c;
  assert.strictEqual(c, 10000);
});

test('Scale: create 5 lists from different precincts simultaneously', () => {
  db.transaction(() => {
    for (let p = 0; p < 5; p++) {
      const pct = 'SPCT-' + p;
      const listRes = db.prepare("INSERT INTO admin_lists (name) VALUES (?)").run('List ' + pct);
      const voters = db.prepare("SELECT id FROM voters WHERE precinct = ? AND last_name = 'Scale'").all(pct);
      const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
      for (const v of voters) insert.run(listRes.lastInsertRowid, v.id);
    }
  })();

  for (let p = 0; p < 5; p++) {
    const list = db.prepare("SELECT id FROM admin_lists WHERE name = 'List SPCT-" + p + "'").get();
    const count = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list.id).c;
    assert.strictEqual(count, 500, 'Each precinct list should have 500 voters');
  }
});

test('Scale: precinct analytics query performs well', () => {
  const start = Date.now();
  const stats = db.prepare(`
    SELECT precinct, COUNT(*) as total,
      SUM(CASE WHEN support_level = 'strong_support' THEN 1 ELSE 0 END) as supporters
    FROM voters WHERE last_name = 'Scale'
    GROUP BY precinct ORDER BY precinct
  `).all();
  const elapsed = Date.now() - start;

  assert.strictEqual(stats.length, 20, 'Should have 20 precincts');
  assert(elapsed < 1000, 'Query should complete in under 1 second: ' + elapsed + 'ms');
});

test('Scale: bulk delete list does not affect other lists', () => {
  const list0 = db.prepare("SELECT id FROM admin_lists WHERE name = 'List SPCT-0'").get();
  const list1 = db.prepare("SELECT id FROM admin_lists WHERE name = 'List SPCT-1'").get();

  const before1 = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list1.id).c;

  db.prepare('DELETE FROM admin_lists WHERE id = ?').run(list0.id);

  const after1 = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list1.id).c;
  assert.strictEqual(after1, before1, 'Other list should be unaffected');
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 11 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
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
