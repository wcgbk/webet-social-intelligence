# Omega Sharp-90 (`omega-sharp-90`)

## Claude role (non-negotiable)

### Omega (MAIN multi-sport card)
- **JS** computes ALL projections, edges, EV, and Kelly sizing.
- **Claude** is **SELECTOR + NARRATOR** on the candidate table only:
  - May reject candidates (news / injury / weather / starter-QB changes).
  - May reduce units by ≤50% with justification.
  - Must NOT invent edges, override model direction, or pick outside the table.
- **Binding card builder**: after Claude runs (and on JS fallback), `selectDiversifiedStraights` builds the straight card from the YES pool. Claude narratives / unit cuts map onto diversified slots — diversification is not soft post-hoc.
- **Claude abort path**: primary call (top 15, 120s, 4 retries) → one retry with top-8 table → only then JS `fallback:true`.

### NFL / CFB standalones
- **JS selects and sizes**; **Claude is NARRATOR only** (unchanged).
- CFB select path adds the same blowout gate as Omega MAIN: NCAAF spreads with `|line| ≥ 17.5` require `EV ≥ 6%`.

## Alpha
- Untouched. Do not modify `generate-picks-alpha*`.

## High-leverage changes
1. Hard diversification via `buildBindingDiversifiedPicks` / `selectDiversifiedStraights`
2. Claude resilience (timeout/retries + top-8 retry before fallback)
3. `predCLV ≥ -0.02` gate for NFL/NCAAF when available (skip if missing)
4. Canonical matchup keys: `Away @ Home` on candidates and published picks
5. Lean fill: no football below sport EV floor; MLB leans ≥2.0% EV; skip lean fill when ≥1 football YES is on the card
6. CFB blowout filter on Omega + CFB standalone select path

Model version: `v11.1-omega-sharp-90`
