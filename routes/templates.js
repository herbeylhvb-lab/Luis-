// Admin-editable message templates.
//
// Templates are stored as rows in the existing key/value `settings` table
// with keys prefixed `tmpl_`. The DEFAULTS map below is the seed/fallback
// copy used when there is no override row. Captain portal fetches via
// /api/captain/templates whenever the bulk-text modal opens, so an admin
// edit goes live the next time any captain opens the modal — no refresh
// needed.
//
// Placeholders:
//   captain-voter templates ({captain_voter_individual}, {captain_voter_group}):
//     {first_name} {last_name} {full_name}   — voter (individual mode only,
//                                              renders empty in group mode)
//     {captain_first}                        — sending captain's first name
//     {candidate} {candidate_first} {race}   — campaign candidate / race
//   captain-invite template ({captain_invite}):
//     {captain_name} {captain_code} {portal_url}

const express = require('express');
const router = express.Router();
const db = require('../db');

const DEFAULTS = {
  captain_voter_individual:
    "Hi {first_name}! It’s {captain_first}. Today is Election Day — please go out and vote for my friend Luis Villarreal for Port Commissioner. He has the experience and wants to end the port property tax. Your vote really matters to me. Reply if you have questions or need a ride to the polls!",
  captain_voter_group:
    "Hey team — it’s {captain_first}. Today is Election Day! Please go out and vote for my friend Luis Villarreal for Port Commissioner. He has the experience and wants to end the port property tax. Your vote really matters. Reply if you need a ride to the polls. 🗳️",
  captain_invite:
    "Hey {captain_name}! Here is your Block Captain login code: {captain_code}\n\nGo to {portal_url} and enter this code to get started.",
};

// Inline admin gate. We don't import requireAdmin from routes/auth.js
// (it isn't exported), so duplicate the check — same logic, same response.
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

const readOverride = db.prepare("SELECT value FROM settings WHERE key = ?");
const writeOverride = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const deleteOverride = db.prepare("DELETE FROM settings WHERE key = ?");

function getOverride(key) {
  const row = readOverride.get('tmpl_' + key);
  return row ? row.value : null;
}

// ── Captain-portal read (no admin auth) ─────────────────────────────
// Captains use the captain-code login flow, not session cookies, so
// session-based auth wouldn't work here. Templates aren't sensitive
// (they're literally the text that goes into outgoing SMS), so reading
// them is open. Returns merged defaults+overrides keyed by template key.
router.get('/captain/templates', (req, res) => {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    out[k] = getOverride(k) || DEFAULTS[k];
  }
  res.json({ templates: out });
});

// ── Admin endpoints ─────────────────────────────────────────────────

// List all templates with both defaults and current bodies, plus an
// `is_overridden` flag so the admin UI can show "(custom)" indicators.
router.get('/admin/templates', requireAdmin, (req, res) => {
  const out = Object.keys(DEFAULTS).map(function(k) {
    const override = getOverride(k);
    return {
      key: k,
      default_body: DEFAULTS[k],
      current_body: override !== null ? override : DEFAULTS[k],
      is_overridden: override !== null,
    };
  });
  res.json({ templates: out });
});

// Update one template. Body shape: { body: "..." }.
router.put('/admin/templates/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    return res.status(404).json({ error: 'Unknown template key.' });
  }
  const body = req.body && typeof req.body.body === 'string' ? req.body.body : null;
  if (body === null) return res.status(400).json({ error: 'body (string) required.' });
  // Length cap: SMS templates are short by nature; reject obviously-broken
  // 100KB pastes early so we don't fill the settings table.
  if (body.length > 4000) return res.status(400).json({ error: 'Template too long (max 4000 chars).' });
  writeOverride.run('tmpl_' + key, body);
  res.json({ ok: true, key, body });
});

// Reset to default — deletes the override row. Subsequent reads fall
// through to the DEFAULTS map.
router.delete('/admin/templates/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    return res.status(404).json({ error: 'Unknown template key.' });
  }
  deleteOverride.run('tmpl_' + key);
  res.json({ ok: true, key, body: DEFAULTS[key] });
});

module.exports = router;
