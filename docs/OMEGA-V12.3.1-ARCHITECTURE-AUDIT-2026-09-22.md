# Omega v12.3.1 Architecture/Math Audit (read-only) — 2026-09-22

**Commit audited:** `699406d` (Merge PR #77 — `v12.3.1-omega-vnext-pregen`)  
**Scope:** `netlify/functions/lib/omega-vnext/**` + related Netlify entrypoints / schedules / tests  
**Mode:** READ-ONLY — no generator math, weights, gates, Kelly, selection, Netlify env, or live-card changes  
**Auditor note:** Findings grounded in source symbols; percentile is an honest engineering judgment, not a marketing score.

---

## Executive summary

| Dimension | Percentile (honest) | One-liner |
|-----------|---------------------|-----------|
| **Math** | **~82nd** | Sound Kelly/unit structure, quality grades, shrink+isotonic; still double-anchored to market and dual score systems. |
| **Architecture** | **~85th** | Clean ingest→gates→select→parlay→store spine; shadow / PM / walk-forward / replay isolation is real; TSP has no hard dep. |
| **Process** | **~78th** | Pregen health (#77) is a real reliability lift; verify still has refill / units-grade paths that can undo generator policy. |
| **Overall** | **~82nd** | Consistent with the ~80–85th band. Strong enough to run volume carefully; not yet ~90th until verify refill + dual-score debt are cleaned. |

**PR #77 residual:** Added 9:15 ET line snap, `captureHealth` hard-fail after one Odds retry, `warm-omega-feeds`, isolated `omega-shadow/*` dry-run at 9:05, and lifted the TSP live hold for `/live-ai` only. Residual risk is operational (Odds outage → empty morning after hard-fail) and process (verify steam drops can still refill toward 3 picks; autofix/backfill still grade from units). Generator math knobs were not touched — correctly.

**Confirmed by code (not findings):**
- Unit caps: `STRAIGHT_UNIT_BUDGET=3.5`, `PARLAY_FIXED_UNITS=0.5`, `DAILY_UNIT_CAP=4.0`, `MAX_STRAIGHT_UNITS_PER_PICK=1.25` (`config.js`).
- `SPORTS_ENABLED.NBA/NHL = false`; stubs return `[]`.
- `walk_forward.js` `FIT_ENABLED = false`; fit payloads refused in `store.js`.
- TSP: no `require` of TSP into Omega selection/gates/grades; TSP is observer / offline-prior only.
- Shadow: `resolvePicksStoreTarget` + `storeShadowPicks` never touch `latest-date` / `picks-dates` / live `picks-{date}`.
- Morning cron: `trigger-picks-omega` always `force:true` so `OVERWRITE_GUARD` does not keep overnight cards.
- Same-ET-day: `GATES.sameEtDayOnly` + `isSameEtDay` on straights and parlay pool.

---

## Critical (fix before trusting more volume)

### C1: Verify steam drops do not block TARGET_PICKS refill

- **Where:** `netlify/functions/verify-picks-omega.js` — steam drop block (~L1062–1094) vs `blockStraightRefill` / `TARGET_PICKS = 3` backfill (~L1003–1033, ~L1243–1287)
- **What's wrong:** Placeability soft-veto correctly sets `blockStraightRefill = true` when straights are dropped. Adverse **steam** drops remove picks and allow empty cards in comments, but **never** set `blockStraightRefill`. The final pass then refills toward 3 picks from `candidateTable` (EV-sorted, gate-filtered) whenever the card is short.
- **Why it hurts:** Undermines CLV/ROI of the steam gate. A line that steamed against the published ticket can be replaced at 10:30 with a weaker leftover that never passed open→now steam annotation the same way — or a candidate that was correctly left off the card. Reintroduces “force toward 3” behavior the generator explicitly rejects (`LEAN_PAD = false`).
- **Suggested fix (text only):** After steam drops, set the same refill block used for placeability (or a dedicated `blockStraightRefill ||= droppedSteam > 0`). Prefer empty / short honest cards over TARGET_PICKS refill for steam and QA hard-fails. Keep candidate refill only for true math-critical autofix with quality grades from `qualityToRating`, not units.

### C2: Verify autofix / backfill still assign grades from units

- **Where:** `verify-picks-omega.js` — `autoFixPicks` replacement builder (`rating: unitsToRating(cappedKellyUnits(c))`, ~L742); backfill push (`rating: unitsToRating(u)`, ~L1269); dead sharp path also uses `unitsToRating` (~L1138, ~L1177)
- **What's wrong:** Generator path correctly uses `qualityToRating` / `qualityScore` (edge-first). Main verify trim path comments “NEVER rewrite from units (v12.1+)” and preserves ratings on unit-cap trim. **Replacement and backfill paths still map stake → letter grade**, and backfill even writes string grades into `confidence` (`confidence: u >= 2.0 ? "aplus" : …`).
- **Why it hurts:** Public Edge legend / A+/A/A- become stake theater again whenever verify replaces or refills. ROI signaling and CLV QA become inconsistent day-to-day (generator card vs post-verify card). `cappedKellyUnits` still uses legacy Alpha-era market caps (ML 0.5u, `Math.max(0.5, …)`) that disagree with vnext `MAX_STRAIGHT_UNITS_PER_PICK = 1.25`.
- **Suggested fix (text only):** Build replacements via the same `toPickObject` / `qualityToRating` path as `select.js`. Delete units→rating on verify write paths. Align sizing with `applyDailyUnitCap` / vnext caps. Treat confidence as numeric only.

---

## High (fix this week)

### H1: Double market anchor (blend + shrink) systematically compresses edge

- **Where:** `sports/_common.js` `blendWithMarket`; callers in `sports/nfl.js`, `cfb.js`, `mlb.js` (wModel ≈ 0.45–0.5); then `calibrate.js` `shrinkTowardSharp` with `SHRINK_K` Total 0.58 / Spread 0.68 / Moneyline 0.73; then `isotonicClip` toward [0.42, 0.58]
- **What's wrong:** Model raw P is blended ~50% toward market **before** calibrate, then shrunk again toward no-vig sharp with high K, then soft-capped. Effective model weight on moneyline is often well under ~15–20% of the original signal.
- **Why it hurts:** Honest edges get pushed under `GATES.minEV` / `nonpositive-edge`, causing empty or thin cards even when EPA/SP seeds disagree with the market. Hurts CLV discovery if the model has residual skill; also makes grade bands noisy because `edgePct = coverProb − fair_sharp` after heavy shrink.
- **Suggested fix:** Treat as a **measured** change after Sep 29 walk-forward samples — either lower blend weight, or shrink-only (no pre-blend), or sport-specific K. Do not retune both knobs in one ship. Log `p_model` vs `coverProb` deltas on shadow cards for a week first.

### H2: Dual scoring systems (SELECT_WEIGHTS vs quality grades)

- **Where:** `select.js` `scoreCandidate` (`SELECT_WEIGHTS`: w_ev 0.35, w_clv 0.45, w_uncertainty 0.20); `odds_math.js` `qualityScore` / `qualityToRating` (edge-first; CLV ±3¢ × 0.0005)
- **What's wrong:** Ranking for which picks make the card optimizes a CLV-weighted score; published letter grades optimize calibrated edge. A high residual-CLV / modest-edge candidate can outrank a cleaner edge play, then show a weaker grade (or vice versa after steam adj).
- **Why it hurts:** Selection vs badge inconsistency confuses CLV attribution and postmortems. Steam boost (`_steamScoreAdj`) affects selection but barely moves quality score.
- **Suggested fix:** Unify: either select by `qualityScore` (plus hard gates), or grade by the same linear form as `scoreCandidate`. Prefer one CLV feature (`predictedResidualClv` when present). Document the chosen objective in `MODEL_NOTES`.

### H3: Capture-health hard-fail is correct but brittle under Odds flakiness

- **Where:** `line_path.js` `assessCaptureHealth` (`hardFail = usableSnapCount === 0`); `index.js` retry via `runOmegaLineCapture` then throw `CAPTURE_HEALTH`
- **What's wrong:** By design, zero usable morning snaps after one retry aborts generate (live and shadow). Partial missing slots only warn. If The Odds API or Netlify blob write fails across the morning window, the card stays empty / sticky prior-day.
- **Why it hurts:** Reliability of volume: a single vendor outage blanks the day even when live ingest odds for projection still work. Steam features degrade without snaps; hard-fail is safer than inventing opens, but operators need an alert path.
- **Suggested fix:** Keep hard-fail (do not invent snaps). Add explicit Discord/ops alert on `CAPTURE_HEALTH` / `captureHealthRetry` failure. Optionally allow generate-without-steam when `usableSnapCount === 0` only under an explicit env flag for disaster recovery — default off.

### H4: Verify still carries TARGET_PICKS=3 culture vs generator LEAN_PAD=false

- **Where:** `verify-picks-omega.js` `TARGET_PICKS = 3` backfill; `config.js` `LEAN_PAD = false`
- **What's wrong:** Even aside from C1, math-critical autofix + backfill try to restore a 3-pick card. Generator and placeability policy say empty/short is OK.
- **Why it hurts:** Process drift: two products in one codebase (fill-to-3 verify vs empty-OK vnext). Increases chance of publishing lower-quality leftovers after any drop.
- **Suggested fix:** Make refill opt-in and quality-gated; default off for Omega engine cards (`engine: 'omega-vnext'`). Cap refill at “replace only the failed index,” never grow toward a fixed N.

### H5: Parlay “independent” flag uses fragile side matching

- **Where:** `parlay.js` `optimizeParlay` — `straightSides = Set(straights.map(p => p.pick || p.side))` vs `chosen.legs.every(l => straightSides.has(l.side))`
- **What's wrong:** Straight picks are formatted with `formatMoneylinePick`; parlay legs compare raw `l.side` before/after formatting inconsistently. Spread labels include the number; small string mismatches mark parlays “independent” when they are not (or the reverse).
- **Why it hurts:** Correlation / labeling noise in UX and analytics; not a direct Kelly bug (stake is fixed 0.5u) but muddies process metrics and narrative claims.
- **Suggested fix:** Compare canonical keys (`matchup|market|sideNormalized`) shared with `matchupKey` / placeability side keys.

---

## Medium (nice for ~90th)

### M1: NFL/CFB rest adj is effectively binary “played yesterday”

- **Where:** `sports/game_day.js` `restDaysProxy` (returns `1` or `null`); `hfaAdjustment` / `SHORT_REST_DAYS`
- **What's wrong:** Scoreboard ingest only knows prior-ET-day play. Extra-rest branches (`EXTRA_REST_DAYS` 8–9) almost never fire. Football short-rest logic collapses to TNF/Fri-style rare cases.
- **Why it hurts:** Limited CLV from rest feature; risk of over-trusting `projMethod` tags `*-gameday` as if rest were rich.
- **Suggested fix:** After schedule ingest exists, pass true days-rest; until then tag meta `restProxy: 'playedYesterdayOnly'` and keep adj small (already small).

### M2: Soft-fail engines do not nullify edge (good) but uncertainty bumps are easy to miss in QA

- **Where:** `ingest.js` QB/rest/weather soft-fail logs; `epa.js` fallback to standings; `mlb.js` SP/park soft paths; `index.js` continues without blanking slate
- **What's wrong:** Soft-fail correctly keeps standings/Pythag path and does **not** silently zero `coverProb`. Uncertainty increases can still demote selection via `w_uncertainty` without a card-level warning flag beyond logs.
- **Why it hurts:** Shadow vs live diffs hard to explain when ESPN injuries fail for one sport only.
- **Suggested fix:** Persist `feedHealth: { epa, qb, rest, weather, sp }` on `picksData.meta` (like `captureHealth`) for Discord/summary.

### M3: `clv_grade.summarizeBySportMarket` labels meanClvPct = meanClvCents

- **Where:** `clv_grade.js` `summarizeBySportMarket` finalize (~L85–86)
- **What's wrong:** Both fields set to `clvSum / n` (cents). Naming implies percent.
- **Why it hurts:** Observer reports / Discord can mis-scale CLV by 100× in human reading.
- **Suggested fix:** `meanClvPct = meanClvCents / 100` or rename fields; add a unit test.

### M4: `americanCentsDiff` scale is ad hoc

- **Where:** `odds_math.js` `americanCentsDiff` — `(pc - pb) * 10000 / 100`
- **What's wrong:** Equivalent to `(pc-pb)*100`; not true American cents on the juice ladder (contrast `edge.americanCentsWorse`).
- **Why it hurts:** Mixed CLV proxy scales across predicted / residual / realized confuse calibration of `SELECT_WEIGHTS.w_clv`.
- **Suggested fix:** Standardize on one cents definition (prefer no-vig pp × 100 as in `clv_grade`, or American ladder cents) and document it.

### M5: Shadow capture-health retry writes shared line snaps

- **Where:** `docs/OMEGA-SHADOW-DRYRUN.md`; `index.js` capture retry; `capture_runner.js` `storeLinePoll`
- **What's wrong:** Documented and intentional: shadow may write `omega-line-snap-*` / `omega-line-path/{date}`. Not a live-card leak, but 9:05 shadow retry can create a non-canonical HHMM slot if clock skew vs cron slots.
- **Why it hurts:** Path polls may include an off-slot snap that becomes “latest” before 9:15, slightly biasing open→now moves for the 9:30 generate.
- **Suggested fix:** On health retry, force `etSlot` to the nearest configured `LINE_MOVE.captureSlotsET` rather than raw `hhmmET(now)`.

### M6: Warm + late capture + shadow share Odds quota in the same window

- **Where:** `netlify.toml` schedules for `warm-omega-feeds`, `capture-omega-lines-late`, `trigger-omega-shadow`, `trigger-picks-omega`
- **What's wrong:** 9:00–9:30 ET is dense (warm, 9:00/9:15 snaps, shadow, NFL/CFB triggers, Omega generate). Soft-fail warm helps, but quota / timeout races remain.
- **Why it hurts:** Empty snaps → captureHealth pressure (H3).
- **Suggested fix:** Monitor Odds remaining-requests headers; prefer warm cache hits inside ingest when fresh.

### M7: Placeability annotate vs gate order is sound; legacy unannotated candidates skip veto

- **Where:** `gates.js` `failsPlaceability` — returns false when `placeable` unset and no `placeableBooks`
- **What's wrong:** Intentional for legacy. Replay/historical paths that skip enrich could publish unshoppable lines.
- **Why it hurts:** Replay harness optimism vs live placeability.
- **Suggested fix:** In replay, require placeability annotation or mark `placeabilitySkipped: true` in eval summary.

---

## What's already strong

- **Unit structure is coherent and enforced in two places:** generator `applyDailyUnitCap` and verify `enforceOmegaDailyUnitCap` both lock parlay at 0.5u and trim straights only; grades not rewritten on trim in the happy path.
- **Quality grades (A+/A/A-/B) are edge-first** in `odds_math.qualityToRating` with documented band edges in `QUALITY_GRADE`; Edge badge = `coverProb − fair_sharp` after shrink (`edge.attachEv`) — not predicted CLV cents.
- **Placeability soft-veto is US-retail, juice-aware, and distinct from liquidity** (`PLACEABILITY` vs `MAJOR_LIQUIDITY_BOOKS`); verify drop requires Hard Rock fail **and** majors fail; API down does not clear the card.
- **Line-path / steam:** open→now annotation, generate reject thresholds, harder verify thresholds, residual CLV proxy; 9:30 capture removed to avoid racing generate.
- **captureHealth + missingDueSlots:** 9:05 shadow does not treat 9:15 as failed yet; zero usable snaps hard-fail after one real Odds retry — no invented opens.
- **Shadow isolation is real:** `omega-shadow/*` only; no `latest-date` / `picks-dates`; documented in `OMEGA-SHADOW-DRYRUN.md`; tests pinned in suite.
- **PM observer isolation:** Kalshi/Poly logged to `omega-pm-observer/{date}` (shadow under prefix); soft-fail; never mixed into selection/grades/units/gates.
- **Walk-forward FIT_ENABLED=false** with store-level refusal of fit/coefficients payloads; Alpha/TSP offline priors only.
- **Replay isolation:** `omega-replay/{runId}/…` keys; never live picks; skip live snap hard-fail when `historicalSnapshot` / `replay`.
- **TSP independence confirmed:** Omega generator modules do not import TSP fetchers; `fetch-tsp-live` → `tsp-live` blob → passcode `/live-ai`; `monitor-tsp-public-records` → `tsp-research` only; config notes “zero Omega hard dep.”
- **Same-ET-day scope** on gates + parlay pool prevents weekend football on weekday cards.
- **EPA/SP soft fallback** keeps slate alive; both-team EPA required or standings fallback; no silent zero-edge wipe.
- **Morning force overwrite** correctly bypasses `OVERWRITE_GUARD` so overnight cards do not block line-snap-aware rebuilds.
- **Empty card policy** in generator (`LEAN_PAD=false`) is consistent with product intent when verify does not refill.

---

## Explicit non-recommendations

Do **not** change the following without measured CLV samples / before the Sep 29 walk-forward fit window:

1. **`SHRINK_K` market constants** — already strong; retuning without blend change double-counts (see H1).
2. **`SELECT_WEIGHTS`** — wait until dual-score decision (H2) is chosen; do not bump `w_clv` alone.
3. **`KELLY_FRACTION` (0.25), `STRAIGHT_UNIT_BUDGET` (3.5), `PARLAY_FIXED_UNITS` (0.5), `DAILY_UNIT_CAP` (4.0), `MAX_STRAIGHT_UNITS_PER_PICK` (1.25)** — sizing is stable; do not raise caps to chase volume.
4. **`QUALITY_GRADE` band edges (5.0% / 3.5% / 2.0%)** — legend and QA gradeMatch depend on them.
5. **`GATES.minEV` / `minCoverProb`** — tightening further under double-shrink risks chronic empty cards; loosening without placeability/steam discipline risks junk.
6. **EPA seed tables / Sierra weight / MLB SP·park factors** — soft-fallback is working; no mid-week seed surgery.
7. **`FIT_ENABLED`** — keep false; do not wire walk-forward coefficients into `calibrate.js`.
8. **Wiring TSP / Kalshi / Polymarket / Alpha into Omega selection, grades, units, or gates** — observers only.
9. **Re-enabling NBA/NHL** before dedicated engines and placeability coverage.
10. **Removing captureHealth hard-fail** to “always publish” — inventing opens would poison CLV labels.
11. **Turning sharp LLM review back into a card-mutating path** (`if (false && sharpResult…)` must stay false).

---

## Appendix — morning spine (EDT)

| ET | Function | Role |
|----|----------|------|
| 6:00 / 7:30 | `capture-omega-lines` | Line snaps |
| 9:00 | `warm-omega-feeds` + late capture window | Feed warm + 9:00 snap |
| 9:05 | `trigger-omega-shadow` | Isolated dry-run → `omega-shadow/*` |
| 9:15 | `capture-omega-lines-late` | Final pre-generate snap |
| 9:30 | `trigger-picks-omega` (`force:true`) | Live generate |
| 10:15 | `capture-omega-pm-observer` | PM sidecar |
| 10:30 | `verify-picks-omega` | QA / steam / placeability |
| 11:15 | `capture-omega-walkforward` | Observer samples only |

---

*End of read-only audit. Docs-only deliverable; no code changes recommended in this PR.*
