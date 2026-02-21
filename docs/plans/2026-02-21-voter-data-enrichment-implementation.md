# Voter Data Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import purchased voter data lists to enrich existing voter records with phone numbers, flagging conflicts for manual review.

**Architecture:** Two new API endpoints in `routes/voters.js` handle matching and conflict resolution. Frontend adds an "Enrich Data" button and a 3-step card UI (upload, preview/map, results with conflict resolution) in `public/index.html`, reusing the existing quote-aware CSV parser. All DOM built with safe methods (createElement, textContent, appendChild) — no innerHTML.

**Tech Stack:** Express.js, better-sqlite3, vanilla JS (no new dependencies)

---

### Task 1: Backend — Enrich Endpoint

**Files:**
- Modify: `routes/voters.js` (insert after line 171, before line 173 `// Get voter detail`)

**Step 1: Add the `POST /api/voters/enrich` endpoint**

Insert after line 171 (after the `import-canvass` endpoint closing) and before line 173:

```javascript
// --- Enrich voter data from purchased lists ---
router.post('/voters/enrich', (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided.' });

  const allVoters = db.prepare("SELECT id, first_name, last_name, phone, address, registration_number FROM voters").all();
  const regMap = {};
  for (const v of allVoters) {
    if (v.registration_number && v.registration_number.trim()) {
      regMap[v.registration_number.trim()] = v;
    }
  }

  const findByNameAddr = db.prepare(
    "SELECT id, phone FROM voters WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND address != '' AND LOWER(address) LIKE ? LIMIT 1"
  );
  const updatePhone = db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?");

  const results = {
    total: rows.length, filled: 0, skipped: 0,
    conflicts: [], unmatched: [],
    match_details: { by_voter_id: 0, by_name_address: 0 }
  };

  const enrichTx = db.transaction((rowList) => {
    for (const row of rowList) {
      let voter = null;
      let matchMethod = '';

      // 1. Voter ID / registration number match
      if (row.voter_id && row.voter_id.trim()) {
        const found = regMap[row.voter_id.trim()];
        if (found) { voter = found; matchMethod = 'voter_id'; }
      }

      // 2. Name + address fallback
      if (!voter && row.first_name && row.last_name && row.address) {
        const addrWords = row.address.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (addrWords) {
          const found = findByNameAddr.get(row.first_name, row.last_name, addrWords + '%');
          if (found) { voter = found; matchMethod = 'name_address'; }
        }
      }

      if (!voter) {
        results.unmatched.push({
          first_name: row.first_name || '', last_name: row.last_name || '',
          phone: row.phone || '', address: row.address || '',
          city: row.city || '', zip: row.zip || '', voter_id: row.voter_id || ''
        });
        continue;
      }

      results.match_details['by_' + matchMethod]++;
      const newPhone = (row.phone || '').trim();
      const currentPhone = (voter.phone || '').trim();

      if (!currentPhone && newPhone) {
        updatePhone.run(newPhone, voter.id);
        results.filled++;
      } else if (currentPhone && newPhone && phoneDigits(currentPhone) !== phoneDigits(newPhone)) {
        results.conflicts.push({
          voter_id: voter.id,
          name: (voter.first_name || row.first_name || '') + ' ' + (voter.last_name || row.last_name || ''),
          current_phone: currentPhone,
          new_phone: newPhone
        });
      } else {
        results.skipped++;
      }
    }
  });

  enrichTx(rows);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Data enrichment: ' + results.filled + ' phones added, ' + results.conflicts.length + ' conflicts, ' + results.unmatched.length + ' unmatched'
  );

  res.json({ success: true, ...results });
});
```

**Step 2: Verify the server starts**

Run: `cd /Users/luisvillarreal/campaign-text-hq && node -e "require('./routes/voters')"`
Expected: No errors

**Step 3: Commit**

```bash
git add routes/voters.js
git commit -m "feat: add POST /api/voters/enrich endpoint for data enrichment matching"
```

---

### Task 2: Backend — Conflict Resolution Endpoint

**Files:**
- Modify: `routes/voters.js` (insert immediately after the `enrich` endpoint added in Task 1)

