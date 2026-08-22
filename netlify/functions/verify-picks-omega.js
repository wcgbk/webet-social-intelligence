// verify-picks.js
// v2: Post-pick verification + auto-fix + sharp handicapper review + Discord alerts
//
// Runs at 10:30am ET daily. For each pick on today's beta card:
// 1. MATH CHECKS: Recompute EV, Kelly, grade. Flag mismatches.
// 2. NARRATIVE CHECKS: Verify reasoning mentions correct team, correct length, whatLoses present.
// 3. SHARP REVIEW: Call Claude as an elite Vegas handicapper to review the full card.
// 4. AUTO-FIX: If a pick fails critical checks (negative EV, math broken), replace it with the
//    next best candidate from the candidate table. Rewrite the blob so the page updates.
// 5. DISCORD ALERT: Post errors/warnings to #picks-model-optimization.
//
// The goal: the user ALWAYS sees 3 clean, verified picks with correct math and coherent narratives.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const DISCORD_CHANNEL = "1482660132222537808";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Helpers ──
function americanToDecimal(odds) { return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds); }
function impliedProb(odds) { return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100); }
function parseOdds(s) { return parseInt(String(s).replace(/[^0-9\-+]/g, ""), 10); }
function parseUnits(s) { return parseFloat(String(s).replace(/[^0-9.]/g, "")); }
function parseProbability(s) { const n = parseFloat(String(s).replace(/[^0-9.]/g, "")); return n > 1 ? n / 100 : n; }
function unitsToRating(u) { if (u >= 2.5) return "A+"; if (u >= 1.5) return "A"; if (u >= 1.0) return "A-"; if (u >= 0.5) return "B+"; return "B"; } // aligned w/ generator thresholds

// ── Math Checks ──
function runMathChecks(pick) {
  const warnings = [], errors = [];
  const checks = { evMatch: true, kellyMatch: true, gradeMatch: true, edgePositive: true };
  const odds = parseOdds(pick.odds);
  const units = parseUnits(pick.units);
  const coverProb = parseProbability(pick.winProbability || pick.coverProb);
  const decPayout = americanToDecimal(odds);
  const breakeven = impliedProb(odds);

  if (isNaN(odds) || isNaN(units) || isNaN(coverProb)) {
    errors.push("CRITICAL: Cannot parse odds, units, or probability");
    return { checks, warnings, errors, severity: "critical" };
  }

  // EV check
  const computedEV = coverProb * decPayout - 1;
  if (computedEV <= 0) {
    checks.edgePositive = false;
    errors.push(`CRITICAL: Negative EV (${(computedEV * 100).toFixed(1)}%) — coverProb ${(coverProb * 100).toFixed(0)}% <= breakeven ${(breakeven * 100).toFixed(0)}%`);
  }

  // EV display match
  if (pick.kellyCalc) {
    const evMatch = pick.kellyCalc.match(/edge=([\d.-]+)/);
    if (evMatch && Math.abs(computedEV - parseFloat(evMatch[1])) > 0.03) {
      checks.evMatch = false;
      warnings.push(`EV mismatch: computed ${(computedEV * 100).toFixed(1)}% vs displayed ${(parseFloat(evMatch[1]) * 100).toFixed(1)}%`);
    }
  }

  // Grade check
  const expectedGrade = unitsToRating(units);
  if (pick.rating && pick.rating !== expectedGrade) {
    checks.gradeMatch = false;
    warnings.push(`Grade mismatch: "${pick.rating}" but ${units}u should be "${expectedGrade}"`);
  }

  const hasCritical = errors.some(e => e.startsWith("CRITICAL"));
  return { checks, warnings, errors, severity: hasCritical ? "critical" : warnings.length > 0 ? "warning" : "clean" };
}

// ── Narrative Checks ──
function runNarrativeChecks(pick) {
  const warnings = [], errors = [];
  const checks = { mentionsPickedTeam: true, reasonableLength: true, whatLosesPresent: true, narrativeDirection: true };
  const reasoning = pick.coreReasoning || "";
  const pickName = pick.pick || "";

  // Extract team name from pick
  const teamToken = pickName.split(/\s+(ML|[-+]?\d)/)[0].trim();
  const isTotal = /over|under/i.test(pickName);

  if (!isTotal && teamToken && reasoning.length > 0) {
    const lastWord = teamToken.split(/\s+/).pop().toLowerCase();
    if (lastWord.length > 3 && !reasoning.toLowerCase().includes(lastWord)) {
      checks.mentionsPickedTeam = false;
      warnings.push(`Narrative doesn't mention picked team "${teamToken}"`);
    }
  }

  // Length check
  const sentences = reasoning.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length < 2) {
    checks.reasonableLength = false;
    errors.push("CRITICAL: Narrative too short — fewer than 2 sentences");
  } else if (sentences.length > 7) {
    checks.reasonableLength = false;
    warnings.push(`Narrative too long: ${sentences.length} sentences`);
  }

  // Empty narrative
  if (reasoning.trim().length < 20) {
    errors.push("CRITICAL: Narrative is empty or nearly empty");
  }

  // whatLoses
  if (!pick.whatLoses || pick.whatLoses.trim().length < 10) {
    checks.whatLosesPresent = false;
    warnings.push("whatLoses field is empty or too short");
  }

  const hasCritical = errors.some(e => e.startsWith("CRITICAL"));
  return { checks, warnings, errors, severity: hasCritical ? "critical" : warnings.length > 0 ? "warning" : "clean" };
}

// ── Hard Rock Bet placeability check (Ben-directed, 2026-08-22) ──
// QA must confirm every published bet — each straight pick AND each parlay leg — is a bet a
// user can actually place at a major US sportsbook, using Hard Rock Bet as the confirmation
// book, at a price/line in the ballpark of what the card expresses. Ballpark: the market
// exists at Hard Rock for that game; totals/spreads point within 0.5 of the published line;
// Hard Rock's price no more than ~3 implied-probability points worse than published
// (≈20-25 American cents). Missing market/game → error; point drift ≤0.5 or worse-but-close
// price → warning. ADVISORY: findings go to the QA report + Discord alert; this check never
// modifies the published card (severity is never escalated to critical, so auto-fix ignores it).
const HR_BOOK_KEYS = new Set(["hardrockbet", "hardrockbet_oh", "hardrock"]);
const HR_SPORT_KEYS = { MLB: "baseball_mlb", NBA: "basketball_nba", NHL: "icehockey_nhl", NFL: "americanfootball_nfl" };
const HR_F5_MARKETS = { "F5 Moneyline": "h2h_1st_5_innings", "F5 Run Line": "spreads_1st_5_innings", "F5 Total": "totals_1st_5_innings" };
const HR_ODDS_WORSE_PP = 3.0; // warning: Hard Rock implied prob >3pp worse than published
const HR_ODDS_ERROR_PP = 6.0; // error: >6pp worse — materially off the expressed price

