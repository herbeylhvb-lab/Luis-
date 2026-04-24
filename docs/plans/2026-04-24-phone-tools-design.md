# Phone Tools — Design Doc

**Date:** 2026-04-24
**Status:** Approved, ready for implementation
**Author:** Brainstormed with Luis

## Purpose

Two lightweight additions to the captain portal, shipped together as one release:

1. **Tap-to-call**: one-tap phone icon on every voter row in the captain list. Launches the iPhone native dialer with the voter's primary phone number. Logs the call attempt.
2. **Phone editing**: captains can update or erase any of a voter's 3 phone numbers, gated by a shared admin-controlled password. Old numbers are retired to an audit log, never hard-deleted.

This is deliberately scoped small. A structured phone-bank flow (call queue, scripts, support-level outcome scoring, callbacks) is explicitly deferred.

## Motivation

- Current voter phone data is unreliable. Captains calling voters discover wrong / disconnected numbers regularly. Today there's no way for a captain to fix the record — they can only add a note.
- Captains also want a faster way to dial voters than opening each voter's detail card. A one-tap call from the list row compresses the "see voter → dial" loop to a single gesture.
- A shared password for edits (not a per-captain trust tier) gives Luis a single lever he can rotate whenever trust shifts. Simpler than per-captain permissions, stronger than a wide-open edit.

## Non-goals

- Full phone-bank queue mode (one voter at a time, step-through)
- Per-candidate phone scripts with placeholder substitution
- Outcome buttons during calls (Strong Support / Lean Yes / etc.)
- Callback scheduler with specific-time reminders
- Native iOS app (keep the web + tel: URL approach)
- Automatic contact-matching against the captain's iPhone Contacts (impossible in a web app)

All of the above can be added later if needed.

## User Flows

### Flow 1: Tap-to-call from the list

1. Captain opens their voter list
2. Each voter row shows a 📞 icon on the right (next to the existing 💬 message/text indicator)
3. Captain taps the 📞 icon
4. iPhone native dialer opens pre-filled with the voter's **primary** number
5. Call happens via the captain's own carrier
6. Server logs one `voter_contacts` row: `contact_type='Call'`, `result='dialed'`, `contacted_by='Captain #N'`
7. Next time anyone sees this voter, a "📞 Called 2d ago" badge is visible

Icon is greyed-out / disabled when the voter has no primary phone.

### Flow 2: Phone edit via voter detail card

1. Captain taps the voter's name/row (not the 📞 icon) → voter detail card opens
2. Card shows all 3 phone numbers (primary, secondary, tertiary) with type labels, each individually tappable
3. Captain taps one of the phone numbers → action menu appears:
   - **📱 Call This Number** — no password, opens tel:
   - **✏️ Update to a New Number** — password-gated
   - **❌ Mark as No Longer Valid** — password-gated
4. If captain picks an edit action:
   - First edit in session → password prompt
   - Correct password → server sets `req.session.phoneEditUnlocked = true`
   - Wrong password → error, captain can retry (rate-limited 10/15min per captain)
   - Subsequent edits in same session skip the prompt
5. **Update flow**: prompts for new number, validates digit count, writes to `voters.{phone|secondary_phone|tertiary_phone}` depending on slot, retires old number to `voter_contacts` audit row
6. **Mark as No Longer Valid flow**: confirms intent, erases the slot, retires old number to audit row
7. **Auto-promotion**: if the primary slot was erased and a secondary exists, secondary is promoted to primary (and tertiary to secondary if present). This keeps the voter callable/textable automatically.
8. Card re-renders showing the updated phone layout

### Flow 3: Admin manages the password

1. Admin opens admin settings
2. New tile: **"📞 Phone Update Password"** showing the current password
3. Buttons: **[Change Password]** (manual entry) or **[Generate New Random]** (6-char alphanumeric)
4. Rotating instantly invalidates all unlocked captain sessions — everyone who had the old password must re-enter the new one

### Flow 4: Admin reviews changes

1. Admin opens new panel: **"📞 Recent Phone Changes"**
2. Lists last 30 days of phone updates, each showing: voter name, slot, old → new number, captain name, timestamp
3. Each row has a **[Revert]** button. Clicking it:
   - Restores the old number from the audit row to the voter's active slot
   - Writes a new audit row documenting the revert

## Security Model

- **Authentication**: captain login already enforces session ownership. `requireCaptainAuth` middleware already validates `:id` in path matches `req.session.captainId`.
- **Authorization for phone edits**: additional layer — captain's session must have `phoneEditUnlocked = true` AND `phonePasswordAtAuth` must equal the current `phone_update_password` setting. If the admin rotates the password, `phonePasswordAtAuth` is stale → captain is forced to re-authenticate.
- **Rate limit**: 10 password attempts per 15 minutes per captain, to prevent brute-force.
- **Audit attribution**: every edit, erase, promote, and revert writes to `voter_contacts` with `contacted_by = 'Captain #N'` (or `'Admin'` for reverts). Nothing is hard-deleted; anything can be recovered from the log.
- **Password storage**: plaintext in `settings` table (value needs to be shareable by admin with captains verbally / via Slack). DB is already admin-access-only, so plaintext is acceptable for this low-sensitivity shared secret.

