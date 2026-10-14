# Sharp math spec — 2026-10-14 (WeBet approval)

One page. Research: `docs/sharp-math-research-1014.md`. Evidence: `docs/MATH-DIAG-1014.md` on `origin/research/math-diag-1014` at `2f182c4`, re-fetched before this draft. Card rules that already shipped stay. This page changes only where the probability comes from.

## The exact error

v12.3.74 bets a model probability that has been pulled toward Pinnacle and still sits above it. It does not bet a soft price that beats the Pinnacle fair.

Brewers moneyline, 2026-09-22, DraftKings +118, Pinnacle lag 0 (`docs/MATH-DIAG-1014.md`):

- Pinnacle +121 / −131. Proportional fair 0.4438. Power fair 0.4422.
- Model after the 50% MLB blend and the hand shrink K = 0.30: 0.4778.
- EV from that model at +118: **+4.17%**. The gate posted it (floor, 1u). It lost. CLV −1.68 pp.
- EV from the Pinnacle fair at the same +118: **−3.3%** (proportional) / **−3.6%** (power).

DraftKings implied (0.4587) was already worse than the no-vig. The entire plus EV was the leftover model weight: `(1 − 0.30) × 0.50 = 0.35` on the CDF. Pool of every gate pass, 1u: EV 2–4% ROI −2.9% (n=63), 4–6% −28.7% (n=20), 6–12% −36.3% (n=13). Higher displayed EV is a larger disagreement with the sharp, so it loses more. Card CLV −1.39 pp. De-vig choice and snapshot age are not this row: methods agree within 0.16 pp, and the Pinnacle quote is the same cluster as DraftKings.

## Formulas (flag `OMEGA_SHARP_FAIR`, default off until approval)

Module `sharp_fair.js`. On: fair comes only from this module. Model blend and mode-A shrink do not enter `p` or EV. Off: v12.3.74 path, unchanged.

**Pair.** Pinnacle two-way, both sides, same market, same point, same side as the DraftKings or Hard Rock bet. `|t_pinnacle − t_soft| ≤ 15` minutes. Else reject (`stale-sharp` or `no-two-way`). No 3-hour fallback. Close is for grading only.

**Power fair.** π_i = 1/decimal_i. Find k > 0 with π_1^k + π_2^k = 1. p_i = π_i^k. Overround uses k > 1. Underround uses k < 1. This is the sharp-book winner (Clarke, Kovalchik, Ingram 2017; vigged 77.5k sharp two-ways). At −110/−110 it equals multiplicative, additive, Shin, and probit. Shin is not coded: on two outcomes it is the additive number.

**Push.** p is P(win | no push). q = 0 except an NFL spread on 3 (q = 0.090) or 7 (q = 0.065), the close-conditioned nflverse rates. Half points do not push.

**EV** at the executed DraftKings or Hard Rock decimal d (Pinnacle is never the bet):

EV = (1 − q) · (p · d − 1).

**Point mismatch.** Exact point: use p. NFL spread differing by exactly 0.5 across 3 or 7: move the push mass with that q (bought hook: P(win) = p(1−q)+q; laid hook: P(win) = p(1−q); integer bet against a half-point sharp: conditional p becomes the half-point probability / (1−q), and q applies). Every other mismatch rejects (`point-mismatch`), including totals and other sports.

**Anchor sanity.** Reject if the Pinnacle overround is > 6% or < −1% (`wide-sharp`).

## Gates and stakes (unchanged)

| Rule | Value |
| --- | --- |
| Floor | EV ≥ 2% and ≤ 12%. Above 12% is `ev-stale`, not a lean |
| Odds | about −250 .. +250 |
| Rank | stake EV, one side per game |
| Card | 3 straights; short floor fills from leans, then any pregame lean |
| Stakes | floor 1u, lean 0.5u, 3-leg parlay 0.25u |
| Parlay | product of leg fairs; three same-direction totals × 0.92; non-positive joint still labeled `combined EV not positive` |

Kelly is not a stake. f* = EV / (d − 1), and a 0.25–0.50 multiplier is the research range. The card stays flat units.

## Expected KPI impact (before the backtest)

Direction, not a promised ROI. The backtest section below is filled after `docs/sharp-math-backtest-1014.md`.

- The Brewers class of bet leaves. Those were minus EV against Pinnacle and they were the high-EV tail. The inverted bucket curve (worse ROI at higher EV) should stop, because EV is now the soft price versus the sharp rather than model disagreement.
- Straight ROI should move from the card's −9.7% toward the same-time Pinnacle-versus-soft band in the Buchdahl sample (about +3% to +4% realized when the soft price beats the contemporaneous no-vig). Conditioning on EV ≥ 2% raises the theoretical mean and cuts the count. A short card is the expected operating state.
- CLV versus the Pinnacle close should move from −1.4 pp toward zero or better. Beating the 10:00 sharp does not guarantee beating the close if the line keeps moving after the snapshot.
- Parlay hit rate should not be planned at 20% while the card's average price is +112 to +143. A 4% EV at +130 wins about 45% of the time; 0.45³ ≈ 9%. A 20% three-leg needs leg win rates near 58%, which at plus-money prices is an EV above the 12% cap. The 20% figure is reachable only if the new card's legs are favorites (a 4% EV at −150 wins about 62%, and 0.62³ ≈ 24%).

## Deploy

Do not deploy on this page. Implementation is behind `OMEGA_SHARP_FAIR` (default off) on `feat/sharp-math-1014` only. Approval to default the flag on waits on the held-out backtest.

## Backtest update

Pending step 4. Replace this paragraph with the held-out record, ROI and 95% CI, CLV, EV-bucket ROI, parlay hit rate, and a yes/no on defaulting the flag.