function hrLastWord(name) { return String(name || "").trim().split(/\s+/).pop().toLowerCase(); }
function hrImpliedPct(american) { return impliedProb(american) * 100; }
function hrMatchGame(games, matchup) {
  const m = String(matchup || "").toLowerCase();
  return (games || []).find(g => m.includes(hrLastWord(g.home_team)) && m.includes(hrLastWord(g.away_team))) || null;
}
function hrBookFrom(game) {
  return ((game && game.bookmakers) || []).find(b => HR_BOOK_KEYS.has((b.key || "").toLowerCase())) || null;
}
function hrMarketFrom(book, marketKey) {
  return ((book && book.markets) || []).find(mk => mk.key === marketKey) || null;
}

// Find the published pick's side inside one book's market, plus the published point.
function hrFindOutcome(market, pick, marketKey) {
  let outcome = null, pubPoint = null;
  if (marketKey === "h2h" || marketKey === "h2h_1st_5_innings") {
    const team = String(pick.pick || "").replace(/\s*(F5\s*)?ML\s*$/i, "").trim();
    outcome = (market.outcomes || []).find(o => hrLastWord(o.name) === hrLastWord(team) || String(o.name).toLowerCase().includes(hrLastWord(team)));
  } else if (marketKey === "totals" || marketKey === "totals_1st_5_innings") {
    const side = /under/i.test(pick.pick) ? "Under" : "Over";
    pubPoint = parseFloat(String(pick.pick).replace(/[^0-9.]/g, ""));
    outcome = (market.outcomes || []).find(o => o.name === side);
  } else {
    const team = String(pick.pick || "").replace(/[-+]?\d+(\.\d+)?\s*$/, "").trim();
    const ptMatch = String(pick.pick || "").match(/([-+]?\d+(\.\d+)?)\s*$/);
    pubPoint = ptMatch ? parseFloat(ptMatch[1]) : null;
    outcome = (market.outcomes || []).find(o => hrLastWord(o.name) === hrLastWord(team) || String(o.name).toLowerCase().includes(hrLastWord(team)));
  }
  return { outcome, pubPoint };
}

// Hard Rock DOES offer F5 on-app (branded "First 5 Innings") but its F5 prices don't flow
// through The Odds API (verified 0/15 MLB events on 2026-08-22 while 14 other books quote
// them — a feed-coverage gap, NOT a Hard Rock product gap; Ben-corrected 2026-08-22).
// When HR is absent from an F5 event, confirm placeability against the other major US
// books instead: >=3 majors quoting the same bet with a ballpark median = placeable
// (informational note to spot-check the HR app); <3 majors or off-ballpark median = flag.
const HR_MAJOR_BOOKS = new Set([
  "draftkings", "fanduel", "betmgm", "caesars", "williamhill_us",
  "espnbet", "betrivers", "fanatics", "hardrockbet", "hardrockbet_oh",
]);
function hrMajorsFallback(pick, game) {
  const out = { available: false, hrOdds: null, hrPoint: null, warnings: [], errors: [], notes: [] };
  const marketKey = HR_F5_MARKETS[pick.betType || ""];
  const pubOdds = parseOdds(pick.odds);
  const prices = [];
  for (const b of (game.bookmakers || [])) {
    if (!HR_MAJOR_BOOKS.has((b.key || "").toLowerCase())) continue;
    const market = hrMarketFrom(b, marketKey);
    if (!market) continue;
    const { outcome, pubPoint } = hrFindOutcome(market, pick, marketKey);
    if (!outcome || !Number.isFinite(outcome.price)) continue;
    if (pubPoint !== null && Number.isFinite(outcome.point) && Math.abs(outcome.point - pubPoint) > 0.5) continue;
    prices.push(outcome.price);
  }
  if (prices.length < 3) {
    out.errors.push(`HardRock: Hard Rock's First 5 Innings prices aren't in the odds feed and only ${prices.length} other major book(s) quote this bet — not confirmed placeable`);
    return out;
  }
  const sorted = prices.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const medianStr = median > 0 ? `+${median}` : `${median}`;
  out.available = true;
  const worsePP = Number.isFinite(pubOdds) ? hrImpliedPct(median) - hrImpliedPct(pubOdds) : 0;
  if (worsePP > HR_ODDS_ERROR_PP) {
    out.available = false;
    out.errors.push(`HardRock: majors' median F5 price ${medianStr} vs published ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — outside ballpark`);
  } else if (worsePP > HR_ODDS_WORSE_PP) {
    out.warnings.push(`HardRock: majors' median F5 price ${medianStr} vs published ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — worse but in ballpark`);
  }
  if (out.available) {
    out.notes.push(`HardRock: HR lists this as "First 5 Innings" on-app but its F5 prices aren't in the odds feed — confirmed at ${prices.length} majors (median ${medianStr}); spot-check the HR app for HR's exact number`);
  }
  return out;
}

// Route one pick to the right confirmation path: HR-direct when the feed has Hard Rock's
// market, majors-fallback for F5 events where HR's prices aren't in the feed.
function hrCheckOne(pick, game) {
  const isF5 = (pick.betType || "").startsWith("F5");
  if (isF5 && game && !hrBookFrom(game)) return hrMajorsFallback(pick, game);
  return hrEvaluate(pick, game);
}

// Compare one published pick against Hard Rock's current offering for that market.
function hrEvaluate(pick, game) {
  const out = { available: false, hrOdds: null, hrPoint: null, warnings: [], errors: [], notes: [] };
  const pubOdds = parseOdds(pick.odds);
  const betType = pick.betType || "";
  const isF5 = betType.startsWith("F5");
  const marketKey = isF5 ? HR_F5_MARKETS[betType] : (betType === "Moneyline" ? "h2h" : betType === "Total" ? "totals" : "spreads");
  if (!marketKey) { out.warnings.push(`HardRock: unsupported bet type "${betType}" — not checked`); return out; }

  const book = hrBookFrom(game);
  if (!book) { out.errors.push(`HardRock: Hard Rock Bet has no lines for this game — bet not confirmed placeable`); return out; }
  const market = hrMarketFrom(book, marketKey);
  if (!market) { out.errors.push(`HardRock: ${betType} market not offered at Hard Rock Bet for this game`); return out; }

  const { outcome, pubPoint } = hrFindOutcome(market, pick, marketKey);
  if (!outcome || !Number.isFinite(outcome.price)) {
    out.errors.push(`HardRock: side "${pick.pick}" not found in Hard Rock's ${betType} market`);
    return out;
  }

  out.available = true;
  out.hrOdds = outcome.price > 0 ? `+${outcome.price}` : `${outcome.price}`;
  if (outcome.point !== undefined) out.hrPoint = outcome.point;

  // Point ballpark (totals/spreads): same bet within half a point, else it's a different bet.
  if (pubPoint !== null && Number.isFinite(outcome.point)) {
    const d = Math.abs(outcome.point - pubPoint);
    if (d > 0.5) {
      out.errors.push(`HardRock: line is ${outcome.point} vs published ${pubPoint} (Δ${d.toFixed(1)}) — materially different bet`);
      return out;
    }
    if (d > 0) out.warnings.push(`HardRock: line is ${outcome.point} vs published ${pubPoint} — half-point off`);
  }

  // Price ballpark: how much worse is Hard Rock's implied probability than the published price?
  if (Number.isFinite(pubOdds)) {
    const worsePP = hrImpliedPct(outcome.price) - hrImpliedPct(pubOdds);
    if (worsePP > HR_ODDS_ERROR_PP) {
      out.errors.push(`HardRock: price ${out.hrOdds} vs published ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — outside ballpark`);
    } else if (worsePP > HR_ODDS_WORSE_PP) {
      out.warnings.push(`HardRock: price ${out.hrOdds} vs published ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — worse but in ballpark`);
    }
  }
  return out;
}

