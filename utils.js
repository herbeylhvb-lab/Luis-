const { randomBytes } = require('crypto');

/**
 * Normalize a phone number to digits only, stripping the leading "1" for US numbers.
 * e.g. "+1 (512) 555-1234" -> "5125551234"
 */
function phoneDigits(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return '';
}

/**
 * Normalize a phone number for storage: strips all formatting to 10-digit US number.
 * Handles: "(956) 555-1234", "+1-956-555-1234", "1-956-555-1234", "956.555.1234", etc.
 * Returns empty string if the result isn't a valid 10-digit number.
 */
function normalizePhone(raw) {
  const digits = phoneDigits(raw);
  if (digits.length === 10) return digits;
  return '';
}

/**
 * Format a stored phone number to E.164: "9565551234" -> "+19565551234"
 */
function toE164(raw) {
  const digits = phoneDigits(raw);
  if (digits.length === 10) return '+1' + digits;
  return raw || '';
}

/**
 * Generate a cryptographically secure numeric join code (4 digits).
 * Replaces Math.random() which is not suitable for codes that guard access.
 */
function generateJoinCode() {
  // Generate a random number 1000-9999 using crypto
  const buf = randomBytes(2);
  const num = 1000 + (buf.readUInt16BE(0) % 9000);
  return String(num);
}

/**
 * Generate a cryptographically secure alphanumeric code (e.g. "A3F8XZ").
 * Used for walk group join codes. Uses A-Z + 2-9 minus ambiguous letters
 * (0/1/I/O) — 32 chars. At the default length of 6, that's 32^6 ≈ 1B
 * combos; at the legacy length 4 it's ~1M (16x better than the previous
 * hex 65K). 32 divides 256 evenly so `byte % 32` is unbiased.
 */
function generateAlphaCode(length = 6) {
  // Avoid O/0 and I/1 — easy to mistype on phones.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const base = alphabet.length; // 32 (power of 2 → no modulo bias)
  // Use 2x bytes so we can reject out-of-range draws without rerolling
  const bytes = randomBytes(length * 2);
  let out = '';
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const b = bytes[i++];
    // 32 evenly divides 256, so every byte gives a uniform 0..31 draw
    out += alphabet[b % base];
  }
  return out;
}

/**
 * Wrap an async Express route handler so rejected promises are forwarded
 * to the Express error handler instead of crashing the process.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Replace merge tags ({firstName}, {lastName}, {city}) in a message template.
 * Used by WhatsApp send, P2P queue, and email send.
 */
function personalizeTemplate(template, contact, options) {
  const c = contact || {};
  const opts = options || {};
  const baseUrl = process.env.BASE_URL || 'https://villarrealjr.com';
  const eventParam = opts.eventId ? '?e=' + opts.eventId : '';
  const checkinLink = c.qr_token
    ? '\nCheck in here: ' + baseUrl + '/v/' + c.qr_token + eventParam
    : '';
  const map = {
    '{firstName}': c.firstName || c.first_name || '',
    '{lastName}': c.lastName || c.last_name || '',
    '{city}': c.city || '',
    '{checkin_link}': checkinLink,
  };
  // Replace all merge tags simultaneously to prevent double-substitution
  // (e.g. a first_name of "{city}" should NOT be replaced again)
  return (template || '').replace(/\{firstName\}|\{lastName\}|\{city\}|\{checkin_link\}/g, (tag) => map[tag] || '');
}

// Central Time offset: -6 during CST (Nov-Mar), -5 during CDT (Mar-Nov)
function getCentralOffsetHours() {
  try {
    const now = new Date();
    const centralStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const centralDate = new Date(centralStr);
    const diffMs = now.getTime() - centralDate.getTime();
    return Math.round(diffMs / 3600000);
  } catch (e) {
    return 6; // safe fallback: CST
  }
}
function getCentralNow() {
  const offset = getCentralOffsetHours();
  return new Date(Date.now() - offset * 60 * 60 * 1000);
}
function getCentralOffsetSql() {
  return '-' + getCentralOffsetHours() + ' hours';
}

module.exports = {
  phoneDigits,
  normalizePhone,
  toE164,
  generateJoinCode,
  generateAlphaCode,
  asyncHandler,
  personalizeTemplate,
  getCentralOffsetHours,
  getCentralNow,
  getCentralOffsetSql,
};
