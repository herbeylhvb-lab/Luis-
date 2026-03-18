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
    // If APP_URL is configured, enforce it; otherwise allow all origins
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
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
app.get('/v/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'voter-checkin.html')));
app.get('/captain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
app.get('/candidate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'candidate.html')));
app.get('/group', (req, res) => res.sendFile(path.join(__dirname, 'public', 'group.html')));
app.get('/walker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'walker.html')));
app.get('/texter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'texter.html')));

// Public API routes (volunteer/walker endpoints that don't need admin auth)
const publicApiPaths = [
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
      req.path.match(/^\/api\/walks\/\d+\/location/)) {
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
      req.path === '/api/p2p/texting-volunteers/login' ||
      req.path.match(/^\/api\/p2p\/texting-volunteers\/\d+\/dashboard/)) {
    return next();
  }
  // Allow captain portal endpoints (used by captain.html without admin auth)
  if (req.path.match(/^\/api\/captains\/login/) ||
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
app.use('/api', require('./routes/captains'));
app.use('/api', require('./routes/candidates'));
app.use('/api', require('./routes/email'));
app.use('/api', require('./routes/admin-lists'));
app.use('/api', require('./routes/groups'));
app.use('/api', require('./routes/surveys'));
app.use('/api', require('./routes/broadcast'));
app.use('/api', require('./routes/rumbleup'));

// --- TCPA: Bulk SMS endpoint removed ---
app.post('/send', (req, res) => {
  res.status(410).json({ error: 'Bulk SMS sending has been disabled for TCPA compliance. Use P2P sessions instead.' });
});

// --- Core endpoints ---

app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const users = (db.prepare('SELECT COUNT(*) as c FROM users').get() || { c: 0 }).c;
    const voters = (db.prepare('SELECT COUNT(*) as c FROM voters').get() || { c: 0 }).c;
    res.json({ status: 'ok', uptime: process.uptime(), users, voters });
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

// --- Stats (single query) ---
const _statsQuery = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM contacts) as contacts,
    (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') as sent,
    (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') as responses,
    (SELECT COUNT(*) FROM opt_outs) as optedOut,
    (SELECT COUNT(*) FROM block_walks) as walks,
    (SELECT COUNT(*) FROM walk_addresses WHERE result != 'not_visited') as doorsKnocked,
    (SELECT COUNT(*) FROM voters) as voters,
    (SELECT COUNT(*) FROM events WHERE status = 'upcoming') as upcomingEvents
`);
app.get('/api/stats', (req, res) => {
  res.json(_statsQuery.get());
});

// --- Activity log ---
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
    p.saveCredentials({ apiKey, apiSecret, phoneNumber: req.body.phoneNumber, actionId: req.body.actionId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Connection test failed:', err.message);
    res.status(401).json({ success: false, error: err.message || 'Invalid credentials.' });
  }
}));

// --- Incoming webhook (messaging provider) ---
app.post('/incoming', webhookLimiter, async (req, res) => {
  console.log('[webhook /incoming] Received webhook:', JSON.stringify(req.body).substring(0, 500));
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
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  // Normalize phone to 10-digit for matching against stored contacts
  const fromNormalized = phoneDigits(From);

  try {

  const msgText = (Body || '').trim().toLowerCase();
  if (STOP_KEYWORDS.includes(msgText)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run(fromNormalized);
    return res.type(replyType).send(provider.buildReply("You've been removed from our list. -- Campaign HQ"));
  }

  const sentiment = await analyzeSentimentAI(Body);

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
  const p2pAssignment = db.prepare(`
    SELECT a.*, s.id as sid FROM p2p_assignments a
    JOIN p2p_sessions s ON a.session_id = s.id
    JOIN contacts c ON a.contact_id = c.id
    WHERE (c.phone = ? OR REPLACE(REPLACE(REPLACE(c.phone,'+1',''),'+',''),'-','') = ?)
      AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    ORDER BY a.sent_at DESC LIMIT 1
  `).get(fromNormalized, fromNormalized);

  if (p2pAssignment) {
    db.transaction(() => {
      db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(p2pAssignment.id);
      db.prepare("INSERT INTO messages (phone, body, direction, sentiment, session_id, channel) VALUES (?, ?, 'inbound', ?, ?, ?)").run(fromNormalized, Body, sentiment, p2pAssignment.sid, channel);
    })();
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, 'inbound', ?, ?)").run(fromNormalized, Body, sentiment, channel);
  const autoReply = generateAutoReply(msgText);
  if (autoReply) {
    return res.type(replyType).send(provider.buildReply(autoReply));
  }
  res.type(replyType).send(provider.buildEmptyReply());

  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.type(replyType).send(provider.buildEmptyReply());
  }
});

// --- Messages & opt-outs ---
// Pending messages: last inbound per phone with no outbound reply after it
app.get('/api/messages/pending', (req, res) => {
  const pending = db.prepare(`
    SELECT m.*,
      COALESCE(v.first_name || ' ' || v.last_name, c.first_name || ' ' || c.last_name) as contact_name
    FROM messages m
    LEFT JOIN voters v ON m.phone = v.phone AND v.phone != '' AND v.phone IS NOT NULL
    LEFT JOIN contacts c ON m.phone = c.phone AND c.phone != '' AND c.phone IS NOT NULL
    WHERE m.direction = 'inbound'
      AND m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.phone = m.phone AND m2.direction = 'inbound')
      AND NOT EXISTS (
        SELECT 1 FROM messages out_msg
        WHERE out_msg.phone = m.phone AND out_msg.direction = 'outbound' AND out_msg.id > m.id
      )
      AND m.phone NOT IN (SELECT phone FROM opt_outs)
    ORDER BY m.id DESC LIMIT 100
  `).all();
  res.json({ messages: pending });
});

app.get('/api/messages', (req, res) => {
  const messages = db.prepare(`
    SELECT m.*,
      COALESCE(v.first_name || ' ' || v.last_name, c.first_name || ' ' || c.last_name) as contact_name
    FROM messages m
    LEFT JOIN voters v ON m.phone = v.phone AND v.phone != '' AND v.phone IS NOT NULL
    LEFT JOIN contacts c ON m.phone = c.phone AND c.phone != '' AND c.phone IS NOT NULL
    WHERE m.direction = 'inbound'
    GROUP BY m.id
    ORDER BY m.id DESC LIMIT 200
  `).all();
  const optedOut = db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone);
  res.json({ messages, optedOut });
});

// --- Reply (SMS or WhatsApp) ---
app.post('/reply', sendLimiter, asyncHandler(async (req, res) => {
  const provider = getProvider();
  const { to, body, channel } = req.body;
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });
  if (!to || !body) return res.status(400).json({ error: 'Recipient and message body required.' });
  // Check opt-out list before sending (TCPA compliance)
  const toDigits = phoneDigits(to);
  if (toDigits && db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(toDigits)) {
    return res.status(400).json({ error: 'Contact has opted out. Cannot send messages.' });
  }
  try {
    await provider.sendMessage(to, body, channel);
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, ?, 'outbound')").run(phoneDigits(to) || to, body);
    res.json({ success: true });
  } catch (err) {
    console.error('Reply send error:', err.message);
    res.status(500).json({ error: 'Failed to send reply: ' + err.message });
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
      apiTest = { phone: testPhone, rawResponse: raw, type: typeof raw, isArray: Array.isArray(raw) };
    } catch (err) {
      apiTest = { phone: testPhone, error: err.message };
    }
  }

  res.json({
    phonesToCheck: sentPhones.length,
    breakdown: { p2p: p2pCount, survey: surveyCount, outbound: outboundCount },
    samplePhones: sentPhones.slice(0, 5),
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

  // Process phones in parallel batches of 5 for speed
  const BATCH_SIZE = 5;
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

        const messages = result.messages || result.data || result || [];
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

        // Check for duplicate by phone + body (use timestamp when available to allow repeated messages)
        const dedupQuery = msgTime
          ? "SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' AND timestamp = ? LIMIT 1"
          : "SELECT id FROM messages WHERE phone = ? AND body = ? AND direction = 'inbound' LIMIT 1";
        const existing = msgTime
          ? db.prepare(dedupQuery).get(msgPhone, msgBody, msgTime)
          : db.prepare(dedupQuery).get(msgPhone, msgBody);
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

        // Find P2P session for this phone so we can tag the message with session_id
        const p2pMatch = db.prepare(`
          SELECT a.id as assignment_id, s.id as session_id FROM p2p_assignments a
          JOIN p2p_sessions s ON a.session_id = s.id
          JOIN contacts c ON a.contact_id = c.id
          WHERE (c.phone = ? OR REPLACE(REPLACE(REPLACE(c.phone,'+1',''),'+',''),'-','') = ?)
            AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
          ORDER BY a.sent_at DESC LIMIT 1
        `).get(msgPhone, msgPhone);

        // Insert the inbound message (with session_id if P2P match found)
        // Use fast keyword sentiment during sync (AI would be too slow for batch)
        const sentiment = analyzeSentiment(msgBody);
        db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel, timestamp, session_id) VALUES (?, ?, 'inbound', ?, 'sms', COALESCE(?, datetime('now')), ?)")
          .run(msgPhone, msgBody, sentiment, msgTime, p2pMatch ? p2pMatch.session_id : null);
        totalSynced++;

        // Route to survey if applicable
        const activeSend = db.prepare(`
          SELECT ss.*, s.name as survey_name, s.completion_message FROM survey_sends ss
          JOIN surveys s ON ss.survey_id = s.id
          WHERE ss.phone = ? AND ss.status IN ('sent', 'in_progress') AND s.status = 'active'
          ORDER BY ss.sent_at DESC LIMIT 1
        `).get(msgPhone);

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

        // Route to P2P if applicable — only if not already handled by survey
        if (p2pMatch && !(activeSend && activeSend.current_question_id)) {
          db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(p2pMatch.assignment_id);
        }
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

// --- WhatsApp bulk send (stub — provider does not yet support WhatsApp) ---
app.post('/api/whatsapp/send', asyncHandler(async (req, res) => {
  const provider = getProvider();
  if (!provider.hasCredentials()) return res.status(400).json({ error: 'Messaging credentials not configured.' });

  const { contacts, messageTemplate, optOutFooter } = req.body;
  if (!contacts || !contacts.length) return res.status(400).json({ error: 'No contacts provided.' });
  if (!messageTemplate) return res.status(400).json({ error: 'Message template is required.' });

  const fullMsg = messageTemplate + (optOutFooter ? '\n' + optOutFooter : '');

  // Filter opted-out contacts
  const optedOut = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  const eligible = contacts.filter(c => {
    const d = phoneDigits(c.phone);
    return d && !optedOut.has(d);
  });

  if (eligible.length === 0) return res.status(400).json({ error: 'All contacts have opted out.' });

  let sent = 0, failed = 0;
  const errors = [];
  for (const c of eligible) {
    const personalMsg = personalizeTemplate(fullMsg, c);
    try {
      await provider.sendMessage(c.phone, personalMsg, 'whatsapp');
      db.prepare("INSERT INTO messages (phone, body, direction, channel) VALUES (?, ?, 'outbound', 'whatsapp')").run(phoneDigits(c.phone), personalMsg);
      sent++;
    } catch (err) {
      failed++;
      if (errors.length < 5) errors.push(c.phone + ': ' + (err.message || 'Unknown error'));
    }
  }

  res.json({ success: true, sent, failed, total: eligible.length, errors });
}));

// --- Send event invites via P2P session (TCPA compliant) ---
app.post('/api/events/:id/invite', (req, res) => {
  const { contactIds, list_id, messageTemplate, precinct_filter } = req.body;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

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
    const getC = db.prepare('SELECT * FROM contacts WHERE id = ?');
    for (const cid of contactIds) {
      const c = getC.get(cid);
      if (c) contacts.push(c);
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

  // Create a P2P session for the invites
  const joinCode = generateJoinCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const sessionResult = db.prepare(
    'INSERT INTO p2p_sessions (name, message_template, assignment_mode, join_code, code_expires_at, session_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('Event Invite: ' + event.title, template, 'auto_split', joinCode, expiresAt, 'event');
  const sessionId = sessionResult.lastInsertRowid;

  // Queue contacts as P2P assignments + record RSVPs
  const insertAssign = db.prepare('INSERT INTO p2p_assignments (session_id, contact_id) VALUES (?, ?)');
  const rsvpInsert = db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, 'invited')");
  const optedOutSet = new Set(db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone));
  // For list-based invites, ensure contacts table entries exist for P2P assignments
  const findContact = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const insertContact = db.prepare('INSERT INTO contacts (phone, first_name, last_name, city) VALUES (?, ?, ?, ?)');
  let queued = 0;
  const inviteTx = db.transaction(() => {
    for (const c of contacts) {
      if (optedOutSet.has(phoneDigits(c.phone))) continue;
      // Ensure contact exists in contacts table for P2P assignment
      let contactId = c.id;
      if (list_id) {
        const existing = findContact.get(c.phone);
        if (existing) { contactId = existing.id; }
        else {
          const r = insertContact.run(c.phone, c.first_name || '', c.last_name || '', c.city || '');
          contactId = r.lastInsertRowid;
        }
      }
      try { insertAssign.run(sessionId, contactId); } catch (e) { if (!e.message.includes('UNIQUE')) throw e; }
      rsvpInsert.run(req.params.id, c.phone, ((c.first_name || '') + ' ' + (c.last_name || '')).trim());
      queued++;
    }
  });
  inviteTx();

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Event invite P2P session created for ' + event.title + ': ' + queued + ' contacts queued.');
  res.json({ success: true, sent: queued, joinCode, sessionId, p2p: true });
});

// --- Sentiment analysis ---
// Keyword fallback for when AI is unavailable
function analyzeSentimentKeywords(text) {
  const msg = (text || '').toLowerCase();
  const positiveWords = ['yes', 'sure', 'support', 'agree', 'thanks', 'thank', 'great', 'love', 'count me in', 'absolutely', 'interested', 'definitely', 'of course', 'wonderful', 'awesome', 'perfect', 'good', 'ok', 'okay', 'yep', 'yea', 'yeah'];
  const negativeWords = ['no', 'stop', 'disagree', 'oppose', 'hate', 'unsubscribe', 'leave me alone', 'not interested', 'remove', 'never', 'terrible', 'awful', 'worst', 'don\'t', 'wont', 'refuse', 'against', 'bad'];
  let score = 0;
  for (const word of positiveWords) { if (msg.includes(word)) score++; }
  for (const word of negativeWords) { if (msg.includes(word)) score--; }
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
  // Check registration FIRST so "register to vote" matches registration, not polling
  if (['register','registration'].some(k => msg.includes(k)))
    return "Register or check your status at vote.org. Don't miss the deadline! -- Campaign HQ";
  if (['poll','polling','vote','where','location'].some(k => msg.includes(k)))
    return "Find your polling location at vote.gov. Polls open 7am-7pm on Election Day! -- Campaign HQ";
  if (['time','open','close','hours','when'].some(k => msg.includes(k)))
    return "Polls are open 7:00 AM - 7:00 PM on Election Day. Check vote.gov for early voting! -- Campaign HQ";
  return null;
}

// --- Global error handler ---
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
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
