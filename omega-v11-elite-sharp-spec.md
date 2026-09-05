# Omega v11 — Elite Sharp Multi-Sport Card

**Owner:** WeBetAI - Omega  
**Baseline:** `v10.9-omega-optimized` (MLB-only, 3 straights + optimized parlay)  
**Goal:** Fold NFL + CFB (NCAAF) projection models into Omega so the daily card maximizes accuracy × ROI across MLB / NFL / CFB while staying selective.

## Daily card contract
- Exactly **3 straight picks** (best EV after gates), sized fractional Kelly / existing Omega unit bands
- Exactly **1 optimized parlay** (prefer 2–3 independent legs; max EV under correlation caps)
- Sports in play: **MLB, NFL, CFB (NCAAF)** when slate exists; skip empty sports rather than force fillers
- Pregame only; no chase of steamed live juice
- Output must keep existing Omega API shape (`picks`, `parlayLegs`, `candidateTable`, `rejections`, `modelProjections`, `summary.modelVersion`)

## Sharp principles (non-negotiable)
1. **Selectivity over volume** — never pad to 3 if fewer than 3 pass gates; if <3 pass, return only those that pass + `noFill` reason (prefer fewer high-EV over forced weak legs). *If product requires always-3, only promote the next candidate when EV ≥ floor below.*
2. **Price at bettable line** — edge vs Odds API consensus / opening; prefer +EV at current price; track CLV expectation
3. **Fractional Kelly** — haircut; hard unit caps (match current Omega bands; typically 0.5–1.5u straights, 0.5u parlay)
4. **Independence** — straights: unique games; parlay: unique games, no same-game sides, prefer cross-sport or opposite market families
5. **Sport-edge humility** — use sport-specific projection ensembles; do not apply MLB starter-FIP logic to NFL/CFB
6. **Calibration** — publish model coverProb / EV; reject thin edges
7. **Verification** — keep Omega’s fact-check / rejection path for starters, injuries, weather (NFL/CFB)

## Edge floors (candidate → card)
| Market family | Min calibrated edge | Min coverProb (approx) | Notes |
|---|---|---|---|
| MLB totals | ≥1.5 runs OR ≥2.0% EV | ≥52% | Match current Omega totals lean |
| MLB ML / spreads | ≥3.0% EV | ≥42% at plus money OK | Size down high variance |
| NFL spread / total / ML | ≥2.5% EV | ≥52% | Prefer ATS / totals over naked ML dogs |
| CFB spread / total / ML | ≥3.0% EV (higher variance) | ≥52% | Prefer power-conference / liquid books; fade tiny-edge FCS noise |

Hard reject if: injury/starter unverified when model depends on it; line already moved through the edge; correlated second pick same game; soccer / blocked sports.

## Projection ensembles to fold in
### MLB (keep + tighten)
- Existing: `ensemble(elo-historical + mlb-starter-adjusted(FIP/ERA))` + park + rest/B2B + recency
- Keep candidate ranking by EV / z-score

### NFL (new)
- Ensemble: team Elo / EPA-style offense-defense + rest (TNF/SNF/MNF) + travel + weather (outdoor) + injury/QB status + market consensus
- Markets: spread primary, total secondary, ML only when EV clears floor
- Situational: look-ahead / letdown as soft features only (never sole reason)

### CFB / NCAAF (new)
- Ensemble: team Elo + SP+/FPI-style proxy if available + home field (larger than NFL) + talent/returning production proxies + weather + QB status
- Prefer liquid majors; apply higher EV floor; beware inflated totals in shootouts already priced in

## Card construction algorithm
1. Pull Odds API + internal projections for MLB + NFL + CFB slate (ET day)
2. Build unified `candidateTable` ranked by EV (then z-score / edge)
3. Apply sport floors + verification → YES pool
4. Select Top 3 straights with greedy diversification:
   - unique games
   - prefer multi-sport when EV within 1.5% of mono-sport best
   - cap 2 picks from one sport unless third sport has no YES
