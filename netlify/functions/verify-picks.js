// verify-picks.js
// v3: Post-pick verification + auto-fix + sharp handicapper review + Discord alerts
//
// Runs at 10:30am ET daily. QA is a VERIFIER, not a second writer:
// 1. MATH CHECKS: Recompute EV, Kelly, grade. Flag mismatches.
// 2. NARRATIVE CHECKS: length / empty / whatLoses. Do not rewrite 9am Grok desk copy.
// 3. SHARP REVIEW: Grok (informational, Discord only). Never mutates the card.
// 4. AUTO-FIX: Negative EV / broken math only. Replace from the 3% EV pool. Write stub
//    copy via Grok only for those replacements.
// 5. DISCORD ALERT: Post errors/warnings to #picks-model-optimization.
//
// Aligned with v10.6-alpha-sharp: edge-rank, no plus-ML, no F5/soccer, short cards stay short.

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
function confFromUnits(u) { return u >= 2.0 ? "aplus" : u >= 1.25 ? "a" : u >= 0.75 ? "aminus" : u >= 0.5 ? "bplus" : "b"; }

// v10.5.3: QA replacements must size like the generator — F5 0.5u illiquid cap only,
// coverProb downsizing gates (sub-50% → 1.0u, sub-42% → 0.5u), full-game Kelly otherwise.
function cappedKellyUnits(c) {
  let u = typeof c.kellyUnits === 'number' ? c.kellyUnits : (parseFloat(c.kellyUnits) || 0.5);
  const mkt = (c.market || c.betType || '').toLowerCase();
  if (mkt.includes('f5')) u = Math.min(u, 0.5);
  const cp = typeof c.coverProb === 'number' ? c.coverProb : (parseFloat(c.coverProb) || 0);
  if (cp > 0 && cp < 0.50) u = Math.min(u, 0.5);
  if (cp > 0 && cp < 0.42) u = Math.min(u, 0.5);
  return Math.max(0.5, Math.round(u * 2) / 2);
}

async function grokFetch({ system, user, max_tokens = 1500, temperature = 0.2, timeoutMs = 25000, model = "grok-4-1-fast" } = {}) {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens,
        temperature,
        messages: [
          { role: "system", content: system || "" },
          { role: "user", content: user || "" },
        ],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.log(`[verify-grok] HTTP ${resp.status}: ${errBody.slice(0, 160)}`);
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.log(`[verify-grok] ${e.message}`);
    return null;
  }
}

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

