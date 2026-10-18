# Omega Spec — Live Pipeline (v1 era restore)

## Restored era code + October 18, 2026 display and compliance fixes

**Version:** Live as of October 18, 2026 — 2:53 PM ET order  
**Live surfaces:** webetsocial.com/omega, webetsocial.com/daily-omega  
**Live endpoint:** /api/get-picks-omega (store: edge-picks-omega)  
**Model version in code:** v12.3.13-omega-vnext-nhl-engine  
**Status:** Governing description of the live Omega code only. This is not the Lock spec and it does not govern V1.

> **How to read this document.** Every behavior below was read from the live code in the Omega pipeline, not recompiled from memory or from older planning documents. Where a behavior is unchanged era-original behavior it is marked **[Era]**. Where it was added or changed on October 18, 2026 it is marked **[Oct 18]**. Code locations are cited per section so any line can be checked in seconds. Nothing in this document invents a behavior the code does not have.

---

## Contents

1. What Omega Is
2. Origin and Commit Lineage
3. Sports and Card Shape
4. Data Inputs and Capture Timing
5. Probability Formation
6. Fair Price and De-Vig
7. Selection Gates
8. Ranking, Grades, and Selection
9. Sizing — Kelly, Caps, and Daily Budget
10. Parlay Builder
11. Books and Pricing Display
12. Published Card and Endpoint Behavior
13. Narration and Verification
14. October 18 Compliance Deltas — Listed Separately
15. What Omega Does Not Do
16. Code Map

---

## 1. What Omega Is

Omega is a CLV-first, multi-sport daily card composer. It builds up to three straight bets plus one optimized parlay per ET calendar day, publishes only what clears its gates, and is explicitly allowed to publish an empty card. It never force-fills a slot with a lean.

- **[Era]** Empty card is a valid outcome. The code constant is `LEAN_PAD = false` — never force-fill.
- **[Era]** Claude is verifier and narrator only. It does not select picks and it does not mutate model math.
- **[Era]** There is no self-optimization mutation in the live generate path. Weekly CLV reporting is observer-only.
- **[Era]** Every straight and every parlay leg must commence on the card's ET calendar date. No weekend football appears on a Tuesday or Wednesday card.

Code: `netlify/functions/generate-picks-omega-background.js` (thin wrapper); `netlify/functions/lib/omega-vnext/index.js` (`generateOmegaVnext`); `netlify/functions/lib/omega-vnext/config.js` (`MODEL_VERSION`, `LEAN_PAD`, `DAY_SCOPE_STRICT`).

---

## 2. Origin and Commit Lineage

Omega as live today is a restoration, not a new build.

| Commit | What it is |
|---|---|
| `bd56b10` (Oct 1, 2026) | The restored era snapshot — the September 26 to October 10, 2026 desk-lock era pipeline, model v12.3.13. Graded at the time as Omega's best window: straights 18–17, +$170, ROI 2.4% (n=35); September 26 to October 12 combined 21–18, +$369. |
| `61b9152` (Oct 18, 2026) | V1 RESET — era code restored as a new commit on main. Today's later work preserved at tag `pre-reset-20261018` and branch `backup/pre-reset-20261018` (`d9d53c6`). Scope: omega-vnext engine plus generate pipeline restored pure; site pages and data added since October 1 kept. |
| `7e99d66` (Oct 18, 2026) | Display fixes — bet book named on the public card; probabilities print to a tenth. See Section 14. |
| `5a91c44` (Oct 18, 2026) | Lock-priority compliance fixes folded into the live era code — QB points zeroed, power de-vig, football formula/receipt tracing with a mandatory-pass gate, parlay correlation haircut, Lock Grade A stamp. See Section 14. |
| `497cfff` (Oct 18, 2026) | V1 only — the separate V1 backend matched to the Lock Spec v2.0. Not an Omega change. Omega's payload was verified byte-identical across this commit. |

The era-original behavior in Sections 3–13 is the `bd56b10` behavior as restored by `61b9152`, except where a line is explicitly marked **[Oct 18]**.

---

## 3. Sports and Card Shape

**[Era]** Sports enabled in the live config:

