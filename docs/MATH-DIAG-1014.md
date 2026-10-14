# Math diagnostic 1014

Research only. Branch `research/math-diag-1014`. No deploys, no `main` push, no Supabase writes, no Odds API calls. Primary score is held-out daily-card profit and the 3-leg parlay hit rate. CLV is a secondary luck check.

Codes are the checkout at `0ef48b0` (`netlify/functions/lib/omega-vnext`). The card numbers below are the 2026-10-14 v12.3.74 backtest in `/workspace/backtest-1014/full/REPORT.md` (pool `out/bets.jsonl`, card `/workspace/backtest-1014/daily_card_kpis.csv`). That run already matched Supabase Pinnacle/DraftKings/Hard Rock counts. This note does not re-pull odds.

Shipped card (v12.3.74, live stakes, all slate days in that file): straights 109-130-2, −14.20u (−9.7%), parlays 7-60 (10.4% vs a 20% goal), combined −19.56u / −12.0% ROI, day 95% CI −26.9% .. +3.0%, CLV −1.39 pp. The floors the gate meant to stand behind are 21-33-1, −17.6% ROI, CLV −1.32 pp.

## 1. Math path

One pipeline prices every candidate. The backtest calls the same functions (`run-backtest.js` 1230–1322, 1273, 1321).

1. Sport projector writes a raw cover, then blends it with the Pinnacle no-vig (`blendWithMarket`, `_common.js` 483–486).
2. `enrichCandidateWithEdge` (`edge.js` 469–518) attaches the best US American price, the de-vigged sharp fair, and a first EV.
3. `calibrateAll` (`calibrate.js` 319–345) replaces `coverProb` with the shrink. Default mode is A (`calibrate.js` 16, 205–207): hand-set K, no second band.
4. `attachEv` (`edge.js` 532–549) sets stake EV and the edge badge.
5. `applyExecutionBook` (`selection_pass.js` 177–198) keeps DraftKings, then the better of DraftKings and Hard Rock on the DraftKings line. Pinnacle is never the bet.
6. `applyGates` (`gates.js` 262–293) splits floor / lean / reject.
7. `selectStraights` (`select.js` 296–322) takes up to 3, ranked by stake EV.
8. `parlayFromStraights` (`parlay.js` 928–992) builds one 3-leg ticket from the best EV on three games.

### Worked loss: Brewers moneyline, 2026-09-22

Pool row in `out/bets.jsonl`. Milwaukee Brewers ML at DraftKings +118, tier floor, gate v74, result loss, −1.00u. Score 4–6 (Brewers road). CLV −1.68 pp. `pinLagMin` 0. `priceRule` nearest_1000. Entry `2026-09-22T13:00:44Z` (9:00 ET). Distance to 10:00 ET is 59 minutes. There is no 10:00 ET print on this game. The live card would have used the stored 10:00 board (`SELECTION_RULES.md` 5, 23). This backtest used the nearest earlier retail cluster (`run-backtest.js` 392–414).

Tape for the Brewers side, same `game_id` `2ec6c946384087513c61f58aad6e082f`, from the local odds cache:

| ET | Pinnacle | DraftKings | Hard Rock |
| --- | ---: | ---: | ---: |
| 06:00 | +119 | +114 | +115 |
| 07:30 | +120 | +117 | +115 |
| 09:00 (bet) | +121 / PHI −131 | +118 / PHI −142 | +115 |
| 11:35 close | +122 / PHI −132 | +118 | +115 |

Pinnacle lengthened the dog first. DraftKings followed and stayed 3 cents shorter. Hard Rock never moved. The bet is the short side of a dog the sharp book is laying off. The Pinnacle quote is the same cluster as DraftKings, so this loss is not a stale Pinnacle snapshot.

**De-vig.** `noVigTwoWay` (`odds_math.js` 72–83) is proportional inside the band. Power (`powerFair`, `odds_math.js` 47–69) runs only when either American is under −250 or over +210 (`lopsidedAmerican`, `odds_math.js` 34–38) and the implieds sum to more than 1. Pinnacle +121/−131 is inside that band.

- Brewers implied `100/221 = 0.452489`
- Phillies implied `131/231 = 0.567100`
- Sum `1.019588`, vig `1.96%`
- Fair `0.452489 / 1.019588 = 0.443796` which matches stored `fairSharp` `0.4437955082515226`

