const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { asyncHandler } = require('../utils');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// Check if any users exist (for first-time setup)
router.get('/auth/status', (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() || { c: 0 }).c;
  const loggedIn = !!(req.session && req.session.userId);

  // Google OAuth availability
  const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  let googleConnected = false;
  let googleEmail = null;
  let googlePicture = null;
  if (loggedIn) {
    const user = db.prepare('SELECT google_email, google_picture FROM users WHERE id = ?').get(req.session.userId);
    if (user && user.google_email) {
      googleConnected = true;
      googleEmail = user.google_email;
      googlePicture = user.google_picture;
    }
  }

  res.json({
    hasUsers: count > 0,
    loggedIn,
    user: loggedIn ? { id: req.session.userId, username: req.session.username, displayName: req.session.displayName } : null,
    googleEnabled,
    googleConnected,
    googleEmail,
    googlePicture
  });
});

// First-time setup: create the initial admin account
router.post('/auth/setup', asyncHandler(async (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() || { c: 0 }).c;
  if (count > 0) return res.status(400).json({ error: 'Setup already completed. Use login.' });

  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
    username.toLowerCase().trim(), hash, displayName || username, 'admin'
  );

  // Auto-login after setup — regenerate session first to prevent fixation.
  // If an attacker planted a session id before setup, regenerate invalidates
  // it and issues a fresh one tied to the newly-created admin.
  req.session.regenerate(function(err) {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.userId = result.lastInsertRowid;
    req.session.username = username.toLowerCase().trim();
    req.session.displayName = displayName || username;
    req.session.role = 'admin';
    req.session.save(function() {
      res.json({ success: true, message: 'Admin account created.' });
    });
  });
}));

// Login
router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password.' });

  // Update last login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  // Regenerate session before writing user data — prevents session fixation,
  // where an attacker plants a known session id and waits for a victim to
  // authenticate with it. Regenerate issues a fresh id bound to this login.
  req.session.regenerate(function(err) {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.display_name;
    req.session.role = user.role;
    req.session.save(function() {
      res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name } });
    });
  });
}));

// Logout
router.post('/auth/logout', (req, res) => {
  req.session.destroy(function(err) {
    if (err) console.error('Session destroy error:', err.message);
    res.json({ success: true });
  });
});

// Change password
router.post('/auth/change-password', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in.' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found. Please log in again.' });
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);

  res.json({ success: true, message: 'Password updated.' });
}));

// ── User management (admin only) ──

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// List all users
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, phone, created_at, last_login FROM users ORDER BY id').all();
  res.json({ users });
});

// Create user
router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, displayName, role, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const validRoles = ['admin', 'captain', 'blockwalker', 'volunteer'];
  const userRole = validRoles.includes(role) ? role : 'volunteer';
  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role, phone) VALUES (?, ?, ?, ?, ?)').run(
      username.toLowerCase().trim(), hash, displayName || username, userRole, phone || null
    );
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists.' });
    console.error('Create user error:', e.message);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
}));

// Reset user password
router.put('/users/:id/password', requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ success: true });
}));

// Delete user
router.delete('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ success: true });
});

module.exports = router;
