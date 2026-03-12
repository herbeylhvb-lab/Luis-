# Setting Up luis@villarealjr.com

## Quick Summary

To get a custom email like `luis@villarealjr.com`, you need two things:
1. **Email hosting** (a provider that handles your mail)
2. **DNS records** (point your domain's email to that provider)

---

## Option A: Zoho Mail (FREE - Recommended for Getting Started)

### Step 1: Sign up
1. Go to https://www.zoho.com/mail/zohomail-pricing.html
2. Choose the **Free Plan** (1 user, 5GB)
3. Click "Sign Up" and enter your domain: `villarealjr.com`

### Step 2: Verify your domain
Zoho will ask you to add a **TXT record** to your DNS to prove you own the domain.

Go to your **domain registrar** (wherever you bought villarealjr.com — GoDaddy, Namecheap, Cloudflare, etc.) and add:

| Type | Name/Host | Value |
|------|-----------|-------|
| TXT  | @         | `zoho-verification=xxxxxxx` (Zoho gives you this) |

### Step 3: Create your email
Once verified, create: `luis@villarealjr.com`

### Step 4: Add MX records
Add these DNS records at your domain registrar:

| Type | Name/Host | Value | Priority |
|------|-----------|-------|----------|
| MX   | @         | `mx.zoho.com`  | 10 |
| MX   | @         | `mx2.zoho.com` | 20 |
| MX   | @         | `mx3.zoho.com` | 50 |

### Step 5: Add SPF record (for deliverability)

| Type | Name/Host | Value |
|------|-----------|-------|
| TXT  | @         | `v=spf1 include:zoho.com ~all` |

### Step 6: Use in CampaignText HQ
Use these SMTP settings in your app's email sender:
- **Host:** `smtp.zoho.com`
- **Port:** `465` (SSL) or `587` (TLS)
- **User:** `luis@villarealjr.com`
- **Password:** Your Zoho mail password (or App Password if 2FA enabled)

---

## Option B: Google Workspace ($7/month)

### Step 1: Sign up
1. Go to https://workspace.google.com
2. Sign up with your domain `villarealjr.com`
3. Create `luis@villarealjr.com`

### Step 2: Add DNS records

| Type | Name/Host | Value | Priority |
|------|-----------|-------|----------|
| MX   | @         | `aspmx.l.google.com`      | 1  |
| MX   | @         | `alt1.aspmx.l.google.com` | 5  |
| MX   | @         | `alt2.aspmx.l.google.com` | 5  |
| MX   | @         | `alt3.aspmx.l.google.com` | 10 |
| MX   | @         | `alt4.aspmx.l.google.com` | 10 |
| TXT  | @         | `v=spf1 include:_spf.google.com ~all` |

### Step 3: Use in CampaignText HQ
- **Service:** `Gmail` (select in app)
- **User:** `luis@villarealjr.com`
- **Password:** App Password (generate at myaccount.google.com > Security > App Passwords)

---

## Option C: Cloudflare Email Routing (FREE - Forwarding Only)

This forwards `luis@villarealjr.com` to your existing email (e.g., your Gmail).
You can then send *from* your existing Gmail as `luis@villarealjr.com`.

### Step 1: Move DNS to Cloudflare
1. Sign up at https://dash.cloudflare.com
2. Add your domain `villarealjr.com`
3. Update nameservers at your registrar to Cloudflare's

### Step 2: Set up Email Routing
1. In Cloudflare dashboard, go to **Email > Email Routing**
2. Add a route: `luis@villarealjr.com` → your personal email
3. Cloudflare automatically adds the required MX and TXT records

### Step 3: Send as luis@villarealjr.com from Gmail
1. In Gmail, go to **Settings > Accounts > Send mail as**
2. Add `luis@villarealjr.com`
3. Use these SMTP settings:
   - Server: `smtp.gmail.com`
   - Port: `587`
   - Username: your Gmail address
   - Password: your Gmail App Password

---

## Which DNS Provider Do You Use?

To add DNS records, you need access to wherever your domain `villarealjr.com` is registered. Common registrars:
- **GoDaddy:** Domains > DNS Management
- **Namecheap:** Domain List > Manage > Advanced DNS
- **Cloudflare:** DNS > Records
- **Google Domains:** DNS > Custom Records

---

## Using Your Custom Email in CampaignText HQ

Once your email is set up with any provider above, your app already supports
sending from `luis@villarealjr.com`. In the email sender, enter:

- **From Name:** `Luis Villarreal` (or `Villarreal Campaign`)
- **SMTP Host/Service:** (depends on provider, see above)
- **SMTP User:** `luis@villarealjr.com`
- **SMTP Password:** Your email password or app password

The app's email system at `/api/email/send` will then send emails from your
custom domain address.
