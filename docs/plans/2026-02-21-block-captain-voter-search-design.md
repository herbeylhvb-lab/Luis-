# Block Captain Voter Search — Design

## Overview

Block Captains are volunteer leaders who build targeted voter contact lists. This feature adds a dedicated captain portal where captains search the voter database, discover household members, and organize voters into named lists. An admin tab manages captains and compiles all lists.

## Requirements

- Captains get a **permanent code** to access `/captain`
- Admin can **toggle captain access on/off**
- Captains can **search** the voter database by name, address, or phone
- **Household matching**: show other voters at the same address (street number + zip)
- Captains create **multiple named lists** (e.g., "Precinct 42", "Follow-up needed")
- Captains can **manage team members** and create lists on their behalf
- **Same voter on multiple lists** allowed — with notification ("Also on Maria's Precinct 42 list")
- Show **voting history** on each voter card if available
- **Admin "Block Captains" tab** shows all captains, teams, lists, overlap stats
- **No new dependencies** — pure SQLite + Express + vanilla JS

## Architecture

**Approach A** (selected): Dedicated `/captain` page — standalone SPA separate from `/volunteer`.

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `public/captain.html` | **Create** | Standalone captain portal (login, search, lists, team) |
| `routes/captains.js` | **Create** | API routes for captain CRUD, search, lists, household, team |
| `db.js` | Modify | Add 4 new tables + voting_history column on voters |
| `server.js` | Modify | Mount `/api` captains routes + serve `/captain` page |
| `public/index.html` | Modify | Add "Block Captains" admin tab |

---

## Database Schema

### New Tables

```sql
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
```

### Migration on voters table

```sql
ALTER TABLE voters ADD COLUMN voting_history TEXT DEFAULT '';
```

---

## API Routes (`routes/captains.js`)

### Admin endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/captains` | List all captains with stats (list counts, team size, voter counts) |
| POST | `/api/captains` | Create captain (auto-generates 6-char code) |
| PUT | `/api/captains/:id` | Update captain name, phone, email, toggle is_active |
| DELETE | `/api/captains/:id` | Delete captain (cascades lists) |

### Captain portal endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/captains/login` | Validate permanent code → return captain profile + team + lists |
| GET | `/api/captains/:id/search?q=` | Search voters by name, address, phone (LIKE queries, limit 50) |
| GET | `/api/captains/:id/household?voter_id=` | Get household members (street number + zip match) |
| GET | `/api/captains/:id/lists` | All lists (own + team members') with voter counts |
| POST | `/api/captains/:id/lists` | Create named list (optional team_member_id) |
| PUT | `/api/captains/:id/lists/:listId` | Rename list |
| DELETE | `/api/captains/:id/lists/:listId` | Delete list |
| POST | `/api/captains/:id/lists/:listId/voters` | Add voter → returns cross-list notifications |
| DELETE | `/api/captains/:id/lists/:listId/voters/:voterId` | Remove voter from list |
| GET | `/api/captains/:id/lists/:listId/voters` | Get all voters in a list |

### Team endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/captains/:id/team` | Add team member |
| DELETE | `/api/captains/:id/team/:memberId` | Remove team member |

### Household Matching Algorithm

Extract street number (first digits in address), then:
```sql
SELECT * FROM voters
WHERE zip = :zip
  AND address LIKE :streetNum || ' %'
  AND id != :currentVoterId
ORDER BY last_name, first_name
```

### Cross-List Notification Query

When adding a voter to a list:
```sql
SELECT cl.name AS list_name, c.name AS captain_name
FROM captain_list_voters clv
JOIN captain_lists cl ON clv.list_id = cl.id
JOIN captains c ON cl.captain_id = c.id
WHERE clv.voter_id = :voterId AND clv.list_id != :currentListId
```

Returns: `["Also on Maria Garcia's 'Precinct 42' list"]`

---

## Captain Portal UI (`public/captain.html`)

### Login Screen
- "Block Captain Portal" heading
- Single input: captain code
- POST `/api/captains/login` → if valid + active, show main interface

### Main Interface — Three-Panel Layout

**Left Sidebar:**
- Captain name + greeting
- "My Lists" — collapsible list of named lists with voter counts
- "Team Lists" — each team member with their lists
- "+ New List" button (assign to self or team member)
- "+ Add Team Member" button
- Selected list is highlighted

**Center Panel (Voter Search):**
- Search bar: name, address, or phone
- Voter cards showing: name, address, party, support level, phone, voter score
- Voting history line: "Voted: 2020 Gen, 2022 Pri, 2024 Gen"
- "Add to [current list]" button per voter
- Cross-list badges: amber "Also on Maria's Precinct 42"
- Household section below each voter: "Other people at this address:" with individual Add buttons

**Right Panel (Current List View):**
- Voters in selected list
- Remove (×) button per voter
- Count header: "23 voters in Precinct 42"
- Cross-list badges visible here too

### Style
- Matches existing app (dark sidebar, clean cards)
- Amber/orange accent for captain elements

---

## Admin "Block Captains" Tab (`public/index.html`)

### Tab Contents

**Header:** "Block Captains" + "+ New Captain" button

**Summary stats:**
- Total captains (active/inactive)
- Total lists
- Total unique voters across all lists
- Overlap count (voters on 2+ lists)

**Captain cards:**
- Name, code, phone, email
- Team size, list count, voter count
- Active/inactive status badge
- [View Lists] — expands to show all lists with voter counts and details
- [Manage Team] — add/remove team members
- [Toggle On/Off] — enable/disable captain access

---

## Verification Steps

1. Create a captain in admin → confirm code generated
2. Go to `/captain` → enter code → verify login works
3. Search for a voter → verify results + household members shown
4. Add voter to a list → confirm cross-list notification if applicable
5. Create team member → create list on their behalf
6. Toggle captain inactive → verify they can't log in
7. Admin tab shows all lists compiled with stats
