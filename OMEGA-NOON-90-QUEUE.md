# Omega noon-90 queue

PR A (`feat/omega-v12.2-sport-engines`) is the deep sport-engine pass: NFL/CFB EPA-style priors and MLB starter + park factors inside omega-vnext only. Today's live card was not regenerated.

PR B (`feat/omega-v12.2-placeability`, v12.2.1) is shipping: generate-time placeability soft-veto. The published price must be within juice ballpark (≤3pp implied worse OR ≤15 American cents worse) at ≥2 US retail books from `US_BOOK_PRIORITY` (`PLACEABILITY.minMajorBooks`). Reject reason `placeability-soft-veto`, distinct from `insufficient-liquidity` (that gate still counts Pinnacle). Verify drops a pick only when Hard Rock and majors coverage both fail; if the odds API is down, warn and leave the card. Empty card OK — no lean refill. Item 3 shipped (v12.2.2); items 4–5 remain. The 2026-09-22 production card was not regenerated.

## 3. Kalshi / Polymarket observer sidecar — DONE (v12.2.2)

Shipped in `feat/omega-v12.2.2-pm-observer` → MODEL_VERSION `v12.2.2-omega-vnext-pm-observer`.
Read-only Kalshi + Polymarket moneyline observer. Maps only clean 1:1 game MLs. Artifacts: `omega-pm-observer/{date}` (+ `pm-sidecar-{date}`) in edge-picks-omega. Soft-fail hook after generate + scheduled `capture-omega-pm-observer` (10:15 ET). Never mutates rating/units/edge/ev. No orders. Today's 2026-09-22 live card was NOT regenerated.

## 4. TSP historical — NEXT (after Kalshi/Poly)

After the Kalshi observer. TOS-safe only: no live `tsp.live` member scrape (`TSP_FETCH_ON_HOLD=true` stays). Prefer public Performance Terminal wager-log feeds / records-transparency / archived records (~2011+). Observer-only into isolated `tsp-research` blob — never edge-picks-omega live config/selection. Do NOT copy TSP picks into Omega; do NOT train Omega to mimic Hermes.

## 5. Walk-forward — scaffold only

A later PR may add the walk-forward scaffold. No coefficient fit in the engines change. The actual fit is Monday 11:00 ET on or after 2026-09-29. Do not refit or mutate the self-opt loop before that.

## Remaining toward ~90th

- Walk-forward scaffold (item 5)
- Historical Omega replay
- Deeper engines beyond seeds (EPA/SP seeds → live multi-day feeds)

## Live card

The 2026-09-22 production Omega card was left alone: no force generate, no verify, no Discord, no self-opt mutation.
## Live card

The 2026-09-22 production Omega card was left alone: no force generate, no verify, no Discord, no self-opt mutation.
