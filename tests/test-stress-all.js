#!/usr/bin/env node
/**
 * FULL-PLATFORM STRESS TEST
 * Tests EVERY feature/endpoint in CampaignText HQ:
 *   1.  Health & static pages
 *   2.  Auth (setup, login, logout, change password, user CRUD)
 *   3.  Contacts (CRUD, import, bulk delete, clear all)
 *   4.  Voters (CRUD, import, search, filters, bulk ops, touchpoints)
 *   5.  Voter contacts (log contact attempts)
 *   6.  QR check-in (token lookup, event check-in, scan check-in)
 *   7.  Early voting (import, mark, stats, extract remaining, reset)
 *   8.  Election history & universe builder
 *   9.  Block walks (CRUD, addresses, door-knock logging, GPS, group walking, route)
 *  10.  Events (CRUD, RSVPs, check-in, flyer, invite via P2P)
 *  11.  P2P sessions (create, join, volunteer queue, send, conversations, complete)
 *  12.  Surveys (CRUD, questions, start, end, results)
 *  13.  Captains (CRUD, login, search, lists, team, CSV import, household)
 *  14.  Admin lists (CRUD, add/remove voters, contacts)
 *  15.  Knowledge base & response scripts (CRUD)
 *  16.  Settings (get/put)
 *  17.  Messages & incoming webhook simulation
 *  18.  Activity log
 *  19.  Stats & sentiment stats
 *  20.  Email recipients
 *  21.  Provider credentials (save/get)
 *  22.  Bulk SMS disabled (TCPA)
 *  23.  Precinct analytics
 *  24.  Voter enrichment
 *  25.  Canvass import
 */

const http = require('http');
const BASE = 'http://127.0.0.1:3999';
let cookieJar = '';
let passed = 0, failed = 0, skipped = 0;
const errors = [];

