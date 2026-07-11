# Deploying the @AskApai mention bot

The bot is a small always-on Node worker (or a cron one-shot). Nothing here
holds secrets — you set them as env vars on the host. It ships **safe by
default** (`DRY_RUN=true`: it scores + logs but never posts) until you flip it.

## The only inputs you provide

Set these on whichever host you pick. Secrets never leave your infrastructure.

| Env var | What |
|---|---|
| `TWITTER_CONSUMER_KEY` / `TWITTER_CONSUMER_SECRET` | @AskApai app key/secret |
| `TWITTER_ACCESS_TOKEN` / `TWITTER_ACCESS_TOKEN_SECRET` | @AskApai access token/secret (Read+Write) |
| `APAI_CHAT_URL` | Apai's chat endpoint — the bot relays each post to it |
| `DRY_RUN` | `true` to test without posting; `false` to go live |

If Apai's chat request/response keys aren't `message` → `reply`, also set
`APAI_REQUEST_FIELD` and `APAI_REPLY_FIELDS`. Full list in `.env.example`.

## Go-live sequence (any host)

1. Set the env vars above, keep `DRY_RUN=true`.
2. `node src/index.js whoami` — confirms the keys authenticate as @AskApai.
3. From a second account, reply to a post tagging @AskApai.
4. `node src/index.js scan` — logs `scan.dryRun.reply` showing exactly what she'd
   post. Confirm it's her real reply (i.e. `APAI_CHAT_URL` is reachable).
5. Set `DRY_RUN=false`. Now mentions get live replies.

---

## Option A — Docker (anywhere)

```bash
docker build -t askapai-bot .
docker run -d --name askapai-bot \
  --env-file .env \
  -v askapai-data:/data \
  askapai-bot
```

The `/data` volume persists `since_id` + usage so restarts don't re-reply or
re-read. Logs: `docker logs -f askapai-bot`.

## Option B — Railway / Render / Fly (managed always-on)

- Point the service at this subdirectory (`bots/askapai-mention-bot`).
- Build: `npm ci --omit=dev` · Start: `node src/index.js loop`
- Add the env vars in the dashboard. Attach a persistent disk mounted at the
  path you set as `BOT_DATA_DIR` (default `./data`).

## Option C — cron (cheapest; no always-on process)

Run one-shot scans on a schedule. State persists in `BOT_DATA_DIR` between runs.

```cron
*/2 * * * * cd /path/to/bots/askapai-mention-bot && /usr/bin/node src/index.js scan >> bot.log 2>&1
```

## Option D — PM2 (a VM you already have)

```bash
npm ci --omit=dev
pm2 start src/index.js --name askapai-bot -- loop
pm2 save
```

---

## Cost & safety while live

- Every read/reply is metered — `node src/index.js usage`.
- Hard caps stop spend: `MAX_REPLIES_PER_DAY`, `MAX_DAILY_SPEND_USD`.
- Tune `COST_PER_READ` / `COST_PER_REPLY` to your actual X tier pricing.
- Reading mentions needs a paid X tier (Basic+). `whoami` failing with 403 usually
  means the tier or the token's Read+Write permission.
