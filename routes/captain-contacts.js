const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { scoreCandidate, normalizePhone } = require('../utils');

const matchLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many match requests.' } });
const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many confirm requests.' } });

// Allow either an admin session OR a captain portal session — both are
// legitimate callers of these endpoints. The path is allow-listed in
// server.js so the global admin requireAuth middleware doesn't fire,
// but we still need to verify SOMEONE is authenticated.
function requireCaptainOrAdmin(req, res, next) {
  if (req.session && (req.session.captainId || req.session.userId)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

router.post('/captain/match-candidates', matchLimiter, requireCaptainOrAdmin, (req, res) => {
  const { firstName, lastName, age, captainId, phone, city } = req.body || {};
  const fn = (firstName || '').trim();
  const ln = (lastName || '').trim();
  const ct = (city || '').trim();
  const phoneDigitsCheck = (phone || '').replace(/\D/g, '');
  // Either phone-only mode (just lookup by phone) OR name+age mode is fine.
  // We need at least one viable strategy or there's nothing to search.
  const hasPhoneStrategy = phoneDigitsCheck.length >= 10;
  const hasNameAgeStrategy = !!(fn && ln && age != null);
  if (!hasPhoneStrategy && !hasNameAgeStrategy) {
    return res.status(400).json({ error: 'phone OR (firstName + lastName + age) required' });
  }
  let ageNum = null, ageMin = 1, ageMax = 130;
  if (age != null) {
    ageNum = parseInt(age, 10);
    if (isNaN(ageNum) || ageNum < 1 || ageNum > 130) {
      return res.status(400).json({ error: 'age must be 1-130' });
    }
    ageMin = Math.max(1, ageNum - 5);
    ageMax = Math.min(130, ageNum + 5);
  }
  const lastInitial = ln ? ln[0] : '';

  // PHONE-FIRST match: if the contact has a phone number that's already in
  // the voter file, that's a much stronger signal than fuzzy name matching.
  // Strip everything to digits, take last 10 (US-format), do a digit-only
  // LIKE so we match across (123) 456-7890, +11234567890, 1234567890, etc.
  const phoneDigits = phoneDigitsCheck;
  let phoneMatchedCandidates = [];
  // Redacted log: only first 3 + last 2 of the digits, so we can debug
  // format issues without leaking full phone numbers in Railway logs.
  const redactedPhone = phoneDigits.length > 5
    ? phoneDigits.slice(0, 3) + '***' + phoneDigits.slice(-2)
    : (phoneDigits ? '***' : '(empty)');
  if (phoneDigits.length >= 10) {
    const last10 = phoneDigits.slice(-10);
    // Pull every voter row that has SOME phone, strip non-digits in JS, and
    // check if the stripped form ends with our last10. Doing this in JS
    // (rather than nested SQL REPLACEs) is exhaustive — there's no special
    // separator we forget to strip. At ~30k voters this is still <50ms.
    const allRows = db.prepare(`
      SELECT id, first_name, last_name, age, gender, address, city, zip,
             phone, phone_validated_at
      FROM voters
      WHERE phone != '' AND phone IS NOT NULL
    `).all();
    const phoneRows = allRows.filter(v => {
      const stripped = String(v.phone || '').replace(/\D/g, '');
      return stripped.length >= 10 && stripped.slice(-10) === last10;
    }).slice(0, 5);
    console.log('[match-candidates] phone=' + redactedPhone + ' digits=' + phoneDigits.length + ' last10=' + last10.slice(0, 3) + '***' + last10.slice(-2) + ' phoneMatches=' + phoneRows.length + ' totalVotersWithPhones=' + allRows.length);
    phoneMatchedCandidates = phoneRows.map(v => ({
      voterId: v.id,
      firstName: v.first_name,
      lastName: v.last_name,
      age: v.age,
      address: v.address,
      city: v.city,
      currentPhone: v.phone || '',
      phoneValidatedAt: v.phone_validated_at || null,
      score: 1.0,
      matchType: 'phone',
    }));
  } else {
    console.log('[match-candidates] phone=' + redactedPhone + ' digits=' + phoneDigits.length + ' (skipping phone-match)');
  }

  function fetchAndScore(scope) {
    if (!hasNameAgeStrategy) return [];
    // Build the SQL dynamically: last-initial filter, age range, optional
    // captain-list scope, optional city filter.
    let sql = `SELECT id, first_name, last_name, age, gender, address, city, zip,
                      phone, phone_validated_at
               FROM voters
               WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)
                 AND age BETWEEN ? AND ?`;
    const params = [lastInitial, ageMin, ageMax];
    if (ct) { sql += ' AND LOWER(city) LIKE ?'; params.push('%' + ct.toLowerCase() + '%'); }
    if (scope === 'list' && captainId) {
      sql += ` AND id IN (SELECT voter_id FROM captain_list_voters
                         WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?))`;
      params.push(captainId);
    }
    sql += ' LIMIT 100';
    const rows = db.prepare(sql).all(...params);
    return rows.map(v => ({
      voterId: v.id,
      firstName: v.first_name,
      lastName: v.last_name,
      age: v.age,
      address: v.address,
      city: v.city,
      currentPhone: v.phone || '',
      phoneValidatedAt: v.phone_validated_at || null,
      score: scoreCandidate({ firstName: fn, lastName: ln, age: ageNum }, v),
    }))
      .filter(c => c.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // Skip name+age search entirely if the caller didn't supply name+age
  // (phone-only mode). fetchAndScore returns [] when hasNameAgeStrategy
  // is false, but we keep the conditional clear for readability.
  let nameCandidates = [], scope = 'phone';
  if (hasNameAgeStrategy) {
    if (captainId) {
      nameCandidates = fetchAndScore('list');
      scope = 'list';
      if (nameCandidates.length === 0) {
        nameCandidates = fetchAndScore('broader');
        scope = 'broader';
      }
    } else {
      nameCandidates = fetchAndScore('broader');
      scope = 'broader';
    }
  }

  // Merge phone matches (score 1.0, matchType 'phone') with name+age matches.
  // Phone matches always sort to the top. Dedupe by voterId so the same voter
  // doesn't appear twice if they match both ways.
  const seen = new Set();
  const merged = [];
  phoneMatchedCandidates.forEach(c => {
    if (seen.has(c.voterId)) return;
    seen.add(c.voterId);
    merged.push(c);
  });
  nameCandidates.forEach(c => {
    if (seen.has(c.voterId)) return;
    seen.add(c.voterId);
    merged.push(Object.assign({ matchType: 'name' }, c));
  });
  // Already sorted within each group; phone matches already at top.
  const candidates = merged.slice(0, 5);
  if (phoneMatchedCandidates.length > 0) scope = 'phone';
  res.json({ candidates, scope });
});

router.post('/captain/confirm-match', confirmLimiter, requireCaptainOrAdmin, (req, res) => {
  const { voterId, phone, listId } = req.body || {};
  if (!voterId || !phone) {
    return res.status(400).json({ error: 'voterId and phone required' });
  }
  const normalized = normalizePhone(phone) || phone;
  try {
    // 1) Check if voter exists and whether their stored phone already
    //    matches. If it matches we skip the phone overwrite — no need to
    //    write the same value — but still bump phone_validated_at to record
    //    that a captain confirmed this number is still good.
    const existing = db.prepare('SELECT phone FROM voters WHERE id = ?').get(voterId);
    if (!existing) return res.status(404).json({ error: 'voter not found' });
    const existingDigits = String(existing.phone || '').replace(/\D/g, '').slice(-10);
    const newDigits = String(normalized || '').replace(/\D/g, '').slice(-10);
    const phoneAlreadyMatches = existingDigits.length >= 10 && existingDigits === newDigits;
    if (phoneAlreadyMatches) {
      // Phone is already correct on the voter record — only refresh
      // validation timestamp + ensure phone_type is mobile.
      db.prepare(`
        UPDATE voters
        SET phone_validated_at = datetime('now'), phone_type = 'mobile'
        WHERE id = ?
      `).run(voterId);
    } else {
      db.prepare(`
        UPDATE voters
        SET phone = ?, phone_validated_at = datetime('now'), phone_type = 'mobile'
        WHERE id = ?
      `).run(normalized, voterId);
    }

    // 2) Add to captain's list if listId provided. Idempotent — captain
    //    can confirm twice without duplicating the list entry.
    let addedToList = false;
    let alreadyOnList = false;
    if (listId) {
      const list = db.prepare('SELECT id FROM captain_lists WHERE id = ?').get(listId);
      if (list) {
        const existing = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, voterId);
        if (existing) {
          alreadyOnList = true;
        } else {
          db.prepare('INSERT INTO captain_list_voters (list_id, voter_id) VALUES (?, ?)').run(listId, voterId);
          addedToList = true;
        }
      }
    }

    // 3) Look up household members so the captain can choose to add them too.
    //    Match on exact address string — same approach as
    //    /api/captains/:id/household (routes/captains.js:925). Filters out
    //    the primary voter and entries with no address.
    const primary = db.prepare('SELECT address FROM voters WHERE id = ?').get(voterId);
    let household = [];
    if (primary && primary.address && primary.address.trim()) {
      household = db.prepare(`
        SELECT v.id AS voterId, v.first_name AS firstName, v.last_name AS lastName,
               v.age, v.address, v.city, v.phone AS currentPhone,
               EXISTS(SELECT 1 FROM captain_list_voters WHERE list_id = ? AND voter_id = v.id) AS onList
        FROM voters v
        WHERE v.address = ? AND v.id != ?
        ORDER BY v.last_name, v.first_name
        LIMIT 20
      `).all(listId || 0, primary.address, voterId);
      household = household.map(h => Object.assign({}, h, { onList: !!h.onList }));
    }

    res.json({ success: true, voterId, phone: normalized, phoneAlreadyMatches, addedToList, alreadyOnList, household });
  } catch (err) {
    console.error('confirm-match error:', err.message);
    res.status(500).json({ error: 'update failed' });
  }
});

// Bulk-add household members (or any voter set) to a captain's list, nested
// under a parent voter so the list view groups them together.
router.post('/captain/add-household', confirmLimiter, requireCaptainOrAdmin, (req, res) => {
  const { listId, parentVoterId, voterIds } = req.body || {};
  if (!listId || !parentVoterId || !Array.isArray(voterIds) || voterIds.length === 0) {
    return res.status(400).json({ error: 'listId, parentVoterId, voterIds[] required' });
  }
  try {
    const list = db.prepare('SELECT id FROM captain_lists WHERE id = ?').get(listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const parentOnList = db.prepare('SELECT id FROM captain_list_voters WHERE list_id = ? AND voter_id = ?').get(listId, parentVoterId);
    if (!parentOnList) return res.status(400).json({ error: 'Parent voter not on this list — confirm-match first.' });

    const insert = db.prepare('INSERT OR IGNORE INTO captain_list_voters (list_id, voter_id, parent_voter_id) VALUES (?, ?, ?)');
    const setParent = db.prepare('UPDATE captain_list_voters SET parent_voter_id = ? WHERE list_id = ? AND voter_id = ?');
    let added = 0, alreadyThere = 0;
    const tx = db.transaction(() => {
      for (const id of voterIds) {
        const vid = parseInt(id, 10);
        if (!vid || vid === parentVoterId) continue;
        const r = insert.run(listId, vid, parentVoterId);
        if (r.changes) added++;
        else { setParent.run(parentVoterId, listId, vid); alreadyThere++; }
      }
    });
    tx();
    res.json({ success: true, added, alreadyThere });
  } catch (err) {
    console.error('add-household error:', err.message);
    res.status(500).json({ error: 'add-household failed' });
  }
});

module.exports = router;
