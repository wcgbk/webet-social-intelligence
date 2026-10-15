// Trim public get-picks payloads. The blob still stores the full generator dump
// (candidateTable, modelProjections, thinkingText, rejections, gapReview,
// Kelly internals). Those are unused on /omega /nfl /cfb cards and dominate
// TTFB + parse time. gapReview is the private model-vs-line flag list.
// shortfall is the private "fewer than 3 straights / no 3-leg" debug list.
// lateNews, voidedPregame, and audit stay on the stored card. The public
// payload drops all three, and it omits void-pregame picks and parlay legs.
// Premium Sharp Depth still comes from get-picks-premium.
//
// CFB: pick/matchup stay full names (ESPN match keys). pickDisplay/matchupDisplay
// are school-only for API consumers. Cards also format at render time.

const { isCfbSport, formatCfbPickDisplay, formatCfbMatchupDisplay } = require('./cfb-school-name');

const PICK_KEEP = [
  'pick', 'pickDisplay', 'matchup', 'sport', 'odds', 'units', 'rating', 'confidence',
  'betType', 'coreReasoning', 'commenceTime', 'gameTime', 'edgePct', 'edge', 'ev',
  'winProbability', 'coverProb', 'thinSlate', 'source', 'modelEdge',
  'dataReviewFlag', 'label', 'grade', 'riskDollars', 'toWinDollars',
];

const PARLAY_KEEP = [
  'type', 'units', 'combinedOdds', 'combinedDecimal', 'combinedProb', 'ev',
  'evLabel', 'riskDollars', 'toWinDollars',
  'uniqueGames', 'uniqueSports', 'independent', 'legMarkets', 'correlationNote',
  'candidatesScanned', 'stake', 'source', 'hrPlaceabilityNote', 'label',
];

const ROOT_DROP = [
  'candidateTable', 'modelProjections', 'thinkingText', 'sgps',
  'rejections', 'rejectionCounts', 'edgeCandidatesCount',
  'teamIdentity',
  'gapReview',
  'health',
  'captureGate',
  'shortfall',
  'voidedPregame',
  'lateNews',
  'audit',
  'gateCounts',
  'hardRockCorrections',
  'selection',
  'bugLog',
];

function isVoidPregame(p) {
  return !!(p && p.status === 'void-pregame');
}

function pickPublic(p) {
  if (!p || typeof p !== 'object') return p;
  const out = {};
  for (const k of PICK_KEEP) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  // Execution book (draftkings and the other US books). Empty stays off the card.
  // tier is a stored selection field. The public card does not copy it.
  if (p.book != null && String(p.book).trim() !== '') out.book = String(p.book).trim();
  if (isCfbSport(out.sport)) {
    if (out.pick) out.pickDisplay = formatCfbPickDisplay(out.pick);
    if (out.matchup) out.matchupDisplay = formatCfbMatchupDisplay(out.matchup);
  }
  return out;
}

function parlayPublic(parlayLegs) {
  if (!Array.isArray(parlayLegs)) return [];
  return parlayLegs.map((pl) => {
    const out = {};
    for (const k of PARLAY_KEEP) {
      if (pl[k] !== undefined) out[k] = pl[k];
    }
    const legs = Array.isArray(pl.legs) ? pl.legs.filter((leg) => !isVoidPregame(leg)) : [];
    out.legs = legs.map(pickPublic);
    return out;
  });
}

function publicPicksPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  for (const k of ROOT_DROP) delete clone[k];
  clone.picks = Array.isArray(data.picks)
    ? data.picks.filter((p) => !isVoidPregame(p)).map(pickPublic)
    : [];
  clone.parlayLegs = parlayPublic(data.parlayLegs);
  clone.rejections = [];
  return clone;
}

module.exports = { publicPicksPayload, pickPublic };
