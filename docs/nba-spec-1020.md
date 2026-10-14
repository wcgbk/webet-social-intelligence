# NBA spec 1020 — for WeBet approval

Status: shadow only. The daily card stays off. `SPORTS_ENABLED.NBA` stays false. `NBA_CARD_LIVE` stays false. `OMEGA_NBA` stays unset. Preseason (2026-10-02 through 2026-10-19) is never card-eligible.

## Price

Fair probability is the de-vigged Pinnacle two-way price. The model blend weight is 0 on moneyline, spread, and total. That weight is the 2025-10-21..2025-12-17 tune in `docs/nba-backtest-1020.md`. Every weight from 0.10 to 0.50 lost money on the tune split, and CLV fell as the weight rose.

The bet is the best DraftKings price in the -250 to +250 band. Hard Rock was not in the backtest tape, so this spec does not claim a Hard Rock quote. One 2% EV minimum, one 12% EV cap, rank by EV. Markets: moneyline, spread, total. One side per market per game.

Rest, back-to-backs, pace, and injuries are not in the fair price. The tune did not support them. Injuries have no pre-bet feed in the tape. The projector may still log a margin and a total. That log is not the number the gate uses. The hand-set NBA shrink K stays in place. When the raw probability is already the Pinnacle no-vig price, that shrink does not move it.

## Expected KPI impact

Do not expect NBA to add a daily card, and do not expect a positive ROI from turning it on.

On simultaneous DraftKings and Pinnacle prices, the 2% gate fired 5 times in the full open-price window (1-4-0, ROI -70.8%, 95% CI -128% to -13.6%) and 13 times at the close (6-7-0, ROI -9.0%, CI -65% to +47%). Average CLV on the two open bets with a point-matched close was positive and is two bets. Full cards: 0. Parlay tickets: 0. The 20% parlay-hit goal is not estimable. A 3-straight day does not appear.

Alpha's older +24% ROI (totals about +14.7%) came from a stack that still anchored to the market. This tape says the anchor was the part that held. Adding model weight made more bets and those bets lost.

Turning NBA on for the 2026-10-20 morning run would add approximately no volume. It is not a path to the 3-straight plus 3-leg card. The other sports still fill that card. NBA should not be asked to.

## What this branch ships

`OMEGA_NBA_GENERATE_SHADOW=1` (or `nbaGenerateShadow: true` on a generate call) writes `omega-nba-shadow-{YYYY-MM-DD}` from the board generate already has. It does not call the Odds API, does not call `selectStraights`, and does not attach anything to `picks-{date}`. Unset, it does nothing. Replay and dry runs do not write the blob.

The existing 21:30 UTC shadow cron is unchanged and remains off the daily card. It is the job that can price a preseason slate on 2026-10-15 through 2026-10-19. This generate flag is the no-odds side log for a board that was already captured.

## What approval would have to do

Approval of this page does not turn NBA on. A live flip is a separate change, after approval, and only on a regular-season date (the opener is 2026-10-20, Boston at Detroit and Philadelphia at New York).

To put NBA on the morning card, both of these have to be true, and preseason still blocks the card:

- `OMEGA_NBA=1` or `OMEGA_NBA_LIVE=1` (or a code change of `NBA_CARD_LIVE`, which this branch does not make).
- The card date is regular season, play-in, or postseason.

`SPORTS_ENABLED.NBA` should stay false so the kill switch remains the env flag. This branch does not set either env flag.

Recommendation: leave the live card off on 10/20. Run the shadow log. Revisit only with a new tape where a pre-registered model weight beats de-vigged Pinnacle on ROI and on CLV with a real bet count.
