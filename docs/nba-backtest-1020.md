# NBA backtest 1020

Window: NBA games from 2025-10-21 through 2026-01-21 in `clv.games` / `clv.odds_snapshots` (Supabase project read-only). Scores and box scores are public ESPN. The prior is the 2024-25 ESPN season (30 teams, league 113.83 points per game, estimated pace 101.16). The file `nba-net-rating-seed.json` is the completed 2025-26 season and was not used as a prior.

Base: v12.3.74 (`e84d5aa`). Gates are the live card gates: EV from 2% to 12%, American odds from -250 to +250, one side per market per game, rank by EV. Flat 1u. ROI is the mean return on decided bets (pushes stay in the record and leave the denominator). The 95% interval is the normal approximation. Same-day bets are dependent, so the interval is slightly tight.

## What was priced

650 games in the window. 649 finished. One game was postponed (2026-01-08 Miami at Chicago) and was not graded. 637 games have a Pinnacle close before tip. The quote builder counted 636 of those closes on the prepared finals.

Books in the tape: DraftKings, Pinnacle, and consensus. Hard Rock is absent, so the best DraftKings/Hard Rock price is DraftKings only. Consensus is not an execution book.

Fair probability is one blend, `w * model + (1 - w) * Pinnacle no-vig`, taken at the same time as the DraftKings price. A Pinnacle number that differs from the DraftKings number is shifted onto the DraftKings number with a normal (spread residual 12, total residual 18) and only when the gap is at most 3 points on a spread or 5 points on a total. The other side is one minus that probability.

Primary cohort (this is the result): the earliest DraftKings open and the earliest Pinnacle open, each inside 60 hours of tip, and within 15 minutes of each other. That drops the 2025-10-21 sentinel timestamp on 42 games. It also drops pairs where Pinnacle opened hours after DraftKings. The median raw gap, before this rule, was about 12 hours, with Pinnacle later. Using that later Pinnacle price as the fair for an earlier DraftKings bet is lookahead. A first run that did so is discarded. It is described under leakage and is not the result.

Usable primary quotes after the 15-minute pair and the point-gap cap: 485. CLV uses the later Pinnacle close only when the close point equals the DraftKings bet point (157 games had at least one such open quote). A moved number is a null CLV, not a shifted one.

Secondary cohort, not used to choose a weight: latest DraftKings and Pinnacle closes before tip, within 15 minutes. Those prices are simultaneous, so that CLV is the execution gap at the close, not a move after the bet.

## Split and the locked rule

Graded games are ordered by ET date. Dates are added to the tune set until it holds about 60% of graded games. The cut date stays entirely in tune.

| Split | Dates | Games |
| --- | --- | --- |
| Tune | 2025-10-21 .. 2025-12-17 (57 dates) | 390 |
| Holdout | 2025-12-18 .. 2026-01-20 (33 dates) | 259 |

The rule was locked before the holdout was read.

1. Grid `w` in {0, 0.10, 0.20, 0.35, 0.50} with pace on and rest off. Keep the smallest `w` whose tune ROI is within 0.2 percentage points of the best eligible weight. A weight is eligible only if its tune ROI beats `w = 0` by at least 1.0 percentage point and its tune CLV is not worse than `w = 0` by more than 0.25 percentage points. Otherwise `w = 0`.
2. Pace on the total only if `w > 0`, totals ROI rises by at least 1.0 percentage point, and overall ROI does not fall by more than 0.5 percentage point.
3. Rest (home back-to-back -1.5 margin, away back-to-back +1.8, cap 2.5) or a 0.97 score factor only if `w > 0`, tune ROI beats rest-off by at least 1.0 percentage point, and CLV is not worse by more than 0.25 percentage point.
4. Total residual 18.5 instead of 18 only if `w > 0` and both overall and totals ROI rise by at least 1.0 percentage point.

Injuries were never eligible. The ESPN game page is the final report and can include news after the open.

