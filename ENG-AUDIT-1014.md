# Engineering audit 2026-10-14

Branch `fix/eng-90`. Base `e84d5aa` (`v12.3.74-omega-vnext-price-lock`). Not deployed. No Odds API pull. No Supabase writes. No deletes.

Scores are elite-desk judgments, the same four lenses as `/percentile`. Overall follows Math. They are not a results rank.

| Lens | Page 10/05 | `data/engineering-scores.json` 10/12 | User provisional | Now (this branch, not live) |
| --- | ---: | ---: | ---: | ---: |
| Processes | 89 | 87 | ~70 | 84 |
| Architecture | 88 | 86 | ~72 | 83 |
| Math | 85 | 86 | ~60 | 85 |
| Overall | 85 | 86 | ~60 | 85 |

Math stays 85. The empty 10/14 card was an engineering gate conflict already fixed on `e84d5aa`. This branch does not change selection, floors, prices, or grading. A 30-day replay was not run, so Math is not raised. Overall stays with Math.

## (a) Checklist

### Processes — 84

| Item | Result | Evidence |
| --- | --- | --- |
| 3:00 and 10:00 ET capture still the only morning Odds checks | Unchanged | `netlify.toml:279` `schedule = "0 7,8,14,15 * * *"`. `et-schedule.js` `capture-omega-pinnacle-lines` etTimes `03:00` and `10:00`. |
| 10:00 ET card cron unchanged | Unchanged | `netlify.toml:31` `schedule = "0 14,15 * * *"`. `trigger-picks-omega` etTimes `10:00`. |
| Nov 1 2026 fall-back and Mar 14 2027 spring-forward | Pass | `test-et-schedule-guard.js` windows `2026-10-25..2026-11-08` and `2027-03-07..2027-03-21`. `regrade-circa` 01:40 runs both fall-back copies (`dstFold: 'both'`). Every active toml schedule is in `ET_SCHEDULE`. `PASS test-et-schedule-guard`. |
| New coverage monitor uses both UTC hours | Added, not deployed | `netlify.toml:295` `20 14,15 * * *`. `et-schedule.js:120` etTimes `10:20`. Handler skips 10:00 ET (`test-omega-snapshot-coverage.js`). |
| 10/10 has no 3:00 or 10:00 ET Pinnacle cluster | Confirmed, not backfilled | Read-only PostgREST on `clv.odds_snapshots` for ET day 2026-10-10 (`commence` `2026-10-10T04:00Z` .. `2026-10-11T04:00Z`): 122 games, 0 NFL. NCAAF snapshot 46 and NHL snapshot 14 are all hour `10Z` (06:00 ET, `capture-opening-lines`). Closings are kickoff evening (`15Z`–`02Z`). No `07Z` (3:00 ET) and no `14Z` (10:00 ET). Next-morning window `2026-10-11T06:30Z..08:30Z` was 0. |
| Silent empty 10:00 board | Now alerts | `ingest.js:90` `opsAlert('stored-10:00-missing')` plus the existing info log. `PASS test-omega-final-fill-1014` still expects `snapshotNote=stored-10:00-missing` and zero fetches. |
| Close group after kickoff, missed event | Now alerts | `odds_master.js:732` `close-snapshot-after-commence`. `odds_master.js:766` `close-event-missed`. Fired inside `PASS test-omega-closes-baseline` without changing stored counts. |
| Failed read must not wipe a tape | Fixed in code | `pinnacle_line_move.js:1154` and `:1196` return `read-failed`. `odds_master.js:502` returns `read-failed` and writes nothing. |
| Overnight uncommitted work | Guard added, manual | `scripts/guard-uncommitted.sh`. `docs/PROCESS-GUARD.md`. No hook installed. After these commits the script printed `PROCESS GUARD: clean worktree on fix/eng-90`. |
| Idempotent morning card | Unchanged | `et-schedule.js` `morningCardIdempotency` still skips only when `generatedAt` is today ET at or after 09:20. Not modified. |
| Credit floor vs 3:00 closes | Unchanged | Capture comment and `capture_runner.js`: the 49,000 floor does not stop 3:00/10:00 checks or yesterday's closes. `PASS test-omega-closes-baseline` still pulls two historical groups under the floor. |