`sharpFairForSide` (`edge.js` 370–395) asks Pinnacle for both sides before any other sharp book. `noVigPinnacleImplied` (`edge.js` 353–358) is that same paired Pinnacle number. Shin is not implemented.

**Snapshot age.** Fair is the latest two-way non-closing Pinnacle at or before the bet, lag cap 3 hours (`run-backtest.js` 260–276, report pairing section). Here lag is 0 minutes. Across 2,259 kept markets the median lag is 0. Eighteen markets sit between 1 and 3 hours. None sit between 20 and 60 minutes.

**Blend.** MLB moneyline weight on the model CDF is 0.50 (`mlb.js` 180). `blendWithMarket` clamps to 0.05–0.95. Stored `modelRawP` `0.4924281462734529` is the post-blend number. Backing out the CDF: `0.50 * cdf + 0.50 * 0.443796 = 0.492428`, so `cdf = 0.54106`.

Other blend weights, model vs Pinnacle no-vig, before the second shrink:

| Sport | ML | Spread | Total | Where |
| --- | ---: | ---: | ---: | --- |
| MLB | 0.50 | 0.50 | 0.45 | `mlb.js` 180, 207, 229 |
| NFL | 0.50 | 0.50 | 0.10 | `nfl.js` 194, 219, 245 (`NFL_TOTAL_MODEL_WEIGHT`, `config.js` 764) |
| NCAAF | 0.10 | 0.10 | 0.10 | `cfb.js` 176, 202, 228 (`config.js` 767) |
| NHL | 0.10 | 0.50 | 0.45 | `nhl.js` 87 |
| NBA | 0.50 | 0.50 | 0.45 | `nba.js` 50 |

Football also point-shrinks before the CDF. Shipped λ is 1, so the point does not move (`POINT_SHRINK`, `config.js` 660–663). `pricedFromPointShrink` then keeps the lower of the raw and shrunk probabilities (`_common.js` 709–713).

**Shrink.** Mode A. `p = (1−K) * p_model + K * p_sharp`, clamp 0.02–0.98 (`calibrate.js` 104–120). K is `SHRINK_K` (`config.js` 303): Total 0.58, Spread 0.68, Moneyline 0.73. MLB overrides (`config.js` 322–324): Total 0.46, Spread 0.62, Moneyline 0.30. The second 0.42–0.58 band is mode `legacy` only (`calibrate.js` 63–71, 304–308). Mode B’s K floor 0.30 is not applied in mode A.

Brewers, K = 0.30:

`0.70 * 0.492428 + 0.30 * 0.443796 = 0.477838`

That matches stored `coverProb` `0.47783835486687376`. After both steps the CDF weight is `(1−0.30)*0.50 = 0.35` and the Pinnacle weight is 0.65. The published probability is still 3.4 pp above the sharp fair (`edge` 0.034).

**EV.** `evAtOdds` is `p * decimal − 1` (`odds_math.js` 105–108). `attachEv` calls `pushAwareEv` (`edge.js` 532–533, `push_ev.js` 19–22). `OMEGA_PUSH_EV` defaults on (`gaps_flags.js` 9–15, 22–23). A push multiplies EV by `(1 − pPush)`. This moneyline has no push, so the factor is 1.

`decimal(+118) = 2.18`. `0.477838 * 2.18 − 1 = 0.04169`, stored `0.0417`.

The same formula on the Pinnacle fair is `0.443796 * 2.18 − 1 = −0.0325`. DraftKings implied is `100/218 = 0.4587`, which is worse than the no-vig `0.4438`. The entire positive EV is the model sitting above both the sharp fair and the price. It is not a soft number versus Pinnacle.

**Gates.** `gateReason` (`gates.js` 140–233). This row clears them: odds +118 is inside −250..+250 (`config.js` 342–343), EV 4.17% is inside 2%..12% (`config.js` 337–339), cover is finite, `minCoverProb` is 0. Edge is not a gate (`edge_floor.js` is not an inclusion test; `gates.js` 197–202). EV above 12% returns `ev-stale` and cannot fill (`gates.js` 204–208). A miss of 2% returns `ev-floor` and can become a lean (`gates.js` 256–259).

