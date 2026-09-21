'use strict';

/**
 * Claude as VERIFIER + NARRATOR only. Cannot invent sides.
 * May reject on news; unit cuts ≤50% allowed.
 */
async function narrateAndVerify({ picks, dateFormatted, apiKey }) {
  if (!picks || !picks.length) {
    return {
      picks: [],
      edgeSummary: 'No qualifying CLV-positive edges today. Empty card by design.',
      insights: 'Discipline over volume — Omega vNext publishes only when gates clear.',
      claudeVerified: true,
      rejections: [],
    };
  }

  // Template narratives always available
  const templated = picks.map(p => ({
    ...p,
    coreReasoning: p.coreReasoning || (
      `${p.pick} clears Omega vNext gates: calibrated cover ${p.coverProb}, EV ${p.ev}` +
      (p.predictedClv != null ? `, predicted CLV ${p.predictedClv}¢ vs sharp.` : '.') +
      ` Method: ${p.projMethod || 'sport-hybrid'}.`
    ),
  }));

  const templateSummary = `Today's Omega card (${dateFormatted}): ${templated.map(p => p.pick).join('; ')}. CLV-first selection; empty allowed when thin.`;
  const templateInsights = `Sports: ${[...new Set(templated.map(p => p.sport))].join(', ')}. Model is vNext — not legacy v11.`;

  if (!apiKey) {
    return {
      picks: templated,
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [],
    };
  }

  try {
    const locked = templated.map((p, i) => ({
      idx: i,
      sport: p.sport,
      matchup: p.matchup,
      pick: p.pick,
      betType: p.betType,
      odds: p.odds,
      units: p.units,
      ev: p.ev,
      coverProb: p.coverProb,
    }));

    const prompt = `You are the Omega verifier+narrator. Sides are LOCKED by the JS model — you MAY NOT invent or swap sides.
You may: (1) write 1-2 sentence coreReasoning per pick, (2) veto a pick only for concrete injury/news with reason, (3) cut units ≤50%.
Return JSON: { "picks": [{ "idx":0, "coreReasoning":"...", "veto":false, "unitCut":null }], "edgeSummary":"...", "insights":"..." }

LOCKED PICKS:
${JSON.stringify(locked, null, 2)}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}`);
    const data = await resp.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) throw new Error('no JSON in Claude response');
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

    const rejections = [];
    const outPicks = [];
    for (const row of parsed.picks || []) {
      const base = templated[row.idx];
      if (!base) continue;
      if (row.veto) {
        rejections.push({ matchup: base.matchup, side: base.pick, reason: row.coreReasoning || 'Claude news veto' });
        continue;
      }
      let units = base.units;
      if (row.unitCut != null) {
        const cur = parseFloat(base.units);
        const cut = Number(row.unitCut);
        if (Number.isFinite(cut) && cut < cur && cut >= cur * 0.5) units = `${cut}u`;
      }
      outPicks.push({
        ...base,
        units,
        coreReasoning: row.coreReasoning || base.coreReasoning,
      });
    }

    // If Claude returned nothing usable, keep templates
    if (!outPicks.length && !rejections.length) {
      return {
        picks: templated,
        edgeSummary: parsed.edgeSummary || templateSummary,
        insights: parsed.insights || templateInsights,
        claudeVerified: false,
        rejections: [],
      };
    }

    return {
      picks: outPicks.length ? outPicks : templated,
      edgeSummary: parsed.edgeSummary || templateSummary,
      insights: parsed.insights || templateInsights,
      claudeVerified: true,
      rejections,
    };
  } catch (e) {
    console.error(`[omega-vnext/narrate] ${e.message}`);
    return {
      picks: templated,
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [{ matchup: 'Claude', side: 'verifier', reason: `Narrate failed: ${e.message}` }],
    };
  }
}

module.exports = { narrateAndVerify };