Processes is not 90. The 10/10 hole is historical. The monitor is not live until a deploy. The guard does not run unless someone invokes it. Stale toml comments still say the card does not lean-fill (`netlify.toml:35`) and that DST handling is only prepared. The running code is the UTC union plus `etGuard`.

### Architecture — 83

| Item | Result | Evidence |
| --- | --- | --- |
| Blob encode split | Fixed in code | Only `pinnacle_line_move.js` and `odds_master.js` full-encoded keys. `blob_key.js:15` `canonicalBlobKey` encodes segments and keeps `/`. `legacyEncodedBlobKey` is read-only. Writes use `blobRestUrl(..., 'canonical')` (`pinnacle_line_move.js:1030`, `odds_master.js:355`). `store.js:8`, `line_path.js`, `clv_candidates.js`, and `candidate_closes_v2.js` go through the same helper. `test-omega-blob-keys.js` asserts `netlify/functions` has zero `encodeURIComponent(key)`. `date/2026-10-14` stays distinct from `date%2F2026-10-14`. |
| Line-move date index showed one game | Root cause fixed in code | Last-write of one blob `date/${date}`, made worse when the SDK read of `date/...` hid the fuller `date%2F...` object and the next REST write rebuilt from the short doc. Not only an intra-run race (`storeCheck` is sequential). `ensureDateIndex` (`pinnacle_line_move.js:1041`) writes `date/${date}/event/${sport}/${eventId}` first, alerts and does not rewrite the aggregate on a thrown read (`marker-only`), and blocks a shrink. `readPinnacleLineMoves` unions markers when `list` is available. Injected tests that pass `read` and no `list` stay index-only. |
| Odds-master `by-date/` same pattern | Fixed in code | `touchDateIndex` (`odds_master.js:431`) writes `by-date/${ymd}/event/${sport}/${eventId}`, refuses a shrink, and skips the aggregate rewrite when the normalized rows are unchanged. `readMasterKey` unions markers only when the caller did not inject `read` without `list`. |
| Yesterday's closes follow the short index | Wired | `capture_runner.js:386` uses `readPinnacleLineMoves`. If the odds-master date list is longer, `capture_runner.js:406` alerts `date-index-short`. |
| Stored board fallback | Still there | `stored_board.js` still merges a short line-move index with `by-date/`. That remains a second path, not the fix. `test-omega-final-fill-1014.js` still expects key `by-date/2026-10-14`. |
| CLV Pinnacle close coverage | Diagnosed, not repaired | Read-only counts, schema `clv`. NFL 79/320 games (552 close rows). MLB 107/2383 (642). NCAAF 446/730 (2446). Also NHL 767/1016, NBA 637/769. Close orphans: 0. |
| Why NFL looks thin | Denominator includes the future book | NFL games/closes by month: 2026-09 64/48, 2026-10 92/31, 2026-11 70/0, 2026-12 62/0, 2027-01 32/0. Played NFL before `2026-10-14T04:00Z`: 127 games, 79 with a close, 48 missing. Null `commence_time`: 0. Duplicate catalog rows start about 2026-09-24 (twin `game_id`s, close on one). Sources: `oddsapi-historical` 211, `box` 61, `netlify:omega-line-path` 48. |
| Why MLB looks thin | Almost all rows have no kickoff | MLB null `commence_time` 2151/2383, all `source=netlify` (`netlify` rows 2155, null 2151). Kickoff-known MLB: 232 games, 107 with a close. NHL null commence 145, all `source=netlify`. NCAAF null commence 0. |
| Sync cannot fill those nulls | By design, left alone | `supabase-sync.js:11` insert-ignore, no update. `resolveGameId` (`supabase-sync.js:540`) uses the event id when present, else exact normalized home/away plus exact commence (`:557-566`) and skips ambiguous or unmatched names. In-memory commence fill does not update an existing row. A backfill would be an UPDATE. Not done. |
| Quota did not block the 3:00 close pull | Confirmed in code | The 49,000 floor stops opens, backfill, and extra pulls. It does not stop the 3:00 historical close. The suspended job is `capture-candidate-closes` (commented schedule, `no-et-schedule` in the DST test). |
| `snapshot-after-commence` drops the group | Still the rule, now logged | `odds_master.js` `storeHistoricalCloses` rejects the whole kickoff group. Prices are unchanged. The miss is no longer silent. |
| Team-name match | Secondary | Exact match misses are real but smaller than null commence, future games, duplicate ids, and the short date index. |

