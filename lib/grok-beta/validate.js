"use strict";

// 3-agent wrapper. Agents may reject or cut stake and must write reason text.
// They MUST NOT invent p_model, edge, or units (enforced by schema + sanitizer).

const SYSTEM = `You are a Grok Beta validation agent for WeBetAI. The pricing engine already computed p_model, edge, and units. You MAY NOT invent or change p_model, edge, side, market, or line. You MAY only:
- keep a pick
- reject a pick (with a reason grounded in the provided raw features / news risk)
- cut_units to a SMALLER value on the 0.25 grid (never raise units)

Return JSON only:
{ "actions": [ { "matchup": "...", "pick": "...", "action": "keep"|"reject"|"cut_units", "units": 0.25, "reason": "..." } ] }
Include every candidate. If unsure, keep.`;

function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0].replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
  } catch (e) {
    return null;
  }
}

async function callClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no ANTHROPIC_API_KEY");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1800,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`claude ${resp.status}`);
  const data = await resp.json();
  return extractJson(data.content?.[0]?.text || "");
}

async function callGrok(prompt) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("no XAI_API_KEY");
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "grok-3-mini",
      temperature: 0,
      max_tokens: 1800,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`grok ${resp.status}`);
  const data = await resp.json();
  return extractJson(data.choices?.[0]?.message?.content || "");
}

async function callGpt(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no OPENAI_API_KEY");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1800,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`gpt ${resp.status}`);
  const data = await resp.json();
  return extractJson(data.choices?.[0]?.message?.content || "");
}

function candidatePrompt(candidates) {
  const rows = candidates.map((c, i) => ({
    i,
    sport: c.sport,
    matchup: c.matchup,
    pick: c.pick,
    market: c.market,
    odds: c.odds,
    units: c.units,
    pModel: c.pModel,
    pMarket: c.pMarket,
    edge: c.edge,
    ev: c.ev,
    reasoning: c.reasoning,
    starter: `${c.awayTeam} ${/* filled below */ ""}`,
  }));
  return `Grok Beta frozen candidates. Do not reprice. Reject or cut units only.\n${JSON.stringify(rows, null, 2)}`;
}

function indexActions(parsed, candidates) {
  const map = new Map();
  const actions = parsed && Array.isArray(parsed.actions) ? parsed.actions : [];
  for (const a of actions) {
    const key = `${a.matchup || ""}||${a.pick || ""}`;
    map.set(key, a);
    if (a.i != null && candidates[a.i]) {
      const c = candidates[a.i];
      map.set(`${c.matchup}||${c.pick}`, a);
    }
  }
  return map;
}

function sanitizeUnits(requested, current) {
  if (requested == null || !Number.isFinite(Number(requested))) return current;
  let u = Math.round(Number(requested) * 4) / 4;
  if (u > current) u = current; // cannot raise
  if (u < 0.25) u = 0.25;
  return u;
}

async function validateCandidates(candidates) {
  if (!candidates.length) return { picks: [], rejections: [], agentReports: [] };
  const prompt = candidatePrompt(candidates);
  const reports = [];
  const calls = [
    ["grok", callGrok],
    ["claude", callClaude],
    ["gpt", callGpt],
  ];
  const results = await Promise.all(calls.map(async ([name, fn]) => {
    try {
      const parsed = await fn(prompt);
      reports.push({ agent: name, ok: !!parsed, parsed });
      return { agent: name, parsed };
    } catch (e) {
      console.log(`[grok-beta] agent ${name} failed: ${e.message}`);
      reports.push({ agent: name, ok: false, error: e.message });
      return { agent: name, parsed: null };
    }
  }));

  const picks = [];
  const rejections = [];
  for (const c of candidates) {
    const key = `${c.matchup}||${c.pick}`;
    let rejectVotes = 0;
    let minUnits = c.units;
    const reasons = [];
    for (const r of results) {
      if (!r.parsed) continue;
      const map = indexActions(r.parsed, candidates);
      const a = map.get(key);
      if (!a) continue;
      const action = String(a.action || "keep").toLowerCase();
      if (action === "reject") {
        rejectVotes++;
        if (a.reason) reasons.push(`${r.agent}: ${a.reason}`);
      } else if (action === "cut_units") {
        minUnits = Math.min(minUnits, sanitizeUnits(a.units, c.units));
        if (a.reason) reasons.push(`${r.agent} cut to ${minUnits}u: ${a.reason}`);
      } else if (a.reason) {
        reasons.push(`${r.agent}: ${a.reason}`);
      }
    }
    if (rejectVotes >= 2) {
      rejections.push({ matchup: c.matchup, pick: c.pick, reason: reasons.join(" | ") || "2+ agents rejected" });
      continue;
    }
    const next = { ...c, units: minUnits, rating: require("./engine").letterForUnits(minUnits) };
    if (reasons.length) next.agentNote = reasons.join(" | ");
    // Freeze engine numbers
    next.pModel = c.pModel;
    next.edge = c.edge;
    next.ev = c.ev;
    if (reasons.length) next.reasoning = `${c.reasoning} ${reasons.join(" ")}`.trim();
    picks.push(next);
  }
  return { picks, rejections, agentReports: reports };
}

module.exports = { validateCandidates };
