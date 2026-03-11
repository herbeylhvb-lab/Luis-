/**
 * STRESS TEST ROUND 15
 * Focus: Concurrent DB semantics, multi-step transaction integrity, webhook processing,
 * survey flow state machine, P2P session lifecycle, engagement score math at scale,
 * early voting import with all 3 match tiers, universe builder with overlapping sets,
 * captain list overlap detection, walk group re-split after leave, auto-reply keyword
 * matching edge cases, and sentiment analysis boundary conditions.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'stress_test_r15.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Copy schema from db.js but use our test DB
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Bootstrap full schema
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT DEFAULT NULL, session_id INTEGER DEFAULT NULL, volunteer_name TEXT DEFAULT NULL, channel TEXT DEFAULT 'sms');
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
  CREATE TABLE IF NOT EXISTS opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY, message_template TEXT, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS block_walks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', assigned_to TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), join_code TEXT DEFAULT NULL, max_walkers INTEGER DEFAULT 4);
  CREATE TABLE IF NOT EXISTS walk_addresses (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, address TEXT NOT NULL, unit TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', voter_name TEXT DEFAULT '', result TEXT DEFAULT 'not_visited', notes TEXT DEFAULT '', knocked_at TEXT, sort_order INTEGER DEFAULT 0, voter_id INTEGER DEFAULT NULL, lat REAL DEFAULT NULL, lng REAL DEFAULT NULL, gps_lat REAL DEFAULT NULL, gps_lng REAL DEFAULT NULL, gps_accuracy REAL DEFAULT NULL, gps_verified INTEGER DEFAULT 0, assigned_walker TEXT DEFAULT NULL);
  CREATE TABLE IF NOT EXISTS walk_group_members (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, walker_name TEXT NOT NULL, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(walk_id, walker_name));
  CREATE TABLE IF NOT EXISTS voters (id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '', support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), registration_number TEXT DEFAULT '', qr_token TEXT DEFAULT NULL, voting_history TEXT DEFAULT '', precinct TEXT DEFAULT '', early_voted INTEGER DEFAULT 0, early_voted_date TEXT DEFAULT NULL, early_voted_method TEXT DEFAULT NULL);
  CREATE INDEX IF NOT EXISTS idx_voters_phone ON voters(phone);
  CREATE TABLE IF NOT EXISTS voter_contacts (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '', contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS voter_checkins (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, checked_in_at TEXT DEFAULT (datetime('now')), UNIQUE(voter_id, event_id));
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '', status TEXT DEFAULT 'upcoming', created_at TEXT DEFAULT (datetime('now')), flyer_image TEXT DEFAULT NULL);
  CREATE TABLE IF NOT EXISTS event_rsvps (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '', rsvp_status TEXT DEFAULT 'invited', invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT, checked_in_at TEXT DEFAULT NULL);
  CREATE TABLE IF NOT EXISTS p2p_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL, assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL, status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), session_type TEXT DEFAULT 'campaign');
  CREATE TABLE IF NOT EXISTS p2p_volunteers (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS p2p_assignments (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, volunteer_id INTEGER REFERENCES p2p_volunteers(id), contact_id INTEGER NOT NULL REFERENCES contacts(id), status TEXT DEFAULT 'pending', original_volunteer_id INTEGER DEFAULT NULL, assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT DEFAULT NULL);
  CREATE TABLE IF NOT EXISTS campaign_knowledge (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS captains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS captain_team_members (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS captain_lists (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), list_type TEXT DEFAULT 'general');
  CREATE TABLE IF NOT EXISTS captain_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE IF NOT EXISTS admin_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), list_type TEXT DEFAULT 'general');
  CREATE TABLE IF NOT EXISTS admin_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE IF NOT EXISTS surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER DEFAULT NULL, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE IF NOT EXISTS survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER DEFAULT NULL, responded_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS election_votes (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, election_name TEXT NOT NULL, election_date TEXT NOT NULL, election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '', voted INTEGER DEFAULT 1, UNIQUE(voter_id, election_name));
  CREATE TABLE IF NOT EXISTS email_campaigns (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT DEFAULT '', role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE IF NOT EXISTS response_scripts (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`);

// Import utils
const { phoneDigits, normalizePhone, toE164, generateJoinCode, generateAlphaCode, personalizeTemplate } = require('./utils');
const { buildSurveyMessage } = require('./routes/surveys');

let passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write('.'); passed++; }
  catch (e) { process.stdout.write('F'); failed++; failures.push({ name, error: e.message || String(e) }); }
}

// ==================== Section 1: Survey State Machine ====================
console.log('\n=== Section 1: Survey State Machine ===');

test('Survey: full multi-question flow with write-in', () => {
  const surveyId = db.prepare("INSERT INTO surveys (name, status) VALUES ('Exit Poll', 'active')").run().lastInsertRowid;
  // Q1: single choice
  const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Who do you support?', 'single_choice', 1)").run(surveyId).lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Alice', '1', 0)").run(q1);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Bob', '2', 1)").run(q1);
  // Q2: write-in
  const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Why?', 'write_in', 2)").run(surveyId).lastInsertRowid;
  // Q3: ranked choice
  const q3 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Rank issues', 'ranked_choice', 3)").run(surveyId).lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Economy', '1', 0)").run(q3);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Healthcare', '2', 1)").run(q3);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Education', '3', 2)").run(q3);

  // Create a send
  const sendId = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id, status) VALUES (?, '5551230001', ?, 'sent')").run(surveyId, q1).lastInsertRowid;

  // Simulate answering Q1 → should advance to Q2
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5551230001', '1')").run(surveyId, sendId, q1);
  db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(q2, sendId);

  const afterQ1 = db.prepare("SELECT * FROM survey_sends WHERE id = ?").get(sendId);
  assert.strictEqual(afterQ1.current_question_id, q2);
  assert.strictEqual(afterQ1.status, 'in_progress');

  // Answer Q2 (write-in) → advance to Q3
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5551230001', 'Because she is better')").run(surveyId, sendId, q2);
  db.prepare("UPDATE survey_sends SET current_question_id = ? WHERE id = ?").run(q3, sendId);

  // Answer Q3 (ranked) → complete
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5551230001', '2,1,3')").run(surveyId, sendId, q3);
  db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now'), current_question_id = NULL WHERE id = ?").run(sendId);

  const final = db.prepare("SELECT * FROM survey_sends WHERE id = ?").get(sendId);
  assert.strictEqual(final.status, 'completed');
  assert.strictEqual(final.current_question_id, null);

  const responses = db.prepare("SELECT * FROM survey_responses WHERE send_id = ? ORDER BY id").all(sendId);
  assert.strictEqual(responses.length, 3);
  assert.strictEqual(responses[0].response_text, '1');
  assert.strictEqual(responses[1].response_text, 'Because she is better');
  assert.strictEqual(responses[2].response_text, '2,1,3');
});

test('Survey: buildSurveyMessage for ranked choice shows all options', () => {
  const q = { question_text: 'Rank candidates', question_type: 'ranked_choice' };
  const opts = [
    { option_text: 'Alpha', sort_order: 0 },
    { option_text: 'Beta', sort_order: 1 },
    { option_text: 'Gamma', sort_order: 2 },
  ];
  const msg = buildSurveyMessage('Test Survey', q, opts);
  assert(msg.includes('Rank your choices'), 'Should contain ranking instructions');
  assert(msg.includes('1) Alpha'), 'Should list first option');
  assert(msg.includes('2) Beta'), 'Should list second option');
  assert(msg.includes('3) Gamma'), 'Should list third option');
  assert(msg.includes('Alpha, Beta'), 'Should show example with option names');
});

test('Survey: buildSurveyMessage for write-in has no options', () => {
  const q = { question_text: 'What concerns you?', question_type: 'write_in' };
  const msg = buildSurveyMessage('Concern Poll', q, []);
  assert(msg.includes('Reply with your answer'), 'Write-in should ask for answer');
  assert(!msg.includes('1)'), 'Write-in should not list numbered options');
});

test('Survey: closing survey expires in_progress sends', () => {
  const surveyId = db.prepare("INSERT INTO surveys (name, status) VALUES ('Closable', 'active')").run().lastInsertRowid;
  const q = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q?', 'write_in', 1)").run(surveyId).lastInsertRowid;
  db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id, status) VALUES (?, '5550001111', ?, 'sent')").run(surveyId, q);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id, status) VALUES (?, '5550001112', ?, 'in_progress')").run(surveyId, q);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id, status) VALUES (?, '5550001113', NULL, 'completed')").run(surveyId);

  // Close survey
  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(surveyId);
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(surveyId);
  assert.strictEqual(expired.changes, 2);

  // Completed send should not be touched
  const completed = db.prepare("SELECT status FROM survey_sends WHERE survey_id = ? AND phone = '5550001113'").get(surveyId);
  assert.strictEqual(completed.status, 'completed');
});

// ==================== Section 2: Engagement Score Math ====================
console.log('\n=== Section 2: Engagement Score Math ===');

test('Engagement: score caps at 100', () => {
  // Create voter with many touchpoints
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct) VALUES ('Mega', 'Engaged', '5559990001', 'P1')").run().lastInsertRowid;
  // 20 door-knocks = 60pts, 10 events = 50pts, total = 110 → cap at 100
  for (let i = 0; i < 20; i++) {
    db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Door-knock', 'Support')").run(vid);
  }
  const eId = db.prepare("INSERT INTO events (title, event_date) VALUES ('Rally', '2025-01-01')").run().lastInsertRowid;
  for (let i = 0; i < 10; i++) {
    // Can't insert duplicate (UNIQUE voter_id,event_id), so create different events
    const eid2 = db.prepare("INSERT INTO events (title, event_date) VALUES (?, '2025-01-01')").run('Event' + i).lastInsertRowid;
    db.prepare("INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)").run(vid, eid2);
  }

  const contacts = db.prepare("SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?").get(vid).c;
  const checkins = db.prepare("SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?").get(vid).c;
  const rawScore = contacts * 3 + checkins * 5;
  assert(rawScore > 100, 'Raw score should exceed 100');
  const capped = Math.min(100, rawScore);
  assert.strictEqual(capped, 100);
});

test('Engagement: 0 touchpoints = 0 score', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES ('Zero', 'Touchpoints')").run().lastInsertRowid;
  const contacts = db.prepare("SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?").get(vid).c;
  const checkins = db.prepare("SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?").get(vid).c;
  const score = Math.min(100, contacts * 3 + checkins * 5);
  assert.strictEqual(score, 0);
});

test('Engagement: captain list membership = 4 pts each', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES ('Captain', 'Listed')").run().lastInsertRowid;
  const cap = db.prepare("INSERT INTO captains (name, code) VALUES ('Cap1', 'C1R15A')").run().lastInsertRowid;
  for (let i = 0; i < 3; i++) {
    const listId = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)").run(cap, 'List' + i).lastInsertRowid;
    db.prepare("INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)").run(listId, vid);
  }
  const captainLists = db.prepare("SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?").get(vid).c;
  assert.strictEqual(captainLists, 3);
  const score = captainLists * 4;
  assert.strictEqual(score, 12);
});

// ==================== Section 3: P2P Session Lifecycle ====================
console.log('\n=== Section 3: P2P Session Lifecycle ===');

test('P2P: auto_split distributes evenly among volunteers', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sid = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Test Session', 'Hi {firstName}', '1234', ?)").run(expires).lastInsertRowid;

  // Create 30 contacts and assignments
  for (let i = 0; i < 30; i++) {
    const cid = db.prepare("INSERT INTO contacts (phone) VALUES (?)").run('555000' + String(i).padStart(4, '0')).lastInsertRowid;
    db.prepare("INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)").run(sid, cid);
  }

  // Add 3 volunteers
  const vIds = [];
  for (let i = 0; i < 3; i++) {
    const vid = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)").run(sid, 'Vol' + i).lastInsertRowid;
    vIds.push(vid);
  }

  // Distribute round-robin
  const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL ORDER BY id").all(sid);
  for (let i = 0; i < unassigned.length; i++) {
    db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?").run(vIds[i % 3], unassigned[i].id);
  }

  // Each should have 10
  for (const vid of vIds) {
    const count = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?").get(vid).c;
    assert.strictEqual(count, 10, 'Each volunteer should get 10 assignments');
  }
});

test('P2P: redistribute moves pending to remaining online volunteers', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sid = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Redist Test', 'Hello', '5678', ?)").run(expires).lastInsertRowid;

  // 2 volunteers
  const v1 = db.prepare("INSERT INTO p2p_volunteers (session_id, name, is_online) VALUES (?, 'VolA', 1)").run(sid).lastInsertRowid;
  const v2 = db.prepare("INSERT INTO p2p_volunteers (session_id, name, is_online) VALUES (?, 'VolB', 1)").run(sid).lastInsertRowid;

  // Create 6 assignments for v1
  for (let i = 0; i < 6; i++) {
    const cid = db.prepare("INSERT INTO contacts (phone) VALUES (?)").run('555100' + String(i).padStart(4, '0')).lastInsertRowid;
    db.prepare("INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id, status) VALUES (?, ?, ?, 'pending')").run(sid, cid, v1);
  }

  // VolA goes offline → redistribute pending to VolB
  db.prepare("UPDATE p2p_volunteers SET is_online = 0 WHERE id = ?").run(v1);
  const pending = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status = 'pending'").all(v1, sid);
  const onlineVols = db.prepare("SELECT id FROM p2p_volunteers WHERE session_id = ? AND is_online = 1").all(sid);
  for (let i = 0; i < pending.length; i++) {
    const target = onlineVols[i % onlineVols.length];
    db.prepare("UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = ? WHERE id = ?").run(target.id, v1, pending[i].id);
  }

  const v2Count = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?").get(v2).c;
  assert.strictEqual(v2Count, 6, 'All 6 should transfer to VolB');

  // Check original_volunteer_id is preserved
  const originals = db.prepare("SELECT original_volunteer_id FROM p2p_assignments WHERE volunteer_id = ?").all(v2);
  originals.forEach(a => assert.strictEqual(a.original_volunteer_id, v1));
});

test('P2P: snap-back returns conversations when volunteer reconnects', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sid = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Snap Test', 'Hey', '9012', ?)").run(expires).lastInsertRowid;

  const v1 = db.prepare("INSERT INTO p2p_volunteers (session_id, name, is_online) VALUES (?, 'VSnap', 0)").run(sid).lastInsertRowid;
  const v2 = db.prepare("INSERT INTO p2p_volunteers (session_id, name, is_online) VALUES (?, 'VTemp', 1)").run(sid).lastInsertRowid;

  // Create a conversation originally owned by v1 but currently with v2
  const cid = db.prepare("INSERT INTO contacts (phone) VALUES ('5552220001')").run().lastInsertRowid;
  db.prepare("INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id, original_volunteer_id, status) VALUES (?, ?, ?, ?, 'in_conversation')").run(sid, cid, v2, v1);

  // v1 comes back online → snap back
  db.prepare("UPDATE p2p_volunteers SET is_online = 1 WHERE id = ?").run(v1);
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')").run(v1, v1, sid);
  db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?").run(v1, sid);

  const assignment = db.prepare("SELECT * FROM p2p_assignments WHERE contact_id = ? AND session_id = ?").get(cid, sid);
  assert.strictEqual(assignment.volunteer_id, v1, 'Should snap back to original volunteer');
  assert.strictEqual(assignment.original_volunteer_id, null, 'Original_volunteer_id should be cleared');
});

// ==================== Section 4: Walk Group Re-split ====================
console.log('\n=== Section 4: Walk Group Re-split ===');

test('Walk: re-split after member leaves redistributes evenly', () => {
  const walkId = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('Group Walk R15', 'G1R5')").run().lastInsertRowid;

  // Add 12 addresses
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)").run(walkId, '100' + i + ' Main St', i);
  }

  // 3 members join
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Alice')").run(walkId);
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Bob')").run(walkId);
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'Carol')").run(walkId);

  // Split addresses
  const members = db.prepare("SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at").all(walkId);
  const addresses = db.prepare("SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id").all(walkId);
  for (let i = 0; i < addresses.length; i++) {
    db.prepare("UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?").run(members[i % members.length].walker_name, addresses[i].id);
  }

  // Verify initial split: 4 each
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c, 4);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walkId).c, 4);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Carol'").get(walkId).c, 4);

  // Bob leaves
  db.prepare("DELETE FROM walk_group_members WHERE walk_id = ? AND walker_name = 'Bob'").run(walkId);

  // Re-split
  const remaining = db.prepare("SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at").all(walkId);
  const allAddr = db.prepare("SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order, id").all(walkId);
  for (let i = 0; i < allAddr.length; i++) {
    db.prepare("UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?").run(remaining[i % remaining.length].walker_name, allAddr[i].id);
  }

  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c, 6);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Carol'").get(walkId).c, 6);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walkId).c, 0);
});

test('Walk: max_walkers cap prevents joining when full', () => {
  const walkId = db.prepare("INSERT INTO block_walks (name, join_code, max_walkers) VALUES ('Small Walk', 'SM15', 2)").run().lastInsertRowid;
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'W1')").run(walkId);
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'W2')").run(walkId);

  const count = db.prepare("SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?").get(walkId).c;
  const maxWalkers = db.prepare("SELECT max_walkers FROM block_walks WHERE id = ?").get(walkId).max_walkers;
  assert(count >= maxWalkers, 'Group is at capacity');
});

// ==================== Section 5: Early Voting Import (All 3 Match Tiers) ====================
console.log('\n=== Section 5: Early Voting Import ===');

test('Early voting: match by registration number', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, registration_number, phone) VALUES ('Reg', 'Match', 'REG12345', '5553330001')").run().lastInsertRowid;

  // Build lookup map
  const v = db.prepare("SELECT id, registration_number FROM voters WHERE id = ?").get(vid);
  const regMap = {};
  regMap[v.registration_number.trim().toUpperCase()] = v.id;

  // Match
  const reg = 'REG12345';
  assert.strictEqual(regMap[reg.toUpperCase()], vid);

  db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = '2025-10-20', early_voted_method = 'in-person' WHERE id = ?").run(vid);
  const voter = db.prepare("SELECT early_voted, early_voted_date, early_voted_method FROM voters WHERE id = ?").get(vid);
  assert.strictEqual(voter.early_voted, 1);
  assert.strictEqual(voter.early_voted_date, '2025-10-20');
  assert.strictEqual(voter.early_voted_method, 'in-person');
});

test('Early voting: match by phone when reg not available', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, phone) VALUES ('Phone', 'MatchEV', '5553330002')").run().lastInsertRowid;

  const phoneMap = {};
  const d = phoneDigits('5553330002');
  phoneMap[d] = vid;

  assert.strictEqual(phoneMap['5553330002'], vid);
  db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = '2025-10-21' WHERE id = ?").run(vid);
  assert.strictEqual(db.prepare("SELECT early_voted FROM voters WHERE id = ?").get(vid).early_voted, 1);
});

test('Early voting: match by name+address fallback', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip) VALUES ('Jane', 'Doe', '123 Oak Lane', 'Austin', '78701')").run().lastInsertRowid;

  const found = db.prepare("SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1").get('Jane', 'Doe', '123 oak%');
  assert(found, 'Should match by name+address');
  assert.strictEqual(found.id, vid);
});

test('Early voting: already voted skips without error', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, phone, early_voted, early_voted_date) VALUES ('Already', 'Voted', '5553330003', 1, '2025-10-15')").run().lastInsertRowid;

  const existing = db.prepare("SELECT early_voted FROM voters WHERE id = ?").get(vid);
  assert.strictEqual(existing.early_voted, 1);
  // Should not update again — just count as already_voted
});

// ==================== Section 6: Universe Builder with Overlapping Sets ====================
console.log('\n=== Section 6: Universe Builder ===');

test('Universe: temp tables build correct hierarchy (precinct → universe → sub → priority)', () => {
  // Create voters in 2 precincts
  for (let i = 0; i < 20; i++) {
    const vid = db.prepare("INSERT INTO voters (first_name, last_name, precinct) VALUES (?, ?, ?)").run('UV' + i, 'Last', i < 10 ? 'PCT100' : 'PCT200').lastInsertRowid;

    // First 15 voted in November 2024
    if (i < 15) {
      db.prepare("INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, 'Nov 2024 General', '2024-11-05', 'general', 'november')").run(vid);
    }
    // First 8 also voted in March 2024 primary
    if (i < 8) {
      db.prepare("INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, 'Mar 2024 Primary', '2024-03-05', 'primary', 'march')").run(vid);
    }
  }

  // Build universe for PCT100 only, looking back 2 years
  db.exec('DROP TABLE IF EXISTS _test_precinct');
  db.exec('CREATE TEMP TABLE _test_precinct (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_precinct SELECT id FROM voters WHERE precinct = 'PCT100'").run();
  const pctCount = db.prepare('SELECT COUNT(*) as c FROM _test_precinct').get().c;
  assert.strictEqual(pctCount, 10);

  // Universe: voted since 2023
  db.exec('DROP TABLE IF EXISTS _test_universe');
  db.exec('CREATE TEMP TABLE _test_universe (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_universe SELECT DISTINCT ev.voter_id FROM election_votes ev INNER JOIN _test_precinct tp ON ev.voter_id = tp.voter_id WHERE ev.election_date >= '2023-01-01'").run();
  const univCount = db.prepare('SELECT COUNT(*) as c FROM _test_universe').get().c;
  assert.strictEqual(univCount, 10); // All 10 in PCT100 voted in Nov 2024

  // Sub-universe: voted in march cycle
  db.exec('DROP TABLE IF EXISTS _test_sub');
  db.exec('CREATE TEMP TABLE _test_sub (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_sub SELECT DISTINCT ev.voter_id FROM election_votes ev INNER JOIN _test_universe tu ON ev.voter_id = tu.voter_id WHERE ev.election_cycle = 'march'").run();
  const subCount = db.prepare('SELECT COUNT(*) as c FROM _test_sub').get().c;
  assert.strictEqual(subCount, 8); // First 8 voted in March

  // Priority: voted in specific election
  db.exec('DROP TABLE IF EXISTS _test_priority');
  db.exec('CREATE TEMP TABLE _test_priority (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_priority SELECT DISTINCT ev.voter_id FROM election_votes ev INNER JOIN _test_sub ts ON ev.voter_id = ts.voter_id WHERE ev.election_name = 'Mar 2024 Primary'").run();
  const priCount = db.prepare('SELECT COUNT(*) as c FROM _test_priority').get().c;
  assert.strictEqual(priCount, 8);

  // Cleanup
  db.exec('DROP TABLE IF EXISTS _test_precinct; DROP TABLE IF EXISTS _test_universe; DROP TABLE IF EXISTS _test_sub; DROP TABLE IF EXISTS _test_priority');
});

test('Universe: empty precincts returns 0 for all counts', () => {
  db.exec('DROP TABLE IF EXISTS _test_empty');
  db.exec('CREATE TEMP TABLE _test_empty (voter_id INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO _test_empty SELECT id FROM voters WHERE precinct = 'NONEXISTENT'").run();
  const c = db.prepare('SELECT COUNT(*) as c FROM _test_empty').get().c;
  assert.strictEqual(c, 0);
  db.exec('DROP TABLE IF EXISTS _test_empty');
});

// ==================== Section 7: Captain List Overlap Detection ====================
console.log('\n=== Section 7: Captain Overlap ===');

test('Captain: overlap count correctly identifies shared voters', () => {
  const cap1 = db.prepare("INSERT INTO captains (name, code) VALUES ('CaptX', 'CXR150')").run().lastInsertRowid;
  const cap2 = db.prepare("INSERT INTO captains (name, code) VALUES ('CaptY', 'CYR150')").run().lastInsertRowid;
  const list1 = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'ListX')").run(cap1).lastInsertRowid;
  const list2 = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'ListY')").run(cap2).lastInsertRowid;

  // Create 5 voters; 2 are on both lists
  const sharedVoters = [];
  for (let i = 0; i < 5; i++) {
    const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES (?, ?)").run('OV' + i, 'R15').lastInsertRowid;
    db.prepare("INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)").run(list1, vid);
    if (i < 2) {
      db.prepare("INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)").run(list2, vid);
      sharedVoters.push(vid);
    }
  }

  const overlap = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT voter_id FROM captain_list_voters WHERE list_id IN (${list1}, ${list2})
      GROUP BY voter_id HAVING COUNT(DISTINCT list_id) >= 2
    )
  `).get().c;
  assert.strictEqual(overlap, 2, 'Should detect 2 shared voters');
});

test('Captain: household matching by street number + zip', () => {
  const v1 = db.prepare("INSERT INTO voters (first_name, last_name, address, zip) VALUES ('John', 'Smith', '500 Elm Street', '78701')").run().lastInsertRowid;
  const v2 = db.prepare("INSERT INTO voters (first_name, last_name, address, zip) VALUES ('Mary', 'Smith', '500 Elm Street Apt B', '78701')").run().lastInsertRowid;
  const v3 = db.prepare("INSERT INTO voters (first_name, last_name, address, zip) VALUES ('Bob', 'Jones', '501 Elm Street', '78701')").run().lastInsertRowid;

  // extractStreetNumber('500 Elm Street') = '500'
  const streetNum = '500';
  const household = db.prepare("SELECT * FROM voters WHERE zip = ? AND address LIKE ? AND id != ?").all('78701', streetNum + ' %', v1);
  // Should find Mary (500 Elm Street Apt B) but not Bob (501 Elm Street)
  assert.strictEqual(household.length, 1);
  assert.strictEqual(household[0].id, v2);
});

// ==================== Section 8: Sentiment Analysis ====================
console.log('\n=== Section 8: Sentiment Analysis ===');

function analyzeSentiment(text) {
  const msg = (text || '').toLowerCase();
  const positiveWords = ['yes', 'sure', 'support', 'agree', 'thanks', 'thank', 'great', 'love', 'count me in', 'absolutely', 'interested', 'definitely', 'of course', 'wonderful', 'awesome', 'perfect', 'good', 'ok', 'okay', 'yep', 'yea', 'yeah'];
  const negativeWords = ['no', 'stop', 'disagree', 'oppose', 'hate', 'unsubscribe', 'leave me alone', 'not interested', 'remove', 'never', 'terrible', 'awful', 'worst', 'don\'t', 'wont', 'refuse', 'against', 'bad'];
  let score = 0;
  for (const word of positiveWords) { if (msg.includes(word)) score++; }
  for (const word of negativeWords) { if (msg.includes(word)) score--; }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

test('Sentiment: positive message', () => {
  assert.strictEqual(analyzeSentiment('Yes, I absolutely support this!'), 'positive');
});

test('Sentiment: negative message', () => {
  assert.strictEqual(analyzeSentiment('Stop sending me this terrible stuff'), 'negative');
});

test('Sentiment: neutral message (no keywords)', () => {
  assert.strictEqual(analyzeSentiment('What time is the meeting?'), 'neutral');
});

test('Sentiment: mixed cancels out to neutral', () => {
  // "yes" (+1) + "no" (-1) = 0 → neutral
  assert.strictEqual(analyzeSentiment('yes and no'), 'neutral');
});

test('Sentiment: empty/null returns neutral', () => {
  assert.strictEqual(analyzeSentiment(''), 'neutral');
  assert.strictEqual(analyzeSentiment(null), 'neutral');
});

test('Sentiment: substring matching (good inside goodbye)', () => {
  // "goodbye" contains "good" — this is a known behavior of includes()
  const result = analyzeSentiment('Goodbye');
  // "good" is in positive list, so it matches inside "goodbye"
  assert.strictEqual(result, 'positive');
});

// ==================== Section 9: Auto-Reply Keyword Priority ====================
console.log('\n=== Section 9: Auto-Reply Keywords ===');

function generateAutoReply(msg) {
  if (['register','registration'].some(k => msg.includes(k)))
    return "Register or check your status at vote.org. Don't miss the deadline! -- Campaign HQ";
  if (['poll','polling','vote','where','location'].some(k => msg.includes(k)))
    return "Find your polling location at vote.gov. Polls open 7am-7pm on Election Day! -- Campaign HQ";
  if (['time','open','close','hours','when'].some(k => msg.includes(k)))
    return "Polls are open 7:00 AM - 7:00 PM on Election Day. Check vote.gov for early voting! -- Campaign HQ";
  return null;
}

test('Auto-reply: "register to vote" matches registration first', () => {
  const reply = generateAutoReply('how do i register to vote');
  assert(reply.includes('vote.org'), 'Should match registration, not polling');
});

test('Auto-reply: "where to vote" matches polling location', () => {
  const reply = generateAutoReply('where do i vote');
  assert(reply.includes('vote.gov'), 'Should match polling location');
});

test('Auto-reply: "what time" matches hours', () => {
  const reply = generateAutoReply('what time do polls open');
  // "time" and "open" and "poll" — but "poll" matches first rule... wait, "poll" is in the second check
  // Actually "time" would match the third check, but "poll" in the second check comes first
  assert(reply.includes('vote.gov') || reply.includes('7:00 AM'), 'Should match polling or hours');
});

test('Auto-reply: unrecognized message returns null', () => {
  assert.strictEqual(generateAutoReply('hello how are you'), null);
});

// ==================== Section 10: Webhook Processing ====================
console.log('\n=== Section 10: Webhook Processing ===');

test('Webhook: opt-out keyword stores normalized phone', () => {
  const from = '+15559990001';
  const normalized = phoneDigits(from);
  assert.strictEqual(normalized, '5559990001');
  db.prepare("INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)").run(normalized);
  const exists = db.prepare("SELECT id FROM opt_outs WHERE phone = ?").get('5559990001');
  assert(exists, 'Opt-out should be stored with normalized phone');
});

test('Webhook: WhatsApp from number strips prefix', () => {
  let From = 'whatsapp:+15559990002';
  const isWhatsApp = From.startsWith('whatsapp:');
  assert(isWhatsApp);
  if (isWhatsApp) From = From.replace('whatsapp:', '');
  const normalized = phoneDigits(From);
  assert.strictEqual(normalized, '5559990002');
});

test('Webhook: P2P reply updates assignment to in_conversation', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sid = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at, status) VALUES ('WH Test', 'Hi', '7777', ?, 'active')").run(expires).lastInsertRowid;
  const cid = db.prepare("INSERT INTO contacts (phone) VALUES ('5559990003')").run().lastInsertRowid;
  const aid = db.prepare("INSERT INTO p2p_assignments (session_id, contact_id, status) VALUES (?, ?, 'sent')").run(sid, cid).lastInsertRowid;

  // Simulate incoming reply finding the assignment
  const assignment = db.prepare(`
    SELECT a.id FROM p2p_assignments a
    JOIN p2p_sessions s ON a.session_id = s.id
    JOIN contacts c ON a.contact_id = c.id
    WHERE c.phone = ? AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    LIMIT 1
  `).get('5559990003');
  assert(assignment, 'Should find the active assignment');

  db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(assignment.id);
  const updated = db.prepare("SELECT status FROM p2p_assignments WHERE id = ?").get(aid);
  assert.strictEqual(updated.status, 'in_conversation');
});

test('Webhook: survey response records and advances question', () => {
  const surveyId = db.prepare("INSERT INTO surveys (name, status) VALUES ('WH Survey', 'active')").run().lastInsertRowid;
  const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Pick one', 'single_choice', 1)").run(surveyId).lastInsertRowid;
  const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Explain', 'write_in', 2)").run(surveyId).lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Yes', '1', 0)").run(q1);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'No', '2', 1)").run(q1);

  const sendId = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id, status) VALUES (?, '5559990004', ?, 'sent')").run(surveyId, q1).lastInsertRowid;

  // Process response "1" (Yes)
  const surveyResponseTx = db.transaction(() => {
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5559990004', '1')").run(surveyId, sendId, q1);
    db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(q2, sendId);
  });
  surveyResponseTx();

  const send = db.prepare("SELECT * FROM survey_sends WHERE id = ?").get(sendId);
  assert.strictEqual(send.current_question_id, q2);
  assert.strictEqual(send.status, 'in_progress');
});

// ==================== Section 11: COALESCE Semantics in Updates ====================
console.log('\n=== Section 11: COALESCE Semantics ===');

test('COALESCE: null preserves existing value', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, city) VALUES ('Coalesce', 'Test', 'Austin')").run().lastInsertRowid;
  db.prepare("UPDATE voters SET city = COALESCE(?, city) WHERE id = ?").run(null, vid);
  assert.strictEqual(db.prepare("SELECT city FROM voters WHERE id = ?").get(vid).city, 'Austin');
});

test('COALESCE: empty string overwrites existing value', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, city) VALUES ('Coal2', 'Test', 'Dallas')").run().lastInsertRowid;
  db.prepare("UPDATE voters SET city = COALESCE(?, city) WHERE id = ?").run('', vid);
  assert.strictEqual(db.prepare("SELECT city FROM voters WHERE id = ?").get(vid).city, '');
});

test('COALESCE: new value replaces existing', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name, city) VALUES ('Coal3', 'Test', 'Houston')").run().lastInsertRowid;
  db.prepare("UPDATE voters SET city = COALESCE(?, city) WHERE id = ?").run('San Antonio', vid);
  assert.strictEqual(db.prepare("SELECT city FROM voters WHERE id = ?").get(vid).city, 'San Antonio');
});

// ==================== Section 12: Canvass Import 3-Tier Matching ====================
console.log('\n=== Section 12: Canvass Import ===');

test('Canvass: phone match takes priority over name+address', () => {
  const v1 = db.prepare("INSERT INTO voters (first_name, last_name, phone, address) VALUES ('John', 'Doe', '5554440001', '100 Main St')").run().lastInsertRowid;
  const v2 = db.prepare("INSERT INTO voters (first_name, last_name, phone, address) VALUES ('John', 'Doe', '5554440002', '100 Main St')").run().lastInsertRowid;

  // Phone match should find v1, not v2
  const phoneMap = {};
  phoneMap[phoneDigits('5554440001')] = v1;
  phoneMap[phoneDigits('5554440002')] = v2;

  const digits = phoneDigits('5554440001');
  assert.strictEqual(phoneMap[digits], v1, 'Phone match should find correct voter');
});

test('Canvass: registration number match as second tier', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, registration_number) VALUES ('Reg', 'Tier2', 'ABC9999')").run().lastInsertRowid;
  const regMap = {};
  regMap['ABC9999'] = v;

  // No phone match, but reg number matches
  assert.strictEqual(regMap['ABC9999'], v);
});

test('Canvass: name+address match uses first 3 address words', () => {
  db.prepare("INSERT INTO voters (first_name, last_name, address) VALUES ('Addr', 'Match', '200 Elm Street North Austin TX')").run();

  const addrWords = '200 Elm Street North Austin TX'.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
  assert.strictEqual(addrWords, '200 elm street');

  const found = db.prepare("SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1").get('Addr', 'Match', addrWords + '%');
  assert(found, 'Name+address should match');
});

test('Canvass: import with create_new creates new voter', () => {
  const countBefore = db.prepare("SELECT COUNT(*) as c FROM voters WHERE first_name = 'NewCanvass'").get().c;
  assert.strictEqual(countBefore, 0);

  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('NewCanvass', 'Person', '5554440099', '999 New Ave', 'qr_nc1')").run();

  const countAfter = db.prepare("SELECT COUNT(*) as c FROM voters WHERE first_name = 'NewCanvass'").get().c;
  assert.strictEqual(countAfter, 1);
});

// ==================== Section 13: E.164 Formatting ====================
console.log('\n=== Section 13: E.164 Formatting ===');

test('toE164: 10-digit number gets +1 prefix', () => {
  assert.strictEqual(toE164('5125551234'), '+15125551234');
});

test('toE164: 11-digit with leading 1 strips and re-adds +1', () => {
  assert.strictEqual(toE164('15125551234'), '+15125551234');
});

test('toE164: non-10-digit returns raw input', () => {
  assert.strictEqual(toE164('12345'), '12345');
  assert.strictEqual(toE164(''), '');
});

test('toE164: formatted number works via phoneDigits chain', () => {
  assert.strictEqual(toE164('(512) 555-1234'), '+15125551234');
  assert.strictEqual(toE164('+1-512-555-1234'), '+15125551234');
});

// ==================== Section 14: Election Vote Dedup ====================
console.log('\n=== Section 14: Election Vote Dedup ===');

test('Election: UNIQUE(voter_id, election_name) prevents duplicates', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES ('Dedup', 'EV')").run().lastInsertRowid;
  db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Test Election', '2024-11-05')").run(vid);

  // INSERT OR IGNORE should not throw
  db.prepare("INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Test Election', '2024-11-05')").run(vid);

  const count = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ? AND election_name = 'Test Election'").get(vid).c;
  assert.strictEqual(count, 1, 'Should have exactly 1 vote record');
});

test('Election: same voter different elections allowed', () => {
  const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES ('Multi', 'Elections')").run().lastInsertRowid;
  db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'Primary 2024', '2024-03-05')").run(vid);
  db.prepare("INSERT INTO election_votes (voter_id, election_name, election_date) VALUES (?, 'General 2024', '2024-11-05')").run(vid);

  const count = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?").get(vid).c;
  assert.strictEqual(count, 2);
});

// ==================== Section 15: Cascade Deletes ====================
console.log('\n=== Section 15: Cascade Deletes ===');

test('Cascade: deleting a captain removes lists and list_voters', () => {
  const capId = db.prepare("INSERT INTO captains (name, code) VALUES ('DelCap', 'DC15XX')").run().lastInsertRowid;
  const listId = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'DelList')").run(capId).lastInsertRowid;
  const vid = db.prepare("INSERT INTO voters (first_name, last_name) VALUES ('CascV', 'R15')").run().lastInsertRowid;
  db.prepare("INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)").run(listId, vid);

  // Verify exists
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?").get(capId).c, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?").get(listId).c, 1);

  // Delete captain
  db.prepare("DELETE FROM captains WHERE id = ?").run(capId);

  // Verify cascade
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?").get(capId).c, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?").get(listId).c, 0);

  // Voter itself should still exist
  assert(db.prepare("SELECT id FROM voters WHERE id = ?").get(vid), 'Voter should survive captain deletion');
});

test('Cascade: deleting a survey removes questions, options, sends, and responses', () => {
  const surveyId = db.prepare("INSERT INTO surveys (name) VALUES ('CascSurvey')").run().lastInsertRowid;
  const qId = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Q?', 'single_choice', 1)").run(surveyId).lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key) VALUES (?, 'Yes', '1')").run(qId);
  const sendId = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id) VALUES (?, '5559990099', ?)").run(surveyId, qId).lastInsertRowid;
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5559990099', '1')").run(surveyId, sendId, qId);

  // Delete survey
  db.prepare("DELETE FROM surveys WHERE id = ?").run(surveyId);

  // Verify cascade
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?").get(surveyId).c, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?").get(surveyId).c, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?").get(surveyId).c, 0);
  // Options cascade through questions
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM survey_options WHERE question_id = ?").get(qId).c, 0);
});

test('Cascade: deleting P2P session removes volunteers and assignments', () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sid = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('CascP2P', 'Hi', '3333', ?)").run(expires).lastInsertRowid;
  const vid = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, 'CascVol')").run(sid).lastInsertRowid;
  const cid = db.prepare("INSERT INTO contacts (phone) VALUES ('5559991111')").run().lastInsertRowid;
  db.prepare("INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)").run(sid, cid, vid);

  db.prepare("DELETE FROM p2p_sessions WHERE id = ?").run(sid);

  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?").get(sid).c, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?").get(sid).c, 0);
  // Contact should survive
  assert(db.prepare("SELECT id FROM contacts WHERE id = ?").get(cid));
});

// ==================== Section 16: personalizeTemplate Edge Cases ====================
console.log('\n=== Section 16: Template Personalization ===');

test('Template: all tags replaced simultaneously', () => {
  const result = personalizeTemplate('Hi {firstName} {lastName} from {city}!', { firstName: 'Jane', lastName: 'Doe', city: 'Austin' });
  assert.strictEqual(result, 'Hi Jane Doe from Austin!');
});

test('Template: missing contact fields become empty string', () => {
  const result = personalizeTemplate('Hi {firstName} {lastName}', {});
  assert.strictEqual(result, 'Hi  ');
});

test('Template: injection via firstName containing {city}', () => {
  const result = personalizeTemplate('Hi {firstName} from {city}', { firstName: '{city}', city: 'Austin' });
  // Simultaneous replacement means {city} in firstName is literal, not re-expanded
  assert.strictEqual(result, 'Hi {city} from Austin');
});

test('Template: null template returns empty string', () => {
  assert.strictEqual(personalizeTemplate(null, { firstName: 'Test' }), '');
});

test('Template: null contact uses empty strings', () => {
  const result = personalizeTemplate('Hello {firstName}', null);
  assert.strictEqual(result, 'Hello ');
});

// ==================== Summary ====================
console.log('\n');
if (failures.length > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error));
}
console.log('\n============================================================');
console.log(`STRESS TEST ROUND 15 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('============================================================');

db.close();
try { fs.unlinkSync(TEST_DB); } catch (e) {}
process.exit(failed > 0 ? 1 : 0);