| Sport | Enabled | Odds API key | Notes |
|---|---|---|---|
| MLB | Yes | baseball_mlb | Full projector with starting-pitcher, park, and bullpen residuals |
| NFL | Yes | americanfootball_nfl | EPA-style priors plus standings fallback |
| NCAAF | Yes | americanfootball_ncaaf | EPA-style priors, talent overlay where seeded |
| NHL | Yes | icehockey_nhl | Enabled September 30, 2026 — goals for/against projector |
| NBA | No | basketball_nba | Hooks ready; disabled in config (`SPORTS_ENABLED.NBA = false`) |

**[Era]** Card shape: at most 3 straights (`MAX_STRAIGHTS = 3`) plus 1 parlay. The parlay is fixed at 0.5u when published and omitted otherwise. A short card or an empty card is published as-is.

Code: `netlify/functions/lib/omega-vnext/config.js` (`SPORTS_ENABLED`, `ODDS_SPORT_KEYS`, `ESPN_LEAGUES`, `MAX_STRAIGHTS`).

---

## 4. Data Inputs and Capture Timing

### 4.1 Odds — The Odds API

**[Era]** Live odds come from The Odds API, one pass per enabled sport, American format. Historical replay uses the API's historical endpoint at a snapshot timestamp instead of the live endpoint.

Code: `netlify/functions/lib/omega-vnext/ingest.js` (`fetchOddsApi`, `ODDS_SPORT_KEYS`).

### 4.2 Morning line-path captures (stored board)

**[Era]** The generate does not rely on a single odds pull. Morning snapshots are captured into the Omega store and read back as the line path (open → now) for steam and CLV context:

| Capture | ET slot | Function |
|---|---|---|
| Early snaps | 6:00 AM, 7:30 AM ET | `capture-omega-lines` |
| Late snaps | 9:00 AM, 9:15 AM ET | `capture-omega-lines-late` |
| Feed warm | 9:00 AM ET | `warm-omega-feeds` (ESPN injuries/QB, MLB weather, StatsAPI probables) |
| Shadow dry-run | 9:05 AM ET | `trigger-omega-shadow` (writes omega-shadow keys only; never the live card) |
| Prediction-market open snap | 8:30 AM ET | `capture-omega-pm-observer-open` |
| Generate trigger | 9:30 AM ET | `trigger-picks-omega` |
| Prediction-market observer | 10:15 AM ET | `capture-omega-pm-observer` (audit log only; never mutates the card) |

**[Era]** There is deliberately no 9:30 AM capture — it would race the 9:30 generate. If required morning snaps are missing at generate time, the generator attempts one real capture into the current ET slot and re-reads; if zero usable snaps remain, generate hard-fails with a `CAPTURE_HEALTH` error and writes no card rather than inventing one.

Code: `netlify.toml` function schedules; `netlify/functions/lib/omega-vnext/config.js` (`LINE_MOVE.captureSlotsET`); `netlify/functions/lib/omega-vnext/index.js` (`assessCaptureHealth`, capture retry); `netlify/functions/lib/omega-vnext/capture_runner.js`; `netlify/functions/lib/omega-vnext/line_path.js`.

### 4.3 ESPN slate, standings, injuries, and game-day context

**[Era]** ESPN supplies the same-ET-day slate (scoreboard), standings-derived team stats, football injury/QB status, rest and back-to-back context, and MLB weather already present on the ESPN board. Feeds soft-fail: a missing feed degrades that adjustment to zero and generate continues; it does not blank the slate. The one exception is structural: games on ESPN with no odds for any sport is treated as a feed failure and nothing is stored, so a broken odds feed can never publish as a pass card.

Code: `netlify/functions/lib/omega-vnext/ingest.js` (`fetchEspnScoreboard`, standings, `loadGameDayContext`, QB injury map); `netlify/functions/lib/omega-vnext/sports/game_day.js`; `netlify/functions/lib/omega-vnext/index.js` (empty-odds guard).

### 4.4 Posted-line hold at verify

**[Era]** After publish, verification rechecks each pick against fresh prices. A pick whose line has moved adversely past the verify thresholds is dropped, not refilled: 20 American cents, or 1.5 points on spreads/totals. The pre-publish QA hard-fail uses the tighter stale-line band (1.0 point on Spread/Total, 15 juice-ladder cents against the lock snapshot). A dropped pick leaves the slot empty.

