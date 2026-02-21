const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

// --- Mount API routes ---
app.use('/api', require('./routes/contacts'));
app.use('/api', require('./routes/walks'));
app.use('/api', require('./routes/voters'));
app.use('/api', require('./routes/events'));
app.use('/api', require('./routes/knowledge'));
app.use('/api', require('./routes/ai'));
app.use('/api', require('./routes/p2p'));
app.use('/api', require('./routes/captains'));

// --- Core endpoints ---

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Stats ---
app.get('/api/stats', (req, res) => {
  const contacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'outbound'").get().c;
  const responses = db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'inbound'").get().c;
  const optedOut = db.prepare('SELECT COUNT(*) as c FROM opt_outs').get().c;
  const walks = db.prepare('SELECT COUNT(*) as c FROM block_walks').get().c;
  const doorsKnocked = db.prepare("SELECT COUNT(*) as c FROM walk_addresses WHERE result != 'not_visited'").get().c;
  const voters = db.prepare('SELECT COUNT(*) as c FROM voters').get().c;
  const upcomingEvents = db.prepare("SELECT COUNT(*) as c FROM events WHERE status = 'upcoming'").get().c;
  res.json({ contacts, sent, responses, optedOut, walks, doorsKnocked, voters, upcomingEvents });
});

// --- Activity log ---
app.get('/api/activity', (req, res) => {
  const logs = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 50').all();
  res.json({ logs });
});

app.post('/api/activity', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required.' });
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(message);
  res.json({ success: true });
});

// --- Sentiment stats ---
app.get('/api/stats/sentiment', (req, res) => {
  const positive = db.prepare("SELECT COUNT(*) as c FROM messages WHERE sentiment = 'positive'").get().c;
  const negative = db.prepare("SELECT COUNT(*) as c FROM messages WHERE sentiment = 'negative'").get().c;
  const neutral = db.prepare("SELECT COUNT(*) as c FROM messages WHERE sentiment = 'neutral'").get().c;
  res.json({ positive, negative, neutral });
});

// --- QR Check-in pages ---
app.get('/checkin/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

// Per-voter QR code check-in page (short URL for QR codes)
app.get('/v/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voter-checkin.html'));
});

// Standalone P2P volunteer page (shareable link, no admin access)
app.get('/volunteer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'volunteer.html'));
});

// Standalone Block Captain portal (shareable link)
app.get('/captain', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'captain.html'));
});

// --- Twilio test connection ---
app.post('/test-connection', async (req, res) => {
  const { accountSid, authToken } = req.body;
  if (!accountSid || !authToken) return res.status(400).json({ error: 'Missing credentials.' });
  try {
    const client = twilio(accountSid, authToken);
    const account = await client.api.accounts(accountSid).fetch();
    res.json({ success: true, accountName: account.friendlyName, status: account.status });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid credentials: ' + err.message });
  }
});

