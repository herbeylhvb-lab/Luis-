# CallHub Phone Banking Integration — Design Doc

**Date:** 2026-03-28
**Status:** Approved
**Approach:** Full Embedded Integration (Option A)

## Overview

Integrate CallHub's phone banking into Campaign Text HQ so volunteers can make calls from the same volunteer portal they use for texting and walking. Admin creates campaigns from the dashboard, volunteers call from the volunteer portal, results auto-sync back to voter records.

## User Stories

1. **Admin** picks a voter list → creates a phone bank campaign → pushes contacts to CallHub
2. **Volunteer** logs into `/volunteer` → picks "Phone Banking" role → sees active campaigns → clicks "Start Calling" → CallHub agent console opens → they make calls
3. **Results** flow back via webhook → logged as `voter_contacts` with `contact_type = 'phone'`
4. **Admin** sees live stats: calls made, contact rate, results breakdown

## Architecture

```
Admin Panel                Volunteer Portal              CallHub API
──────────                ────────────────              ──────────
Phone Bank tab            Phone Banking role            REST API v1
- Connect API key         - List campaigns              - Phonebooks
- Create campaign         - Join campaign               - Contacts
- Push voter list         - "Start Calling" →           - Power campaigns
- Monitor live stats        opens agent console         - Agents
- View results          ← Webhook auto-syncs          ← Webhooks
```

## Database Schema

### callhub_config
Stores the CallHub API key (one per installation).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| api_key | TEXT | CallHub API token |
| region | TEXT | API region (default 'us1') |
| created_at | TEXT | Timestamp |

### phone_bank_campaigns
Tracks campaigns created from the admin panel.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| callhub_campaign_id | TEXT | CallHub's campaign ID |
| callhub_phonebook_id | TEXT | CallHub's phonebook ID |
| name | TEXT | Campaign name |
| list_id | INTEGER | Source voter list (admin_lists or captain_lists) |
| list_type | TEXT | 'admin' or 'universe' |
| script | TEXT | Talking points / script text |
| status | TEXT | draft, active, paused, completed |
| total_contacts | INTEGER | Voters pushed to CallHub |
| calls_made | INTEGER | Updated via webhook |
| contacts_reached | INTEGER | Calls that connected |
| created_at | TEXT | Timestamp |

## API Routes

### Admin (require auth)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/callhub/config | Save API key + region |
| GET | /api/callhub/config | Get config (key masked) |
| POST | /api/callhub/campaigns | Create campaign from voter list |
| GET | /api/callhub/campaigns | List all campaigns with stats |
| GET | /api/callhub/campaigns/:id | Campaign detail + results |
| POST | /api/callhub/campaigns/:id/start | Start/resume campaign |
| POST | /api/callhub/campaigns/:id/pause | Pause campaign |
| DELETE | /api/callhub/campaigns/:id | Delete campaign |

### Volunteer (public auth via volunteer code)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/callhub/campaigns/active | List active campaigns |
| POST | /api/callhub/campaigns/:id/join | Add volunteer as CallHub agent, get console URL |

### Webhook (public, no auth — validated by CallHub signature)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/callhub/webhook | Receive call results |

## CallHub API Flow

### Create Campaign
1. `POST /v1/phonebooks/` — create phonebook with campaign name
2. `POST /v1/contacts/bulk_create/` — push voter contacts (name, phone, custom fields)
3. `POST /v1/power_campaign/create/` — create power dialer campaign linked to phonebook
4. `POST /v1/webhooks/` — register webhook for call results

### Add Volunteer as Agent
1. `POST /v2/power_campaign/{id}/agents/add/` — add volunteer email/phone as agent
2. Return agent console URL for the volunteer to open

### Webhook Result Processing
When CallHub fires the webhook after a call:
1. Parse the payload (contact phone, result, duration, notes, agent)
2. Match phone to voter in DB
3. Insert into `voter_contacts` table with `contact_type = 'phone'`
4. Update `phone_bank_campaigns` stats (calls_made, contacts_reached)

## UI Components

### Admin Panel — Phone Bank Tab
- **Setup card:** Enter CallHub API key + test connection
- **Create campaign:** Pick voter list → name → script → "Create & Push to CallHub"
- **Campaign list:** Table with name, status, total/called/reached, actions (start/pause/delete)
- **Campaign detail:** Live stats, result breakdown pie chart, recent calls log

### Volunteer Portal — Phone Banking Role
- New role card on role selection screen (📞 Phone Banking)
- Campaign list showing active phone banks
- "Start Calling" button → opens CallHub agent console (new tab)
- Simple stats: your calls today, contacts reached

## Files to Create/Modify

### New Files
- `routes/callhub.js` — all CallHub API routes
- Admin panel phone bank UI (in index.html, new sub-tab)
- Volunteer portal phone banking role (in volunteer.html)

### Modified Files
- `db.js` — add callhub_config + phone_bank_campaigns tables
- `server.js` — mount callhub routes, add webhook to public auth whitelist
- `public/volunteer.html` — add Phone Banking role card + campaign list + calling UI
- `public/index.html` — add Phone Bank sub-tab in admin panel

## Security

- CallHub API key stored encrypted or at minimum not exposed to frontend (masked in GET)
- Webhook endpoint validates request origin (CallHub IP or signature)
- Volunteer can only join active campaigns, can't create or delete
- Phone numbers sent to CallHub are already in the voter file (no new PII created)

## Testing Plan

1. Save API key → verify connection works
2. Create campaign from a small test list (5 voters) → verify contacts appear in CallHub
3. Add a volunteer as agent → verify they can access the console
4. Make a test call → verify webhook fires and result appears in voter_contacts
5. Check admin stats update in real-time
6. Verify voter detail page shows phone contact history
