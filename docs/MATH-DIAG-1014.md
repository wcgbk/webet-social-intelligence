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

Steps 2–5 follow in later commits on this file.
