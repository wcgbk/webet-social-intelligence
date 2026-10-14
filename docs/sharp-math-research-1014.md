# Sharp math research — 2026-10-14

Research for the WeBet daily card. No deploy, no `main` push. The live pricer this note diagnoses is v12.3.74 (`e84d5aa` and the checkout described in `docs/MATH-DIAG-1014.md` on `origin/research/math-diag-1014`). Primary sources are listed at the end. Local notes are in `/workspace/sm/sources.md`.

The card bets DraftKings or Hard Rock. Pinnacle is the fair-price anchor and is never the bet. Markets in scope are two-way moneylines, spreads, and totals.

## What v12.3.74 actually prices

`docs/MATH-DIAG-1014.md` traces one pipeline. A sport model writes a cover probability, blends it with a Pinnacle no-vig (`blendWithMarket`), then `calibrateAll` shrinks again toward the sharp with a hand-set K (mode A). Stake EV is that blended probability times the DraftKings or Hard Rock decimal, minus 1. The de-vig inside the −250 / +210 band is proportional (`noVigTwoWay` in `odds_math.js`). Power runs only outside that band.

Held-out card, live stakes, v12.3.74 (`/workspace/backtest-1014/full`): straights 109-130-2, −14.20u (−9.7% ROI), parlays 7-60 (10.4% vs a 20% goal), combined −19.56u / −12.0% ROI. CLV −1.39 pp. The pool of every gate pass, 1u flat: EV 2–4% ROI −2.9% (n=63), 4–6% −28.7% (n=20), 6–12% −36.3% (n=13). Higher displayed EV lost more and beat the close less often (pool CLV −1.18 pp, beat-close 19.8%). Average taken odds sit about +112 to +143.

Worked row, Milwaukee Brewers moneyline, 2026-09-22, DraftKings +118, lag to Pinnacle 0 minutes:

| Quantity | Value |
| --- | ---: |
| Pinnacle | +121 / Phillies −131 |
| Raw implieds | 0.4525 / 0.5671, overround 1.96% |
| Proportional fair (what shipped) | 0.4438 |
| Power fair (k = 1.029) | 0.4422 |
| Model after 50% MLB blend | 0.4924 |
| After hand shrink K = 0.30 | 0.4778 |
| EV at +118 from the shrunk model | +4.17% (bet, floor tier) |
| EV at +118 from the Pinnacle fair | −3.25% proportional, −3.61% power |

DraftKings implied at +118 is 0.4587, which is already worse than the no-vig 0.4438. The whole positive EV is the model sitting above the sharp. The dog lost, and the close was a longer dog (CLV −1.68 pp). That row is the pool pattern: the gate treats model disagreement as edge.

Blend weights before the second shrink (`docs/MATH-DIAG-1014.md`): MLB ML/spread/total 0.50 / 0.50 / 0.45, NFL 0.50 / 0.50 / 0.10, NCAAF 0.10 everywhere, NHL 0.10 / 0.50 / 0.45, NBA 0.50 / 0.50 / 0.45. Mode A then mixes again with `SHRINK_K` (total 0.58, spread 0.68, moneyline 0.73; MLB overrides 0.46 / 0.62 / 0.30). Neither step was fit on held-out profit. Štrumbelj's result below is the reason not to stack a second favorite-longshot adjustment on top of a de-vig that already made one.

## 1. De-vig methods

Let π_i = 1 / decimal_i be the raw implied probability of outcome i. For American odds A, decimal = 1 + A/100 when A > 0, and 1 + 100/|A| when A < 0. The overround is Σπ − 1. A fair vector p sums to 1 and stays inside (0, 1).

### Multiplicative (proportional, normalization)

p_i = π_i / Σπ.

The same percentage of the margin comes off every outcome. It is the method in v12.3.74 inside the band, and the method EVstrike documents as its Pinnacle model. It has no favorite-longshot tilt. On a longshot it leaves too much probability on the dog, which shows up as phantom EV when a soft book is only slightly longer than Pinnacle.

### Additive

p_i = π_i − (Σπ − 1) / n.

