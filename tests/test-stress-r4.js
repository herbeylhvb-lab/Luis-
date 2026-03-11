#!/usr/bin/env node
/**
 * Stress Test Round 4 — Route logic verification + data integrity after mutations
 * Tests: route-level logic, bulk operations with verify, survey state machine,
 *        P2P volunteer lifecycle, captain auth flow, walk state management,
 *        event invite dedup, early voting flow, election vote analytics
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'data');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'test_stress_r4.db');
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

// Full schema (compressed)
db.exec(`
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '', preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT, session_id INTEGER, volunteer_name TEXT, channel TEXT DEFAULT 'sms');
  CREATE TABLE opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '', status TEXT DEFAULT 'upcoming', created_at TEXT DEFAULT (datetime('now')), flyer_image TEXT DEFAULT NULL);
  CREATE TABLE event_rsvps (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '', rsvp_status TEXT DEFAULT 'invited', invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT, checked_in_at TEXT);
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);
  CREATE TABLE voters (id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '', support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '', registration_number TEXT DEFAULT '', qr_token TEXT, voting_history TEXT DEFAULT '', precinct TEXT DEFAULT '', early_voted INTEGER DEFAULT 0, early_voted_date TEXT, early_voted_method TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_voters_phone ON voters(phone);
  CREATE INDEX idx_voters_name ON voters(last_name, first_name);
  CREATE TABLE voter_contacts (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '', contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL, assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL, status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL, session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_volunteers (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_assignments (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, volunteer_id INTEGER REFERENCES p2p_volunteers(id), contact_id INTEGER NOT NULL REFERENCES contacts(id), status TEXT DEFAULT 'pending', original_volunteer_id INTEGER, assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT);
  CREATE INDEX idx_p2p_assign_vol_status ON p2p_assignments(volunteer_id, status);
  CREATE TABLE captains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_lists (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL, name TEXT NOT NULL, list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE captain_team_members (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER, responded_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE block_walks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', assigned_to TEXT DEFAULT '', status TEXT DEFAULT 'pending', join_code TEXT, max_walkers INTEGER DEFAULT 4, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE walk_addresses (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, address TEXT NOT NULL, unit TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', voter_name TEXT DEFAULT '', result TEXT DEFAULT 'not_visited', notes TEXT DEFAULT '', knocked_at TEXT, sort_order INTEGER DEFAULT 0, voter_id INTEGER, lat REAL, lng REAL, assigned_walker TEXT);
  CREATE TABLE walk_group_members (id INTEGER PRIMARY KEY, walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE, walker_name TEXT NOT NULL, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(walk_id, walker_name));
  CREATE TABLE election_votes (id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, election_name TEXT NOT NULL, election_date TEXT NOT NULL, election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '', voted INTEGER DEFAULT 1, UNIQUE(voter_id, election_name));
  CREATE TABLE campaigns (id INTEGER PRIMARY KEY, message_template TEXT, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT DEFAULT '', role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
  CREATE TABLE campaign_knowledge (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE response_scripts (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`);

const { phoneDigits, normalizePhone, personalizeTemplate, generateJoinCode } = require('./utils');

console.log('=== STRESS TEST ROUND 4 — ROUTE LOGIC + DATA INTEGRITY ===\n');

// =============================================================================
// Seed data
// =============================================================================
console.log('[Seeding data...]');
const voterIds = [];
db.transaction(() => {
  const ins = db.prepare('INSERT INTO voters (first_name, last_name, phone, address, city, zip, party, support_level, precinct, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 5000; i++) {
    voterIds.push(ins.run('First' + i, 'Last' + i, normalizePhone('512555' + String(i).padStart(4, '0')), i + ' Main St', 'Austin', '78701', i % 2 === 0 ? 'D' : 'R', 'unknown', 'PCT-' + (i % 20), 'qr_' + i).lastInsertRowid);
  }
})();

const contactIds = [];
db.transaction(() => {
  const ins = db.prepare("INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 2000; i++) {
    contactIds.push(ins.run('512555' + String(i).padStart(4, '0'), 'CFirst' + i, 'CLast' + i, 'Austin', 'c' + i + '@test.com').lastInsertRowid);
  }
})();
console.log(' Done.\n');

// =============================================================================
// TEST 1: Survey state machine — draft -> active -> closed with responses
// =============================================================================
console.log('[1] Survey state machine...');

// Create survey
const survId = db.prepare("INSERT INTO surveys (name, status) VALUES ('Poll: Favorite Park', 'draft')").run().lastInsertRowid;
let survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(survId);
assert(survey.status === 'draft', 'Survey starts as draft');

// Add questions
const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Favorite park?', 'single_choice', 1)").run(survId).lastInsertRowid;
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key) VALUES (?, 'Zilker', '1'), (?, 'Barton Springs', '2'), (?, 'Mueller', '3')").run(q1, q1, q1);

const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Why?', 'write_in', 2)").run(survId).lastInsertRowid;

// Activate
db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(survId);
survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(survId);
assert(survey.status === 'active', 'Survey activated');

// Simulate sends + responses
const sends = [];
db.transaction(() => {
  for (let i = 0; i < 100; i++) {
    const phone = '512555' + String(i).padStart(4, '0');
    const sid = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, ?, ?, ?)")
      .run(survId, phone, 'Person ' + i, q1).lastInsertRowid;
    sends.push(sid);
  }
})();

// 80 people answer Q1
db.transaction(() => {
  for (let i = 0; i < 80; i++) {
    const phone = '512555' + String(i).padStart(4, '0');
    const pick = String((i % 3) + 1);
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)").run(survId, sends[i], q1, phone, pick);
    db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(q2, sends[i]);
  }
})();

// 50 of those answer Q2
db.transaction(() => {
  for (let i = 0; i < 50; i++) {
    const phone = '512555' + String(i).padStart(4, '0');
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)").run(survId, sends[i], q2, phone, 'Because its beautiful');
    db.prepare("UPDATE survey_sends SET status = 'completed', current_question_id = NULL WHERE id = ?").run(sends[i]);
  }
})();

// Close survey — expire remaining
db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(survId);
const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(survId);

const sendStats = {
  total: db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(survId).c,
  completed: db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(survId).c,
  expired: expired.changes,
};
assert(sendStats.total === 100, 'Survey: 100 sends');
assert(sendStats.completed === 50, 'Survey: 50 completed');
assert(sendStats.expired === 50, 'Survey: 50 expired (20 never answered + 30 only answered Q1)');

// Results tally
const q1Results = db.prepare('SELECT response_text, COUNT(*) as c FROM survey_responses WHERE question_id = ? GROUP BY response_text').all(q1);
const totalQ1 = q1Results.reduce((s, r) => s + r.c, 0);
assert(totalQ1 === 80, 'Q1: 80 responses tallied');

// =============================================================================
// TEST 2: P2P volunteer join/leave/rejoin with assignment redistribution
// =============================================================================
console.log('\n[2] P2P volunteer lifecycle...');

const sessId = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('Volunteer Test', 'Hi {firstName}!', '7777', '2026-12-31')").run().lastInsertRowid;

// Create assignments
db.transaction(() => {
  const ins = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  for (let i = 0; i < 100; i++) ins.run(sessId, contactIds[i]);
})();

// Vol1 joins — gets assignments
const vol1 = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, 'Alice')").run(sessId).lastInsertRowid;
const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL LIMIT 50").all(sessId);
db.transaction(() => {
  for (const a of unassigned) db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(vol1, a.id);
})();

// Vol2 joins — gets remaining
const vol2 = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, 'Bob')").run(sessId).lastInsertRowid;
const remaining = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL").all(sessId);
db.transaction(() => {
  for (const a of remaining) db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(vol2, a.id);
})();

const vol1Count = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(vol1).c;
const vol2Count = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(vol2).c;
assert(vol1Count === 50, 'Vol1 has 50 assignments');
assert(vol2Count === 50, 'Vol2 has 50 assignments');

// Vol1 sends 10 messages
db.transaction(() => {
  const toSend = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending' LIMIT 10").all(vol1);
  for (const a of toSend) db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(a.id);
})();

// Vol1 goes offline — pending redistributed to Vol2
db.prepare('UPDATE p2p_volunteers SET is_online = 0 WHERE id = ?').run(vol1);
const vol1Pending = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").all(vol1);
db.transaction(() => {
  for (const a of vol1Pending) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = ? WHERE id = ?').run(vol2, vol1, a.id);
  }
})();

const vol2After = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(vol2).c;
assert(vol2After === vol2Count + vol1Pending.length, 'Vol2 got Vol1 pending assignments');

// Vol1 comes back online — snap back
db.prepare('UPDATE p2p_volunteers SET is_online = 1 WHERE id = ?').run(vol1);
db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')")
  .run(vol1, vol1, sessId);
db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?").run(vol1, sessId);

const vol1Sent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'sent'").get(vol1).c;
assert(vol1Sent === 10, 'Vol1 snapped back: has 10 sent assignments');

// =============================================================================
// TEST 3: Captain full lifecycle
// =============================================================================
console.log('\n[3] Captain lifecycle...');

const capId = db.prepare("INSERT INTO captains (name, code, phone, email) VALUES ('Maria', 'CAP001', '5125551111', 'maria@test.com')").run().lastInsertRowid;

// Add team members
const tm1 = db.prepare("INSERT INTO captain_team_members (captain_id, name) VALUES (?, 'TeamMember1')").run(capId).lastInsertRowid;
const tm2 = db.prepare("INSERT INTO captain_team_members (captain_id, name) VALUES (?, 'TeamMember2')").run(capId).lastInsertRowid;

// Create lists
const list1 = db.prepare("INSERT INTO captain_lists (captain_id, team_member_id, name, list_type) VALUES (?, ?, 'Door Knock List', 'block_walk')").run(capId, tm1).lastInsertRowid;
const list2 = db.prepare("INSERT INTO captain_lists (captain_id, team_member_id, name, list_type) VALUES (?, ?, 'Phone Bank List', 'text')").run(capId, tm2).lastInsertRowid;

// Add voters to lists (with overlap)
db.transaction(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');
  for (let i = 0; i < 200; i++) ins.run(list1, voterIds[i]);
  for (let i = 100; i < 300; i++) ins.run(list2, voterIds[i]);
})();

const l1Count = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(list1).c;
const l2Count = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(list2).c;
assert(l1Count === 200, 'Captain list 1: 200 voters');
assert(l2Count === 200, 'Captain list 2: 200 voters');

// Check overlap
const overlapCount = db.prepare(`
  SELECT COUNT(*) as c FROM (
    SELECT voter_id FROM captain_list_voters WHERE list_id IN (?, ?) GROUP BY voter_id HAVING COUNT(DISTINCT list_id) >= 2
  )
`).get(list1, list2).c;
assert(overlapCount === 100, 'Overlap: 100 voters on both lists');

// Deactivate captain
db.prepare('UPDATE captains SET is_active = 0 WHERE id = ?').run(capId);
const cap = db.prepare('SELECT is_active FROM captains WHERE id = ?').get(capId);
assert(cap.is_active === 0, 'Captain deactivated');

// Reactivate
db.prepare('UPDATE captains SET is_active = 1 WHERE id = ?').run(capId);

// Delete team member — lists should keep their voters, team_member_id set to NULL
db.prepare('DELETE FROM captain_team_members WHERE id = ?').run(tm1);
const list1After = db.prepare('SELECT team_member_id FROM captain_lists WHERE id = ?').get(list1);
assert(list1After.team_member_id === null, 'Team member FK set to NULL on delete');
const l1VoterCount = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(list1).c;
assert(l1VoterCount === 200, 'List voters preserved after team member delete');

// =============================================================================
// TEST 4: Early voting flow
// =============================================================================
console.log('\n[4] Early voting flow...');

// Mark some voters as early voted
db.transaction(() => {
  const upd = db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = ?, early_voted_method = ? WHERE id = ?");
  for (let i = 0; i < 500; i++) {
    upd.run('2026-02-20', i % 2 === 0 ? 'in_person' : 'mail', voterIds[i]);
  }
})();

const earlyCount = db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get().c;
assert(earlyCount === 500, '500 voters marked as early voted');

// Stats breakdown
const byMethod = db.prepare("SELECT early_voted_method, COUNT(*) as c FROM voters WHERE early_voted = 1 GROUP BY early_voted_method").all();
assert(byMethod.length === 2, '2 voting methods');
assert(byMethod.find(m => m.early_voted_method === 'in_person').c === 250, '250 in-person');
assert(byMethod.find(m => m.early_voted_method === 'mail').c === 250, '250 by mail');

// Non-early voters query (for GOTV)
const gotvCount = db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 0').get().c;
assert(gotvCount === 4500, '4500 have not voted early');

// Clear one voter's early vote status
const clearTarget = voterIds[0];
db.prepare("UPDATE voters SET early_voted = 0, early_voted_date = NULL, early_voted_method = NULL WHERE id = ?").run(clearTarget);
const cleared = db.prepare('SELECT early_voted, early_voted_date FROM voters WHERE id = ?').get(clearTarget);
assert(cleared.early_voted === 0, 'Voter early vote cleared');
assert(cleared.early_voted_date === null, 'Voter early vote date cleared');

// =============================================================================
// TEST 5: Event check-in flow with dedup
// =============================================================================
console.log('\n[5] Event check-in flow...');

const eventId = db.prepare("INSERT INTO events (title, event_date, location) VALUES ('Town Hall', '2026-03-01', 'City Hall')").run().lastInsertRowid;

// Invite contacts via RSVPs
db.transaction(() => {
  for (let i = 0; i < 50; i++) {
    db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, 'invited')")
      .run(eventId, '512555' + String(i).padStart(4, '0'), 'Guest ' + i);
  }
})();

// Some confirm
db.transaction(() => {
  for (let i = 0; i < 20; i++) {
    db.prepare("UPDATE event_rsvps SET rsvp_status = 'confirmed', responded_at = datetime('now') WHERE event_id = ? AND contact_phone = ?")
      .run(eventId, '512555' + String(i).padStart(4, '0'));
  }
})();

// Some check in (including walk-ins)
db.transaction(() => {
  // Existing RSVP checks in
  for (let i = 0; i < 15; i++) {
    db.prepare("UPDATE event_rsvps SET rsvp_status = 'attended', checked_in_at = datetime('now') WHERE event_id = ? AND contact_phone = ?")
      .run(eventId, '512555' + String(i).padStart(4, '0'));
  }
  // Walk-in
  db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status, checked_in_at) VALUES (?, '5129999999', 'Walk In', 'attended', datetime('now'))")
    .run(eventId);
})();

const rsvpStats = db.prepare(`SELECT
  COUNT(*) as total,
  SUM(CASE WHEN rsvp_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
  SUM(CASE WHEN rsvp_status = 'attended' THEN 1 ELSE 0 END) as attended,
  SUM(CASE WHEN rsvp_status = 'invited' THEN 1 ELSE 0 END) as invited
FROM event_rsvps WHERE event_id = ?`).get(eventId);

assert(rsvpStats.total === 51, 'Event: 51 RSVPs (50 invited + 1 walk-in)');
assert(rsvpStats.attended === 16, 'Event: 16 attended (15 + 1 walk-in)');
assert(rsvpStats.confirmed === 5, 'Event: 5 confirmed (20 - 15 attended)');
assert(rsvpStats.invited === 30, 'Event: 30 still invited');

// Duplicate invite should be ignored
const beforeCount = db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(eventId).c;
db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5125550001', 'Duplicate')").run(eventId);
const afterCount = db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(eventId).c;
assert(afterCount === beforeCount, 'Duplicate RSVP ignored (' + beforeCount + ' -> ' + afterCount + ')');

// =============================================================================
// TEST 6: Walk group mode
// =============================================================================
console.log('\n[6] Walk group mode...');

const walkId = db.prepare("INSERT INTO block_walks (name, join_code, max_walkers) VALUES ('Group Walk', 'GRPW', 4)").run().lastInsertRowid;

// Add addresses
db.transaction(() => {
  for (let i = 0; i < 40; i++) {
    db.prepare("INSERT INTO walk_addresses (walk_id, address, city, zip, sort_order) VALUES (?, ?, 'Austin', '78701', ?)").run(walkId, (i * 10) + ' Elm St', i);
  }
})();

// Add 4 walkers
for (let i = 0; i < 4; i++) {
  try {
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Walker' + i);
  } catch (e) { /* unique constraint */ }
}
// Duplicate walker name rejected
let dupRejected = false;
try {
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Walker0');
} catch (e) { dupRejected = true; }
assert(dupRejected, 'Duplicate walker name rejected');

