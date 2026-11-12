'use strict';
// v2 text-only narration. The narrator writes prose; it never changes the card.
// Vetoes, unit cuts, and reorders from the narrator are ignored on v2. Only
// coreReasoning (straights + parlay legs), insights, claudeVerified, and a
// narration status are copied back. Failure or timeout => card unchanged, empty text.
const { narrateAndVerify, ensureNarrative } = require('./narrate');

const norm = s => String(s || '').trim().toLowerCase();
const sameRow = (a, b) => a && b && norm(a.pick || a.side) === norm(b.pick || b.side) && norm(a.matchup) === norm(b.matchup);

async function narrateTextOnly({ picks, parlayLegs, dateFormatted, apiKey, sports, timeoutMs = 90000, narrateFn = narrateAndVerify } = {}) {
  picks = picks || [];
  parlayLegs = parlayLegs || [];
  const clone = x => JSON.parse(JSON.stringify(x));
  let narr = null;
  let status = 'ok';
  let timer;
  try {
    narr = await Promise.race([
      narrateFn({ picks: clone(picks), parlayLegs: clone(parlayLegs), dateFormatted, apiKey, sports }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('narration timeout')), timeoutMs); }),
    ]);
  } catch (e) {
    status = `failed: ${e.message}`;
    console.warn(`[omega-v2] narration skipped: ${e.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!narr) {
    return { picks, parlayLegs, insights: '', claudeVerified: false, narration: { status, vetoesIgnored: 0 } };
  }
  const outPicks = picks.map(p => {
    const hit = (narr.picks || []).find(n => sameRow(n, p));
    let text = hit && String(hit.coreReasoning || '').trim();
    // Vetoed straight: keep it, use the template write-up, not the veto reason.
    if (!text) text = String(ensureNarrative({ ...p, coreReasoning: '' }).coreReasoning || '').trim();
    return { ...p, coreReasoning: text || p.coreReasoning || '' };
  });
  const outLegs = parlayLegs.map((pl, i) => {
    const npl = (narr.parlayLegs || [])[i] || {};
    return {
      ...pl,
      legs: (pl.legs || []).map((leg, j) => {
        const nl = (npl.legs || [])[j];
        const text = nl && sameRow(nl, leg) ? String(nl.coreReasoning || '').trim() : '';
        return { ...leg, coreReasoning: text || leg.coreReasoning || '' };
      }),
    };
  });
  const vetoes = (narr.rejections || []).filter(r => r && r.matchup !== 'Claude');
  const explicit = narr.narration && narr.narration.status;
  if (explicit === 'empty' || explicit === 'fallback') status = explicit;
  else status = narr.claudeVerified ? 'ok' : 'fallback';
  return {
    picks: outPicks,
    parlayLegs: outLegs,
    insights: String(narr.insights || ''),
    claudeVerified: !!narr.claudeVerified,
    narration: { status, vetoesIgnored: vetoes.length, vetoes },
  };
}

module.exports = { narrateTextOnly };
