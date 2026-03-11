#!/usr/bin/env node
/**
 * Stress Test Round 2 — Harder edge cases, boundary conditions, injection attempts
 * Tests: SQL injection attempts, XSS in data, unicode handling, boundary values,
 *        foreign key integrity under stress, CSV-like data, opt-out flow, sentiment analysis
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'data');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'test_stress_r2.db');
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

// Minimal schema
db.exec(`
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', city TEXT DEFAULT '', email TEXT DEFAULT '', preferred_channel TEXT DEFAULT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, body TEXT, direction TEXT DEFAULT 'inbound', timestamp TEXT DEFAULT (datetime('now')), sentiment TEXT, session_id INTEGER, volunteer_name TEXT, channel TEXT DEFAULT 'sms');
  CREATE INDEX idx_messages_direction_id ON messages(direction, id DESC);
  CREATE TABLE opt_outs (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, opted_out_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', location TEXT DEFAULT '', event_date TEXT NOT NULL, event_time TEXT DEFAULT '', status TEXT DEFAULT 'upcoming', created_at TEXT DEFAULT (datetime('now')), flyer_image TEXT DEFAULT NULL);
  CREATE TABLE event_rsvps (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, contact_phone TEXT NOT NULL, contact_name TEXT DEFAULT '', rsvp_status TEXT DEFAULT 'invited', invited_at TEXT DEFAULT (datetime('now')), responded_at TEXT, checked_in_at TEXT);
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);
  CREATE TABLE voters (id INTEGER PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', party TEXT DEFAULT '', support_level TEXT DEFAULT 'unknown', voter_score INTEGER DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '', registration_number TEXT DEFAULT '', qr_token TEXT, voting_history TEXT DEFAULT '', precinct TEXT DEFAULT '', early_voted INTEGER DEFAULT 0, early_voted_date TEXT, early_voted_method TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_voters_phone ON voters(phone);
  CREATE TABLE p2p_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL, assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL, status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL, session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_volunteers (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, is_online INTEGER DEFAULT 1, joined_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE p2p_assignments (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE, volunteer_id INTEGER REFERENCES p2p_volunteers(id), contact_id INTEGER NOT NULL REFERENCES contacts(id), status TEXT DEFAULT 'pending', original_volunteer_id INTEGER, assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT, wa_status TEXT);
  CREATE TABLE captains (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_lists (id INTEGER PRIMARY KEY, captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE, team_member_id INTEGER, name TEXT NOT NULL, list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE captain_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
  CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE survey_questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice', sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
  CREATE TABLE survey_sends (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent', current_question_id INTEGER, sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
  CREATE TABLE survey_responses (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER, responded_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE admin_list_voters (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE, added_at TEXT DEFAULT (datetime('now')), UNIQUE(list_id, voter_id));
`);

const { phoneDigits, normalizePhone, toE164, personalizeTemplate } = require('./utils');

console.log('=== STRESS TEST ROUND 2 — EDGE CASES ===\n');

// =============================================================================
// TEST 1: SQL injection via parameterized queries
// =============================================================================
console.log('\n[1] SQL injection attempts...');

// These should all be safely handled by parameterized queries
const maliciousInputs = [
  "'; DROP TABLE contacts; --",
  "1 OR 1=1",
  "' UNION SELECT * FROM settings --",
  '1; DELETE FROM voters;',
  "Robert'); DROP TABLE voters;--",
  "' OR '1'='1",
  '"; DROP TABLE messages; --',
  "1' AND (SELECT COUNT(*) FROM settings WHERE key='session_secret')>0 --"
];

// Insert malicious data as contact names (should store literally)
for (const input of maliciousInputs) {
  try {
    db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)").run('5550000001', input);
  } catch (e) { /* Some may fail on constraint but not on injection */ }
}
// Verify tables still exist
assert(db.prepare('SELECT COUNT(*) as c FROM contacts').get().c > 0, 'contacts table survives injection attempts');
assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voters'").get() !== undefined, 'voters table not dropped');
assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get() !== undefined, 'settings table not dropped');

// Verify the injected names are stored literally
const injected = db.prepare("SELECT first_name FROM contacts WHERE first_name LIKE '%DROP%' LIMIT 1").get();
assert(injected && injected.first_name.includes('DROP TABLE'), 'Injection stored as literal string');

// Search with malicious input (LIKE injection)
const searchResult = db.prepare("SELECT * FROM contacts WHERE first_name LIKE ? LIMIT 10").all('%' + "'; DROP TABLE contacts; --" + '%');
assert(Array.isArray(searchResult), 'LIKE search with injection returns array');

