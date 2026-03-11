/**
 * RumbleUp SMS Provider
 *
 * Uses the RumbleUp API (https://app.rumbleup.com/api/) in "fast mode"
 * to send individual P2P messages.
 *
 * Auth: HTTP Basic Auth with KEY:SECRET
 * Send: POST /api/message/send  { phone, action, text }
 * Test: POST /api/account/get   (returns account object)
 * Webhooks: DELIVERY_RECEIPT and CONTACT_UPDATED events
 *   - Inbound message: sender === phone field in the message object
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

async function apiRequest(path, body, creds) {
  const key = creds?.apiKey || getCredentials().apiKey;
  const secret = creds?.apiSecret || getCredentials().apiSecret;
  if (!key || !secret) throw new Error('RumbleUp API credentials not configured.');

  const resp = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(key, secret),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('RumbleUp authentication failed. Check your API key and secret.');
  }
  if (resp.status === 429) {
    const retry = resp.headers.get('Retry-After') || '5';
    throw new Error('RumbleUp rate limit hit. Retry after ' + retry + 's.');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('RumbleUp API error (' + resp.status + '): ' + (text || resp.statusText));
  }
  return resp.json().catch(() => { throw new Error('RumbleUp API returned invalid JSON.'); });
}

// --- Sending ---

async function sendSms(to, body) {
  const creds = getCredentials();
  if (!creds.apiKey || !creds.apiSecret || !creds.actionId) {
    throw new Error('RumbleUp credentials not configured. Set them in Messaging Setup.');
  }
  // Fast mode: single POST with phone + action + text
  const phone = to.replace(/\D/g, ''); // RumbleUp expects digits only
  if (phone.length < 10) throw new Error('Invalid phone number: must be at least 10 digits.');
  return apiRequest('/message/send', {
    phone,
    action: creds.actionId,
    text: body
  });
}

async function sendWhatsApp(_to, _body) {
  throw new Error('RumbleUp does not support WhatsApp messaging.');
}

async function sendMessage(to, body, channel) {
  if (channel === 'whatsapp') {
    return sendWhatsApp(to, body);
  }
  return sendSms(to, body);
}

// --- Connection test ---

async function testConnection(apiKey, apiSecret) {
  const result = await apiRequest('/account/get', {}, { apiKey, apiSecret });
  return {
    accountName: result.name || result.cid || 'RumbleUp Account',
    status: result.status || 'Active'
  };
}

// --- Webhook handling ---
// RumbleUp webhook payloads use: phone, text, sender, proxy
// Inbound message: sender === phone (i.e. the contact is the sender)

function buildReply(text) {
  // RumbleUp webhooks are one-way push events; replies go through the send API.
  // Return a simple JSON acknowledgment.
  return JSON.stringify({ ok: true, reply: text });
}

function buildEmptyReply() {
  return JSON.stringify({ ok: true });
}

function getWebhookData(req) {
  // RumbleUp webhook payload uses 'phone' and 'text' fields in the data object
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
  getCredentials,
  saveCredentials,
  getPublicCredentials,
  hasCredentials,
  sendSms,
  sendWhatsApp,
  sendMessage,
  testConnection,
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
