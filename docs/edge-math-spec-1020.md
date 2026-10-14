# Edge card spec — approval for 2026-10-20

Target first: a daily card of up to 3 straights and one 3-leg parlay that is profitable on held-out days, with the parlay hitting 20% by 2026-10-20. CLV is the secondary check. It does not put a bet on the card.

The current v12.3.74 card on slates before 2026-09-22 lost 13.6% (day 95% −31% .. +5%). Parlays hit 10.4% (7-60). Eighty-six of 94 graded pool "edges" are negative if the probability is the Pinnacle no-vig. The model is the only reason they clear 2%.

## Selection

A straight publishes only when all of these hold. Sources: held-out v74 bands, the Alpha ticket record, and the pool price audit in `docs/MATH-DIAG-1014.md`.

1. Best DraftKings or Hard Rock price, same as today. Pinnacle is the fair, never the bet.
2. Vigged implied probability of that price is less than or equal to the paired Pinnacle no-vig at the 10:00 ET snapshot. A worse price than the sharp is a pass. `gates.js` after line 209.
3. American odds from −160 to −110 inclusive. Held-out straights in −159..−110: 46-22, +24.4% ROI, day interval +3.8% .. +43.6% (n=68). Dogs on the same cut: 16-47, −40%, interval entirely below zero. Prices ≤ −160 won 43.5% against a 65% implied.
4. Stake EV from 0% to 4% at that price. EV above 4% on the published card was 7-19, −36%, interval entirely below zero. `GATES.maxEV` moves from 0.12 to 0.04 (`config.js` 339).
5. One game. Up to three. No final-fill and no negative-EV lean. A day with one or two qualifiers publishes those and does not pad.
6. NHL spreads stay off. Held-out NHL spread was 12-21, −30%, interval −59% .. +1%.

De-vig stays proportional. On 1,831 closing moneylines, power and Shin change log-loss by about 0.0005 and the interval includes zero. Snapshot lag is not a filter: 241 of 254 card straights already had Pinnacle within 2 minutes.

## Parlay, 20% by 10/20

Publish the 3-leg 0.25u ticket only when three straights cleared the rules above. Otherwise no parlay. `parlayFromStraights` (`parlay.js` 956) currently ships any three games, including a negative combined EV.

Why this can hit 20%: a 3-leg independent ticket hits 20% when each leg wins about 58%. The held-out −159..−110 legs won 68% (against a 54% vigged implied). `0.58^3 = 20%`. `0.68^3 = 31%`. The same card rule produced 4 wins in 9 tickets (44%, Wilson 19% .. 73%). That n is too small to treat 44% as the forecast. The forecast is 20% if the legs revert to 58%, and higher only if the 68% holds.

Alpha's published 3-leg tickets, 2026-03-19 .. 2026-09-21, hit 21.3% (30-111, Wilson 15% .. 29%) and made +$6,764, with 21% on both sides of 2026-06-15. The v74 fill hits 10.4% because the legs win 44% and 49 of 67 tickets are one sport. The total-correlation haircut never fired (zero same-direction total tickets).

## Expected KPI versus the current card

Held-out (before 2026-09-22), if the card had been this rule:

- Straights in the band: +24% ROI, day interval above zero, CLV −1.64 pp.
- Full card including the parlay: +8.83u, +15.6% ROI, day interval −11% .. +43%. Many days have no ticket.
- Parlay hit: 4/9 in the replay. Plan on 20% once three short favorites are required, not on 44%.

From 2026-09-22 the band is 9 days. Do not read it as confirmation.

Alpha NBA totals after 2026-04-20 were 28-11, +34%, interval above zero. This model's held-out NBA totals were 9-12, −20%, CLV −3.9 pp. The spec does not turn NBA totals on to chase that Alpha run. NBA spreads on this model were 15-9, +15%, interval through zero, CLV −2.0. They stay eligible only through the price rules above.

## CLV check, not a gate

Positive CLV does not select. Negative CLV does not by itself veto a price that beat Pinnacle at 10:00. Report beat-close rate next to units.

Do not Gaussian-shift CLV when the close number differs from the bet by more than half a point (`run-backtest.js` 825). Those 20 of 96 pool closes are `point-normal` today. Mark them unmeasured.

The short-favorite band made units and lost the close by 1.6 pp. A week that is green on units and flat-to-positive on same-number CLV is the confirmation. A week that is green only because dogs were padded back in is not.

## Out of scope

No deploy, no `main` push, no Supabase write, no Odds API. Proportional de-vig, the 10:00 ET lock, and the 0.25u parlay stake stay. Kelly staking stays off the published card.