// v10.6 publish laws — fail the card, do not rewrite it.
const SOCCER_SPORTS = new Set(["EPL", "La Liga", "Serie A", "Ligue 1", "MLS", "UCL", "Bundesliga", "Europa"]);
function runPublishLawChecks(picks) {
  const errors = [];
  for (const p of picks || []) {
    const odds = parseOdds(p.odds);
    const cp = parseProbability(p.winProbability || p.coverProb);
    const u = parseUnits(p.units);
    const mkt = (p.betType || "").toLowerCase();
    const pk = (p.pick || "").toLowerCase();
    const src = (p.source || "").toLowerCase();
    if (mkt.startsWith("f5") || src === "f5" || /\bf5\b/.test(pk)) {
      errors.push(`CRITICAL: F5 on published card (${p.pick})`);
    }
    if (SOCCER_SPORTS.has(p.sport)) {
      errors.push(`CRITICAL: soccer on published card (${p.sport} ${p.pick})`);
    }
    const isML = mkt.includes("moneyline") || /\bml\b/.test(pk);
    if (isML && odds > 140) {
      errors.push(`CRITICAL: plus-ML longer than +140 (${p.pick} ${p.odds})`);
    }
    if (isML && odds > 0 && u > 0.5) {
      errors.push(`CRITICAL: plus-ML sized ${u}u > 0.5u (${p.pick})`);
    }
    if (!isNaN(cp) && cp < 0.50 && u > 0.5) {
      errors.push(`CRITICAL: cover ${(cp * 100).toFixed(0)}% sized ${u}u > 0.5u (${p.pick})`);
    }
  }
  if ((picks || []).length >= 2) {
    const cp0 = parseProbability(picks[0].winProbability || picks[0].coverProb);
    const alt = picks.find(p => parseProbability(p.winProbability || p.coverProb) >= 0.50);
    if (cp0 < 0.50 && alt) {
      errors.push(`CRITICAL: pick #1 cover < 50% while ${alt.pick} is >= 50%`);
    }
  }
  return errors;
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

// ── Sharp Handicapper Review (Grok, informational only) ──
async function sharpReview(picks, dateFormatted) {
  if (!process.env.XAI_API_KEY) return { verdict: "skip", analysis: "No XAI_API_KEY for sharp review" };

  const cardSummary = picks.map((p, i) =>
    `${i + 1}. [${p.rating}] ${p.pick} ${p.odds} | ${p.units} | ${p.sport} | Cover: ${p.winProbability} | EV: ${p.ev}\n   Reasoning: ${(p.coreReasoning || '').slice(0, 200)}\n   What loses: ${p.whatLoses || 'N/A'}`
  ).join('\n\n');

  const text = await grokFetch({
    system: `You are an elite Las Vegas handicapper with 25 years of experience. You've worked for professional betting syndicates and have a lifetime ROI of +8% on over 50,000 bets. You review betting cards for red flags that pure math can't catch.

Your job: Review today's card and flag anything that concerns you. Think about:
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

Be honest and direct. Don't flag things just to flag them. Only raise genuine concerns. This review is advisory only and does not change the published card.`,
    user: `Today's card (${dateFormatted}):\n\n${cardSummary}`,
    max_tokens: 1500,
    temperature: 0.2,
    timeoutMs: 25000,
    model: "grok-4-1-fast",
  });

  if (text) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.log(`[verify-sharp] Grok JSON parse failed: ${e.message}`);
    }
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
  const newsRejectedSides = new Set((picksData.rejections || []).filter(r => r.reason && !r.reason.startsWith('Not selected')).map(r => r.side));
  const replacements = [];

  for (const idx of criticalIndices) {
    const badPick = picksData.picks[idx];

    // Find next best candidate not already on the card
    let replacement = null;
    for (const c of candidateTable) {
      if (currentPicks.has(c.side)) continue;
      if (c.ev <= 0.03) continue;
      if ((c.market || '').toLowerCase().includes('moneyline') && c.odds > 140) continue;
      if ((c.market || '').toLowerCase().startsWith('f5')) continue;
      if (c.verification === 'FAIL') continue;
      if (newsRejectedSides.has(c.side)) { console.log(`[verify-fix] Skipping "${c.side}" — generator news/DQ rejected`); continue; }

      // Build a replacement pick object
      replacement = {
        sport: c.sport,
        matchup: c.matchup,
        pick: c.side,
        betType: c.market,
        odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
        rating: unitsToRating(cappedKellyUnits(c)),
        confidence: confFromUnits(cappedKellyUnits(c)),
        units: `${cappedKellyUnits(c)}u`,
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
    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha/picks-${dateKey}`;
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

  let msg = `**🔍 Pick Verification Report — ${report.date}**\n`;

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

  msg += `\n${report.summary}\nhttps://webetsocial.com/alpha`;

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

  const baseUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha`;
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
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha/verification-${dateKey}`,
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

    // v10.5.3: full-game Kelly sizes; no ML unit cap to load.

    const result = await fetchBetaPicks(dateKey);
    if (!result || !result.data || !result.data.picks || result.data.picks.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ date: dateKey, verified: false, summary: "No picks found" }) };
    }

    const picksData = result.data;
    const dateFormatted = dateKey;

    // ── Step 1: Math + Narrative checks ──
    let totalWarnings = 0, totalErrors = 0;
    const pickReports = [];

    const lawErrors = runPublishLawChecks(picksData.picks);
    if (lawErrors.length) {
      totalErrors += lawErrors.length;
      console.log(`[verify] v10.6 publish-law failures: ${lawErrors.join(" | ")}`);
    }

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
    if (lawErrors.length) {
      pickReports.push({ pick: "CARD", sport: "", severity: "critical", mathChecks: {}, narrativeChecks: {}, warnings: [], errors: lawErrors });
    }

    console.log(`[verify] Math/narrative: ${totalErrors} errors, ${totalWarnings} warnings`);

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
          if (sharpRejectedSides.has(c.side)) { console.log(`[verify-sharp] Skipping "${c.side}" — generator news/DQ rejected`); continue; }

          replacement = {
            sport: c.sport,
            matchup: c.matchup,
            pick: c.side,
            betType: c.market,
            odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
            rating: unitsToRating(cappedKellyUnits(c)),
            confidence: confFromUnits(cappedKellyUnits(c)),
            units: `${cappedKellyUnits(c)}u`,
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

      // ── Backfill ONLY if THIS QA run dropped a pick. v10.5.3 publishes a short card on
      // purpose when fewer than 3 names clear 3% EV — do not pad that. If we removed a
      // math-critical pick, refill from the 3% pool, 1 per game.
      const TARGET_PICKS = 3;
      const qaDroppedAPick = (allReplacements || []).some(r => r.removed && !r.added);
      if (qaDroppedAPick && picksData.picks.length < TARGET_PICKS && Array.isArray(picksData.candidateTable)) {
        const onCard = new Set(picksData.picks.map(p => p.pick));
        const rejectedSides = new Set((picksData.rejections || []).filter(r => r.reason && !r.reason.startsWith('Not selected')).map(r => r.side));
        const dirKey = (sport, side) => `${sport}|${/over/i.test(side) ? 'over' : /under/i.test(side) ? 'under' : 'side'}`;
        const matchupsOnCard = new Set(picksData.picks.map(p => p.matchup));
        const dirCount = {};
        for (const p of picksData.picks) { const k = dirKey(p.sport, p.pick); dirCount[k] = (dirCount[k] || 0) + 1; }

        // Exclude sides QA removed/flagged THIS run — never re-add a pick we just dropped.
        const removedThisRun = new Set((allReplacements || []).map(r => r.removed));
        const pool = picksData.candidateTable
          .filter(c => !onCard.has(c.side) && !rejectedSides.has(c.side) && !removedThisRun.has(c.side) && c.ev > 0 && !((c.market || '').toLowerCase().includes('moneyline') && c.odds > 140) && !(c.market || '').toLowerCase().startsWith('f5'))
          .sort((a, b) => b.ev - a.ev);

        let backfilled = 0;
        for (const c of pool) {
          if (picksData.picks.length >= TARGET_PICKS) break;
          if (matchupsOnCard.has(c.matchup)) continue;          // one pick per game
          const k = dirKey(c.sport, c.side);
          if ((dirCount[k] || 0) >= 2) continue;                // avoid 3 same-direction same-sport legs
          const u = cappedKellyUnits(c);
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
      } else if (picksData.picks.length < TARGET_PICKS) {
        console.log(`[verify-backfill] Short card ${picksData.picks.length}/3 is generator intent — not padding`);
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

      // Write copy ONLY for QA replacement stubs. Never rewrite 9am Grok desk copy
      // just because a sentence is short.
      const needsNarrative = [];
      for (let i = 0; i < picksData.picks.length; i++) {
        const p = picksData.picks[i];
        const cr = p.coreReasoning || "";
        const stub = cr.length < 40
          || /replaces a|replacing a|statistical edge on this|Auto-generated|Claude narrative unavailable|Grok narrative unavailable/i.test(cr);
        const missingLose = !p.whatLoses || p.whatLoses.trim().length < 15;
        if (stub || missingLose) needsNarrative.push(i);
      }
      const uniqueNeeds = [...new Set(needsNarrative)];

      if (uniqueNeeds.length > 0 && process.env.XAI_API_KEY) {
        console.log(`[verify-final] Writing stub narratives for ${uniqueNeeds.length} pick(s) via Grok`);
        const pickDescriptions = uniqueNeeds.map(i => {
          const p = picksData.picks[i];
          return `Pick ${i + 1}: ${p.pick} ${p.odds} | ${p.sport} ${p.betType || ''} | ${p.matchup} | Cover: ${p.winProbability} | EV: ${p.ev} | ${p.modelEdge || ''}`;
        }).join('\n');

        const grokText = await grokFetch({
          system: `You write concise sports betting pick narratives for WeBetAI. You have NO live data, so you must NOT invent specific facts (player names, stats, records, injuries, venues, weather). Each narrative should:
- Be 2-3 sentences max
- Explain in GENERAL terms why WeBetAI favors the side named in the pick
- Frame the value as the projection diverging from this market price
- State NO specific player names, records, scores, venues, or injuries you were not explicitly given
- Never use technical jargon (no ORtg, DRtg, DVOA, ATS); never restate projections, lines, or numbers (shown separately)
- Always say "WeBetAI" not "the model"
- No em dashes

Also write a "whatLoses" field: one sentence describing the specific scenario that beats this pick.

Return ONLY valid JSON array:
[{ "pickIndex": 1, "coreReasoning": "...", "whatLoses": "..." }, ...]`,
          user: `Write narratives for these picks:\n${pickDescriptions}`,
          max_tokens: 1500,
          temperature: 0.3,
          timeoutMs: 25000,
          model: "grok-4-1-fast",
        });

        let wrote = false;
        if (grokText) {
          try {
            const jsonMatch = grokText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const narratives = JSON.parse(jsonMatch[0]);
              for (const n of narratives) {
                const idx = (n.pickIndex || 1) - 1;
                if (idx >= 0 && idx < picksData.picks.length) {
                  if (n.coreReasoning && n.coreReasoning.length > 30) {
                    picksData.picks[idx].coreReasoning = n.coreReasoning;
                    finalFixCount++;
                    wrote = true;
                    console.log(`[verify-final] Wrote narrative for pick ${idx + 1}: "${picksData.picks[idx].pick}"`);
                  }
                  if (n.whatLoses && n.whatLoses.length > 10) {
                    picksData.picks[idx].whatLoses = n.whatLoses;
                  }
                }
              }
            }
          } catch (e) {
            console.log(`[verify-final] Grok JSON parse failed: ${e.message}`);
          }
        }
        if (!wrote) {
          console.log(`[verify-final] Grok narrative write failed — using templates`);
          for (const i of uniqueNeeds) {
            const p = picksData.picks[i];
            if (!p.coreReasoning || p.coreReasoning.length < 40 || /replaces a|replacing a/i.test(p.coreReasoning)) {
              const isTotal = /over|under/i.test(p.pick);
              const isML = /\bML\b/i.test(p.pick);
              p.coreReasoning = isTotal
                ? `WeBetAI projects ${p.modelEdge || 'a statistical edge'} on this total. Scoring rates support this side at the posted number.`
                : isML
                ? `WeBetAI gives this team a win probability above the market's implied odds at ${p.odds}.`
                : `WeBetAI projects ${p.modelEdge || 'a spread edge'} on this matchup. The projection diverges from the consensus line.`;
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

      // ── Parlay handling (v10.4): PRESERVE the generator's parlay unless it's now invalid ──
      // The old unconditional daily rebuild (a) discarded the correlated-parlay optimizer's
      // output (its legs may legitimately differ from the straight card), (b) re-hardcoded
      // 0.5u over the 0.25u lean-card rule, and (c) dropped each leg's commenceTime —
      // re-breaking doubleheader settlement every day at 10:30. Rebuild ONLY when the parlay
      // is missing or a verification action invalidated one of its legs.
      const removedPicks = new Set(allReplacements.map(r => r.removed).filter(Boolean));
      const existingParlay = (Array.isArray(picksData.parlayLegs) && picksData.parlayLegs[0]) || null;
      const parlayLegsArr = (existingParlay && Array.isArray(existingParlay.legs)) ? existingParlay.legs : [];
      const cardPickSet = new Set(picksData.picks.map(p => p.pick));
      const isCardMirror = !existingParlay || /fallback|verified/.test(existingParlay.type || "");
      const parlayInvalid =
        !existingParlay || !parlayLegsArr.length ||
        parlayLegsArr.some(l => removedPicks.has(l.pick)) ||
        (isCardMirror && parlayLegsArr.some(l => !cardPickSet.has(l.pick)));

      if (picksData.picks.length >= 2 && parlayInvalid) {
        const hasLean = picksData.picks.some(p => p.thinSlate || p.dataVerified === 'lean-tier' || (p.rating || '').toLowerCase() === 'lean');
        const uniqueByGame = [];
        const seenG = new Set();
        for (const p of picksData.picks) {
          const g = (p.matchup || '').toLowerCase().replace(/\s+vs\.?\s+/g, ' @ ').replace(/\s+/g, ' ').trim();
          if (!g || seenG.has(g)) continue;
          seenG.add(g);
          uniqueByGame.push(p);
          if (uniqueByGame.length >= 3) break;
        }
        if (uniqueByGame.length >= 2) {
          const legs = uniqueByGame.map(p => ({
            pick: p.pick,
            sport: p.sport,
            matchup: p.matchup,
            betType: p.betType,
            odds: p.odds,
            coverProb: p.winProbability || p.coverProb,
            // Legs MUST carry the start time or doubleheader legs settle against the wrong game.
            commenceTime: p.commenceTime || '',
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
            type: `${legs.length}-leg-parlay-verified`,
            legs,
            units: hasLean ? "0.25u" : "0.5u",
            combinedOdds: combinedDecimal >= 2
              ? `+${Math.round((combinedDecimal - 1) * 100)}`
              : `${Math.round(-100 / (combinedDecimal - 1))}`,
            combinedDecimal: +combinedDecimal.toFixed(2),
            combinedProb: `${(combinedProb * 100).toFixed(1)}%`,
            ev: `${(parlayEV * 100).toFixed(1)}%`,
            correlationNote: "Rebuilt after verification from the published card (2- or 3-leg)",
          }];
          console.log(`[verify-final] Parlay rebuilt: ${legs.map(l => l.pick).join(' + ')} (${hasLean ? '0.25u lean card' : '0.5u'})`);
          finalFixCount++;
        } else if (picksData.parlayLegs && picksData.parlayLegs.length) {
          picksData.parlayLegs = [];
          console.log(`[verify-final] Cleared stale parlay — fewer than 2 unique games remain`);
        }
      } else if (picksData.picks.length < 2) {
        if (picksData.parlayLegs && picksData.parlayLegs.length) {
          picksData.parlayLegs = [];
          console.log(`[verify-final] Cleared stale parlay — only ${picksData.picks.length} pick(s) remain`);
        }
      } else {
        console.log(`[verify-final] Parlay preserved — generator output intact (${existingParlay.type})`);
      }

      // verified ONLY if the final card is genuinely clean: at least 1 pick, no math flags, no v10.6 law breaks
      picksData.verified = picksData.picks.length > 0 && picksData.picks.every(p => !p._verifyFlag) && lawErrors.length === 0;

      // Do not rewrite the 9am blob unless QA actually changed the card.
      if (finalFixCount > 0) {
        await updatePicksBlob(dateKey, picksData);
        console.log(`[verify-final] Final pass complete: ${finalFixCount} fixes applied and saved`);
      } else {
        console.log(`[verify-final] No card mutations — 9am Grok copy left intact`);
      }
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
      sharpReview: sharpResult,
      summary: `${pickReports.length} picks checked | ${totalErrors} error(s) | ${totalWarnings} warning(s) | Sharp: ${sharpResult.verdict}${sharpReplacements.length > 0 ? ` (${sharpReplacements.length} replaced)` : ''} | ${anyFixed ? `Auto-fixed ${allReplacements.length} pick(s)` : 'No fixes needed'}`,
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
