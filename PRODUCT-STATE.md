# WeBetAI — Product Build State (canonical, read me first)

> Any agent (cloud routine, fresh session, overnight run) starts HERE. Read this + the
> Iteration Backlog in the charter, do the work, then UPDATE both. Never redo items
> listed under DONE. Last updated: 2026-08-22 ET. ⚠️ FOUNDER REVERT: alpha is the EXACT
> 6/29 state again (v10.3, commit 133c57a — v10.4+ fixes deliberately NOT live on alpha;
> do not re-apply without Ben). NEW: /omega split-test environment (full alpha duplicate,
> edge-picks-omega store, own 9am/10:30/Sun crons, KPIs from 2026-08-22; CLV capture
> deferred to Odds-API quota renewal ~28th). QA now includes the Hard Rock Bet
> placeability check in verify-picks + verify-picks-omega.
> Historical (superseded on alpha, still true as history): 2026-08-03 v10.4-alpha-mlb settlement truth
> (track-clv DH/PPD/F5 + overnight sweep), EV ranking, per-market caps, feedback loops demoted
> to observer, parlay optimizer un-vetoed. See first DONE bullet.

## What this product is
AI sports-picks platform. Betty (the LLM, /dashboard chat) is the primary interface —
users ask, she delivers today's card; onboarding happens IN conversation, never as
homepage chrome (founder directive — homepage stays exactly as designed). /alpha = daily
picks card + live track record. WeBits = credit economy (1,000 granted at signup).

## Charter (full backlog + safety rails)
~/.gstack/projects/wcgbk-webet-social-intelligence/bk-main-design-20260612-180500.md
Cycle history: PRODUCT-LOOP-LOG.md (repo root). Both must be updated every cycle.

## DONE — never rebuild (evidence in git log + charter)
- **CFB (College Football) pipeline LIVE (2026-08-28, founder-directed; commit cfabceb):**
  full NFL-environment clone for the FBS slate, isolated in edge-picks-cfb → /cfb page +
  dashboard "College Football Picks" menu item (panel-cfb iframe, ?view=cfb deep link).
  generate-picks-cfb-background v1.0-cfb: market-anchored (no static seed for 130+ FBS
  teams; ESPN standings overlay when games exist; hard drift clamps ±4 spread / ±5 total),
  school-keyed team matching (nickname collisions: LSU Tigers ≠ Auburn Tigers), FBS
  scoreboard needs groups=80&limit=300. Cron trigger-picks-cfb 15:05 UTC; off days write
  "No College Football Games Scheduled For Today". get-results-cfb lazy ESPN grading,
  KPIs from zero; track-clv-cfb fired by trigger-clv after alpha + NFL. Fixed the predCLV
  mis-attachment inherited from the NFL generator (pushCand returns the pushed candidate)
  — the SAME bug is still in generate-picks-nfl-background (flagged, not yet fixed there).
- **NFL pipeline LIVE (2026-08-06, founder-directed; v1.1-nfl 2026-08-18):** separate
  environment from alpha, shaped to merge later. generate-picks-nfl-background v1.1-nfl
  runs the regular-season process even while ESPN still labels the slate preseason:
  live standings overlay + QB-out, key-number cover (3/7), independent 50/50 totals,
  Pinnacle predCLV floor −2¢, 2+ major US books with Hard Rock preferred, 3% EV floor,
  NO forced leans, 3+1 of the published card, regular-season caps 2.5u / 0.5u ML.
  Cron always fires; off days write "No NFL Games Scheduled For Today" (not indexed
  on the track record). get-picks-nfl never serves a stale last-game-day card.
  get-results-nfl grades only explicit parlayLegs (phantom 3-leg synthesis killed).
  track-clv-nfl writes clv-{date} into edge-picks-nfl; trigger-clv fires it after alpha.