Code: `netlify/functions/lib/omega-vnext/config.js` (`LINE_MOVE.verifyAdverseCents`, `verifyAdversePts`, `QA_HARDFAIL.staleLinePts`, `staleOddsCents`); `netlify/functions/lib/omega-vnext/qa_hardfail.js`; `netlify/functions/verify-picks-omega.js`.

> **Note on capture times.** Any summary describing Omega captures as "3 AM / 10 AM" does not match the live code. The live morning slots are 6:00, 7:30, 9:00, and 9:15 AM ET with a 9:30 AM ET generate, as tabled above. This spec follows the code.

---

## 5. Probability Formation

Omega probabilities are built in three stages: a sport projector produces a raw model probability, that probability is anchored (blended) toward the market, then it is shrunk toward the sharp fair price and band-clipped. No stage is skipped.

### 5.1 Stage 1 — Sport projectors (model margin and model total)

**[Era]** Each sport projector emits a model margin (home perspective) and, where a total exists, a model total, plus an uncertainty value. Football and the other points sports convert those to cover probabilities with a normal distribution:

- Spread cover probability uses the sport's spread standard deviation (NFL 13.5, NCAAF 16.0, NBA 12.0, NHL 2.5 goals, MLB 4.2 runs).
- Total cover probability uses the sport's total standard deviation (NFL 10.5, NCAAF 13.5, NBA 14.0, NHL 1.8, MLB 3.5).
- Moneyline probability is derived from the model margin through the same normal curve, clamped to 0.05–0.95.
- Home-field advantage bases: MLB 0.12 runs, NFL 2.1 points, NCAAF 2.6 points, NBA 2.5 points, NHL 0.15 goals. Game-day rest/back-to-back deltas apply on top.

**[Era]** Football inputs, in order: EPA-style offensive/defensive priors (seeded, with a standings points-for/points-against blend only when those numbers are clean and both teams are present), success-rate or talent overlays under hard caps, then game-day adjustments. MLB inputs: starting-pitcher quality, park factors, and a capped bullpen residual. NHL inputs: per-game goals for/against with capped shot-efficiency and goalie residuals. Every overlay hard-caps and soft-fails to zero when its input is missing — a bad feed cannot dominate the sportsbook spine.

Code: `netlify/functions/lib/omega-vnext/sports/_common.js` (`spreadCoverProb`, `totalCoverProb`, `mlFromSpread`, `powerFromStandings`); `sports/nfl.js`, `sports/cfb.js`, `sports/mlb.js`, `sports/nhl.js`, `sports/game_day.js`, `sports/epa.js`; `config.js` (`SPORT_SPREAD_STD`, `SPORT_TOTAL_STD`, `HFA`, `ENGINE_SOFT`).

### 5.2 Stage 2 — Market anchor blend

**[Era]** Before calibration, each candidate's model probability is blended with the no-vig market anchor (Pinnacle and Circa at equal weight where both post; one book alone otherwise):

NFL (`sports/nfl.js` call sites):

| Market | Model weight | Market weight |
|---|---|---|
| Moneyline | 0.50 | 0.50 |
| Spread | 0.50 | 0.50 |
| Total | 0.45 | 0.55 |

NCAAF (`sports/cfb.js` call sites — corrected October 18, 2026: this table previously listed the NFL weights for NCAAF; the live NCAAF code has always used the weights below, so the document was fixed to match the code, not the reverse):

| Market | Model weight | Market weight |
|---|---|---|
| Moneyline | 0.45 | 0.55 |
| Spread | 0.45 | 0.55 |
| Total | 0.40 | 0.60 |

The blend is clamped to 0.05–0.95. If the market anchor is missing, the unblended model probability stands.

Code: `netlify/functions/lib/omega-vnext/sports/_common.js` (`blendWithMarket`); `sports/nfl.js` (0.50 / 0.50 / 0.45 call sites); `sports/cfb.js` (0.45 / 0.45 / 0.40 call sites); `edge.js` (`noVigPinnacleCircaImplied`).

