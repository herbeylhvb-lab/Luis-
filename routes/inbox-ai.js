// Inbox AI features — holistic per-phone sentiment classification.
//
// Why this exists:
//   The raw `messages.sentiment` column is per-message, set at ingest by a
//   keyword classifier.  When a phone has multiple replies, the inbox
//   filter "positive" surfaces ANY message tagged positive, which is noisy
//   — a phone with one friendly text and three "stop already" texts
//   shouldn't read positive overall.
//
//   This module computes a *holistic* sentiment per phone using Claude:
//   the entire inbound conversation goes in, one classification comes out
//   ('positive' | 'negative' | 'neutral'), cached in
//   phone_holistic_sentiment.  Filter Positive on the inbox shows phones
//   whose holistic classification is positive — the message-level sentiment
//   tags stay intact and are still rendered alongside.
//
//   Hard rule: any STOP/UNSUBSCRIBE keyword anywhere in the conversation
//   forces 'negative' regardless of model output.  Belt-and-suspenders
//   over the model — TCPA compliance is non-negotiable.

const express = require('express');
const router = express.Router();
const db = require('../db');

// Phone normalization — last 10 digits, all non-digits stripped.  Identical
// to the helper used in /api/messages/pending so format drift between
// '+19565551234', '9565551234', and '(956) 555-1234' all match the same
// cache row.
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits.slice(-10);
}

// Hard opt-out keywords — if any of these appear in the conversation, force
// negative classification before even calling the model.  Caught at every
// ingestion point in the codebase already, but surfaced here too because
// a model occasionally rationalizes a "STOP texting me" as polite request.
const OPT_OUT_PATTERNS = /\b(stop|unsubscribe|quit|cancel|opt[\s-]?out|do not text|leave me alone)\b/i;

// Get all inbound messages for a phone.  Uses the indexed phone_norm
// generated column (idx_messages_phone_norm) — direct equality, no
// per-row function calls.  The `AND phone_norm != ''` is required for
// the partial index to be picked up by the optimizer.
function loadConversation(phoneNorm) {
  if (!phoneNorm) return [];
  return db.prepare(`
    SELECT id, body, sentiment, timestamp, phone_norm
    FROM messages
    WHERE direction = 'inbound'
      AND phone_norm = ?
      AND phone_norm != ''
    ORDER BY id ASC
  `).all(phoneNorm);
}

// Fallback sentiment when no AI cache exists yet — looks at message-level
// tags + opt-out keywords.  Keeps the UI useful before AI eval completes.
function fallbackHolistic(messages) {
  for (const m of messages) {
    if (m.body && OPT_OUT_PATTERNS.test(m.body)) return 'negative';
  }
  if (messages.length === 0) return 'neutral';
  const latest = messages[messages.length - 1];
  return latest.sentiment || 'neutral';
}

