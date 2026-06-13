# WeBetAI — Product Build State (canonical, read me first)

> Any agent (cloud routine, fresh session, overnight run) starts HERE. Read this + the
> Iteration Backlog in the charter, do the work, then UPDATE both. Never redo items
> listed under DONE. Last updated: 2026-06-13 00:15 ET. X login fixed + founder-confirmed on real iPhone.

## What this product is
AI sports-picks platform. Betty (the LLM, /dashboard chat) is the primary interface —
users ask, she delivers today's card; onboarding happens IN conversation, never as
homepage chrome (founder directive — homepage stays exactly as designed). /alpha = daily
picks card + live track record. WeBits = credit economy (1,000 granted at signup).

## Charter (full backlog + safety rails)
~/.gstack/projects/wcgbk-webet-social-intelligence/bk-main-design-20260612-180500.md
Cycle history: PRODUCT-LOOP-LOG.md (repo root). Both must be updated every cycle.

## DONE — never rebuild (evidence in git log + charter)
- Models v10.3-alpha-sharp + v11.1-mvp live; crons 12:00/13:00 UTC; shrinkage calibration
  (K: totals .30 / spreads .35 / ML .50 fitted on 428 real picks), Kelly ×50, 3% EV floor,
  per-market total σ, soccer off (alpha), +160 dog cap. MVP totalZ crash fixed.
- Feedback loops repointed to alpha store; 3am ET settle run; crash-vs-quiet markers in
  no-plays path; verify-picks QA → alpha store, Discord link → /alpha.
- /percentile rewritten for v10.3, header removed.
- Narrative opener quotes calibrated edge (matches badge).
- WeBit funnel LIVE: /credits buttons wired → /checkout (TEST-badged, idempotent) →
  webit-mock-pay fn → webit-ledger (one blob per event) + credit_balance on wbai-users.
  E2E-verified purchase: 1,000 → 16,000 on founder account.
- /webit = canonical WeBit page, header removed; dashboard coin + balance → /webit;
  avatar = profile entry only. nav.js token icon → /webit.
- /alpha header: stale Beta Picks links removed; auth chip live (nav.js).
- X OAuth: authorize moved twitter.com → x.com (mobile login-loop fix; founder retest pending).
- Homepage: RESTORED TO ORIGINAL — do not add nav items/chips there again.
- Betty picks delivery verified live (chat returns today's card, mobile, 0 console errors).
- Onboarding v1 LIVE (loop-c4): Betty-led, in-conversation on /dashboard — sports chips ->
  matching pick cards render in chat (honest empty note) -> X sign-in offer + WeBits welcome;
  guest prefs merge to wbai-users on login (user-prefs fn); funnel-event fn instruments
  shown/chosen/edges/signin/saved/skipped (funnel-events store). Test hook ?onboard=force.
- Premium gate v1 LIVE (2026-06-12 loop-c3): get-picks-premium fn (session+balance, idempotent
  1-WeBit daily unlock, audit event in webit-ledger, picks read via blobs REST API — SDK store
  reads return null in fn runtime); public get-picks-alpha strips kellyCalc/kellyFraction/zScore
  (never rendered free); /alpha Sharp Depth bar + per-card depth blocks. E2E: unlock charged
  exactly 1 (16,000→15,999), re-click no double charge, 0 console errors.

## NEXT (top of backlog, in order)
1. /login gateway — X (live) + SMS via Twilio Verify (rate-limit phone+IP); email/Google
   UI behind PROVIDER_READY flags (no creds yet).
2. Canonical identity (one userId, link X+phone, ledger keyed on it).
3. /app shell consolidation (dashboard content merges; admin stays separate role-gated URL).
4. Pick3P2P same-login integration (local pick3p2p/ + pick3p2p.com site d8231945).
5. Admin funnel report page (funnel-events store now collecting; report is role-gated admin page).

## Conventions every cycle MUST follow
- Deploy: `npx netlify deploy --prod --dir . --skip-functions-cache` (NETLIFY_AUTH_TOKEN
  env; token in founder's key doc, never in repo files).
- RAILS before deploy: `shasum -a 256 -c PRODUCT-LOOP-BASELINE.sha256 --quiet` must pass
  (protected: generate-picks-*, track-clv, verify-picks, self-optimize, netlify.toml, /edge).
  The two pre-existing dirty pipeline files ARE production — never commit/revert/modify.
- Deploy blackouts (UTC): 11:55–13:20 and 13:55–14:40.
- Blob writes ONLY to: webit-ledger, funnel-events, user-profiles, wbai-users user records.
  NEVER edge-picks*.
- QA: live-site verification required; auth/purchase flows tested LOGGED-OUT; anything
  auth-related gets flagged for founder real-iPhone retest (emulated 390px ≠ real device —
  proven 2026-06-12). Zero console errors. Commit per cycle (Co-Authored-By Claude).
- Design: match the surface you're touching (product pages = light teal #004C54 family;
  homepage/credits/checkout = dark). Full OG meta on new pages. Honest copy only — live
  record via get-results-alpha, never invented numbers, never "guaranteed".

## Pending founder inputs (blocked items — skip, don't stall)
- Stripe account + TEST keys → swaps mock processor for real checkout (charter 3b).
- Google OAuth client + email provider key (Resend/Postmark) → activates last 2 logins.

## Verification endpoints (quick health)
- /api/get-picks-alpha , /api/get-picks-mvp (model version + picks count)
- /api/get-results-alpha (record/ROI; straight+parlay totals)
- auth flow: /.netlify/functions/auth-x-init → location header must be x.com
