# Block Captain Voter Search — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Block Captain system where volunteer leaders search voters, discover households, build named lists, and manage teams — with a dedicated captain portal at `/captain` and an admin tab in the main SPA.

**Architecture:** New SQLite tables for captains/lists/teams, a new Express route file (`routes/captains.js`), a standalone captain HTML page, and a new admin tab. No new dependencies.

**Tech Stack:** SQLite (better-sqlite3), Express, vanilla JS/HTML/CSS

---

### Task 1: Database Schema — Add captain tables + voting_history migration

**Files:**
- Modify: `db.js` (insert after the voter_checkins table block around line 241, before the `const { randomBytes }` line)

**Step 1: Add the 4 captain tables + voting_history migration to `db.js`**

Insert this block after the `voter_checkins` table section and before the `const { randomBytes }` line:

```javascript
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
try { db.exec("ALTER TABLE voters ADD COLUMN voting_history TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
```

**Step 2: Verify server starts**

Run the server and confirm the 4 new captain tables exist in the database.

**Step 3: Commit**

Message: `feat: add block captain database tables + voting_history column`

---

### Task 2: Backend API — Create `routes/captains.js`

**Files:**
- Create: `routes/captains.js`

**Step 1: Create the full route file**

Create `routes/captains.js` with all endpoints following the same pattern as `routes/voters.js`. The file needs:

- `generateCaptainCode()` — generates 6-char hex code via `crypto.randomBytes(3)`
- `extractStreetNumber(address)` — regex extracts leading digits for household matching

**Admin endpoints:**
- `GET /captains` — list all captains with stats (join team/lists/voters for counts + overlap stats)
- `POST /captains` — create captain (auto-gen unique code, retry on collision)
- `PUT /captains/:id` — update name/phone/email/is_active
- `DELETE /captains/:id` — delete with cascade

**Captain portal endpoints:**
- `POST /captains/login` — validate code, return captain + team + lists if active
- `GET /captains/:id/search?q=` — search voters (LIKE on name/address/phone, limit 50) + cross-list info
- `GET /captains/:id/household?voter_id=` — extract street number from voter address, query WHERE zip = ? AND address LIKE streetNum + ' %' AND id != voter_id

**List endpoints:**
- `GET /captains/:id/lists` — all lists with voter counts + team member names
- `POST /captains/:id/lists` — create named list (optional team_member_id)
- `PUT /captains/:id/lists/:listId` — rename
- `DELETE /captains/:id/lists/:listId` — delete (cascades via FK)
- `GET /captains/:id/lists/:listId/voters` — voters in list with cross-list badges
- `POST /captains/:id/lists/:listId/voters` — add voter, return cross-list notifications
- `DELETE /captains/:id/lists/:listId/voters/:voterId` — remove voter

**Team endpoints:**
- `POST /captains/:id/team` — add team member
- `DELETE /captains/:id/team/:memberId` — remove team member

**Step 2: Verify syntax is valid**

Require the module in node and confirm no errors.

**Step 3: Commit**

Message: `feat: add block captain API routes (CRUD, search, lists, household, team)`

---

### Task 3: Mount routes in `server.js`

**Files:**
- Modify: `server.js` (2 insertions)

**Step 1: Add the route mount**

After line 23 (`app.use('/api', require('./routes/p2p'));`), add:

```javascript
app.use('/api', require('./routes/captains'));
```

**Step 2: Add the `/captain` page route**

After line 82 (the `/volunteer` route), add:

```javascript
// Standalone Block Captain portal (shareable link)
app.get('/captain', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'captain.html'));
});
```

**Step 3: Verify server starts**

Start the server and confirm it runs on port 3000 without errors.

**Step 4: Commit**

Message: `feat: mount block captain routes and /captain page`

---

### Task 4: Captain Portal Frontend — `public/captain.html`

**Files:**
- Create: `public/captain.html`

**Step 1: Create the standalone captain portal page**

Create `public/captain.html` — a self-contained SPA matching the app's dark theme (`#0f172a` bg, `#1e293b` cards, `#818cf8` primary accent, `#f59e0b` amber for captain-specific elements).

**Login screen:**
- "Block Captain Portal" heading
- Single input for captain code
- POST `/api/captains/login` — if valid + active, transition to main interface
- Store captain data in a `captainState` variable

**Main interface — three-panel layout:**

Left sidebar (~250px):
- Captain name greeting
- "My Lists" section — collapsible named lists with voter counts, click to select
- "Team Lists" section — each team member with their lists
- "+ New List" button — modal to enter name + optional team member assignment
- "+ Add Team Member" button

