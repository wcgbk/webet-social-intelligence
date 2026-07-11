# @AskApai Mention-Reply Bot

Production-ready X (Twitter) API v2 bot that watches for mentions of **@AskApai**
and relays the referenced post to **Apai's existing chat brain** — the same one
behind her daily dose + web chat — as if a user typed *"rate this post for
authenticity and manipulation."* Her reply gets posted back in her own voice.
Pay-per-use, cost-tracked, TOS-compliant.

> **The bot does not score anything itself.** It's a thin bridge between an X
> mention and Apai's chat endpoint. All authenticity + manipulation judgment
> lives in Apai (one source of truth) — set `APAI_CHAT_URL` to point at it.

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
3. Sends it to **Apai's chat endpoint** (`APAI_CHAT_URL`) as the message
   *"Rate this post for authenticity and manipulation: <post>"*.
4. Posts **her reply** via `POST /2/tweets` with `reply.in_reply_to_tweet_id` —
   in her voice, clamped to X's limit, with the follow CTA appended when it fits
   (and the full-analysis link appended if her reply had to be truncated).
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

## Wiring Apai's chat (the real brain)

Set `APAI_CHAT_URL` to Apai's chat endpoint. The bot POSTs:

```json
{ "message": "Rate this post for authenticity and manipulation.\n\nPost: https://…\nText: \"…\"",
  "source": "x-mention", "url": "https://…", "tweetId": "123…" }
```

- The message key is configurable via `APAI_REQUEST_FIELD` (default `message`).
- Her reply is read from the first present of `APAI_REPLY_FIELDS`
  (default `reply,message,text,response,answer`); it also understands
  `{ data: { reply } }` and OpenAI-style `{ choices:[{message:{content}}] }`.

If the chat endpoint errors or times out, the bot falls back to a short
chat-style stub so an outage never wedges the reply loop.

> **The one thing to confirm:** Apai's chat endpoint URL and its request/response
> field names. Set `APAI_CHAT_URL` (+ `APAI_REQUEST_FIELD` / `APAI_REPLY_FIELDS`
> if they differ from the defaults) and the bot posts her real judgment.

---

## Files

```
src/
  index.js    entry — CLI dispatch, polling loop, charity schedule, shutdown
  config.js   all env + tunables in one place
  xClient.js  OAuth 1.0a signing + X v2 calls (mentions, reply) + retry/backoff
  scan.js     one scan cycle: poll → dedupe → target → ask Apai → reply
  apai.js     relays the post to Apai's chat brain (else a chat-style stub)
  reply.js    fits Apai's reply to X (CTA/link appended when room, ≤280)
  charity.js  optional daily challenge poster
  state.js    since_id + processed-id dedupe ledger
  usage.js    cost/volume meter + daily budget guard
  store.js    atomic JSON persistence (swap for Blobs/Redis/DB)
  logger.js   leveled JSON logger
data/         state.json + usage.json (gitignored, auto-created)
```