Each outcome gives up the same probability points. With two outcomes this is one line of arithmetic. It can go negative when a longshot's raw implied is smaller than the per-outcome margin. That happens on big boards (futures, large 1X2 margins), not on a two-way main inside −250..+250 with a Pinnacle hold of a few percent.

### Shin

Shin (1992, 1993) models the overround as coming from a fraction z of informed money. The fair probabilities solve

π_i = [z·p_i + (1 − z)·p_i²] / something normalized, or the usual inverse: find z > 0 such that the Shin map of the π vector sums to 1.

Clarke, Kovalchik, and Ingram (2017) prove that for exactly two competitors Shin's probabilities are the additive probabilities. OddsJam states the same identity. On the NFL/NBA/MLB/NHL two-way card, a separate Shin solver does not change a number that additive already produced. Shin earns its keep on three-way soccer (1X2), which this card does not post.

### Power

Find one exponent k such that Σ π_i^k = 1, then p_i = π_i^k.

For an overround, k > 1 and every π in (0, 1) shrinks, with the longshot shrinking more in probability points than a pure percentage haircut would. For an underround (Σπ < 1, which Pinnacle posts on some competitive markets), k < 1 and the same equation still has a unique positive root. Probabilities stay in (0, 1). There is no negative-probability failure.

This is the Clarke / Vovk-Zhadanov power method. The R `implied` package writes the inverse exponent (bookmaker probability = p^k, so fair = π^(1/k)); it is the same family.

### Probit

Let z_i = Φ⁻¹(π_i). Find a shift δ such that Σ Φ(z_i − δ) = 1, then p_i = Φ(z_i − δ).

The margin is removed in normal-score space, so a two-way market near 50/50 barely moves (the normal density is flat there in relative terms) and the tails move smoothly. Practitioners like it for spreads and totals because those prices live next to a point spread, and a normal margin is the natural model for basketball. It is not the winner on sharp moneylines in the large studies below. On a two-way market it lands within a few tenths of a point of additive.

### Worst-case

Not a statistical estimator. Compute several fairs and keep, for the side being bet, the smallest p. Vigged will flag a price as +EV only when the edge survives the most cautious of the methods it runs, and it marks anything more than 10% above the no-vig for a human check. actualodds.com defines worst-case as the minimum fair probability across multiplicative, additive, power, and Shin.

Worst-case is a false-positive screen. It is a biased probability: it systematically understates the chance of the side you like, so it is the wrong number to size with and the wrong number to report as fair. It is the right number to ask "does this edge depend on which de-vig I picked?"

### One market, five answers

Side 1 is the first price. Shin equals additive on every row. Spread is the gap from the highest fair to the lowest, in percentage points.

| Market | Overround | Mult | Additive = Shin | Power (k) | Probit | Worst on side 1 | Spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| −110 / −110 | 4.76% | 50.00% | 50.00% | 50.00% (1.072) | 50.00% | 50.00% | 0.00 pp |
| −105 / −115 | 4.71% | 48.92% | 48.87% | 48.84% (1.071) | 48.86% | 48.84% | 0.08 pp |
| +121 / −131 (Brewers tape) | 1.96% | 44.38% | 44.27% | 44.22% (1.029) | 44.27% | 44.22% | 0.16 pp |
| +210 / −250 (edge of the card band) | 3.69% | 31.11% | 30.41% | 30.06% (1.063) | 30.39% | 30.06% | 1.05 pp |
| −300 / +240 (outside the card band) | 4.41% | 71.83% | 72.79% | 73.31% (1.079) | 72.84% | 71.83% | 1.48 pp |

Near even money the methods are the same number. At +210 the multiplicative dog is a full point more optimistic than power. At −300 / +240 the multiplicative favorite is 1.5 points too low, which is the same fact stated from the other side: multiplicative hands that point to the longshot.

A soft +230 against a Pinnacle +210 / −250 illustrates the phantom:

- Multiplicative dog 31.11% at decimal 3.30 → EV +2.67% (clears a 2% floor).
- Power dog 30.06% at decimal 3.30 → EV −0.81% (no bet).

The 2% "edge" was the de-vig, not the price.

### Which method is best, by market

