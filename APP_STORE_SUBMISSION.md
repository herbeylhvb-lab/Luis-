# App Store Submission Guide — CampaignText + BlockWalker

This document is a paste-ready playbook for submitting both iOS apps to the
App Store. Each section is what to type/click, in order. **Allow ~3 hours
total** the first time through.

---

## Pre-flight checklist (do these FIRST)

You must finish these before submitting either app or Apple will reject:

- [ ] **Reviewer credentials created** in your admin — see §3 below.
- [ ] **Privacy contact email working** — `privacy@campaigntext.app` is in the
      policy. Either set up that exact mailbox (Google Workspace forwarding,
      ForwardEmail.net free tier, etc.) OR change the policy to your real
      email at `routes/...` line in `server.js`. Apple will email this
      address to verify it works.
- [ ] **iOS app icons** generated (1024×1024 each). The two apps must have
      visually distinct icons or App Store rejects "duplicate visual
      identity".
- [ ] **Screenshots captured** for both apps — see §5 below.

> **Note on A2P 10DLC**: A2P 10DLC compliance applies to the **admin / web
> backend** that uses RumbleUp for bulk SMS broadcasts — that's already
> registered through RumbleUp. **The iOS apps do NOT trigger A2P SMS.** The
> CampaignText (captain) app uses the iOS Messages handoff (`sms:` URL or
> the Capacitor SMS plugin) so any text the captain sends comes from the
> captain's personal phone number, which is person-to-person (P2P) and
> exempt from A2P rules. The BlockWalker app does not send SMS at all.
> See §6 below for the details Apple's reviewer will want to know.

---

## §1 CampaignText (Captain) — App Store Connect metadata

Open https://appstoreconnect.apple.com → My Apps → CampaignText (create if
not yet). All fields are paste-ready unless noted.

### App Information

| Field | Value |
|---|---|
| **Name** | `CampaignText` |
| **Subtitle** | `Voter outreach for campaigns` |
| **Bundle ID** | `com.campaigntext.app` (already set) |
| **SKU** | `campaigntext-captain-001` (any unique string; never shown publicly) |
| **Primary Language** | English (U.S.) |
| **Category — Primary** | Productivity |
| **Category — Secondary** | Business |
| **Content Rights** | Check "Does NOT contain third-party content" |
| **Age Rating** | 17+ — answer the questionnaire as: Unrestricted Web Access = Yes, User-Generated Content = Yes, Political = Yes |

### Pricing & Availability
- Price: **Free**
- Availability: **United States only** (Brownsville is in TX; no need for global availability)
- Pre-order: No
- Volume Purchase: No

### Description (paste into "Description" field, max 4000 chars)

```
CampaignText is the field-operations app for political campaigns and authorized
campaign captains. Manage your assigned voter lists, log canvassing notes,
and reach out to voters from your iPhone — designed for campaign volunteers
and field captains, not desktop users.

WHAT IT DOES
• Captain dashboard — log in with your captain code, see your assigned voter
  lists, and start canvassing immediately
• Voter list management — search voters, view family/household groups, log
  support level, take notes, mark phone numbers
• Personal outreach — tap a voter to text them through your phone's built-in
  Messages app, or to call them through the Phone app. The text or call
  comes from YOUR phone — the app does not send messages on your behalf.
• Phone & text logging — every conversation you have is logged so the
  campaign can avoid double-contacting voters
• Block-walk coordination — see live walker positions on a shared map,
  track progress against the campaign's outreach goals
• Voter file integration — uses public Texas voter records to identify
  registered voters in your district

DESIGNED FOR FIELD USE
• Tap-friendly buttons sized for canvassers wearing gloves
• Works on iPhone and iPad
• Stays responsive even with 5,000+ doors in a walk

BUILT FOR COMPLIANCE
• When you tap "Text" on a voter, the app opens your iPhone's native
  Messages app pre-filled with the campaign's suggested message — you
  remain in control and choose whether to send. No automated sending.
• Texas Election Code §18.001/§18.066: voter file used only for permitted
  political-campaign purposes, never for commercial use
• Privacy: see in-app Privacy Policy. Account deletion available from the
  Account menu.

WHO USES IT
This app is intended for authorized campaign staff and field captains
operating under the direction of a registered political campaign committee.
Captain access codes are issued by the campaign administrator. The app is
not for distribution to or use by the general public.

SUPPORT
Questions? Email privacy@campaigntext.app or use the Account menu in the
app to log out / delete your captain account at any time.
```