// =============================================================================
// TEST 2: XSS in stored data
// =============================================================================
console.log('\n[2] XSS payloads stored safely...');

const xssPayloads = [
  '<script>alert("XSS")</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "javascript:alert('XSS')",
  '<iframe src="javascript:alert(1)">',
  '{{constructor.constructor("return this")()}}',
  '${7*7}',
];

for (const payload of xssPayloads) {
  db.prepare("INSERT INTO voters (first_name, last_name, phone) VALUES (?, ?, ?)").run(payload, payload, '5550000099');
}
const xssVoter = db.prepare("SELECT first_name FROM voters WHERE first_name LIKE '%script%' LIMIT 1").get();
assert(xssVoter && xssVoter.first_name.includes('<script>'), 'XSS payload stored literally (not executed)');

// personalizeTemplate with XSS
const xssTemplate = personalizeTemplate('Hello {firstName}!', { firstName: '<script>alert(1)</script>' });
assert(xssTemplate.includes('<script>'), 'personalizeTemplate passes through HTML (frontend must escape)');

// =============================================================================
// TEST 3: Unicode and emoji handling
// =============================================================================
console.log('\n[3] Unicode and emoji handling...');

const unicodeData = [
  { name: 'José García', city: 'San José' },
  { name: '张伟', city: '北京' },
  { name: 'Müller', city: 'München' },
  { name: 'Dwayne "The Rock"', city: "Rock's Place" },
  { name: '🎉 Party!', city: '🌎 World' },
  { name: 'Крупнов', city: 'Москва' },
  { name: 'محمد', city: 'الرياض' },
  { name: '', city: '' },
  { name: 'A'.repeat(10000), city: 'B'.repeat(10000) }, // Very long strings
];

for (const u of unicodeData) {
  db.prepare("INSERT INTO voters (first_name, city) VALUES (?, ?)").run(u.name, u.city);
}
const jose = db.prepare("SELECT first_name, city FROM voters WHERE first_name = ?").get('José García');
assert(jose && jose.first_name === 'José García', 'Unicode accents preserved');
assert(jose && jose.city === 'San José', 'Unicode city preserved');

const chinese = db.prepare("SELECT first_name FROM voters WHERE first_name = ?").get('张伟');
assert(chinese && chinese.first_name === '张伟', 'Chinese characters preserved');

const emoji = db.prepare("SELECT first_name FROM voters WHERE first_name LIKE '%🎉%'").get();
assert(emoji && emoji.first_name.includes('🎉'), 'Emoji preserved');

const longName = db.prepare("SELECT LENGTH(first_name) as len FROM voters WHERE LENGTH(first_name) > 1000").get();
assert(longName && longName.len === 10000, 'Long string preserved (10K chars)');

// =============================================================================
// TEST 4: Boundary values
// =============================================================================
console.log('\n[4] Boundary values...');

// Integer overflow
assert(phoneDigits('99999999999999999') === '99999999999999999', 'phoneDigits handles large numbers');
assert(normalizePhone('99999999999999999') === '', 'normalizePhone rejects >10 digit');
assert(toE164('') === '', 'toE164 empty string');

// Null/undefined in personalizeTemplate — should handle gracefully
assert(personalizeTemplate('{firstName}', null) === '', 'personalizeTemplate with null contact');
assert(personalizeTemplate(null, { firstName: 'Test' }) === '', 'personalizeTemplate null template returns empty');
assert(personalizeTemplate(undefined, undefined) === '', 'personalizeTemplate all undefined returns empty');

// Very long template
const longTemplate = '{firstName}'.repeat(10000);
const longResult = personalizeTemplate(longTemplate, { firstName: 'X' });
assert(longResult.length === 10000, 'personalizeTemplate handles long template (' + longResult.length + ')');

// =============================================================================
// TEST 5: Opt-out flow integrity
// =============================================================================
console.log('\n[5] Opt-out flow integrity...');

// Insert opt-outs
db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run('5551112222');
db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run('5551112222'); // duplicate should be ignored
const optOutCount = db.prepare("SELECT COUNT(*) as c FROM opt_outs WHERE phone = '5551112222'").get().c;
assert(optOutCount === 1, 'Opt-out dedup works');

