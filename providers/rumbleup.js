/**
 * RumbleUp SMS Provider — Full API Integration
 *
 * Base URL: https://app.rumbleup.com/api
 * Auth: HTTP Basic Auth with KEY:SECRET
 *
 * Endpoints implemented:
 *   Account:  GET  /account/get, GET /account/list
 *   Projects: POST /project/create, GET /project/get/{id}, POST /project/update/{id}
 *             POST /project/test/{id}, POST /project/send/{id}, POST /project/stop/{id}
 *             POST /project/stats
 *   Contacts: POST /contact/select, POST /contact/sync, POST /contact/import
 *             POST /contact/download, GET /group/get/{id}
 *   Messaging: POST /message/send, GET /message/next, GET /message/log/select
 *   Reports:  POST /report/create, GET /report/list
 *   Webhooks: DELIVERY_RECEIPT, MESSAGE, CONTACT events (inbound via /incoming)
 */
const db = require('../db');

const BASE_URL = 'https://app.rumbleup.com/api';

// --- Credential management ---

function getCredentials() {
  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'rumbleup_api_key'").get();
  const apiSecret = db.prepare("SELECT value FROM settings WHERE key = 'rumbleup_api_secret'").get();
  const phone = db.prepare("SELECT value FROM settings WHERE key = 'rumbleup_phone_number'").get();
  const actionId = db.prepare("SELECT value FROM settings WHERE key = 'rumbleup_action_id'").get();
  return {
    apiKey: apiKey?.value || '',
    apiSecret: apiSecret?.value || '',
    phoneNumber: phone?.value || '',
    actionId: actionId?.value || ''
  };
}

function saveCredentials({ apiKey, apiSecret, phoneNumber, actionId }) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?');
  if (apiKey) upsert.run('rumbleup_api_key', apiKey, apiKey);
  if (apiSecret) upsert.run('rumbleup_api_secret', apiSecret, apiSecret);
  if (phoneNumber) upsert.run('rumbleup_phone_number', phoneNumber, phoneNumber);
  if (actionId !== undefined) upsert.run('rumbleup_action_id', actionId || '', actionId || '');
}

function getPublicCredentials() {
  const creds = getCredentials();
  return {
    hasApiKey: !!creds.apiKey,
    hasApiSecret: !!creds.apiSecret,
    phoneNumber: creds.phoneNumber,
    actionId: creds.actionId
  };
}

function hasCredentials() {
  const creds = getCredentials();
  return !!(creds.apiKey && creds.apiSecret && creds.actionId);
}

// --- HTTP helpers ---

function authHeader(key, secret) {
  const encoded = Buffer.from(key + ':' + secret).toString('base64');
  return 'Basic ' + encoded;
}

async function apiRequest(path, body, creds, options = {}) {
  const key = creds?.apiKey || getCredentials().apiKey;
  const secret = creds?.apiSecret || getCredentials().apiSecret;
  if (!key || !secret) throw new Error('RumbleUp API credentials not configured.');

  const method = options.method || 'POST';
  const timeoutMs = options.timeout || 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOpts = {
    method,
    headers: { 'Authorization': authHeader(key, secret) },
    signal: controller.signal
  };

  if (method === 'GET') {
    // Append query params from body object
    if (body && Object.keys(body).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null && v !== '') qs.append(k, v);
      }
      path = path + '?' + qs.toString();
    }
  } else if (options.multipart) {
    // Multipart form data (for CSV upload)
    fetchOpts.body = body; // body should be a FormData instance
  } else {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body || {});
  }

  let resp;
  try {
    resp = await fetch(BASE_URL + path, fetchOpts);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('RumbleUp API request timed out (' + (timeoutMs / 1000) + 's).');
    throw new Error('RumbleUp API network error: ' + (err.message || 'Connection failed'));
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('RumbleUp authentication failed. Check your API key and secret.');
  }
  if (resp.status === 429) {
    const retry = resp.headers.get('Retry-After') || '5';
    throw new Error('RumbleUp rate limit hit. Retry after ' + retry + 's.');
  }

  // Some endpoints return CSV
  const contentType = resp.headers.get('content-type') || '';
  if (options.rawResponse) return resp;

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('RumbleUp API error (' + resp.status + '): ' + (text || resp.statusText));
  }

  if (contentType.includes('text/csv')) {
    return { csv: await resp.text(), contentType: 'text/csv' };
  }

  const rawText = await resp.text();
  try {
    return JSON.parse(rawText);
  } catch {
    // If response looks like CSV (has commas and newlines), return as CSV
    if (rawText.includes(',') && rawText.includes('\n')) {
      return { csv: rawText, contentType: 'text/csv' };
    }
    return { raw: rawText };
  }
}

// Convenience wrappers
function apiGet(path, params, creds, options = {}) {
  return apiRequest(path, params, creds, { ...options, method: 'GET' });
}

function apiPost(path, body, creds, options = {}) {
  return apiRequest(path, body, creds, { ...options, method: 'POST' });
}

// --- Account ---

async function testConnection(apiKey, apiSecret) {
  const result = await apiGet('/account/get', {}, { apiKey, apiSecret });
  return {
    accountName: result.name || result.cid || 'RumbleUp Account',
    status: result.status || 'Active',
    balance: result.balance
  };
}

async function getAccount() {
  return apiGet('/account/get');
}

async function listAccounts(params) {
  return apiGet('/account/list', params);
}