### Keywords (paste into "Keywords", 100 chars max — this is exactly 99)

```
campaign,voters,canvassing,SMS,GOTV,block walk,election,outreach,captain,texting,political
```

### Promotional Text (paste into "Promotional Text", 170 chars max)

```
The mobile field operations app for political campaign captains. Manage voter lists, coordinate block walks, send compliant SMS — all from your iPhone.
```

### URLs

| Field | Value |
|---|---|
| **Marketing URL** (optional) | `https://campaigntext-production.up.railway.app/` |
| **Support URL** (required) | `https://campaigntext-production.up.railway.app/privacy` |
| **Privacy Policy URL** (required) | `https://campaigntext-production.up.railway.app/privacy` |

### App Review Information

These fields go in the **App Review Information** tab — Apple's reviewer
sees them, end users do not.

| Field | Value |
|---|---|
| **Sign-in required** | Yes |
| **Demo Account — Username** | (paste the Apple Reviewer captain code, see §3) |
| **Demo Account — Password** | `n/a — code-only login, the username field IS the credential` |
| **Contact First Name** | Luis |
| **Contact Last Name** | Villarreal |
| **Contact Phone** | (your phone) |
| **Contact Email** | (your email — Apple may call/email if review hits a snag) |

**Notes for the reviewer** (paste into "Notes" — 4000 char max):

```
This is a tool for authorized political campaign staff and volunteer captains
of the "Luis for Port of Brownsville Place 4" campaign in Texas. Captains are
assigned access codes by the campaign administrator and use the app to manage
voter outreach (door-knocking, SMS, phone calls).

HOW TO TEST:
1. Open the app. You'll see a code-entry screen.
2. Enter the demo code: APPLEREVIEW
3. You'll be signed in as the "Apple Reviewer" captain with a sample list of
   10 fictitious voters assigned for testing. The phone numbers in the
   sample list are 555-area test numbers that will not actually receive SMS.
4. Try: search the list, tap a voter to view details, tap "Match from My
   Contacts" (will request Contacts permission — voters' contact info stays
   on-device), tap the Account button (top right) to see Log Out and Delete
   My Account options.
5. To log out: Account → Log Out.
6. To delete the demo account from the app: Account → Delete My Account →
   re-type "APPLEREVIEW" → confirm. The account will be deactivated.
   (We will recreate the demo account so it remains available for future
   reviewers; the deletion confirms the in-app account-deletion flow works
   per guideline 5.1.1(v).)

CONTACTS PERMISSION:
The "Match from My Contacts" feature compares the device's contacts against
the campaign's voter list to suggest matches the captain might know
personally. Contact data is processed entirely on-device and is NEVER
uploaded to our servers. The corresponding Info.plist string explains this.

HOW SMS WORKS IN THIS APP (important for review):
When the captain taps the "Text" button on a voter, the app opens the
native iOS Messages app pre-filled with the campaign's suggested message.
The text is then sent FROM THE CAPTAIN'S OWN PHONE — it is person-to-person
SMS, not application-to-person (A2P). The app does not send messages on
the captain's behalf and does not maintain its own SMS infrastructure.
This handoff uses the standard `sms:` URL scheme and the open-source
@byteowls/capacitor-sms plugin.

NO REAL SMS WILL BE SENT during review — the demo voters have 555-test phone
numbers that the iOS Messages app may compose but the carrier will not
deliver.

OUR PRIVACY POLICY: https://campaigntext-production.up.railway.app/privacy
```

### Build (under "Build" section after upload)

After running Archive → Distribute App → App Store Connect from Xcode:
- The build appears in App Store Connect (~10-30 minutes after upload)
- **Encryption Compliance**: choose "No" — we declared
  `ITSAppUsesNonExemptEncryption = false` in Info.plist so this is fast.
- Tie this build to your version (1.0).

---

## §2 BlockWalker (Walker) — App Store Connect metadata

Same flow but for the second app. Create as a new app in App Store Connect
with **Bundle ID: `com.campaigntext.blockwalker`**.

### App Information

