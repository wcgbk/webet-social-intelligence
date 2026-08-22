"use strict";

// Public-card copy in the Alpha/Omega voice. Numbers stay on the badge row;
// this module writes Daily Edge, Insights, and per-pick coreReasoning.

function extractJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0].replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
  } catch (e) {
    return null;
  }
}

function lastName(team) {
  if (!team) return "";
  const parts = String(team).trim().split(/\s+/);
  return parts[parts.length - 1];
}

function mathLead(p) {
  if (p.pModel == null || p.pMarket == null || p.ev == null) return "";
  const pm = (Number(p.pModel) * 100).toFixed(1);
  const mkt = (Number(p.pMarket) * 100).toFixed(1);
  const ev = (Number(p.ev) * 100).toFixed(1);
  return `WeBetAI puts this play at ${pm}% vs the market's ${mkt}% — a ${ev}% edge at the price. `;
}

function factSheet(picks, dateFormatted, parlay) {
  const lines = picks.map((p, i) => {
    const facts = [];
    if (p.awayStarter || p.homeStarter) facts.push(`starters ${p.awayStarter || "unlisted"} vs ${p.homeStarter || "unlisted"}`);
    if (p.restAway === 1 || p.restHome === 1) facts.push(`short rest: ${p.awayTeam} ${p.restAway}d, ${p.homeTeam} ${p.restHome}d`);
    if (p.projAway != null && p.projHome != null) facts.push(`projected score ${p.awayTeam} ${Number(p.projAway).toFixed(1)} / ${p.homeTeam} ${Number(p.projHome).toFixed(1)}`);
    if (p.venue) facts.push(`venue ${p.venue}`);
    if (p.injuryNamesAway && p.injuryNamesAway.length) facts.push(`${p.awayTeam} injuries: ${p.injuryNamesAway.join(", ")}`);
    if (p.injuryNamesHome && p.injuryNamesHome.length) facts.push(`${p.homeTeam} injuries: ${p.injuryNamesHome.join(", ")}`);
    if (p.sport === "NFL" && p.projSource === "mu") facts.push("NFL preseason — do not cite regular-season records");
    const hold = p.holdEv >= 0.03 ? "retail is clearly behind the sharp number" : p.holdEv > 0 ? "slight retail lag vs the sharp number" : "priced at the sharp number";
    facts.push(hold);
    facts.push(`best book ${p.book || "US retail"}`);
    return `Pick ${i + 1}: ${p.pick} | ${p.sport} ${p.betType || ""} | ${p.matchup} | ${p.units}u
   Facts: ${facts.join(" | ")}`;
  });
  const parlayLine = parlay && parlay.legs
    ? `\nParlay: same ${parlay.legs.length} legs, ${parlay.combinedOdds}, ${parlay.units}u.`
    : "";
  return `Today's Grok Beta card (${dateFormatted}):\n${lines.join("\n")}${parlayLine}`;
}

function fallbackPick(p) {
  const home = lastName(p.homeTeam);
  const away = lastName(p.awayTeam);
  const isOver = /^over/i.test(p.pick);
  const isUnder = /^under/i.test(p.pick);
  const sentences = [];
  if (p.awayStarter || p.homeStarter) {
    sentences.push(`${p.awayStarter || "The visitor"} takes the ball from ${p.homeStarter || "the home starter"} in ${away} at ${home}.`);
  } else if (isOver) {
    sentences.push(`WeBetAI likes points in ${away} at ${home} — the number is sitting where a typical night already covers it.`);
  } else if (isUnder) {
    sentences.push(`WeBetAI is on the under in ${away} at ${home}, where the posted total is a half-point richer than the sharp side of the board.`);
  } else {
    sentences.push(`WeBetAI is with ${p.pick.replace(/\s+ML$/,'')} in ${away} at ${home}.`);
  }
  if (p.holdEv >= 0.02) {
    sentences.push(`The number WeBetAI can actually bet is already behind the sharp books, which is the whole reason this side made the card.`);
  } else {
    sentences.push(`US books are a tick slow relative to the sharp no-vig; that extra juice is the edge, not a rest-day story.`);
  }
  if (p.sport === "NFL" && p.projSource === "mu") {
    sentences.push(`This is preseason — WeBetAI is pricing the number, not last year's roster.`);
  } else if (p.projAway != null) {
    sentences.push(`The independent projection still lands on this side after blending toward the sharp price.`);
  }
  sentences.push(`The play loses if the other side of this number is simply right tonight.`);
  return sentences.join(" ");
}

