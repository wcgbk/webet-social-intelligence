# Omega v2 thresholds

Every live-path constant is either estimated from a stored sample or labeled as a stated product rule. The owner's -250 favorite limit, 4 percentage-point edge, and 0.95 same-game haircut were suggestions. They are not the values in code.

Sources read for this pass: `tools/omega-calibration/out/dataset.jsonl` (4,293 lines, 4,160 graded rows with a win or a loss and both probabilities in (0, 1), 341 games, 2026-09-22 through 2026-10-08), `tools/omega-calibration/out/walkforward-cal4.md`, `audit-1030/ds.json`, and `kpi.picks` (1,128 rows via the read-only database; 879 non-parlay graded rows including 25 pushes, 854 wins and losses). The row file is the walk-forward set named in that report. Closing-line rows were inspected and do not have enough prices at -200 or shorter to estimate a favorite ROI cutoff. That price cutoff is retired.

## Estimated from stored results

One floor covers straights and parlay legs. `pNovig` is the no-vig probability on the graded row (`fair_sharp_p`). Buckets are [0, 0.2), [0.2, 0.35), [0.35, 0.65), [0.65, 0.8), [0.8, 1].

Residual `e = y - pNovig`. `biasRaw = mean(e)`. `s^2` is the sample variance of `e` (divisor n − 1). The global residual variance on all 4,160 rows is 0.234655 (sd 0.484412). Prior strength is 80, the walk-forward pool minimum. A cell under 80 rows does not keep its own fit, so a bucket that thin does not keep its own variance either.

`bias = n / (n + 80) * biasRaw`, shrunk toward 0. `var = (n * s^2 + 80 * 0.234655) / (n + 80)`. `SE = sqrt(var / n)`.

The shrink is what moves the thin buckets. The under-0.2 bucket has n = 56 and a sample sd of 0.182, because it won 2 of 56. That sd is below a Bernoulli sd and would set the floor too low. The prior raises SE from 0.0243 to 0.052035. Bias moves from −0.079889 to −0.032896, so the haircut is not the full thin-sample gap. The middle bucket (n = 3,541) is unchanged at the published decimals.

Long-shot penalty is `max(0, −bias)` on the two buckets with `pNovig < 0.35`, and 0 elsewhere. A negative bias means the price overstated the win rate. That is the long-shot direction. It is subtracted from `pCal` before the edge test. Favorite buckets are not haircut. The over-0.8 shrunk bias is −0.001903, inside its SE, and it is not a long-shot overstatement.

Qualify when `(pCal − penalty) − pNovig > k * SE`. `k = 1.5` (`EDGE_FLOOR_K`). The under-0.2 floor is 1.5 × 0.052035 = 0.078052. A +575 with `pCal` 0.167 and `pNovig` 0.140 is a 0.027 edge (2.7pp; the 2.69pp case is the same comparison). That is under the floor before the 0.032896 penalty is applied. The data do not ask for a higher k. The penalty is the long-shot correction. k is the noise multiple.

Published `edgePct` is the raw gap `pCal − pNovig`, in percentage points. The card prints it as a percent string, the same way it prints `ev`. `priceEdgePct` is `pCal` minus the American implied probability. That used to be stored as `edgePct`.

| Bucket | n | games | mean pNovig | hit rate | bias raw | bias shrunk | penalty | SE | k·SE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| <0.2 | 56 | 55 | 0.115603 | 0.035714 | −0.079889 | −0.032896 | 0.032896 | 0.052035 | 0.078052 |
| 0.2–0.35 | 145 | 127 | 0.298480 | 0.248276 | −0.050204 | −0.032354 | 0.032354 | 0.037668 | 0.056501 |
| 0.35–0.65 | 3541 | 341 | 0.500303 | 0.500988 | +0.000686 | +0.000670 | 0 | 0.008385 | 0.012577 |
| 0.65–0.8 | 221 | 160 | 0.710906 | 0.719457 | +0.008551 | +0.006278 | 0 | 0.031055 | 0.046583 |
| >0.8 | 197 | 122 | 0.891000 | 0.888325 | −0.002675 | −0.001903 | 0 | 0.026143 | 0.039215 |

| Constant | Value | Sample | Metric |
| --- | --- | --- | --- |
| `EDGE_FLOOR_K` | 1.5 | walk-forward rows above, 4,160 graded, 341 games | Noise multiple on the bucket SE. 1.5 already keeps the +575 example out. A higher k is not estimated. |
| `NO_VIG_BUCKETS` | table above | same 4,160 rows | SE and long-shot penalty used by the live gate. |
| `MAX_EDGE` | 0.10 | Omega rows in `audit-1030/ds.json`, n=99 with a stored edge (92 graded, 7 still pending) | Stored edges run from 0.1pp to 8.7pp. None exceed 10pp. 10pp remains the miscalibration screen, one step past that sample. |
| `PAIR_PHI['Moneyline+Total']` | measured -0.02595, applied 0 | 14 decided same-game pairs | phi -0.026, SE 1/sqrt(14) = 0.267. The 95% interval includes 0, so the joint probability stays the product. Factor is 1. This is not a 0.95 haircut. |
| `PAIR_PHI['Spread+Total']` | measured 0.18712, applied 0 | 26 decided same-game pairs | phi +0.187, SE 0.196. The 95% interval includes 0. Applied phi is 0. Factor is 1. |
| Same-game ML+spread | disallowed | 4 decided pairs, phi 1.0, SE 0.50 | |phi| is outside 1.96 SE. Two pairs are the same side (Flyers ML with Flyers -1.5, Knicks ML with Knicks +2.5). Two are full-game ML with F5 ML. The opposite side is the complement, not a second bet. Both directions are refused. |

