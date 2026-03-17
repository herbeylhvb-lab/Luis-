# Walkers Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace anonymous group-based block walking with persistent walker identities tied to candidates, with admin assignment, a walker portal, and leaderboard.

**Architecture:** New `walkers` table mirrors captains (code-based login, per-candidate). Admin creates walkers and assigns them to walks. All walkers on a walk see all addresses — first to knock gets credit. Walker portal shows personal stats + leaderboard.

**Tech Stack:** SQLite (better-sqlite3), Express.js, vanilla JS frontend (same patterns as captain portal)

---

### Task 1: Database Schema — walkers table + column additions

**Files:**
- Modify: `db.js` (after line ~847, near other walk_group_members addColumn calls)

**Step 1: Add walkers table and new columns to db.js**

**Step 2: Change max_walkers default to 10**

**Step 3: Verify DB starts clean**

Run: `node -e "require('./db'); console.log('DB OK')"`

**Step 4: Commit**

---

### Task 2: Backend — Walker CRUD endpoints

**Files:**
- Modify: `routes/candidates.js`

Add these endpoints:
- `GET /candidates/:id/walkers` — list walkers with stats (total_doors, total_contacts, walks_participated, last_active)
- `POST /candidates/:id/walkers` — create walker (name, phone -> generates 6-char code)
- `PUT /walkers/:id` — update walker (name, phone, is_active)
- `DELETE /walkers/:id` — delete walker
- `POST /walkers/login` — code-based login, returns walker + candidate info
- `GET /walkers/:id/dashboard` — personal stats, leaderboard (all candidate walkers ranked by doors), assigned active walks with progress

**Step 1: Add all walker routes to candidates.js**

**Step 2: Verify server starts**

**Step 3: Commit**

---

### Task 3: Backend — Assign walkers to walks

**Files:**
- Modify: `routes/walks.js`

**Step 1: Add assign/remove/list walker endpoints**
- `POST /walks/:id/assign-walker` — assign walker_id to walk (checks capacity <= 10)
- `POST /walks/:id/remove-walker` — remove walker from walk
- `GET /walks/:id/walkers` — list assigned walkers with per-walk stats

**Step 2: Update door-knock log endpoint to accept and save walker_id**
- Accept `walker_id` in request body
- Verify walker is assigned to walk
- Save walker_id in walk_attempts INSERT
- Update walk_group_members performance metrics using walker_id

**Step 3: Add walker-by-id volunteer endpoint**
- `GET /walks/:id/walker-by-id/:walkerId` — returns ALL addresses (no split), annotates which ones this walker knocked

**Step 4: Commit**

---

### Task 4: Walker Portal — `/walker.html`

**Files:**
- Create: `public/walker.html`

Create walker portal following captain.html patterns:
- Login screen: 6-char code input
- Dashboard: walker name, candidate name/office
- Stats cards: total doors, total contacts, contact rate %, walks participated
- Leaderboard table: rank, name, doors, contacts (current walker highlighted)
- Active walks: cards with walk name, progress bar (completed/total), my doors count, "Start Walking" button -> `/walk?walkId=X&walkerId=Y`

**Step 1: Create walker.html**

**Step 2: Add route redirect in server.js if needed**

**Step 3: Commit**

---

### Task 5: Walk UI — Auto-identify walker

**Files:**
- Modify: `public/walk.html`

**Step 1: Read walkerId from URL params**
- If `walkerId` present: skip name entry, set walkState.walkerId, hide walker name bar, show "Walking as [Name]"
- Fetch walk data via `/walks/:id/walker-by-id/:walkerId` (all addresses, no split)
- Send `walker_id` in all door-knock log requests

**Step 2: Keep backward compat**
- If no walkerId param, fall back to existing name-entry join-code flow

**Step 3: Commit**

---

### Task 6: Admin Portal — Walker management in candidate detail

**Files:**
- Modify: `public/index.html`

**Step 1: Add walkers section to showCandidateDetail()**
- After captains tree: "WALKERS" header + "+ New Walker" button
- Fetch GET /candidates/:id/walkers
- Render walker cards: name, code, phone, total_doors, total_contacts, last_active, active badge
- Edit name, activate/deactivate toggle, delete button per walker

**Step 2: Add walker assignment to walk detail**
- In block walks detail: "Assigned Walkers" section
- "Assign Walker" button -> dropdown of candidate's walkers -> POST assign
- Show each assigned walker: name, doors on this walk, last knock, remove button
- Add candidate selector since walks are global

**Step 3: Commit**

---

### Task 7: Integration test — full flow

1. Admin: create candidate -> create walker -> get code
2. Admin: create walk from precinct -> assign walker
3. Walker portal: login -> see walk -> "Start Walking"
4. Walk page: see all addresses -> knock door -> verify credit
5. Walker portal: refresh -> updated stats + leaderboard
6. Admin: view walk -> see walker progress

---

### Task 8: Push to both remotes

```
git push origin main
git push campaigntext main
```

---

## File Summary

| File | Task | Action |
|---|---|---|
| `db.js` | 1 | Add walkers table, walker_id columns |
| `routes/candidates.js` | 2 | Walker CRUD, login, dashboard endpoints |
| `routes/walks.js` | 3 | Assign/remove walkers, walker_id tracking, all-addresses endpoint |
| `public/walker.html` | 4 | New walker portal |
| `public/walk.html` | 5 | Auto-identify walker from URL params |
| `public/index.html` | 6 | Walker management + walk assignment in admin |
| `server.js` | 4 | Mount walker route if needed |
