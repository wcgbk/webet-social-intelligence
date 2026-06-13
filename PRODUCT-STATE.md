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
- Pick3P2P unified-account v1 LIVE (loop-c6): dashboard P2P panel -> same-domain /pick3p2p;
  WeBetAI bridge strip (handle + live WeBit balance, /login CTA when signed out); SMS-first
  users auto-adopt verified phone (skip page phone-login); picks source beta->alpha; stake
  select = WeBits (0/50/100/250); p2p-stake fn escrows idempotently to webit-ledger (verified:
  50 escrowed, re-call alreadyEscrowed, bal 15,949). LIMITATIONS -> backlog: stake PAYOUT
  resolution (read escrow events by challengeId + grade via check-resolution); X-users w/o
  phone still use page's own phone step to pick (fixed by canonical identity); pick3p2p.com
  external domain still separate — point its DNS at this site or deprecate.
- Sports Markets QA + WeBit unify (loop-c15): BettorEdge pull VERIFIED CORRECT (/api/get-bettoredge-markets
  returns live orders/odds/volume; '----' cells = real thin exchange liquidity, not a bug). Page unified
  with WeBit account: real balance (auth-me, was fake E10,000), currency=WeBits, sign-in gate, unified
  identity on created bets. v2 follow-up: WeBit escrow + settlement for single-line market wagers.
- Pick3P2P game times + started-lock (loop-c14): rows show ET start time (AI=commenceTime,
  avail=matched ESPN startTime); started games lock (ESPN in/post or time passed) — only
  not-yet-started games pickable. gameStartInfo() helper; pickSide JS guard + disabled row.
- Pick3P2P PERFECTED (loop-c13): two-sided wager — opponent MATCHES stake on accept (was
  one-sided, pot was wrong); self-challenge guard; settlement shown in My Challenges (Won/Lost/
  refunded); respond btn 'Lock Picks & Stake N'; dashboard leaderboard unified + WeBits currency.
  Escrow keys reconcile across challenger/opponent/SMS. Remaining v2 polish: spread grading (ML
  approx), escrow-before-respond atomicity (pre-check covers common case), real-game payout test.
- P2P grading + settlement LIVE (loop-c9): p2p-settle grades picks vs ESPN finals (team-name=ML,
  O/U vs total; spreads approximated as ML — v2 refinement), winner takes pot from webit-ledger
  escrows, tie/expired refund, idempotent (settle marker + per-event keys); page lazily settles
  the signed-in user's due challenges each visit. ⚠️ ALL functions must stay git-tracked —
  untracked fns get DROPPED by deploys (this killed auth-x-callback/X login on 2026-06-13).
- One login everywhere (loop-c8): Pick3P2P page phone-gate REMOVED — unified /login is the only
  auth; X users (no phone) pick, create, and respond via wbai:{id} identity end-to-end. Full game
  E2E verified in-product as X user: picks -> DM create -> escrow -> recipient landing.
- X-DM challenge delivery LIVE (loop-c7): create-modal toggle Text/X-DM; DM mode = deliver:'link'
  (no friend phone needed; X users use wbai:{id} identity), opens prefilled x.com/messages/compose
  with invite; invite links unified to webetsocial.com/pick3p2p/?challenge=; WeBits copy everywhere.
- /login gateway LIVE (loop-c5): X primary + SMS code login via existing Twilio Messages API
  (HMAC OTP, 10-min TTL, 3/phone/hr + 10/IP/hr limits, 8-attempt cap); auth-sms-verify mints
  sessions identical to X callback; sms_ users get 1,000 WeBits; email/Google = SOON flags.
  NOTE env name: TWILIO_PHONE_NUMBER (TWILIO_FROM does not exist). Real-SMS send untested —
  founder 30-sec test pending. Funnel beacon login_view live.
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
1. (done loop-c9: P2P settlement — see DONE) — payout/refund: aggregate webit-ledger evt_*_p2pstake_{challengeId}
   escrows, grade challenges via check-resolution pattern, credit winner (idempotent), refund
   on expiry/decline. Required before stakes are user-facing-final.
2. Admin funnel report — role-gated page + summary fn reading funnel-events store (SDK
   namespace! REST list shows empty — SDK and legacy REST blobs are SEPARATE namespaces;
   edge-picks-* = REST-written, webit-ledger/funnel-events/wbai-users = SDK-written).
3. Canonical identity (one userId, link X+phone — SMS-first users currently get a separate
   sms_ account; linking merges balances/prefs) (one userId, link X+phone, ledger keyed on it).
5. /app shell consolidation (dashboard content merges; admin stays separate role-gated URL).
(done: Pick3P2P v1 — see DONE)
3. (moved to #1)

## Conventions every cycle MUST follow
- ⚠️ KNOWN UNTRACKED RISK: the old live site had ~266 curated files; the git-tracked set is smaller, so untracked-but-live pages/assets/functions get DROPPED by every deploy. Already restored: dashboard menu pages (betty,guardian,mlb,p2p-sports,p2p-trending), site images, ALL 168 functions. STILL UNTRACKED (may 404 from non-dashboard links): authenticity, rif, prediction-markets, scorecard, fox, predictions, props, scanner, etc. — restore on report or do a full sweep. Before deleting/assuming a 404 is intentional, check if the dir exists locally & is just untracked.
- ⚠️ DEPLOY SHIPS ONLY GIT-TRACKED FILES (proven 2026-06-13: untracked images 404'd in prod —
  the CLI walks the git index, not the directory). ANY new/needed static asset MUST be
  `git add`-ed BEFORE deploying. The old curated live set (~266 files) was replaced by the
  tracked set; if a legacy page 404s an asset, find it locally, git add, redeploy.
- Deploy: `npx netlify deploy --prod --dir . --skip-functions-cache` (NETLIFY_AUTH_TOKEN
  env; token in founder's key doc, never in repo files).
- RAILS before deploy: `shasum -a 256 -c PRODUCT-LOOP-BASELINE.sha256 --quiet` must pass
  (protected: generate-picks-*, track-clv, verify-picks, self-optimize, netlify.toml, /edge).
  The two pre-existing dirty pipeline files ARE production — never commit/revert/modify.
- Deploy blackouts (UTC): 11:55–13:20 and 13:55–14:40.
- Blob writes ONLY to: webit-ledger, funnel-events, user-profiles, wbai-users user records.
  NEVER edge-picks*.
- POST-DEPLOY SMOKE CHECK (mandatory, added after the Jun-13 incident where --skip-functions-cache
  deploys silently DROPPED function registrations — betty-chat 404'd for ~40 min): after EVERY
  deploy, curl must return 200/expected on: betty-chat-beta (POST), get-picks-alpha, auth-x-init
  (302 to x.com), webit-mock-pay (405 on GET is fine). If any fail, redeploy WITHOUT
  --skip-functions-cache immediately.
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