### 5.3 Stage 3 — Shrink toward sharp fair, then band clip

**[Era]** Calibration shrinks the blended probability toward the no-vig sharp fair price:

- `p_cal = (1 − K) × p_model + K × p_sharp`
- K by market (all non-MLB sports): Total 0.58, Spread 0.68, Moneyline 0.73, default 0.63.
- MLB uses its own table: Total 0.46, Spread 0.62, Moneyline 0.30, default 0.46.
- The shrunk probability is then soft-clipped to the 0.42–0.58 band: only 25% of any excess beyond the band is retained. This is the isotonic-style band clip — it exists so the model cannot print a 15% fake edge against the sharp number.
- Output of this stage is the candidate's `coverProb`. All downstream EV, edge, grading, and Kelly math uses `coverProb`, never the raw projector probability.

Code: `netlify/functions/lib/omega-vnext/calibrate.js` (`shrinkTowardSharp`, `isotonicClip`, `calibrateCandidate`); `config.js` (`SHRINK_K`, `MLB_CALIBRATION`).

### 5.4 Quarterback handling

**[Oct 18 — changed]** Quarterback status is flags only. The era code priced a known QB out/doubtful directly into the projection (NFL: 3.0 margin points, −1.5 total points; NCAAF: 3.5 / −2.0; doubtful at 0.75 weight, with an uncertainty bump). On October 18 that was switched off: `QB_MARGIN_SCALE = 0`, so margin adjustment, total adjustment, and uncertainty bump all multiply to zero while the status notes still report on the candidate. A separate small QB-continuity term (questionable-only, capped at 0.55 points inside the stacked engine cap) is era behavior and still applies; out/doubtful no longer feeds it, precisely so the same injury is never counted twice.

Code: `netlify/functions/lib/omega-vnext/config.js` (`QB_MARGIN_SCALE`, `QB_INJURY`); `sports/game_day.js` (`qbSoftAdjust`, `qbContinuityAdjust`).

---

## 6. Fair Price and De-Vig

**[Era]** The fair price (`fair_sharp_p`) is a same-book, two-way no-vig probability. Books are tried in sharp order — Pinnacle, Circa/Circa Sports, Bookmaker, BetOnline, LowVig — and the first book posting both sides supplies the pair. Prices from two different books are never mixed into one de-vig. Only when no sharp book posts both sides does the code fall back to a sharp-consensus pair. The spread/total anchor (Section 5.2) averages the Pinnacle and Circa no-vig prices at equal weight.

**[Oct 18 — changed]** The two-way de-vig itself is now the **power method**: solve for exponent k such that `i1^k + i2^k = 1`, with each fair price equal to `i^k`. The era code used proportional de-vig (`implied ÷ sum of implieds`), which under-shrinks longshots. Multi-outcome de-vig elsewhere in the file remains proportional; the two-way pair that sets `fair_sharp_p` is power.

Code: `netlify/functions/lib/omega-vnext/edge.js` (`sharpFairForSide`, `noVigForBook`, `noVigPinnacleCircaImplied`); `odds_math.js` (`noVigTwoWay` — power method; `deVigMarket` — proportional, multi-outcome only); `config.js` (`SHARP_BOOKS`).

---

## 7. Selection Gates

**[Era]** Every candidate must pass every gate below or it is rejected with a named reason. There is no lean pool and no revival path — `LEAN_PAD` is a plain `false`.

