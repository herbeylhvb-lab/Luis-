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

router.get('/rumbleup/accounts', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.listAccounts({ name: req.query.name, q: req.query.q });
  res.json(result);
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

router.patch('/rumbleup/projects/:id', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.updateProject(req.params.id, req.body);
  res.json(result);
}));

router.post('/rumbleup/projects/:id/test', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { test_phone, message } = req.body;
  if (!test_phone) return res.status(400).json({ error: 'test_phone is required.' });
  const result = await ru.sendTestMessage(req.params.id, test_phone, message);
  res.json({ success: true, ...result });
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

router.get('/rumbleup/stats', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.getProjectStats({
    format: req.query.format || 'json',
    days: req.query.days ? parseInt(req.query.days) : undefined,
    since: req.query.since || undefined,
    before: req.query.before || undefined,
    project: req.query.project || undefined
  });
  res.json(result);
}));

// ========== CONTACTS ==========

router.post('/rumbleup/contacts/search', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.getContacts(req.body);
  res.json(result);
}));

router.post('/rumbleup/contacts/sync', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  if (!req.body.phone) return res.status(400).json({ error: 'phone is required.' });
  const result = await ru.syncContact(req.body);
  res.json({ success: true, ...result });
}));

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

router.post('/rumbleup/contacts/download', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  if (!req.body.gid) return res.status(400).json({ error: 'gid (group ID) is required.' });
  const result = await ru.downloadContacts(req.body);
  if (result.csv) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rumbleup_contacts.csv"');
    return res.send(result.csv);
  }
  res.json(result);
}));

// ========== GROUPS ==========

router.get('/rumbleup/groups/:id', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const group = await ru.getGroup(req.params.id);
  res.json(group);
}));

// ========== MESSAGING ==========

router.get('/rumbleup/messaging/next', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const actionId = req.query.action || ru.getCredentials().actionId;
  if (!actionId) return res.status(400).json({ error: 'action (project ID) is required.' });
  const result = await ru.getNextContact(actionId);
  res.json(result);
}));

router.post('/rumbleup/messaging/send', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { phone, action, text, name, group, flags } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone and text are required.' });
  const actionId = action || ru.getCredentials().actionId;
  if (!actionId) return res.status(400).json({ error: 'action (project ID) is required.' });
  const result = await ru.sendToProject(phone, actionId, text, { name, group, flags });
  res.json(result);
}));

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

// ========== REPORTS ==========

router.post('/rumbleup/reports', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required.' });
  const result = await ru.createReport(title, req.body);
  res.json(result);
}));

router.get('/rumbleup/reports', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.listReports();
  res.json(result);
}));

// ========== DIRECT IMPORT FROM LIST ==========
// Push an admin list directly to RumbleUp as contacts, then optionally assign to a project

router.post('/rumbleup/push-list', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { list_id, project_id } = req.body;
  if (!list_id) return res.status(400).json({ error: 'list_id is required.' });

  // Get voters from admin list
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(list_id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL
  `).all(list_id);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with phone numbers on this list.' });

  // Sync each contact individually (more reliable than CSV import for smaller lists)
  let synced = 0;
  let errors = 0;
  for (const v of voters) {
    try {
      await ru.syncContact({
        phone: (v.phone || '').replace(/\D/g, ''),
        first_name: v.first_name || '',
        last_name: v.last_name || '',
        city: v.city || '',
        zipcode: v.zip || '',
        email: v.email || ''
      });
      synced++;
    } catch (err) {
      errors++;
    }
  }

  res.json({
    success: true,
    listName: list.name,
    total: voters.length,
    synced,
    errors,
    project_id: project_id || null
  });
}));

module.exports = router;
