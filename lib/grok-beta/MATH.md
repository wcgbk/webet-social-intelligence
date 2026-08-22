# Grok Beta Model — Pricing Math

Version: `grok-beta-0.1.0`. Independent day-one engine. No WeBet Alpha, v10, Betty, Elo, NB, Kelly, CLV, or historical-Alpha constants appear in these equations.

The engine is deterministic: a frozen odds snapshot plus raw ESPN/injury/starter payloads produce the same candidate list. LLMs may reject a pick or cut its stake and must write a reason; they must not invent `p_model`, `edge`, or `units`.

---

## 1. Odds and implied probability

American odds \(o\) map to a book-implied probability

\[
\pi(o) =
\begin{cases}
\dfrac{|o|}{|o|+100} & o < 0 \\[8pt]
\dfrac{100}{o+100} & o > 0
\end{cases}
\]

Decimal odds: \(d(o) = 1 + o/100\) if \(o>0\), else \(1 + 100/|o|\).

A **two-way market** is a pair of American prices \((o_A, o_B)\) on complementary sides (home/away, over/under, favorite/dog). If either side is missing, the market is **fail-closed** (no pick). Three-way soccer 1X2 is not two-way and is skipped.

---

## 2. De-vig → \(p_{\text{market}}\) (Shin, two-way)

Let \(\pi_A = \pi(o_A)\), \(\pi_B = \pi(o_B)\). Overround \(v = \pi_A + \pi_B - 1\).

- If \(v \le 0\): already fair. \(p_A = \pi_A / (\pi_A+\pi_B)\).
- If \(v > 0.28\): market is garbage. **Fail closed.**
- Else apply **Shin (1993)** insider-mixture de-vig. Define

\[
p_i(z) = \frac{\sqrt{z^2 + 4(1-z)\,\pi_i^2} - z}{2(1-z)}
\]

and find the unique \(z \in [0,1)\) by bisection such that \(p_A(z)+p_B(z)=1\). (The \(\sum\sqrt{\cdot}=2\) identity is algebraically equivalent but has a degenerate root at \(z=1\); we solve the probability-sum form.) Then \(p_i = p_i(z)\).

If Shin does not converge in 64 bisection steps, use **additive** de-vig (not proportional):

\[
p_i = \pi_i - \frac{v}{2},\qquad \text{then clip to }(0.02,0.98)\text{ and renormalize.}
\]

Book consensus for a side is the **median** American price across books, books sorted by key. Dispersion is the sample standard deviation of the implied probabilities (same sort, same snapshot → same median and \(\sigma\)).

\(p_{\text{market}}\) is the Shin (or additive) probability of the side we are pricing.

---

## 3. Sport families

Scoring is **not** one formula. Three families, parameterized in scoring units of that sport.

| Family | Sports | Process | League mean \(\mu\) (per team) | Home field \(h\) | Rest coef \(\rho\) (per extra rest day vs 1) | Injury unit |
|---|---|---|---|---|---|---|
| Runs | MLB | Independent Poisson | 4.45 runs | +0.14 runs to home | +0.05 runs | 0.07 / position OUT; 0.32 if listed pitcher |
| Points | NBA, WNBA, NCAAB, NFL, NCAAF | Independent normal | NBA 113.0 / WNBA 82.5 / NCAAB 73.0 / NFL 22.8 / NCAAF 27.4 | NBA +2.3 / WNBA +1.5 / NCAAB +3.1 / NFL +2.0 / NCAAF +2.6 pts | NBA 0.6 / WNBA 0.5 / NCAAB 0.8 / NFL 0.9 / NCAAF 1.0 pts | see §5 |
| Goals | NHL, MLS, EPL and other soccer | Independent Poisson | NHL 3.05 / soccer 1.38 | NHL +0.18 / soccer +0.16 goals | NHL 0.04 / soccer 0.03 | NHL 0.22 skater / 0.50 goalie; soccer 0.12 |
| Fight | UFC / MMA | Bernoulli (ML only) | 0.50 base | 0 | 0.01 per rest-day gap | fighter OUT → fail closed |

Points-family residual σ (not Alpha σ):

- NBA: \(\sigma_{\text{margin}}=12.0\), \(\sigma_{\text{total}}=14.5\)
- WNBA: 10.5 / 12.0
- NCAAB: 11.0 / 13.5
- NFL: 13.8 / 10.4
- NCAAF: 16.0 / 13.0

These are published-sport residual scales, not fitted on WeBet Alpha history.

