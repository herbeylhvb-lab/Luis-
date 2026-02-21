# Voter Data Enrichment — Design

## Problem

Voter registration rolls provide names, addresses, party, voting history, and voter IDs — but no phone numbers or emails. Campaigns purchase supplemental data lists that include phone numbers matched to voter IDs. This feature imports purchased lists and merges phone data into existing voter records.

## Requirements

- Upload a purchased CSV containing voter ID, name, address, and phone
- Match rows to existing voters by voter ID first, then name + address fallback
- Auto-fill blank phone fields on matched voters
- Flag conflicts (voter already has a different phone) for manual review
- Display unmatched rows for informational purposes
- UI lives inside the existing Voter File tab

## Approach: Two-Phase Upload

**Phase 1 — Upload & Match:** Single CSV upload, backend matches each row against existing voters and returns results in 3 buckets.

**Phase 2 — Review:** User sees auto-filled count, resolves phone conflicts via radio buttons, and reviews unmatched records.

No new dependencies. No background jobs. Synchronous processing (sufficient for campaign-scale lists of hundreds to low thousands of rows).

---

## Backend — `routes/voters.js`

### `POST /api/voters/enrich`

**Request:** `{ rows: [...] }`

Each row: `{ voter_id, first_name, last_name, phone, address, city, zip, email }`

**Matching algorithm (per row, single transaction):**

1. **Voter ID match** — `WHERE registration_number = ?`
2. **Name + Address fallback** — `LOWER(first_name) = ? AND LOWER(last_name) = ?` + `address LIKE first3words%`

**Per matched voter:**

| Scenario | Action | Bucket |
|----------|--------|--------|
| Voter has no phone | Set phone from purchased list | `filled` |
| Voter has same phone | No change | `skipped` |
| Voter has different phone | Don't overwrite | `conflicts` |

**Response:**
```json
{
  "success": true,
  "total": 500,
  "filled": 312,
  "conflicts": [
    { "voter_id": 42, "name": "Luis V", "current_phone": "+15125551111", "new_phone": "+15125552222" }
  ],
  "skipped": 88,
  "unmatched": [
    { "first_name": "New", "last_name": "Person", "phone": "5125559999", "address": "456 Oak" }
  ],
  "match_details": { "by_voter_id": 350, "by_name_address": 50 }
}
```

### `POST /api/voters/enrich/resolve`

**Request:** `{ resolutions: [{ voter_id: 42, phone: "+15125552222" }, ...] }`

Bulk-updates the chosen phone for each conflict voter.

---

## Frontend — `public/index.html`

### UI Components

**"Enrich Data" button** — green/emerald style, in Voter File header next to existing import buttons.

**`enrichDataCard`** — three-step card:

- **Step 1 — Upload:** File input + textarea fallback + "Preview & Match" button
- **Step 2 — Column Mapping:** Auto-detected dropdowns + first 5 rows preview + "Run Enrichment" button
- **Step 3 — Results:**
  - Summary bar (filled / skipped / conflicts / unmatched counts)
  - Conflicts table with radio buttons to pick current vs new phone + "Apply Selected" button
  - Unmatched table (display-only, informational)

### JavaScript

- `ENRICH_COLUMN_MAP` — ~30 common header mappings (VAN, L2, TargetSmart)
- `previewEnrichment()` — parse CSV, auto-map columns, render preview
- `executeEnrichment()` — POST mapped rows, render results
- `resolveConflicts()` — collect radio selections, POST to resolve endpoint
- `closeEnrichment()` / `showEnrichStep(n)` — navigation helpers
- Reuses `parseCanvassCsvLine()` (quote-aware CSV parser) from canvass import

---

## Files to Modify

| File | Changes |
|------|---------|
| `routes/voters.js` | Add `POST /api/voters/enrich` + `POST /api/voters/enrich/resolve` |
| `public/index.html` | "Enrich Data" button + 3-step card UI + JS functions |

No changes to `server.js`, `db.js`, or `package.json`.