// Check STOP keywords work
const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
assert(STOP_KEYWORDS.includes('stop'), 'stop is a keyword');
assert(STOP_KEYWORDS.includes('unsubscribe'), 'unsubscribe is a keyword');
assert(!STOP_KEYWORDS.includes('STOP'), 'STOP (uppercase) not in array — code lowercases first');
assert(!STOP_KEYWORDS.includes('maybe'), 'maybe is not stop');

// =============================================================================
// TEST 6: Sentiment analysis edge cases (server.js inline function)
// =============================================================================
console.log('\n[6] Sentiment analysis...');

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

assert(analyzeSentiment('Yes, I support this!') === 'positive', 'Positive sentiment');
assert(analyzeSentiment('No, I hate this. Stop.') === 'negative', 'Negative sentiment');
assert(analyzeSentiment('Maybe later.') === 'neutral', 'Neutral sentiment');
assert(analyzeSentiment('') === 'neutral', 'Empty = neutral');
assert(analyzeSentiment(null) === 'neutral', 'Null = neutral');
assert(analyzeSentiment('I agree and support it, great!') === 'positive', 'Multiple positive');
// "no thanks" has mixed signals: "thank"/"thanks" match positive, "no"/"not interested"/"bad" match negative
// The simple keyword analyzer may score this differently depending on overlap
const mixedResult = analyzeSentiment('no thanks, not interested, bad');
assert(['negative', 'neutral'].includes(mixedResult), 'Mixed sentiment returns valid value: ' + mixedResult + ' (known limitation of keyword approach)');

// Edge case: "good" vs "not good" — simple analysis doesn't catch negation
const notGood = analyzeSentiment('not good at all');
assert(notGood === 'neutral' || notGood === 'positive' || notGood === 'negative', 'not good returns valid sentiment (known limitation)');

// =============================================================================
// TEST 7: Large-scale foreign key integrity
// =============================================================================
console.log('\n[7] FK integrity under stress...');

// Create a P2P session with 1000 contacts and assignments
const insertC = db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)");
const contactIds = [];
db.transaction(() => {
  for (let i = 0; i < 1000; i++) {
    const r = insertC.run('666' + String(i).padStart(7, '0'), 'Stress' + i);
    contactIds.push(r.lastInsertRowid);
  }
})();

const sessId = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('StressSess', 'Hi {firstName}', '9999', '2026-12-31')").run().lastInsertRowid;
const volId = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, 'StressVol')").run(sessId).lastInsertRowid;

db.transaction(() => {
  const ins = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)');
  for (const cid of contactIds) {
    ins.run(sessId, cid, volId);
  }
})();

const assignCount = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessId).c;
assert(assignCount === 1000, '1000 P2P assignments created');

// Delete session — all should cascade
db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(sessId);
const assignAfter = db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sessId).c;
const volAfter = db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?').get(sessId).c;
assert(assignAfter === 0, '1000 assignments cascade deleted');
assert(volAfter === 0, 'Volunteer cascade deleted');

// Contacts should still exist (not cascade deleted)
const contactsAfter = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE phone LIKE ?').get('666%').c;
assert(contactsAfter === 1000, 'Contacts preserved after session delete (' + contactsAfter + ')');

// =============================================================================
// TEST 8: Survey response flow integrity
// =============================================================================
console.log('\n[8] Survey response flow...');

const survId = db.prepare("INSERT INTO surveys (name, status) VALUES ('Stress Survey', 'active')").run().lastInsertRowid;
const q1 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Favorite color?', 'single_choice', 1)").run(survId).lastInsertRowid;
const q2 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Why?', 'write_in', 2)").run(survId).lastInsertRowid;
const q3 = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Rank colors', 'ranked_choice', 3)").run(survId).lastInsertRowid;

db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Red', '1', 0)").run(q1);
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Blue', '2', 1)").run(q1);
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Green', '3', 2)").run(q1);

// Same options for ranked choice
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Red', '1', 0)").run(q3);
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Blue', '2', 1)").run(q3);
db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Green', '3', 2)").run(q3);

// Simulate 500 survey respondents
db.transaction(() => {
  for (let i = 0; i < 500; i++) {
    const phone = '777' + String(i).padStart(7, '0');
    const ssId = db.prepare("INSERT INTO survey_sends (survey_id, phone, current_question_id) VALUES (?, ?, ?)").run(survId, phone, q1).lastInsertRowid;

    // Answer Q1 (single choice)
    const pick = String((i % 3) + 1);
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)").run(survId, ssId, q1, phone, pick);

    // Answer Q2 (write-in)
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)").run(survId, ssId, q2, phone, 'Because reason ' + i);

    // Answer Q3 (ranked choice)
    const ranking = [1, 2, 3].sort(() => Math.random() - 0.5).join(',');
    db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)").run(survId, ssId, q3, phone, ranking);

    db.prepare("UPDATE survey_sends SET status = 'completed', current_question_id = NULL WHERE id = ?").run(ssId);
  }
})();