## Data Model

**No new tables. No new columns.** Uses existing structures:

### `settings` table (already exists)

Seed one row:
```sql
INSERT OR IGNORE INTO settings (key, value)
VALUES ('phone_update_password', 'CHANGE_ME_VIA_ADMIN');
```

### `voters` table

Already has `phone`, `secondary_phone`, `tertiary_phone`. No schema changes.

### `voter_contacts` table (already exists)

Every call + every phone edit writes one row:

| Action | `contact_type` | `result` | `notes` |
|---|---|---|---|
| Tap-to-call | `Call` | `dialed` | (empty or phone number called) |
| Replace a phone | `PhoneUpdate` | `replaced` | `Slot: primary · Old: (956) 555-0001 → New: (956) 555-9999` |
| Erase a phone | `PhoneUpdate` | `erased` | `Slot: primary · Old: (956) 555-0001` |
| Auto-promote | `PhoneUpdate` | `promoted` | `Promoted secondary → primary: (956) 555-0002` |
| Admin revert | `PhoneUpdate` | `reverted` | `Slot: primary · Restored: (956) 555-0001` |

All rows include `voter_id`, `contacted_by`, `contacted_at`.

## New API Endpoints

All under `/api/captains/` or `/api/admin/`:

### Captain-facing

```
POST /api/captains/:id/phone-log
  Body: { voter_id, phone_called }
  Auth: requireCaptainAuth (matches :id)
  Behavior: inserts voter_contacts row (contact_type='Call', result='dialed')
  Returns: { success: true }

POST /api/captains/:id/phone-edit-auth
  Body: { password }
  Auth: requireCaptainAuth (matches :id)
  Behavior:
    - Rate-limit: 10 attempts / 15 min per captain
    - Compare body.password to settings.phone_update_password
    - On match: set req.session.phoneEditUnlocked = true, store phonePasswordAtAuth
    - On miss: 401
  Returns: { success: true } or 401

POST /api/captains/:id/update-phone
  Body: { voter_id, slot: 'primary'|'secondary'|'tertiary', new_phone }
  Auth: requireCaptainAuth + session.phoneEditUnlocked + password-fresh check
  Behavior:
    - Ownership check: voter must be visible to this captain (same pattern as text-log)
    - Validate new_phone (10+ digits)
    - Read old value from voters table
    - Write new_phone into chosen slot
    - Insert voter_contacts audit row
  Returns: { success: true, updated_voter } or 401/403/400

POST /api/captains/:id/erase-phone
  Body: { voter_id, slot }
  Auth: same as update-phone
  Behavior:
    - Ownership check
    - Read old value
    - Clear the slot
    - If slot=='primary' and secondary exists: promote (secondary→primary, tertiary→secondary)
    - Insert voter_contacts audit rows (one for erase, one for each promote if applicable)
  Returns: { success: true, updated_voter }
```

### Admin-facing

```
GET  /api/admin/settings/phone-update-password
  Auth: requireAuth (admin)
  Returns: { password }

PUT  /api/admin/settings/phone-update-password
  Body: { password }
  Auth: requireAuth
  Behavior: updates settings row. Note: all captain sessions with stale phonePasswordAtAuth will be implicitly logged out of phone-edit mode on next attempt.
  Returns: { success: true }

POST /api/admin/settings/phone-update-password/rotate
  Auth: requireAuth
  Behavior: generates random 6-char code using same alphabet as walk join codes; saves
  Returns: { password }

GET  /api/admin/phone-changes?days=30
  Auth: requireAuth
  Returns: [{ voter_id, voter_name, slot, old_value, new_value, captain_id, captain_name, contacted_at, audit_id }, ...]

POST /api/admin/phone-changes/:audit_id/revert
  Auth: requireAuth
  Behavior: reads the audit row, restores the old value to the voter's slot, writes a new 'reverted' audit row.
  Returns: { success: true }
```

## Frontend Changes

### `public/captain.html`

1. **Voter row rendering** (in `makeVoterRow` or equivalent):
   - Add 📞 button element next to existing 💬 badge
   - Disabled state when `voter.phone` is empty
   - Tap handler → `window.location.href = 'tel:+1' + digitsOnly(voter.phone)` + fire `POST /captains/:id/phone-log` (fire-and-forget)

2. **Voter detail card** (existing card rendering):
   - Render all 3 phones (primary, secondary, tertiary) as individual tappable elements
   - Each tap opens the action menu modal

3. **Action menu modal** (new):
   - Three buttons: Call / Update / Mark as No Longer Valid
   - Call → tel: + log
   - Update/Erase → check session's `phoneEditUnlocked` state (local mirror of server state); if not unlocked, first ask for password

