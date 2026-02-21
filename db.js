const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'campaign.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// --- Phase 2 migrations ---

// Sentiment column on messages
try { db.exec("ALTER TABLE messages ADD COLUMN sentiment TEXT DEFAULT NULL"); } catch (e) { /* already exists */ }

// Check-in timestamp on event RSVPs
try { db.exec("ALTER TABLE event_rsvps ADD COLUMN checked_in_at TEXT DEFAULT NULL"); } catch (e) { /* already exists */ }

// Voter registration number
try { db.exec("ALTER TABLE voters ADD COLUMN registration_number TEXT DEFAULT ''"); } catch (e) { /* already exists */ }

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

// P2P columns on messages
try { db.exec("ALTER TABLE messages ADD COLUMN session_id INTEGER DEFAULT NULL"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE messages ADD COLUMN volunteer_name TEXT DEFAULT NULL"); } catch (e) { /* already exists */ }

// --- Per-voter QR code check-in ---

// Unique QR token per voter (short random string used in check-in URLs)
try { db.exec("ALTER TABLE voters ADD COLUMN qr_token TEXT DEFAULT NULL"); } catch (e) { /* already exists */ }
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

module.exports = db;
module.exports.generateQrToken = generateQrToken;
