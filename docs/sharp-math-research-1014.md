# Sharp math research — 2026-10-14

Brief notes for the v12.3.74 pricing fix. Sources are listed once at the bottom and cited inline as [S#]. Live card context is in `docs/MATH-DIAG-1014.md` on `research/math-diag-1014` (re-fetched each step).

## De-vig methods

Two-way raw implieds `q1`, `q2` from American prices. Overround `v = q1 + q2 − 1`. Fair probabilities must sum to 1.

| Method | Formula | What the studies say |
| --- | --- | --- |
| Multiplicative | `p_i = q_i / (q1+q2)` | Best of the simple splits on **retail US moneylines**. Worst in the tails: understates heavy favorites by 1.71–2.71 pp and **overstates longshots**, which prints phantom +EV on dogs [S1][S2]. |
| Additive | `p_i = q_i − v/2` | On 64,670 two-way markets, additive, odds-ratio, and probit are indistinguishable. Shin equals additive when there are two outcomes [S2][S3][S6]. |
| Power | Find `k ≥ 1` with `q1^k + q2^k = 1`, then `p_i = q_i^k` | Best on **Pinnacle** moneylines (typical `k` near 2 in the vigged sample) and on soccer 1X2. Beats multiplicative everywhere and matches or beats Shin [S1][S3][S4]. Near even money it collapses to the same number as the others. |
| Shin | Insider-share `z` solved so the Shin prices sum to 1 | Equals additive on two-way markets. Worth it on 3-way soccer, not on NFL/NBA/MLB/NHL sides [S2][S3][S6]. |
| Probit | Shift `Φ^{-1}(q_i)` by one margin so the mapped probs sum to 1 | Same answer as additive on two-way prices [S2]. |
| Worst-case | `p = min(p_mult, p_add, p_power, p_shin)` on the side you bet | Conservative screen used by some +EV tools. It is not a more accurate probability. Stacking it on top of power double-counts the favorite-longshot bias [S9][S4]. |

## Best method per market

Use **power on every Pinnacle two-way**, including spreads and totals.

- Moneylines are often lopsided. Power is the method that does not hand the longshot extra probability [S1][S2]. The live card's average price is +112 to +143, so a multiplicative fair is the method that manufactures dog EV.
- Spreads and totals are usually within a few cents of −110/−110. Power, multiplicative, additive, Shin, and probit agree there [S1]. One function is enough.
- Do not de-vig DraftKings or Hard Rock and call it fair. Do not average them in when Pinnacle has no pair [S5][S14].
- Do not take the worst-case min as the price. Power is the estimate. A 12% EV cap already drops the stale outliers [S9].

The code already has `powerFair` and only calls it past −250 / +210 (`odds_math.js`). Inside that band a +170/−200 pair still gets the multiplicative longshot bias. The new path runs power whenever `q1+q2 > 1`.

## Spreads and totals at a different point

Fair is defined at **one point**. A soft price at 3.5 is not a bet against a Pinnacle fair at 3.

1. Prefer the exact point and side, both books, same snapshot.
2. If the points differ, convert with a distribution centered on the de-vigged main (or the sharp point), then read `P(win)` and `P(push)` at the soft point [S10][S13].
   - NFL/NCAAF spreads: normal with extra mass on keys 3, 6, 7 (and 10, 14). Conditional push at NFL −3 is about 7–9%; at −7 about 4.7–6.5% [S11][S12]. Half-point value depends on which key you are leaving [S10].
   - NFL totals: jagged integer bins, not a flat normal. NCAAF totals and NBA sides/totals: normal. MLB run lines / totals: negative binomial. NHL totals: Poisson [S13].
   - This repo already has that football mass in `key_mass.js`. Use it for NFL/NCAAF. For NBA, NHL, and MLB, convert only when the point gap is at most 1.0 and the distribution is the sport normal / Poisson already in config. Larger gaps, or no distribution, **reject**.
3. Integer lines push. The two-way de-vig is `P(win | no push)`. Stake EV with a known push rate is `(1 − P(push)) × (p_cond × decimal − 1)`, which is `P(win)×(decimal−1) − P(lose)` [S13]. A moneyline has no push, so it is just `p × decimal − 1`.

## Freshness (sharp / soft pair)

The edge is a soft price versus a **same-time** Pinnacle no-vig on the **same line** [S14][S15]. It is not a model number, and it is not this morning's Pinnacle against this afternoon's DraftKings.

- DraftKings follows Pinnacle in about 5–30 minutes on major markets, longer on thin ones [S14]. Fast followers reprice in about 8 minutes; regional books (Hard Rock) in 25–90 [S15].
- The Odds API Pinnacle feed is a public-site scrape and can lag. Age is the market `last_update`, not our capture time [S16][S17].
- Historical snapshots sit on a 5-minute grid [S16]. A same-request DK/HR/Pinnacle pull is same-time even when `last_update` is a few minutes apart.

**N = 20 minutes.** A Pinnacle two-way older than 20 minutes relative to the DraftKings or Hard Rock price is not a pair. A quote more than 2 minutes after the bet is not a pair either. Missing timestamps on one stored board count as the same snapshot. The reason for 20, and the pricing error it does not fix, is at the end of this note.

## EV

`EV = p_fair × decimal(DK or HR) − 1` [S5].

`decimal = 1 + american/100` when american > 0, else `1 + 100/|american|`.

`p_fair` is the power no-vig of the paired Pinnacle two-way, push-adjusted when the line is an integer and a push rate is known. Rank by this EV. The probability gap `coverProb − p_fair` is not the stake EV and is not a gate.

## Kelly

Full Kelly `f* = EV / (decimal − 1) = (b·p − q) / b` with `b = decimal − 1`. OddsJam's own +EV guide uses a 0.25–0.5 multiplier because full Kelly assumes the fair is exact [S7]. The card does **not** stake with Kelly. WeBet sizes stay: main 1u, lean 0.5u, 3-leg parlay 0.25u.

## Outlier and stale caps

- EV above about 12% versus a tight Pinnacle pair is a bad line, a point mismatch, or a stale quote, not a gift [S8]. Keep the 12% cap (`ev-stale`). Keep the 2% floor and the −250..+250 odds band.
- Drop the candidate when Pinnacle's hold on the pair is extreme (thin market) or when `last_update` fails the freshness window [S7][S18].
- Do not stack a second favorite-longshot haircut, a model blend, and a hand-set shrink on a Pinnacle fair. Those adjustments double-count [S4].

## How the screeners build parlays

- OddsJam's +EV tool prices **singles** against the sharpest book's no-vig (Pinnacle when it is posted). The user parlays the survivors. The tool tells you to throw out outliers that no other book is near, and to treat a wide market as low confidence [S5][S7][S8].
- Unabated does not invent a parlay probability. It converts a vig-free main line into an alt with a sport distribution, then the bettor multiplies legs [S10].
- Pinnacle-anchored screeners (Pinnacle Odds Dropper, pinnodds) rank the soft book's price against the de-vigged Pinnacle close-in-time number. They do not blend a team model into that probability [S18][S19].
- A same-game or same-direction parlay is not the product of the leg fairs. Independent fair is `Π p_i`. Same-game legs need a correlation factor; same-direction totals need a haircut [S9]. This card already multiplies three same-direction totals by 0.92.
- Hit rate is `Π p_win` under independence. Three −110 legs at a true 2% EV are about `0.53³ ≈ 15%`. Three coin-flip fills are about `0.45³ ≈ 9%`, which is the 10.4% parlay hit on the v12.3.74 card. A 20% hit needs legs whose no-vig win probabilities multiply to 0.20 (about 58% each if equal), which means shorter prices or a real edge, not a filled longshot ticket.

## Sources

1. https://vigged.com/learn/de-vig-methods — power on Pinnacle ML and soccer 1X2; multiplicative on retail US ML; all methods agree near even; multiplicative worst in the tails.
2. https://upside.tools/research/most-accurate-devig-method — 64,670 two-way markets; multiplicative longshot bias 1.71–2.71 pp; additive ≈ odds-ratio ≈ probit; Shin ≈ additive on two outcomes.
3. https://sciencepg.com/article/10.11648/j.ajss.20170506.12 — Clarke, 2017. Power beats multiplicative and matches or beats Shin. Shin = additive for two competitors.
4. https://45analytics.com/vault/market-layer — Štrumbelj, 2014. Power dominates proportional. Do not stack favorite-longshot adjustments.
5. https://oddsjam.com/betting-calculators/expected-value — `EV = p_fair × profit − (1−p_fair) × stake`, fair from the sharpest book with the vig removed.
6. https://oddsjam.com/betting-education/uncovering-true-outcome-probabilities — method list; Shin = additive on two-way markets.
7. https://oddsjam.com/betting-education/positive-ev-tool-tips-tricks-hacks — quarter to half Kelly; tight markets are the confident ones.
8. https://oddsjam.com/betting-education/how-to-use-the-oddsjam-positive-ev-tool — outlier check against the rest of the board.
9. https://actualodds.com — worst-case de-vig is the min across methods; parlay fair is the product of leg fairs; same-game parlays need a correlation factor.
10. https://unabated.com/tools/calculators/alt-lines-calculator and https://unabated.com/betting-calculators/alternate-line-derivatives — alt line from the vig-free main and a sport distribution; half-point value depends on the origin.
11. https://unabated.com/post/betting-value-nfl-conference-championship — NFL spread keys 3, 6, 7; totals keys are weaker and odd totals matter more.
12. https://bettoredge.com/alternate-lines-calculator — NFL −3 push about 7.3%, −7 about 4.7%.
13. https://gridironandwine.com/tools/cover-probability-calculator.html — `EV = P(win)×(d−1) − P(lose)`. Football keyed-normal, basketball normal, MLB negative binomial, NHL Poisson. Center the distribution on the de-vigged main, then read the alt.
14. https://parcae.io/learn/sharp-vs-retail-books — DK lags Pinnacle by about 5–30 minutes, and by hours on low-attention markets.
15. https://sportsbookish.com/research/how-sportsbooks-reprice-without-news — fast followers about 8 minutes; regional books 25–90 minutes.
16. https://the-odds-api.com/liveapi/guides/v4/ — `bookmakers` overrides `regions`; market `last_update`; historical snapshot is the grid point at or before `date` (5 minutes).
17. https://the-odds-api.com/sports-odds-data/bookmaker-apis.html — Pinnacle odds are scraped from the public site and can be delayed. `hardrockbet` is the Indiana feed.
18. https://www.pinnacleoddsdropper.com/guides/market-limits-and-vigs-what-are-they-and-why-are-they-important — limits and vig; low-limit openers are noisy.
19. https://pinnodds.com/blog/why-use-pinnacle-odds-as-fair-value — de-vigged Pinnacle is the fair used to grade a soft price.
20. https://football-data.co.uk/blog/pinnacle_limit.php — EV measured more than about 24 hours out mostly dies by the close. A higher EV floor is the early-bet tax.
21. https://pinnwire.com/closing-line-value-pinnacle-odds-guide.html — `CLV = decimal_bet × p_close_novig − 1` on the same outcome and line.

## The error, and the 20-minute rule

Re-fetched `origin/research/math-diag-1014` at `8688c9c` (`docs/MATH-DIAG-1014.md`).

The published probability is not the Pinnacle fair. `blendWithMarket` then mode-A shrink still leaves the model above the sharp, and that gap is the EV the 2% floor accepts.

Brewers moneyline, 2026-09-22, DraftKings +118, Pinnacle +121/−131, lag 0 (same cluster):

- Proportional fair 0.4438. Power fair 0.4422 (k ≈ 1.03). Shin 0.4416. The three disagree by 0.2 pp.
- After the 50% MLB blend and K = 0.30: cover 0.4778, which is 3.4 pp above the sharp.
- EV at +118 from the model: **+4.17%**. Posted as a 1u floor. Lost. CLV −1.68 pp.
- EV at +118 from the Pinnacle fair: **−3.3%** (proportional) / **−3.6%** (power). DraftKings implied 0.4587 was already worse than the no-vig.

On 94 graded v12.3.74 pool bets, the vigged price averages 1.31 pp worse than `fairSharp`. **86 of 94 are negative EV** if `p` is the bet-time Pinnacle no-vig. Only 8 are actually soft versus Pinnacle. The 76 bets more than 0.5 pp worse than the fair are 28-48, −19.2% ROI. Pool ROI falls as displayed EV rises: 2–4% −2.9% (n=63), 4–6% −28.7% (n=20), 6–12% −36.3% (n=13). Model log-loss on those 94 is 0.668 versus 0.658 for the bet-time Pinnacle no-vig. The blend is not helping.

De-vig choice and snapshot age are not this leak. Power versus proportional log-loss on 1,831 closing moneylines differs by 0.0005, and the interval covers zero. Of 254 card straights, 241 have a Pinnacle quote within 2 minutes, 12 sit between 2 and 20, none sit between 20 and 60, and 1 is older than 60. The 3-hour cap is what let that one in. It is not why the card is −12%.

**Freshness stays 20 minutes** anyway. That is the gap in the lag histogram and the width of one capture cluster (`CLUSTER_MS` in the v74 backtest). It drops the 1–3 hour tail (18 kept markets, 1 actual card bet) and keeps same-time pairs. It is not a ROI-tuned knob. Fair is still the power no-vig, because that is the sharp-book method and it matches the others near −110, where this card lives. The change that moves the card is deleting the model: `p` is that Pinnacle fair or the bet is rejected.
