const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Try writable directories in order: DATABASE_DIR env, /data (cloud volume mount), ./data (local dev)
function findWritableDir() {
  const candidates = [
    process.env.DATABASE_DIR,
    '/data',
    path.join(__dirname, 'data')
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Test write access
      const testFile = path.join(dir, '.write-test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      console.log('Using database directory:', dir);
      return dir;
    } catch (e) {
      console.log('Directory not writable:', dir, e.message);
    }
  }
  throw new Error('No writable directory found for SQLite database');
}

const dataDir = findWritableDir();
const dbPath = path.join(dataDir, 'campaign.db');
const dbExisted = fs.existsSync(dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (!dbExisted) {
  console.warn('WARNING: Database was created fresh — previous data was lost.');
  console.warn('  If on Railway, ensure a Volume is mounted at /data to persist data across deploys.');
}

// --- Migrated tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    city TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL,
    body TEXT,
    direction TEXT DEFAULT 'inbound',
    timestamp TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);

  CREATE TABLE IF NOT EXISTS opt_outs (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    opted_out_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

`);

// --- Block Walk tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS block_walks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS walk_addresses (
    id INTEGER PRIMARY KEY,
    walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    unit TEXT DEFAULT '',
    city TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    voter_name TEXT DEFAULT '',
    result TEXT DEFAULT 'not_visited',
    notes TEXT DEFAULT '',
    knocked_at TEXT,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_walk_addr_walk ON walk_addresses(walk_id);
`);

// Safe column migration helper — only ignores "duplicate column" errors
function addColumn(sql) {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
}

// GPS verification columns for walk addresses
addColumn("ALTER TABLE walk_addresses ADD COLUMN voter_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN lat REAL DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN lng REAL DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN gps_lat REAL DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN gps_lng REAL DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN gps_accuracy REAL DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN gps_verified INTEGER DEFAULT 0");

// --- Voter File tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS voters (
    id INTEGER PRIMARY KEY,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    party TEXT DEFAULT '',
    support_level TEXT DEFAULT 'unknown',
    voter_score INTEGER DEFAULT 0,
    tags TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_voters_name ON voters(last_name, first_name);
  CREATE INDEX IF NOT EXISTS idx_voters_phone ON voters(phone);

  CREATE TABLE IF NOT EXISTS voter_contacts (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    contact_type TEXT NOT NULL,
    result TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    contacted_by TEXT DEFAULT '',
    contacted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vc_voter ON voter_contacts(voter_id);
`);

// --- Event tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    event_date TEXT NOT NULL,
    event_time TEXT DEFAULT '',
    status TEXT DEFAULT 'upcoming',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS event_rsvps (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    rsvp_status TEXT DEFAULT 'invited',
    invited_at TEXT DEFAULT (datetime('now')),
    responded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rsvps_event ON event_rsvps(event_id);
`);
// Prevent duplicate RSVPs for same contact+event
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvps_event_phone ON event_rsvps(event_id, contact_phone)"); } catch (e) { /* duplicates may exist */ }

// --- Phase 2 migrations ---

// Sentiment column on messages
addColumn("ALTER TABLE messages ADD COLUMN sentiment TEXT DEFAULT NULL");

// Check-in timestamp on event RSVPs
addColumn("ALTER TABLE event_rsvps ADD COLUMN checked_in_at TEXT DEFAULT NULL");

// Voter registration number
addColumn("ALTER TABLE voters ADD COLUMN registration_number TEXT DEFAULT ''");

