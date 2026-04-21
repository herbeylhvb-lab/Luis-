// Cameron County district code → canonical name lookups.
// SINGLE SOURCE OF TRUTH. Used by:
//   - db.js startup migration (decodes existing raw codes in DB)
//   - scripts/import-county-voter-file.js (decodes during fresh import)
//   - scripts/upload-county-file.js
//   - scripts/local-merge.js / local-merge-csv.js
//
// When the county re-issues codes (as happened with CCO→CCB, CLC→CIL,
// CPT→CPV, CSX→CSR), ADD the new code here — don't replace the old one.
// Keeping both active means re-imports work regardless of which code
// version the county sends.

// ───── CITIES (prefix C = incorporated city/town) ─────
// Each canonical city name maps from every code ever used for it.
const CITY_LABELS = {
  // Older county codes (kept for backwards compatibility on re-imports)
  'CBR': 'Brownsville',
  'CBV': 'Bayview',
  'CHG': 'Harlingen',
  'CLA': 'La Feria',
  'CLV': 'Los Fresnos',
  'CPR': 'Port Isabel',
  'CRV': 'Rio Hondo',
  'CSB': 'San Benito',
  'CSP': 'South Padre Island',
  'CSX': 'Santa Rosa',      // old code
  'CLI': 'Laguna Vista',
  'CLC': 'Los Indios',      // old code
  'CCO': 'Combes',          // old code
  'CRG': 'Rancho Viejo',
  'CPT': 'Palm Valley',     // old code
  // Newer county codes (added when migrations were written)
  'CCB': 'Combes',          // new code
  'CIL': 'Los Indios',      // new code
  'CLO': 'Lozano',
  'CPI': 'Primera',
  'CPV': 'Palm Valley',     // new code
  'CRH': 'Rangerville',
  'CSR': 'Santa Rosa',      // new code
};

// ───── SCHOOL DISTRICTS (prefix I = ISD) ─────
const SCHOOL_LABELS = {
  'IBR': 'Brownsville ISD',
  'IHG': 'Harlingen ISD',
  'ILA': 'La Feria ISD',
  'ILO': 'Los Fresnos ISD',
  'ILY': 'Lyford ISD',
  'IPI': 'Point Isabel ISD',
  'IRH': 'Rio Hondo ISD',
  'ISB': 'San Benito ISD',
  'ISM': 'Santa Maria ISD',
  'ISR': 'Santa Rosa ISD',
};

// ───── NAVIGATION / PORT DISTRICTS ─────
const NAVIGATION_PORT_LABELS = {
  'BND': 'Port of Brownsville',
  'PIS': 'Port Isabel-San Benito',
  // Accept legacy partial-name from earlier imports
  'Port Isabel Navigation District': 'Port Isabel-San Benito',
};

// NOTE: SAN used to be labeled "Port of San Benito" — that was wrong.
// The correct name is "Port of Harlingen". Accept both forms.
const PORT_AUTHORITY_LABELS = {
  'SAN': 'Port of Harlingen',
  'Port of San Benito': 'Port of Harlingen',
};

// ───── CITY COUNCIL SINGLE-MEMBER DISTRICTS ─────
const SINGLE_MEMBER_CITY_LABELS = {
  'B01': 'Brownsville District 1',
  'B02': 'Brownsville District 2',
  'B03': 'Brownsville District 3',
  'B04': 'Brownsville District 4',
  'H01': 'Harlingen District 1',
  'H02': 'Harlingen District 2',
  'H03': 'Harlingen District 3',
  'H04': 'Harlingen District 4',
  'H05': 'Harlingen District 5',
};

// ───── Helper: safe decode (returns input unchanged if not a known code) ─────
function makeDecoder(map) {
  return (code) => {
    if (code == null) return '';
    const trimmed = String(code).trim();
    if (!trimmed) return '';
    return map[trimmed] || trimmed;
  };
}

const decodeCity = makeDecoder(CITY_LABELS);
const decodeSchool = makeDecoder(SCHOOL_LABELS);
const decodeNavigationPort = makeDecoder(NAVIGATION_PORT_LABELS);
const decodePortAuthority = makeDecoder(PORT_AUTHORITY_LABELS);
const decodeSingleMemberCity = makeDecoder(SINGLE_MEMBER_CITY_LABELS);

// ───── Build the districtRenames array for db.js startup migration ─────
// Each tuple: [columnName, rawCode, canonicalName]
// UPDATE voters SET <col> = canonicalName WHERE <col> = rawCode
function buildDistrictRenames() {
  const tuples = [];
  for (const [code, name] of Object.entries(NAVIGATION_PORT_LABELS)) {
    tuples.push(['navigation_port', code, name]);
  }
  for (const [code, name] of Object.entries(PORT_AUTHORITY_LABELS)) {
    tuples.push(['port_authority', code, name]);
  }
  for (const [code, name] of Object.entries(SINGLE_MEMBER_CITY_LABELS)) {
    tuples.push(['single_member_city', code, name]);
  }
  for (const [code, name] of Object.entries(SCHOOL_LABELS)) {
    tuples.push(['school_district', code, name]);
  }
  for (const [code, name] of Object.entries(CITY_LABELS)) {
    tuples.push(['city_district', code, name]);
  }
  return tuples;
}

// ───── Build rename tuples for the voters.city column ─────
// This fixes cases where raw abbreviation codes bled into the home-city
// column (e.g., voter's city = "CCO" instead of "Combes").
// Only codes — not full names — are returned, so we don't accidentally
// double-rename already-clean data.
function buildCityColumnRenames() {
  return Object.entries(CITY_LABELS)
    .filter(([code]) => /^C[A-Z0-9]{2,3}$/.test(code)) // only 3-4 char ALL-CAPS codes
    .map(([code, name]) => ['city', code, name]);
}

module.exports = {
  CITY_LABELS,
  SCHOOL_LABELS,
  NAVIGATION_PORT_LABELS,
  PORT_AUTHORITY_LABELS,
  SINGLE_MEMBER_CITY_LABELS,
  decodeCity,
  decodeSchool,
  decodeNavigationPort,
  decodePortAuthority,
  decodeSingleMemberCity,
  buildDistrictRenames,
  buildCityColumnRenames,
};
