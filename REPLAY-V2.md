# Omega pipeline v2 replay

Walk-forward on the stored Omega card, 2026-09-30 to 2026-10-29 (30 days). 1u = $150. Profit dollars and units are whole numbers rounded away from zero. The close is used only for CLV. Prices and win/loss grades are the stored card.

The candidate pool each day is the published straights plus that day's parlay legs. Full morning boards are not stored, so v2 can drop or resize a published leg. It cannot add a bet that never made the card.

| | Live | v2 |
|---|---:|---:|
| Straights W-L-P | 37-38-0 | 1-6-0 |
| Straight bets | 75 | 7 |
| Straight units | -5 | -6 |
| Straight $ | -$648 | -$870 |
| Parlay W-L-P | 5-22-0 | 0-0-0 |
| Parlay hit rate | 18.5% | — |
| Parlay units | +6 | 0 |
| Parlay $ | +$803 | $0 |
| Overall units | +2 | -6 |
| Overall $ | +$155 | -$870 |
| Overall ROI | +2% | -80% |
| CLV cents (n) | 0.81 (68) | 2.46 (7) |
| Beat close | 64.7% | 100% |
| Brier on bets | 0.256 | 0.2727 |
| Log loss on bets | 0.7057 | 0.7386 |
| Brier, all straights | 0.2560 | 0.2561 |
| Log loss, all straights | 0.7057 | 0.7060 |
| Market Brier | 0.2546 | — |
| Pass days | 0 | 25 |
| Short-card days | 12 | 4 |
| Max drawdown | 19u | 6u |

Bootstrap, 10000 day resamples, seed 1030. Difference is v2 minus live.

- Profit: -$1025 raw -1025. 95% CI -$5750 to +$3193. p=0.676.
- ROI: -132.0 to 4.1 percentage points. p=0.056.

## Read

Live straights were about even and the parlays made the card. v2 kept the prices and the grades, then dropped any leg whose walk-forward probability did not clear the price. What remained was 7 straights and no parlay. Those 7 beat the close and lost the games. The all-straight Brier did not improve on the raw model, and the no-vig market is still the best probability in the file.

Recommendation: Do not replace the live card. The profit gap is not significant. v2 is the cleaner process (no forced fill, walk-forward calibration, ML+total parlays only), but this 30-day pool does not justify replacing the live card. Leave OMEGA_PIPELINE_V2 off and keep the shadow.

## Data and mapping

- Unmatched games (no close id): 5
- Alt-line mismatches (close point ≠ bet point): 37
- Missing closes (no CLV cents): 12
- Duplicate snapshots dropped: 57 rows across 45 games. The replay keeps the latest close per game.
- Pick-time price reconstructed from the card edge, because no pre-pick Pinnacle pair matched the number: 26
- St. Louis / "state louis" spellings normalized before the game key: 0
- Other derived-set notes: 2026-10-13 units_drift; 2026-10-15 parlay_skip_with_risk

CLV cents stay on the stored grade. A moved NHL or MLB number is left unmatched rather than scored off an alt line. `clvPp` is cents.
