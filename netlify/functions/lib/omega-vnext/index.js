'use strict';

const {
  MODEL_VERSION, MODEL_NOTES, SPORTS_ENABLED, MAX_STRAIGHTS, LINE_MOVE, PM_SOFT,
} = require('./config');
const { ingest } = require('./ingest');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { selectStraights, toPickObject, applyDailyCap, applyDailyUnitCap, sortByGradeThenUnits, orderedByScore, formatMoneylinePick } = require('./select');
const { optimizeParlay } = require('./parlay');
const { narrateAndVerify, narrateParlayLegsOnly } = require('./narrate');
const { attachClvFields, attachClvToParlay } = require('./clv_log');
const { applyHardFails, loadQaContext, majorBookStillOffers } = require('./qa_hardfail');
const { storePicks, storeShadowPicks, storePmObserver, storeJson, storeCaptureHealthSnapshot, readPmObserverOpen } = require('./store');
const { runPmObserver, annotatePmSoftFeatures } = require('./pm_observer');
const { loadLinePath, annotateLineMoves, assessCaptureHealth, missingDueSlots, canonicalRetrySlot } = require('./line_path');
const { runOmegaLineCapture } = require('./capture_runner');

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
  const gameDay = snap.gameDay || {};
  if (SPORTS_ENABLED.MLB) {
    raw.push(...mlb.project({
      oddsEvents: snap.oddsBySport.MLB || [],
      standings: snap.standingsBySport.MLB || {},
      espnGames: snap.espnBySport && snap.espnBySport.MLB,
      mlbPitcherStats: snap.mlbPitcherStats || {},
      parkFactors: snap.parkFactors || {},
      gameDay,
      weatherByGame: gameDay.weatherByGame || {},
    }));
  }
  if (SPORTS_ENABLED.NFL) {
    raw.push(...nfl.project({
      oddsEvents: snap.oddsBySport.NFL || [],
      standings: snap.standingsBySport.NFL || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NFL) || {},
      gameDay,
    }));
  }
  if (SPORTS_ENABLED.NCAAF) {
    raw.push(...cfb.project({
      oddsEvents: snap.oddsBySport.NCAAF || [],
      standings: snap.standingsBySport.NCAAF || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NCAAF) || {},
      gameDay,
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
 * Walk-forward calibration is a SEPARATE observer (capture-omega-walkforward);
 * this generator never reads walk-forward fit params — shrink stays static config.
 */


/**
 * Ops-only: persist last captureHealth + optional OMEGA_OPS_WEBHOOK_URL POST.
 * Never touches live picks keys. Soft-fail at call site.
 */
async function emitCaptureHealthOps(dateISO, captureHealth, meta = {}) {
  const snapshot = {
    event: 'captureHealthOps',
    date: dateISO,
    shadow: !!meta.shadow,
    modelVersion: MODEL_VERSION,
    ...captureHealth,
  };
  try {
    await storeCaptureHealthSnapshot(dateISO, snapshot);
  } catch (e) {
    console.warn(JSON.stringify({ event: 'captureHealthOpsStoreSoftFail', date: dateISO, error: e.message }));
  }
  const url = process.env.OMEGA_OPS_WEBHOOK_URL || process.env.OMEGA_CAPTURE_HEALTH_WEBHOOK_URL;
  if (url) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!resp.ok) {
        console.warn(JSON.stringify({
          event: 'captureHealthOpsWebhookSoftFail',
          date: dateISO,
          status: resp.status,
        }));
      }
    } catch (e) {
      console.warn(JSON.stringify({
        event: 'captureHealthOpsWebhookSoftFail',
        date: dateISO,
        error: e.message,
      }));
    }
  }
}

