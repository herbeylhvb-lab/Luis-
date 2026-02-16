const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

let incomingMessages = [];
let optedOutNumbers = new Set();
const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

app.post('/send', async (req, res) => {
  const { accountSid, authToken, from, contacts, messageTemplate, optOutFooter } = req.body;
  if (!accountSid || !authToken || !from) return res.status(400).json({ error: 'Missing Twilio credentials.' });
  if (!contacts || contacts.length === 0) return res.status(400).json({ error: 'No contacts provided.' });
  if (!messageTemplate) return res.status(400).json({ error: 'No message body provided.' });

  const client = twilio(accountSid, authToken);
  const results = { sent: 0, failed: 0, errors: [] };

  for (const contact of contacts) {
    try {
      if (optedOutNumbers.has(contact.phone)) { results.failed++; continue; }
      let body = messageTemplate
        .replace(/{firstName}/g, contact.firstName || '')
        .replace(/{lastName}/g,  contact.lastName  || '')
        .replace(/{city}/g,      contact.city      || '');
      body += '\n' + (optOutFooter || 'Reply STOP to opt out.');
      await client.messages.create({ body, from, to: contact.phone });
      results.sent++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) {
      results.failed++;
      results.errors.push({ phone: contact.phone, reason: err.message });
    }
  }
  res.json({ success: true, totalContacts: contacts.length, sent: results.sent, failed: results.failed, errors: results.errors.slice(0, 20) });
});

app.post('/incoming', (req, res) => {
  const { From, Body } = req.body;
  const msgText = (Body || '').trim().toLowerCase();
  if (STOP_KEYWORDS.includes(msgText)) {
    optedOutNumbers.add(From);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("You've been removed from our list. -- Campaign HQ");
    return res.type('text/xml').send(twiml.toString());
  }
  incomingMessages.push({ phone: From, body: Body, timestamp: new Date().toISOString() });
  const autoReply = generateAutoReply(msgText);
  if (autoReply) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(autoReply);
    return res.type('text/xml').send(twiml.toString());
  }
  res.type('text/xml').send('<Response></Response>');
});

app.get('/messages', (req, res) => {
  res.json({ messages: incomingMessages, optedOut: [...optedOutNumbers] });
});

app.post('/reply', async (req, res) => {
  const { accountSid, authToken, from, to, body } = req.body;
  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body, from, to });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
