# Add "Positive Texters Who Voted" to Confirmed Mine — Design

**Date:** 2026-04-28
**Approved by:** Luis ("add the line how you have the captain and block walk")

## Problem

Confirmed Mine on the GOTV tab currently UNIONs two buckets of voters:
1. Universe voters tagged strong/lean support who voted
2. Captain-list voters under the candidate who voted

Voters who texted back positively but aren't tagged as universe supporters or
captain-list members are invisible — they don't count toward "votes I have"
even though their text says they're supportive.

## Goal

Add a third bucket: voters whose phone sent a positive inbound text and who
voted. UNION it into the existing Confirmed Mine total (auto-deduped against
the other two buckets) and surface a breakdown line in the GOTV UI matching
the existing "From universe" / "From captain lists" pattern.

## Endpoint changes — `/api/gotv/confirmed-mine`

Add one CTE to the existing query:

```sql
positive_texters AS (
  SELECT DISTINCT v.id FROM voters v
  WHERE v.early_voted = 1
    AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(v.phone, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) IN (
      SELECT DISTINCT SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(m.phone, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)
      FROM messages m
      WHERE m.direction = 'inbound' AND m.sentiment = 'positive'
    )
)
```

Then extend the UNION:

```sql
SELECT id FROM universe_supporters
UNION SELECT id FROM captain_voters
UNION SELECT id FROM positive_texters
```

The phone normalization (last 10 digits, strip non-digits) matches the
pattern already used by `/api/messages/pending`, so format drift between
`+19565551234` / `9565551234` / `(956) 555-1234` doesn't break the join.

### Response shape (additive)

```json
{
  "confirmed_mine": 250,                 // grew to include the new bucket
  "universe_supporters_voted": 180,
  "captain_list_voted": 95,
  "positive_texters_voted": 42,          // NEW
  "overlap": 22                          // unchanged 2-way universe∩captain
}
```

`positive_texters` is unconditionally included — even when neither
`universe_id` nor `candidate_id` is selected, the bucket is computed (so
positive-texter signal works as a global GOTV indicator).  When both filters
are absent, the existing endpoint returns zeros for everything; we keep that
behavior — the new field also reports 0 in that case to avoid surprising
"high number with no filter" results.

## UI change

In `loadGotvConfirmedMine` (`public/index.html`), add ONE line after the
existing captain-list line, using the exact same `<div>` template:

```js
breakdown += '<div>📱 From positive texters: <strong style="color:#86efac">'
  + (data.positive_texters_voted || 0).toLocaleString() + '</strong></div>';
```

The line is shown unconditionally (not gated on universe/candidate selection)
because the bucket is always populated when the card is visible.

## Decisions baked in

| Question | Decision | Why |
|---|---|---|
| Sentiment scope | Any inbound message ever marked positive | Simplest; campaign data is for THIS cycle anyway |
| Voter match | Per-voter (every voter row at a positive-texter phone) | Matches how universe/captain buckets count |
| Phone normalization | Last 10 digits (existing pattern) | Format drift safety |
| Candidate scoping | Not scoped (positive texts are global) | Outbound→inbound link not modeled in messages table; YAGNI |
| Time window | None | Current cycle data dominates anyway |
| Sentiment confidence threshold | None — accept the tag as-is | Sentiment already AI-classified at ingest |

## Out of scope

- Per-bucket export of voters
- Excluding phones that later went negative
- Candidate-scoped positive-texter buckets
- 3-way overlap reporting (UNION handles dedup; the existing 2-way `overlap`
  number stays as-is for backward compatibility)