function fallbackCard(picks, parlay) {
  const names = picks.map(p => {
    const g = (p.matchup || "").replace(/\s+@\s+/, " at ");
    return `${p.pick} (${g})`;
  });
  const sports = [...new Set(picks.map(p => p.sport))];
  const units = picks.map(p => `${p.pick} at ${p.units}u`).join(", ");
  const edgeSummary = `WeBetAI's Grok Beta card today is built around ${picks.length} separate games: ${names.join("; ")}. The thread is price — each play is the best US number after the sharp books had already moved — not a single-league stack.`;
  const parlayBit = parlay && parlay.combinedOdds
    ? ` The same three legs also go on a ${parlay.units}u parlay at ${parlay.combinedOdds}.`
    : "";
  const insights = `The slate shaped into ${sports.join(" and ")} with one pick per game, so the card is not doubling a single matchup. Sizing follows expected value: ${units}.${parlayBit} WeBetAI passed on sides where retail was already worse than the sharp no-vig.`;
  return { edgeSummary, insights };
}

async function callClaude(sheet) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const system = `You are WeBetAI's sharp sports-betting analyst writing the public card. Match the voice of WeBetAI's Alpha and Omega pages: confident, specific, for a smart general audience.

RULES:
- Always say "WeBetAI", never "the model", "Grok Beta", "p_model", "Shin", "hold EV", or "devig".
- Use ONLY the facts provided. Do not invent players, injuries, records, ERA, or venues.
- Do NOT restate odds, unit size, or EV percentages in coreReasoning (those sit on the card separately).
- Argue IN FAVOR of the pick side. If it is a spread, explain why that team covers. If a total, explain why Over or Under hits.
- Plain English. No ORtg, DRtg, DVOA, ATS, or formula dumps.
- coreReasoning: 3-4 sentences. Start with a supporting fact. End with why this is the number to bet.
- whatLoses: one concrete sentence.
- edgeSummary: 2-3 sentences tying the WHOLE card together with the actual games and why the edges exist. Never say "lone edge" if there is more than one pick.
- insights: 2-3 sentences — why these markets, how the slate shaped the card, and why some plays are sized bigger than others.

Return ONLY JSON:
{ "narratives": [{ "pickIndex": 1, "coreReasoning": "...", "whatLoses": "..." }], "edgeSummary": "...", "insights": "..." }`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 2200,
      temperature: 0.35,
      system,
      messages: [{ role: "user", content: sheet + "\n\nReturn the JSON." }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`claude ${resp.status}`);
  const data = await resp.json();
  return extractJson(data.content?.[0]?.text || "");
}

async function writeCardCopy(picks, { dateFormatted, parlay } = {}) {
  const fb = fallbackCard(picks, parlay);
  if (!picks.length) return { edgeSummary: fb.edgeSummary, insights: "" };

  for (const p of picks) {
    p.coreReasoning = mathLead(p) + fallbackPick(p);
  }

  try {
    const parsed = await callClaude(factSheet(picks, dateFormatted || "today", parlay));
    if (parsed) {
      for (const n of (parsed.narratives || [])) {
        const idx = (n.pickIndex || 1) - 1;
        if (idx >= 0 && idx < picks.length && n.coreReasoning && n.coreReasoning.length > 40) {
          picks[idx].coreReasoning = mathLead(picks[idx]) + n.coreReasoning.replace(/WeBetAI's model/g, "WeBetAI");
          if (n.whatLoses) picks[idx].whatLoses = n.whatLoses;
        }
      }
      if (parsed.edgeSummary && parsed.edgeSummary.length > 40) fb.edgeSummary = parsed.edgeSummary.replace(/\bthe model\b/gi, "WeBetAI");
      if (parsed.insights && parsed.insights.length > 40) fb.insights = parsed.insights.replace(/\bthe model\b/gi, "WeBetAI");
    }
  } catch (e) {
    console.log(`[grok-beta] narrate fallback: ${e.message}`);
  }

  return { edgeSummary: fb.edgeSummary, insights: fb.insights };
}

module.exports = { writeCardCopy };
