# Omega walk-forward scaffold (observer only)

This is a **scaffold**. It records Omega lock→close samples so a later fit has something honest to read. It does **not** fit coefficients, and it does **not** steer the live card.

## What is true

- `OBSERVER_ONLY=true`, `FIT_ENABLED=false` in `netlify/functions/lib/omega-vnext/walk_forward.js`.
- `getFitParams()` returns `null`. There is no shrink map, isotonic table, or gate override to apply.
- `calibrate.js` still shrinks with the static `SHRINK_K` in `config.js`. `generateOmegaVnext` does not load the walk-forward module and does not read a fit blob.
- Samples are built only for dates on or after `CLV_KPI_FLOOR` (`2026-09-22`). Earlier dates are skipped and not written.
- The **2026-09-22 production card was not regenerated** by this work. The capture function only reads `picks-{date}` and `clv-{date}`.

## When a fit is allowed

The actual coefficient fit is **Monday 11:00 America/New_York on or after 2026-09-29**.

Do not fit shrink, isotonic bands, or gates from the sparse day-1 closes (2026-09-22). Do not flip `FIT_ENABLED` before that date. Do not point `self-optimize-omega` or `generateOmegaVnext` at these blobs.

## What this is not

- **Not an Omega empirical CLV percentile.** Do not quote Alpha CLV history or TSP records as Omega's close-beat rate or percentile.
- **Alpha priors are offline only.** `data/walkforward-offline-priors.json` documents Alpha public blobs (`edge-picks`) as a different model. `loadOfflinePriors()` strips coefficients and sets `appliedToCalibrate: false`. Nothing in `calibrate.js` reads that file.
- **Public TSP is not a decade of member closes.** The public Performance Terminal CSVs (see `docs/TSP-RESEARCH-OBSERVER.md`) are not the member archive. **Member `tsp.live` stays ON HOLD.** Do not train Omega to mimic Hermes, and do not copy TSP picks onto the Omega card.

## Schedule

`capture-omega-walkforward` runs at **15:15 UTC**, which is **11:15am ET during EDT** (same EDT assumption as the other Omega crons; after the November clock change this UTC slot is 10:15am ET).

That is after the morning generate/verify window and after the 07:00 UTC (3am ET) `track-clv` settle. With no `?date=`, the function refreshes **yesterday ET and today ET** so yesterday's lock→close grades are stored, while today's card may still have null closes. It is not called from `generateOmegaVnext` or from `track-clv-omega`.

`?date=YYYY-MM-DD` captures one date. Dates before the KPI floor are not written. Failures return HTTP 200 and do not throw into the card pipeline. There is no Discord post.

## Blob keys (edge-picks-omega)

| Key | What |
|-----|------|
| `omega-walkforward/samples/{YYYY-MM-DD}` | Lock→close samples for that date |
| `omega-walkforward/reports/{YYYY-MM-DD}` | Daily observer report |
| `omega-walkforward/reports/latest` | Copy of the latest report written |
| `omega-walkforward/priors-offline` | Sanitized offline-prior note (coefficients always null) |

These writers refuse `picks-{date}`, `latest-date`, `picks-dates`, `self-optimize-params`, and `omega-walkforward/fit`.

## Sample fields

`date`, `pickId`, `sport`, `market`, `side`, `matchup`, `lockOdds`, `closeOdds`, `clvCents`, `beatClosing`, `coverProb`, `p_model`, `fair_sharp_p`, `edgePct`, `units`, `modelVersion`, and `result` only when the grade is win, loss, push, or void.

Close fields are null until `track-clv-omega` has a row. Null closes are not a fit.

## Report

`observerOnly: true`, `fitEnabled: false`, `fitApplied: false`, plus `date`, `n`, `bySportMarket`, `notes` (first note is `scaffold only — no coefficient fit`), and `kpiFloor`.