| Market | Best supported fair | Why |
| --- | --- | --- |
| Sharp two-way moneylines (Pinnacle, and the tennis sets in the same studies) | Power, fitted λ about 2 on the Box-Cox dial that has multiplicative at 0, additive at 1, and power near 1.5–2 | vigged, 77.5k sharp two-way markets, mostly Pinnacle tennis. Power wins. Additive/Shin worse by 0.09 millinats [0.03, 0.16], multiplicative worse by 0.42 [0.26, 0.58]. Fitted λ = 2.0 [1.5, 3.1]. The gap is in the tails: dogs priced 5–10% won 5.6%; power said 6.2%, multiplicative 7.7%. |
| Same matches, retail book vs Pinnacle | The book's λ is not Pinnacle's λ | vigged: Bet365 on those tennis matches fits λ = 1.2 [1.1, 1.3], Pinnacle 2.1 [1.5, 3.3]. De-vig the book you trust. Do not copy a retail λ onto Pinnacle. |
| US retail moneylines (the soft book itself) | Multiplicative, fitted λ about 0.4 | vigged, 71.5k NFL/NBA/NHL/MLB retail moneylines. Dogs win more often than power says. Multiplicative wins by 0.38 millinats [0.10, 0.68] on held-out seasons, mostly NBA. This is the reverse favorite-longshot bias in closing retail prices. It is a finding about the soft book, not about the Pinnacle anchor. |
| Soccer 1X2 | Power, ahead of Shin | vigged, 235.6k markets: power beats Shin by 0.11 [0.06, 0.16] and multiplicative by 0.71 [0.56, 0.85]. Clarke et al. (2017) on tennis, Australian racing, and NZ greyhounds: power universally beats multiplicative and matches or beats Shin. |
| Two-way spreads and totals within a few points of −110 | Any of them | The table above. −110/−110 is identical. −105/−115 differs by 0.08 pp, which is under a cent of price and under the 2% floor. upside.tools, 64,670 two-way markets: additive, odds-ratio, and probit are indistinguishable; Shin equals additive on two ways; multiplicative understates heavy favorites by 1.71–2.71 points and overstates the longshot. |
| Heavy favorites and longshots | Power on a sharp book; worst-case if the only goal is to refuse method-driven EV | Multiplicative is the worst tail estimator on sharp prices (upside.tools, vigged, Clarke). |

Štrumbelj (2014) found Shin better calibrated than proportional normalization across bookmaker-competition pairs, and found that the gap shrinks as the market gets larger. 45analytics summarizes the practical corollary: power dominates proportional, and a second favorite-longshot adjustment stacked on a de-vig that already applied one double-counts the bias. v12.3.74 does that stack (proportional or power, then a model blend, then a hand shrink).

### Choice for this card

Use power on every Pinnacle two-way, including spreads and totals.

- On a Pinnacle moneyline it is the method the sharp-book studies pick, and it is the method that removes the tail phantom inside the card's +250 end.
- On a spread or total near −110 it returns the same probability as multiplicative, additive, Shin, and probit, so switching it on does not reprice the even-money card.
- Shin adds nothing on two outcomes.
- Probit is a reasonable spread model and is not more accurate than power on the published tests.
- Worst-case stays a diagnostic (report it, do not bet it). Inside −110/−110 it equals power. At +210 it equals power, because power is the cautious dog number. The screen only bites when some other method is the one that created the edge.

Retail-book multiplicative would be right only if we were de-vigging DraftKings to estimate the true win rate of DraftKings prices. We are not. The fair is Pinnacle's price with the margin removed. DraftKings enters as the payout, once.

## 2. Spreads and totals at a different point

A no-vig probability belongs to one number. vigged: "a −3 no-vig price does not price a −2.5 bet." PinnWire's stale-odds note makes the same cut: compare only exactly equivalent markets. A Pinnacle −3.5 does not fair a DraftKings −3, and a Pinnacle 47.5 total does not fair a DraftKings 46.

### Push

US spreads and totals on an integer void on a landing exactly on the number (stake returned). Half-point lines do not push. The two-way American price is a price on the conditional contract: the break-even win rate given no push is 1/decimal, for any push rate. De-vigging the two-way therefore estimates

