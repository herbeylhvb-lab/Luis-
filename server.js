const express = require('express');
const compression = require('compression');
const cors    = require('cors');
const path    = require('path');
const session = require('express-session');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db      = require('./db');
const { getProvider, getProviderByName, getActiveProviderName, setActiveProvider, listProviders } = require('./providers');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // disabled for inline scripts in SPA
  crossOriginEmbedderPolicy: false
}));

// Gzip/brotli compression — cuts ~497KB index.html to ~60KB over the wire
app.use(compression());

// CORS — restrict to own origin (set APP_URL env var in production)
const ALLOWED_ORIGINS = [
  process.env.APP_URL,
].filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) console.warn('[WARN] APP_URL env var not set — CORS will allow all origins. Set APP_URL in production.');

app.use(cors({
  credentials: true,
  origin: function(origin, callback) {
    // Allow same-origin requests (no origin header)
    if (!origin) return callback(null, true);
    // Enforce APP_URL origin whitelist; reject unknown origins in production
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(null, false);
  }
}));

// Rate limiting on sensitive endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later.' } });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many send requests, slow down.' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Rate limit exceeded.' } });
const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many join attempts.' } });

// Bulk import paths get a higher body limit (50mb); all others get 2mb
const BULK_PATHS = ['/api/voters/import', '/api/voters/import-canvass', '/api/voters/import-voter-file', '/api/voters/import-county-file', '/api/voters/import-county-batch', '/api/election-votes/import', '/api/election-votes/import-turnout', '/api/early-voting/import', '/api/voters/enrich', '/api/events'];
const bulkJsonParserEarly = express.json({ limit: '50mb' });
const defaultJsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (BULK_PATHS.some(p => req.path.startsWith(p))) return bulkJsonParserEarly(req, res, next);
  defaultJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Generate a stable session secret and store it in the DB so it survives restarts
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (row) return row.value;
  const secret = require('crypto').randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
  return secret;
}

// Trust proxy (Railway, Heroku, etc.) so secure cookies work
app.set('trust proxy', 1);

// Session middleware
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Auth routes (must be before auth middleware) — rate limited
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/setup', authLimiter);
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/google'));

// Login page (public)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Auth middleware — protect admin routes, always require login
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();

  // API requests get 401 (except setup endpoint when no users exist)
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  // Page requests redirect to login
  return res.redirect('/login');
}

