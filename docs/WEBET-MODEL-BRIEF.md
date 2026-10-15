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
9. Autopilot: start from the current state of the repo, Supabase and the live site, and work continuously, QA'ing as you go, to get the most profitable daily-picks model LIVE. You MAY merge to main and deploy (Netlify auto-deploys on push) when ALL of these are true:
(a) held-out backtest profit and ROI beat current main
(b) all tests pass
(c) the 10/14 dry run produces 3 straights plus a 3-leg parlay (the 30-day replay was removed from the pre-deploy check on 2026-10-15)
(d) it is not 10–11 AM ET or 2:45–3:15 AM ET
Never regenerate the already-published card for today. After each deploy, verify the site is live and append the change and its KPIs to docs/ELITE-MODEL-REPORT-1014.md. Keep iterating until no held-out improvement remains, or until tomorrow's 3 AM run.

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

Deliver docs/ELITE-MODEL-REPORT-1014.md covering:
- each change and why
- a before-and-after KPI table (record, profit in whole $, ROI, CLV), with a row for each tier and each sport
- the 10/14 dry-run card, with each pick's model edge, tier, units and book

---
OWNER-APPROVED FAST PATH FOR TONIGHT (do this FIRST, in this order; WeBet approved: "Yes, rebuild tonight's card with the corrected model." This overrides "never regenerate today's card" for 2026-10-14 only, and for this first deploy only, gates (a) and the 30-day replay in (c) are waived):
1. Pure-model fix: edge and EV from the pure WeBetAI model probability per rules 1–2 (no Pinnacle blend, anchor or gate).
2. QA: all test-omega-*.js and test-sharp-*.js tests pass, and the 2026-10-14 dry run from the stored board gives 3 straights plus a 3-leg parlay.
3. Only if step 2 passes, and outside the 10–11 AM ET and 2:45–3:15 AM ET windows: merge to main and push (Netlify auto-deploys). Verify the deploy is live and record its commit and deploy id.
4. Regenerate the 2026-10-14 card: POST generate-picks-omega-background with {date:'2026-10-14', force:true}. Stored board only, no Odds API calls, X autopost stays off.
5. Verify the new card on /api/get-picks-omega, then immediately print the card: each straight's pick, book, model edge, tier, units, and the 3-leg parlay.
After that, continue on autopilot with the rest of this brief.
