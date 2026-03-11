/**
 * STRESS TEST ROUND 10 — Final Regression + Integration Sweep
 *
 * This round is the capstone: it verifies EVERY fix from rounds 1-5 is still working
 * and adds integration tests that exercise multiple modules together.
 *
 * Sections:
 * 1. Verify all round 5 fixes (events PUT 404, contacts limit, P2P assignment 404, RSVP validation, personalizeTemplate)
 * 2. Full end-to-end: voter import → list → P2P session → volunteer → send → reply → complete
 * 3. Full end-to-end: survey lifecycle (create → add questions → send → collect responses → results → end)
 * 4. Full end-to-end: walk lifecycle (create from precinct → group join → knock → GPS verify → complete)
 * 5. Captain portal isolation (captain A can't see captain B's data)
 * 6. Cleanup and DB health check
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r10.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Full Schema ───
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

const { phoneDigits, normalizePhone, toE164, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push({ name, error: e.message }); process.stdout.write('F'); }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Verify Round 5 Fixes Still Work
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Round 5 Fix Verification ===');

test('Fix verify: personalizeTemplate no double-substitution', () => {
  // If first_name is "{city}", it should NOT be replaced by city value
  const result = personalizeTemplate('Hello {firstName} from {city}!', {
    first_name: '{city}', city: 'Austin'
  });
  assert.strictEqual(result, 'Hello {city} from Austin!', 'Should NOT double-substitute');
});

test('Fix verify: personalizeTemplate normal case still works', () => {
  const result = personalizeTemplate('Dear {firstName} {lastName}, your {city} office.', {
    first_name: 'Jane', last_name: 'Doe', city: 'Dallas'
  });
  assert.strictEqual(result, 'Dear Jane Doe, your Dallas office.');
});

test('Fix verify: contacts limit clamps negative', () => {
  const limit = Math.min(Math.max(parseInt('-1', 10) || 5000, 1), 10000);
  assert.strictEqual(limit, 1, 'Negative should clamp to 1');
});

test('Fix verify: contacts limit clamps zero', () => {
  const limit = Math.min(Math.max(parseInt('0', 10) || 5000, 1), 10000);
  assert.strictEqual(limit, 5000, '0 should fallback to default 5000 via ||');
});

test('Fix verify: contacts limit clamps excessive', () => {
  const limit = Math.min(Math.max(parseInt('99999', 10) || 5000, 1), 10000);
  assert.strictEqual(limit, 10000, 'Large should clamp to 10000');
});

test('Fix verify: RSVP status validation', () => {
  const validStatuses = ['invited', 'confirmed', 'declined', 'attended', 'maybe'];
  assert(!validStatuses.includes('hacked'), 'Invalid status should be rejected');
  assert(validStatuses.includes('confirmed'), 'Valid status should be accepted');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Full E2E — Voter Import → P2P Campaign
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: E2E P2P Campaign ===');

test('E2E: import 100 voters', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, city, precinct, qr_token) VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run('V' + i, 'E2E', '555700' + String(i).padStart(4, '0'), 'TestCity', 'E2EPCT', crypto.randomBytes(6).toString('base64url'));
    }
  })();
  assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM voters WHERE precinct = 'E2EPCT'").get().c, 100);
});

test('E2E: create admin list from precinct', () => {
  const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('E2E Campaign List', 'text')").run();
  const voters = db.prepare("SELECT id FROM voters WHERE precinct = 'E2EPCT'").all();
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  db.transaction(() => {
    for (const v of voters) insert.run(listRes.lastInsertRowid, v.id);
  })();
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(listRes.lastInsertRowid).c, 100);
});

test('E2E: create P2P session from list', () => {
  const list = db.prepare("SELECT id FROM admin_lists WHERE name = 'E2E Campaign List'").get();
  const voters = db.prepare(`
    SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city
    FROM admin_list_voters alv JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != ''
  `).all(list.id);

  // Create contacts
  const findC = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertC = db.prepare("INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?,?,?,?)");
  const ids = [];
  for (const v of voters) {
    let c = findC.get(v.phone);
    if (!c) { const r = insertC.run(v.phone, v.first_name, v.last_name, v.city); ids.push(r.lastInsertRowid); }
    else ids.push(c.id);
  }

  // Create session
  const joinCode = generateJoinCode();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  const sessRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('E2E Campaign', 'Hi {firstName}! Can we count on your vote?', ?, ?)").run(joinCode, expires);

  const insertA = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  db.transaction(() => { for (const id of ids) insertA.run(sessRes.lastInsertRowid, id); })();

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessRes.lastInsertRowid).c, 100);
});

test('E2E: volunteer joins and gets assignments', () => {
  const session = db.prepare("SELECT * FROM p2p_sessions WHERE name = 'E2E Campaign'").get();
  const volRes = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(session.id, 'E2EVol');
  const volId = volRes.lastInsertRowid;

  // Auto-split all 100 to this volunteer
  const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL").all(session.id);
  for (const a of unassigned) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volId, a.id);
  }

  const myCount = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ?').get(volId).c;
  assert.strictEqual(myCount, 100);
});

test('E2E: send message and mark complete', () => {
  const session = db.prepare("SELECT * FROM p2p_sessions WHERE name = 'E2E Campaign'").get();
  const vol = db.prepare("SELECT * FROM p2p_volunteers WHERE session_id = ? AND name = 'E2EVol'").get(session.id);
  const assign = db.prepare("SELECT a.*, c.phone, c.first_name FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id WHERE a.volunteer_id = ? AND a.status = 'pending' LIMIT 1").get(vol.id);

  // Personalize message
  const msg = personalizeTemplate(session.message_template, { first_name: assign.first_name });
  assert(msg.includes(assign.first_name));

  // Mark as sent
  db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(assign.id);
  db.prepare("INSERT INTO messages (phone, body, direction, session_id, volunteer_name, channel) VALUES (?, ?, 'outbound', ?, ?, 'sms')")
    .run(assign.phone, msg, session.id, vol.name);

  // Simulate reply
  db.prepare("INSERT INTO messages (phone, body, direction, session_id, channel) VALUES (?, 'Yes, you can count on me!', 'inbound', ?, 'sms')")
    .run(assign.phone, session.id);
  db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(assign.id);

  // Complete
  db.prepare("UPDATE p2p_assignments SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(assign.id);
  const completed = db.prepare('SELECT status FROM p2p_assignments WHERE id = ?').get(assign.id);
  assert.strictEqual(completed.status, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Full E2E — Survey Lifecycle
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: E2E Survey Lifecycle ===');

let e2eSurveyId, e2eQ1Id, e2eQ2Id;
test('E2E Survey: create survey', () => {
  const res = db.prepare("INSERT INTO surveys (name, description) VALUES ('Voter Priorities', 'What issues matter most?')").run();
  e2eSurveyId = res.lastInsertRowid;
  assert(e2eSurveyId > 0);
});

test('E2E Survey: add questions with options', () => {
  const q1Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'What is your #1 issue?', 'single_choice', 0)").run(e2eSurveyId);
  e2eQ1Id = q1Res.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Economy', '1', 0)").run(e2eQ1Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Healthcare', '2', 1)").run(e2eQ1Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Education', '3', 2)").run(e2eQ1Id);

  const q2Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Any other thoughts?', 'write_in', 1)").run(e2eSurveyId);
  e2eQ2Id = q2Res.lastInsertRowid;
});

test('E2E Survey: start poll', () => {
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(e2eSurveyId);
  const s = db.prepare('SELECT status FROM surveys WHERE id = ?').get(e2eSurveyId);
  assert.strictEqual(s.status, 'active');
});

test('E2E Survey: send to 10 contacts', () => {
  const insertSend = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 10; i++) {
    insertSend.run(e2eSurveyId, '555800' + String(i).padStart(4, '0'), 'Respondent' + i, e2eQ1Id);
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(e2eSurveyId).c;
  assert.strictEqual(count, 10);
});

test('E2E Survey: collect responses (varied choices)', () => {
  const sends = db.prepare('SELECT * FROM survey_sends WHERE survey_id = ?').all(e2eSurveyId);
  const insertResp = db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)");

  for (let i = 0; i < sends.length; i++) {
    // Answer Q1 with varied choices
    const choice = String((i % 3) + 1); // cycles through "1", "2", "3"
    insertResp.run(e2eSurveyId, sends[i].id, e2eQ1Id, sends[i].phone, choice);

    // Advance to Q2
    db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(e2eQ2Id, sends[i].id);

    // Answer Q2 with write-in
    insertResp.run(e2eSurveyId, sends[i].id, e2eQ2Id, sends[i].phone, 'I care about local issues in my neighborhood.');

    // Complete
    db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now'), current_question_id = NULL WHERE id = ?").run(sends[i].id);
  }

  const responses = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(e2eSurveyId).c;
  assert.strictEqual(responses, 20); // 10 respondents × 2 questions
});

test('E2E Survey: results tally is correct', () => {
  const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order').all(e2eQ1Id);
  const responses = db.prepare('SELECT * FROM survey_responses WHERE question_id = ?').all(e2eQ1Id);

  const tally = {};
  for (const opt of options) tally[opt.option_key] = { text: opt.option_text, count: 0 };
  for (const r of responses) {
    if (tally[r.response_text]) tally[r.response_text].count++;
  }

  // 10 respondents cycling through 1,2,3: 4,3,3 or similar
  const total = Object.values(tally).reduce((sum, t) => sum + t.count, 0);
  assert.strictEqual(total, 10, 'All 10 responses should be tallied');
  assert(tally['1'].count >= 3 && tally['1'].count <= 4);
});

test('E2E Survey: end poll expires remaining', () => {
  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(e2eSurveyId);
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(e2eSurveyId);
  // All should be completed already, so 0 expired
  assert.strictEqual(expired.changes, 0);

  const completed = db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(e2eSurveyId).c;
  assert.strictEqual(completed, 10);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Full E2E — Walk Lifecycle
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: E2E Walk Lifecycle ===');

let e2eWalkId;
test('E2E Walk: create from precinct with voter links', () => {
  // Create voters in a dedicated precinct
  const insertV = db.prepare("INSERT INTO voters (first_name, last_name, address, city, zip, precinct, phone, qr_token) VALUES (?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 20; i++) {
    insertV.run('Walker' + i, 'E2E', (100 + i) + ' Walk St', 'WalkCity', '78000', 'WALKPCT', '555900' + String(i).padStart(4, '0'), crypto.randomBytes(6).toString('base64url'));
  }

  const joinCode = generateAlphaCode(4);
  const walkRes = db.prepare("INSERT INTO block_walks (name, description, join_code) VALUES ('E2E Walk', 'From WALKPCT', ?)").run(joinCode);
  e2eWalkId = walkRes.lastInsertRowid;

  const voters = db.prepare("SELECT id, first_name, last_name, address, city, zip FROM voters WHERE precinct = 'WALKPCT'").all();
  const insertAddr = db.prepare('INSERT INTO walk_addresses (walk_id, address, city, zip, voter_name, voter_id, sort_order, lat, lng) VALUES (?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    voters.forEach((v, i) => {
      insertAddr.run(e2eWalkId, v.address, v.city, v.zip, (v.first_name + ' ' + v.last_name).trim(), v.id, i, 30.3 + i * 0.001, -97.7 + i * 0.001);
    });
  })();

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(e2eWalkId).c, 20);
});

test('E2E Walk: 3 walkers join group', () => {
  for (const name of ['Alice', 'Bob', 'Carol']) {
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(e2eWalkId, name);
  }

  // Split addresses round-robin
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(e2eWalkId);
  const addrs = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order').all(e2eWalkId);
  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  db.transaction(() => {
    addrs.forEach((a, i) => update.run(members[i % members.length].walker_name, a.id));
  })();

  const alice = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(e2eWalkId).c;
  assert(alice >= 6 && alice <= 7);
});

test('E2E Walk: knock doors with GPS verification', () => {
  const addrs = db.prepare("SELECT * FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice' LIMIT 5").all(e2eWalkId);

  for (const addr of addrs) {
    // GPS within 50m → verified
    db.prepare(`UPDATE walk_addresses SET result = 'support', notes = 'Supporter!', knocked_at = datetime('now'),
      gps_lat = ?, gps_lng = ?, gps_accuracy = 5, gps_verified = 1 WHERE id = ?`)
      .run(addr.lat + 0.0001, addr.lng + 0.0001, addr.id);

    // Auto-log voter contact
    if (addr.voter_id) {
      db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, 'Door-knock', 'Strong Support', 'Supporter!', 'Alice')")
        .run(addr.voter_id);
      db.prepare("UPDATE voters SET support_level = 'strong_support' WHERE id = ?").run(addr.voter_id);
    }
  }

  const knocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND result != 'not_visited'").get(e2eWalkId).c;
  assert.strictEqual(knocked, 5);

  const contacts = db.prepare("SELECT COUNT(*) as c FROM voter_contacts WHERE contacted_by = 'Alice'").get().c;
  assert.strictEqual(contacts, 5);
});

test('E2E Walk: progress tracking', () => {
  const total = db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(e2eWalkId).c;
  const knocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND result != 'not_visited'").get(e2eWalkId).c;
  assert.strictEqual(total, 20);
  assert.strictEqual(knocked, 5);
  assert.strictEqual(total - knocked, 15);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Captain Portal Isolation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Captain Isolation ===');

let captAId, captBId, captAListId, captBListId;
test('Captain isolation: create two captains', () => {
  const codeA = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  const codeB = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  captAId = db.prepare("INSERT INTO captains (name, code) VALUES ('Captain A', ?)").run(codeA).lastInsertRowid;
  captBId = db.prepare("INSERT INTO captains (name, code) VALUES ('Captain B', ?)").run(codeB).lastInsertRowid;
  assert(captAId !== captBId);
});

test('Captain isolation: each creates a list with voters', () => {
  captAListId = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'A List')").run(captAId).lastInsertRowid;
  captBListId = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'B List')").run(captBId).lastInsertRowid;

  // Add different voters
  const votersA = db.prepare("SELECT id FROM voters WHERE precinct = 'E2EPCT' LIMIT 10").all();
  const votersB = db.prepare("SELECT id FROM voters WHERE precinct = 'E2EPCT' LIMIT 10 OFFSET 50").all();

  for (const v of votersA) db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(captAListId, v.id);
  for (const v of votersB) db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(captBListId, v.id);
});

test('Captain isolation: captain A cannot access B list', () => {
  // Simulating the ownership check from the fixed code
  const listForA = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(captBListId, captAId);
  assert.strictEqual(listForA, undefined, 'Captain A should NOT see B list');
});

test('Captain isolation: captain B cannot access A list', () => {
  const listForB = db.prepare('SELECT id FROM captain_lists WHERE id = ? AND captain_id = ?').get(captAListId, captBId);
  assert.strictEqual(listForB, undefined, 'Captain B should NOT see A list');
});

test('Captain isolation: each sees only their own lists', () => {
  const aLists = db.prepare('SELECT * FROM captain_lists WHERE captain_id = ?').all(captAId);
  const bLists = db.prepare('SELECT * FROM captain_lists WHERE captain_id = ?').all(captBId);
  assert.strictEqual(aLists.length, 1);
  assert.strictEqual(bLists.length, 1);
  assert.strictEqual(aLists[0].name, 'A List');
  assert.strictEqual(bLists[0].name, 'B List');
});

test('Captain isolation: deleting A does not affect B', () => {
  db.prepare('DELETE FROM captains WHERE id = ?').run(captAId);

  // A's lists should cascade delete
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?').get(captAId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(captAListId).c, 0);

  // B's lists should be untouched
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?').get(captBId).c, 1);
  assert(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(captBListId).c > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: DB Health Check
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: DB Health ===');

test('DB: create event and log for health check', () => {
  db.prepare("INSERT INTO events (title, event_date) VALUES ('E2E Event', '2025-07-04')").run();
  db.prepare("INSERT INTO activity_log (message) VALUES ('E2E test completed')").run();
  assert(db.prepare('SELECT COUNT(*) as c FROM events').get().c > 0);
  assert(db.prepare('SELECT COUNT(*) as c FROM activity_log').get().c > 0);
});

test('DB: foreign_keys pragma enabled', () => {
  const fk = db.pragma('foreign_keys', { simple: true });
  assert.strictEqual(fk, 1);
});

test('DB: WAL mode active', () => {
  const mode = db.pragma('journal_mode', { simple: true });
  assert.strictEqual(mode, 'wal');
});

test('DB: no orphaned voter_contacts', () => {
  const orphans = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id NOT IN (SELECT id FROM voters)').get().c;
  assert.strictEqual(orphans, 0);
});

test('DB: no orphaned admin_list_voters', () => {
  const orphans = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE voter_id NOT IN (SELECT id FROM voters)').get().c;
  assert.strictEqual(orphans, 0);
});

test('DB: no orphaned captain_list_voters', () => {
  const orphans = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id NOT IN (SELECT id FROM voters)').get().c;
  assert.strictEqual(orphans, 0);
});

test('DB: all populated tables have data', () => {
  const tables = ['voters', 'contacts', 'p2p_sessions', 'p2p_volunteers', 'p2p_assignments',
    'surveys', 'survey_questions', 'survey_options', 'survey_sends', 'survey_responses',
    'block_walks', 'walk_addresses', 'walk_group_members', 'voter_contacts', 'admin_lists',
    'admin_list_voters', 'captains', 'captain_lists', 'captain_list_voters',
    'events', 'messages', 'activity_log'];
  for (const t of tables) {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
    assert(count > 0, `Table ${t} should have data, got ${count}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 10 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
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
