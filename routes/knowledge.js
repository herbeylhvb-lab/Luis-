const express = require('express');
const router = express.Router();
const db = require('../db');

// ========== SETTINGS ==========

router.get('/settings/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(req.params.key);
  res.json({ value: row ? row.value : null });
});

router.put('/settings/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'Value required.' });
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
  db.prepare("UPDATE campaign_knowledge SET type = COALESCE(?, type), title = COALESCE(?, title), content = COALESCE(?, content), updated_at = datetime('now') WHERE id = ?")
    .run(type, title, content, req.params.id);
  res.json({ success: true });
});

router.delete('/knowledge/:id', (req, res) => {
  db.prepare('DELETE FROM campaign_knowledge WHERE id = ?').run(req.params.id);
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
  db.prepare('UPDATE response_scripts SET scenario = COALESCE(?, scenario), label = COALESCE(?, label), content = COALESCE(?, content) WHERE id = ?')
    .run(scenario, label, content, req.params.id);
  res.json({ success: true });
});

router.delete('/scripts/:id', (req, res) => {
  db.prepare('DELETE FROM response_scripts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