p_cond = P(win | no push).

The unconditional pieces, with q = P(push), are

P(win) = p_cond · (1 − q), P(lose) = (1 − p_cond) · (1 − q), P(push) = q.

Stake EV with the stake returned on a push (gridironandwine writes the same identity as P(win)·(decimal − 1) − P(lose)):

EV = (1 − q) · (p_cond · decimal − 1).

When q = 0 this is p · decimal − 1. v12.3.74's `pushAwareEv` is this formula when `coverProb` is conditional. The missing piece in production is q. A two-way quote does not contain q. It has to come from the margin distribution.

### Key numbers

NFL margins pile up on field goals and touchdowns. They are not a smooth normal.

Unconditional final margins, nflverse 1999–2025, 7,276 games (nflanalytic.com, same counts restated by parlaytools.com):

| Margin | Share of games |
| ---: | ---: |
| 3 | 15.1% |
| 7 | 9.0% |
| 6 | 6.0% |
| 10 | 5.5% |
| 4 | 4.9% |
| 14 | 4.9% |

Those unconditional rates count either team winning by that margin. The rate that prices a spread is the push rate when the market is actually on that number (parlaytools.com, same game log):

| Closing spread | Games | Push rate |
| --- | ---: | ---: |
| exactly 3 | 1,153 | 9.0% |
| exactly 7 | 491 | 6.5% |
| 2.5 to 3.5, land on 3 | 2,366 | 17.0% land on 3 (not all are pushes) |
| 6.5 to 7.5, land on 7 | 1,122 | 8.7% land on 7 |

bettoredge.com's alternate-line table uses 7.3% at −3 and 4.7% at −7. The conditional-on-the-close figures (9.0% and 6.5%) are the ones that match the contract a bettor holds, and they come from a counted game log. Unabated's conference-championship note treats 3, then 7, then 6 as the NFL spread keys, and treats totals keys as weaker, with odd totals worth more than even ones because of the way football scoring lands.

A half point that crosses 3 changes the cover result in about 9 pushes per 100 games closed on 3. A half point that crosses 5 changes far fewer. The juice to buy through 3 is routinely 20–25 cents, against about 10 cents in open space (oddsshopper.com, betpredictionsite.com). Basketball has no equivalent keys; a normal margin is enough. NHL and MLB are low-scoring and discrete (Poisson / Skellam for goals, negative binomial for runs — gridironandwine).

### Alt conversion, when the points differ

Unabated's alternate-line calculator and derivative notes, and the gridironandwine cover calculator, use the same construction:

1. De-vig the sharp two-way at the sharp point. That anchors p_cond (and, on an integer, a push mass).
2. Pick the sport distribution. NFL: a keyed distribution (normal kernel plus mass on 3, 6, 7, 10, 14), not a plain normal. NBA: normal. MLB run margin: negative binomial. NHL goal margin: Poisson or Skellam. Totals use the matching scoring distribution.
3. Shift that distribution until it reproduces the de-vigged cover probability at the sharp point.
4. Read P(win), P(push), and P(lose) at the bet point. The value of each half point depends on the origin, not on a flat cents-per-half-point table.
5. If the move is wide enough that the distribution is no longer identified by one anchor (several points away, or a sport with no published family), do not convert.

The half-point identity, when the only change is crossing one integer k and q = P(margin = k) is known for that line:

- Sharp on k, bet on k − 0.5 (bought the hook, favorite side): P(win) = p_cond·(1 − q) + q, push = 0.
- Sharp on k, bet on k + 0.5 (laid the extra half): P(win) = p_cond·(1 − q), push = 0.
- Sharp on the half point, bet on the integer: the integer's conditional win probability is the half-point probability renormalized by (1 − q), and the bet pushes with probability q.

Using the unconditional 15% in place of the 9% push rate overstates the hook by a factor of about 1.7. Using 9% when the close is not near 3 overstates it too. Convert only across a key the close is actually on, and only with the conditional push rate.

### Rule for the card