| Gate | Rule (live values) | Reject reason |
|---|---|---|
| Same ET day | Commence time must fall on the card ET date; missing commence time also fails | `not-same-et-day` / `missing-commenceTime` |
| Pregame only | Game must not have started (5-minute grace; replay judges against the snapshot instant) | `in-progress-or-started` |
| Odds present and in band | American odds must exist and sit between −300 and +300 | `no-odds` / `odds-out-of-band` |
| Major liquidity | At least one major liquidity book (DraftKings, FanDuel, BetMGM, Caesars, WilliamHill US, ESPN BET, Pinnacle) must offer the market | `insufficient-liquidity` |
| Cover-probability floor | `coverProb` ≥ 0.48 (MLB, NFL, NCAAF, default) | `coverProb-floor` |
| EV floor (stake-EV) | EV at the best US price ≥ 3.0% (MLB, NCAAF, NBA, NHL, default); NFL ≥ 2.5% | `ev-floor` |
| Predicted CLV | Predicted CLV must be non-negative (≥ 0 cents) | `predictedClv-negative` |
| Positive edge | Calibrated edge vs fair (`coverProb − fair_sharp_p`) must be > 0 | `nonpositive-edge` |
| Adverse steam | Open→now steam against the pick past generate thresholds (18 cents, or 1.0 point Spread/Total) rejects | steam reason from line path |
| US placeability | The published price must be offered within the juice ballpark (≤3 implied points worse OR ≤15 American cents worse; a better price always counts) at ≥2 US retail books | `placeability-soft-veto` |
| Football Lock data **[Oct 18]** | NFL/NCAAF only: missing formula line or missing Pinnacle receipt line is a mandatory pass | `lock-missing-data` |

**[Era]** Steam toward the pick and prediction-market disagreement never gate a pick in or out. They are score-only nudges at ranking time (Section 8), hard-capped so they cannot outrank the sportsbook spine.

Code: `netlify/functions/lib/omega-vnext/gates.js` (`gateReason`, `applyGates`); `config.js` (`GATES`, `PLACEABILITY`, `LINE_MOVE`); `edge.js` (`assessPlaceability`).

---

## 8. Ranking, Grades, and Selection

### 8.1 Ranking score

**[Era]** Candidates passing the gates (the YES pool) are ranked by quality score, not by raw EV:

- Quality score = calibrated edge (fraction) + a residual-CLV nudge (clamped CLV × 0.0005, worth at most 0.15 percentage points) + a small uncertainty nudge (at most ±0.1 points).
- Score-only additions: steam toward (+0.03) / steam against (−0.04) where annotated; prediction-market soft score clamped to ±0.03 (moneyline only); a 0.02 sport-mix bonus for a sport not yet on the card.
- A +180 underdog therefore cannot outrank a better edge merely by having a larger raw EV. Raw EV sizes the bet (Section 9) and gates the pick (Section 7); it does not rank it.

Code: `netlify/functions/lib/omega-vnext/select.js` (`scoreCandidate`); `odds_math.js` (`qualityScore`); `config.js` (`SELECT_WEIGHTS`, `PM_SOFT`).

### 8.2 Letter grades

**[Era]** The published letter grade is pick quality — calibrated edge band — not stake size and not hit rate:

| Grade | Calibrated edge |
|---|---|
| A+ | ≥ 5.0% |
| A | ≥ 3.5% and < 5.0% |
| A− | ≥ 2.0% and < 3.5% |
| B | < 2.0% (no B+ on the quality path) |

Exact band edges (5.0 / 3.5 / 2.0) take the higher grade. Confidence maps from the grade (A+ 90, A 82, A− 75, B+ 68, B 60). Trimming a stake for the daily budget never downgrades the grade.

**[Oct 18 — added, display alongside]** NFL/NCAAF picks additionally carry a `lockGrade` of A when the Lock receipt is complete (formula line and receipt line present, gate-enforced). The era letter grade above is untouched and remains the displayed grade; the Lock stamp rides in the card data.

Code: `odds_math.js` (`qualityToRating`, `unitsToRating` is legacy and not the quality path); `config.js` (`QUALITY_GRADE`); `select.js` (`toPickObject` — era rating plus the **[Oct 18]** `lockGrade` stamp).

### 8.3 Selection

**[Era]** Greedy diversification: walk the ranked YES pool, take at most one pick per game, stop at 3 straights. A pool with fewer qualifying games stays short. Nothing pads the card.

Code: `select.js` (`selectStraights`, `orderedByScore`).

---

## 9. Sizing — Kelly, Caps, and Daily Budget

**[Era]** Each straight is sized by fractional Kelly on its calibrated probability at its published price:

1. Full Kelly `f = (b·p − q) / b`, where `p = coverProb`, `b = decimal odds − 1`, `q = 1 − p`. Non-positive Kelly sizes to zero.
2. Quarter Kelly is applied (`KELLY_FRACTION = 0.25`).
3. Kelly fraction converts to units at roughly 1% of bankroll ≈ 1.0u (unit = $150 against a ~$15k roll feel), rounded to 0.25u steps, floored at 0.25u when positive, and capped per pick at **1.25u** (`MAX_STRAIGHT_UNITS_PER_PICK`).
4. Daily budget enforcement (`applyDailyUnitCap`): straights combined ≤ **3.5u**; parlay fixed at 0.5u; card total ≤ **4.0u**. Overage is removed from the lowest-grade, then lowest-quality, straights in 0.25u steps down to a 0.25u floor. A higher grade must never carry less stake than a lower grade on the same card — the trim lifts the better pick into remaining headroom first, then trims the lower pick. The card may finish under budget; it is never topped up.

In practice, because most qualifying probabilities sit in the clipped 0.42–0.58 band at near-even prices, quarter-Kelly stakes frequently land at or near the 1.25u cap. That flattening is a property of the era sizing as built, not a separate rule.

Code: `odds_math.js` (`kellyFraction`, `kellyToUnits`); `select.js` (`toPickObject`, `applyDailyUnitCap`); `config.js` (`KELLY_FRACTION`, `UNIT_DOLLARS`, `STRAIGHT_UNIT_BUDGET`, `PARLAY_FIXED_UNITS`, `DAILY_UNIT_CAP`, `MAX_STRAIGHT_UNITS_PER_PICK`).

---

## 10. Parlay Builder

**[Era]** The parlay is built from the same gated YES pool (positive-EV candidates only, same ET day):

- All 3-leg combinations (then 2-leg only if no clean 3-leg exists) are enumerated over the top 24 pool candidates by cover probability. A published ticket must be one leg per game — a 3-leg ticket is always three distinct games.
- Tickets rank by combined hit probability. Combined EV breaks an exact tie and nothing else.
- A clean 3-leg is published whenever one exists; a 2-leg is the fallback. Stake is fixed at **0.5u** regardless of price.
- The ticket is flagged independent vs straight-mirror depending on whether every leg duplicates a published straight. Legs are displayed sorted by grade, then quality, then units, each with its own grade.

**[Oct 18 — changed]** Combined probability now takes a correlation haircut before EV: `combinedProb ×= 0.95^(legs − 1)`. Era code multiplied raw leg probabilities as if fully independent, which overstated combined probability and ticket EV.

Code: `netlify/functions/lib/omega-vnext/parlay.js` (`optimizeParlay`, `comboStats` — haircut marked in code; `preferHit`, `parlayIsCardMirror`).

---

## 11. Books and Pricing Display

**[Era]** Candidates are priced at the best captured US retail price at the bet line. US priority order: DraftKings, FanDuel, BetMGM, Caesars, WilliamHill US, ESPN BET, Hard Rock Bet, BetRivers, Fanatics, then Bovada. Sharp books (Pinnacle, Circa, Bookmaker, BetOnline, LowVig) set the fair price and CLV context; they are never the displayed execution price. The published price must additionally survive the placeability gate (Section 7): actually offered, within the juice ballpark, at two or more US retail books.

**[Oct 18 — fixed]** The book that supplied the published price is now named on the public card. The pick always carried `book` (plus `displayBook` / `executionBook` where present) in the stored blob; the public endpoint's field whitelist was stripping it. The whitelist now keeps those fields, so fans see, for example, a price at FanDuel, WilliamHill US, or DraftKings named on the pick itself.

Code: `edge.js` (`bestPrice`, `enrichCandidateWithEdge`, `assessPlaceability`); `config.js` (`US_BOOK_PRIORITY`, `US_BOOKS`, `MAJOR_LIQUIDITY_BOOKS`, `SHARP_BOOKS`); `netlify/functions/lib/public-picks.js` (`PICK_KEEP` — book fields added **[Oct 18]**).

---

## 12. Published Card and Endpoint Behavior

**[Era]** The generator writes the full blob to the `edge-picks-omega` store under `picks-{date}`, with an overwrite guard: a scheduled morning run force-overwrites a same-day overnight preview, while a non-forced duplicate write is refused (HTTP 409) rather than silently replacing a locked card. Shadow runs write only `omega-shadow/picks-{date}` and never touch the live keys.

