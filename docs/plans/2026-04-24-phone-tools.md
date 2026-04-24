# Phone Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship tap-to-call and phone-editing features for the captain portal in one release.

**Architecture:** Reuses existing patterns: voter_contacts as universal touchpoint log, settings table for the shared admin password, requireCaptainAuth middleware for captain-owned endpoints, session flags for password-unlock state. No new DB tables or columns. Frontend uses existing modal + DOM-building patterns already in captain.html and index.html.

**Tech Stack:** Node.js, Express, better-sqlite3, vanilla JS frontend. No build step.

**Design Doc:** docs/plans/2026-04-24-phone-tools-design.md (committed as 58ede90).

**Verification approach:** No formal test framework. Each task verifies via `node --check` for server JS and the inline script-block parser for HTML. Manual smoke test at the end. Commits are granular for easy reverts.

---

## Task 1: Seed the phone-update password setting

**File:** `db.js` (near the other `INSERT OR IGNORE INTO settings` rows around line 1565-1570)

**Step 1:** Add after the `max_walkers_migrated` block:

```
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('phone_update_password', 'CHANGE_ME')").run();
} catch(e) {}
```

**Step 2:** `node --check db.js` — expect no output.

**Step 3:**
```
git add db.js
git commit -m "Phone tools: seed phone_update_password setting"
```

---

## Task 2: phone-log endpoint (tap-to-call logging)

**Files:** `routes/captains.js`, `server.js`

**Step 1:** In `routes/captains.js`, immediately after the `text-log` route (~line 1095), add a new endpoint that mirrors text-log's voter-ownership check. The endpoint is `POST /captains/:id/phone-log`, takes `{ voter_id, phone_called }`, requires `requireCaptainAuth`, validates voter is on a list the captain or their team can see, then inserts into voter_contacts with `contact_type='Call'`, `result='dialed'`, notes set to the called number.

**Step 2:** In `server.js`, add to the captain whitelist (around line 236):

```
req.path.match(/^\/api\/captains\/\d+\/phone-log$/) ||
```

**Step 3:** `node --check routes/captains.js && node --check server.js`

**Step 4:**
```
git add routes/captains.js server.js
git commit -m "Phone tools: phone-log endpoint"
```

---

## Task 3: phone-edit-auth endpoint (password unlock)

**Files:** `routes/captains.js`, `server.js`

**Step 1:** At the top of `routes/captains.js`, near the `captainLoginLimiter`, add a second rate limiter `phoneEditAuthLimiter`: 10 attempts per 15 min per captain, keyed on session captainId (fallback IP).

**Step 2:** Add `POST /captains/:id/phone-edit-auth` endpoint that takes `{ password }`, reads current value from `settings.phone_update_password`, compares, on match sets `req.session.phoneEditUnlocked = true` and `req.session.phonePasswordAtAuth = current`. Rejects if current is `CHANGE_ME` (admin must set a real password first).

**Step 3:** Add to server.js whitelist:
```
req.path.match(/^\/api\/captains\/\d+\/phone-edit-auth$/) ||
```

**Step 4:** `node --check routes/captains.js && node --check server.js`

**Step 5:**
```
git add routes/captains.js server.js
git commit -m "Phone tools: phone-edit-auth endpoint + rate limiter"
```

---

## Task 4: update-phone and erase-phone endpoints (with auto-promote)

**Files:** `routes/captains.js`, `server.js`

**Step 1:** Add a helper `requirePhoneEditUnlocked(req, res, next)` that checks `req.session.phoneEditUnlocked` AND that `req.session.phonePasswordAtAuth` matches the current `settings.phone_update_password` value. If password rotated since auth, clears the session flags and returns 401 with `code: 'PASSWORD_CHANGED'`. If not unlocked at all, returns 401 with `code: 'PASSWORD_REQUIRED'`.

**Step 2:** Add `canCaptainSeeVoter(captainId, voterId)` helper that returns true if voter is on any list in the captain's team tree (same recursive CTE as in text-log). Reuse by all phone endpoints.

**Step 3:** Add a `PHONE_SLOTS` map: `{ primary: 'phone', secondary: 'secondary_phone', tertiary: 'tertiary_phone' }`.