// --- Phase 3: P2P Texting tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS p2p_sessions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    message_template TEXT NOT NULL,
    assignment_mode TEXT DEFAULT 'auto_split',
    join_code TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    code_expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_sessions_code ON p2p_sessions(join_code);

  CREATE TABLE IF NOT EXISTS p2p_volunteers (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_online INTEGER DEFAULT 1,
    joined_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_vol_session ON p2p_volunteers(session_id);

  CREATE TABLE IF NOT EXISTS p2p_assignments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
    volunteer_id INTEGER REFERENCES p2p_volunteers(id),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    status TEXT DEFAULT 'pending',
    original_volunteer_id INTEGER DEFAULT NULL,
    assigned_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_assign_vol ON p2p_assignments(volunteer_id);
  CREATE INDEX IF NOT EXISTS idx_p2p_assign_session ON p2p_assignments(session_id);
  CREATE INDEX IF NOT EXISTS idx_p2p_assign_contact ON p2p_assignments(contact_id);

  CREATE TABLE IF NOT EXISTS campaign_knowledge (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS response_scripts (
    id INTEGER PRIMARY KEY,
    scenario TEXT NOT NULL,
    label TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// --- Phase 3: Event flyer image for QR overlay ---
addColumn("ALTER TABLE events ADD COLUMN flyer_image TEXT DEFAULT NULL");

// --- Phase 4: Geofenced event check-in ---
addColumn("ALTER TABLE events ADD COLUMN latitude REAL DEFAULT NULL");
addColumn("ALTER TABLE events ADD COLUMN longitude REAL DEFAULT NULL");
addColumn("ALTER TABLE events ADD COLUMN checkin_radius INTEGER DEFAULT 500");
addColumn("ALTER TABLE events ADD COLUMN event_end_time TEXT DEFAULT ''");
addColumn("ALTER TABLE events ADD COLUMN mms_project_id TEXT DEFAULT NULL");
addColumn("ALTER TABLE events ADD COLUMN event_end_date TEXT DEFAULT ''");

// Session type for P2P sessions (campaign, event, survey)
addColumn("ALTER TABLE p2p_sessions ADD COLUMN session_type TEXT DEFAULT 'campaign'");
addColumn("ALTER TABLE p2p_sessions ADD COLUMN media_url TEXT DEFAULT NULL");
addColumn("ALTER TABLE p2p_sessions ADD COLUMN rumbleup_action_id TEXT DEFAULT NULL");
addColumn("ALTER TABLE p2p_sessions ADD COLUMN source_id INTEGER DEFAULT NULL");

// P2P columns on messages
addColumn("ALTER TABLE messages ADD COLUMN session_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE messages ADD COLUMN volunteer_name TEXT DEFAULT NULL");

// --- Per-voter QR code check-in ---

// Unique QR token per voter (short random string used in check-in URLs)
addColumn("ALTER TABLE voters ADD COLUMN qr_token TEXT DEFAULT NULL");
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_voters_qr_token ON voters(qr_token)"); } catch (e) { /* already exists */ }

// Track voter check-ins at events (separate from event_rsvps which is contact-based)
db.exec(`
  CREATE TABLE IF NOT EXISTS voter_checkins (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    checked_in_at TEXT DEFAULT (datetime('now')),
    UNIQUE(voter_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vcheckin_voter ON voter_checkins(voter_id);
  CREATE INDEX IF NOT EXISTS idx_vcheckin_event ON voter_checkins(event_id);
`);

// --- Block Captain tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS captains (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_captains_code ON captains(code);

  CREATE TABLE IF NOT EXISTS captain_team_members (
    id INTEGER PRIMARY KEY,
    captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ctm_captain ON captain_team_members(captain_id);

  CREATE TABLE IF NOT EXISTS captain_lists (
    id INTEGER PRIMARY KEY,
    captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    team_member_id INTEGER REFERENCES captain_team_members(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cl_captain ON captain_lists(captain_id);

  CREATE TABLE IF NOT EXISTS captain_list_voters (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES captain_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(list_id, voter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_clv_list ON captain_list_voters(list_id);
  CREATE INDEX IF NOT EXISTS idx_clv_voter ON captain_list_voters(voter_id);
`);

// Voting history on voters (populated via CSV import)
addColumn("ALTER TABLE voters ADD COLUMN voting_history TEXT DEFAULT ''");

// Precinct / district for geographic targeting
addColumn("ALTER TABLE voters ADD COLUMN precinct TEXT DEFAULT ''");

// Email column on contacts (for mass email feature)
addColumn("ALTER TABLE contacts ADD COLUMN email TEXT DEFAULT ''");

// Email campaigns tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS email_campaigns (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Admin lists (not tied to a captain)
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admin_list_voters (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES admin_lists(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(list_id, voter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_alv_list ON admin_list_voters(list_id);
  CREATE INDEX IF NOT EXISTS idx_alv_voter ON admin_list_voters(voter_id);
`);

// List type columns for purpose tagging (event, text, survey, block_walk, general)
addColumn("ALTER TABLE admin_lists ADD COLUMN list_type TEXT DEFAULT 'general'");
addColumn("ALTER TABLE captain_lists ADD COLUMN list_type TEXT DEFAULT 'general'");

// Admin list can be assigned to a captain — captain can then add voters to it
addColumn("ALTER TABLE admin_lists ADD COLUMN assigned_captain_id INTEGER DEFAULT NULL");

// Block walking group mode — up to 4 walkers per group
addColumn("ALTER TABLE block_walks ADD COLUMN join_code TEXT DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN max_walkers INTEGER DEFAULT 4");
db.exec(`
  CREATE TABLE IF NOT EXISTS walk_group_members (
    id INTEGER PRIMARY KEY,
    walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    walker_name TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(walk_id, walker_name)
  );
  CREATE INDEX IF NOT EXISTS idx_wgm_walk ON walk_group_members(walk_id);
`);
addColumn("ALTER TABLE walk_group_members ADD COLUMN phone TEXT DEFAULT NULL");
// Assigned walker on each address (for group splitting)
addColumn("ALTER TABLE walk_addresses ADD COLUMN assigned_walker TEXT DEFAULT NULL");

// Real-time walker GPS locations for live map tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS walker_locations (
    id INTEGER PRIMARY KEY,
    walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    walker_name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy REAL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(walk_id, walker_name)
  );
  CREATE INDEX IF NOT EXISTS idx_walker_loc_walk ON walker_locations(walk_id);
`);

// --- Early Voting tracking ---
addColumn("ALTER TABLE voters ADD COLUMN early_voted INTEGER DEFAULT 0");
addColumn("ALTER TABLE voters ADD COLUMN early_voted_date TEXT DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN early_voted_method TEXT DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN early_voted_ballot TEXT DEFAULT NULL");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_early_voted ON voters(early_voted)"); } catch (e) { /* exists */ }

// Additional voter fields for registered voter file imports
addColumn("ALTER TABLE voters ADD COLUMN middle_name TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN state TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN secondary_phone TEXT DEFAULT ''");

// --- Twilio phone validation columns ---
addColumn("ALTER TABLE voters ADD COLUMN phone_type TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN phone_carrier TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN phone_validated_at TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN secondary_phone_type TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN secondary_phone_carrier TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN secondary_phone_validated_at TEXT DEFAULT ''");

// County voter file fields (VAN exports, county file imports)
addColumn("ALTER TABLE voters ADD COLUMN county_file_id TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN vanid TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN suffix TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN zip4 TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN address_id TEXT DEFAULT ''");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_vanid ON voters(vanid)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_county_file_id ON voters(county_file_id)"); } catch (e) { /* exists */ }

// State File ID (the voter's unique ID from the county/state voter file)
addColumn("ALTER TABLE voters ADD COLUMN state_file_id TEXT DEFAULT ''");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_state_file_id ON voters(state_file_id)"); } catch (e) { /* exists */ }

// --- Voter demographics & district assignments (from county voter file) ---
addColumn("ALTER TABLE voters ADD COLUMN gender TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN age INTEGER DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN county_commissioner TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN justice_of_peace TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN state_board_ed TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN state_rep TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN state_senate TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN us_congress TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN city_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN school_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN college_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN hospital_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN navigation_port TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN port_authority TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN voter_status TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN party_score TEXT DEFAULT ''");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_party_score ON voters(party_score)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_gender ON voters(gender)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_state_rep ON voters(state_rep)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_us_congress ON voters(us_congress)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_school_district ON voters(school_district)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voters_port_authority ON voters(port_authority)"); } catch (e) { /* exists */ }

// --- Users table (authentication) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );
`);

// --- Sessions table (express-session store) ---
// better-sqlite3-session-store expects column "expire" — fix old schema if needed
try {
  db.prepare("SELECT expire FROM sessions LIMIT 1").get();
} catch (e) {
  // Drop and recreate with correct schema (sessions are ephemeral)
  db.exec("DROP TABLE IF EXISTS sessions");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`);

// Backfill QR tokens for any existing voters that don't have one
const { randomBytes } = require('crypto');
function generateQrToken() {
  return randomBytes(6).toString('base64url');
}
const votersWithoutToken = db.prepare("SELECT id FROM voters WHERE qr_token IS NULL OR qr_token = ''").all();
if (votersWithoutToken.length > 0) {
  const updateToken = db.prepare("UPDATE voters SET qr_token = ? WHERE id = ?");
  const backfill = db.transaction(() => {
    for (const v of votersWithoutToken) {
      updateToken.run(generateQrToken(), v.id);
    }
  });
  backfill();
  console.log(`Backfilled QR tokens for ${votersWithoutToken.length} voters`);
}

// --- Polls & Surveys tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS survey_questions (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT 'single_choice',
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sq_survey ON survey_questions(survey_id);

  CREATE TABLE IF NOT EXISTS survey_options (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    option_key TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_so_question ON survey_options(question_id);

  CREATE TABLE IF NOT EXISTS survey_sends (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    status TEXT DEFAULT 'sent',
    current_question_id INTEGER DEFAULT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ss_survey ON survey_sends(survey_id);
  CREATE INDEX IF NOT EXISTS idx_ss_phone ON survey_sends(phone);

  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    send_id INTEGER NOT NULL REFERENCES survey_sends(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    response_text TEXT NOT NULL,
    option_id INTEGER DEFAULT NULL,
    responded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sr_survey ON survey_responses(survey_id);
  CREATE INDEX IF NOT EXISTS idx_sr_question ON survey_responses(question_id);
  CREATE INDEX IF NOT EXISTS idx_sr_send ON survey_responses(send_id);
`);

// --- Election Votes table (voter participation in specific elections) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS election_votes (
    id INTEGER PRIMARY KEY,
    voter_id INTEGER NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    election_name TEXT NOT NULL,
    election_date TEXT NOT NULL,
    election_type TEXT DEFAULT 'general',
    election_cycle TEXT DEFAULT '',
    voted INTEGER DEFAULT 1,
    UNIQUE(voter_id, election_name)
  );
  CREATE INDEX IF NOT EXISTS idx_ev_voter ON election_votes(voter_id);
  CREATE INDEX IF NOT EXISTS idx_ev_election ON election_votes(election_name);
  CREATE INDEX IF NOT EXISTS idx_ev_date ON election_votes(election_date);
  CREATE INDEX IF NOT EXISTS idx_ev_cycle ON election_votes(election_cycle);
  CREATE INDEX IF NOT EXISTS idx_ev_type ON election_votes(election_type);
`);

// Party voted column on election_votes (R = Republican, D = Democrat, blank = no party / nonpartisan)
addColumn("ALTER TABLE election_votes ADD COLUMN party_voted TEXT DEFAULT ''");

// Vote method — how they voted: early, mail, election_day, provisional
addColumn("ALTER TABLE election_votes ADD COLUMN vote_method TEXT DEFAULT ''");

// Voter status (ACTIVE, SUSPENSE, etc.), navigation district, and unit
addColumn("ALTER TABLE voters ADD COLUMN voter_status TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN navigation_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN unit TEXT DEFAULT ''");

// One-time cleanup: remove voters not in the county file (never updated by Cameron County import)
// Voters updated by the import have voter_status = 'ACTIVE' or 'SUSPENSE'
// Voters NOT updated still have voter_status = '' — they're no longer registered
try {
  const notUpdated = db.prepare("SELECT COUNT(*) as c FROM voters WHERE voter_status = '' AND registration_number != '' AND registration_number IS NOT NULL").get();
  if (notUpdated.c > 0 && notUpdated.c < 100000) {
    const result = db.prepare("DELETE FROM voters WHERE voter_status = '' AND registration_number != '' AND registration_number IS NOT NULL").run();
    console.log('[cleanup] Removed', result.changes, 'voters not in county file (no voter_status after import)');
  } else if (notUpdated.c >= 100000) {
    console.log('[cleanup] Skipped — too many voters without status (' + notUpdated.c + '), import may not have completed');
  }
} catch (e) { /* ignore */ }

// Heavy migrations — run after server starts to avoid health check timeout
setTimeout(() => {
  // Remove ghost voter records (empty registration_number + empty name)
  try {
    const ghosts = db.prepare("DELETE FROM voters WHERE (registration_number IS NULL OR registration_number = '') AND (first_name IS NULL OR TRIM(first_name) = '') AND (last_name IS NULL OR TRIM(last_name) = '')").run();
    if (ghosts.changes > 0) console.log('[cleanup] Removed', ghosts.changes, 'ghost voter records');
  } catch (e) { /* ignore */ }

  // Backfill unit data on walk_addresses from voter file
  try {
    const missingUnits = db.prepare(`
      SELECT wa.id, v.unit FROM walk_addresses wa
      JOIN voters v ON wa.voter_id = v.id
      WHERE (wa.unit IS NULL OR wa.unit = '') AND v.unit != '' AND v.unit IS NOT NULL
    `).all();
    if (missingUnits.length > 0) {
      const updateUnit = db.prepare('UPDATE walk_addresses SET unit = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const r of missingUnits) updateUnit.run(r.unit, r.id);
      });
      tx();
      console.log('[migrate] Backfilled unit data on', missingUnits.length, 'walk addresses');
    }
  } catch (e) { /* ignore */ }

  // Clean up orphaned election_votes records where voter was deleted
  try {
    const orphaned = db.prepare("SELECT COUNT(*) as c FROM election_votes WHERE voter_id NOT IN (SELECT id FROM voters)").get();
    if (orphaned.c > 0) {
      const del = db.prepare("DELETE FROM election_votes WHERE voter_id NOT IN (SELECT id FROM voters)").run();
      console.log('[cleanup] Removed', del.changes, 'orphaned election records from deleted voters');
    }
  } catch (e) { /* ignore */ }
}, 10000); // run 10s after startup

// --- Fix election name duplicates from Cameron County import ---
// Run after server starts to avoid health check timeout
setTimeout(() => {
try {
  const renames = {
    // Fix 3-digit codes that were parsed as "Local May XXX"
    'Local May 619': 'Local Jun 2019', 'Local May 618': 'Local Jun 2018', 'Local May 616': 'Local Jun 2016',
    'Local May 621': 'Local Jun 2021', 'Local May 623': 'Local Jun 2023',
    'Local May 525': 'Local May 2025', 'Local May 524': 'Local May 2024', 'Local May 523': 'Local May 2023',
    'Local May 522': 'Local May 2022', 'Local May 521': 'Local May 2021',
    'Local May 519': 'Local May 2019', 'Local May 518': 'Local May 2018',
    'Local May 517': 'Local May 2017', 'Local May 516': 'Local May 2016',
    // Fix R6XX codes — Runoff Jun
    'R625': 'Runoff Jun 2025', 'R624': 'Runoff Jun 2024', 'R622': 'Runoff Jun 2022',
    // Fix other bad codes
    'Special 2034': 'Special 2034', // keep as-is, might be a real code
    'SPI24': 'Special Election SPI 2024',
    'CDD5': 'Drainage District Election',
  };
  // Merge duplicates: keep shorter canonical name
  const merges = {
    'Primary Mar 2024': 'Primary 2024', 'Primary Mar 2022': 'Primary 2022',
    'Primary Mar 2020': 'Primary 2020', 'Primary Mar 2018': 'Primary 2018',
    'Primary Mar 2016': 'Primary 2016',
    'Primary Runoff May 2024': 'Primary Runoff 2024', 'Primary Runoff May 2022': 'Primary Runoff 2022',
    'Primary Runoff May 2018': 'Primary Runoff 2018',
    'Primary Runoff Jul 2020': 'Primary Runoff 2020',
    'General Nov 2024': 'General 2024', 'General Nov 2022': 'General 2022',
    'General Nov 2020': 'General 2020', 'General Nov 2018': 'General 2018',
    'General Nov 2016': 'General 2016',
    'General Runoff 2024': 'General Runoff 2024',
    'General Runoff 2020': 'General Runoff 2020',
    'Local Jun 2023': 'Local Jun 2023', 'Local Jun 2021': 'Local Jun 2021',
    'Local Jun 2019': 'Local Jun 2019', 'Local Jun 2018': 'Local Jun 2018',
    'Local Jun 2016': 'Local Jun 2016',
  };
  const allRenames = { ...renames, ...merges };
  let renamed = 0;
  for (const [old, newName] of Object.entries(allRenames)) {
    if (old === newName) continue;
    // Step 1: Delete old-name records where voter already exists under new name
    db.prepare('DELETE FROM election_votes WHERE election_name = ? AND voter_id IN (SELECT voter_id FROM election_votes WHERE election_name = ?)').run(old, newName);
    // Step 2: Rename remaining old-name records to new name
    const r = db.prepare('UPDATE election_votes SET election_name = ? WHERE election_name = ?').run(newName, old);
    if (r.changes > 0) renamed += r.changes;
    // Step 3: Force delete any remaining old-name records (stragglers)
    db.prepare('DELETE FROM election_votes WHERE election_name = ?').run(old);
    db.prepare('DELETE FROM elections WHERE election_name = ?').run(old);
  }
  if (renamed > 0) console.log('[migrate] Renamed', renamed, 'election records');
  // Remove all election definitions with no matching vote records
  const emptyElecs = db.prepare(`
    SELECT election_name FROM elections
    WHERE election_name NOT IN (SELECT DISTINCT election_name FROM election_votes)
  `).all();
  if (emptyElecs.length > 0) {
    const del = db.prepare('DELETE FROM elections WHERE election_name = ?');
    for (const e of emptyElecs) del.run(e.election_name);
    console.log('[migrate] Removed', emptyElecs.length, 'empty election definitions');
  }
  // Remove election_votes with 0 voters (orphans)
  const orphanElecs = db.prepare(`
    SELECT DISTINCT election_name FROM election_votes
    GROUP BY election_name HAVING COUNT(*) = 0
  `).all();
  for (const e of orphanElecs) db.prepare('DELETE FROM election_votes WHERE election_name = ?').run(e.election_name);
  console.log('[migrate] Election cleanup complete');

  // Check for empty columns
  const colsToCheck = [
    'email','state','secondary_phone','phone_type','phone_carrier','phone_validated_at',
    'secondary_phone_type','secondary_phone_carrier','secondary_phone_validated_at',
    'county_file_id','vanid','suffix','zip4','address_id','state_file_id',
    'voting_history','early_voted_ballot','middle_name','qr_token',
    'unit','unit_type','voter_status','navigation_district',
    'court_of_appeals','municipal_utility','water_district','college_single_member',
    'not_incorporated','single_member_city','drainage_district','school_board',
    'city_council','constable','ballot_box','mailing_address','mailing_city',
    'mailing_state','mailing_zip','hospital_district','party_score'
  ];
  const empty = [];
  const hasData = [];
  for (const col of colsToCheck) {
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM voters WHERE " + col + " IS NOT NULL AND " + col + " != ''").get();
      if (row.c === 0) empty.push(col);
      else hasData.push(col + '(' + row.c + ')');
    } catch(e) { /* column might not exist */ }
  }
  console.log('[audit] Empty columns:', empty.join(', ') || 'none');
  console.log('[audit] Columns with data:', hasData.join(', '));
} catch (e) { console.error('[migrate] Election rename error:', e.message); }
}, 5000); // run after server starts

addColumn("ALTER TABLE voters ADD COLUMN unit_type TEXT DEFAULT ''");

// --- Normalize district abbreviations to full names ---
const districtRenames = [
  // Navigation districts
  ['navigation_port', 'BND', 'Port of Brownsville'],
  ['navigation_port', 'PIS', 'Port Isabel Navigation District'],
  // Port authorities
  ['port_authority', 'SAN', 'Port of San Benito'],
  // School districts — abbreviations to full names
  ['school_district', 'IBR', 'Brownsville ISD'],
  ['school_district', 'IHG', 'Harlingen ISD'],
  ['school_district', 'ILA', 'La Feria ISD'],
  ['school_district', 'ILO', 'Los Fresnos ISD'],
  ['school_district', 'ILY', 'Lyford ISD'],
  ['school_district', 'IPI', 'Point Isabel ISD'],
  ['school_district', 'IRH', 'Rio Hondo ISD'],
  ['school_district', 'ISB', 'San Benito ISD'],
  ['school_district', 'ISM', 'Santa Maria ISD'],
  ['school_district', 'ISR', 'Santa Rosa ISD'],
  // City abbreviations — Cameron County codes (C = City + initials)
  ['city_district', 'CCB', 'Combes'],
  ['city_district', 'CIL', 'Los Indios'],
  ['city_district', 'CLO', 'Lozano'],
  ['city_district', 'CPI', 'Primera'],
  ['city_district', 'CPV', 'Palm Valley'],
  ['city_district', 'CRH', 'Rangerville'],
  ['city_district', 'CSR', 'Santa Rosa'],
];
for (const [col, abbrev, fullName] of districtRenames) {
  try {
    const r = db.prepare(`UPDATE voters SET ${col} = ? WHERE ${col} = ?`).run(fullName, abbrev);
    if (r.changes > 0) console.log(`[migrate] Renamed ${col}: ${abbrev} → ${fullName} (${r.changes} voters)`);
  } catch(e) {}
}

// --- Add remaining district columns ---
addColumn("ALTER TABLE voters ADD COLUMN court_of_appeals TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN municipal_utility TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN water_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN college_single_member TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN not_incorporated TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN single_member_city TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN drainage_district TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN school_board TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN city_council TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN constable TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN ballot_box TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN mailing_address TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN mailing_city TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN mailing_state TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN mailing_zip TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN mailing_unit TEXT DEFAULT ''");
addColumn("ALTER TABLE voters ADD COLUMN birth_date TEXT DEFAULT ''");

// Vote frequency scores — percentage of elections voted in (0-100)
addColumn("ALTER TABLE voters ADD COLUMN vote_frequency INTEGER DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN general_frequency INTEGER DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN primary_frequency INTEGER DEFAULT NULL");
addColumn("ALTER TABLE voters ADD COLUMN elections_voted INTEGER DEFAULT 0");
addColumn("ALTER TABLE voters ADD COLUMN elections_eligible INTEGER DEFAULT 0");
addColumn("ALTER TABLE voters ADD COLUMN may_frequency INTEGER DEFAULT NULL");

// Index for vote_method filtering
try { db.exec("CREATE INDEX IF NOT EXISTS idx_ev_vote_method ON election_votes(vote_method)"); } catch (e) { /* exists */ }

// One-time address cleanup migration — standardize all voter addresses
// Strips embedded city/state/zip, collapses multiple spaces, trims
try {
  const needsCleanup = db.prepare("SELECT COUNT(*) as c FROM voters WHERE address LIKE '%  %' OR address LIKE '% TX %'").get();
  const walkNeedsCleanup = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE address LIKE '% TX %' OR address LIKE '%  %'").get();
  if (walkNeedsCleanup && walkNeedsCleanup.c > 0 && (!needsCleanup || needsCleanup.c === 0)) {
    // Voter addresses already clean but walk addresses still dirty
    console.log('[migrate] Cleaning ' + walkNeedsCleanup.c + ' walk addresses...');
    const walkTxOnly = db.prepare("SELECT id, address FROM walk_addresses WHERE address LIKE '% TX %'").all();
    const updateWA = db.prepare('UPDATE walk_addresses SET address = ? WHERE id = ?');
    let wc = 0;
    db.transaction(() => {
      for (const w of walkTxOnly) {
        let clean = w.address.replace(/\s+(TX|TEXAS)\s+\d{5}[\s\-]*$/i, '').trim().replace(/\s*-\s*$/, '')
          .replace(/\s+(BROWNSVILLE|HARLINGEN|LOS FRESNOS|PORT ISABEL|SAN BENITO|LAGUNA VISTA|SOUTH PADRE ISLAND|RANCHO VIEJO|MERCEDES|LA FERIA|RIO HONDO|COMBES|OLMITO|SANTA ROSA|SANTA MARIA|BAYVIEW|LOZANO|SEBASTIAN|LYFORD|LOS INDIOS|PALM VALLEY|INDIAN LAKE|PRIMERA)\s*$/i, '').trim()
          .replace(/\s+/g, ' ');
        if (clean !== w.address) { updateWA.run(clean, w.id); wc++; }
      }
    })();
    db.prepare("UPDATE walk_addresses SET address = REPLACE(address, '  ', ' ') WHERE address LIKE '%  %'").run();
    console.log('[migrate] Walk address cleanup done: ' + wc + ' cleaned');
  }
  if (needsCleanup && needsCleanup.c > 0) {
    console.log('[migrate] Cleaning ' + needsCleanup.c + ' voter addresses with spacing/format issues...');
    // Step 1: Strip embedded " CITY TX ZIPCODE -" from addresses
    const txPattern = db.prepare("SELECT id, address FROM voters WHERE address LIKE '% TX %'").all();
    const updateAddr = db.prepare('UPDATE voters SET address = ? WHERE id = ?');
    const cleanTx = db.transaction(() => {
      let cleaned = 0;
      for (const v of txPattern) {
        let clean = v.address
          .replace(/\s+(TX|TEXAS)\s+\d{5}[\s\-]*$/i, '') // strip TX 78520 -
          .trim()
          .replace(/\s*-\s*$/, ''); // trailing dash
        // Strip common Cameron County city names from end
        clean = clean.replace(/\s+(BROWNSVILLE|HARLINGEN|LOS FRESNOS|PORT ISABEL|SAN BENITO|LAGUNA VISTA|SOUTH PADRE ISLAND|RANCHO VIEJO|MERCEDES|LA FERIA|RIO HONDO|COMBES|OLMITO|SANTA ROSA|SANTA MARIA|BAYVIEW|LOZANO|SEBASTIAN|LYFORD|LOS INDIOS|PALM VALLEY|INDIAN LAKE|PRIMERA|RIO GRANDE CITY|WESLACO|PHARR|MCALLEN|EDINBURG|MISSION|DONNA|ALAMO|SAN JUAN|PROGRESO|SULLIVAN CITY|HIDALGO|LA JOYA|PENITAS|LAURELES)\s*$/i, '').trim();
        // Collapse multiple spaces
        clean = clean.replace(/\s+/g, ' ');
        if (clean !== v.address) {
          updateAddr.run(clean, v.id);
          cleaned++;
        }
      }
      return cleaned;
    });
    const txCleaned = cleanTx();

    // Step 2: Collapse remaining double spaces
    const dblSpace = db.prepare("UPDATE voters SET address = REPLACE(address, '  ', ' ') WHERE address LIKE '%  %'").run();
    // Run twice to catch triple spaces
    db.prepare("UPDATE voters SET address = REPLACE(address, '  ', ' ') WHERE address LIKE '%  %'").run();

    // Step 3: Clean walk_addresses too — same full cleanup
    const walkTx = db.prepare("SELECT id, address FROM walk_addresses WHERE address LIKE '% TX %'").all();
    const updateWalkAddr = db.prepare('UPDATE walk_addresses SET address = ? WHERE id = ?');
    let walkCleaned = 0;
    const cleanWalkTx = db.transaction(() => {
      for (const w of walkTx) {
        let clean = w.address
          .replace(/\s+(TX|TEXAS)\s+\d{5}[\s\-]*$/i, '').trim()
          .replace(/\s*-\s*$/, '')
          .replace(/\s+(BROWNSVILLE|HARLINGEN|LOS FRESNOS|PORT ISABEL|SAN BENITO|LAGUNA VISTA|SOUTH PADRE ISLAND|RANCHO VIEJO|MERCEDES|LA FERIA|RIO HONDO|COMBES|OLMITO|SANTA ROSA|SANTA MARIA|BAYVIEW|LOZANO|SEBASTIAN|LYFORD|LOS INDIOS|PALM VALLEY|INDIAN LAKE|PRIMERA)\s*$/i, '').trim()
          .replace(/\s+/g, ' ');
        if (clean !== w.address) {
          updateWalkAddr.run(clean, w.id);
          walkCleaned++;
        }
      }
    });
    cleanWalkTx();
    // Also collapse remaining double spaces
    db.prepare("UPDATE walk_addresses SET address = REPLACE(address, '  ', ' ') WHERE address LIKE '%  %'").run();

    console.log('[migrate] Address cleanup done: ' + txCleaned + ' voters stripped, ' + dblSpace.changes + ' spaces collapsed, ' + walkCleaned + ' walk addresses cleaned');
  }
} catch (e) { console.error('[migrate] Address cleanup error:', e.message); }

// Composite indexes for universe builder performance
try { db.exec("CREATE INDEX IF NOT EXISTS idx_ev_voter_election ON election_votes(voter_id, election_name)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_ev_voter_date ON election_votes(voter_id, election_date)"); } catch (e) { /* exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_ev_voter_party ON election_votes(voter_id, party_voted)"); } catch (e) { /* exists */ }

// --- Performance indexes (added for query optimization) ---
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_optouts_phone ON opt_outs(phone);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_walk_addrs_walk_result ON walk_addresses(walk_id, result);
    CREATE INDEX IF NOT EXISTS idx_walk_addrs_knocked ON walk_addresses(knocked_at);
    CREATE INDEX IF NOT EXISTS idx_voters_phone ON voters(phone);
    CREATE INDEX IF NOT EXISTS idx_voters_lastname ON voters(last_name, first_name);
    CREATE INDEX IF NOT EXISTS idx_voters_support ON voters(support_level);
    CREATE INDEX IF NOT EXISTS idx_voter_contacts_voter ON voter_contacts(voter_id);
    CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_rsvps_status ON event_rsvps(rsvp_status);
    CREATE INDEX IF NOT EXISTS idx_p2p_sessions_status ON p2p_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_session ON p2p_assignments(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_volunteer ON p2p_assignments(volunteer_id, status);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_admin_list_voters_voter ON admin_list_voters(voter_id);

    -- Composite indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_messages_direction_id ON messages(direction, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_phone_direction ON messages(phone, direction, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_phone ON messages(session_id, phone);
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_vol_status ON p2p_assignments(volunteer_id, status);
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_session_status ON p2p_assignments(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_survey_sends_survey_status ON survey_sends(survey_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_phone_dir_ts ON messages(phone, direction, timestamp);
    CREATE INDEX IF NOT EXISTS idx_survey_sends_phone_status ON survey_sends(phone, status);
    CREATE INDEX IF NOT EXISTS idx_voter_contacts_contacted ON voter_contacts(voter_id, contacted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_captain_list_voters_voter ON captain_list_voters(voter_id, list_id);

    -- Walk and captain performance indexes
    CREATE INDEX IF NOT EXISTS idx_walk_addrs_assigned ON walk_addresses(walk_id, assigned_walker);
    CREATE INDEX IF NOT EXISTS idx_admin_lists_captain ON admin_lists(assigned_captain_id);
    CREATE INDEX IF NOT EXISTS idx_voters_precinct ON voters(precinct);
    CREATE INDEX IF NOT EXISTS idx_voters_city ON voters(city);
    CREATE INDEX IF NOT EXISTS idx_voters_party ON voters(party);
    CREATE INDEX IF NOT EXISTS idx_voters_registration ON voters(registration_number);
    CREATE INDEX IF NOT EXISTS idx_voters_address_city ON voters(address, city);
    CREATE INDEX IF NOT EXISTS idx_voters_address ON voters(address COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_block_walks_join ON block_walks(join_code, status);

  `);
} catch (e) { /* indexes already exist */ }

// Walk infrastructure indexes — voter_id and phone exist at this point
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_addresses_voter_id ON walk_addresses(voter_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_group_members_phone ON walk_group_members(phone)"); } catch (e) {}
// Note: indexes for walk_attempts, walk_universes, and walk_addresses.universe_id
// are created after those tables/columns exist (see below line ~885)

// --- Broadcast campaigns table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS broadcast_campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    list_id INTEGER DEFAULT NULL,
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Broadcast campaigns indexes ---
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcast_campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_broadcast_list ON broadcast_campaigns(list_id);
    CREATE INDEX IF NOT EXISTS idx_broadcast_created ON broadcast_campaigns(created_at);
  `);
} catch (e) { /* indexes already exist */ }

// --- Channel tracking (SMS vs WhatsApp dual-send) ---
addColumn("ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'sms'");
// contacts.email already added at line 311; skip duplicate
addColumn("ALTER TABLE contacts ADD COLUMN preferred_channel TEXT DEFAULT NULL");
addColumn("ALTER TABLE p2p_assignments ADD COLUMN wa_status TEXT DEFAULT NULL");

// --- Captain hierarchy: team members become real captains ---
addColumn("ALTER TABLE captains ADD COLUMN parent_captain_id INTEGER DEFAULT NULL");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_captains_parent ON captains(parent_captain_id)"); } catch (e) { /* exists */ }

// --- Election definitions (so elections can exist before any voter is marked) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS elections (
    id INTEGER PRIMARY KEY,
    election_name TEXT NOT NULL UNIQUE,
    election_date TEXT NOT NULL,
    election_type TEXT DEFAULT 'general',
    election_cycle TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Google OAuth columns on users ---
addColumn("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_id TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_email TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_name TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_picture TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_access_token TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_refresh_token TEXT DEFAULT NULL");
addColumn("ALTER TABLE users ADD COLUMN google_token_expiry TEXT DEFAULT NULL");
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)"); } catch (e) { /* already exists */ }

// --- Candidates table (multi-candidate support) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    office TEXT DEFAULT '',
    code TEXT NOT NULL UNIQUE,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_code ON candidates(code);
`);

// Link captains to candidates (NULL = admin's direct captains, backward compatible)
addColumn("ALTER TABLE captains ADD COLUMN candidate_id INTEGER DEFAULT NULL");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_captains_candidate ON captains(candidate_id)"); } catch (e) { /* exists */ }

// Link admin lists to candidates (NULL = admin's direct lists, backward compatible)
addColumn("ALTER TABLE admin_lists ADD COLUMN candidate_id INTEGER DEFAULT NULL");
try { db.exec("CREATE INDEX IF NOT EXISTS idx_admin_lists_candidate ON admin_lists(candidate_id)"); } catch (e) { /* exists */ }

// Sub-member grouping: nest voters under a "parent" voter on a list
addColumn("ALTER TABLE admin_list_voters ADD COLUMN parent_voter_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE captain_list_voters ADD COLUMN parent_voter_id INTEGER DEFAULT NULL");

// Captain notes per voter (how they know them, personal reminders)
addColumn("ALTER TABLE captain_list_voters ADD COLUMN notes TEXT DEFAULT ''");

// Rename existing "My Voters" lists to the captain's actual name
try {
  const renamed = db.prepare(`
    UPDATE captain_lists SET name = (
      SELECT c.name FROM captains c WHERE c.id = captain_lists.captain_id
    )
    WHERE captain_lists.name = 'My Voters'
      AND EXISTS (SELECT 1 FROM captains c WHERE c.id = captain_lists.captain_id)
  `).run();
  if (renamed.changes > 0) console.log('[migration] Renamed ' + renamed.changes + ' "My Voters" lists to captain names');
} catch (e) { /* already migrated or no matching lists */ }

// --- Populate election_cycle from election_name where missing ---
try {
  const monthMap = {
    JANUARY: 'january', FEBRUARY: 'february', MARCH: 'march', APRIL: 'april',
    MAY: 'may', JUNE: 'june', JULY: 'july', AUGUST: 'august',
    SEPTEMBER: 'september', OCTOBER: 'october', NOVEMBER: 'november', DECEMBER: 'december'
  };
  const empty = db.prepare("SELECT DISTINCT election_name FROM election_votes WHERE election_cycle IS NULL OR election_cycle = ''").all();
  if (empty.length > 0) {
    const upd = db.prepare("UPDATE election_votes SET election_cycle = ? WHERE election_name = ? AND (election_cycle IS NULL OR election_cycle = '')");
    let count = 0;
    const tx = db.transaction(() => {
      for (const row of empty) {
        const upper = (row.election_name || '').toUpperCase();
        let cycle = '';
        for (const [m, c] of Object.entries(monthMap)) {
          if (upper.includes(m)) { cycle = c; break; }
        }
        if (cycle) {
          upd.run(cycle, row.election_name);
          count++;
        }
      }
    });
    tx();
    if (count > 0) console.log('[migration] Populated election_cycle for ' + count + ' election names');
  }
} catch (e) { console.error('[migration] election_cycle backfill error:', e.message); }

// --- Clean up bad election names in database ---
try {
  const BAD_NAME_MAP = {
    'Local May 522': 'Local May 2022', 'Local May 524': 'Local May 2024',
    'Local May 523': 'Local May 2023', 'Local May 525': 'Local May 2025',
    'Local May 521': 'Local May 2021', 'Local May 519': 'Local May 2019',
    'Local May 518': 'Local May 2018', 'Local May 517': 'Local May 2017',
    'Local May 516': 'Local May 2016',
    'Local Jun 619': 'Local Jun 2019', 'Local Jun 623': 'Local Jun 2023',
    'Local Jun 621': 'Local Jun 2021', 'Local Jun 618': 'Local Jun 2018',
    'Local Jun 616': 'Local Jun 2016',
    'General Nov 2024': 'General 2024', 'General Nov 2022': 'General 2022',
    'General Nov 2020': 'General 2020', 'General Nov 2018': 'General 2018',
    'General Nov 2016': 'General 2016',
    'Primary Mar 2024': 'Primary 2024', 'Primary Mar 2022': 'Primary 2022',
    'Primary Mar 2020': 'Primary 2020', 'Primary Mar 2018': 'Primary 2018',
    'Primary Mar 2016': 'Primary 2016',
    'Primary Runoff May 2024': 'Primary Runoff 2024', 'Primary Runoff May 2022': 'Primary Runoff 2022',
    'Primary Runoff May 2018': 'Primary Runoff 2018',
    'Primary Runoff Jul 2020': 'Primary Runoff 2020',
    'Special 2034': 'Special Election CD34 2022',
    'City/District Dec 5': 'General Runoff 2020',
    'Drainage District Election': 'Drainage District 5 Election',
  };
  const renameStmt = db.prepare('UPDATE election_votes SET election_name = ? WHERE election_name = ?');
  const delDupStmt = db.prepare('DELETE FROM election_votes WHERE election_name = ? AND voter_id IN (SELECT voter_id FROM election_votes WHERE election_name = ?)');
  let cleaned = 0;
  const tx = db.transaction(() => {
    for (const [bad, good] of Object.entries(BAD_NAME_MAP)) {
      // First delete rows that would create duplicates (voter already has the good name)
      delDupStmt.run(bad, good);
      // Then rename remaining
      const r = renameStmt.run(good, bad);
      if (r.changes > 0) cleaned += r.changes;
    }
  });
  tx();
  if (cleaned > 0) console.log('[migrate] Cleaned', cleaned, 'bad election names');
  // Delete elections with 0 voters
  db.prepare("DELETE FROM elections WHERE election_name NOT IN (SELECT DISTINCT election_name FROM election_votes)").run();
} catch (e) { console.error('[migrate] Election cleanup error:', e.message); }

// --- Shared captains across candidates (many-to-many) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS captain_candidates (
    id INTEGER PRIMARY KEY,
    captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    shared_at TEXT DEFAULT (datetime('now')),
    UNIQUE(captain_id, candidate_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cc_captain ON captain_candidates(captain_id);
  CREATE INDEX IF NOT EXISTS idx_cc_candidate ON captain_candidates(candidate_id);
`);

// Race/district assignment for candidates (e.g., race_type='navigation_port', race_value='1')
addColumn("ALTER TABLE candidates ADD COLUMN race_type TEXT DEFAULT ''");
addColumn("ALTER TABLE candidates ADD COLUMN race_value TEXT DEFAULT ''");
// Default universe (admin_list) for candidate — used by dashboard candidate picker
addColumn("ALTER TABLE candidates ADD COLUMN default_list_id INTEGER DEFAULT NULL");

// --- Backfill: tag NULL-candidate walks ---
// Runs every startup (idempotent — only touches walks where candidate_id IS NULL).
try {
  const nullWalks = db.prepare("SELECT COUNT(*) as c FROM block_walks WHERE candidate_id IS NULL").get().c;
  if (nullWalks > 0) {
    // Log all candidate names so we can debug matching
    const allCands = db.prepare("SELECT id, name, is_active FROM candidates").all();
    console.log(`[backfill] ${nullWalks} unassigned walk(s). Candidates: ${allCands.map(c => `#${c.id} "${c.name}" (active=${c.is_active})`).join(', ')}`);

    // Try multiple name patterns for Luis (the primary/default candidate)
    const luis = db.prepare("SELECT id, name FROM candidates WHERE is_active = 1 AND (LOWER(name) LIKE '%luis%' OR LOWER(name) LIKE '%villarreal%') ORDER BY id LIMIT 1").get();
    // Try multiple patterns for Adreste
    const adreste = db.prepare("SELECT id, name FROM candidates WHERE is_active = 1 AND (LOWER(name) LIKE '%adre%' OR LOWER(name) LIKE '%tsc%') ORDER BY id LIMIT 1").get();

    if (adreste) {
      const r = db.prepare("UPDATE block_walks SET candidate_id = ? WHERE candidate_id IS NULL AND (UPPER(name) LIKE '%TSC%' OR UPPER(COALESCE(description,'')) LIKE '%TSC%')").run(adreste.id);
      if (r.changes > 0) console.log(`[backfill] Tagged ${r.changes} TSC walk(s) → "${adreste.name}" (#${adreste.id})`);
    }
    if (luis) {
      const r = db.prepare("UPDATE block_walks SET candidate_id = ? WHERE candidate_id IS NULL").run(luis.id);
      if (r.changes > 0) console.log(`[backfill] Tagged ${r.changes} remaining walk(s) → "${luis.name}" (#${luis.id})`);
    }
    if (!luis && !adreste) console.log('[backfill] Could not match any candidate names — walks still unassigned. Use "Tag Unassigned Walks" button on Block Walking page.');

    const stillNull = db.prepare("SELECT COUNT(*) as c FROM block_walks WHERE candidate_id IS NULL").get().c;
    if (stillNull > 0) console.log(`[backfill] WARNING: ${stillNull} walk(s) still unassigned after backfill`);
  }
} catch (e) { console.warn('[backfill] Walk tagging failed:', e.message); }

// Clean incorrect navigation_port tags — official BND precincts from Cameron County Elections
// Source: https://www.cameroncountytx.gov/elections/wp-content/uploads/2024/05/Brownsville-Navigation-District-Precinct-by-Precinct.pdf
// Pct 52 removed — had 0 BND voters per audit (all 2,339 are Port Isabel)
const BND_PRECINCTS = new Set(['2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','37','38','45','46','47','48','49','53','54','60','61','62','63','65','66','68','69','70','71','72','73','74','75','76','77','82','86','88','89','90','91','94','95','97','98','99','100']);
try {
  // Find voters with navigation_port set but in precincts NOT in the BND
  const badRows = db.prepare("SELECT COUNT(*) as c FROM voters WHERE navigation_port != '' AND navigation_port IS NOT NULL AND precinct != '' AND precinct NOT IN (" + [...BND_PRECINCTS].map(() => '?').join(',') + ")").get(...BND_PRECINCTS);
  if (badRows.c > 0) {
    const r = db.prepare("UPDATE voters SET navigation_port = '' WHERE navigation_port != '' AND navigation_port IS NOT NULL AND precinct != '' AND precinct NOT IN (" + [...BND_PRECINCTS].map(() => '?').join(',') + ")").run(...BND_PRECINCTS);
    console.log(`[cleanup] Cleared navigation_port for ${r.changes} voter(s) in non-BND precincts (e.g., Pct 36)`);
  }
} catch (e) { console.warn('[cleanup] BND precinct cleanup failed:', e.message); }

// Auto-mark stuck inbound messages as replied if there's evidence of a reply.
// Evidence = any outbound for the same normalized phone in the last 60 days.
// Inserts a placeholder outbound so Needs Response drops the thread naturally.
try {
  const stuck = db.prepare(`
    SELECT DISTINCT m.phone, m.id FROM messages m
    WHERE m.direction = 'inbound'
      AND m.timestamp > datetime('now', '-60 days')
      AND m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.phone = m.phone)
      AND EXISTS (
        SELECT 1 FROM messages out_msg
        WHERE out_msg.direction = 'outbound'
          AND out_msg.timestamp > datetime('now', '-60 days')
          AND SUBSTR(REPLACE(REPLACE(REPLACE(out_msg.phone, '+', ''), '-', ''), ' ', ''), -10)
            = SUBSTR(REPLACE(REPLACE(REPLACE(m.phone, '+', ''), '-', ''), ' ', ''), -10)
      )
  `).all();
  if (stuck.length > 0) {
    const insert = db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, '[Auto-marked replied: outbound exists for this contact]', 'outbound', 'neutral', 'sms')");
    for (const s of stuck) insert.run(s.phone);
    console.log(`[cleanup] Auto-marked ${stuck.length} stuck messages as replied (found matching outbounds)`);
  }
} catch (e) { console.warn('[cleanup] Auto-mark replied failed:', e.message); }