const walkerCount = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walkId).c;
assert(walkerCount === 4, '4 walkers in group');

// Assign addresses round-robin
const addrs = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order').all(walkId);
db.transaction(() => {
  addrs.forEach((a, i) => {
    db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?').run('Walker' + (i % 4), a.id);
  });
})();

const walker0Addrs = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Walker0'").get(walkId).c;
assert(walker0Addrs === 10, 'Walker0 has 10 addresses (40/4)');

// Simulate knocking with results
const resultTypes = ['not_home', 'door_knock', 'refused', 'not_home', 'door_knock'];
db.transaction(() => {
  for (let i = 0; i < 20; i++) {
    db.prepare("UPDATE walk_addresses SET result = ?, knocked_at = datetime('now'), notes = ? WHERE id = ?")
      .run(resultTypes[i % 5], 'Note for address ' + i, addrs[i].id);
  }
})();

const knocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND result != 'not_visited'").get(walkId).c;
assert(knocked === 20, '20 addresses knocked');
const doorKnocks = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND result = 'door_knock'").get(walkId).c;
assert(doorKnocks === 8, '8 door knocks (20 * 2/5)');

// =============================================================================
// TEST 7: Admin list operations + voter search
// =============================================================================
console.log('\n[7] Admin list operations...');

