# Omega noon-90 queue

PR A (`feat/omega-v12.2-sport-engines`) is the deep sport-engine pass: NFL/CFB EPA-style priors and MLB starter + park factors inside omega-vnext only. Today's live card was not regenerated.

PR B (`feat/omega-v12.2-placeability`, v12.2.1) is shipping: generate-time placeability soft-veto. The published price must be within juice ballpark (≤3pp implied worse OR ≤15 American cents worse) at ≥2 US retail books from `US_BOOK_PRIORITY` (`PLACEABILITY.minMajorBooks`). Reject reason `placeability-soft-veto`, distinct from `insufficient-liquidity` (that gate still counts Pinnacle). Verify drops a pick only when Hard Rock and majors coverage both fail; if the odds API is down, warn and leave the card. Empty card OK — no lean refill. Items 3–5 below stay queued. The 2026-09-22 production card was not regenerated.

## 3. Kalshi / Polymarket observer sidecar — QUEUED

Read-only sidecar next to the card. Do not mix prediction-market prices into live selection, grades, or unit caps, and do not place orders. Wire it only after the v12.2 engines are stable.

## 4. TSP historical — ON HOLD

After the Kalshi observer, not before. TOS-safe only: no live `tsp.live` calls and no scrape that violates terms. Do not copy Alpha Elo or lean parameters into Omega selection. Held until a compliant historical path exists.

## 5. Walk-forward — scaffold only

A later PR may add the walk-forward scaffold. No coefficient fit in the engines change. The actual fit is Monday 11:00 ET on or after 2026-09-29. Do not refit or mutate the self-opt loop before that.

## Live card

The 2026-09-22 production Omega card was left alone: no force generate, no verify, no Discord, no self-opt mutation.