Architecture is not 90. The key and index bugs are fixed on the branch. The catalog rows, duplicate ids, and suspended kickoff closer are still in the data and the schedule.

### Math — 85

| Item | Result | Evidence |
| --- | --- | --- |
| Flat 2% stake-EV floor, edge curve not a gate | Holds | `edge_floor.js:94` `mainMinEv` ignores odds. `test-omega-final-fill-1014.js:19-36` and `:62-65`. `PASS test-omega-final-fill-1014`. |
| EV above 12% is stale, not published | Holds | Same test logs `ev-stale` and asserts the lean pool has no `ev-stale`. |
| Card shape | Holds | Three straights with lean fill at `0.5u` (`test-omega-final-fill-1014.js:131-143`). Parlay `LEAN_PARLAY_UNITS` 0.25 and 3 legs (`:28`, `:162-163`). |
| Straights price band | Holds | `-250..+250` asserted in that test. |
| Model version | Unchanged | `v12.3.74-omega-vnext-price-lock`. `PASS test-omega-replay` prints that version. |
| Files that price, select, or grade | Empty diff vs `e84d5aa` | `select.js`, `edge_floor.js`, `gates.js`, `parlay.js`, `odds_math.js`, `clv_grade.js`, `omega-grading-rules.js`, `get-results-omega.js`, `index.js`. |
| 30-day card replay | Not run | `scripts/replay-omega-cli.js` calls the paid historical Odds API. No offline fixture replay of 30 days exists here. Not run. |

The user provisional ~60 matches a day the card was empty. That failure mode is the gate conflict fixed in `e84d5aa` and covered by the fill test. It is not a change to the probability model. Math is not scored up, because this audit did not re-grade history.

### Overall — 85

Follows Math. Processes and Architecture moved on this branch. They do not lift Overall while Math stays 85.

## (b) Prioritized fixes

### Processes

1. Deploy `fix/eng-90` so `monitor-omega-snapshot-coverage` actually runs at 10:20 ET. This audit does not deploy.
2. Run `sh scripts/guard-uncommitted.sh` at the end of every session, or call it from CI. Do not rely on memory.
3. Investigate the 2026-10-10 capture miss from logs (function did not run, or it ran and wrote nowhere). The database has no 3:00 or 10:00 ET cluster that day. Do not re-pull paid odds to fill it from this audit.
4. Correct the stale schedule comments (`netlify.toml` "no lean force-fill", DST "prepared and not applied"). Behavior is already the union cron plus `etGuard`.
5. Teach the coverage monitor the season calendar so an offseason zero-game day does not page.

### Architecture

1. Keep the marker indexes. After deploy, confirm a slate with more than one game writes both `date/${date}/event/...` markers and a `date/${date}` aggregate that does not shrink.
2. Approved data repair, separate from this branch: fill null `commence_time` on `source=netlify` MLB (2151) and NHL (145). Sync will not do it. Insert-ignore leaves the null forever.
3. Approved data repair: merge duplicate NFL `game_id`s from about 2026-09-24 without changing a stored price.
4. Decide whether the suspended kickoff closer stays off. Yesterday's 3:00 historical close is the path that was under-fed by the short index.
5. Leave team-name matching exact until the commence and id problems are gone. Fuzzy names would attach closes to the wrong game.