**Rank, fill, parlay.** `compareByEv` sorts stake EV, then edge (`select.js` 186–190). `selectStraights` takes three passing floors, one game each, then positive-EV leans, then any remaining pregame lean including EV ≤ 0 (`select.js` 296–322). The backtest labels that last group `final-fill 0.5u` (`daily-card.js` 115–119). Stakes: floor 1u, lean and final-fill 0.5u, parlay 0.25u. Kelly units exist on `toPickObject` (`select.js` 413–437) and are then overwritten for leans. The card sim does not use Kelly.

`parlayFromStraights` re-sorts the floor pool plus the leans by EV, keeps the best side per game, and publishes the top three whenever three games exist (`parlay.js` 928–970). Combined probability is the product. Same-direction totals are multiplied by 0.92 for three legs (`config.js` 40–43, `parlay.js` 83–104). A non-positive ticket still publishes, labeled `combined EV not positive`. Correlation ρ defaults off and cannot raise the joint (`parlay.js` 106–114).

The 2025-10-07 v74 card is that fill path, not a floor path. Three NHL final-fills: Under 5.5 (EV −2.6%, win), Kings ML (EV −3.3%, loss), Rangers −1.5 (EV −3.4%, loss). The parlay is those three legs at +771, combined EV −8.9%, result loss (`daily-card-summary.json` examples). One leg won. The ticket lost. Hit rate on that construction cannot reach 20% if the legs are ~45% and correlated inside one sport: `0.45^3 = 9.1%`.

### Where the aggregate loses

v74 pool, 1u, every gate pass: 38-56-1, −11.93u, −12.7% ROI, CLV −1.18 pp, beat close 19.8%. EV 2–4% is −2.9% (n=63). EV 4–6% is −28.7% (n=20). EV 6–12% is −36.3% (n=13). Higher EV lost more often and did not beat the close.

v74 card: floor −17.6% (n=55 decided), lean 0–2% +2.8% with CI through zero and CLV −1.36, final-fill −8.6% (n=129). Parlays 7-60, −5.36u. NHL card combined day CI is entirely below zero (−48% .. −6%). NFL is the only green sport (+1.35u) and it lost the close (CLV −0.64).

The Brewers row is the pool pattern in one bet. Pinnacle was current. The de-vig was the inside-band proportional split. The model, after a 50% blend and a 30% shrink, still claimed 3.4 pp the sharp did not. The price was worse than that sharp. The gate treated the gap as a 4.2% edge. The dog lost, and the close was a longer dog, so CLV was negative too.

## 2. Hypothesis tests

Database check, SELECT only, 2026-10-14: `clv.games` 6,224, `clv.game_aliases` 424, filtered MLB Pinnacle/DraftKings/Hard Rock rows 11,438. The Brewers game has 610 odds rows in the database and 90 in the three-book cache. Those counts match the repair snapshot the backtest used. The `clv` API exposes `games`, `odds_snapshots`, `game_aliases`, `clv_results`, and `v_clv_by_sport`. It does not expose a backup table. No Odds API call.

The card accounting below reproduces the report: v74 straight profit −14.20u on 146.87u risk (−9.7%), parlay profit −5.36u, combined −19.56u / −12.0% on 97 days with money at risk. Day intervals are 4,000 resamples. Held-out is a slate before 2026-09-22. That is the sample outside the 9/22–10/10 window cited for the NFL and NCAAF blend weights (`config.js` 988–991). From 2026-09-22 is the tuning window, shown separately.

### (a) Stale Pinnacle vs a soft book that already moved

Pinnacle lag on the joined card is not the leak. Of 254 joined v74 straights (256 parsed), 241 have a Pinnacle quote within 2 minutes of the retail cluster, 12 sit between 2 and 20 minutes, none sit between 20 and 60, and 1 is older than 60 minutes. The held-out lag ≤2 minute straights are 82-97, −12.1% ROI. The one lag-over-20 bet lost.

Who moved first is usually invisible. 197 of 254 tapes have a single pregame cluster, so there is no earlier print to order. On the rest: Pinnacle first 16, retail first 10, same cluster 7, no 0.5 pp move 24. That is too small to rank a leader rule.