// ─── GET /api/inbox/grouped-by-phone ────────────────────────────────────
// Returns one entry per unique inbound phone with the holistic sentiment
// (cached or fallback) and the full message list for that phone.  The
// inbox UI hits this when the user clicks Positive or Negative filter.
//
// Query params:
//   sentiment=positive|negative|all   filter on holistic sentiment
//
// Response includes `pending_eval`: phones lacking a current AI cache, so
// the client can trigger /eval-sentiment for them in the background.
router.get('/inbox/grouped-by-phone', (req, res) => {
  const filter = (req.query.sentiment || 'all').toLowerCase();
  const allowedFilters = new Set(['positive', 'negative', 'neutral', 'all']);
  if (!allowedFilters.has(filter)) {
    return res.status(400).json({ error: 'Invalid sentiment filter.' });
  }

  // Pull the full inbound message list using the phone_norm generated
  // column on messages (indexed via idx_messages_phone_norm).  We resolve
  // contact_name via a JS-side hash map built from a single voters scan
  // and a single contacts scan — instead of correlated subqueries that
  // ran NORM(v.phone) for every voter row × every inbound message row.
  // Old shape: O(messages × voters) ≈ 200M ops at campaign scale.
  // New shape: O(messages) + O(voters) + O(contacts) ≈ 250K ops.
  const rows = db.prepare(`
    SELECT m.id, m.phone, m.body, m.sentiment, m.timestamp, m.phone_norm
    FROM messages m
    WHERE m.direction = 'inbound'
    ORDER BY m.id DESC
  `).all();

  // Build phone_norm → name lookup once per request.  Voters table is the
  // big one (~210K) but pulling a 50K-name map is ~2-3MB and ~150ms worst
  // case — vastly cheaper than the per-message correlated subqueries.
  const nameMap = new Map();
  const voterNames = db.prepare(
    `SELECT phone_norm, first_name, last_name FROM voters
       WHERE phone_norm != '' AND phone_norm IS NOT NULL`
  ).all();
  for (const v of voterNames) {
    if (!nameMap.has(v.phone_norm)) {
      nameMap.set(v.phone_norm, ((v.first_name || '') + ' ' + (v.last_name || '')).trim());
    }
  }
  const contactNames = db.prepare(
    `SELECT phone_norm, first_name, last_name FROM contacts
       WHERE phone_norm != '' AND phone_norm IS NOT NULL`
  ).all();
  for (const c of contactNames) {
    if (!nameMap.has(c.phone_norm)) {
      // Voters take precedence — only fill in from contacts if no voter match.
      nameMap.set(c.phone_norm, ((c.first_name || '') + ' ' + (c.last_name || '')).trim());
    }
  }
  // Join into the messages array.
  for (const r of rows) {
    r.contact_name = nameMap.get(r.phone_norm) || '';
  }

  // Group by phone_norm.  Display phone is the most-recently-stored format.
  const groupMap = new Map();
  for (const r of rows) {
    if (!r.phone_norm) continue;
    let g = groupMap.get(r.phone_norm);
    if (!g) {
      g = {
        phone: r.phone_norm,
        phone_display: r.phone,           // first row encountered = newest, by ORDER BY id DESC
        contact_name: r.contact_name || '',
        messages: [],
        latest_id: r.id,
        latest_at: r.timestamp || ''
      };
      groupMap.set(r.phone_norm, g);
    }
    g.messages.push({
      id: r.id, body: r.body, sentiment: r.sentiment, timestamp: r.timestamp
    });
  }

  // Pull cached holistic sentiments in one shot (avoid per-phone N+1).
  const cacheMap = new Map();
  const cacheRows = db.prepare('SELECT * FROM phone_holistic_sentiment').all();
  for (const c of cacheRows) cacheMap.set(c.phone_norm, c);

  // Assemble groups with holistic + staleness flags.
  const groups = [];
  const pendingEval = [];
  for (const g of groupMap.values()) {
    g.message_count = g.messages.length;
    // Reverse to chronological order for display (we collected newest-first)
    g.messages = g.messages.reverse();
    const cache = cacheMap.get(g.phone);
    const latestMsgId = g.messages[g.messages.length - 1].id;
    if (cache) {
      g.holistic_sentiment = cache.sentiment;
      g.holistic_reason = cache.reason || '';
      g.is_stale = (cache.last_message_id || 0) < latestMsgId;
      if (g.is_stale) pendingEval.push(g.phone);
    } else {
      // No cache yet — use fallback rule, mark for AI eval.
      g.holistic_sentiment = fallbackHolistic(g.messages);
      g.holistic_reason = '';
      g.is_stale = true;
      pendingEval.push(g.phone);
    }
    groups.push(g);
  }

  // Filter by sentiment.
  const filtered = filter === 'all'
    ? groups
    : groups.filter(g => g.holistic_sentiment === filter);

  // Sort by latest activity.
  filtered.sort((a, b) => (b.latest_id || 0) - (a.latest_id || 0));

  res.json({
    groups: filtered,
    pending_eval: pendingEval,
    total_phones: groups.length,
    filter_applied: filter
  });
});