// Remove privacy-redacted addresses from block walks entirely (no useful data)
try {
  const r = db.prepare("DELETE FROM walk_addresses WHERE address LIKE '%***%' OR address LIKE '%Privacy%' OR TRIM(address) = '' OR LENGTH(TRIM(address)) < 4").run();
  if (r.changes > 0) console.log(`[cleanup] Removed ${r.changes} privacy/empty address(es) from block walks`);
} catch (e) {}

// --- Canvassing Scripts (VAN-style door scripts with survey questions) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS walk_scripts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS walk_script_elements (
    id INTEGER PRIMARY KEY,
    script_id INTEGER NOT NULL REFERENCES walk_scripts(id) ON DELETE CASCADE,
    element_type TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    label TEXT DEFAULT '',
    content TEXT DEFAULT '',
    options_json TEXT DEFAULT '[]',
    parent_element_id INTEGER DEFAULT NULL,
    parent_option_key TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wse_script ON walk_script_elements(script_id);
`);

// Link walks to scripts
addColumn("ALTER TABLE block_walks ADD COLUMN script_id INTEGER DEFAULT NULL");

// --- Walk Attempt Tracking (multiple attempts per address) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS walk_attempts (
    id INTEGER PRIMARY KEY,
    address_id INTEGER NOT NULL REFERENCES walk_addresses(id) ON DELETE CASCADE,
    walk_id INTEGER NOT NULL REFERENCES block_walks(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    notes TEXT DEFAULT '',
    walker_name TEXT DEFAULT '',
    gps_lat REAL DEFAULT NULL,
    gps_lng REAL DEFAULT NULL,
    gps_accuracy REAL DEFAULT NULL,
    gps_verified INTEGER DEFAULT 0,
    survey_responses_json TEXT DEFAULT NULL,
    attempted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wa_address ON walk_attempts(address_id);
  CREATE INDEX IF NOT EXISTS idx_wa_walk ON walk_attempts(walk_id);
  CREATE INDEX IF NOT EXISTS idx_wa_walker ON walk_attempts(walk_id, walker_name);
  CREATE INDEX IF NOT EXISTS idx_wa_time ON walk_attempts(attempted_at);
`);

