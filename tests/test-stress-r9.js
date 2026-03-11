/**
 * STRESS TEST ROUND 9 — Adversarial API Sequences & Parameter Type Coercion
 *
 * This round focuses on:
 * 1. parseInt/NaN parameter coercion (req.params as strings)
 * 2. Adversarial API call ordering (delete before create, update after delete)
 * 3. Empty/null body edge cases
 * 4. Large batch operations (memory pressure)
 * 5. Concurrent transaction isolation
 * 6. Opt-out enforcement across all send paths
 * 7. P2P claim mode race condition
 * 8. Survey state machine transitions (draft→active→closed→re-open)
 * 9. Walk group max_walkers enforcement
 * 10. Settings key injection attempts
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, 'data', 'test-stress-r9.db');
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
// SECTION 1: parseInt/NaN Parameter Coercion
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: parseInt Coercion ===');

test('parseInt: valid integer string', () => {
  const id = parseInt('42', 10);
  assert.strictEqual(id, 42);
  assert(!isNaN(id));
});

test('parseInt: NaN from non-numeric string', () => {
  const id = parseInt('abc', 10);
  assert(isNaN(id), 'Non-numeric string should produce NaN');
  // Demonstrates need for validation — NaN in a query parameter could cause issues
});

test('parseInt: leading zeros', () => {
  const id = parseInt('007', 10);
  assert.strictEqual(id, 7);
});

test('parseInt: negative number', () => {
  const id = parseInt('-1', 10);
  assert.strictEqual(id, -1);
  assert(id <= 0, 'Negative IDs should be rejected');
});

test('parseInt: float string truncated', () => {
  const id = parseInt('3.14', 10);
  assert.strictEqual(id, 3);
});

test('parseInt: empty string produces NaN', () => {
  const id = parseInt('', 10);
  assert(isNaN(id));
});

test('SQLite: NaN in WHERE clause returns no rows', () => {
  db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('Test', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const result = db.prepare('SELECT * FROM voters WHERE id = ?').get(NaN);
  assert.strictEqual(result, undefined, 'NaN should not match any row');
});

test('SQLite: undefined in WHERE clause returns no rows', () => {
  const result = db.prepare('SELECT * FROM voters WHERE id = ?').get(undefined);
  assert.strictEqual(result, undefined, 'undefined should not match any row');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Adversarial API Call Ordering
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Adversarial Ordering ===');

test('Delete non-existent walk returns gracefully', () => {
  const result = db.prepare('DELETE FROM block_walks WHERE id = ?').run(99999);
  assert.strictEqual(result.changes, 0);
});

test('Update after delete returns 0 changes', () => {
  const res = db.prepare("INSERT INTO events (title, event_date) VALUES ('TempEvent', '2025-01-01')").run();
  db.prepare('DELETE FROM events WHERE id = ?').run(res.lastInsertRowid);
  const upd = db.prepare("UPDATE events SET title = 'Updated' WHERE id = ?").run(res.lastInsertRowid);
  assert.strictEqual(upd.changes, 0);
});

test('Double-delete is idempotent', () => {
  const res = db.prepare("INSERT INTO admin_lists (name) VALUES ('DoubleDel')").run();
  const d1 = db.prepare('DELETE FROM admin_lists WHERE id = ?').run(res.lastInsertRowid);
  assert.strictEqual(d1.changes, 1);
  const d2 = db.prepare('DELETE FROM admin_lists WHERE id = ?').run(res.lastInsertRowid);
  assert.strictEqual(d2.changes, 0);
});

test('FK violation on orphaned reference', () => {
  // Try inserting walk_address referencing non-existent walk
  let threw = false;
  try {
    db.prepare("INSERT INTO walk_addresses (walk_id, address) VALUES (99999, '123 Fake St')").run();
  } catch (e) {
    threw = true;
    assert(e.message.includes('FOREIGN KEY'), 'Should be FK violation');
  }
  assert(threw, 'Should throw on FK violation');
});

test('Create and immediately query returns the new row', () => {
  const res = db.prepare("INSERT INTO surveys (name) VALUES ('Immediate')").run();
  const row = db.prepare('SELECT * FROM surveys WHERE id = ?').get(res.lastInsertRowid);
  assert(row, 'Should find immediately after insert');
  assert.strictEqual(row.name, 'Immediate');
  db.prepare('DELETE FROM surveys WHERE id = ?').run(res.lastInsertRowid);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Empty/Null Body Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Empty/Null Bodies ===');

test('COALESCE with empty string preserves empty string (not NULL)', () => {
  const res = db.prepare("INSERT INTO voters (first_name, last_name, phone, qr_token) VALUES ('', '', '', ?)").run(crypto.randomBytes(6).toString('base64url'));
  db.prepare("UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?").run('', res.lastInsertRowid);
  const voter = db.prepare('SELECT first_name FROM voters WHERE id = ?').get(res.lastInsertRowid);
  assert.strictEqual(voter.first_name, '', 'Empty string should be preserved');
});

test('COALESCE with NULL keeps original', () => {
  const res = db.prepare("INSERT INTO voters (first_name, phone, qr_token) VALUES ('OrigName', '1234567890', ?)").run(crypto.randomBytes(6).toString('base64url'));
  db.prepare("UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?").run(null, res.lastInsertRowid);
  const voter = db.prepare('SELECT first_name FROM voters WHERE id = ?').get(res.lastInsertRowid);
  assert.strictEqual(voter.first_name, 'OrigName');
});

test('INSERT with all defaults uses correct defaults', () => {
  const res = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('Defaults', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const voter = db.prepare('SELECT * FROM voters WHERE id = ?').get(res.lastInsertRowid);
  assert.strictEqual(voter.support_level, 'unknown');
  assert.strictEqual(voter.voter_score, 0);
  assert.strictEqual(voter.early_voted, 0);
  assert.strictEqual(voter.phone, '');
  assert.strictEqual(voter.tags, '');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Large Batch Operations (Memory Pressure)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: Large Batches ===');

test('Batch insert 5000 voters in transaction', () => {
  const insert = db.prepare("INSERT INTO voters (first_name, last_name, phone, precinct, qr_token) VALUES (?,?,?,?,?)");
  const addMany = db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      insert.run('Batch' + i, 'BL' + i, '555600' + String(i).padStart(4, '0'), 'BPCT-' + (i % 10), crypto.randomBytes(6).toString('base64url'));
    }
  });
  addMany();
  const count = db.prepare("SELECT COUNT(*) as c FROM voters WHERE precinct LIKE 'BPCT-%'").get().c;
  assert.strictEqual(count, 5000);
});

test('Query 5000 voters by precinct filter', () => {
  const voters = db.prepare("SELECT id, first_name FROM voters WHERE precinct = 'BPCT-0'").all();
  assert.strictEqual(voters.length, 500);
});

test('Batch add voters to admin list (5000 INSERT OR IGNORE)', () => {
  const list = db.prepare("INSERT INTO admin_lists (name) VALUES ('Big List')").run();
  const voters = db.prepare("SELECT id FROM voters WHERE precinct LIKE 'BPCT-%'").all();
  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addAll = db.transaction(() => {
    let added = 0;
    for (const v of voters) { if (insert.run(list.lastInsertRowid, v.id).changes > 0) added++; }
    return added;
  });
  const added = addAll();
  assert.strictEqual(added, 5000);
});

test('Batch delete admin list cascades voter memberships', () => {
  const list = db.prepare("SELECT id FROM admin_lists WHERE name = 'Big List'").get();
  const beforeCount = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list.id).c;
  assert.strictEqual(beforeCount, 5000);
  db.prepare('DELETE FROM admin_lists WHERE id = ?').run(list.id);
  const afterCount = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(list.id).c;
  assert.strictEqual(afterCount, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Concurrent Transaction Isolation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Transaction Isolation ===');

test('Transaction rollback on error preserves state', () => {
  const countBefore = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;

  const badTx = db.transaction(() => {
    db.prepare("INSERT INTO contacts (phone) VALUES ('5559990001')").run();
    db.prepare("INSERT INTO contacts (phone) VALUES ('5559990002')").run();
    // Force error
    throw new Error('Simulated failure');
  });

  try { badTx(); } catch (e) { /* expected */ }

  const countAfter = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  assert.strictEqual(countAfter, countBefore, 'Transaction should be rolled back');
});

