# Omega sport engines (v12.3.7)

Deeper pregame feature engines for **MLB / NFL / NCAAF**. Signals feed `modelRawP` → calibrate → `coverProb` / edge. US sportsbook CLV spine stays primary.

## Caps (`ENGINE_SOFT` in `config.js`)

| Sport | New signal | Max abs contribution |
|-------|------------|----------------------|
| MLB | Bullpen residual (team pitching − named SP) | ±0.35 runs margin, ±0.40 total |
| MLB | SP-known spread/ML std tighten | ≤10% std shrink when both SPs have player-quality |
| NFL | Success-rate mismatch → margin | ±1.50 points |
| NFL | QB continuity (non-empty injury map) | ±0.55 points |
| NCAAF | Talent / spPlus seed overlay | ±2.00 points (weight 0.22) |

## Soft-fail

Missing feed or seed → adjustment **0**, prior path (standings / EPA / SP-park / game-day). Generate never throws on engine deepen.

## Unchanged (bans)

`SHRINK_K`, `SELECT_WEIGHTS`, market blend weights, gates, Kelly, grades, unit caps, `PM_SOFT`, `FIT_ENABLED=false`, no TSP, NBA/NHL off.
