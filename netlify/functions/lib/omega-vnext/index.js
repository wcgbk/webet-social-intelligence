'use strict';

const {
  MODEL_VERSION, MODEL_NOTES, SPORTS_ENABLED, MAX_STRAIGHTS,
} = require('./config');
const { ingest } = require('./ingest');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { selectStraights, toPickObject, applyDailyCap, applyDailyUnitCap, sortByGradeThenUnits } = require('./select');
const { optimizeParlay } = require('./parlay');
const { narrateAndVerify, narrateParlayLegsOnly } = require('./narrate');
const { attachClvFields, attachClvToParlay } = require('./clv_log');
const { applyHardFails, loadQaContext, majorBookStillOffers } = require('./qa_hardfail');
const { storePicks } = require('./store');
const { loadLinePath, annotateLineMoves } = require('./line_path');

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
      espnGames: snap.espnBySport && snap.espnBySport.MLB,
      mlbPitcherStats: snap.mlbPitcherStats || {},
      parkFactors: snap.parkFactors || {},
    }));
  }
  if (SPORTS_ENABLED.NFL) {
    raw.push(...nfl.project({
      oddsEvents: snap.oddsBySport.NFL || [],
      standings: snap.standingsBySport.NFL || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NFL) || {},
    }));
  }
  if (SPORTS_ENABLED.NCAAF) {
    raw.push(...cfb.project({
      oddsEvents: snap.oddsBySport.NCAAF || [],
      standings: snap.standingsBySport.NCAAF || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NCAAF) || {},
    }));
  }
  if (SPORTS_ENABLED.NBA) raw.push(...nba.project({}));
  if (SPORTS_ENABLED.NHL) raw.push(...nhl.project({}));
  return raw;
}

