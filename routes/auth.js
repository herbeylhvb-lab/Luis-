const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

// Check if any users exist (for first-time setup)
router.get('/auth/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
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
router.post('/auth/setup', async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count > 0) return res.status(400).json({ error: 'Setup already completed. Use login.' });

  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
    username.toLowerCase().trim(), hash, displayName || username, 'admin'
  );

  // Auto-login after setup
  req.session.userId = result.lastInsertRowid;
  req.session.username = username.toLowerCase().trim();
  req.session.displayName = displayName || username;
  req.session.role = 'admin';

  res.json({ success: true, message: 'Admin account created.' });
});

// Login
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password.' });

  // Update last login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;

  res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name } });
});

// Logout
router.post('/auth/logout', (req, res) => {
  req.session.destroy(function(err) {
    res.json({ success: true });
  });
});

// Change password
router.post('/auth/change-password', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in.' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);

  res.json({ success: true, message: 'Password updated.' });
});

module.exports = router;
