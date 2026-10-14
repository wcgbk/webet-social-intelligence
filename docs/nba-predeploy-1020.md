# NBA pre-deploy identity, 2026-10-14

Compared the stored-board replay of `e84d5aa` (v12.3.74) with this branch after the sharp-price change (`cd402fc`). No Odds API call. `ODDS_API_KEY` was unset. Each day used `generate` with `dryRun`, `replay`, and `skipNarrate`. The ingest log on every day was `paidPull=0`. Nothing was written to `picks-{date}` or to a replay blob.

The canonical record is the straights, the parlay legs, and the replay grade (CLV cents, beat-close, settle result, profit). Timestamps that are "now" are not in the hash.

Window: the 30 ET dates 2026-09-14 through 2026-10-13. Two passes on this branch, flag off (`OMEGA_NBA` unset and `OMEGA_NBA_GENERATE_SHADOW` unset) and shadow on (`OMEGA_NBA_GENERATE_SHADOW=1`, still not on the card). Both matched the `e84d5aa` hash on all 30 dates. Mismatches: 0.

| Date | Straights | Parlay legs | Full card | Grade | Hash | vs e84d5aa |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-14 | 0 | 0 | no | no_picks | 4b9f247bea9f | match |
| 2026-09-15 | 0 | 0 | no | no_picks | de1b207df741 | match |
| 2026-09-16 | 0 | 0 | no | no_picks | 97fed8ae733d | match |
| 2026-09-17 | 0 | 0 | no | no_picks | 65faa5dba7e0 | match |
| 2026-09-18 | 0 | 0 | no | no_picks | 6906692f9b7b | match |
| 2026-09-19 | 0 | 0 | no | no_picks | 3d6334884c4d | match |
| 2026-09-20 | 0 | 0 | no | no_picks | 0bcff1a672e5 | match |
| 2026-09-21 | 0 | 0 | no | no_picks | 4096a3e38f28 | match |
| 2026-09-22 | 0 | 0 | no | no_picks | c5a1b90f2e80 | match |
| 2026-09-23 | 0 | 0 | no | no_picks | 18f790137034 | match |
| 2026-09-24 | 0 | 0 | no | no_picks | d6f1828c3f7d | match |
| 2026-09-25 | 0 | 0 | no | no_picks | b846f53a7180 | match |
| 2026-09-26 | 0 | 0 | no | no_picks | e406f36b0c6b | match |
| 2026-09-27 | 0 | 0 | no | no_picks | adf26e6e0726 | match |
| 2026-09-28 | 0 | 0 | no | no_picks | 5ed0961dd48e | match |
| 2026-09-29 | 0 | 0 | no | no_picks | cbbf2e914b06 | match |
| 2026-09-30 | 0 | 0 | no | no_picks | 0bb002546568 | match |
| 2026-10-01 | 0 | 0 | no | no_picks | 233d6aa838d3 | match |
| 2026-10-02 | 0 | 0 | no | no_picks | 4401e5e94994 | match |
| 2026-10-03 | 0 | 0 | no | no_picks | 7cf91de759ab | match |
| 2026-10-04 | 0 | 0 | no | no_picks | 28154d68bbb3 | match |
| 2026-10-05 | 0 | 0 | no | no_picks | 1880eaad264f | match |
| 2026-10-06 | 0 | 0 | no | no_picks | a7f0ddebf21b | match |
| 2026-10-07 | 0 | 0 | no | no_picks | 4fec9d543110 | match |
| 2026-10-08 | 0 | 0 | no | no_picks | 8885a6f352be | match |
| 2026-10-09 | 0 | 0 | no | no_picks | f5f5790c769b | match |
| 2026-10-10 | 0 | 0 | no | no_picks | b0c02be02f57 | match |
| 2026-10-11 | 0 | 0 | no | no_picks | 55fea51de4ae | match |
| 2026-10-12 | 0 | 0 | no | no_picks | 1e6fbbd0c02f | match |
| 2026-10-13 | 3 | 3 | yes | closes_missing | 5e01300f1c60 | match |

29 dates have no stored 10:00 board (`odds source=stored-10:00-missing`). They produce an empty card on `e84d5aa` and on this branch. That is the stored-board replay. It does not call the historical Odds API.

2026-10-13 is the date with a stored board (19 events, `paidPull=0`). It still publishes 3 straights and a 3-leg parlay. Prices, books, lines, and commence times match `e84d5aa`. The joined grade is `closes_missing` on both sides (no `clv-2026-10-13` blob). The grade fields in the hash are null on both sides.

Straights, DraftKings:

| Matchup | Market | Side | Line | Odds | Commence |
| --- | --- | --- | --- | --- | --- |
| Tampa Bay Lightning @ New York Rangers | Spread | New York Rangers +1.5 | 1.5 | -185 | 2026-10-13T23:25:00Z |
| Edmonton Oilers @ Los Angeles Kings | Spread | Edmonton Oilers -1.5 | -1.5 | +190 | 2026-10-14T02:40:00Z |
| Boston Bruins @ San Jose Sharks | Moneyline | Boston Bruins ML | — | -120 | 2026-10-14T03:10:00Z |

Parlay, 0.25u, three legs. The first leg is the existing auto-correct (Tampa Bay Rays -1.5, +168, MLB, commence 2026-10-14T00:00:00Z), then Rangers +1.5 and Bruins ML. That shape is the `e84d5aa` card. It did not change.

`SPORTS_ENABLED.NBA` stays false. `NBA_CARD_LIVE` stays false. `MODEL_VERSION` stays `v12.3.74-omega-vnext-price-lock`. `node test-omega-nba-engine.js` passed after the blend change.

## Deploy

Not deployed. No deploy id.

The clock at the check was 2026-10-14 14:27 ET, outside 10:00–11:00 ET and 02:45–03:15 ET, and the replay hashes match. The repo's deploy script is `deploy.sh`. It pushes `origin/main` and then runs `netlify deploy --prod` for site `87d7bcd9-e95a-479c-bc44-6432a2ffc606`. That is a production ship of the working tree, not a shadow deploy, and it would push main. This branch stays on `feat/nba-1020`.