| Field | Value |
|---|---|
| **Name** | `BlockWalker` |
| **Subtitle** | `Door-to-door canvassing tool` |
| **Bundle ID** | `com.campaigntext.blockwalker` |
| **SKU** | `campaigntext-walker-001` |
| **Primary Language** | English (U.S.) |
| **Category — Primary** | Productivity |
| **Category — Secondary** | Navigation |
| **Age Rating** | 17+ |

### Pricing & Availability
- Free, US only.

### Description (paste, max 4000 chars)

```
BlockWalker is the iPhone app for political campaign volunteers who go
door-to-door talking to voters. Sign in with your walker code from the
campaign captain, and the app routes you to the next house, captures
your knock results, and shares your live position with your team.

WHAT IT DOES
• Walker code login — your captain gives you a code, you tap it in, you're
  walking. No account creation required.
• Address list with route — see every door in your assigned walk in
  walking order, with each voter's name, age, and party score
• Door panel — tap a door to log who's home, what their support level is,
  what notes the campaign should remember. Voice notes supported.
• Live group map — when walking with a team, see other walkers' positions
  in real time so you don't double-knock
• GPS verification — confirm you actually visited the door (configurable;
  privacy respected)
• Election history — see at a glance which elections each voter has
  participated in, so you can have a more relevant conversation

DESIGNED FOR THE FIELD
• Big, glove-friendly buttons
• Works on bad cellular — progressive load means a 5,000-house walk feels
  fast on the slowest connection
• Battery-aware location tracking
• Voice notes so you can capture details without typing

PERMISSIONS WE ASK FOR
• Location (always) — to show your live position to your team captain and
  to verify door knocks. If you decline "always," "while-using" works for
  most features.
• Microphone — only when you tap "Record" to capture a voice note.
• Camera — only if you scan a QR code at a check-in event.

WHO USES IT
Volunteer block walkers and field organizers working under the direction
of a registered political campaign committee. Walker codes are issued by
the campaign captain. The app is not for distribution to or use by the
general public.

PRIVACY & DATA
Your live location is shared only with your team captain during an active
walk. You can sign out anytime from the in-app menu. See our full Privacy
Policy at https://campaigntext-production.up.railway.app/privacy
```

### Keywords (100 chars max)

```
canvassing,block walker,doors,GOTV,election,voter contact,campaign,volunteer,knock,political
```

### Promotional Text (170 chars max)

```
Walker code, door list, route, knock results — everything a field volunteer needs to canvass effectively. Built for political campaigns.
```

### URLs (same as CampaignText)

### App Review Information

**Demo Account:**
- Username: `APPLEWALK` (the walker code — see §3)
- Password: `n/a — code-only`

**Notes for the reviewer:**

```
BlockWalker is the volunteer-canvasser companion app to CampaignText. Field
volunteers receive a walker code from the campaign captain and use this app
to log door-to-door visits.

HOW TO TEST:
1. Open the app. You'll see a code-entry screen.
2. Enter the demo code: APPLEWALK
3. You'll be assigned to a sample walk titled "Apple Review Test Walk" with
   10 fictitious houses on a single block.
4. Try: tap a house to open the door panel, log a knock outcome ("Support",
   "Not Home", etc.), close the panel, see the result on the address card.
5. The map view (tap "Map" tab) requires Location permission. Granting
   "while using" or "always" both work; the app does not transmit your
   location to anyone outside the campaign team.
6. The microphone permission is only requested if you tap "Record" inside
   a door panel to capture a voice note.

NO REAL SMS WILL BE SENT and no real voter contact occurs during review —
the test walk uses fictitious addresses and 555-test phone numbers.

LOCATION JUSTIFICATION (for App Store Review):
Background location ("Always") is used so that when a walker's screen locks
mid-walk, their team captain can still see them on the live group map. This
is a real-time team-coordination feature used during an active block walk.
The app does not collect location at any other time. We disclose this in
the Info.plist NSLocationAlwaysAndWhenInUseUsageDescription string.

OUR PRIVACY POLICY: https://campaigntext-production.up.railway.app/privacy
```

---

## §3 Reviewer credentials — create in your admin

Apple's reviewer must be able to sign in. Both apps use code-based login.
Create these via your existing admin UI at
`https://campaigntext-production.up.railway.app/` (admin login required):

### A. CampaignText reviewer captain

