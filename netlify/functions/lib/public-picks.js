// Trim public get-picks payloads. The blob still stores the full generator dump
// (candidateTable, modelProjections, thinkingText, rejections, gapReview,
// Kelly internals). Those are unused on /omega /nfl /cfb cards and dominate
// TTFB + parse time. gapReview is the private model-vs-line flag list.
// shortfall is the private "fewer than 3 straights / no 3-leg" debug list.
// reserve is the private next-best straight list. It is not a public pick.
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
  'dataReviewFlag', 'placeabilityFlag', 'p_fair', 'p_model', 'calK', 'label', 'grade', 'riskDollars', 'toWinDollars',
  // fairSource is anchorFairSource (pinnacle, sharp-books, consensus, a book key, or none).
  // A retail-only fair appends -soft. fairQuality is sharp, soft, or none.
  // evAtFair is p_fair at the bet price when the fair is sharp. A soft fair
  // publishes 'n/a (soft fair)' and evAtFairValid false. p_fair still anchors.
  'fairP', 'fairSource', 'evAtFair', 'modelWeight',
  'fairSoft', 'evAtFairValid', 'fairQuality',
  // NFL QB flag. notes is the diagnostic (market-implied QB points) and,
  // when the gap guard fires, the informed-market sentence. qbFlag is only
  // set on a flagged game. The model margin is not changed.
  'qbFlag', 'qbMarketImpliedPts', 'qbMarketInformed', 'notes',
];

const PARLAY_KEEP = [
  'type', 'units', 'combinedOdds', 'combinedDecimal', 'combinedProb', 'ev',
  'evAtModel', 'evAtFair', 'isLean',
  // reason is the explicit no-parlay line (fewer than 2 eligible legs).
  // label is the lean line (fair EV or model EV after the haircut).
  'reason',
  'evLabel', 'riskDollars', 'toWinDollars',
  'uniqueGames', 'uniqueSports', 'independent', 'mirrorsCard', 'legMarkets', 'correlationNote',
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
  'reserve',
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
  // The public blurb keeps the narrator text and prints the QB note on the end.
  const note = out.notes != null ? String(out.notes).trim() : '';
  if (note) {
    const reasoning = out.coreReasoning != null ? String(out.coreReasoning).trim() : '';
    if (!reasoning) out.coreReasoning = note;
    else if (!reasoning.includes(note)) out.coreReasoning = `${reasoning} ${note}`;
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
