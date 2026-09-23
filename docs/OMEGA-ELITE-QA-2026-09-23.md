# Omega elite QA — 2026-09-23

Scored only against an elite sharp closing-line desk (Pinnacle / Circa grade). One bar. These are engineering judgments, not ROI forecasts and not a second public scorecard.

Reviewer: Grok Build, grok-4.7. Code under test after the ship below is `v12.3.11-omega-vnext-run-env`. The published 2026-09-22 card was not regenerated.

## Baseline before this ship

`main` at `dabd74c`, `MODEL_VERSION = v12.3.10-omega-vnext-sharp-blend`.

| Lens | Percentile | Why it was there |
|---|---|---|
| Processes | 80 | Morning snap, shadow, 9:30 generate, and 10:30 verify are a real desk. Steam drops block refill. Verify sizes on quarter-Kelly. Still false-fired when a price crossed +100/−100, graded a missing Pinnacle close to Betfair ahead of Circa, and wrote off-slot line polls. |
| Architecture | 83 | vNext is isolated from Alpha, TSP, and walk-forward fit. Spreads and totals already shared one no-vig helper. Moneylines did not. Verify is still a second publisher. |
| Math | 74 | Spread and total anchors are equal-weight no-vig Pinnacle/Circa. MLB treated a season run differential as the margin, so the normal curve saturated and starter, park, and bullpen residuals did not move a mismatched game. Moneylines blended to a vigged price. Straight rank used EV, which inflates plus-money dogs. |
| Overall | 78 | Card shape is right: 3 gate-clear straights, a hit-ranked 3-leg, 4.0u cap, no lean pad. The probability underneath a mismatched MLB game was not a closing-line probability. |

## What moved the score

Shipped in `v12.3.11-omega-vnext-run-env`. Gates, Kelly, the 4.0u cap, global `SHRINK_K`, `MLB_CALIBRATION`, blend weights, FIT, TSP, NBA/NHL, and Alpha are unchanged.

1. **MLB run environment.** Margin and total come from per-game runs scored and allowed. Season totals are divided by wins + losses. Home runs are the average of that club's scoring and the opponent's runs allowed. Missing or unclean standings stay on the old 8.6 / home-field baseline, so the Wednesday starter-and-park fill still holds. A 100-run season gap is about a run, not a clamped 0.95. A named starter still moves that probability.
2. **Moneyline anchor.** MLB, NFL, and NCAAF moneylines blend to the same no-vig Pinnacle/Circa number as spreads and totals. Weights are unchanged (0.50 / 0.50 / 0.45). `prices[0]` is gone.
3. **Paired fair.** `fair_sharp` de-vigs one book (Pinnacle, then Circa, then the other sharp books). It does not mix Pinnacle on one side with another book on the other.
4. **Steam cents.** Open-to-now uses the American juice ladder. A move from +105 to −105 is 10 cents, not 210, so a normal plus-to-minus cross is not an automatic reject.
5. **Capture retry label.** A health retry uses a missing canonical slot within 12 minutes, or the latest due slot when the book is empty. It does not insert a 0905 poll between 0900 and 0915, and it does not stamp a 9:30 price as the 6:00 open.
6. **Close book order.** `track-clv-omega` prefers Pinnacle, then Circa, then Bookmaker, then the other US sharps. Exchanges remain only when no US sharp posts both sides. This does not rewrite the 2026-09-22 card. The next grade uses the new order.
7. **Straight rank.** The card orders gate-clear games by `qualityScore`, the same calibrated edge as the letter grade. A +180 with a fatter EV no longer outranks a −110 with a larger edge versus the no-vig line. The parlay is still ranked by combined hit probability, with EV as the tie-break. Three gate-clear games still publish three straights and a 3-leg.
8. **Football fallback.** When EPA is missing, NFL and NCAAF season point totals become per game before the margin. Live slates still use the EPA seed. Per-game inputs in the existing tests are unchanged.

## Score now

| Lens | Percentile | Why it is not higher |
|---|---|---|
| Processes | 84 | The live morning path now measures steam, closes, and retries on the same scale a sharp desk uses. UTC crons are correct only while EDT holds. On 2026-11-01 they fire an hour early ET. There is still no evening walk-forward resample after the 7:00pm ET close. Neither item changes the 2026-09-24 9:30 ET generate. |
| Architecture | 84 | One anchor, one fair, one straight rank, observers still off the card. `verify-picks-omega.js` is still a second publisher that can rebuild a parlay and backfill a straight. That is the point under 85. Collapsing it the night before a generate is the wrong risk. |
| Math | 83 | Pregame run and point environments are on a per-game scale, and the published edge is the shrink-adjusted gap versus a paired no-vig. `SHRINK_K`, `MLB_CALIBRATION`, and the global isotonic band (0.42–0.58, keep 0.25) are still hand-set. Walk-forward fit stays off until 2026-09-29. Moving those knobs tonight would be a guess, and a guess is how a desk prints a fake edge or an empty Wednesday. |
| Overall | 83 | Overall follows the weakest lens. The card can be bet. It is not yet a fitted closing-line model. |

