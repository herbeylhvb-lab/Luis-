/**
 * Lightweight request-body validation middleware.
 *
 * Usage:
 *   const { validate, rules } = require('../middleware/validate');
 *   router.post('/foo', validate({ name: rules.required, email: rules.email }), handler);
 *
 * Each rule is a function (value) => errorMessage | null.
 */

const rules = {
  /** Value must be a non-empty string. */
  required(v) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return 'is required';
    }
    return null;
  },

  /** Value must be a non-empty array. */
  nonEmptyArray(v) {
    if (!Array.isArray(v) || v.length === 0) return 'must be a non-empty array';
    return null;
  },

  /** Value, if present, must look like an email address. */
  optionalEmail(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return 'must be a valid email address';
    }
    return null;
  },

  /** Value, if present, must contain only digits (and optional leading +). */
  optionalPhone(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\+?[\d\s()-]{7,20}$/.test(v)) {
      return 'must be a valid phone number';
    }
    return null;
  },

  /** Value must be a positive integer (or a string that parses to one). */
  positiveInt(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return 'must be a positive integer';
    return null;
  },
};

/**
 * Returns Express middleware that validates `req.body` against the given schema.
 * @param {Object<string, Function>} schema - map of field name -> rule function
 */
function validate(schema) {
  return (req, res, next) => {
    const errors = {};
    for (const [field, rule] of Object.entries(schema)) {
      const msg = rule(req.body[field]);
      if (msg) errors[field] = `${field} ${msg}`;
    }
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    next();
  };
}

module.exports = { validate, rules };