const alId = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('Campaign Targets', 'Top targets', 'text')").run().lastInsertRowid;

// Add voters
db.transaction(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  for (const vid of voterIds.slice(0, 500)) ins.run(alId, vid);
})();

// Count with phone
const listStats = db.prepare(`
  SELECT COUNT(alv.id) as voterCount,
    SUM(CASE WHEN v.phone != '' AND v.phone IS NOT NULL THEN 1 ELSE 0 END) as withPhone
  FROM admin_list_voters alv
  LEFT JOIN voters v ON alv.voter_id = v.id
  WHERE alv.list_id = ?
`).get(alId);
assert(listStats.voterCount === 500, 'Admin list: 500 voters');
assert(listStats.withPhone === 500, 'All 500 have phones');

// Remove some voters
db.transaction(() => {
  for (let i = 0; i < 100; i++) {
    db.prepare('DELETE FROM admin_list_voters WHERE list_id = ? AND voter_id = ?').run(alId, voterIds[i]);
  }
})();
const afterRemove = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(alId).c;
assert(afterRemove === 400, 'Admin list: 400 after removing 100');

// =============================================================================
// TEST 8: Knowledge base and scripts CRUD
// =============================================================================
console.log('\n[8] Knowledge base CRUD...');

const kbId = db.prepare("INSERT INTO campaign_knowledge (type, title, content) VALUES ('policy', 'Infrastructure Plan', 'Build roads and bridges')").run().lastInsertRowid;
const kb = db.prepare('SELECT * FROM campaign_knowledge WHERE id = ?').get(kbId);
assert(kb.type === 'policy', 'KB entry created');
assert(kb.title === 'Infrastructure Plan', 'KB title correct');