async function runHardRockCheck(picksData) {
  const summary = { book: "Hard Rock Bet", checked: 0, available: 0, warnings: 0, errors: 0, skipped: false };
  const pickResults = [];
  const parlayFindings = [];
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { summary.skipped = true; summary.reason = "No ODDS_API_KEY"; return { summary, pickResults, parlayFindings }; }

  // One main-lines fetch per sport (bookmakers param scopes cost to Hard Rock only),
  // plus one per-event fetch per F5 game.
  const bySport = {};
  for (const p of (picksData.picks || [])) (bySport[p.sport] = bySport[p.sport] || []).push(p);
  const sportGames = {};
  for (const sport of Object.keys(bySport)) {
    const key = HR_SPORT_KEYS[sport];
    if (!key) continue;
    try {
      const resp = await fetch(
        `https://api.the-odds-api.com/v4/sports/${key}/odds?markets=h2h,spreads,totals&oddsFormat=american&bookmakers=hardrockbet,hardrockbet_oh&apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(12000) }
      );
      sportGames[sport] = resp.ok ? await resp.json() : null;
    } catch (e) { sportGames[sport] = null; }
  }

  const f5Cache = {};
  async function gameForPick(pick) {
    const games = sportGames[pick.sport];
    if (!games) return { game: null, feedDown: true };
    const game = hrMatchGame(games, pick.matchup);
    if (!game) return { game: null, feedDown: false };
    if ((pick.betType || "").startsWith("F5")) {
      if (!(game.id in f5Cache)) {
        try {
          // All US books, not HR-scoped: HR's F5 prices aren't in the feed, so the
          // majors-fallback needs the full field to confirm placeability.
          const resp = await fetch(
            `https://api.the-odds-api.com/v4/sports/${HR_SPORT_KEYS[pick.sport]}/events/${game.id}/odds?regions=us,us2&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings&oddsFormat=american&apiKey=${apiKey}`,
            { signal: AbortSignal.timeout(12000) }
          );
          f5Cache[game.id] = resp.ok ? await resp.json() : null;
        } catch (e) { f5Cache[game.id] = null; }
      }
      return { game: f5Cache[game.id], feedDown: f5Cache[game.id] === null };
    }
    return { game, feedDown: false };
  }

  for (const pick of (picksData.picks || [])) {
    summary.checked++;
    const { game, feedDown } = await gameForPick(pick);
    let r;
    if (!game) {
      r = { available: false, hrOdds: null, hrPoint: null, warnings: [], errors: [], notes: [] };
      // A game missing from the upcoming-odds feed usually means it already started —
      // unknowable rather than unplaceable, so warn instead of error.
      r.warnings.push(feedDown
        ? `HardRock: odds feed unavailable — placeability not confirmed`
        : `HardRock: game not in the current odds feed (already started?) — placeability not confirmed`);
    } else {
      r = hrCheckOne(pick, game);
    }
    if (r.available) summary.available++;
    summary.warnings += r.warnings.length;
    summary.errors += r.errors.length;
    pickResults.push(r);
  }

  // Parlay legs: same per-leg confirmation + same-game structural check (a standard parlay
  // with two legs from one game is typically not buildable — books require an SGP instead).
  for (const pl of (picksData.parlayLegs || [])) {
    const legGames = [];
    for (const leg of (pl.legs || [])) {
      const idx = (picksData.picks || []).findIndex(p => p.pick === leg.pick && p.matchup === leg.matchup);
      if (idx >= 0 && pickResults[idx]) {
        const r = pickResults[idx];
        if (!r.available && r.errors.length) parlayFindings.push({ level: "error", note: `Parlay leg "${leg.pick}": ${r.errors[0]}` });
      } else {
        const { game } = await gameForPick(leg);
        const r = game ? hrCheckOne(leg, game) : null;
        if (!r || !r.available) parlayFindings.push({ level: "error", note: `Parlay leg "${leg.pick}" not confirmed at Hard Rock Bet` });
      }
      legGames.push(hrLastWord((leg.matchup || "").replace(/\s*(vs\.?|@|at)\s*/gi, " ")));
    }
    const dupes = legGames.filter((g, i) => legGames.indexOf(g) !== i);
    if (dupes.length > 0) {
      parlayFindings.push({ level: "warning", note: `Parlay has two legs from the same game — a standard parlay likely won't build at Hard Rock Bet (needs SGP)` });
    }
  }
  summary.errors += parlayFindings.filter(f => f.level === "error").length;
  summary.warnings += parlayFindings.filter(f => f.level === "warning").length;
  return { summary, pickResults, parlayFindings };
}

