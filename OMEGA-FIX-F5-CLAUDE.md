# Omega fix: F5 off MAIN + Claude verify + schedule align (`v11.2-omega-no-f5-claude-verify`)

## Rockies / F5 decision

**Published Omega MAIN card no longer includes F5** (`ALLOW_F5_ON_CARD = false`).

Why:
- F5 is unvalidated (forward-CLV only) and historically soft on the conviction card.
- Rockies / Coors-style F5 MLs kept surfacing; park + home/away edge cases made the market noisy.

What we audited / fixed (even though F5 is off-card):
1. **Home/away mapping** — Sox-safe detector already avoided `includes("sox")` collisions; tightened further to **exact full-name + exact last-token** matching (no bare substring). Ambiguous names still resolve to **away** (never guess home). Log warns on ambiguity.
2. **Coors park double-count** — F5 previously applied the **full** park factor (`114 → 1.14`) while full-game uses **dampened ×0.5**. That systematically inflated Coors/Rockies F5 spots. F5 now uses the same dampened park mult as full-game.
3. **No grading inversion found** in `f5IsHomeTeam` / `projF5Margin` / starter-vs-offense wiring after the prior "aces' opponents" sign fix. Residual Rockies appearances were more **selection + Coors inflation** than a flipped home/away label.

F5 is still **computed and attached** when Odds API per-event lines are available (analytics / candidate table / CLV diagnostics) but is **filtered out** of:
- `selectDiversifiedStraights` / binding YES
- lean top-ups
- correlated parlays
- JS emergency / fallback card paths

Flip `ALLOW_F5_ON_CARD = true` only after a dedicated F5 validation pass.

## Claude change (timeouts / retry storms)

**Before:** Claude selected from top-15 (`web_search` max_uses 20, 120s × 4 retries, then top-8 retry storm) → often aborted → `fallback:true` rewrote sides.

**After (JS-locks-3):**
1. Rank candidates; **JS** runs `selectDiversifiedStraights` and locks ≤3 YES (F5 excluded).
2. Claude receives **only those ≤3** with `web_search` **max_uses 5**.
3. Single long attempt **~180000ms**, **retries 1**.
4. Claude **verifies + narrates** (may news-veto → JS fills next diversified YES). Cannot invent sides.
5. On fail: **keep JS picks**, Haiku narrate, set **`claudeVerified: false`** (no side-rewriting selector fallback).

## Schedule alignment (ET)

| Pipeline | Cron (UTC) | Local ET | Notes |
|----------|------------|----------|-------|
| Omega MAIN | `0 13 * * *` | 9:00am | Unchanged |
| NFL standalone | `5 13 * * *` | 9:05am | Was 11:00am — stagger vs Omega Odds pull |
| CFB standalone | `10 13 * * *` | 9:10am | Was 11:05am |
| verify-picks-omega | `30 14 * * *` | 10:30am | Unchanged |

**Choice documented:** prefer 9:00 Omega / 9:05 NFL / 9:10 CFB (shared morning live process, avoid Odds API burst).

**Verify crons for NFL/CFB:** `verify-picks-nfl.js` / `verify-picks-cfb.js` **do not exist**. Skipped huge clones. Standalones rely on **JS-select discipline + CLV** (`track-clv-nfl` / `track-clv-cfb`). Optional follow-up: thin verify wrappers for those stores.

## Alpha

Untouched.

## Model version

`v11.2-omega-no-f5-claude-verify`
