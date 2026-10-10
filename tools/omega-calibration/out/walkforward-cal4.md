# Calibration modes A / B / C, expanding window

Dataset `/workspace/omega-autopilot/wt-calib/tools/omega-calibration/out/dataset.jsonl`. Graded rows 4160. Games 341.
Window 2026-09-22..2026-10-08. Cluster bootstrap by game, B=1000, seed 6167.

Production is the hand-set shrink (`SHRINK_K`, MLB `shrinkK`) followed by `bandRetainClip`: a fixed 0.42–0.58 band that keeps 25% of the excess. That step was named `isotonicClip`. It is not a fitted isotonic regression.

A drops that band and keeps the hand-set shrink. B fits K on the same linear form with no band. K is bounded to [0.3, 1.0]. The lower bound is a product constraint equal to the lowest hand-set K (MLB moneyline 0.30), not a log-loss estimate. `kMle` is the unconstrained minimizer on [0, 1] and is not applied when it sits below 0.3. C keeps the hand-set shrink and replaces the band with a Platt map on that shrunk probability. Isotonic regression is used only when the train pool has at least 400 rows and 50 games and its train log-loss beats Platt by 0.001. Pools under 80 rows or 20 games step up to sport, then global, then the hand-set K (B) or the identity map (C).

Floors and gates are not part of this fit. `minCoverProb`, `minEV`, and the rest of `GATES` stay at the current values.

## Out of sample

| method | log-loss | 95% CI | Brier | 95% CI |
| --- | ---: | --- | ---: | --- |
| market | 0.658108 | 0.650143 .. 0.666485 | 0.234602 | 0.231242 .. 0.238166 |
| production | 0.673287 | 0.667722 .. 0.678896 | 0.240315 | 0.237572 .. 0.243076 |
| A | 0.660488 | 0.651789 .. 0.669566 | 0.235662 | 0.231819 .. 0.239660 |
| B | 0.659223 | 0.650774 .. 0.667869 | 0.235023 | 0.231416 .. 0.238745 |
| C | 0.662862 | 0.653058 .. 0.672500 | 0.236775 | 0.232611 .. 0.241063 |
| raw | 0.672666 | 0.659149 .. 0.686953 | 0.241188 | 0.234824 .. 0.247882 |

| contrast | mean | 95% CI | CI excludes 0 | point estimate better |
| --- | ---: | --- | --- | --- |
| AMinusProductionLl | -0.012840 | -0.017171 .. -0.008556 | true | true |
| AMinusMarketLl | 0.002321 | -0.001452 .. 0.006371 | false | false |
| AMinusProductionBr | -0.004671 | -0.006286 .. -0.003066 | true | true |
| AMinusMarketBr | 0.001032 | -0.000880 .. 0.002923 | false | false |
| BMinusProductionLl | -0.014030 | -0.018957 .. -0.008780 | true | true |
| BMinusMarketLl | 0.001132 | -0.001513 .. 0.003964 | false | false |
| BMinusProductionBr | -0.005275 | -0.007250 .. -0.003247 | true | true |
| BMinusMarketBr | 0.000428 | -0.000839 .. 0.001792 | false | false |
| CMinusProductionLl | -0.010448 | -0.016141 .. -0.004758 | true | true |
| CMinusMarketLl | 0.004713 | 0.000114 .. 0.009624 | true | false |
| CMinusProductionBr | -0.003549 | -0.005542 .. -0.001567 | true | true |
| CMinusMarketBr | 0.002155 | -0.000107 .. 0.004459 | false | false |

A negative contrast is a lower score than the baseline. Lower log-loss and lower Brier are better.

## Log-loss ship check (volume is a separate replay)

| mode | log-loss vs production | meets log-loss bar |
| --- | --- | --- |
| A | -0.012840 (CI excludes 0) | true |
| B | -0.014030 (CI excludes 0) | true |
| C | -0.010448 (CI excludes 0) | true |

## By date (log-loss)

| date | n | market | production | A | B | C | raw |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-09-22 | 181 | 0.660575 | 0.666239 | 0.658148 | 0.658148 | 0.658148 | 0.657807 |
| 2026-09-23 | 153 | 0.701196 | 0.686277 | 0.695539 | 0.695539 | 0.695539 | 0.689937 |
| 2026-09-24 | 168 | 0.661192 | 0.672667 | 0.660668 | 0.661733 | 0.661428 | 0.662991 |
| 2026-09-25 | 254 | 0.664819 | 0.669603 | 0.667236 | 0.675054 | 0.668490 | 0.682311 |
| 2026-09-26 | 1089 | 0.623399 | 0.656454 | 0.626092 | 0.624458 | 0.629838 | 0.645639 |
| 2026-09-27 | 382 | 0.666799 | 0.669500 | 0.660156 | 0.665512 | 0.668770 | 0.650666 |
| 2026-09-28 | 12 | 0.754793 | 0.763381 | 0.792465 | 0.766319 | 0.821029 | 0.864964 |
| 2026-09-29 | 89 | 0.711350 | 0.704958 | 0.709101 | 0.708129 | 0.726221 | 0.703903 |
| 2026-09-30 | 72 | 0.687513 | 0.690809 | 0.687164 | 0.685128 | 0.684115 | 0.688360 |
| 2026-10-01 | 124 | 0.668988 | 0.673960 | 0.668627 | 0.670711 | 0.671121 | 0.670833 |
| 2026-10-02 | 82 | 0.689318 | 0.692523 | 0.682090 | 0.686196 | 0.671471 | 0.669020 |
| 2026-10-03 | 877 | 0.658678 | 0.676028 | 0.662082 | 0.659786 | 0.666970 | 0.675316 |
| 2026-10-04 | 248 | 0.673643 | 0.698407 | 0.695697 | 0.674448 | 0.689312 | 0.749848 |
| 2026-10-05 | 66 | 0.697610 | 0.699839 | 0.704802 | 0.704858 | 0.698439 | 0.719089 |
| 2026-10-06 | 121 | 0.669818 | 0.671851 | 0.669605 | 0.669887 | 0.671094 | 0.672075 |
| 2026-10-07 | 82 | 0.672130 | 0.673291 | 0.677478 | 0.674631 | 0.665974 | 0.687656 |
| 2026-10-08 | 160 | 0.681638 | 0.692488 | 0.690102 | 0.688457 | 0.686697 | 0.708180 |

