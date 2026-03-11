const express = require('express');
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

// CORS — restrict to own origin (set APP_URL env var in production)
const ALLOWED_ORIGINS = [
  process.env.APP_URL,
].filter(Boolean);

app.use(cors({
  credentials: true,
  origin: function(origin, callback) {
    // Allow same-origin requests (no origin header) and allowed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(null, false);
  }
}));

// Rate limiting on sensitive endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later.' } });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many send requests, slow down.' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Rate limit exceeded.' } });
const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many join attempts.' } });

// Bulk import paths need a higher body limit (50mb); skip the default 2mb parser for them
const BULK_PATHS = ['/api/voters/import', '/api/voters/import-canvass', '/api/voters/import-voter-file', '/api/election-votes/import', '/api/election-votes/import-turnout', '/api/early-voting/import', '/api/voters/enrich'];
app.use((req, res, next) => {
  if (BULK_PATHS.some(p => req.path.startsWith(p))) return next();
  express.json({ limit: '2mb' })(req, res, next);
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
    sameSite: 'lax',
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
// Serve static files ONLY for public assets (CSS, JS, images)
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
// Static assets
// Public pages that don't need auth
app.get('/volunteer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'volunteer.html')));
app.get('/walk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'walk.html')));
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
app.get('/checkin/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/v/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'voter-checkin.html')));
app.get('/captain', (req, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
app.get('/candidate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'candidate.html')));

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
      req.path === '/api/p2p/send') {
    return next();
  }
  // Allow captain portal endpoints (used by captain.html without admin auth)
  if (req.path.match(/^\/api\/captains\/login/) ||
      req.path.match(/^\/api\/captains\/\d+\/lists/) ||
      req.path.match(/^\/api\/captains\/\d+\/assigned-lists/) ||
      req.path.match(/^\/api\/captains\/\d+\/team/) ||
      req.path.match(/^\/api\/captains\/\d+\/search/) ||
      req.path.match(/^\/api\/captains\/\d+\/household/)) {
    return next();
  }
  // Allow candidate portal endpoints (used by candidate.html without admin auth)
  if (req.path.match(/^\/api\/candidates\/login/) ||
      req.path.match(/^\/api\/candidates\/\d+\/portal/) ||
      req.path.match(/^\/api\/candidates\/\d+\/search/) ||
      req.path.match(/^\/api\/candidates\/\d+\/household/) ||
      req.path.match(/^\/api\/candidates\/\d+\/lists/)) {
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
  // Allow root (serves dashboard or redirects to login)
  if (req.path === '/') return next();

  // Everything else requires auth
  requireAuth(req, res, next);
});

// Serve static files for authenticated users
app.use(express.static(path.join(__dirname, 'public')));

const { generateJoinCode, asyncHandler, phoneDigits } = require('./utils');

const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

// --- Mount API routes ---
// Bulk import endpoints get a higher body limit for large CSV/voter file uploads
const bulkJsonParser = express.json({ limit: '50mb' });
app.use('/api/voters/import', bulkJsonParser);
app.use('/api/voters/import-canvass', bulkJsonParser);
app.use('/api/election-votes/import', bulkJsonParser);
app.use('/api/election-votes/import-turnout', bulkJsonParser);
app.use('/api/early-voting/import', bulkJsonParser);
app.use('/api/voters/enrich', bulkJsonParser);

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
app.use('/api', require('./routes/surveys'));
app.use('/api', require('./routes/broadcast'));

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

app.get('/', (req, res) => {
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
app.post('/incoming', webhookLimiter, (req, res) => {
  let provider;
  try {
    provider = getProvider();
  } catch (err) {
    console.error('Webhook provider error:', err.message);
    return res.type('application/json').send('{"ok":true}');
  }
  // Use the provider's declared content type for all webhook responses
  const replyType = provider.responseContentType || 'application/json';
  const webhook = provider.getWebhookData(req);
  const From = webhook.from;
  const Body = webhook.body;
  const channel = webhook.channel || 'sms';
  if (!From) {
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  // Normalize phone to 10-digit for matching against stored contacts
  const fromNormalized = phoneDigits(From);

  const msgText = (Body || '').trim().toLowerCase();
  if (STOP_KEYWORDS.includes(msgText)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run(fromNormalized);
    return res.type(replyType).send(provider.buildReply("You've been removed from our list. -- Campaign HQ"));
  }

  const sentiment = analyzeSentiment(Body);

  // Check if this is a survey response (only when the survey is actively running)
  const activeSend = db.prepare(`
    SELECT ss.*, s.name as survey_name FROM survey_sends ss
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
      surveyResponseTx();

      if (nextQ) {
        const nextOpts = db.prepare('SELECT * FROM survey_options WHERE question_id = ? ORDER BY sort_order, id').all(nextQ.id);
        const nextMsg = buildSurveyMessage(activeSend.survey_name, nextQ, nextOpts);
        return res.type(replyType).send(provider.buildReply(nextMsg));
      } else {
        return res.type(replyType).send(provider.buildReply('Thank you for completing the survey! Your responses have been recorded.'));
      }
    }
  }

  // Check if this is a reply to an active P2P session
  const p2pAssignment = db.prepare(`
    SELECT a.*, s.id as sid FROM p2p_assignments a
    JOIN p2p_sessions s ON a.session_id = s.id
    JOIN contacts c ON a.contact_id = c.id
    WHERE c.phone = ? AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    ORDER BY a.sent_at DESC LIMIT 1
  `).get(fromNormalized);

  if (p2pAssignment) {
    db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(p2pAssignment.id);
    db.prepare("INSERT INTO messages (phone, body, direction, sentiment, session_id, channel) VALUES (?, ?, 'inbound', ?, ?, ?)").run(fromNormalized, Body, sentiment, p2pAssignment.sid, channel);
    return res.type(replyType).send(provider.buildEmptyReply());
  }

  db.prepare("INSERT INTO messages (phone, body, direction, sentiment, channel) VALUES (?, ?, 'inbound', ?, ?)").run(fromNormalized, Body, sentiment, channel);
  const autoReply = generateAutoReply(msgText);
  if (autoReply) {
    return res.type(replyType).send(provider.buildReply(autoReply));
  }
  res.type(replyType).send(provider.buildEmptyReply());
});

// --- Messages & opt-outs ---
app.get('/api/messages', (req, res) => {
  const messages = db.prepare("SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id DESC LIMIT 200").all();
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
    res.status(500).json({ error: 'Failed to send reply. Check messaging provider configuration.' });
  }
}));

// --- Send event invites via P2P session (TCPA compliant) ---
app.post('/api/events/:id/invite', (req, res) => {
  const { contactIds, list_id, messageTemplate } = req.body;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Gather contacts — from list or individual IDs
  let contacts = [];
  if (list_id) {
    contacts = db.prepare(`
      SELECT v.id, v.phone, v.first_name, v.last_name
      FROM admin_list_voters alv
      JOIN voters v ON alv.voter_id = v.id
      WHERE alv.list_id = ? AND v.phone != ''
    `).all(list_id);
  } else if (contactIds && contactIds.length > 0) {
    const getC = db.prepare('SELECT * FROM contacts WHERE id = ?');
    for (const cid of contactIds) {
      const c = getC.get(cid);
      if (c) contacts.push(c);
    }
  }
  if (contacts.length === 0) return res.status(400).json({ error: 'No contacts with phone numbers found.' });

  // Build the invite message template
  const template = (messageTemplate || 'You\'re invited to {title} on {date} at {location}!')
    .replace(/{title}/g, event.title)
    .replace(/{date}/g, event.event_date)
    .replace(/{time}/g, event.event_time || '')
    .replace(/{location}/g, event.location || '')
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
      if (optedOutSet.has(c.phone)) continue;
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
function analyzeSentiment(text) {
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