1. Go to admin → **Captains** tab → "New Captain"
2. Fill in:
   - Name: `Apple Reviewer`
   - Code: `APPLEREVIEW` (must be uppercase, no spaces)
   - Phone: `5555550100` (a 555 fake number)
   - Email: leave blank or `applereview@example.com`
   - Active: ✅
3. Save.
4. Create a small voter list assigned to this captain:
   - Admin → **Lists** tab → New List
   - Name: `Apple Review Sample`
   - Add 10 fictitious voters (or copy 10 existing ones, but EDIT their
     phones to all be 555-XXX-XXXX so even accidental sends fail at the
     carrier).
   - Assign the list to captain `APPLEREVIEW`.

### B. BlockWalker reviewer walker + walk

1. Admin → **Walkers** (or Volunteers) tab → "New Walker"
   - Name: `Apple Reviewer`
   - Code: `APPLEWALK`
   - Active: ✅
2. Admin → **Block Walks** tab → "New Walk"
   - Name: `Apple Review Test Walk`
   - Description: `For Apple App Store reviewer testing`
   - Status: Active
3. Add 10 sample addresses to the walk (admin UI lets you add manually —
   or import a CSV). Use 555-area phone numbers and fictitious names.
4. Add `APPLEWALK` walker as a member of the walk.

### C. Verify both work

Test before submitting:
1. Open `https://…/captain` in a private/incognito browser, type
   `APPLEREVIEW`, confirm you see the sample list.
2. Open `https://…/walk`, type `APPLEWALK`, confirm you see the test walk.

If both work in a clean browser session, Apple's reviewer will succeed too.

### D. Don't forget after Apple approves

Set a calendar reminder for ~2 weeks after submission to **recreate the
APPLEREVIEW captain** (the reviewer's deletion test will have soft-deleted
it). Repeat the steps in §3A.

---

## §4 Privacy contact email

The privacy policy promises responses to `privacy@campaigntext.app`. You
need this mailbox to actually exist before submission, because:

- Apple sometimes emails the privacy contact before approval.
- California/EU residents can email asking for their data; ignoring those
  requests is a CCPA/GDPR violation.

**Two ways to set this up:**

**Option A — Buy `campaigntext.app` domain + ForwardEmail.net (free)**
1. Register `campaigntext.app` at any registrar (~$15/year)
2. Sign up at https://forwardemail.net (free tier supports custom domains)
3. Add MX records pointing to ForwardEmail
4. Create a forward: `privacy@campaigntext.app → your-real-email@gmail.com`
5. Test by emailing yourself from another address

**Option B — Change the email in the privacy policy to your existing one**
Edit `server.js` around the `compliancePage('privacy')` block, replace
`privacy@campaigntext.app` with whatever address you do own (e.g.,
`luis@luisforportbrownsville.com`), commit, push.

---

## §5 Screenshots — how to capture them

You need at least one set of screenshots for each app. Apple's required
device sizes (as of 2026):

| Device | Resolution | Required? |
|---|---|---|
| iPhone 6.7" (15 Pro Max) | 1290×2796 | ✅ Required |
| iPhone 6.5" (11 Pro Max) | 1242×2688 | Required (auto-derived from 6.7" if you skip) |
| iPad 12.9" (Pro) | 2048×2732 | Only if you market iPad support |

**Easiest method — iOS Simulator:**

```bash
# In Xcode → Open Developer Tool → Simulator
# Pick "iPhone 15 Pro Max" → load https://campaigntext-production.up.railway.app/captain
# Sign in as APPLEREVIEW
# For each screen, press Cmd+S to save a PNG
# Repeat for /walk and APPLEWALK
```

Take 3–5 screenshots per app showing:
1. Login screen
2. Main dashboard / address list
3. A voter / door detail panel
4. The map view (BlockWalker only)
5. The Account menu (CampaignText only — proves account-deletion exists)

Drop all PNGs into App Store Connect → Media Manager.

---

## §6 SMS compliance — already handled via RumbleUp ✅

A2P 10DLC compliance applies to the **admin / web backend**, where bulk
broadcast SMS goes out via RumbleUp. **You already have that registered
through RumbleUp**, so this is not a blocker for App Store submission.

### Why the iOS apps don't need additional 10DLC registration

