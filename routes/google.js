const express = require('express');
const router = express.Router();
const { randomBytes } = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const { asyncHandler } = require('../utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOAuthClient() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;

  const base = process.env.BASE_URL || (process.env.NODE_ENV === 'production'
    ? 'https://villarrealjr.com'
    : 'http://localhost:3000');
  return new OAuth2Client(id, secret, `${base}/api/auth/google/callback`);
}

// ---------------------------------------------------------------------------
// 1. Start Google OAuth flow
// ---------------------------------------------------------------------------
router.get('/auth/google', (req, res) => {
  const client = getOAuthClient();
  if (!client) return res.status(500).json({ error: 'Google OAuth not configured.' });

  // Generate CSRF state token to prevent OAuth redirect attacks
  const state = randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state,
    scope: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });
  res.redirect(url);
});

// ---------------------------------------------------------------------------
// 2. Google OAuth callback
// ---------------------------------------------------------------------------
router.get('/auth/google/callback', asyncHandler(async (req, res) => {
  const client = getOAuthClient();
  if (!client) return res.redirect('/login?error=google_not_configured');

  const { code, error, state } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/login?error=no_code');

  // Verify CSRF state token
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/login?error=invalid_state');
  }
  delete req.session.oauthState;

  try {
    // Exchange code for tokens
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user info from Google
    const resp = await client.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' });
    const profile = resp.data;
    const googleId = profile.id;
    const email = profile.email;
    const name = profile.name || email;
    const picture = profile.picture || '';

    // Check if a user with this google_id already exists
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

    if (!user) {
      // Try matching by email on an existing user (link accounts)
      user = db.prepare('SELECT * FROM users WHERE username = ? OR google_email = ?').get(email, email);

      if (user) {
        // Link Google to existing user
        db.prepare(`UPDATE users SET
          google_id = ?, google_email = ?, google_name = ?, google_picture = ?,
          google_access_token = ?, google_refresh_token = ?, google_token_expiry = ?
          WHERE id = ?`).run(
          googleId, email, name, picture,
          tokens.access_token, tokens.refresh_token || '', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
          user.id
        );
      } else {
        // Brand-new Google user
        const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const role = count === 0 ? 'admin' : 'admin'; // all users admin for now

        const result = db.prepare(`INSERT INTO users
          (username, password_hash, display_name, role,
           google_id, google_email, google_name, google_picture,
           google_access_token, google_refresh_token, google_token_expiry)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          email, '', name, role,
          googleId, email, name, picture,
          tokens.access_token, tokens.refresh_token || '', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : ''
        );
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      }
    } else {
      // Existing Google user — update tokens
      db.prepare(`UPDATE users SET
        google_name = ?, google_picture = ?,
        google_access_token = ?,
        google_refresh_token = CASE WHEN ? != '' THEN ? ELSE google_refresh_token END,
        google_token_expiry = ?,
        last_login = datetime('now')
        WHERE id = ?`).run(
        name, picture,
        tokens.access_token,
        tokens.refresh_token || '', tokens.refresh_token || '',
        tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
        user.id
      );
    }

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.display_name || user.google_name || name;
    req.session.role = user.role;

    res.redirect('/app');
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect('/login?error=oauth_failed');
  }
}));

// ---------------------------------------------------------------------------
// 3. Google Sheets — Setup (create spreadsheet)
// ---------------------------------------------------------------------------
router.post('/google/sheets/setup', asyncHandler(async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });

  try {
    const { getAuthenticatedClient, createSpreadsheet } = require('../lib/google-sheets-sync');
    const auth = await getAuthenticatedClient(req.session.userId);
    if (!auth) return res.status(400).json({ error: 'Google account not connected. Sign in with Google first.' });

    const spreadsheetId = await createSpreadsheet(auth);

    // Store sheet ID in settings
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'google_sheet_id'").get();
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'google_sheet_id'").run(spreadsheetId);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('google_sheet_id', ?)").run(spreadsheetId);
    }

    res.json({ success: true, spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  } catch (err) {
    console.error('Sheets setup error:', err.message);
    res.status(500).json({ error: 'Failed to create Google Sheet: ' + err.message });
  }
}));

// ---------------------------------------------------------------------------
// 4. Google Sheets — Status
// ---------------------------------------------------------------------------
router.get('/google/sheets/status', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });

  const user = db.prepare('SELECT google_email, google_name, google_picture FROM users WHERE id = ?').get(req.session.userId);
  const sheetId = db.prepare("SELECT value FROM settings WHERE key = 'google_sheet_id'").get();
  const autoSync = db.prepare("SELECT value FROM settings WHERE key = 'google_auto_sync'").get();
  const lastSync = db.prepare("SELECT value FROM settings WHERE key = 'google_last_sync'").get();

  res.json({
    googleConnected: !!(user && user.google_email),
    googleEmail: user?.google_email || null,
    googleName: user?.google_name || null,
    googlePicture: user?.google_picture || null,
    sheetId: sheetId?.value || null,
    sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId.value}` : null,
    autoSyncEnabled: autoSync?.value === 'true',
    lastSync: lastSync?.value || null
  });
});

// ---------------------------------------------------------------------------
// 5. Google Sheets — Manual sync
// ---------------------------------------------------------------------------
router.post('/google/sheets/sync', asyncHandler(async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });

  try {
    const { getAuthenticatedClient, syncToSheets } = require('../lib/google-sheets-sync');
    const auth = await getAuthenticatedClient(req.session.userId);
    if (!auth) return res.status(400).json({ error: 'Google account not connected.' });

    const sheetId = db.prepare("SELECT value FROM settings WHERE key = 'google_sheet_id'").get();
    if (!sheetId) return res.status(400).json({ error: 'No Google Sheet set up yet. Click "Setup Google Sheet" first.' });

    await syncToSheets(auth, sheetId.value);

    // Update last sync time
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'google_last_sync'").get();
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'google_last_sync'").run(now);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('google_last_sync', ?)").run(now);
    }

    res.json({ success: true, syncedAt: now });
  } catch (err) {
    console.error('Sheets sync error:', err.message);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
}));

// ---------------------------------------------------------------------------
// 6. Google Sheets — Toggle auto-sync
// ---------------------------------------------------------------------------
router.post('/google/sheets/toggle', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });

  const { enabled } = req.body;
  const val = enabled ? 'true' : 'false';
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'google_auto_sync'").get();
  if (existing) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'google_auto_sync'").run(val);
  } else {
    db.prepare("INSERT INTO settings (key, value) VALUES ('google_auto_sync', ?)").run(val);
  }
  res.json({ success: true, autoSyncEnabled: enabled });
});

// ---------------------------------------------------------------------------
// 7. Google Sheets — Import from Sheet (disaster recovery)
// ---------------------------------------------------------------------------
router.post('/google/sheets/import', asyncHandler(async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in.' });

  try {
    const { getAuthenticatedClient, importFromSheets } = require('../lib/google-sheets-sync');
    const auth = await getAuthenticatedClient(req.session.userId);
    if (!auth) return res.status(400).json({ error: 'Google account not connected.' });

    const { sheetUrl, dataType } = req.body;
    // Extract sheet ID from URL
    let sheetId = sheetUrl;
    const match = sheetUrl?.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (match) sheetId = match[1];

    if (!sheetId) return res.status(400).json({ error: 'Invalid Google Sheet URL.' });

    const result = await importFromSheets(auth, sheetId, dataType || 'voters');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Sheets import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
}));

module.exports = router;