**Step 1: Add the `POST /api/voters/enrich/resolve` endpoint**

```javascript
// Resolve phone conflicts from enrichment
router.post('/voters/enrich/resolve', (req, res) => {
  const { resolutions } = req.body;
  if (!resolutions || !resolutions.length) return res.status(400).json({ error: 'No resolutions provided.' });

  const updatePhone = db.prepare("UPDATE voters SET phone = ?, updated_at = datetime('now') WHERE id = ?");
  const resolveTx = db.transaction((list) => {
    let updated = 0;
    for (const r of list) {
      if (r.voter_id && r.phone) {
        updatePhone.run(r.phone, r.voter_id);
        updated++;
      }
    }
    return updated;
  });

  const updated = resolveTx(resolutions);

  db.prepare('INSERT INTO activity_log (message) VALUES (?)').run(
    'Enrichment conflicts resolved: ' + updated + ' phone numbers updated'
  );

  res.json({ success: true, updated });
});
```

**Step 2: Verify the server starts**

Run: `cd /Users/luisvillarreal/campaign-text-hq && node -e "require('./routes/voters')"`
Expected: No errors

**Step 3: Commit**

```bash
git add routes/voters.js
git commit -m "feat: add POST /api/voters/enrich/resolve for conflict resolution"
```

---

### Task 3: Frontend — Enrich Button + Card HTML

**Files:**
- Modify: `public/index.html` (2 insertion points)

**Step 1: Add "Enrich Data" button**

On line 474, after the "Import Canvass Data" button and before the closing `</div>` on line 475, insert:

```html
          <button class="btn btn-sm" id="btnEnrichData" style="margin-left:8px;background:#059669;border-color:#047857;color:#fff">&#128270; Enrich Data</button>
```

**Step 2: Add the enrichment card HTML**

After line 506 (end of `importVotersCard`) and before line 507 (`<!-- Import Canvass Data`), insert:

```html
        <!-- Enrich Voter Data (3-step: Upload → Preview → Results) -->
        <div class="card" id="enrichDataCard" style="display:none">
          <h3>&#128270; Enrich Voter Data</h3>
          <p style="color:#94a3b8;margin-bottom:12px;font-size:13px">
            Upload a purchased data list (CSV) to add phone numbers to existing voters.
            Matches by Voter ID first, then name + address.
          </p>
          <!-- Step 1: Upload -->
          <div id="enrichStep1">
            <div class="form-group" style="margin-bottom:12px">
              <label>Upload CSV File</label>
              <input type="file" id="enrichFile" accept=".csv,.txt" style="margin-top:4px">
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label>Or Paste CSV Data</label>
              <textarea id="enrichCsvData" rows="6" placeholder="VoterID,FirstName,LastName,Phone,Address,City,Zip&#10;12345,John,Doe,5125551234,123 Main St,Austin,78701"></textarea>
            </div>
            <button class="btn btn-primary btn-sm" onclick="previewEnrichment()">Preview &amp; Map Columns</button>
            <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="closeEnrichment()">Cancel</button>
          </div>
          <!-- Step 2: Column Mapping + Preview -->
          <div id="enrichStep2" style="display:none">
            <h4 style="margin-bottom:8px">Column Mapping</h4>
            <div id="enrichColumnMap" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px"></div>
            <h4 style="margin-bottom:8px">Preview (first 5 rows)</h4>
            <div class="table-wrap" style="margin-bottom:16px"><table id="enrichPreviewTable"><thead></thead><tbody></tbody></table></div>
            <button class="btn btn-success btn-sm" onclick="executeEnrichment()">&#128270; Run Enrichment</button>
            <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="showEnrichStep(1)">Back</button>
            <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="closeEnrichment()">Cancel</button>
          </div>
          <!-- Step 3: Results + Conflict Resolution -->
          <div id="enrichStep3" style="display:none">
            <div id="enrichSummary" style="margin-bottom:16px"></div>
            <div id="enrichConflicts" style="margin-bottom:16px"></div>
            <div id="enrichUnmatched" style="margin-bottom:16px"></div>
            <button class="btn btn-primary btn-sm" onclick="closeEnrichment()">Done</button>
          </div>
        </div>
```