db.prepare("UPDATE campaign_knowledge SET content = 'Updated: build roads, bridges, and transit', updated_at = datetime('now') WHERE id = ?").run(kbId);
const kbUp = db.prepare('SELECT content FROM campaign_knowledge WHERE id = ?').get(kbId);
assert(kbUp.content.includes('transit'), 'KB updated');

// Response scripts
const scrId = db.prepare("INSERT INTO response_scripts (scenario, label, content) VALUES ('healthcare', 'ACA Support', 'We support the ACA...')").run().lastInsertRowid;
const scr = db.prepare('SELECT * FROM response_scripts WHERE id = ?').get(scrId);
assert(scr.scenario === 'healthcare', 'Script created');

db.prepare('DELETE FROM response_scripts WHERE id = ?').run(scrId);
const scrAfter = db.prepare('SELECT * FROM response_scripts WHERE id = ?').get(scrId);
assert(scrAfter === undefined, 'Script deleted');

// =============================================================================
// TEST 9: Messages and opt-out interaction
// =============================================================================
console.log('\n[9] Messages and opt-out...');

// Simulate message flow
db.transaction(() => {
  const ins = db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 200; i++) {
    ins.run('512555' + String(i).padStart(4, '0'), 'Message ' + i, i % 3 === 0 ? 'inbound' : 'outbound', ['positive', 'negative', 'neutral'][i % 3], i % 4 === 0 ? 'whatsapp' : 'sms');
  }
})();