**Step 4:** Add `POST /captains/:id/update-phone`, taking `{ voter_id, slot, new_phone }`. Validates slot is valid, new_phone has 10+ digits, captain can see voter. Inside a transaction: read old value from the slot's column, write new digits-only value, insert voter_contacts row with `contact_type='PhoneUpdate'`, `result='replaced'`, notes showing slot + old + new.

**Step 5:** Add `POST /captains/:id/erase-phone`, taking `{ voter_id, slot }`. Inside a transaction: if slot is primary AND secondary exists, promote secondary to primary and tertiary to secondary, log both the erase and the promote as two voter_contacts rows. Otherwise just clear that slot's column and log the erase.

**Step 6:** Whitelist both in server.js:
```
req.path.match(/^\/api\/captains\/\d+\/update-phone$/) ||
req.path.match(/^\/api\/captains\/\d+\/erase-phone$/) ||
```

**Step 7:** `node --check routes/captains.js && node --check server.js`

**Step 8:**
```
git add routes/captains.js server.js
git commit -m "Phone tools: update-phone + erase-phone with auto-promote"
```

---

## Task 5: Admin endpoints (password CRUD, recent changes, revert)

**File:** `routes/captains.js`

**Step 1:** Add `requireAdmin(req, res, next)` helper: 401 if no `req.session.userId`.

**Step 2:** Add these admin endpoints (all require requireAdmin):
- `GET /admin/phone-update-password` — returns `{ password }` from settings
- `PUT /admin/phone-update-password` — takes `{ password }`, validates length >= 4, upserts into settings
- `POST /admin/phone-update-password/rotate` — calls `generateAlphaCode(6)` from utils, saves to settings, returns `{ password }`
- `GET /admin/phone-changes?days=30` — returns last N days of `voter_contacts` rows with `contact_type='PhoneUpdate'`, joined on voters for name, LIMIT 500
- `POST /admin/phone-changes/:audit_id/revert` — reads the audit row, parses slot from notes, parses old value, writes old back into the voter's slot, inserts a new `result='reverted'` audit row

**Step 3:** `node --check routes/captains.js`

**Step 4:**
```
git add routes/captains.js
git commit -m "Phone tools: admin endpoints for password + recent-changes + revert"
```

---

## Task 6: Tap-to-call phone icon on voter list rows

**File:** `public/captain.html`

**Step 1:** Find the voter-row rendering code (search for makeVoterRow or where voter rows are built — around line 2300-2450).

**Step 2:** Add a `.phone-call-btn` button element to each row. If the voter has a 10+ digit primary phone, render a green 📞 button. If not, render a greyed-out disabled version.

**Step 3:** The click handler does two things: (1) fire-and-forget POST to `/api/captains/:id/phone-log` with `voter_id` and `phone_called` (digits only), (2) navigate to `tel:+1` + digits. Use `ev.stopPropagation()` so tapping the icon doesn't also open the voter card.

**Step 4:** Validate JS parses clean using the inline script-block parser.

**Step 5:**
```
git add public/captain.html
git commit -m "Phone tools: tap-to-call icon on voter rows"
```

---

## Task 7: Show all 3 phone slots on voter detail card

**File:** `public/captain.html`

**Step 1:** Find the voter detail card section (search for where `voter.phone` is rendered on the card, likely around line 2450-2600).

**Step 2:** Replace the single-phone display with a function `renderPhoneSlot(voter, slot, label)` that returns a tappable `<div>` showing the label (Primary/Secondary/Tertiary), the number, and the phone type. Returns null if that slot is empty.

**Step 3:** Build a container that iterates over all 3 slots. If all are empty, show "(No phone numbers on file)".

**Step 4:** Each phone row's click handler calls `showPhoneActionMenu(voter, slot, phoneValue)` (to be defined in Task 8).

**Step 5:** Validate JS parses clean.

**Step 6:**
```
git add public/captain.html
git commit -m "Phone tools: show all 3 phone slots on voter detail card"
```

---

## Task 8: Action menu + password unlock + update/erase modals

**File:** `public/captain.html`

**Step 1:** Near the other state vars (line ~2800), add:
```
var _phoneEditUnlocked = false;
```

**Step 2:** Add four new functions at the bottom of the script, before the closing `</script>`:

