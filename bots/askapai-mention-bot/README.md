# @AskApai Mention-Reply Bot

Production-ready X (Twitter) API v2 bot that watches for mentions of **@AskApai**,
scores the referenced content for **authenticity (0–100)** and **framing
(low/medium/high)**, and replies with a link to the full private analysis plus a
follow CTA. Pay-per-use, cost-tracked, TOS-compliant.

> **Why a standalone worker (not a Netlify Function)?** A mention poller needs a
> persistent `since_id` cursor and a long-running loop. Netlify Functions are
> ephemeral, so this ships as a small Node worker you run on any always-on host
> (Railway, Render, Fly, a VM, PM2, Docker) **or** as a cron/n8n one-shot. It
> reuses the repo's OAuth 1.0a signing (`post-to-x.js`) and framing categorizer
> (`scan-ap-mentions.js`).

---

## What it does

1. Polls `GET /2/users/:id/mentions` using `since_id` + bounded pagination — only
   ever reads *new* mentions (no wasted spend).
2. For each mention, picks the thing to analyze, in priority order:
   - an **external URL** in the mention → `?url=`
   - else the **parent tweet** it replied to (a reply-summon) → `?tweet=<parentId>`
   - else the **mention's own text** as a claim → `?tweet=<mentionId>`
3. Scores it (askapai.com backend if configured, else a local heuristic stub).
4. Replies via `POST /2/tweets` with `reply.in_reply_to_tweet_id`:
   ```
   Authenticity: 72/100 · Framing: medium
   Full private analysis: https://askapai.com/analyze?tweet=1234567890
   Follow @AskApai for daily truth scores.
   ```
5. Meters every read/write to `data/usage.json` and **hard-stops** at your daily
   reply/spend caps.
6. (Optional) Posts a daily "tag @AskApai to score this claim → winner picks a
   charity donation" challenge.

**TOS note:** the bot only ever replies to posts that *mention @AskApai* — i.e.
it acts when summoned, never unsolicited. Keep automation within
[X's automation rules](https://help.x.com/en/rules-and-policies/x-automation).

---

## Setup

```bash
cd bots/askapai-mention-bot
npm install
cp .env.example .env      # then fill in your @AskApai keys
```

Get keys at **developer.x.com → your App → Keys and tokens**. You need a paid
tier that grants mention **reads** (Basic and up). The Access Token/Secret must
belong to **@AskApai** and have **Read + Write** permission (regenerate the token
*after* setting the app to Read+Write, or replies will 403).

Verify credentials without posting anything:

```bash
node src/index.js whoami     # prints the authenticated account id + handle
```

First run in **dry-run** (scores + logs, never posts) — `.env.example` ships with
`DRY_RUN=true`:

```bash
node src/index.js scan
```

When the logged replies look right, set `DRY_RUN=false` and go live.

---

## Run modes

| Command | Use |
|---|---|
| `npm start` / `node src/index.js loop` | Long-running poller (default). Polls every `POLL_INTERVAL_MS`, plus optional daily charity post. |
| `node src/index.js scan` | One-shot cycle — ideal for cron / n8n. |
| `node src/index.js charity` | Post one charity challenge now. |
| `node src/index.js whoami` | Credential check. |
| `node src/index.js usage` | Print today's + lifetime usage/cost. |

**Cron (every 2 min):**
```cron
*/2 * * * * cd /path/to/bots/askapai-mention-bot && /usr/bin/node src/index.js scan >> bot.log 2>&1
```

**PM2 (persistent loop):**
```bash
pm2 start src/index.js --name askapai-bot -- loop
```

**n8n:** a *Schedule Trigger* → *Execute Command* node running
`node src/index.js scan`, or `require()` the exported `runCycle()` from a Function
node. State persists in `data/` between runs, so both styles are safe.

---

## Cost tracking

Every read and write is metered against a configurable price:

- `COST_PER_READ` (default **$0.005**) × mentions read
- `COST_PER_REPLY` (default **$0.20**) × replies posted

Tune these to your actual X tier. The tracker enforces two hard caps —
`MAX_REPLIES_PER_DAY` and `MAX_DAILY_SPEND_USD` — and refuses to reply once
either is hit (leftover mentions are picked up the next day). Inspect anytime:

```bash
node src/index.js usage
```

> The defaults are placeholder estimates. X's mention-read and post pricing
> depend on your access tier — confirm the real per-call cost and set the env
> vars accordingly before trusting the dollar figures.

---

## Wiring the real scoring backend

The stub in `src/scoring.js` makes the bot runnable today. To use askapai.com's
real authenticity + manipulation engine, set `ASKAPAI_BACKEND_URL` (and optional
`ASKAPAI_BACKEND_KEY`). The bot POSTs:

```json
{ "url": "https://…", "text": "tweet text or null", "tweetId": "123…" }
```

and expects:

```json
{ "authenticity": 0-100, "framing": "low|medium|high", "note": "optional" }
```

If the backend errors or times out, the bot falls back to the local stub so a
scoring outage never wedges the reply loop.

---

## Files

```
src/
  index.js    entry — CLI dispatch, polling loop, charity schedule, shutdown
  config.js   all env + tunables in one place
  xClient.js  OAuth 1.0a signing + X v2 calls (mentions, reply) + retry/backoff
  scan.js     one scan cycle: poll → dedupe → target → score → reply
  scoring.js  authenticity + framing (backend hook, else heuristic stub)
  reply.js    reply text formatter (CTA in every reply, ≤280)
  charity.js  optional daily challenge poster
  state.js    since_id + processed-id dedupe ledger
  usage.js    cost/volume meter + daily budget guard
  store.js    atomic JSON persistence (swap for Blobs/Redis/DB)
  logger.js   leveled JSON logger
data/         state.json + usage.json (gitignored, auto-created)
```
