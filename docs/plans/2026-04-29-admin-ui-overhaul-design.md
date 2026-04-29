# Admin UI Overhaul — Design

**Date:** 2026-04-29
**Approved by:** Luis ("do it all make it easy to use in iPad")

## Goal

Bring the admin app (`public/index.html`, ~18K lines) from "rough internal tool" to "feels like a product." Specifically optimize for iPad use since Luis runs the campaign from one.

## Current state (audit)

| Metric | Value | Implication |
|---|---|---|
| File size | 18,229 lines | Lots of complexity in one file |
| Pages in sidebar | 18 (flat) | Crowded, hard to scan |
| Inline `style=...` | 1,931 instances | No abstraction; consistency is hard |
| Media queries | 2 only | Desktop-only; iPad squishes the desktop layout |

## Scope — 10 improvements grouped into 5 commit batches

### Batch 1: Foundation
1. **Toast notification system** — reusable `showToast(msg, type)` for success/error feedback. Adopted at the most critical save/error sites first (broadcast send, list edit, etc.); other sites adopt over time.
2. **Utility CSS classes** — extract the most common 30 inline-style patterns (`.text-sm`, `.text-mute`, `.row`, `.gap-8`, `.badge-sm`, etc.). Doesn't touch existing code; future code becomes shorter.

### Batch 2: iPad responsive layer
3. **Collapsing sidebar at narrow widths** (`@media max-width: 1024px`): sidebar narrows to 60px with icon-only items; tap an icon → full overlay panel slides in.
4. **Stat card grid** — 5 across becomes 2-up on iPad portrait, 3-up on iPad landscape.
5. **Voter table** — horizontal scroll with sticky first column (Name) so the user can swipe through columns.
6. **44px minimum touch targets** for all primary buttons (current many are 28-32px which is hard to tap).
7. **Sticky bottom save/cancel bar in modals** — applies to voter detail, broadcast composer, list editor.

### Batch 3: Sidebar grouping
8. **18 flat pages → 4 grouped sections**:
   - **Operations**: Dashboard, Texting, Inbox, Block Walking, GOTV Chase
   - **Voters**: Voter File, Contacts, Events, Polls & Surveys
   - **Analytics**: Analytics, Trends
   - **Setup**: Messaging, Auto-Reply, RumbleUp, Knowledge Base, Candidates, Users, Volunteers

### Batch 4: Per-page polish
9. **Loading skeletons** on the 5 highest-traffic pages (Dashboard, Voter File, Inbox, GOTV, Block Walking) — replace "Loading..." text with shimmer placeholder cards so the layout doesn't jump on data load.
10. **Better empty states** with illustration + call-to-action on the same 5 pages.
11. **Filter chips** above the Voter File table — show active filters as removable chips.

### Batch 5: Polish
12. **Badge sizing consistency** — adopt `.badge-sm` / `.badge-md` everywhere; one visual rhythm across the app.
13. **Keyboard shortcuts**: `/` focuses search, `Esc` closes any modal, `Cmd+K` opens command palette to jump pages.

## Out of scope (YAGNI)

- Full CSS rewrite (hundreds of inline styles stay; only the most-repeated 30 get classes)
- New page designs — only structural / interactive improvements
- Removing existing features
- Theme toggling (dark mode is locked in; light mode would be its own project)

## Why these specific choices for iPad

The iPad-specific moves (sidebar collapse, stat-card stack, sticky modal bars, 44px tap targets, horizontal-scroll table with sticky first column) are the standard Apple-approved tablet-friendly patterns. Touch targets must be 44pt+ per the iOS HIG. Sticky first column on tables is what spreadsheet apps do for narrow viewports. Sidebar overlay (vs always-visible) is the standard iPad app pattern (Mail, Notes, Files all do this).

## Execution order

Foundation (1, 2) first because everything else uses them. iPad responsive (3-7) next because it's the user's main pain point and needs to settle before per-page polish so the polish targets the right layout. Sidebar grouping (8) is independent. Per-page polish (9-11) and final polish (12-13) last.

Push between each batch so a regression in any one batch can be isolated.