// --- Distributed Canvassing Universes ---
db.exec(`
  CREATE TABLE IF NOT EXISTS walk_universes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    share_code TEXT NOT NULL UNIQUE,
    script_id INTEGER DEFAULT NULL,
    doors_per_turf INTEGER DEFAULT 30,
    filters_json TEXT DEFAULT '{}',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wu_code ON walk_universes(share_code);
`);

// --- Time Gap Flags (breaks > 15 min between knocks, admin must approve deduction) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS walker_time_gaps (
    id INTEGER PRIMARY KEY,
    walker_name TEXT NOT NULL,
    gap_date TEXT NOT NULL,
    gap_start TEXT NOT NULL,
    gap_end TEXT NOT NULL,
    gap_minutes REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    reviewed_at TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wtg_walker ON walker_time_gaps(walker_name);
  CREATE INDEX IF NOT EXISTS idx_wtg_date ON walker_time_gaps(gap_date);
  CREATE INDEX IF NOT EXISTS idx_wtg_status ON walker_time_gaps(status);
`);

// Track which voters are already assigned in a universe to avoid duplication
addColumn("ALTER TABLE walk_addresses ADD COLUMN universe_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE walk_addresses ADD COLUMN geo_flagged INTEGER DEFAULT 0");
addColumn("ALTER TABLE walk_addresses ADD COLUMN outside_precinct INTEGER DEFAULT 0");

// --- Walk performance metrics ---
addColumn("ALTER TABLE walk_group_members ADD COLUMN doors_knocked INTEGER DEFAULT 0");
addColumn("ALTER TABLE walk_group_members ADD COLUMN contacts_made INTEGER DEFAULT 0");
addColumn("ALTER TABLE walk_group_members ADD COLUMN first_knock_at TEXT DEFAULT NULL");
addColumn("ALTER TABLE walk_group_members ADD COLUMN last_knock_at TEXT DEFAULT NULL");

// Precinct-level saved search for turf refresh
addColumn("ALTER TABLE block_walks ADD COLUMN source_precincts TEXT DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN source_filters_json TEXT DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN candidate_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN created_by_walker_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN sandbox INTEGER DEFAULT 0");

// --- Walkers — persistent block walk volunteers tied to a candidate ---
db.exec(`
  CREATE TABLE IF NOT EXISTS walkers (
    id INTEGER PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT DEFAULT NULL,
    code TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_walkers_candidate ON walkers(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_walkers_code ON walkers(code);
`);
// Link walk_group_members to persistent walker identity
addColumn("ALTER TABLE walk_group_members ADD COLUMN walker_id INTEGER DEFAULT NULL");
// Track which walker knocked each door
addColumn("ALTER TABLE walk_attempts ADD COLUMN walker_id INTEGER DEFAULT NULL");
// Deferred indexes — these tables/columns are now defined above
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_addresses_universe_id ON walk_addresses(universe_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_attempts_walker_id ON walk_attempts(walker_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_attempts_walker_walk ON walk_attempts(walker_id, walk_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_walk_universes_status ON walk_universes(status)"); } catch (e) {}

// One-time migration: bump default max walkers from 4 to 10 (guarded by settings flag)
try {
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'max_walkers_migrated'").get();
  if (!migrated) {
    db.prepare("UPDATE block_walks SET max_walkers = 10 WHERE max_walkers = 4").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_walkers_migrated', '1')").run();
  }
} catch(e) {}

// --- Groups table (code-based login, block walk only, max 10) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_groups_code ON groups(code);
`);

// --- Survey completion message ---
addColumn("ALTER TABLE surveys ADD COLUMN completion_message TEXT DEFAULT ''");

// --- Texting volunteers (legacy — kept for backward compat) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS texting_volunteers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT DEFAULT NULL,
    code TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_texting_volunteers_code ON texting_volunteers(code);
`);
// Link p2p session volunteers to persistent identity
addColumn("ALTER TABLE p2p_volunteers ADD COLUMN volunteer_id INTEGER DEFAULT NULL");
addColumn("ALTER TABLE p2p_volunteers ADD COLUMN last_active TEXT DEFAULT NULL");
addColumn("ALTER TABLE p2p_assignments ADD COLUMN volunteer_name TEXT DEFAULT NULL");

// --- Unified volunteers table (replaces texting_volunteers + walkers) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS volunteers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT DEFAULT NULL,
    code TEXT NOT NULL UNIQUE,
    can_text INTEGER DEFAULT 1,
    can_walk INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_volunteers_code ON volunteers(code);

  CREATE TABLE IF NOT EXISTS saved_qr_codes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'voting-reminder',
    qr_data_url TEXT NOT NULL,
    ics_url TEXT,
    config_json TEXT,
    scan_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS short_links (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    target_url TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_short_links_code ON short_links(code);

  CREATE TABLE IF NOT EXISTS qr_scans (
    id INTEGER PRIMARY KEY,
    url_hash TEXT NOT NULL,
    scanned_at TEXT DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_qr_scans_hash ON qr_scans(url_hash);
`);