## Tune grid (primary cohort)

Pace was on and rest was off while the weight was chosen. No weight has a positive tune ROI.

| w | Bets | W-L-P | ROI | Avg CLV pp | Beat close | CLV n |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 0-1-0 | -100% | +16.52 | 100% | 1 |
| 0.10 | 10 | 2-8-0 | -60.0% | +5.48 | 50% | 4 |
| 0.20 | 63 | 23-40-0 | -27.9% | +0.89 | 32% | 22 |
| 0.35 | 114 | 47-67-0 | -18.1% | -0.01 | 31% | 35 |
| 0.50 | 97 | 42-55-0 | -14.6% | -0.63 | 30% | 33 |

`w = 0` is one decided bet, a loss, with CLV +16.52. Every higher weight has a better ROI than -100% and fails the CLV rule against that one-bet CLV. The one-bet CLV is not a stable bar. A cleaner pre-specified fallback, written here and not used to refit, would keep a model weight only if tune ROI is positive, tune CLV is positive, and decided bets are at least 80. None qualify. The chosen spec does not change. The holdout was not used to pick it.

Chosen spec: model weight 0, pace off, rest off, total residual 18, injuries off. Fair probability is the de-vigged Pinnacle price.

## Primary results at that spec

| Split | Bets | W-L-P | ROI (95% CI) | Avg CLV pp | Beat close | CLV n |
| --- | --- | --- | --- | --- | --- | --- |
| Tune | 1 | 0-1-0 | -100% (n=1) | +16.52 | 100% | 1 |
| Holdout | 4 | 1-3-0 | -63.5% (-135.0% to +7.9%) | +0.84 | 100% | 1 |
| Full | 5 | 1-4-0 | -70.8% (-128.0% to -13.6%) | +8.68 | 100% | 2 |

Holdout by market:

| Market | Bets | W-L-P | ROI | Avg CLV pp | CLV n |
| --- | --- | --- | --- | --- | --- |
| Moneyline | 1 | 1-0-0 | +45.9% | +0.84 | 1 |
| Spread | 2 | 0-2-0 | -100% | — | 0 |
| Total | 1 | 0-1-0 | -100% | — | 0 |

Full window by market:

| Market | Bets | W-L-P | ROI (95% CI) | Avg CLV pp | CLV n |
| --- | --- | --- | --- | --- | --- |
| Moneyline | 2 | 1-1-0 | -27.1% (-170.0% to +115.9%) | +8.68 | 2 |
| Spread | 2 | 0-2-0 | -100% | — | 0 |
| Total | 1 | 0-1-0 | -100% | — | 0 |

Spread and total CLV is empty because the Pinnacle close number had moved off the DraftKings bet number. Those bets are graded. They do not get a CLV.

These five bets are not a strategy sample. The gate almost never fires when DraftKings and Pinnacle are priced together. The few fires lost. The full-window interval sits entirely below zero and is still only five bets.

## Daily card

A full card is three straights on three different games plus the 3-leg parlay of those straights. A day with one or two flagged bets is short and is not in the card ROI. The product parlay stake is 0.25u. This table uses 1u per ticket.

| Split | Dates | Full cards | Short days | Empty days | Parlay tickets | Strict hit rate |
| --- | --- | --- | --- | --- | --- | --- |
| Tune | 57 | 0 | 1 | 56 | 0 | — |
| Holdout | 33 | 0 | 2 | 31 | 0 | — |
| Full | 90 | 0 | 3 | 87 | 0 | — |

Straight-card bets on full cards: 0. Parlay hit rate against the 20% goal is not estimable. NBA at this gate does not fill a daily card.

## Closing cohort (not used to choose the spec)

Same frozen spec. DraftKings and Pinnacle are simultaneous at the close, so CLV here is the gap between those two prices, not a move after a bet.

