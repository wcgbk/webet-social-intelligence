# Omega historical replay harness

Runs the **current** omega-vnext stack against The Odds API **historical** snapshots into an **isolated eval store**. Live cards are never overwritten.

## Hard constraints

- Writes only `omega-replay/{runId}/picks-{date}` and `omega-replay/{runId}/summary`
- **Never** writes `picks-{date}`, `latest-date`, or `picks-dates`
- Default **`dryRun=true`** (compute card in memory; no blob writes)
- `--write` / `dryRun=false` still cannot touch live keys (`assertReplayKey`)
- 2026-09-22 live production card is out of scope for this harness (do not force-regenerate)

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
# Dry-run (default) — no blob writes; scores CLV/ROI when closes exist
node scripts/replay-omega-cli.js --from 2026-09-15 --to 2026-09-21 --dry-run

# Persist to eval store only
node scripts/replay-omega-cli.js --from 2026-09-18 --to 2026-09-21 --write --run-id mlb-late-sep --max-days 7
```

### Netlify function

`GET/POST /.netlify/functions/replay-omega-historical`

```
?from=2026-09-15&to=2026-09-21&dryRun=true&maxDays=7
```

Body/query fields: `from`, `to`, `dryRun` (default true), `maxDays`, `runId`, `sports`.

Narrate is skipped (`skipNarrate=true`) to save cost/time.

## Snapshot timestamp

`historicalTimestampForDate` uses `{date}T13:00:00Z` (~9am ET during EDT) as the Odds API `date=` parameter. Pregame gates use this as `asOf` (v12.3.4+). Configurable later if needed.

## Scoring (CLV / ROI) — v12.3.5+

After each day card is generated, replay **joins best-available closes and settles already in the stack**:

1. `clv-{date}` (track-clv-omega) — realized no-vig CLV cents + optional settle
2. Live `picks-{date}` — settle `result` / `profit` when the live card existed (read-only)
3. Card-carried `closingOdds` / `result` if present (fixtures)

**Does not invent books.** Soft-fails per day when closes/settles are missing:

| `scoreReason` | Meaning |
|---------------|---------|
| `no_picks` | Empty card |
| `closes_missing` | No CLV and no settles joined |
| `closes_missing_partial_settle` | Settles only |
| `settles_missing_partial_clv` | CLV only |
| `partial` | Some picks scored, not all |

Summary fields (replacing placeholders):

- `meanClvCents`, `beatClosePct`, `nScoredClv`, `nDaysWithClv`
- `roiUnits`, `roiPct`, `unitsRisked`, `nScoredSettle`, `nDaysWithSettle`
- `nDaysMissingCloses`
- Deprecated `clvPlaceholder` / `roiPlaceholder` remain `null` so old callers do not misread zeros

Treat `null` as **unknown**, not zero CLV/ROI.

## Isolation tests

`test-omega-replay.js` asserts `assertReplayKey` refuses `picks-2026-09-22`, dry-run never calls `storePicks`, and scored summary shape (including soft-fail when closes absent).