// Migrate: add scan_count column to saved_qr_codes if missing
try {
  db.prepare("SELECT scan_count FROM saved_qr_codes LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE saved_qr_codes ADD COLUMN scan_count INTEGER DEFAULT 0");
}

// Step 1: Link ALL orphaned walk_addresses (voter_id IS NULL) to voters
try {
  const orphans = db.prepare(`
    SELECT wa.id, wa.address, wa.city, wa.voter_name, wa.unit,
      UPPER(TRIM(wa.address)) as addr_upper, UPPER(TRIM(wa.city)) as city_upper
    FROM walk_addresses wa
    WHERE wa.voter_id IS NULL AND wa.address != ''
  `).all();
  if (orphans.length > 0) {
    const updAddr = db.prepare('UPDATE walk_addresses SET voter_id = ? WHERE id = ?');
    let linked = 0;
    let strategies = { name_addr: 0, exact_addr: 0, partial_addr: 0, name_only: 0 };
    for (const o of orphans) {
      let voter = null;
      // Strategy 1: voter_name contains "FirstName LastName" — match both name AND address
      if (!voter && o.voter_name) {
        const parts = o.voter_name.trim().split(/\s+/);
        if (parts.length >= 2) {
          const first = parts[0].toUpperCase();
          const last = parts[parts.length - 1].toUpperCase();
          voter = db.prepare(`
            SELECT id FROM voters
            WHERE UPPER(TRIM(first_name)) = ? AND UPPER(TRIM(last_name)) = ?
              AND UPPER(TRIM(address)) = ?
            LIMIT 1
          `).get(first, last, o.addr_upper);
          if (voter) strategies.name_addr++;
        }
      }
      // Strategy 2: Exact address + city
      if (!voter) {
        voter = db.prepare(`
          SELECT id FROM voters WHERE UPPER(TRIM(address)) = ? AND UPPER(TRIM(city)) = ? LIMIT 1
        `).get(o.addr_upper, o.city_upper);
        if (voter) strategies.exact_addr++;
      }
      // Strategy 3: First 3 words of address (handles St vs Street, Ave vs Avenue)
      if (!voter && o.addr_upper) {
        const words = o.addr_upper.split(/\s+/).slice(0, 3).join(' ');
        if (words.length > 5) {
          voter = db.prepare(`
            SELECT id FROM voters WHERE UPPER(TRIM(address)) LIKE ? AND UPPER(TRIM(city)) = ? LIMIT 1
          `).get(words + '%', o.city_upper);
          if (voter) strategies.partial_addr++;
        }
      }
      // Strategy 4: Match by voter name only (last resort — may have duplicates)
      if (!voter && o.voter_name) {
        const parts = o.voter_name.trim().split(/\s+/);
        if (parts.length >= 2) {
          const first = parts[0].toUpperCase();
          const last = parts[parts.length - 1].toUpperCase();
          // Only use name-only if there's exactly 1 match (avoid ambiguity)
          const matches = db.prepare(`
            SELECT id FROM voters WHERE UPPER(TRIM(first_name)) = ? AND UPPER(TRIM(last_name)) = ?
          `).all(first, last);
          if (matches.length === 1) {
            voter = matches[0];
            strategies.name_only++;
          }
        }
      }
      if (voter) {
        updAddr.run(voter.id, o.id);
        linked++;
      }
    }
    console.log('[migrate] Linked ' + linked + ' orphaned walk_addresses to voters (of ' + orphans.length + ' total). Strategies:', JSON.stringify(strategies));
  }
} catch(e) { console.error('[migrate] link orphans error:', e.message); }