4. **Password unlock modal** (new):
   - Input field + Submit
   - On success, store `phoneEditUnlockedAt = Date.now()` in a JS variable (not localStorage — session-only)
   - Remembers for the rest of this browser session

5. **Update phone modal** (new):
   - Pre-filled with old number (read-only display)
   - New number input
   - Save → POST /update-phone

6. **Erase confirmation** (new):
   - "Erase this number? The old number stays in the audit log and can be recovered by admin."
   - Confirm → POST /erase-phone

7. **Auto-promote message** (new):
   - After primary erase, UI shows "Secondary (956) 555-0002 promoted to primary."

### `public/index.html` (admin)

1. **Phone Update Password tile** in admin settings section:
   - Shows current password in a readable field
   - [Change Password] button → prompt for new value
   - [Generate New Random] button → calls /rotate endpoint, shows result

2. **Recent Phone Changes panel** (new tab or section):
   - Fetch /admin/phone-changes?days=30
   - Table: Voter · Slot · Old → New · Captain · When · [Revert]
   - Revert button triggers confirm + API call

## Error Handling

- **Network fails on phone-log (tap-to-call)**: ignored silently. Calling already succeeded locally; missing the log entry is minor and not worth retry complexity.
- **Network fails on phone-edit**: show error toast; retry button. No silent failures here since captain expects confirmation.
- **Password rotated mid-session**: captain's next edit attempt returns 401 with message "Password has changed, please re-authenticate." UI prompts for new password inline.
- **Invalid new_phone** (< 10 digits, non-digits, etc.): rejected server-side with 400.
- **Voter not visible to captain** (e.g. captain tries to edit a voter not on any of their lists): 403.
- **Auto-promote race** (two captains edit same voter simultaneously): last-write-wins at the DB level; audit log captures both actions, admin can reconcile if ever needed.

## Testing

Manual test plan (pre-release):

1. **Tap-to-call basic**
   - Login as captain with at least one voter with phone
   - Tap 📞 icon → iPhone dialer opens (simulate on iOS Safari; for desktop, `tel:` is a no-op but the log fires)
   - Check `voter_contacts` table has a new `Call/dialed` row

2. **Tap-to-call with empty phone**
   - Voter with no phone → icon greyed, tap has no effect

3. **Password gate**
   - Open voter card, tap a phone number, pick Update → password prompt appears
   - Wrong password → error, 9 retries allowed, 10th gets rate-limited
   - Correct password → proceed; subsequent Update on another voter skips prompt

4. **Update flow**
   - Enter new number → voter's phone updates, old number in audit log
   - Voter list reflects new number on next load

5. **Erase + auto-promote**
   - Voter with phone + secondary_phone → erase primary → secondary becomes primary in DB
   - Voter with only primary → erase primary → phone field is empty, voter is un-callable

6. **Admin password rotation**
   - Captain unlocks edit mode
   - Admin rotates password
   - Captain tries next edit → rejected with "Password has changed, please re-authenticate"

7. **Admin revert**
   - Captain erases a phone
   - Admin opens Recent Phone Changes, taps [Revert] on that entry
   - Voter's phone is restored

8. **Cross-captain isolation**
   - Captain A can't edit a voter on Captain B's list (unless they share team hierarchy)
   - Test the ownership check

## Rollout

1. Ship the full feature in one deploy
2. Admin visits Settings → sets an initial password (or clicks Generate)
3. Admin shares the password with trusted captains (Slack, SMS, verbal)
4. Captains start using the 📞 icon for fast calls and the edit flow for corrections
5. Admin periodically checks the Recent Phone Changes panel to spot-check data quality

## Future Work (explicitly deferred)

- Phone-bank queue mode (one-at-a-time structured call flow)
- Per-candidate phone scripts
- Call outcome buttons (Strong Support / Lean Yes / etc.) during calls
- Callback scheduler with specific-time reminders
- Suggested-corrections queue for untrusted captains (if we ever decide to reintroduce a trust tier)
- Native iOS app with Contacts integration (post-election decision)

## Risks

- **Password sprawl**: if the admin shares the password too widely, effectively all captains can edit. Mitigation: rotate any time trust shifts.
- **Typo errors**: captain types a wrong number. Mitigation: audit log + admin revert.
- **Accidental primary erase**: captain intends to mark secondary bad but taps primary. Mitigation: confirm dialog on erase shows which number is being erased.
- **Auto-promote surprise**: captain erases primary not realizing secondary becomes new primary. Mitigation: show message after erase explaining what happened.

## Build size estimate

~3-5 files touched, ~600 lines of new code:

- `public/captain.html`: +250 lines (icon, modals, edit flow)
- `public/index.html`: +150 lines (admin settings tile + changes panel)
- `routes/captains.js`: +150 lines (5 new endpoints)
- `routes/admin-lists.js` or new `routes/admin-phones.js`: +80 lines (admin endpoints)
- `db.js`: +3 lines (seed setting row)

All additive; no refactor of existing code.