async function generateOmegaVnext(opts = {}) {
  const dateISO = opts.date || todayET();
  const dateFormatted = formatDateLong(dateISO);
  const force = !!opts.force;
  const simMode = !!opts.simMode;
  const dryRun = !!opts.dryRun;
  const shadow = !!opts.shadow;
  const skipNarrate = !!opts.skipNarrate;
  const now = new Date();
  // Historical replay has no morning snap series. Do not retry live Odds into
  // the line-path store and do not hard-fail the eval day.
  const replayLike = !!(opts.historicalSnapshot || opts.replay);

  console.log(`[omega-vnext] START ${MODEL_VERSION} date=${dateISO} force=${force} sim=${simMode} shadow=${shadow}`);

  const snap = await ingest(dateISO, {
    historicalSnapshot: opts.historicalSnapshot,
  });
  console.log(`[omega-vnext] ingest sports=${Object.keys(snap.oddsBySport || {}).join(',')}`);

  let candidates = projectAll(snap);
  console.log(`[omega-vnext] raw candidates=${candidates.length}`);

  candidates = calibrateAll(candidates).map(attachEv);
  candidates = annotateMajorBooks(candidates, snap);

  // Open→pick US line-move (earliest morning snap → latest pre-generate).
  // Missing required snaps: one real Odds capture into the current ET slot, then re-load.
  // Zero usable snaps after that hard-fails. Partial snaps warn and continue.
  // Does not invent snaps and does not force-fill leans.
  let linePathMeta = { path: null, earliest: null, latest: null };
  try {
    const loaded = await loadLinePath(dateISO);
    if (loaded) linePathMeta = loaded;
  } catch (e) {
    console.error(`[omega-vnext] line-move load failed: ${e.message}`);
  }

  const requiredSlotsET = (LINE_MOVE && LINE_MOVE.captureSlotsET) || ['0600', '0730', '0900', '0915'];
  let captureHealth = assessCaptureHealth(dateISO, linePathMeta, { requiredSlotsET });
  let retriedCapture = false;
  let retryOk = null;
  // Retry only for snaps that should already exist (9:05 must not treat 9:15 as failed).
  const dueMissing = missingDueSlots(captureHealth.missingSlotsET, now);
  const retrySlot = replayLike ? null : canonicalRetrySlot(now, {
    slots: requiredSlotsET,
    missingDue: dueMissing,
    usableSnapCount: captureHealth.usableSnapCount,
  });
  if (retrySlot) {
    retriedCapture = true;
    try {
      const cap = await runOmegaLineCapture({ force: true, dateISO, now, etSlot: retrySlot });
      retryOk = !!(cap && Number(cap.gameCount) > 0);
      console.log(JSON.stringify({
        event: 'captureHealthRetry',
        date: dateISO,
        retryOk,
        gameCount: cap && cap.gameCount,
        etSlot: cap && cap.etSlot,
        error: null,
      }));
    } catch (e) {
      retryOk = false;
      console.warn(JSON.stringify({
        event: 'captureHealthRetry',
        date: dateISO,
        retryOk: false,
        error: e.message,
      }));
    }
    try {
      const reloaded = await loadLinePath(dateISO);
      if (reloaded) linePathMeta = reloaded;
    } catch (e) {
      console.error(`[omega-vnext] line-move reload failed: ${e.message}`);
    }
    captureHealth = assessCaptureHealth(dateISO, linePathMeta, {
      requiredSlotsET,
      retriedCapture,
      retryOk,
    });
  }

  if (replayLike) {
    const complete = captureHealth.usableSnapCount > 0 && captureHealth.missingSlotsET.length === 0;
    captureHealth = {
      ...captureHealth,
      hardFail: false,
      reason: null,
      retriedCapture: false,
      retryOk: null,
      ok: complete,
      warning: complete
        ? null
        : `CAPTURE_HEALTH: historical replay skips live snap retry/hard-fail for ${dateISO}`,
    };
  }

  if (linePathMeta.earliest) {
    candidates = annotateLineMoves(candidates, linePathMeta.earliest, linePathMeta.latest || linePathMeta.earliest);
    const withOpen = candidates.filter(c => c.openPrint).length;
    const openSlot = linePathMeta.earliest.hhmm || linePathMeta.earliest.slot;
    const latestSlot = (linePathMeta.latest && (linePathMeta.latest.hhmm || linePathMeta.latest.slot)) || 'n/a';
    console.log(`[omega-vnext] line-move open=${openSlot} latest=${latestSlot} annotated=${withOpen}/${candidates.length}`);
  } else {
    console.log(`[omega-vnext] line-move: no morning snaps for ${dateISO}`);
  }

  const healthLog = { event: 'captureHealth', date: dateISO, shadow: !!shadow, ...captureHealth };
  if (captureHealth.warning || captureHealth.hardFail) console.warn(JSON.stringify(healthLog));
  else console.log(JSON.stringify(healthLog));

  // Ops-only signal: persist snapshot + optional HTTP callback. Does NOT change hardFail policy.
  if (!replayLike && !shadow) {
    try {
      await emitCaptureHealthOps(dateISO, captureHealth, { shadow: !!shadow });
    } catch (e) {
      console.warn(JSON.stringify({ event: 'captureHealthOpsSoftFail', date: dateISO, error: e.message }));
    }
  }

  if (captureHealth.hardFail) {
    const err = new Error(captureHealth.reason || `CAPTURE_HEALTH: zero usable morning line snaps for ${dateISO} after retry`);
    err.code = 'CAPTURE_HEALTH';
    err.captureHealth = captureHealth;
    throw err;
  }

  // Kalshi/Polymarket soft features BEFORE gates so yesPool carries _pmScoreAdj
  // into selectStraights. Score only. API/map failure → 0 and generate continues.
  // Replay has no as-of PM history; do not apply today's live prices.
  let pmSoftMeta = {
    applied: false,
    skipped: null,
    priorOpen: false,
    mapped: 0,
    sources: null,
    maxAbsScoreAdj: PM_SOFT.maxAbsScoreAdj,
    scoreWeightVsBook: PM_SOFT.scoreWeightVsBook,
    scoreWeightMove: PM_SOFT.scoreWeightMove,
    venueCombine: PM_SOFT.venueCombine,
  };
  // Reuse a successful generate-time fetch for the post-card audit so 9:30
  // does not hit Kalshi/Polymarket twice. Null means the audit may retry.
  let pmAuditMarkets = { polyMarkets: null, kalshiMarkets: null };
  const injectedPm = opts.pmPolyMarkets != null || opts.pmKalshiMarkets != null;
  if (replayLike && !injectedPm) {
    candidates = (candidates || []).map(c => ({
      ...c,
      _pmScoreAdj: 0,
      pmFeatures: {
        pmVsBookGap: null, pmMove: null, pmImplied: null, bookImplied: null,
        venues: [], _pmScoreAdj: 0, capped: false, reason: 'replay-skip',
      },
    }));
    pmSoftMeta.skipped = 'replay';
    console.log(`[omega-vnext] pm-soft skipped (historical replay) date=${dateISO}`);
  } else {
    try {
      let prior = opts.pmPriorArtifact || null;
      if (!prior) {
        try { prior = await readPmObserverOpen(dateISO); } catch (e) {
          console.warn(`[omega-vnext] pm open read soft-fail: ${e.message}`);
          prior = null;
        }
      }
      const annotated = await annotatePmSoftFeatures(candidates, {
        priorArtifact: prior,
        polyMarkets: opts.pmPolyMarkets,
        kalshiMarkets: opts.pmKalshiMarkets,
        dateISO,
      });
      candidates = annotated.candidates;
      const mapped = (candidates || []).filter(c => c.pmFeatures && c.pmFeatures.pmImplied != null).length;
      pmSoftMeta = {
        ...pmSoftMeta,
        applied: true,
        skipped: null,
        priorOpen: !!annotated.priorOpen,
        mapped,
        sources: annotated.sources || null,
      };
      const polyOk = annotated.sources && annotated.sources.polymarket && annotated.sources.polymarket.ok;
      const kalshiOk = annotated.sources && annotated.sources.kalshi && annotated.sources.kalshi.ok;
      pmAuditMarkets = {
        polyMarkets: polyOk ? (annotated.polyMarkets || []) : null,
        kalshiMarkets: kalshiOk ? (annotated.kalshiMarkets || []) : null,
      };
      console.log(`[omega-vnext] pm-soft mapped=${mapped} priorOpen=${!!annotated.priorOpen} poly=${!!polyOk} kalshi=${!!kalshiOk}`);
    } catch (e) {
      console.error(`[omega-vnext] pm-soft soft-fail: ${e.message}`);
      candidates = (candidates || []).map(c => ({
        ...c,
        _pmScoreAdj: 0,
        pmFeatures: c.pmFeatures || {
          pmVsBookGap: null, pmMove: null, pmImplied: null, bookImplied: null,
          venues: [], _pmScoreAdj: 0, capped: false, reason: 'soft-fail',
        },
      }));
      pmSoftMeta.skipped = 'soft-fail';
      pmSoftMeta.error = e.message;
    }
  }

  // placeableBooks / bestPlaceable are attached in enrichCandidateWithEdge
  // (sport project, before calibrate + attachEv). Gates then soft-veto
  // unshoppable US retail lines. Do not publish those.
  const placeableAnnotated = candidates.filter(c => Array.isArray(c.placeableBooks)).length;
  console.log(`[omega-vnext] placeability annotated=${placeableAnnotated}/${candidates.length}`);

  // Historical replay: pregame is vs the snapshot instant, not wall-clock now.
  // Live generate leaves asOf unset (Date.now() + 5-minute grace unchanged).
  const gateOpts = { cardDate: dateISO };
  if (replayLike) {
    const asOfMs = Date.parse(opts.historicalSnapshot);
    if (Number.isFinite(asOfMs)) gateOpts.asOfMs = asOfMs;
  }
  const { yesPool, rejected } = applyGates(candidates, gateOpts);
  if (gateOpts.asOfMs != null) {
    console.log(`[omega-vnext] pregame asOf=${new Date(gateOpts.asOfMs).toISOString()}`);
  }
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

  let narr = { picks, parlayLegs, rejections: [], edgeSummary: '', insights: '', claudeVerified: false };
  if (!skipNarrate) {
    narr = await narrateAndVerify({
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
      parlayLegs = await narrateParlayLegsOnly({
        parlayLegs,
        dateFormatted,
        apiKey: process.env.ANTHROPIC_API_KEY,
        straightPicks: picks,
      });
    }
  } else {
    console.log('[omega-vnext] skipNarrate=true (replay/eval path)');
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

  const candidateTable = orderedByScore(yesPool).slice(0, 15).map((c, i) => ({
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
    pmFeatures: c.pmFeatures || null,
    _pmScoreAdj: typeof c._pmScoreAdj === 'number' ? c._pmScoreAdj : 0,
    openPrint: c.openPrint || null,
    projMethod: c.projMethod,
    placeableBooks: Array.isArray(c.placeableBooks) ? c.placeableBooks : null,
    bestPlaceable: c.bestPlaceable || null,
    selected: picks.some(p => {
      const labeled = formatMoneylinePick(c.side, c.market);
      return (p.pick === c.side || p.pick === labeled) && p.matchup === c.matchup;
    }),
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
    captureHealth: captureHealth || null,
    pmSoft: pmSoftMeta,
    meta: {
      captureHealth: captureHealth || null,
      pmSoft: pmSoftMeta,
      shadow: !!shadow,
      storeKey: shadow ? `omega-shadow/picks-${dateISO}` : null,
    },
  };
  if (shadow) {
    picksData.shadow = true;
    picksData.storeKey = `omega-shadow/picks-${dateISO}`;
    picksData.meta.storeKey = picksData.storeKey;
  }
  if (empty) {
    picksData.noPlays = hardFails.length
      ? 'WeBetAI passed after late checks. Nothing left was worth a stake.'
      : 'WeBetAI passed on today\'s board. No number was soft enough to lock.';
    picksData.edgeSummary = picksData.edgeSummary || picksData.noPlays;
  }

  // Shadow writes omega-shadow/* only (no live picks, latest-date, picks-dates, or verify unlock).
  if (!dryRun && shadow) {
    await storeShadowPicks(dateISO, picksData);
  } else if (!dryRun) {
    await storePicks(dateISO, picksData, { force, simMode });
  }

  // Prediction-market OBSERVER sidecar — non-blocking, never mutates locked picks.
  // Soft score already ran before selectStraights. This write is the audit log.
  // API failures must not fail generate.
  // Shadow keeps the artifact under omega-shadow/ and does not call storePmObserver.
  let pmObserver = null;
  if (!dryRun && shadow) {
    try {
      const pool = [
        ...picks.map(p => ({
          sport: p.sport, homeTeam: p.homeTeam, awayTeam: p.awayTeam,
          side: p.pick || p.side, market: p.betType || p.market || 'Moneyline',
          matchup: p.matchup, rating: p.rating, units: p.units,
          edgePct: p.edgePct, ev: p.ev, coverProb: p.coverProb,
        })),
        ...yesPool.slice(0, 25).map(c => ({
          sport: c.sport, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
          side: c.side, market: c.market, matchup: c.matchup,
          rating: null, units: null, edgePct: c.edgePct, ev: c.ev, coverProb: c.coverProb,
        })),
      ];
      pmObserver = await runPmObserver({
        dateISO, candidates: pool, picks: picks.map(p => ({ ...p })),
        modelVersion: MODEL_VERSION,
        polyMarkets: pmAuditMarkets.polyMarkets,
        kalshiMarkets: pmAuditMarkets.kalshiMarkets,
      });
      const shadowPmKey = `omega-shadow/pm-observer/${dateISO}`;
      await storeJson(shadowPmKey, { ...pmObserver, shadow: true });
      console.log(`[omega-vnext] shadow pm-observer mapped=${pmObserver.mappedCount} key=${shadowPmKey}`);
    } catch (e) {
      console.error(`[omega-vnext] shadow pm-observer soft-fail: ${e.message}`);
      pmObserver = { observer: 'omega-pm-observer', date: dateISO, shadow: true, error: e.message, mappedCount: 0, notes: [] };
    }
  } else if (!dryRun && !simMode) {
    try {
      const pool = [
        ...picks.map(p => ({
          sport: p.sport, homeTeam: p.homeTeam, awayTeam: p.awayTeam,
          side: p.pick || p.side, market: p.betType || p.market || 'Moneyline',
          matchup: p.matchup, rating: p.rating, units: p.units,
          edgePct: p.edgePct, ev: p.ev, coverProb: p.coverProb,
        })),
        ...yesPool.slice(0, 25).map(c => ({
          sport: c.sport, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
          side: c.side, market: c.market, matchup: c.matchup,
          rating: null, units: null, edgePct: c.edgePct, ev: c.ev, coverProb: c.coverProb,
        })),
      ];
      pmObserver = await runPmObserver({
        dateISO, candidates: pool, picks: picks.map(p => ({ ...p })),
        modelVersion: MODEL_VERSION,
        polyMarkets: pmAuditMarkets.polyMarkets,
        kalshiMarkets: pmAuditMarkets.kalshiMarkets,
      });
      await storePmObserver(dateISO, pmObserver);
      console.log(`[omega-vnext] pm-observer mapped=${pmObserver.mappedCount} poly=${pmObserver.sources.polymarket.ok} kalshi=${pmObserver.sources.kalshi.ok}`);
    } catch (e) {
      console.error(`[omega-vnext] pm-observer soft-fail: ${e.message}`);
      pmObserver = { observer: 'omega-pm-observer', date: dateISO, error: e.message, mappedCount: 0, notes: [] };
    }
  }

  if (pmObserver) {
    picksData.pmObserver = {
      mappedCount: pmObserver.mappedCount,
      key: shadow ? `omega-shadow/pm-observer/${dateISO}` : `omega-pm-observer/${dateISO}`,
      shadow: !!shadow,
    };
  }

  console.log(`[omega-vnext] DONE picks=${picks.length} parlay=${(picksData.parlayLegs || []).length} hardFails=${hardFails.length}`);
  return picksData;
}

module.exports = {
  generateOmegaVnext,
  MODEL_VERSION,
  projectAll,
  todayET,
  assessCaptureHealth,
};
