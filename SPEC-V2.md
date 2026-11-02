# Omega pipeline v2

Flag `OMEGA_PIPELINE_V2` (or `opts.pipelineV2`). Default off. Grading, prices, and the 3 AM / 10 AM schedule stay on the live path until the flag is on. Version stamp: `omega-pipeline-v2.0`. 1u = $150.

## Rules

Calibrate walk-forward only. Shrink the model toward the pick-time Pinnacle no-vig. Platt, and isotonic once a sport has enough rows, are used only when a chronological holdout inside the past prefers them. A training row dated on or after the card throws.

Select a side only when the calibrated edge over the pick-time price clears 1 percentage point, scaled up for a longer price and for higher uncertainty, and stays under 10 points. Publish 0 to 3 straights, one game each. No forced fill. A pass day is a valid card.

Size at quarter-Kelly on that same price. Round to 0.25u. Cap 1.25u per bet. Straights stay inside 3.5u and the card inside 4.0u.

Parlay legs come only from qualified sides. The ticket must mix a moneyline and a total, on different games, 2 or 3 legs. Same-game tickets are rejected. Same-sport legs and same-direction totals take a correlation haircut below 1. Publish only at EV of 3% or more. The stake is quarter-Kelly, capped at 0.5u and at the smallest straight.

Every published straight and parlay leg is priced at DraftKings or Hard Rock (`bestDkHr` when that American number is finite, otherwise the posted book if it is already one of those). Any other book is rejected as `no-dk-hr-price` and is not on the card. A parlay leg also needs positive EV at that price (`pCal * decimal - 1 > 0`). A miss is skipped as `leg-ev-not-positive`, and the ticket falls back to the best valid ticket.

A pre-publish price recheck is a hook the caller supplies. The pipeline does not call The Odds API. The gate is `npm run omega-v2:gate`.

## 30-day replay (9/30–10/29)

Point estimate, not a promise. Dollars and units are whole numbers rounded away from zero. Detail is in `REPLAY-V2.md`.

| | Live | v2 |
|---|---:|---:|
| Straights | 37-38, -5u | 1-6, -6u |
| Parlays | 5-22, +6u | none |
| Card | +2u, +$155, ROI +2% | -6u, -$870, ROI -80% |
| CLV | 0.8c (n=68), beat 65% | 2.5c (n=7), beat 7/7 |
| Brier, all straights | 0.256 | 0.256 |
| Pass / short days | 0 / 12 | 25 / 4 |
| Max drawdown | 19u | 6u |

Profit difference -$1,025. 95% CI -$5,750 to +$3,193, p=0.68. ROI difference p=0.06. Neither excludes zero.

## Expected impact

Do not expect a better card. Shrinkage removes the fake 54%-versus-50% edge, so most published legs fail the floor and 25 of 30 days pass. The parlays that made the live profit do not clear a 3% haircut. The 7 bets that remain beat the close and lose the games, which is the same split the October audit saw, on a smaller n. Drawdown falls because the book is mostly unbet. Brier does not beat the raw model. The no-vig market (Brier 0.255) is still the best probability in the file.

## Recommendation

Do not turn the flag on for the live card. Keep v2 as a shadow until a full morning board is stored and the profit gap is not pointing the wrong way.

## Risks

The replay can only drop or resize a published leg. It cannot add a bet that never made the card. Seven bets is one weekend. Twenty-six pick-time prices were rebuilt from the card edge because no pre-pick Pinnacle pair matched the number. The log shows 5 unmatched games, 37 alt-line closes, 12 missing CLV grades, and 57 stray snapshot rows dropped across 45 games. `clvPp` is cents. The latest close per game is the one that was kept.