// Public routes (no auth needed)
// Campaign website at root (public, no auth)
app.use('/site', express.static(path.join(__dirname, 'public', 'site'), { maxAge: '1h' }));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'site', 'index.html'));
});
// Serve static files ONLY for public assets (CSS, JS, images) — cache 7 days
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '7d' }));
// Public pages that don't need auth
app.get('/volunteer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'volunteer.html')));
app.get('/walk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'walk.html')));
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
app.get('/checkin/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/v/:token', (req, res) => {
  const eventId = req.query.e;
  const voter = db.prepare("SELECT id, first_name, last_name, phone FROM voters WHERE qr_token = ?").get(req.params.token);

  // Auto-check-in if we have a voter and event
  if (voter && eventId) {
    const event = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId);
    if (event) {
      const existing = db.prepare('SELECT id FROM voter_checkins WHERE voter_id = ? AND event_id = ?').get(voter.id, event.id);
      if (!existing) {
        db.transaction(() => {
          db.prepare('INSERT INTO voter_checkins (voter_id, event_id) VALUES (?, ?)').run(voter.id, event.id);
          db.prepare(
            'INSERT INTO voter_contacts (voter_id, contact_type, result, notes, contacted_by) VALUES (?, ?, ?, ?, ?)'
          ).run(voter.id, 'Event', 'Attended', 'Auto checked in via link: ' + event.title, 'Link Check-In');
          db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
            voter.first_name + ' ' + voter.last_name + ' auto checked in to: ' + event.title
          );
          // Update RSVP status to attended
          if (voter.phone) {
            const normalizedPhone = voter.phone.replace(/\D/g, '');
            db.prepare("UPDATE event_rsvps SET rsvp_status = 'attended', checked_in_at = datetime('now') WHERE event_id = ? AND contact_phone = ?")
              .run(event.id, normalizedPhone);
          }
        })();
      }
    }
  }

  return res.redirect('https://villarrealjr.com');
});
app.get('/captain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
app.get('/candidate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'candidate.html')));
app.get('/group', (req, res) => res.sendFile(path.join(__dirname, 'public', 'group.html')));
app.get('/walker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'walker.html')));
app.get('/texter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'texter.html')));

// Public API routes (volunteer/walker endpoints that don't need admin auth)
const publicApiPaths = [
  '/api/config/public',
  '/api/walks/all-results-map',
  '/api/walks/civic-info',
  '/api/walks/join',
  '/api/auth/',
  '/api/voters/qr/',
  '/api/voters/checkins/today-events',
];

app.use((req, res, next) => {
  // Allow public API paths
  for (const p of publicApiPaths) {
    if (req.path.startsWith(p)) return next();
  }
  // Allow volunteer walk endpoints
  if (req.path.match(/^\/api\/walks\/\d+\/volunteer/) ||
      req.path.match(/^\/api\/walks\/\d+\/walker\//) ||
      req.path.match(/^\/api\/walks\/\d+\/group/) ||
      req.path.match(/^\/api\/walks\/\d+\/addresses\/\d+\/log/) ||
      req.path.match(/^\/api\/walks\/\d+\/route/) ||
      req.path.match(/^\/api\/walks\/\d+\/location/) ||
      req.path.match(/^\/api\/walks\/\d+\/script/) ||
      req.path.match(/^\/api\/walks\/\d+\/walkers/) ||
      req.path.match(/^\/api\/walks\/\d+\/map-data/) ||
      req.path.match(/^\/api\/walks\/\d+\/live-status/) ||
      req.path.match(/^\/api\/walks\/\d+\/geocode/)) {
    return next();
  }
  // Allow P2P volunteer endpoints (used by volunteer.html without admin auth)
  if (req.path.match(/^\/api\/p2p\/join/) ||
      req.path.match(/^\/api\/p2p\/sessions\/\d+\/volunteer/) ||
      req.path.match(/^\/api\/p2p\/volunteers\/\d+\/queue/) ||
      req.path.match(/^\/api\/p2p\/conversations\/\d+/) ||
      req.path.match(/^\/api\/p2p\/assignments\/\d+/) ||
      req.path === '/api/p2p/send' ||
      req.path === '/api/p2p/suggest-reply' ||
      req.path === '/api/p2p/review-reply' ||
      req.path === '/api/texting-volunteers/login' ||
      req.path.match(/^\/api\/texting-volunteers\/\d+\/dashboard/) ||
      req.path === '/api/volunteers/login' ||
      req.path === '/api/volunteers/register' ||
      req.path === '/api/volunteers/create-walk' ||
      req.path.match(/^\/api\/volunteers\/\d+\/dashboard/) ||
      req.path === '/reply') {
    return next();
  }
  // Allow captain portal endpoints (used by captain.html without admin auth)
  if (req.path.match(/^\/api\/captains\/login/) ||
      req.path.match(/^\/api\/captains\/\d+\/refresh/) ||
      req.path.match(/^\/api\/captains\/\d+\/lists/) ||
      req.path.match(/^\/api\/captains\/\d+\/assigned-lists/) ||
      req.path.match(/^\/api\/captains\/\d+\/team/) ||
      req.path.match(/^\/api\/captains\/\d+\/search/) ||
      req.path.match(/^\/api\/captains\/\d+\/household/) ||
      req.path === '/api/voters-cities') {
    return next();
  }
  // Allow candidate portal endpoints (used by candidate.html without admin auth)
  if (req.path.match(/^\/api\/candidates\/login/) ||
      req.path.match(/^\/api\/candidates\/\d+\/portal/) ||
      req.path.match(/^\/api\/candidates\/\d+\/search/) ||
      req.path.match(/^\/api\/candidates\/\d+\/household/) ||
      req.path.match(/^\/api\/candidates\/\d+\/lists/) ||
      req.path.match(/^\/api\/candidates\/\d+\/captain-lists/) ||
      req.path.match(/^\/api\/candidates\/\d+\/master-list/)) {
    return next();
  }
  // Allow group portal endpoints (used by group.html without admin auth)
  if (req.path.match(/^\/api\/groups\/login/) ||
      req.path.match(/^\/api\/groups\/\d+\/walks/)) {
    return next();
  }
  // Allow walker portal endpoints (used by walker.html without admin auth)
  if (req.path.match(/^\/api\/walkers\/login/) ||
      req.path.match(/^\/api\/walkers\/\d+\/dashboard/) ||
      req.path.match(/^\/api\/walks\/\d+\/walker-by-id\//)) {
    return next();
  }
  // Allow messaging provider webhook
  if (req.path === '/incoming') return next();
  // Allow health check
  if (req.path === '/health') return next();
  // Allow login page
  if (req.path === '/login') return next();
  // Allow static login page assets
  if (req.path === '/login.html') return next();
  // Allow root campaign site and /site assets
  if (req.path === '/' || req.path.startsWith('/site')) return next();
  // Allow /app (handles its own auth redirect)
  if (req.path === '/app') return next();
  // Allow event flyer images (needed for MMS — RumbleUp fetches these URLs)
  if (req.path.match(/^\/api\/events\/\d+\/flyer/)) return next();
  // Allow voter check-in links (QR code destinations)
  if (req.path.startsWith('/v/')) return next();
  // Debug sync-status requires admin auth (contains phone numbers)
  // Everything else requires auth
  requireAuth(req, res, next);
});

// Serve static files for authenticated users (ETag enabled by default for cache validation)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));

const { generateJoinCode, asyncHandler, phoneDigits, personalizeTemplate } = require('./utils');

const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

// --- Mount API routes ---

app.use('/api', require('./routes/contacts'));
// Rate limit public join endpoints
app.use('/api/p2p/join', joinLimiter);
app.use('/api/walks/join', joinLimiter);
app.use('/api', require('./routes/walks'));
app.use('/api', require('./routes/voters'));
app.use('/api', require('./routes/events'));
app.use('/api', require('./routes/knowledge'));
app.use('/api', require('./routes/ai'));
app.use('/api', require('./routes/p2p'));
app.use('/api', require('./routes/volunteers'));
app.use('/api', require('./routes/captains'));
app.use('/api', require('./routes/candidates'));
app.use('/api', require('./routes/email'));
app.use('/api', require('./routes/admin-lists'));
app.use('/api', require('./routes/groups'));
app.use('/api', require('./routes/surveys'));
app.use('/api', require('./routes/broadcast'));
app.use('/api', require('./routes/rumbleup'));

// --- Core endpoints ---

app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (_err) {
    res.status(503).json({ status: 'error', message: 'Database unavailable.' });
  }
});

// Campaign HQ dashboard — accessible at /app (requires login)
app.get('/app', (req, res) => {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login');
  }
});

// --- Stats ---
const _statsQueryDefault = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM contacts) as contacts,
    (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') as sent,
    (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') as responses,
    (SELECT COUNT(*) FROM opt_outs) as optedOut,
    (SELECT COUNT(*) FROM block_walks) as walks,
    (SELECT COUNT(*) FROM walk_addresses WHERE result != 'not_visited') as doorsKnocked,
    (SELECT COUNT(*) FROM voters) as voters,
    (SELECT COUNT(*) FROM events WHERE status = 'upcoming') as upcomingEvents,
    (SELECT COUNT(*) FROM voters WHERE support_level IN ('strong_support', 'lean_support')) as supporters,
    (SELECT COUNT(*) FROM voters WHERE support_level = 'undecided') as undecided
`);
app.get('/api/stats', (req, res) => {
  const { race_col, race_val, list_id } = req.query;
  const validCols = ['navigation_port','port_authority','city_district','school_district','college_district','state_rep','state_senate','us_congress','county_commissioner','justice_of_peace'];

  // If no filters, use fast prepared statement
  if (!race_col && !list_id) return res.json(_statsQueryDefault.get());

  let voterFilter = '';
  const vParams = [];

  if (race_col && validCols.includes(race_col) && race_val) {
    voterFilter += ` AND ${race_col} = ?`;
    vParams.push(race_val);
  }
  // Filter voters by admin_list membership (My Universes)
  if (list_id) {
    voterFilter += ' AND id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)';
    vParams.push(list_id);
  }

  const stats = _statsQueryDefault.get(); // base stats (messages, events, etc. aren't filtered)
  // Override voter-related stats with filtered versions
  stats.voters = db.prepare(`SELECT COUNT(*) as c FROM voters WHERE 1=1${voterFilter}`).get(...vParams).c;
  stats.supporters = db.prepare(`SELECT COUNT(*) as c FROM voters WHERE support_level IN ('strong_support','lean_support')${voterFilter}`).get(...vParams).c;
  stats.undecided = db.prepare(`SELECT COUNT(*) as c FROM voters WHERE support_level = 'undecided'${voterFilter}`).get(...vParams).c;
  // Doors knocked for voters in this list
  if (list_id) {
    stats.doorsKnocked = db.prepare(`SELECT COUNT(*) as c FROM walk_addresses WHERE result != 'not_visited' AND voter_id IN (SELECT voter_id FROM admin_list_voters WHERE list_id = ?)`).get(list_id).c;
  }
  res.json(stats);
});

// --- Activity log ---
// Public config — non-sensitive keys for frontend Google API usage
app.get('/api/config/public', (req, res) => {
  res.json({ mapsKey: process.env.GOOGLE_GEOCODE_KEY || '' });
});

app.get('/api/activity', (req, res) => {
  const logs = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 50').all();
  res.json({ logs });
});

app.post('/api/activity', (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required (string).' });
  if (message.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars).' });
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(message);
  res.json({ success: true });
});

// --- Sentiment stats (single query) ---
const _sentimentQuery = db.prepare(`
  SELECT
    SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
    SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
    SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral
  FROM messages
`);
app.get('/api/stats/sentiment', (req, res) => {
  const stats = _sentimentQuery.get();
  res.json({ positive: stats.positive || 0, negative: stats.negative || 0, neutral: stats.neutral || 0 });
});


// --- Live walkers across all walks (aggregated per walker) ---
app.get('/api/stats/live-walkers', (req, res) => {
  // Get all walks that have group members
  const walks = db.prepare("SELECT id, name, status FROM block_walks WHERE id IN (SELECT DISTINCT walk_id FROM walk_group_members)").all();
  const walkMap = {};
  for (const w of walks) walkMap[w.id] = w;

  // Get all group memberships with activity, aggregate per unique walker
  const allMembers = db.prepare(`
    SELECT wgm.walker_name, wgm.walk_id, wgm.doors_knocked, wgm.contacts_made,
           wgm.first_knock_at, wgm.last_knock_at, wgm.joined_at
    FROM walk_group_members wgm
    ORDER BY wgm.last_knock_at DESC NULLS LAST
  `).all();

  const walkerAgg = {};
  for (const m of allMembers) {
    const walk = walkMap[m.walk_id];
    if (!walk) continue;

    const name = m.walker_name;
    if (!walkerAgg[name]) {
      walkerAgg[name] = {
        walker_name: name,
        total_doors: 0,
        total_contacts: 0,
        total_hours: 0,
        walks_count: 0,
        active_walks: 0,
        current_walk_id: null,
        current_walk_name: null,
        is_live: false,
        last_knock_at: null
      };
    }
    const agg = walkerAgg[name];

    // Only count walks where they actually knocked doors or walk is in_progress
    const hasActivity = (m.doors_knocked || 0) > 0;
    const isLive = walk.status === 'in_progress';

    if (hasActivity || isLive) {
      agg.total_doors += m.doors_knocked || 0;
      agg.total_contacts += m.contacts_made || 0;
      agg.walks_count++;

      // Calculate hours for this walk
      if (m.first_knock_at && m.last_knock_at) {
        const startMs = new Date(m.first_knock_at + (m.first_knock_at.endsWith('Z') ? '' : 'Z')).getTime();
        const endMs = new Date(m.last_knock_at + (m.last_knock_at.endsWith('Z') ? '' : 'Z')).getTime();
        agg.total_hours += Math.max(0, (endMs - startMs) / 3600000);
      }

      if (isLive) {
        agg.active_walks++;
        agg.is_live = true;
      }

      // Track most recent walk as "current"
      if (!agg.last_knock_at || (m.last_knock_at && m.last_knock_at > agg.last_knock_at)) {
        agg.last_knock_at = m.last_knock_at;
        agg.current_walk_id = walk.id;
        agg.current_walk_name = walk.name;
      }
    }
  }

  const walkers = Object.values(walkerAgg)
    .filter(w => w.walks_count > 0)
    .map(w => ({
      ...w,
      total_hours: Math.round(w.total_hours * 10) / 10
    }))
    .sort((a, b) => {
      if (a.is_live !== b.is_live) return b.is_live - a.is_live;
      return (b.last_knock_at || '').localeCompare(a.last_knock_at || '');
    });

  const liveWalkCount = walks.filter(w => w.status === 'in_progress').length;

  res.json({
    liveWalkCount,
    totalWalkCount: walks.length,
    liveWalkerCount: walkers.filter(w => w.is_live).length,
    totalWalkerCount: walkers.length,
    walkers
  });
});

// --- Messaging provider endpoints ---

// List available providers and which is active
app.get('/api/providers', (req, res) => {
  res.json({ providers: listProviders(), active: getActiveProviderName() });
});

// Set active provider
app.post('/api/providers/active', (req, res) => {
  const { provider } = req.body;
  if (!provider) return res.status(400).json({ error: 'Provider name required.' });
  try {
    setActiveProvider(provider);
    res.json({ success: true, active: provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get saved credentials for a specific provider (without exposing secrets)
app.get('/api/provider-credentials', (req, res) => {
  const providerName = req.query.provider || getActiveProviderName();
  const p = getProviderByName(providerName);
  if (!p) return res.status(400).json({ error: 'Unknown provider.' });
  res.json({ provider: providerName, credentials: p.getPublicCredentials(), fields: p.credentialFields });
});

// Save credentials for a specific provider
app.post('/api/provider-credentials', (req, res) => {
  const { provider: providerName, credentials } = req.body;
  const name = providerName || getActiveProviderName();
  const p = getProviderByName(name);
  if (!p) return res.status(400).json({ error: 'Unknown provider.' });
  p.saveCredentials(credentials || {});
  res.json({ success: true });
});

// Test connection for the active provider (or a specified one)
app.post('/test-connection', asyncHandler(async (req, res) => {
  const providerName = req.body.provider || getActiveProviderName();
  const p = getProviderByName(providerName);
  if (!p) return res.status(400).json({ error: 'Unknown provider.' });

  try {
    let { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      const saved = p.getCredentials();
      apiKey = apiKey || saved.apiKey;
      apiSecret = apiSecret || saved.apiSecret;
    }
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'Missing API key or secret.' });
    const result = await p.testConnection(apiKey, apiSecret);
    p.saveCredentials({ apiKey, apiSecret, phoneNumber: req.body.phoneNumber, actionId: req.body.actionId, campaignId: req.body.campaignId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Connection test failed:', err.message);
    res.status(401).json({ success: false, error: err.message || 'Invalid credentials.' });
  }
}));

// --- Incoming webhook (messaging provider) ---
app.post('/incoming', webhookLimiter, async (req, res) => {
  const webhookType = (req.body && req.body.type) || 'unknown';
  console.log('[webhook /incoming] type=' + webhookType + ' payload:', JSON.stringify(req.body).substring(0, 500));

  // Skip non-message events — only block known non-message types
  // RumbleUp may send "MESSAGE_RECEIVED", "MESSAGE", or other variants
  const skipTypes = ['DELIVERY_RECEIPT', 'CONTACT_UPDATED', 'CONTACT', 'STATUS', 'PROXY_PROVISIONED'];
  if (skipTypes.includes(webhookType)) {
    return res.type('application/json').send('{"ok":true}');
  }

  let provider;
  try {
    provider = getProvider();
  } catch (err) {
    console.error('Webhook provider error:', err.message);
    return res.type('application/json').send('{"ok":true}');
  }
  // Use the provider's declared content type for all webhook responses
  const replyType = provider.responseContentType || 'application/json';
  let webhook;
  try {
    webhook = provider.getWebhookData(req);
  } catch (err) {
    console.error('Webhook parse error:', err.message);
    return res.type('application/json').send('{"ok":true}');
  }
  const From = webhook.from;
  const Body = webhook.body;
  const channel = webhook.channel || 'sms';
  if (!From) {
    console.warn('[webhook] No phone in payload, skipping');
    return res.type(replyType).send(provider.buildEmptyReply());
  }
  console.log('[webhook] Processing message from ' + From + ': ' + (Body || '').substring(0, 100));

  // Normalize phone to 10-digit for matching against stored contacts
  const fromNormalized = phoneDigits(From);
  if (!fromNormalized || fromNormalized.length < 10) {
    console.log('[webhook] Invalid phone number, ignoring');
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  try {

  const msgText = (Body || '').trim().toLowerCase();
  if (STOP_KEYWORDS.includes(msgText)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run(fromNormalized);
    return res.type(replyType).send(provider.buildReply("You've been removed from our list. -- Campaign HQ"));
  }

  // Use fast keyword sentiment in webhook path (AI is too slow, risks timeout)
  const sentiment = analyzeSentimentKeywords(Body);
  // AI sentiment will be fire-and-forget AFTER message is inserted (see below)

  // Check if this is a survey response (only when the survey is actively running)
  const activeSend = db.prepare(`
    SELECT ss.*, s.name as survey_name, s.completion_message FROM survey_sends ss
    JOIN surveys s ON ss.survey_id = s.id
    WHERE ss.phone = ? AND ss.status IN ('sent', 'in_progress')
      AND s.status = 'active'
    ORDER BY ss.sent_at DESC LIMIT 1
  `).get(fromNormalized);

  if (activeSend && activeSend.current_question_id) {
    const { buildSurveyMessage } = require('./routes/surveys');
    const question = db.prepare('SELECT * FROM survey_questions WHERE id = ?').get(activeSend.current_question_id);
    if (question) {
      const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(question.id);

      // Match response: could be a number ("2"), option key, or the option text itself
      const rawReply = (Body || '').trim();
      let matchedOption = null;
      let responseText = rawReply;

      if (question.question_type !== 'write_in' && options.length > 0) {
        // Helper: resolve a single reply token to an option
        function matchSingleOption(token) {
          const t = token.trim();
          const tLower = t.toLowerCase();
          // By option_key ("1", "2")
          let found = options.find(o => o.option_key === t);
          if (found) return found;
          // By number index
          const num = parseInt(t, 10);
          if (!isNaN(num) && num >= 1 && num <= options.length) return options[num - 1];
          // By exact option text (case-insensitive)
          found = options.find(o => o.option_text.toLowerCase() === tLower);
          if (found) return found;
          // By partial text match
          found = options.find(o =>
            tLower.includes(o.option_text.toLowerCase()) ||
            o.option_text.toLowerCase().includes(tLower)
          );
          return found || null;
        }

        if (question.question_type === 'ranked_choice' && rawReply.includes(',')) {
          // Ranked choice: "2,1,3" or "Biden, Trump, Harris"
          const parts = rawReply.split(',');
          const resolvedKeys = [];
          for (const part of parts) {
            const opt = matchSingleOption(part);
            if (opt) resolvedKeys.push(opt.option_key);
          }
          responseText = resolvedKeys.length > 0 ? resolvedKeys.join(',') : rawReply;
          matchedOption = resolvedKeys.length > 0 ? options.find(o => o.option_key === resolvedKeys[0]) : null;
        } else {
          // Single choice: "2" or "Biden"
          matchedOption = matchSingleOption(rawReply);
          if (matchedOption) {
            responseText = matchedOption.option_key;
          }
        }
      }

      // Find next question
      const nextQ = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? AND sort_order > ? ORDER BY sort_order, id LIMIT 1')
        .get(activeSend.survey_id, question.sort_order);

      // Prevent duplicate responses to same question from same send
      const existingResponse = db.prepare('SELECT id FROM survey_responses WHERE send_id = ? AND question_id = ?').get(activeSend.id, question.id);
      if (existingResponse) {
        // Already answered this question — skip
        return res.type(replyType).send(provider.buildEmptyReply());
      }

      // Wrap response recording + state update in a transaction for atomicity
      const surveyResponseTx = db.transaction(() => {
        db.prepare('INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text, option_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(activeSend.survey_id, activeSend.id, question.id, fromNormalized, responseText, matchedOption ? matchedOption.id : null);
        db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, 'inbound', ?, ?)").run(fromNormalized, Body, sentiment, channel);
        if (nextQ) {
          db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(nextQ.id, activeSend.id);
        } else {
          db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now'), current_question_id = NULL WHERE id = ?").run(activeSend.id);
        }
      });
      try { surveyResponseTx(); } catch (e) {
        console.error('Survey response transaction error:', e.message);
        return res.status(500).json({ error: 'Failed to record survey response.' });
      }

      if (nextQ) {
        const nextOpts = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(nextQ.id);
        const nextMsg = buildSurveyMessage(activeSend.survey_name, nextQ, nextOpts);
        return res.type(replyType).send(provider.buildReply(nextMsg));
      } else {
        const completionMsg = activeSend.completion_message || 'Thank you for completing the survey! Your responses have been recorded.';
        return res.type(replyType).send(provider.buildReply(completionMsg));
      }
    }
  }

  // Check if this is a reply to an active P2P session
  // Contacts are now stored with normalized phones (10-digit), matching webhook format
  const p2pAssignment = db.prepare(`
    SELECT a.*, s.id as sid FROM p2p_assignments a
    JOIN p2p_sessions s ON a.session_id = s.id
    JOIN contacts c ON a.contact_id = c.id
    WHERE c.phone = ?
      AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    ORDER BY a.sent_at DESC LIMIT 1
  `).get(fromNormalized);

  // Dedup: atomically check-and-insert using INSERT OR IGNORE with a unique-ish key
  // First check (non-atomic but catches most duplicates cheaply)
  const alreadyExists = db.prepare("SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' AND timestamp > datetime('now', '-2 minutes') LIMIT 1").get(fromNormalized, Body);
  if (alreadyExists) {
    console.log('[webhook] Skipping duplicate message from ' + fromNormalized);
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  if (p2pAssignment) {
    const txResult = db.transaction(() => {
      db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(p2pAssignment.id);
      const r = db.prepare("INSERT INTO messages (phone, body, direction, sentiment, session_id, channel) VALUES (?, ?, 'inbound', ?, ?, ?)").run(fromNormalized, Body, sentiment, p2pAssignment.sid, channel);
      return r.lastInsertRowid;
    })();
    const savedMsgId = txResult;
    // Fire-and-forget AI sentiment update by exact row ID
    analyzeSentimentAI(Body).then(aiSentiment => {
      if (aiSentiment !== sentiment && savedMsgId) {
        db.prepare("UPDATE messages SET sentiment = ? WHERE id = ?").run(aiSentiment, savedMsgId);
      }
    }).catch(err => { console.error('AI sentiment error:', err.message); });
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  const insResult = db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, 'inbound', ?, ?)").run(fromNormalized, Body, sentiment, channel);
  const savedMsgId = insResult.lastInsertRowid;
  // Fire-and-forget AI sentiment update by exact row ID
  analyzeSentimentAI(Body).then(aiSentiment => {
    if (aiSentiment !== sentiment && savedMsgId) {
      db.prepare("UPDATE messages SET sentiment = ? WHERE id = ?").run(aiSentiment, savedMsgId);
    }
  }).catch(err => { console.error('AI sentiment error:', err.message); });
  const autoReply = generateAutoReply(msgText);
  if (autoReply) {
    return res.type(replyType).send(provider.buildReply(autoReply));
  }
  res.type(replyType).send(provider.buildEmptyReply());

  } catch (err) {
    console.error('Webhook processing error:', err.message);
    if (!res.headersSent) res.type(replyType).send(provider.buildEmptyReply());
  }
});

// --- Messages & opt-outs ---
// Pending messages: last inbound per phone with no outbound reply after it
// Accessible by admin (session) or volunteers (X-Volunteer-Id header)
app.get('/api/messages/pending', (req, res) => {
  const isAdmin = req.session && req.session.userId;
  const volId = req.headers['x-volunteer-id'];
  const volCode = req.headers['x-volunteer-code'];
  // Require both volunteer ID and their personal code to prevent ID spoofing
  const isVol = volId && volCode &&
    db.prepare('SELECT id FROM volunteers WHERE id = ? AND code = ?').get(volId, volCode);
  if (!isAdmin && !isVol) return res.status(401).json({ error: 'Authentication required.' });

  // For volunteers: only show messages for phones in their assignments
  // For admin: show all pending messages
  let volPhoneFilter = '';
  let volPhoneParams = [];
  if (isVol && !isAdmin) {
    // Get all phones assigned to this volunteer across all sessions
    const assignedPhones = db.prepare(`
      SELECT DISTINCT c.phone FROM p2p_assignments pa
      JOIN p2p_volunteers pv ON pa.session_id = pv.session_id AND pa.volunteer_id = pv.id
      JOIN contacts c ON pa.contact_id = c.id
      WHERE (pv.volunteer_id = ? OR pv.id = ?) AND pa.status IN ('sent','in_conversation','completed')
    `).all(volId, volId).map(r => r.phone);
    // Normalize and batch to avoid SQLite 999 variable limit
    const allPhones = new Set();
    for (const p of assignedPhones) {
      const digits = phoneDigits(p);
      if (digits) allPhones.add(digits);
    }
    if (allPhones.size === 0) return res.json({ messages: [] });
    // Build phone filter using batched placeholders (safe for any size, no temp table race)
    const phonesArr = [...allPhones];
    volPhoneFilter = ' AND m.phone IN (' + phonesArr.map(() => '?').join(',') + ')';
    volPhoneParams = phonesArr;
  }

  const pending = db.prepare(`
    SELECT m.*,
      COALESCE(
        (SELECT v.first_name || ' ' || v.last_name FROM voters v WHERE v.phone = m.phone AND v.phone != '' LIMIT 1),
        (SELECT c.first_name || ' ' || c.last_name FROM contacts c WHERE c.phone = m.phone AND c.phone != '' LIMIT 1)
      ) as contact_name
    FROM messages m
    WHERE m.direction = 'inbound'
      AND m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.phone = m.phone AND m2.direction = 'inbound')
      AND NOT EXISTS (
        SELECT 1 FROM messages out_msg
        WHERE out_msg.phone = m.phone AND out_msg.direction = 'outbound' AND out_msg.id > m.id
      )
      AND m.phone NOT IN (SELECT phone FROM opt_outs)
      ${volPhoneFilter}
    ORDER BY m.id DESC LIMIT 100
  `).all(...volPhoneParams);
  // Batch-load conversation history for all pending phones in one query
  if (pending.length > 0) {
    const phones = pending.map(m => m.phone);
    const placeholders = phones.map(() => '?').join(',');
    const allConvos = db.prepare(`SELECT phone, body, direction, timestamp, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY COALESCE(timestamp, datetime('now')) DESC, id DESC) as rn FROM messages WHERE phone IN (${placeholders})`).all(...phones);
    const convoMap = {};
    for (const c of allConvos) {
      if (c.rn > 5) continue; // limit 5 per phone
      if (!convoMap[c.phone]) convoMap[c.phone] = [];
      convoMap[c.phone].push({ body: c.body, direction: c.direction, timestamp: c.timestamp });
    }
    for (const msg of pending) {
      msg.conversation = (convoMap[msg.phone] || []).reverse();
    }
  }
  res.json({ messages: pending });
});

app.get('/api/messages', (req, res) => {
  const messages = db.prepare(`
    SELECT m.*,
      COALESCE(
        (SELECT v.first_name || ' ' || v.last_name FROM voters v WHERE v.phone = m.phone AND v.phone != '' LIMIT 1),
        (SELECT c.first_name || ' ' || c.last_name FROM contacts c WHERE c.phone = m.phone AND c.phone != '' LIMIT 1)
      ) as contact_name
    FROM messages m
    WHERE m.direction = 'inbound'
    ORDER BY m.id DESC LIMIT 200
  `).all();
  const optedOut = db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone);
  res.json({ messages, optedOut });
});

// --- Reply (SMS or WhatsApp) ---
app.post('/reply', sendLimiter, asyncHandler(async (req, res) => {
  // Require admin session or verified volunteer identity to prevent unauthenticated sends
  const hasAdminSession = req.session && req.session.userId;
  const hasVolunteer = req.body && req.body.volunteerId && req.body.volunteerCode &&
    db.prepare('SELECT id FROM volunteers WHERE id = ? AND code = ?').get(req.body.volunteerId, req.body.volunteerCode);
  if (!hasAdminSession && !hasVolunteer) return res.status(401).json({ error: 'Authentication required.' });
  const provider = getProvider();
  const { to, body, channel, mmsActionId } = req.body;
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });
  if (!to || !body) return res.status(400).json({ error: 'Recipient and message body required.' });
  // Check opt-out list before sending (TCPA compliance)
  const toDigits = phoneDigits(to);
  if (toDigits && db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(toDigits)) {
    return res.status(400).json({ error: 'Contact has opted out. Cannot send messages.' });
  }
  try {
    // RumbleUp requires opt-out instructions in every message
    const sendBody = /stop|opt.?out|unsubscribe/i.test(body) ? body : body + '\nSTOP to opt-out';
    // If mmsActionId provided, send through that pre-created MMS project (image is on the project)
    if (mmsActionId) {
      console.log('[reply] Sending MMS via pre-created project:', mmsActionId);
    }
    await provider.sendMessage(to, sendBody, channel, mmsActionId || null);

    // Find active P2P session for this phone so reply appears in conversation view
    const replySessionMatch = db.prepare(`
      SELECT a.session_id FROM p2p_assignments a
      JOIN p2p_sessions s ON a.session_id = s.id
      JOIN contacts c ON a.contact_id = c.id
      WHERE c.phone = ? AND s.status = 'active' AND a.status IN ('sent','in_conversation')
      ORDER BY a.sent_at DESC LIMIT 1
    `).get(toDigits);
    db.prepare("INSERT INTO messages (phone, body, direction, session_id) VALUES (?, ?, 'outbound', ?)").run(toDigits || to, body, replySessionMatch ? replySessionMatch.session_id : null);
    res.json({ success: true, mms: !!mmsActionId });
  } catch (err) {
    console.error('Reply send error:', err.message);
    res.status(500).json({ error: 'Failed to send reply. Please try again.' });
  }
}));

// --- Fetch RumbleUp projects for MMS dropdown ---
app.get('/api/rumbleup/projects', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.json({ projects: [] });
  try {
    const stats = await provider.getProjectStats({ days: 90 });
    // Stats response may be an array of projects or an object with project data
    let projects = [];
    if (Array.isArray(stats)) {
      projects = stats.map(p => ({
        id: p.action || p.id || p.aid,
        name: p.name || ('Project ' + (p.action || p.id)),
        type: p.type || 'SMS',
        status: p.status || '',
        sent: p.sent || p.total_sent || 0
      }));
    } else if (stats && stats.data && Array.isArray(stats.data)) {
      projects = stats.data.map(p => ({
        id: p.action || p.id || p.aid,
        name: p.name || ('Project ' + (p.action || p.id)),
        type: p.type || 'SMS',
        status: p.status || '',
        sent: p.sent || p.total_sent || 0
      }));
    }
    res.json({ projects });
  } catch (err) {
    console.error('[rumbleup] Failed to fetch projects:', err.message);
    res.json({ projects: [], error: err.message });
  }
}));

// (Dead MMS media upload code removed — RumbleUp API doesn't support programmatic media upload.
// MMS images must be uploaded on RumbleUp's dashboard. Our system creates the project via API
// and sends messages through it; the image is attached on RumbleUp's side.)

// --- Create a RumbleUp project (text only — user adds image on RumbleUp dashboard) ---
app.post('/api/rumbleup/create-project', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });

  const { name, message } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'Project name and message required.' });

  const creds = provider.getCredentials();
  try {
    const result = await provider.createProject({
      name,
      message,
      campaignId: creds.campaignId,
      proxy: creds.phoneNumber
    });
    const projectId = result.action || result.id || result.aid;
    console.log('[rumbleup] Project created:', projectId, JSON.stringify(result));
    res.json({
      success: true,
      projectId,
      cid: result.cid,
      link: result.link || (result.cid ? 'https://app.rumbleup.com/app/action/' + result.cid + '/' + projectId : null)
    });
  } catch (err) {
    console.error('[rumbleup] Create project failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// --- Send test message through an existing RumbleUp project ---
app.post('/api/rumbleup/test-send', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });

  const { projectId, testPhone } = req.body;
  if (!projectId) return res.status(400).json({ error: 'Project ID required.' });
  if (!testPhone) return res.status(400).json({ error: 'Test phone number required.' });

  try {
    const result = await provider.sendTestMessage(projectId, testPhone);
    console.log('[mms] Test send via project', projectId, ':', JSON.stringify(result));
    res.json({ success: true, result });
  } catch (err) {
    console.error('[mms] Test send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// --- Check a RumbleUp project's details (for MMS debugging) ---
app.get('/api/rumbleup/project/:id', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });
  try {
    const details = await provider.getProject(req.params.id);
    res.json({ project: details, hasMedia: !!(details.media || details.media_url), allKeys: Object.keys(details) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// --- Debug endpoint: test RumbleUp message log API directly ---
app.get('/api/debug/sync-status', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });

  // Gather all the phones the sync would check
  const phoneSet = new Set();
  try {
    db.prepare(`SELECT DISTINCT c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id WHERE a.status IN ('sent','in_conversation') AND a.sent_at > datetime('now', '-7 days')`)
      .all().forEach(r => { if (r.phone) phoneSet.add(phoneDigits(r.phone)); });
  } catch (e) { /* table may not exist */ }
  const p2pCount = phoneSet.size;

  db.prepare(`SELECT DISTINCT phone FROM survey_sends WHERE status IN ('sent', 'in_progress') AND sent_at > datetime('now', '-7 days')`)
    .all().forEach(r => { if (r.phone) phoneSet.add(r.phone); });
  const surveyCount = phoneSet.size - p2pCount;

  const beforeOutbound = phoneSet.size;
  if (phoneSet.size < 25) {
    db.prepare(`SELECT DISTINCT phone FROM messages WHERE direction = 'outbound' AND timestamp > datetime('now', '-3 days')`)
      .all().forEach(r => { if (r.phone && phoneSet.size < 25) phoneSet.add(r.phone); });
  }
  const outboundCount = phoneSet.size - beforeOutbound;

  const sentPhones = Array.from(phoneSet).filter(p => p && p.length >= 10);
  const lastSyncRow = db.prepare("SELECT value FROM settings WHERE key = 'last_inbound_sync'").get();
  const inboundCount = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE direction = 'inbound'").get();
  const outboundTotal = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE direction = 'outbound'").get();

  // Test RumbleUp API with first phone if available
  let apiTest = null;
  const testPhone = req.query.phone || sentPhones[0];
  if (testPhone && provider.getMessageLog) {
    try {
      const raw = await provider.getMessageLog({ phone: testPhone });
      apiTest = { success: true, type: typeof raw, isArray: Array.isArray(raw), resultCount: Array.isArray(raw) ? raw.length : (raw ? 1 : 0) };
    } catch (err) {
      apiTest = { phone: testPhone, error: err.message };
    }
  }

  res.json({
    phonesToCheck: sentPhones.length,
    breakdown: { p2p: p2pCount, survey: surveyCount, outbound: outboundCount },
    samplePhoneCount: Math.min(sentPhones.length, 5),
    lastSync: lastSyncRow?.value || null,
    dbCounts: { inbound: inboundCount?.cnt || 0, outbound: outboundTotal?.cnt || 0 },
    apiTest
  });
}));

// --- Sync inbound messages from RumbleUp ---
// Cooldown: skip if last sync was < 4 seconds ago (prevents stacking from rapid polls)
let _lastSyncTime = 0;
app.post('/api/sync-inbound', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (now - _lastSyncTime < 4000) return res.json({ synced: 0, skipped: true, message: 'Sync cooldown active' });
  _lastSyncTime = now;

  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });
  if (!provider.getMessageLog) return res.status(400).json({ error: 'Provider does not support message log sync.' });

  // PRIORITY 1: Check P2P active conversations first (most important for reply detection)
  // Extended to 30 days and raised cap to 100 phones to catch more replies
  const phoneSet = new Set();
  try {
    db.prepare(`SELECT DISTINCT c.phone FROM p2p_assignments a JOIN contacts c ON a.contact_id = c.id WHERE a.status IN ('sent','in_conversation') AND a.sent_at > datetime('now', '-30 days')`)
      .all().forEach(r => { if (r.phone) phoneSet.add(phoneDigits(r.phone)); });
  } catch (e) { /* table may not exist */ }

  // PRIORITY 2: Active survey sends
  db.prepare(`SELECT DISTINCT phone FROM survey_sends WHERE status IN ('sent', 'in_progress') AND sent_at > datetime('now', '-30 days')`)
    .all().forEach(r => { if (r.phone) phoneSet.add(phoneDigits(r.phone)); });

  // PRIORITY 3: Recent outbound — check all phones we've texted in last 14 days (cap at 100)
  if (phoneSet.size < 100) {
    db.prepare(`SELECT DISTINCT phone FROM messages WHERE direction = 'outbound' AND timestamp > datetime('now', '-14 days')`)
      .all().forEach(r => { if (r.phone && phoneSet.size < 100) phoneSet.add(phoneDigits(r.phone)); });
  }

  const sentPhones = Array.from(phoneSet).filter(p => p && p.length >= 10);

  console.log('[sync-inbound] Phones to check:', sentPhones.length, '| P2P:', phoneSet.size, '| Sample:', sentPhones.slice(0, 3));

  if (sentPhones.length === 0) return res.json({ synced: 0, checked: 0, message: 'No outbound messages to check replies for.' });

  // Get the last sync timestamp
  const lastSyncRow = db.prepare("SELECT value FROM settings WHERE key = 'last_inbound_sync'").get();
  const lastSync = lastSyncRow ? lastSyncRow.value : null;

  let totalSynced = 0;
  const errors = [];

  // Pre-load P2P session map for fast lookups (avoids N+1 queries per message)
  const p2pPhoneMap = {};
  try {
    db.prepare(`
      SELECT c.phone, a.id as assignment_id, s.id as session_id FROM p2p_assignments a
      JOIN p2p_sessions s ON a.session_id = s.id
      JOIN contacts c ON a.contact_id = c.id
      WHERE s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    `).all().forEach(r => {
      const digits = phoneDigits(r.phone);
      if (digits) {
        // Store ALL assignments per phone (not just last) to handle multi-session contacts
        if (!p2pPhoneMap[digits]) p2pPhoneMap[digits] = [];
        p2pPhoneMap[digits].push({ assignment_id: r.assignment_id, session_id: r.session_id });
      }
    });
  } catch (e) { /* table may not exist */ }

  // Pre-load active survey sends for fast matching
  const surveyPhoneMap = {};
  try {
    db.prepare(`
      SELECT ss.*, s.name as survey_name, s.completion_message FROM survey_sends ss
      JOIN surveys s ON ss.survey_id = s.id
      WHERE ss.status IN ('sent', 'in_progress') AND s.status = 'active'
    `).all().forEach(r => {
      const digits = phoneDigits(r.phone);
      if (digits) surveyPhoneMap[digits] = r;
    });
  } catch (e) { /* table may not exist */ }

  // Process phones in parallel batches of 15 for speed
  const BATCH_SIZE = 15;
  for (let i = 0; i < sentPhones.length; i += BATCH_SIZE) {
    const batch = sentPhones.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (phone) => {
      try {
        // Don't pass 'since' — RumbleUp may interpret timestamps differently
        // and skip messages. Instead fetch all recent messages and dedup locally.
        const result = await provider.getMessageLog({ phone });

        // DEBUG: Log raw API response shape for first phone
        if (i === 0 && phone === batch[0]) {
          console.log('[sync-inbound] Raw API response keys:', Object.keys(result || {}));
          console.log('[sync-inbound] Raw API response (first 500 chars):', JSON.stringify(result).substring(0, 500));
        }

        // RumbleUp may return messages under different keys depending on API version
        let messages = result.messages || result.data || result.logs || result || [];
        // If result is an object with a single array value, use that
        if (!Array.isArray(messages) && typeof messages === 'object' && messages !== null) {
          const keys = Object.keys(messages);
          const arrKey = keys.find(k => Array.isArray(messages[k]));
          if (arrKey) messages = messages[arrKey];
        }
        if (!Array.isArray(messages)) {
          console.log('[sync-inbound] Messages not an array for phone', phone, '| type:', typeof messages, '| keys:', Object.keys(messages || {}));
          return;
        }
        if (messages.length > 0) {
          console.log('[sync-inbound] Found', messages.length, 'messages for phone', phone, '| First msg keys:', Object.keys(messages[0]));
        }

      for (const msg of messages) {
        // Only import inbound messages (sender === phone means incoming)
        const isInbound = msg.status === 'received' || msg.sender === msg.phone || msg.sender === phone || msg.direction === 'inbound';
        // DEBUG: Log message direction detection
        if (i === 0 && phone === batch[0]) {
          console.log('[sync-inbound] Msg:', { status: msg.status, sender: msg.sender, phone: msg.phone, direction: msg.direction, isInbound, body: (msg.text || msg.body || msg.message || '').substring(0, 50) });
        }
        if (!isInbound) continue;

        const msgPhone = phoneDigits(msg.phone || msg.from || phone);
        const msgBody = msg.text || msg.body || msg.message || '';
        const msgTime = msg.timestamp || msg.created || msg.date || msg.sent_time || msg.update_time || null;

        if (!msgBody.trim()) continue;

        // Check for duplicate — use timestamp when available, otherwise check recent (last 24h) only
        // This prevents dropping repeated common messages like "Yes", "Ok", "Thanks"
        let existing;
        if (msgTime) {
          // Try exact timestamp match first, then fuzzy (±5 min) to catch webhook-inserted copies
          existing = db.prepare("SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' AND timestamp = ? LIMIT 1").get(msgPhone, msgBody, msgTime);
          if (!existing) {
            existing = db.prepare("SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' AND timestamp > datetime('now', '-5 minutes') LIMIT 1").get(msgPhone, msgBody);
          }
        } else {
          existing = db.prepare("SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' AND timestamp > datetime('now', '-1 day') LIMIT 1").get(msgPhone, msgBody);
        }
        if (existing) continue;

        // Check STOP keywords FIRST (before any routing)
        const msgLower = msgBody.trim().toLowerCase();
        if (STOP_KEYWORDS.includes(msgLower)) {
          db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run(msgPhone);
          // Use fast keyword sentiment during sync (AI would be too slow for batch)
          const sentiment = analyzeSentiment(msgBody);
          db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel, timestamp) VALUES (?, ?, 'inbound', ?, 'sms', COALESCE(?, datetime('now')))")
            .run(msgPhone, msgBody, sentiment, msgTime);
          totalSynced++;
          continue; // Don't route STOP messages to surveys or P2P
        }

        // Find P2P sessions for this phone using pre-loaded map (supports multi-session)
        const p2pMatches = p2pPhoneMap[msgPhone] || p2pPhoneMap[msgPhone.slice(-10)] || [];
        const p2pMatch = p2pMatches.length > 0 ? p2pMatches[0] : null;

        // Insert the inbound message (with first session_id if P2P match found)
        const sentiment = analyzeSentiment(msgBody);
        db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel, timestamp, session_id) VALUES (?, ?, 'inbound', ?, 'sms', COALESCE(?, datetime('now')), ?)")
          .run(msgPhone, msgBody, sentiment, msgTime, p2pMatch ? p2pMatch.session_id : null);
        totalSynced++;
        // Fire-and-forget AI sentiment upgrade (same as webhook path)
        analyzeSentimentAI(msgBody).then(aiSentiment => {
          if (aiSentiment !== sentiment) {
            try { db.prepare("UPDATE messages SET sentiment = ? WHERE phone = ? AND body = ? AND direction = 'inbound' ORDER BY id DESC LIMIT 1").run(aiSentiment, msgPhone, msgBody); } catch(e) {}
          }
        }).catch(err => { console.error('AI sentiment error:', err.message); });

        // Update ALL matching P2P assignments to in_conversation (not just first)
        for (const match of p2pMatches) {
          db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ? AND status IN ('sent','in_conversation')").run(match.assignment_id);
        }

        // Route to survey if applicable (use pre-loaded map for speed)
        const activeSend = surveyPhoneMap[msgPhone] || surveyPhoneMap[msgPhone.slice(-10)] || null;

        if (activeSend && activeSend.current_question_id) {
          const question = db.prepare('SELECT * FROM survey_questions WHERE id = ?').get(activeSend.current_question_id);
          if (question) {
            const options = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(question.id);
            let matchedOption = null;
            let responseText = msgBody.trim();

            if (question.question_type !== 'write_in' && options.length > 0) {
              const t = responseText;
              const tLower = t.toLowerCase();
              matchedOption = options.find(o => o.option_key === t);
              if (!matchedOption) {
                const num = parseInt(t, 10);
                if (!isNaN(num) && num >= 1 && num <= options.length) matchedOption = options[num - 1];
              }
              if (!matchedOption) matchedOption = options.find(o => o.option_text.toLowerCase() === tLower);
              if (!matchedOption) matchedOption = options.find(o => tLower.includes(o.option_text.toLowerCase()) || o.option_text.toLowerCase().includes(tLower));
              if (matchedOption) responseText = matchedOption.option_key;
            }

            const existingResp = db.prepare('SELECT id FROM survey_responses WHERE send_id = ? AND question_id = ?').get(activeSend.id, question.id);
            if (!existingResp) {
              const nextQ = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? AND sort_order > ? ORDER BY sort_order, id LIMIT 1')
                .get(activeSend.survey_id, question.sort_order);
              db.prepare('INSERT INTO survey_responses (survey_id, send_id, question_id, phone, response_text, option_id) VALUES (?, ?, ?, ?, ?, ?)')
                .run(activeSend.survey_id, activeSend.id, question.id, msgPhone, responseText, matchedOption ? matchedOption.id : null);
              if (nextQ) {
                db.prepare("UPDATE survey_sends SET current_question_id = ?, status = 'in_progress' WHERE id = ?").run(nextQ.id, activeSend.id);
              } else {
                db.prepare("UPDATE survey_sends SET status = 'completed', completed_at = datetime('now'), current_question_id = NULL WHERE id = ?").run(activeSend.id);
                // Send thank-you auto-reply
                const thankYouMsg = activeSend.completion_message || 'Thank you for completing the survey! Your responses have been recorded.';
                try {
                  await provider.sendMessage(msgPhone, thankYouMsg);
                  db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, ?, 'outbound', 'sms')")
                    .run(msgPhone, thankYouMsg);
                } catch (replyErr) {
                  console.warn('Survey thank-you auto-reply failed:', replyErr.message);
                }
              }
            }
          }
        }

        // P2P assignment status already updated above (all matching sessions)
      }
    } catch (err) {
      errors.push({ phone, error: err.message });
    }
    }));
  }

  // Update last sync timestamp
  db.prepare("INSERT INTO settings (key, value) VALUES ('last_inbound_sync', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = datetime('now')").run();

  res.json({ synced: totalSynced, checked: sentPhones.length, errors: errors.length > 0 ? errors : undefined });
}));

// --- Send event invites via P2P session (TCPA compliant) ---
app.post('/api/events/:id/invite', (req, res) => {
  const { contactIds, list_id, messageTemplate, precinct_filter } = req.body;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const mms_project_id = req.body.mms_project_id || event.mms_project_id || null;

  // Gather contacts — from list or individual IDs
  let contacts = [];
  if (list_id) {
    let listSql = `
      SELECT v.id, v.phone, v.first_name, v.last_name
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != ''
    `;
    const listParams = [list_id];
    if (precinct_filter && precinct_filter.length > 0) {
      listSql += ' AND v.precinct IN (' + precinct_filter.map(() => '?').join(',') + ')';
      listParams.push(...precinct_filter);
    }
    contacts = db.prepare(listSql).all(...listParams);
  } else if (contactIds && contactIds.length > 0) {
    // Batch fetch contacts instead of N+1
    for (let i = 0; i < contactIds.length; i += 900) {
      const batch = contactIds.slice(i, i + 900);
      const ph = batch.map(() => '?').join(',');
      contacts.push(...db.prepare(`SELECT * FROM contacts WHERE id IN (${ph})`).all(...batch));
    }
  }
  if (contacts.length === 0) return res.status(400).json({ error: 'No contacts with phone numbers found.' });

  // Build the invite message template (includes personalized check-in link)
  const template = (messageTemplate || 'You\'re invited to {title} on {date} at {location}!')
    .replace(/{title}/g, event.title)
    .replace(/{date}/g, event.event_date)
    .replace(/{time}/g, event.event_time || '')
    .replace(/{location}/g, event.location || '')
    + '{checkin_link}'
    + '\nReply STOP to opt out.';

  // Create/reuse a P2P session for event invites
  // Build public flyer URL — ensure https:// prefix
  let baseUrl = process.env.BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'campaigntext-production.up.railway.app';
  if (baseUrl && !baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const flyerUrl = event.flyer_image ? baseUrl + '/api/events/' + event.id + '/flyer' : null;

  // Check for existing active event session first (don't create duplicates)
  let sessionId;
  const existingSession = db.prepare("SELECT id, join_code FROM p2p_sessions WHERE name = ? AND status = 'active' LIMIT 1")
    .get('Event Invite: ' + event.title);
  let joinCode;
  if (existingSession) {
    sessionId = existingSession.id;
    joinCode = existingSession.join_code;
    // Update media_url and MMS project ID in case they were added/changed
    if (flyerUrl) db.prepare('UPDATE p2p_sessions SET media_url = ? WHERE id = ?').run(flyerUrl, sessionId);
    if (mms_project_id) db.prepare('UPDATE p2p_sessions SET rumbleup_action_id = ? WHERE id = ?').run(mms_project_id, sessionId);
  } else {
    joinCode = generateJoinCode();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const sessionResult = db.prepare(
      'INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at, session_type, media_url, source_id, rumbleup_action_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('Event Invite: ' + event.title, template, 'auto_split', joinCode, expiresAt, 'event', flyerUrl, req.params.id, mms_project_id || null);
    sessionId = sessionResult.lastInsertRowid;
  }

  // Queue contacts as P2P assignments + record RSVPs
  const insertAssign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const rsvpInsert = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, 'invited')");
  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)');

  // Find online volunteers to auto-assign contacts to
  const onlineVols = db.prepare("SELECT id FROM p2p_volunteers WHERE session_id = ? AND is_online = 1").all(sessionId);
  let volIndex = 0;

  let queued = 0;
  const inviteTx = db.transaction(() => {
    for (const c of contacts) {
      const normalizedPhone = phoneDigits(c.phone) || c.phone;
      if (optedOutSet.has(normalizedPhone)) continue;
      // Ensure contact exists in contacts table
      let contactId = c.id;
      if (list_id) {
        const existing = findContact.get(normalizedPhone);
        if (existing) { contactId = existing.id; }
        else {
          const r = insertContact.run(normalizedPhone, c.first_name || '', c.last_name || '', c.city || '');
          contactId = r.lastInsertRowid;
        }
      }
      // Skip if already assigned in this session
      const alreadyAssigned = db.prepare('SELECT id FROM p2p_assignments WHERE session_id = ? AND contact_id = ?').get(sessionId, contactId);
      if (alreadyAssigned) continue;

      // Auto-assign to online volunteers round-robin, or leave unassigned for next volunteer
      const volId = onlineVols.length > 0 ? onlineVols[volIndex % onlineVols.length].id : null;
      if (volId) volIndex++;

      db.prepare('INSERT INTO p2p_assignments (session_id, contact_id, volunteer_id) VALUES (?, ?, ?)').run(sessionId, contactId, volId);
      rsvpInsert.run(req.params.id, normalizedPhone, ((c.first_name || '') + ' ' + (c.last_name || '')).trim());
      queued++;
    }
  });
  inviteTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Event invites queued for ' + event.title + ': ' + queued + ' contacts' + (onlineVols.length > 0 ? ' (assigned to ' + onlineVols.length + ' volunteers)' : ' (waiting for volunteers)'));
  res.json({ success: true, queued: queued, sent: queued, joinCode, sessionId, p2p: true, volunteersOnline: onlineVols.length });
});

// --- Sentiment analysis ---
// Keyword fallback for when AI is unavailable
function analyzeSentimentKeywords(text) {
  const msg = (text || '').toLowerCase();
  const positiveWords = ['yes', 'sure', 'support', 'agree', 'thanks', 'thank', 'great', 'love', 'count me in', 'absolutely', 'interested', 'definitely', 'of course', 'wonderful', 'awesome', 'perfect', 'good', 'ok', 'okay', 'yep', 'yea', 'yeah'];
  const negativeWords = ['no', 'stop', 'disagree', 'oppose', 'hate', 'unsubscribe', 'leave me alone', 'not interested', 'remove', 'never', 'terrible', 'awful', 'worst', 'don\'t', 'wont', 'refuse', 'against', 'bad'];
  // Use word-boundary matching to avoid false positives ("no" matching "know", "ok" matching "broke")
  const words = new Set(msg.split(/\s+/));
  const hasPhrase = (phrase) => msg.includes(phrase);
  let score = 0;
  for (const word of positiveWords) { if (word.includes(' ') ? hasPhrase(word) : words.has(word)) score++; }
  for (const word of negativeWords) { if (word.includes(' ') ? hasPhrase(word) : words.has(word)) score--; }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// AI-powered sentiment analysis with keyword fallback
async function analyzeSentimentAI(text) {
  if (!text || !text.trim()) return 'neutral';
  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();
  if (!apiKey || !apiKey.value) return analyzeSentimentKeywords(text);
  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({ apiKey: apiKey.value });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'You analyze text messages sent to a political campaign. Classify the sentiment as exactly one word: positive, negative, or neutral. Positive = supportive, interested, friendly, willing to help. Negative = opposed, hostile, annoyed, wants to be left alone. Neutral = questions, unclear intent, or informational. Reply with ONLY one word.',
      messages: [{ role: 'user', content: text }]
    });
    const result = (response.content[0].text || '').trim().toLowerCase();
    if (['positive', 'negative', 'neutral'].includes(result)) return result;
    return analyzeSentimentKeywords(text);
  } catch (err) {
    console.warn('[sentiment] AI analysis failed, using keywords:', err.message);
    return analyzeSentimentKeywords(text);
  }
}

// Synchronous wrapper for webhook path (uses keywords, AI runs after)
function analyzeSentiment(text) {
  return analyzeSentimentKeywords(text);
}

function generateAutoReply(msg) {
  // Use word-boundary matching to avoid false positives (e.g., "sometime" matching "time")
  const words = new Set(msg.split(/\s+/));
  const hasWord = (keywords) => keywords.some(k => words.has(k));
  // Don't auto-reply if there's an active P2P assignment (volunteer should handle it)
  if (['register','registration'].some(k => msg.includes(k)))
    return "Register or check your status at vote.org. Don't miss the deadline! -- Campaign HQ";
  if (hasWord(['poll','polling','precinct','location']) || (words.has('where') && words.has('vote')))
    return "Find your polling location at vote.gov. Polls open 7am-7pm on Election Day! -- Campaign HQ";
  if (hasWord(['hours']) || (words.has('when') && (words.has('vote') || words.has('polls') || words.has('open'))))
    return "Polls are open 7:00 AM - 7:00 PM on Election Day. Check vote.gov for early voting! -- Campaign HQ";
  return null;
}

// --- Global error handler ---
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error.' });
});

// One-time user reset: set RESET_USERS=true in Railway env vars, deploy, then REMOVE it
if (process.env.RESET_USERS === 'true') {
  const deleted = db.prepare('DELETE FROM users').run();
  console.log(`⚠️  RESET_USERS: Deleted ${deleted.changes} user(s). Remove RESET_USERS env var now!`);
}




const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('CampaignText HQ running on port ' + PORT);
  // Log persistence status on startup
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() || { c: 0 }).c;
  const voterCount = (db.prepare('SELECT COUNT(*) as c FROM voters').get() || { c: 0 }).c;
  console.log(`Database: ${userCount} user(s), ${voterCount} voter(s)`);
  if (userCount === 0) {
    console.warn('No admin users found — setup required at /login');
  }
});

// --- Google Sheets auto-sync (every 5 minutes) ---
setInterval(async () => {
  try {
    const autoSync = db.prepare("SELECT value FROM settings WHERE key = 'google_auto_sync'").get();
    if (autoSync?.value !== 'true') return;
    const sheetId = db.prepare("SELECT value FROM settings WHERE key = 'google_sheet_id'").get();
    if (!sheetId) return;
    const user = db.prepare("SELECT id FROM users WHERE google_access_token IS NOT NULL AND google_access_token != '' LIMIT 1").get();
    if (!user) return;
    const { getAuthenticatedClient, syncToSheets } = require('./lib/google-sheets-sync');
    const auth = await getAuthenticatedClient(user.id);
    if (!auth) return;
    await syncToSheets(auth, sheetId.value);
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'google_last_sync'").get();
    if (existing) db.prepare("UPDATE settings SET value = ? WHERE key = 'google_last_sync'").run(now);
    else db.prepare("INSERT INTO settings (key, value) VALUES ('google_last_sync', ?)").run(now);
    console.log('Auto-sync to Google Sheets completed at', now);
  } catch (err) {
    console.error('Auto-sync error:', err.message);
  }
}, 5 * 60 * 1000);

// Graceful shutdown: close DB and stop accepting new connections
function shutdown(signal) {
  console.log(signal + ' received, shutting down...');
  server.close(() => {
    db.close();
    console.log('Server and database closed.');
    process.exit(0);
  });
  // Force exit after 10 seconds if connections don't close
  setTimeout(() => { db.close(); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