// --- Send campaign ---
app.post('/send', async (req, res) => {
  const { accountSid, authToken, from, contacts, messageTemplate, optOutFooter, eventId } = req.body;
  if (!accountSid || !authToken || !from) return res.status(400).json({ error: 'Missing Twilio credentials.' });
  if (!contacts || contacts.length === 0) return res.status(400).json({ error: 'No contacts provided.' });
  if (!messageTemplate) return res.status(400).json({ error: 'No message body provided.' });

  const client = twilio(accountSid, authToken);
  const results = { sent: 0, failed: 0, errors: [] };
  const optedOut = db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone);
  const optedOutSet = new Set(optedOut);

  // Build origin URL for QR links and MMS composite images
  const origin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://luis-production-8f1a.up.railway.app';

  // Check if event has a flyer for MMS
  let eventHasFlyer = false;
  if (eventId) {
    const evt = db.prepare('SELECT flyer_image IS NOT NULL as has_flyer FROM events WHERE id = ?').get(eventId);
    if (evt && evt.has_flyer) eventHasFlyer = true;
  }

  for (const contact of contacts) {
    try {
      if (optedOutSet.has(contact.phone)) { results.failed++; continue; }

      // Look up voter QR token for {qr_link} replacement and MMS
      let qrLink = '';
      let voterToken = null;
      const voter = db.prepare("SELECT qr_token FROM voters WHERE phone = ? AND qr_token IS NOT NULL LIMIT 1").get(contact.phone);
      if (voter) {
        voterToken = voter.qr_token;
        qrLink = origin + '/v/' + voter.qr_token;
      } else {
        qrLink = origin;
      }

      let body = messageTemplate
        .replace(/{firstName}/g, contact.firstName || contact.first_name || '')
        .replace(/{lastName}/g,  contact.lastName  || contact.last_name  || '')
        .replace(/{city}/g,      contact.city      || '')
        .replace(/{qr_link}/g,   qrLink);
      body += '\n' + (optOutFooter || 'Reply STOP to opt out.');

      // Build Twilio message params (include MMS if event has flyer + voter has token)
      const msgParams = { body, from, to: contact.phone };
      if (eventHasFlyer && voterToken) {
        msgParams.mediaUrl = [origin + '/api/events/' + eventId + '/flyer/' + voterToken];
      }

      await client.messages.create(msgParams);
      db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, ?, 'outbound')").run(contact.phone, body);
      results.sent++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) {
      results.failed++;
      results.errors.push({ phone: contact.phone, reason: err.message });
    }
  }

  db.prepare('INSERT INTO campaigns (message_template, sent_count, failed_count) VALUES (?, ?, ?)').run(messageTemplate, results.sent, results.failed);
  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Campaign sent: ' + results.sent + '/' + contacts.length + ' delivered.' + (eventHasFlyer ? ' (MMS with flyer)' : ''));

  res.json({ success: true, totalContacts: contacts.length, sent: results.sent, failed: results.failed, errors: results.errors.slice(0, 20) });
});

// --- Incoming webhook (Twilio) ---
app.post('/incoming', (req, res) => {
  const { From, Body } = req.body;
  const msgText = (Body || '').trim().toLowerCase();
  if (STOP_KEYWORDS.includes(msgText)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone) VALUES (?)').run(From);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("You've been removed from our list. -- Campaign HQ");
    return res.type('text/xml').send(twiml.toString());
  }
  const sentiment = analyzeSentiment(Body);

  // Check if this is a reply to an active P2P session
  const p2pAssignment = db.prepare(`
    SELECT a.*, s.id as sid FROM p2p_assignments a
    JOIN p2p_sessions s ON a.session_id = s.id
    JOIN contacts c ON a.contact_id = c.id
    WHERE c.phone = ? AND s.status = 'active' AND a.status IN ('sent', 'in_conversation')
    ORDER BY a.sent_at DESC LIMIT 1
  `).get(From);

  if (p2pAssignment) {
    db.prepare("UPDATE p2p_assignments SET status = 'in_conversation' WHERE id = ?").run(p2pAssignment.id);
    db.prepare("INSERT INTO messages (phone, body, direction, sentiment, session_id) VALUES (?, ?, 'inbound', ?, ?)").run(From, Body, sentiment, p2pAssignment.sid);
    return res.type('text/xml').send('<Response></Response>');
  }

  db.prepare("INSERT INTO messages (phone, body, direction, sentiment) VALUES (?, ?, 'inbound', ?)").run(From, Body, sentiment);
  const autoReply = generateAutoReply(msgText);
  if (autoReply) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(autoReply);
    return res.type('text/xml').send(twiml.toString());
  }
  res.type('text/xml').send('<Response></Response>');
});

// --- Messages & opt-outs ---
app.get('/api/messages', (req, res) => {
  const messages = db.prepare("SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id DESC LIMIT 200").all();
  const optedOut = db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone);
  res.json({ messages, optedOut });
});

// Keep old path for backward compat
app.get('/messages', (req, res) => {
  const messages = db.prepare("SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id DESC LIMIT 200").all();
  const optedOut = db.prepare('SELECT phone FROM opt_outs').all().map(r => r.phone);
  res.json({ messages, optedOut });
});

