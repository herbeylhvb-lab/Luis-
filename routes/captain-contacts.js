const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { scoreCandidate, normalizePhone } = require('../utils');

const matchLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many match requests.' } });
const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many confirm requests.' } });

router.post('/captain/match-candidates', matchLimiter, (req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

router.post('/captain/confirm-match', confirmLimiter, (req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

module.exports = router;
