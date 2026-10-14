# Edge math: 2026-09-29 vs the card now

Window this note is about: Omega as it was computed from 2026-09-29 through 2026-10-05. No full backtest.

## 9/29 method

The morning card on 2026-09-29 ran on commit `1c6237b` (2026-09-28 11:59 ET). That commit is model `v12.3.12-omega-vnext-desk-lock`. Nothing in `edge.js` changed again until 2026-09-30 (`55e2570` turns NHL on; it does not retouch the edge formula). There is no tag and no deploy note that points the 9/29 card at a different commit.

`attachEv` in that commit (`edge.js`, then lines 447–463):

- `coverProb` is the shrink-blended model probability.
- Edge = `coverProb − fair_sharp_p`. If the fair is missing, edge = `coverProb − implied(odds)`.
- EV = `coverProb × decimal(odds) − 1` (`evAtOdds`). No push factor yet.
- Letter grades use that model edge (`config.js` `QUALITY_GRADE`): A+ ≥ 5%, A 3.5–5%, A− 2.0–3.5%, otherwise B.
- Publish floors are stake-EV floors (MLB/NCAAF/NBA/NHL 3%, NFL 2.5%), not the price edge.
- Stake is quarter-Kelly on `coverProb`, then `kellyToUnits` (`× 50`, nearest 0.5u, floor 0.5u). It is not `0.25 × (p × d − 1) / (d − 1)` on a Pinnacle fair, and 1u is not $150 / 1.5% of a $10,000 bankroll.

The stored 9/29 Omega rows in `data/clv-ledger-seed.json` (same model version) are three MLB straights:

- Chicago White Sox ML +110 vs Houston
- Boston @ New York Yankees Over 6.5 +107
- Chicago Cubs @ San Diego Padres Over 7.5 +110

## What the code did before this pass

These are the lines that still implemented the 9/29 idea, or that gated the audit fix:

| Piece | Where | What it did |
| --- | --- | --- |
| Model edge and model EV | `edge.js` `attachEv` (now 592–624; the model branch is unchanged) | `edge = coverProb − fair`, else `coverProb − implied`. EV = push-scaled `coverProb × decimal − 1`. |
| Sharp price, flag only | `index.js` (the old `if (sharpFairEnabled())` around the old 569) | Pinnacle power fair ran only when `OMEGA_SHARP_FAIR=1`. Default off, so the card stayed on the model blend. |
| Soft fair fallback | `edge.js` `sharpFairForSide` (374–402) | With the flag off, a missing Pinnacle pair falls through to other sharp books and a mixed consensus. |
| EV with a push factor | `sharp_fair.js` `evaluateQuote` (the old `stakeEv` call) | Flag-on EV was `(1 − q) × (p × decimal − 1)`, not `p × decimal − 1`. |
| Gate | `gates.js` (the EV check just above 211) | Main floor was stake EV ≥ 2%. A miss, including a negative EV, could fill as a lean. Edge was not the gate. |
| Stake | `select.js` `toPickObject` | `kellyToUnits` cap 1.25u (`config.js` `MAX_STRAIGHT_UNITS_PER_PICK`). B cap 0.5u. Lean stake flat 0.5u. |
| CLV headline | `candidate_closes_v2.js` `stampClose` (was 226) | `dec × closeNoVig − 1` was the headline only while the flag was on. Otherwise the headline was close-fair minus generate-fair. |

Book-audit pieces that already matched the spec and stay:

- No soft-book fair once the row is sharp-priced (`sharp_fair.js` `priceCandidate`, and `sharpFairForSide` when the flag is on).
- Same line, or the NFL 3/7 half-point convert (`sharp_fair.js` `evaluateQuote`).
- Best of DraftKings and Hard Rock by EV (`sharp_fair.js` `priceCandidate` shop loop).
- CLV number `bet decimal × de-vigged Pinnacle close prob on the same line − 1` (`candidate_closes_v2.js` `priceClv`, lines 211–215). A different point does not get a fair.

## Fix (best practice wins where it conflicts with 9/29)

