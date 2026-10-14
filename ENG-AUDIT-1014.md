# Engineering audit 2026-10-14

Branch `fix/eng-90`. Base `e84d5aa` (`v12.3.74-omega-vnext-price-lock`). Repair commit `2171e0a` is on `main` and live. Deploy `6acfd4847f8a18e51916a2d9` at 15:14 ET. No Odds API pull. No deletes. No price overwrites.

Scores are elite-desk judgments, the same four lenses as `/percentile`. Overall follows Math.

| Lens | Prior on `eec47be` | Now |
| --- | ---: | ---: |
| Processes | 84 | 91 |
| Architecture | 83 | 90 |
| Math | 85 | 85 |
| Overall | 85 | 85 |

Math stays 85. Selection, floors, prices, and grading are unchanged versus `e84d5aa`. The offline replay matched that base on the one day that has a saved morning board. Overall stays with Math.

## Repair evidence

Cutoff for played-only coverage: `2026-10-14T19:04:31.485Z` (15:04 ET), stored in `backup.audit_meta_20261014`.

### Rows backed up before any write

| Table | Rows |
| --- | ---: |
| `backup.games_20261014` | 6224 (all `clv.games`, including MLB null 2151 and NHL null 145) |
| `backup.odds_snapshots_pinnacle_close_20261014` | 12070 |
| `backup.viewdefs_20261014` | 3 view definitions |
| `backup.audit_meta_20261014` | 1 before-coverage document |

### Rows changed

| Table | Change |
| --- | --- |
| `clv.games` | 2277 `commence_time` fills. MLB 2132, NHL 145. Existing non-null commence times overwritten: 0. |
| `clv.game_aliases` | 424 inserts. MLB 113, NCAAF 182, NFL 48, NHL 81. |
| `clv.odds_snapshots` | 0. Pinnacle closing checksum unchanged: 12070 rows, 2036 games, price sum `-687866`, point sum `361927.0`. Row-level price/point/game_id diffs versus the backup: 0. |

### Commence fill

Hash of every null MLB/NHL id matched a saved opening-lines slate (`2296/2296`). Snapshot time was not used as kickoff. A fill was written only when the slate date and the clock agreed within 2 minutes, the ET date fit the slate, and the match was one event.

| Sport | Filled | Unresolved |
| --- | ---: | ---: |
| MLB | 2132 `espn-scoreboard` | 19 |
| NHL | 145 `espn-scoreboard` | 0 |

MLB unresolved: 16 ESPN doubleheaders, 1 method conflict (odds-game time disagreed with ESPN), 1 ambiguous saved Netlify clock, 1 no source. `odds-game-same-date` and `netlify-commence` filled 0. Opening-lines files carry the slate date and no kickoff clock. NBA (119 null) and soccer were left null. They were outside this fill.

### Duplicate ids

No deletes and no price edits. Migration `supabase/migrations/20261014_game_aliases.sql` adds `clv.game_aliases`, `clv.canonical_game_id`, `clv.game_family`, and `clv.fill_game_nulls`. Row list: `supabase/migrations/20261014_game_alias_rows.sql`. Twins are the same sport, order-insensitive teams, and commence within 15 minutes. Canonical is the member with the only Pinnacle close, else `oddsapi` then `box` then `netlify`, else the stable id.

`clv.v_coverage` counts a family open or close. `clv.v_open_entry_close` attaches a family close only when that game has no close of its own. `clv.v_pinnacle_close_attach` exposes both, with `pref` 0 for own and 1 for family. `netlify/functions/lib/game-alias.js` is the same rule in process.

### Daily sync

`supabase-sync.js` still posts `resolution=ignore-duplicates`. Odds snapshot posts are insert-only. After a games insert succeeds, `clv.fill_game_nulls` sets only null `commence_time`, `home_team`, `away_team`, and `season`, at most 500 rows. A failed games insert does not call the fill. `PASS test-omega-supabase-sync`.

### Pinnacle close coverage

A game counts when it has at least one Pinnacle `closing` row, or, after the repair, a twin does. Played means `commence_time` before the cutoff.

