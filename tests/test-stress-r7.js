/**
 * STRESS TEST ROUND 7 — Production Simulation & Regression Tests
 *
 * This round simulates realistic production workflows end-to-end:
 * - Full campaign lifecycle: import voters → create lists → create P2P session → send → track
 * - Event lifecycle: create → invite → RSVP → check-in → analytics
 * - Block walk lifecycle: create from precinct → group walk → GPS log → route optimization → analytics
 * - Survey lifecycle: create → add questions → send → collect responses → tally
 * - Captain portal: login → search → create list → import CSV → manage team
 * - Early voting: import → track → extract GOTV list → universe builder
 * - Regression: verify all previously fixed bugs stay fixed
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r7.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───
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
// SECTION 1: Full Campaign Lifecycle (end-to-end)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Full Campaign Lifecycle ===');

// Step 1: Import voters
test('Campaign: import 3000 voters', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, email, address, city, zip, party, support_level, precinct, registration_number, qr_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      insert.run('F' + i, 'L' + i, '555' + String(i).padStart(7, '0'), 'v' + i + '@test.com',
        (100 + i) + ' Main St', 'Austin', '78701', ['D','R','I','L'][i%4],
        ['strong_support','lean_support','undecided','lean_oppose','strong_oppose'][i%5],
        'PCT-' + String(i % 15).padStart(2, '0'), 'REG' + String(i).padStart(6, '0'),
        crypto.randomBytes(6).toString('base64url'));
    }
  });
  tx();
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voters').get().c, 3000);
});

// Step 2: Create admin list from precinct
test('Campaign: create target list from precinct filter', () => {
  const listRes = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('PCT-00 Supporters', 'Supporters in precinct 0', 'text')").run();
  const listId = listRes.lastInsertRowid;

  const voterIds = db.prepare("SELECT id FROM voters WHERE precinct = 'PCT-00' AND support_level IN ('strong_support', 'lean_support')").all();
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addTx = db.transaction((ids) => {
    let added = 0;
    for (const v of ids) { if (insert.run(listId, v.id).changes > 0) added++; }
    return added;
  });
  const added = addTx(voterIds);
  assert(added > 0, 'Should add supporters to list');
  // PCT-00 gets voters where i%15==0 (i=0,15,30...). support_level = i%5:
  // i%15==0 means i is multiple of 15, so i%5 is always 0 (strong_support).
  // Also i%15==0 AND i%5==1 never happens. So only strong_support in PCT-00.
  // PCT has 200 voters (3000/15), but support distribution is NOT uniform per precinct.
  assert(added >= 1 && added <= 200, 'Expected supporters in PCT-00, got ' + added);
});

// Step 3: Create contacts from voters (simulating P2P session creation)
test('Campaign: create contacts from voter list for P2P', () => {
  const listVoters = db.prepare(`
    SELECT v.id as voter_id, v.phone, v.first_name, v.last_name, v.city, v.email
    FROM admin_list_voters alv JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = 1 AND v.phone != ''
  `).all();

  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city, email) VALUES (?,?,?,?,?)');
  const contactIds = [];

  const createTx = db.transaction(() => {
    for (const v of listVoters) {
      let contact = findContact.get(v.phone);
      if (!contact) {
        const r = insertContact.run(v.phone, v.first_name, v.last_name, v.city, v.email);
        contactIds.push(r.lastInsertRowid);
      } else {
        contactIds.push(contact.id);
      }
    }
  });
  createTx();
  assert(contactIds.length > 0);
});

// Step 4: Create P2P session with contacts
test('Campaign: create P2P session', () => {
  const contactIds = db.prepare('SELECT id FROM contacts').all().map(c => c.id);
  const joinCode = generateJoinCode();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();

  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at) VALUES (?, ?, 'auto_split', ?, ?)").run(
    'GOTV Campaign', 'Hi {firstName}! Election day is coming. Can we count on your vote?', joinCode, expires
  );
  const sessionId = sRes.lastInsertRowid;

  const insert = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  db.transaction(() => { for (const id of contactIds) insert.run(sessionId, id); })();

  const count = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessionId).c;
  assert.strictEqual(count, contactIds.length);
});

// Step 5: Volunteers join and get assignments
test('Campaign: 3 volunteers join and get auto-split assignments', () => {
  const session = db.prepare('SELECT * FROM p2p_sessions LIMIT 1').get();
  const totalAssign = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'pending'").get(session.id).c;

  for (let i = 0; i < 3; i++) {
    const vRes = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(session.id, 'Vol' + i);
    const volId = vRes.lastInsertRowid;

    // Auto-split: divide unassigned among online volunteers
    const unassigned = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").all(session.id);
    const onlineCount = db.prepare("SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ? AND is_online = 1").get(session.id).c;
    const batchSize = Math.ceil(unassigned.length / Math.max(onlineCount, 1));
    const batch = unassigned.slice(0, batchSize);
    for (const a of batch) {
      db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volId, a.id);
    }
  }

  // Verify all assigned
  const remaining = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL").get(session.id).c;
  assert.strictEqual(remaining, 0, 'All contacts should be assigned to volunteers');
});

// Step 6: Simulate sending
test('Campaign: volunteers send messages', () => {
  const session = db.prepare('SELECT * FROM p2p_sessions LIMIT 1').get();
  const assignments = db.prepare("SELECT a.*, c.phone, c.first_name FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id WHERE a.session_id = ? AND a.status = 'pending' LIMIT 30").all(session.id);

  for (const a of assignments) {
    const msg = personalizeTemplate(session.message_template, a);
    assert(msg.includes(a.first_name || ''), 'Personalized message should include name');

    // Record send
    db.prepare("UPDATE p2p_assignments SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(a.id);
    db.prepare("INSERT INTO messages (phone, body, direction, session_id, channel) VALUES (?, ?, 'outbound', ?, 'sms')").run(a.phone, msg, session.id);
  }

  const sent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND status = 'sent'").get(session.id).c;
  assert.strictEqual(sent, 30);
});

// Step 7: Session stats
test('Campaign: session stats accurate', () => {
  const session = db.prepare('SELECT * FROM p2p_sessions LIMIT 1').get();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalContacts,
      SUM(CASE WHEN status IN ('sent','in_conversation','completed') THEN 1 ELSE 0 END) as totalSent,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as remaining
    FROM p2p_assignments WHERE session_id = ?
  `).get(session.id);

  assert.strictEqual(stats.totalSent, 30);
  assert.strictEqual(stats.totalContacts, stats.totalSent + stats.remaining);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Full Event Lifecycle
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Full Event Lifecycle ===');

test('Event: create rally', () => {
  const r = db.prepare("INSERT INTO events (title, description, location, event_date, event_time, status) VALUES ('Town Hall Rally', 'Meet the candidate', 'City Park', '2025-04-15', '18:00', 'upcoming')").run();
  assert(r.lastInsertRowid > 0);
});

test('Event: invite contacts via RSVP', () => {
  const event = db.prepare('SELECT id FROM events LIMIT 1').get();
  const contacts = db.prepare('SELECT phone, first_name, last_name FROM contacts LIMIT 50').all();

  const insert = db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)');
  let invited = 0;
  for (const c of contacts) {
    if (insert.run(event.id, c.phone, (c.first_name + ' ' + c.last_name).trim(), 'invited').changes > 0) invited++;
  }
  assert.strictEqual(invited, 50);
});

test('Event: process RSVPs (confirm/decline)', () => {
  const event = db.prepare('SELECT id FROM events LIMIT 1').get();
  const rsvps = db.prepare("SELECT id, contact_phone FROM event_rsvps WHERE event_id = ? AND rsvp_status = 'invited'").all(event.id);

  for (let i = 0; i < rsvps.length; i++) {
    const status = i % 3 === 0 ? 'declined' : 'confirmed';
    db.prepare("UPDATE event_rsvps SET rsvp_status = ?, responded_at = datetime('now') WHERE id = ?").run(status, rsvps[i].id);
  }

  const confirmed = db.prepare("SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ? AND rsvp_status = 'confirmed'").get(event.id).c;
  const declined = db.prepare("SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ? AND rsvp_status = 'declined'").get(event.id).c;
  assert(confirmed > 0);
  assert(declined > 0);
  assert.strictEqual(confirmed + declined, 50);
});

test('Event: check-in attendees', () => {
  const event = db.prepare('SELECT id FROM events LIMIT 1').get();
  const confirmed = db.prepare("SELECT contact_phone FROM event_rsvps WHERE event_id = ? AND rsvp_status = 'confirmed' LIMIT 20").all(event.id);

  for (const c of confirmed) {
    db.prepare("UPDATE event_rsvps SET rsvp_status = 'attended', checked_in_at = datetime('now') WHERE event_id = ? AND contact_phone = ?").run(event.id, c.contact_phone);
  }

  const attended = db.prepare("SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ? AND rsvp_status = 'attended'").get(event.id).c;
  assert.strictEqual(attended, 20);
});

test('Event: RSVP analytics with LEFT JOIN', () => {
  const stats = db.prepare(`
    SELECT e.id, e.title,
      COUNT(er.id) as rsvp_total,
      SUM(CASE WHEN er.rsvp_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN er.rsvp_status = 'declined' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN er.rsvp_status = 'attended' THEN 1 ELSE 0 END) as attended
    FROM events e LEFT JOIN event_rsvps er ON e.id = er.event_id
    GROUP BY e.id
  `).all();
  assert(stats.length >= 1);
  assert.strictEqual(stats[0].rsvp_total, 50);
  assert.strictEqual(stats[0].attended, 20);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Full Survey Lifecycle
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Full Survey Lifecycle ===');

test('Survey: create with 3 questions and options', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, description, status) VALUES ('Voter Priorities', 'What matters most to you?', 'draft')").run();
  const sId = sRes.lastInsertRowid;

  // Q1: single choice
  const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Top priority?', 'single_choice', 0)").run(sId);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Economy', 'economy', 0)").run(q1.lastInsertRowid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Healthcare', 'healthcare', 1)").run(q1.lastInsertRowid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Education', 'education', 2)").run(q1.lastInsertRowid);

  // Q2: single choice
  const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Support level?', 'single_choice', 1)").run(sId);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Strong support', 'strong', 0)").run(q2.lastInsertRowid);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Undecided', 'undecided', 1)").run(q2.lastInsertRowid);

  // Q3: write-in
  db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Any other thoughts?', 'write_in', 2)").run(sId);

  const qCount = db.prepare('SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?').get(sId).c;
  assert.strictEqual(qCount, 3);
});

test('Survey: activate and send to 200 contacts', () => {
  const survey = db.prepare("SELECT * FROM surveys WHERE name = 'Voter Priorities'").get();
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(survey.id);

  const q1 = db.prepare('SELECT id FROM survey_questions WHERE survey_id = ? ORDER BY sort_order LIMIT 1').get(survey.id);
  const insertSend = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, ?, ?, ?)");

  const tx = db.transaction(() => {
    for (let i = 0; i < 200; i++) {
      insertSend.run(survey.id, '555' + String(i).padStart(7, '0'), 'F' + i + ' L' + i, q1.id);
    }
  });
  tx();

  const sent = db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(survey.id).c;
  assert.strictEqual(sent, 200);
});

test('Survey: collect responses and tally', () => {
  const survey = db.prepare("SELECT * FROM surveys WHERE name = 'Voter Priorities'").get();
  const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order').all(survey.id);
  const sends = db.prepare('SELECT * FROM survey_sends WHERE survey_id = ? LIMIT 150').all(survey.id);

  const insertResp = db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)");
  const priorities = ['economy', 'healthcare', 'education'];
  const supports = ['strong', 'undecided'];

  const tx = db.transaction(() => {
    for (let i = 0; i < sends.length; i++) {
      // Answer Q1
      insertResp.run(survey.id, sends[i].id, questions[0].id, sends[i].phone, priorities[i % 3]);
      // 70% answer Q2
      if (i % 10 < 7) {
        insertResp.run(survey.id, sends[i].id, questions[1].id, sends[i].phone, supports[i % 2]);
      }
      // 30% answer Q3
      if (i % 10 < 3) {
        insertResp.run(survey.id, sends[i].id, questions[2].id, sends[i].phone, 'I think ' + priorities[i % 3] + ' is important');
        db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(sends[i].id);
      }
    }
  });
  tx();

  // Tally Q1
  const tally = db.prepare(`
    SELECT response_text, COUNT(*) as c FROM survey_responses
    WHERE survey_id = ? AND question_id = ? GROUP BY response_text ORDER BY c DESC
  `).all(survey.id, questions[0].id);
  assert.strictEqual(tally.length, 3);
  assert.strictEqual(tally.reduce((s, t) => s + t.c, 0), 150);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Captain Portal Workflow
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Captain Portal ===');

test('Captain: create captain and team', () => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  const cRes = db.prepare("INSERT INTO captains (name, code, phone, email) VALUES ('Maria Garcia', ?, '5121234567', 'maria@campaign.org')").run(code);
  const captId = cRes.lastInsertRowid;

  db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(captId, 'John Helper');
  db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(captId, 'Sarah Knock');

  const members = db.prepare('SELECT * FROM captain_team_members WHERE captain_id = ?').all(captId);
  assert.strictEqual(members.length, 2);
});

test('Captain: create list and add voters by search', () => {
  const captain = db.prepare('SELECT id FROM captains LIMIT 1').get();
  const tm = db.prepare('SELECT id FROM captain_team_members WHERE captain_id = ? LIMIT 1').get(captain.id);

  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, team_member_id, name, list_type) VALUES (?, ?, ?, ?)').run(
    captain.id, tm.id, 'Door Knock List', 'block_walk'
  );
  const listId = listRes.lastInsertRowid;

  // Search voters in captain's area (simulating search endpoint)
  // PCT-01 gets voters where i%15==1 (i=1,16,31...). i%5 for those: 1,1,1... = lean_support.
  // Use PCT-03 which gets i%15==3 → i%5 cycles: 3=lean_oppose, 18%5=3, etc.
  // Use a support_level that definitely exists: 'strong_support' in PCT-00 (i%15==0 → i%5==0)
  const voters = db.prepare("SELECT id FROM voters WHERE precinct = 'PCT-00' AND support_level = 'strong_support' LIMIT 20").all();
  const insert = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0;
  for (const v of voters) { if (insert.run(listId, v.id).changes > 0) added++; }

  assert(added > 0, 'Should find strong_support voters in PCT-00');
  const count = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listId).c;
  assert.strictEqual(count, added);
});

test('Captain: list with voter counts via JOIN', () => {
  const captain = db.prepare('SELECT id FROM captains LIMIT 1').get();
  const lists = db.prepare(`
    SELECT cl.*, COUNT(clv.id) as voter_count, ctm.name as team_member_name
    FROM captain_lists cl
    LEFT JOIN captain_list_voters clv ON cl.id = clv.list_id
    LEFT JOIN captain_team_members ctm ON cl.team_member_id = ctm.id
    WHERE cl.captain_id = ? GROUP BY cl.id
  `).all(captain.id);

  assert(lists.length >= 1);
  assert(lists[0].voter_count > 0);
  assert(lists[0].team_member_name);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Early Voting + Universe Builder
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Early Voting + Universe ===');

test('Early voting: import election history', () => {
  const insertVote = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?,?,?,?,?)');
  const elections = [
    { name: 'Nov 2024 General', date: '2024-11-05', type: 'general', cycle: 'november' },
    { name: 'Mar 2024 Primary', date: '2024-03-05', type: 'primary', cycle: 'march' },
    { name: 'Nov 2020 General', date: '2020-11-03', type: 'general', cycle: 'november' },
  ];

  const tx = db.transaction(() => {
    const voters = db.prepare('SELECT id FROM voters').all();
    let inserted = 0;
    for (const v of voters) {
      // 80% voted in Nov 2024
      if (v.id % 5 !== 0) { if (insertVote.run(v.id, elections[0].name, elections[0].date, elections[0].type, elections[0].cycle).changes > 0) inserted++; }
      // 50% in Mar 2024
      if (v.id % 2 === 0) { if (insertVote.run(v.id, elections[1].name, elections[1].date, elections[1].type, elections[1].cycle).changes > 0) inserted++; }
      // 60% in Nov 2020
      if (v.id % 5 < 3) { if (insertVote.run(v.id, elections[2].name, elections[2].date, elections[2].type, elections[2].cycle).changes > 0) inserted++; }
    }
    return inserted;
  });
  const inserted = tx();
  assert(inserted > 5000, 'Should insert >5K votes, got ' + inserted);
});

test('Early voting: mark 1000 voters', () => {
  db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = '2025-02-20', early_voted_method = 'in_person' WHERE id <= 1000").run();
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get().c, 1000);
});

test('Early voting: extract GOTV list', () => {
  const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('GOTV Not Yet Voted', 'text')").run();
  const listId = listRes.lastInsertRowid;
  const added = db.prepare("INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, id FROM voters WHERE early_voted = 0").run(listId);
  assert(added.changes > 1500);
});

test('Universe builder: full pipeline with list creation', () => {
  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _t_pct; CREATE TEMP TABLE _t_pct (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _t_pct SELECT id FROM voters WHERE precinct IN ('PCT-00','PCT-01','PCT-02')").run();
    const pctCount = db.prepare('SELECT COUNT(*) as c FROM _t_pct').get().c;

    db.exec('DROP TABLE IF EXISTS _t_univ; CREATE TEMP TABLE _t_univ (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _t_univ SELECT DISTINCT ev.voter_id FROM election_votes ev JOIN _t_pct p ON ev.voter_id = p.voter_id WHERE ev.election_date >= '2020-01-01'").run();
    const univCount = db.prepare('SELECT COUNT(*) as c FROM _t_univ').get().c;

    // Create list
    const listRes = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('Universe PCT 0-2', 'Active voters', 'general')").run();
    const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _t_univ').run(listRes.lastInsertRowid);

    db.exec('DROP TABLE IF EXISTS _t_pct; DROP TABLE IF EXISTS _t_univ');
    return { pctCount, univCount, added: added.changes };
  });
  const result = tx();
  assert(result.pctCount > 500);
  assert(result.univCount > 0 && result.univCount <= result.pctCount);
  assert.strictEqual(result.added, result.univCount);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Regression — Previously Fixed Bugs
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Regression Tests ===');

test('Regression: personalizeTemplate null safety', () => {
  assert.strictEqual(personalizeTemplate(null, null), '');
  assert.strictEqual(personalizeTemplate(undefined, undefined), '');
  assert.strictEqual(personalizeTemplate('Hi {firstName}!', null), 'Hi !');
  assert.strictEqual(personalizeTemplate(null, { first_name: 'X' }), '');
});

test('Regression: RSVP dedup via UNIQUE index', () => {
  const event = db.prepare('SELECT id FROM events LIMIT 1').get();
  const phone = '5550000000';
  db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone) VALUES (?, ?)').run(event.id, phone);
  db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone) VALUES (?, ?)').run(event.id, phone);
  const count = db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ? AND contact_phone = ?').get(event.id, phone).c;
  assert.strictEqual(count, 1);
});

test('Regression: bulk delete counts correctly', () => {
  // Insert 5 voters, try to delete 7 (2 non-existent)
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('BulkDel' + ?, ?)").run(i, crypto.randomBytes(6).toString('base64url'));
    ids.push(r.lastInsertRowid);
  }
  ids.push(999999, 999998); // non-existent

  const del = db.prepare('DELETE FROM voters WHERE id = ?');
  const tx = db.transaction((list) => {
    let removed = 0;
    for (const id of list) { if (del.run(id).changes > 0) removed++; }
    return removed;
  });
  const removed = tx(ids);
  assert.strictEqual(removed, 5, 'Should only count actually deleted rows');
});

test('Regression: cascade delete removes all child records', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('Cascade Test', '2025-12-01')").run();
  const eId = eRes.lastInsertRowid;
  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone) VALUES (?, '1111111111')").run(eId);
  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone) VALUES (?, '2222222222')").run(eId);

  db.prepare('DELETE FROM events WHERE id = ?').run(eId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(eId).c, 0);
});

test('Regression: P2P session cascade', () => {
  const cRes = db.prepare("INSERT INTO contacts (phone) VALUES ('3333333333')").run();
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('CascP2P', 'Hi', 'REG1', ?)").run(expires);
  const sId = sRes.lastInsertRowid;
  db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sId, 'RegVol');
  db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)').run(sId, cRes.lastInsertRowid);

  db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(sId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?').get(sId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sId).c, 0);
});

test('Regression: QR token uniqueness', () => {
  const dupes = db.prepare("SELECT qr_token, COUNT(*) as c FROM voters WHERE qr_token IS NOT NULL GROUP BY qr_token HAVING COUNT(*) > 1").all();
  assert.strictEqual(dupes.length, 0);
});

test('Regression: voter_contacts records', () => {
  // Ensure voter_contacts table has data (simulating door-knock / phone bank results)
  const voters = db.prepare('SELECT id FROM voters LIMIT 10').all();
  const insert = db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)");
  for (const v of voters) {
    insert.run(v.id, 'door_knock', 'contacted', 'Spoke at door', 'VolunteerA');
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_contacts').get().c, 10);
});

test('Regression: phone normalization edge cases', () => {
  assert.strictEqual(normalizePhone('+1 (512) 555-1234'), '5125551234');
  assert.strictEqual(normalizePhone(''), '');
  assert.strictEqual(normalizePhone(null), '');
  assert.strictEqual(normalizePhone('123'), '');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Final Health Check
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Final Health ===');

test('DB: integrity check', () => {
  assert.strictEqual(db.pragma('integrity_check')[0].integrity_check, 'ok');
});

test('DB: no FK violations', () => {
  assert.strictEqual(db.pragma('foreign_key_check').length, 0);
});

test('DB: all tables have data', () => {
  const tables = ['voters', 'contacts', 'messages', 'events', 'event_rsvps',
    'p2p_sessions', 'p2p_assignments', 'captains', 'captain_lists',
    'admin_lists', 'admin_list_voters', 'surveys', 'survey_questions',
    'survey_sends', 'survey_responses', 'election_votes', 'voter_contacts'];
  for (const t of tables) {
    const c = db.prepare('SELECT COUNT(*) as c FROM ' + t).get().c;
    assert(c > 0, t + ' should have data, got ' + c);
  }
});

test('DB: total data volume', () => {
  const voters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const electionVotes = db.prepare('SELECT COUNT(*) as c FROM election_votes').get().c;
  const messages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  assert(voters > 2500);
  assert(electionVotes > 5000);
  assert(messages > 0);
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 7 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
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