## What remains before the 9:30 ET generate

Nothing in this list should be coded before that generate.

- Let 6:00 / 7:30 / 9:00 / 9:15 captures and the 9:30 ET generate run on `v12.3.11`. Do not hand-edit `picks-2026-09-23` or `picks-2026-09-24`, and do not force a regenerate.
- Do not flip `FIT_ENABLED`. Earliest fit date is 2026-09-29, and only after Pinnacle/Circa closes exist and a shadow week does not lose closing-line value.
- Do not retune `SHRINK_K`, `MLB_CALIBRATION`, the isotonic band, Kelly, or the 4.0u cap off one or two cards.
- Do not wire TSP or Alpha into Omega select.
- Leave NBA and NHL off.
- November 1: move the Omega UTC crons one hour later before the first EST Sunday. That is a process fix for next month, not for tomorrow morning.

## v12.3.12 desk lock — scored before the 9:30 ET generate

Shipped as `v12.3.12-omega-vnext-desk-lock`. The 2026-09-22 card was not regenerated. `SHRINK_K`, `MLB_CALIBRATION.shrinkK`, the 0.42–0.58 isotonic band, Kelly, the 4.0u cap, `LEAN_PAD`, FIT, TSP, NBA/NHL, and Alpha are unchanged. Wednesday's 9:30 ET generate stays on `30 13 * * *`.

What changed:

1. **Verify is not a second publisher.** It may drop a math-broken straight, flag copy, and resize stakes inside the existing cap. It does not add a straight. A steam or placeability drop is not refilled. A generate-locked parlay is kept; a dropped leg is removed, and if fewer than two legs remain the slip is cleared. It is not rebuilt from the straight card. The disabled sharp-review replacement branch is gone.
2. **Evening post-close observer.** `capture-omega-walkforward-evening` runs at 23:45 UTC (7:45pm ET while EDT holds), after the 23:00 UTC close pass. It writes `omega-walkforward/*` only.
3. **Nov 1 clock change is written down and not applied.** `netlify.toml` lists the EST crons as comments. Live schedules are still the EDT ones, so Wednesday is unchanged.
4. **Odds and rank bugfixes, not knob retunes.** Stale-odds cents use the American juice ladder (`+105` to `−105` is 10 cents, not 210). Candidate-table rank follows the same quality score as the letter grade. Verify's stake trim uses that same quality order. A moneyline parlay of the straight card is not marked independent just because the label gained " ML". Summary `meanClvPct` is the probability (`2.0` cents → `0.02`).

## Score after v12.3.12

| Lens | Percentile | Why it is not higher |
|---|---|---|
| Processes | 86 | Morning snaps, generate, verify, and an evening write-only resample now bracket the card. The Nov 1 EST shift is scheduled on paper. The live crons are still fixed UTC, which is correct until that Sunday and wrong if nobody applies the comment. |
| Architecture | 86 | Generate publishes the card. Verify drops, flags, or resizes. Walk-forward, PM, and TSP stay off the selection path. |
| Math | 84 | The juice ladder, the candidate rank, and the CLV percent scale now match the rest of the desk. The published probability is still shrunk with hand-set `SHRINK_K`, `MLB_CALIBRATION.shrinkK`, and the 0.42–0.58 isotonic band. That is the point under 85. |
| Overall | 84 | Overall follows Math. The card shape is unchanged: 3 gate-clear straights, a hit-ranked 3-leg, 4.0u cap, no lean pad. |

## Still blocked — do not ship before the closes exist

These are not code bugs. Shipping them before 2026-09-29 would be a guess.

- Do not flip `FIT_ENABLED`. Earliest fit is Monday 11:00 ET on or after 2026-09-29, and only after Pinnacle/Circa closes exist and a shadow week does not lose closing-line value.
- Do not retune `SHRINK_K`, `MLB_CALIBRATION.shrinkK`, or the isotonic band off one or two cards.
- Do not wire TSP or Alpha into Omega select. Leave NBA and NHL off. Do not raise the 4.0u cap.
- Do not hand-edit `picks-2026-09-22`, `picks-2026-09-23`, or `picks-2026-09-24`, and do not force a regenerate.
- On 2026-11-01, apply the commented EST crons in `netlify.toml` before the first Sunday slate. That includes moving `capture-omega-walkforward-evening` from `45 23 * * *` to `45 0 * * *`. `trigger-clv` is shared with the settler; retiming it is a separate ops change.