// Opt-out some contacts
for (let i = 0; i < 10; i++) {
  db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run('512555' + String(i).padStart(4, '0'));
}

// Verify opt-out is respected for P2P
const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
let optedOutFound = 0;
for (let i = 0; i < 20; i++) {
  if (optedOutSet.has('512555' + String(i).padStart(4, '0'))) optedOutFound++;
}
assert(optedOutFound === 10, '10 opt-outs found in check');

// WhatsApp channel preference
db.prepare("UPDATE contacts SET preferred_channel = 'whatsapp' WHERE phone = '5125550001'").run();
const pref = db.prepare("SELECT preferred_channel FROM contacts WHERE phone = '5125550001'").get();
assert(pref && pref.preferred_channel === 'whatsapp', 'WhatsApp preference saved');

// =============================================================================
// TEST 10: Election vote analytics
// =============================================================================
console.log('\n[10] Election vote analytics...');

// Import election votes
const elections = [
  { name: '2020 General', date: '2020-11-03', type: 'general', cycle: '2020' },
  { name: '2022 Primary', date: '2022-03-01', type: 'primary', cycle: '2022' },
  { name: '2022 General', date: '2022-11-08', type: 'general', cycle: '2022' },
  { name: '2024 Primary', date: '2024-03-05', type: 'primary', cycle: '2024' },
  { name: '2024 General', date: '2024-11-05', type: 'general', cycle: '2024' },
];