// ── Sharp Handicapper Review (Claude) ──
async function sharpReview(picks, dateFormatted) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { verdict: "skip", analysis: "No API key for sharp review" };

  const cardSummary = picks.map((p, i) =>
    `${i + 1}. [${p.rating}] ${p.pick} ${p.odds} | ${p.units} | ${p.sport} | Cover: ${p.winProbability} | EV: ${p.ev}\n   Reasoning: ${(p.coreReasoning || '').slice(0, 200)}\n   What loses: ${p.whatLoses || 'N/A'}`
  ).join('\n\n');

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000), // never hang QA on a rate-limited call — try/catch → skip
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: [{ type: "text", text: `You are an elite Las Vegas handicapper with 25 years of experience. You've worked for professional betting syndicates and have a lifetime ROI of +8% on over 50,000 bets. You review betting cards for red flags that pure math can't catch.

Your job: Review today's 3-pick card and flag anything that concerns you. Think about:
- Trap games (teams with nothing to play for, scheduling spots, look-ahead games)
- Narrative coherence (does the reasoning actually support the pick direction?)
- Line smell (does the line look right for this matchup, or is it a trap number?)
- Correlation risk (are multiple picks exposed to the same outcome?)
- Situational factors (travel, rest, motivation, playoffs context)

Return ONLY valid JSON:
{
  "verdict": "clean" | "concerns" | "red_flag",
  "confidence": 1-100,
  "analysis": "1-3 sentences summarizing your review",
  "pickFlags": [
    { "pickIndex": 1, "flag": "concern" | "red_flag", "reason": "brief explanation" }
  ]
}

"clean" = card looks solid, no issues.
"concerns" = minor situational worries but still playable.
"red_flag" = at least one pick has a significant problem that math wouldn't catch.

Be honest and direct. Don't flag things just to flag them. Only raise genuine concerns.`, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Today's card (${dateFormatted}):\n\n${cardSummary}` }],
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.log(`[verify-sharp] Claude review failed: ${e.message}`);
  }
  return { verdict: "skip", analysis: "Sharp review unavailable" };
}

// ── Auto-Fix: Replace bad picks with next best candidate ──
async function autoFixPicks(picksData, pickReports) {
  const criticalIndices = [];
  for (let i = 0; i < pickReports.length; i++) {
    if (pickReports[i].severity === "critical") criticalIndices.push(i);
  }
  if (criticalIndices.length === 0) return { fixed: false, replacements: [] };

  const candidateTable = picksData.candidateTable || [];
  if (candidateTable.length === 0) return { fixed: false, replacements: [], reason: "No candidate table available" };

  const currentPicks = new Set(picksData.picks.map(p => p.pick));
  const claudeRejectedSides = new Set((picksData.rejections || []).filter(r => r.reason && !r.reason.startsWith('Not selected')).map(r => r.side));
  const replacements = [];

  for (const idx of criticalIndices) {
    const badPick = picksData.picks[idx];

    // Find next best candidate not already on the card
    let replacement = null;
    for (const c of candidateTable) {
      if (currentPicks.has(c.side)) continue;
      if (c.ev <= 0.03) continue;
      if (c.verification === 'FAIL') continue;
      if (claudeRejectedSides.has(c.side)) { console.log(`[verify-fix] Skipping "${c.side}" — Claude explicitly rejected`); continue; }

      // Build a replacement pick object
      replacement = {
        sport: c.sport,
        matchup: c.matchup,
        pick: c.side,
        betType: c.market,
        odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
        rating: unitsToRating(c.kellyUnits),
        confidence: c.kellyUnits >= 2.0 ? "aplus" : c.kellyUnits >= 1.25 ? "a" : c.kellyUnits >= 0.75 ? "aminus" : c.kellyUnits >= 0.5 ? "bplus" : "b",
        units: `${c.kellyUnits}u`,
        ev: `${(c.ev * 100).toFixed(1)}%`,
        evRaw: c.ev,
        edgePct: `${((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1)}%`,
        edgePoints: c.edge,
        coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
        zScore: c.zScore,
        kellyCalc: c.kellyCalcStr || "",
        winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
        coreReasoning: `WeBetAI projects a statistical edge on this play. ${c.sport} ${c.market} pick replacing a flagged selection.`,
        whatLoses: "Opposite outcome or line movement against the pick.",
        modelEdge: `Edge: ${c.edge}`,
        commenceTime: c.commenceTime || "",
      };
      break;
    }

    if (replacement) {
      replacements.push({
        index: idx,
        removed: badPick.pick,
        removedReason: pickReports[idx].errors.join("; "),
        added: replacement.pick,
      });
      picksData.picks[idx] = replacement;
      currentPicks.delete(badPick.pick);
      currentPicks.add(replacement.pick);
      console.log(`[verify-fix] REPLACED pick ${idx + 1}: "${badPick.pick}" → "${replacement.pick}"`);
    } else {
      // No replacement available — remove the bad pick entirely
      replacements.push({
        index: idx,
        removed: badPick.pick,
        removedReason: pickReports[idx].errors.join("; "),
        added: null,
      });
      picksData.picks.splice(idx, 1);
      console.log(`[verify-fix] REMOVED pick ${idx + 1}: "${badPick.pick}" (no replacement available)`);
    }
  }

  // Fix narrative warnings (too short/empty) — add generic narrative if missing
  for (let i = 0; i < picksData.picks.length; i++) {
    const p = picksData.picks[i];
    if (!p.coreReasoning || p.coreReasoning.trim().length < 20) {
      p.coreReasoning = `WeBetAI's statistical model identifies edge value on this ${p.sport} ${p.betType || ''} play. The projection disagrees with the consensus line, creating a positive expected value opportunity.`;
      console.log(`[verify-fix] Added generic narrative for pick ${i + 1}: "${p.pick}"`);
    }
    if (!p.whatLoses || p.whatLoses.trim().length < 10) {
      p.whatLoses = "The opposite outcome materializes, or late line movement eliminates the edge.";
    }
  }

  // Fix grade mismatches
  for (const p of picksData.picks) {
    const u = parseUnits(p.units);
    const correctGrade = unitsToRating(u);
    if (p.rating !== correctGrade) {
      console.log(`[verify-fix] Grade fix: "${p.pick}" ${p.rating} → ${correctGrade}`);
      p.rating = correctGrade;
    }
  }

  // Recalculate summary
  const totalUnits = picksData.picks.reduce((s, p) => s + parseUnits(p.units), 0);
  if (picksData.summary) {
    picksData.summary.totalPicks = picksData.picks.length;
    picksData.summary.totalStraightBets = picksData.picks.length;
    picksData.summary.totalUnits = `${totalUnits.toFixed(1)}u`;
  }

  return { fixed: true, replacements };
}

// ── Write updated picks back to blob ──
async function updatePicksBlob(dateKey, picksData) {
  picksData.verifiedAt = new Date().toISOString();
  // verified is set by the caller (final pass) based on whether the FINAL card is genuinely clean.
  // Do NOT force true here — a red-flagged pick that couldn't be resolved must not be stamped "verified".
  if (typeof picksData.verified !== "boolean") picksData.verified = true;

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return false;

  try {
    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-omega/picks-${dateKey}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (resp.ok) {
      console.log(`[verify] Updated picks blob for ${dateKey}`);
      return true;
    }
  } catch (e) {
    console.error(`[verify] Blob update failed: ${e.message}`);
  }
  return false;
}

