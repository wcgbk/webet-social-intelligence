'use strict';

/**
 * Final Edge card: never-block fill, 3-leg parlay, post-cap units, rejections.
 * A fill with edge > 0 and EV > 0 keeps qualityToRating and Kelly units.
 * A fill with edge <= 0 or EV <= 0 is 0.5u, rating and grade no-edge.
 * Gate-clear seeds keep the grade select already stamped.
 */

const { MODEL_VERSION, MAX_STRAIGHTS } = require('./config');
const {
  fillNeverBlock, fillKeepsRealGrade, toPickObject, samePublished, droppedRejections,
  applyDailyUnitCap, applyExposureCaps, sortByGradeThenUnits, positionKey, dkHrPriced,
} = require('./select');
const { ensureCardParlay, syncLegsToPublishedStraights } = require('./parlay');
const { buildCardFallbackCopy, alignEdgeSummary } = require('./narrate');

function parseU(u) {
  return parseFloat(String(u == null ? '' : u).replace(/[^0-9.]/g, '')) || 0;
}

function formatUnitsTotal(n) {
  const q = Math.round((Number(n) || 0) * 100) / 100;
  if (Math.abs(q - Math.round(q)) < 1e-9) return `${Math.round(q)}u`;
  const quarters = Math.round(q * 4) / 4;
  const shown = Math.abs(q - quarters) < 1e-9 ? quarters : q;
  return `${(Math.round(shown * 100) / 100).toString()}u`;
}