Center panel (flex:1):
- Search bar at top — oninput debounced search (300ms) via GET `/api/captains/:id/search?q=`
- Voter cards showing: name, address, city, zip, party badge, support badge, phone, voter_score
- Voting history line: "Voted: 2020 Gen, 2022 Pri, 2024 Gen" (only if non-empty)
- "Add to [selected list name]" button (disabled until a list is selected)
- Cross-list amber badges: "Also on Maria's Precinct 42"
- Household section: GET `/api/captains/:id/household?voter_id=` — "Other people at this address:" with individual Add buttons

Right panel (~350px):
- Header: "23 voters in Precinct 42" (current list name + count)
- Voter list for selected list via GET `/api/captains/:id/lists/:listId/voters`
- Each voter has remove (x) button
- Cross-list badges visible here too

**Key JS functions:**
- `loginCaptain()` — POST login, store state, render main UI
- `searchVoters()` — debounced search, render results with household auto-load
- `loadHousehold(voterId, containerEl)` — fetch + render household members
- `selectList(listId)` — highlight in sidebar, load right panel
- `addVoterToList(voterId)` — POST add, show notification if cross-list, refresh counts
- `removeVoterFromList(voterId)` — DELETE, refresh
- `createList()` — modal + POST
- `addTeamMember()` — prompt + POST
- `refreshSidebar()` — reload lists with voter counts
- `logoutCaptain()` — clear state, show login screen

**Step 2: Test in browser**

Open http://localhost:3000/captain — verify login screen renders with dark theme.

**Step 3: Commit**

Message: `feat: add block captain portal page with search, lists, household matching`

---

### Task 5: Admin "Block Captains" Tab — Modify `public/index.html`

**Files:**
- Modify: `public/index.html` (3 insertion points)

**Step 1: Add nav item to sidebar**

After line 152 (the `knowledge` nav-item), before `</div>` at line 153, insert:

```html
    <div class="sidebar-section">Captains</div>
    <div class="nav-item" data-page="captains"><span class="icon">&#128081;</span><span>Block Captains</span></div>
```

**Step 2: Add the page section**

After line 711 (the closing `</div>` of page-checkins), before the content `</div>`, insert the Block Captains page HTML with:
- Stats grid: Active Captains, Total Lists, Unique Voters, Overlap count
- "+ New Captain" button + inline form (name, phone, email)
- Captain cards: name, code (amber highlighted), phone, email, team/list/voter counts, Active/Inactive badge
- Expandable lists section per captain showing all lists with voter counts
- Expandable team section per captain
- Toggle Active/Inactive button
- Delete button with confirmation

**Step 3: Add nav handler**

In the nav click handler (around line 784), after the checkins handler, add:

```javascript
    if (page === 'captains') loadCaptains();
```

**Step 4: Add JavaScript functions**

At end of the script block, add:
- `loadCaptains()` — GET `/api/captains`, update stats, render cards
- `renderCaptainCards(captains)` — generate HTML for each captain card with lists/team/stats
- `showNewCaptainModal()` — show inline form
- `createCaptain()` — POST, alert with generated code, reload
- `toggleCaptain(id, newState)` — PUT is_active, reload
- `deleteCaptain(id)` — DELETE with confirm, reload

**Step 5: Test the admin tab**

Open http://localhost:3000 — click "Block Captains" in sidebar — verify it renders. Create a captain, verify card shows with code.

**Step 6: Commit**

Message: `feat: add Block Captains admin tab to main SPA`

---

### Task 6: End-to-End Verification

**Step 1: Start the server and verify the full flow**

1. Admin: Create a captain → note the code
2. Captain portal (/captain): Login with code → search voters → verify household matching
3. Create lists → add voters → verify cross-list notifications
4. Create team member → create list on their behalf
5. Admin: Verify all data compiled (stats, lists, team details)
6. Admin: Toggle captain off → verify login fails with "access disabled" message
7. Admin: Toggle back on → verify login works again

**Step 2: Final commit + push**

Stage all files, commit with message: `feat: block captain voter search — complete feature`, then push to origin main.

---

## File Summary

| # | File | Action | Task |
|---|------|--------|------|
| 1 | `db.js` | Modify | Task 1 — Add 4 captain tables + voting_history |
| 2 | `routes/captains.js` | Create | Task 2 — All captain API endpoints |
| 3 | `server.js` | Modify | Task 3 — Mount routes + serve /captain |
| 4 | `public/captain.html` | Create | Task 4 — Captain portal frontend |
| 5 | `public/index.html` | Modify | Task 5 — Admin Block Captains tab |
