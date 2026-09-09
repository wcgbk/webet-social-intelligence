# MLB fade: F5 dogs + underdog ML/RL coverProb gate

Ship on `mlb-fade-underdog-runline` (follows `mlb-fade-f5-dogs-underdog-ml-gate` / PR #19). Stops F5, sub-50% underdog ML, **and** underdog run-line hops from the published MAIN card. Sharp-90 (`v10.6-alpha-sharp-90` / `v11.5-omega-sharp-90`) adds fail-closed missing winProb + Athletics/Rockies plus-money ML/RL ban. F5 stays off MAIN. See `SHARP-90-REMAINING.md`.

## Versions

| Pipeline | Previous | This ship |
|----------|----------|-----------|
| Omega MAIN | `v11.4-omega-fade-ud-rl` | `v11.5-omega-sharp-90` |
| Alpha MAIN | `v10.5-alpha-fade-ud-rl` | `v10.6-alpha-sharp-90` |

## Constants

Both generators (`generate-picks-omega-background.js`, `generate-picks-alpha-background.js`):

| Constant | Value | Effect |
|----------|-------|--------|
| `F5_SKIP_ML_UNDERDOG` | `true` | Plus-money F5 moneyline sides are skipped at F5 candidate build (`if (F5_SKIP_ML_UNDERDOG && (data.price \|\| 0) > 0) continue`). |
| `ALLOW_F5_ON_CARD` | `false` | All F5 markets stay off the published MAIN card (straights, leans, parlays). F5 is still computed/attached for analytics when Odds API F5 lines are cheap. |
| `UNDERDOG_ML_MIN_COVER_PROB` | `0.50` | Full-game **MLB moneyline underdogs** (American price `> 0`) need calibrated `coverProb ≥ 0.50`. `≤ 0.499` is treated the same as `< 0.50`. |
| `UNDERDOG_RL_MIN_COVER_PROB` | `0.50` | Full-game **MLB underdog run lines** (picked side receiving +runs, typically `+1.5`; market `Run Line` or `Spread`) need calibrated `coverProb ≥ 0.50`. Same `≤ 0.499` rounding. |
| `UNDERDOG_RL_MIN_WIN_PROB` | `0.50` | Picked side's model win probability must be `≥ 0.50`. **Fail closed** if `homeWinProb` is missing (`underdog RL winProb missing`). |
| Bottom-club ban | Athletics, Rockies | Plus-money ML **and** underdog RL (`+runs`) on these clubs never publish, even if cover/EV clear. |

## Helpers

- `isF5Candidate(c)` — `source === "F5"` or market/side/pick contains F5.
- `allowOnOmegaCard` / `allowOnAlphaCard` — `ALLOW_F5_ON_CARD \|\| !isF5Candidate(c)`.
- `isFullGameUnderdogML(c)` — MLB, full-game Moneyline (not F5), American odds `> 0`.
- `passesUnderdogMlCoverGate(c)` — true unless it is a full-game MLB underdog ML with `coverProb < 0.50` (incl. `≤ 0.499`).
- `isFullGameUnderdogRL(c)` — MLB, full-game Run Line/Spread (not F5), picked side has a **positive** run line (`Athletics +1.5`).
- `passesUnderdogRlCoverGate(c)` — true unless UD RL with `coverProb < 0.50`.
- `passesUnderdogRlWinGate(c)` — true unless UD RL with model `winProb < 0.50` **or winProb missing** (fail closed).
- `passesBottomClubBan(c)` — false for Athletics/Rockies plus-money ML or underdog RL.
- `allowOnPublishedCard(c)` — F5-off-card **and** underdog-ML cover **and** underdog-RL cover/win **and** bottom-club ban.
- `publishedCardRejectionReason(c)` — writes the candidate into `rejections` with:
  - F5: `F5 disabled on {Omega\|Alpha} MAIN card (ALLOW_F5_ON_CARD=false) — computed for analytics only.`
  - UD ML: `underdog ML coverProb < 0.50`
  - UD RL cover: `underdog RL coverProb < 0.50`
  - UD RL win: `underdog RL winProb < 0.50`
  - UD RL missing: `underdog RL winProb missing`
  - Bottom club: `bottom-quartile MLB club plus-money ML/RL banned`

## What is not gated

- Favorites (minus-money ML, minus run line e.g. `Yankees -1.5`).
- Totals (full-game or F5).
- Non-MLB sports (NFL/CFB/NHL/NBA spreads and MLs).
- F5 if `ALLOW_F5_ON_CARD` is later flipped true — plus-money F5 ML still skipped at build while `F5_SKIP_ML_UNDERDOG` is true.

## Rationale

- **F5 dogs:** −21% ROI on n=134 (ESPN-graded). F5 is a starter-priced market the book already prices efficiently; the model's "live dog" edge is phantom.
- **F5 off MAIN:** unvalidated (forward-CLV only). Alpha graded Athletics F5 ~1-4 and Rockies F5 ~0-2. Omega already had `ALLOW_F5_ON_CARD=false` in v11.2; Alpha now matches.
- **Underdog ML coverProb:** Athletics/Rockies-style longshots can rank high on EV with ~40–42% calibrated cover. Plus-money MLB ML is only allowed on the card when the model actually thinks the side is at least a coin flip (`≥ 0.50`).
- **Underdog RL:** PR #19 killed Athletics ML then both cards published **Athletics +1.5** (next-best EV). +1.5 dogs routinely clear a 0.50 RL coverProb (~54–55% on 2026-09-09) even when the model has them losing the game (Athletics ML 41%, homeWinProb 46%). Cover floor matches ML; winProb floor (when `homeWinProb` is on the candidate) stops the ML→RL hop.

## Alpha F5 status

**Fully off-card** (`ALLOW_F5_ON_CARD=false`) **and** plus-money F5 ML dog-ban (`F5_SKIP_ML_UNDERDOG=true`). F5 totals / rare F5 favorites are still computed for the analytics candidate table, then filtered out of YES / Claude's selection table / fallback / lean / parlay.