// ── Discord Alert ──
async function postToDiscord(report, sharpResult) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) { console.log("[verify] No DISCORD_BOT_TOKEN, skipping alert"); return; }

  const hasIssues = report.totalErrors > 0 || report.totalWarnings > 0;
  const hasSharpFlags = sharpResult?.verdict === "red_flag";
  const hasReplacements = report.replacements && report.replacements.length > 0;

  // Only post if there are issues or replacements
  if (!hasIssues && !hasSharpFlags && !hasReplacements) {
    console.log("[verify] All clean — no Discord alert needed");
    return;
  }

  let msg = `**🔍 OMEGA Pick Verification Report — ${report.date}**\n`;

  if (hasReplacements) {
    msg += `\n**⚠️ Auto-Fixed ${report.replacements.length} pick(s):**\n`;
    for (const r of report.replacements) {
      msg += `• Removed: \`${r.removed}\` — ${r.removedReason}\n`;
      msg += `  Replaced with: \`${r.added || 'REMOVED (no replacement)'}\`\n`;
    }
  }

  if (report.totalErrors > 0) {
    msg += `\n**❌ ${report.totalErrors} Error(s):**\n`;
    for (const pr of report.picks) {
      for (const e of pr.errors) msg += `• ${pr.pick}: ${e}\n`;
    }
  }

  if (report.totalWarnings > 0) {
    msg += `\n**⚠️ ${report.totalWarnings} Warning(s):**\n`;
    for (const pr of report.picks) {
      for (const w of pr.warnings) msg += `• ${pr.pick}: ${w}\n`;
    }
  }

  if (sharpResult && sharpResult.verdict !== "clean" && sharpResult.verdict !== "skip") {
    msg += `\n**🎰 Sharp Handicapper Review: ${sharpResult.verdict.toUpperCase()}**\n`;
    msg += `${sharpResult.analysis}\n`;
    if (sharpResult.pickFlags) {
      for (const f of sharpResult.pickFlags) {
        msg += `• Pick #${f.pickIndex}: [${f.flag}] ${f.reason}\n`;
      }
    }
  }

  msg += `\n${report.summary}\nhttps://webetsocial.com/omega`;

  // Truncate if too long for Discord (2000 char limit)
  if (msg.length > 1950) msg = msg.slice(0, 1950) + '...';

  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: msg }),
    });
    if (resp.ok) console.log("[verify] Discord alert posted");
    else console.log(`[verify] Discord post failed: ${resp.status}`);
  } catch (e) {
    console.log(`[verify] Discord error: ${e.message}`);
  }
}

// ── Fetch picks from blob store ──
async function fetchBetaPicks(dateKey) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;

  const baseUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-omega`;
  const headers = { Authorization: `Bearer ${token}` };

  if (!dateKey) {
    try {
      const resp = await fetch(`${baseUrl}/latest-date`, { headers });
      if (resp.ok) dateKey = (await resp.text()).trim().replace(/"/g, '');
    } catch (e) { console.error("[verify] latest-date fetch failed:", e.message); }
  }
  if (!dateKey) return null;

  try {
    const resp = await fetch(`${baseUrl}/picks-${dateKey}`, { headers });
    if (resp.ok) return { dateKey, data: await resp.json() };
  } catch (e) { console.error("[verify] picks fetch failed:", e.message); }
  return null;
}

// ── Store report ──
async function storeReport(dateKey, report) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;
  try {
    await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-omega/verification-${dateKey}`,
      { method: "PUT", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(report) }
    );
  } catch (e) { console.error("[verify] Store error:", e.message); }
}

