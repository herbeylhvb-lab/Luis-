# P2P Texting Feature Design

## Overview

Add peer-to-peer texting to CampaignText HQ. Unlike the existing blast texting (automated mass send), P2P texting puts a human volunteer in the loop for every message. Volunteers work through a queue one contact at a time, reviewing and sending individually. AI (Claude Haiku) generates reply suggestions from campaign knowledge, with script-based fallback.

## Architecture: New Sidebar Page (Approach A)

P2P Texting gets its own page in the sidebar, separate from the existing Compose & Send (blast) flow. A Campaign Knowledge Base page is added under System for uploading platform info.

## Key Components

### 1. P2P Sessions

Admin creates a session with:
- Session name (e.g., "Voter Outreach Oct")
- Message template with merge tags ({firstName}, {lastName}, {city})
- Assignment mode (dropdown): auto-split, manual assign, or claim-based
- 4-digit join code (auto-generated)
- Code expires after 7 days; session stays active until admin closes it

### 2. Volunteer Queue

Each volunteer sees a single-contact view:
- Contact info (name, phone, city, party, support level)
- Pre-filled message with merge tags resolved
- Actions: Edit message, Send, Skip
- Progress bar showing completion (e.g., "15 of 48 sent")

After sending, the view advances to the next contact automatically.

### 3. Online/Offline System

Volunteers toggle online/offline status:
- **Go Offline**: Pending (unsent) contacts auto-redistribute to online volunteers using least-loaded algorithm. Active conversations (voters who replied) route to next available online volunteer.
- **Come Back Online**: System assigns fresh batch from remaining pool. Original conversations that are still active snap back to the returning volunteer for continuity.
- **Incoming reply routing**: System checks if original volunteer is online. If yes, route to them. If no, route to least-loaded online volunteer. When original comes back, conversations return.

No admin intervention needed for routing -- fully automatic.

### 4. Campaign Knowledge Base

New sidebar page under System. Four knowledge types:

| Type | Purpose |
|------|---------|
| `policy` | Issue positions (housing, education, healthcare, etc.) |
| `bio` | Candidate background and qualifications |
| `script` | Pre-approved response templates by scenario |
| `details` | Campaign name, election date, website, slogan |

Admin can add, edit, and delete entries. All content feeds into AI response generation.

### 5. AI Response Engine (Claude API)

Priority: AI-first, scripts as fallback.

When a voter replies:
1. Sentiment analysis classifies the reply (positive/negative/neutral)
2. Claude Haiku generates a response using the full campaign knowledge base as context
3. If AI returns high-confidence response: shown to volunteer with Approve/Edit/Write Own options
4. If AI returns "NO_MATCH" (can't confidently answer): falls back to best-matching response script
5. If no script matches either: volunteer writes their own response manually

System prompt includes candidate bio, all policy positions, campaign details, and tone guidelines. AI is instructed to return "NO_MATCH" rather than guess when knowledge is insufficient.

API key stored server-side in settings table. Claude Haiku used for cost efficiency (~$0.00025/reply).

### 6. Admin Session Dashboard

Real-time view of session progress:
- All volunteers with online/offline status
- Per-volunteer stats: sent count, active chats, remaining queue
- Session totals: total sent, total replies, remaining contacts
- Assignment mode dropdown (changeable mid-session)
- Reassign button for manual intervention if needed

## Data Model

### New Tables

```sql
CREATE TABLE p2p_sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,
  assignment_mode TEXT DEFAULT 'auto_split',  -- auto_split, manual, claim
  join_code TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- active, closed
  code_expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE p2p_volunteers (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_online INTEGER DEFAULT 1,
  joined_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE p2p_assignments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES p2p_sessions(id) ON DELETE CASCADE,
  volunteer_id INTEGER REFERENCES p2p_volunteers(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT DEFAULT 'pending',  -- pending, sent, in_conversation, completed, skipped
  assigned_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  completed_at TEXT
);

CREATE TABLE campaign_knowledge (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,  -- policy, bio, script, details
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE response_scripts (
  id INTEGER PRIMARY KEY,
  scenario TEXT NOT NULL,  -- e.g., supporter_positive, undecided_question, hostile
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Modified Tables

```sql
-- messages table: add session tracking
ALTER TABLE messages ADD COLUMN session_id INTEGER DEFAULT NULL;
ALTER TABLE messages ADD COLUMN volunteer_name TEXT DEFAULT NULL;
```

## New/Modified Files

| File | Change |
|------|--------|
| `db.js` | New tables + migrations |
| `routes/p2p.js` | P2P session, volunteer, assignment, and messaging endpoints |
| `routes/knowledge.js` | Campaign knowledge base CRUD |
| `routes/ai.js` | Claude API integration for response generation |
| `server.js` | Mount new routes |
| `public/index.html` | P2P Texting page + Knowledge Base page in sidebar |
| `package.json` | Add `@anthropic-ai/sdk` dependency |

## External Dependencies

- `@anthropic-ai/sdk` -- Anthropic Claude API client for AI response generation

## Volunteer Auth

No passwords. Lightweight access:
1. Admin creates session, gets 4-digit join code
2. Volunteer enters name + code on P2P page
3. System creates volunteer record, assigns queue
4. Code expires after 7 days; session stays open until admin closes

## API Endpoints (Planned)

### Sessions
- `POST /api/p2p/sessions` -- create session
- `GET /api/p2p/sessions` -- list sessions
- `GET /api/p2p/sessions/:id` -- session details + volunteer stats
- `PATCH /api/p2p/sessions/:id` -- update (close, change assignment mode)

### Volunteers
- `POST /api/p2p/join` -- volunteer joins with name + code
- `PATCH /api/p2p/volunteers/:id/status` -- toggle online/offline
- `GET /api/p2p/volunteers/:id/queue` -- get next contact in queue

### Messaging
- `POST /api/p2p/send` -- volunteer sends message to current contact
- `GET /api/p2p/conversations/:assignmentId` -- get conversation thread
- `POST /api/p2p/suggest-reply` -- get AI-generated reply suggestion

### Knowledge Base
- `GET /api/knowledge` -- list all knowledge entries
- `POST /api/knowledge` -- add entry
- `PUT /api/knowledge/:id` -- update entry
- `DELETE /api/knowledge/:id` -- delete entry

### Response Scripts
- `GET /api/scripts` -- list scripts
- `POST /api/scripts` -- add script
- `PUT /api/scripts/:id` -- update
- `DELETE /api/scripts/:id` -- delete

### Settings
- `GET /api/settings/:key` -- get setting
- `PUT /api/settings/:key` -- update setting (e.g., Anthropic API key)
