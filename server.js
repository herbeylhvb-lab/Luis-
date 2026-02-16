// ============================================================
//  CampaignText HQ — Backend Server
//  Built with Node.js + Express + Twilio
// ============================================================

const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');
const path    = require('path');

const app = express();

// --- Middleware (lets the server read requests) ---
app.use(cors());                          // Allows your HTML file to talk to this server
app.use(express.json());                  // Reads JSON data
app.use(express.urlencoded({ extended: false })); // Reads form data (from Twilio webhooks)

// --- Serve your HTML dashboard ---
app.use(express.static(path.join(__dirname, 'public'))); // Put campaign-texter.html in a /public folder

// ============================================================
//  1. SEND A SINGLE TEXT (or loop through contacts)
//  Called from your dashboard when user clicks "Send Campaign"
// ============================================================
app.post('/send', async (req, res) => {
  const { accountSid, authToken, from, contacts, messageTemplate, optOutFooter } = req.body;

  // Validate required fields
  if (!accountSid || !authToken || !from) {
    return res.status(400).json({ error: 'Missing Twilio credentials.' });
  }
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: 'No contacts provided.' });
  }
  if (!messageTemplate) {
    return res.status(400).json({ error: 'No message body provided.' });
  }

  // Create a Twilio client with the provided credentials
  const client = twilio(accountSid, authToken);

  const results = { sent: 0, failed: 0, errors: [] };

  // Loop through each contact and send a personalized text
  for (const contact of contacts) {
    try {
      // Check if this number has opted out
      if (contact.optedOut) {
        results.failed++;
        results.errors.push({ phone: contact.phone, reason: 'Opted out' });
        continue;
      }

      // Personalize the message by replacing {tags}
      let body = messageTemplate
        .replace(/{firstName}/g, contact.firstName || '')
        .replace(/{lastName}/g,  contact.lastName  || '')
        .replace(/{city}/g,      contact.city      || '');

      // Always append opt-out footer (required by TCPA)
      body += '\n' + (optOutFooter || 'Reply STOP to opt out.');

      // Enforce TCPA quiet hours (8am–9pm in recipient's local time)
      // For simplicity, this checks server time — in production use a timezone library
      const hour = new Date().getHours();
      if (hour < 8 || hour >= 21) {
        results.failed++;
        results.errors.push({ phone: contact.phone, reason: 'Outside allowed hours (8am-9pm)' });
        continue;
      }

      // Send the message via Twilio
      await client.messages.create({
        body: body,
        from: from,
        to: contact.phone,
      });

      results.sent++;

      // Small delay between messages to avoid rate limiting (50ms)
      await new Promise(resolve => setTimeout(resolve, 50));

    } catch (err) {
      results.failed++;
      results.errors.push({ phone: contact.phone, reason: err.message });
    }
  }

  res.json({
    success: true,
    totalContacts: contacts.length,
    sent: results.sent,
    failed: results.failed,
    errors: results.errors.slice(0, 20) // Return first 20 errors max
  });
});

// ============================================================
//  2. TEST TWILIO CONNECTION
//  Called when user clicks "Test Connection" in Settings
// ============================================================
app.post('/test-connection', async (req, res) => {
  const { accountSid, authToken, from } = req.body;

  if (!accountSid || !authToken) {
    return res.status(400).json({ error: 'Missing credentials.' });
  }

  try {
    const client = twilio(accountSid, authToken);
    // Fetch account info — this will fail if credentials are wrong
    const account = await client.api.accounts(accountSid).fetch();
    res.json({
      success: true,
      accountName: account.friendlyName,
      status: account.status,
    });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid credentials: ' + err.message });
  }
});

// ============================================================
//  3. RECEIVE INCOMING REPLIES (Twilio Webhook)
//  Set this URL in your Twilio console:
//  http://YOUR-SERVER-IP:3000/incoming
//  Twilio calls this every time someone replies to your texts
// ============================================================

// In-memory store for incoming messages (use a database in production)
let incomingMessages = [];

// Keywords that trigger automatic opt-out
const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

// Opt-out list (in production, store this in a database)
let optedOutNumbers = new Set();

app.post('/incoming', (req, res) => {
  const { From, Body } = req.body; // Twilio sends these fields
  const msgText = (Body || '').trim().toLowerCase();

  console.log(`📱 Incoming message from ${From}: ${Body}`);

  // Handle STOP / opt-out automatically (TCPA required)
  if (STOP_KEYWORDS.includes(msgText)) {
    optedOutNumbers.add(From);
    console.log(`🛑 ${From} opted out.`);

    // Send opt-out confirmation (required by TCPA)
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("You've been removed from our list and won't receive further messages. — Campaign HQ");
    return res.type('text/xml').send(twiml.toString());
  }

  // Store the message so your dashboard can display it
  incomingMessages.push({
    phone: From,
    body: Body,
    timestamp: new Date().toISOString(),
    handled: false,
  });

  // Generate an auto-reply based on keywords
  const autoReply = generateAutoReply(msgText);

  if (autoReply) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(autoReply);
    return res.type('text/xml').send(twiml.toString());
  }

  // No auto-reply — just acknowledge to Twilio
  res.type('text/xml').send('<Response></Response>');
});

// ============================================================
//  4. GET INCOMING MESSAGES (your dashboard polls this)
// ============================================================
app.get('/messages', (req, res) => {
  res.json({
    messages: incomingMessages,
    optedOut: [...optedOutNumbers],
  });
});

// ============================================================
//  5. SEND A MANUAL REPLY (from your dashboard Inbox)
// ============================================================
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

// ============================================================
//  HELPER: Generate auto-replies based on message keywords
// ============================================================
function generateAutoReply(msg) {
  const polling = ['poll', 'polling', 'vote', 'where', 'location'];
  const hours   = ['time', 'open', 'close', 'hours', 'when'];
  const register = ['register', 'registration', 'sign up', 'signup'];
  const info    = ['who', 'what', 'platform', 'policy', 'stance'];

  if (polling.some(k => msg.includes(k))) {
    return "Find your polling location at vote.gov or call your county clerk. Polls are open 7am–7pm on Election Day! 🗳️ — Campaign HQ";
  }
  if (hours.some(k => msg.includes(k))) {
    return "Polls are open 7:00 AM – 7:00 PM on Election Day. Early voting may have different hours — check vote.gov! — Campaign HQ";
  }
  if (register.some(k => msg.includes(k))) {
    return "Check your registration or register at vote.org. Don't miss the deadline! — Campaign HQ";
  }
  if (info.some(k => msg.includes(k))) {
    return "Learn more about our campaign at our website. We'd love your support! — Campaign HQ";
  }

  return null; // No auto-reply for unrecognized messages
}

// ============================================================
//  START THE SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ✅ CampaignText HQ Server is running!
  🌐 Open your dashboard: http://localhost:${PORT}
  📡 Twilio webhook URL:  http://YOUR-PUBLIC-IP:${PORT}/incoming
  `);
});
