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
  const campaignId = db.prepare("SELECT value FROM settings WHERE key = 'rumbleup_campaign_id'").get();
  return {
    apiKey: apiKey?.value || '',
    apiSecret: apiSecret?.value || '',
    phoneNumber: phone?.value || '',
    actionId: actionId?.value || '',
    campaignId: campaignId?.value || ''
  };
}

function saveCredentials({ apiKey, apiSecret, phoneNumber, actionId, campaignId }) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?');
  if (apiKey) upsert.run('rumbleup_api_key', apiKey, apiKey);
  if (apiSecret) upsert.run('rumbleup_api_secret', apiSecret, apiSecret);
  if (phoneNumber) upsert.run('rumbleup_phone_number', phoneNumber, phoneNumber);
  if (actionId !== undefined) upsert.run('rumbleup_action_id', actionId || '', actionId || '');
  if (campaignId !== undefined) upsert.run('rumbleup_campaign_id', campaignId || '', campaignId || '');
}

function getPublicCredentials() {
  const creds = getCredentials();
  return {
    hasApiKey: !!creds.apiKey,
    hasApiSecret: !!creds.apiSecret,
    phoneNumber: creds.phoneNumber,
    actionId: creds.actionId,
    campaignId: creds.campaignId
  };
}

function hasCredentials() {
  const creds = getCredentials();
  // Only require key+secret — actionId and phone are optional for some operations
  return !!(creds.apiKey && creds.apiSecret);
}

// --- HTTP helpers ---

function authHeader(key, secret, style) {
  if (style === 'bearer') return 'Bearer ' + key + ':' + secret;
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
    headers: { 'Authorization': authHeader(key, secret, options.authStyle) },
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
    const errBody = await resp.text().catch(() => '');
    let detail = '';
    try { detail = JSON.parse(errBody).message || ''; } catch { detail = errBody; }
    if (resp.status === 401) {
      throw new Error('RumbleUp authentication failed. Check your API key and secret.' + (detail ? ' (' + detail + ')' : ''));
    }
    throw new Error('RumbleUp forbidden (' + resp.status + '): ' + (detail || 'Access denied. Check account balance or permissions.'));
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

// --- Proxy Management ---

async function getProxies() {
  return apiGet('/proxy/get', {});
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

async function createProject({ name, message, group, campaignId, proxy, media, type }) {
  const body = { name, message };
  if (group) body.group = group;
  if (campaignId) body.campaignId = campaignId;
  if (proxy) body.proxy = proxy;
  if (type) body.type = type; // SMS, MMS, or EVT
  if (media) body.media = media;
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
  if (message) {
    // RumbleUp requires opt-out instructions in test messages
    const hasOptOut = /stop|opt.?out|unsubscribe/i.test(message);
    body.message = hasOptOut ? message : message + '\nSTOP to opt-out';
  }
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
  // Always include the action ID so the contact is associated with the active project
  const creds = getCredentials();
  const data = { ...contactData };
  if (creds.actionId && !data.action) {
    data.action = String(creds.actionId);
  }
  return apiPost('/contact/sync', data);
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

/**
 * Attempt a raw API request that does NOT throw on HTTP errors.
 * Returns { ok, status, body } so callers can inspect failures.
 */
async function rawApiRequest(path, fetchOpts, timeoutMs = 15000) {
  const creds = getCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  fetchOpts.signal = controller.signal;
  try {
    const resp = await fetch(BASE_URL + path, fetchOpts);
    const text = await resp.text().catch(() => '');
    clearTimeout(timeout);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, body: text, json };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 0, body: err.message, json: null };
  }
}

/**
 * Download a remote file into a Buffer for binary multipart upload.
 */
async function downloadFileBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const arrayBuf = await resp.arrayBuffer();
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    clearTimeout(timeout);
    return { buffer: Buffer.from(arrayBuf), contentType };
  } catch (err) {
    clearTimeout(timeout);
    throw new Error('Failed to download media file: ' + err.message);
  }
}

