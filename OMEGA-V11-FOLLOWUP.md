# Omega v11 delivery notes (include in PR)

## Promote Omega to MAIN (after QA)
- This PR makes Omega the multi-sport MAIN model (`v11.0-omega-elite-multisport`: MLB+NFL+CFB).
- UI/lab: `daily-omega/` continues as the Omega surface; after QA, product MAIN = Omega card from `get-picks-omega` / `edge-picks-omega`.
- Alpha remains untouched (do not change alpha generators).

## KPI reset (2026-09-05)
- `get-results-omega.js`: `KPI_START=2026-09-05` + cache `results-omega-cache-v2`
- `get-results-nfl.js`: same floor + cache `results-nfl-cache-v3`
- `get-results-cfb.js`: same floor + cache `results-cfb-cache-v2`
- `daily-omega/index.html`: meta copy Sep 5

## Regenerate TODAY (2026-09-05 ET) Omega example card (post-deploy)
1. POST `/.netlify/functions/generate-picks-omega-background` (or `trigger-picks-omega`) with body like:
   `{ "force": true, "date": "2026-09-05" }`
   (use site auth / function invoke as currently used for Omega cron)
2. Confirm blob write to `edge-picks-omega` key `picks-2026-09-05`
3. GET `/.netlify/functions/get-picks-omega?date=2026-09-05` and verify `summary.modelVersion === "v11.0-omega-elite-multisport"`, 3 straights + parlay when slate allows, `sportsCovered` tags

## NFL/CFB standalones
- Untouched by Omega fold-in: `generate-picks-nfl-background.js` (v1.1-nfl) and `generate-picks-cfb-background.js` (v1.0-cfb) remain separate stores/cards.
- Readers: `get-picks-nfl` / `get-picks-cfb` unchanged.
