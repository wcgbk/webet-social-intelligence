# ESPN-Grounding Patch — narrative record accuracy (STAGED, NOT DEPLOYED)

**Status:** built + validated locally on 2026-06-14. Awaiting Ben's go-ahead to deploy.
**Files:** `generate-picks-alpha-background.js` + `generate-picks-mvp-background.js` (both protected/architecture-locked).
**Apply with:** `python3 espn-grounding-apply.py --apply` (dry-run default patches /tmp copies only).

## Problem it solves
The picks narrative ("SELECTOR" Claude) gets **team records via its own ad-hoc web search**, which can return stale/wrong numbers. Overall records are already injected deterministically from ESPN (good), but **home/road splits are not** — so a line like "White Sox 23-12 *home*" rides on web-search luck. (It happened to be correct, but a general web search during review returned a stale 20-11, proving the source is unreliable.) ESPN's free API is the accurate source and is already fetched by the pipeline.

## What it does (4 surgical, additive edits per file)
1. **Declare** `recordTotal/recordHome/recordRoad` vars in `fetchTeamStats`.
2. **Extract** them from `teamData.team.record.items` (already fetched at line ~694) — the home/road `.summary` values are currently parsed-then-ignored.
3. **Attach** them to `teamStats[teamName]` (so they ride on each candidate's `homeStats`/`awayStats`).
4. **Inject** into the prompt's Records line + **constrain** the SELECTOR system prompt: *cite records ONLY from the "Records (ESPN, authoritative)" line; never from web search/memory; qualitative if absent.*

Net effect on the prompt line:
```
OLD:  Records: Chicago White Sox 37-32 / Los Angeles Dodgers 45-26
NEW:  Records (ESPN, authoritative): Chicago White Sox 37-32 [home 23-12] / Los Angeles Dodgers 45-26 [road 23-14]
```
The home split is now in the table, so the narrative cites it deterministically. Web search stays allowed for time-sensitive items (injuries, scratches) that ESPN standings don't cover.

## Validation already done (local, no deploy)
- ESPN `record.items` returns total+home+road `.summary` for **MLB, NHL (W-L-OTL), NBA** — confirmed live.
- Extraction + new prompt-line logic tested against live ESPN data — produces the correct string.
- All 4 edits apply cleanly to **both** files (each anchor matches exactly once).
- **`node --check` PASSES** on both patched copies.

## To deploy (when greenlit)
1. `python3 espn-grounding-apply.py --apply`
2. `node --check netlify/functions/generate-picks-*-background.js`
3. Deploy from `main`: `npx netlify deploy --prod --dir .`
4. **Sim-verify** (no overwrite): POST `{"snapshotTime":"<now ISO>"}` to `generate-picks-alpha-background`, then read `get-picks-alpha-sim?date=<today>` and confirm narratives cite the injected splits + still read well. Repeat for mvp via `run-picks-mvp`.
5. Note: this changes hash-locked files — re-baseline `PRODUCT-LOOP-BASELINE.sha256` afterward.

## Rollback
`git checkout netlify/functions/generate-picks-alpha-background.js netlify/functions/generate-picks-mvp-background.js` (pre-apply state), redeploy.

## Risk
Additive only — does not touch projection/edge/Kelly math. Worst case if ESPN omits a split: falls back to the existing overall record (graceful). Narrative-only impact.