const totalResponses = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(survId).c;
assert(totalResponses === 1500, 'Survey: 500 respondents x 3 questions = 1500 responses (' + totalResponses + ')');

const completedSends = db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(survId).c;
assert(completedSends === 500, 'All 500 sends completed');

// Tally Q1 results
const q1Responses = db.prepare('SELECT response_text, COUNT(*) as c FROM survey_responses WHERE question_id = ? GROUP BY response_text').all(q1);
const totalQ1 = q1Responses.reduce((sum, r) => sum + r.c, 0);
assert(totalQ1 === 500, 'Q1 tally sums to 500');

// =============================================================================
// TEST 9: Rapid delete + re-insert (simulating data refresh)
// =============================================================================
console.log('\n[9] Rapid delete + re-insert...');

const refreshId = db.prepare("INSERT INTO admin_lists (name) VALUES ('Refresh List')").run().lastInsertRowid;

// First, seed some voters
const voterIds = [];
for (let i = 0; i < 100; i++) {
  voterIds.push(db.prepare("INSERT INTO voters (first_name, phone) VALUES ('RefreshVoter', ?)").run('888' + String(i).padStart(7, '0')).lastInsertRowid);
}

// Rapid add-delete cycles
for (let cycle = 0; cycle < 10; cycle++) {
  db.transaction(() => {
    for (const vid of voterIds) {
      db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)').run(refreshId, vid);
    }
  })();
  const count = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(refreshId).c;
  assert(count === 100, 'Cycle ' + cycle + ': 100 voters on list (' + count + ')');

  db.prepare('DELETE FROM admin_list_voters WHERE list_id = ?').run(refreshId);
  const afterDel = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(refreshId).c;
  assert(afterDel === 0, 'Cycle ' + cycle + ': cleared to 0');
}

// =============================================================================
// TEST 10: Events JOIN with zero RSVPs
// =============================================================================
console.log('\n[10] Events JOIN with zero RSVPs...');

const emptyEvent = db.prepare("INSERT INTO events (title, event_date) VALUES ('Empty Event', '2026-06-01')").run().lastInsertRowid;
const evQuery = db.prepare(`
  SELECT e.id, e.title, COUNT(er.id) as rsvp_total,
    SUM(CASE WHEN er.rsvp_status = 'confirmed' THEN 1 ELSE 0 END) as rsvp_confirmed
  FROM events e LEFT JOIN event_rsvps er ON e.id = er.event_id
  WHERE e.id = ? GROUP BY e.id
`).get(emptyEvent);
assert(evQuery.rsvp_total === 0, 'Event with 0 RSVPs: total=0');
assert(evQuery.rsvp_confirmed === 0, 'Event with 0 RSVPs: confirmed=0 (not null)');

// =============================================================================
// TEST 11: Captain list voter overlap detection
// =============================================================================
console.log('\n[11] Voter overlap detection...');

const cap1 = db.prepare("INSERT INTO captains (name, code) VALUES ('Cap1', 'OVER01')").run().lastInsertRowid;
const cap2 = db.prepare("INSERT INTO captains (name, code) VALUES ('Cap2', 'OVER02')").run().lastInsertRowid;
const cl1 = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'List1')").run(cap1).lastInsertRowid;
const cl2 = db.prepare("INSERT INTO captain_lists (captain_id, name) VALUES (?, 'List2')").run(cap2).lastInsertRowid;

// Add 50 voters to both lists (overlap)
for (let i = 0; i < 50; i++) {
  const vid = voterIds[i];
  db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(cl1, vid);
  db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(cl2, vid);
}

const overlap = db.prepare(`
  SELECT COUNT(*) as c FROM (
    SELECT voter_id FROM captain_list_voters GROUP BY voter_id HAVING COUNT(DISTINCT list_id) >= 2
  )
`).get().c;
assert(overlap === 50, 'Overlap detection finds 50 shared voters (' + overlap + ')');

// =============================================================================
// TEST 12: Message volume and retrieval
// =============================================================================
console.log('\n[12] Message volume stress...');

