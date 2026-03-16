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

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    message_template TEXT,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
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

// Session type for P2P sessions (campaign, event, survey)
addColumn("ALTER TABLE p2p_sessions ADD COLUMN session_type TEXT DEFAULT 'campaign'");

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
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_vol_status ON p2p_assignments(volunteer_id, status);
    CREATE INDEX IF NOT EXISTS idx_p2p_assign_session_status ON p2p_assignments(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_survey_sends_survey_status ON survey_sends(survey_id, status);
    CREATE INDEX IF NOT EXISTS idx_survey_sends_phone_status ON survey_sends(phone, status);
    CREATE INDEX IF NOT EXISTS idx_voter_contacts_contacted ON voter_contacts(voter_id, contacted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_captain_list_voters_voter ON captain_list_voters(voter_id, list_id);

    -- Walk and captain performance indexes
    CREATE INDEX IF NOT EXISTS idx_walk_addrs_assigned ON walk_addresses(walk_id, assigned_walker);
    CREATE INDEX IF NOT EXISTS idx_captains_parent ON captains(parent_captain_id);
    CREATE INDEX IF NOT EXISTS idx_admin_lists_captain ON admin_lists(assigned_captain_id);
    CREATE INDEX IF NOT EXISTS idx_voters_precinct ON voters(precinct);
    CREATE INDEX IF NOT EXISTS idx_voters_city ON voters(city);
    CREATE INDEX IF NOT EXISTS idx_voters_party ON voters(party);
    CREATE INDEX IF NOT EXISTS idx_voters_registration ON voters(registration_number);
    CREATE INDEX IF NOT EXISTS idx_block_walks_join ON block_walks(join_code, status);
  `);
} catch (e) { /* indexes already exist */ }

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

// Track which voters are already assigned in a universe to avoid duplication
addColumn("ALTER TABLE walk_addresses ADD COLUMN universe_id INTEGER DEFAULT NULL");

// --- Walk performance metrics ---
addColumn("ALTER TABLE walk_group_members ADD COLUMN doors_knocked INTEGER DEFAULT 0");
addColumn("ALTER TABLE walk_group_members ADD COLUMN contacts_made INTEGER DEFAULT 0");
addColumn("ALTER TABLE walk_group_members ADD COLUMN first_knock_at TEXT DEFAULT NULL");
addColumn("ALTER TABLE walk_group_members ADD COLUMN last_knock_at TEXT DEFAULT NULL");

// Precinct-level saved search for turf refresh
addColumn("ALTER TABLE block_walks ADD COLUMN source_precincts TEXT DEFAULT NULL");
addColumn("ALTER TABLE block_walks ADD COLUMN source_filters_json TEXT DEFAULT NULL");

module.exports = db;
module.exports.generateQrToken = generateQrToken;
