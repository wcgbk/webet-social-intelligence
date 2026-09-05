# Omega UX: live scores, mobile, KPI settle, load

Audit + changes for `/omega` (`daily-omega/`), `/nfl`, `/cfb`. No Alpha model math. No F5-on-MAIN flip (`ALLOW_F5_ON_CARD` stays `false`). No production regen.

## Audit (verified, not guessed)

### 1. Live scores — hypothesis confirmed

Today’s Omega card (`2026-09-05`) is MLB + **NCAAF** (UNLV @ Hawai’i Under 55.5, kickoff `2026-09-06T02:00:00Z` = 10pm ET). CFB standalone also has that Hawaii game plus WKU/Nevada and an **FCS** leg (MVSU vs Sacramento State).

| Surface | ESPN map | Date param | CFB groups | Match |
|---|---|---|---|---|
| `/omega` **before** | **No NFL / NCAAF** | pick date only | n/a | last-word nicknames (Tigers collide) |
| `/nfl` **before** | NFL present | **none** (week board only) | n/a | last-word |
| `/cfb` **before** | NCAAF present | **none** | `groups=80` only (FBS/featured) | school-key (good) |
| KPI `get-results-omega` **before** | **No NFL / NCAAF** | pick date only | n/a | last-word |
| KPI `get-results-cfb` **before** | NCAAF | pick date | `groups=80` only | school-key |

**Gaps that actually dropped scores / left KPI pending:**

1. Omega client + `get-results-omega` could not fetch football scoreboards at all (`ESPN_ENDPOINTS[sport]` returned empty). NCAAF cards stayed “Upcoming”; KPI `pending: 3` even after finals.
2. NFL/CFB clients fetched the undated board only — late Hawaii / UTC-spill games (commence `…T02:00:00Z`) can sit on ESPN date D+1 vs the ET pick date.
3. `groups=80` misses FCS. CFB’s Sac State / MVSU leg would never attach a score or grade.
4. Omega used last-word matching on NCAAF (`Tigers` / `Bulldogs` / `Warriors`).

**Not a gap:** pick-card scorebar UI (`scoreBarHTML`) already renders live → final when `findGame` hits. The break was polling + match, not the chrome.

### 2. Mobile

Pick cards used `white-space: nowrap` on matchups, rigid `min-width: 100px` team names, and a single-line footer (`1.0u - Bet $150 — To Win +$136` + LIVE/WIN + edge). Live scorebar is a second flex row — overflow/clip on 375–430px once scores appear.

### 3. KPIs

- Day boundary is already `America/New_York` (`getEasternDateToday` / `en-CA`).
- Floor is already `KPI_START = "2026-09-05"` on omega / nfl / cfb. Unchanged. No invented numbers.
- Settle was **5-minute blob + CDN cache** even with live games. Client also re-hit KPIs every 30s (wasted) *or* waited a full 5 min after final.

### 4. Page load

Live Omega payload included `candidateTable`, `modelProjections`, `thinkingText`, full `rejections` — unused on the card. `/api/get-picks-omega` was fetched with `cache: 'no-store'`, and first paint waited on ESPN before rendering the card.

## Changes

### Live scores (all three pages + KPI graders)

- ESPN map includes **NFL** and **NCAAF**.
- Fetch **dated** (pick date + each `commenceTime` ET date) **and undated** (current/week) boards; merge, prefer `in` > `post` > `pre`.
- NCAAF: `groups=90` (D1 FBS+FCS) **and** `groups=80` (FBS/featured).
- KPI fetch also pulls **D-1 / D / D+1** so Hawaii/UTC spill still grades.
- Omega NCAAF matching is **school-keyed** (same idea as `/cfb`).
- Omega live win-prob clocks include NFL/NCAAF (was defaulting to 0.5 elapsed).
- Cards still hide the scorebar pre-game; show it from first pitch/kick through Final.

### Mobile

- `.pick-matchup-row`, `.pick-footer`, wrapping chips, ellipsized score names.
- `@media (max-width: 600px)` and `400px`: wrap matchup, shrink units, stack scorebar meta so live chrome does not overflow.
- **Nav (Omega + CFB):** same hamburger/dropdown as NFL. Hamburger at `max-width: 900px` so tablet ~768px does not keep a nowrap pill row (CFB has four long labels). Duplicate Dashboard chip hides when the hamburger is on; Omega badge shortens to “Omega” under 480px. No `overflow-x: auto` on `.header-nav` (that was the inner nav scrollbar / clipped labels at ~390px).
- **Nav (NFL):** same pattern at phone widths. Hamburger stays at `max-width: 640px` (NFL pills are shorter). Duplicate Dashboard chip is a `.header-dash` that hides with the hamburger so logo + Sign in + menu fit at ~375–390px; no `overflow-x: auto` on `.header-nav`; header padding tightens under 480px. Hamburger must stay on-screen; `html`/`body` `scrollWidth` must not exceed `clientWidth`.

### KPI settle (still real ESPN grades)

- Cache keys: `results-omega-cache-v3`, `results-nfl-cache-v4`, `results-cfb-cache-v3` (bust the football-blind / 5-min-only caches).
- Adaptive TTL: **30s** while any pick is `pending`, **5 min** once the ET slate is decided.
- `?refresh=1` skips blob cache. Client busts immediately when a pick’s live/final signature changes; otherwise KPI polls at 45s (live) / 5 min (all final).

### Load

- Public `get-picks-*` strips `candidateTable`, `modelProjections`, `thinkingText`, `sgps`, `rejections`, Kelly/z internals. Sharp Depth remains `get-picks-premium`. Measured on live 2026-09-05 Omega JSON: **18.0 KB → 6.1 KB (−66%)**.
- Card HTML paints **before** ESPN; scores overlay on arrival.
- Cache-Control: picks `max-age=60–120` + `stale-while-revalidate`; HTML `/daily-omega` `/nfl` `/cfb` `max-age=120`.
- `preconnect` to jsDelivr + ESPN. Removed `cache: 'no-store'` on Omega picks.

## Test plan (PR)

1. **Mobile widths** — 375 / 390 / 430 / 768: pick cards, live scorebar, units row, parlay legs. No horizontal scroll, no clipped LIVE/Final chip. Top nav: hamburger (not a scrolling/clipped pill row) on `/daily-omega` and `/cfb` at 390 and 768; `/nfl` hamburger visible at 390 with no page-level horizontal scrollbar (`scrollWidth <= clientWidth`); labels fully visible.
2. **Live → final** — `/omega` NCAAF (UNLV–Hawaii) and `/cfb` same game: scorebar appears at kick, updates in-game, shows Final. FCS CFB leg (MVSU/Sac State) also attaches.
3. **KPI after final** — when the game goes `post`, day’s row + cumulative record/ROI update within ~30s (or immediately on the next score poll). Totals are ESPN-graded, not placeholders. KPI day = ET, start `2026-09-05`.
4. **Load** — Network: `get-picks-omega` JSON no longer includes `candidateTable`/`thinkingText`; first contentful card does not wait on ESPN.
5. **Non-regression** — Omega model still `v11.2-omega-no-f5-claude-verify`; F5 stays off MAIN; Alpha generators untouched.

`node test-omega-ux-live-kpi.js` covers endpoints, payload trim, cache TTL, and page wiring.
