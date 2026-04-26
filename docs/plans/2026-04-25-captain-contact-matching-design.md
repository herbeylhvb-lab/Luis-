# Captain Contact Matching & In-App Texting — Design

**Date:** 2026-04-25
**Author:** Luis Villarreal (with Claude)
**Status:** Approved, ready for implementation plan

## Problem

Block captains have voters' real cell numbers stored in their iPhone's Contacts app. The campaign's voter file (from the county) is missing or has outdated phone numbers for many of those same voters. We need a way for captains to:

1. Pull contacts off their iPhone.
2. Match those contacts against existing voter records.
3. Update the voter records' phone numbers with the captain's data.
4. Text those voters from the captain's personal phone number, in-app.

New voters are NEVER created from contacts — the voter file is the source of truth for who exists. This is an *enrichment* workflow.

## Goals & Non-Goals

**Goals**
- Update phone numbers on existing voter records using captain's contacts.
- Captain manually confirms each match (no auto-update).
- Smooth iPhone-native experience eventually (no app-switching for texting).
- Validate matching algorithm against real voter data before paying for native distribution.

**Non-Goals**
- Creating new voter records from contacts.
- Silent / unattended SMS sending (Apple forbids it).
- Texting from a campaign-owned number for this feature (existing `routes/p2p.js` covers that case separately).
- Cross-platform native (Android out of scope for now; iOS-first).

## Approach: Web first, then wrap in native

Two phases, same codebase:

**Phase 1 — Web (browser-only, ~2 days)**
- Captain uploads contacts as vCard or CSV from their phone.
- Matching API + picker UI built in `captain.html`.
- Texting button uses the existing `sms:` URL scheme (launches iPhone Messages app — works but leaves the app on web).
- Allows iterating on the matching algorithm against real voter data with seconds-per-iteration cycles.

**Phase 2 — Capacitor wrapper + TestFlight (~1 day after Phase 1)**
- Wrap unchanged web app in [Capacitor](https://capacitorjs.com).
- Add `@capacitor-community/contacts` plugin for native iPhone Contact Picker.
- Add `@capacitor-community/sms` plugin so texting opens iOS message sheet *over* the app (native `MFMessageComposeViewController`) — captain's personal number, no app switch.
- Distribute via TestFlight (Apple Developer Program, $99/yr).
- One runtime branch in JS: `if (Capacitor.isNativePlatform()) { useNative() } else { useWebFallback() }` — same matching code on both sides.

Phase 2 is **not optional** and not deferred — it is the second half of the same project, scheduled immediately after Phase 1 is verified.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  captain.html  (existing file, +Match Contacts) │
└────────────────┬─────────────────────────────────┘
                 │ JSON over fetch()
                 ▼
┌──────────────────────────────────────────────────┐
│  routes/captain-contacts.js  (NEW)               │
│  POST /api/captain/match-candidates              │
│  POST /api/captain/confirm-match                 │
└────────────────┬─────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────┐
│  voters table  (existing schema, NO changes)     │
│  uses idx_voters_name (last_name, first_name)    │
└──────────────────────────────────────────────────┘
```

**Files added in Phase 1:**
- `routes/captain-contacts.js` — two endpoints
- `utils/nicknames.js` — nickname dictionary (~30 starter entries, expandable)
- `utils.js` — add `levenshtein()` and `nameDistance()` helpers
- `tests/test-captain-match.js` — integration tests

**Files modified in Phase 1:**
- `server.js` — register the new router (one line)
- `public/captain.html` — add "Match from My Contacts" wizard section

**Files added in Phase 2:**
- `capacitor.config.ts` — Capacitor configuration
- `ios/` — Xcode project (generated)
- (No new server-side code; all changes are JS wrapper logic in `captain.html`)

## Matching algorithm

For each contact, the server runs:

**Step 1 — SQL pre-filter** (narrow the candidate set)
```sql
SELECT id, first_name, last_name, age, gender, address, city, zip,
       phone, phone_validated_at
FROM voters
WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)   -- same starting letter
  AND age BETWEEN ? AND ?                         -- age ± 5 years
  AND id IN (SELECT voter_id FROM captain_list_voters
             WHERE captain_id = ?)
LIMIT 100;
```

If 0 results → re-query without the `captain_list_voters` filter (broader scope = whole voter file).

**Step 2 — Score each candidate in Node.js**
```
lastNameScore = 1 - levenshtein(contact.lastName, voter.last_name) / max(lengths)
firstNameScore = max(
  1 - levenshtein(contact.firstName, voter.first_name) / max(lengths),
  isNicknameOf(contact.firstName, voter.first_name) ? 1.0 : 0
)
ageGap = abs(contact.age - voter.age)
ageScore = max(0, 1 - ageGap / 10)

