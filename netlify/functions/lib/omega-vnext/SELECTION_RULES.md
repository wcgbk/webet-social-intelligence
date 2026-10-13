# Selection rules

The card is priced from the 10:00 AM America/New_York odds snapshot (`priceLockTimestamp`). The public card waits until 11:00 ET. This file is the selection contract. Invented coefficients below are labeled **ASSUMPTION**. They are not fit on CLV.

## 1. DraftKings is the execution book

Odds API key `draftkings`. A side with a `bookPrices` ladder and no DraftKings quote is dropped (`no-draftkings-line`). The next candidate that DraftKings does post stays in the pool and can fill the bet. Shop books do not create a second candidate for the same side and number. The fair price stays the de-vigged Pinnacle/Circa price. Stake EV is recomputed at the DraftKings American price before the gates.

A candidate with no `bookPrices` array is a synthetic fixture. It keeps the price it already has so older gate tests stay eligible. Live projectors always attach a ladder.

## 2. Hard Rock is review-only

Keys `hardrockbet`, `hardrockbet_oh`, and `hardrock` are one brand. Verify calls `reviewHardRock`. It does not change the pick, the book, the odds, or the parlay.

Flag when `|DK line − HR line| >= 1.0`, or in the NFL when the gap is 0.5 and the closed interval between the two numbers contains 3, −3, 7, or −7 (examples: −2.5 vs −3, +7 vs +7.5). No Hard Rock number is not a flag. A flag never rejects and never disqualifies. `autoCorrectHardRock` remains for its own unit tests and is not on the verify path.

## 3. NFL projection gap

`|model spread − sharp spread| > 10` excludes the game as a data problem and is logged. Every market on that game drops. A total whose own gap is above 10 and still inside the wider total cap also drops, even when the spread gap is inside 10.

Spreads and moneylines already reject past `FB_MARKET_GAP.NFL.margin` (10) with reason `model_market_gap`. The game stamp and a total gap above 10 use `nfl-projection-gap`. Exactly 10 is allowed. `FB_MARKET_GAP` itself is unchanged. NCAAF caps are unchanged.

## 4. Inputs at 10:00 AM ET

A run before 10:00 ET prices the current board (`resolveGenerateOddsSnapshot` returns null). The log line `odds snapshot requested=live served=...` is the time the odds feed actually returned. The 10:00 final run requests `priceLockTimestamp` (10:00 ET). The card is generated then and stays unpublished until 11:00 ET. Missing morning capture slots `0600`, `0730`, `0900`, and `0915` are a `captureHealthWarning`. They do not throw and they do not withhold the card. One capture retry still runs when a due slot is empty.

- ESPN football injuries for any player: Out, Doubtful, Questionable, Inactive, deactivations, and transactions, parsed from the injuries payload the QB map already downloads (`parseFootballPersonnel`). No second HTTP call. A row that names both clubs (for example Marvin Harrison Jr. inactive, DET@ARI) applies only to that game. A team-level designation applies to that club's games.
- X recent search when `X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN` is set. `x_news.js` reads those names from the process environment at call time (Netlify injects them). A test may pass an `env` object instead. The token is a Bearer header only. It is never logged and never stored on the card. The card and the dry run keep `{ mode, count }`.
- No token: `x_news.js` is a stub (`mode: "stub"`). It does not fetch. **ASSUMPTION:** an X post is not a priced coefficient. Unmatched text is logged and does not move a number.
- Weather (wind, precip, roof) and stadium / neutral site stay on the existing football weather and HFA paths. A dome or a closed retractable roof adjusts 0. Neutral site zeroes HFA.
- Last 5 completed margins are shrunk inside the pre-market rating (`last5.js`), before `applyEngineStack` and before the market blend. They are not added after the edge.

**ASSUMPTION (last 5):** prior weight `K = 8`. `n = min(home games, away games)`, `w = n / (n + K)`, `raw = (1 − w) * seasonMargin + w * (homeLast5Mean − awayLast5Mean)`. The move from the season margin is capped at ±1.5 points. A side with no completed games is a no-op, so a missing board does not change the margin.

## 5. Sport modules

- NFL: key-number mass at 3 and 7, QB out/doubtful, rest days, and wind stay on the existing modules. Those coefficients are not retuned here. `qbSoftAdjust` moves the margin and the total. A fresh Out uses `backupQbDelta`: an explicit starter-vs-backup gap, else a named backup (Lamar Jackson 4.5 margin / −2.25 total), else the sport table (NFL 3.0 / −1.5, doubtful × 0.75, cap 5 / 3). **ASSUMPTION:** the table is not a fitted backup-QB scoring effect. The total stays on the card. A starting QB Out does not exclude totals, spreads, or moneylines. IR / PUP / season-ending is not a fresh Out. Doubtful and questionable stay on the table and do not exclude.
- NCAAF: opponent-adjusted priors and the FBS/FCS split stay in `sports/epa.js` (`solveNcaafOpponentRatings`, `isFbsTeamId`).
- NHL: a goalie with `confirmed === undefined` is still priced from the given save rate. `confirmed === false` prices the projected starter and a backup, then keeps the residual closer to zero. A missing starter save rate still returns none.

