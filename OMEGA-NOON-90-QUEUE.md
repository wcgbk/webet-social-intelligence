# Omega noon-90 queue

Shipped today (2026-09-22 ET) toward ~90th-percentile Omega architecture. **Today's live 2026-09-22 Omega card was NOT force-regenerated.** Alpha live steering untouched. No Discord. No Alpha pollution into Omega selection.

## Done

### D) Deeper sport engines (`v12.3.7-omega-vnext-engines`)
- MLB: capped bullpen residual + SP-known std tighten
- NFL: capped success→margin + QB continuity
- NCAAF: optional talent seed overlay (capped)
- Soft-fail; no FIT/TSP/SELECT_WEIGHTS/SHRINK retune; PM soft unchanged
- See `docs/OMEGA-SPORT-ENGINES.md`


### Sport engines + placeability + observers (prior today)
- PR A sport engines EPA/SP/park (`feat/omega-v12.2-sport-engines`)
- Placeability soft-veto v12.2.1 (`feat/omega-v12.2-placeability`)
- Kalshi/Polymarket observer v12.2.2 (`#71`)
- TSP public Performance Terminal research observer (`#72`) — **public CSVs ≠ decade member archive**; member `tsp.live` still **ON HOLD**

### A) Walk-forward calibration SCAFFOLD (`#74`)
- `walk_forward.js` + `capture-omega-walkforward` (15:15 UTC / 11:15am ET EDT)
- Blobs: `omega-walkforward/samples|reports|priors-offline` only
- `FIT_ENABLED=false`; `getFitParams()` always null
- Offline priors document Alpha/TSP as **priors only** — **not** an Omega empirical CLV percentile
- Actual fit remains **Mon 11:00 ET ≥2026-09-29**
- Tests prove generator does not read fit params

### B) Historical replay harness (`#76`)
- `replay.js` + CLI `scripts/replay-omega-cli.js` + `replay-omega-historical`
- Eval store only: `omega-replay/{runId}/picks-{date}` — **never** live `picks-{date}`
- Default dry-run; hard max 14 days; `skipNarrate` for eval
- **Odds API quota caution:** ≈1 historical call × sports × days (~3/day with MLB+NFL+NCAAF)

### C) Deeper game-day engines (`#75`) → **MODEL_VERSION `v12.3.0-omega-vnext-game-day`**
- NFL/CFB: prior-day rest/B2B HFA tweaks + soft ESPN QB status on EPA seeds
- MLB: weather total adj on SP/park stacks
- Soft fallbacks if feeds fail; empty card OK; no lean force-fill

## What runs tomorrow vs scaffold-only

| Path | Tomorrow |
|------|----------|
| Generate (9:30 ET etc.) | **Runs** v12.3.0 game-day engines (rest/QB/weather when feeds OK) |
| Shrink / isotonic / gates | **Unchanged** static `SHRINK_K` — walk-forward does **not** steer |
| Walk-forward capture | **Runs** observer writes samples/reports; **no fit** |
| Historical replay | **On-demand only** (dry-run default); not on generate cron |
| PM / TSP observers | Unchanged schedules; TSP member live still ON HOLD |

## Remaining toward ~90th

- Walk-forward **fit** (Mon 11am ET ≥2026-09-29) — not before
- Replay close-join → real CLV/ROI metrics (placeholders today)
- Stronger multi-day EPA **live** feeds beyond seeds (talent/bullpen still seed/StatsAPI)
- Member `tsp.live` still **ON HOLD** pending permission
- Public TSP feeds ≠ full decade member archive (honesty unchanged)

## Live card

The **2026-09-22** production Omega card was left alone: no force generate, no verify overwrite, no Discord, no self-opt mutation.
