'use strict';

/**
 * Claude as VERIFIER + NARRATOR only. Cannot invent sides.
 * May reject on news; unit cuts ≤50% allowed.
 * Narratives: ESPN-style 3–5 sentence journalistic blurbs (not math templates).
 */

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

function resolveAnthropicKey(explicit) {
  return explicit
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_KEY
    || '';
}

/** Short sports-desk fallback — matchup + angle, NEVER math-gate jargon. */
function buildFallbackNarrative(p) {
  const pick = p.pick || p.side || 'this side';
  const matchup = p.matchup || 'today\'s matchup';
  const sport = p.sport || '';
  const betType = (p.betType || p.market || '').toLowerCase();
  const odds = p.odds || '';

  let angle;
  if (/total|over|under/.test(betType) || /^(over|under)\b/i.test(pick)) {
    angle = `The number looks soft relative to how these sides have been scoring, and WeBetAI likes the price at ${odds || 'market odds'}.`;
  } else if (/spread|run line|puck/.test(betType) || /[+-]\d/.test(pick)) {
    angle = `The spread still prices in more separation than the recent form suggests, giving WeBetAI a clean cover angle at ${odds || 'market odds'}.`;
  } else {
    angle = `The moneyline still offers value versus how WeBetAI reads the matchup at ${odds || 'market odds'}.`;
  }

  const sportBit = sport ? `${sport}: ` : '';
  return `${sportBit}${pick} in ${matchup}. ${angle} Key situational edges — form, injuries, and rest — line up with this side rather than the chalk narrative. Size stays disciplined; this is a card play, not a hammer.`;
}

function ensureNarrative(p) {
  const existing = (p.coreReasoning || '').trim();
  const isBadTemplate = /clears Omega vNext gates|predicted CLV|Method:\s*sport-hybrid|projMethod/i.test(existing);
  if (existing && existing.length > 40 && !isBadTemplate) return { ...p, coreReasoning: existing };
  return { ...p, coreReasoning: buildFallbackNarrative(p) };
}

function lockedRow(p, i, kind) {
  return {
    idx: i,
    kind: kind || 'straight',
    sport: p.sport,
    matchup: p.matchup,
    pick: p.pick || p.side,
    betType: p.betType || p.market,
    odds: p.odds,
    units: p.units || null,
    // Context only — Claude must NOT restate these numbers in prose
    _contextEv: p.ev,
    _contextCover: p.coverProb,
  };
}

const SYSTEM_PROMPT = `You are THE LOCK — WeBetAI's sports betting analyst. You VERIFY and NARRATE pre-locked picks. You do NOT select sides, invent replacements, compute projections, probabilities, or Kelly sizing — the statistical model has already locked the card.

YOUR JOB:
1. Use web search (sparingly — tight budget) to verify injury status, recent news, starting pitchers (MLB), QB status (NFL/NCAAF), outdoor weather, and recent form for EACH locked pick/leg.
2. ACCEPT or REJECT each LOCKED STRAIGHT pick. Default is ACCEPT. Reject ONLY for concrete disqualifying news (star out, SP scratch, QB out/doubtful, severe weather, material lineup change). You do NOT choose replacements.
3. Write 3-5 sentence coreReasoning for each ACCEPTED straight AND each parlay leg.
4. You MAY reduce straight pick units by up to 50% with justification. You MUST NOT increase units. Do not change parlay leg units.
5. You MUST NOT invent new picks, swap sides, or override model direction.
6. Always say "WeBetAI" instead of "the model" or "our model".
7. Do NOT apply baseball starter/FIP logic to football picks.

NARRATIVE RULES (coreReasoning):
- Argue IN FAVOR of the pick side. If the pick is "Team X +17.5", explain why Team X covers — NOT why the opponent wins.
- Start with a supporting fact — preferably a verified insight from web search.
- Support with 2-3 distinct verified facts (form, injuries, rest, matchup factor).
- End with a brief value statement (why the price is attractive) WITHOUT restating EV/coverProb/CLV/edge numbers from the table.
- Max 5 sentences. No padding. No duplicate stats.
- DO NOT restate projections, lines, edges, cover probabilities, EV, CLV cents, or Kelly math.
- NEVER lead with negative data about the side you're picking.
- NEVER use technical jargon like ORtg, DRtg, DVOA, ATS, FIP, xFIP, or advanced-stat abbreviations.
- GROUNDING: every specific must come from web search THIS run or the locked table. If you cannot verify a specific, describe the edge generally.
- Parlay legs may be slightly shorter (2-4 sentences) but must still be real prose, not math templates.

OUTPUT — Return ONLY valid JSON (no markdown fences):
{
  "picks": [
    { "idx": 0, "coreReasoning": "3-5 journalistic sentences...", "veto": false, "unitCut": null }
  ],
  "parlayLegs": [
    { "idx": 0, "coreReasoning": "2-4 journalistic sentences..." }
  ],
  "edgeSummary": "1-2 sentence editorial Daily Edge Summary. Sharp, specific, WeBetAI not 'the model'. Plain English.",
  "insights": "1-2 sentences on slate texture / sizing / sport mix. Plain English."
}`;

