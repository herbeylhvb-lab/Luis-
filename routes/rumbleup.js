const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { getProviderByName } = require('../providers');

function getRumbleUp() {
  const provider = getProviderByName('rumbleup');
  if (!provider) throw new Error('RumbleUp provider not found.');
  if (!provider.hasCredentials()) throw new Error('RumbleUp credentials not configured.');
  return provider;
}

// ========== ACCOUNT ==========

router.get('/rumbleup/account', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const account = await ru.getAccount();
  res.json(account);
}));

// ========== PROJECTS ==========

router.get('/rumbleup/projects', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.getProjectStats({
    format: 'json',
    days: parseInt(req.query.days) || 90,
    project: req.query.project || undefined,
    name: req.query.name || undefined
  });
  // Handle various response formats — stats endpoint returns NDJSON (one object per line)
  if (result.csv || result.raw) {
    const text = result.csv || result.raw;
    const projects = text.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return res.json({ projects });
  }
  res.json(Array.isArray(result) ? { projects: result } : { projects: [result] });
}));

router.get('/rumbleup/projects/:id', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const project = await ru.getProject(req.params.id);
  res.json(project);
}));

router.post('/rumbleup/projects', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { name, message, group, campaignId, proxy } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message are required.' });
  const project = await ru.createProject({ name, message, group, campaignId, proxy });
  res.json(project);
}));

router.post('/rumbleup/projects/:id/test', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { test_phone, message } = req.body;
  if (!test_phone) return res.status(400).json({ error: 'test_phone is required.' });
  try {
    const result = await ru.sendTestMessage(req.params.id, test_phone, message);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/rumbleup/projects/:id/live', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.goLive(req.params.id);
  res.json(result);
}));

router.post('/rumbleup/projects/:id/stop', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.stopProject(req.params.id);
  res.json(result);
}));

// ========== CONTACTS ==========

router.post('/rumbleup/contacts/import', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { list_id } = req.body;

  if (!list_id) return res.status(400).json({ error: 'list_id is required.' });

  // Build CSV from admin list voters
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(list_id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL
    ORDER BY v.last_name, v.first_name
  `).all(list_id);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with phone numbers on this list.' });

  // Build CSV with lowercase headers (RumbleUp requirement)
  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  const header = 'first_name,last_name,phone,city,zipcode,email';
  const rows = voters.map(v =>
    [v.first_name, v.last_name, (v.phone || '').replace(/\D/g, ''), v.city, v.zip, v.email].map(csvEscape).join(',')
  );
  const csvContent = header + '\n' + rows.join('\n');

  const result = await ru.importContacts(Buffer.from(csvContent), list.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.csv');
  res.json({ success: true, imported: voters.length, listName: list.name, ...result });
}));

// ========== MESSAGING LOGS ==========

router.get('/rumbleup/messaging/logs', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  if (!req.query.phone) return res.status(400).json({ error: 'phone query param is required.' });
  const result = await ru.getMessageLog({
    phone: req.query.phone,
    proxy: req.query.proxy,
    since: req.query.since,
    before: req.query.before,
    _start: req.query._start
  });
  res.json(result);
}));

module.exports = router;
