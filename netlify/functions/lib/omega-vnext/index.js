'use strict';

const {
  MODEL_VERSION, MODEL_NOTES, SPORTS_ENABLED, MAX_STRAIGHTS,
} = require('./config');
const { ingest } = require('./ingest');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { selectStraights, toPickObject, applyDailyCap } = require('./select');
const { optimizeParlay } = require('./parlay');
const { narrateAndVerify } = require('./narrate');
const { attachClvFields, attachClvToParlay } = require('./clv_log');
const { storePicks } = require('./store');

const mlb = require('./sports/mlb');
const nfl = require('./sports/nfl');
const cfb = require('./sports/cfb');
const nba = require('./sports/nba');
const nhl = require('./sports/nhl');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatDateLong(dateISO) {
  try {
    const [y, m, d] = dateISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 16)).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/New_York',
    });
  } catch (_) {
    return dateISO;
  }
}

function projectAll(snap) {
  const raw = [];
  if (SPORTS_ENABLED.MLB) {
    raw.push(...mlb.project({
      oddsEvents: snap.oddsBySport.MLB || [],
      standings: snap.standingsBySport.MLB || {},
    }));
  }
  if (SPORTS_ENABLED.NFL) {
    raw.push(...nfl.project({
      oddsEvents: snap.oddsBySport.NFL || [],
      standings: snap.standingsBySport.NFL || {},
    }));
  }
  if (SPORTS_ENABLED.NCAAF) {
    raw.push(...cfb.project({
      oddsEvents: snap.oddsBySport.NCAAF || [],
      standings: snap.standingsBySport.NCAAF || {},
    }));
  }
  if (SPORTS_ENABLED.NBA) raw.push(...nba.project({}));
  if (SPORTS_ENABLED.NHL) raw.push(...nhl.project({}));
  return raw;
}

/**
 * Full Omega vNext pipeline. Writes edge-picks-omega unless dryRun.
 */
async function generateOmegaVnext(opts = {}) {
  const dateISO = opts.date || todayET();
  const dateFormatted = formatDateLong(dateISO);
  const force = !!opts.force;
  const simMode = !!opts.simMode;
  const dryRun = !!opts.dryRun;
  const now = new Date();

  console.log(`[omega-vnext] START ${MODEL_VERSION} date=${dateISO} force=${force} sim=${simMode}`);

  const snap = await ingest(dateISO, {
    historicalSnapshot: opts.historicalSnapshot,
  });
  console.log(`[omega-vnext] ingest sports=${Object.keys(snap.oddsBySport || {}).join(',')}`);

  let candidates = projectAll(snap);
  console.log(`[omega-vnext] raw candidates=${candidates.length}`);

  candidates = calibrateAll(candidates).map(attachEv);
  const { yesPool, rejected } = applyGates(candidates);
  console.log(`[omega-vnext] yesPool=${yesPool.length} rejected=${rejected.length}`);

  const selected = selectStraights(yesPool, MAX_STRAIGHTS);
  let picks = selected.map(c => toPickObject(c, { modelVersion: MODEL_VERSION }));
  picks = applyDailyCap(picks);

  let parlayLegs = optimizeParlay(yesPool, picks);

  const narr = await narrateAndVerify({
    picks,
    dateFormatted,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  picks = narr.picks;
  // If Claude vetoed some, rebuild parlay from remaining yes excluding vetoed sides
  if (narr.rejections && narr.rejections.length) {
    const veto = new Set(narr.rejections.map(r => (r.side || '').toLowerCase()));
    const pool2 = yesPool.filter(c => !veto.has((c.side || '').toLowerCase()));
    parlayLegs = optimizeParlay(pool2, picks);
  }

  picks = attachClvFields(picks, MODEL_VERSION);
  parlayLegs = attachClvToParlay(parlayLegs, MODEL_VERSION);

  const totalUnits = picks.reduce((s, p) => s + (parseFloat(p.units) || 0), 0);
  const sportsCovered = [...new Set(picks.map(p => p.sport))];

  const candidateTable = yesPool.slice(0, 15).map((c, i) => ({
    rank: i + 1,
    sport: c.sport,
    side: c.side,
    market: c.market,
    odds: c.odds,
    modelProjection: c.modelProjection,
    consensusLine: c.consensusLine,
    edge: c.edgePct,
    coverProb: c.coverProb,
    ev: c.ev,
    matchup: c.matchup,
    commenceTime: c.commenceTime,
    predictedClv: c.predictedClv,
    projMethod: c.projMethod,
    selected: picks.some(p => p.pick === c.side && p.matchup === c.matchup),
  }));

  const rejections = [
    ...(narr.rejections || []),
    ...rejected.slice(0, 40).map(r => ({
      matchup: r.matchup,
      side: r.side,
      reason: r.rejectReason || 'gate',
    })),
  ];

  const empty = picks.length === 0;
  const picksData = {
    date: dateISO,
    dateFormatted,
    model: MODEL_VERSION,
    picks,
    rejections,
    edgeSummary: narr.edgeSummary || '',
    insights: narr.insights || '',
    summary: {
      totalPicks: picks.length,
      totalStraightBets: picks.length,
      totalUnits: `${totalUnits.toFixed(1)}u`,
      aplusLocks: picks.filter(p => p.rating === 'aplus').length,
      sportsCovered,
      modelVersion: MODEL_VERSION,
    },
    generatedAt: now.toISOString(),
    parlayLegs: empty ? [] : parlayLegs,
    sgps: [],
    claudeVerified: !!narr.claudeVerified,
    fallback: false,
    candidateTable,
    modelNotes: MODEL_NOTES,
    engine: 'omega-vnext',
  };
  if (empty) {
    picksData.noPlays = 'No qualifying CLV-positive edges today.';
    picksData.edgeSummary = picksData.edgeSummary || picksData.noPlays;
  }

  if (!dryRun) {
    await storePicks(dateISO, picksData, { force, simMode });
  }

  console.log(`[omega-vnext] DONE picks=${picks.length} parlay=${(picksData.parlayLegs || []).length}`);
  return picksData;
}

module.exports = {
  generateOmegaVnext,
  MODEL_VERSION,
  projectAll,
  todayET,
};