async function callClaudeOnce({ apiKey, lockedStraights, lockedLegs, dateFormatted, useWebSearch }) {
  const userPrompt = `Date: ${dateFormatted}

LOCKED STRAIGHT PICKS (verify + narrate; may veto on news only):
${JSON.stringify(lockedStraights.map(({ _contextEv, _contextCover, ...r }) => r), null, 2)}

LOCKED PARLAY LEGS (narrate only — do NOT veto; sides are fixed for the parlay slip):
${JSON.stringify((lockedLegs || []).map(({ _contextEv, _contextCover, ...r }) => r), null, 2)}

Write journalistic coreReasoning for every straight and every parlay leg. Return JSON only.`;

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(useWebSearch ? 120000 : 60000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${resp.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text' || c.text)
    .map(c => c.text || '')
    .join('\n');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) throw new Error('no JSON in Claude response');
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

/** Prefer web_search; on tool/HTTP failure retry once without tools so narratives still ship. */
async function callClaude(opts) {
  try {
    return await callClaudeOnce({ ...opts, useWebSearch: true });
  } catch (e) {
    console.error(`[omega-vnext/narrate] web_search path failed (${e.message}) — retrying without tools`);
    return await callClaudeOnce({ ...opts, useWebSearch: false });
  }
}

function applyStraightRows(templated, parsed) {
  const rejections = [];
  const outPicks = [];
  for (const row of parsed.picks || []) {
    const base = templated[row.idx];
    if (!base) continue;
    if (row.veto) {
      rejections.push({
        matchup: base.matchup,
        side: base.pick,
        reason: row.coreReasoning || 'Claude news veto',
      });
      continue;
    }
    let units = base.units;
    if (row.unitCut != null) {
      const cur = parseFloat(base.units);
      const cut = Number(row.unitCut);
      if (Number.isFinite(cut) && cut < cur && cut >= cur * 0.5) units = `${cut}u`;
    }
    const prose = (row.coreReasoning || '').trim();
    outPicks.push({
      ...base,
      units,
      coreReasoning: prose.length > 40 ? prose : base.coreReasoning,
    });
  }
  return { outPicks, rejections };
}

function applyLegRows(legsTemplated, parsed) {
  const byIdx = new Map();
  for (const row of parsed.parlayLegs || []) {
    if (row && row.idx != null) byIdx.set(row.idx, row);
  }
  return legsTemplated.map((leg, i) => {
    const row = byIdx.get(i);
    const prose = row && (row.coreReasoning || '').trim();
    if (prose && prose.length > 30) return { ...leg, coreReasoning: prose };
    return ensureNarrative(leg);
  });
}

/**
 * Narrate + verify straights; narrate each parlay leg.
 * @returns {{ picks, parlayLegs, edgeSummary, insights, claudeVerified, rejections }}
 */
async function narrateAndVerify({ picks, parlayLegs, dateFormatted, apiKey }) {
  const key = resolveAnthropicKey(apiKey);

  if (!picks || !picks.length) {
    return {
      picks: [],
      parlayLegs: parlayLegs || [],
      edgeSummary: 'No qualifying CLV-positive edges today. Empty card by design.',
      insights: 'Discipline over volume — Omega publishes only when gates clear.',
      claudeVerified: true,
      rejections: [],
    };
  }

  const templated = picks.map(ensureNarrative);
  const flatLegs = [];
  const legOwners = []; // { plIdx, legIdx }
  (parlayLegs || []).forEach((pl, plIdx) => {
    (pl.legs || []).forEach((leg, legIdx) => {
      flatLegs.push(ensureNarrative(leg));
      legOwners.push({ plIdx, legIdx });
    });
  });

  const templateSummary = `Today's Omega card (${dateFormatted}): ${templated.map(p => p.pick).join('; ')}. Focused card — quality over volume.`;
  const templateInsights = `Sports on the card: ${[...new Set(templated.map(p => p.sport))].join(', ')}. WeBetAI sized each play to the edge, keeping daily exposure capped.`;

  if (!key) {
    console.error('[omega-vnext/narrate] ANTHROPIC_API_KEY missing — using sports-desk fallbacks');
    return {
      picks: templated,
      parlayLegs: mergeLegsBack(parlayLegs, flatLegs, legOwners),
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [],
    };
  }

  try {
    const lockedStraights = templated.map((p, i) => lockedRow(p, i, 'straight'));
    const lockedLegs = flatLegs.map((p, i) => lockedRow(p, i, 'parlay'));
    const parsed = await callClaude({
      apiKey: key,
      lockedStraights,
      lockedLegs,
      dateFormatted,
    });

    const { outPicks, rejections } = applyStraightRows(templated, parsed);
    const narratedLegs = applyLegRows(flatLegs, parsed);

    if (!outPicks.length && !rejections.length) {
      return {
        picks: templated,
        parlayLegs: mergeLegsBack(parlayLegs, narratedLegs, legOwners),
        edgeSummary: parsed.edgeSummary || templateSummary,
        insights: parsed.insights || templateInsights,
        claudeVerified: false,
        rejections: [],
      };
    }

    return {
      picks: outPicks.length ? outPicks : templated,
      parlayLegs: mergeLegsBack(parlayLegs, narratedLegs, legOwners),
      edgeSummary: parsed.edgeSummary || templateSummary,
      insights: parsed.insights || templateInsights,
      claudeVerified: true,
      rejections,
    };
  } catch (e) {
    console.error(`[omega-vnext/narrate] ${e.message}`);
    return {
      picks: templated,
      parlayLegs: mergeLegsBack(parlayLegs, flatLegs, legOwners),
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [{ matchup: 'Claude', side: 'verifier', reason: `Narrate failed: ${e.message}` }],
    };
  }
}

function mergeLegsBack(parlayLegs, flatLegs, legOwners) {
  if (!parlayLegs || !parlayLegs.length) return [];
  const clone = parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }));
  legOwners.forEach((owner, i) => {
    if (clone[owner.plIdx] && clone[owner.plIdx].legs[owner.legIdx] != null) {
      clone[owner.plIdx].legs[owner.legIdx] = {
        ...clone[owner.plIdx].legs[owner.legIdx],
        ...flatLegs[i],
      };
    }
  });
  return clone;
}

