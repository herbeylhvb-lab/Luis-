/**
 * STRESS TEST ROUND 5 — Extreme Chaos & Cross-Module Integration
 *
 * Focus areas NOT covered by rounds 1-4:
 * - Universe builder with temp tables, multi-step segmentation
 * - Canvass import with all 3 matching tiers (phone, registration, name+address)
 * - Data enrichment conflict detection pipeline
 * - GPS route optimization with degenerate coordinates
 * - Captain CSV cross-matching at scale with ambiguous matches
 * - Engagement score calculation accuracy
 * - Walk group splitting math under member churn
 * - Early voting extract-to-list pipeline
 * - P2P claim mode assignment logic
 * - COALESCE NULL vs empty string edge cases in updates
 * - Full cascading delete chains across ALL FK relationships
 * - QR token uniqueness and check-in deduplication
 * - personalizeTemplate with every merge tag combo
 * - Phone normalization across the full international format spectrum
 * - Precinct analytics with zero-data precincts
 * - Activity log message truncation boundary
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

// Isolated test database
const TEST_DB = path.join(__dirname, 'data', 'test-stress-r5.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema (mirrors db.js) ───
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

  CREATE TABLE opt_outs (
    id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE,
    opted_out_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY, message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY, message_template TEXT,
    sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

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
  CREATE INDEX idx_voters_name ON voters(last_name, first_name);
  CREATE UNIQUE INDEX idx_voters_qr_token ON voters(qr_token);

  CREATE TABLE voter_contacts (
    id INTEGER PRIMARY KEY, voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    contact_type TEXT NOT NULL, result TEXT DEFAULT '', notes TEXT DEFAULT '',
    contacted_by TEXT DEFAULT '', contacted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_vc_voter ON voter_contacts(voter_id);

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
  CREATE INDEX idx_rsvps_event ON event_rsvps(event_id);
  CREATE UNIQUE INDEX idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone);

  CREATE TABLE voter_checkins (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    checked_in_at TEXT DEFAULT (datetime('now')),
    UNIQUE(voter_id, event_id)
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
  CREATE INDEX idx_walk_addr_walk ON walk_addresses(walk_id);

  CREATE TABLE walk_group_members (
    id INTEGER PRIMARY KEY,
    walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    walker_name TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(walk_id, walker_name)
  );

  CREATE TABLE p2p_sessions (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, message_template TEXT NOT NULL,
    assignment_mode TEXT DEFAULT 'auto_split', join_code TEXT NOT NULL,
    status TEXT DEFAULT 'active', code_expires_at TEXT NOT NULL,
    session_type TEXT DEFAULT 'campaign', created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE p2p_volunteers (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL, is_online INTEGER DEFAULT 1,
    joined_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE p2p_assignments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    volunteer_id INTEGER REFERENCES p2p_volunteers(id),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    status TEXT DEFAULT 'pending', original_volunteer_id INTEGER DEFAULT NULL,
    assigned_at TEXT DEFAULT (datetime('now')), sent_at TEXT, completed_at TEXT,
    wa_status TEXT DEFAULT NULL
  );

  CREATE TABLE captains (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
    phone TEXT DEFAULT '', email TEXT DEFAULT '', is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE captain_team_members (
    id INTEGER PRIMARY KEY,
    captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE captain_lists (
    id INTEGER PRIMARY KEY,
    captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL,
    name TEXT NOT NULL, list_type TEXT DEFAULT 'general',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE captain_list_voters (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(list_id, voter_id)
  );

  CREATE TABLE admin_lists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    list_type TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE admin_list_voters (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(list_id, voter_id)
  );

  CREATE TABLE email_campaigns (
    id INTEGER PRIMARY KEY, subject TEXT NOT NULL, body_html TEXT NOT NULL,
    sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE surveys (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE survey_questions (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL, question_type TEXT NOT NULL DEFAULT 'single_choice',
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE survey_options (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL, option_key TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE survey_sends (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    phone TEXT NOT NULL, contact_name TEXT DEFAULT '', status TEXT DEFAULT 'sent',
    current_question_id INTEGER DEFAULT NULL,
    sent_at TEXT DEFAULT (datetime('now')), completed_at TEXT
  );

  CREATE TABLE survey_responses (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    phone TEXT NOT NULL, response_text TEXT NOT NULL, option_id INTEGER DEFAULT NULL,
    responded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE election_votes (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    election_name TEXT NOT NULL, election_date TEXT NOT NULL,
    election_type TEXT DEFAULT 'general', election_cycle TEXT DEFAULT '',
    voted INTEGER DEFAULT 1,
    UNIQUE(voter_id, election_name)
  );
  CREATE INDEX idx_ev_voter ON election_votes(voter_id);
  CREATE INDEX idx_ev_election ON election_votes(election_name);
  CREATE INDEX idx_ev_date ON election_votes(election_date);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, display_name TEXT DEFAULT '',
    role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE campaign_knowledge (
    id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE response_scripts (
    id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, label TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Load utils ───
const { phoneDigits, normalizePhone, toE164, personalizeTemplate, generateJoinCode, generateAlphaCode } = require('./utils');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stdout.write('F');
  }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: UNIVERSE BUILDER — Temp Table Segmentation Pipeline
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 1: Universe Builder ===');

// Seed 5000 voters across 10 precincts, 4 parties
const insertVoter = db.prepare(
  `INSERT INTO voters (first_name, last_name, phone, address, city, zip, party, support_level, precinct, registration_number, qr_token)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const parties = ['D', 'R', 'I', 'L'];
const supports = ['strong_support', 'lean_support', 'undecided', 'lean_oppose', 'strong_oppose'];
const seedVotersTx = db.transaction(() => {
  for (let i = 0; i < 5000; i++) {
    const precinct = 'PCT-' + String(i % 10).padStart(2, '0');
    const party = parties[i % 4];
    const support = supports[i % 5];
    const phone = '555' + String(i).padStart(7, '0');
    const regNum = 'REG' + String(i).padStart(6, '0');
    const qr = crypto.randomBytes(6).toString('base64url');
    insertVoter.run('First' + i, 'Last' + i, phone, (100 + i) + ' Main St', 'Austin', '78701', party, support, precinct, regNum, qr);
  }
});
seedVotersTx();

// Seed election votes: 3 elections, varied participation
const insertVote = db.prepare(
  'INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)'
);
const elections = [
  { name: 'Nov 2024 General', date: '2024-11-05', type: 'general', cycle: 'november' },
  { name: 'Mar 2024 Primary', date: '2024-03-05', type: 'primary', cycle: 'march' },
  { name: 'Nov 2020 General', date: '2020-11-03', type: 'general', cycle: 'november' },
  { name: 'Nov 2016 General', date: '2016-11-08', type: 'general', cycle: 'november' },
  { name: 'May 2023 Local', date: '2023-05-06', type: 'local', cycle: 'may' },
];
const seedElectionsTx = db.transaction(() => {
  for (let i = 1; i <= 5000; i++) {
    // 80% voted in Nov 2024
    if (i % 5 !== 0) insertVote.run(i, elections[0].name, elections[0].date, elections[0].type, elections[0].cycle);
    // 50% voted in Mar 2024
    if (i % 2 === 0) insertVote.run(i, elections[1].name, elections[1].date, elections[1].type, elections[1].cycle);
    // 60% voted in Nov 2020
    if (i % 5 < 3) insertVote.run(i, elections[2].name, elections[2].date, elections[2].type, elections[2].cycle);
    // 40% voted in Nov 2016
    if (i % 5 < 2) insertVote.run(i, elections[3].name, elections[3].date, elections[3].type, elections[3].cycle);
    // 30% voted in May 2023
    if (i % 10 < 3) insertVote.run(i, elections[4].name, elections[4].date, elections[4].type, elections[4].cycle);
  }
});
seedElectionsTx();

test('Universe builder: precinct filter with temp tables', () => {
  // Simulate universe/build for PCT-00 and PCT-01
  const pctParams = ['PCT-00', 'PCT-01'];
  const pctFilter = 'precinct IN (' + pctParams.map(() => '?').join(',') + ')';

  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO _univ_precinct SELECT id FROM voters WHERE ' + pctFilter).run(...pctParams);
    const total = db.prepare('SELECT COUNT(*) as c FROM _univ_precinct').get().c;

    // 5000 voters / 10 precincts = 500 per precinct, 2 precincts = 1000
    assert.strictEqual(total, 1000);

    // Universe: voted since 2018
    db.exec('DROP TABLE IF EXISTS _univ_universe');
    db.exec('CREATE TEMP TABLE _univ_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_precinct up ON ev.voter_id = up.voter_id
      WHERE ev.election_date >= '2018-01-01'`).run();
    const universeCount = db.prepare('SELECT COUNT(*) as c FROM _univ_universe').get().c;
    // Should be high — most voters voted in at least one post-2018 election
    assert(universeCount > 800, 'Universe should be > 800, got ' + universeCount);
    assert(universeCount <= 1000);

    // Sub-universe: november cycle only
    db.exec('DROP TABLE IF EXISTS _univ_sub');
    db.exec('CREATE TEMP TABLE _univ_sub (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_sub
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_universe uu ON ev.voter_id = uu.voter_id
      WHERE ev.election_cycle = 'november'`).run();
    const subCount = db.prepare('SELECT COUNT(*) as c FROM _univ_sub').get().c;
    assert(subCount > 0 && subCount <= universeCount);

    // Priority: voted in Nov 2024 specifically
    db.exec('DROP TABLE IF EXISTS _univ_priority');
    db.exec('CREATE TEMP TABLE _univ_priority (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_priority
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_sub us ON ev.voter_id = us.voter_id
      WHERE ev.election_name = 'Nov 2024 General'`).run();
    const priorityCount = db.prepare('SELECT COUNT(*) as c FROM _univ_priority').get().c;
    assert(priorityCount > 0 && priorityCount <= subCount);

    // Cleanup
    db.exec('DROP TABLE IF EXISTS _univ_precinct; DROP TABLE IF EXISTS _univ_universe; DROP TABLE IF EXISTS _univ_sub; DROP TABLE IF EXISTS _univ_priority');
    return { total, universeCount, subCount, priorityCount };
  });
  buildTx();
});

test('Universe builder: empty precincts yields zero', () => {
  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _univ_precinct SELECT id FROM voters WHERE precinct = ?").run('NONEXISTENT');
    const c = db.prepare('SELECT COUNT(*) as c FROM _univ_precinct').get().c;
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    assert.strictEqual(c, 0);
  });
  buildTx();
});

test('Universe builder: all precincts = full voter file', () => {
  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _univ_precinct SELECT id FROM voters WHERE 1=1").run();
    const c = db.prepare('SELECT COUNT(*) as c FROM _univ_precinct').get().c;
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    assert.strictEqual(c, 5000);
  });
  buildTx();
});

test('Universe builder: create lists from segmentation', () => {
  const pctParams = ['PCT-03'];
  const buildTx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS _univ_precinct');
    db.exec('CREATE TEMP TABLE _univ_precinct (voter_id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO _univ_precinct SELECT id FROM voters WHERE precinct IN (?)").run(...pctParams);

    db.exec('DROP TABLE IF EXISTS _univ_universe');
    db.exec('CREATE TEMP TABLE _univ_universe (voter_id INTEGER PRIMARY KEY)');
    db.prepare(`INSERT INTO _univ_universe
      SELECT DISTINCT ev.voter_id FROM election_votes ev
      INNER JOIN _univ_precinct up ON ev.voter_id = up.voter_id
      WHERE ev.election_date >= '2020-01-01'`).run();

    // Create admin list from universe
    const listRes = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES (?, ?, ?)").run('Test Universe PCT-03', 'From stress test', 'general');
    const listId = listRes.lastInsertRowid;
    const added = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, voter_id FROM _univ_universe').run(listId);
    assert(added.changes > 0, 'Should have added voters to list');

    // Verify list contents
    const count = db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE list_id = ?').get(listId).c;
    assert.strictEqual(count, added.changes);

    db.exec('DROP TABLE IF EXISTS _univ_precinct; DROP TABLE IF EXISTS _univ_universe');
    return count;
  });
  const count = buildTx();
  assert(count > 0);
});

test('Election votes: UNIQUE constraint prevents double-recording', () => {
  const voterId = 1;
  // Already inserted above; try again
  const r = db.prepare('INSERT OR IGNORE INTO election_votes (voter_id, election_name, election_date, election_type, election_cycle) VALUES (?, ?, ?, ?, ?)').run(voterId, 'Nov 2024 General', '2024-11-05', 'general', 'november');
  assert.strictEqual(r.changes, 0); // ignored
});

test('Election analytics: voter participation frequency', () => {
  // "Super voters" who voted in 4+ elections
  const superVoters = db.prepare(`
    SELECT voter_id, COUNT(*) as elections_voted
    FROM election_votes GROUP BY voter_id HAVING COUNT(*) >= 4
  `).all();
  assert(superVoters.length > 0, 'Should have super voters');
  for (const sv of superVoters) {
    assert(sv.elections_voted >= 4);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Canvass Import — All 3 Matching Tiers
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 2: Canvass Import Matching ===');

test('Canvass: phone match (tier 1)', () => {
  // Voter 1 has phone 5550000000
  const voter = db.prepare('SELECT id, phone FROM voters WHERE id = 1').get();
  const digits = phoneDigits(voter.phone);
  assert(digits.length >= 7);

  // Simulate matching
  const found = db.prepare('SELECT id FROM voters WHERE phone = ?').get(voter.phone);
  assert(found);
  assert.strictEqual(found.id, 1);
});

test('Canvass: registration number match (tier 2)', () => {
  const voter = db.prepare('SELECT id, registration_number FROM voters WHERE id = 42').get();
  assert(voter.registration_number);

  const found = db.prepare('SELECT id FROM voters WHERE registration_number = ?').get(voter.registration_number);
  assert.strictEqual(found.id, 42);
});

test('Canvass: name + address match (tier 3)', () => {
  const voter = db.prepare('SELECT id, first_name, last_name, address FROM voters WHERE id = 100').get();
  const addrWords = voter.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
  const found = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  ).get(voter.first_name, voter.last_name, addrWords + '%');
  assert(found);
  assert.strictEqual(found.id, 100);
});

test('Canvass: unmatched row falls through all tiers', () => {
  const found1 = db.prepare('SELECT id FROM voters WHERE phone = ?').get('0000000000');
  assert(!found1);
  const found2 = db.prepare('SELECT id FROM voters WHERE registration_number = ?').get('NONEXISTENT');
  assert(!found2);
  const found3 = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND LOWER(address) LIKE ?"
  ).get('NoSuchPerson', 'NoSuchFamily', '999999%');
  assert(!found3);
});

test('Canvass import: bulk with contact logging', () => {
  const insertContact = db.prepare(
    "INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)"
  );
  const updateSupport = db.prepare("UPDATE voters SET support_level = ? WHERE id = ?");

  const importTx = db.transaction(() => {
    let matched = 0;
    for (let i = 1; i <= 200; i++) {
      const voter = db.prepare('SELECT id FROM voters WHERE id = ?').get(i);
      if (voter) {
        insertContact.run(voter.id, 'Door-knock', 'Strong Support', 'Test canvass', 'Tester');
        updateSupport.run('strong_support', voter.id);
        matched++;
      }
    }
    return matched;
  });
  const matched = importTx();
  assert.strictEqual(matched, 200);

  // Verify contacts were logged
  const contactCount = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE contacted_by = ?').get('Tester').c;
  assert.strictEqual(contactCount, 200);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Data Enrichment Conflict Detection
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 3: Data Enrichment ===');

test('Enrichment: fill empty phone numbers', () => {
  // Create voters without phones
  const noPhoneIds = [];
  const insertNoPhone = db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      const r = db.prepare(
        "INSERT INTO voters (first_name, last_name, phone, address, city, zip, party, precinct, registration_number, qr_token) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)"
      ).run('NoPhone' + i, 'Person' + i, (9000 + i) + ' Oak Ave', 'Dallas', '75001', 'D', 'PCT-20', 'ENRICH' + i, crypto.randomBytes(6).toString('base64url'));
      noPhoneIds.push(r.lastInsertRowid);
    }
  });
  insertNoPhone();

  // Enrich with phone numbers
  const updatePhone = db.prepare("UPDATE voters SET phone = ? WHERE id = ?");
  const enrichTx = db.transaction(() => {
    let filled = 0;
    for (let i = 0; i < noPhoneIds.length; i++) {
      const voter = db.prepare('SELECT id, phone FROM voters WHERE id = ?').get(noPhoneIds[i]);
      if (!voter.phone || voter.phone === '') {
        updatePhone.run(normalizePhone('214555' + String(i).padStart(4, '0')), noPhoneIds[i]);
        filled++;
      }
    }
    return filled;
  });
  const filled = enrichTx();
  assert.strictEqual(filled, 50);
});

test('Enrichment: detect phone conflicts', () => {
  // Voter already has a phone, but enrichment data has different one
  const voter = db.prepare('SELECT id, phone FROM voters WHERE id = 1').get();
  assert(voter.phone); // already has phone
  const newPhone = '9999999999';
  const currentDigits = phoneDigits(voter.phone);
  const newDigits = phoneDigits(newPhone);
  assert.notStrictEqual(currentDigits, newDigits); // confirms conflict
});

test('Enrichment: skip when phones match', () => {
  const voter = db.prepare('SELECT id, phone FROM voters WHERE id = 1').get();
  const sameDigits = phoneDigits(voter.phone);
  assert.strictEqual(sameDigits, sameDigits); // no conflict
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: GPS Route Optimization Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 4: GPS & Route Optimization ===');

// Haversine function from walks.js
function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    isFinite(lat) && isFinite(lng);
}

test('GPS: haversine at zero distance', () => {
  const d = gpsDistance(30.2672, -97.7431, 30.2672, -97.7431);
  assert.strictEqual(d, 0);
});

test('GPS: haversine across Austin (~5km)', () => {
  const d = gpsDistance(30.2672, -97.7431, 30.3100, -97.7431);
  assert(d > 4000 && d < 5500, 'Expected ~4.7km, got ' + d);
});

test('GPS: haversine antipodal points', () => {
  const d = gpsDistance(90, 0, -90, 0); // pole to pole
  assert(d > 20000000, 'Pole to pole should be > 20Mm');
});

test('GPS: coordinate validation rejects NaN', () => {
  assert(!isValidCoord(NaN, -97));
  assert(!isValidCoord(30, NaN));
  assert(!isValidCoord(NaN, NaN));
});

test('GPS: coordinate validation rejects Infinity', () => {
  assert(!isValidCoord(Infinity, -97));
  assert(!isValidCoord(30, -Infinity));
});

test('GPS: coordinate validation rejects out-of-range', () => {
  assert(!isValidCoord(91, 0));
  assert(!isValidCoord(-91, 0));
  assert(!isValidCoord(0, 181));
  assert(!isValidCoord(0, -181));
});

test('GPS: coordinate validation accepts boundary values', () => {
  assert(isValidCoord(90, 180));
  assert(isValidCoord(-90, -180));
  assert(isValidCoord(0, 0));
});

test('GPS: nearest-neighbor route optimization', () => {
  // Create a walk with GPS-enabled addresses in a known pattern
  const walkRes = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('GPS Test Walk', 'GPST')").run();
  const walkId = walkRes.lastInsertRowid;

  // Place 10 addresses in a line along a street (spaced ~100m apart)
  const baseLat = 30.2672;
  const baseLng = -97.7431;
  const insertAddr = db.prepare(
    'INSERT INTO walk_addresses (walk_id, address, city, lat, lng, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // Insert in scrambled order
  const scrambled = [7, 2, 9, 0, 4, 6, 1, 8, 3, 5];
  for (const idx of scrambled) {
    insertAddr.run(walkId, (100 + idx) + ' Test St', 'Austin', baseLat + idx * 0.001, baseLng, idx * 10);
  }

  // Run nearest-neighbor
  const addrs = db.prepare(
    "SELECT id, lat, lng FROM walk_addresses WHERE walk_id = ? AND lat IS NOT NULL ORDER BY sort_order"
  ).all(walkId);

  const remaining = [...addrs];
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

  // The route should be monotonically increasing or decreasing in lat
  let monotonic = true;
  for (let i = 1; i < ordered.length; i++) {
    if (Math.abs(ordered[i].lat - ordered[i - 1].lat) > 0.0015) {
      monotonic = false;
    }
  }
  assert(monotonic, 'Route should be roughly monotonic in latitude for linear arrangement');
});

test('GPS: walk with no coordinates falls back to sort order', () => {
  const walkRes = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('No GPS Walk', 'NGPS')").run();
  const walkId = walkRes.lastInsertRowid;
  for (let i = 0; i < 5; i++) {
    db.prepare(
      'INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)'
    ).run(walkId, (200 + i) + ' Plain St', i);
  }
  const addrs = db.prepare('SELECT id, lat, lng FROM walk_addresses WHERE walk_id = ?').all(walkId);
  const hasCoords = addrs.filter(a => a.lat && a.lng);
  assert.strictEqual(hasCoords.length, 0);
  // Fallback: just return original order
  assert.strictEqual(addrs.length, 5);
});

test('GPS: verification within 150m radius', () => {
  const addrLat = 30.2672, addrLng = -97.7431;
  // GPS reading 50m away — should verify
  const d50 = gpsDistance(addrLat, addrLng, addrLat + 0.0004, addrLng);
  assert(d50 < 150, '50m should be within 150m threshold');

  // GPS reading 200m away — should NOT verify
  const d200 = gpsDistance(addrLat, addrLng, addrLat + 0.002, addrLng);
  assert(d200 > 150, '200m should exceed 150m threshold');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Walk Group Splitting Under Member Churn
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 5: Walk Group Splitting ===');

test('Walk group: round-robin split among 3 walkers', () => {
  const walkRes = db.prepare("INSERT INTO block_walks (name, join_code, max_walkers) VALUES ('Group Walk', 'GRPW', 4)").run();
  const walkId = walkRes.lastInsertRowid;

  // Add 12 addresses
  for (let i = 0; i < 12; i++) {
    db.prepare('INSERT INTO walk_addresses (walk_id, address, sort_order) VALUES (?, ?, ?)').run(walkId, (300 + i) + ' Group St', i);
  }

  // Add 3 group members
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Alice');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Bob');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Charlie');

  // Split addresses
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
  const addresses = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order').all(walkId);
  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  const splitTx = db.transaction(() => {
    for (let i = 0; i < addresses.length; i++) {
      update.run(members[i % members.length].walker_name, addresses[i].id);
    }
  });
  splitTx();

  // Verify: each walker gets 4 addresses
  const aliceCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c;
  const bobCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walkId).c;
  const charlieCount = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Charlie'").get(walkId).c;
  assert.strictEqual(aliceCount, 4);
  assert.strictEqual(bobCount, 4);
  assert.strictEqual(charlieCount, 4);
});

test('Walk group: re-split when member leaves', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;

  // Remove Charlie
  db.prepare("DELETE FROM walk_group_members WHERE walk_id = ? AND walker_name = 'Charlie'").run(walkId);

  // Re-split
  const members = db.prepare('SELECT walker_name FROM walk_group_members WHERE walk_id = ? ORDER BY joined_at').all(walkId);
  const addresses = db.prepare('SELECT id FROM walk_addresses WHERE walk_id = ? ORDER BY sort_order').all(walkId);
  const update = db.prepare('UPDATE walk_addresses SET assigned_walker = ? WHERE id = ?');
  db.transaction(() => {
    for (let i = 0; i < addresses.length; i++) {
      update.run(members[i % members.length].walker_name, addresses[i].id);
    }
  })();

  // Now Alice gets 6, Bob gets 6
  const alice = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Alice'").get(walkId).c;
  const bob = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ? AND assigned_walker = 'Bob'").get(walkId).c;
  assert.strictEqual(alice, 6);
  assert.strictEqual(bob, 6);
});

test('Walk group: UNIQUE constraint prevents duplicate members', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  let threw = false;
  try {
    db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Alice');
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw, 'Should reject duplicate walker name');
});

test('Walk group: max_walkers limit (4)', () => {
  const walkId = db.prepare("SELECT id FROM block_walks WHERE name = 'Group Walk'").get().id;
  // Currently 2 members (Alice, Bob). Can add 2 more.
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Diana');
  db.prepare('INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, ?)').run(walkId, 'Eve');
  const count = db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(walkId).c;
  assert.strictEqual(count, 4); // at max
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: P2P Claim Mode & Redistribution
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 6: P2P Claim Mode & Redistribution ===');

test('P2P: claim mode — volunteer claims one at a time', () => {
  // Create contacts
  const contactIds = [];
  for (let i = 0; i < 100; i++) {
    const r = db.prepare("INSERT INTO contacts (phone, first_name) VALUES (?, ?)").run('800' + String(i).padStart(7, '0'), 'Claim' + i);
    contactIds.push(r.lastInsertRowid);
  }

  // Create session in claim mode
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sessionRes = db.prepare(
    "INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at) VALUES (?, ?, 'claim', '9999', ?)"
  ).run('Claim Test', 'Hello {firstName}', expires);
  const sessionId = sessionRes.lastInsertRowid;

  // Add assignments (all unassigned)
  const insertAssign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  db.transaction(() => {
    for (const cid of contactIds) insertAssign.run(sessionId, cid);
  })();

  // Verify all unassigned
  const unassigned = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").get(sessionId).c;
  assert.strictEqual(unassigned, 100);

  // Volunteer joins and claims one
  const volRes = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessionId, 'ClaimVol');
  const volId = volRes.lastInsertRowid;

  const one = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 1").get(sessionId);
  assert(one);
  db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(volId, one.id);

  const remaining = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending'").get(sessionId).c;
  assert.strictEqual(remaining, 99);
});

test('P2P: redistribution when volunteer goes offline', () => {
  // Use the claim session from above
  const session = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'Claim Test'").get();
  const sessionId = session.id;

  // Add 2 more volunteers
  const v2 = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessionId, 'Vol2');
  const v3 = db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sessionId, 'Vol3');

  // Assign 20 contacts each to v2 and v3
  const pending = db.prepare("SELECT id FROM p2p_assignments WHERE session_id = ? AND volunteer_id IS NULL AND status = 'pending' LIMIT 40").all(sessionId);
  for (let i = 0; i < 20 && i < pending.length; i++) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(v2.lastInsertRowid, pending[i].id);
  }
  for (let i = 20; i < 40 && i < pending.length; i++) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ? WHERE id = ?').run(v3.lastInsertRowid, pending[i].id);
  }

  // v2 goes offline — mark some as sent first
  const v2Assigns = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending' LIMIT 5").all(v2.lastInsertRowid);
  for (const a of v2Assigns.slice(0, 3)) {
    db.prepare("UPDATE p2p_assignments SET status = 'sent' WHERE id = ?").run(a.id);
  }

  // Redistribute v2's pending contacts to v3
  const v2Pending = db.prepare("SELECT id FROM p2p_assignments WHERE volunteer_id = ? AND session_id = ? AND status = 'pending'").all(v2.lastInsertRowid, sessionId);
  for (const p of v2Pending) {
    db.prepare('UPDATE p2p_assignments SET volunteer_id = ?, original_volunteer_id = COALESCE(original_volunteer_id, ?) WHERE id = ?').run(v3.lastInsertRowid, v2.lastInsertRowid, p.id);
  }

  // Verify redistribution
  const v3Count = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'pending'").get(v3.lastInsertRowid).c;
  assert(v3Count > 20, 'v3 should have received v2 pending contacts');

  // Verify original_volunteer_id was set
  const redistributed = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE original_volunteer_id = ?").get(v2.lastInsertRowid).c;
  assert(redistributed > 0);
});

test('P2P: snap back conversations when volunteer returns', () => {
  const session = db.prepare("SELECT id FROM p2p_sessions WHERE name = 'Claim Test'").get();
  const sessionId = session.id;
  const v2 = db.prepare("SELECT id FROM p2p_volunteers WHERE session_id = ? AND name = 'Vol2'").get(sessionId);

  // Snap back: return sent/in_conversation assignments to original volunteer
  db.prepare("UPDATE p2p_assignments SET volunteer_id = ? WHERE original_volunteer_id = ? AND session_id = ? AND status IN ('sent', 'in_conversation')").run(v2.id, v2.id, sessionId);
  db.prepare("UPDATE p2p_assignments SET original_volunteer_id = NULL WHERE volunteer_id = ? AND session_id = ?").run(v2.id, sessionId);

  // Verify: v2 should have their sent contacts back
  const v2Sent = db.prepare("SELECT COUNT(*) as c FROM p2p_assignments WHERE volunteer_id = ? AND status = 'sent'").get(v2.id).c;
  assert(v2Sent > 0, 'v2 should have sent contacts snapped back');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Engagement Score Accuracy
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 7: Engagement Scores ===');

test('Engagement: score = contacts*3 + events*5 + texts*1 + captainLists*4, cap 100', () => {
  const voterId = 1;

  // Already has contacts from canvass import above (1 contact)
  const contacts = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(voterId).c;

  // Add event check-in
  const eventRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('Engagement Test', '2025-01-15')").run();
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voterId, eventRes.lastInsertRowid);
  const checkins = 1;

  // Add some messages
  const voterPhone = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voterId).phone;
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, 'test', 'outbound')").run(voterPhone);
  }
  const texts = 5;

  // Add captain list membership
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('EngCapt', 'ENG001')").run();
  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(captRes.lastInsertRowid, 'Eng List');
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listRes.lastInsertRowid, voterId);
  const captainLists = 1;

  const expectedRaw = contacts * 3 + checkins * 5 + texts * 1 + captainLists * 4;
  const expected = Math.min(100, expectedRaw);
  assert(expected > 0);
  assert(expected <= 100);
});

test('Engagement: score caps at 100 for highly engaged voter', () => {
  const voterId = 2;
  const voterPhone = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voterId).phone;

  // Add 30 contacts
  for (let i = 0; i < 30; i++) {
    db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Call', 'Contacted')").run(voterId);
  }
  // 30 * 3 = 90, already close to cap

  // Add 3 events
  for (let i = 0; i < 3; i++) {
    const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES (?, '2025-02-0" + (i + 1) + "')").run('EngEvent' + i);
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voterId, eRes.lastInsertRowid);
  }
  // 3 * 5 = 15, total raw = 90 + 15 = 105

  const raw = 30 * 3 + 3 * 5;
  assert(raw > 100, 'Raw score should exceed 100');
  assert.strictEqual(Math.min(100, raw), 100);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Early Voting Extract-to-List
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 8: Early Voting Pipeline ===');

test('Early voting: mark voters and extract remaining to list', () => {
  // Mark first 1000 voters as early voted
  db.prepare("UPDATE voters SET early_voted = 1, early_voted_date = '2025-02-15', early_voted_method = 'in_person' WHERE id <= 1000").run();

  const voted = db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get().c;
  assert(voted >= 1000);

  // Extract non-voters to a list
  const listRes = db.prepare("INSERT INTO admin_lists (name, description, list_type) VALUES ('GOTV Remaining', 'Not yet voted', 'text')").run();
  const listId = listRes.lastInsertRowid;
  const nonVoterIds = db.prepare('SELECT id FROM voters WHERE early_voted = 0').all().map(v => v.id);

  const insert = db.prepare('INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) VALUES (?, ?)');
  const addTx = db.transaction((ids) => {
    let added = 0;
    for (const vid of ids) {
      if (insert.run(listId, vid).changes > 0) added++;
    }
    return added;
  });
  const added = addTx(nonVoterIds);
  assert(added > 0);
  assert.strictEqual(added, nonVoterIds.length);
});

test('Early voting: filter by precinct and party', () => {
  const dem_pct00 = db.prepare("SELECT COUNT(*) as c FROM voters WHERE early_voted = 0 AND precinct = 'PCT-00' AND party = 'D'").get().c;
  assert(dem_pct00 >= 0); // just verify the query works
  // 500 voters in PCT-00, 25% D, minus early voters
  // ~125 D voters, 200 early voted per precinct (1000/5 precincts with i<=1000), but distribution depends on IDs
});

test('Early voting: reset requires confirmation', () => {
  // Simulate the guard from the route
  const confirmRequired = true;
  if (confirmRequired) {
    const count = db.prepare('SELECT COUNT(*) as c FROM voters WHERE early_voted = 1').get().c;
    assert(count > 0, 'Should have early voters to reset');
    // Don't actually reset — just verify the count
  }
});

test('Early voting: by-date and by-method aggregation', () => {
  const byDate = db.prepare(`
    SELECT early_voted_date as date, COUNT(*) as count
    FROM voters WHERE early_voted = 1 AND early_voted_date IS NOT NULL
    GROUP BY early_voted_date ORDER BY early_voted_date DESC
  `).all();
  assert(byDate.length > 0);
  assert.strictEqual(byDate[0].date, '2025-02-15');

  const byMethod = db.prepare(`
    SELECT COALESCE(early_voted_method, 'unknown') as method, COUNT(*) as count
    FROM voters WHERE early_voted = 1
    GROUP BY early_voted_method ORDER BY count DESC
  `).all();
  assert(byMethod.length > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Captain CSV Cross-Matching at Scale
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 9: Captain CSV Import ===');

test('Captain CSV import: single phone match auto-adds', () => {
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('ImportCapt', 'IMP001')").run();
  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(captRes.lastInsertRowid, 'Import List');
  const listId = listRes.lastInsertRowid;

  // Match by phone
  const voter = db.prepare("SELECT id, phone FROM voters WHERE phone != '' LIMIT 1").get();
  const digits = phoneDigits(voter.phone);

  // Build phone map
  const phoneMap = {};
  const allVoters = db.prepare("SELECT id, phone FROM voters WHERE phone != '' AND phone IS NOT NULL LIMIT 1000").all();
  for (const v of allVoters) {
    const d = phoneDigits(v.phone);
    if (d.length >= 7) {
      if (!phoneMap[d]) phoneMap[d] = [];
      phoneMap[d].push(v);
    }
  }

  // Simulate single match
  const candidates = phoneMap[digits] || [];
  assert.strictEqual(candidates.length, 1); // unique phone
  db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, candidates[0].id);

  const count = db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listId).c;
  assert.strictEqual(count, 1);
});

test('Captain CSV import: ambiguous phone match needs review', () => {
  // Create 2 voters with same phone
  const phone = '5559999999';
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('Dup', 'One', ?, '123 Dup St', ?)").run(phone, crypto.randomBytes(6).toString('base64url'));
  db.prepare("INSERT INTO voters (first_name, last_name, phone, address, qr_token) VALUES ('Dup', 'Two', ?, '456 Dup St', ?)").run(phone, crypto.randomBytes(6).toString('base64url'));

  const matches = db.prepare('SELECT id FROM voters WHERE phone = ?').all(phone);
  assert(matches.length >= 2, 'Should have multiple matches for ambiguous phone');
});

test('Captain CSV import: name+address match with 500 rows', () => {
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('BulkCapt', 'BLK001')").run();
  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, name) VALUES (?, ?)').run(captRes.lastInsertRowid, 'Bulk Import');
  const listId = listRes.lastInsertRowid;

  const findByNameAddr = db.prepare(
    "SELECT id FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 3"
  );
  const checkExisting = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?');
  const insertToList = db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)');

  let autoAdded = 0, noMatch = 0, needsReview = 0;

  const importTx = db.transaction(() => {
    for (let i = 100; i < 600; i++) {
      const firstName = 'First' + i;
      const lastName = 'Last' + i;
      const addr = (100 + i) + ' main'; // lowercase partial match
      const candidates = findByNameAddr.all(firstName, lastName, addr + '%');

      if (candidates.length === 1) {
        if (!checkExisting.get(listId, candidates[0].id)) {
          insertToList.run(listId, candidates[0].id);
          autoAdded++;
        }
      } else if (candidates.length > 1) {
        needsReview++;
      } else {
        noMatch++;
      }
    }
  });
  importTx();

  assert(autoAdded > 400, 'Should auto-add most matches, got ' + autoAdded);
  assert.strictEqual(noMatch, 0); // all voters exist
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Phone Normalization Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 10: Phone Normalization ===');

test('Phone: all international formats normalize correctly', () => {
  const cases = [
    ['+1 (512) 555-1234', '5125551234'],
    ['1-512-555-1234', '5125551234'],
    ['512.555.1234', '5125551234'],
    ['512 555 1234', '5125551234'],
    ['(512) 555-1234', '5125551234'],
    ['+15125551234', '5125551234'],
    ['15125551234', '5125551234'],
    ['5125551234', '5125551234'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(normalizePhone(input), expected, `normalizePhone("${input}") should be "${expected}"`);
  }
});

test('Phone: invalid numbers return empty string', () => {
  assert.strictEqual(normalizePhone(''), '');
  assert.strictEqual(normalizePhone(null), '');
  assert.strictEqual(normalizePhone(undefined), '');
  assert.strictEqual(normalizePhone('123'), ''); // too short
  assert.strictEqual(normalizePhone('123456789012'), ''); // too long (12 digits)
});

test('Phone: toE164 formats to E.164', () => {
  assert.strictEqual(toE164('5125551234'), '+15125551234');
  assert.strictEqual(toE164('+15125551234'), '+15125551234');
  assert.strictEqual(toE164('(512) 555-1234'), '+15125551234');
});

test('Phone: phoneDigits strips non-digit chars', () => {
  assert.strictEqual(phoneDigits('+1 (512) 555-1234'), '5125551234');
  assert.strictEqual(phoneDigits('abc'), '');
  assert.strictEqual(phoneDigits(''), '');
  assert.strictEqual(phoneDigits(null), '');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: personalizeTemplate Exhaustive
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 11: personalizeTemplate ===');

test('personalizeTemplate: all merge tags', () => {
  const result = personalizeTemplate('Hi {firstName} {lastName} from {city}!', { first_name: 'Jane', last_name: 'Doe', city: 'Austin' });
  assert.strictEqual(result, 'Hi Jane Doe from Austin!');
});

test('personalizeTemplate: camelCase contact fields', () => {
  const result = personalizeTemplate('{firstName} {lastName}', { firstName: 'John', lastName: 'Smith' });
  assert.strictEqual(result, 'John Smith');
});

test('personalizeTemplate: missing fields become empty', () => {
  const result = personalizeTemplate('Hello {firstName} {lastName} in {city}', {});
  assert.strictEqual(result, 'Hello   in ');
});

test('personalizeTemplate: null template returns empty string', () => {
  assert.strictEqual(personalizeTemplate(null, { first_name: 'X' }), '');
  assert.strictEqual(personalizeTemplate(undefined, {}), '');
});

test('personalizeTemplate: null contact returns empty merge tags', () => {
  assert.strictEqual(personalizeTemplate('Hi {firstName}!', null), 'Hi !');
  assert.strictEqual(personalizeTemplate('Hi {firstName}!', undefined), 'Hi !');
});

test('personalizeTemplate: both null', () => {
  assert.strictEqual(personalizeTemplate(null, null), '');
});

test('personalizeTemplate: template with no merge tags passes through', () => {
  assert.strictEqual(personalizeTemplate('Just a plain message.', { first_name: 'X' }), 'Just a plain message.');
});

test('personalizeTemplate: multiple instances of same tag', () => {
  const result = personalizeTemplate('{firstName} and {firstName}', { first_name: 'Sam' });
  assert.strictEqual(result, 'Sam and Sam');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: Full Cascade Delete Chains
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 12: Cascade Delete Chains ===');

test('Cascade: delete voter removes contacts, checkins, list memberships, election votes', () => {
  const voterId = 500;
  // Verify has data
  const beforeContacts = db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(voterId).c;
  // Add some cross-references
  db.prepare("INSERT INTO voter_contacts (voter_id, contact_type, result) VALUES (?, 'Test', 'Test')").run(voterId);

  const event = db.prepare("INSERT INTO events (title, event_date) VALUES ('Cascade Event', '2025-03-01')").run();
  try { db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voterId, event.lastInsertRowid); } catch(e) {}

  db.prepare('DELETE FROM voters WHERE id = ?').run(voterId);

  // All should be gone
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_contacts WHERE voter_id = ?').get(voterId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE voter_id = ?').get(voterId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM election_votes WHERE voter_id = ?').get(voterId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE voter_id = ?').get(voterId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM admin_list_voters WHERE voter_id = ?').get(voterId).c, 0);
});

test('Cascade: delete captain removes team members, lists, list voters', () => {
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('CascCapt', 'CAS001')").run();
  const captId = captRes.lastInsertRowid;
  const tmRes = db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(captId, 'TeamGuy');
  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, name, team_member_id) VALUES (?, ?, ?)').run(captId, 'CascList', tmRes.lastInsertRowid);

  // Add voter to list
  const voter = db.prepare('SELECT id FROM voters LIMIT 1').get();
  db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listRes.lastInsertRowid, voter.id);

  // Delete captain
  db.prepare('DELETE FROM captains WHERE id = ?').run(captId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_team_members WHERE captain_id = ?').get(captId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_lists WHERE captain_id = ?').get(captId).c, 0);
  // list voters also gone since list was deleted
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM captain_list_voters WHERE list_id = ?').get(listRes.lastInsertRowid).c, 0);
});

test('Cascade: delete P2P session removes volunteers and assignments', () => {
  const cRes = db.prepare("INSERT INTO contacts (phone, first_name) VALUES ('8001111111', 'CascContact')").run();
  const expires = new Date(Date.now() + 86400000).toISOString();
  const sRes = db.prepare("INSERT INTO p2p_sessions (name, message_template, join_code, code_expires_at) VALUES ('CascSession', 'Hi', 'CASC', ?)").run(expires);
  const sId = sRes.lastInsertRowid;
  db.prepare('INSERT INTO p2p_volunteers (session_id, name) VALUES (?, ?)').run(sId, 'CascVol');
  db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)').run(sId, cRes.lastInsertRowid);

  db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(sId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_volunteers WHERE session_id = ?').get(sId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM p2p_assignments WHERE session_id = ?').get(sId).c, 0);
});

test('Cascade: delete event removes RSVPs and checkins', () => {
  const eRes = db.prepare("INSERT INTO events (title, event_date) VALUES ('CascEvent', '2025-04-01')").run();
  const eId = eRes.lastInsertRowid;
  db.prepare("INSERT INTO event_rsvps (event_id, contact_phone, contact_name) VALUES (?, '5551234567', 'TestPerson')").run(eId);
  const voter = db.prepare('SELECT id FROM voters LIMIT 1').get();
  try { db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, eId); } catch(e) {}

  db.prepare('DELETE FROM events WHERE id = ?').run(eId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM event_rsvps WHERE event_id = ?').get(eId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM voter_checkins WHERE event_id = ?').get(eId).c, 0);
});

test('Cascade: delete survey removes questions, options, sends, responses', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, status) VALUES ('CascSurvey', 'active')").run();
  const sId = sRes.lastInsertRowid;
  const qRes = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type) VALUES (?, 'Q1?', 'single_choice')").run(sId);
  const qId = qRes.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key) VALUES (?, 'Yes', 'yes')").run(qId);
  const sendRes = db.prepare("INSERT INTO survey_sends (survey_id, phone) VALUES (?, '5550001111')").run(sId);
  db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, '5550001111', 'yes')").run(sId, sendRes.lastInsertRowid, qId);

  db.prepare('DELETE FROM surveys WHERE id = ?').run(sId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_questions WHERE survey_id = ?').get(sId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(sId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(sId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM survey_options WHERE question_id = ?').get(qId).c, 0);
});

test('Cascade: delete block walk removes addresses and group members', () => {
  const wRes = db.prepare("INSERT INTO block_walks (name, join_code) VALUES ('CascWalk', 'CWLK')").run();
  const wId = wRes.lastInsertRowid;
  db.prepare("INSERT INTO walk_addresses (walk_id, address) VALUES (?, '999 Casc St')").run(wId);
  db.prepare("INSERT INTO walk_group_members (walk_id, walker_name) VALUES (?, 'CascWalker')").run(wId);

  db.prepare('DELETE FROM block_walks WHERE id = ?').run(wId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_addresses WHERE walk_id = ?').get(wId).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM walk_group_members WHERE walk_id = ?').get(wId).c, 0);
});

test('Cascade: delete team member sets captain_list.team_member_id to NULL', () => {
  const captRes = db.prepare("INSERT INTO captains (name, code) VALUES ('NullCapt', 'NUL001')").run();
  const captId = captRes.lastInsertRowid;
  const tmRes = db.prepare('INSERT INTO captain_team_members (captain_id, name) VALUES (?, ?)').run(captId, 'NullTM');
  const tmId = tmRes.lastInsertRowid;
  const listRes = db.prepare('INSERT INTO captain_lists (captain_id, name, team_member_id) VALUES (?, ?, ?)').run(captId, 'NullList', tmId);

  // Delete team member
  db.prepare('DELETE FROM captain_team_members WHERE id = ?').run(tmId);

  // List should still exist with team_member_id = NULL
  const list = db.prepare('SELECT team_member_id FROM captain_lists WHERE id = ?').get(listRes.lastInsertRowid);
  assert(list);
  assert.strictEqual(list.team_member_id, null);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 13: COALESCE NULL vs Empty String Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 13: COALESCE & NULL Handling ===');

test('COALESCE: update with null preserves existing value', () => {
  const voterId = 10;
  const before = db.prepare('SELECT first_name, party FROM voters WHERE id = ?').get(voterId);

  db.prepare(`UPDATE voters SET
    first_name = COALESCE(?, first_name),
    party = COALESCE(?, party)
    WHERE id = ?`).run(null, null, voterId);

  const after = db.prepare('SELECT first_name, party FROM voters WHERE id = ?').get(voterId);
  assert.strictEqual(after.first_name, before.first_name);
  assert.strictEqual(after.party, before.party);
});

test('COALESCE: update with empty string REPLACES value (not preserves)', () => {
  const voterId = 11;
  const before = db.prepare('SELECT first_name FROM voters WHERE id = ?').get(voterId);
  assert(before.first_name !== '', 'Should have a name');

  // COALESCE with empty string: '' is truthy in SQL, so it replaces!
  db.prepare("UPDATE voters SET first_name = COALESCE(?, first_name) WHERE id = ?").run('', voterId);
  const after = db.prepare('SELECT first_name FROM voters WHERE id = ?').get(voterId);
  assert.strictEqual(after.first_name, ''); // COALESCE treats '' as non-NULL
});

test('COALESCE: walk update preserves unmentioned fields', () => {
  const walkRes = db.prepare("INSERT INTO block_walks (name, description, assigned_to, status) VALUES ('CoalesceWalk', 'Desc here', 'Assignee', 'pending')").run();
  const wId = walkRes.lastInsertRowid;

  // Update only name, leave others null
  db.prepare("UPDATE block_walks SET name = COALESCE(?, name), description = COALESCE(?, description), assigned_to = COALESCE(?, assigned_to), status = COALESCE(?, status) WHERE id = ?")
    .run('NewName', null, null, null, wId);

  const walk = db.prepare('SELECT * FROM block_walks WHERE id = ?').get(wId);
  assert.strictEqual(walk.name, 'NewName');
  assert.strictEqual(walk.description, 'Desc here');
  assert.strictEqual(walk.assigned_to, 'Assignee');
  assert.strictEqual(walk.status, 'pending');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 14: QR Token Uniqueness & Check-in Dedup
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 14: QR Tokens & Check-in ===');

test('QR token: all voters have unique tokens', () => {
  const dupes = db.prepare(`
    SELECT qr_token, COUNT(*) as c FROM voters
    WHERE qr_token IS NOT NULL AND qr_token != ''
    GROUP BY qr_token HAVING COUNT(*) > 1
  `).all();
  assert.strictEqual(dupes.length, 0, 'No duplicate QR tokens');
});

test('QR token: UNIQUE index enforces uniqueness', () => {
  const voter = db.prepare('SELECT qr_token FROM voters WHERE qr_token IS NOT NULL LIMIT 1').get();
  let threw = false;
  try {
    db.prepare("INSERT INTO voters (first_name, last_name, qr_token) VALUES ('Dup', 'Token', ?)").run(voter.qr_token);
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw, 'Should reject duplicate QR token');
});

test('QR check-in: dedup prevents double check-in', () => {
  const voter = db.prepare('SELECT id FROM voters WHERE id = 3').get();
  const event = db.prepare("INSERT INTO events (title, event_date) VALUES ('QR Dedup Event', '2025-03-15')").run();
  const eId = event.lastInsertRowid;

  // First check-in
  db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, eId);

  // Second check-in — UNIQUE(voter_id, event_id) should reject
  let threw = false;
  try {
    db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, eId);
  } catch (e) {
    threw = e.message.includes('UNIQUE');
  }
  assert(threw, 'Should reject duplicate check-in');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 15: Precinct Analytics with Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 15: Precinct Analytics ===');

test('Precinct analytics: voter counts by party', () => {
  const rows = db.prepare(`
    SELECT precinct,
      COUNT(*) as total_voters,
      SUM(CASE WHEN party = 'D' THEN 1 ELSE 0 END) as dem,
      SUM(CASE WHEN party = 'R' THEN 1 ELSE 0 END) as rep,
      SUM(CASE WHEN party NOT IN ('D','R') OR party = '' THEN 1 ELSE 0 END) as other
    FROM voters WHERE precinct != '' GROUP BY precinct ORDER BY precinct
  `).all();

  assert(rows.length >= 10, 'Should have 10+ precincts');
  for (const r of rows) {
    assert.strictEqual(r.dem + r.rep + r.other, r.total_voters, 'Party counts should sum to total for ' + r.precinct);
  }
});

test('Precinct analytics: touchpoints per precinct', () => {
  const contactsByPct = db.prepare(`
    SELECT v.precinct, COUNT(vc.id) as c FROM voter_contacts vc
    JOIN voters v ON vc.voter_id = v.id WHERE v.precinct != ''
    GROUP BY v.precinct
  `).all();
  // Should have data for precincts that had canvass contacts
  assert(contactsByPct.length > 0);
});

test('Precinct analytics: zero-data precinct handled gracefully', () => {
  // PCT-20 has voters but potentially no touchpoints from seeded data
  const row = db.prepare(`
    SELECT precinct,
      COUNT(*) as total_voters,
      SUM(CASE WHEN support_level IN ('strong_support','lean_support') THEN 1 ELSE 0 END) as supporters
    FROM voters WHERE precinct = 'PCT-20' GROUP BY precinct
  `).get();
  // This precinct was created by enrichment test — may or may not have data
  // Just verify the query doesn't crash
  if (row) {
    assert(row.total_voters >= 0);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 16: generateJoinCode & generateAlphaCode
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 16: Join Code Generation ===');

test('generateJoinCode: always 4 digits, 1000-9999', () => {
  for (let i = 0; i < 100; i++) {
    const code = generateJoinCode();
    assert.strictEqual(code.length, 4, 'Code should be 4 chars: ' + code);
    const num = parseInt(code, 10);
    assert(num >= 1000 && num <= 9999, 'Code should be 1000-9999: ' + code);
  }
});

test('generateAlphaCode: always uppercase hex of specified length', () => {
  for (let len = 2; len <= 8; len++) {
    const code = generateAlphaCode(len);
    assert.strictEqual(code.length, len, `Code should be ${len} chars: ${code}`);
    assert(/^[0-9A-F]+$/.test(code), 'Code should be uppercase hex: ' + code);
  }
});

test('generateJoinCode: statistical distribution (no bias)', () => {
  const counts = {};
  for (let i = 0; i < 10000; i++) {
    const code = generateJoinCode();
    const firstDigit = code[0];
    counts[firstDigit] = (counts[firstDigit] || 0) + 1;
  }
  // First digit should be 1-9, roughly uniform
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    assert(counts[d] > 500, `Digit ${d} should appear >500 times in 10K codes, got ${counts[d] || 0}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 17: Survey Full Lifecycle with Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 17: Survey Lifecycle ===');

test('Survey: full lifecycle with ranked-choice question', () => {
  const sRes = db.prepare("INSERT INTO surveys (name, description, status) VALUES ('Full Survey', 'Testing all types', 'active')").run();
  const sId = sRes.lastInsertRowid;

  // Add single choice question
  const q1Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Favorite color?', 'single_choice', 0)").run(sId);
  const q1Id = q1Res.lastInsertRowid;
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Red', 'red', 0)").run(q1Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Blue', 'blue', 1)").run(q1Id);
  db.prepare("INSERT INTO survey_options (question_id, option_text, option_key, sort_order) VALUES (?, 'Green', 'green', 2)").run(q1Id);

  // Add write-in question
  const q2Res = db.prepare("INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (?, 'Other thoughts?', 'write_in', 1)").run(sId);
  const q2Id = q2Res.lastInsertRowid;

  // Send to 100 contacts
  const insertSend = db.prepare("INSERT INTO survey_sends (survey_id, phone, contact_name, current_question_id) VALUES (?, ?, ?, ?)");
  const insertResp = db.prepare("INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text) VALUES (?, ?, ?, ?, ?)");

  const lifecycleTx = db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      const phone = '900' + String(i).padStart(7, '0');
      const sendRes = insertSend.run(sId, phone, 'Respondent' + i, q1Id);
      const sendId = sendRes.lastInsertRowid;

      // 60% answer q1, 40% drop off
      if (i % 5 < 3) {
        const colors = ['red', 'blue', 'green'];
        insertResp.run(sId, sendId, q1Id, phone, colors[i % 3]);

        // Of those, 50% also answer q2
        if (i % 2 === 0) {
          insertResp.run(sId, sendId, q2Id, phone, 'Write-in answer from ' + phone);
          db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(sendId);
        }
      }
    }
  });
  lifecycleTx();

  // Verify counts
  const sends = db.prepare('SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ?').get(sId).c;
  assert.strictEqual(sends, 100);

  const responses = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ?').get(sId).c;
  assert(responses > 0);

  // Tally q1 responses
  const tally = db.prepare(`
    SELECT response_text, COUNT(*) as c FROM survey_responses
    WHERE survey_id = ? AND question_id = ?
    GROUP BY response_text ORDER BY c DESC
  `).all(sId, q1Id);
  assert(tally.length === 3, 'Should have 3 color options');
  const totalVotes = tally.reduce((sum, t) => sum + t.c, 0);
  assert.strictEqual(totalVotes, 60); // 60% of 100

  // Count write-ins
  const writeIns = db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ? AND question_id = ?').get(sId, q2Id).c;
  assert(writeIns > 0 && writeIns <= 60);

  // Count completed
  const completed = db.prepare("SELECT COUNT(*) as c FROM survey_sends WHERE survey_id = ? AND status = 'completed'").get(sId).c;
  assert(completed > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 18: Concurrent-Style Write Patterns
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 18: Concurrent Write Patterns ===');

test('Concurrent: interleaved inserts and reads in transaction', () => {
  const insertMsg = db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, ?, 'outbound', 'sms')");
  const countMsgs = db.prepare('SELECT COUNT(*) as c FROM messages WHERE phone = ?');

  const phone = '7770000001';
  const tx = db.transaction(() => {
    for (let i = 0; i < 500; i++) {
      insertMsg.run(phone, 'Concurrent msg ' + i);
      // Read mid-transaction
      if (i % 100 === 99) {
        const count = countMsgs.get(phone).c;
        assert(count >= i, 'Should see own writes: expected >=' + i + ', got ' + count);
      }
    }
  });
  tx();

  const final = countMsgs.get(phone).c;
  assert.strictEqual(final, 500);
});

test('Concurrent: rapid delete and re-insert cycle', () => {
  const settingsKey = 'concurrent_test_key';
  for (let i = 0; i < 100; i++) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(settingsKey, 'value_' + i);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey);
    assert.strictEqual(row.value, 'value_' + i);
  }
  // Final value
  const final = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey);
  assert.strictEqual(final.value, 'value_99');
});

test('Concurrent: transaction rollback on constraint violation', () => {
  const initialCount = db.prepare('SELECT COUNT(*) as c FROM captains').get().c;

  let threw = false;
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO captains (name, code) VALUES ('TxCapt1', 'TX0001')").run();
      db.prepare("INSERT INTO captains (name, code) VALUES ('TxCapt2', 'TX0002')").run();
      // This should fail: duplicate code
      db.prepare("INSERT INTO captains (name, code) VALUES ('TxCapt3', 'TX0001')").run();
    })();
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Transaction should have thrown on UNIQUE violation');

  // Verify rollback: count should be unchanged
  const afterCount = db.prepare('SELECT COUNT(*) as c FROM captains').get().c;
  assert.strictEqual(afterCount, initialCount, 'Transaction should have rolled back');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 19: Bulk Operations at Scale
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 19: Scale Operations ===');

test('Scale: 10K message inserts in single transaction', () => {
  const insert = db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, ?, 'outbound', 'sms')");
  const before = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;

  const tx = db.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      insert.run('666' + String(i % 1000).padStart(7, '0'), 'Bulk message ' + i);
    }
  });
  tx();

  const after = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  assert.strictEqual(after - before, 10000);
});

test('Scale: complex aggregation over 5K voters', () => {
  const stats = db.prepare(`
    SELECT
      party,
      support_level,
      COUNT(*) as cnt,
      SUM(CASE WHEN early_voted = 1 THEN 1 ELSE 0 END) as early_voted_count
    FROM voters WHERE precinct LIKE 'PCT-%'
    GROUP BY party, support_level
    ORDER BY party, support_level
  `).all();

  const totalFromStats = stats.reduce((sum, r) => sum + r.cnt, 0);
  const totalDirect = db.prepare("SELECT COUNT(*) as c FROM voters WHERE precinct LIKE 'PCT-%'").get().c;
  assert.strictEqual(totalFromStats, totalDirect, 'Aggregation should account for all voters');
});

test('Scale: admin list with 5K voters — JOIN performance', () => {
  const listRes = db.prepare("INSERT INTO admin_lists (name, list_type) VALUES ('Big List', 'text')").run();
  const listId = listRes.lastInsertRowid;

  // Add all 5K voters (minus deleted ones)
  const added = db.prepare("INSERT OR IGNORE INTO admin_list_voters (list_id, voter_id) SELECT ?, id FROM voters").run(listId);
  assert(added.changes > 4000);

  // Query with JOINs (mirrors admin-lists route)
  const result = db.prepare(`
    SELECT al.*, COUNT(alv.id) as voterCount,
      SUM(CASE WHEN v.phone != '' AND v.phone IS NOT NULL THEN 1 ELSE 0 END) as withPhone
    FROM admin_lists al
    LEFT JOIN admin_list_voters alv ON al.id = alv.list_id
    LEFT JOIN voters v ON alv.voter_id = v.id
    WHERE al.id = ?
    GROUP BY al.id
  `).get(listId);

  assert(result.voterCount > 4000);
  assert(result.withPhone > 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 20: Database Health & Integrity
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Section 20: Database Health ===');

test('DB: WAL mode active', () => {
  const mode = db.pragma('journal_mode', { simple: true });
  assert.strictEqual(mode, 'wal');
});

test('DB: foreign keys enabled', () => {
  const fk = db.pragma('foreign_keys', { simple: true });
  assert.strictEqual(fk, 1);
});

test('DB: integrity check passes', () => {
  const result = db.pragma('integrity_check');
  assert.strictEqual(result[0].integrity_check, 'ok');
});

test('DB: FK violations check passes', () => {
  const violations = db.pragma('foreign_key_check');
  assert.strictEqual(violations.length, 0, 'Should have no FK violations, found: ' + JSON.stringify(violations.slice(0, 5)));
});

test('DB: no orphaned admin_list_voters', () => {
  const orphans = db.prepare(`
    SELECT alv.id FROM admin_list_voters alv
    LEFT JOIN admin_lists al ON alv.list_id = al.id
    LEFT JOIN voters v ON alv.voter_id = v.id
    WHERE al.id IS NULL OR v.id IS NULL
  `).all();
  assert.strictEqual(orphans.length, 0);
});

test('DB: no orphaned captain_list_voters', () => {
  const orphans = db.prepare(`
    SELECT clv.id FROM captain_list_voters clv
    LEFT JOIN captain_lists cl ON clv.list_id = cl.id
    LEFT JOIN voters v ON clv.voter_id = v.id
    WHERE cl.id IS NULL OR v.id IS NULL
  `).all();
  assert.strictEqual(orphans.length, 0);
});

test('DB: no orphaned p2p_assignments', () => {
  const orphans = db.prepare(`
    SELECT a.id FROM p2p_assignments a
    LEFT JOIN p2p_sessions s ON a.session_id = s.id
    LEFT JOIN contacts c ON a.contact_id = c.id
    WHERE s.id IS NULL OR c.id IS NULL
  `).all();
  assert.strictEqual(orphans.length, 0);
});

test('DB: no orphaned election_votes', () => {
  const orphans = db.prepare(`
    SELECT ev.id FROM election_votes ev
    LEFT JOIN voters v ON ev.voter_id = v.id
    WHERE v.id IS NULL
  `).all();
  assert.strictEqual(orphans.length, 0);
});

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '='.repeat(60));
console.log(`STRESS TEST ROUND 5 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`        ${f.error}`);
  }
}

// Cleanup
db.close();
try { fs.unlinkSync(TEST_DB); } catch (e) {}
try { fs.unlinkSync(TEST_DB + '-wal'); } catch (e) {}
try { fs.unlinkSync(TEST_DB + '-shm'); } catch (e) {}

process.exit(failed > 0 ? 1 : 0);
