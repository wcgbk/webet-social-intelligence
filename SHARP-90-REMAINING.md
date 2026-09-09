# Sharp-90 remaining (after P0/P1 stack)

**Date:** 2026-09-09  
**Shipped on branch `sharp-90-p0-p1-stack`:** Alpha `v10.6-alpha-sharp-90`, Omega `v11.5-omega-sharp-90`.  
**Do not merge until founder review.** F5 stays off MAIN. Alpha stays MLB-control (no NFL/CFB). `/edge` untouched.

Process percentiles are reasoned bands vs a ~90th-percentile sharp desk (CLV-first, placeable line, pass-when-thin). They are **not** ROI forecasts.

| Book | Process before this PR | Process after this PR | Why still short of 90th |
|---|---|---|---|
| **Alpha** | ~55–62nd | **~72–78th** | Honest KPI window + JS-lock + observer-only calibration + unit caps close the accidental holes. Still consensus (not Pinnacle/HR) priced; CLV n on the new window is tiny; SP confirm is a 1:30pm flag/kill, not T-3h reprice. |
| **Omega MAIN** | ~62–70th | **~75–82nd** | Killing lean pad-to-3 and tightening football MAIN (predCLV ≥ 0, 1 slot) are the two live-card process upgrades. Remaining: football prior is still market-echo; Hard Rock is verify-time advisory; CLV dashboard is wired but n is small. |

**Honest remaining score to ~90th:** this PR likely lands **Alpha ~75, Omega ~78–82**. The last 8–15 points are CLV maturity, placeability at gen time, and SP confirm maturity — not another market-family fade.

---

## What shipped in this PR

**P0**
1. Alpha CLV + self-opt **observer only** (no `coverProb` / `kellyUnits` mutation). Still fetched for Discord/logs.
2. ~~Omega no lean pad-to-3~~ **REVERTED (v11.6 / v10.7)** then **tightened (v10.8 / v11.7)**: fill-to-3 lean top-up; Alpha lean floor EV>0; both books compare best-2 vs best-3 parlays. F5/UD/A's gates stay.

**P1**
3. Alpha `MARKET_UNIT_CAPS` (ML 0.5 / Total 1.5 / RL 1.0 / F5 0.5) + `applyMarketUnitCaps` after Kelly.
4. Alpha `get-picks-alpha` serves **today ET**, not stale `latest-date`.
5. Alpha `get-results-alpha`: **default FULL lifetime history** again (architecture dashboard); optional `?from=` for sharp A/B. Omega MAIN keeps intentional 2026-09-05 KPI floor. Honest `{n}-leg parlay` labels.
6. Alpha Claude is **verify/narrate only** (JS `selectDiversifiedStraights` locks ≤3). Claude fail keeps JS sides; `fallbackToTopCandidates` only if the emergency JS-lock store throws.
7. Fail-closed MLB UD RL if `winProb` missing. Bottom-club plus-money ML/RL ban: **Athletics, Rockies** (hard list).
8. Alpha park rename aliases (Daikin / Rate Field / Oriole Park at Camden Yards / Steinbrenner) + `MLB_CITY_OVERRIDES` Athletics→Sacramento + DH FIP `Team\|eventISO` merge + `pitcherForGame`.
9. Omega football MAIN: `predCLV ≥ 0` when present; **max 1 football slot**.
10. `confirm-starters-mlb` unpaused (`30 17 * * *` = 1:30pm ET). Now reads **Alpha + Omega** stores (not the paused F5 mlb store). Flags SP changes; **kills** SP-dependent MLB totals/ML/F5/RL when gen-time `homeSP`/`awaySP` no longer match ESPN. Pre-v10.6 cards without stored SPs are snapshotted, not killed.
11. Docs: this file, `PRODUCT-STATE.md`, `CLAUDE.md`, `MLB-FADE-F5-DOGS.md`.
12. CLV summary: `GET /api/get-clv-summary?book=alpha|omega&from=&to=` plus `clv` object on `get-results-alpha` / `get-results-omega`. Mean cents / beat-close % / n by market family from existing `clv-{date}` blobs. Honest nulls if missing.