db.transaction(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 5000; i++) {
    const numElections = (i % 5) + 1;
    for (let e = 0; e < numElections; e++) {
      ins.run(voterIds[i], elections[e].name, elections[e].date, elections[e].type, elections[e].cycle);
    }
  }
})();

// All-election participation query
const participation = db.prepare(`
  SELECT election_name, election_date, COUNT(DISTINCT voter_id) as voters
  FROM election_votes GROUP BY election_name ORDER BY election_date
`).all();
assert(participation.length === 5, '5 elections in history');
assert(participation[0].voters === 5000, 'All 5000 voted in 2020 General (every voter has at least 1 election)');

// Super voters (4+ elections)
const superVoters = db.prepare(`
  SELECT v.id, v.first_name, v.last_name, COUNT(ev.id) as elections
  FROM voters v JOIN election_votes ev ON v.id = ev.voter_id
  GROUP BY v.id HAVING elections >= 4
  ORDER BY elections DESC LIMIT 10
`).all();
assert(superVoters.length > 0, 'Found super voters');
assert(superVoters[0].elections >= 4, 'Super voter has 4+ elections');

// Voters who skipped 2024 General (potential GOTV targets)
const skipped2024 = db.prepare(`
  SELECT COUNT(*) as c FROM voters v
  WHERE v.id NOT IN (SELECT voter_id FROM election_votes WHERE election_name = '2024 General')
`).get().c;
assert(skipped2024 > 0, 'Found voters who skipped 2024 General (' + skipped2024 + ')');

// =============================================================================
// TEST 11: Data integrity verification after all mutations
// =============================================================================
console.log('\n[11] Data integrity check...');

// No orphaned captain list voters
const orphanedCLV = db.prepare(`
  SELECT COUNT(*) as c FROM captain_list_voters clv
  WHERE clv.voter_id NOT IN (SELECT id FROM voters)
`).get().c;
assert(orphanedCLV === 0, 'No orphaned captain list voters');

// No orphaned admin list voters
const orphanedALV = db.prepare(`
  SELECT COUNT(*) as c FROM admin_list_voters alv
  WHERE alv.voter_id NOT IN (SELECT id FROM voters)
`).get().c;
assert(orphanedALV === 0, 'No orphaned admin list voters');

// No orphaned P2P assignments
const orphanedAssign = db.prepare(`
  SELECT COUNT(*) as c FROM p2p_assignments pa
  WHERE pa.contact_id NOT IN (SELECT id FROM contacts)
`).get().c;
assert(orphanedAssign === 0, 'No orphaned P2P assignments');

// No orphaned survey responses
const orphanedResp = db.prepare(`
  SELECT COUNT(*) as c FROM survey_responses sr
  WHERE sr.survey_id NOT IN (SELECT id FROM surveys)
`).get().c;
assert(orphanedResp === 0, 'No orphaned survey responses');

// No orphaned voter contacts
const orphanedVC = db.prepare(`
  SELECT COUNT(*) as c FROM voter_contacts vc
  WHERE vc.voter_id NOT IN (SELECT id FROM voters)
`).get().c;
assert(orphanedVC === 0, 'No orphaned voter contacts');

// DB integrity
const integrity = db.pragma('integrity_check')[0].integrity_check;
assert(integrity === 'ok', 'SQLite integrity check passes after all mutations');

// FK check
const fkCheck = db.pragma('foreign_key_check');
assert(fkCheck.length === 0, 'No FK violations (' + fkCheck.length + ')');

// =============================================================================
// RESULTS
// =============================================================================
console.log('\n\n=== ROUND 4 RESULTS ===');
console.log('Passed: ' + passed + '/' + (passed + failed));
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log('  - ' + f));
}

db.close();
try { fs.unlinkSync(testDbPath); } catch (e) {}
process.exit(failed > 0 ? 1 : 0);
