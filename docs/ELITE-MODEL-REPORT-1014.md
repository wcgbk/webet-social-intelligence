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
