# Omega final QA — 2026-09-22

Reviewer: Grok Build, grok-4.7 (xhigh). Read-only. No production code change.

Live target on `main` @ `eaeffa5` (PR #86): `MODEL_VERSION = v12.3.8-omega-vnext-engines-build` in `netlify/functions/lib/omega-vnext/config.js`.

Tomorrow’s card is Wednesday 2026-09-23 ET. September is still EDT (UTC−4). DST ends 2026-11-01. Every Omega cron below is a UTC schedule that is correct **only while EDT holds**.

## A. Critical / ship-blockers for tomorrow

None found that would clearly break the 2026-09-23 card (empty overwrite, wrong sport on, FIT on, TSP steering picks, published units > 4, live write of the wrong day).

Checked and holding:

- `SPORTS_ENABLED`: MLB/NFL/NCAAF `true`; NBA/NHL `false`. `nba.project` / `nhl.project` return `[]`. Ingest and capture skip disabled sports unless `includeDisabled` (cron does not set it).
- `FIT_ENABLED = false`, `OBSERVER_ONLY = true` in `walk_forward.js`. `proposeFit()` returns `null`. Generate does not import walk-forward or `self-optimize-params`.
- No `tsp-live` / `tsp-research` require under `omega-vnext/`. `TSP_FETCH_ON_HOLD = true`. `fetch-tsp-live` schedule is commented. `monitor-tsp-public-records` writes `tsp-research` only.
- `LEAN_PAD = false`. Generator does not force-fill. Empty card sets `noPlays` and clears parlay legs.
- Unit caps: straights ≤ `STRAIGHT_UNIT_BUDGET` 3.5, parlay `PARLAY_FIXED_UNITS` 0.5, card ≤ `DAILY_UNIT_CAP` 4.0, per straight ≤ `MAX_STRAIGHT_UNITS_PER_PICK` 1.25. Verify `enforceOmegaDailyUnitCap` uses the same 3.5 / 0.5 / 4.0 and runs inside `updatePicksBlob`.
- `trigger-picks-omega` sends `force: true` with **no date**. Generate dates with `todayET()` (`America/New_York`). Overwrite is same-day `picks-{date}` only. Shadow uses `omega-shadow/picks-{date}` and never `latest-date`.
- Capture-health hard-fail throws `CAPTURE_HEALTH` (HTTP 503) **before** `storePicks` when usable snaps = 0. A failed morning does not blank yesterday’s blob. `get-picks-omega` stickies the newest prior day with real picks (`lib/omega-live-date.js`).

## B. High (fix soon, not tomorrow-blockers)

1. **Verify replacement sizing is still the v10 alpha ladder.** `verify-picks-omega.js` `cappedKellyUnits` floors at 0.5u, caps ML from blob `edge-picks-omega/alpha-config` `mlUnitCap` (0.5–2.0, default 0.5), totals at 1.5u, spreads at 1.0u. `buildQualityReplacement` overwrites `toPickObject` quarter-Kelly units with that ladder. Backfill and math-critical replace use it. The 4.0u card cap still clamps the published total, so this cannot print >4u. It **can** size a replacement unlike the generator (0.25 steps, 1.25 cap, quarter Kelly). `alpha-config` is not read by generate.

2. **Verify parlay rebuild can publish a wrong plus-price.** `optimizeParlay` sets type `N-leg-parlay-straight` when every leg is also a straight. Verify treats any type matching `/straight|fallback|verified/` as a card-mirror. If a leg was removed or the pick string misses `cardPickSet`, it rebuilds from the first 2–3 straights and sets `combinedOdds` to `` `+${(decimal-1)*100}` `` even when decimal < 2. Generator handles favorites. Rebuild also drops leg `rating` / `commenceTime` is copied, but the price string is not. Path is conditional; a clean independent `optimized` parlay is preserved.

3. **Verify NFL/NCAAF cover floor ≠ generator gate.** `candidateClearsSportGates` requires NFL/NCAAF `coverProb ≥ 0.52`. `GATES.minCoverProb` is 0.48 for every sport (`gates.js`). Backfill is stricter than generate. It will not add a sub-48% leg (candidate table is already the yes-pool). It can refuse a legal 48–52% football refill and leave the card short. MLB cover floor in verify is `0` (generator still applies 0.48 before the table exists).

4. **Close-grade sharp list ≠ open-print sharp list.** Generate `SHARP_BOOKS` = pinnacle, circa, circasports, bookmaker, betonlineag, lowvig. `track-clv-omega.js` `SHARP_BOOKS` = pinnacle, **betfair_ex_eu, betfair_ex_uk, betfair, matchbook**, circasports, circa, bookmaker. Pinnacle wins when present. If Pinnacle is missing, KPI close can anchor an exchange before Circa/Bookmaker. `CLV_KPI_FLOOR = 2026-09-22`, so tomorrow’s settles start the empirical sample. Do not retune shrink off that mix.

5. **Spread/total blend anchor is not the sharp book.** NFL ML blends to Pinnacle (else first price) at weight 0.5 (`nfl.js`). NFL spread/total and the matching NCAAF/MLB total paths blend to `prices[0]` (bookmaker order), weight 0.50 / 0.45 / 0.40, **before** `calibrate.js` shrinks toward no-vig sharp (`SHRINK_K` ML 0.73, spread 0.68, total 0.58). A juiced retail price in slot 0 moves `modelRawP` halfway, then shrink only partly undoes it. ML is in better shape. Not a wrong-sport or unit bug.

6. **Line-path append is read-modify-write with no lock** (`storeLinePoll` in `line_path.js`). 13:00 UTC capture and a slow run overlapping the 13:05 shadow health-retry (retry calls `runOmegaLineCapture` with `etSlot = hhmmET(now)`, e.g. `0905`, not a canonical slot) can drop a poll. One usable snap is enough to avoid hard-fail. Missing 0600/0730/0900/0915 warns and continues, so steam can be measured off a short path.

7. **UTC crons assume EDT.** After 2026-11-01 (EST, UTC−5) the same schedules fire one hour earlier ET: generate 8:30am, verify 9:30am, captures 5:00/6:30/8:00/8:15. Circa’s own comment already flags the November shift. Not in force tomorrow.

8. **`test-sharp-90-gates.js` is stale and aborts.** It asserts `MODEL_VERSION === v12.2.1-omega-vnext-placeability`. Actual is v12.3.8, so the rest of that smoke (gates + parlay) never runs. Other Omega tests passed (see D).

9. **No evening walk-forward resample.** `capture-omega-walkforward` is only `15 15 * * *` (11:15am ET). Same-day closes land via `trigger-clv` at 17:00 and 23:00 UTC (1:00pm / 7:00pm ET) and the 07:00 UTC overnight settle, but WF does not read them until the next morning’s yesterday pass. That is safe (observer, `FIT_ENABLED` false). It is not an evening KPI close.

## C. Medium / polish

- `netlify.toml` NFL comment still says “Omega 9:00”. Omega generate is **9:30 ET** (`30 13 * * *`). NFL `5 13`, CFB `10 13`, shadow `5 13` share the 9:05–9:10 window with the 9:00/9:15 Omega snaps. Separate stores (`edge-picks-nfl`, `edge-picks-cfb`). Odds quota burst, not a shared card.
- `verify-picks-omega.js` file header still says the user always sees 3 picks. Comment at the auto-fix summary still says “enforce 5u”. Constants are 4.0. Sharp-review card mutation is behind `if (false && …)` (advisory only). Good.
- `selectStraights` sorts once without the sport-mix bonus, then applies `softSportMixBonus` 0.02 only on the already chosen row. Mix does not change who is greedy-picked.
- Parlay objective is hit probability + 0.15×EV (`parlay.js`), not predicted CLV. 3-leg preferred; 2-leg only if clearly better. Fixed 0.5u.
- `unitsToRating` still exported from `odds_math.js` (A+ at ≥1.25u). Live grade path is `qualityToRating` (edge bands 5.0 / 3.5 / 2.0). Verify tests assert it does not assign ratings. Dead on the Omega card.
- `QUALITY_GRADE` CLV term moves the score by at most ~0.15 percentage points (`qualityScore`). Grades are almost pure calibrated edge. Fine, and easy to misread as a CLV grade.
- `isotonicClip` band 0.42–0.58, 25% of the excess kept. Combined with high `SHRINK_K`, published edges stay small. Empty or 1-play MLB Wednesdays are the intended output, not a failure.
- Capture union `0,30 10,11 * * *` also fires 10:30 and 11:00 UTC; handler no-ops unless within ±5 min of `ALLOWED_UTC_HHMM` `1000|1130|1300|1315`. 13:30 is not a capture slot. Correct.
- PM soft-fail and missing `omega-pm-observer/{date}-open` leave `_pmScoreAdj = 0` and `pmMove` unused. Generate continues.
- `self-optimize-omega` Sunday `0 9 * * 0` (5:00am ET) writes `edge-picks-omega/self-optimize-params` for humans. Next run 2026-09-27. Generator does not apply it. Leave it that way.
- Wednesday 2026-09-23 is an MLB card. NFL is Thursday; NCAAF is mostly Saturday. Engine caps still matter, but tomorrow’s ROI is the MLB SP/park/bullpen path plus gates.

## D. Confirmed healthy (elite-ready pieces)

Ran on this tree (node, no network):

| Test | Result |
|---|---|
| `test-omega-vnext.js` | PASS — version, 4.0u cap, 3 straights, 3-leg parlay, edge = coverProb − fair sharp |
| `test-omega-sport-engines.js` | PASS — NBA/NHL off, caps, soft-fail on a null event (`mapGamesSoft`) |
| `test-omega-linemove.js` | PASS — steam 18c generate / 20c verify |
| `test-omega-pm-observer.js` | OK — score cap, no locked-pick mutation |
| `test-tsp-research-observer.js` | OK — hold true, blob `tsp-research`, model v12.3.8 |
| `test-omega-walkforward.js` | PASS — `fitEnabled: false`, floor `2026-09-22`, earliest fit `2026-09-29` |
| `test-omega-gates-asof.js` | PASS — replay asOf vs live `Date.now()` |
| `test-omega-live-date.js` | PASS — sticky prior day, no far-future live serve |
| `test-omega-placeability.js` | PASS — ≥2 US books, juice ballpark |
| `test-omega-clv-qa.js` | PASS — SP scratch, QB out, stale, adverse steam |
| `test-omega-game-day.js` | PASS |
| `test-omega-replay.js` | PASS — dry-run, missing closes stay null |
| `test-omega-ux-live-kpi.js` | PASS |
| `test-sharp-90-gates.js` | **FAIL** — version pin only (B8) |

Spine for Wednesday 2026-09-23 (EDT):

| ET | UTC cron | Function | Writes |
|---|---|---|---|
| 6:00 | `0,30 10,11` (10:00 kept; 10:30/11:00 no-op) | `capture-omega-lines` | `omega-line-snap` / `omega-line-path` |
| 7:30 | 11:30 | same | same |
| 8:30 | `30 12` | `capture-omega-pm-observer-open` | `omega-pm-observer/{date}-open` |
| 9:00 | `0 13` | `capture-omega-lines-late` and `warm-omega-feeds` | snaps; `omega-feed-warm/{date}` (not the card) |
| 9:05 | `5 13` | `trigger-omega-shadow` | `omega-shadow/picks-{date}` only |
| 9:15 | `0,15 13` (13:15) | `capture-omega-lines-late` | snaps. 13:30 deliberately absent |
| 9:30 | `30 13` | `trigger-picks-omega` `force:true` | `edge-picks-omega` `picks-{todayET}` |
| 10:15 | `15 14` | `capture-omega-pm-observer` | audit log, does not resize the card |
| 10:30 | `30 14` | `verify-picks-omega` | same-day blob, cap re-applied |
| 11:00 | `0 15` | `monitor-tsp-public-records` | `tsp-research` only |
| 11:15 | `15 15` | `capture-omega-walkforward` | `omega-walkforward/*` only |
| 1:30pm | `30 17` | `confirm-starters-mlb` | SP scratch vs Alpha + Omega |
| 1:00pm / 7:00pm / 3:00am | `0 17,23` and `0 7` | `trigger-clv` → `track-clv-omega` | CLV / settle |

Config that is actually on:

- Kelly `KELLY_FRACTION = 0.25`. Display units = quarter-Kelly × 100, 0.25 steps, cap 1.25 (`kellyToUnits`).
- `SELECT_WEIGHTS`: EV 0.35, CLV 0.45, uncertainty 0.20, corr 0.15. CLV is `predictedResidualClv` else `predictedClv`, divided by 100.
- PM score: `0.20 * pmVsBookGap + 0.08 * pmMove`, hard cap `±0.03` (`PM_SOFT`). Moneyline, clean 1:1, venue average. Does not touch coverProb, edge, gates, Kelly, grades, units.
- Engine caps (`ENGINE_SOFT`): MLB bullpen ±0.35 runs / ±0.40 total, std tighten ≤ 0.10; NFL stacked margin ±1.50; NCAAF talent+QB stack ±2.00. Missing feed → adj 0.
- Gates: NFL EV 0.025, else 0.03; cover 0.48; odds −300..+300; same ET day; pregame + 5 min; adverse steam 18c / 1.0 pt; placeability ≥2 of DK/FD/MGM/Caesars/William Hill/ESPN BET/Hard Rock/BetRivers/Fanatics within 3pp or 15c.
- QA hard-fail before narrate: stale 15c / 1 pt, QB out/doubtful, MLB SP scratch. Claude may cut straight units up to 50%, may not raise them (`narrate.js`).
- Env that must exist at runtime (not in repo): `ODDS_API_KEY`, `NETLIFY_AUTH_TOKEN`. Narrate falls back if `ANTHROPIC_API_KEY` is missing (unit test hit that path). `OMEGA_OPS_WEBHOOK_URL` is optional. `TSP_SESSION_COOKIE` is not on the Omega path.

## E. Percentiles vs an elite sharp desk

Honest vs a Pinnacle/Circa-adjacent desk that bets closing-line value with a fitted model. Not a marketing score.

| Lens | Percentile | Why |
|---|---|---|
| Processes | 74 | Morning snap → shadow → force generate → verify → isolated TSP/PM/WF is a real desk schedule, and the dangerous switches (FIT, TSP, NBA/NHL, lean pad, >4u) are off. Gaps: EDT-only UTC crons, no evening WF, verify still carries a second sizing policy, one smoke test pinned to v12.2.1. |
| Architecture | 82 | vNext composer is separated from observers. Shadow, replay, WF, and TSP cannot write `picks-{date}`. Capture hard-fail fails closed. The 1,600-line verify function is still a second publisher with its own gates and parlay builder. |
| Math | 67 | No-vig shrink, quarter Kelly, steam gates, and a hard PM cap are the right shape. Kelly→units is a ×100 heuristic. Isotonic 0.42–0.58 is ad hoc. Shrink K is hand-set, not walk-forward. Spread/total blend uses `prices[0]`. Close book list includes Betfair ahead of Circa. Parlay ranks hit rate. No fitted CLV model until the Sep 29 gate, and that gate must stay off until the sample exists. |
| Overall | 73 | Safe to run tomorrow. It will pass more often than it bets, which is correct at this edge size. It is not yet a closing-line desk. |

## F. Remaining product roadmap

Ordered for CLV, not for feature count. ET dates.

### This week (Wed 2026-09-23 – Sun 2026-09-28)

1. Wed: let the 6:00/7:30/9:00/9:15 captures and 9:30 generate run. Do not hand-edit `picks-2026-09-23`. If capture health 503s, the site stickies Tuesday; fix `ODDS_API_KEY` / blobs, do not force a lean card.
2. Wed 10:30: read verify Discord. If it replaced a pick, check units came from `cappedKellyUnits` (B1) and parlay `combinedOdds` (B2). Do not hot-patch mid-slate unless the published number is a favorite priced as a plus.
3. Thu–Sun: log Pinnacle vs Circa vs the anchor `track-clv-omega` actually stored. Tag exchange anchors. Do not change `SHRINK_K`.
4. Sun 5:00am ET `self-optimize-omega` may write `self-optimize-params`. Do not wire it into generate.
5. Fix in a small PR, not during the 9:30 window: B1 (stop reading `alpha-config` for Omega units), B2 (favorite combined odds), B8 (version pin). B5 (blend to no-vig Pinnacle/Circa, not `prices[0]`) is the highest-leverage math fix this week if it stays a pure anchor change with the same weights.

### Next week (Mon 2026-09-29 WF gate)

1. Mon 11:00am ET is the earliest `FIT_EARLIEST` (`walk_forward.js`). Keep `FIT_ENABLED = false` unless samples since `CLV_KPI_FLOOR` 2026-09-22 have Pinnacle/Circa closes, n large enough to move K by a pre-registered amount, and a shadow week that does not lose CLV.
2. Default next week: still observer-only. A one-number shrink proposal in `omega-walkforward/reports/` is allowed. Applying it inside `calibrate.js` is not, until that shadow week exists.
3. Add one WF pass after the 7:00pm ET `trigger-clv`, or accept that closes are always one morning late. Do not fit on same-morning null closes.
4. Align `track-clv-omega` sharp priority with config `SHARP_BOOKS` (Pinnacle, then Circa, Bookmaker). Exchanges stay a labeled fallback.

### October (NBA regular season ~2026-10-20, NHL ~2026-10-06)

1. NHL regular season opens before NBA. Leave `SPORTS_ENABLED.NHL` and `.NBA` false through preseason. Turn each on only with a seed (goalie / rest for NHL, pace for NBA), the same shrink/gates/unit cap, and a shadow week. No shared “winter sports” flag.
2. November 1: move Omega UTC crons +1 hour (or schedule in ET if Netlify still cannot). Do this before the first EST Sunday slate, not after a silent 8:30am generate.
3. Engine depth: MLB bullpen is the live edge; NFL success-rate and NCAAF talent stay inside `ENGINE_SOFT` caps. Do not raise caps because a Saturday looked good.
4. Calibration: isotonic band and `SHRINK_K` move only off post-floor CLV, market by market. One market at a time.

### What NOT to do

- Do not point `self-optimize-params` or `omega-walkforward/fit` at live `coverProb`, gates, Kelly, or units.
- Do not lower `SHRINK_K` because edges look small. The isotonic clip is doing that on purpose.
- Do not feed TSP (`tsp-live` or public Performance Terminal) into `selectStraights`, grades, or units. Hold stays on.
- Do not turn NBA/NHL on for preseason.
- Do not raise `DAILY_UNIT_CAP` or backfill toward 3 with leans.
- Do not “fix” an empty Wednesday by force-fill. Empty is a valid card.
