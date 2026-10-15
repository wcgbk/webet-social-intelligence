# Elite model report — 2026-10-14

## Deploy 1 — pure model probability

Commit `d5634a1c1aea92b7357fe8cd932dcc0d45fcfe7c`.
Netlify site `webet-ai-landing` (`webetsocial.com`).
Deploy id `6acffc7613cbfb8ea0ab4c15`.
State ready. Published `2026-10-14T22:05:11.080Z`.
Site check: `https://webetsocial.com/` returned 200. `/api/get-picks-omega?date=2026-10-14` returned the rebuilt card.

Owner fast path. Held-out profit and the 30-day replay were waived for this deploy only. Time of push was 6:04 PM ET, outside the 10–11 AM ET and 2:45–3:15 AM ET windows.

### Change

Published edge and EV now use the sport model's own probability.

- Edge = model probability − implied probability of the bet price.
- EV = model probability × decimal odds − 1.
- The bet is the better of DraftKings and Hard Rock on the same line.
- Pinnacle no-vig is kept on the row for CLV. It is not blended into the probability, not used as a shrink anchor, and not a selection gate.
- Removed from the card path: the market blend inside the priced probability, the point-shrink toward the sharp number, the hand-set shrink toward the sharp, line-move probability shifts, DraftKings lag lifts onto the Pinnacle no-vig, the Pinnacle power-fair replacement, and the Pinnacle gates (missing pair, sharp gap, steam, line-move drop).
- Grades stay on that edge alone: A+ ≥ 5%, A 3.5–5%, A− 2–3.5%, B under 2% capped at 0.5u. CLV does not move the grade.
- Stakes stay quarter-Kelly, rounded to the nearest 0.5u, capped at 1.25u by the existing per-pick cap and at 0.5u for grade B. A later change may tighten the A-grade cap to 1u only if a held-out backtest shows it raises profit and ROI.

`modelRawP` is still the old blended number so the engine unit tests keep their contract. The card reads `modelPureP`.

### Why

The live card was pricing edge from the Pinnacle power fair (`applySharpFair` on every generate). Before that, the sport probability was blended and shrunk toward the same book. That is the opposite of rule 1. The 10/14 card already on the site when this shipped was three grade-B leans at negative edge (−0.7%, −0.8%, −1.0%).

### 2026-10-14 card after the rebuild

Generated `2026-10-14T22:05:55.904Z` from the stored 10:00 ET board. No Odds API call. X autopost was not enabled. Dry run before the push and the live card match.

| # | Pick | Book | Odds | Model edge | Grade | Tier | Units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Brewers @ Dodgers Under 7.5 | Hard Rock | −115 | 3.6% | A | floor | 1u |
| 2 | Stars @ Avalanche Over 5.5 | DraftKings | −135 | 3.3% | A− | floor | 1u |
| 3 | Western Kentucky @ Sam Houston Over 52.5 | Hard Rock | −110 | 2.4% | A− | floor | 0.5u |

3-leg parlay, 0.25u, combined EV 18.0%, same three legs. Cover probabilities on the public card are 57%, 61%, and 55%. Those match edge against the bet price, not against the Pinnacle no-vig.

The third stake is 0.5u because quarter-Kelly at −110 and a 2.4% edge rounds to 0.5u. It is still grade A−, not a B lean.

### Before and after on the 2026-10-14 card

| | Before (generated 21:35Z) | After (generated 22:05Z) |
| --- | --- | --- |
| Straights | 3 leans, all grade B, all DraftKings | 3 floor picks, A / A− / A− |
| Edges | −0.7%, −0.8%, −1.0% | 3.6%, 3.3%, 2.4% |
| Units | 0.5u, 0.5u, 0.5u | 1u, 1u, 0.5u |
| Parlay | 3 legs, 0.25u | 3 legs, 0.25u |
| Picks | Sam Houston ML, Missouri State ML, Canadiens +1.5 | Dodgers/Brewers Under 7.5, Avalanche/Stars Over 5.5, Sam Houston Over 52.5 |

### Published record before this change

These rows are the cards already graded on `/api/get-results-omega` at 22:05Z. They are not a pure-model replay. Profit is whole dollars. ROI is profit / amount wagered. CLV here is the published mean in cents (close no-vig minus bet no-vig), not yet restated as bet decimal × Pinnacle close probability − 1. The pure-model held-out table is not filled: that replay was waived for this deploy and is the next pass.

| Slice | Record | Profit | ROI | CLV |
| --- | --- | --- | --- | --- |
| Last 7 days, all graded | 6–9, 3 pending | −$945 | −37.0% | n=51, mean +0.4¢, 47.1% beat close (sample is wider than 7 days) |
| Last 30 days, all graded | 36–33, 3 pending | −$283 | −2.3% | same CLV sample |
| Last 30 days parlays | 3–20 | (inside the −$283) | | |
| CLV spreads | n=14 | | | +0.18¢, 42.9% beat |
| CLV totals | n=34 | | | +0.51¢, 47.1% beat |
| CLV moneylines | n=3 | | | +0.17¢, 66.7% beat |