**Step 3: Add click handler for the button**

Find the line with `document.getElementById('btnImportCanvass')` event listener. Add the enrich button handler right after it:

```javascript
document.getElementById('btnEnrichData').onclick = function() {
  document.getElementById('enrichDataCard').style.display = document.getElementById('enrichDataCard').style.display === 'none' ? '' : 'none';
};
```

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: enrich data button and 3-step card UI in voter file"
```

---

### Task 4: Frontend — Column Mapping Dictionary + State

**Files:**
- Modify: `public/index.html` (insert JS after line 1405, after `window.closeCanvassImport = closeCanvassImport;`)

**Step 1: Add the column mapping dictionary and state variables**

```javascript
// ===================== ENRICH DATA =====================
const ENRICH_COLUMN_MAP = {
  'voterid': 'voter_id', 'voter_id': 'voter_id', 'voter id': 'voter_id',
  'vanid': 'voter_id', 'van id': 'voter_id', 'id': 'voter_id',
  'registrationnumber': 'voter_id', 'registration_number': 'voter_id',
  'reg_num': 'voter_id', 'regnum': 'voter_id', 'voterregid': 'voter_id',
  'stateid': 'voter_id', 'state_id': 'voter_id', 'state id': 'voter_id',
  'firstname': 'first_name', 'first_name': 'first_name', 'first name': 'first_name',
  'first': 'first_name', 'fname': 'first_name', 'givenname': 'first_name',
  'lastname': 'last_name', 'last_name': 'last_name', 'last name': 'last_name',
  'last': 'last_name', 'lname': 'last_name', 'surname': 'last_name',
  'phone': 'phone', 'telephone': 'phone', 'tel': 'phone', 'phonenumber': 'phone',
  'phone_number': 'phone', 'phone number': 'phone', 'cell': 'phone',
  'cellphone': 'phone', 'cell_phone': 'phone', 'mobile': 'phone',
  'homephone': 'phone', 'home_phone': 'phone',
  'address': 'address', 'streetaddress': 'address', 'street_address': 'address',
  'street address': 'address', 'addr': 'address', 'street': 'address',
  'address1': 'address', 'mailingaddress': 'address',
  'city': 'city', 'town': 'city', 'municipality': 'city',
  'zip': 'zip', 'zipcode': 'zip', 'zip_code': 'zip', 'zip code': 'zip',
  'postalcode': 'zip', 'postal_code': 'zip', 'postal code': 'zip',
  'email': 'email', 'emailaddress': 'email', 'email_address': 'email'
};

const ENRICH_FIELDS = ['voter_id','first_name','last_name','phone','address','city','zip','email'];
const ENRICH_LABELS = { voter_id: 'Voter ID', first_name: 'First Name', last_name: 'Last Name', phone: 'Phone', address: 'Address', city: 'City', zip: 'ZIP', email: 'Email' };

let enrichRawHeaders = [];
let enrichAutoMap = [];
let enrichParsedRows = [];
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: enrich column mapping dictionary and state variables"
```

---

### Task 5: Frontend — Preview, Navigation, and Parse Functions

**Files:**
- Modify: `public/index.html` (insert JS immediately after Task 4 code)

**Step 1: Add navigation helpers and preview function**

All DOM manipulation uses safe methods (createElement, textContent, appendChild). Use `el.replaceChildren()` to clear containers.

```javascript
function showEnrichStep(n) {
  document.getElementById('enrichStep1').style.display = n === 1 ? '' : 'none';
  document.getElementById('enrichStep2').style.display = n === 2 ? '' : 'none';
  document.getElementById('enrichStep3').style.display = n === 3 ? '' : 'none';
}

function closeEnrichment() {
  document.getElementById('enrichDataCard').style.display = 'none';
  document.getElementById('enrichCsvData').value = '';
  document.getElementById('enrichFile').value = '';
  enrichRawHeaders = []; enrichAutoMap = []; enrichParsedRows = [];
  showEnrichStep(1);
  searchVoters();
}