---

## 4. Raw features → team scoring mean

Inputs (raw only): rest days, home/away, injury list, starter if present, book dispersion, optional Kalshi/Polymarket last price, and the **posted two-way lines themselves** (observables, not a fitted rating).

Rest is binary from ESPN: **1** if the team appears on yesterday's scoreboard, else **2** (neutral, no adjustment). We do not invent 3–7 day rest without a dated last game — that would systematically juice overs on NFL/NBA off-nights.

Day-one conservative prior: **anchor on the market total \(T\) and home spread \(S\)** (home handicap; \(S<0\) means home favored), then apply feature deltas only. Home field is already in \(S\); it is not added again.

\[
\lambda_H^{(0)} = \frac{T - S}{2},\qquad \lambda_A^{(0)} = \frac{T + S}{2}
\]

If only \(T\) is available, split \(T/2\) and add \(\pm h/2\). If neither line exists, fall back to the family league mean \(\mu\) plus home field \(h\) (table in §3).

\[
\lambda_{\text{home}} = \max\!\bigl(\mu_{\min},\; \lambda_H^{(0)} + \rho(\text{rest}_H-2) - I_H + I_A + S_H - S_A\bigr)
\]
\[
\lambda_{\text{away}} = \max\!\bigl(\mu_{\min},\; \lambda_A^{(0)} + \rho(\text{rest}_A-2) - I_A + I_H + S_A - S_H\bigr)
\]

\(\mu_{\min} = 0.35\) (goals/runs) or \(8\) (points). \(I\) is injury impact in scoring units. \(S\) is starter adjustment (MLB only; 0 if starter present but no quality stat; **fail closed** if the market is pitcher-sensitive and no starter is listed). Feature overlay (not a second rating): compute \(p^{\text{feat}}\) with features and \(p^{\text{neutral}}\) with rest=2 / no injuries on the same market-anchored means. Then

\[
p_{\text{raw}} = p_{\text{market}} + \bigl(p^{\text{feat}} - p^{\text{neutral}}\bigr)
\]

so a quiet slate (no rest/injury/starter signal) has edge 0. After dispersion shrink, clip \(|p_{\text{model}}-p_{\text{market}}| \le 0.10\) so a day-one engine cannot claim a 30-point edge.

Pitcher-sensitive markets: MLB moneyline, run line, F5. A probable pitcher name from ESPN is sufficient confirmation. Quality \(S\) is 0 unless ESPN supplies an ERA-like number; we do **not** invent FIP or K/9.

---

## 5. Injury impact

Count ESPN items with status matching `/out|doubtful|injured reserve|ir/i`. Questionable counts at 0.4×.

Points family, per OUT player:

- detail mentions starter / starting / probable starter: 2.6 pts (NBA/WNBA), 2.2 (NCAAB), 1.8 (NFL/NCAAF)
- otherwise: 1.0 / 0.9 / 0.7

Capped at 9 pts per team so a long injury list cannot dominate.

---

## 6. Family likelihoods → \(p_{\text{model}}^{\text{raw}}\)

### 6.1 Poisson families (runs, goals)

Independent Poisson scoring. Sum of two independent Poissons is Poisson(\(\lambda_H+\lambda_A\)).

- **Moneyline (no-tie sports, MLB):** \(p = P(X_H > X_A)\) via double sum of Poisson PMFs. Extra innings: ties after 9 are broken by \(\lambda_H/(\lambda_H+\lambda_A)\) share of \(P(X_H=X_A)\).
- **NHL moneyline (with OT):** same tie-break using \(\lambda\) share.
- **Soccer two-way** (if a two-way market exists, e.g. draw-no-bet / spread): use the corresponding Poisson/Skellam probability. Three-way 1X2 is skipped.
- **Total over line \(L\):** if \(L\) is integer, push mass \(P(X_H+X_A=L)\) is removed and the over probability is renormalized. If \(L\) is half-point, \(p = 1 - F_{\text{Poi}}(\lfloor L \rfloor; \lambda_H+\lambda_A)\).
- **Spread / run line / puck line \(k\)** (home getting \(k\), \(k\) may be negative): \(p = P(X_H + k > X_A)\), push removed on integer \(k\).

Poisson PMF is computed in log-space. Support is truncated at \(\lceil 4\max(\lambda,8)+24 \rceil\).

### 6.2 Points family (normal)

\[
m = \lambda_H - \lambda_A,\qquad t = \lambda_H + \lambda_A
\]

