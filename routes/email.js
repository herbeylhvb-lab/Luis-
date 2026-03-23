const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const db = require('../db');
const { asyncHandler, personalizeTemplate } = require('../utils');

const emailSendLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many email sends, slow down.' } });

// Test SMTP connection
router.post('/email/test', asyncHandler(async (req, res) => {
  const { service, host, port, user, pass } = req.body;
  if (!user || !pass) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const transportOpts = service
      ? { service, auth: { user, pass } }
      : { host, port: port || 587, secure: (port === 465), auth: { user, pass } };

    const transporter = nodemailer.createTransport(transportOpts);
    await transporter.verify();
    res.json({ success: true, message: 'SMTP connection successful.' });
  } catch (err) {
    res.status(400).json({ success: false, error: 'SMTP connection failed. Check your credentials and server settings.' });
  }
}));

// Get email recipients (contacts + voters with email, deduplicated)
router.get('/email/recipients', (req, res) => {
  // Get contacts with email
  const contacts = db.prepare("SELECT first_name, last_name, email, city, 'contact' as source FROM contacts WHERE email IS NOT NULL AND email != ''").all();
  // Get voters with email
  const voters = db.prepare("SELECT first_name, last_name, email, city, 'voter' as source FROM voters WHERE email IS NOT NULL AND email != ''").all();

  // Deduplicate by email (lowercase)
  const seen = new Set();
  const recipients = [];
  for (const r of [...contacts, ...voters]) {
    const key = r.email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      recipients.push(r);
    }
  }

  res.json({ recipients, total: recipients.length });
});

// Get email recipients from a specific admin list
router.get('/email/recipients-from-list/:listId', (req, res) => {
  const recipients = db.prepare(`
    SELECT v.first_name, v.last_name, v.email, v.city, v.precinct, 'voter' as source
    FROM admin_list_voters alv
    JOIN voters v ON alv.voter_id = v.id
    WHERE alv.list_id = ? AND v.email IS NOT NULL AND v.email != ''
  `).all(req.params.listId);

  res.json({ recipients, total: recipients.length });
});

// Send mass email
router.post('/email/send', emailSendLimiter, asyncHandler(async (req, res) => {
  const { smtp, fromName, subject, bodyHtml, recipients } = req.body;
  if (!smtp || !smtp.user || !smtp.pass) return res.status(400).json({ error: 'SMTP credentials required.' });
  if (!subject) return res.status(400).json({ error: 'Subject is required.' });
  if (!bodyHtml) return res.status(400).json({ error: 'Email body is required.' });
  if (!recipients || recipients.length === 0) return res.status(400).json({ error: 'No recipients.' });
  if (recipients.length > 500) return res.status(400).json({ error: 'Maximum 500 recipients per batch. Split into multiple sends.' });

  try {
    const transportOpts = smtp.service
      ? { service: smtp.service, auth: { user: smtp.user, pass: smtp.pass } }
      : { host: smtp.host, port: smtp.port || 587, secure: (smtp.port === 465), auth: { user: smtp.user, pass: smtp.pass } };

    const transporter = nodemailer.createTransport(transportOpts);
    const senderName = (fromName || 'Campaign HQ').replace(/["\\<>\r\n]/g, '');
    const results = { sent: 0, failed: 0, errors: [] };

    // Filter out recipients without email
    const filteredRecipients = recipients.filter(r => r.email);

    for (const r of filteredRecipients) {
      try {
        // Basic email format validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
          results.failed++;
          if (results.errors.length < 20) results.errors.push({ email: r.email, reason: 'Invalid email format' });
          continue;
        }

        // Personalize subject and body with merge tags
        const personalSubject = personalizeTemplate(subject, r);
        const personalBody = personalizeTemplate(bodyHtml, r);

        await transporter.sendMail({
          from: '"' + senderName + '" <' + smtp.user + '>',
          to: r.email,
          subject: personalSubject,
          html: personalBody
        });
        results.sent++;
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (err) {
        results.failed++;
        if (results.errors.length < 20) results.errors.push({ email: r.email, reason: err.message || 'Send failed' });
      }
    }

    // Log the campaign
    db.prepare(
      'INSERT INTO email_campaigns (subject, body_html, sent_count, failed_count) VALUES (?, ?, ?, ?)'
    ).run(subject, bodyHtml, results.sent, results.failed);

    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      'Email campaign "' + subject + '": ' + results.sent + '/' + filteredRecipients.length + ' delivered.'
    );

    res.json({ success: true, sent: results.sent, failed: results.failed, errors: results.errors.slice(0, 20) });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: 'Email send failed. Check SMTP settings and try again.' });
  }
}));

module.exports = router;
