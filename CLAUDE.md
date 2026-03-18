# CLAUDE.md - CampaignText HQ

## Project Overview

CampaignText HQ is a political campaign management platform for voter outreach, block walking, peer-to-peer texting, event management, and voter data analysis. Full-stack Node.js/Express application with SQLite database, deployed on Railway.

## Tech Stack

- **Runtime**: Node.js 20.x
- **Framework**: Express 4.18.2
- **Database**: SQLite 3 via better-sqlite3 (WAL mode, foreign keys enabled)
- **Frontend**: Static HTML SPA files served from `/public/` (no build step)
- **Auth**: Session-based with bcryptjs password hashing
- **SMS**: RumbleUp (pluggable provider architecture in `/providers/`)
- **AI**: Claude Haiku via `@anthropic-ai/sdk`
- **Integrations**: Google Sheets OAuth, QR code generation, email via nodemailer

## Commands

```bash
npm start          # Start server (node server.js), port from $PORT or 3000
npm run lint       # ESLint on *.js, routes/*.js, providers/*.js, middleware/*.js
npm run build      # No-op (no build step required)
```

There is no test framework (Jest/Mocha/etc). Tests in `/tests/` are standalone HTTP load/stress scripts run directly with `node tests/test-stress.js` against a running server at `http://127.0.0.1:3999`.

## Project Structure

```
server.js              # Main Express server, middleware setup, route mounting
db.js                  # Database schema initialization (44 tables), migrations
utils.js               # Phone normalization, code generation, template helpers

routes/                # API route handlers (18 files)
  auth.js              # Login, setup, session management
  candidates.js        # Candidate portal management
  captains.js          # Block captain system
  walks.js             # Block walking with GPS verification
  voters.js            # Voter database CRUD, import, search
  p2p.js               # Peer-to-peer texting sessions
  volunteers.js        # Unified volunteer identity
  events.js            # Event management & QR check-ins
  surveys.js           # Survey distribution & responses
  broadcast.js         # Broadcast messaging
  contacts.js          # Contact logging
  admin-lists.js       # Admin voter lists
  google.js            # Google Sheets/OAuth integration
  rumbleup.js          # SMS provider config
  email.js             # Email functionality
  ai.js                # Claude AI integration
  knowledge.js         # Campaign knowledge base

middleware/
  validate.js          # Request body validation (required, email, phone rules)

providers/
  index.js             # SMS provider abstraction layer
  rumbleup.js          # RumbleUp SMS API implementation

lib/
  google-sheets-sync.js  # Google Sheets OAuth & data sync

public/                # Frontend SPA HTML files (no JS build step)
scripts/               # Database import utilities (voter file imports)
tests/                 # Load/stress test scripts (25 files)
docs/plans/            # Feature design & implementation documents
```

## Code Conventions

### JavaScript Style
- ES2021, CommonJS modules (`require`/`module.exports`)
- `const` preferred over `let`; no `var`
- Strict equality (`===`) preferred; `eqeqeq: smart` allows `== null`
- Unused function args prefixed with `_` (e.g., `_next`)
- No `eval`, `implied-eval`, or `new Function`

### Express Patterns
- Routes use `asyncHandler(fn)` wrapper for Promise rejection handling
- Auth: `requireAuth(req, res, next)` middleware checks `req.session.userId`
- Validation: `validate({ field: rules.required })` middleware from `/middleware/validate.js`
- JSON error responses: `{ error: 'message' }` with appropriate HTTP status codes
- Rate limiting on sensitive endpoints (auth, sends, joins, webhooks)

### Database Patterns
- Raw SQL with `db.prepare().all()`, `.get()`, `.run()` — no ORM
- All queries use parameterized `?` placeholders (never string interpolation)
- Schema migrations use `addColumn()` helper that ignores "duplicate column" errors
- Batch dictionary lookups to avoid N+1 queries

### Phone Numbers
- Stored as 10-digit strings
- `normalizePhone()`, `phoneDigits()`, `toE164()` utilities in `utils.js`
- Validation regex: `^\+?[\d\s()-]{7,20}$`

### Join Codes
- `generateJoinCode()`: cryptographic 4-digit numeric
- `generateAlphaCode()`: 4-char alphanumeric (e.g., A3F8)
- Candidate codes: 8-char hex; Captain codes: 6-char hex
- All use `crypto.randomBytes`, never `Math.random()`

### Template Personalization
- `personalizeTemplate()` replaces merge tags: `{firstName}`, `{lastName}`, `{city}`, `{checkin_link}`
- Atomic replacement to prevent double-substitution

## Database

SQLite database with 44 tables. Schema defined in `db.js`. Key domains:
- **Messaging**: contacts, messages, opt_outs, activity_log, campaigns
- **Walking**: block_walks, walk_addresses, walker_locations
- **Voters**: voters, voter_contacts, election_votes, voter_checkins
- **P2P Texting**: p2p_sessions, p2p_volunteers, p2p_assignments, campaign_knowledge, response_scripts
- **Captains**: captains, captain_team_members, captain_lists, captain_list_voters
- **Events**: events, event_rsvps
- **Surveys**: surveys, survey_questions, survey_options, survey_sends, survey_responses
- **Auth**: users, sessions, settings

Database location priority: `$DATABASE_DIR` env > `/data` (cloud volume) > `./data` (local).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` or `development` (affects secure cookies) |
| `PORT` | Server port (default: 3000) |
| `APP_URL` | CORS whitelist origin |
| `DATABASE_DIR` | SQLite directory |
| `BASE_URL` | Base URL for QR check-in links |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SESSION_SECRET` | Express session secret (auto-generated if unset) |

SMS provider credentials are stored in the SQLite `settings` table, not env vars.

## Security Practices

- Helmet security headers (CSP disabled for inline SPA scripts)
- Rate limiting on auth, sends, webhooks, and join endpoints
- CORS restricted to `APP_URL`
- bcryptjs password hashing
- httpOnly, sameSite='strict' cookies (secure in production)
- Parameterized SQL queries throughout
- TCPA-compliant opt-out tracking

## Deployment

- **Primary**: Railway via Docker (`railway.toml`), persistent volume at `/data`
- **Docker**: Multi-stage build in `Dockerfile` (builder for native SQLite, slim production image)
- **Heroku-compatible**: `Procfile` with `web: node server.js`
- Health check endpoint: `GET /health`

## Multi-Role Architecture

The platform supports multiple user roles with separate portals:
- **Admin**: Full access via main dashboard (`/`)
- **Candidates**: Scoped portal (`/candidate.html`) with login codes
- **Captains**: Voter search & list building (`/captain.html`)
- **Walkers**: Block walking with leaderboard (`/walker.html`)
- **Volunteers/Texters**: P2P messaging (`/volunteer.html`, `/texter.html`)

Each role authenticates via session with role-specific checks in route handlers.
