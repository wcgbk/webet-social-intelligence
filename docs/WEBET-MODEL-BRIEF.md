WEBET ELITE SHARP MODEL BRIEF (owner-approved rules; you work autonomously within them)

Goal: optimize and QA the Omega/Edge daily-card model (netlify/functions/lib/omega-vnext) to elite sharp-betting standard. The primary objective is daily-card profit and ROI.

Fixed rules (do not change):
1. Edge and EV come from the PURE WeBetAI model probability. Edge = model probability − implied probability of the bet price. EV = model probability × decimal odds − 1. Remove any Pinnacle/sharp blend or anchor from the model probability, and any Pinnacle-based gate.
2. Pinnacle is used ONLY for CLV. CLV = bet decimal × Pinnacle's closing probability with the vig removed, on the same line, − 1. CLV is reported as a check that profit isn't luck; it is never used to select bets.
3. Bet at the better of DraftKings and Hard Rock, by model EV, on the same line.
4. Grades: A+ is 5% edge and up, A is 3.5–5%, A− is 2–3.5%, and B is 1–2% as a 0.5u lean.
5. The card always publishes 3 straights plus a 3-leg parlay (0.25u). Short days are filled with the best remaining picks as 0.5u leans.
6. 1u = $150. KPI and dollar displays use whole dollars, rounded up.
7. Do not change the morning 3 AM / 10 AM schedule, the grading, the results pages or the X posting (autopost stays off).
8. No Odds API calls. Use only stored Supabase data (credentials in /workspace/supabase/webet-db.env; never print them) and the stored Netlify blobs.
9. Do NOT push to main and do NOT deploy. Work on the branch feat/elite-model-1014 and push the branch.

You decide, using elite sharp best practice and evidence from the Supabase history:
- calibration of the model's own probabilities
- sport and market weights
- Kelly sizing within the caps (1u max for A grades, 0.5u for B)
- the stale-line cap
- the odds band
- parlay leg selection
- any model bug fixes

Justify each change with a held-out backtest on Supabase history: profit, ROI and CLV, compared against current main. Keep a change only if it improves held-out profit and ROI.

QA before finishing:
- all test-omega-*.js and test-sharp-*.js tests pass
- a dry run of 2026-10-14 from the stored board produces 3 straights plus a 3-leg parlay
- a 30-day replay shows a full card every day

Deliver docs/ELITE-MODEL-REPORT-1014.md covering:
- each change and why
- a before-and-after KPI table (record, profit in whole $, ROI, CLV), with a row for each tier and each sport
- the 10/14 dry-run card, with each pick's model edge, tier, units and book
