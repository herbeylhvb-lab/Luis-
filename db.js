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

module.exports = db;