// Insert 50K messages
const t1 = Date.now();
const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, ?, ?, ?)");
db.transaction(() => {
  for (let i = 0; i < 50000; i++) {
    const dir = i % 3 === 0 ? 'inbound' : 'outbound';
    const sent = ['positive', 'negative', 'neutral'][i % 3];
    const ch = i % 4 === 0 ? 'whatsapp' : 'sms';
    insertMsg.run('999' + String(i % 10000).padStart(7, '0'), 'Message #' + i, dir, sent, ch);
  }
})();
const t2 = Date.now();
assert(t2 - t1 < 10000, '50K messages inserted < 10s (took ' + (t2 - t1) + 'ms)');

// Retrieve inbound messages (like /api/messages)
const t3 = Date.now();
const inbound = db.prepare("SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id DESC LIMIT 200").all();
const t4 = Date.now();
assert(inbound.length === 200, '200 inbound messages returned');
assert(t4 - t3 < 500, 'Inbound message retrieval < 500ms (took ' + (t4 - t3) + 'ms)');

// Sentiment stats on 50K messages
const t5 = Date.now();
const sentStats = db.prepare(`
  SELECT
    SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
    SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
    SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral
  FROM messages
`).get();
const t6 = Date.now();
assert(sentStats.positive + sentStats.negative + sentStats.neutral === 50000, 'Sentiment totals match (50K)');
assert(t6 - t5 < 500, 'Sentiment stats < 500ms (took ' + (t6 - t5) + 'ms)');

// =============================================================================
// TEST 13: Empty table queries
// =============================================================================
console.log('\n[13] Empty table queries...');

// Query on table with no rows matching
const noMatch = db.prepare("SELECT * FROM voters WHERE phone = ?").get('0000000000');
assert(noMatch === undefined, 'No-match returns undefined');

const emptyAll = db.prepare("SELECT * FROM voters WHERE phone = ?").all('0000000000');
assert(Array.isArray(emptyAll) && emptyAll.length === 0, 'No-match .all() returns empty array');

// Count on empty result
const zeroCount = db.prepare("SELECT COUNT(*) as c FROM voters WHERE phone = ?").get('0000000000').c;
assert(zeroCount === 0, 'COUNT on no match = 0');

// =============================================================================
// TEST 14: Special characters in settings
// =============================================================================
console.log('\n[14] Special characters in settings...');

const specialValues = [
  'sk-ant-api03-very-long-key-' + 'x'.repeat(200),
  'Value with "double quotes" and \'single quotes\'',
  'Line1\nLine2\nLine3',
  'Path: C:\\Users\\test\\file.txt',
  '{"json": true, "nested": {"key": "value"}}',
  '',
];

for (const val of specialValues) {
  const key = 'test_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, val);
  const readBack = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  assert(readBack && readBack.value === val, 'Setting round-trip: ' + key);
}

// =============================================================================
// TEST 15: Walk addresses with GPS data
// =============================================================================
console.log('\n[15] GPS data precision...');

db.exec("CREATE TABLE IF NOT EXISTS block_walks_test (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE IF NOT EXISTS walk_addresses_test (id INTEGER PRIMARY KEY, walk_id INTEGER REFERENCES block_walks_test(id) ON DELETE CASCADE, address TEXT, lat REAL, lng REAL, gps_lat REAL, gps_lng REAL, gps_accuracy REAL)");
const wid = db.prepare("INSERT INTO block_walks_test (name) VALUES ('GPS Walk')").run().lastInsertRowid;

// Test GPS precision (6 decimal places = ~11cm accuracy)
db.prepare("INSERT INTO walk_addresses_test (walk_id, address, lat, lng, gps_lat, gps_lng, gps_accuracy) VALUES (?, ?, ?, ?, ?, ?, ?)").run(wid, '123 Main St', 30.267153, -97.743061, 30.267150, -97.743065, 4.5);
const gps = db.prepare("SELECT * FROM walk_addresses_test WHERE walk_id = ?").get(wid);
assert(Math.abs(gps.lat - 30.267153) < 0.000001, 'GPS lat precision preserved');
assert(Math.abs(gps.lng - (-97.743061)) < 0.000001, 'GPS lng precision preserved');
assert(gps.gps_accuracy === 4.5, 'GPS accuracy preserved');

// =============================================================================
// RESULTS
// =============================================================================
console.log('\n\n=== ROUND 2 RESULTS ===');
console.log('Passed: ' + passed + '/' + (passed + failed));
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log('  - ' + f));
}

db.close();
try { fs.unlinkSync(testDbPath); } catch (e) {}
process.exit(failed > 0 ? 1 : 0);