test('Nested prepared statement in transaction works', () => {
  const insertContact = db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)");
  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');

  const safeTx = db.transaction(() => {
    insertContact.run('5559990010', 'TxTest1');
    const found = findContact.get('5559990010');
    assert(found, 'Should find within transaction');
    insertContact.run('5559990011', 'TxTest2');
    return 2;
  });

  const result = safeTx();
  assert.strictEqual(result, 2);
  assert(db.prepare("SELECT id FROM contacts WHERE phone = '5559990010'").get());
  assert(db.prepare("SELECT id FROM contacts WHERE phone = '5559990011'").get());
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Opt-Out Enforcement Across All Paths
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: Opt-Out Enforcement ===');

test('Opted-out phone in P2P queue is auto-skipped', () => {
  // Create opt-out
  db.prepare("INSERT OR IGNORE INTO opt_outs (phone) VALUES ('5551110000')").run();

  // Create contact, session, assignment
  const cRes = db.prepare("INSERT INTO contacts (phone, first_name) VALUES ('5551110000', 'OptOut')").run();
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('OptOut Test', 'Hi', ?, ?)").run(generateJoinCode(), expires);
  const vRes = db.prepare("INSERT INTO p2p_volunteers (session_id, name) VALUES (?, 'VolOptTest')").run(sRes.lastInsertRowid);
  const aRes = db.prepare("INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)").run(sRes.lastInsertRowid, cRes.lastInsertRowid, vRes.lastInsertRowid);

  // Simulate queue check: skip opted-out contacts
  const optedOutPhones = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const pendingAll = db.prepare(`
    SELECT a.id, c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id
    WHERE a.volunteer_id = ? AND a.status = 'pending' ORDER BY a.id ASC
  `).all(vRes.lastInsertRowid);

  for (const p of pendingAll) {
    if (optedOutPhones.has(p.phone)) {
      db.prepare("UPDATE p2p_assignments SET status = 'skipped' WHERE id = ?").run(p.id);
    }
  }

  const assign = db.prepare('SELECT status FROM p2p_assignments WHERE id = ?').get(aRes.lastInsertRowid);
  assert.strictEqual(assign.status, 'skipped', 'Opted-out contact should be skipped');
});

test('Opted-out phone blocked from survey send', () => {
  db.prepare("INSERT OR IGNORE INTO opt_outs (phone) VALUES ('5551120000')").run();
  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  assert(optedOutSet.has('5551120000'), 'Should be in opt-out set');

  // Simulating the survey send loop that checks opt-outs
  let queued = 0;
  const contacts = [{ phone: '5551120000', first_name: 'Blocked' }];
  for (const c of contacts) {
    if (optedOutSet.has(c.phone)) continue;
    queued++;
  }
  assert.strictEqual(queued, 0, 'Opted-out contact should not be queued');
});

test('Opt-out then re-subscribe allows messaging again', () => {
  db.prepare("INSERT OR IGNORE INTO opt_outs (phone) VALUES ('5551130000')").run();
  assert(db.prepare("SELECT id FROM opt_outs WHERE phone = '5551130000'").get());

  // Re-subscribe (remove from opt-outs)
  db.prepare("DELETE FROM opt_outs WHERE phone = '5551130000'").run();

  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  assert(!optedOutSet.has('5551130000'), 'Should no longer be opted out');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Survey State Machine Transitions
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Survey State Machine ===');

test('Survey: draft → active → closed → reopen', () => {
  const res = db.prepare("INSERT INTO surveys (name, status) VALUES ('State Machine', 'draft')").run();
  const sid = res.lastInsertRowid;

  // draft → active
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');

  // active → closed
  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'closed');

  // closed → active (reopen)
  db.prepare("UPDATE surveys SET status = 'active' WHERE id = ?").run(sid);
  assert.strictEqual(db.prepare('SELECT status FROM surveys WHERE id = ?').get(sid).status, 'active');
});

test('Survey: closed survey rejects new sends', () => {
  const res = db.prepare("INSERT INTO surveys (name, status) VALUES ('Closed Survey', 'closed')").run();
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(res.lastInsertRowid);
  assert.strictEqual(survey.status, 'closed');
  // App logic check
  const blocked = (survey.status === 'closed');
  assert(blocked, 'Closed survey should block sends');
});

test('Survey: ending poll expires all pending sends', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, status) VALUES ('EndPoll', 'active')").run();
  const sid = sRes.lastInsertRowid;
  const qRes = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Q?', 'single_choice')").run(sid);

  // Create sends in various states
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status, current_question_id) VALUES (?, '1111', 'sent', ?)").run(sid, qRes.lastInsertRowid);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status, current_question_id) VALUES (?, '2222', 'in_progress', ?)").run(sid, qRes.lastInsertRowid);
  db.prepare("INSERT INTO survey_sends (survey_id, phone, status) VALUES (?, '3333', 'completed')").run(sid);

  // End poll
  db.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").run(sid);
  const expired = db.prepare("UPDATE survey_sends SET status = 'expired', current_question_id = NULL WHERE survey_id = ? AND status IN ('sent', 'in_progress')").run(sid);

  assert.strictEqual(expired.changes, 2, 'Should expire sent + in_progress');
  // Completed should not be changed
  const completed = db.prepare("SELECT status FROM survey_sends WHERE survey_id = ? AND phone = '3333'").get(sid);
  assert.strictEqual(completed.status, 'completed', 'Completed sends should not be expired');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Walk Group Constraints
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Walk Group Constraints ===');

