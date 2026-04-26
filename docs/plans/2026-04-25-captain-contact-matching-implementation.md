# Captain Contact Matching & In-App Texting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let block captains import iPhone contacts, match them to existing voters, update phone numbers, and text from inside a native iOS app on their personal number.

**Architecture:** Two phases on the same codebase. Phase 1 builds the matching API + picker UI as a plain web feature (testable in any browser, fed by vCard/CSV upload). Phase 2 wraps the unchanged web app in Capacitor and adds native iPhone Contact picker + native message sheet plugins, distributed via TestFlight. JS branches at runtime via `Capacitor.isNativePlatform()` so the same matching code runs on both.

**Web stays first-class:** the existing browser experience continues to work for any captain who never installs the iOS app. Phase 2 is *additive*, not a replacement.

**Tech Stack:** Node.js + Express + better-sqlite3 (existing), vanilla JS in `captain.html` (existing), Capacitor 5 + `@capacitor-community/contacts` + a Capacitor SMS plugin (Phase 2), Xcode + Apple Developer Program for TestFlight.

**Test convention:** Tests are plain Node scripts in `tests/` that boot the server on port 3999 and hit it via `http`. No framework. Run with `node tests/test-foo.js`. Pattern is established in `tests/test-captain-sim.js`.

**Security note (XSS):** All UI code in `captain.html` MUST build dynamic content via DOM methods (`document.createElement`, `textContent`, `appendChild`), NOT `innerHTML` with interpolated values. This avoids any chance of malicious vCard/CSV content executing scripts. The plan below uses this pattern throughout.

**Design doc:** `docs/plans/2026-04-25-captain-contact-matching-design.md`

**Commit/push convention** (per user memory): commit after each task; push to BOTH `origin` and `campaigntext` remotes; do not ask for permission.

---

## Phase 1 — Web matching (Tasks 1-12)

### Task 1: Add `levenshtein()` to utils.js

**Files:**
- Modify: `utils.js` (append to end of file)
- Test: `tests/test-name-matching.js` (NEW)

**Step 1: Write the failing test**

Create `tests/test-name-matching.js`:

```js
#!/usr/bin/env node
const { levenshtein } = require('../utils');
let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${actual}, expected ${expected}`);
  ok ? passed++ : failed++;
}

eq('identical strings', levenshtein('smith', 'smith'), 0);
eq('one substitution', levenshtein('smith', 'smyth'), 1);
eq('insertion', levenshtein('smith', 'smiths'), 1);
eq('deletion', levenshtein('smiths', 'smith'), 1);
eq('case-insensitive', levenshtein('Smith', 'smith'), 0);
eq('empty vs filled', levenshtein('', 'smith'), 5);
eq('totally different', levenshtein('bob', 'robert'), 4);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

**Step 2: Run to verify it fails**

```bash
node tests/test-name-matching.js
```

