# Omega results KPI — 2026-10-30

Not deployed. WeBet approves deploy.

## Problem

`get-results-omega` showed a straights W-L next to an ROI that included parlays. `cumulative` summed `day.wagered` / `day.profit` (straights, parlays, and push stakes) while `wins` stayed straights-only. A missing stake became 1u (`parseFloat(units) || 1`), and a parlay with no `parlayRisk` became $75. Four NCAAF straights from 2026-10-03 through 2026-10-10 stayed `pending` because ESPN names did not match the card (McNeese State vs McNeese, Southern Mississippi vs Southern Miss, San José, UMass vs Massachusetts).

## Changes

Record and ROI now come from the same bets. `straightsOnly` is straights. `allIn` is straights plus parlays. Pushes stay in the record and out of wagered. Pending stays out of both. Dollars are whole, rounded away from zero, at $150 = 1u. ROI stays one decimal.

The stake is `pick.units` or the parlay ticket `units`. If neither parses, the bet is left out of the record and the money and listed as `{issue:'units_missing', date, pick}`. Nothing fills in 1u or 0.5u.

NCAAF matching folds accents, applies the sizing-v2 aliases, and compares schools after the mascot is stripped. Miami (OH) does not match Miami. Grading reads the ESPN college scoreboard for a still-pending NCAAF pick. The results cache key is `results-omega-cache-v9-kpi1030`.

Old fields stay. `cumulative` and the window/month rows are all-in and tagged `kpiScope:'allIn'`. `straight` is straights-only and carries its own `roi`. The Omega, v1, percentile, dashboard, and tracking summaries read those scopes. Today’s live card uses the same stake rule.

## API

`straightsOnly` and `allIn`: `{scope, kpiScope, record:"W-L-P", wins, losses, pushes, pending, bets, wagered, profit, totalWagered, totalProfit, roi, accuracy}`. Top-level `flags` and `unitsMissing` repeat the excluded bets. `day.wins` / `day.profit` / `day.roi` are all-in; `day.straightsOnly` keeps the straight line. `day.accuracy` is still a whole number without a `%` so the existing day row can append one.

## Expected KPI impact

Replayed on `/workspace/audit-1030/omega-all.json` plus `cards/`. Settled results stay. Only the four pending NCAAF bets are graded, and only the 2026-10-13 parlay stake changes. Stakes that the old `|| 1` path would have invented: **0**. 141 pre-Omega parlays had a null `parlayRisk`; each was already 0.5u, so the old $75 substitute matched the ticket. 2026-10-13 was graded at 0.5u (−$75) against a 0.25u ticket (−$38).

Published full-ledger headline was straights **308-270-18** with ROI **14.5%** on **$88,673 / +$12,832**. That denominator includes $2,473 of push stakes. The same-bet-set books below are the before column.

| Window | Scope | Before | After |
| --- | --- | --- | --- |
| Full ledger | Straights | 308-270-18, $73,075, +$5,176 (+34.51u), 7.1% | 311-271-18, $73,751, +$5,437 (+36.25u), 7.4% |
| Full ledger | All-in | 344-409-18, $86,200, +$12,828 (+85.52u), 14.9% | 347-410-18, $86,839, +$13,126 (+87.51u), 15.1% |
| Since 2026-09-22 | Straights | 46-46-0, $13,374, −$376 (−2.51u), −2.8% | 49-47-0, $14,050, −$115 (−0.77u), −0.8% |
| Since 2026-09-22 | All-in | 52-74-0, $15,924, +$512 (+3.41u), 3.2% | 55-75-0, $16,563, +$810 (+5.40u), 4.9% |
| 09-30..10-29 | Straights | 34-37-0, $9,729, −$909 (−6.06u), −9.3% | 37-38-0, $10,405, −$648 (−4.32u), −6.2% |
| 09-30..10-29 | All-in | 39-59-0, $11,754, −$106 (−0.71u), −0.9% | 42-60-0, $12,393, +$192 (+1.28u), 1.5% |

The four finals, checked on the ESPN scoreboard for those dates: 10/03 McNeese State +53.5 **win** 14-63 (+$137); 10/06 Troy −10 **win** 34-55 (+$175); 10/09 Over 42.5 **loss** 16-13 (−$188); 10/10 UMass +6.5 **win** 20-19 (+$137). Net +$261 straight profit. With the 10/13 parlay restake, all-in profit is +$298. 2026-10-30 stays pending (Warriors, Bulls, Kent State, and that parlay).

## Rollout

Local commit only. No Netlify deploy, no push, no Supabase or blob write, no Odds API call. After WeBet deploys, the v9 cache key misses the old mixed payload. Legacy days before 2026-09-22 are not regraded.

## Update 2026-10-30 (WeBet decision)
The page display is unchanged. Record and accuracy show straight picks only; profit and ROI are the single overall (all-in) figure, with the same labels. Published overall wagered keeps push stakes in the denominator, as production does; the `allIn` block leaves them out. The legacy fields (`wins`, `losses`, `accuracy`, `cumulative.*`, `flatSummary`) keep that production meaning (`recordScope: straightsOnly`, `roiScope: allIn`). `straightsOnly`, `allIn`, and `parlay` stay in the API as extra fields, and the pages do not show them. The page files (dashboard, tracking, percentile x2), `js/live-score.js`, `lib/tracking-report.js`, and the v1/daily-omega pages are all reverted to production. The backend fixes are kept: the 4 NCAAF grades, no 1u stake default, and the 10/13 parlay at its 0.25u card stake.