Same-game phi uses non-parlay `kpi.picks` grouped by date and matchup (`vs` folded to `@`). Identical selection, market family, and result are collapsed so two models betting the same side count once. Wins and losses only. 162 games had two or more straights before that collapse. Same-game ML+ML, spread+spread, and total+total are the same market or a duplicate and are not a ticket. No other same-game pair has a measured phi, so those pairs are not used.

Published Omega prices at -250 or shorter are one graded straight (Bruins +1.5 -270, edge 1.6pp, loss). Prices at -150 or shorter with an edge under 2pp are four bets, ROI about -23%. That sample cannot support a ROI cutoff. The bucket SE is the rule.

Mode B log-loss minus the market is +0.001132 (interval -0.001513 to +0.003964, same 4,160 rows). The market is still the better probability. The card trusts a departure from the no-vig price only when that departure clears `k * SE` in its bucket, after the long-shot penalty.

## Stated product rules, not fitted

These are card rules. The graded sample was not used to tune them.

| Rule | Value | Why it is stated |
| --- | --- | --- |
| Unit | 1u = $150 | Display unit. |
| Bankroll basis | 100u = $15,000 | `units = quarter-Kelly fraction * 100`, so 1% of the roll prints as 1.0u. |
| Kelly | `f = (b*p - q) / b`, then multiply by 0.25 | `p` is the calibrated probability. `b` is decimal odds minus 1. `q` is 1-p. |
| Per-bet cap | 2u | Risk cap. A -290 price at 3.5% EV has `b = 100/290`, full Kelly about 10.2%, quarter-Kelly about 2.54u, which rounds to 2.5u and then hits this cap. v1 printed 1u because of a 1.25u pick cap and a 1u per-game cap. The algebra was the same. The 2u print was the cap. The uncertainty floor is what drops that bet when the no-vig edge is only about 2pp. At that price the no-vig probability sits in 0.65–0.8, where `k * SE` is 0.046583. |
| Straight budget | 3.5u | Existing card cap. Not re-fit. |
| Card budget | 4.5u | Straight budget plus the 1u parlay cap. |
| Parlay cap | 1u | Stated ceiling. |
| Parlay step | 0.25u, no 0.5u floor | Nearest 0.25u. A ticket that rounds to 0u is skipped. The next ranked ticket with positive joint EV and a stake of at least 0.25u is used. If none remain, there is no parlay. |
| Parlay shape | 2 legs allowed, 3 legs preferred | No ticket with fewer than 2 qualifying legs. |
| Price | DraftKings or Hard Rock only | The bet price is `bestDkHr` when that American number is finite, even if another book is a better price. Hard Rock aliases publish as `hardrockbet`. No DK/HR price rejects the candidate (`no-dk-hr-price`). The pre-publish recheck reads only those books. EV, the price edge, and selection use that DK/HR price. The uncertainty floor is re-checked on the candidate after that price is locked. |
| Leg rule | same uncertainty floor as a straight, plus positive EV at the DK/HR price | `(pCal − penalty) − pNovig > k * SE(bucket)`, scored after the DK/HR price replaces the raw best price. A longshot whose edge is inside that floor is out. A leg that clears the floor but has `pCal * decimal(DK/HR price) − 1` at or below 0 is skipped (`leg-ev-not-positive`) and is not a parlay leg. |
| Joint rule | joint EV must be positive | Otherwise no parlay. |
| Ranking | more legs, then the sum of no-vig edges, then an ML+total mix, then joint EV | The historical ML+total pattern is only that tiebreak. |
| Sizing price | exact decimal product | American odds are display only. Quarter-Kelly uses the product. |

## Retired on this path

`PARLAY_PROFIT_FLOOR` 0.5, `PARLAY_LEAN_STAKE` 0.25, `PARLAY_MIN_EV` 0.03, the scaled `EDGE_FLOOR`, `SAME_SPORT_HAIRCUT` 0.95, `TOTAL_HAIRCUT`, `FAV_AMERICAN` −200, and `FAV_MIN_EDGE` 0.042 are not read. The −200 screen applied one flat edge only at short prices. The bucket floor replaces it for every price. The v1 historical parlay builder is not called. Sport prior shrinks (NFL 0.70, NCAAF 0.72, NBA 0.75, NHL 0.68, MLB 0.46) are unchanged and were not re-fit here.