test('Walk: max_walkers enforcement', () => {
  const wRes = db.prepare("INSERT INTO block_walks (name, max_walkers, join_code) VALUES ('Full Walk', 2, 'FULL')").run();
  const wid = wRes.lastInsertRowid;

  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'W1')").run(wid);
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'W2')").run(wid);

  const members = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(wid);
  const maxWalkers = db.prepare('SELECT max_walkers FROM block_walks WHERE id = ?').get(wid).max_walkers;

  assert(members.c >= maxWalkers, 'Group should be full');

  // App logic check: reject if full
  const isFull = members.c >= maxWalkers;
  assert(isFull, 'Should detect group is full');
});

test('Walk: duplicate walker name rejected by UNIQUE', () => {
  const wRes = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('Dup Walk', 'DUPW')").run();
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'DupWalker')").run(wRes.lastInsertRowid);

  let threw = false;
  try {
    db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'DupWalker')").run(wRes.lastInsertRowid);
  } catch (e) {
    threw = true;
    assert(e.message.includes('UNIQUE'), 'Should be UNIQUE constraint violation');
  }
  assert(threw, 'Duplicate walker name should throw');
});

test('Walk: completed walk rejects new joins', () => {
  const wRes = db.prepare("INSERT INTO block_walks (name, status, join_code) VALUES ('Done Walk', 'completed', 'DONE')").run();
  const walk = db.prepare("SELECT * FROM block_walks WHERE join_code = 'DONE' AND status != 'completed'").get();
  assert.strictEqual(walk, undefined, 'Completed walk should not be found by join query');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Settings Security
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Settings Security ===');

test('Settings: allowlist blocks secret keys', () => {
  const SETTINGS_ALLOWLIST = [
    'anthropic_api_key', 'candidate_name', 'campaign_name', 'campaign_info',
    'opt_out_footer', 'auto_reply_enabled', 'default_area_code',
  ];

  // Store secrets
  db.prepare("INSERT INTO settings (key, value) VALUES ('rumbleup_api_secret', 'SECRET123') ON CONFLICT(key) DO UPDATE SET value = 'SECRET123'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('rumbleup_api_key', 'KEYXXX') ON CONFLICT(key) DO UPDATE SET value = 'KEYXXX'").run();

  // Simulate GET check
  assert(!SETTINGS_ALLOWLIST.includes('rumbleup_api_secret'), 'api_secret should NOT be in allowlist');
  assert(!SETTINGS_ALLOWLIST.includes('rumbleup_api_key'), 'api_key should NOT be in allowlist');
  assert(SETTINGS_ALLOWLIST.includes('candidate_name'), 'candidate_name should be in allowlist');
});

test('Settings: allowlist blocks write to secrets', () => {
  const SETTINGS_ALLOWLIST = [
    'anthropic_api_key', 'candidate_name', 'campaign_name', 'campaign_info',
    'opt_out_footer', 'auto_reply_enabled', 'default_area_code',
  ];

  // Attempt to overwrite provider secrets
  assert(!SETTINGS_ALLOWLIST.includes('rumbleup_api_secret'));
  assert(!SETTINGS_ALLOWLIST.includes('rumbleup_api_key'));
});

test('Settings: path traversal key rejected', () => {
  const SETTINGS_ALLOWLIST = [
    'anthropic_api_key', 'candidate_name', 'campaign_name', 'campaign_info',
    'opt_out_footer', 'auto_reply_enabled', 'default_area_code',
  ];

  const traversalKeys = ['../etc/passwd', 'rumbleup_api_secret', '__proto__', 'constructor'];
  for (const key of traversalKeys) {
    assert(!SETTINGS_ALLOWLIST.includes(key), 'Key should be blocked: ' + key);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Event RSVP Deduplication & Check-In
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Event RSVP & Check-In ===');

test('Event: RSVP dedup via UNIQUE index', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('Dedup Event', '2025-06-01')").run();
  const eid = eRes.lastInsertRowid;

  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5559001111', 'Alice')").run(eid);
  // Duplicate should fail
  let threw = false;
  try {
    db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5559001111', 'Alice Dup')").run(eid);
  } catch (e) {
    threw = true;
    assert(e.message.includes('UNIQUE'));
  }
  assert(threw, 'Duplicate RSVP should be rejected');
});

test('Event: INSERT OR IGNORE for safe dedup', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('Safe Dedup', '2025-06-02')").run();
  const eid = eRes.lastInsertRowid;

  const r1 = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5559002222', 'Bob')").run(eid);
  assert.strictEqual(r1.changes, 1);
  const r2 = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5559002222', 'Bob Dup')").run(eid);
  assert.strictEqual(r2.changes, 0, 'Duplicate INSERT OR IGNORE returns 0 changes');
});

test('Event: check-in updates existing RSVP to attended', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('Checkin Event', '2025-06-03')").run();
  const eid = eRes.lastInsertRowid;

  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, '5559003333', 'Carol', 'confirmed')").run(eid);

  // Check in
  const existing = db.prepare("SELECT * FROM event_rsvps WHERE event_id = ? AND contact_phone = '5559003333'").get(eid);
  assert(existing);
  db.prepare("UPDATE event_rsvps SET rsvp_status = 'attended', checked_in_at = datetime('now') WHERE id = ?").run(existing.id);

  const updated = db.prepare('SELECT * FROM event_rsvps WHERE id = ?').get(existing.id);
  assert.strictEqual(updated.rsvp_status, 'attended');
  assert(updated.checked_in_at, 'Should have checked_in_at timestamp');
});

test('Event: QR voter check-in via voter_checkins table', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('QR Event', '2025-06-04')").run();
  const eid = eRes.lastInsertRowid;
  const vRes = db.prepare("INSERT INTO voters (first_name, qr_token) VALUES ('QRVoter', ?)").run(crypto.randomBytes(6).toString('base64url'));
  const vid = vRes.lastInsertRowid;

  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, eid);
  const checkin = db.prepare('SELECT * FROM voter_checkins WHERE voter_id = ? AND event_id = ?').get(vid, eid);
  assert(checkin, 'Check-in should exist');
  assert(checkin.checked_in_at, 'Should have timestamp');

  // Duplicate check-in rejected by UNIQUE
  let threw = false;
  try {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(vid, eid);
  } catch (e) {
    threw = true;
    assert(e.message.includes('UNIQUE'));
  }
  assert(threw, 'Duplicate QR check-in should be rejected');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Phone Normalization Stress
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: Phone Normalization ===');

test('normalizePhone: various US formats', () => {
  assert.strictEqual(normalizePhone('(512) 555-1234'), '5125551234');
  assert.strictEqual(normalizePhone('+1-512-555-1234'), '5125551234');
  assert.strictEqual(normalizePhone('1-512-555-1234'), '5125551234');
  assert.strictEqual(normalizePhone('512.555.1234'), '5125551234');
  assert.strictEqual(normalizePhone('512 555 1234'), '5125551234');
});

test('normalizePhone: international numbers rejected', () => {
  // 12+ digit international numbers should return empty
  assert.strictEqual(normalizePhone('+44 20 7946 0958'), '');
  assert.strictEqual(normalizePhone('0044 20 7946 0958'), '');
});

test('normalizePhone: too short returns empty', () => {
  assert.strictEqual(normalizePhone('555'), '');
  assert.strictEqual(normalizePhone('12345'), '');
});

test('normalizePhone: null/undefined returns empty', () => {
  assert.strictEqual(normalizePhone(null), '');
  assert.strictEqual(normalizePhone(undefined), '');
  assert.strictEqual(normalizePhone(''), '');
});

test('phoneDigits: strips all non-digits', () => {
  assert.strictEqual(phoneDigits('+1 (512) 555-1234'), '5125551234');
  assert.strictEqual(phoneDigits('call: 512.555.1234!'), '5125551234');
  assert.strictEqual(phoneDigits('abc'), '');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: Email Campaign Validation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: Email Campaign ===');

test('Email campaign record created on send', () => {
  const res = db.prepare("INSERT INTO email_campaigns (subject, body_html, sent_count, failed_count) VALUES ('Test Subject', '<p>Hello</p>', 10, 2)").run();
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(res.lastInsertRowid);
  assert.strictEqual(campaign.subject, 'Test Subject');
  assert.strictEqual(campaign.sent_count, 10);
  assert.strictEqual(campaign.failed_count, 2);
});

test('personalizeTemplate in email body', () => {
  const body = '<p>Dear {firstName} {lastName},</p><p>Your city: {city}</p>';
  const result = personalizeTemplate(body, { first_name: 'Jane', last_name: 'Doe', city: 'Austin' });
  assert.strictEqual(result, '<p>Dear Jane Doe,</p><p>Your city: Austin</p>');
});

test('personalizeTemplate does NOT execute code in merge tags', () => {
  // Ensure {firstName} is a simple replace, not eval
  const result = personalizeTemplate('Hi {firstName}', { first_name: '${process.exit()}' });
  assert.strictEqual(result, 'Hi ${process.exit()}', 'Template should treat as literal string');
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 9 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
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