// ── Handler ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  try {
    const params = event.queryStringParameters || {};
    let dateKey = params.date || null;

    if (!dateKey) {
      const now = new Date();
      dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }

    console.log(`[verify] Starting verification for ${dateKey}`);

    const result = await fetchBetaPicks(dateKey);
    if (!result || !result.data || !result.data.picks || result.data.picks.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ date: dateKey, verified: false, summary: "No picks found" }) };
    }

    const picksData = result.data;
    const dateFormatted = dateKey;

    // ── Step 1: Math + Narrative checks ──
    let totalWarnings = 0, totalErrors = 0;
    const pickReports = [];

    for (const pick of picksData.picks) {
      const math = runMathChecks(pick);
      const narrative = runNarrativeChecks(pick);
      const allWarnings = [...math.warnings, ...narrative.warnings];
      const allErrors = [...math.errors, ...narrative.errors];
      const severity = math.severity === "critical" || narrative.severity === "critical" ? "critical" : allWarnings.length > 0 ? "warning" : "clean";
      totalWarnings += allWarnings.length;
      totalErrors += allErrors.length;
      pickReports.push({ pick: `${pick.pick} ${pick.odds}`, sport: pick.sport, severity, mathChecks: math.checks, narrativeChecks: narrative.checks, warnings: allWarnings, errors: allErrors });
    }

    console.log(`[verify] Math/narrative: ${totalErrors} errors, ${totalWarnings} warnings`);

    // ── Step 1.5: Hard Rock Bet placeability check (advisory) ──
    // Confirms each bet (straights + parlay legs) is actually placeable at Hard Rock Bet in
    // the ballpark of the published odds/line. Findings flow into the report + Discord; the
    // severity stays below "critical" so auto-fix never rewrites the card because of it.
    let hrCheck = { summary: { skipped: true }, pickResults: [], parlayFindings: [] };
    try {
      hrCheck = await runHardRockCheck(picksData);
      for (let i = 0; i < pickReports.length; i++) {
        const r = hrCheck.pickResults[i];
        if (!r) continue;
        pickReports[i].hardRock = { available: r.available, hrOdds: r.hrOdds, hrPoint: r.hrPoint, notes: r.notes || [] };
        for (const w of r.warnings) { pickReports[i].warnings.push(w); totalWarnings++; }
        for (const e of r.errors) { pickReports[i].errors.push(e); totalErrors++; }
        if (pickReports[i].severity === "clean" && (r.warnings.length > 0 || r.errors.length > 0)) {
          pickReports[i].severity = "warning";
        }
      }
      totalErrors += hrCheck.parlayFindings.filter(f => f.level === "error").length;
      totalWarnings += hrCheck.parlayFindings.filter(f => f.level === "warning").length;
      console.log(`[verify-hardrock] ${hrCheck.summary.available}/${hrCheck.summary.checked} bets confirmed at Hard Rock Bet | ${hrCheck.summary.errors} error(s), ${hrCheck.summary.warnings} warning(s)`);
    } catch (e) {
      console.log(`[verify-hardrock] Check failed (non-fatal): ${e.message}`);
    }

    // ── Step 2: Auto-fix critical issues ──
    const fixResult = await autoFixPicks(picksData, pickReports);
    if (fixResult.fixed) {
      console.log(`[verify] Auto-fixed ${fixResult.replacements.length} pick(s)`);
      // Write updated picks back to blob so the page shows clean data
      await updatePicksBlob(dateKey, picksData);
    }

    // ── Step 3: Sharp handicapper review ──
    const sharpResult = await sharpReview(picksData.picks, dateFormatted);
    console.log(`[verify] Sharp review: ${sharpResult.verdict} (${sharpResult.confidence || 0}% confidence)`);

    // ── Step 3b: Sharp handicapper review — INFORMATIONAL ONLY (2026-06-25) ──
    // The sharp review is a non-deterministic LLM working from STALE training knowledge (no live data).
    // It false-flagged a genuine +EV play (on narrative) AND a fine play (claimed "corrupted data" on a
    // correct A's road game). So it must NOT modify, resize, or annotate the user-facing card. Its verdict
    // is logged + posted to Discord for human monitoring only; real structural issues (same-game
    // correlation) are handled deterministically upstream (canonical-key de-correlation in the merge).
    let sharpReplacements = [];
    if (sharpResult.verdict === "red_flag") {
      console.log(`[verify-sharp] (informational, no card change) red_flag: ${sharpResult.analysis || ""}`);
    }
    if (false && sharpResult.pickFlags && sharpResult.pickFlags.length > 0) { // DISABLED: advisory-only now
      const candidateTable = picksData.candidateTable || [];
      const currentPickNames = new Set(picksData.picks.map(p => p.pick));
      const sharpRejectedSides = new Set((picksData.rejections || []).filter(r => r.reason && !r.reason.startsWith('Not selected')).map(r => r.side));

      for (const flag of sharpResult.pickFlags) {
        if (flag.flag !== "red_flag") continue; // only act on red flags, not concerns
        const pickIdx = (flag.pickIndex || 1) - 1; // pickIndex is 1-based
        if (pickIdx < 0 || pickIdx >= picksData.picks.length) continue;
        const badPick = picksData.picks[pickIdx];

        // Find replacement from candidate table
        let replacement = null;
        for (const c of candidateTable) {
          if (currentPickNames.has(c.side)) continue;
          if (c.ev <= 0.03) continue;
          if (c.verification === 'FAIL') continue;
          if (sharpRejectedSides.has(c.side)) { console.log(`[verify-sharp] Skipping "${c.side}" — Claude explicitly rejected`); continue; }

          replacement = {
            sport: c.sport,
            matchup: c.matchup,
            pick: c.side,
            betType: c.market,
            odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
            rating: unitsToRating(c.kellyUnits),
            confidence: c.kellyUnits >= 2.0 ? "aplus" : c.kellyUnits >= 1.25 ? "a" : c.kellyUnits >= 0.75 ? "aminus" : c.kellyUnits >= 0.5 ? "bplus" : "b",
            units: `${c.kellyUnits}u`,
            ev: `${(c.ev * 100).toFixed(1)}%`,
            evRaw: c.ev,
            edgePct: `${((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1)}%`,
            edgePoints: c.edge,
            coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
            zScore: c.zScore,
            kellyCalc: c.kellyCalcStr || "",
            winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
            coreReasoning: `WeBetAI projects a statistical edge on this ${c.sport} ${c.market} play. This pick replaces a sharp-review flagged selection.`,
            whatLoses: "The opposite outcome materializes, or late line movement eliminates the edge.",
            modelEdge: `Edge: ${c.edge}`,
            commenceTime: c.commenceTime || "",
          };
          break;
        }

        if (replacement) {
          sharpReplacements.push({
            index: pickIdx,
            removed: badPick.pick,
            removedReason: `Sharp review RED FLAG: ${flag.reason}`,
            added: replacement.pick,
          });
          picksData.picks[pickIdx] = replacement;
          currentPickNames.delete(badPick.pick);
          currentPickNames.add(replacement.pick);
          console.log(`[verify-sharp] REPLACED pick ${pickIdx + 1}: "${badPick.pick}" → "${replacement.pick}" (sharp red flag: ${flag.reason})`);
        } else {
          // No CLEAN replacement. The sharp review is ADVISORY — a non-deterministic LLM that flags
          // narrative/situational concerns, not math, and it has red-flagged genuine +EV plays (e.g.
          // on "What Loses" phrasing). So we DOWNGRADE rather than delete: annotate the concern and
          // trim 0.5u. Truly broken picks (negative/undefined EV, broken math) are removed upstream by
          // the math-critical autoFix, not here. This guarantees the sharp review never shrinks the card.
          const curU = parseUnits(badPick.units);
          const newU = Math.max(0.5, (isNaN(curU) ? 1 : curU) - 0.5);
          badPick.units = `${newU}u`;
          badPick.rating = unitsToRating(newU);
          badPick.sharpConcern = flag.reason;
          sharpReplacements.push({
            index: pickIdx,
            downgraded: badPick.pick,
            removed: null,
            removedReason: `Sharp concern (downgraded ${(isNaN(curU) ? 1 : curU)}u→${newU}u, not removed): ${flag.reason}`,
            added: null,
          });
          console.log(`[verify-sharp] DOWNGRADED pick ${pickIdx + 1}: "${badPick.pick}" → ${newU}u (advisory sharp concern)`);
        }
      }

      // Card floor: a red-flag drop must never publish an EMPTY card. If every surviving pick is
      // flagged, retain the single highest-EV one (annotate the concern) rather than going dark.
      // (Policy choice — flip to an honest "0-play day" if you'd rather show nothing than a flagged play.)
      const evNum = (p) => { const r = (typeof p.evRaw === "number") ? p.evRaw : parseFloat(String(p.ev)) / 100; return isNaN(r) ? 0 : r; };
      if (picksData.picks.filter(p => !p._dropRedFlag).length === 0) {
        const flagged = picksData.picks.filter(p => p._dropRedFlag).sort((a, b) => evNum(b) - evNum(a));
        if (flagged.length > 0) {
          const keep = flagged[0];
          delete keep._dropRedFlag;
          keep.sharpConcern = "Retained as the card's only qualifying play; sharp review flagged a situational concern — size accordingly.";
          sharpReplacements = sharpReplacements.filter(r => r.removed !== keep.pick); // it was NOT removed
          console.log(`[verify-sharp] Card floor: retained "${keep.pick}" (highest EV) rather than publish an empty card`);
        }
      }

      // Physically remove any red-flagged picks that had no replacement (filter avoids index-shift)
      const droppedCount = picksData.picks.filter(p => p._dropRedFlag).length;
      if (droppedCount > 0) {
        picksData.picks = picksData.picks.filter(p => !p._dropRedFlag);
        console.log(`[verify-sharp] Removed ${droppedCount} red-flagged pick(s) with no replacement; ${picksData.picks.length} remain`);
      }

      // If we made any sharp action (replace / downgrade / drop), recalc summary + update the blob
      if (sharpReplacements.length > 0 || droppedCount > 0) {
        const totalUnits = picksData.picks.reduce((s, p) => s + parseUnits(p.units), 0);
        if (picksData.summary) {
          picksData.summary.totalPicks = picksData.picks.length;
          picksData.summary.totalStraightBets = picksData.picks.length;
          picksData.summary.totalUnits = `${totalUnits.toFixed(1)}u`;
        }
        await updatePicksBlob(dateKey, picksData);
        console.log(`[verify-sharp] Updated blob: ${sharpReplacements.filter(r => r.added).length} replacement(s), ${droppedCount} drop(s)`);
      }
    }

    // Merge all replacements
    const allReplacements = [...(fixResult.replacements || []), ...sharpReplacements];

    // ── Step 3c: FINAL PASS — re-verify entire card, write real narratives, rebuild parlay ──
    // After any replacements, the published card must be perfect:
    // 1. Every pick has a real narrative (not generic)
    // 2. Grades match units
    // 3. Math checks pass
    // 4. Parlay is recalculated with the final picks
    {
      console.log(`[verify-final] Running final verification pass on ${picksData.picks.length} picks`);
      let finalFixCount = 0;

      // ── Backfill: if drops/removals shrank the card below target, refill from the candidate
      // pool with the next-best CLEAN candidates. A math-critical removal or sharp red-flag drop
      // must NOT silently shrink the card to 2 when a clean alternative exists. We never force junk:
      // only EV>3% candidates that Claude didn't actively reject, de-correlated, 1 per game.
      // (If the pool is genuinely exhausted — a truly lean slate — we publish fewer, honestly.)
      const TARGET_PICKS = 3;
      if (picksData.picks.length < TARGET_PICKS && Array.isArray(picksData.candidateTable)) {
        const onCard = new Set(picksData.picks.map(p => p.pick));
        const rejectedSides = new Set((picksData.rejections || []).filter(r => r.reason && !r.reason.startsWith('Not selected')).map(r => r.side));
        const dirKey = (sport, side) => `${sport}|${/over/i.test(side) ? 'over' : /under/i.test(side) ? 'under' : 'side'}`;
        const matchupsOnCard = new Set(picksData.picks.map(p => p.matchup));
        const dirCount = {};
        for (const p of picksData.picks) { const k = dirKey(p.sport, p.pick); dirCount[k] = (dirCount[k] || 0) + 1; }

        // Exclude sides QA removed/flagged THIS run — never re-add a pick we just dropped.
        const removedThisRun = new Set((allReplacements || []).map(r => r.removed));
        const pool = picksData.candidateTable
          .filter(c => !onCard.has(c.side) && !rejectedSides.has(c.side) && !removedThisRun.has(c.side) && c.ev > 0.03)
          .sort((a, b) => b.ev - a.ev);

        let backfilled = 0;
        for (const c of pool) {
          if (picksData.picks.length >= TARGET_PICKS) break;
          if (matchupsOnCard.has(c.matchup)) continue;          // one pick per game
          const k = dirKey(c.sport, c.side);
          if ((dirCount[k] || 0) >= 2) continue;                // avoid 3 same-direction same-sport legs
          const u = c.kellyUnits || 0.5;
          picksData.picks.push({
            sport: c.sport, matchup: c.matchup, pick: c.side, betType: c.market,
            odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
            rating: unitsToRating(u),
            confidence: u >= 2.0 ? "aplus" : u >= 1.25 ? "a" : u >= 0.75 ? "aminus" : u >= 0.5 ? "bplus" : "b",
            units: `${u}u`,
            ev: `${(c.ev * 100).toFixed(1)}%`, evRaw: c.ev,
            edgePct: `${((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1)}%`,
            edgePoints: c.edge,
            coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
            zScore: c.zScore,
            kellyCalc: c.kellyCalcStr || "",
            winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
            coreReasoning: "",          // written by the narrative pass below
            whatLoses: "",
            modelEdge: `Edge: ${c.edge}`,
            commenceTime: c.commenceTime || "",
          });
          onCard.add(c.side); matchupsOnCard.add(c.matchup); dirCount[k] = (dirCount[k] || 0) + 1;
          backfilled++;
          console.log(`[verify-backfill] Added ${c.side} (EV ${(c.ev * 100).toFixed(1)}%) to refill card toward ${TARGET_PICKS}`);
        }
        if (backfilled > 0) {
          finalFixCount += backfilled;
          if (picksData.summary) {
            const tu = picksData.picks.reduce((s, p) => s + parseUnits(p.units), 0);
            picksData.summary.totalPicks = picksData.picks.length;
            picksData.summary.totalStraightBets = picksData.picks.length;
            picksData.summary.totalUnits = `${tu.toFixed(1)}u`;
          }
          console.log(`[verify-backfill] Refilled card to ${picksData.picks.length} pick(s) from candidate pool`);
        } else {
          console.log(`[verify-backfill] No clean candidates available to refill — publishing ${picksData.picks.length} pick(s) honestly`);
        }
      }

      // Fix grades + strip any stale sharp-review annotations (sharp review is informational-only now)
      for (const p of picksData.picks) {
        delete p.sharpConcern; delete p._dropRedFlag;
        const u = parseUnits(p.units);
        const correctGrade = unitsToRating(u);
        if (p.rating !== correctGrade) {
          console.log(`[verify-final] Grade fix: "${p.pick}" ${p.rating} → ${correctGrade}`);
          p.rating = correctGrade;
          finalFixCount++;
        }
      }

      // Identify picks needing real narratives (generic, too short, or contains "replaces")
      const needsNarrative = [];
      for (let i = 0; i < picksData.picks.length; i++) {
        const p = picksData.picks[i];
        const cr = p.coreReasoning || "";
        if (cr.length < 80 || cr.includes('replaces a') || cr.includes('replacing a') || cr.includes('statistical edge on this')) {
          needsNarrative.push(i);
        }
        if (!p.whatLoses || p.whatLoses.trim().length < 15) {
          needsNarrative.push(i); // will dedupe below
        }
      }
      const uniqueNeeds = [...new Set(needsNarrative)];

      // Call Claude to write proper narratives for picks that need them
      if (uniqueNeeds.length > 0 && process.env.ANTHROPIC_API_KEY) {
        console.log(`[verify-final] Writing narratives for ${uniqueNeeds.length} pick(s) via Claude`);
        const pickDescriptions = uniqueNeeds.map(i => {
          const p = picksData.picks[i];
          return `Pick ${i + 1}: ${p.pick} ${p.odds} | ${p.sport} ${p.betType || ''} | ${p.matchup} | Cover: ${p.winProbability} | EV: ${p.ev} | ${p.modelEdge || ''}`;
        }).join('\n');

        try {
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: AbortSignal.timeout(25000), // never hang QA on a rate-limited call — try/catch → template
            headers: {
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              "anthropic-beta": "prompt-caching-2024-07-31",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-6",
              max_tokens: 1500,
              system: [{ type: "text", text: `You write concise sports betting pick narratives for WeBetAI. You have NO live data, so you must NOT invent specific facts (player names, stats, records, injuries, venues, weather). Each narrative should:
- Be 2-3 sentences max
- Explain in GENERAL terms why WeBetAI's model favors the side named in the pick (team / Over-Under / line)
- Frame the value as the model's projection diverging from this market price
- State NO specific player names, records, scores, venues, or injuries you were not explicitly given — if unsure, stay general
- Never use technical jargon (no ORtg, DRtg, DVOA, ATS); never restate projections, lines, or numbers (shown separately)
- Always say "WeBetAI" not "the model"

Also write a "whatLoses" field: one sentence describing the specific scenario that beats this pick.

Return ONLY valid JSON array:
[{ "pickIndex": 1, "coreReasoning": "...", "whatLoses": "..." }, ...]`, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: `Write narratives for these picks:\n${pickDescriptions}` }],
            }),
          });

          if (resp.ok) {
            const data = await resp.json();
            const text = data.content?.[0]?.text || "";
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const narratives = JSON.parse(jsonMatch[0]);
              for (const n of narratives) {
                const idx = (n.pickIndex || 1) - 1;
                if (idx >= 0 && idx < picksData.picks.length) {
                  if (n.coreReasoning && n.coreReasoning.length > 30) {
                    picksData.picks[idx].coreReasoning = n.coreReasoning;
                    finalFixCount++;
                    console.log(`[verify-final] Wrote narrative for pick ${idx + 1}: "${picksData.picks[idx].pick}"`);
                  }
                  if (n.whatLoses && n.whatLoses.length > 10) {
                    picksData.picks[idx].whatLoses = n.whatLoses;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.log(`[verify-final] Claude narrative write failed: ${e.message}`);
          // Fallback: use template narratives
          for (const i of uniqueNeeds) {
            const p = picksData.picks[i];
            if (!p.coreReasoning || p.coreReasoning.length < 80 || p.coreReasoning.includes('replaces')) {
              const isTotal = /over|under/i.test(p.pick);
              const isML = /\bML\b/i.test(p.pick);
              p.coreReasoning = isTotal
                ? `WeBetAI projects ${p.modelEdge || 'a statistical edge'} on this total. Recent scoring trends and pace data support this direction, with the projection diverging from the consensus line.`
                : isML
                ? `WeBetAI gives this team a win probability above the market's implied odds at ${p.odds}. The Elo rating differential and recent form support value at these odds.`
                : `WeBetAI projects ${p.modelEdge || 'a spread edge'} on this matchup. Efficiency metrics and recent form diverge from the consensus line, creating positive expected value.`;
              finalFixCount++;
            }
            if (!p.whatLoses || p.whatLoses.length < 15) {
              p.whatLoses = "The opposite outcome materializes, or late line movement eliminates the edge.";
            }
          }
        }
      }

      // Re-verify math on all picks
      for (let i = 0; i < picksData.picks.length; i++) {
        const finalMath = runMathChecks(picksData.picks[i]);
        if (finalMath.severity === "critical") {
          console.log(`[verify-final] CRITICAL: Pick ${i + 1} still fails math — flagging for Discord`);
          picksData.picks[i]._verifyFlag = "math-critical-after-fix";
        }
      }

      // ── Rebuild parlay with the final card ──
      // The parlay must reflect the actual picks on the page, not the pre-replacement picks
      if (picksData.picks.length >= 3) {
        const legs = picksData.picks.slice(0, 3).map(p => ({
          pick: p.pick,
          sport: p.sport,
          matchup: p.matchup,
          betType: p.betType,
          odds: p.odds,
          coverProb: p.winProbability || p.coverProb,
          ev: p.ev,
        }));

        let combinedDecimal = 1.0, combinedProb = 1.0;
        for (const leg of legs) {
          const odds = parseOdds(leg.odds);
          combinedDecimal *= americanToDecimal(odds);
          combinedProb *= parseProbability(leg.coverProb);
        }
        const parlayEV = (combinedProb * combinedDecimal) - 1;

        picksData.parlayLegs = [{
          type: "3-leg-parlay-verified",
          legs,
          units: "0.5u",
          combinedOdds: `+${Math.round((combinedDecimal - 1) * 100)}`,
          combinedDecimal: +combinedDecimal.toFixed(2),
          combinedProb: `${(combinedProb * 100).toFixed(1)}%`,
          ev: `${(parlayEV * 100).toFixed(1)}%`,
          correlationNote: "Rebuilt after verification — reflects final verified card",
        }];
        console.log(`[verify-final] Parlay rebuilt: ${legs.map(l => l.pick).join(' + ')} @ +${Math.round((combinedDecimal - 1) * 100)}`);
        finalFixCount++;
      } else {
        // Fewer than 3 picks (e.g. after a red-flag drop) — clear any stale parlay so the page
        // never shows a parlay containing a removed leg.
        if (picksData.parlayLegs && picksData.parlayLegs.length) {
          picksData.parlayLegs = [];
          console.log(`[verify-final] Cleared stale parlay — only ${picksData.picks.length} pick(s) remain`);
        }
      }

      // verified ONLY if the final card is genuinely clean: at least 1 pick and none still failing math
      picksData.verified = picksData.picks.length > 0 && picksData.picks.every(p => !p._verifyFlag);

      // Write the final clean card
      await updatePicksBlob(dateKey, picksData);
      console.log(`[verify-final] Final pass complete: ${finalFixCount} fixes applied and saved`);
    }

    // ── Step 4: Build report ──
    const anyFixed = allReplacements.length > 0;
    const report = {
      date: dateKey,
      verified: picksData.verified === true,
      autoFixed: anyFixed,
      replacements: allReplacements,
      totalWarnings,
      totalErrors,
      sharpRedFlags: sharpReplacements.length,
      picks: pickReports,
      hardRock: { ...hrCheck.summary, parlay: hrCheck.parlayFindings },
      sharpReview: sharpResult,
      summary: `${pickReports.length} picks checked | ${totalErrors} error(s) | ${totalWarnings} warning(s) | HardRock: ${hrCheck.summary.skipped ? 'skipped' : `${hrCheck.summary.available}/${hrCheck.summary.checked} confirmed`} | Sharp: ${sharpResult.verdict}${sharpReplacements.length > 0 ? ` (${sharpReplacements.length} replaced)` : ''} | ${anyFixed ? `Auto-fixed ${allReplacements.length} pick(s)` : 'No fixes needed'}`,
      verifiedAt: new Date().toISOString(),
    };

    // ── Step 5: Store report + Discord alert ──
    await storeReport(dateKey, report);
    await postToDiscord(report, sharpResult);

    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  } catch (err) {
    console.error("[verify] Error:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message }) };
  }
};
