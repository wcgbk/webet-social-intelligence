# Pipeline v2 replay

Stored DraftKings and Hard Rock quotes, joined on game, market, side, and line: 66 of 87 candidate rows (109 of 150 stored rows). Sources: line snaps 48, odds-master 10:00 board 3, stakeaudit cards 15.

Coverage is short of the full candidate pool. Dates with candidate rows and no stored quote: 2026-10-10, 2026-10-20, 2026-10-21, 2026-10-22, 2026-10-23, 2026-10-24. The primary 30-day replay used for ship decisions is tools/omega-v2/replay-bp1104.js. This replay prices a row only from a stored DraftKings or Hard Rock quote.

Walk-forward on the stored card, 2026-09-30 to 2026-10-29 (30 days). 1u = $150. Profit dollars and units are whole numbers rounded away from zero. The close is used only for CLV. Prices and win/loss grades are the stored card. A bet price is the stored DraftKings or Hard Rock quote when one matches the row.

The candidate pool each day is the published straights plus that day's parlay legs. Full morning boards are not stored, so v2 can drop or resize a published leg. It cannot add a bet that never made the card.

| | Live | v2 |
|---|---:|---:|
| Straights W-L-P | 37-38-0 | 4-9-0 |
| Straight bets | 75 | 13 |
| Straight units | -5 | -3 |
| Straight $ | -$648 | -$398 |
| Parlay W-L-P | 5-22-0 | 0-1-0 |
| Parlay hit rate | 18.5% | 0% |
| Parlay units | +6 | -1 |
| Parlay $ | +$803 | -$38 |
| Overall units | +2 | -3 |
| Overall $ | +$155 | -$436 |
| Overall ROI | +2% | -51% |
| CLV cents (n) | 0.81 (68) | 0.8 (10) |
| Beat close | 64.7% | 80% |
| Brier on bets | 0.256 | 0.2515 |
| Log loss on bets | 0.7057 | 0.6962 |
| Brier, all straights | 0.2560 | 0.2556 |
| Log loss, all straights | 0.7057 | 0.7050 |
| Market Brier | 0.2546 | — |
| Pass days | 0 | 18 |
| Short-card days | 12 | 12 |
| Max drawdown | 19u | 5u |

Bootstrap, 10000 day resamples, seed 1030. Difference is v2 minus live.

- Profit: -$591 raw -591. 95% CI -$5249 to +$3475. p=0.809.
- ROI: -88.4 to -5.4 percentage points. p=0.031 (excludes 0).

## Read

On this window v2 published 13 straights and 1 parlays. The live card published 75 straights and 27 parlays. The candidate pool is the published card, not the morning board, so a leg that never made the card cannot be added.

Recommendation: Do not replace the live card. Stored DraftKings and Hard Rock quotes cover 66 of 87 candidate rows. Ship decisions use tools/omega-v2/replay-bp1104.js for this window.

## Data and mapping

- Unmatched games (no close id): 5
- Alt-line mismatches (close point ≠ bet point): 37
- Missing closes (no CLV cents): 12
- Duplicate snapshots dropped: 57 rows across 45 games. The replay keeps the latest close per game.
- Pick-time price reconstructed from the card edge, because no pre-pick Pinnacle pair matched the number: 26
- St. Louis / "state louis" spellings normalized before the game key: 0
- Other derived-set notes: 2026-10-13 units_drift; 2026-10-15 parlay_skip_with_risk

CLV cents stay on the stored grade. A moved NHL or MLB number is left unmatched rather than scored off an alt line. `clvPp` is cents.