// --- Projects (Actions) ---

async function createProject({ name, message, group, campaignId, proxy, media }) {
  const body = { name, message };
  if (group) body.group = group;
  if (campaignId) body.campaignId = campaignId;
  if (proxy) body.proxy = proxy;
  return apiPost('/project/create', body);
}

async function getProject(projectId) {
  return apiGet('/project/get/' + projectId);
}

async function updateProject(projectId, updates) {
  return apiPost('/project/update/' + projectId, updates);
}

async function sendTestMessage(projectId, testPhone, message) {
  const body = { test_phone: testPhone, terms_agree: true };
  if (message) body.message = message;
  return apiPost('/project/test/' + projectId, body);
}

async function goLive(projectId) {
  return apiPost('/project/send/' + projectId);
}

async function stopProject(projectId) {
  return apiPost('/project/stop/' + projectId);
}

async function getProjectStats(params) {
  // params: { format, interval, days, since, before, project, name }
  return apiPost('/project/stats', params || {});
}

// --- Contacts ---

async function getContacts(params) {
  // params: { action, actions, filter, group, since, flags, noflags, q, _count, _start }
  return apiPost('/contact/select', params || {});
}

async function syncContact(contactData) {
  // contactData: { phone (required), first_name, last_name, email, city, zipcode, flags, custom1-5, ... }
  return apiPost('/contact/sync', contactData);
}

async function importContacts(csvBuffer, filename) {
  const { FormData, Blob } = await import('node:buffer').then(() => {
    // Node 18+ has global FormData and Blob
    return { FormData: globalThis.FormData, Blob: globalThis.Blob };
  });
  const form = new FormData();
  form.append('csv', new Blob([csvBuffer], { type: 'text/csv' }), filename || 'contacts.csv');
  return apiPost('/contact/import', form, null, { multipart: true, timeout: 60000 });
}

async function downloadContacts(params) {
  // params: { gid (required), flags, q, action, actions, filter, since }
  return apiPost('/contact/download', params, null, { timeout: 30000 });
}

async function getGroup(groupId) {
  return apiGet('/group/get/' + groupId);
}

// --- Messaging ---

async function sendSms(to, body) {
  const creds = getCredentials();
  if (!creds.apiKey || !creds.apiSecret || !creds.actionId) {
    throw new Error('RumbleUp credentials not configured. Set them in Messaging Setup.');
  }
  const phone = to.replace(/\D/g, '');
  if (phone.length < 10) throw new Error('Invalid phone number: must be at least 10 digits.');
  return apiPost('/message/send', {
    phone,
    action: creds.actionId,
    text: body
  });
}

async function sendToProject(phone, actionId, text, options = {}) {
  const body = { phone: phone.replace(/\D/g, ''), action: String(actionId), text };
  if (options.name) body.name = options.name;
  if (options.group) body.group = options.group;
  if (options.flags) body.flags = options.flags;
  return apiPost('/message/send', body);
}

async function sendWhatsApp(_to, _body) {
  throw new Error('RumbleUp does not support WhatsApp messaging.');
}

async function sendMessage(to, body, channel) {
  if (channel === 'whatsapp') return sendWhatsApp(to, body);
  return sendSms(to, body);
}

async function getNextContact(actionId) {
  return apiGet('/message/next', { action: String(actionId) });
}

async function getMessageLog(params) {
  // params: { phone (required), proxy, logid, flags, tcr_cid, since, before, _start }
  return apiGet('/message/log/select', params);
}

// --- Reports ---

async function createReport(title, params) {
  return apiPost('/report/create', { title, ...params });
}

async function listReports() {
  return apiGet('/report/list');
}

// --- Webhook handling ---

function buildReply(text) {
  return JSON.stringify({ ok: true, reply: text });
}

function buildEmptyReply() {
  return JSON.stringify({ ok: true });
}

function getWebhookData(req) {
  const data = req.body.data || req.body;
  return {
    from: data.phone || data.from || data.From || '',
    body: data.text || data.body || data.Body || ''
  };
}

module.exports = {
  name: 'rumbleup',
  label: 'RumbleUp',
  responseContentType: 'application/json',
  // Credentials
  getCredentials,
  saveCredentials,
  getPublicCredentials,
  hasCredentials,
  // Account
  testConnection,
  getAccount,
  listAccounts,
  // Projects
  createProject,
  getProject,
  updateProject,
  sendTestMessage,
  goLive,
  stopProject,
  getProjectStats,
  // Contacts
  getContacts,
  syncContact,
  importContacts,
  downloadContacts,
  getGroup,
  // Messaging
  sendSms,
  sendToProject,
  sendWhatsApp,
  sendMessage,
  getNextContact,
  getMessageLog,
  // Reports
  createReport,
  listReports,
  // Webhooks
  buildReply,
  buildEmptyReply,
  getWebhookData,
  credentialFields: [
    { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'Your RumbleUp API key' },
    { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'Your RumbleUp API secret' },
    { key: 'actionId', label: 'Action / Project ID', type: 'text', placeholder: 'e.g. 125', hint: 'The project ID for sending messages. Find it in your RumbleUp dashboard.' },
    { key: 'phoneNumber', label: 'From Number (display only)', type: 'text', placeholder: '+1234567890', hint: 'RumbleUp assigns proxy numbers automatically. This is for your reference.' }
  ]
};
