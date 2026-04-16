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

// Alias: singular /project/:id (used by MMS test UI)
router.get('/rumbleup/project/:id', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.getProject(req.params.id);
  // Normalize response — RumbleUp returns flat object
  res.json({ project: result });
}));

// MMS test send endpoint (used by MMS test UI)
router.post('/rumbleup/test-send', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { projectId, testPhone } = req.body;
  if (!projectId || !testPhone) return res.status(400).json({ error: 'projectId and testPhone are required.' });
  try {
    // RumbleUp requires the project to be in test/draft mode — try test endpoint first
    const result = await ru.sendTestMessage(projectId, testPhone);
    res.json({ success: true, ...result });
  } catch (err) {
    // If proxy error, provide helpful message
    if (err.message && err.message.includes('Proxy numbers')) {
      return res.status(400).json({ error: 'This project needs to be in Testing/Draft mode on RumbleUp to send test messages. Live or Archived projects cannot send tests. Create a new Draft project or switch this one to Testing mode on the RumbleUp dashboard.' });
    }
    res.status(400).json({ error: err.message || 'Test send failed.' });
  }
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
    res.status(400).json({ error: 'Operation failed. Please try again.' });
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

  // Primary phones
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL AND COALESCE(v.phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  // Secondary phones — add as separate rows so both numbers get texted
  const secVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.secondary_phone as phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.secondary_phone != '' AND v.secondary_phone IS NOT NULL AND COALESCE(v.secondary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  voters.push(...secVoters);
  // Tertiary phones — add as separate rows so all numbers get texted
  const terVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.tertiary_phone as phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.tertiary_phone != '' AND v.tertiary_phone IS NOT NULL AND COALESCE(v.tertiary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  voters.push(...terVoters);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with textable phone numbers on this list (landlines/invalid excluded).' });

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

// ========== CAMPAIGN LAUNCHER — Create + Import + Send in one flow ==========

router.post('/rumbleup/launch-campaign', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const { name, message, list_id, test_phone, schedule_start, schedule_end, outsource_email } = req.body;

  if (!name || !message || !list_id) {
    return res.status(400).json({ error: 'name, message, and list_id are required.' });
  }

  // Step 1: Build CSV from universe/list (mobile only if validated)
  const list = db.prepare('SELECT * FROM admin_lists WHERE id = ?').get(list_id);
  if (!list) return res.status(404).json({ error: 'List not found.' });

  // Primary phones
  const voters = db.prepare(`
    SELECT v.first_name, v.last_name, v.phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.phone != '' AND v.phone IS NOT NULL AND COALESCE(v.phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  // Secondary phones — add as separate rows
  const secVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.secondary_phone as phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.secondary_phone != '' AND v.secondary_phone IS NOT NULL AND COALESCE(v.secondary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  voters.push(...secVoters);
  // Tertiary phones — add as separate rows
  const terVoters = db.prepare(`
    SELECT v.first_name, v.last_name, v.tertiary_phone as phone, v.city, v.zip, v.email
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.tertiary_phone != '' AND v.tertiary_phone IS NOT NULL AND COALESCE(v.tertiary_phone_type,'') NOT IN ('landline','invalid')
    ORDER BY v.last_name, v.first_name
  `).all(list_id);
  voters.push(...terVoters);

  if (voters.length === 0) return res.status(400).json({ error: 'No voters with valid phone numbers in this list.' });

  // Step 2: Upload contacts to RumbleUp
  const csvEscape = (val) => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  const header = 'first_name,last_name,phone,city,zipcode,email';
  const rows = voters.map(v =>
    [v.first_name, v.last_name, (v.phone || '').replace(/\D/g, ''), v.city, v.zip, v.email].map(csvEscape).join(',')
  );
  const csvContent = header + '\n' + rows.join('\n');
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  let importResult;
  try {
    importResult = await ru.importContacts(Buffer.from(csvContent), safeName + '.csv');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to import contacts: ' + err.message });
  }

  const groupId = importResult.gid || importResult.group || importResult.id;

  // Step 3: Create project/action
  const safeMessage = /stop|opt.?out|unsubscribe/i.test(message) ? message : message + '\nReply STOP to opt out.';
  let projectResult;
  try {
    const projectBody = { name: safeName, message: safeMessage };
    if (groupId) projectBody.group = String(groupId);
    if (schedule_start) {
      projectBody.flags = 'outsourced';
      projectBody.outsource_start = schedule_start;
      projectBody.outsource_end = schedule_end || schedule_start;
      if (outsource_email) projectBody.outsource_email = outsource_email;
    }
    projectResult = await ru.createProject(projectBody);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign: ' + err.message, importResult });
  }

  const actionId = projectResult.action || projectResult.id || projectResult.aid;

  // Step 4: Send test if phone provided
  let testResult = null;
  if (test_phone) {
    try {
      testResult = await ru.sendTestMessage(actionId, test_phone);
    } catch (err) {
      testResult = { error: err.message };
    }
  }

  res.json({
    success: true,
    actionId,
    groupId,
    contactsUploaded: voters.length,
    listName: list.name,
    projectResult,
    importResult,
    testResult,
    message: 'Campaign "' + name + '" created with ' + voters.length + ' contacts.' + (test_phone ? ' Test sent to ' + test_phone + '.' : '') + ' Go to RumbleUp dashboard to review and go live.'
  });
}));

// Get groups from RumbleUp
router.get('/rumbleup/groups', asyncHandler(async (req, res) => {
  const ru = getRumbleUp();
  const result = await ru.getContacts({ _count: 0 });
  res.json(result);
}));

module.exports = router;