**[Era]** The public endpoint `get-picks-omega`:

- With no date: serves the newest stored date with real picks, up to tomorrow ET (a Monday evening can serve an already-generated Tuesday card). If today/tomorrow has no card, it sticks to the most recent prior day with picks — the page never blanks at midnight before the morning run. A generated "No Qualifying Plays Today" card counts as a real card and is served as itself.
- With `?date=YYYY-MM-DD`: sticky to the nearest prior day with picks, unless `?forceEmpty=1`, which serves that exact date honestly (including its empty card).
- Responses are trimmed for the public: candidate table, model projections, thinking text, SGPs, rejections, and Kelly internals are dropped from the payload (they remain in the stored blob). Cache: 60 seconds public (10 seconds while generating), with stale-while-revalidate.

**[Oct 18 — changed in payload]** Two display reconciliations ride in the pick objects the endpoint serves:

- Probabilities print to a **tenth of a percent** (`coverProb`, `winProbability`: e.g. 56.7%, not 57%), so a reader recomputing EV from the printed probability gets the printed EV. EV and Edge already printed to a tenth.
- NFL/NCAAF picks carry the Lock receipt fields (`lockGrade`, `lockFormulaLine`, `lockReceiptLine`, `lockAvailability`) through the public whitelist.

**[Era]** The Edge badge on the card is the calibrated edge after shrink: `coverProb − fair_sharp_p` (fallback: `coverProb − book implied`). It is not predicted CLV in cents, not the raw projector probability, and not the full-Kelly EV percentage. True EV at the posted price (`ev`) is carried separately and is what gates and Kelly use.

Code: `netlify/functions/get-picks-omega.js`; `lib/public-picks.js` (`publicPicksPayload`, `PICK_KEEP`, `PARLAY_KEEP`, `ROOT_DROP`); `lib/omega-live-date.js`; `lib/no-plays.js`; `omega-vnext/store.js` (`storePicks`, overwrite guard); `select.js` (`toPickObject` — tenth-percent printing marked **[Oct 18]** in code); `edge.js` (`attachEv`).

---

## 13. Narration and Verification

**[Era]** After selection and QA hard-fails, Claude writes the fan-facing copy (straights, parlay legs, Daily Edge summary) and verifies each locked straight: accept by default, reject only for concrete disqualifying news (star out, starter scratch, severe weather, material lineup change). Claude does not choose picks, does not choose replacements, and — by explicit instruction — does not reject a football pick over QB status, because QB status is handled in the model layer (now flags-only, Section 5.4). A separate 10:30 AM ET verify pass re-checks prices and placeability and drops (never refills) any pick that fails; the parlay is cleared whole if any leg fails.

Code: `omega-vnext/narrate.js` (`narrateAndVerify`); `omega-vnext/qa_hardfail.js`; `netlify/functions/verify-picks-omega.js`; `edge.js` (`applyPlaceabilityDrops`).

---

## 14. October 18 Compliance Deltas — Listed Separately

Everything in this section was added to or changed in the restored era code on October 18, 2026 (commits `7e99d66` and `5a91c44`). Nothing here is era-original. The live card published at 1:57 PM ET on October 18 was generated before these fixes bit; they govern the next generate, not that card retroactively.

