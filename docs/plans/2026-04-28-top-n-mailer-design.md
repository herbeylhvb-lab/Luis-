# Top N Mailer Extraction — Design

**Date:** 2026-04-28
**Owner:** Luis Villarreal
**Concrete need:** Source list "Final Final Final" has ~8000 households; only enough budget to mail to 3500. Pick the 3500 households most likely to vote in the May 2026 municipal election.

## Goal

Add a feature that takes any admin list, scores its voters by historical May-election turnout (recency-weighted), aggregates to household, and extracts the top N households into a new child list ready for mailer export.

## Scoring (recency-weighted Mays)

For each voter in the source list, sum points across past Local May elections they voted in:

| Election           | Points |
|--------------------|--------|
| Local May 2025     | 5      |
| Local May 2024     | 4      |
| Local May 2023     | 3      |
| Local May 2022     | 2      |
| Local May ≤ 2021   | 1 each |

Score is computed as a single SQL `SUM(CASE WHEN ... END)` against `election_votes` so it scales to 8K voters in one query.

### Aggregation: voter → household

A household = `(LOWER(TRIM(address)) || '|' || TRIM(city) || '|' || TRIM(zip))`. Household score = **MAX** of any eligible voter's score at that address. ("Best voter at this address" wins.)

### Tie-break order

When many households share the same household score, sort by:
1. `MAX(may_frequency)` of voters at the address — already-computed % of Mays voted
2. Whether the household has at least one voter with a phone (1 vs 0)
3. Number of voters at the address (more = better mailer reach)

## Exclusions (applied BEFORE scoring)

A voter is excluded from the eligibility pool when ANY of these is true:

1. **Habitual VBM voter** — `EXISTS(SELECT 1 FROM election_votes WHERE voter_id = v.id AND LOWER(TRIM(COALESCE(vote_method,''))) IN ('mail','absentee','vbm','mail-in','mail_ballot','mailed'))`
2. **Already mailed in this cycle** — `LOWER(TRIM(COALESCE(v.early_voted_method,''))) IN ('mail','absentee','vbm','mail-in','mail_ballot','mailed')`
3. **Already voted this cycle (any method)** — `v.early_voted = 1`

Filters 1+2 are gated by the "Exclude vote-by-mail voters" checkbox; filter 3 by "Exclude already-voted" checkbox. Both default ON.

A household is dropped when **all** its voters fall into the exclusion set; if some voters at the address are excluded but at least one is not, the household stays and only the eligible voter's score counts.

## UI

On the admin list detail panel (Voter File → Lists/Universes → click any list), add a button next to **"📬 Export for Mailer"**:

> 🎯 Top N Mailer (Best May Voters)

Click → modal:
- N input, default **3500**
- Source list name (read-only label)
- ☑ Exclude vote-by-mail voters
- ☑ Exclude already-voted voters
- **Preview** button → shows totals + score range
- **Save as New List** button → creates child list and closes modal

After save, the new list appears in the lists table; user can click into it and use the existing **📬 Export for Mailer** flow.

## Endpoints

### `POST /api/admin-lists/:id/top-n-mailer/preview`
Body: `{ n, exclude_vbm, exclude_voted }`
Returns:
```json
{
  "source_total_households": 8021,
  "eligible_households": 6870,
  "selected_households": 3500,
  "selected_voters": 5912,
  "top_score": 25,
  "bottom_score_in_cut": 8,
  "excluded_vbm": 412,
  "excluded_already_voted": 739
}
```

### `POST /api/admin-lists/:id/top-n-mailer/save`
Body: `{ n, exclude_vbm, exclude_voted, name }`
Behavior: runs the same query as preview but persists the resulting voter set into a new `admin_lists` row (`list_type='mail'`), then inserts every eligible voter from the selected households into `admin_list_voters`.
Returns: `{ success: true, list_id, list_name, households, voters }`

## Why this design (vs alternatives)

- **Why a child list, not just a CSV download:** Luis wants to see/verify the 3500 before sending. A persisted list also makes the mailer auditable — you can re-export, log the mailer, see who actually voted, etc. The existing **Mailer History** tab works on lists.
- **Why recency-weighted instead of raw count:** Luis picked C — recent May voters are stronger predictors of May 2026 turnout than people who showed up in 2017 once.
- **Why MAX-of-household instead of SUM:** Mailer goes to one address. The strongest voter at the address is what matters; SUM would unfairly favor multi-voter households over a strong single-voter household.

## Out of scope (YAGNI)

- Per-voter "likelihood %" score export — household-level cut is enough for mailer triage.
- Tunable weights in the UI — we ship 5/4/3/2/1 hard-coded; if Luis wants to tweak later we revisit.
- Saving the preview parameters as a "template" for future mailers — one-off use right now.
