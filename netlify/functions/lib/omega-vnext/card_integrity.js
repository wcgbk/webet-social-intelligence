'use strict';
/**
 * Card integrity. One place for the rules every card write must satisfy.
 *
 *  blockedRowsFor(card, extra)  the ONE blocked list used by generate,
 *      the 10:15 rerank top-up, the 10:30 verify top-up, and the final gate:
 *      every qaHardFails row (hardFail !== false) + every rejection + extra.
 *  enforceHardFailGate(card)    drops any straight or parlay leg that has a
 *      hard fail, refills from the private reserve with the same blocked list,
 *      and rebuilds the parlay without the failed side.
 *  refreshCardText(card)        recomputes summary.sportsCovered and, when the
 *      text was written for a different pick set or names a sport/team that is
 *      not on the card, rebuilds edgeSummary and insights from the final picks.
 *  ensureCoreReasoning(card)    no straight or parlay leg ships empty reasoning.
 *  flagPlaceability(card)       a Hard Rock FAIL flags the non-placeable picks on
 *      the card (policy: Hard Rock is preferred, not required; flag, don't hide).
 *  applyCardIntegrity(card)     all of the above, in order. Pure; returns a copy.
 */
const { finishShortCard, sideBlocked } = require('./card_topup');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function hardFailRows(card) {
  return ((card && card.qaHardFails) || []).filter((r) => r && typeof r === 'object' && r.hardFail !== false);
}

function blockedRowsFor(card, extra) {
  const rej = Array.isArray(card && card.rejections) ? card.rejections.filter(Boolean) : [];
  return [].concat(hardFailRows(card), rej, (extra || []).filter(Boolean));
}

function legRows(card) {
  const out = [];
  for (const pl of (card && card.parlayLegs) || []) for (const leg of (pl && pl.legs) || []) out.push(leg);
  return out;
}

function enforceHardFailGate(card) {
  const fails = hardFailRows(card);
  const report = { droppedStraights: [], droppedLegs: [], refilled: [], parlayRebuilt: false };
  if (!fails.length || !card) return { card, changed: false, report };
  const picks = (card.picks || []).filter((p) => {
    const bad = sideBlocked(p, fails);
    if (bad) report.droppedStraights.push(p.pick || p.side);
    return !bad;
  });
  for (const leg of legRows(card)) if (sideBlocked(leg, fails)) report.droppedLegs.push(leg.pick || leg.side);
  if (!report.droppedStraights.length && !report.droppedLegs.length) return { card, changed: false, report };
  const blocked = blockedRowsFor(card);
  const reserve = (card.reserve || []).filter((r) => !sideBlocked(r, blocked));
  const pool = picks.concat(reserve).concat(legRows(card).filter((l) => !sideBlocked(l, blocked)));
  const finished = finishShortCard({ picks, reserve, blocked, parlayPool: pool });
  card.picks = finished.picks;
  card.parlayLegs = finished.parlayLegs;
  card.reserve = finished.reserve;
  report.refilled = (finished.added || []).map((r) => r.pick || r.side);
  report.parlayRebuilt = true;
  // Belt and braces: nothing hard-failed survives the rebuild.
  card.picks = card.picks.filter((p) => !sideBlocked(p, fails));
  card.parlayLegs = (card.parlayLegs || []).filter((pl) => !((pl && pl.legs) || []).some((l) => sideBlocked(l, fails)));
  card.summary = card.summary && typeof card.summary === 'object' ? card.summary : {};
  card.summary.totalPicks = card.picks.length;
  card.summary.totalStraightBets = card.picks.length;
  try {
    const { writeSummaryStakeDisplay } = require('./odds_math');
    writeSummaryStakeDisplay(card.summary, card.picks, card.parlayLegs);
  } catch (_) { /* display only */ }
  card.hardFailGate = report;
  return { card, changed: true, report };
}

const SPORT_WORDS = {
  NFL: /\bNFL\b/i, NHL: /\bNHL\b|\bhockey\b/i, MLB: /\bMLB\b|\bbaseball\b/i,
  NBA: /\bNBA\b|\bbasketball\b/i, NCAAF: /\bNCAAF\b|\bcollege football\b/i,
};

function teamTokens(row) {
  const out = [];
  for (const s of String((row && row.matchup) || '').split('@')) {
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (words.length) out.push(words[words.length - 1].toLowerCase());
  }
  return out;
}

function pickSignature(picks) {
  return (picks || []).map((p) => `${p.matchup || ''}|${p.pick || p.side || ''}`).sort().join('||');
}

