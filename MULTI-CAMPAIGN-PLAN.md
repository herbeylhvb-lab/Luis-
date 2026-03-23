# Multi-Campaign Platform — Campaign Text HQ

## Context
Luis runs political campaigns and wants to manage **multiple candidates** from one platform. The voter registration file (public record) is shared, but each candidate's operational data (lists, contacts, messages, walks, events) is isolated. Luis is the super-admin who can see everything and switch between campaigns. Each candidate admin only sees their own campaign.

**Single deployment** at villarrealjr.com — candidates log into the same app with separate accounts and see only their campaign. No need for separate Railway instances.

---

## Phase 1: Database & Migration (~4 files)

### 1a. New tables — `db.js`

**`political_campaigns`** (named to avoid conflict with existing `campaigns` SMS-batch table):
- id, name, slug (unique), candidate_name, description, is_active, created_at

**`user_campaigns`** junction table:
- id, user_id → users, campaign_id → political_campaigns, role, is_default
- UNIQUE(user_id, campaign_id)

**`users` column:** `is_super_admin INTEGER DEFAULT 0`

### 1b. Add `campaign_id` to 14 tables — `db.js`
Using existing `addColumn()` pattern:
- contacts, messages, campaigns (SMS batches), activity_log
- block_walks, events, admin_lists, captains
- p2p_sessions, campaign_knowledge, response_scripts, email_campaigns
- voter_contacts (touchpoint logs are per-campaign)
- Plus indexes on each

**NOT scoped** (stay shared): voters, users, sessions, opt_outs, settings (global keys)

### 1c. Backfill migration — `db.js`
- Create "Default Campaign" if none exists (slug: `default`)
- `UPDATE <table> SET campaign_id = 1 WHERE campaign_id IS NULL` for all 14 tables
- Mark first user as `is_super_admin = 1`
- Link first user to default campaign via `user_campaigns`
- All idempotent — safe to re-run

---

## Phase 2: Middleware & Auth (~3 files)

### 2a. Session changes — `routes/auth.js`
After login, load user's default campaign into session:
- `req.session.campaignId` = their default campaign
- `req.session.isSuperAdmin` = from users table
- Update `/api/auth/status` to return: `isSuperAdmin`, `activeCampaignId`, `activeCampaignName`, `campaigns[]`

### 2b. New middleware — `server.js`
`requireCampaign(req, res, next)`:
- Extracts campaign from `X-Campaign-Id` header or session
- Super-admin can access any campaign
- Regular admin: checks `user_campaigns` table for access
- Sets `req.campaignId` for all downstream routes
- Applied after `requireAuth` on `/api/` routes

### 2c. Campaign switching — `routes/auth.js`
`POST /api/auth/switch-campaign` — sets `req.session.campaignId`, reloads page

---

## Phase 3: Route Scoping (~12 files)

Mechanical pattern applied to every route file:

**READ:** Add `WHERE campaign_id = ?` with `req.campaignId`
**WRITE:** Add `campaign_id` to INSERT with `req.campaignId`
**UPDATE/DELETE:** Add `AND campaign_id = ?` for ownership check

Files (in order of complexity):
1. `routes/contacts.js` (55 lines, 4 endpoints) — start here as proof
2. `routes/admin-lists.js` (71 lines) — lists join voters (shared)
3. `routes/knowledge.js` (71 lines) — knowledge + scripts
4. `routes/email.js` (104 lines) — email campaigns
5. `routes/events.js` (197 lines) — events + RSVPs
6. `routes/walks.js` (343 lines) — walks + addresses
7. `routes/p2p.js` (287 lines) — P2P sessions + volunteers
8. `routes/captains.js` (381 lines) — captains + lists
9. `routes/voters.js` (534 lines) — only voter_contacts need scoping, voters stay shared
10. `routes/ai.js` (95 lines) — scope knowledge/scripts lookup
11. `server.js` inline endpoints — stats, activity, send, reply, incoming webhook
12. `routes/google.js` — Sheets sync scoped to active campaign

**Special case — Twilio `/incoming` webhook:**
- Match incoming phone to `contacts` table to find `campaign_id`
- If not found, store with default campaign

---

## Phase 4: Campaign Management UI (~2 files)

### 4a. New file — `routes/campaigns.js`
Super-admin only endpoints:
- `GET /api/political-campaigns` — list all campaigns
- `POST /api/political-campaigns` — create campaign
- `PUT /api/political-campaigns/:id` — update
- `DELETE /api/political-campaigns/:id` — delete
- `POST /api/political-campaigns/:id/users` — add user to campaign
- `DELETE /api/political-campaigns/:id/users/:userId` — remove
- `GET /api/users` — list all users (super-admin)
- `POST /api/users` — create user account

### 4b. UI changes — `public/index.html`
- **Campaign switcher dropdown** in topbar (super-admin only)
- **New "Campaigns" nav item** under System section (super-admin only)
- **Campaign management page**: create/edit campaigns, manage users
- Conditional visibility based on `isSuperAdmin` flag from auth status

### 4c. Login flow — `public/login.html`
- After login, if user has multiple campaigns → show campaign picker
- If only one campaign → auto-select and redirect

---

## Files Summary

| File | Action | What |
|------|--------|------|
| `db.js` | Modify | 2 new tables, 14 addColumn calls, backfill migration |
| `server.js` | Modify | Add requireCampaign middleware, scope inline endpoints |
| `routes/auth.js` | Modify | Campaign in session, switch endpoint, status update |
| `routes/campaigns.js` | **Create** | Campaign + user management CRUD (~150 lines) |
| `routes/contacts.js` | Modify | Add campaign_id to all queries |
| `routes/admin-lists.js` | Modify | Add campaign_id to all queries |
| `routes/knowledge.js` | Modify | Add campaign_id to all queries |
| `routes/email.js` | Modify | Add campaign_id to all queries |
| `routes/events.js` | Modify | Add campaign_id to all queries |
| `routes/walks.js` | Modify | Add campaign_id to all queries |
| `routes/p2p.js` | Modify | Add campaign_id to all queries |
| `routes/captains.js` | Modify | Add campaign_id to all queries |
| `routes/voters.js` | Modify | Scope voter_contacts only |
| `routes/ai.js` | Modify | Scope knowledge/scripts lookup |
| `routes/google.js` | Modify | Scope Sheets sync per-campaign |
| `public/index.html` | Modify | Campaign switcher + management page |
| `public/login.html` | Modify | Campaign picker after login |

---

## Key Design Decisions
- **`voters` table stays shared** — voter registration is public record, all campaigns search same data
- **`voter_contacts` is per-campaign** — door-knock logs are campaign-private
- **Single deployment** — no separate Railway instances, just role-based access
- **`political_campaigns` table name** — avoids conflict with existing `campaigns` (SMS batches)
- **Super-admin flag on users** — simpler than a full role system
- **Campaign context via middleware** — every authenticated request gets `req.campaignId`
- **Backward compatible** — all existing data assigned to "Default Campaign", app works identically until new campaigns are created

---

## Verification
1. Deploy → existing app works exactly as before (all data in "Default Campaign")
2. Create new campaign as super-admin → appears in switcher
3. Create user for new campaign → they log in, see only their data
4. Switch campaigns as super-admin → dashboard/data refreshes
5. Candidate admin tries to access other campaign → 403 denied
6. Both campaigns can search the same voter file
7. Each campaign's lists, contacts, walks, events are isolated

---

## How to Implement
Tell Claude: "Implement the multi-campaign platform using the plan in MULTI-CAMPAIGN-PLAN.md — start with Phase 1"
Then proceed phase by phase. Each phase can be done in a single session.
