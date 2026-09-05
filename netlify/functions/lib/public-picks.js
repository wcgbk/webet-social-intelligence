// Trim public get-picks payloads. The blob still stores the full generator dump
// (candidateTable, modelProjections, thinkingText, rejections, Kelly internals).
// Those are unused on /omega /nfl /cfb cards and dominate TTFB + parse time.
// Premium Sharp Depth still comes from get-picks-premium.

const PICK_KEEP = [
  'pick', 'matchup', 'sport', 'odds', 'units', 'rating', 'confidence',
  'betType', 'coreReasoning', 'commenceTime', 'edgePct', 'ev',
  'winProbability', 'coverProb', 'thinSlate', 'source', 'modelEdge',
];

const PARLAY_KEEP = [
  'type', 'units', 'combinedOdds', 'combinedDecimal', 'combinedProb', 'ev',
  'uniqueGames', 'uniqueSports', 'independent', 'legMarkets', 'correlationNote',
  'candidatesScanned', 'stake', 'source',
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
  return out;
}

function parlayPublic(parlayLegs) {
  if (!Array.isArray(parlayLegs)) return [];
  return parlayLegs.map((pl) => {
    const out = {};
    for (const k of PARLAY_KEEP) {
      if (pl[k] !== undefined) out[k] = pl[k];
    }
    out.legs = Array.isArray(pl.legs) ? pl.legs.map(pickPublic) : [];
    return out;
  });
}

function publicPicksPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  for (const k of ROOT_DROP) delete clone[k];
  clone.picks = Array.isArray(data.picks) ? data.picks.map(pickPublic) : [];
  clone.parlayLegs = parlayPublic(data.parlayLegs);
  clone.rejections = [];
  return clone;
}

module.exports = { publicPicksPayload, pickPublic };