function dedupeRejections(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    if (!r) continue;
    const key = `${r.matchup || ''}|${r.side || ''}|${r.market || ''}|${r.reason || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function compactPool(positions) {
  const out = [];
  const seen = new Set();
  for (const c of positions || []) {
    if (!dkHrPriced(c)) continue;
    const key = positionKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      matchup: c.matchup || null,
      side: c.side || null,
      market: c.market || null,
      odds: c.odds,
      coverProb: c.coverProb,
      ev: c.ev,
      edgePct: c.edgePct,
      sport: c.sport || null,
      book: c.book || null,
      homeTeam: c.homeTeam || null,
      awayTeam: c.awayTeam || null,
      commenceTime: c.commenceTime || '',
      predictedClv: c.predictedClv,
      uncertainty: c.uncertainty,
      bestDkHr: c.bestDkHr || null,
      line: c.line != null ? c.line : null,
    });
  }
  return out;
}

function summaryFrom(picks, parlayLegs, extras = {}) {
  const straightUnits = (picks || []).reduce((s, p) => s + parseU(p.units), 0);
  const parlayUnits = (parlayLegs || []).reduce((s, pl) => s + parseU(pl.units), 0);
  const summary = {
    totalPicks: (picks || []).length,
    totalStraightBets: (picks || []).length,
    totalUnits: formatUnitsTotal(straightUnits + parlayUnits),
    sportsCovered: [...new Set((picks || []).map(p => p.sport).filter(Boolean))],
  };
  if (extras.modelVersion) summary.modelVersion = extras.modelVersion;
  if (extras.aplusLocks != null) summary.aplusLocks = extras.aplusLocks;
  if (extras.qaHardFails != null) summary.qaHardFails = extras.qaHardFails;
  return summary;
}

/** Rewrite the unit fields on an existing summary. Leaves aplusLocks and modelVersion. */
function applySummaryUnits(card) {
  if (!card || !card.summary || typeof card.summary !== 'object') return card;
  const next = summaryFrom(card.picks, card.parlayLegs, {});
  card.summary.totalPicks = next.totalPicks;
  card.summary.totalStraightBets = next.totalStraightBets;
  card.summary.totalUnits = next.totalUnits;
  card.summary.sportsCovered = next.sportsCovered;
  return card;
}

function finishPublication(args) {
  const {
    picks: seedPicks, chosen, positions, yesPool, rejected, miscalibrated, hardFails, cardDate, modelVersion, dateFormatted,
  } = args;
  let picks = seedPicks || [];
  // The ticket is the published straights. The guard still drops an opposing
  // leg and keeps one leg per game (a second market only when the card has
  // fewer than 3 games).
  const parlayBuilt = ensureCardParlay(positions || [], picks, {
    cardDate,
    yesPool: yesPool || positions,
    fromPublishedStraights: true,
  });
  const parlayExclusions = (parlayBuilt && parlayBuilt.parlayExclusions) || [];
  let parlayLegs = Array.isArray(parlayBuilt) ? parlayBuilt : [];
  const capped = applyDailyUnitCap(picks, parlayLegs);
  const exposed = applyExposureCaps(capped.picks, capped.parlayLegs);
  const exposureRejections = (exposed.picks || []).filter(p => parseU(p.units) <= 0).map(p => ({
    matchup: p.matchup || null,
    side: p.pick || p.side || null,
    market: p.betType || p.market || null,
    sport: p.sport || null,
    reason: 'exposure-cap',
  }));
  picks = exposed.picks.filter(p => parseU(p.units) > 0);
  parlayLegs = syncLegsToPublishedStraights(exposed.parlayLegs || [], picks);
  picks = sortByGradeThenUnits(picks);

  const hf = (hardFails || []).map(h => ({
    matchup: h.matchup || null,
    side: h.side || null,
    market: h.market || null,
    sport: h.sport || null,
    reason: String(h.reason || '').startsWith('QA_HARDFAIL') ? h.reason : `QA_HARDFAIL: ${h.reason}`,
    hardFail: true,
  }));
  const rejections = dedupeRejections([
    ...hf,
    ...droppedRejections(positions, chosen, rejected, miscalibrated),
    ...parlayExclusions,
    ...exposureRejections,
  ]);
  const copy = buildCardFallbackCopy({ picks, parlayLegs, dateFormatted });
  const edgeSummary = alignEdgeSummary(copy.edgeSummary, picks, parlayLegs, dateFormatted);
  const version = modelVersion || MODEL_VERSION;
  const summary = summaryFrom(picks, parlayLegs, {
    modelVersion: version,
    aplusLocks: picks.filter(p => p.rating === 'aplus').length,
    qaHardFails: (hardFails || []).length,
  });
  return {
    picks,
    parlayLegs,
    rejections,
    parlayPool: compactPool(positions),
    chosen,
    summary,
    edgeSummary,
    hardFails: hardFails || [],
  };
}

/**
 * Seeds are the gate-clear / QA-kept sides. Open slots fill from DK/Hard Rock
 * prices on `positions`. Positive-edge fills keep their grade and Kelly size.
 * No-edge fills are 0.5u. A second market is used only when the priced board
 * has fewer than 3 games.
 */
function publishEdgeCard(opts = {}) {
  const positions = opts.positions || [];
  const qualified = opts.qualified || [];
  const chosen = fillNeverBlock(qualified, positions, opts.maxN || MAX_STRAIGHTS);
  const version = opts.modelVersion || MODEL_VERSION;
  const seed = opts.picksSeed || null;
  const picks = chosen.map(c => {
    if (seed && !c.leanFill) {
      const existing = seed.find(p => samePublished(p, c));
      if (existing) return { ...existing };
    }
    const noEdgeFill = !!(c && c.leanFill && !fillKeepsRealGrade(c));
    const cand = noEdgeFill ? { ...c, noEdgeFill: true } : c;
    return toPickObject(cand, { modelVersion: version });
  });
  return finishPublication({
    picks,
    chosen,
    positions,
    yesPool: opts.yesPool || [],
    rejected: opts.rejected || [],
    miscalibrated: opts.miscalibrated || [],
    hardFails: opts.hardFails || [],
    cardDate: opts.cardDate || opts.dateISO || null,
    modelVersion: version,
    dateFormatted: opts.dateFormatted || '',
  });
}

module.exports = {
  publishEdgeCard,
  finishPublication,
  applySummaryUnits,
  summaryFrom,
  dedupeRejections,
  compactPool,
  formatUnitsTotal,
};
