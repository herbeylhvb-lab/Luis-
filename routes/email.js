const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const db = require('../db');

// Test SMTP connection
router.post('/email/test', async (req, res) => {
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
    res.status(400).json({ success: false, error: 'Connection failed: ' + err.message });
  }
});

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

// Send mass email
router.post('/email/send', async (req, res) => {
  const { smtp, fromName, subject, bodyHtml, recipients } = req.body;
  if (!smtp || !smtp.user || !smtp.pass) return res.status(400).json({ error: 'SMTP credentials required.' });
  if (!subject) return res.status(400).json({ error: 'Subject is required.' });
  if (!bodyHtml) return res.status(400).json({ error: 'Email body is required.' });
  if (!recipients || recipients.length === 0) return res.status(400).json({ error: 'No recipients.' });

  try {
    const transportOpts = smtp.service
      ? { service: smtp.service, auth: { user: smtp.user, pass: smtp.pass } }
      : { host: smtp.host, port: smtp.port || 587, secure: (smtp.port === 465), auth: { user: smtp.user, pass: smtp.pass } };

    const transporter = nodemailer.createTransport(transportOpts);
    const senderName = fromName || 'Campaign HQ';
    const results = { sent: 0, failed: 0, errors: [] };

    for (const r of recipients) {
      try {
        // Personalize subject and body with merge tags
        const personalSubject = subject
          .replace(/{firstName}/g, r.firstName || r.first_name || '')
          .replace(/{lastName}/g, r.lastName || r.last_name || '')
          .replace(/{city}/g, r.city || '');

        const personalBody = bodyHtml
          .replace(/{firstName}/g, r.firstName || r.first_name || '')
          .replace(/{lastName}/g, r.lastName || r.last_name || '')
          .replace(/{city}/g, r.city || '');

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
        results.errors.push({ email: r.email, reason: err.message });
      }
    }

    // Log the campaign
    db.prepare(
      'INSERT INTO email_campaigns (subject, body_html, sent_count, failed_count) VALUES (?, ?, ?, ?)'
    ).run(subject, bodyHtml, results.sent, results.failed);

    db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
      'Email campaign "' + subject + '": ' + results.sent + '/' + recipients.length + ' delivered.'
    );

    res.json({ success: true, sent: results.sent, failed: results.failed, errors: results.errors.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: 'Email send failed: ' + err.message });
  }
});

module.exports = router;