window.previewEnrichment = function() {
  const fileInput = document.getElementById('enrichFile');
  if (fileInput.files && fileInput.files[0]) {
    const reader = new FileReader();
    reader.onload = function() { processEnrichCsv(reader.result); };
    reader.readAsText(fileInput.files[0]);
  } else {
    const raw = document.getElementById('enrichCsvData').value.trim();
    if (!raw) return alert('Please upload a CSV file or paste data.');
    processEnrichCsv(raw);
  }
};

function processEnrichCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return alert('CSV must have a header row and at least one data row.');

  enrichRawHeaders = parseCanvassCsvLine(lines[0]);

  // Auto-map headers
  enrichAutoMap = enrichRawHeaders.map(h => {
    const key = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ENRICH_COLUMN_MAP[key] || ENRICH_COLUMN_MAP[h.toLowerCase().trim()] || '';
  });

  // Parse data rows
  enrichParsedRows = [];
  for (let i = 1; i < lines.length; i++) {
    enrichParsedRows.push(parseCanvassCsvLine(lines[i]));
  }

  // Build column mapping dropdowns
  const mapContainer = document.getElementById('enrichColumnMap');
  mapContainer.replaceChildren();
  enrichRawHeaders.forEach((header, idx) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;min-width:140px';
    const label = document.createElement('label');
    label.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:2px';
    label.textContent = header;
    wrapper.appendChild(label);
    const select = document.createElement('select');
    select.id = 'enrichMap_' + idx;
    select.style.cssText = 'padding:4px 6px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;font-size:13px';
    const skipOpt = document.createElement('option');
    skipOpt.value = '';
    skipOpt.textContent = '-- Skip --';
    select.appendChild(skipOpt);
    ENRICH_FIELDS.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = ENRICH_LABELS[f];
      if (enrichAutoMap[idx] === f) opt.selected = true;
      select.appendChild(opt);
    });
    wrapper.appendChild(select);
    mapContainer.appendChild(wrapper);
  });

  // Build preview table (first 5 rows)
  const table = document.getElementById('enrichPreviewTable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.replaceChildren();
  tbody.replaceChildren();
  const headerRow = document.createElement('tr');
  enrichRawHeaders.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  const previewCount = Math.min(5, enrichParsedRows.length);
  for (let i = 0; i < previewCount; i++) {
    const tr = document.createElement('tr');
    enrichRawHeaders.forEach((_, ci) => {
      const td = document.createElement('td');
      td.textContent = enrichParsedRows[i][ci] || '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  showEnrichStep(2);
}

window.showEnrichStep = showEnrichStep;
window.closeEnrichment = closeEnrichment;
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: enrich data preview with column mapping and CSV parsing"
```

---

### Task 6: Frontend — Execute Enrichment + Results + Conflict Resolution

**Files:**
- Modify: `public/index.html` (insert JS immediately after Task 5 code)

**Step 1: Add executeEnrichment and resolveConflicts functions**

All DOM built with safe methods — no innerHTML anywhere.

```javascript
window.executeEnrichment = async function() {
  const colMap = enrichRawHeaders.map((_, idx) => {
    const sel = document.getElementById('enrichMap_' + idx);
    return sel ? sel.value : '';
  });

  const rows = enrichParsedRows.map(cols => {
    const obj = {};
    cols.forEach((val, ci) => {
      const field = colMap[ci];
      if (field) obj[field] = val;
    });
    return obj;
  }).filter(r => r.voter_id || (r.first_name && r.last_name));

  if (rows.length === 0) return alert('No valid rows found. Make sure Voter ID or Name columns are mapped.');

  try {
    const d = await apiPost('/api/voters/enrich', { rows });
    if (!d.success) return alert('Enrichment failed: ' + (d.error || 'Unknown error'));

    // Summary bar
    const summary = document.getElementById('enrichSummary');
    summary.replaceChildren();
    const summaryDiv = document.createElement('div');
    summaryDiv.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px';
    const stats = [
      { label: 'Phones Added', value: d.filled, color: '#10b981' },
      { label: 'Already Same', value: d.skipped, color: '#64748b' },
      { label: 'Conflicts', value: d.conflicts.length, color: '#f59e0b' },
      { label: 'Unmatched', value: d.unmatched.length, color: '#ef4444' }
    ];
    stats.forEach(s => {
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e293b;padding:12px 20px;border-radius:8px;text-align:center;min-width:100px';
      const num = document.createElement('div');
      num.style.cssText = 'font-size:24px;font-weight:700;color:' + s.color;
      num.textContent = s.value;
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:12px;color:#94a3b8;margin-top:4px';
      lbl.textContent = s.label;
      box.appendChild(num);
      box.appendChild(lbl);
      summaryDiv.appendChild(box);
    });
    summary.appendChild(summaryDiv);

    if (d.match_details) {
      const breakdown = document.createElement('div');
      breakdown.style.cssText = 'font-size:13px;color:#94a3b8;margin-top:8px';
      breakdown.textContent = 'Matched: ' + (d.match_details.by_voter_id || 0) + ' by Voter ID, ' + (d.match_details.by_name_address || 0) + ' by name+address';
      summary.appendChild(breakdown);
    }

    // Conflicts table
    const conflictsDiv = document.getElementById('enrichConflicts');
    conflictsDiv.replaceChildren();
    if (d.conflicts.length > 0) {
      const heading = document.createElement('h4');
      heading.style.cssText = 'color:#f59e0b;margin-bottom:8px';
      heading.textContent = 'Phone Conflicts (' + d.conflicts.length + ') \u2014 Select which number to keep:';
      conflictsDiv.appendChild(heading);

      const table = document.createElement('table');
      const cThead = document.createElement('thead');
      const hRow = document.createElement('tr');
      ['Voter', 'Current Phone', 'New Phone', 'Keep'].forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        hRow.appendChild(th);
      });
      cThead.appendChild(hRow);
      table.appendChild(cThead);

      const cTbody = document.createElement('tbody');
      d.conflicts.forEach((c, i) => {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.textContent = c.name;
        tr.appendChild(tdName);
        const tdCurrent = document.createElement('td');
        tdCurrent.textContent = c.current_phone;
        tr.appendChild(tdCurrent);
        const tdNew = document.createElement('td');
        tdNew.textContent = c.new_phone;
        tr.appendChild(tdNew);

        const tdRadio = document.createElement('td');
        tdRadio.style.cssText = 'display:flex;gap:12px;align-items:center';
        const lCur = document.createElement('label');
        lCur.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer';
        const rCur = document.createElement('input');
        rCur.type = 'radio'; rCur.name = 'conflict_' + i;
        rCur.value = c.current_phone; rCur.checked = true;
        rCur.dataset.voterId = c.voter_id;
        lCur.appendChild(rCur);
        lCur.appendChild(document.createTextNode('Current'));
        tdRadio.appendChild(lCur);
        const lNew = document.createElement('label');
        lNew.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer';
        const rNew = document.createElement('input');
        rNew.type = 'radio'; rNew.name = 'conflict_' + i;
        rNew.value = c.new_phone;
        rNew.dataset.voterId = c.voter_id;
        lNew.appendChild(rNew);
        lNew.appendChild(document.createTextNode('New'));
        tdRadio.appendChild(lNew);
        tr.appendChild(tdRadio);
        cTbody.appendChild(tr);
      });
      table.appendChild(cTbody);

      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.appendChild(table);
      conflictsDiv.appendChild(wrap);

      conflictsDiv.dataset.count = d.conflicts.length;
      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'btn btn-sm';
      resolveBtn.style.cssText = 'margin-top:8px;background:#f59e0b;border-color:#d97706;color:#000;font-weight:600';
      resolveBtn.textContent = 'Apply Selected Phones';
      resolveBtn.onclick = resolveConflicts;
      conflictsDiv.appendChild(resolveBtn);
    }

    // Unmatched table
    const unmatchedDiv = document.getElementById('enrichUnmatched');
    unmatchedDiv.replaceChildren();
    if (d.unmatched.length > 0) {
      const heading = document.createElement('h4');
      heading.style.cssText = 'color:#ef4444;margin-bottom:8px';
      heading.textContent = 'Unmatched Records (' + d.unmatched.length + ') \u2014 Could not find these voters:';
      unmatchedDiv.appendChild(heading);
      const table = document.createElement('table');
      const uThead = document.createElement('thead');
      const uhRow = document.createElement('tr');
      ['Voter ID', 'Name', 'Phone', 'Address'].forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        uhRow.appendChild(th);
      });
      uThead.appendChild(uhRow);
      table.appendChild(uThead);
      const uTbody = document.createElement('tbody');
      d.unmatched.forEach(u => {
        const tr = document.createElement('tr');
        const tdId = document.createElement('td');
        tdId.textContent = u.voter_id || '-';
        tr.appendChild(tdId);
        const tdName = document.createElement('td');
        tdName.textContent = (u.first_name + ' ' + u.last_name).trim() || '-';
        tr.appendChild(tdName);
        const tdPhone = document.createElement('td');
        tdPhone.textContent = u.phone || '-';
        tr.appendChild(tdPhone);
        const tdAddr = document.createElement('td');
        tdAddr.textContent = [u.address, u.city, u.zip].filter(Boolean).join(', ') || '-';
        tr.appendChild(tdAddr);
        uTbody.appendChild(tr);
      });
      table.appendChild(uTbody);
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.appendChild(table);
      unmatchedDiv.appendChild(wrap);
    }

    showEnrichStep(3);
  } catch(e) {
    alert('Enrichment failed: ' + (e.message || 'Unknown error'));
  }
};

