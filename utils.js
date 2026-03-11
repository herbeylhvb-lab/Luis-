const { randomBytes } = require('crypto');

/**
 * Normalize a phone number to digits only, stripping the leading "1" for US numbers.
 * e.g. "+1 (512) 555-1234" -> "5125551234"
 */
function phoneDigits(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
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
 * Generate a cryptographically secure alphanumeric code (e.g. "A3F8").
 * Used for walk group join codes.
 */
function generateAlphaCode(length = 4) {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .toUpperCase()
    .slice(0, length);
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
function personalizeTemplate(template, contact) {
  const c = contact || {};
  const map = {
    '{firstName}': c.firstName || c.first_name || '',
    '{lastName}': c.lastName || c.last_name || '',
    '{city}': c.city || '',
  };
  // Replace all merge tags simultaneously to prevent double-substitution
  // (e.g. a first_name of "{city}" should NOT be replaced again)
  return (template || '').replace(/\{firstName\}|\{lastName\}|\{city\}/g, (tag) => map[tag] || '');
}

module.exports = {
  phoneDigits,
  normalizePhone,
  toE164,
  generateJoinCode,
  generateAlphaCode,
  asyncHandler,
  personalizeTemplate,
};
