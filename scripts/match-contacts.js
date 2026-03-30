#!/usr/bin/env node
/**
 * Cross-reference a contact list (Facebook friends, etc.) against the voter database.
 *
 * Usage: node scripts/match-contacts.js contacts.txt
 *
 * Output: CSV with matched voters (name, voter ID, address, party, phone, match quality)
 */

const fs = require('fs');
const path = require('path');

// Use the production database
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = require('../db');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node scripts/match-contacts.js <contacts-file.txt>');
  process.exit(1);
}

const raw = fs.readFileSync(inputFile, 'utf8');
const names = raw.split('\n').map(n => n.trim()).filter(n => n && n.length > 2);

console.log(`Loaded ${names.length} contact names`);

// Prepare queries
const exactMatch = db.prepare(`
  SELECT id, first_name, last_name, middle_name, registration_number, address, city, zip,
         phone, party_score, support_level, precinct, age, gender, navigation_district,
         early_voted, voter_status
  FROM voters
  WHERE LOWER(TRIM(first_name)) = LOWER(?) AND LOWER(TRIM(last_name)) = LOWER(?)
  AND voter_status = 'ACTIVE'
`);

const firstLastLike = db.prepare(`
  SELECT id, first_name, last_name, middle_name, registration_number, address, city, zip,
         phone, party_score, support_level, precinct, age, gender, navigation_district,
         early_voted, voter_status
  FROM voters
  WHERE LOWER(TRIM(last_name)) = LOWER(?) AND LOWER(TRIM(first_name)) LIKE ?
  AND voter_status = 'ACTIVE'
  LIMIT 5
`);

// Parse a contact name into possible first/last combinations
function parseName(fullName) {
  // Remove common suffixes/prefixes that aren't names
  let clean = fullName
    .replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '')
    .replace(/^(Dr|Dra|Mr|Mrs|Ms|Coach|Judge|Mayor|Commissioner)\.?\s+/i, '')
    .trim();

  // Skip obvious businesses/organizations
  if (/^(El |La |Los |Las |Club |Team |Restaurant|Salon|LLC|Inc|Corp|PD$|Bail|Towing|Taxi|Tacos|Salon)/i.test(clean)) {
    return null;
  }
  if (clean.includes('@') || clean.includes('.com') || clean.includes('http')) return null;
  if (/^\W+$/.test(clean)) return null; // all special chars

  const parts = clean.split(/\s+/).filter(p => p.length > 0);
  if (parts.length < 2) return null;

  // Standard: first last
  const first = parts[0];
  const last = parts[parts.length - 1];

  // Also try: first middle last (use first and last)
  const results = [{ first, last }];

  // If 3+ parts, also try first + second-to-last (for "Maria Garcia Lane" → Maria Garcia)
  if (parts.length >= 3) {
    results.push({ first: parts[0], last: parts[parts.length - 2] });
    // Also try first two as first name: "Maria Elena" → first="Maria Elena"
    results.push({ first: parts[0] + ' ' + parts[1], last: parts[parts.length - 1] });
  }

  return results;
}

// Match a contact against the voter database
function matchContact(fullName) {
  const combos = parseName(fullName);
  if (!combos) return null;

  for (const { first, last } of combos) {
    // Try exact match first
    const exact = exactMatch.all(first, last);
    if (exact.length > 0) {
      return { matches: exact, quality: 'exact', searchFirst: first, searchLast: last };
    }
  }

  // Try fuzzy: first name starts with (for nicknames like "Alex" → "Alejandro")
  for (const { first, last } of combos) {
    if (first.length >= 3) {
      const fuzzy = firstLastLike.all(last, first.substring(0, 3) + '%');
      if (fuzzy.length > 0) {
        return { matches: fuzzy, quality: 'fuzzy', searchFirst: first, searchLast: last };
      }
    }
  }

  return null;
}

// Process all contacts
console.log('Matching contacts against voter database...\n');

const results = [];
let matched = 0;
let skipped = 0;
let noMatch = 0;

for (const name of names) {
  const result = matchContact(name);
  if (result === null) {
    skipped++;
    continue;
  }
  if (result) {
    matched++;
    for (const v of result.matches) {
      results.push({
        contact_name: name,
        match_quality: result.quality,
        voter_id: v.id,
        registration_number: v.registration_number || '',
        first_name: v.first_name || '',
        last_name: v.last_name || '',
        address: v.address || '',
        city: v.city || '',
        zip: v.zip || '',
        phone: v.phone || '',
        party_score: v.party_score || '',
        support_level: v.support_level || '',
        precinct: v.precinct || '',
        age: v.age || '',
        gender: v.gender || '',
        navigation_district: v.navigation_district || '',
        early_voted: v.early_voted ? 'Yes' : 'No',
        voter_status: v.voter_status || ''
      });
    }
  } else {
    noMatch++;
  }
}

// Output CSV
const headers = ['Contact Name', 'Match Quality', 'Voter ID', 'Reg #', 'First Name', 'Last Name',
                 'Address', 'City', 'ZIP', 'Phone', 'Party Score', 'Support', 'Precinct',
                 'Age', 'Gender', 'Nav District', 'Voted', 'Status'];

function csvEscape(val) {
  const s = String(val || '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const csvRows = [headers.join(',')];
for (const r of results) {
  csvRows.push([
    csvEscape(r.contact_name), r.match_quality, r.voter_id, csvEscape(r.registration_number),
    csvEscape(r.first_name), csvEscape(r.last_name), csvEscape(r.address), csvEscape(r.city),
    r.zip, r.phone, r.party_score, r.support_level, r.precinct, r.age, r.gender,
    csvEscape(r.navigation_district), r.early_voted, r.voter_status
  ].join(','));
}

const outputFile = inputFile.replace(/\.[^.]+$/, '') + '_matched.csv';
fs.writeFileSync(outputFile, csvRows.join('\n'));

console.log(`\n=== Results ===`);
console.log(`Total contacts: ${names.length}`);
console.log(`Skipped (businesses/invalid): ${skipped}`);
console.log(`Matched to voters: ${matched} (${results.length} voter records)`);
console.log(`No match found: ${noMatch}`);
console.log(`\nOutput saved to: ${outputFile}`);
