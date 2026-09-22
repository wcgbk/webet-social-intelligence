# TSP Research Observer (TOS-safe)

Isolated research pipeline for **public** The Sharp Plays / Performance Terminal wager-log records.

## Hard constraints (WeBet)

- **Observer only** — writes `tsp-research` blob store. **Never** `edge-picks-omega` live config/selection.
- **Do not** copy TSP picks into Omega as picks.
- **Do not** train Omega to mimic Hermes.
- Member `fetch-tsp-live` hold was lifted 2026-09-22. It writes isolated `tsp-live` → `/live-ai` only and soft-fails without `TSP_SESSION_COOKIE`. This public-records observer does not call it. Do not copy TSP picks into Omega. The research-module flag `TSP_FETCH_ON_HOLD` in `lib/tsp-research/config.js` is unchanged and is not an Omega gate.
- No IP rotate, spoof, or hide-traffic jitter. Normal public HTTPS only. No member cookies for this tranche.

## What ships

| Piece | Role |
|-------|------|
| `netlify/functions/lib/tsp-research/*` | Parse/fetch/store helpers |
| `fetch-tsp-public-records` | On-demand snapshot → `tsp-research/snapshots/{date}` |
| `monitor-tsp-public-records` | Daily digest cron → `tsp-research/digests/{date}` |
| Blob store `tsp-research` | Isolated from Omega live |

## Public data source

The public Performance Terminal (`tsp.live` / thesharpplays.com records UI) loads wager-log CSVs from a **public AWS Lambda Function URL** (no auth):

`https://kjcvzfri7oqq3iddfgcz72oice0qdqfd.lambda-url.us-east-1.on.aws/?id={sheetId}`

Sheet ids mirror the terminal (Consensus, Insiders, Hermes Elite, Live Portfolio, Compass, summaries since ~2011, etc.). This is the same public HTTP the browser terminal uses — not a member cookie scrape.

Override with env `TSP_PUBLIC_LAMBDA_BASE` if the URL rotates.

## Manual / CSV import

If Lambda is blocked or pages go fully JS-gated without a public CSV:

```js
const { storeManualImport, parseCsv } = require('./lib/tsp-research');
const csv = fs.readFileSync('hermes-elite.csv','utf8');
const parsed = parseCsv(csv);
await storeManualImport('hermes-elite-2026-09-22', {
  source: 'manual-csv',
  importedAt: new Date().toISOString(),
  ...parsed,
});
```

Keys land under `tsp-research/manual/{name}`.

## Blob schema

```
tsp-research/
  snapshots/{YYYY-MM-DD}   full public feed pull
  snapshots/latest
  digests/{YYYY-MM-DD}     lightweight daily summary
  digests/latest
  manual/{name}            operator CSV/JSON imports
```

Each snapshot includes `isolation.neverWrites` and `neverCopiesPicksIntoOmega: true`.

## Discord

Optional only: set `TSP_RESEARCH_DISCORD_WEBHOOK` **and** `TSP_RESEARCH_DISCORD_ENABLE=true`. Default is off.

## TOS blockers / honesty

- **Member Hermes live card** (`tsp.live` analytics) remains **on hold** — not fetched.
- Public Lambda CSVs are structured and reliable today; if TSP removes the public Function URL, fall back to manual CSV import rather than breaking TOS with member scraping or traffic obfuscation.
- JS-heavy terminal HTML alone is not scraped for picks; we only GET the public CSV endpoint the terminal already exposes.
