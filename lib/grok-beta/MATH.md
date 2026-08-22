# Grok Beta Model — Pricing Math (v0.2.0)

Independent day-one engine. **Not** WeBet Alpha / v10 / Betty / Elo / NB / Alpha Kelly / Alpha CLV observer.

Version string: `grok-beta-0.2.0+<gitsha>`.

LLMs may reject a pick or cut stake and must write a reason. They must not invent `p_model`, `edge`, `EV`, or `units`.

---

## Audit of v0.1 (why the card was empty)

v0.1 did four things that guaranteed ~zero published picks on a real slate:

1. **Market-anchored scoring.** Team means started at the posted total/spread. An independent view was never formed.
2. **Feature overlay on Shin market.** \(p_{\text{raw}}=p_{\text{market}}+(p^{\text{feat}}-p^{\text{neutral}})\). Quiet rest/injury → edge 0 by construction.
3. **4.8pt AND 5.5% EV floor.** Syndicate desks work at ~2–3% EV vs a **devigged sharp book**. 4.8 probability points is a once-a-month number, not a daily card.
4. **All-book median as “the market.”** Elite process is: **devig Pinnacle (or Circa / Bookmaker / BetOnline)**, then **bet the best US retail number**. Median DK/FD/MGM *is* the soft price, not the fair price.

v0.1 also treated “did not play yesterday” as extra rest, which minted fake NFL overs. That bug stays dead: rest is 1 if they played yesterday, else 2.

v0.2 replaces the model. Same isolation, same fail-closed gates, different (standard) sharp algorithm.

---

## Elite process this engine follows

Industry-standard +EV workflow (Pinnacle benchmarking, not Alpha):

1. Snapshot US+EU books.
2. **Fair probability** = Shin de-vig of the **sharp** two-way (Pinnacle first, else Circa / Bookmaker / BetOnline / Betfair). If no sharp book, Shin of the all-book median.
3. **Bet price** = best **US retail** decimal on that side (line shop).
4. **Independent projection** from ESPN (season scoring / win% Pythagorean + HFA + injuries + starter + rest). Sport-family likelihood (Poisson runs/goals, normal points). **Not** Elo.
5. Blend: \(p_{\text{model}} = w\,p_{\text{proj}} + (1-w)\,p_{\text{fair}}\).
6. \(\mathrm{EV} = p_{\text{model}}\cdot d_{\text{retail}} - 1\).
7. **Hold EV** (pure steam/lag): \(\mathrm{EV}_{\text{hold}} = p_{\text{fair}}\cdot d_{\text{retail}} - 1\).
8. Publish a **3-straight card** plus the **same 3 as a parlay**, chosen to maximize combined EV with sport/market diversity.

---

## 1. Odds

\[
\pi(o)=\begin{cases}|o|/(|o|+100)& o<0\\ 100/(o+100)& o>0\end{cases}
\qquad
d(o)=\begin{cases}1+o/100& o>0\\ 1+100/|o|& o<0\end{cases}
\]

Two-way required. Soccer 1X2 (three outcomes) is skipped.

**Sharp keys (books, not exchanges):** `pinnacle`, `circasports`, `bookmaker`, `betonlineag`, `lowvig`. Betfair/Matchbook back prices are not a two-way book and must not be Shin-devigged as fair. Negative overround → discard that sharp two-way and fall back to all-book median. Totals with fair \(p\notin[0.28,0.72]\) are treated as alt-line artifacts and skipped.

**US retail keys:** `draftkings`, `fanduel`, `betmgm`, `caesars`, `espnbet`, `hardrockbet`, `hardrockbet_oh`, `betrivers`, `fanatics`, `ballybet`, `betparx`.

---

## 2. Shin de-vig (unchanged method, different input)

Same Shin \(z\) as v0.1, applied to the **sharp two-way**, not the retail median.

\(p_{\text{fair}}\) is that Shin probability. If sharp is missing, Shin the all-book median.

Overround \(> 0.28\) → fail closed.

---

## 3. Independent projection (not market-anchored)

### 3.1 Sport families

| Family | Sports | Process | μ (per team) | HFA | σ_margin / σ_total | Pythag exp |
|---|---|---|---|---|---|---|
| Runs | MLB | Poisson | 4.45 | +0.14 | — | 1.83 (James) |
| Points | NBA | Normal | 113.0 | +2.3 | 12.0 / 14.5 | 14 (Oliver) |
| Points | WNBA | Normal | 82.5 | +1.5 | 10.5 / 12.0 | 14 |
| Points | NCAAB | Normal | 73.0 | +3.1 | 11.0 / 13.5 | 11.5 |
| Points | **NFL regular** | Normal | 22.8 | +2.0 | 13.8 / 10.4 | 2.37 |
| Points | **NFL preseason** | Normal | **17.4** | +1.0 | 12.5 / 9.2 | unused |
| Points | NCAAF | Normal | 27.4 | +2.6 | 16.0 / 13.0 | 2.37 |
| Goals | NHL | Poisson | 3.05 | +0.18 | — | 2.00 |
| Goals | soccer | Poisson | 1.38 | +0.16 | — | 1.35 |
| Fight | UFC | Bernoulli | 0.50 | 0 | — | — |

NFL preseason is detected from the Odds API key `americanfootball_nfl_preseason` **or** NFL in calendar month 8. Regular-season μ is **not** applied to preseason totals (that was a second fake-over channel).

### 3.2 Team scoring means

Priority:

1. ESPN points/runs/goals for and against per game, if both teams have them:

\[
\lambda_H^{(0)}=\tfrac12(\mathrm{PF}_H+\mathrm{PA}_A)+\tfrac h2,\qquad
\lambda_A^{(0)}=\tfrac12(\mathrm{PF}_A+\mathrm{PA}_H)-\tfrac h2
\]

2. Else season win% with \(n\ge 8\) games (skip tiny NFL preseason samples):

\[
\lambda_H^{(0)}=\mu+\tfrac h2+(w_H-0.5)\cdot 1.1\cdot\sigma_m,\qquad
\lambda_A^{(0)}=\mu-\tfrac h2+(w_A-0.5)\cdot 1.1\cdot\sigma_m
\]

For Poisson sports \(\sigma_m \approx \sqrt{2\mu}\).

3. Else league μ ± HFA.

Then rest / injuries / starter:

- Rest: 1 if played yesterday else 2. \(\Delta=\rho(\text{rest}-2)\).
- Injuries: OUT/DOUBTFUL as in v0.1 (capped).
- MLB starter: if named, \(S=0\) (presence only). Pitcher-sensitive market with **no** starter → fail closed. We do not invent FIP.

\[
\lambda_H=\max(\mu_{\min},\,\lambda_H^{(0)}+\Delta_H - I_H + I_A + S_H - S_A)
\]

and symmetric for away.

### 3.3 Likelihood → \(p_{\text{proj}}\)

Unchanged family math: Skellam/Poisson for runs and goals (ties broken by \(\lambda\) share for MLB/NHL ML); \(\Phi\) for points; UFC ML only, fighter OUT fail-closed.

NFL spread key numbers: if the ball is on 2.5 or 3.5, shift cover probability ±0.018 toward the 3; ±0.012 toward the 7 at 6.5/7.5. Public-domain key-number mass, not an Alpha table.

---

## 4. Blend and EV

Projection weight \(w\):

| Slate | \(w\) |
|---|---|
| MLB | 0.50 |
| NBA / WNBA | 0.45 |
| NHL / soccer | 0.40 |
| NCAAF / NCAAB | 0.30 |
| NFL regular | 0.40 |
| NFL preseason | **0.12** |
| UFC | 0.15 |

\[
p_{\text{model}}=w\,p_{\text{proj}}+(1-w)\,p_{\text{fair}}
\]

Clip to \((0.08, 0.92)\). Optional Kalshi/Polymarket: if a matching contract exists, mix 8% of that price into \(p_{\text{model}}\) (still cannot invent numbers).

If sharp and retail lines differ by \(\delta\) points, shift \(p_{\text{fair}}\) to the **retail line** using the family σ (totals: \(\Phi\) or Poisson CDF at the new line; spreads: same). We price the number we can actually bet.

\[
\mathrm{EV}=p_{\text{model}}\,d_{\text{retail}}-1
\qquad
\mathrm{EV}_{\text{hold}}=p_{\text{fair}}\,d_{\text{retail}}-1
\]

---

## 5. Emission (daily 3-pick card)

A side is a **candidate** iff all of:

1. Two-way present; Shin succeeded.
2. Game not started; ESPN not postponed / live / final.
3. MLB ML/spread has a named probable pitcher.
4. At least 2 books; at least 1 US retail quote.
5. Retail American in \([-220,+260]\).
6. \(\mathrm{EV}\ge 0.018\) (1.8%).
7. \(\mathrm{EV}_{\text{hold}}\ge 0.006\) — **never fade a sharp no-vig price**. Projection may upgrade a retail lag; it may not bet the side Pinnacle already has as fair-worse. Agents may cut stake; they drop a pick only for a hard gate (scratch / postponed / started / no starter).

Zero published remains valid if the slate is truly efficient. The v0.1 floor was the bug, not this clause.

Stake (not Alpha Kelly):

\[
u=\mathrm{clip}_{[0.25,1.25]}\bigl(\mathrm{round}_{0.25}(10\cdot\mathrm{EV})\bigr)
\]

Hard cap **3.5u** on the three straights. Letter from units: ≥1.0 A, ≥0.75 A-, ≥0.50 B+, else B.

---

## 6. Card selection + parlay

From candidates, one pick per matchup (highest EV).

Let \(U\) be those unique-game candidates. Take the top 12 by EV. Enumerate every 3-set (or the full set if \(|U|<3\)).

Score of a set \(S\):

\[
\mathrm{score}(S)=\sum_{i\in S}\mathrm{EV}_i + 0.55\,\mathrm{EV}_{\text{parlay}} + 0.05\,(n_{\text{sports}}-1) + 0.04\,(n_{\text{markets}}-1) - 0.06\cdot\mathbf{1}_{\text{all overs}}
\]

\[
\mathrm{EV}_{\text{parlay}}=\Bigl(\prod_i p_{\text{model},i}\Bigr)\Bigl(\prod_i d_i\Bigr)-1
\]

Independence assumed **only** across different games (already enforced). Same-game parlays are never built.

Publish:

- `picks` = the winning 3-set (or 1–2 if that is all that cleared).
- `parlayLegs` = one ticket, those same legs, units \(0.50\) if every leg EV ≥ 3%, else \(0.25\). Require \(\mathrm{EV}_{\text{parlay}}>0\); otherwise omit the parlay.

---

## 7. Fail closed

- missing two-way
- started / final / postponed
- MLB pitcher-sensitive, no starter
- UFC fighter OUT
- Shin overround > 0.28
- no US retail number to actually bet

---

## 8. Close-capture

Still a stub at `grok-beta/closes/{date}.json`. Future: compare to Pinnacle close (CLV), not Alpha’s observer.
