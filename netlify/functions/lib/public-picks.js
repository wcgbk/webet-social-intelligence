// Trim public get-picks payloads. The blob still stores the full generator dump
// (candidateTable, modelProjections, thinkingText, rejections, Kelly internals).
// Those are unused on /omega /nfl /cfb cards and dominate TTFB + parse time.
// Premium Sharp Depth still comes from get-picks-premium.
//
// CFB: pick/matchup stay full names (ESPN match keys). pickDisplay/matchupDisplay
// are school-only for API consumers. Cards also format at render time.

const { isCfbSport, formatCfbPickDisplay, formatCfbMatchupDisplay } = require('./cfb-school-name');

const PICK_KEEP = [
  'pick', 'pickDisplay', 'matchup', 'sport', 'odds', 'units', 'rating', 'grade', 'qualityGrade', 'confidence',
  'betType', 'coreReasoning', 'commenceTime', 'edgePct', 'ev',
  'winProbability', 'coverProb', 'thinSlate', 'source', 'modelEdge', 'book', 'displayBook', 'executionBook', 'lockGrade', 'lockFormulaLine', 'lockReceiptLine', 'lockAvailability', 'stakeUsd', 'filler',
];

const PARLAY_KEEP = [
  'type', 'units', 'combinedOdds', 'combinedDecimal', 'combinedProb', 'ev',
  'uniqueGames', 'uniqueSports', 'independent', 'legMarkets', 'correlationNote', 'correlationHaircut',
  'candidatesScanned', 'stake', 'stakeUsd', 'source',
];

const ROOT_DROP = [
  'candidateTable', 'modelProjections', 'thinkingText', 'sgps',
  'rejections', 'edgeCandidatesCount',
];

function pickPublic(p) {
  if (!p || typeof p !== 'object') return p;
  const out = {};
  for (const k of PICK_KEEP) {
    if (p[k] !== undefined) out[k] = p[k];
  }
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
    // stakeUsd is the ticket stake; legs do not carry their own.
    out.legs = Array.isArray(pl.legs) ? pl.legs.map((leg) => {
      const o = pickPublic(leg);
      if (o && typeof o === 'object') delete o.stakeUsd;
      return o;
    }) : [];
    return out;
  });
}

function rejectionCounts(rows) {
  const counts = {};
  for (const row of rows || []) {
    const reason = row && row.reason != null ? String(row.reason).trim() : '';
    if (!reason) continue;
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function publicPicksPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  for (const k of ROOT_DROP) delete clone[k];
  clone.picks = Array.isArray(data.picks) ? data.picks.map(pickPublic) : [];
  clone.parlayLegs = parlayPublic(data.parlayLegs);
  clone.rejections = [];
  const counts = rejectionCounts(data.rejections);
  if (Object.keys(counts).length) clone.rejectionCounts = counts;
  return clone;
}

module.exports = { publicPicksPayload, pickPublic };
