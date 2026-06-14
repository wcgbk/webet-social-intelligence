#!/usr/bin/env python3
# ESPN-grounding patch for the picks narratives — STAGED, NOT YET DEPLOYED.
# Grounds team records (incl. home/road splits) in ESPN's free API so the SELECTOR
# narrative cites them from the candidate table instead of ad-hoc web search.
#
#   python3 espn-grounding-apply.py            # DRY RUN: patch /tmp copies + node --check
#   python3 espn-grounding-apply.py --apply    # APPLY to the real protected files (only when greenlit)
#
# After --apply: run `node --check` on both, deploy from main, then sim-verify
# (POST snapshotTime to generate-picks-alpha-background, read get-picks-alpha-sim).
import shutil, subprocess, sys

APPLY = "--apply" in sys.argv
FILES = ["generate-picks-alpha-background", "generate-picks-mvp-background"]

EDITS = [
  # 1a — declare split vars alongside ppg vars
  ("        let ppgFor = null, ppgAgainst = null;",
   "        let ppgFor = null, ppgAgainst = null;\n        let recordTotal = null, recordHome = null, recordRoad = null;"),
  # 1b — extract ESPN total/home/road record summaries from record.items
  ("          const recordItems = teamData.team?.record?.items || [];",
   "          const recordItems = teamData.team?.record?.items || [];\n          recordTotal = (recordItems.find(i => i.type === 'total') || {}).summary || null;\n          recordHome = (recordItems.find(i => i.type === 'home') || {}).summary || null;\n          recordRoad = (recordItems.find(i => i.type === 'road') || {}).summary || null;"),
  # 2 — attach splits to teamStats[teamName] (anchor = end of basketball branch + closes)
  ("""              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
            };
          }
        }
      } catch (e) { /* continue */ }""",
   """              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
            };
          }
          if (teamStats[teamName]) {
            teamStats[teamName].recordTotal = recordTotal;
            teamStats[teamName].recordHome = recordHome;
            teamStats[teamName].recordRoad = recordRoad;
          }
        }
      } catch (e) { /* continue */ }"""),
  # 3 — prompt Records line: inject ESPN totals + home/road splits
  ("    if (c.homeRecord) prompt += `  Records: ${c.homeTeam} ${c.homeRecord} / ${c.awayTeam} ${c.awayRecord}\\n`;",
   """    {
      const hRec = c.homeStats?.recordTotal || c.homeRecord;
      const aRec = c.awayStats?.recordTotal || c.awayRecord;
      if (hRec || aRec) {
        prompt += `  Records (ESPN, authoritative): ${c.homeTeam} ${hRec || '?'}`;
        if (c.homeStats?.recordHome) prompt += ` [home ${c.homeStats.recordHome}]`;
        prompt += ` / ${c.awayTeam} ${aRec || '?'}`;
        if (c.awayStats?.recordRoad) prompt += ` [road ${c.awayStats.recordRoad}]`;
        prompt += `\\n`;
      }
    }"""),
  # 4 — system prompt: constrain record citations to the table (ESPN), not web/memory
  ("- DO NOT restate projections, lines, edges, cover probabilities, or any numbers from the candidate table.",
   "- DO NOT restate projections, lines, edges, cover probabilities, or any numbers from the candidate table.\n- RECORDS & SPLITS: Cite team win-loss records and home/road records ONLY from the \"Records (ESPN, authoritative)\" line in the candidate table. Never state a record from web search or memory. If a record is not in the table, describe it qualitatively (e.g., \"a strong home team\") with no numbers."),
]

all_ok = True
for name in FILES:
    src = f"netlify/functions/{name}.js"
    dst = src if APPLY else f"/tmp/{name}_patched.js"
    if not APPLY:
        shutil.copy(src, dst)
    txt = open(src).read()
    ok = True
    for i, (old, new) in enumerate(EDITS, 1):
        c = txt.count(old)
        if c != 1:
            print(f"  [{name}] Edit {i}: found {c}x (expected 1) — ABORT")
            ok = False; all_ok = False
    if not ok:
        continue
    for old, new in EDITS:
        txt = txt.replace(old, new)
    open(dst, "w").write(txt)
    chk = subprocess.run(["node", "--check", dst], capture_output=True, text=True)
    status = "PASS" if chk.returncode == 0 else "FAIL " + chk.stderr[:200]
    print(f"{'APPLIED' if APPLY else 'DRY-RUN'} {name}: node --check {status}")
    if chk.returncode != 0:
        all_ok = False

print("\n" + ("ALL OK — ready." if all_ok else "PROBLEMS — do not deploy."))