No tier or sport split is on that results payload. Pure-model profit, ROI, and CLV by tier and by sport stay blank until the held-out replay grades them.

### QA for this deploy

- `test-omega-*.js` and `test-sharp-*.js`: 115 files, 0 failures, including `test-omega-pure-model-1014.js`.
- Dry run `node tools/omega-dryrun-selection.js --date 2026-10-14`: 3 straights and a 3-leg parlay. Stored board, Odds API blocked, autopost off.
- 30-day replay: waived for this deploy.

### Next

Held-out replay on stored Supabase history before any further weight, calibration, Kelly, stale-cap, odds-band, or parlay change. A change ships only if held-out profit and ROI beat this card's model.

## 2026-10-15 — empty card restored and republished

The 17:30Z card in this section is not a QA pass. Integer win percents cannot produce the printed edge and expected value, the rank was stake EV, and NHL, NFL, and MLB were past the extreme margin line. The following section replaces it.

Live site at 1:09 PM ET was still `v12.4.0-webetai-pure` and the 2026-10-15 Omega card had 0 picks, generated `2026-10-15T16:07:55Z` (12:07 PM ET), after the 11:00 ET finalization. Capture health was fine: slots 0300 and 1000 present, 17 games (MLB 2, NFL 1, NCAAF 3, NHL 11). NBA is preseason and correctly off the card.

`/api/get-omega-health` showed `yes=0` in every sport. The best leftovers were NHL overs at +105 with stake EV 6.6–8.1% rejected as `ev-stale` (anchor cap 6%) and the rest rejected as `no-edge-vs-fair` with displayed edge 0. `OMEGA_MARKET_ANCHOR=1` blends the model into the Pinnacle no-vig (K floor 0.7), ranks edge against that fair, cuts max EV from 12% to 6%, and turns lean fill off. That violates brief rules 1 and 5 and is why the card was empty.

Fix is on `main` as `6bf85f581f23cfb28198f2b8a73bef9777651c7c`. Netlify production deploy `6ad10d05095ad7a2b5d3655a` was ready at `2026-10-15T17:27:33Z`.

- `marketAnchorOn()` always returns false. The env flag cannot re-enable the blend.
- The Pinnacle selection gates `no-edge-vs-fair`, `edge-floor-vs-fair`, and `sharp-move-against` are removed. Pinnacle stays a CLV input.
- Morning cron times are unchanged.

Owner asked to rebuild today's card on that deploy. `POST {"date":"2026-10-15","force":true}` to `generate-picks-omega-background` returned 202 at `2026-10-15T17:30:36Z` (request `01M509VA8G60KGRB2MXEJ2XBVR`). The run priced the stored 10:00 ET board (`priceLock.note` is `stored-10:00`, served `2026-10-15T14:01:04Z`). No new Odds API pull. X autopost stayed off. The written card still has slots 0300 and 1000 and `hardFail` false.

Public card from `GET /api/get-picks-omega`, `generatedAt` `2026-10-15T17:30:37.503Z`. `modelNotes` starts with the sentence that `OMEGA_MARKET_ANCHOR` is ignored. `qaHardFails` is empty. Label is `3 floor straights`. Straights are 4.5u ($675). The parlay is 0.5u because the card has floor grades.

| Pick | Sport | Matchup | Book | Odds | Edge | EV | Grade | Units | Start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New York Islanders ML | NHL | Islanders @ Senators | DraftKings | +130 | 5.2% | 12.0% | A+ | 1.5u | 7:10 PM ET |
| Under 40.5 | NFL | Seahawks @ Broncos | DraftKings | −102 | 5.2% | 10.3% | A+ | 1.5u | 8:15 PM ET |
| Toronto Maple Leafs −1.5 | NHL | Sabres @ Maple Leafs | DraftKings | +200 | 4.0% | 11.9% | A | 1u | 7:10 PM ET |

Parlay is those three legs, type `3-leg-parlay`, combined +1266, EV 38.2%, 0.5u, $75 to win $950, three distinct games.

As-of-now dry run before the POST (`pregameAsOfMs` = wall clock, stored 10:00 board, no write) printed the same three sides and the same parlay, `hardFails=0`. Six already-started rows were dropped. All three published games start tonight.

Local QA before that request:

- `node tools/omega-dryrun-selection.js --date 2026-10-14` exited 0. Stored 10:00 board, no Odds API pull, no blob write. Result: 3 straights and a 3-leg parlay. Straight 1 matches the published 10/14 card (Dodgers/Brewers Under 7.5, Hard Rock −115, 3.6% edge, 1u). Straight 2 is the same Over 5.5 at DraftKings −135, at 2.1% edge and 0.75u. Straight 3 is Capitals −1.5 at +185, 1.4% edge, 0.5u. The local run could not read the line-move blob index (`@netlify/blobs` is not installed in this worktree) and it refetched ESPN inputs, so it is not a byte match of the 22:05Z card.
- `node tools/run-tests.js` on `test-omega-*.js` and `test-sharp-*.js`: 118 passed, 5 failed. The 5 failures all read `/workspace/omega-replay-2w`, which is not on this machine. They do not import the gate change.

Published Omega KPIs at the same check, from `/api/get-results-omega`. Profit is the API's dollar total. These rows are the cards already graded. They are not a pure-model replay.

| Slice | Record | Profit | ROI | Parlay | CLV |
| --- | --- | --- | --- | --- | --- |
| All versions, 2026-03-19 on | 291–252–18 | $12,139 | 14.5% | 33–128, 20.5% | |
| Legacy through 2026-09-21 | 262–224–18 | $12,320 | 16.9% | 30–111, 21.3% | |
| Omega only from 2026-09-22 | 29–28 | −$181 | −1.7% | 3–17, 15.0% | n=51, +0.4¢, 47.1% beat close |
| October 2026 | 15–19 | −$1,300 | −21.1% | 1–11 | |
| Last 7 days | 6–9 | −$796 | −33.1% | 0–5 | |

The lifetime book is near the 55% / 15% / 20% parlay marks because of the March–July legacy run. The live Omega window is not. The anchor rollback is a rule restore, not a new weight. A calibration or stake change still needs a held-out replay that beats this pure-model policy before it ships.

## 2026-10-15 — edge rank, margin gate, and the replacement card

The 17:30Z Islanders / Broncos under / Leafs ticket stays in the section above as the card that was live before this change. It is withdrawn.

Rules now in the publisher:

- Win probability prints to one decimal from the same probability that sets edge and expected value.
- A sport whose mean margin residual is more than three times its limit is off the card for that run. It is not a lean fill.
- Straights rank by probability edge. Stake EV from 2% through 12% is the inclusion check and the tie-break inside 0.2 percentage points.
- A parlay leg needs a sport that passed the margin check, cover of at least 45%, and positive stake EV at or under 12%. Fewer than three such games publishes no parlay.
- Narration has to print the probability, the price, the edge, and the expected value. Copy that invents a cause is replaced with the factual line.
- A stored morning card with no picks can be rebuilt. A card that already has picks stays locked for the scheduled job.

Dry run of the stored 10:00 ET board for 2026-10-15, no Odds API pull, no blob write, pregame clock at the 10:00 lock. `bias-margin-extreme` removed MLB, NHL, and NFL (98 rows). NCAAF stayed. Gate log: yes 2, lean 11, ev-stale 7. No parlay.

| Pick | Sport | Matchup | Book | Odds | Win | Edge | EV | Units | Role |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Georgia Southern Eagles ML | NCAAF | Georgia Southern @ Old Dominion | DraftKings | −180 | 69.3% | 5.0% | 7.8% | 1.5u | floor |
| UAB Blazers ML | NCAAF | East Carolina @ UAB | Hard Rock | +180 | 38.1% | 2.4% | 6.6% | 0.75u | floor |
| Texas State Bobcats −13.5 | NCAAF | Colorado State @ Texas State | Hard Rock | −120 | 43.7% | −10.9% | −19.9% | 0.5u | lean |

The third row is the lean pad on the only remaining NCAAF game. The other side of that spread is over the 12% cap, so it is not a floor play. The pad still fills the third slot, and the printed edge and expected value are negative. UAB is under 45% cover, so it is not a parlay leg. ESPN listed all three kickoffs as scheduled, 7:30 PM and 8:00 PM ET.

Architecture scorecard on this build: Processes 82, Architecture 84, Math 70, Verify 78, Straights 70, Parlay 65, Overall 65. The hockey rating stays near 46 until a replay. These are judgments of the publisher. They are not the ROI table.

Local QA: `node tools/run-tests.js` on the omega and sharp files, excluding the five that read `/workspace/omega-replay-2w`, was 121 passed after the edge-rank fixture updates. The five replay-path files were not run. NHL shrink mode stays `all`.

Public card after deploy `6ad11fc2af386205134e57b2` (`410c163`), `generatedAt` `2026-10-15T18:48:26.520Z`. Same three NCAAF rows as the dry run. No parlay. MLB, NFL, and NHL are off the card. The copy is the factual template: probability, price, edge, and expected value. The Texas State line says the projection is 12.7 against a posted line of -13.5, 0.8 points short of that number. Kickoffs were still scheduled at the rebuild. X autopost stayed off. No new odds pull.
