# P2P Texting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add peer-to-peer texting with AI-powered reply suggestions, volunteer online/offline routing, and campaign knowledge base to CampaignText HQ.

**Architecture:** New sidebar pages (P2P Texting + Campaign Knowledge Base) with Express routes, SQLite tables, and Anthropic Claude API integration. Vanilla JS SPA frontend matching existing dark-theme UI patterns.

**Tech Stack:** Express.js, better-sqlite3, @anthropic-ai/sdk, vanilla JS (no framework), Twilio SMS

---

### Task 1: Install Anthropic SDK

**Files:**
- Modify: `package.json`

**Step 1:** Run `npm install @anthropic-ai/sdk`
**Step 2:** Verify with `node -e "require('@anthropic-ai/sdk'); console.log('OK')"`
**Step 3:** Commit `package.json` and `package-lock.json`

---

### Task 2: Database Schema

**Files:**
- Modify: `db.js` (append after line 153)

**Step 1:** Add Phase 3 tables: `p2p_sessions`, `p2p_volunteers`, `p2p_assignments`, `campaign_knowledge`, `response_scripts`, `settings` plus ALTER TABLE migrations for `messages.session_id` and `messages.volunteer_name`

**Step 2:** Verify tables with `node -e "require('./db')"`
**Step 3:** Commit

---

### Task 3: Settings & Knowledge Base API

**Files:**
- Create: `routes/knowledge.js`
- Modify: `server.js` (add route mount after line 20)

**Step 1:** Create CRUD endpoints for `/api/settings/:key`, `/api/knowledge`, `/api/scripts`
**Step 2:** Mount in server.js
**Step 3:** Commit

---

### Task 4: AI Response Engine

**Files:**
- Create: `routes/ai.js`
- Modify: `server.js` (add route mount)

**Step 1:** Build `buildCampaignContext()` that assembles system prompt from campaign_knowledge table
**Step 2:** Build `findBestScript()` for fallback script matching by sentiment
**Step 3:** Create `POST /api/p2p/suggest-reply` — tries Claude API first, falls back to scripts, then returns `source: 'none'`
**Step 4:** Mount and commit

---

### Task 5: P2P Core API Routes

**Files:**
- Create: `routes/p2p.js`
- Modify: `server.js` (add route mount + update `/incoming` webhook)

**Step 1:** Create session CRUD, volunteer join/status, queue management, send/skip/complete endpoints
**Step 2:** Implement smart routing helpers: `redistributeContacts()`, `snapBackConversations()`, `assignFreshBatch()`, `getLeastLoadedVolunteer()`
**Step 3:** Update `/incoming` webhook to detect P2P replies and mark assignments as `in_conversation`
**Step 4:** Mount and commit

---

### Task 6: Frontend — Knowledge Base Page

**Files:**
- Modify: `public/index.html`

**Step 1:** Add sidebar nav items for P2P and Knowledge Base
**Step 2:** Add Knowledge Base page HTML (AI settings, campaign details, bio, policies, scripts)
**Step 3:** Add Knowledge Base JavaScript (CRUD for all knowledge types)
**Step 4:** Commit

---

### Task 7: Frontend — P2P Texting Page

**Files:**
- Modify: `public/index.html`

**Step 1:** Add P2P page HTML with three views: admin session list, session detail dashboard, volunteer queue
**Step 2:** Add P2P JavaScript: session creation, volunteer join, queue loading, send/skip, online/offline toggle, conversation thread with AI suggestions
**Step 3:** Wire up nav handler for P2P page
**Step 4:** Commit

---

### Task 8: Push to GitHub and Verify Deployment

**Step 1:** Push all commits to GitHub (browser method or git push)
**Step 2:** Verify Railway auto-deployment
**Step 3:** Test all new endpoints on live site