WeBet: edge and EV are against the Pinnacle de-vigged fair at the same line. The model probability does not enter either number.

- Edge = `p_fair − implied(bet price)` (`sharp_fair.js` 372, kept on a later `attachEv` at `edge.js` 592–607).
- EV = `p_fair × decimal − 1` (`sharp_fair.js` 245).
- The card always runs that price (`index.js` 566–571). A missing Pinnacle pair is a reject, not a soft fair.
- Grades on that edge: A+ ≥ 5%, A 3.5–5%, A− 2.0–3.5%, B 1–2%. Under 1% is not a lean fill (`gates.js` 209–216). EV above 12% stays `ev-stale`.
- Stake is quarter-Kelly on the Pinnacle fair: `f = 0.25 × (p × d − 1) / (d − 1)`, in units of $150 on $10,000 (`select.js` `sharpStakeUnits`, 408–418). Caps: A+/A/A− 1u, B 0.5u. Parlay stays 0.25u.
- CLV headline is the price CLV on the same line (`candidate_closes_v2.js` `stampClose`).
- KPI dollars and units on the tracking page, and the daily P/L dollars, display as whole numbers rounded up (`tracking/index.html` `wholeUp`, `daily-omega/index.html` profit line). Stakes of 0.5u and 0.25u stay stakes.

`attachEv` still computes the 9/29 model edge for a row that is not sharp-priced. That path is what the older unit tests lock. The published card is sharp-priced before the gates.

## 9/29 replay

Does not reproduce the published card.

The stored card (`edge-picks-omega/picks-2026-09-29`, model `v12.3.12`) is three MLB straights and a 0.5u parlay:

| Pick | Price | Grade | Units | Shown edge | Shown EV | Book |
| --- | --- | --- | --- | --- | --- | --- |
| Chicago White Sox ML | +110 | A | 1.25u | 4.0% | 7.0% | BetMGM |
| Cubs @ Padres Over 7.5 | +110 | A | 1u | 3.8% | 4.9% | ESPN BET |
| Red Sox @ Yankees Over 6.5 | +107 | A | 1.25u | 3.6% | 6.0% | William Hill |

Those edges are `coverProb − fair`. The parlay is the White Sox ML, an Over 7 at −115, and the Yankees Over 6.5, shown at 18% EV.

The stored-board replay (`tools/omega-dryrun-selection.js --date 2026-09-29`, no Odds API, no writes) finds no 10:00 line-move board (`stored-10:00-missing`). Priced candidates: 0. Straights: 0. There is no snapshot to reprice those three bets at a Pinnacle fair. A match was not expected anyway: the published edges are the model gap, and two of the three books are not DraftKings or Hard Rock.

## Today (2026-10-14)

Stored-board run, same tool, `allowPaidOdds: false`, pregame clock 10:00 ET. Snapshot served `2026-10-14T14:02:16Z`. Sharp fair priced 28 sides and rejected 8 (6 with no Pinnacle pair, 2 point mismatches). Every priced side failed the 1% edge floor. Best price edges:

| Side | Price | Edge | EV |
| --- | --- | --- | --- |
| Sam Houston State ML | +105 | −0.69% | −1.4% |
| Sam Houston State +1.5 | −105 | −0.74% | −1.4% |
| Missouri State ML | +136 | −0.77% | −1.8% |
| Canadiens +1.5 | −225 | −1.03% | −1.5% |
| Milwaukee Brewers ML | +150 | −1.17% | −2.9% |

Card: 0 straights, no parlay. No side is a B (1–2%) or better against the Pinnacle fair.

The card already stored for this date (`picks-2026-10-14`, model v12.3.74, before this pass) is the model-edge fill: Brewers ML +150 shown at 1.4% edge / 1.4% EV, Sam Houston ML +105 at 0.5% / −0.2%, Missouri State ML +136 at −0.5% / −2.1%, plus a 0.25u parlay labeled combined EV not positive. Those three are the same names as the closest price edges above, and each one is negative against Pinnacle. The new card leaves them off.