| # | Delta | Era behavior | Live behavior since Oct 18 | Code |
|---|---|---|---|---|
| 1 | QB hand points off | QB out/doubtful moved margin (NFL 3.0 / NCAAF 3.5 pts), total (−1.5 / −2.0), and uncertainty | `QB_MARGIN_SCALE = 0` — all three multiply to zero; status survives as flags/notes only | `config.js`; `sports/game_day.js` `qbSoftAdjust` |
| 2 | Power de-vig | Proportional two-way de-vig | Power de-vig (solve k, fair = i^k) for the two-way fair price | `odds_math.js` `noVigTwoWay` |
| 3 | Football formula + receipt tracing | No formula/receipt fields on candidates | NFL/NCAAF candidates carry `lockFormulaLine` (ratings projection) and `lockReceiptLine` (Pinnacle line at the bet) | `edge.js` `enrichCandidateWithEdge` |
| 4 | Missing-data mandatory pass (football) | No equivalent gate | Missing formula or receipt ⇒ reject `lock-missing-data` | `gates.js` `gateReason` |
| 5 | Parlay correlation haircut | Raw independence product | `combinedProb ×= 0.95^(legs−1)` before EV | `parlay.js` `comboStats` |
| 6 | Lock Grade A stamp | Not present | Verified NFL/NCAAF picks carry `lockGrade: A` plus receipt fields in card data; era letter grade unchanged and still displayed | `select.js` `toPickObject`; `public-picks.js` |
| 7 | Book named on fan card | Pick carried the book; endpoint stripped it | `book` / `displayBook` / `executionBook` kept in the public payload | `public-picks.js` `PICK_KEEP` |
| 8 | Tenth-percent probabilities | Probabilities printed whole (57%) next to tenth-percent EV | `coverProb` / `winProbability` print to a tenth (56.7%) | `select.js` `toPickObject` |
| 9 | No-leans hardening | Lean force-fill already off in era code | `LEAN_PAD = false` confirmed as a plain constant with no revival path in the live selection path | `config.js`; `select.js` |

Deliberately **not** changed on October 18: shrink weights and band clip (Section 5.3), anchor blend weights (5.2), EV and cover-probability floors (Section 7), grade bands (8.2), Kelly fraction, per-pick cap, and the 3.5u + 0.5u budget (Section 9). Those remain era-original values.

---

## 15. What Omega Does Not Do

- **[Era]** No lean force-fill. An empty or short card is published as-is.
- **[Era]** No self-optimizing mutation. Calibration reporting and the walk-forward observer write observer stores only; `FIT` is off and no report steers live weights.
- **[Era]** No soccer, no props, no SGP product on the Omega card. NBA is coded but disabled.
- **[Era]** No price invented from a single sharp book. The displayed price is a US retail price that passed placeability at two or more US books.
- **[Era]** Claude never selects, replaces, or re-prices a pick. News-based rejection at narrate/verify drops the pick; the slot stays empty.
- **[Oct 18]** No hand-set QB points anywhere in the probability path (Section 5.4). No NFL/NCAAF pick publishes without its formula line and Pinnacle receipt line (Section 7).

---

## 16. Code Map

| Concern | File |
|---|---|
| Generate entry (thin wrapper) | `netlify/functions/generate-picks-omega-background.js` |
| Pipeline orchestration | `netlify/functions/lib/omega-vnext/index.js` |
| All live constants (weights, gates, caps, books) | `netlify/functions/lib/omega-vnext/config.js` |
| Odds/ESPN/standings/injury ingest | `netlify/functions/lib/omega-vnext/ingest.js` |
| Sport projectors | `netlify/functions/lib/omega-vnext/sports/nfl.js`, `cfb.js`, `mlb.js`, `nhl.js`, `sports/_common.js`, `sports/epa.js` |
| Game-day adjustments (rest, QB flags) | `netlify/functions/lib/omega-vnext/sports/game_day.js` |
| Fair price, placeability, EV/edge attach | `netlify/functions/lib/omega-vnext/edge.js` |
| Shrink + band clip | `netlify/functions/lib/omega-vnext/calibrate.js` |
| Gates | `netlify/functions/lib/omega-vnext/gates.js` |
| Ranking, grades, Kelly sizing, budget cap | `netlify/functions/lib/omega-vnext/select.js`, `odds_math.js` |
| Parlay builder | `netlify/functions/lib/omega-vnext/parlay.js` |
| Line path / steam | `netlify/functions/lib/omega-vnext/line_path.js`, `capture_runner.js` |
| QA hard-fails, narration/verify | `netlify/functions/lib/omega-vnext/qa_hardfail.js`, `narrate.js` |
| Store + overwrite guard | `netlify/functions/lib/omega-vnext/store.js` |
| Public endpoint + payload trim | `netlify/functions/get-picks-omega.js`, `netlify/functions/lib/public-picks.js`, `lib/omega-live-date.js`, `lib/no-plays.js` |
| Schedules | `netlify.toml` |

---

*End of spec. This document describes the live Omega code as read on October 18, 2026. If the code changes, this document must change with it — the code governs, and any drift between the two is a defect in this document.*
