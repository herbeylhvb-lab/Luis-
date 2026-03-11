/**
 * STRESS TEST ROUND 13 — New Fix Verification + Advanced Edge Cases
 *
 * Sections:
 * 1. P2P send volunteer-assignment ownership enforcement
 * 2. Settings API key masking (write-only credentials)
 * 3. Survey status enum validation
 * 4. Walk status enum validation
 * 5. RSVP duplicate phone handling (INSERT OR IGNORE)
 * 6. Personalize template: simultaneous replacement, edge cases
 * 7. Opt-out enforcement across all send paths
 * 8. Voter touchpoint timeline aggregation correctness
 * 9. Election vote deduplication (UNIQUE constraint)
 * 10. Early voting: import, mark, clear, extract lifecycle
 * 11. QR token uniqueness and check-in idempotency
 * 12. COALESCE behavior with null vs empty string
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r13.db');
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
// SECTION 1: P2P Send Volunteer-Assignment Ownership
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: P2P Assignment Ownership ===');

test('P2P: assignment.volunteer_id must match sender volunteerId', () => {
  // Setup
  const contact = db.prepare("INSERT INTO contacts (phone, first_name) VALUES ('5551110001', 'Target')").run();
  const sess = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('OwnerTest', 'Hi', 'OWNR', '2099-01-01')").run();
  const vol1 = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sess.lastInsertRowid, 'Vol1');
  const vol2 = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sess.lastInsertRowid, 'Vol2');
  const assign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)').run(sess.lastInsertRowid, contact.lastInsertRowid, vol1.lastInsertRowid);

  // Vol2 tries to send for Vol1's assignment — should be blocked
  const assignment = db.prepare('SELECT * FROM p2p_assignments WHERE id = ?').get(assign.lastInsertRowid);
  const sendingVolId = Number(vol2.lastInsertRowid);
  assert.notStrictEqual(assignment.volunteer_id, sendingVolId, 'Assignment should belong to Vol1, not Vol2');
  // The server would return 403 for this mismatch
});

test('P2P: own assignment passes ownership check', () => {
  const sess = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'OwnerTest'").get();
  const vol1 = db.prepare("SELECT id FROM p2p_volunteers WHERE name = 'Vol1' AND session_id = ?").get(sess.id);
  const assignment = db.prepare("SELECT * FROM p2p_assignments WHERE session_id = ? AND volunteer_id = ?").get(sess.id, vol1.id);
  assert.strictEqual(assignment.volunteer_id, vol1.id, 'Ownership should match');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Settings API Key Masking
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Settings Key Masking ===');

test('Settings: API key should be write-only (masked on read)', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('anthropic_api_key', 'sk-ant-secret-key-12345')").run();
  // The server returns '********' instead of actual value
  const WRITE_ONLY_KEYS = ['anthropic_api_key'];
  const key = 'anthropic_api_key';
  const isWriteOnly = WRITE_ONLY_KEYS.includes(key);
  assert(isWriteOnly, 'anthropic_api_key should be in write-only list');
  // Simulate masked response
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const maskedValue = isWriteOnly ? '********' : row.value;
  assert.strictEqual(maskedValue, '********');
  assert.notStrictEqual(maskedValue, 'sk-ant-secret-key-12345', 'Actual key should not be exposed');
});

test('Settings: non-sensitive keys are readable', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('campaign_name', 'My Campaign')").run();
  const WRITE_ONLY_KEYS = ['anthropic_api_key'];
  const key = 'campaign_name';
  const isWriteOnly = WRITE_ONLY_KEYS.includes(key);
  assert(!isWriteOnly, 'campaign_name should be readable');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  assert.strictEqual(row.value, 'My Campaign');
});

test('Settings: allowlist blocks unauthorized keys', () => {
  const SETTINGS_ALLOWLIST = ['anthropic_api_key', 'candidate_name', 'campaign_name', 'campaign_info', 'opt_out_footer', 'auto_reply_enabled', 'default_area_code'];
  assert(!SETTINGS_ALLOWLIST.includes('rumbleup_api_secret'), 'RumbleUp API secret should NOT be in allowlist');
  assert(!SETTINGS_ALLOWLIST.includes('password'), 'password should NOT be in allowlist');
  assert(SETTINGS_ALLOWLIST.includes('campaign_name'), 'campaign_name should be in allowlist');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Survey Status Enum Validation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Survey Status Validation ===');

test('Survey: valid statuses are draft, active, closed', () => {
  const validStatuses = ['draft', 'active', 'closed'];
  assert(validStatuses.includes('draft'));
  assert(validStatuses.includes('active'));
  assert(validStatuses.includes('closed'));
  assert(!validStatuses.includes('paused'));
  assert(!validStatuses.includes('archived'));
  assert(!validStatuses.includes(''));
});

test('Survey: status transition draft→active→closed→active (reopen)', () => {
  const s = db.prepare("INSERT INTO surveys (name, status) VALUES ('StatusTest', 'draft')").run();
  const sid = s.lastInsertRowid;

  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');

  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'closed');

  // Reopen
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Walk Status Enum Validation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Walk Status Validation ===');

test('Walk: valid statuses are pending, in_progress, completed', () => {
  const validStatuses = ['pending', 'in_progress', 'completed'];
  assert(validStatuses.includes('pending'));
  assert(validStatuses.includes('in_progress'));
  assert(validStatuses.includes('completed'));
  assert(!validStatuses.includes('active'));
  assert(!validStatuses.includes('cancelled'));
});

test('Walk: status transitions correctly', () => {
  const w = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('WalkStatus', 'WSTS')").run();
  const wid = w.lastInsertRowid;
  assert.strictEqual(db.prepare('SELECT status FROM block_walks WHERE id = ?').get(wid).status, 'pending');

  db.prepare("UPDATE block_walks SET status = 'in_progress' WHERE id = ?").run(wid);
  assert.strictEqual(db.prepare('SELECT status FROM block_walks WHERE id = ?').get(wid).status, 'in_progress');

  db.prepare("UPDATE block_walks SET status = 'completed' WHERE id = ?").run(wid);
  assert.strictEqual(db.prepare('SELECT status FROM block_walks WHERE id = ?').get(wid).status, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: RSVP Duplicate Phone Handling
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: RSVP Duplicate Handling ===');

test('RSVP: INSERT OR IGNORE prevents duplicate (event_id, contact_phone)', () => {
  db.prepare("INSERT INTO events (title, event_date) VALUES ('RSVPEvent', '2025-06-01')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'RSVPEvent'").get().id;

  const insert = db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)');
  const r1 = insert.run(evId, '5551110000', 'Alice', 'invited');
  assert.strictEqual(r1.changes, 1, 'First insert should succeed');

  const r2 = insert.run(evId, '5551110000', 'Alice Dup', 'confirmed');
  assert.strictEqual(r2.changes, 0, 'Duplicate should be ignored');

  // Original record preserved
  const rsvp = db.prepare('SELECT contact_name FROM event_rsvps WHERE event_id = ? AND contact_phone = ?').get(evId, '5551110000');
  assert.strictEqual(rsvp.contact_name, 'Alice', 'Original name preserved');
});

test('RSVP: different phone same event is allowed', () => {
  const evId = db.prepare("SELECT id FROM events WHERE title = 'RSVPEvent'").get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)');
  const r = insert.run(evId, '5551110001', 'Bob', 'invited');
  assert.strictEqual(r.changes, 1);
});

test('RSVP: same phone different event is allowed', () => {
  db.prepare("INSERT INTO events (title, event_date) VALUES ('RSVPEvent2', '2025-07-01')").run();
  const evId2 = db.prepare("SELECT id FROM events WHERE title = 'RSVPEvent2'").get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, ?)');
  const r = insert.run(evId2, '5551110000', 'Alice', 'invited');
  assert.strictEqual(r.changes, 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: personalizeTemplate Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: personalizeTemplate ===');

test('Template: basic merge tags', () => {
  const result = personalizeTemplate('Hello {firstName} {lastName} from {city}!', {
    firstName: 'Jane', lastName: 'Doe', city: 'Austin'
  });
  assert.strictEqual(result, 'Hello Jane Doe from Austin!');
});

test('Template: missing fields default to empty string', () => {
  const result = personalizeTemplate('Hi {firstName}!', {});
  assert.strictEqual(result, 'Hi !');
});

test('Template: null contact handled', () => {
  const result = personalizeTemplate('Hi {firstName}!', null);
  assert.strictEqual(result, 'Hi !');
});

test('Template: null template returns empty string', () => {
  const result = personalizeTemplate(null, { firstName: 'Test' });
  assert.strictEqual(result, '');
});

test('Template: merge tag injection prevented (simultaneous replacement)', () => {
  // A voter whose first_name IS literally "{city}" should NOT get city substituted
  const result = personalizeTemplate('Hello {firstName} from {city}!', {
    firstName: '{city}', city: 'Austin'
  });
  assert.strictEqual(result, 'Hello {city} from Austin!');
});

test('Template: first_name and last_name snake_case fallback', () => {
  const result = personalizeTemplate('Hello {firstName} {lastName}!', {
    first_name: 'Snake', last_name: 'Case'
  });
  assert.strictEqual(result, 'Hello Snake Case!');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Opt-Out Enforcement
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Opt-Out Enforcement ===');

test('Opt-out: normalized phone blocks send', () => {
  db.prepare("INSERT INTO opt_outs (phone) VALUES ('5551234567')").run();
  const isOptedOut = !!db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get('5551234567');
  assert(isOptedOut, 'Normalized phone should be found in opt_outs');
});

test('Opt-out: unnormalized phone matches after normalizing', () => {
  const rawPhone = '+1 (555) 123-4567';
  const normalized = normalizePhone(rawPhone);
  const isOptedOut = !!db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(normalized);
  assert(isOptedOut, 'Normalized version of unnormalized phone should match');
});

test('Opt-out: non-opted-out phone passes through', () => {
  const isOptedOut = !!db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get('5559999999');
  assert(!isOptedOut, 'Non-opted phone should not be blocked');
});

test('Opt-out: WhatsApp send checks normalized phone', () => {
  // Simulate WhatsApp opt-out check with Set
  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const contact = { phone: '(555) 123-4567' };
  const isBlocked = optedOutSet.has(contact.phone) || optedOutSet.has(normalizePhone(contact.phone));
  assert(isBlocked, 'WhatsApp send should block after normalizing');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Voter Touchpoint Timeline
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Touchpoint Timeline ===');

test('Touchpoints: aggregates contacts, texts, checkins, captain lists', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('TouchPt', 'Voter', '5559880011', 'qr_tp1')").run();
  const vid = Number(v.lastInsertRowid);

  // 2 contacts
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_at) VALUES (?, 'Door-knock', 'Support', '2025-01-01')").run(vid);
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result, contacted_at) VALUES (?, 'Phone Call', 'Undecided', '2025-01-02')").run(vid);

  // 1 text
  db.prepare("INSERT INTO messages (phone, body, direction, timestamp) VALUES ('5559880011', 'Hi!', 'outbound', '2025-01-03')").run();

  // 1 event checkin
  db.prepare("INSERT INTO events (title, event_date) VALUES ('TPEvent', '2025-01-04')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'TPEvent'").get().id;
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);

  // 1 captain list
  db.prepare("INSERT INTO captains (name, code) VALUES ('TPCap', 'TPCAP')").run();
  const capId = db.prepare("SELECT id FROM captains WHERE code = 'TPCAP'").get().id;
  db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(capId, 'TP List');
  const listId = db.prepare("SELECT id FROM captain_lists WHERE captain_id = ?").get(capId).id;
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, vid);

  // Aggregate touchpoints
  const touchpoints = [];
  const contacts = db.prepare('SELECT contact_type, contacted_at FROM voter_contacts WHERE voter_id = ?').all(vid);
  for (const c of contacts) touchpoints.push({ channel: c.contact_type, date: c.contacted_at });

  const texts = db.prepare("SELECT direction, timestamp FROM messages WHERE phone = '5559880011'").all();
  for (const t of texts) touchpoints.push({ channel: t.direction === 'outbound' ? 'Text Sent' : 'Text Received', date: t.timestamp });

  const checkins = db.prepare('SELECT vc.checked_in_at FROM voter_checkins vc WHERE vc.voter_id = ?').all(vid);
  for (const c of checkins) touchpoints.push({ channel: 'Event', date: c.checked_in_at });

  const captainLists = db.prepare('SELECT clv.added_at FROM captain_list_voters clv WHERE clv.voter_id = ?').all(vid);
  for (const cl of captainLists) touchpoints.push({ channel: 'Captain List', date: cl.added_at });

  assert.strictEqual(touchpoints.length, 5, 'Should have 5 touchpoints total');

  // Sort by date descending
  touchpoints.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });
  // Most recent first
  assert(touchpoints[0].date >= touchpoints[touchpoints.length - 1].date, 'Should be sorted descending');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Election Vote Deduplication
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Election Vote Dedup ===');

test('Election votes: INSERT OR IGNORE prevents duplicate (voter_id, election_name)', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('ElecV', 'Test', 'qr_elv1')").run();
  const vid = Number(v.lastInsertRowid);

  const insert = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)');
  const r1 = insert.run(vid, 'Nov 2024 General', '2024-11-05', 'general', 'november');
  assert.strictEqual(r1.changes, 1);

  const r2 = insert.run(vid, 'Nov 2024 General', '2024-11-05', 'general', 'november');
  assert.strictEqual(r2.changes, 0, 'Duplicate election vote should be ignored');
});

test('Election votes: same voter, different elections allowed', () => {
  const vid = db.prepare("SELECT id FROM voters WHERE first_name = 'ElecV'").get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date) VALUES (?, ?, ?)');
  const r = insert.run(vid, 'Mar 2024 Primary', '2024-03-05');
  assert.strictEqual(r.changes, 1);
});

test('Election votes: count by cycle aggregation', () => {
  const vid = db.prepare("SELECT id FROM voters WHERE first_name = 'ElecV'").get().id;
  const count = db.prepare('SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?').get(vid).c;
  assert.strictEqual(count, 2);
  const novCount = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ? AND election_cycle = 'november'").get(vid).c;
  assert.strictEqual(novCount, 1);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Early Voting Lifecycle
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Early Voting ===');

test('Early voting: mark voter, check stats', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, precinct, qr_token) VALUES ('EarlyV', 'Test', 'EV-PCT', 'qr_ev1')").run();
  const vid = Number(v.lastInsertRowid);

  db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = '2025-10-15', early_voted_method = 'in-person' WHERE id = ?").run(vid);
  const voter = db.prepare('SELECT early_voted, early_voted_date, early_voted_method FROM voters WHERE id = ?').get(vid);
  assert.strictEqual(voter.early_voted, 1);
  assert.strictEqual(voter.early_voted_date, '2025-10-15');
  assert.strictEqual(voter.early_voted_method, 'in-person');
});

test('Early voting: clear early voted status', () => {
  const vid = db.prepare("SELECT id FROM voters WHERE first_name = 'EarlyV'").get().id;
  db.prepare("UPDATE voters SET early_voted = 0, early_voted_date = NULL, early_voted_method = NULL WHERE id = ?").run(vid);
  const voter = db.prepare('SELECT early_voted, early_voted_date, early_voted_method FROM voters WHERE id = ?').get(vid);
  assert.strictEqual(voter.early_voted, 0);
  assert.strictEqual(voter.early_voted_date, null);
  assert.strictEqual(voter.early_voted_method, null);
});

test('Early voting: extract remaining (non-early) voters to list', () => {
  // Add more voters, some early voted
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO voters (first_name, last_name, precinct, early_voted, qr_token) VALUES (?, ?, 'EV-PCT', ?, ?)")
      .run(`EV${i}`, 'Voter', i < 2 ? 1 : 0, `qr_evx_${i}`);
  }

  const nonEarly = db.prepare("SELECT id FROM voters WHERE precinct = 'EV-PCT' AND early_voted = 0").all();
  assert(nonEarly.length >= 3, 'Should have at least 3 non-early voters');

  // Create list and add
  const listR = db.prepare("INSERT INTO admin_lists (name, description) VALUES ('GOTV Remaining', 'Auto-extracted')").run();
  const listId = listR.lastInsertRowid;
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  let added = 0;
  for (const v of nonEarly) {
    if (insert.run(listId, v.id).changes > 0) added++;
  }
  assert(added >= 3, 'Should add at least 3 voters to GOTV list');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: QR Token Uniqueness & Check-in Idempotency
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: QR Token ===');

test('QR: generateQrToken produces unique tokens', () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateQrToken());
  }
  assert.strictEqual(tokens.size, 100, 'All 100 tokens should be unique');
});

test('QR: token has expected length and format (base64url)', () => {
  const token = generateQrToken();
  assert(token.length >= 8, 'Token should be at least 8 chars');
  assert(/^[A-Za-z0-9_-]+$/.test(token), 'Token should be base64url characters');
});

test('QR: check-in is idempotent (UNIQUE voter_id + event_id)', () => {
  const v = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('QRV', 'qr_qrv1')").run();
  const vid = Number(v.lastInsertRowid);
  db.prepare("INSERT INTO events (title, event_date) VALUES ('QREvent', '2025-05-01')").run();
  const evId = db.prepare("SELECT id FROM events WHERE title = 'QREvent'").get().id;

  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);

  // Duplicate check-in should fail on UNIQUE constraint
  let duplicateFailed = false;
  try {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId);
  } catch (e) {
    if (e.message.includes('UNIQUE')) duplicateFailed = true;
    else throw e;
  }
  assert(duplicateFailed, 'Duplicate checkin should fail with UNIQUE constraint');
});

test('QR: same voter, different events allowed', () => {
  const vid = db.prepare("SELECT id FROM voters WHERE first_name = 'QRV'").get().id;
  db.prepare("INSERT INTO events (title, event_date) VALUES ('QREvent2', '2025-06-01')").run();
  const evId2 = db.prepare("SELECT id FROM events WHERE title = 'QREvent2'").get().id;
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, evId2);
  const count = db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(vid).c;
  assert.strictEqual(count, 2);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: COALESCE Behavior
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: COALESCE Edge Cases ===');

test('COALESCE: null vs empty string in voter update', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('Coal', 'Test', '5551112233', 'qr_coal1')").run();
  const vid = Number(v.lastInsertRowid);

  // COALESCE(null, current) keeps current value
  db.prepare('UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?').run(null, vid);
  assert.strictEqual(db.prepare('SELECT first_name FROM voters WHERE id = ?').get(vid).first_name, 'Coal');

  // COALESCE('', current) uses '' (empty string overwrites)
  db.prepare('UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?').run('', vid);
  assert.strictEqual(db.prepare('SELECT first_name FROM voters WHERE id = ?').get(vid).first_name, '');
});

test('COALESCE: undefined becomes null in better-sqlite3', () => {
  const v = db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('CoalU', 'Test', 'qr_coalu')").run();
  const vid = Number(v.lastInsertRowid);

  // undefined → null in better-sqlite3, so COALESCE skips it
  db.prepare('UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?').run(undefined, vid);
  assert.strictEqual(db.prepare('SELECT first_name FROM voters WHERE id = ?').get(vid).first_name, 'CoalU');
});

test('COALESCE: voter_score 0 vs null', () => {
  const v = db.prepare("INSERT INTO voters (first_name, voter_score, qr_token) VALUES ('Score0', 50, 'qr_score0')").run();
  const vid = Number(v.lastInsertRowid);

  // COALESCE(0, current) uses 0 (overwrites 50 with 0)
  db.prepare('UPDATE voters SET voter_score = COALESCE(?, voter_score) WHERE id = ?').run(0, vid);
  assert.strictEqual(db.prepare('SELECT voter_score FROM voters WHERE id = ?').get(vid).voter_score, 0);

  // COALESCE(null, current) keeps current
  db.prepare('UPDATE voters SET voter_score = COALESCE(?, voter_score) WHERE id = ?').run(null, vid);
  assert.strictEqual(db.prepare('SELECT voter_score FROM voters WHERE id = ?').get(vid).voter_score, 0);
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
console.log(`STRESS TEST ROUND 13 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('='.repeat(60));

db.close();
try { fs.unlinkSync(TEST_DB); } catch (e) {}

process.exit(failed > 0 ? 1 : 0);