// --- Reply ---
app.post('/reply', async (req, res) => {
  const { accountSid, authToken, from, to, body } = req.body;
  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body, from, to });
    db.prepare("INSERT INTO messages (phone, body, direction) VALUES (?, ?, 'outbound')").run(to, body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Send event invites via text ---
app.post('/api/events/:id/invite', async (req, res) => {
  const { accountSid, authToken, from, contactIds, messageTemplate } = req.body;
  if (!accountSid || !authToken || !from) return res.status(400).json({ error: 'Missing Twilio credentials.' });
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const contacts = [];
  for (const cid of (contactIds || [])) {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
    if (c) contacts.push(c);
  }
  if (contacts.length === 0) return res.status(400).json({ error: 'No contacts selected.' });

  const client = twilio(accountSid, authToken);
  let sent = 0;
  const rsvpInsert = db.prepare('INSERT INTO event_rsvps (event_id, contact_phone, contact_name, rsvp_status) VALUES (?, ?, ?, \'invited\')');

  const invOrigin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://luis-production-8f1a.up.railway.app';

  // Check if event has a flyer for MMS
  const eventRow = db.prepare('SELECT flyer_image IS NOT NULL as has_flyer FROM events WHERE id = ?').get(req.params.id);
  const eventHasFlyer = eventRow && eventRow.has_flyer;

  for (const c of contacts) {
    try {
      // Look up QR link for this contact
      let qrLink = '';
      let voterToken = null;
      const voter = db.prepare("SELECT qr_token FROM voters WHERE phone = ? AND qr_token IS NOT NULL LIMIT 1").get(c.phone);
      if (voter) {
        voterToken = voter.qr_token;
        qrLink = invOrigin + '/v/' + voter.qr_token;
      } else {
        qrLink = invOrigin;
      }

      let body = (messageTemplate || 'You\'re invited to {title} on {date} at {location}!')
        .replace(/{title}/g, event.title)
        .replace(/{date}/g, event.event_date)
        .replace(/{time}/g, event.event_time || '')
        .replace(/{location}/g, event.location || '')
        .replace(/{firstName}/g, c.first_name || '')
        .replace(/{lastName}/g, c.last_name || '')
        .replace(/{qr_link}/g, qrLink);
      body += '\nReply STOP to opt out.';

      // Build Twilio message params (include MMS if event has flyer + voter has QR token)
      const msgParams = { body, from, to: c.phone };
      if (eventHasFlyer && voterToken) {
        msgParams.mediaUrl = [invOrigin + '/api/events/' + req.params.id + '/flyer/' + voterToken];
      }

      await client.messages.create(msgParams);
      rsvpInsert.run(req.params.id, c.phone, (c.first_name + ' ' + c.last_name).trim());
      sent++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) { /* skip failed */ }
  }

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run('Invited ' + sent + ' contacts to: ' + event.title);
  res.json({ success: true, sent });
});

// --- Sentiment analysis ---
function analyzeSentiment(text) {
  const msg = (text || '').toLowerCase();
  const positiveWords = ['yes', 'sure', 'support', 'agree', 'thanks', 'thank', 'great', 'love', 'count me in', 'absolutely', 'interested', 'definitely', 'of course', 'wonderful', 'awesome', 'perfect', 'good', 'ok', 'okay', 'yep', 'yea', 'yeah'];
  const negativeWords = ['no', 'stop', 'disagree', 'oppose', 'hate', 'unsubscribe', 'leave me alone', 'not interested', 'remove', 'never', 'terrible', 'awful', 'worst', 'don\'t', 'wont', 'refuse', 'against', 'bad'];
  let score = 0;
  for (const word of positiveWords) { if (msg.includes(word)) score++; }
  for (const word of negativeWords) { if (msg.includes(word)) score--; }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

function generateAutoReply(msg) {
  if (['poll','polling','vote','where','location'].some(k => msg.includes(k)))
    return "Find your polling location at vote.gov. Polls open 7am-7pm on Election Day! -- Campaign HQ";
  if (['time','open','close','hours','when'].some(k => msg.includes(k)))
    return "Polls are open 7:00 AM - 7:00 PM on Election Day. Check vote.gov for early voting! -- Campaign HQ";
  if (['register','registration'].some(k => msg.includes(k)))
    return "Register or check your status at vote.org. Don't miss the deadline! -- Campaign HQ";
  return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('CampaignText HQ running on port ' + PORT);
});