function annotateMajorBooks(candidates, snap) {
  const bySport = snap.oddsBySport || {};
  return (candidates || []).map(c => {
    const events = bySport[c.sport] || [];
    const ev = events.find(e =>
      (e.home_team === c.homeTeam && e.away_team === c.awayTeam) ||
      (e.home_team === c.awayTeam && e.away_team === c.homeTeam)
    );
    const offering = majorBookStillOffers(ev, c);
    return {
      ...c,
      majorBooksOffering: offering == null ? true : offering,
      lockSnapshot: c.lockSnapshot || {
        odds: c.oddsStr || c.odds,
        line: c.line != null ? c.line : null,
        book: c.book || null,
        capturedAt: snap.fetchedAt || new Date().toISOString(),
        openPrint: c.openPrint || null,
      },
    };
  });
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
  candidates = annotateMajorBooks(candidates, snap);

  // Open→pick US line-move (earliest morning snap → latest pre-generate)
  let linePathMeta = { earliest: null, latest: null };
  try {
    const loaded = await loadLinePath(dateISO);
    linePathMeta = loaded;
    if (loaded.earliest) {
      candidates = annotateLineMoves(candidates, loaded.earliest, loaded.latest || loaded.earliest);
      const withOpen = candidates.filter(c => c.openPrint).length;
      console.log(`[omega-vnext] line-move open=${loaded.earliest.hhmm || loaded.earliest.slot} latest=${(loaded.latest && (loaded.latest.hhmm || loaded.latest.slot)) || 'n/a'} annotated=${withOpen}/${candidates.length}`);
    } else {
      console.log(`[omega-vnext] line-move: no morning snaps for ${dateISO} (continuing without steam gates)`);
    }
  } catch (e) {
    console.error(`[omega-vnext] line-move load failed: ${e.message}`);
  }

  // placeableBooks / bestPlaceable are attached in enrichCandidateWithEdge
  // (sport project, before calibrate + attachEv). Gates then soft-veto
  // unshoppable US retail lines. Do not publish those.
  const placeableAnnotated = candidates.filter(c => Array.isArray(c.placeableBooks)).length;
  console.log(`[omega-vnext] placeability annotated=${placeableAnnotated}/${candidates.length}`);

  const { yesPool, rejected } = applyGates(candidates, { cardDate: dateISO });
  const placeVeto = rejected.filter(r => r.rejectReason === 'placeability-soft-veto').length;
  console.log(`[omega-vnext] yesPool=${yesPool.length} rejected=${rejected.length} placeabilityVeto=${placeVeto}`);

  const selected = selectStraights(yesPool, MAX_STRAIGHTS);

  // QA hard-fails before narrate/store — drop + refill; empty OK
  let qaCtx = {};
  try {
    const sports = [...new Set(selected.map(c => c.sport).concat(yesPool.slice(0, 12).map(c => c.sport)))];
    qaCtx = await loadQaContext(dateISO, sports);
    console.log(`[omega-vnext] QA context loaded sports=${sports.join(',')}`);
  } catch (e) {
    console.error(`[omega-vnext] QA context load failed (continuing): ${e.message}`);
  }

  const qa = applyHardFails(selected, yesPool, qaCtx, {
    maxN: MAX_STRAIGHTS,
    modelVersion: MODEL_VERSION,
  });
  let picks = qa.picks;
  const hardFails = qa.hardFails || [];
  if (hardFails.length) {
    console.log(`[omega-vnext] QA hard-fails=${hardFails.length}: ${hardFails.map(h => h.reason).join('; ')}`);
  }
  // Provisional straight-only trim; final 3.5u straights + 0.5u parlay (≤4.0u) after optimizeParlay
  picks = applyDailyCap(picks);

  const poolForParlay = qa.yesPoolRemaining || yesPool;
  let parlayLegs = optimizeParlay(poolForParlay, picks, { cardDate: dateISO });

  const narr = await narrateAndVerify({
    picks,
    parlayLegs,
    dateFormatted,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  picks = narr.picks;
  parlayLegs = narr.parlayLegs || parlayLegs;
  if (narr.rejections && narr.rejections.length) {
    const veto = new Set(narr.rejections.map(r => (r.side || '').toLowerCase()));
    const pool2 = poolForParlay.filter(c => !veto.has((c.side || '').toLowerCase()));
    parlayLegs = optimizeParlay(pool2, picks, { cardDate: dateISO });
    // Re-narrate new parlay legs after veto-driven re-optimize
    parlayLegs = await narrateParlayLegsOnly({
      parlayLegs,
      dateFormatted,
      apiKey: process.env.ANTHROPIC_API_KEY,
      straightPicks: picks,
    });
  }

  picks = attachClvFields(picks, MODEL_VERSION, dateISO);
  parlayLegs = attachClvToParlay(parlayLegs, MODEL_VERSION, dateISO);

  // Final unit structure: straights ≤3.5u + fixed 0.5u parlay ≤ 4.0u MAX. Sort grade then units.
  {
    const capped = applyDailyUnitCap(picks, parlayLegs);
    picks = capped.picks;
    parlayLegs = capped.parlayLegs;
  }
  picks = sortByGradeThenUnits(picks);

  const parlayUnits = (parlayLegs || []).reduce((s, pl) => s + (parseFloat(pl.units) || 0), 0);
  const totalUnits = picks.reduce((s, p) => s + (parseFloat(p.units) || 0), 0) + parlayUnits;
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
    predictedResidualClv: c.predictedResidualClv,
    steamToward: !!c.steamToward,
    steamAgainst: !!c.steamAgainst,
    openPrint: c.openPrint || null,
    projMethod: c.projMethod,
    placeableBooks: Array.isArray(c.placeableBooks) ? c.placeableBooks : null,
    bestPlaceable: c.bestPlaceable || null,
    selected: picks.some(p => p.pick === c.side && p.matchup === c.matchup),
  }));

  const rejections = [
    ...hardFails.map(h => ({
      matchup: h.matchup,
      side: h.side,
      reason: `QA_HARDFAIL: ${h.reason}`,
      hardFail: true,
    })),
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
      qaHardFails: hardFails.length,
    },
    generatedAt: now.toISOString(),
    parlayLegs: empty ? [] : parlayLegs,
    sgps: [],
    claudeVerified: !!narr.claudeVerified,
    fallback: false,
    candidateTable,
    modelNotes: MODEL_NOTES,
    engine: 'omega-vnext',
    qaHardFails: hardFails,
    linePath: {
      earliestSlot: linePathMeta.earliest ? (linePathMeta.earliest.hhmm || linePathMeta.earliest.slot) : null,
      latestSlot: linePathMeta.latest ? (linePathMeta.latest.hhmm || linePathMeta.latest.slot) : null,
      openPollCount: linePathMeta.path && Array.isArray(linePathMeta.path.polls)
        ? linePathMeta.path.polls.length : 0,
    },
  };
  if (empty) {
    picksData.noPlays = hardFails.length
      ? 'No qualifying edges after QA hard-fails.'
      : 'No qualifying CLV-positive edges today.';
    picksData.edgeSummary = picksData.edgeSummary || picksData.noPlays;
  }

  if (!dryRun) {
    await storePicks(dateISO, picksData, { force, simMode });
  }

  console.log(`[omega-vnext] DONE picks=${picks.length} parlay=${(picksData.parlayLegs || []).length} hardFails=${hardFails.length}`);
  return picksData;
}

module.exports = {
  generateOmegaVnext,
  MODEL_VERSION,
  projectAll,
  todayET,
};