The price gap is the leak. On the 94 graded v74 pool bets, the bet's vigged implied probability averages 1.31 pp higher than `fairSharp` (a worse price than the no-vig). 86 of 94 have negative stake EV if the probability is the Pinnacle fair. Only 8 are soft versus Pinnacle. The 76 bets priced more than 0.5 pp worse than the fair are 28-48, −19.2% ROI, day interval −41.3% .. +0.0%. The Brewers ticket is this case: DraftKings implied 0.459 versus fair 0.444, lag 0, Pinnacle already longer.

Fix, `gates.js` `gateReason` after the EV test at line 209: reject when `americanToImplied(odds) > fair_sharp_p`. The fair is already on the candidate from `edge.js` 500. A price that is not better than the sharp is not a bet. This deletes the model-only EV the 2% floor is currently passing.

### (b) De-vig: proportional vs power vs Shin, favorite-longshot

Inside −250..+210, `noVigTwoWay` (`odds_math.js` 72–83) is proportional. Power runs only outside that band (`odds_math.js` 34–38), and `GATES` (`config.js` 342–343) already drops a bet outside −250..+250. Published bets are on the proportional branch. Shin is not in the code.

On the Brewers pair +121/−131 the three fairs are 0.4438 proportional, 0.4422 power (k 1.029), 0.4416 Shin (z 0.040). The gap is 0.2 pp.

On 1,831 graded closing Pinnacle moneylines (90 games unmatched), home-side log-loss is 0.6235 proportional, 0.6230 power, 0.6231 Shin. Proportional minus power is +0.00049, 95% interval −0.00063 .. +0.0015. Favorite bins versus proportional fair: 50–55% actual 52.9% (n=429, gap +0.4 pp), 55–65% actual 56.7% (n=742, gap −2.7 pp), 65–75% actual 69.8% (n=311, gap +0.3 pp), 75%+ actual 82.4% (n=346, gap −0.7 pp). The market does not show a favorite-longshot bias large enough to move a card.

On the 94 pool bets the same three fairs log-loss 0.6587 / 0.6579 / 0.6576. Changing the de-vig does not change who clears 2%.

No de-vig change. The band gate already keeps the card off the power branch.

### (c) Log-loss and Brier: model vs Pinnacle vs the close

Graded v74 pool bets, n=94. Log-loss / Brier:

| Probability | Log-loss | Brier |
| --- | ---: | ---: |
| Model `coverProb` | 0.6680 | 0.2377 |
| Bet-time Pinnacle no-vig | 0.6582 | 0.2329 |
| Pinnacle close no-vig | 0.6701 | 0.2387 |

Model minus bet-time Pinnacle log-loss is +0.0098 (interval −0.0035 .. +0.0223). The point estimate says the shrink still adds noise versus the sharp it is blended with. The close is not a better score than the bet-time fair on this selected set (fair minus close −0.0119, interval −0.0276 .. +0.0007).

`coverProb` is `(1−K) * modelRawP + K * fair` (`calibrate.js` 104–120) and `modelRawP` is already a market blend (`mlb.js` 180 and the table in section 1). Raising K does not create a price the book does not have. The gate fix in (a) is the one that changes the card.

### (d) EV formula, units, side and point

`evAtOdds` (`odds_math.js` 105–108) matches the stored EV on 94 of 94 pool bets within 0.0015. Straight and parlay profits match the report to the hundredth of a unit, so the stake math in the card file is the profit math.

Grading uses the bet's line, not the close (`run-backtest.js` `gradeBet` 850–877). A home spread wins when `homeScore + line > awayScore`. The Brewers moneyline loss agrees with the 4–6 road score.

The close number differs from the bet number on 20 of 96 v74 pool rows (`clvMethod` `point-normal` 20, `novig-same-point` 76). Examples: Under 11 closed 10.5; Hornets +5.5 closed +4.5; one NBA total moved 229.5 to 235.5; Braves −1.5 closed +1.5. Those 20 CLV figures are `gradeRealizedClv` (`run-backtest.js` 825–844), a normal shift, not a same-number no-vig. Profit does not use them. For the luck check, treat `|closePoint − line| > 0.5` as no CLV (`clv_grade.js` `pointsDiffer` is the existing helper) instead of shifting a multi-point move.

### (e) High EV as an error signal

v74 card straights, all days:

