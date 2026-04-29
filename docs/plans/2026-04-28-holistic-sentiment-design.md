# Holistic AI Sentiment per Phone — Design

**Date:** 2026-04-28
**Approved by:** Luis (picked "B — AI holistic" over rule-based aggregation)

## Goal

When the inbox filter is **Positive** or **Negative**, group messages by phone (one row per phone) and show ONE holistic sentiment per phone — computed by feeding the entire conversation to Claude — instead of one badge per message. This eliminates the noise where a phone with mixed messages appears under both filters.

## The AI call

For each phone with inbound messages, call Claude with the full conversation and ask for one classification.

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-4-7` | Per the claude-api skill default |
| `output_config.effort` | `"low"` | Sentiment classification is a simple task; `low` is the right tier for sub-agent-style work |
| `thinking` | `{type: "disabled"}` | Single-word classification — no thinking needed |
| `max_tokens` | 200 | Tiny output |
| Output format | JSON schema (`output_config.format`) | Guaranteed parseable, no string manipulation |

Schema:
```json
{
  "type": "object",
  "properties": {
    "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] },
    "reason":    { "type": "string", "description": "≤ 1 sentence explanation" }
  },
  "required": ["sentiment", "reason"],
  "additionalProperties": false
}
```

Hard rule baked into the system prompt: any STOP / UNSUBSCRIBE / opt-out keyword in the conversation → `negative`, regardless of friendly preceding messages.

## Storage — `phone_holistic_sentiment` table

```sql
CREATE TABLE IF NOT EXISTS phone_holistic_sentiment (
  phone_norm TEXT PRIMARY KEY,         -- last 10 digits, normalized
  sentiment TEXT NOT NULL,             -- 'positive' | 'negative' | 'neutral'
  reason TEXT,                         -- short explanation from the model
  evaluated_at TEXT DEFAULT (datetime('now')),
  last_message_id INTEGER,             -- latest inbound message id at eval time
  message_count INTEGER                -- count of inbound messages at eval time
);
CREATE INDEX IF NOT EXISTS idx_phs_sentiment ON phone_holistic_sentiment(sentiment);
```

A phone is **stale** when it has new inbound messages since `last_message_id`. Stale phones get re-evaluated on demand.

## Endpoints

### `GET /api/inbox/grouped-by-phone?sentiment=positive|negative|all`

Returns one entry per phone with inbound messages, grouped:
```json
{
  "groups": [
    {
      "phone": "9565551234",
      "phone_display": "+19565551234",
      "contact_name": "Maria Lopez",
      "holistic_sentiment": "positive",
      "holistic_reason": "Voter says she'll vote and is bringing friends.",
      "is_stale": false,
      "message_count": 4,
      "latest_at": "2026-04-27T18:43:00Z",
      "messages": [
        { "id": 123, "body": "...", "sentiment": "positive", "timestamp": "..." },
        ...
      ]
    },
    ...
  ],
  "pending_eval": ["9565555678", "9565559876"]   // phones with no cached holistic
}
```

When filtered to `sentiment=positive`, only groups whose `holistic_sentiment === 'positive'` are returned. For phones with no cache yet, fallback to a "latest message wins + STOP-override" rule and include them in `pending_eval` so the client can trigger evaluation.

### `POST /api/inbox/eval-sentiment`

Body: `{ phones: ["9565551234", ...] }` (max 20 per call).
For each phone: load its inbound messages, call Claude, upsert into `phone_holistic_sentiment`. Returns updated rows.

Concurrency cap on the server side (5 parallel calls) to avoid rate limits. Skipped if a phone has no inbound messages or its cache is current.

## UI flow

1. User clicks **Positive** or **Negative** filter on inbox All Messages.
2. Frontend calls `/api/inbox/grouped-by-phone?sentiment=...`.
3. Renders one row per phone (grouped — not message-by-message). Holistic badge at the top, stack of all messages below with their original per-message badges.
4. If `pending_eval` is non-empty, a small **"⚙ Evaluating N conversations…"** indicator appears, and the frontend POSTs to `/eval-sentiment` in batches of 10. As batches return, it re-fetches the grouped view to show updated tags.
5. A **"🔄 Refresh AI sentiment"** button next to the filter buttons forces re-evaluation of all phones in the current filter (sets cache to stale).

## Cost (rough)

- 500 phones × ~600 input tokens (avg conversation) × $5/1M = **$1.50 per full backfill**
- Output: ~50 tokens × $25/1M × 500 = **$0.63**
- **Total ≈ $2 per full campaign backfill.** Subsequent evals only re-run for stale phones (those with new messages), so day-to-day cost is pennies.

## Why Opus 4.7 over Haiku

The codebase already uses Haiku elsewhere (`routes/ai.js` reply suggestion). For this endpoint I'm using Opus 4.7 per the claude-api skill default — cost is trivial at this scale (~$2 per backfill), and Opus 4.7's better grasp of conversational context helps with edge cases (sarcasm, mixed signals, "yes but…" patterns). With `effort: "low"` we're not paying full Opus pricing on thinking.

## Out of scope

- Bulk export of holistic-positive voters as a list (separate feature)
- Refreshing on every new inbound message (would add latency — refresh is opt-in)
- Surfacing the `reason` text in the UI initially (shipped as data, not yet shown)
- Multi-language sentiment (Claude handles Spanish replies natively in our tests)