| Sport | Before all | Before played | After all | After played |
| --- | ---: | ---: | ---: | ---: |
| MLB | 107/2383 (4.5%) | 107/231 (46.3%) | 210/2383 (8.8%) | 210/2363 (8.9%) |
| NBA | 637/769 (82.8%) | 637/650 (98.0%) | 637/769 (82.8%) | 637/650 (98.0%) |
| NCAAF | 446/730 (61.1%) | 446/641 (69.6%) | 628/730 (86.0%) | 628/641 (98.0%) |
| NFL | 79/320 (24.7%) | 79/127 (62.2%) | 127/320 (39.7%) | 127/127 (100%) |
| NHL | 767/1016 (75.5%) | 767/871 (88.1%) | 848/1016 (83.5%) | 848/1016 (83.5%) |

Soccer books stay 0/all. Their commence times were not filled. NBA did not gain a family close. The MLB played denominator grew because 2132 null kickoffs are now in the past. Most of those games still have no Pinnacle close on either twin. That is missing tape, not an id mismatch. NFL played is 127/127 after the alias attach. Raw price rows did not move.

## Replay

`scripts/replay-predeploy-30d.js` for 2026-09-15 through 2026-10-14. A day is replayed only when Supabase has a 3:00 ET snapshot (`07:00Z`, opening or snapshot) or a 10:00 ET snapshot (`14:00Z`, `line_type=snapshot`) on pinnacle, draftkings, or hardrockbet. The board is injected through `readPinnacleLineMoves`. `fetch` and `https`/`http` throw if the host is `api.the-odds-api.com` or a configured odds URL.

| | |
| --- | --- |
| Days in window | 30 |
| Replayed | 2026-10-13 (19 events on the 10:00 board) |
| Skipped | 29, including 2026-10-10 and 2026-10-14 |
| `fix/eng-90` and `e84d5aa` | 3 straights and a 3-leg parlay at 0.25u. Picks, prices, and grading fields identical. |
| Odds API requests | 0 (guard did not trip) |
| Schedules | `netlify.toml` adds only `monitor-omega-snapshot-coverage` at `20 14,15 * * *` |
| Result | Pass. Proof: `docs/REPLAY-30D-20261014.md` |

Math and grading files versus `e84d5aa` are an empty diff: `select.js`, `edge_floor.js`, `gates.js`, `parlay.js`, `odds_math.js`, `clv_grade.js`, `omega-grading-rules.js`, `get-results-omega.js`, `index.js`.

## Deploy

`npm test`: 131 passed, 0 failed, concurrency 1. Replay pass. Pre-deploy clock `2026-10-14 15:14 ET`, outside 10:00–11:00 and 02:45–03:15. Fast-forward merge of `fix/eng-90` into `main`, then `./deploy.sh`. No force-push.

| | |
| --- | --- |
| Deploy id | `6acfd4847f8a18e51916a2d9` |
| ET | 15:14 ET (live check 15:14:37 ET) |
| Live card | `get-picks-omega?date=2026-10-14` returned 3 straights and one 3-leg parlay at 0.25u. Model `v12.3.74-omega-vnext-price-lock`. |

## Why these scores

Processes is 91. The 10:20 ET coverage monitor is on the live schedule. The sync can fill a null kickoff without a second price write. The replay guard and the skip list are in the repo. It is not higher because 2026-10-10 still has no 3:00 or 10:00 snapshot, 29 of 30 replay days were skipped for that reason, and `scripts/guard-uncommitted.sh` still runs only when someone invokes it.

Architecture is 90. Null MLB and NHL kickoffs that were unambiguous are filled. Duplicate ids resolve through `clv.game_aliases` without a delete or a price change. NFL played Pinnacle-close coverage is 127/127 via that map. It is not higher because 19 MLB rows are still null, NBA and soccer null commence were left alone, and most historical MLB games have no Pinnacle close on either twin.

Math is 85. The card contract held on the replayed day and matched `e84d5aa` on picks, prices, and grading. The model was not changed, and 29 days had no saved morning board to re-grade. Overall follows Math.

## What remains

- 19 MLB `commence_time` values are still null (doubleheaders, one odds/ESPN conflict, one ambiguous Netlify clock, one with no source).
- NBA null commence (119) and every soccer row were not in this fill.
- 2026-10-10 still has no 3:00 or 10:00 ET snapshot. The replay skipped it on purpose.
- MLB Pinnacle closes are still thin after the alias attach (210 of 2363 played). The missing rows are absent tape.
- The process guard is a script. A session that never runs it can still lose uncommitted work.
- The coverage monitor still alerts on a true offseason zero-game day.
- This audit commit is after the deploy. Live code is `2171e0a`. The score writeup is the following commit.
