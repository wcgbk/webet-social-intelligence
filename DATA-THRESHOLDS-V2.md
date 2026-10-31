# Omega v2 thresholds

Every live-path constant is either estimated from a stored sample or labeled as a stated product rule. The owner's -250 favorite limit, 4 percentage-point edge, and 0.95 same-game haircut were suggestions. They are not the values in code.

Sources read for this pass: `tools/omega-calibration/out/walkforward-cal4.md`, `audit-1030/ds.json`, and `kpi.picks` (1,128 rows via the read-only database; 879 non-parlay graded rows including 25 pushes, 854 wins and losses). Closing-line rows were inspected and do not have enough prices at -200 or shorter to estimate a favorite ROI cutoff.

## Estimated from stored results

| Constant | Value | Sample | Metric |
| --- | --- | --- | --- |
| `FAV_AMERICAN` | -200 | walk-forward mode B, 4,160 rows, 341 games | Brier minus the no-vig market is +0.000428. RMSE = sqrt(0.000428) = 0.0207. Quarter-Kelly stake error for a phantom edge of that size is `25 * 0.0207 / b`, with `b = 100 / |American|`. That error reaches about 1.03u at -200 and 1.29u at -250. -200 is the round price where one RMSE is already a full unit. -250 would leave -200 to -249 uncapped. |
| `FAV_MIN_EDGE` | 0.042 | same fit, 4,160 rows, 341 games | The 95% interval on mode B minus market Brier is -0.000839 to +0.001792 and includes 0. sqrt(0.001792) = 0.0423. A short-price edge inside 0.042 is not separable from calibration noise. Applied to straights and to parlay legs, and only at prices of -200 or shorter. At -110 the same 0.042 error is about 1.16u, so the floor is not applied to every price. |
| `MAX_EDGE` | 0.10 | Omega rows in `audit-1030/ds.json`, n=99 with a stored edge (92 graded, 7 still pending) | Stored edges run from 0.1pp to 8.7pp. None exceed 10pp. 10pp remains the miscalibration screen, one step past that sample. |
| `PAIR_PHI['Moneyline+Total']` | measured -0.02595, applied 0 | 14 decided same-game pairs | phi -0.026, SE 1/sqrt(14) = 0.267. The 95% interval includes 0, so the joint probability stays the product. Factor is 1. This is not a 0.95 haircut. |
| `PAIR_PHI['Spread+Total']` | measured 0.18712, applied 0 | 26 decided same-game pairs | phi +0.187, SE 0.196. The 95% interval includes 0. Applied phi is 0. Factor is 1. |
| Same-game ML+spread | disallowed | 4 decided pairs, phi 1.0, SE 0.50 | |phi| is outside 1.96 SE. Two pairs are the same side (Flyers ML with Flyers -1.5, Knicks ML with Knicks +2.5). Two are full-game ML with F5 ML. The opposite side is the complement, not a second bet. Both directions are refused. |

Same-game phi uses non-parlay `kpi.picks` grouped by date and matchup (`vs` folded to `@`). Identical selection, market family, and result are collapsed so two models betting the same side count once. Wins and losses only. 162 games had two or more straights before that collapse. Same-game ML+ML, spread+spread, and total+total are the same market or a duplicate and are not a ticket. No other same-game pair has a measured phi, so those pairs are not used.

Published Omega prices at -250 or shorter are one graded straight (Bruins +1.5 -270, edge 1.6pp, loss). Prices at -150 or shorter with an edge under 2pp are four bets, ROI about -23%. That sample cannot support a ROI cutoff. The Brier interval is the favorite rule.

Mode B log-loss minus the market is +0.001132 (interval -0.001513 to +0.003964, same 4,160 rows). The market is still the better probability. The card trusts a departure from the no-vig price only when that departure clears the noise bound above.

## Stated product rules, not fitted

These are card rules. The graded sample was not used to tune them.

| Rule | Value | Why it is stated |
| --- | --- | --- |
| Unit | 1u = $150 | Display unit. |
| Bankroll basis | 100u = $15,000 | `units = quarter-Kelly fraction * 100`, so 1% of the roll prints as 1.0u. |
| Kelly | `f = (b*p - q) / b`, then multiply by 0.25 | `p` is the calibrated probability. `b` is decimal odds minus 1. `q` is 1-p. |
| Per-bet cap | 2u | Risk cap. A -290 price at 3.5% EV has `b = 100/290`, full Kelly about 10.2%, quarter-Kelly about 2.54u, which rounds to 2.5u and then hits this cap. v1 printed 1u because of a 1.25u pick cap and a 1u per-game cap. The algebra was the same. The 2u print was the cap. The favorite rule is what drops that bet when the no-vig edge is only about 2pp. |
| Straight budget | 3.5u | Existing card cap. Not re-fit. |
| Card budget | 4.5u | Straight budget plus the 1u parlay cap. |
| Parlay cap | 1u | Stated ceiling. |
| Parlay step | 0.25u, no 0.5u floor | Nearest 0.25u. A ticket that rounds to 0u is skipped. The next ranked ticket with positive joint EV and a stake of at least 0.25u is used. If none remain, there is no parlay. |
| Parlay shape | 2 legs allowed, 3 legs preferred | No ticket with fewer than 2 qualifying legs. |
| Leg rule | calibrated probability above the Pinnacle no-vig price | A longshot with no such edge is out. A longshot with that edge can be a leg. |
| Joint rule | joint EV must be positive | Otherwise no parlay. |
| Ranking | more legs, then the sum of no-vig edges, then an ML+total mix, then joint EV | The historical ML+total pattern is only that tiebreak. |
| Sizing price | exact decimal product | American odds are display only. Quarter-Kelly uses the product. |

## Retired on this path

`PARLAY_PROFIT_FLOOR` 0.5, `PARLAY_LEAN_STAKE` 0.25, `PARLAY_MIN_EV` 0.03, the scaled `EDGE_FLOOR`, `SAME_SPORT_HAIRCUT` 0.95, and `TOTAL_HAIRCUT` are not read. The v1 historical parlay builder is not called. Sport prior shrinks (NFL 0.70, NCAAF 0.72, NBA 0.75, NHL 0.68, MLB 0.46) are unchanged and were not re-fit here.