---

## SP reconfirm behavior (item 10)

- Cron: `confirm-starters-mlb` at **1:30pm ET** (`30 17 * * *`).
- Stores: `edge-picks-alpha`, `edge-picks-omega` for **today ET**.
- ESPN MLB scoreboard probable starters vs pick `awaySP`/`homeSP` (attached at gen time).
- If SP changed and the pick is Total / Moneyline / F5 / Run Line: pick is **removed** from `picks` into `killedPicks` with `killReason`. Summary units recount. Parlay dropped if <2 live legs.
- If the game is already `in`/`post`, skip (too late).
- If gen-time SP names are missing, snapshot current ESPN names and do **not** kill (cannot prove a change).
- This is **not** a T-3h-to-first-pitch reprice. Night SPs that scratch after 1:30pm still need a later pass (backlog).

---

## Concrete backlog to close the gap to ~90th

| Gap | Why it matters | What “done” looks like |
|---|---|---|
| **CLV n maturity** | Process is now CLV-first in code comments, but the public object is still a stub until `n` per market family is large enough to steer. Totals vs ML sizing still rests on Jun–Aug comment numbers, not the post-gate book. | `get-clv-summary` `n≥30` per family on the shared `KPI_START` window; raise/cut `MARKET_UNIT_CAPS` only from trailing CLV, never Discord. |
| **SP confirm maturity** | Totals are the live book and 9am is early for night SPs. 1:30pm catch is real but incomplete. | Second pass T-3h to first pitch (or 4pm/6pm ET) that **reprices** or kills, not just flags. Store confirmed SPs on the pick. |
| **Football MAIN** | Fold is still a market-anchored prior (NFL 50% market / CFB 70%). One slot + predCLV≥0 stops weekend dilution; it does not create elite football projection. | Keep NFL/CFB **standalones** as the lab. Do not raise `FOOTBALL_MAIN_MAX_SLOTS` until folded-leg CLV `n≥30` and mean cents ≥ 0. |
| **HR / Circa placeability at gen time** | Published ticket is consensus; Hard Rock check is 10:30 advisory. A −105 consensus that is −118 at HR is not the bet the user shops. | Generate at a named book (HR or Circa) **or** print `book` + placeable price on the pick. |
| **True-line engine** | Consensus (`us,us2,eu`, sharpness-weighted median) is a solid retail engine, not Pinnacle/exchange no-vig. | Optional: price EV vs Pinnacle/Betfair no-vig; shop juice at the user’s book. Do not pretend consensus is a sharp true line. |
| **Team-tier prior (beyond hard list)** | Athletics/Rockies hard ban stops the last hop. Next weak club will rank #1 on EV until it prints. | Elo/standings **bottom quartile** of MLB (rolling) for plus-money ML/RL, not a growing nickname list. |
| **F5** | Still computed for analytics. Dog ROI `n=134` is known (−21%). Do **not** re-enable on MAIN. | Dedicated F5 CLV sample on favorites/totals only, founder call. Never plus-money F5 ML. |
| **`/percentile` copy** | Still can advertise F5-on-card / v10.4 caps-on-Alpha that were not live. | Sync `/percentile` to v10.6 / v11.5, F5-off, observer-only, KPI_START. Deferred here (docs pages, not the card). |
| **MAJOR_US_BOOKS hygiene** | Still lists barstool / wynnbet / superbook. Inflates “2+ majors”. | Align with `TOP_US_BOOKS`. P2. |

**What not to do:** A/B Alpha vs Omega on lifetime ROI; add LLM selection budget; copy 0.50 UD cover onto every NFL dog; pad the card to 3; revive `/edge` or F5-on-MAIN.

---

## Tests

```
node test-mlb-fade-f5-dogs.js
node test-sharp-90-gates.js
node test-fill3-parlay-2or3.js
```
