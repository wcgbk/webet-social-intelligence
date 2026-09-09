# MLB fade: F5 dogs + underdog ML coverProb gate

Ship on `mlb-fade-f5-dogs-underdog-ml-gate`. Stops two bleed patterns from the published MAIN card without changing Claude verify-only (Omega), CFB/NFL standalones, school-name display, or KPI/live score UX.

## Versions

| Pipeline | Previous | This ship |
|----------|----------|-----------|
| Omega MAIN | `v11.2-omega-no-f5-claude-verify` | `v11.3-omega-fade-ud-ml` |
| Alpha MAIN | `v10.3-alpha-sharp` | `v10.4-alpha-fade-f5-ud` |

## Constants

Both generators (`generate-picks-omega-background.js`, `generate-picks-alpha-background.js`):

| Constant | Value | Effect |
|----------|-------|--------|
| `F5_SKIP_ML_UNDERDOG` | `true` | Plus-money F5 moneyline sides are skipped at F5 candidate build (`if (F5_SKIP_ML_UNDERDOG && (data.price \|\| 0) > 0) continue`). |
| `ALLOW_F5_ON_CARD` | `false` | All F5 markets stay off the published MAIN card (straights, leans, parlays). F5 is still computed/attached for analytics when Odds API F5 lines are cheap. |
| `UNDERDOG_ML_MIN_COVER_PROB` | `0.50` | Full-game **MLB moneyline underdogs** (American price `> 0`) need calibrated `coverProb ≥ 0.50`. `≤ 0.499` is treated the same as `< 0.50`. |

## Helpers

- `isF5Candidate(c)` — `source === "F5"` or market/side/pick contains F5.
- `allowOnOmegaCard` / `allowOnAlphaCard` — `ALLOW_F5_ON_CARD \|\| !isF5Candidate(c)`.
- `isFullGameUnderdogML(c)` — MLB, full-game Moneyline (not F5), American odds `> 0`.
- `passesUnderdogMlCoverGate(c)` — true unless it is a full-game MLB underdog ML with `coverProb < 0.50` (incl. `≤ 0.499`).
- `allowOnPublishedCard(c)` — F5-off-card **and** underdog-ML cover gate.
- `publishedCardRejectionReason(c)` — writes the candidate into `rejections` with:
  - F5: `F5 disabled on {Omega\|Alpha} MAIN card (ALLOW_F5_ON_CARD=false) — computed for analytics only.`
  - UD ML: `underdog ML coverProb < 0.50`

## What is not gated

- Favorites (minus-money ML).
- Run lines / spreads.
- Totals (full-game or F5).
- Non-MLB sports (NFL/CFB/NHL/NBA MLs).
- F5 if `ALLOW_F5_ON_CARD` is later flipped true — plus-money F5 ML still skipped at build while `F5_SKIP_ML_UNDERDOG` is true.

## Rationale

- **F5 dogs:** −21% ROI on n=134 (ESPN-graded). F5 is a starter-priced market the book already prices efficiently; the model's "live dog" edge is phantom.
- **F5 off MAIN:** unvalidated (forward-CLV only). Alpha graded Athletics F5 ~1-4 and Rockies F5 ~0-2. Omega already had `ALLOW_F5_ON_CARD=false` in v11.2; Alpha now matches.
- **Underdog ML coverProb:** Athletics/Rockies-style longshots can rank high on EV with ~40–42% calibrated cover. Plus-money MLB ML is only allowed on the card when the model actually thinks the side is at least a coin flip (`≥ 0.50`).

## Alpha F5 status

**Fully off-card** (`ALLOW_F5_ON_CARD=false`) **and** plus-money F5 ML dog-ban (`F5_SKIP_ML_UNDERDOG=true`). F5 totals / rare F5 favorites are still computed for the analytics candidate table, then filtered out of YES / Claude's selection table / fallback / lean / parlay.