| Split | Bets | W-L-P | ROI (95% CI) | Avg CLV pp | Beat close | CLV n |
| --- | --- | --- | --- | --- | --- | --- |
| Tune | 10 | 5-5-0 | -0.8% (-66.4% to +64.8%) | +5.40 | 100% | 3 |
| Holdout | 3 | 1-2-0 | -36.4% (-161.1% to +88.4%) | — | — | 0 |
| Full | 13 | 6-7-0 | -9.0% (-65.2% to +47.1%) | +5.40 | 100% | 3 |

Full window by market: moneyline 3 bets, 2-1-0, ROI +41.8% (CI -101.1% to +184.6%), CLV +5.40 on all 3. Spread 7 bets, 2-5-0, ROI -45.8% (CI -114.4% to +22.8%), no point-matched CLV. Total 3 bets, 2-1-0, ROI +26.0% (CI -97.5% to +149.4%), no point-matched CLV.

Full cards: 0. Parlay tickets: 0. Ten short days, 80 empty days.

## Inputs kept and dropped

Kept: de-vigged Pinnacle as the fair probability (model weight 0). The 2% EV gate, the 12% EV cap, and the -250 to +250 band, at the DraftKings price. Moneyline, spread, and total stay in the menu. Rank by EV.

Dropped, because the tune did not support them:

- Pace on totals. It only enters through the model. No weight above 0 was eligible, and every weight above 0 lost money on the tune split while CLV fell toward zero and then negative.
- Rest and back-to-backs (margin adjustment and the 0.97 score factor). Same reason. The separate rest comparison was skipped because `w` stayed 0, which is what the rule says to do.
- Total residual 18.5. Alpha used 18.5. This tune had no eligible model weight, so the residual was not switched. The logged production residual stays 18.
- Injuries. No pre-bet injury feed is in this tape. The ESPN summary list is the final game page. It was hard-excluded. At weight 0 it cannot move the fair probability anyway.

The production projector still logs a margin and a total, including rest, so existing projection tests stay meaningful. That log is not the price. See `docs/nba-spec-1020.md`.

## What Alpha got right

The Alpha stack reported about +23% to +24% ROI on an older NBA replay (n=289 in the code comment; totals were the stronger market, about +14.7% in the note that prompted this work). It anchored to market prices, used a wider total residual (18.5), kept edges small, capped cover probabilities, and used a modest rest adjustment. The part that matches this tape is the anchor. Overriding Pinnacle with a model weight of 0.10 to 0.50 created bets, and those bets lost on the tune split. This tape does not reproduce +24%. It says the sharp line was the part worth keeping.

The 2026-10-14 all-sport report (`/workspace/backtest-1014/REPORT.md`) found the live v12.3.74 card at 74-87-1, ROI -6.85%, average CLV +0.55 percentage points, and the 2%+ EV bucket the worst bucket. That report is other sports, mostly NHL, and it is not an NBA result. It is the same warning: a model disagreement large enough to clear 2% EV has been the losing bet.

## Leakage

- Discarded run. Pairing any Pinnacle open inside 60 hours, without the 15-minute rule, let a DraftKings price be judged against a Pinnacle price that usually did not exist yet (median about +12 hours). That run showed a full-window ROI near +20% and a high rate of beating the close, on moneylines only, because a spread bug also dropped every spread. Those numbers are lookahead. They are not in the tables above. A 3-hour window would put a large share of that lookahead back and was not used.
- Sentinel opens. 42 games have only the timestamp 2025-10-21T11:55:39Z. The 60-hour rule removes them.
- Injuries and the 2025-26 net-rating seed would leak end-of-game or end-of-season information. Neither was an input.
- Ratings on a holdout game use only games before that bet, including tune-window results. The weight, pace, rest, and residual choices were not fit on the holdout.
- Closing-cohort CLV is not evidence that the line moved after the bet.
- Point-matched CLV misses spreads and totals whose number moved. That omission is the house rule. It makes the CLV sample smaller, not larger.
