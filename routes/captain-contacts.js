const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { scoreCandidate, normalizePhone } = require('../utils');

const matchLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many match requests.' } });
const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many confirm requests.' } });

router.post('/captain/match-candidates', matchLimiter, (req, res) => {
  const { firstName, lastName, age, captainId } = req.body || {};
  if (!firstName || !lastName || age == null) {
    return res.status(400).json({ error: 'firstName, lastName, age required' });
  }
  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 130) {
    return res.status(400).json({ error: 'age must be 1-130' });
  }
  const ageMin = Math.max(1, ageNum - 5);
  const ageMax = Math.min(130, ageNum + 5);
  const lastInitial = lastName[0] || '';

  function fetchAndScore(scope) {
    let rows;
    if (scope === 'list' && captainId) {
      rows = db.prepare(`
        SELECT id, first_name, last_name, age, gender, address, city, zip,
               phone, phone_validated_at
        FROM voters
        WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)
          AND age BETWEEN ? AND ?
          AND id IN (SELECT voter_id FROM captain_list_voters
                     WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?))
        LIMIT 100
      `).all(lastInitial, ageMin, ageMax, captainId);
    } else {
      rows = db.prepare(`
        SELECT id, first_name, last_name, age, gender, address, city, zip,
               phone, phone_validated_at
        FROM voters
        WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)
          AND age BETWEEN ? AND ?
        LIMIT 100
      `).all(lastInitial, ageMin, ageMax);
    }
    return rows.map(v => ({
      voterId: v.id,
      firstName: v.first_name,
      lastName: v.last_name,
      age: v.age,
      address: v.address,
      city: v.city,
      currentPhone: v.phone || '',
      phoneValidatedAt: v.phone_validated_at || null,
      score: scoreCandidate({ firstName, lastName, age: ageNum }, v),
    }))
      .filter(c => c.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  let candidates = fetchAndScore('list');
  let scope = 'list';
  if (candidates.length === 0) {
    candidates = fetchAndScore('broader');
    scope = 'broader';
  }
  res.json({ candidates, scope });
});

router.post('/captain/confirm-match', confirmLimiter, (req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

module.exports = router;