| Sending channel | Where | Subject to A2P 10DLC? |
|---|---|---|
| RumbleUp bulk broadcasts | Admin web UI only | Yes — registered through RumbleUp ✅ |
| Captain "Text" button | Captain iPhone app | **No** — opens iOS Messages, sends from captain's personal number (P2P) |
| BlockWalker | Walker iPhone app | **No** — app doesn't send SMS at all |

The captain app uses two SMS handoff mechanisms, both P2P (exempt from A2P):

1. **`@byteowls/capacitor-sms` plugin** (when running natively on iOS) —
   opens the iOS Messages compose sheet pre-filled. Captain reviews and
   taps Send.
2. **`sms:` URL scheme** (when running in Safari) — same idea, opens
   Messages.

In both cases, the SMS leaves the captain's personal phone, billed to the
captain's own carrier plan, with the captain's own caller ID. The
`opt_outs` table is consulted server-side before suggesting a phone number
to text, so opted-out voters don't appear in the captain's outreach list.

### If Apple's reviewer asks about 10DLC

Use the language already in your reviewer notes (§1):

> "When the captain taps the 'Text' button on a voter, the app opens the
> native iOS Messages app pre-filled with the campaign's suggested message.
> The text is then sent FROM THE CAPTAIN'S OWN PHONE — it is person-to-
> person SMS, not application-to-person (A2P). The app does not send
> messages on the captain's behalf and does not maintain its own SMS
> infrastructure."

### What about the admin/RumbleUp side?

The admin's bulk broadcast feature is web-only and is not exposed in
either iOS app. Apple's reviewer will not encounter it. Your RumbleUp
A2P 10DLC registration covers it independently.

> If you ever need to verify the RumbleUp registration is healthy:
> RumbleUp Dashboard → Compliance → 10DLC Status. A green checkmark and
> the legal entity name = registered.

---

## §7 Trademark search (5 minutes, $0)

Run a quick check at https://tmsearch.uspto.gov before you publish to make
sure no one has already federally trademarked "CampaignText" or
"BlockWalker":

1. Go to TESS → Basic Word Mark Search
2. Search `CampaignText` → click results, look for active "live"
   registrations in IC 009 (software), IC 035 (advertising), or IC 042
   (hosted software services).
3. Repeat for `BlockWalker`.

**If both are clear**, you're fine. The names are descriptive enough that
common-law use by a single campaign is low-risk.

**If someone else has a live federal trademark**, change the App Store
display name to something distinctive (e.g., `LV CampaignHQ`) — the bundle
ID can stay; the marketing name is what users see.

---

## §8 Submission checklist (do these in order)

- [x] A2P 10DLC — already done via RumbleUp (admin side). Apps are P2P-only.
- [ ] §3 Reviewer credentials created and tested
- [ ] §4 Privacy email mailbox set up
- [ ] §5 Screenshots captured for both apps
- [ ] §7 Trademark search clear (or rename app)
- [ ] App icons distinct between the two apps (replace BlockWalker icon
      with a door-knock or walking-figure design)
- [ ] In Xcode, both apps' `MARKETING_VERSION = 1.0`,
      `CURRENT_PROJECT_VERSION = 1`
- [ ] Archive each app, upload via Distribute → App Store Connect
- [ ] In App Store Connect, attach the build to the version, fill all §1
      and §2 metadata fields
- [ ] Submit for review

Apple typically replies within 24-48 hours.

---

## §9 If Apple rejects — common political-app reasons

| Reason | Fix |
|---|---|
| "We could not log in with the demo credentials" | Re-test §3, ensure your admin actually saved the codes, ensure the captain/walker is `is_active = 1` |
| "App requires content the reviewer cannot access" | Add more sample voters/doors so the reviewer sees populated screens |
| "Missing in-app account deletion" | Already handled — point reviewer to the Account → Delete My Account flow in your re-submission notes |
| "Privacy policy missing required disclosures" | Already covered in our policy, but if Apple specifies what's missing, add it and re-submit |
| "App contains political content without rating" | Confirm Age Rating questionnaire selected "Political" = Yes |
| "Background location not justified" | The Notes for Reviewer in §2 already explains this; if rejected anyway, escalate via Resolution Center with the same explanation |

---

*This document is part of the compliance documentation for the campaign-text-hq
project. Last updated: April 2026.*
