const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');

// Build system prompt from campaign knowledge
function buildCampaignContext() {
  const entries = db.prepare('SELECT * FROM campaign_knowledge ORDER BY type, id').all();
  const bio = entries.filter(e => e.type === 'bio').map(e => e.content).join('\n');
  const policies = entries.filter(e => e.type === 'policy').map(e => `${e.title}: ${e.content}`).join('\n');
  const details = entries.filter(e => e.type === 'details').map(e => `${e.title}: ${e.content}`).join('\n');
  const instructions = entries.filter(e => e.type === 'instruction').map(e => '- ' + e.content).join('\n');

  return `You are a campaign texting assistant for Luis Villarreal Jr., candidate for Port Commissioner Place 4, Port of Brownsville. Generate a brief, friendly SMS response (under 160 chars preferred, max 320 chars) to a voter's message.

CRITICAL: Read the voter's message carefully and respond DIRECTLY to what they asked. Do not give generic campaign pitches — answer their specific question or respond to their specific comment.

CANDIDATE BIO:
${bio || 'Luis Villarreal Jr. is running for Port Commissioner Place 4, Port of Brownsville, TX. He is a business owner focused on lowering costs, creating jobs, and cutting red tape at the port.'}

CAMPAIGN DETAILS:
${details || 'Election: Port Commissioner Place 4, Port of Brownsville. Website: villarrealjr.com'}

POLICY POSITIONS:
${policies || 'Streamline industrial permitting, lower costs through efficiency, compete for Gulf Coast investment, create more jobs and lower taxes.'}

HOW LUIS GETS THINGS DONE:
- By working with fellow board members and building consensus
- By partnering with state and federal officials for funding and support
- By applying his business experience to cut waste and improve operations
- By listening to the community and representing their interests at the port

${instructions ? `CUSTOM BEHAVIOR INSTRUCTIONS (from campaign admin — follow these closely):
${instructions}

` : ''}RESPONSE RULES:
- Be warm, personal, and conversational — like a real person texting
- Answer the voter's SPECIFIC question — don't pivot to talking points unless relevant
- If they ask "how will you do X?" explain the approach (working with board, state/federal partners, business efficiency)
- If they express a concern, acknowledge it first before responding
- If they're supportive, thank them warmly and ask if they want to volunteer or need a yard sign
- If they're hostile, stay respectful and wish them well
- Never attack opponents by name
- Keep it short — this is a text, not an email
- If you truly cannot answer from the info above, respond with exactly: NO_MATCH`;
}

// Get best matching script for fallback
function findBestScript(voterMessage, sentiment) {
  const scripts = db.prepare('SELECT * FROM response_scripts').all();
  if (scripts.length === 0) return null;

  const scenarioMap = {
    positive: ['supporter_positive', 'positive', 'supporter'],
    negative: ['hostile', 'negative', 'opposed'],
    neutral: ['undecided_question', 'neutral', 'undecided', 'question']
  };
  const candidates = scenarioMap[sentiment] || scenarioMap.neutral;
  for (const scenario of candidates) {
    const match = scripts.find(s => s.scenario.toLowerCase().includes(scenario));
    if (match) return match;
  }
  return scripts[0];
}

// POST /api/p2p/suggest-reply
router.post('/p2p/suggest-reply', asyncHandler(async (req, res) => {
  const { voterMessage, voterName, sentiment, sessionName } = req.body;
  if (!voterMessage) return res.status(400).json({ error: 'voterMessage required.' });
  if (voterMessage.length > 2000) return res.status(400).json({ error: 'Voter message too long (max 2000 chars).' });

  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();
  // Try AI first
  if (apiKey && apiKey.value) {
    try {
      const Anthropic = require('@anthropic-ai/sdk').default;
      const client = new Anthropic({ apiKey: apiKey.value });

      const systemPrompt = buildCampaignContext();
      const userPrompt = `Voter ${voterName || 'Someone'} texted: "${voterMessage}"
Their tone seems: ${sentiment || 'neutral'}

Reply directly to what they said. Be specific — don't give a generic campaign pitch. Keep it under 160 characters if possible.`;

      const response = await client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const aiReply = response.content && response.content[0] && response.content[0].text
        ? response.content[0].text.trim()
        : null;

      if (aiReply && !aiReply.startsWith('NO_MATCH')) {
        return res.json({ source: 'ai', suggestion: aiReply });
      }
    } catch (err) {
      console.error('AI suggestion error:', err.message);
    }
  }

  // Fallback to scripts
  const script = findBestScript(voterMessage, sentiment || 'neutral');
  if (script) {
    return res.json({ source: 'script', suggestion: script.content, scriptLabel: script.label });
  }

  res.json({ source: 'none', suggestion: null });
}));

// POST /api/p2p/review-reply — grammar/spelling check for volunteer-typed replies
router.post('/p2p/review-reply', asyncHandler(async (req, res) => {
  const { draftText } = req.body;
  if (!draftText) return res.status(400).json({ error: 'draftText required.' });
  if (draftText.length > 2000) return res.status(400).json({ error: 'Draft text too long (max 2000 chars).' });

  // Skip review for very short messages (under 10 chars — e.g. "Thanks!" "Yes" "OK")
  if (draftText.trim().length < 10) {
    return res.json({ corrected: draftText.trim(), changed: false });
  }

  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();

  if (apiKey && apiKey.value) {
    try {
      const Anthropic = require('@anthropic-ai/sdk').default;
      const client = new Anthropic({ apiKey: apiKey.value });

      const response = await client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 400,
        system: `You are a grammar and spelling checker for SMS campaign texts. Fix grammar, spelling, and punctuation errors in the volunteer's draft message. Keep the same tone, meaning, and length. Only fix actual errors — do not rewrite or improve the message beyond corrections. If the message has no errors, return it exactly as-is. Return ONLY the corrected text, nothing else.`,
        messages: [{ role: 'user', content: draftText }]
      });

      const corrected = response.content && response.content[0] && response.content[0].text
        ? response.content[0].text.trim()
        : draftText;

      const changed = corrected.toLowerCase() !== draftText.trim().toLowerCase();
      return res.json({ corrected, changed, original: draftText.trim() });
    } catch (err) {
      console.error('AI review error:', err.message);
    }
  }

  // No API key or AI failed — pass through
  res.json({ corrected: draftText.trim(), changed: false });
}));

// POST /api/ai/test-key — verify the Anthropic API key works
router.post('/ai/test-key', asyncHandler(async (req, res) => {
  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();
  if (!apiKey || !apiKey.value) {
    return res.json({ success: false, error: 'No API key saved. Paste your key above and click Save first.' });
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({ apiKey: apiKey.value });
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Say OK' }]
    });
    const text = response.content && response.content[0] ? response.content[0].text : '';
    return res.json({ success: true, model: 'claude-3-5-haiku-20241022', response: text.trim() });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
}));

module.exports = router;
