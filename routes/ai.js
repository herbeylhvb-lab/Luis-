const express = require('express');
const router = express.Router();
const db = require('../db');

// Build system prompt from campaign knowledge
function buildCampaignContext() {
  const entries = db.prepare('SELECT * FROM campaign_knowledge ORDER BY type, id').all();
  const bio = entries.filter(e => e.type === 'bio').map(e => e.content).join('\n');
  const policies = entries.filter(e => e.type === 'policy').map(e => `${e.title}: ${e.content}`).join('\n');
  const details = entries.filter(e => e.type === 'details').map(e => `${e.title}: ${e.content}`).join('\n');

  return `You are a campaign texting assistant. Generate a brief, friendly SMS response (under 160 chars preferred, max 320 chars) to a voter's message.

CANDIDATE BIO:
${bio || 'No bio provided.'}

CAMPAIGN DETAILS:
${details || 'No details provided.'}

POLICY POSITIONS:
${policies || 'No policies provided.'}

TONE RULES:
- Be friendly, respectful, and concise
- Never attack opponents by name
- Include the campaign website when relevant
- Stay strictly on-message using only the information above
- If you cannot confidently answer from the above info, respond with exactly: NO_MATCH`;
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
router.post('/p2p/suggest-reply', async (req, res) => {
  const { voterMessage, voterName, sentiment, sessionName } = req.body;
  if (!voterMessage) return res.status(400).json({ error: 'voterMessage required.' });

  const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();

  // Try AI first
  if (apiKey && apiKey.value) {
    try {
      const Anthropic = require('@anthropic-ai/sdk').default;
      const client = new Anthropic({ apiKey: apiKey.value });

      const systemPrompt = buildCampaignContext();
      const userPrompt = `Voter ${voterName || 'Unknown'} said: "${voterMessage}"
Sentiment: ${sentiment || 'neutral'}
Context: P2P texting session${sessionName ? ': ' + sessionName : ''}

Generate a short SMS reply:`;

      const response = await client.messages.create({
        model: 'claude-haiku-4-20250414',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const aiReply = response.content[0].text.trim();

      if (aiReply !== 'NO_MATCH') {
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
});

module.exports = router;