**ASSUMPTION (NHL backup):** when `confirmed === false` and no `backupSavePct` is present, the backup save rate is 0.010 worse than the projected starter (`UNCONFIRMED_BACKUP_SAVE_HAIRCUT`). Rates outside 0.85–0.95 are dropped. The scenario with the smaller absolute residual is used.

## 6. Rank, floors, top 10, three straights, parlay

The floor pool is stake EV ≥ 3% (`GATES.minEV`) and edge vs the de-vigged sharp at or above `minEdgeFor` in `edge_floor.js` (1.75% at −110, +0.05 per implied point of plus-money distance from −110, +0.04 per uncertainty point above 0.15, cap 6%). That curve is wired in `gateReason`. It is not retuned. Leans stay at 1.5% EV and 0.5u in the lean pool. Floors are not lowered to fill the card.

Top 10 is the floor pool sorted by edge, one candidate per game. An exact edge tie keeps the earlier row. A second market on a game already taken is skipped. A short floor pool publishes fewer than 10 rows. It is not padded with leans. Hard Rock coverage of those ten is recorded and does not reject a row.

Published straights are `selectStraights`: calibrated edge, one straight per game, up to three. When fewer than three clear the floor and `LEAN_PAD` is true, the open slots fill from leans sorted by stake EV. A fill lean needs stake EV > 0 after vig, edge >= 1.5% vs the no-vig sharp, a DraftKings line, and a pregame board. One pick per game. A game that already holds a straight is skipped. The stake is flat `LEAN_MAX_UNITS` (0.5u). The daily cap does not raise it. If the lean pool cannot fill the rest, the card still publishes the shorter set. It never blocks, and it does not publish "No Qualifying Plays" while a fill lean is still open. `summary.cardLabel` and `selection.cardLabel` say `3 floor straights`, `short card: 2 floor straights`, `short card: 1 floor straight`, or `no floor plays` when every published straight is a floor play. A mixed card says how many of the three are leans.

The published parlay is `parlayFromStraights`: the three published straights, combined. There is no pool search, no cover floor, and no combined-EV gate. Fewer than three straights, or a straight with no finite price, means no parlay. The straights still publish. A lean among the three sizes the ticket at 0.25u. Otherwise it is 0.5u. A parlay leg with no Hard Rock price is a silent bug-log entry. It is swapped for the next edge-ranked one-per-game candidate that has a Hard Rock price, or the leg stays and the ticket notes it. QA does not block publish. `optimizeParlay` remains in the file for older tests and is not the card path.

## 7. Live and in-play

`inPlay`, `live`, `in_play`, or `priceState` / `marketStatus` of `live` or `in-play` rejects as `live-in-play`. A commence more than five minutes before the pregame clock still rejects as `in-progress-or-started`. Verify runs `verifySchedule` and drops a started or out-of-slate straight. It backfills from `candidateTable` only when the book is DraftKings or unknown, EV is at least 3%, the edge clears `minEdgeFor`, the game is in the slate, and the game has not started. One straight per game, up to three. A missing commence time does not drop.

## 8. Slate window

Eligible commence times are `>= 11:15:00 ET` on the card date and `< 06:00:00 ET` the next calendar day. Publish is 11:00 ET, so a start before publish + 15 minutes is out. There is no per-game waiver. The 9:30 AM ET London Eagles at Jaguars game is excluded by this window.

- `starts-before-1115-et` — same ET date, before 11:15
- `future-date` — at or after 06:00 ET the next day
- `not-same-et-day` — any earlier date outside that window
- `missing-commenceTime` — no parseable start (gates only; verify does not drop)

The same window filters odds events (`filterEventsSameEtDay` keeps its name) and parlay legs.

## 9. Unquantifiable inputs

Non-QB personnel uses `personnel.js`. Quarterbacks are skipped here because `qbSoftAdjust` already prices them. Kickers, punters, and any position that is not in the priced set are logged and do not move the margin.

**ASSUMPTION (non-QB):** one Out skill or offensive-line player is 0.20 points toward the opponent. Doubtful weighs 0.75. Questionable weighs 0.35. Inactives and deactivations count as Out. Each side is capped at 0.60 before the two sides are netted. The cap is not raised for a longer list.

**Starter cluster:** only Out or Doubtful players marked starter (or depth-chart order 1) count. Position weights put QB highest, then offensive line, edge, and corner. The weight is a probability haircut toward 0.5 and an uncertainty bump, including at or above `STARTER_CLUSTER.highThreshold` (4.5). Offensive starters also take points off the game total (`starterTotalPoints`, 0.12 per weight, cap 1.5). The gate does not drop a side or a total (`injuryClusterReason` is always null). Depth outs never blanket-exclude the game. A fresh starting-QB Out reprices the total and does not exclude it. A candidate leaves only when the repriced EV misses the floor.

Injured reserve, PUP, and season-ending are already in the market. They are logged as `logged-priced-in`. They do not move the margin and they do not count toward the cluster. Cincinnati @ Miami depth outs are not a cluster. Jalen Davis (CB, injured reserve) is not an out.

X text that does not match a quantified ESPN status is log-only.