// Step 2: Sync support_level from walk_addresses result for ALL voters
// Uses walk_addresses.result directly (not walk_attempts) because household logging
// updates all walk_address rows at an address, but only creates 1 walk_attempt
// Support sync — deferred to avoid health check timeout
setTimeout(() => { try {
  const resultToSupport = {
    'support': 'strong_support', 'lean_support': 'lean_support',
    'undecided': 'undecided', 'lean_oppose': 'lean_oppose',
    'oppose': 'strong_oppose', 'refused': 'refused'
  };
  // Source 1: walk_addresses.result (covers household members)
  const addrRows = db.prepare(`
    SELECT wa.voter_id, wa.result, wa.knocked_at FROM walk_addresses wa
    WHERE wa.voter_id IS NOT NULL
      AND wa.result IN ('support','lean_support','undecided','lean_oppose','oppose','refused')
    ORDER BY wa.knocked_at DESC
  `).all();
  // Source 2: walk_attempts (covers individual door knocks)
  const attemptRows = db.prepare(`
    SELECT wa.voter_id, wt.result, wt.attempted_at as knocked_at FROM walk_attempts wt
    JOIN walk_addresses wa ON wt.address_id = wa.id
    WHERE wa.voter_id IS NOT NULL
      AND wt.result IN ('support','lean_support','undecided','lean_oppose','oppose','refused')
    ORDER BY wt.attempted_at DESC
  `).all();
  // Merge: most recent result per voter wins
  const latest = {};
  for (const r of [...addrRows, ...attemptRows]) {
    if (!latest[r.voter_id]) latest[r.voter_id] = r.result;
  }
  let count = 0;
  const countByLevel = {};
  // Update ALL voters with walk results — most recent walk result wins
  const upd = db.prepare("UPDATE voters SET support_level = ?, updated_at = datetime('now') WHERE id = ?");
  for (const [vid, result] of Object.entries(latest)) {
    const lvl = resultToSupport[result];
    if (lvl) {
      const r = upd.run(lvl, vid);
      count += r.changes;
      countByLevel[lvl] = (countByLevel[lvl] || 0) + 1;
    }
  }
  // Also count walk_attempts that have no voter_id link (orphans that didn't get matched)
  const orphanAttempts = db.prepare(`
    SELECT wt.result, COUNT(*) as cnt FROM walk_attempts wt
    JOIN walk_addresses wa ON wt.address_id = wa.id
    WHERE wa.voter_id IS NULL
      AND wt.result IN ('support','lean_support','undecided','lean_oppose','oppose','refused')
    GROUP BY wt.result
  `).all();
  console.log('[migrate] Support sync: ' + count + ' voters updated. Breakdown:', JSON.stringify(countByLevel));
  if (orphanAttempts.length > 0) {
    console.log('[migrate] WARNING: ' + orphanAttempts.reduce((s,r) => s + r.cnt, 0) + ' walk attempts still have no voter_id link:', JSON.stringify(orphanAttempts));
  }
} catch(e) { console.error('[migrate] backfill error:', e.message); }
}, 5000);