// ─── HTTP helpers ────────────────────────────────────────────────
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const r = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach(c => { cookieJar = c.split(';')[0]; });
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, d: JSON.parse(data), h: res.headers }); }
        catch (e) { resolve({ s: res.statusCode, d: data, h: res.headers }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function postForm(urlPath, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const body = new URLSearchParams(params).toString();
    const opts = {
      method: 'POST', hostname: url.hostname, port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const r = http.request(opts, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach(c => { cookieJar = c.split(';')[0]; });
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, d: JSON.parse(data), h: res.headers }); }
        catch (e) { resolve({ s: res.statusCode, d: data, h: res.headers }); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function assert(label, condition) {
  if (condition) { passed++; }
  else { failed++; errors.push(label); console.log('  FAIL: ' + label); }
}

// ─── Shared IDs used across test sections ─────────────────────
let contactId, contactId2, contactId3;
let voterId, voterId2, voterId3, voterId4, voterId5;
let voterQrToken;
let walkId, walkJoinCode, addrId, addrId2;
let eventId, rsvpId;
let p2pSessionId, p2pJoinCode, p2pVolunteerId, p2pAssignmentId;
let surveyId, questionId1, questionId2, questionId3;
let captainId, captainCode, captainListId, teamMemberId;
let adminListId;
let knowledgeId, scriptId;

// ═════════════════════════════════════════════════════════════════
async function run() {
  const t0 = Date.now();

  // ── 1. HEALTH & STATIC PAGES ──────────────────────────────────
  console.log('\n═══ 1. HEALTH & STATIC PAGES ═══');
  {
    const r = await req('GET', '/health');
    assert('GET /health returns 200', r.s === 200);
  }
  {
    const r = await req('GET', '/login');
    assert('GET /login serves HTML', r.s === 200 && typeof r.d === 'string');
  }

  // ── 2. AUTH ────────────────────────────────────────────────────
  console.log('\n═══ 2. AUTH ═══');
  {
    // Setup admin account
    const r = await req('POST', '/api/auth/setup', { username: 'admin', password: 'testpass123', displayName: 'Test Admin' });
    assert('POST /api/auth/setup creates admin', r.s === 200 && r.d.success);
  }
  {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });
    assert('POST /api/auth/login succeeds', r.s === 200 && r.d.success);
  }
  {
    const r = await req('GET', '/api/auth/status');
    assert('GET /api/auth/status returns logged in', r.s === 200 && r.d.loggedIn);
  }
  {
    // Setup validation — too short password
    const r = await req('POST', '/api/auth/setup', { username: 'x', password: '12' });
    assert('Setup rejects short password', r.s === 400 || (r.d && r.d.error));
  }
  {
    // Change password
    const r = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'newpass456' });
    assert('POST /api/auth/change-password succeeds', r.s === 200 && r.d.success);
  }
  {
    // Change back for remaining tests
    await req('POST', '/api/auth/change-password', { currentPassword: 'newpass456', newPassword: 'testpass123' });
  }
  {
    // Wrong current password
    const r = await req('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'x123456' });
    assert('Change password rejects wrong current', r.s === 400 || r.s === 401 || (r.d && r.d.error));
  }
  {
    // Create sub-users
    const r = await req('POST', '/api/users', { username: 'captain1', password: 'cap123456', displayName: 'Cap One', role: 'captain' });
    assert('POST /api/users creates captain', r.s === 200 && r.d.success);
    const r2 = await req('POST', '/api/users', { username: 'vol1', password: 'vol123456', displayName: 'Vol One', role: 'volunteer' });
    assert('POST /api/users creates volunteer', r2.s === 200 && r2.d.success);
  }
  let userId2;
  {
    const r = await req('GET', '/api/users');
    assert('GET /api/users lists users', r.s === 200 && r.d.users && r.d.users.length >= 2);
    userId2 = r.d.users.find(u => u.username === 'vol1')?.id;
  }
  if (userId2) {
    const r = await req('PUT', '/api/users/' + userId2 + '/password', { password: 'newvol789' });
    assert('PUT /api/users/:id/password resets password', r.s === 200 && r.d.success);
    const r2 = await req('DELETE', '/api/users/' + userId2);
    assert('DELETE /api/users/:id deletes user', r2.s === 200 && r2.d.success);
  }
  {
    // Cannot delete self
    const users = (await req('GET', '/api/users')).d.users;
    const self = users.find(u => u.username === 'admin');
    if (self) {
      const r = await req('DELETE', '/api/users/' + self.id);
      assert('Cannot delete own account', r.s === 400 || (r.d && r.d.error));
    }
  }

  // ── 3. CONTACTS ────────────────────────────────────────────────
  console.log('\n═══ 3. CONTACTS ═══');
  {
    const r = await req('POST', '/api/contacts', { phone: '+15551001001', firstName: 'Alice', lastName: 'Smith', city: 'Springfield', email: 'alice@test.com' });
    assert('POST /api/contacts creates contact', r.s === 200 && r.d.success);
    contactId = r.d.id;
  }
  {
    const r = await req('POST', '/api/contacts', { phone: '+15551001002', firstName: 'Bob', lastName: 'Jones' });
    assert('Create second contact', r.s === 200);
    contactId2 = r.d.id;
  }
  {
    // Missing phone
    const r = await req('POST', '/api/contacts', {});
    assert('Contact creation requires phone', r.s === 400);
  }
  {
    // Bulk import
    const r = await req('POST', '/api/contacts/import', {
      contacts: [
        { phone: '+15551001003', firstName: 'Carol', lastName: 'Davis', city: 'Shelbyville' },
        { phone: '+15551001004', firstName: 'Dan', lastName: 'Lee', email: 'dan@test.com' },
        { phone: '+15551001005', firstName: 'Eve', lastName: 'Park' }
      ]
    });
    assert('POST /api/contacts/import bulk imports', r.s === 200 && r.d.added >= 3);
  }
  {
    const r = await req('GET', '/api/contacts');
    assert('GET /api/contacts lists all', r.s === 200 && r.d.contacts && r.d.contacts.length >= 5);
  }
  {
    // Delete one contact (not contactId — we need that for P2P/invite tests)
    if (contactId2) {
      const r = await req('DELETE', '/api/contacts/' + contactId2);
      assert('DELETE /api/contacts/:id works', r.s === 200 && r.d.success);
    }
  }
  {
    // Bulk delete — only delete extra contacts, preserve contactId for later tests
    const all = (await req('GET', '/api/contacts')).d.contacts;
    const toDelete = all.filter(c => c.id !== contactId).slice(-2).map(c => c.id);
    if (toDelete.length) {
      const r = await req('POST', '/api/contacts/bulk-delete', { ids: toDelete });
      assert('POST /api/contacts/bulk-delete works', r.s === 200 && r.d.success);
    }
  }

  // ── 4. VOTERS ──────────────────────────────────────────────────
  console.log('\n═══ 4. VOTERS ═══');
  {
    const r = await req('POST', '/api/voters', {
      first_name: 'Jane', last_name: 'Doe', phone: '+15552001001',
      email: 'jane@test.com', address: '123 Main St', city: 'Springfield',
      zip: '62701', party: 'D', support_level: 'lean_support', voter_score: 8,
      tags: 'active,volunteer', notes: 'Key supporter', registration_number: 'REG001', precinct: 'PCT-01'
    });
    assert('POST /api/voters creates voter', r.s === 200 && r.d.success);
    voterId = r.d.id;
  }
  {
    const r = await req('POST', '/api/voters', {
      first_name: 'John', last_name: 'Doe', phone: '+15552001002',
      address: '125 Main St', city: 'Springfield', zip: '62701', party: 'D', precinct: 'PCT-01'
    });
    voterId2 = r.d.id;
  }
  {
    // Bulk import voters
    const r = await req('POST', '/api/voters/import', {
      voters: [
        { first_name: 'Mike', last_name: 'Brown', phone: '+15552001003', address: '200 Oak Ave', city: 'Springfield', zip: '62701', party: 'R', precinct: 'PCT-02' },
        { first_name: 'Sara', last_name: 'White', phone: '+15552001004', address: '201 Oak Ave', city: 'Springfield', zip: '62701', party: 'I', precinct: 'PCT-02' },
        { first_name: 'Tom', last_name: 'Green', phone: '+15552001005', address: '300 Elm St', city: 'Shelbyville', zip: '62702', party: 'D', precinct: 'PCT-03' },
        { first_name: 'Lisa', last_name: 'Black', phone: '+15552001006', address: '301 Elm St', city: 'Shelbyville', zip: '62702', party: 'D', precinct: 'PCT-03', email: 'lisa@test.com' }
      ]
    });
    assert('POST /api/voters/import bulk imports', r.s === 200 && r.d.added >= 4);
  }
  {
    // Search voters
    const r = await req('GET', '/api/voters?q=Jane');
    assert('GET /api/voters?q= searches by name', r.s === 200 && r.d.voters && r.d.voters.length >= 1);
  }
  {
    // Filter by party
    const r = await req('GET', '/api/voters?party=D');
    assert('Filter voters by party', r.s === 200 && r.d.voters && r.d.voters.length >= 1);
  }
  {
    // Filter by precinct
    const r = await req('GET', '/api/voters?precinct=PCT-02');
    assert('Filter voters by precinct', r.s === 200 && r.d.voters && r.d.voters.length >= 1);
  }
  {
    // List all voters (no filter)
    const r = await req('GET', '/api/voters');
    assert('GET /api/voters lists all', r.s === 200 && r.d.voters && r.d.voters.length >= 5);
    // Store QR token
    const v = r.d.voters.find(v => v.id === voterId);
    if (v) voterQrToken = v.qr_token;
  }
  {
    // Get single voter
    const r = await req('GET', '/api/voters/' + voterId);
    assert('GET /api/voters/:id returns detail', r.s === 200 && r.d.voter && r.d.voter.first_name === 'Jane');
  }
  {
    // Update voter
    const r = await req('PUT', '/api/voters/' + voterId, { support_level: 'strong_support', notes: 'Updated notes' });
    assert('PUT /api/voters/:id updates voter', r.s === 200 && r.d.success);
  }
  {
    // 404 on nonexistent voter
    const r = await req('GET', '/api/voters/99999');
    assert('GET /api/voters/:id 404 for missing', r.s === 404);
  }

  // ── 5. VOTER CONTACTS ─────────────────────────────────────────
  console.log('\n═══ 5. VOTER CONTACT LOGGING ═══');
  {
    const r = await req('POST', '/api/voters/' + voterId + '/contacts', {
      contact_type: 'Phone call', result: 'Strong Support', notes: 'Very enthusiastic', contacted_by: 'Admin'
    });
    assert('POST /api/voters/:id/contacts logs contact', r.s === 200 && r.d.success);
  }
  {
    const r = await req('POST', '/api/voters/' + voterId + '/contacts', {
      contact_type: 'Door-knock', result: 'Not Home', contacted_by: 'Vol1'
    });
    assert('Log second contact attempt', r.s === 200 && r.d.success);
  }
  {
    // Missing contact_type
    const r = await req('POST', '/api/voters/' + voterId + '/contacts', { result: 'test' });
    assert('Contact log requires contact_type', r.s === 400);
  }
  {
    // Touchpoints
    const r = await req('GET', '/api/voters/' + voterId + '/touchpoints');
    assert('GET /api/voters/:id/touchpoints returns timeline', r.s === 200 && r.d.touchpoints);
  }
  {
    // Aggregate touchpoint stats
    const r = await req('GET', '/api/voters-touchpoints/stats');
    assert('GET /api/voters-touchpoints/stats returns stats', r.s === 200);
  }
  {
    // Precincts list
    const r = await req('GET', '/api/voters-precincts');
    assert('GET /api/voters-precincts returns precincts', r.s === 200 && r.d.precincts && r.d.precincts.length >= 2);
  }

  // ── 6. QR CHECK-IN ────────────────────────────────────────────
  console.log('\n═══ 6. QR CHECK-IN ═══');
  if (voterQrToken) {
    {
      const r = await req('GET', '/api/voters/qr/' + voterQrToken);
      assert('GET /api/voters/qr/:token finds voter', r.s === 200 && r.d.voter);
    }
    {
      const r = await req('GET', '/api/voters/qr/INVALIDTOKEN999');
      assert('QR token 404 for invalid', r.s === 404);
    }
    {
      const r = await req('GET', '/api/voters/checkins/today-events');
      assert('GET /api/voters/checkins/today-events works', r.s === 200);
    }
  }

  // ── 7. EVENTS ──────────────────────────────────────────────────
  console.log('\n═══ 7. EVENTS ═══');
  {
    const today = new Date().toISOString().split('T')[0];
    const r = await req('POST', '/api/events', {
      title: 'Town Hall Meeting', description: 'Community Q&A', location: 'City Hall',
      event_date: today, event_time: '18:00'
    });
    assert('POST /api/events creates event', r.s === 200 && r.d.success);
    eventId = r.d.id;
  }
  {
    // Create second event for bulk-delete test
    const r = await req('POST', '/api/events', { title: 'Fundraiser Dinner', event_date: '2026-03-15' });
    assert('Create second event', r.s === 200);
    const eventId2 = r.d.id;
    // Bulk delete it
    const r2 = await req('POST', '/api/events/bulk-delete', { ids: [eventId2] });
    assert('POST /api/events/bulk-delete works', r2.s === 200 && r2.d.success);
  }
  {
    // Missing fields
    const r = await req('POST', '/api/events', { title: '' });
    assert('Event creation requires title+date', r.s === 400);
  }
  {
    const r = await req('GET', '/api/events');
    assert('GET /api/events lists events', r.s === 200 && r.d.events && r.d.events.length >= 1);
  }
  {
    const r = await req('GET', '/api/events/' + eventId);
    assert('GET /api/events/:id returns detail', r.s === 200 && r.d.event && r.d.event.title === 'Town Hall Meeting');
  }
  {
    const r = await req('PUT', '/api/events/' + eventId, { description: 'Updated Q&A session', status: 'active' });
    assert('PUT /api/events/:id updates event', r.s === 200 && r.d.success);
  }
  {
    // Add RSVPs
    const r = await req('POST', '/api/events/' + eventId + '/rsvps', {
      rsvps: [
        { contact_phone: '+15551001001', contact_name: 'Alice Smith', rsvp_status: 'confirmed' },
        { contact_phone: '+15552001001', contact_name: 'Jane Doe', rsvp_status: 'confirmed' },
        { contact_phone: '+15559999999', contact_name: 'Walk-in Joe' }
      ]
    });
    assert('POST /api/events/:id/rsvps adds RSVPs', r.s === 200 && r.d.success);
  }
  {
    // Get event with RSVPs
    const r = await req('GET', '/api/events/' + eventId);
    assert('Event detail includes RSVPs', r.d.event.rsvps && r.d.event.rsvps.length >= 3);
    rsvpId = r.d.event.rsvps[0]?.id;
  }
  if (rsvpId) {
    const r = await req('PUT', '/api/events/' + eventId + '/rsvps/' + rsvpId, { rsvp_status: 'attended' });
    assert('PUT /api/events/:id/rsvps/:id updates RSVP', r.s === 200 && r.d.success);
  }
  {
    // Event check-in (public)
    const r = await req('POST', '/api/events/' + eventId + '/checkin', { name: 'Walk-in Pam', phone: '+15558888888' });
    assert('POST /api/events/:id/checkin works', r.s === 200 && r.d.success);
  }
  {
    // Check-in validation
    const r = await req('POST', '/api/events/' + eventId + '/checkin', { name: '', phone: '' });
    assert('Event check-in requires name+phone', r.s === 400);
  }
  {
    // QR check-in to event
    if (voterQrToken) {
      const r = await req('POST', '/api/voters/qr/' + voterQrToken + '/checkin', { event_id: eventId });
      assert('POST /api/voters/qr/:token/checkin works', r.s === 200 && r.d.success);
    }
  }
  {
    // Scan check-in
    if (voterQrToken) {
      const r = await req('POST', '/api/voters/qr/' + voterQrToken + '/scan-checkin', { event_id: eventId, scanned_by: 'Vol1' });
      assert('POST /api/voters/qr/:token/scan-checkin works', r.s === 200);
    }
  }
  {
    // Check-in stats for event
    const r = await req('GET', '/api/voters/checkins/event/' + eventId);
    assert('GET /api/voters/checkins/event/:id returns stats', r.s === 200);
  }
  {
    // Flyer endpoint (no flyer uploaded — should 404)
    const r = await req('GET', '/api/events/' + eventId + '/flyer');
    assert('GET /api/events/:id/flyer 404 when no flyer', r.s === 404);
  }
  {
    // Event session (no P2P session yet)
    const r = await req('GET', '/api/events/' + eventId + '/session');
    assert('GET /api/events/:id/session returns null when none', r.s === 200);
  }

  // ── 8. EVENT INVITE VIA P2P ───────────────────────────────────
  console.log('\n═══ 8. EVENT INVITE VIA P2P ═══');
  {
    const r = await req('POST', '/api/events/' + eventId + '/invite', {
      contactIds: [contactId],
      messageTemplate: 'You\'re invited to {title} on {date} at {location}!'
    });
    assert('POST /api/events/:id/invite creates P2P session', r.s === 200 && r.d.success && r.d.joinCode);
  }
  {
    const r = await req('GET', '/api/events/' + eventId + '/session');
    assert('Event now has linked P2P session', r.s === 200 && r.d.session);
  }

  // ── 9. BLOCK WALKS ────────────────────────────────────────────
  console.log('\n═══ 9. BLOCK WALKS ═══');
  {
    const r = await req('POST', '/api/walks', { name: 'Main Street Canvas', description: 'Door to door on Main', assigned_to: 'Admin' });
    assert('POST /api/walks creates walk', r.s === 200 && r.d.success && r.d.joinCode);
    walkId = r.d.id;
    walkJoinCode = r.d.joinCode;
  }
  {
    const r = await req('POST', '/api/walks', {});
    assert('Walk creation requires name', r.s === 400);
  }
  {
    const r = await req('GET', '/api/walks');
    assert('GET /api/walks lists walks', r.s === 200 && r.d.walks && r.d.walks.length >= 1);
  }
  {
    // Add addresses
    const r = await req('POST', '/api/walks/' + walkId + '/addresses', {
      addresses: [
        { address: '123 Main St', city: 'Springfield', zip: '62701', voter_name: 'Jane Doe' },
        { address: '125 Main St', city: 'Springfield', zip: '62701', voter_name: 'John Doe' },
        { address: '127 Main St', city: 'Springfield', zip: '62701', voter_name: 'Neighbor' },
        { address: '129 Main St', city: 'Springfield', zip: '62701', voter_name: 'Resident' }
      ]
    });
    assert('POST /api/walks/:id/addresses adds addresses', r.s === 200 && r.d.added >= 4);
  }
  {
    // Empty addresses
    const r = await req('POST', '/api/walks/' + walkId + '/addresses', { addresses: [] });
    assert('Add addresses rejects empty list', r.s === 400);
  }
  {
    const r = await req('GET', '/api/walks/' + walkId);
    assert('GET /api/walks/:id returns detail with addresses', r.s === 200 && r.d.walk && r.d.walk.addresses.length >= 4);
    addrId = r.d.walk.addresses[0]?.id;
    addrId2 = r.d.walk.addresses[1]?.id;
  }
  {
    // Update address result
    const r = await req('PUT', '/api/walks/' + walkId + '/addresses/' + addrId, { result: 'support', notes: 'Very friendly' });
    assert('PUT /api/walks/:walkId/addresses/:addrId updates result', r.s === 200 && r.d.success);
  }
  {
    // Door-knock log with GPS
    const r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addrId2 + '/log', {
      result: 'not_home', notes: 'No answer', gps_lat: 39.7817, gps_lng: -89.6501, gps_accuracy: 10, walker_name: 'TestWalker'
    });
    assert('POST /api/walks/:wId/addresses/:aId/log logs door knock', r.s === 200 && r.d.success);
  }
  {
    // Invalid result value
    const r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addrId2 + '/log', { result: 'invalid_value' });
    assert('Door knock rejects invalid result', r.s === 400);
  }
  {
    // Missing result
    const r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addrId2 + '/log', {});
    assert('Door knock requires result', r.s === 400);
  }
  {
    // GPS with bad accuracy (>200m)
    const r = await req('POST', '/api/walks/' + walkId + '/addresses/' + addrId + '/log', {
      result: 'support', gps_lat: 39.78, gps_lng: -89.65, gps_accuracy: 500
    });
    assert('Door knock with poor GPS accuracy accepted', r.s === 200);
  }
  {
    // Volunteer view
    const r = await req('GET', '/api/walks/' + walkId + '/volunteer');
    assert('GET /api/walks/:id/volunteer returns simplified view', r.s === 200 && r.d.walk && r.d.walk.progress);
  }
  {
    // Route optimization
    const r = await req('GET', '/api/walks/' + walkId + '/route');
    assert('GET /api/walks/:id/route returns route', r.s === 200);
  }
  {
    // Update walk metadata
    const r = await req('PUT', '/api/walks/' + walkId, { name: 'Main St Canvas v2', status: 'in_progress' });
    assert('PUT /api/walks/:id updates metadata', r.s === 200 && r.d.success);
  }
  {
    // Delete one address
    const walk = (await req('GET', '/api/walks/' + walkId)).d.walk;
    const lastAddr = walk.addresses[walk.addresses.length - 1];
    if (lastAddr) {
      const r = await req('DELETE', '/api/walks/' + walkId + '/addresses/' + lastAddr.id);
      assert('DELETE /api/walks/:wId/addresses/:aId removes address', r.s === 200 && r.d.success);
    }
  }

  // ── GROUP WALKING ──────────────────────────────────────────────
  console.log('\n═══ 9b. GROUP WALKING ═══');
  {
    const r = await req('POST', '/api/walks/join', { joinCode: walkJoinCode, walkerName: 'Alice' });
    assert('POST /api/walks/join joins group', r.s === 200 && r.d.success);
  }
  {
    const r = await req('POST', '/api/walks/join', { joinCode: walkJoinCode, walkerName: 'Bob' });
    assert('Second walker joins group', r.s === 200);
  }
  {
    // Missing fields
    const r = await req('POST', '/api/walks/join', {});
    assert('Walk join requires code+name', r.s === 400);
  }
  {
    // Invalid code
    const r = await req('POST', '/api/walks/join', { joinCode: 'ZZZZ', walkerName: 'Nobody' });
    assert('Walk join rejects invalid code', r.s === 404);
  }
  {
    const r = await req('GET', '/api/walks/' + walkId + '/group');
    assert('GET /api/walks/:id/group returns members', r.s === 200 && r.d.members && r.d.members.length >= 2);
  }
  {
    const r = await req('GET', '/api/walks/' + walkId + '/walker/Alice');
    assert('GET /api/walks/:id/walker/:name returns assigned addresses', r.s === 200 && r.d.addresses);
  }
  {
    const r = await req('DELETE', '/api/walks/' + walkId + '/group/Bob');
    assert('DELETE /api/walks/:id/group/:name leaves group', r.s === 200 && r.d.success);
  }

  // ── Bulk delete walks ─────────────────────────────────────────
  {
    const r2 = await req('POST', '/api/walks', { name: 'Temp Walk' });
    if (r2.d.id) {
      const r3 = await req('POST', '/api/walks/bulk-delete', { ids: [r2.d.id] });
      assert('POST /api/walks/bulk-delete works', r3.s === 200 && r3.d.success);
    }
  }

  // ── 9c. CREATE WALK FROM PRECINCT ─────────────────────────────
  console.log('\n═══ 9c. CREATE WALK FROM PRECINCT ═══');
  let precinctWalkId;
  {
    const r = await req('POST', '/api/walks/from-precinct', { precincts: ['PCT-01'] });
    assert('POST /api/walks/from-precinct creates walk', r.s === 200 && r.d.success && r.d.added >= 1);
    precinctWalkId = r.d.id;
  }
  {
    // Multiple precincts
    const r = await req('POST', '/api/walks/from-precinct', { precincts: ['PCT-01', 'PCT-02'], name: 'Multi-Precinct Walk' });
    assert('Create walk from multiple precincts', r.s === 200 && r.d.success && r.d.added >= 2);
  }
  {
    // With filters
    const r = await req('POST', '/api/walks/from-precinct', { precincts: ['PCT-01'], filters: { party: 'D' } });
    assert('Create precinct walk with party filter', r.s === 200 && r.d.success);
  }
  {
    // No precincts provided
    const r = await req('POST', '/api/walks/from-precinct', { precincts: [] });
    assert('Precinct walk requires precincts', r.s === 400);
  }
  {
    // Non-existent precinct
    const r = await req('POST', '/api/walks/from-precinct', { precincts: ['NONEXISTENT-99'] });
    assert('Precinct walk rejects empty result', r.s === 400);
  }
  if (precinctWalkId) {
    // Verify the walk has voter-linked addresses
    const r = await req('GET', '/api/walks/' + precinctWalkId);
    assert('Precinct walk addresses are voter-linked', r.s === 200 && r.d.walk.addresses.length >= 1 && r.d.walk.addresses[0].voter_id);
  }

  // ── 9d. PER-WALKER LIVE ROUTE ─────────────────────────────────
  console.log('\n═══ 9d. PER-WALKER ROUTE & LIVE STATUS ═══');
  {
    // Walker route (Alice is still in walkId group from 9b)
    const r = await req('GET', '/api/walks/' + walkId + '/walker/Alice/route');
    assert('GET /api/walks/:id/walker/:name/route works', r.s === 200 && r.d.route !== undefined);
  }
  {
    // Walker route with GPS position
    const r = await req('GET', '/api/walks/' + walkId + '/walker/Alice/route?lat=39.78&lng=-89.65');
    assert('Walker route with GPS start position', r.s === 200);
  }
  {
    // Live group status
    const r = await req('GET', '/api/walks/' + walkId + '/live-status');
    assert('GET /api/walks/:id/live-status returns group stats', r.s === 200 && r.d.progress && r.d.walkerStats && r.d.recentKnocks);
    assert('Live status has per-walker breakdown', r.d.walkerStats['Alice'] !== undefined);
  }

  // ── 10. P2P SESSIONS ──────────────────────────────────────────
  console.log('\n═══ 10. P2P SESSIONS ═══');
  {
    // Get contact IDs for P2P
    const contacts = (await req('GET', '/api/contacts')).d.contacts;
    const cids = contacts.slice(0, 2).map(c => c.id);
    const r = await req('POST', '/api/p2p/sessions', {
      name: 'GOTV Texting Drive',
      message_template: 'Hi {firstName}, election day is coming! Are you planning to vote?',
      assignment_mode: 'auto_split',
      contact_ids: cids
    });
    assert('POST /api/p2p/sessions creates session', r.s === 200 && r.d.success);
    p2pSessionId = r.d.id || r.d.sessionId;
    p2pJoinCode = r.d.joinCode;
  }
  {
    const r = await req('GET', '/api/p2p/sessions');
    assert('GET /api/p2p/sessions lists sessions', r.s === 200 && r.d.sessions && r.d.sessions.length >= 1);
  }
  {
    const r = await req('GET', '/api/p2p/sessions/' + p2pSessionId);
    assert('GET /api/p2p/sessions/:id returns detail', r.s === 200 && r.d.session);
  }
  {
    const r = await req('PATCH', '/api/p2p/sessions/' + p2pSessionId, { status: 'active' });
    assert('PATCH /api/p2p/sessions/:id activates session', r.s === 200 && r.d.success);
  }
  {
    // Join as volunteer
    const r = await req('POST', '/api/p2p/join', { name: 'VolunteerAlex', code: p2pJoinCode });
    assert('POST /api/p2p/join joins session', r.s === 200 && r.d.success);
    p2pVolunteerId = r.d.volunteerId;
  }
  if (p2pVolunteerId) {
    {
      // Update online status
      const r = await req('PATCH', '/api/p2p/volunteers/' + p2pVolunteerId + '/status', { is_online: true });
      assert('PATCH /api/p2p/volunteers/:id/status sets online', r.s === 200);
    }
    {
      // Get queue
      const r = await req('GET', '/api/p2p/volunteers/' + p2pVolunteerId + '/queue');
      assert('GET /api/p2p/volunteers/:id/queue returns queue', r.s === 200);
      if (r.d.assignment) p2pAssignmentId = r.d.assignment.id;
    }
    if (p2pAssignmentId) {
      {
        // Get conversation
        const r = await req('GET', '/api/p2p/conversations/' + p2pAssignmentId);
        assert('GET /api/p2p/conversations/:assignmentId works', r.s === 200);
      }
      {
        // Complete assignment
        const r = await req('PATCH', '/api/p2p/assignments/' + p2pAssignmentId + '/complete');
        assert('PATCH /api/p2p/assignments/:id/complete works', r.s === 200);
      }
      {
        // Get next assignment (should be a different one or empty)
        const r = await req('GET', '/api/p2p/volunteers/' + p2pVolunteerId + '/queue');
        const nextAssign = r.d.assignment;
        if (nextAssign) {
          // Skip it
          const r2 = await req('PATCH', '/api/p2p/assignments/' + nextAssign.id + '/skip');
          assert('PATCH /api/p2p/assignments/:id/skip works', r2.s === 200);
        }
      }
    }
  }
  {
    // Delete a test session
    const r2 = await req('POST', '/api/p2p/sessions', {
      name: 'Temp Session', message_template: 'test', assignment_mode: 'claim', contact_ids: [contactId]
    });
    if (r2.d.id || r2.d.sessionId) {
      const tempId = r2.d.id || r2.d.sessionId;
      const r3 = await req('DELETE', '/api/p2p/sessions/' + tempId);
      assert('DELETE /api/p2p/sessions/:id works', r3.s === 200 && r3.d.success);
    }
  }

  // ── 11. SURVEYS ────────────────────────────────────────────────
  console.log('\n═══ 11. SURVEYS ═══');
  {
    const r = await req('POST', '/api/surveys', { name: 'Voter Priorities Poll', description: 'What issues matter most?' });
    assert('POST /api/surveys creates survey', r.s === 200 && r.d.success);
    surveyId = r.d.id;
  }
  {
    const r = await req('POST', '/api/surveys', {});
    assert('Survey creation requires name', r.s === 400);
  }
  {
    // Add single_choice question
    const r = await req('POST', '/api/surveys/' + surveyId + '/questions', {
      question_text: 'What is your #1 issue?',
      question_type: 'single_choice',
      options: ['Economy', 'Healthcare', 'Education', 'Environment']
    });
    assert('Add single_choice question', r.s === 200 && r.d.success);
    questionId1 = r.d.questionId;
  }
  {
    // Add ranked_choice question
    const r = await req('POST', '/api/surveys/' + surveyId + '/questions', {
      question_text: 'Rank these candidates:',
      question_type: 'ranked_choice',
      options: [{ text: 'Candidate A' }, { text: 'Candidate B' }, { text: 'Candidate C' }]
    });
    assert('Add ranked_choice question', r.s === 200 && r.d.success);
    questionId2 = r.d.questionId;
  }
  {
    // Add write_in question
    const r = await req('POST', '/api/surveys/' + surveyId + '/questions', {
      question_text: 'Any additional comments?',
      question_type: 'write_in'
    });
    assert('Add write_in question', r.s === 200 && r.d.success);
    questionId3 = r.d.questionId;
  }
  {
    // Missing question text
    const r = await req('POST', '/api/surveys/' + surveyId + '/questions', { question_type: 'single_choice' });
    assert('Question requires text', r.s === 400);
  }
  {
    // Get survey detail
    const r = await req('GET', '/api/surveys/' + surveyId);
    assert('GET /api/surveys/:id returns detail with questions', r.s === 200 && r.d.survey && r.d.survey.questions.length === 3);
  }
  {
    // Update question
    const r = await req('PUT', '/api/surveys/' + surveyId + '/questions/' + questionId1, { question_text: 'What is your TOP issue?' });
    assert('PUT /api/surveys/:sId/questions/:qId updates question', r.s === 200 && r.d.success);
  }
  {
    // Update survey metadata
    const r = await req('PUT', '/api/surveys/' + surveyId, { description: 'Updated poll description' });
    assert('PUT /api/surveys/:id updates metadata', r.s === 200 && r.d.success);
  }
  {
    // Start poll
    const r = await req('POST', '/api/surveys/' + surveyId + '/start');
    assert('POST /api/surveys/:id/start activates poll', r.s === 200 && r.d.success);
  }
  {
    // End poll
    const r = await req('POST', '/api/surveys/' + surveyId + '/end');
    assert('POST /api/surveys/:id/end closes poll', r.s === 200 && r.d.success);
  }
  {
    // Results
    const r = await req('GET', '/api/surveys/' + surveyId + '/results');
    assert('GET /api/surveys/:id/results returns results', r.s === 200 && r.d.results);
  }
  {
    // List surveys
    const r = await req('GET', '/api/surveys');
    assert('GET /api/surveys lists all', r.s === 200 && r.d.surveys && r.d.surveys.length >= 1);
  }
  {
    // Survey session (none yet since we didn't /send)
    const r = await req('GET', '/api/surveys/' + surveyId + '/session');
    assert('GET /api/surveys/:id/session works', r.s === 200);
  }
  {
    // Delete a question
    const r = await req('DELETE', '/api/surveys/' + surveyId + '/questions/' + questionId3);
    assert('DELETE /api/surveys/:sId/questions/:qId removes question', r.s === 200 && r.d.success);
  }
  {
    // Create + delete survey
    const r = await req('POST', '/api/surveys', { name: 'Temp Survey' });
    if (r.d.id) {
      const r2 = await req('DELETE', '/api/surveys/' + r.d.id);
      assert('DELETE /api/surveys/:id removes survey', r2.s === 200 && r2.d.success);
    }
  }
  {
    // Start survey with no questions (should fail)
    const r0 = await req('POST', '/api/surveys', { name: 'Empty Survey' });
    const emptySurveyId = r0.d.id;
    if (emptySurveyId) {
      const r = await req('POST', '/api/surveys/' + emptySurveyId + '/start');
      assert('Start survey with no questions fails', r.s === 400);
      await req('DELETE', '/api/surveys/' + emptySurveyId);
    }
  }

  // ── 12. ADMIN LISTS ────────────────────────────────────────────
  console.log('\n═══ 12. ADMIN LISTS ═══');
  {
    const r = await req('POST', '/api/admin-lists', { name: 'GOTV Priority List', description: 'High priority voters', list_type: 'gotv' });
    assert('POST /api/admin-lists creates list', r.s === 200 && r.d.success);
    adminListId = r.d.id;
  }
  {
    const r = await req('GET', '/api/admin-lists');
    assert('GET /api/admin-lists returns lists', r.s === 200 && r.d.lists);
  }
  {
    // Add voters
    const r = await req('POST', '/api/admin-lists/' + adminListId + '/voters', { voterIds: [voterId, voterId2] });
    assert('POST /api/admin-lists/:id/voters adds voters', r.s === 200 && r.d.success);
  }
  {
    const r = await req('GET', '/api/admin-lists/' + adminListId);
    assert('GET /api/admin-lists/:id returns detail with voters', r.s === 200 && r.d.list && r.d.list.voters && r.d.list.voters.length >= 2);
  }
  {
    // Get contacts from list
    const r = await req('GET', '/api/admin-lists/' + adminListId + '/contacts');
    assert('GET /api/admin-lists/:id/contacts returns phone targets', r.s === 200);
  }
  {
    // Update list
    const r = await req('PUT', '/api/admin-lists/' + adminListId, { name: 'GOTV Priority List v2' });
    assert('PUT /api/admin-lists/:id updates list', r.s === 200 && r.d.success);
  }
  {
    // Remove voter
    const r = await req('DELETE', '/api/admin-lists/' + adminListId + '/voters/' + voterId2);
    assert('DELETE /api/admin-lists/:id/voters/:vId removes voter', r.s === 200 && r.d.success);
  }
  {
    // Create + delete list
    const r = await req('POST', '/api/admin-lists', { name: 'Temp List' });
    if (r.d.id) {
      const r2 = await req('DELETE', '/api/admin-lists/' + r.d.id);
      assert('DELETE /api/admin-lists/:id removes list', r2.s === 200 && r2.d.success);
    }
  }

  // ── 13. CAPTAINS ───────────────────────────────────────────────
  console.log('\n═══ 13. CAPTAIN PORTAL ═══');
  {
    const r = await req('POST', '/api/captains', { name: 'Block Captain Maria', phone: '+15553001001', email: 'maria@test.com' });
    assert('POST /api/captains creates captain', r.s === 200 && r.d.success);
    captainId = r.d.id;
    captainCode = r.d.code;
  }
  {
    const r = await req('GET', '/api/captains');
    assert('GET /api/captains lists captains', r.s === 200 && r.d.captains && r.d.captains.length >= 1);
  }
  {
    // Captain login with code
    const r = await req('POST', '/api/captains/login', { code: captainCode });
    assert('POST /api/captains/login works', r.s === 200 && r.d.captain);
  }
  {
    // Invalid captain code
    const r = await req('POST', '/api/captains/login', { code: 'BADCODE' });
    assert('Captain login rejects bad code', r.s === 404 || r.s === 401 || (r.d && r.d.error));
  }
  {
    // Update captain
    const r = await req('PUT', '/api/captains/' + captainId, { email: 'maria_updated@test.com' });
    assert('PUT /api/captains/:id updates captain', r.s === 200 && r.d.success);
  }
  {
    // Add team member
    const r = await req('POST', '/api/captains/' + captainId + '/team', { name: 'Helper Joe' });
    assert('POST /api/captains/:id/team adds team member', r.s === 200 && r.d.success);
    teamMemberId = r.d.team_member_id;
  }
  {
    // Search voters (captain)
    const r = await req('GET', '/api/captains/' + captainId + '/search?q=Jane');
    assert('GET /api/captains/:id/search finds voters', r.s === 200 && r.d.voters && r.d.voters.length >= 1);
  }
  {
    // Search too short
    const r = await req('GET', '/api/captains/' + captainId + '/search?q=J');
    assert('Captain search requires min 2 chars', r.s === 400 || (r.d.voters && r.d.voters.length === 0));
  }
  {
    // Household lookup
    const r = await req('GET', '/api/captains/' + captainId + '/household?voter_id=' + voterId);
    assert('GET /api/captains/:id/household returns results', r.s === 200);
  }
  {
    // Create captain list
    const r = await req('POST', '/api/captains/' + captainId + '/lists', { name: 'My Neighborhood List' });
    assert('POST /api/captains/:id/lists creates list', r.s === 200 && r.d.success);
    captainListId = r.d.id;
  }
  {
    // Add voter to captain list
    const r = await req('POST', '/api/captains/' + captainId + '/lists/' + captainListId + '/voters', { voter_id: voterId, phone: '+15552001001' });
    assert('Add voter to captain list', r.s === 200 && r.d.success);
  }
  {
    // Get voters in captain list
    const r = await req('GET', '/api/captains/' + captainId + '/lists/' + captainListId + '/voters');
    assert('GET captain list voters', r.s === 200 && r.d.voters && r.d.voters.length >= 1);
  }
  {
    // Rename captain list
    const r = await req('PUT', '/api/captains/' + captainId + '/lists/' + captainListId, { name: 'My Neighborhood v2' });
    assert('PUT /api/captains/:id/lists/:lId renames list', r.s === 200 && r.d.success);
  }
  {
    // CSV import to captain list
    const r = await req('POST', '/api/captains/' + captainId + '/lists/' + captainListId + '/import-csv', {
      rows: [
        { phone: '+15552001003', first_name: 'Mike', last_name: 'Brown' },
        { phone: '+15559999999', first_name: 'Unknown', last_name: 'Person' }
      ]
    });
    assert('POST /api/captains/:id/lists/:lId/import-csv works', r.s === 200);
  }
  {
    // All lists (admin view)
    const r = await req('GET', '/api/captains/all-lists');
    assert('GET /api/captains/all-lists returns all lists', r.s === 200 && r.d.lists);
  }
  {
    // Remove voter from captain list
    const r = await req('DELETE', '/api/captains/' + captainId + '/lists/' + captainListId + '/voters/' + voterId);
    assert('Remove voter from captain list', r.s === 200 && r.d.success);
  }
  {
    // Delete captain list
    const r = await req('DELETE', '/api/captains/' + captainId + '/lists/' + captainListId);
    assert('Delete captain list', r.s === 200 && r.d.success);
  }
  {
    // Remove team member
    if (teamMemberId) {
      const r = await req('DELETE', '/api/captains/' + captainId + '/team/' + teamMemberId);
      assert('Remove team member', r.s === 200 && r.d.success);
    }
  }
  {
    // Create + delete captain
    const r = await req('POST', '/api/captains', { name: 'Temp Captain' });
    if (r.d.id) {
      const r2 = await req('DELETE', '/api/captains/' + r.d.id);
      assert('DELETE /api/captains/:id removes captain', r2.s === 200 && r2.d.success);
    }
  }

  // ── 14. KNOWLEDGE BASE & SCRIPTS ──────────────────────────────
  console.log('\n═══ 14. KNOWLEDGE BASE & SCRIPTS ═══');
  {
    const r = await req('POST', '/api/knowledge', { type: 'policy', title: 'Healthcare Plan', content: 'Universal coverage for all residents' });
    assert('POST /api/knowledge creates entry', r.s === 200 && r.d.success);
    knowledgeId = r.d.id;
  }
  {
    const r = await req('POST', '/api/knowledge', {});
    assert('Knowledge creation requires fields', r.s === 400);
  }
  {
    const r = await req('GET', '/api/knowledge');
    assert('GET /api/knowledge lists entries', r.s === 200 && r.d.entries && r.d.entries.length >= 1);
  }
  {
    const r = await req('PUT', '/api/knowledge/' + knowledgeId, { content: 'Updated: expanded coverage plan' });
    assert('PUT /api/knowledge/:id updates entry', r.s === 200 && r.d.success);
  }
  {
    // Scripts
    const r = await req('POST', '/api/scripts', { scenario: 'greeting', label: 'Standard Hello', content: 'Hi {firstName}, thanks for chatting!' });
    assert('POST /api/scripts creates script', r.s === 200 && r.d.success);
    scriptId = r.d.id;
  }
  {
    const r = await req('POST', '/api/scripts', {});
    assert('Script creation requires fields', r.s === 400);
  }
  {
    const r = await req('GET', '/api/scripts');
    assert('GET /api/scripts lists scripts', r.s === 200 && r.d.scripts && r.d.scripts.length >= 1);
  }
  {
    const r = await req('PUT', '/api/scripts/' + scriptId, { content: 'Updated: Hi {firstName}! How are you today?' });
    assert('PUT /api/scripts/:id updates script', r.s === 200 && r.d.success);
  }
  {
    const r = await req('DELETE', '/api/scripts/' + scriptId);
    assert('DELETE /api/scripts/:id removes script', r.s === 200 && r.d.success);
  }
  {
    const r = await req('DELETE', '/api/knowledge/' + knowledgeId);
    assert('DELETE /api/knowledge/:id removes entry', r.s === 200 && r.d.success);
  }

  // ── 15. SETTINGS ───────────────────────────────────────────────
  console.log('\n═══ 15. SETTINGS ═══');
  {
    const r = await req('PUT', '/api/settings/campaign_name', { value: 'Smith for Council 2026' });
    assert('PUT /api/settings/:key saves setting', r.s === 200 && r.d.success);
  }
  {
    const r = await req('GET', '/api/settings/campaign_name');
    assert('GET /api/settings/:key retrieves setting', r.s === 200 && r.d.value === 'Smith for Council 2026');
  }
  {
    // Missing value
    const r = await req('PUT', '/api/settings/test_key', {});
    assert('Settings requires value', r.s === 400);
  }
  {
    // Nonexistent key returns null
    const r = await req('GET', '/api/settings/default_area_code');
    assert('Nonexistent setting returns null', r.s === 200 && r.d.value === null);
  }

  // ── 16. PROVIDER CREDENTIALS ─────────────────────────────────
  console.log('\n═══ 16. PROVIDER CREDENTIALS ═══');
  {
    const r = await req('GET', '/api/providers');
    assert('GET /api/providers lists rumbleup', r.s === 200 && r.d.providers && r.d.providers.some(p => p.name === 'rumbleup'));
  }
  {
    const r = await req('POST', '/api/provider-credentials', { provider: 'rumbleup', credentials: { apiKey: 'test_key', apiSecret: 'test_secret', actionId: '123' } });
    assert('POST /api/provider-credentials saves creds', r.s === 200 && r.d.success);
  }
  {
    const r = await req('GET', '/api/provider-credentials?provider=rumbleup');
    assert('GET /api/provider-credentials returns creds', r.s === 200 && r.d.credentials && r.d.credentials.hasApiKey === true);
  }

  // ── 17. BULK SMS DISABLED ──────────────────────────────────────
  console.log('\n═══ 17. TCPA COMPLIANCE ═══');
  {
    const r = await req('POST', '/send', {});
    assert('POST /send returns 410 (TCPA disabled)', r.s === 410);
  }

  // ── 18. INCOMING WEBHOOK ───────────────────────────────────────
  console.log('\n═══ 18. INCOMING WEBHOOK ═══');
  {
    // Simulate inbound SMS
    const r = await postForm('/incoming', { From: '+15559990001', Body: 'I support your campaign!' });
    assert('POST /incoming handles inbound SMS', r.s === 200);
  }
  {
    // Opt-out
    const r = await postForm('/incoming', { From: '+15559990002', Body: 'STOP' });
    assert('POST /incoming handles STOP opt-out', r.s === 200);
  }
  {
    // RumbleUp webhook format (JSON with phone/text)
    const r = await req('POST', '/incoming', { phone: '5559990003', text: 'Hello from RumbleUp' });
    assert('POST /incoming handles RumbleUp webhook', r.s === 200);
  }
  {
    // Auto-reply trigger (polling info)
    const r = await postForm('/incoming', { From: '+15559990004', Body: 'Where is my polling location?' });
    assert('POST /incoming generates auto-reply for polling', r.s === 200 && r.d && r.d.reply && r.d.reply.includes('vote.gov'));
  }
  {
    // Auto-reply trigger (registration)
    const r = await postForm('/incoming', { From: '+15559990005', Body: 'How do I register to vote?' });
    assert('POST /incoming generates auto-reply for registration', r.s === 200 && r.d && r.d.reply && r.d.reply.includes('vote.org'));
  }

  // ── 19. MESSAGES ───────────────────────────────────────────────
  console.log('\n═══ 19. MESSAGES ═══');
  {
    const r = await req('GET', '/api/messages');
    assert('GET /api/messages returns inbound messages', r.s === 200 && r.d.messages && r.d.messages.length >= 1);
    assert('Messages include opted-out list', r.d.optedOut && r.d.optedOut.length >= 1);
  }

  // ── 20. STATS ──────────────────────────────────────────────────
  console.log('\n═══ 20. STATS & ANALYTICS ═══');
  {
    const r = await req('GET', '/api/stats');
    assert('GET /api/stats returns system stats', r.s === 200 && r.d.contacts !== undefined && r.d.voters !== undefined);
  }
  {
    const r = await req('GET', '/api/stats/sentiment');
    assert('GET /api/stats/sentiment returns sentiment breakdown', r.s === 200 && r.d.positive !== undefined);
  }
  {
    const r = await req('GET', '/api/analytics/precincts');
    assert('GET /api/analytics/precincts returns precinct analytics', r.s === 200 && r.d.precincts);
  }

  // ── 21. ACTIVITY LOG ───────────────────────────────────────────
  console.log('\n═══ 21. ACTIVITY LOG ═══');
  {
    const r = await req('POST', '/api/activity', { message: 'Test activity entry from stress test' });
    assert('POST /api/activity logs message', r.s === 200 && r.d.success);
  }
  {
    const r = await req('GET', '/api/activity');
    assert('GET /api/activity returns log', r.s === 200 && r.d.logs && r.d.logs.length >= 1);
  }

  // ── 22. EMAIL RECIPIENTS ───────────────────────────────────────
  console.log('\n═══ 22. EMAIL ═══');
  {
    const r = await req('GET', '/api/email/recipients');
    assert('GET /api/email/recipients returns deduped list', r.s === 200 && r.d.recipients);
  }

  // ── 23. EARLY VOTING ──────────────────────────────────────────
  console.log('\n═══ 23. EARLY VOTING ═══');
  {
    // Mark voter as early voted
    const r = await req('POST', '/api/voters/' + voterId + '/early-voted', { vote_date: '2026-02-20', vote_method: 'in_person' });
    assert('POST /api/voters/:id/early-voted marks voter', r.s === 200 && r.d.success);
  }
  {
    // Early voting stats
    const r = await req('GET', '/api/early-voting/stats');
    assert('GET /api/early-voting/stats returns stats', r.s === 200);
  }
  {
    // Import early voting data
    const r = await req('POST', '/api/early-voting/import', {
      rows: [
        { registration_number: 'REG001', first_name: 'Jane', last_name: 'Doe' }
      ],
      vote_date: '2026-02-21',
      vote_method: 'mail'
    });
    assert('POST /api/early-voting/import works', r.s === 200);
  }
  {
    // Filter voters by early voting status
    const r = await req('GET', '/api/voters?early_voting=voted');
    assert('Filter voters by early_voting=voted', r.s === 200 && r.d.voters.length >= 1);
  }
  {
    const r = await req('GET', '/api/voters?early_voting=not_voted');
    assert('Filter voters by early_voting=not_voted', r.s === 200);
  }
  {
    // Extract remaining (non-early voters)
    const r = await req('POST', '/api/early-voting/extract-remaining', { list_name: 'GOTV Remaining' });
    assert('POST /api/early-voting/extract-remaining creates list', r.s === 200);
  }
  {
    // Clear early voted status
    const r = await req('DELETE', '/api/voters/' + voterId + '/early-voted');
    assert('DELETE /api/voters/:id/early-voted clears status', r.s === 200 && r.d.success);
  }
  {
    // Reset all early voting (test endpoint)
    const r = await req('POST', '/api/early-voting/reset', { confirm: true });
    assert('POST /api/early-voting/reset clears all', r.s === 200 && r.d.success);
  }

  // ── 24. ELECTION HISTORY & UNIVERSE BUILDER ────────────────────
  console.log('\n═══ 24. ELECTION HISTORY & UNIVERSE BUILDER ═══');
  {
    // Import election history
    const r = await req('POST', '/api/election-votes/import', {
      rows: [
        { registration_number: 'REG001', election: '2024-General', voted: true },
        { registration_number: 'REG001', election: '2022-General', voted: true },
        { registration_number: 'REG001', election: '2020-Primary', voted: false }
      ]
    });
    assert('POST /api/election-votes/import works', r.s === 200);
  }
  {
    const r = await req('GET', '/api/election-votes/elections');
    assert('GET /api/election-votes/elections lists elections', r.s === 200 && r.d.elections);
  }
  {
    // Universe preview
    const r = await req('POST', '/api/universe/preview', {
      precincts: ['PCT-01', 'PCT-02'], years_back: 8
    });
    assert('POST /api/universe/preview returns counts', r.s === 200);
  }
  {
    // Universe build
    const r = await req('POST', '/api/universe/build', {
      precincts: ['PCT-01', 'PCT-02'],
      years_back: 8,
      list_name_universe: 'Universe 2026'
    });
    assert('POST /api/universe/build creates lists', r.s === 200 && r.d.success);
  }

  // ── 25. VOTER ENRICHMENT ───────────────────────────────────────
  console.log('\n═══ 25. VOTER ENRICHMENT & CANVASS IMPORT ═══');
  {
    // Enrich voters
    const r = await req('POST', '/api/voters/enrich', {
      rows: [
        { registration_number: 'REG001', phone: '+15552001001', address: '123 Main St Updated' },
        { first_name: 'Mike', last_name: 'Brown', phone: '+15552001099' }
      ]
    });
    assert('POST /api/voters/enrich processes enrichment', r.s === 200);
  }
  {
    // Canvass import
    const r = await req('POST', '/api/voters/import-canvass', {
      rows: [
        { first_name: 'Jane', last_name: 'Doe', phone: '+15552001001', support_level: 'strong_support', notes: 'From canvass' }
      ],
      create_new: false
    });
    assert('POST /api/voters/import-canvass matches & updates', r.s === 200);
  }

  // ── 26. VOTER BULK DELETE ──────────────────────────────────────
  console.log('\n═══ 26. VOTER BULK OPERATIONS ═══');
  {
    // Create a temp voter to delete
    const r0 = await req('POST', '/api/voters', { first_name: 'Temp', last_name: 'Voter', phone: '+15559999888' });
    if (r0.d.id) {
      const r = await req('POST', '/api/voters/bulk-delete', { ids: [r0.d.id] });
      assert('POST /api/voters/bulk-delete removes voters', r.s === 200 && r.d.success);
    }
  }
  {
    // Delete single voter
    const r0 = await req('POST', '/api/voters', { first_name: 'Del', last_name: 'Me', phone: '+15559999777' });
    if (r0.d.id) {
      const r = await req('DELETE', '/api/voters/' + r0.d.id);
      assert('DELETE /api/voters/:id works', r.s === 200 && r.d.success);
    }
  }

  // ── 27. CONTACTS CLEAR ALL ─────────────────────────────────────
  // (Run last since it wipes contacts)
  console.log('\n═══ 27. CLEANUP TESTS ═══');
  {
    // Verify contacts exist before clear
    const before = (await req('GET', '/api/contacts')).d.contacts;
    assert('Contacts exist before clear', before && before.length >= 1);
    const r = await req('DELETE', '/api/contacts', { confirm: true });
    assert('DELETE /api/contacts clears all', r.s === 200 && r.d.success);
    const after = (await req('GET', '/api/contacts')).d.contacts;
    assert('All contacts cleared', after.length === 0);
  }

  // ── 28. AUTH LOGOUT ────────────────────────────────────────────
  console.log('\n═══ 28. AUTH LOGOUT ═══');
  {
    const r = await req('POST', '/api/auth/logout');
    assert('POST /api/auth/logout succeeds', r.s === 200 && r.d.success);
  }
  {
    // Verify logged out
    const r = await req('GET', '/api/auth/status');
    assert('After logout, auth status is unauthenticated', r.s === 200 && !r.d.loggedIn);
  }

  // ═════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '═'.repeat(60));
  console.log('  STRESS TEST COMPLETE');
  console.log('  Passed: ' + passed + '  Failed: ' + failed + '  Time: ' + elapsed + 's');
  if (errors.length > 0) {
    console.log('\n  FAILURES:');
    errors.forEach(e => console.log('    - ' + e));
  }
  console.log('═'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
