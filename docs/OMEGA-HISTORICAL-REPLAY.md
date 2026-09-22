# Omega historical replay harness

Runs the **current** omega-vnext stack against The Odds API **historical** snapshots into an **isolated eval store**. Live cards are never overwritten.

## Hard constraints

- Writes only `omega-replay/{runId}/picks-{date}` and `omega-replay/{runId}/summary`
- **Never** writes `picks-{date}`, `latest-date`, or `picks-dates`
- Default **`dryRun=true`** (compute card in memory; no blob writes)
- `--write` / `dryRun=false` still cannot touch live keys (`assertReplayKey`)
- 2026-09-22 live production card is out of scope for this harness

## Quota caution

Each replay day costs approximately **1 Odds API historical request × enabled sport** (MLB + NFL + NCAAF today ≈ 3 calls/day).

| Window | ≈ calls |
|--------|---------|
| 1 day | ~3 |
| 7 days (default max) | ~21 |
| 14 days (hard cap) | ~42 |

Do **not** burn infinite quota. Prefer a documented small window (last NFL week or late MLB stretch). Check Odds API remaining before `--write`.

## Usage

### CLI

```bash
# Dry-run (default) — no blob writes
node scripts/replay-omega-cli.js --from 2026-09-15 --to 2026-09-21 --dry-run

# Persist to eval store only
node scripts/replay-omega-cli.js --from 2026-09-18 --to 2026-09-21 --write --run-id mlb-late-sep --max-days 7
```

### Netlify function

`GET/POST /.netlify/functions/replay-omega-historical`

```
?from=2026-09-15&to=2026-09-21&dryRun=true&maxDays=7
```

## Snapshot timestamp

`historicalTimestampForDate` uses `{date}T13:00:00Z` (~9am ET during EDT) as the Odds API `date=` parameter. Configurable later if needed.

## Metrics

Summary includes `clvPlaceholder` / `roiPlaceholder` until closes are joined. Do not treat empty placeholders as zero CLV/ROI.

## Isolation tests

`test-omega-replay.js` asserts `assertReplayKey` refuses `picks-2026-09-22` and that dry-run never calls `storePicks`.
