# Walkers Feature Design

## Problem
Block walk volunteers currently have no persistent identity. Each time someone joins a walk they enter a name — no way to track individual progress across walks or verify who's active.

## Solution
Walkers as first-class entities (like captains), tied to a candidate, with their own portal and leaderboard.

## Data Model

### New `walkers` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| candidate_id | INTEGER FK | Which candidate they belong to |
| name | TEXT | Walker's name |
| phone | TEXT | Phone number |
| code | TEXT UNIQUE | 6-char login code |
| is_active | INTEGER | Default 1 |
| created_at | TEXT | datetime('now') |

### Changes to existing tables
- `block_walks.max_walkers` default → 10
- `walk_group_members` gets `walker_id INTEGER` FK to walkers
- `walk_attempts` gets `walker_id INTEGER` FK to walkers (for credit tracking)

## Key Design Decisions

### No address splitting
All walkers on a walk see all addresses. First to knock gets credit. Encourages teamwork and natural competition.

### Admin-assigned only
Admin creates walkers per candidate and assigns them to walks. No self-registration or self-join.

### Walker portal (`/walker?code=XXXX`)
- Login with 6-char code
- Dashboard: personal stats (total doors, contacts, walks, contact rate)
- Leaderboard: ranked among candidate's walkers by doors knocked
- Active walks: cards with progress + "Start Walking" button → `/walk` UI

### Admin portal changes
- Walker management in candidate detail (alongside captains): create, edit, activate/deactivate
- Walk detail: assign walkers (up to 10), see per-walker progress and last active time

### Walk UI changes
- Walker auto-identified by walker_id (no "Enter your name" step)
- Walker identity passed to `/walk` page from walker portal

### Groups deprecated
Walker system replaces groups. `/group.html` replaced by `/walker.html`.

## Files to modify
| File | Changes |
|---|---|
| `db.js` | New walkers table, alter walk_group_members, alter walk_attempts |
| `routes/walks.js` | Assign walkers endpoint, update join/log to use walker_id |
| `routes/candidates.js` | CRUD for walkers under candidates |
| `public/walker.html` | New walker portal (replaces group.html) |
| `public/walk.html` | Auto-identify walker, remove name entry |
| `public/index.html` | Walker management in candidate detail, walker assignment on walks |
| `server.js` | Mount walker routes if needed |