/** Re-narrate only parlay legs (after veto-driven re-optimize). */
async function narrateParlayLegsOnly({ parlayLegs, dateFormatted, apiKey, straightPicks }) {
  const key = resolveAnthropicKey(apiKey);
  if (!parlayLegs || !parlayLegs.length) return parlayLegs || [];

  const flatLegs = [];
  const legOwners = [];
  parlayLegs.forEach((pl, plIdx) => {
    (pl.legs || []).forEach((leg, legIdx) => {
      // Prefer matching straight narrative when same pick
      const match = (straightPicks || []).find(p => p.pick === leg.pick && p.matchup === leg.matchup);
      const seeded = match && match.coreReasoning
        ? { ...leg, coreReasoning: match.coreReasoning }
        : ensureNarrative(leg);
      flatLegs.push(seeded);
      legOwners.push({ plIdx, legIdx });
    });
  });

  if (!key) return mergeLegsBack(parlayLegs, flatLegs, legOwners);

  try {
    const parsed = await callClaude({
      apiKey: key,
      lockedStraights: [],
      lockedLegs: flatLegs.map((p, i) => lockedRow(p, i, 'parlay')),
      dateFormatted: dateFormatted || '',
    });
    const narrated = applyLegRows(flatLegs, parsed);
    return mergeLegsBack(parlayLegs, narrated, legOwners);
  } catch (e) {
    console.error(`[omega-vnext/narrate] parlay-only failed: ${e.message}`);
    return mergeLegsBack(parlayLegs, flatLegs, legOwners);
  }
}

module.exports = {
  narrateAndVerify,
  narrateParlayLegsOnly,
  buildFallbackNarrative,
  ensureNarrative,
  resolveAnthropicKey,
};