function textProblems(card) {
  const picks = card.picks || [];
  const sports = new Set(picks.map((p) => p.sport).filter(Boolean));
  const text = `${card.edgeSummary || ''} ${card.insights || ''}`;
  const problems = [];
  for (const [sport, re] of Object.entries(SPORT_WORDS)) {
    if (re.test(text) && !sports.has(sport)) {
      problems.push(`mentions ${sport} not on card`);
    }
  }
  // Any team named in a candidate/rejected/reserve row but not on the card.
  const onCard = new Set(picks.concat(legRows(card)).flatMap(teamTokens));
  const offCard = new Set();
  for (const r of [].concat(card.reserve || [], card.qaHardFails || [], card.rejections || [])) {
    for (const t of teamTokens(r)) if (!onCard.has(t)) offCard.add(t);
  }
  for (const t of offCard) if (t.length > 3 && new RegExp(`\\b${t}\\b`, 'i').test(text)) problems.push(`mentions ${t} not on card`);
  for (const p of picks) {
    const needles = teamTokens(p).concat(
      String((p && (p.pick || p.side)) || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    );
    if (needles.length && !needles.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(text))) {
      problems.push(`omits ${p.pick}`);
    }
  }
  if (card.textSignature && card.textSignature !== pickSignature(picks)) problems.push('pick set changed since text was written');
  return problems;
}

function refreshCardText(card) {
  const picks = card.picks || [];
  card.summary = card.summary && typeof card.summary === 'object' ? card.summary : {};
  const sports = [...new Set(picks.map((p) => p.sport).filter(Boolean))];
  let changed = JSON.stringify(card.summary.sportsCovered || null) !== JSON.stringify(sports);
  card.summary.sportsCovered = sports;
  const problems = textProblems(card);
  if (problems.length || !card.edgeSummary || !card.insights) {
    const { buildCardFallbackCopy } = require('./narrate');
    const copy = buildCardFallbackCopy({ picks, dateFormatted: card.dateFormatted });
    card.edgeSummary = copy.edgeSummary;
    card.insights = copy.insights;
    card.textRebuilt = { reasons: problems.length ? problems : ['missing'], source: 'template' };
    changed = true;
  }
  const sig = pickSignature(picks);
  if (card.textSignature !== sig) { card.textSignature = sig; changed = true; }
  return { card, changed, problems };
}

function fallbackReasoning(row) {
  const { buildFallbackNarrative } = require('./narrate');
  return buildFallbackNarrative(row);
}

function ensureCoreReasoning(card) {
  let changed = false;
  for (const row of (card.picks || []).concat(legRows(card))) {
    if (!row || String(row.coreReasoning || '').trim()) continue;
    const match = (card.picks || []).find((p) => p !== row && p.pick === row.pick && p.matchup === row.matchup && String(p.coreReasoning || '').trim());
    row.coreReasoning = match ? match.coreReasoning : fallbackReasoning(row);
    changed = true;
  }
  return { card, changed };
}

function flagPlaceability(card) {
  const hr = card && card.hardRockCheck;
  if (!hr || !Array.isArray(hr.lines)) return { card, changed: false };
  let changed = false;
  const notes = [];
  for (const line of hr.lines) {
    if (!line || line.placeable !== false) continue;
    const rows = line.kind === 'parlay' ? legRows(card) : (card.picks || []);
    for (const row of rows) {
      if (row.pick !== line.pick || row.matchup !== line.matchup) continue;
      const flag = `Not available at Hard Rock. Price shown is ${String(row.book || line.book || 'another book')}.`;
      if (row.placeabilityFlag !== flag) { row.placeabilityFlag = flag; changed = true; }
    }
    if (line.kind !== 'parlay') notes.push(line.pick);
  }
  if (notes.length) {
    const note = `Hard Rock check: ${notes.join(', ')} not placeable at Hard Rock; shown at the listed book.`;
    if (card.placeabilityNote !== note) { card.placeabilityNote = note; changed = true; }
  }
  return { card, changed };
}

function applyCardIntegrity(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.picks)) return { card: input, changed: false, report: null };
  const card = clone(input);
  const gate = enforceHardFailGate(card);
  const reasoning = ensureCoreReasoning(card);
  const place = flagPlaceability(card);
  const text = refreshCardText(card);
  return {
    card,
    changed: gate.changed || reasoning.changed || place.changed || text.changed,
    report: { gate: gate.report, textProblems: text.problems },
  };
}

module.exports = {
  hardFailRows,
  blockedRowsFor,
  enforceHardFailGate,
  refreshCardText,
  ensureCoreReasoning,
  flagPlaceability,
  applyCardIntegrity,
  pickSignature,
  textProblems,
};