### Math

1. Do not change floors, selection, or grading to chase the percentile.
2. When a replay is allowed, run an offline fixture replay, not `scripts/replay-omega-cli.js`, and diff published prices against the stored cards.
3. Keep Overall locked to that result.

## (c) Implemented

| Commit | What |
| --- | --- |
| `d863e2d` | Canonical blob keys. Line-move and odds-master date indexes write per-event markers, refuse to shrink, and do not rewrite the aggregate when the read throws. Yesterday's close list reads line-move markers. Ops alerts for a missing 10:00 board, a snapshot after kickoff, a missed close event, and a failed tape read. |
| `17bd989` | `monitor-omega-snapshot-coverage` at 10:20 ET. Cron `20 14,15 * * *`. Read-only. Writes `omega-ops/snapshot-coverage-${date}` only. |
| `939a885` | `scripts/guard-uncommitted.sh` and `docs/PROCESS-GUARD.md`. |
| (this file) | The audit. |

Tests, one file at a time, all exit 0: `test-omega-blob-keys.js`, `test-omega-snapshot-coverage.js`, `test-omega-final-fill-1014.js`, `test-omega-pinnacle-line-move.js`, `test-omega-closes-baseline.js`, `test-omega-candidate-closes-v2.js`, `test-et-schedule-guard.js`, `test-handler-arity.js` (246 handlers, length ≤ 2), `test-omega-replay.js`, `test-omega-supabase-sync.js`, `test-omega-late-news.js`.

## (d) Pre-deploy check

| Check | Result |
| --- | --- |
| Cheap 30-day replay shows a full card | Not run. The repo replay hits the paid Odds API. There is no offline 30-day fixture replay. |
| Grading, prices, schedules that already existed | Unchanged. Diff of the math and grading files listed above against `e84d5aa` is empty. `index.js` is empty. `netlify.toml` adds only `monitor-omega-snapshot-coverage`. `trigger-picks-omega` stays `0 14,15 * * *`. `capture-omega-pinnacle-lines` stays `0 7,8,14,15 * * *`. |
| Card contract on the fixture | `PASS test-omega-final-fill-1014`: flat 2% EV, lean fill to 3, 3-leg parlay at 0.25u, stored 10:00 board, no network fetch. |
| Price tape behavior under failure | A thrown index read does not publish a new price and does not replace the date aggregate (`PASS test-omega-blob-keys`). Successful quotes still write the same price keys. `PASS test-omega-closes-baseline` still expects 3 price keys on a duplicate role and zero writes on dry-run and `OMEGA_REPLAY_NO_WRITE`. |

Do not deploy from this audit.

## (e) Projected score

| Lens | Now | After this branch is deployed | After deploy plus the data repairs in (b) |
| --- | ---: | ---: | ---: |
| Processes | 84 | 88 | 91 |
| Architecture | 83 | 85 | 90 |
| Math | 85 | 85 | 85 |
| Overall | 85 | 85 | 85 |

Deploy moves Processes because the 10:20 monitor and the alerts start firing. It does not repair 10/10 or the null commence rows. Architecture reaches 90 only if those rows are repaired without changing a price. Math and Overall stay 85 until a replay or a separate math review says otherwise. 90+ overall by 10/20 is not the projection.

## (f) What remains

- Deploy is out of scope. Nothing here is on Netlify until someone else ships `fix/eng-90`.
- Supabase was read only. Null commence, duplicate NFL ids, and thin closes are still in the database.
- 2026-10-10 still has no 3:00 or 10:00 ET snapshot rows.
- Live blobs were not read. Whether `by-date/2026-10-14` is also one event is unknown.
- The process guard is a script. A session that never runs it can still lose uncommitted work.
- The coverage monitor alerts on zero games, including a true offseason day.
- Stale schedule comments were left in place so the cron lines that already exist were not edited.
- 30-day replay was not run.
- Pick math was not changed. The card is still 3 straights plus one 3-leg parlay. The 3:00 and 10:00 ET morning process is unchanged.
