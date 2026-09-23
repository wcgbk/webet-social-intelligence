# Omega sport engines (v12.3.8)

Grok Build 4.7 xhigh redo of v12.3.7. Same signals and cap philosophy. Pregame features for **MLB / NFL / NCAAF** feed `modelRawP` → calibrate → `coverProb` / edge. US sportsbook CLV spine stays primary.

## Caps (`ENGINE_SOFT` in `config.js`)

| Sport | Signal | Max abs contribution |
|-------|--------|----------------------|
| MLB | Bullpen residual (team pitching − named SP) | ±0.35 runs margin, ±0.40 total |
| MLB | SP-known spread/ML std tighten | ≤10% of `SPORT_SPREAD_STD.MLB` when both SPs are player-quality. `0` means no shrink |
| NFL | Success-rate mismatch → margin | part of the **stacked** ±1.50 point cap |
| NFL | QB continuity (non-empty injury map) | ±0.55 alone, then shares the ±1.50 stack with success |
| NCAAF | Talent / spPlus seed overlay (weight 0.22) | part of the **stacked** ±2.00 point cap |
| NCAAF | QB continuity | ±0.55 alone, then shares the ±2.00 stack with talent |

MLB totals stay inside the existing 5.5–14.5 run band after the bullpen add. Talent uses the seed's centered scale. A value above 5 is still a strong team, not a 0–100 score.

## Soft-fail

Missing feed or seed → adjustment **0**, prior path (standings / EPA / SP-park / game-day). One bad event does not blank the rest of that sport. Generate does not throw on engine deepen.

Teams in the talent seed with no EPA row stay on the standings path. The overlay does not invent EPA.

## Unchanged (bans)

`SHRINK_K`, `SELECT_WEIGHTS`, market blend weights, gates, Kelly, grades, unit caps, `PM_SOFT`, `FIT_ENABLED=false`, no TSP, NBA/NHL off.