Expected: error like `TypeError: levenshtein is not a function` (since we haven't added it yet).

**Step 3: Implement `levenshtein()` in `utils.js`**

Append to `utils.js`:

```js
// Computes Levenshtein edit distance between two strings (case-insensitive).
function levenshtein(a, b) {
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

module.exports.levenshtein = levenshtein;
```

**Step 4: Run to verify it passes**

```bash
node tests/test-name-matching.js
```

Expected: `7 passed, 0 failed`.

**Step 5: Commit and push**

```bash
git add utils.js tests/test-name-matching.js
git commit -m "feat: add levenshtein() helper for fuzzy name matching"
git push origin main && git push campaigntext main
```

---

### Task 2: Create `utils/nicknames.js`

**Files:**
- Create: `utils/nicknames.js`

**Step 1: Create the file**

```js
// Bidirectional nickname map for captain contact matching.
// Keys are canonical legal names from voter files; values are common informal forms.
// Expand over time with district-specific entries.

module.exports = {
  // Male
  'Robert':    ['Bob', 'Bobby', 'Rob', 'Robbie', 'Bert'],
  'William':   ['Will', 'Bill', 'Billy', 'Willie', 'Liam'],
  'James':     ['Jim', 'Jimmy', 'Jamie'],
  'John':      ['Jon', 'Johnny', 'Jack'],
  'Richard':   ['Rich', 'Rick', 'Ricky', 'Dick', 'Richie'],
  'Michael':   ['Mike', 'Mickey', 'Mick', 'Mikey'],
  'Charles':   ['Charlie', 'Chuck', 'Chas'],
  'Christopher': ['Chris', 'Topher', 'Kit'],
  'Joseph':    ['Joe', 'Joey', 'Jos'],
  'Thomas':    ['Tom', 'Tommy', 'Thom'],
  'Daniel':    ['Dan', 'Danny'],
  'Anthony':   ['Tony', 'Ant'],
  'Andrew':    ['Andy', 'Drew'],
  'Edward':    ['Ed', 'Eddie', 'Ted', 'Teddy', 'Ned'],
  'Nicholas':  ['Nick', 'Nicky'],
  'Benjamin':  ['Ben', 'Benny', 'Benji'],
  'Matthew':   ['Matt', 'Matty'],
  'Timothy':   ['Tim', 'Timmy'],
  'Jose':      ['Pepe', 'Pepito', 'Joselito'],
  'Francisco': ['Paco', 'Pancho', 'Frank'],

  // Female
  'Elizabeth': ['Liz', 'Lizzy', 'Beth', 'Betty', 'Eliza', 'Betsy', 'Libby'],
  'Margaret':  ['Maggie', 'Meg', 'Peggy', 'Marge', 'Madge'],
  'Catherine': ['Cathy', 'Kate', 'Katie', 'Kathy', 'Cat'],
  'Katherine': ['Kathy', 'Kate', 'Katie', 'Kat'],
  'Patricia':  ['Pat', 'Patty', 'Trish', 'Tricia'],
  'Jennifer':  ['Jen', 'Jenny', 'Jenn'],
  'Susan':     ['Sue', 'Susie', 'Suzy'],
  'Deborah':   ['Deb', 'Debbie'],
  'Barbara':   ['Barb', 'Barbie'],
  'Rebecca':   ['Becky', 'Becca', 'Reba'],
  'Maria':     ['Mary', 'Mari', 'Mia'],
  'Guadalupe': ['Lupe', 'Lupita'],
};
```

**Step 2: Commit and push**

```bash
mkdir -p utils
git add utils/nicknames.js
git commit -m "feat: add nickname dictionary for first-name matching"
git push origin main && git push campaigntext main
```

---

### Task 3: Add `isNicknameOf()` to utils.js

**Files:**
- Modify: `utils.js` (append after `levenshtein`)
- Test: `tests/test-name-matching.js` (extend)

**Step 1: Extend the test file** — append to `tests/test-name-matching.js` BEFORE the final `console.log`:

```js
// === isNicknameOf() ===
const { isNicknameOf } = require('../utils');

eq('Bob is nickname of Robert', isNicknameOf('Bob', 'Robert'), true);
eq('Robert is nickname of Bob (reverse)', isNicknameOf('Robert', 'Bob'), true);
eq('case-insensitive', isNicknameOf('bob', 'ROBERT'), true);
eq('Liz is nickname of Elizabeth', isNicknameOf('Liz', 'Elizabeth'), true);
eq('Lupe is nickname of Guadalupe', isNicknameOf('Lupe', 'Guadalupe'), true);
eq('not a nickname', isNicknameOf('Bob', 'William'), false);
eq('same name not a nickname', isNicknameOf('Robert', 'Robert'), false);
```

**Step 2: Run to verify it fails**

```bash
node tests/test-name-matching.js
```

Expected: `TypeError: isNicknameOf is not a function`.

**Step 3: Implement in `utils.js`**

```js
const NICKNAMES = require('./utils/nicknames');

function isNicknameOf(a, b) {
  if (!a || !b) return false;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) return false;
  for (const formal in NICKNAMES) {
    const informals = NICKNAMES[formal].map(n => n.toLowerCase());
    const formalLower = formal.toLowerCase();
    if ((lowerA === formalLower && informals.includes(lowerB)) ||
        (lowerB === formalLower && informals.includes(lowerA))) {
      return true;
    }
  }
  return false;
}

module.exports.isNicknameOf = isNicknameOf;
```

**Step 4: Run to verify it passes**

```bash
node tests/test-name-matching.js
```

Expected: `14 passed, 0 failed`.

**Step 5: Commit and push**

```bash
git add utils.js tests/test-name-matching.js
git commit -m "feat: add isNicknameOf() bidirectional nickname check"
git push origin main && git push campaigntext main
```

---

### Task 4: Add `scoreCandidate()` pure function

**Files:**
- Modify: `utils.js`
- Test: `tests/test-name-matching.js` (extend)

**Step 1: Extend the test file** — append:

```js
// === scoreCandidate() ===
const { scoreCandidate } = require('../utils');

function near(name, actual, expected, tol = 0.05) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${actual.toFixed(3)}, expected ~${expected}`);
  ok ? passed++ : failed++;
}

near('exact match', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 1.0);