// ─── POST /api/inbox/eval-sentiment ─────────────────────────────────────
// Body: { phones: ["9565551234", ...] }  (max 20 per request)
//
// For each phone, loads the conversation, runs the AI classifier, upserts
// into phone_holistic_sentiment.  Returns the updated rows so the client
// can re-render without an extra round trip.
//
// Concurrency: runs evaluations in parallel (capped at 5 at a time) so a
// 20-phone batch doesn't take 30 seconds end-to-end.  Per-call latency is
// ~1.5s on Claude Opus 4.7 with effort=low.
router.post('/inbox/eval-sentiment', async (req, res) => {
  const phones = Array.isArray(req.body && req.body.phones) ? req.body.phones : [];
  if (phones.length === 0) return res.status(400).json({ error: 'phones array required.' });
  if (phones.length > 20) return res.status(400).json({ error: 'Max 20 phones per request.' });

  const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();
  if (!apiKeyRow || !apiKeyRow.value) {
    return res.status(503).json({ error: 'Anthropic API key not configured.' });
  }

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk').default;
  } catch (e) {
    return res.status(503).json({ error: '@anthropic-ai/sdk not installed.' });
  }
  const client = new Anthropic({ apiKey: apiKeyRow.value });

  // Process at most 5 phones in flight to avoid rate limits.  Batch slicing
  // gives us deterministic ordering of results back to the client.
  const CONCURRENCY = 5;
  const results = [];
  const errors = [];

  async function evalOne(phoneRaw) {
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm) return { phone: phoneRaw, error: 'invalid phone' };
    const messages = loadConversation(phoneNorm);
    if (messages.length === 0) return { phone: phoneNorm, error: 'no inbound messages' };

    // Hard opt-out override BEFORE the AI call.  Saves a token spend and
    // guarantees TCPA-compliant routing even if the model misclassifies.
    let sentiment;
    let reason;
    if (messages.some(m => m.body && OPT_OUT_PATTERNS.test(m.body))) {
      sentiment = 'negative';
      reason = 'Contains opt-out / STOP keyword.';
    } else {
      // Build a compact transcript for the model.  Numbered, single-line.
      const transcript = messages.map((m, i) =>
        (i + 1) + '. ' + (m.body || '').replace(/\s+/g, ' ').trim()
      ).join('\n');

      const systemPrompt =
        'You classify a voter\'s overall stance toward a political campaign based ' +
        'on their text-message replies.  Reply with ONE word from {positive, negative, neutral} ' +
        'and a one-sentence reason.\n\n' +
        '- positive: voter expresses support, will vote, thanks, agreement, asks how/where to vote\n' +
        '- negative: voter opposes, asks to stop, hostile, refusing, sarcastic\n' +
        '- neutral: questions only, info-only, ambiguous, mixed signals\n\n' +
        'If the voter sent any STOP/UNSUBSCRIBE keyword, classify as negative.';

      const userPrompt =
        'Voter replies (chronological):\n' + transcript +
        '\n\nClassify the voter\'s overall stance.';

      try {
        // claude-opus-4-7 with effort=low + structured JSON output.  No
        // thinking (single-word classification — over-thinking burns tokens
        // for no quality gain).  max_tokens=200 is plenty for a one-line
        // reason + the sentiment field.
        const response = await client.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          output_config: {
            effort: 'low',
            format: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: {
                  sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                  reason: { type: 'string' }
                },
                required: ['sentiment', 'reason'],
                additionalProperties: false
              }
            }
          }
        });

        // Parse the structured-outputs response.  Per the SDK, when
        // output_config.format is set, the first text block contains the
        // JSON-validated string.  Defense-in-depth: try .parsed_output if
        // present (newer SDKs), else fall back to JSON.parse on the text.
        let parsed = null;
        if (response.parsed_output) {
          parsed = response.parsed_output;
        } else if (response.content && response.content[0] && response.content[0].text) {
          try { parsed = JSON.parse(response.content[0].text); } catch (e) { /* keep null */ }
        }
        if (!parsed || !parsed.sentiment) {
          throw new Error('AI returned no parseable classification.');
        }
        sentiment = parsed.sentiment;
        reason = (parsed.reason || '').slice(0, 500);
      } catch (err) {
        // On AI failure, store fallback so we don't infinite-retry.  Mark
        // the failure in the reason field for diagnostic visibility.
        sentiment = fallbackHolistic(messages);
        reason = '[fallback — AI error: ' + (err.message || 'unknown').slice(0, 200) + ']';
      }
    }

    // Upsert.  ON CONFLICT replaces existing row (newer eval wins).
    const lastId = messages[messages.length - 1].id;
    db.prepare(`
      INSERT INTO phone_holistic_sentiment
        (phone_norm, sentiment, reason, evaluated_at, last_message_id, message_count)
      VALUES (?, ?, ?, datetime('now'), ?, ?)
      ON CONFLICT(phone_norm) DO UPDATE SET
        sentiment = excluded.sentiment,
        reason = excluded.reason,
        evaluated_at = excluded.evaluated_at,
        last_message_id = excluded.last_message_id,
        message_count = excluded.message_count
    `).run(phoneNorm, sentiment, reason, lastId, messages.length);

    return { phone: phoneNorm, sentiment, reason, message_count: messages.length, last_message_id: lastId };
  }

  // Concurrency-capped batch.  Slices the input into chunks and runs each
  // chunk via Promise.all, sequentially across chunks.
  for (let i = 0; i < phones.length; i += CONCURRENCY) {
    const chunk = phones.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(evalOne));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === 'fulfilled') {
        if (s.value.error) errors.push({ phone: chunk[j], error: s.value.error });
        else results.push(s.value);
      } else {
        errors.push({ phone: chunk[j], error: (s.reason && s.reason.message) || 'unknown' });
      }
    }
  }

  res.json({ updated: results, errors });
});

module.exports = router;