1. Same point and same side: use the power fair directly. q = 0 on a half point. On an NFL integer spread of 3 or 7, q = 9.0% or 6.5% from the counted close-conditioned log, and EV uses the push formula.
2. NFL spread, points differ by exactly 0.5, and the integer between them is 3 or 7: convert with the half-point identity and those push rates.
3. Every other mismatch, including other sports, other integers, totals, and any gap of 1 point or more: reject the candidate. There is no second anchor in the tape to identify a full distribution, and a guessed sigma would invent EV the research does not support.

NCAAF keys are the same scoring system but the push rates above are NFL counts. Do not reuse them. NBA, NHL, and MLB alternate lines need the distribution step with a published scale; until that scale is in the pricer, a point mismatch rejects.

## 3. Freshness of the sharp/soft pair

The edge this card is allowed to claim is a price difference at one moment: Pinnacle's no-vig versus the DraftKings or Hard Rock payout on that same line. It is not a difference between a Pinnacle quote from earlier and a soft quote from later.

PinnWire's account of manufactured +EV: a cached no-vig fair of decimal 2.00 against a soft 2.08 prints +4.0%, but if the live fair has already moved to 2.15 the same soft price is −3.3%. The scanner surfaces the largest fake gaps on the references that are furthest behind. Their rule is to timestamp both prices, reject stale inputs, and compare only equivalent markets.

The follow lag that makes the trade real is the soft book's delay in copying Pinnacle, measured by FairOdds in the 1–5 minute range on the markets they timed, and described by pinnapi as "near-instant on headline markets to minutes on neglected ones." That lag is only tradable if the Pinnacle side of the comparison is the current Pinnacle price. A Pinnacle quote that is itself hours old is a stale reference, not a sharp one.

Buchdahl's pre-closing sample (the networked write-up of his European-league set) only supports Pinnacle-versus-soft EV when the books were collected at approximately the same time. Vigged drops stale and suspended prices from the no-vig and from every edge, and only flags a price when the book's quote is live. SharpLine rescans on a five-minute cycle. EVstrike polls game odds about every 30 seconds and tells the user to confirm the price because the poll lags the book.

### What the v12.3.74 tape shows

`docs/MATH-DIAG-1014.md`: 2,259 kept markets, median Pinnacle lag 0 minutes, 18 markets between 1 and 3 hours, none between 20 and 60 minutes. The backtest cap was 3 hours. The Brewers loss was lag 0, so freshness did not cause that loss. The 3-hour cap is still the wrong rule: it is wide enough to admit the PinnWire failure on those 18 markets, and the empty 20–60 minute band means a tight cap does not slice through a dense set of real pairs.

The live card is priced from the stored 10:00 ET board (`SELECTION_RULES.md`). Pinnacle, DraftKings, and Hard Rock on that board are one capture. Their lag is 0 by construction.

### The N this card should use

N = 15 minutes.

- Both timestamps, |t_pinnacle − t_soft| ≤ 15 minutes, on the quote that is actually being bet.
- 15 minutes covers one capture cluster whose clocks differ by a few minutes, and it covers the 1–5 minute soft follow window without treating the two prices as different information sets.
- It cuts the 1–3 hour tail the diagnostic found. Nothing in that tape sits between 15 and 60 minutes, so 15 and 20 keep the same bets there. 15 is the tighter research-backed bound (five-minute rescan cycles, a few minutes of follow lag, a hard reject of hour-old references).
- A pair older than 15 minutes is unused. There is no "latest Pinnacle in the last 3 hours" fallback.
- Closing snapshots are not a fair for a bet placed earlier. They are the CLV grade after the fact.

## 4. EV formula

OddsJam, vigged, and EVstrike all publish the same stake EV. With p the fair win probability (conditional on no push) and d the decimal of the price being bet:

EV = p · d − 1.

Equivalently, with profit b = d − 1 and q_lose = 1 − p when there is no push:

EV = p · b − (1 − p).

Push-aware, q = P(push), p = P(win | no push):

EV = (1 − q) · (p · d − 1).

The decimal is the DraftKings or Hard Rock price, whichever the execution rule selects. It is never the Pinnacle decimal. A positive EV means that soft price pays more than the Pinnacle fair. A model probability does not enter.