near('nickname match', scoreCandidate(
  { firstName: 'Bob', lastName: 'Smith', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 1.0);

near('last name typo', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smyth', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 0.9);

near('age off by 5', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith', age: 62 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 0.9);

near('totally wrong', scoreCandidate(
  { firstName: 'Bob', lastName: 'Smith', age: 30 },
  { first_name: 'Maria', last_name: 'Lopez', age: 70 }
), 0.0, 0.2);
```

**Step 2: Run to verify it fails**

```bash
node tests/test-name-matching.js
```

Expected: `TypeError: scoreCandidate is not a function`.

**Step 3: Implement in `utils.js`**

```js
function scoreCandidate(contact, voter) {
  const lastA = contact.lastName || '', lastB = voter.last_name || '';
  const firstA = contact.firstName || '', firstB = voter.first_name || '';
  const lastNameScore = 1 - levenshtein(lastA, lastB) / Math.max(lastA.length, lastB.length, 1);
  const levFirstScore = 1 - levenshtein(firstA, firstB) / Math.max(firstA.length, firstB.length, 1);
  const firstNameScore = isNicknameOf(firstA, firstB) ? 1.0 : levFirstScore;
  const ageGap = Math.abs((contact.age || 0) - (voter.age || 0));
  const ageScore = Math.max(0, 1 - ageGap / 10);
  return 0.5 * lastNameScore + 0.3 * firstNameScore + 0.2 * ageScore;
}

module.exports.scoreCandidate = scoreCandidate;
```

**Step 4: Run to verify it passes**

```bash
node tests/test-name-matching.js
```

Expected: `19 passed, 0 failed`.

**Step 5: Commit and push**

```bash
git add utils.js tests/test-name-matching.js
git commit -m "feat: add scoreCandidate() weighted matching score"
git push origin main && git push campaigntext main
```

---

### Task 5: Create `routes/captain-contacts.js` skeleton

**Files:**
- Create: `routes/captain-contacts.js`

**Step 1: Create the file** with route stubs:

```js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { scoreCandidate, normalizePhone } = require('../utils');

const matchLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many match requests.' } });
const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many confirm requests.' } });

router.post('/captain/match-candidates', matchLimiter, (req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

router.post('/captain/confirm-match', confirmLimiter, (req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

module.exports = router;
```

**Step 2: Commit and push**

```bash
git add routes/captain-contacts.js
git commit -m "feat: scaffold routes/captain-contacts.js"
git push origin main && git push campaigntext main
```

---

### Task 6: Mount the router in `server.js` (do this BEFORE Task 7 so tests can hit the endpoint)

**Files:**
- Modify: `server.js`

**Step 1: Find the routes block:**

```bash
grep -n "app.use.*api" server.js | head -10
```

**Step 2: Add this line** in the same block:

```js
app.use('/api', require('./routes/captain-contacts'));
```

**Step 3: Verify the server starts:**

```bash
node server.js
# Should start without errors. Ctrl-C to stop.
```

**Step 4: Commit and push**

```bash
git add server.js
git commit -m "feat: mount captain-contacts router"
git push origin main && git push campaigntext main
```

---

### Task 7: Implement `POST /api/captain/match-candidates`

**Files:**
- Modify: `routes/captain-contacts.js`
- Create: `tests/test-captain-match.js`

**Step 1: Write failing test**

Create `tests/test-captain-match.js`:

```js
#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://127.0.0.1:3999';
let passed = 0, failed = 0;
let serverProc;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      method, hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const r = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  cond ? passed++ : failed++;
}

async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try { await req('GET', '/'); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('server did not come up');
}

(async () => {
  process.env.DB_PATH = path.join(__dirname, 'test-match.db');
  process.env.PORT = '3999';
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch {}
  serverProc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();

  const db = require('../db');
  const insert = db.prepare('INSERT INTO voters (first_name, last_name, age, phone, address, city, zip) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('Robert', 'Smith', 57, '', '123 Main', 'Cameron', '43009');
  insert.run('Robert', 'Smith', 32, '', '456 Oak', 'Cameron', '43009');
  insert.run('Maria', 'Lopez', 45, '', '789 Pine', 'Cameron', '43009');
  insert.run('William', 'Johnson', 60, '', '12 Elm', 'Cameron', '43009');
  insert.run('Patricia', 'Brown', 28, '', '34 Birch', 'Cameron', '43009');

  let r = await req('POST', '/api/captain/match-candidates', { firstName: 'Bob', lastName: 'Smith', age: 55 });
  ok('returns 200', r.status === 200);
  ok('returns candidates array', Array.isArray(r.body.candidates));
  ok('top candidate is age-57 Robert', r.body.candidates[0] && r.body.candidates[0].age === 57);

  r = await req('POST', '/api/captain/match-candidates', { firstName: 'Maria', lastName: 'Lopes', age: 45 });
  ok('typo match works', r.body.candidates[0] && r.body.candidates[0].lastName === 'Lopez');

  r = await req('POST', '/api/captain/match-candidates', { firstName: 'Zachariah', lastName: 'Q', age: 99 });
  ok('no match returns empty candidates', r.body.candidates.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  serverProc.kill();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (serverProc) serverProc.kill(); process.exit(1); });
```

**Step 2: Run to verify it fails**

```bash
node tests/test-captain-match.js
```

Expected: tests fail because endpoint returns 501.

**Step 3: Implement match-candidates** in `routes/captain-contacts.js` — replace the stub:

```js
router.post('/captain/match-candidates', matchLimiter, (req, res) => {
  const { firstName, lastName, age, captainId } = req.body || {};
  if (!firstName || !lastName || age == null) {
    return res.status(400).json({ error: 'firstName, lastName, age required' });
  }
  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 130) {
    return res.status(400).json({ error: 'age must be 1-130' });
  }
  const ageMin = Math.max(1, ageNum - 5);
  const ageMax = Math.min(130, ageNum + 5);
  const lastInitial = lastName[0] || '';

  function fetchAndScore(scope) {
    let rows;
    if (scope === 'list' && captainId) {
      rows = db.prepare(`
        SELECT id, first_name, last_name, age, gender, address, city, zip,
               phone, phone_validated_at
        FROM voters
        WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)
          AND age BETWEEN ? AND ?
          AND id IN (SELECT voter_id FROM captain_list_voters
                     WHERE list_id IN (SELECT id FROM captain_lists WHERE captain_id = ?))
        LIMIT 100
      `).all(lastInitial, ageMin, ageMax, captainId);
    } else {
      rows = db.prepare(`
        SELECT id, first_name, last_name, age, gender, address, city, zip,
               phone, phone_validated_at
        FROM voters
        WHERE LOWER(SUBSTR(last_name, 1, 1)) = LOWER(?)
          AND age BETWEEN ? AND ?
        LIMIT 100
      `).all(lastInitial, ageMin, ageMax);
    }
    return rows.map(v => ({
      voterId: v.id,
      firstName: v.first_name,
      lastName: v.last_name,
      age: v.age,
      address: v.address,
      city: v.city,
      currentPhone: v.phone || '',
      phoneValidatedAt: v.phone_validated_at || null,
      score: scoreCandidate({ firstName, lastName, age: ageNum }, v),
    }))
      .filter(c => c.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  let candidates = fetchAndScore('list');
  let scope = 'list';
  if (candidates.length === 0) {
    candidates = fetchAndScore('broader');
    scope = 'broader';
  }
  res.json({ candidates, scope });
});
```

**Step 4: Run to verify it passes**

```bash
node tests/test-captain-match.js
```

Expected: `5 passed, 0 failed`.

**Step 5: Commit and push**

```bash
git add routes/captain-contacts.js tests/test-captain-match.js
git commit -m "feat: implement /api/captain/match-candidates with scoring"
git push origin main && git push campaigntext main
```

---

### Task 8: Implement `POST /api/captain/confirm-match`

**Files:**
- Modify: `routes/captain-contacts.js`
- Modify: `tests/test-captain-match.js` (add confirm test)

**Step 1: Append confirm tests** to `tests/test-captain-match.js` (before the final `console.log`):

```js
  r = await req('POST', '/api/captain/confirm-match', { voterId: 1, phone: '(555) 123-4567' });
  ok('confirm-match returns 200', r.status === 200);
  ok('confirm-match returns success', r.body.success === true);
  const updated = db.prepare('SELECT phone, phone_validated_at, phone_type FROM voters WHERE id = ?').get(1);
  ok('voter phone updated', updated.phone && updated.phone.includes('555'));
  ok('phone_validated_at set', !!updated.phone_validated_at);
  ok('phone_type set to mobile', updated.phone_type === 'mobile');

  r = await req('POST', '/api/captain/confirm-match', { phone: '5551112222' });
  ok('rejects missing voterId', r.status === 400);
```

**Step 2: Run to verify failure**

```bash
node tests/test-captain-match.js
```

Expected: confirm tests fail (still 501).

**Step 3: Implement confirm-match** in `routes/captain-contacts.js` — replace the stub:

```js
router.post('/captain/confirm-match', confirmLimiter, (req, res) => {
  const { voterId, phone } = req.body || {};
  if (!voterId || !phone) {
    return res.status(400).json({ error: 'voterId and phone required' });
  }
  const normalized = normalizePhone(phone) || phone;
  try {
    const result = db.prepare(`
      UPDATE voters
      SET phone = ?, phone_validated_at = datetime('now'), phone_type = 'mobile'
      WHERE id = ?
    `).run(normalized, voterId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'voter not found' });
    }
    res.json({ success: true, voterId, phone: normalized });
  } catch (err) {
    console.error('confirm-match error:', err.message);
    res.status(500).json({ error: 'update failed' });
  }
});
```

**Step 4: Run to verify it passes**

```bash
node tests/test-captain-match.js
```

Expected: `10 passed, 0 failed`.

**Step 5: Commit and push**

```bash
git add routes/captain-contacts.js tests/test-captain-match.js
git commit -m "feat: implement /api/captain/confirm-match phone update"
git push origin main && git push campaigntext main
```

---

### Task 9: Add the modal scaffold to `captain.html`

**Files:**
- Modify: `public/captain.html`

**Step 1: Find a good insertion point for the trigger button** — search for where existing buttons live near the top of the captain dashboard:

```bash
grep -n "csv-import\|bulk-text\|Add to List" public/captain.html | head -10
```

**Step 2: Add the trigger button** in that area:

```html
<button id="matchContactsBtn" class="btn-primary">Match from My Contacts</button>
```

**Step 3: Add the modal markup** near the other modals in the file (search for `class="modal"` to find them). The modal contains only static structure; all dynamic content is built via DOM methods later — no `innerHTML` with user data.

```html
<div id="matchContactsModal" class="modal" style="display:none">
  <div class="modal-box" style="max-width:520px;background:#1e293b;padding:20px;border-radius:12px">
    <h3 id="mcTitle">Match Contacts to Voters</h3>

    <section id="mcStep1">
      <p>Upload your iPhone Contacts as a vCard (.vcf) or CSV file.</p>
      <input type="file" id="mcFileInput" accept=".vcf,.csv,text/vcard,text/csv">
      <p id="mcParseStatus" style="color:#94a3b8;margin-top:8px"></p>
    </section>

    <section id="mcStep2" style="display:none">
      <p id="mcContactProgress" style="color:#94a3b8"></p>
      <div id="mcContactCard" style="padding:8px;background:#0f172a;border-radius:6px;margin:8px 0"></div>
      <label>Probable age:
        <input type="number" id="mcAgeInput" min="1" max="130" style="width:80px">
      </label>
      <button id="mcFindMatchesBtn">Find Matches</button>
      <div id="mcCandidateList" style="margin-top:12px"></div>
      <div id="mcActionMenu" style="display:none;margin-top:12px"></div>
      <button id="mcSkipBtn" style="margin-top:8px">Skip — not in voter file</button>
    </section>

    <section id="mcStep3" style="display:none">
      <h4>Done</h4>
      <p id="mcSummary"></p>
    </section>

    <button id="mcCloseBtn" style="float:right;margin-top:12px">Close</button>
  </div>
</div>
```

**Step 4: Verify it renders** — start the server and visit captain.html in a browser. Click the button — modal should appear with Step 1 visible.

```bash
node server.js
# Browser → http://localhost:3000/captain.html
```

**Step 5: Commit and push**

```bash
git add public/captain.html
git commit -m "feat: add Match Contacts modal scaffold (markup only)"
git push origin main && git push campaigntext main
```

---

### Task 10: Add vCard + CSV parsers (browser-side)

**Files:**
- Modify: `public/captain.html` (within an existing `<script>` block)

**Step 1: Add the parser functions:**

```js
function parseVCard(text) {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const out = [];
  for (const block of cards) {
    const lines = block.split(/\r?\n/);
    let firstName = '', lastName = '', phone = '';
    for (const line of lines) {
      if (/^N[:;]/i.test(line)) {
        const parts = line.replace(/^N[^:]*:/i, '').split(';');
        lastName = (parts[0] || '').trim();
        firstName = (parts[1] || '').trim();
      } else if (/^FN[:;]/i.test(line) && !firstName) {
        const fn = line.replace(/^FN[^:]*:/i, '').trim().split(/\s+/);
        firstName = fn[0] || '';
        lastName = fn.slice(1).join(' ') || '';
      } else if (/^TEL/i.test(line) && !phone) {
        phone = line.replace(/^TEL[^:]*:/i, '').trim();
      }
    }
    if (firstName || lastName) out.push({ firstName, lastName, phone });
  }
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idxOf = (names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const fi = idxOf(['first', 'firstname', 'first_name', 'first name']);
  const li = idxOf(['last', 'lastname', 'last_name', 'last name']);
  const pi = idxOf(['phone', 'phone number', 'mobile', 'cell']);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row = {
      firstName: fi >= 0 ? cols[fi] : '',
      lastName: li >= 0 ? cols[li] : '',
      phone: pi >= 0 ? cols[pi] : '',
    };
    if (row.firstName || row.lastName) out.push(row);
  }
  return out;
}
```

**Step 2: Wire up the file input handler** (no DOM-string interpolation; uses `textContent`):

```js
document.getElementById('mcFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const isVcf = file.name.toLowerCase().endsWith('.vcf') || text.includes('BEGIN:VCARD');
  const contacts = isVcf ? parseVCard(text) : parseCSV(text);
  document.getElementById('mcParseStatus').textContent = `Parsed ${contacts.length} contacts.`;
  window._mcContacts = contacts;
  window._mcIndex = 0;
  window._mcResults = { matched: 0, skipped: 0 };
  if (contacts.length > 0) {
    document.getElementById('mcStep1').style.display = 'none';
    document.getElementById('mcStep2').style.display = 'block';
    renderCurrentContact();
  }
});
```

**Step 3: Sanity-check the parsers in the browser console** with the page loaded:

```js
parseVCard('BEGIN:VCARD\nFN:Bob Smith\nTEL:5551234567\nEND:VCARD\n')
// → [{firstName:'Bob', lastName:'Smith', phone:'5551234567'}]
```

**Step 4: Commit and push**

```bash
git add public/captain.html
git commit -m "feat: parse vCard and CSV contact files in browser"
git push origin main && git push campaigntext main
```

---

### Task 11: Wire up the per-contact wizard flow (using safe DOM methods, NOT innerHTML)

**Files:**
- Modify: `public/captain.html`

**Step 1: Add the wizard JavaScript** (note: every dynamic node uses `document.createElement` + `textContent` — never `innerHTML` with interpolated values, to prevent XSS from malicious contact data):

```js
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeEl(tag, opts) {
  const el = document.createElement(tag);
  if (opts) {
    if (opts.text) el.textContent = opts.text;
    if (opts.cls) el.className = opts.cls;
    if (opts.style) el.setAttribute('style', opts.style);
    if (opts.data) for (const k in opts.data) el.dataset[k] = opts.data[k];
  }
  return el;
}

function renderCurrentContact() {
  const c = window._mcContacts[window._mcIndex];
  if (!c) return finishWizard();

  document.getElementById('mcContactProgress').textContent =
    `Contact ${window._mcIndex + 1} of ${window._mcContacts.length}`;

  const card = document.getElementById('mcContactCard');
  clearChildren(card);
  const nameEl = makeEl('strong', { text: `${c.firstName} ${c.lastName}` });
  const br = document.createElement('br');
  const phoneEl = makeEl('span', { text: c.phone, style: 'color:#94a3b8' });
  card.appendChild(nameEl);
  card.appendChild(br);
  card.appendChild(phoneEl);

  document.getElementById('mcAgeInput').value = '';
  clearChildren(document.getElementById('mcCandidateList'));
  document.getElementById('mcActionMenu').style.display = 'none';
}

document.getElementById('mcFindMatchesBtn').addEventListener('click', async () => {
  const c = window._mcContacts[window._mcIndex];
  const age = parseInt(document.getElementById('mcAgeInput').value, 10);
  if (!age) { alert('Enter a probable age first.'); return; }
  const r = await fetch('/api/captain/match-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: c.firstName, lastName: c.lastName, age }),
  });
  const data = await r.json();
  renderCandidates(data.candidates || [], data.scope || 'list');
});

function renderCandidates(candidates, scope) {
  const list = document.getElementById('mcCandidateList');
  clearChildren(list);
  if (!candidates.length) {
    list.appendChild(makeEl('p', { text: 'No matches found.', style: 'color:#94a3b8' }));
    return;
  }
  list.appendChild(makeEl('p', {
    text: `Top ${candidates.length} candidates (${scope}):`,
    style: 'color:#94a3b8'
  }));
  candidates.forEach(v => {
    const row = makeEl('div', {
      cls: 'candidate-card',
      style: 'padding:10px;border:1px solid #334155;border-radius:6px;margin:6px 0;cursor:pointer'
    });
    row.appendChild(makeEl('strong', { text: `${v.firstName} ${v.lastName}` }));
    row.appendChild(makeEl('span', { text: ` · age ${v.age}` }));
    row.appendChild(document.createElement('br'));
    row.appendChild(makeEl('span', {
      text: `${v.address || ''}, ${v.city || ''}`,
      style: 'color:#94a3b8'
    }));
    row.appendChild(document.createElement('br'));
    row.appendChild(makeEl('span', {
      text: `Current phone: ${v.currentPhone || '(none)'} · Score: ${v.score.toFixed(2)}`,
      style: 'color:#64748b'
    }));
    row.addEventListener('click', () => confirmMatch(v.voterId, window._mcContacts[window._mcIndex].phone));
    list.appendChild(row);
  });
}

async function confirmMatch(voterId, phone) {
  if (!confirm('Update this voter\'s phone to ' + phone + '?')) return;
  const r = await fetch('/api/captain/confirm-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voterId, phone }),
  });
  const data = await r.json();
  if (data.success) {
    window._mcResults.matched++;
    showActionMenu(voterId, phone);
  } else {
    alert('Update failed: ' + (data.error || 'unknown'));
  }
}

function showActionMenu(voterId, phone) {
  const menu = document.getElementById('mcActionMenu');
  clearChildren(menu);
  menu.style.display = 'block';
  menu.appendChild(makeEl('p', { text: 'Updated.' }));
  const c = window._mcContacts[window._mcIndex];
  const textBtn = makeEl('button', { text: 'Text now' });
  textBtn.addEventListener('click', () => textVoter(c, phone));
  const nextBtn = makeEl('button', { text: 'Next contact', style: 'margin-left:8px' });
  nextBtn.addEventListener('click', advance);
  menu.appendChild(textBtn);
  menu.appendChild(nextBtn);
}

function textVoter(contact, phone) {
  const captainName = (window.captainState && window.captainState.captain && window.captainState.captain.name) || 'your block captain';
  const body = `Hi ${contact.firstName}, this is ${captainName}.`;
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // Phase 2 hook — replaced after SMS plugin install in Task 18
    if (window.Capacitor.Plugins.SMS) {
      window.Capacitor.Plugins.SMS.send({ numbers: [phone], text: body });
    }
  } else {
    window.location.href = `sms:${phone}&body=${encodeURIComponent(body)}`;
  }
}

document.getElementById('mcSkipBtn').addEventListener('click', () => {
  window._mcResults.skipped++;
  advance();
});

function advance() {
  window._mcIndex++;
  renderCurrentContact();
}

function finishWizard() {
  document.getElementById('mcStep2').style.display = 'none';
  document.getElementById('mcStep3').style.display = 'block';
  document.getElementById('mcSummary').textContent =
    `${window._mcResults.matched} matched · ${window._mcResults.skipped} skipped`;
}

document.getElementById('mcCloseBtn').addEventListener('click', () => {
  document.getElementById('matchContactsModal').style.display = 'none';
});

document.getElementById('matchContactsBtn').addEventListener('click', () => {
  document.getElementById('mcStep1').style.display = 'block';
  document.getElementById('mcStep2').style.display = 'none';
  document.getElementById('mcStep3').style.display = 'none';
  document.getElementById('matchContactsModal').style.display = 'block';
});
```

**Step 2: Manual end-to-end test:**

1. Start server: `node server.js`
2. Open captain.html in a browser, log in as a captain.
3. Make a tiny test vCard (or export a few contacts from iPhone Contacts).
4. Click "Match from My Contacts" → upload `.vcf`.
5. For each contact: enter age → tap Find Matches → tap correct candidate → confirm → tap Next.
6. Verify final summary shows "N matched, M skipped".
7. Verify DB updates:
   ```bash
   sqlite3 campaign.db "SELECT id, first_name, last_name, phone, phone_validated_at FROM voters WHERE phone_validated_at IS NOT NULL ORDER BY phone_validated_at DESC LIMIT 5;"
   ```

**Step 3: Commit and push**

```bash
git add public/captain.html
git commit -m "feat: wire up captain contact matching wizard end-to-end"
git push origin main && git push campaigntext main
```

---

### Task 12: Phase 1 verification checkpoint

Before moving to Phase 2, verify all of the following:

- [ ] `node tests/test-name-matching.js` → 19 passed, 0 failed
- [ ] `node tests/test-captain-match.js` → 10 passed, 0 failed
- [ ] `node tests/test-captain-sim.js` → still passes (no regressions)
- [ ] Manual: real vCard from iPhone, complete wizard for ≥3 contacts, verify DB updates
- [ ] Manual: text button on web fallback opens iPhone Messages with pre-filled body
- [ ] Web app continues to work for everything else (no regressions to other captain features)

If all pass, Phase 1 is **complete**. **Stop and ask the user before starting Phase 2** — Phase 2 requires an Apple Developer Program enrollment that costs $99 and takes 24-48 hours of waiting.

---

## Phase 2 — Capacitor wrapper + TestFlight (Tasks 13-22)

> **Pre-requisite — manual user action:** Enroll in [Apple Developer Program](https://developer.apple.com/programs/enroll/) ($99/yr). Approval can take 24-48 hours. Recommend starting this in parallel with Phase 1 if not already done.

### Task 13: Install Capacitor

```bash
cd /Users/luisvillarreal/campaign-text-hq
npm install @capacitor/core @capacitor/cli
npx cap init "CampaignText" "com.campaigntext.app" --web-dir=public
```

Commit:

```bash
git add package.json package-lock.json capacitor.config.ts capacitor.config.json 2>/dev/null
git commit -m "feat: initialize Capacitor"
git push origin main && git push campaigntext main
```

### Task 14: Add iOS platform

```bash
npm install @capacitor/ios
npx cap add ios
```

Commit:

```bash
git add ios/ package.json package-lock.json
git commit -m "feat: add Capacitor iOS platform"
git push origin main && git push campaigntext main
```

### Task 15: Install native Contacts plugin

```bash
npm install @capacitor-community/contacts
npx cap sync ios
```

Add `NSContactsUsageDescription` to `ios/App/App/Info.plist`:

```xml
<key>NSContactsUsageDescription</key>
<string>CampaignText uses your contacts to help you match voters and update phone numbers.</string>
```

Commit:

```bash
git add ios/ package.json package-lock.json
git commit -m "feat: add Capacitor Contacts plugin + Info.plist permission"
git push origin main && git push campaigntext main
```

### Task 16: Install SMS / message-composer plugin

Search npm for currently maintained options (verify before installing — abandoned plugins are common):
- `@capacitor-community/sms`
- `capacitor-plugin-sms-manager`
- Or write a thin custom plugin around `MFMessageComposeViewController` if no maintained option exists.

```bash
npm install <chosen-plugin>
npx cap sync ios
```

Commit accordingly.

### Task 17: Add native Contact Picker branch in `captain.html`

In Step 1 of the modal, conditionally show a "Pick from iPhone Contacts" button when running natively:

```js
async function pickNativeContact() {
  const { Contacts } = window.Capacitor.Plugins;
  await Contacts.requestPermissions();
  const result = await Contacts.pickContact({ projection: { name: true, phones: true } });
  return [{
    firstName: (result.contact && result.contact.name && result.contact.name.given) || '',
    lastName: (result.contact && result.contact.name && result.contact.name.family) || '',
    phone: (result.contact && result.contact.phones && result.contact.phones[0] && result.contact.phones[0].number) || '',
  }];
}

// Show the native picker button only when running inside Capacitor
if (window.Capacitor?.isNativePlatform?.()) {
  const btn = document.createElement('button');
  btn.textContent = 'Pick from iPhone Contacts';
  btn.addEventListener('click', async () => {
    const contacts = await pickNativeContact();
    window._mcContacts = contacts;
    window._mcIndex = 0;
    window._mcResults = { matched: 0, skipped: 0 };
    document.getElementById('mcStep1').style.display = 'none';
    document.getElementById('mcStep2').style.display = 'block';
    renderCurrentContact();
  });
  document.getElementById('mcStep1').appendChild(btn);
}
```

Commit:

```bash
git add public/captain.html
git commit -m "feat: native iPhone Contact picker branch (Capacitor)"
git push origin main && git push campaigntext main
```

### Task 18: Replace SMS URL placeholder with real plugin call

In `textVoter()`, replace the placeholder with the chosen plugin's actual API. Verify the plugin docs for the correct method name and argument shape — exact call may differ. The web fallback (`sms:` URL) stays unchanged.

Commit.

### Task 19: Build & run on iOS Simulator

```bash
npx cap open ios
```

In Xcode:
1. Select an iPhone simulator (e.g. iPhone 15).
2. Click Run.
3. App launches in simulator. Log in as a captain. Open Match Contacts modal.
4. Verify "Pick from iPhone Contacts" button appears (only in native build).
5. Verify the picker shows the simulator's seeded contacts (you may need to add a few contacts in the Simulator's Contacts app).
6. Verify the message compose sheet appears when tapping Text (Simulator can't actually send SMS, but the sheet should appear).

Common build fixes if anything fails:
- `cd ios/App && pod install`, then re-open Xcode.
- Set Signing Team in Xcode → Signing & Capabilities (any team works for simulator).

No commit (no source changes).

### Task 20: USER ACTION — Apple Developer Program enrollment

User must:
1. Sign up at https://developer.apple.com/programs/enroll/.
2. Pay $99 USD.
3. Wait 24-48hrs for approval.
4. Add Apple ID account in Xcode → Settings → Accounts.

Claude cannot complete this task — it's a manual checkpoint.

### Task 21: Generate signing certificate + create App Store Connect record

In Xcode → Signing & Capabilities:
- Check "Automatically manage signing"
- Select your Team
- Bundle ID: `com.campaigntext.app` (matches Task 13)

In App Store Connect (https://appstoreconnect.apple.com):
- Create new app, same bundle ID
- Set name, primary language, SKU

### Task 22: Archive + upload to TestFlight

In Xcode:
1. Select **Any iOS Device (arm64)** as target (not simulator).
2. Product → Archive (5-15 min build).
3. In the Archives window, click **Distribute App** → **App Store Connect** → **Upload**.
4. Wait 5-30 min for processing in App Store Connect.
5. App Store Connect → TestFlight tab → add internal testers (your Apple ID email).
6. Install TestFlight app on your iPhone.
7. Receive TestFlight invite email → install build → log in as a captain → run full matching+texting flow on real contacts.

**Verification on a real device:**
- [ ] Native picker shows your real iPhone contacts.
- [ ] Tap a candidate → confirm → DB updates (verify by logging into the web app and checking the voter's phone).
- [ ] Tap "Text" → iOS message sheet appears OVER the app.
- [ ] Tap Send → message sends from your personal number → instantly back in the app.
- [ ] Open Messages app — sent message is in your history.

If all pass: Phase 2 done. Feature shipped.

---

## Done criteria

- All Phase 1 tests pass (`19 + 10 + existing` passing, 0 failing).
- Phase 1 wizard works end-to-end on web with real vCard upload.
- Phase 2 TestFlight build installs on iPhone.
- Native picker AND native SMS sheet both work on a real device.
- `voters.phone` updates persist to the database from native flow.
- Memory rule honored: captain can update any voter's phone, no list-membership block.
- Web version of captain.html continues to work for non-iOS users.