// Migrate existing texting_volunteers and walkers into unified table (one-time)
try {
  const volCount = (db.prepare('SELECT COUNT(*) as c FROM volunteers').get() || {}).c || 0;
  if (volCount === 0) {
    // Copy texting volunteers
    const texters = db.prepare('SELECT name, phone, code, is_active, created_at FROM texting_volunteers').all();
    const ins = db.prepare('INSERT OR IGNORE INTO volunteers (name, phone, code, can_text, can_walk, is_active, created_at) VALUES (?, ?, ?, 1, 0, ?, ?)');
    for (const t of texters) { ins.run(t.name, t.phone, t.code, t.is_active, t.created_at); }
    // Copy walkers (give them walk access, handle NULL phone dedup)
    const walkerRows = db.prepare('SELECT name, phone, code, is_active, created_at FROM walkers').all();
    const insWalk = db.prepare('INSERT OR IGNORE INTO volunteers (name, phone, code, can_text, can_walk, is_active, created_at) VALUES (?, ?, ?, 0, 1, ?, ?)');
    for (const w of walkerRows) {
      // Match by name, handling NULL phone correctly
      const existing = w.phone
        ? db.prepare('SELECT id FROM volunteers WHERE name = ? AND phone = ?').get(w.name, w.phone)
        : db.prepare('SELECT id FROM volunteers WHERE name = ? AND phone IS NULL').get(w.name);
      if (existing) { db.prepare('UPDATE volunteers SET can_walk = 1 WHERE id = ?').run(existing.id); }
      else { insWalk.run(w.name, w.phone, w.code, w.is_active, w.created_at); }
    }
    const migrated = (db.prepare('SELECT COUNT(*) as c FROM volunteers').get() || {}).c || 0;
    if (migrated > 0) console.log('[migration] Migrated ' + migrated + ' volunteers to unified table');
  }
} catch (e) { console.error('[migration] Volunteer migration error:', e.message); }

// One-time: normalize all contact phone numbers to 10-digit format for consistent matching
try {
  const rawContacts = db.prepare("SELECT id, phone FROM contacts WHERE phone IS NOT NULL AND phone != '' AND phone GLOB '*[^0-9]*'").all();
  if (rawContacts.length > 0) {
    const upd = db.prepare('UPDATE contacts SET phone = ? WHERE id = ?');
    const normalize = db.transaction(() => {
      let fixed = 0;
      for (const c of rawContacts) {
        const digits = (c.phone || '').replace(/\D/g, '');
        const clean = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (clean && clean !== c.phone) { upd.run(clean, c.id); fixed++; }
      }
      if (fixed > 0) console.log('[migration] Normalized ' + fixed + ' contact phone numbers');
    });
    normalize();
  }
} catch (e) { console.error('[migration] Phone normalization error:', e.message); }