total = 0.5 * lastNameScore + 0.3 * firstNameScore + 0.2 * ageScore
```

**Step 3 — Return top 5** with `score >= 0.4`, sorted descending.

### Defaults (committed)

| Decision | Value | Rationale |
|---|---|---|
| Age tolerance | ±5 years | Captain estimates by appearance; covers normal error |
| Score cutoff | ≥ 0.4 | Below this is noise |
| Scoring weights | 0.5 last / 0.3 first / 0.2 age | Last name is the most reliable signal in voter files |
| Scope | Captain's list first; broader if 0 hits | Reduces false matches, matches real workflow |
| Nickname dict | ~30 common English nicknames at launch | Easy to grow per district |
| Candidates per page | 5 | Fits one mobile screen without scrolling |

## API endpoints

```
POST /api/captain/match-candidates
  auth:    captain session (existing middleware)
  body:    { firstName: string, lastName: string, age: number }
  returns: {
    candidates: [{voterId, firstName, lastName, age, address, city,
                  currentPhone, score}],
    scope: 'list' | 'broader'
  }

POST /api/captain/confirm-match
  auth:    captain session
  body:    { voterId: number, phone: string }
  action:  UPDATE voters
           SET phone = ?, phone_validated_at = datetime('now'),
               phone_type = 'mobile'
           WHERE id = ?
  returns: { success: true, voterId, phone }
```

Both endpoints respect the **"captains unrestricted"** rule — no list-membership checks block a captain from updating any voter.

## UI flow (in `captain.html`)

New wizard, opened by a **"📱 Match from My Contacts"** button on the captain dashboard:

1. **Pick source.**
   - Phase 1: file picker (vCard or CSV).
   - Phase 2: native iPhone Contact picker via Capacitor.
2. **Per-contact card.** Shows contact name + phone. Captain types **age** (numeric, required). Tap **Find Matches**.
3. **Top 5 candidate list.** Each row: name, age, address, current phone (if any).
   - Tap a row → confirm dialog → server update.
   - **"Show more"** → next 5 candidates.
   - **"Skip — not in voter file"**.
4. **Per-contact action menu (after confirmed match).** Three buttons:
   - ✅ **Done** (move to next)
   - 📱 **Text now**
     - Phase 1: existing `sms:` URL → launches Messages app
     - Phase 2: native `MFMessageComposeViewController` → in-app sheet
   - ➡️ **Next contact**
5. **End screen.** "✅ N matched, M skipped." Counts persisted to localStorage so captain can resume mid-flow.

## Error handling

| Scenario | Behavior |
|---|---|
| 0 candidates returned | "No matches" message + "Search broader" / "Skip" buttons |
| Network error mid-confirm | Retry button; optimistic UI rolled back |
| Phone in DB already matches contact | Show "no change needed"; don't bump `phone_validated_at` |
| Two captains updating same voter at once | Last-write-wins (acceptable; `phone_validated_at` provides audit) |
| Captain enters invalid age (e.g. blank, negative) | Validation in UI; server also rejects with 400 |
| vCard upload malformed | Parse what we can; surface errors per-contact, don't fail whole batch |

## Testing

- **Unit:** `levenshtein()`, `isNicknameOf()`, `scoreCandidate()` — pure functions, easy to test.
- **Integration:** `tests/test-captain-match.js` seeds 5 voters with known names/ages, runs match against 3 fake contacts, asserts top-1 candidate is the intended one.
- **Manual Phase 1:** upload a sample vCard from a real iPhone export, walk the captain wizard end-to-end in a browser.
- **Manual Phase 2:** install TestFlight build on iPhone; verify native picker, native message sheet, return-to-app flow.

## Texting strategy summary

| Phase | Texting button behavior | From which number |
|---|---|---|
| Phase 1 (web) | Launches iPhone Messages app (existing `sms:` URL) | Captain's personal |
| Phase 2 (native) | iOS message sheet appears OVER the app, captain taps Send, returns to app instantly | Captain's personal |

Apple does not allow ANY app — native or web — to silently send SMS from the user's personal number. Phase 2 delivers the smoothest possible UX within Apple's policy.

## Out of scope (deferred)

- Android wrapper (Capacitor supports it; not in this project).
- Server-side SMS via campaign number for this feature (already exists in `routes/p2p.js` for other workflows).
- Bulk-confirm UI ("auto-confirm all matches with score > 0.9 in one tap").
- Importing a contact's *email* into voter records.
- District-specific nickname additions beyond the starter ~30 entries — the captain can add them by editing `utils/nicknames.js`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Apple rejects TestFlight build | Phase 1 still works as web app; matching value already delivered |
| Matching algorithm misses too many real matches | Web phase lets us tune fast; nickname dict is easily expanded |
| Captain enters wrong age and matches the wrong voter | Manual confirm step requires captain to look at name + address — wrong voter is visible before commit |
| Captain spams voters by accident | Each text requires a Send tap (Apple rule); no bulk silent send is possible |
| Cost: $99/yr Apple Developer Program | Confirmed acceptable by user |