async function resolveConflicts() {
  const count = parseInt(document.getElementById('enrichConflicts').dataset.count || '0');
  const resolutions = [];
  for (let i = 0; i < count; i++) {
    const selected = document.querySelector('input[name="conflict_' + i + '"]:checked');
    if (selected) {
      resolutions.push({ voter_id: parseInt(selected.dataset.voterId), phone: selected.value });
    }
  }
  if (resolutions.length === 0) return alert('No conflicts to resolve.');

  try {
    const d = await apiPost('/api/voters/enrich/resolve', { resolutions });
    if (d.success) {
      alert('Updated ' + d.updated + ' phone number(s).');
      const conflictsDiv = document.getElementById('enrichConflicts');
      conflictsDiv.replaceChildren();
      const doneMsg = document.createElement('div');
      doneMsg.style.cssText = 'color:#10b981;font-size:14px;margin-bottom:8px';
      doneMsg.textContent = 'All conflicts resolved.';
      conflictsDiv.appendChild(doneMsg);
    } else {
      alert('Resolution failed: ' + (d.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Resolution failed: ' + (e.message || 'Unknown error'));
  }
}

window.resolveConflicts = resolveConflicts;
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: enrichment execution, results display, and conflict resolution UI"
```

---

### Task 7: End-to-End Verification

**Step 1: Start the server**

Run: `cd /Users/luisvillarreal/campaign-text-hq && node server.js`

**Step 2: Create test voters via API**

```bash
curl -s -X POST http://localhost:3000/api/voters \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"TestLuis","last_name":"Enrich","phone":"","address":"123 Main St","city":"Austin","zip":"78701","registration_number":"REG001"}'

curl -s -X POST http://localhost:3000/api/voters \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"TestMaria","last_name":"Enrich","phone":"+15125551111","address":"456 Oak Ave","city":"Austin","zip":"78702","registration_number":"REG002"}'
```

**Step 3: Test enrichment via API**

```bash
curl -s -X POST http://localhost:3000/api/voters/enrich \
  -H 'Content-Type: application/json' \
  -d '{"rows":[
    {"voter_id":"REG001","first_name":"TestLuis","last_name":"Enrich","phone":"5125559999","address":"123 Main St"},
    {"voter_id":"REG002","first_name":"TestMaria","last_name":"Enrich","phone":"5125552222","address":"456 Oak Ave"},
    {"voter_id":"REG999","first_name":"New","last_name":"Person","phone":"5125553333","address":"789 Elm Rd"}
  ]}'
```

Expected: `filled: 1`, `conflicts` array with 1 entry, `unmatched` array with 1 entry.

**Step 4: Verify in browser**

Navigate to Voter File and verify the button and 3-step flow work visually.

**Step 5: Clean up test voters, commit, push**

```bash
git add -A && git commit -m "feat: voter data enrichment complete" && git push origin main
```