// Cleanup: remove orphaned P2P sessions from deleted events/surveys (transactional)
try {
  const orphanedEvent = db.prepare("SELECT id, name FROM p2p_sessions WHERE session_type = 'event' AND name LIKE 'Event Invite:%' AND name NOT IN (SELECT 'Event Invite: ' || title FROM events)").all();
  const orphanedSurvey = db.prepare("SELECT id, name FROM p2p_sessions WHERE session_type = 'survey' AND name LIKE 'Survey:%' AND name NOT IN (SELECT 'Survey: ' || name FROM surveys)").all();
  const orphaned = [...orphanedEvent, ...orphanedSurvey];
  if (orphaned.length > 0) {
    const cleanupOrphans = db.transaction(() => {
      for (const s of orphaned) {
        db.prepare('DELETE FROM p2p_assignments WHERE session_id = ?').run(s.id);
        db.prepare('DELETE FROM p2p_volunteers WHERE session_id = ?').run(s.id);
        db.prepare('DELETE FROM p2p_sessions WHERE id = ?').run(s.id);
      }
    });
    cleanupOrphans();
    console.log('[cleanup] Removed ' + orphaned.length + ' orphaned P2P sessions from deleted events/surveys');
  }
} catch (e) { /* cleanup is best-effort */ }

// --- Compute VAN-style party scores (D/DD/DDD, R/RR/RRR) from election history ---
function computePartyScores() {
  // VAN-style party score: DDD/DD/D/R/RR/RRR strength scale
  // Based on primary ballot history with RECENCY WEIGHTING:
  // - Most recent primary counts 3x
  // - Second most recent counts 2x
  // - Older primaries count 1x each
  // This means a DDD voter who just pulled R drops to D or SWING, not stays DDD
  const rows = db.prepare(`
    SELECT voter_id, party_voted, election_date
    FROM election_votes
    WHERE party_voted IS NOT NULL AND party_voted != ''
      AND party_voted IN ('D','DEM','Democrat','R','REP','Republican')
    ORDER BY voter_id, election_date DESC
  `).all();

  // Group by voter, most recent first
  const voterVotes = {};
  for (const r of rows) {
    if (!voterVotes[r.voter_id]) voterVotes[r.voter_id] = [];
    const party = (r.party_voted === 'D' || r.party_voted === 'DEM' || r.party_voted === 'Democrat') ? 'D' : 'R';
    voterVotes[r.voter_id].push(party);
  }

  const update = db.prepare('UPDATE voters SET party_score = ? WHERE id = ?');
  const batch = db.transaction(() => {
    db.prepare("UPDATE voters SET party_score = '' WHERE party_score != ''").run();
    for (const [voterId, votes] of Object.entries(voterVotes)) {
      // Weighted scoring: most recent = 3pts, second = 2pts, rest = 1pt each
      let dScore = 0, rScore = 0;
      for (let i = 0; i < votes.length; i++) {
        const weight = i === 0 ? 3 : i === 1 ? 2 : 1;
        if (votes[i] === 'D') dScore += weight;
        else rScore += weight;
      }

      let score = '';
      const total = dScore + rScore;
      const dPct = dScore / total;
      const rPct = rScore / total;

      if (dScore > 0 && rScore === 0) {
        // Pure D
        score = dScore >= 5 ? 'DDD' : dScore >= 3 ? 'DD' : 'D';
      } else if (rScore > 0 && dScore === 0) {
        // Pure R
        score = rScore >= 5 ? 'RRR' : rScore >= 3 ? 'RR' : 'R';
      } else if (dPct >= 0.75) {
        // Mostly D (75%+ weighted)
        score = dScore >= 5 ? 'DD' : 'D';
      } else if (rPct >= 0.75) {
        // Mostly R (75%+ weighted)
        score = rScore >= 5 ? 'RR' : 'R';
      } else {
        // Mixed — lean based on most recent
        score = votes[0] === 'D' ? 'D' : 'R';
        // If truly close, mark as swing
        if (Math.abs(dPct - rPct) < 0.2) score = 'SWING';
      }
      if (score) update.run(score, voterId);
    }
  });
  batch();
  console.log('[party-score] Computed party scores for ' + Object.keys(voterVotes).length + ' voters with primary history');
}

// ===================== VOTE FREQUENCY SCORES =====================
// Computes what percentage of elections each voter participated in
// Similar to VAN's turnout propensity — measures voting consistency
function computeVoteFrequency() {
  const evCount = db.prepare('SELECT COUNT(DISTINCT election_name) as c FROM election_votes').get().c;
  if (evCount === 0) { console.log('[vote-freq] No election data, skipping'); return; }

  // Get all distinct elections by type
  const allElections = db.prepare('SELECT DISTINCT election_name, election_type, election_date FROM election_votes ORDER BY election_name').all();
  const generalElections = allElections.filter(e => (e.election_type || '').toLowerCase().includes('general'));
  const primaryElections = allElections.filter(e => (e.election_type || '').toLowerCase().includes('primary'));
  // May elections: any election held in May (month 05) — covers May primaries, May runoffs, May specials
  const mayElections = allElections.filter(e => {
    const d = e.election_date || '';
    return d.substring(5, 7) === '05' || (e.election_name || '').toLowerCase().includes('may');
  });
  const totalElections = allElections.length;

  console.log('[vote-freq] Computing frequency scores: ' + totalElections + ' elections (' +
    generalElections.length + ' general, ' + primaryElections.length + ' primary, ' + mayElections.length + ' may)');

  // Get per-voter election counts — all, general-only, primary-only
  // Also get their first election to determine eligibility window
  const voterStats = db.prepare(`
    SELECT voter_id,
      COUNT(DISTINCT election_name) as total_voted,
      MIN(election_name) as first_election
    FROM election_votes
    GROUP BY voter_id
  `).all();

  // Per-voter general, primary, and may counts
  const generalCounts = {};
  const primaryCounts = {};
  const mayCounts = {};
  if (generalElections.length > 0) {
    const gRows = db.prepare(
      'SELECT voter_id, COUNT(DISTINCT election_name) as c FROM election_votes WHERE election_type LIKE \'%general%\' COLLATE NOCASE GROUP BY voter_id'
    ).all();
    for (const r of gRows) generalCounts[r.voter_id] = r.c;
  }
  if (primaryElections.length > 0) {
    const pRows = db.prepare(
      'SELECT voter_id, COUNT(DISTINCT election_name) as c FROM election_votes WHERE election_type LIKE \'%primary%\' COLLATE NOCASE GROUP BY voter_id'
    ).all();
    for (const r of pRows) primaryCounts[r.voter_id] = r.c;
  }
  if (mayElections.length > 0) {
    const mayNames = mayElections.map(e => e.election_name);
    const mRows = db.prepare(
      'SELECT voter_id, COUNT(DISTINCT election_name) as c FROM election_votes WHERE election_name IN (' + mayNames.map(() => '?').join(',') + ') GROUP BY voter_id'
    ).all(...mayNames);
    for (const r of mRows) mayCounts[r.voter_id] = r.c;
  }

  // Build election order for eligibility calculation
  const electionOrder = allElections.map(e => e.election_name);
  const generalOrder = generalElections.map(e => e.election_name);
  const primaryOrder = primaryElections.map(e => e.election_name);
  const mayOrder = mayElections.map(e => e.election_name);

  const update = db.prepare(
    'UPDATE voters SET vote_frequency = ?, general_frequency = ?, primary_frequency = ?, may_frequency = ?, elections_voted = ?, elections_eligible = ? WHERE id = ?'
  );

  const batch = db.transaction(() => {
    // Reset all to NULL first
    db.prepare('UPDATE voters SET vote_frequency = NULL, general_frequency = NULL, primary_frequency = NULL, may_frequency = NULL, elections_voted = 0, elections_eligible = 0').run();

    for (const vs of voterStats) {
      // Eligible = elections that occurred on or after their first recorded vote
      const firstIdx = electionOrder.indexOf(vs.first_election);
      const eligible = firstIdx >= 0 ? totalElections - firstIdx : totalElections;
      const eligibleGeneral = generalOrder.filter((e, i) => electionOrder.indexOf(e) >= firstIdx).length || generalElections.length;
      const eligiblePrimary = primaryOrder.filter((e, i) => electionOrder.indexOf(e) >= firstIdx).length || primaryElections.length;
      const eligibleMay = mayOrder.filter((e, i) => electionOrder.indexOf(e) >= firstIdx).length || mayElections.length;

      const overallFreq = eligible > 0 ? Math.round((vs.total_voted / eligible) * 100) : 0;
      const genFreq = eligibleGeneral > 0 ? Math.round(((generalCounts[vs.voter_id] || 0) / eligibleGeneral) * 100) : null;
      const priFreq = eligiblePrimary > 0 ? Math.round(((primaryCounts[vs.voter_id] || 0) / eligiblePrimary) * 100) : null;
      const mayFreq = eligibleMay > 0 ? Math.round(((mayCounts[vs.voter_id] || 0) / eligibleMay) * 100) : null;

      update.run(
        Math.min(overallFreq, 100),
        genFreq !== null ? Math.min(genFreq, 100) : null,
        priFreq !== null ? Math.min(priFreq, 100) : null,
        mayFreq !== null ? Math.min(mayFreq, 100) : null,
        vs.total_voted,
        eligible,
        vs.voter_id
      );
    }
  });
  batch();
  console.log('[vote-freq] Computed frequency scores for ' + voterStats.length + ' voters');
}

// Compute after startup to avoid health check timeout
setTimeout(() => {
  try { computePartyScores(); } catch (e) { console.error('[party-score] Error:', e.message); }
  try { computeVoteFrequency(); } catch (e) { console.error('[vote-freq] Error:', e.message); }
}, 15000);

module.exports = db;
module.exports.generateQrToken = generateQrToken;
module.exports.computePartyScores = computePartyScores;
module.exports.computeVoteFrequency = computeVoteFrequency;
