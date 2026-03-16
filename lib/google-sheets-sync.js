const { OAuth2Client } = require('google-auth-library');
const { sheets: sheetsApi } = require('@googleapis/sheets');
const db = require('../db');

// ---------------------------------------------------------------------------
// Get an authenticated OAuth2 client for a given user (auto-refreshes tokens)
// ---------------------------------------------------------------------------
async function getAuthenticatedClient(userId) {
  const user = db.prepare(`SELECT google_access_token, google_refresh_token, google_token_expiry
    FROM users WHERE id = ?`).get(userId);

  if (!user || !user.google_access_token) return null;

  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: user.google_token_expiry ? new Date(user.google_token_expiry).getTime() : 0
  });

  // Check if token needs refresh
  const now = Date.now();
  const expiry = user.google_token_expiry ? new Date(user.google_token_expiry).getTime() : 0;
  if (expiry && expiry < now + 60000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);

      // Save refreshed tokens back to DB
      db.prepare(`UPDATE users SET
        google_access_token = ?,
        google_refresh_token = CASE WHEN ? != '' THEN ? ELSE google_refresh_token END,
        google_token_expiry = ?
        WHERE id = ?`).run(
        credentials.access_token,
        credentials.refresh_token || '', credentials.refresh_token || '',
        credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : '',
        userId
      );
    } catch (err) {
      console.error('Token refresh failed:', err.message);
      return null;
    }
  }

  return client;
}

// ---------------------------------------------------------------------------
// Create the backup spreadsheet with 3 tabs
// ---------------------------------------------------------------------------
async function createSpreadsheet(auth) {
  const sheets = sheetsApi({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'Campaign HQ Data — Auto Backup' },
      sheets: [
        { properties: { title: 'Voters', index: 0 } },
        { properties: { title: 'Contacts', index: 1 } },
        { properties: { title: 'Messages', index: 2 } }
      ]
    }
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId;

  // Write header rows
  const voterHeaders = [['ID', 'First Name', 'Last Name', 'Phone', 'Email', 'Address', 'City', 'ZIP',
    'Party', 'Support Level', 'Voter Score', 'Tags', 'Notes', 'Registration #', 'Voting History', 'Created', 'Updated']];
  const contactHeaders = [['ID', 'Phone', 'First Name', 'Last Name', 'City', 'Email', 'Created']];
  const messageHeaders = [['ID', 'Phone', 'Body', 'Direction', 'Sentiment', 'Timestamp']];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: 'Voters!A1', values: voterHeaders },
        { range: 'Contacts!A1', values: contactHeaders },
        { range: 'Messages!A1', values: messageHeaders }
      ]
    }
  });

  // Bold the header rows
  const sheetIds = spreadsheet.data.sheets.map(s => s.properties.sheetId);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: sheetIds.map(sheetId => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      }))
    }
  });

  return spreadsheetId;
}

// ---------------------------------------------------------------------------
// Full sync — write all data to the Google Sheet
// ---------------------------------------------------------------------------
async function syncToSheets(auth, spreadsheetId) {
  const sheets = sheetsApi({ version: 'v4', auth });

  // Pull all data from SQLite
  const voters = db.prepare(`SELECT id, first_name, last_name, phone, email, address, city, zip,
    party, support_level, voter_score, tags, notes, registration_number, voting_history,
    created_at, updated_at FROM voters ORDER BY id`).all();

  const contacts = db.prepare(`SELECT id, phone, first_name, last_name, city, email, created_at
    FROM contacts ORDER BY id`).all();

  const messages = db.prepare(`SELECT id, phone, body, direction, sentiment, timestamp
    FROM messages ORDER BY id`).all();

  // Convert to 2D arrays
  const voterRows = voters.map(v => [
    v.id, v.first_name, v.last_name, v.phone, v.email, v.address, v.city, v.zip,
    v.party, v.support_level, v.voter_score, v.tags, v.notes, v.registration_number, v.voting_history,
    v.created_at, v.updated_at
  ]);

  const contactRows = contacts.map(c => [
    c.id, c.phone, c.first_name, c.last_name, c.city, c.email, c.created_at
  ]);

  const messageRows = messages.map(m => [
    m.id, m.phone, m.body, m.direction, m.sentiment, m.timestamp
  ]);

  // Clear existing data (keep headers) then write
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: {
      ranges: ['Voters!A2:Q', 'Contacts!A2:G', 'Messages!A2:F']
    }
  });

  const data = [];
  if (voterRows.length > 0) data.push({ range: 'Voters!A2', values: voterRows });
  if (contactRows.length > 0) data.push({ range: 'Contacts!A2', values: contactRows });
  if (messageRows.length > 0) data.push({ range: 'Messages!A2', values: messageRows });

  if (data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  console.log(`Synced to Sheets: ${voterRows.length} voters, ${contactRows.length} contacts, ${messageRows.length} messages`);
}