Worked non-push check. Fair 52.4% (a −110 no-vig flipped to the other side's dog at a better price), soft +100, d = 2.00:

EV = 0.524 · 2 − 1 = +4.8%.

Worked push check. NFL −3, p_cond = 0.50, q = 0.09, soft −110, d = 1.9091:

EV = 0.91 · (0.50 · 1.9091 − 1) = −4.14%.

The push scaled a negative EV toward zero. It does not turn a bad conditional price into a good one. Ignoring q on an integer would overstate the magnitude, which on a true plus-EV integer overstates the edge and can clear the 2% floor by mistake.

## 5. Kelly and fractional Kelly

Full Kelly fraction of bankroll, b = d − 1:

f* = (b · p − (1 − p)) / b = EV / b.

When EV ≤ 0, f* = 0. Quarter-Kelly and half-Kelly are f* multiplied by 0.25 or 0.50. OddsJam's positive-EV notes recommend a multiplier in the 0.25–0.50 range. Full Kelly's log-wealth growth is real and its drawdowns are larger than a daily card should take; the multiplier is the hedge against an overstated p. Because the old p was a blended model, Kelly on that p would have sized the phantom up, not down.

The published card does not stake with Kelly. `SELECTION_RULES.md`: floor straights 1u, leans 0.5u, parlay 0.25u, ranked by stake EV. A 4% EV at −110 has f* ≈ 4.4% of bankroll and quarter-Kelly ≈ 1.1%. Flat 1u is the same order of size only if 1u is about 1% of bankroll. The unit schedule stays as specified. Kelly is the sizing theory, not a second stake path on the card.

## 6. Outlier and stale caps

Large displayed EV is where stale lines, wrong-game matches, and model error concentrate. The v12.3.74 buckets are the empirical version of that sentence: ROI got worse as EV rose.

Screeners operationalize it as follows.

- Vigged flags a price more than 10% above the no-vig ("Verify") and drops stale or suspended quotes before the edge is computed.
- OddsJam's tool notes tell the user to check an outlier against the other books on that market, and to trust a tight market more than a wide one. Their practical Kelly multiplier assumes the fair is not a one-book glitch.
- The WeBet gate already rejects EV above 12% as `ev-stale` and rejects American odds outside about −250..+250. Both stay. 12% is above vigged's 10% verify line, so it is a hard drop rather than a review queue. The odds band also keeps the card out of the region where multiplicative and power diverge by more than about a point (the +210 row is inside the band; −300 / +240 is outside it).
- A second cap belongs on the anchor, not only on the EV. Reject the pair when the Pinnacle two-way overround is above 6% or below −1%. Pinnacle mains usually hold about 2–4%, and a 6%+ pair is a bad match or a pulled market, not a sharp fair. A mild underround is real on Pinnacle and power handles it (k < 1). An overround past 6% does not get "fixed" by de-vigging.
- OddsJam's outlier check, applied here without a third book in the fair: the fair is Pinnacle only. DraftKings and Hard Rock are both payouts. If they disagree, the execution rule still takes the better price on the DraftKings line. The fair does not average them in. A price that clears 12% EV against a fresh, same-line Pinnacle is dropped as stale or erroneous even if the timestamps are inside 15 minutes. That is the cap, not a signal to bet bigger.
- Do not stack a favorite-longshot haircut, a model blend, or a hand shrink on top of the power fair (Štrumbelj via 45analytics; the Brewers arithmetic).

## 7. How OddsJam, Unabated, and Pinnacle-style screeners build parlays

They do not have one shared parlay product. The construction that shows up across their writing is the same three steps.

1. Each leg is already a plus-EV single against a sharp no-vig, on the same point the leg bets. OddsJam's "sharp bets for your parlay" note starts from the Positive EV page and ranks legs by profit margin. Unabated prices the leg off the Unabated Line, their no-vig blend of market-makers, and will not treat a different number as the same market. A Pinnacle-anchored screen (EVstrike, SharpLine, PickFinder, the Buchdahl-style comparison) uses one sharp book's de-vigged two-way as p_leg.
2. The joint fair under independence is the product of the leg fairs. actualodds.com states that directly, and applies a separate correlation factor to same-game parlays. Cross-game legs stay at the product. Same-game legs do not.
3. The parlay is a bet only when the book's parlay decimal clears that joint probability: EV = (Π p_i) · d_parlay − 1. Leg-level plus EV is not enough. Parlay juice compounds, so three slightly plus-EV −110s can still be a minus-EV parlay at the parlay price. Pinnacle's own parlay pricing multiplies decimals and then holds a margin; copying the soft parlay price without the product test bets the compounded hold.

Correlation. Same-game parlays need an explicit factor (actualodds.com). Cross-game same-direction totals share weather and pace, so the true P(all win) sits above the independent product. A factor below 1 on that product understates the joint and makes the parlay EV conservative. v12.3.74 multiplies three same-direction totals by 0.92 (`config.js`). That factor stays. It is not re-fit here.

What the screeners do not do, and what this card will not do:

- They do not build the parlay probability from a team model that has already been blended with the sharp.
- They do not require the legs to be the highest-EV bets in the app regardless of sign. OddsJam's walkthrough is "bet the circled plus-EV leg, then add more." A non-positive leg lowers the joint.
- Unabated will blend several market-makers into one fair (the Unabated Line). OddsJam's custom EV formula can weight Pinnacle with Circa and Bookmaker and require a fraction of them to agree. That is a different estimator. This card's instruction is one anchor: same-time Pinnacle, two-way, same line. Circa is not in the pipeline.

The WeBet ticket shape stays: up to three straights, one three-leg parlay at 0.25u, fill tier when the floor pool is short of three. The research constraint on that shape is that every leg's p is the Pinnacle power fair, the joint is the product (with the 0.92 same-direction-total factor), and a ticket whose combined EV is not positive is the one the current card already labels `combined EV not positive`. Hitting 20% on three legs needs leg win probabilities around 58% if the legs are independent (0.58³ ≈ 0.195), or a correlation benefit. Three 45% legs are a 9% parlay before correlation. The 10.4% parlay hit rate on the v12.3.74 card is what that math predicts when the legs are coin flips the model called 4–12% EV.

## 8. What follows from this

The exact pricing error is the probability, not the EV arithmetic and not, on the Brewers row, the snapshot age. v12.3.74 computes EV from a model that has been blended with Pinnacle and then shrunk toward Pinnacle by a hand-set K. The Pinnacle fair at the bet price was negative. The gate bet it anyway. Larger disagreements produced larger displayed EV and worse ROI.

The replacement, specified in `docs/sharp-math-spec-1014.md` and implemented behind a flag:

- Fair = power de-vig of the Pinnacle two-way on the identical line and side, timestamps within 15 minutes of the DraftKings or Hard Rock price.
- No model blend and no hand calibration in that probability.
- EV = (1 − q) · (p_fair · d_soft − 1), with q from the NFL 3/7 push table when the line is that integer, else 0.
- A point mismatch rejects, except the NFL half-point identity across 3 or 7.
- The 2% floor, 12% cap, −250..+250 band, EV rank, three straights, fill tier, and 1u / 0.5u / 0.25u stakes stay.

## Sources

De-vig studies and method notes:

- https://www.sciencepublishinggroup.com/article/10.11648/j.ajss.20170506.12 — Clarke, Kovalchik, Ingram (2017), *Adjusting Bookmaker's Odds to Allow for Overround*. Power beats multiplicative and matches or beats Shin. Shin = additive for two competitors. PDF mirror: https://pdfs.semanticscholar.org/713d/3cb2e10dec3183ea5feced45bb11097fe702.pdf
- https://www.vigged.com/learn/positive-ev-betting and the vigged de-vig study summarized at https://www.reddit.com/r/algobetting/s/ZpNcbfucEv (725k results: power on sharp two-way and soccer 1X2; multiplicative on US retail moneylines; methods agree near even money). Method choice also at https://vigged.com/learn/line-shopping (worst of three methods; stale prices dropped).
- https://upside.tools/research/most-accurate-devig-method — 64,670 two-way markets. Multiplicative understates heavy favorites by 1.71–2.71 points. Additive, odds-ratio, and probit indistinguishable. Shin = additive on two-way.
- https://www.45analytics.com/vault/market-layer — Štrumbelj (2014): power dominates proportional; do not stack a second favorite-longshot adjustment.
- https://cran.r-universe.dev/implied/doc/introduction.html — formulas for multiplicative, additive, power, Shin, and the two-outcome Shin identity.
- https://help.outlier.bet/en/articles/8208129-how-to-devig-odds-comparing-the-methods — multiplicative, additive, Shin, power, probit, worst-case definitions.
- https://impliedscore.com/bookmaker-margin-removal-methods/ — side-by-side on one market, including probit/odds-ratio.

EV, Kelly, outliers, freshness:

- https://oddsjam.com/betting-calculators/expected-value — EV = p_fair · profit − (1 − p_fair) · stake, fair from the sharpest book (Pinnacle) with the vig removed.
- https://oddsjam.com/betting-education/uncovering-true-outcome-probabilities — method survey; Shin = additive on two-way markets.
- https://oddsjam.com/betting-education/positive-ev-tool-tips-tricks-hacks — Kelly multiplier 0.25–0.5; tighter markets carry more confidence.
- https://oddsjam.com/betting-education/how-to-use-the-oddsjam-positive-ev-tool — outlier check against the other books.
- https://vigged.com/learn/positive-ev-betting — EV% = no-vig probability × decimal − 1; lines must match; stale prices out; verify above 10%.
- https://pinnwire.com/why-positive-ev-bets-disappear.html — timestamp both sides; a stale Pinnacle fair manufactures +EV.
- https://fairoddsterminal.com/dropping-odds-strategy-guide — soft books copy Pinnacle on a delay of about 1–5 minutes.
- https://pinnapi.com/blog/how-fast-do-books-follow-pinnacle — follow lag defined as the soft reprice minus the Pinnacle move.
- https://networked.substack.com/p/a-view-from-the-pinnacle — same-time Pinnacle versus soft pre-closing odds, Buchdahl sample.
- https://evstrike.com/ — Pinnacle two-sided multiplicative no-vig, EV% = p · decimal − 1, poll cadence.
- https://getsharpline.com/ — Pinnacle no-vig as the fair, rescan cycle, CLV against the close.
- https://actualodds.com — worst-case de-vig; parlay fair = product of leg fairs; same-game correlation factor.

Alternate lines, key numbers, push:

- https://unabated.com/tools/calculators/alt-lines-calculator — alt prices from a vig-free line; half-point value depends on the origin.
- https://unabated.com/betting-calculators/alternate-line-derivatives — same construction for derivatives.
- https://unabated.com/post/betting-value-nfl-conference-championship — NFL spread keys 3, 6, 7; totals keys weaker.
- https://gridironandwine.com/tools/cover-probability-calculator.html — EV = P(win)·(d − 1) − P(lose); keyed normal (football), normal (basketball), negative binomial (MLB), Poisson (NHL); center the distribution on the de-vigged main line.
- https://gridironandwine.com/blog/nfl-key-numbers-half-point-betting.html — margin shares for 3, 7, 6, 10.
- https://bettoredge.com/alternate-lines-calculator — fair-price table per half point; NFL −3 push 7.3%, −7 push 4.7%.
- https://nflanalytic.com/betting-key-numbers.html — nflverse 1999–2025 counts, and push rates conditioned on the closing spread (3 → 9.0%, 7 → 6.5%).
- https://parlaytools.com/articles/nfl-spread-betting-strategy/ — the same close-conditioned push table.
- https://unabated.com/post/finding-positive-ev-wagers-step-by-step-guide — market-maker screen; the line and the price are one package.

Parlays:

- https://oddsjam.com/betting-education/how-to-find-sharp-bets-for-your-parlay — parlay legs taken from the positive-EV board, ranked by margin.
- https://actualodds.com — independent product, same-game correlation factor.

Internal:

- `docs/MATH-DIAG-1014.md` on `origin/research/math-diag-1014` (fetched for this note).
- `netlify/functions/lib/omega-vnext/SELECTION_RULES.md` — 10:00 ET board, 2% / 12%, −250..+250, EV rank, 1u / 0.5u / 0.25u.
- `/workspace/sm/sources.md` — URL list this note started from.
