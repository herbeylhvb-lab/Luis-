const express = require('express');
const router = express.Router();
const db = require('../db');

// ========== SETTINGS ==========

// Keys that can be read/written through the generic settings API
const SETTINGS_ALLOWLIST = [
  'anthropic_api_key', 'candidate_name', 'campaign_name', 'campaign_info',
  'opt_out_footer', 'auto_reply_enabled', 'default_area_code',
  'twilio_account_sid', 'twilio_auth_token',
];

// Keys that are write-only (sensitive credentials should not be readable)
const WRITE_ONLY_KEYS = ['anthropic_api_key', 'twilio_auth_token'];

router.get('/settings/:key', (req, res) => {
  if (!SETTINGS_ALLOWLIST.includes(req.params.key)) {
    return res.status(403).json({ error: 'This setting cannot be read through this endpoint.' });
  }
  if (WRITE_ONLY_KEYS.includes(req.params.key)) {
    // Return whether the key is set, but not the actual value
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(req.params.key);
    return res.json({ value: row ? '********' : null, isSet: !!row });
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(req.params.key);
  res.json({ value: row ? row.value : null });
});

router.put('/settings/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'Value required.' });
  if (!SETTINGS_ALLOWLIST.includes(req.params.key)) {
    return res.status(403).json({ error: 'This setting cannot be modified through this endpoint.' });
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(req.params.key, value, value);
  res.json({ success: true });
});

// ========== CAMPAIGN KNOWLEDGE ==========

router.get('/knowledge', (req, res) => {
  const entries = db.prepare('SELECT * FROM campaign_knowledge ORDER BY type, id').all();
  res.json({ entries });
});

router.post('/knowledge', (req, res) => {
  const { type, title, content } = req.body;
  if (!type || !title || !content) return res.status(400).json({ error: 'Type, title, and content required.' });
  const result = db.prepare('INSERT INTO campaign_knowledge (type, title, content) VALUES (?, ?, ?)').run(type, title, content);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/knowledge/:id', (req, res) => {
  const { type, title, content } = req.body;
  const result = db.prepare("UPDATE campaign_knowledge SET type = COALESCE(?, type), title = COALESCE(?, title), content = COALESCE(?, content), updated_at = datetime('now') WHERE id = ?")
    .run(type, title, content, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Knowledge entry not found.' });
  res.json({ success: true });
});

router.delete('/knowledge/:id', (req, res) => {
  const result = db.prepare('DELETE FROM campaign_knowledge WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Knowledge entry not found.' });
  res.json({ success: true });
});

// ========== RESPONSE SCRIPTS ==========

router.get('/scripts', (req, res) => {
  const scripts = db.prepare('SELECT * FROM response_scripts ORDER BY scenario').all();
  res.json({ scripts });
});

router.post('/scripts', (req, res) => {
  const { scenario, label, content } = req.body;
  if (!scenario || !label || !content) return res.status(400).json({ error: 'Scenario, label, and content required.' });
  const result = db.prepare('INSERT INTO response_scripts (scenario, label, content) VALUES (?, ?, ?)').run(scenario, label, content);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/scripts/:id', (req, res) => {
  const { scenario, label, content } = req.body;
  const result = db.prepare('UPDATE response_scripts SET scenario = COALESCE(?, scenario), label = COALESCE(?, label), content = COALESCE(?, content) WHERE id = ?')
    .run(scenario, label, content, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Script not found.' });
  res.json({ success: true });
});

router.delete('/scripts/:id', (req, res) => {
  const result = db.prepare('DELETE FROM response_scripts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Script not found.' });
  res.json({ success: true });
});

module.exports = router;
