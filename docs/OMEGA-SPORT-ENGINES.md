# Omega sport engines (v12.3.13)

Grok Build 4.7 xhigh redo of v12.3.7, plus the NHL projector. Same signals and cap philosophy for MLB / NFL / NCAAF. Pregame features feed `modelRawP` → calibrate → gates → select → placeability. US sportsbook CLV spine stays primary.

MLB, NFL, NCAAF, and NHL are live. NHL is plug-in only on the existing select path (WeBet enable 2026-09-30).

## Caps (`ENGINE_SOFT` in `config.js`)

| Sport | Signal | Max abs contribution |
|-------|--------|----------------------|
| MLB | Bullpen residual (team pitching − named SP) | ±0.35 runs margin, ±0.40 total |
| MLB | SP-known spread/ML std tighten | ≤10% of `SPORT_SPREAD_STD.MLB` when both SPs are player-quality. `0` means no shrink |
| NFL | Success-rate mismatch → margin | part of the **stacked** ±1.50 point cap |
| NFL | QB continuity (non-empty injury map) | ±0.55 alone, then shares the ±1.50 stack with success |
| NCAAF | Talent / spPlus seed overlay (weight 0.22) | part of the **stacked** ±2.00 point cap |
| NCAAF | QB continuity | ±0.55 alone, then shares the ±2.00 stack with talent |
| NHL | Stacked soft residual (unclean winPct, shots, goalie) | ±0.30 goals margin, ±0.35 total |
| NHL | Goalie save% alone (both rates required) | ±0.12 margin, ±0.10 total, then the stack cap |
| NHL | Game-day B2B (`HFA_ADJ.NHL`, not this cap) | max 0.10 goals |

MLB totals stay inside the existing 5.5–14.5 run band after the bullpen add. Talent uses the seed's centered scale. A value above 5 is still a strong team, not a 0–100 score.

NHL projections also soft-clamp at |margin| ≤ 6 and total ≤ 12 (floor 3). A bad feed still emits a candidate.

## NHL (enabled)

Standings goals for/against become a per-game rate the same way MLB turns a season run total into runs per game: divide by games once the count is at least 5, and count OT losses when `games` is missing. Home goals = (home GF + away GA) / 2. Margin adds `HFA.NHL` (0.15), the goal equivalent of the old ~50 Elo home-ice term. Total is the sum. Equal clubs, or missing / unclean rows, land on HFA and 6.2 (league 3.1 + 3.1).

ESPN `pointsFor` on hockey is often the standings-point total (2×wins + OTL), not goals. Ingest keeps `goalsFor` / a goal-band average and otherwise clears `pf`/`pa` so that column cannot become a fake goals-per-game rate. The projector also refuses a `pf` that matches 2×wins + OTL.

A winPct gap may move the margin only when GF/GA is unclean, inside the hard cap. It does not run on a clean goal environment.

Shot efficiency runs only when both clubs have shots and savePct (standings row or the ESPN/ctx bag). No shot feed → adjustment 0. A goalie save% residual runs only when both sides have a rate. v1 does not require a goalie confirmation feed. Missing goalie → 0. Shot, goalie, and the unclean winPct residual stack under `ENGINE_SOFT.NHL` and cannot add past that cap.

Rest is game-day, not a second engine. `SHORT_REST_DAYS.NHL = 1` (back-to-back). `EXTRA_REST_DAYS.NHL = 2`. No QB map.

Method tags: `nhl-standings-hfa` (moneyline), `nhl-normal-pl` (puck line), `nhl-total-baseline` (total). Suffix `-engines` when a soft residual is non-zero, `-gameday` when rest moves the number.

Blend weights match MLB: moneyline 0.50, spread 0.50, total 0.45, anchored on no-vig Pinnacle/Circa.

`projectAll` calls `nhl.project` with that night's NHL odds, standings, game-day rest, and ESPN when `SPORTS_ENABLED.NHL` is true. `nhl.project({})` returns no candidates.

**Enabled 2026-09-30:** `SPORTS_ENABLED.NHL = true` (WeBet voice order). No Omega core routing change; FIT stays off; no TSP into select.

`capture_runner` already supports `includeDisabled` for NHL odds pulls without enabling select. Cron and the generate health retry leave `includeDisabled` false, so a disabled sport does not spend Odds API quota. A shadow or manual capture can pass `includeDisabled: true` to pull NHL prices into the line book only.

## Soft-fail

Missing feed or seed → adjustment **0**, prior path (standings / EPA / SP-park / game-day, or the NHL 6.2 / HFA baseline). One bad event does not blank the rest of that sport. Generate does not throw on engine deepen.

Teams in the talent seed with no EPA row stay on the standings path. The overlay does not invent EPA.

## Unchanged (bans)

`SHRINK_K`, `SELECT_WEIGHTS`, market blend weights for MLB/NFL/NCAAF, gates, Kelly, grades, unit caps, `PM_SOFT`, `FIT_ENABLED=false`, no TSP, NBA off. NHL is on the same select path as MLB/NFL/NCAAF.