| Slice | Record | ROI | Day 95% | CLV pp |
| --- | --- | ---: | --- | ---: |
| EV > 4% | 7-19 | −36.0% | −75.8% .. −4.1% | −1.07 |
| EV 0–2% | 27-28 | −0.9% | −27.9% .. +25.4% | −1.18 |
| EV ≤ 0 (final-fill) | 60-69 | −7.8% | −25.4% .. +9.8% | −1.43 |

The pool agrees: EV > 4% is 9-23, −31.6%. The interval on the card slice is entirely below zero. `GATES.maxEV` is 0.12 (`config.js` 339, `gates.js` 204–208). The bets that pass are still too high. Lower `maxEV` to 0.04.

Dropping only the non-positive fills does not flip the held-out card: that rule is 49-61-1, parlays 2-18 (10%), held-out combined −11.5% (interval −42% .. +23%). The floor that remains is still the model-only EV from (a).

### (f) Parlay construction and correlation

v74 decided parlays: 7-60, hit 10.4%, Wilson 95% 5.2% .. 20.0%. Average decimal 9.97, so the break-even hit rate is 10.0%. The ticket hits what a +900 parlay is priced to hit, and the units are −5.36 because the longer tickets are the ones that lose.

Leg results inside those tickets: 43.7% wins (n=199). Independent product `0.437^3 = 8.4%`. Actual ticket hit 10.4%. 49 of 67 decided tickets are one sport. Same-direction totals: 0, so `PARLAY_TOTAL_HAIRCUT` 0.92 (`config.js` 40–43, `parlay.js` 83–90) never applied. 62 of 67 tickets are the three published straights.

A 20% hit needs a leg win rate near `0.20^(1/3) = 58%` if the legs are independent. The published legs win 44%. Filling with negative-EV dogs cannot get there. `parlayFromStraights` (`parlay.js` 928–970) will publish those three anyway.

## 3. What was profitable on held-out days

### v74 card, slate before 2026-09-22

Combined baseline −15.66u, −13.6% ROI, day interval −31% .. +5%, 75 days. Parlays are inside that figure.

Odds band, straights only, same cut. One scan, five bands:

| American odds | n | Record | Win % | Mean vigged implied | ROI | Day 95% | CLV pp |
| --- | ---: | --- | ---: | ---: | ---: | --- | ---: |
| ≤ −160 | 23 | 10-13 | 43.5 | 65.3% | −31.9% | −70% .. +2% | −1.37 |
| −159 .. −110 | 68 | 46-22 | 67.6 | 54.2% | +24.4% | +3.8% .. +43.6% | −1.64 |
| −109 .. +100 | 29 | 10-19 | 34.5 | 51.3% | −33.1% | −68% .. +9% | −2.17 |
| +101 .. +150 | 28 | 9-19 | 32.1 | 44.9% | −24.5% | −64% .. +16% | −1.57 |
| +151 .. +250 | 32 | 7-25 | 21.9 | 34.8% | −46.7% | −84% .. −7% | +0.23 |

Dogs as a group, same cut: 16-47, −40.3%, day interval −67.8% .. −11.0%. That interval is entirely below zero. The −159..−110 band is the only band whose day interval is entirely above zero. It is one of five bands, and its CLV is −1.64 pp, so the profit is ahead of the close. Composition of that band: NBA total 16, NBA spread 13, NHL total 9, NHL spread 8, NBA ML 7, NHL ML 6, and 9 football. It is a price band, not one market.

Sport × market on the same cut, cells with bets:

| Cell | n | Record | ROI | Day 95% | CLV pp |
| --- | ---: | --- | ---: | --- | ---: |
| NBA spread | 24 | 15-9 | +14.6% | −19% .. +50% | −1.98 |
| NBA ML | 41 | 19-22 | −12.5% | −48% .. +24% | −0.67 |
| NBA total | 21 | 9-12 | −20.2% | −63% .. +25% | −3.87 |
| NHL spread | 33 | 12-21 | −29.8% | −59% .. +1% | −0.84 |
| NHL ML | 21 | 10-11 | −6.3% | −49% .. +42% | −1.26 |
| NHL total | 20 | 8-12 | −27.7% | −67% .. +23% | −0.99 |

NBA spread is the only cell with a winning record and a positive ROI. The interval includes zero and the close was lost. NHL spread is the cell to leave off.