5. Build parlay from remaining YES (or subset of Top 3 if independence allows):
   - maximize `combinedEV` under independence
   - prefer 2–3 legs, unique games, ideally ≥2 sports when available
   - reject if any leg correlation note flags same-game / heavy weather/QB shared risk
6. Size units from EV bands; daily straight risk soft-cap ~3.5–4.0u + 0.5u parlay
7. Bump `modelVersion` → `v11.0-omega-elite-multisport`

## Parlay optimization objective
Maximize expected value: `Π(p_i) * decimalOdds - 1`, subject to:
- unique games
- no ML+spread same team
- no Over+Under same game
- optional: ≥1 non-MLB leg when NFL/CFB YES exists and EV loss ≤ 2%

## Acceptance tests
- With MLB-only slate: behavior ≈ v10.9 (3+parlay, no crash)
- With NFL Sunday + MLB: card can include NFL legs when they beat MLB on EV floors
- With CFB Sat + MLB: same
- Candidate table includes sport tags for all three
- Rejections explain sport-specific rejects
- `summary.sportsCovered` lists sports actually selected
- No fabricated lines — only Odds API / existing WeBet feeds

## Out of scope
- Changing Alpha model
- Kalshi placement / Live Picks ultimate card (downstream consumers)
- Soccer / props-heavy cards

## Concrete code hooks (repo: wcgbk/webet-social-intelligence)

### Files
- `netlify/functions/generate-picks-omega-background.js` — primary (v10.9-omega-optimized, ~310KB, store `edge-picks-omega`)
- Donor logic (do not break these standalone products):
  - `netlify/functions/generate-picks-nfl-background.js` — v1.1-nfl, store `edge-picks-nfl`, keys `americanfootball_nfl` (+ preseason)
  - `netlify/functions/generate-picks-cfb-background.js` — CFB clone of NFL, store `edge-picks-cfb`, key `americanfootball_ncaaf`, sport label `NCAAF`

### Root gap
Omega `ODDS_SPORTS` / `ESPN_LEAGUES` currently include NBA/NHL/MLB + soccer (soccer runtime-disabled). **No `americanfootball_nfl` / `americanfootball_ncaaf`.** That is why live Omega cards are MLB-only in season.

### Fold-in implementation (preferred)
1. Add Odds keys: `americanfootball_nfl`, `americanfootball_ncaaf` (skip preseason once regular season live).
2. Add ESPN leagues: NFL (`football`/`nfl`) and CFB (`football`/`college-football`) with homeAdv/kFactor calibrated (NFL HFA ~48–55 Elo pts / ~2.5 pts; CFB HFA larger ~55–70).
3. Port from NFL/CFB donors into Omega (shared helpers or inline):
   - key-number cover mass (NFL 3/7 heavy; CFB weaker 3/7, empirical college curve)
   - `COVER_PROB_CAPS` for Spread/Total/ML
   - NFL static/team ratings overlay OR market-anchored projection (NFL file has `NFL_TEAM_RATINGS`)
   - CFB live rating from ESPN standings point-diff (no static 130-team seed)
   - QB-out / weather adjustments
   - `SPORT_STD_DEVS` / `SPORT_TOTAL_STD_DEVS` / `SPORT_MIN_EDGE` entries for NFL + NCAAF
4. Keep soccer disabled; keep Alpha untouched.
5. Unified candidate table → existing Claude SELECTOR path (top 3 + existing totals-first parlay builder), but:
   - Diversify across sports when EV within ~1.5%
   - Prefer independent multi-sport parlay when EV loss ≤2%
6. Bump all `model: "v10.9-omega-optimized"` / `modelVersion` strings → `v11.0-omega-elite-multisport`
7. Tighten EV floors per sport (see table above); NFL donor already uses ~3% EV floor + quarter-Kelly.

### Acceptance
- Dry-run / generate for a known NFL Sunday + CFB Sat + MLB day → candidateTable includes all three sports when slate exists
- MLB-only midweek regression still produces 3+parlay
- Standalone `/api/get-picks-nfl` and `/api/get-picks-cfb` unchanged