## Ship table, mode B (fit on the whole window, not used for the rows above)

| cell | K | kMle | bound | level | n | games | pool n |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |
| MLB|Spread | 0.3 | 0 | policy-floor | cell | 420 | 107 | 420 |
| MLB|Total | 1 | 1 |  | cell | 554 | 107 | 554 |
| MLB|Moneyline | 0.3 | 0 | policy-floor | cell | 214 | 107 | 214 |
| NFL|Spread | 1 | 1 |  | cell | 190 | 33 | 190 |
| NFL|Total | 1 | 1 |  | cell | 212 | 33 | 212 |
| NFL|Moneyline | 1 | 1 |  | sport | 66 | 33 | 468 |
| NCAAF|Spread | 1 | 1 |  | cell | 728 | 137 | 728 |
| NCAAF|Total | 1 | 1 |  | cell | 861 | 137 | 861 |
| NCAAF|Moneyline | 1 | 1 |  | cell | 266 | 133 | 266 |
| NHL|Spread | 1 | 1 |  | cell | 237 | 64 | 237 |
| NHL|Total | 1 | 1 |  | cell | 284 | 64 | 284 |
| NHL|Moneyline | 1 | 1 |  | cell | 128 | 64 | 128 |
| NBA|Spread | 1 | 1 |  | global | 0 | 0 | 4160 |
| NBA|Total | 1 | 1 |  | global | 0 | 0 | 4160 |
| NBA|Moneyline | 1 | 1 |  | global | 0 | 0 | 4160 |

## Ship table, mode C

| cell | type | a | b | level | n | games | knots |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| MLB|Spread | isotonic |  |  | cell | 420 | 107 | 21 |
| MLB|Total | isotonic |  |  | cell | 554 | 107 | 15 |
| MLB|Moneyline | platt | 0.000441 | 0.972756 | cell | 214 | 107 |  |
| NFL|Spread | platt | -0.000006 | 0 | cell | 190 | 33 |  |
| NFL|Total | platt | 0.007088 | 0.654023 | cell | 212 | 33 |  |
| NFL|Moneyline | platt | 0.009135 | 0.582683 | sport | 66 | 33 |  |
| NCAAF|Spread | isotonic |  |  | cell | 728 | 137 | 5 |
| NCAAF|Total | isotonic |  |  | cell | 861 | 137 | 39 |
| NCAAF|Moneyline | platt | 0 | 1.508185 | cell | 266 | 133 |  |
| NHL|Spread | platt | 0.011763 | 0.847854 | cell | 237 | 64 |  |
| NHL|Total | platt | 0 | 0.433391 | cell | 284 | 64 |  |
| NHL|Moneyline | platt | 0 | 1.590867 | cell | 128 | 64 |  |
| NBA|Spread | isotonic |  |  | global | 0 | 0 | 84 |
| NBA|Total | isotonic |  |  | global | 0 | 0 | 84 |
| NBA|Moneyline | isotonic |  |  | global | 0 | 0 | 84 |

Production vs stored coverProb max abs 0 on 4160 rows.

## Replay, current floors

Harness `/workspace/omega-replay-2w`, dates 2026-09-22..2026-10-08 (17 days). Straights only. Base is `src/live-2e0a803` with no mode switch. A, B, and C are `src/cal4-6a8ab96` with `OMEGA_CAL_MODE` set. `OMEGA_CAL_MODE=legacy` on that same tree is the rollback.

| mode | straights | per day | zero-pick days | zero dates |
| --- | ---: | ---: | ---: | --- |
| base | 30 | 1.765 | 5 | 09-28, 09-30, 10-05, 10-06, 10-07 |
| A | 30 | 1.765 | 5 | 09-28, 09-30, 10-05, 10-06, 10-07 |
| B | 27 | 1.588 | 4 | 09-28, 09-30, 10-01, 10-02 |
| C | 44 | 2.588 | 0 | |

A matched the base card on 15 of 17 days. On 10-01 the Blackhawks +1.5 unit moved from 0.5u to 1.25u. On 10-04 Over 46.5 was replaced by Detroit Lions ML -185. B changed 13 days. C changed 15 days. `OMEGA_CAL_MODE=legacy` on `src/cal4-6a8ab96` matched the base card on all 17 days (same 30 straights).

## Ship

All three beat production log-loss with a cluster-bootstrap interval that excludes 0. All three clear 1.5 straights per day and 5 zero-pick days. B has the lowest out-of-sample log-loss, so it is the default. `OMEGA_CAL_MODE=legacy` restores the hand-set shrink plus `bandRetainClip`. A card after 2026-10-08 reads `ship` in `omega-cal-mode.json`. A date in the window reads `byDate`, which was fit only on earlier dates.

B minus market log-loss is +0.001132, 95% CI -0.001513..0.003964, so the interval overlaps 0. C minus market is +0.004713, 95% CI 0.000114..0.009624, entirely worse than the market. A minus market is +0.002321, 95% CI -0.001452..0.006371.

On the full-window B table the product floor binds for MLB spread and MLB moneyline (`kMle` 0, applied K 0.3). That is not the log-loss minimizer. Most other cells fit K=1.