Standard normal CDF \(\Phi\) via Abramowitz–Stegun rational approximation (distinct coefficients from any Alpha copy).

- Home spread receiving \(k\) points: \(p = \Phi\bigl((m+k)/\sigma_{\text{margin}}\bigr)\) with a half-point continuity of \(0\) (no integer key-number bump table).
- Over \(L\): \(p = 1 - \Phi\bigl((L-t)/\sigma_{\text{total}}\bigr)\).
- Moneyline: \(p = \Phi(m / \sigma_{\text{margin}})\).

### 6.3 MMA

\(p_{\text{raw}} = 0.50 + 0.03\cdot\mathbf{1}_{\text{fighter not out}} \cdot \mathrm{sign}(\text{rest gap})\). If either fighter is OUT, fail closed. If no injury/rest signal, \(p_{\text{raw}}=0.50\) and the edge will not clear the floor.

---

## 7. Shrink to market by book dispersion

Let \(\mathrm{cv} = \sigma_{\pi} / \bar{\pi}\) across books on this market.

\[
w = \frac{1}{1 + 10\,\mathrm{cv}^{2}} \in (0,1]
\]

High disagreement → shrink toward the de-vigged market (we do not pretend to know more than the books when they disagree).

\[
p_{\text{feat}} = w\, p_{\text{raw}} + (1-w)\, p_{\text{market}}
\]

Optional prediction-market blend, only if a Kalshi or Polymarket contract matches both team tokens and has a last price in \((0.05,0.95)\):

\[
p_{\text{model}} = 0.88\, p_{\text{feat}} + 0.12\, p_{\text{pm}}
\]

otherwise \(p_{\text{model}} = p_{\text{feat}}\). Clip to \((0.05, 0.95)\).

---

## 8. Edge, EV, emission rule

\[
\text{edge} = p_{\text{model}} - p_{\text{market}}
\]
\[
\text{EV} = p_{\text{model}} \cdot d(o_{\text{best}}) - 1
\]

where \(o_{\text{best}}\) is the best available American price for the side among US retail books (max decimal). If no US retail book, use the consensus median.

Emit a candidate iff **all** of:

1. Two-way odds present and de-vig succeeded.
2. `commence_time` is strictly after now (skip live/final).
3. ESPN status is not postponed / canceled / final / in-progress.
4. Pitcher-sensitive market has a named starter.
5. \(\text{edge} \ge 0.048\) (4.8 percentage points).
6. \(\text{EV} \ge 0.055\) (5.5%).
7. Consensus American odds on the taken side are in \([-200, +240]\).

Zero published picks is a valid success.

---

## 9. Stake (not Kelly)

Volatility-scaled linear stake, conservative, hard-capped.

\[
u_{\text{raw}} = 7 \cdot \text{edge} \cdot \sqrt{p_{\text{model}}(1-p_{\text{model}})}
\]

Round to the nearest \(0.25\). Clamp per pick to \([0.25, 1.25]\). Then if \(\sum u > 5.0\), scale every pick by \(5 / \sum u\) and re-round to \(0.25\), dropping any pick that rounds to 0.

Letter label is a display function of units only (not a second model):

- \(\ge 1.00u\) → A
- \(\ge 0.75u\) → A-
- \(\ge 0.50u\) → B+
- else → B

Max **7** published picks, sorted by edge descending, then matchup, then market (stable).

---

## 10. Fail-closed gates

No pick is emitted when:

- two-way odds missing on that market
- game started or final (`commence_time <= now` or ESPN state ≠ `pre`)
- postponed / canceled / delayed
- MLB pitcher-sensitive market with no probable pitcher name
- Shin overround \(> 0.28\)
- UFC fighter listed OUT

---

## 11. LLM validation gate

Agents (Grok, Claude, GPT) receive the frozen candidate table. Allowed actions: `keep`, `cut_units` (new units must be \(\le\) current and on the \(0.25\) grid), `reject`. Forbidden: new `p_model`, new `edge`, new units above current, new sides, new games.

Aggregation: a candidate is rejected only if at least two agents say `reject`. A single reject (or a `cut_units`) applies the **minimum** units any agent allowed, not below \(0.25\). Agent failures (timeout, missing key) are ignored — the deterministic engine stands. Each action stores `reason` text on the pick or rejection list.

---

## 12. Close-capture

Stub only. Future close prices will be written to `grok-beta/closes/{date}.json`. This engine does not observe Alpha CLV and does not copy the Alpha observer.