async function sendSms(to, body, mediaUrl) {
  const creds = getCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    throw new Error('RumbleUp API key and secret are required. Set them in Messaging Setup.');
  }
  if (!creds.actionId && !mediaUrl) {
    throw new Error('RumbleUp credentials not configured. Set them in Messaging Setup.');
  }
  const phone = to.replace(/\D/g, '');
  if (phone.length < 10) throw new Error('Invalid phone number: must be at least 10 digits.');

  const payload = {
    phone,
    action: creds.actionId,
    text: body
  };

  // --- MMS: exhaustively try every known approach ---
  if (mediaUrl) {
    if (!creds.phoneNumber) {
      console.warn('[rumbleup] No proxy phone number configured — skipping MMS attempts, falling back to SMS+link');
      payload.text = body + '\n\nView your event flyer: ' + mediaUrl;
      return apiPost('/message/send', payload);
    }

    const proxy = creds.phoneNumber.replace(/\D/g, '');
    const basicAuth = 'Basic ' + Buffer.from(creds.apiKey + ':' + creds.apiSecret).toString('base64');
    const bearerAuth = 'Bearer ' + creds.apiKey + ':' + creds.apiSecret;

    console.log('[rumbleup] ========= MMS SEND — EXHAUSTIVE ATTEMPTS =========');
    console.log('[rumbleup] to=' + phone + ' proxy=' + proxy + ' file=' + mediaUrl);

    // ---------------------------------------------------------------
    // Attempt 1: POST /proxy/send — Basic auth — JSON body
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 1: POST /proxy/send, Basic auth, JSON body';
      console.log('[rumbleup] ' + label);
      const jsonBody = { phone, proxy, text: body, file: mediaUrl };
      if (creds.campaignId) jsonBody.campaignId = creds.campaignId;
      const res = await rawApiRequest('/proxy/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonBody)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 2: POST /proxy/send — Bearer auth — JSON body
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 2: POST /proxy/send, Bearer auth, JSON body';
      console.log('[rumbleup] ' + label);
      const jsonBody = { phone, proxy, text: body, file: mediaUrl };
      if (creds.campaignId) jsonBody.campaignId = creds.campaignId;
      const res = await rawApiRequest('/proxy/send', {
        method: 'POST',
        headers: { 'Authorization': bearerAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonBody)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 3: POST /proxy/send — Basic auth — multipart/form-data (URL in field)
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 3: POST /proxy/send, Basic auth, multipart/form-data (file URL)';
      console.log('[rumbleup] ' + label);
      const form = new FormData();
      form.append('phone', phone);
      form.append('proxy', proxy);
      form.append('text', body);
      form.append('file', mediaUrl);
      if (creds.campaignId) form.append('campaignId', creds.campaignId);
      const res = await rawApiRequest('/proxy/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth },
        body: form
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 4: POST /proxy/send — Bearer auth — multipart/form-data (URL in field)
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 4: POST /proxy/send, Bearer auth, multipart/form-data (file URL)';
      console.log('[rumbleup] ' + label);
      const form = new FormData();
      form.append('phone', phone);
      form.append('proxy', proxy);
      form.append('text', body);
      form.append('file', mediaUrl);
      if (creds.campaignId) form.append('campaignId', creds.campaignId);
      const res = await rawApiRequest('/proxy/send', {
        method: 'POST',
        headers: { 'Authorization': bearerAuth },
        body: form
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 5: POST /proxy/send — Basic + Bearer — multipart with actual binary file download
    // ---------------------------------------------------------------
    let fileBuf = null;
    let fileContentType = 'image/jpeg';
    try {
      console.log('[rumbleup] MMS attempt 5: Downloading media file for binary upload...');
      const dl = await downloadFileBuffer(mediaUrl);
      fileBuf = dl.buffer;
      fileContentType = dl.contentType;
      console.log('[rumbleup]   Downloaded ' + fileBuf.length + ' bytes, type=' + fileContentType);
    } catch (dlErr) {
      console.error('[rumbleup]   Could not download media: ' + dlErr.message + ' — skipping binary upload attempts');
    }

    if (fileBuf) {
      for (const [authLabel, authValue] of [['Basic', basicAuth], ['Bearer', bearerAuth]]) {
        const label = 'MMS attempt 5' + (authLabel === 'Bearer' ? 'b' : 'a') + ': POST /proxy/send, ' + authLabel + ' auth, multipart binary upload';
        console.log('[rumbleup] ' + label);
        const ext = fileContentType.includes('png') ? '.png' : fileContentType.includes('gif') ? '.gif' : '.jpg';
        const blob = new Blob([fileBuf], { type: fileContentType });
        const form = new FormData();
        form.append('phone', phone);
        form.append('proxy', proxy);
        form.append('text', body);
        form.append('file', blob, 'media' + ext);
        if (creds.campaignId) form.append('campaignId', creds.campaignId);
        const res = await rawApiRequest('/proxy/send', {
          method: 'POST',
          headers: { 'Authorization': authValue },
          body: form
        });
        console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
        if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
      }
    }

    // ---------------------------------------------------------------
    // Attempt 6: POST /message/send with file / media field (undocumented)
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 6a: POST /message/send with file field (Basic auth, JSON)';
      console.log('[rumbleup] ' + label);
      const msgPayload = { phone, action: creds.actionId, text: body, file: mediaUrl };
      const res = await rawApiRequest('/message/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }
    {
      const label = 'MMS attempt 6b: POST /message/send with media field (Basic auth, JSON)';
      console.log('[rumbleup] ' + label);
      const msgPayload = { phone, action: creds.actionId, text: body, media: mediaUrl };
      const res = await rawApiRequest('/message/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }
    {
      const label = 'MMS attempt 6c: POST /message/send with media_url field (Basic auth, JSON)';
      console.log('[rumbleup] ' + label);
      const msgPayload = { phone, action: creds.actionId, text: body, media_url: mediaUrl };
      const res = await rawApiRequest('/message/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 7: POST /message/send with type: "MMS"
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 7a: POST /message/send with type=MMS + file (Basic auth)';
      console.log('[rumbleup] ' + label);
      const msgPayload = { phone, action: creds.actionId, text: body, type: 'MMS', file: mediaUrl };
      const res = await rawApiRequest('/message/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }
    {
      const label = 'MMS attempt 7b: POST /message/send with type=MMS + media (Basic auth)';
      console.log('[rumbleup] ' + label);
      const msgPayload = { phone, action: creds.actionId, text: body, type: 'MMS', media: mediaUrl };
      const res = await rawApiRequest('/message/send', {
        method: 'POST',
        headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload)
      });
      console.log('[rumbleup]   -> status=' + res.status + ' body=' + (res.body || '').substring(0, 500));
      if (res.ok) { console.log('[rumbleup]   => SUCCESS'); return res.json || res.body; }
    }

    // ---------------------------------------------------------------
    // Attempt 8: Create an MMS project via /project/create, then send through it
    // ---------------------------------------------------------------
    {
      const label = 'MMS attempt 8: Create MMS project via /project/create then /project/test';
      console.log('[rumbleup] ' + label);
      try {
        const projectPayload = {
          name: 'MMS-auto-' + Date.now(),
          message: body,
          type: 'MMS',
          media: mediaUrl,
          proxy: proxy
        };
        if (creds.campaignId) projectPayload.campaignId = creds.campaignId;
        console.log('[rumbleup]   Creating MMS project:', JSON.stringify(projectPayload).substring(0, 500));
        const createRes = await rawApiRequest('/project/create', {
          method: 'POST',
          headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify(projectPayload)
        });
        console.log('[rumbleup]   /project/create -> status=' + createRes.status + ' body=' + (createRes.body || '').substring(0, 500));
        if (createRes.ok && createRes.json) {
          const projectId = createRes.json.id || createRes.json.action || createRes.json.project_id;
          if (projectId) {
            // 8a: Try sending a test message through this project
            console.log('[rumbleup]   MMS project created id=' + projectId + ', sending test message...');
            const testRes = await rawApiRequest('/project/test/' + projectId, {
              method: 'POST',
              headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ test_phone: phone, terms_agree: true })
            });
            console.log('[rumbleup]   /project/test -> status=' + testRes.status + ' body=' + (testRes.body || '').substring(0, 500));
            if (testRes.ok) { console.log('[rumbleup]   => SUCCESS via MMS project test'); return testRes.json || testRes.body; }

            // 8b: Try /message/send with the new MMS project action ID
            console.log('[rumbleup]   Trying /message/send with MMS project action=' + projectId);
            const msgRes = await rawApiRequest('/message/send', {
              method: 'POST',
              headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone, action: String(projectId), text: body })
            });
            console.log('[rumbleup]   /message/send with MMS project -> status=' + msgRes.status + ' body=' + (msgRes.body || '').substring(0, 500));
            if (msgRes.ok) { console.log('[rumbleup]   => SUCCESS via MMS project /message/send'); return msgRes.json || msgRes.body; }
          } else {
            console.error('[rumbleup]   MMS project created but no ID found in response');
          }
        }
      } catch (projErr) {
        console.error('[rumbleup]   MMS project approach failed:', projErr.message);
      }
    }

    // ---------------------------------------------------------------
    // ALL MMS APPROACHES FAILED — fall back to SMS + link
    // ---------------------------------------------------------------
    console.warn('[rumbleup] ========= ALL MMS ATTEMPTS FAILED — falling back to SMS with link =========');
    payload.text = body + '\n\nView your event flyer: ' + mediaUrl;
  }

  return apiPost('/message/send', payload);
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

async function sendMessage(to, body, channel, mediaUrl) {
  if (channel === 'whatsapp') return sendWhatsApp(to, body);
  return sendSms(to, body, mediaUrl);
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
  // Proxy
  getProxies,
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
    { key: 'phoneNumber', label: 'Proxy Phone Number', type: 'text', placeholder: '+1234567890', hint: 'Your RumbleUp proxy number — required for MMS. Check /api/rumbleup/proxies to see available numbers.' },
    { key: 'campaignId', label: 'TCR Campaign ID (for MMS)', type: 'text', placeholder: 'e.g. CSDF123', hint: 'Optional — your TCR campaign ID. May be required for MMS via /proxy/send.' }
  ]
};
