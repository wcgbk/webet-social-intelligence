# Selection rules

The card is priced from the 10:00 AM America/New_York odds snapshot (`priceLockTimestamp`). The public card waits until 11:00 ET. This file is the selection contract. Invented coefficients below are labeled **ASSUMPTION**. They are not fit on CLV.

## 1. Best US price is DraftKings or Hard Rock

Odds API keys `draftkings` and `hardrockbet`. DraftKings is priced first. The displayed price is the better American decimal of Hard Rock and DraftKings on the DraftKings line. Hard Rock alone is kept. A side with a `bookPrices` ladder and neither quote is dropped (`no-draftkings-line`). The fair price stays the de-vigged Pinnacle price blended with the model. Stake EV is `p * decimal_odds - 1` at that displayed price. Pinnacle is never the displayed price.

A candidate with no `bookPrices` array is a synthetic fixture. It keeps the price it already has so older gate tests stay eligible. Live projectors always attach a ladder.

## 2. Hard Rock is review-only

Keys `hardrockbet`, `hardrockbet_oh`, and `hardrock` are one brand. Verify calls `reviewHardRock`. It does not change the pick, the book, the odds, or the parlay.

Flag when `|DK line − HR line| >= 1.0`, or in the NFL when the gap is 0.5 and the closed interval between the two numbers contains 3, −3, 7, or −7 (examples: −2.5 vs −3, +7 vs +7.5). No Hard Rock number is not a flag. A flag never rejects and never disqualifies. `autoCorrectHardRock` remains for its own unit tests and is not on the verify path.

## 3. NFL projection gap

`|model spread − sharp spread| > 10` excludes the game as a data problem and is logged. Every market on that game drops. A total whose own gap is above 10 and still inside the wider total cap also drops, even when the spread gap is inside 10.

Spreads and moneylines already reject past `FB_MARKET_GAP.NFL.margin` (10) with reason `model_market_gap`. The game stamp and a total gap above 10 use `nfl-projection-gap`. Exactly 10 is allowed. `FB_MARKET_GAP` itself is unchanged. NCAAF caps are unchanged.

## 4. Inputs at 10:00 AM ET

Generate prices the stored 10:00 ET board from `omega-pinnacle-line-moves` slot `1000` (pinnacle, DraftKings, Hard Rock). The event list is that store's `date/{day}` index plus every `odds-master` `by-date/{day}` game whose line-move doc has a `1000` check. Blob reads use the percent-encoded REST key when the SDK misses a slash key. It does not re-pull paid Odds API odds unless `allowPaidOdds` is true. `priceLockTimestamp` stays 10:00 ET. The card stays unpublished until 11:00 ET. Odds API pulls that write those snapshots are 3:00 and 10:00 ET only. The old morning snaps `0600`, `0730`, `0900`, and `0915` are not pulled and their absence does not warn. `captureHealth` requires the 3:00 and 10:00 pulls. A missing stored board logs `stored-10:00-missing` and does not call the Odds API. `line_move_prob` still reads the 3:00 and 10:00 checks and is not retuned.

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

The floor pool is stake EV ≥ 2% (`GATES.minEV`) and ≤ 12% (`GATES.maxEV`) at the best DraftKings or Hard Rock price. `minEdgeFor` in `edge_floor.js` is not an inclusion gate. Stake EV is the inclusion check. Probability edge is the rank. Inside 0.2 percentage points of edge, higher stake EV wins. EV above 12% is `ev-stale`, logged, and is not a lean. Odds outside −250..+250 are `odds-out-of-band`. A sport whose mean margin residual is more than 3× its bias limit is `bias-margin-extreme` and is off the card for that run. It is not a lean and it does not fill a short card.

Top 10 is the floor pool sorted by probability edge, one candidate per game. An edge tie inside 0.2 percentage points uses stake EV. A second market on a game already taken is skipped. A short floor pool publishes fewer than 10 rows. It is not padded with leans. Hard Rock coverage of those ten is recorded and does not reject a row.

Published straights are `selectStraights`: the same edge rank, one straight per game, up to three. When fewer than three clear the floor and `LEAN_PAD` is true, the open slots fill from positive-EV leans, then from any remaining pregame lean, both sorted by that same edge rank, including a non-positive EV. A positive fill needs DraftKings or Hard Rock (a synthetic with no ladder stays eligible) and a pregame board. One pick per game. A lean is tier `lean`, label `lean`, and the stake is flat `LEAN_MAX_UNITS` (0.5u). The card does not publish "No Qualifying Plays" while a pregame lean remains. A `bias-margin-extreme` row is not that lean. `ev-stale` and other structural rejects do not fill.

The published parlay is `parlayFromStraights`. A leg needs a sport that passed the margin check, cover probability at least 45% (`PARLAY_MIN_COVER`), and positive stake EV at or under 12%. Three distinct games, or no parlay. Rank is probability edge. A ticket whose combined EV is not positive still publishes and is labeled when the three legs each qualify. Fewer than 3 qualifying games is `no qualifying parlay`. A full-grade card stakes `PARLAY_FIXED_UNITS` (0.5u). A lean-only card stakes `LEAN_PARLAY_UNITS` (0.25u). `optimizeParlay` and `priceParlayLeg` remain for older tests and are not the card path.

## 7. Live and in-play

`inPlay`, `live`, `in_play`, or `priceState` / `marketStatus` of `live` or `in-play` rejects as `live-in-play`. A commence more than five minutes before the pregame clock still rejects as `in-progress-or-started`. Verify runs `verifySchedule` and drops a started or out-of-slate straight. It backfills from `candidateTable` when the book is DraftKings, Hard Rock, or unknown. The first pass needs EV of at least 2%. A second pass takes any finite EV that is not above 12%. The game must be in the slate and must not have started. One straight per game, up to three. A dropped parlay leg is refilled from that table up to 3 at 0.25u and labeled when combined EV is not positive. A missing commence time does not drop. QA does not throw.

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