The card rule "publish only −160..−105, and a parlay only when all three straights are in that band" on the held-out days: straights 62-42-2 worth of the full-sample rule, held-out combined +8.83u / +15.6%, day interval −11% .. +43%, parlays 4-5 (44%, Wilson 19% .. 73%). The straight-only band is the result whose interval clears zero. The full card rule's interval does not, because many days void the parlay.

From 2026-09-22 the same short-favorite rule is +21% on 9 days (interval −43% .. +71%). Small.

### Alpha / Beta published cards, 2026-03-19 .. 2026-09-21

Source `kpi-legacy-alpha.json`. Straight profit excludes the 141 rows stored as sport `PARLAY` (those are the tickets, profit −$75 a loss). Parlays are scored from `parlayResult` / `parlayProfit`. Dollars. Day intervals on stake.

Straights, all 179 days: 262-224, +9.3% (interval −0.7% .. +19.3%), +$5,552 on $59,674. Train before 2026-06-15: 132-97, +15.6% (interval +1.7% .. +29.8%). Test from 2026-06-15 is the MLB summer: 130-127, +2.7% (interval −11.5% .. +17.1%). Test moneylines −9.4% (n=121). Test totals 73-50, +17.2% (interval −1.0% .. +35.4%), almost all MLB.

Parlays: 30-111, hit 21.3%, Wilson 15.3% .. 28.8%, +$6,764. Train 15-54 (21.7%, +$2,885). Test 15-57 (20.8%, +$3,879). The published Alpha ticket already cleared 20% on both halves. Stake on those tickets was 0.5u, not the v74 0.25u.

NBA, split 2026-04-20 inside that season. Train 24-20, +10.5% (interval −22% .. +42%). Test 38-16, +37.7% (interval +15.2% .. +60.8%), n=54. Test totals 28-11, +33.8% (interval +8.2% .. +60.0%), n=39. Test spreads 5-3, +39% on 8 bets, interval wide. NBA favorites were the book: 57-30, +26.4% (interval +5.6% .. +47.4%) over the whole Alpha window.

That NBA total result does not carry onto this model's held-out NBA totals (9-12, −20%, CLV −3.87). The pattern that shows up in both places is the short favorite, not "bet Omega NBA totals."

NHL Alpha: ML 13-6, +34% (interval −6% .. +75%), n=19. Totals 20-23, −8.9%. The v74 NHL card does not inherit the ML result.

## 4. Ranked fixes

Ranked by expected held-out card profit and by the parlay hit rate. CLV is the tie-break, not the sort.

| Rank | Fix | Where | Held-out profit | Parlay hit |
| --- | --- | --- | --- | --- |
| 1 | Reject a price worse than the Pinnacle no-vig | `gates.js` 209 | Removes the 76 pool bets at −19% whose interval sits on zero. 86/94 current "edges" are this. | Rises only because the surviving legs are fewer and shorter. |
| 2 | Straights only at −160..−110. Parlay only when three such legs exist. | `gates.js` 193–194 and `parlay.js` 956–958 | The one band with a day interval above zero: +24.4% on 68 held-out straights. Card rule +15.6%, interval still crosses zero. | 4/9 = 44% in that rule (Wilson 19–73%). Leg rate 68% implies about 31% if it holds. 58% legs are the 20% line. |
| 3 | `maxEV` 0.12 → 0.04. Do not final-fill the parlay. | `config.js` 339, `parlay.js` 960 | EV>4% card straights −36%, interval entirely below zero. Dropping fills alone leaves held-out ROI −11%. | Current 10.4% is the fill. Stopping the fill is required for 20% and is not sufficient. |
| 4 | Leave NHL spreads off. | `config.js` `SPORTS_ENABLED` is the wrong switch; filter in `select.js` 301 | Held-out NHL spread −29.8%, interval −59% .. +1%. | Same-sport NHL parlays are 5% in the full report. |
| 5 | CLV: no Gaussian shift when the close number moves by more than half a point. | `run-backtest.js` 825–844 | None. Stops a bad luck check. | None. |
| 6 | Power or Shin de-vig. Stale-pin lag filter. | `odds_math.js` 72 | About zero. Log-loss gap 0.0005. Lag filter drops 1 bet. | None. |

## 5. Spec

`docs/edge-math-spec-1020.md` is the one-page rule set for approval. It takes rank 1–3 as the card, keeps CLV as a check, and does not turn NBA back on to chase the Alpha total.