- **v10.4-alpha-mlb (2026-08-03, full optimization pass after post-ASB review):** settlement
  writer fixed (track-clv: DH disambiguation by commenceTime, postponed→push, F5 linescore
  guards, ESPN-grade-FIRST ordering, awaited overnight settle + 7-day unsettled sweep; dead
  calibrate-95 cron removed from netlify.toml); generator ranks/selects on calibrated EV
  (z-score demoted to diagnostic), DH source collisions fixed (consensus/pitcher/FIP/F5-odds
  keyed per game), two-sided no-vig prior in alt-line + weather recalibrations, spread
  stale/contrarian sign flipped, BettorEdge REMOVED from decision path, self-opt + CLV live
  mutation channels REMOVED (self-optimize.js rebuilt as observer w/ real-ROI buckets +
  grade-inversion alarm), per-market unit caps (ML 0.5u / F5 0.5u / Total 1.5u / RL 1.0u),
  lean floor restored to 3%, storePicks overwrite guard (force:true to override, settled
  results always carried), parlay optimizer un-vetoed (pseudo-rejections no longer poison
  the pool) + 0.25u-lean-card rule enforced + verify-picks preserves the generator parlay
  (rebuilds only on invalidated legs, keeps commenceTime). Baseline hashes regenerated.
- Models v10.3-alpha-sharp + v11.1-mvp live; crons 12:00/13:00 UTC; shrinkage calibration
  (K: totals .30 / spreads .35 / ML .50 fitted on 428 real picks), Kelly ×50, 3% EV floor,
  per-market total σ, soccer off (alpha), +160 dog cap. MVP totalZ crash fixed.
- Feedback loops repointed to alpha store; 3am ET settle run; crash-vs-quiet markers in
  no-plays path; verify-picks QA → alpha store, Discord link → /alpha.
- /percentile rewritten for v10.3, header removed.
- /mvp RESTORED (was 404 — untracked dir dropped by every deploy; now git-tracked) + reformatted
  to /alpha's exact design/layout (cloned, retargeted to get-picks-mvp/get-results-mvp, premium
  Sharp-Depth gate stripped for the lab, experimental banner added). New /mvpalpha = champion-vs-
  challenger A/B page (side-by-side ROI/record/accuracy/PL from both result stores, same-game
  head-to-head w/ agree/differ, no-winner-until-25-graded guardrail). _redirects routes /mvpalpha
  (netlify.toml left hash-pristine). Deployed from main; PR #3 funnel untouched.
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
- Trending Challenges = PREDICTION-MARKET topics + WeBit Yes/No bets (loop-c20, CORRECTED from c19
  sports mistake): page shows trending prediction topics (politics/elections, get-webet-content);
  Bet Yes/No -> WeBit modal (stake + X-DM/Text delivery, even-money winner takes 2x); market-bet
  supports market=prediction (invites->/p2p-trending, settle skips ESPN +21d unresolved-refund);
  WeBit bridge real balance. OPEN: content stale (Apr 13) — needs generate-webet-content-background
  refresh. (c19 also built get-trending-challenges fn — repurposable as an open-bets discovery feed.)
  Superseded note: 'Take the other side' cards linking to accept flows; removed
  107 lines dead STATIC_ARTICLES. Verified live (5 open challenges, real balance, 0 errors).
- Sports Markets real lines via Odds API (loop-c18): get-bettoredge-markets also pulls The Odds
  API (h2h/spreads/totals) and attaches consensus ML/spread/total to every game; page renders
  full spread/pick/total board for ALL games (live BettorEdge order marked • > Odds API line >
  even-money pick'em). Env ODDS_API_KEY. Verified: zero-liquidity games now fully bettable.
- Sports Markets full slate (loop-c17): shows ALL games regardless of BettorEdge liquidity —
  backend merges full ESPN schedule (MLB/NBA/NHL) with exchange orders overlaid; ML always
  bettable even-money pick'em, spread/total where exchange has a line, live games locked.
  Even-money head-to-head (winner takes 2x) = the market-bet-settle model.
- P2P MARKET BETS LIVE (loop-c16): BettorEdge methodology, free WeBit version. market-bet fn
  (create escrows WeBits, X-DM/Twilio delivery; accept=opponent takes other side+matches stake,
  self-guard) + market-bet-settle (grade line vs ESPN, winner takes pot, push/expiry refund,
  idempotent); market-bets store. p2p-sports: WeBit stake + X-DM/Text toggle + invite-accept
  (?bet=) + lazy settle. E2E verified live (escrow 999->949, invite landing, self-guard, 0 errors).
  Swap to real-money BettorEdge later. v2: cross-account settlement payout test (needs 2 accts+final).
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
