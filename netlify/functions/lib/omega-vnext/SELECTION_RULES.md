# Selection rules

The card is priced from the 10:30 AM America/New_York odds snapshot (`priceLockTimestamp`). Publish crons are unchanged. This file is the selection contract. Invented coefficients below are labeled **ASSUMPTION**. They are not fit on CLV.

## 1. DraftKings is the execution book

Odds API key `draftkings`. A side with a `bookPrices` ladder and no DraftKings quote is dropped (`no-draftkings-line`). The next candidate that DraftKings does post stays in the pool and can fill the bet. Shop books do not create a second candidate for the same side and number. The fair price stays the de-vigged Pinnacle/Circa price. Stake EV is recomputed at the DraftKings American price before the gates.

A candidate with no `bookPrices` array is a synthetic fixture. It keeps the price it already has so older gate tests stay eligible. Live projectors always attach a ladder.

## 2. Hard Rock is review-only

Keys `hardrockbet`, `hardrockbet_oh`, and `hardrock` are one brand. Verify calls `reviewHardRock`. It does not change the pick, the book, the odds, or the parlay.

Flag when `|DK line − HR line| >= 1.0`, or in the NFL when the gap is 0.5 and the closed interval between the two numbers contains 3, −3, 7, or −7 (examples: −2.5 vs −3, +7 vs +7.5). No Hard Rock number is not a flag. A flag never rejects and never disqualifies. `autoCorrectHardRock` remains for its own unit tests and is not on the verify path.

## 3. NFL projection gap

`|model − sharp| > 10` excludes the side as a data problem and is logged.

Spreads and moneylines already reject past `FB_MARKET_GAP.NFL.margin` (10) with reason `model_market_gap`. NFL totals use that object's total cap of 13, so a total gap above 10 and at or under 13 is a separate reason, `nfl-projection-gap`. Exactly 10 is allowed. `FB_MARKET_GAP` itself is unchanged. NCAAF caps are unchanged.

## 4. Inputs at 10:30 AM ET

- ESPN football injuries for any player: Out, Doubtful, Questionable, deactivations, and transactions, parsed from the injuries payload the QB map already downloads (`parseFootballPersonnel`). No second HTTP call.
- X recent search when `X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN` is set. The token is a Bearer header only. It is never logged and never stored on the card. The card keeps `{ mode, count }`.
- No token: `x_news.js` is a stub (`mode: "stub"`). It does not fetch. **ASSUMPTION:** an X post is not a priced coefficient. Unmatched text is logged and does not move a number.
- Weather (wind, precip, roof) and stadium / neutral site stay on the existing football weather and HFA paths. A dome or a closed retractable roof adjusts 0. Neutral site zeroes HFA.
- Last 5 completed margins are shrunk inside the pre-market rating (`last5.js`), before `applyEngineStack` and before the market blend. They are not added after the edge.

**ASSUMPTION (last 5):** prior weight `K = 8`. `n = min(home games, away games)`, `w = n / (n + K)`, `raw = (1 − w) * seasonMargin + w * (homeLast5Mean − awayLast5Mean)`. The move from the season margin is capped at ±1.5 points. A side with no completed games is a no-op, so a missing board does not change the margin.

## 5. Sport modules

- NFL: key-number mass at 3 and 7, QB out/doubtful, rest days, and wind stay on the existing modules. Those coefficients are not retuned here.
- NCAAF: opponent-adjusted priors and the FBS/FCS split stay in `sports/epa.js` (`solveNcaafOpponentRatings`, `isFbsTeamId`).
- NHL: a goalie with `confirmed === undefined` is still priced from the given save rate. `confirmed === false` prices the projected starter and a backup, then keeps the residual closer to zero. A missing starter save rate still returns none.

**ASSUMPTION (NHL backup):** when `confirmed === false` and no `backupSavePct` is present, the backup save rate is 0.010 worse than the projected starter (`UNCONFIRMED_BACKUP_SAVE_HAIRCUT`). Rates outside 0.85–0.95 are dropped. The scenario with the smaller absolute residual is used.

## 6. Rank, floors, top 10, three straights, parlay

The floor pool is stake EV ≥ 3% (`GATES.minEV`) and edge vs the de-vigged sharp at or above `minEdgeFor` in `edge_floor.js` (1.75% at −110, +0.05 per implied point of plus-money distance from −110, +0.04 per uncertainty point above 0.15, cap 6%). That curve is wired in `gateReason`. It is not retuned. Leans stay at 1.5% EV and 0.5u. Floors are not lowered to fill the card.

Top 10 is the floor pool sorted by stake EV. An EV tie breaks on edge. One row per bet (matchup, start, market, side, line).

The published three straights stay `selectStraights`: calibrated edge, one straight per game, lean fill when the floor tier is short. The parlay stays `optimizeParlay` (45% cover, positive combined EV, those three straights when they qualify, otherwise the next positive-EV distinct games).

## 7. Live and in-play

`inPlay`, `live`, `in_play`, or `priceState` / `marketStatus` of `live` or `in-play` rejects as `live-in-play`. A commence more than five minutes before the pregame clock still rejects as `in-progress-or-started`. Verify runs `verifySchedule` and drops a started or out-of-slate straight. It backfills from `candidateTable` only when the book is DraftKings or unknown, EV is at least 3%, the edge clears `minEdgeFor`, the game is in the slate, and the game has not started. One straight per game, up to three. A missing commence time does not drop.

## 8. Slate window

Eligible commence times are `>= 11:15:00 ET` on the card date and `< 06:00:00 ET` the next calendar day. Reasons:

- `starts-before-1115-et` — same ET date, before 11:15
- `future-date` — at or after 06:00 ET the next day
- `not-same-et-day` — any earlier date outside that window
- `missing-commenceTime` — no parseable start (gates only; verify does not drop)

The same window filters odds events (`filterEventsSameEtDay` keeps its name) and parlay legs.

## 9. Unquantifiable inputs

Non-QB personnel uses `personnel.js`. Quarterbacks are skipped here because `qbSoftAdjust` already prices them. Kickers, punters, and any position that is not in the priced set are logged and do not move the margin.

**ASSUMPTION (non-QB):** one Out skill or offensive-line player is 0.20 points toward the opponent. Doubtful weighs 0.75. Questionable weighs 0.35. Each side is capped at 0.60 before the two sides are netted. Five or more full outs on one side sets `personnelExclude` and the gate reason `unquantified-injury-cluster`. The cluster is an exclusion, not a larger invented number.

X text that does not match a quantified ESPN status is log-only.
