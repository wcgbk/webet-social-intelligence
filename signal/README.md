# The Signal — automated X content engine for @wcgbk (Ben Klein)

A clone of the AskAPai "Daily Dose" pipeline, repurposed to grow **@wcgbk**. Grok (live X
search) generates daily content across 7 niches in Ben's voice, renders branded cards, and
**auto-posts the low-risk formats while holding sensitive ones for approval** (hybrid mode).

---

## 1. Strategy (the why behind the build)

**Diagnosis of @wcgbk (from the live X API):** aged 2009 blue-check account, 2,028 followers
but only **184 lifetime tweets / 15 media**, inverted follow ratio (following 2,811 > followers),
and typical posts get **4–30 impressions** because they're one-word reactions / bare links /
buried replies — nothing the algorithm can rank. This is a **revival + repositioning** play, not
a cold start. An aged, credible account climbs fast once it ships rankable, original content.

**The three levers (do all three — the engine only owns #1):**

1. **Owned content (automated, this repo).** 3 standalone posts/day + 1 thread, each with a
   branded image, original insight, and a reply-bait close. Fixes the "posting into the void" problem.
2. **Profile positioning (manual, one-time).** Prune following to >2:1 ratio. Rewrite bio to a
   *wedge* not a title. Replace the pinned tweet with a value anchor. See `STRATEGY` section below.
3. **Engagement loop (manual, daily ~20 min).** Reply with *substance* to 5–10 big accounts in
   your lanes within their first 10 min. No tool can fake this; it's the fastest follower source.

**Content pillars (broad, all 7 niches):** politics · startups · vc · economy · crypto ·
personal-development · quotes. The engine rotates a "preferred niche" by day so a week covers
the spread, but lets Grok override toward the biggest live story so posts stay trend-relevant.

**Positioning recommendations (apply manually):**
- **Bio:** *"Helping founders win in the AI era. Building @AskAPai — exposing manipulation,
  propaganda & spin. Daily signal on startups, markets & the war for attention."*
- **Pin:** swap "USA 🇺🇸 + link" (40 impressions) for a thread or manifesto post.
- **Ratio:** prune following 2,811 → < ~800.
- **Unique wedge:** the "Spot the PsyOp" / manipulation-lens angle is *ownable* — nobody in
  founder-X does daily propaganda-detection. Worth leaning into over time.

---

## 2. Architecture

Mirrors Daily Dose: thin **scheduled background functions** (15-min limit) each generate one
"slot", classify its risk, then auto-post or queue. Idempotent per `posted:{date}:{slot}`.

```
netlify/functions/
  lib/grok.js     — xAI Grok caller w/ live x_search, ET date helpers
  lib/x.js        — OAuth 1.0a poster, ACCOUNT-GUARDED to @wcgbk (id 50018957)
  lib/render.js   — branded "The Signal" card (SVG→PNG via resvg, fonts from jsDelivr)
  lib/engine.js   — voice, niche rotation, slot prompts, risk gate, runSlot orchestrator
  lib/gate.js     — scheduled-vs-manual trigger gate
  slot-morning-take-background.js   — ~8:30a ET  · single hot take    · autopost if low-risk
  slot-daily-thread-background.js   — ~11:00a ET · 4-6 tweet thread   · ALWAYS held for approval
  slot-midday-lesson-background.js  — ~1:00p ET  · operator lesson    · autopost if low-risk
  slot-evening-quote-background.js  — ~7:00p ET  · original quote card · autopost if low-risk
  review-drafts.js — approval dashboard backend (list / approve / reject / edit)
review/index.html  — approval UI (gated by REVIEW_KEY)
index.html         — simple landing page
```

**Hybrid gate (`engine.js`):** a draft auto-posts only if
`SIGNAL_AUTOPOST=on` **AND** the slot is autopost-eligible **AND** risk is `low`.
Risk = `sensitive` when Grok flags it OR a keyword backstop matches (politicians, culture-war
topics, price-calls, named accusations). Threads are **always** held. Everything else that's
flagged is held. Held drafts appear at **`/review`**; nothing posts without a click.

**Fail-safe:** before X tokens are configured, the account guard simply throws and the post is
**held as a draft** instead — so deploying early can't post garbage. Nothing posts until both
(a) tokens are set and (b) the authed account is verified as @wcgbk.

---

## 3. Setup

### 3a. Prerequisite — generate @wcgbk OAuth tokens ⚠️
The X tokens in the shared vault are for a **different account** (id `1845323299460612098`),
not @wcgbk (`50018957`). In the [X developer portal](https://developer.x.com), under your app's
**Keys and tokens**, generate an **Access Token & Secret while logged in as @wcgbk** (app needs
**Read and Write**). Those four values go into the env below. The account guard will refuse to
post until `users/me` returns @wcgbk.

### 3b. Netlify env vars
```
XAI_API_KEY        = xai-…            # ⚠ currently over its spending limit — top up xAI credits
X_CONSUMER_KEY     = …                # app consumer key
X_CONSUMER_SECRET  = …                # app consumer secret
X_ACCESS_TOKEN     = …                # @wcgbk access token  (see 3a)
X_ACCESS_SECRET    = …                # @wcgbk access secret (see 3a)
WCG_X_ID           = 50018957         # account guard (default; only change if handle changes)
SIGNAL_AUTOPOST    = on               # on = hybrid; off = queue EVERYTHING for review
TRIGGER_SECRET     = <random>         # gates manual ?key= runs
REVIEW_KEY         = <random>         # gates the /review dashboard
SIGNAL_SITE        = https://<site>.netlify.app   # used in approval notifications
SIGNAL_DISCORD_WEBHOOK = <optional>   # ping a Discord channel when a draft needs approval
BLOBS_SITE_ID / BLOBS_TOKEN           # only if Blobs isn't zero-config on your deploy
```

### 3c. Deploy
New Netlify site, `signal/` as base dir. `npm install` runs automatically; `netlify.toml`
registers the 4 crons. Visit `/review?key=REVIEW_KEY` to see the queue.

---

## 4. Operating it

- **Preview without posting:** `GET /.netlify/functions/slot-evening-quote-background?dryRun=1`
  (generates + stores a pending draft, posts nothing). Works for every slot.
- **Force a run now:** append `?key=TRIGGER_SECRET` (and `&force=1` to regenerate an existing slot).
- **Check which account you'll post as:** `GET /api/review?whoami=1&key=REVIEW_KEY`.
- **Approve / reject:** the `/review` page, or `POST /api/review` `{action:"approve"|"reject", id}`.
- **Pause everything:** set `SIGNAL_AUTOPOST=off` → all four slots queue to `/review`.

## 5. Known notes
- **xAI credits:** the shared `XAI_API_KEY` is currently over its monthly spend limit — generation
  returns `403 permission-denied` until topped up. (Same key powers AskAPai's Dose — likely also down.)
- **EDT/EST:** cron is UTC; the comments assume EDT. In winter (EST) slot times shift +1h.
- **Validated:** all functions syntax-clean; card renderer verified (sample PNGs); Grok request
  shape confirmed correct (reached xAI, billing-blocked only). Live posting unverified pending tokens.
```