// ---------------------------------------------------------------------------
// Import from Google Sheets (disaster recovery)
// ---------------------------------------------------------------------------
async function importFromSheets(auth, spreadsheetId, dataType) {
  const sheets = sheetsApi({ version: 'v4', auth });

  const tabName = dataType === 'contacts' ? 'Contacts' : dataType === 'messages' ? 'Messages' : 'Voters';
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A2:Z`
  });

  const rows = resp.data.values || [];
  if (rows.length === 0) return { imported: 0, message: 'No data found in sheet.' };

  let imported = 0;
  let skipped = 0;

  if (dataType === 'voters' || dataType === 'Voters') {
    const insertVoter = db.prepare(`INSERT OR IGNORE INTO voters
      (first_name, last_name, phone, email, address, city, zip,
       party, support_level, voter_score, tags, notes, registration_number, voting_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const importAll = db.transaction(() => {
      for (const row of rows) {
        // row[0] is ID (skip, auto-generated), row[1..] are fields
        const first = row[1] || '';
        const last = row[2] || '';
        const phone = row[3] || '';
        const email = row[4] || '';
        const address = row[5] || '';
        const city = row[6] || '';
        const zip = row[7] || '';
        const party = row[8] || '';
        const support = row[9] || 'unknown';
        const score = parseInt(row[10]) || 0;
        const tags = row[11] || '';
        const notes = row[12] || '';
        const regNum = row[13] || '';
        const votingHist = row[14] || '';

        const result = insertVoter.run(first, last, phone, email, address, city, zip,
          party, support, score, tags, notes, regNum, votingHist);
        if (result.changes > 0) imported++;
        else skipped++;
      }
    });
    importAll();
  } else if (dataType === 'contacts') {
    const insertContact = db.prepare(`INSERT OR IGNORE INTO contacts
      (phone, first_name, last_name, city, email) VALUES (?, ?, ?, ?, ?)`);

    const importAll = db.transaction(() => {
      for (const row of rows) {
        const phone = row[1] || '';
        const first = row[2] || '';
        const last = row[3] || '';
        const city = row[4] || '';
        const email = row[5] || '';
        if (!phone) { skipped++; continue; }
        const result = insertContact.run(phone, first, last, city, email);
        if (result.changes > 0) imported++;
        else skipped++;
      }
    });
    importAll();
  }

  return { imported, skipped, total: rows.length };
}

// ---------------------------------------------------------------------------
// Debounced sync (fire-and-forget from mutation routes)
// ---------------------------------------------------------------------------
let syncTimer = null;
function queueSync(userId) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const sheetId = db.prepare("SELECT value FROM settings WHERE key = 'google_sheet_id'").get();
      const autoSync = db.prepare("SELECT value FROM settings WHERE key = 'google_auto_sync'").get();
      if (!sheetId || autoSync?.value !== 'true') return;

      const auth = await getAuthenticatedClient(userId);
      if (!auth) return;

      await syncToSheets(auth, sheetId.value);

      // Update last sync
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT value FROM settings WHERE key = 'google_last_sync'").get();
      if (existing) db.prepare("UPDATE settings SET value = ? WHERE key = 'google_last_sync'").run(now);
      else db.prepare("INSERT INTO settings (key, value) VALUES ('google_last_sync', ?)").run(now);
    } catch (err) {
      console.error('Background sync error:', err.message);
    }
  }, 10000); // 10 second debounce
}

module.exports = { getAuthenticatedClient, createSpreadsheet, syncToSheets, importFromSheets, queueSync };
