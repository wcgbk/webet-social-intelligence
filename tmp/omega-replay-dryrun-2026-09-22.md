# Omega historical replay dry-run — 2026-09-22

## Status: SKIPPED (env)

Odds API historical replay was **not** executed in this executor environment.

### Exact env var required
- `ODDS_API_KEY` — The Odds API key used by `netlify/functions/lib/omega-vnext/ingest.js` / `replay.js` for live + historical odds.

### Intended dry-run (≤14 days, no live writes)
```bash
node scripts/replay-omega-cli.js --from 2026-09-09 --to 2026-09-21 --dry-run --max-days 14 --run-id pregen-health-2026-09-22
```

- Default `dryRun=true` — never writes `edge-picks-omega` live keys (`picks-{date}`, `latest-date`, `picks-dates`).
- Eval writes (only with `--write`) go to `omega-replay/{runId}/*` only — see `docs/OMEGA-HISTORICAL-REPLAY.md`.
- Quota caution: ~3 Odds historical calls/day × sports ≈ ≤42 calls for 14 days.

### Outcome
- Skipped without failing the PR.
- Re-run overnight / on Netlify once `ODDS_API_KEY` is available in the shell or via `replay-omega-historical` function.