**`showPhoneActionMenu(voter, slot, phoneValue)`** — renders an overlay with three buttons: Call (opens tel: + logs), Update (calls `requirePhoneEditUnlocked` then `showUpdatePhoneModal`), Mark as No Longer Valid (calls `requirePhoneEditUnlocked` then `confirmErasePhone`).

**`requirePhoneEditUnlocked(callback)`** — if `_phoneEditUnlocked` is already true, calls `callback()`. Otherwise renders a password prompt overlay. On submit, POSTs to `/api/captains/:id/phone-edit-auth`. On 200, sets `_phoneEditUnlocked = true` and calls callback. On error, shows message in the overlay.

**`showUpdatePhoneModal(voter, slot, oldValue)`** — renders a modal showing the old number read-only and an input for the new number. On save, POSTs to `/api/captains/:id/update-phone`. On success, reload the voter list. On `PASSWORD_CHANGED` error, clear `_phoneEditUnlocked` and re-prompt.

**`confirmErasePhone(voter, slot, oldValue)`** — uses `confirm()` with a message that explains auto-promote if primary is being erased. On OK, POSTs to `/api/captains/:id/erase-phone`. Same PASSWORD_CHANGED handling as update.

**Step 3:** Validate JS parses clean.

**Step 4:**
```
git add public/captain.html
git commit -m "Phone tools: action menu + password unlock + update/erase modals"
```

---

## Task 9: Admin UI — password tile + Recent Phone Changes panel

**File:** `public/index.html`

**Step 1:** Find an appropriate spot in the admin settings section. Add a Phone Tools block with two parts:

Part A: Password display with a readonly input showing current password, a Change button (prompts for new value), and a Generate New button (calls rotate endpoint, shows the generated code in an alert for admin to copy).

Part B: Recent Phone Changes list — a scrollable container that lists the last 30 days of phone changes. Each row shows voter name, result (REPLACED/ERASED/PROMOTED/REVERTED), notes, captain, timestamp. For `replaced` and `erased` rows, include a Revert button.

**Step 2:** Add JS helpers:
- `loadPhoneUpdatePassword()` — GETs current password, fills the readonly field
- `changePhoneUpdatePassword()` — `prompt()` for new value, PUT, reload
- `rotatePhoneUpdatePassword()` — confirm, POST to rotate, show new password in alert
- `loadRecentPhoneChanges()` — GET /admin/phone-changes, renders rows
- Each Revert button confirms, POSTs to revert endpoint, reloads the list

**Step 3:** Call `loadPhoneUpdatePassword()` and `loadRecentPhoneChanges()` on page load when the section is present.

**Step 4:** Validate JS parses clean for index.html.

**Step 5:**
```
git add public/index.html
git commit -m "Phone tools: admin password tile + Recent Phone Changes panel"
```

---

## Task 10: End-to-end verification + push

**Step 1:** Final syntax sweep:
```
node --check server.js && node --check routes/captains.js && node --check db.js
```

**Step 2:** Inline script-block check on both HTML files — expect 0 errors.

**Step 3:** Push:
```
git push origin main && git push campaigntext main
```

**Step 4:** After Railway redeploys (~1-2 min), manual smoke test:

1. Admin portal: Phone Tools section appears. Click "Generate New" → copy password.
2. Captain portal (new browser): select a list with voters. 📞 icons appear on rows.
3. Tap a 📞 icon on desktop — tel: fires but nothing happens in browser; check Network tab for /phone-log request.
4. Tap a voter row → card opens → all 3 phones visible (if populated).
5. Tap a phone number → action menu shows.
6. Tap Update → password prompt → enter code → new number form.
7. Save new number → card reloads with new value.
8. Back in admin → refresh Recent Phone Changes → see the update.
9. Click Revert on that entry → voter's phone restored to old.
10. Admin: click Change Password → set a new one.
11. Captain tries to edit another phone → gets prompted for new password (old session-unlock is now invalid).

**Step 5:** If all passes: share password with trusted captains. Done.

---

## Rollout Checklist

- Design doc committed (already done: `58ede90`)
- All 10 tasks committed individually
- Both remotes pushed
- Railway deployed
- Admin set real password (not `CHANGE_ME`)
- One end-to-end smoke test passed
- Password shared with trusted captains
