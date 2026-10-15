'use strict';

const {
  MODEL_VERSION, MODEL_NOTES, SPORTS_ENABLED, MAX_STRAIGHTS, PM_SOFT,
  LEAN_PAD, nbaModuleEnabled,
} = require('./config');
const { sportsForCard, applyUnresolvedSkip, formatSkipLog } = require('./season_calendar');
const { ingest } = require('./ingest');
const { noPlaysFields, omegaReason } = require('../no-plays');
const { calibrateAll, resolveCalMode } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates, buildGapReview } = require('./gates');
const { applyExecutionBook, top10Rows, recordRankedList, excludedGames, selectTop10, ensureParlayPlaceable, hasHardRockPrice } = require('./selection_pass');
const { fetchXNews } = require('./x_news');
const { replayNoWrite } = require('./no_write');
const {
  createAuditLog, runWithAudit, currentAudit, persistAuditLog, attachAuditSummary, resolveFetch, makeRunId,
} = require('./audit_log');
const { selectStraights, toPickObject, applyDailyCap, applyDailyUnitCap, sortByGradeThenUnits, orderedByScore, formatMoneylinePick, straightCardLabel, qualifiesAsLean, eligiblePairedFill, shouldPublishNoPlays, drawdownActive } = require('./select');
const { parlayFromStraights } = require('./parlay');
const { narrateAndVerify } = require('./narrate');
const { attachClvFields, attachClvToParlay } = require('./clv_log');
const { applyHardFails, loadQaContext, majorBookStillOffers } = require('./qa_hardfail');
const { storePicks, storeShadowPicks, storePmObserver, storeJson, storeCaptureHealthSnapshot, readPmObserverOpen, storeHealthRecord } = require('./store');
const { persistCandidateLedger } = require('./candidate_ledger');
const { buildUnmatchedReport, persistUnmatchedReport } = require('./sports/team_identity');
const { attachGenerateHealth, extremeMarginSports } = require('./health');
const { buildShortfall } = require('./shortfall');
const { runPmObserver, annotatePmSoftFeatures } = require('./pm_observer');
const { loadLinePath, annotateLineMoves, assessCaptureHealth, assessPullCaptureHealth, warnCaptureHealth } = require('./line_path');
const { applyDkLag } = require('./dk_lag');
const { applyPureModel, PURE_MODEL_VERSION } = require('./pure_model');
const { applyLineMoveProb } = require('./line_move_prob');
const { runWithFetchMemo } = require('./fetch_memo');
const { runWithSnapshotClock } = require('./odds_snapshot_cache');
const { stampCandidates } = require('./late_news');
const { resolveGenerateOddsSnapshot, etLocalToUtcISO } = require('./price_lock');
const { retryMissingDraftKings } = require('./dk_retry');
const { logReviewFlags, reviewFlag } = require('./pinnacle_flag');
const { holdReason, fetchPostedQuotes, gamesWithoutCurrentSpread, gameKey } = require('./posted_line');
const { readPinnacleLineMoves, applyLineMoveContext, linePathForSelection } = require('./pinnacle_line_move');
const { awaitLiveCaptureGate } = require('./capture_gate');
const { summaryStakeDisplay } = require('./odds_math');
const { applyGenerateReserve } = require('./card_topup');

const mlb = require('./sports/mlb');
const nfl = require('./sports/nfl');
const cfb = require('./sports/cfb');
const nba = require('./sports/nba');
const nhl = require('./sports/nhl');
const { footballAuditFields } = require('./sports/_common');
const { buildCardAudit } = require('./audit_card');
const { restAuditFields } = require('./sports/game_day');
const { cardStarterFeed } = require('./sports/depth_chart');

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

function cardDateOf(snap, dateISO) {
  if (dateISO) return dateISO;
  if (snap && (snap.dateISO || snap.date)) return snap.dateISO || snap.date;
  return null;
}

/** Sports the card prices. No card date keeps the SPORTS_ENABLED kill switch (tests, callers without a date). OMEGA_NBA=1 adds NBA on that path. */
function sportsOnCard(snap, dateISO) {
  const date = cardDateOf(snap, dateISO);
  if (!date) {
    const sports = ['MLB', 'NFL', 'NCAAF', 'NHL'];
    if (SPORTS_ENABLED.NBA) sports.push('NBA');
    else if (nbaModuleEnabled()) sports.push('NBA');
    return sports.filter((s) => SPORTS_ENABLED[s] || (s === 'NBA' && nbaModuleEnabled()));
  }
  return sportsForCard(date);
}

/** Same-day games per sport for the no-plays reason (ESPN first, odds as fallback). */
function slateCountsFor(snap, dateISO) {
  const bySport = {};
  let espn = 0, odds = 0;
  const sports = sportsOnCard(snap, dateISO);
  for (const s of sports) {
    const e = snap && snap.espnBySport && snap.espnBySport[s] && Array.isArray(snap.espnBySport[s].games)
      ? snap.espnBySport[s].games.length : 0;
    const o = snap && snap.oddsBySport && Array.isArray(snap.oddsBySport[s]) ? snap.oddsBySport[s].length : 0;
    espn += e; odds += o;
    bySport[s] = e || o;
  }
  return { bySport, espn, odds, total: Object.values(bySport).reduce((a, b) => a + b, 0) };
}

function projectAll(snap, dateISO) {
  const raw = [];
  const gameDay = snap.gameDay || {};
  const on = new Set(sportsOnCard(snap, dateISO));
  if (on.has('MLB')) {
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
  if (on.has('NFL')) {
    raw.push(...nfl.project({
      oddsEvents: snap.oddsBySport.NFL || [],
      standings: snap.standingsBySport.NFL || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NFL) || {},
      gameDay,
      espnGames: snap.espnBySport && snap.espnBySport.NFL,
    }));
  }
  if (on.has('NCAAF')) {
    raw.push(...cfb.project({
      oddsEvents: snap.oddsBySport.NCAAF || [],
      standings: snap.standingsBySport.NCAAF || {},
      efficiency: (snap.efficiencyBySport && snap.efficiencyBySport.NCAAF) || {},
      gameDay,
      espnGames: snap.espnBySport && snap.espnBySport.NCAAF,
    }));
  }
  // Real board only when the card date (or, with no date, SPORTS_ENABLED.NBA
  // or OMEGA_NBA=1) says so. Off produces nothing here. Preseason candidates
  // are still dropped. NBA_CARD_LIVE stays false.
  if (on.has('NBA')) {
    raw.push(...nba.project({
      oddsEvents: snap.oddsBySport.NBA || [],
      standings: snap.standingsBySport.NBA || {},
      gameDay,
      espnGames: snap.espnBySport && snap.espnBySport.NBA,
    }).filter(c => !c.shadowOnly && !c.preseason));
  }
  if (on.has('NHL')) {
    raw.push(...nhl.project({
      oddsEvents: snap.oddsBySport.NHL || [],
      standings: snap.standingsBySport.NHL || {},
      gameDay,
      espnGames: snap.espnBySport && snap.espnBySport.NHL,
    }));
  }
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
      const resp = await resolveFetch(fetch)(url, {
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

/** True when the 10:00 ingest returned a US-region board with no sport error. */
function tenAmSnapshotCoversChecks(snap) {
  const bySport = snap && snap.oddsBySport;
  if (!bySport || typeof bySport !== 'object') return false;
  const names = Object.keys(bySport);
  if (!names.length) return false;
  if (Array.isArray(snap.oddsErrors) && snap.oddsErrors.length) return false;
  return names.every((name) => Array.isArray(bySport[name]));
}

/**
 * Recent win/loss rows for the drawdown rule. An injected list or reader
 * wins. A live run reads stored cards. A dry run, a replay, or a failed
 * read leaves grades missing so the stake cut stays off.
 */
async function gradedResultsForDrawdown(opts, dryRun, replayLike) {
  if (Array.isArray(opts.gradedResults)) return opts.gradedResults;
  if (typeof opts.readGradedResults === 'function') return opts.readGradedResults();
  if (dryRun || replayLike || opts.loadDrawdown === false) return null;
  const { readJson } = require('./store');
  const dates = await readJson('picks-dates');
  if (!Array.isArray(dates) || !dates.length) return null;
  const out = [];
  for (const date of dates.slice(-8)) {
    const card = await readJson(`picks-${date}`);
    for (const pick of (card && card.picks) || []) {
      const result = pick && pick.result;
      if (result === 'win' || result === 'loss' || result === 'push') out.push(result);
    }
  }
  return out.length ? out : null;
}

async function generateOmegaVnext(opts = {}) {
  if (!opts._fetchMemo) {
    const run = () => runWithFetchMemo(() => generateOmegaVnext({ ...opts, _fetchMemo: true }));
    const clock = Number(opts.pregameAsOfMs);
    if (Number.isFinite(clock)) return runWithSnapshotClock(clock, run);
    return run();
  }
  if (!opts._auditBound) {
    const dateForAudit = opts.date || todayET();
    const auditLog = opts.auditLog || createAuditLog({
      runId: opts.runId || makeRunId(),
      date: dateForAudit,
      fn: opts.auditFn || 'generate-picks-omega',
    });
    return runWithAudit(auditLog, () => generateOmegaVnext({
      ...opts,
      date: opts.date || dateForAudit,
      _auditBound: true,
      auditLog,
    }));
  }
  const auditLog = opts.auditLog || currentAudit();
  try {
  const dateISO = opts.date || todayET();
  const dateFormatted = formatDateLong(dateISO);
  const force = !!opts.force;
  const simMode = !!opts.simMode;
  const dryRun = !!opts.dryRun || replayNoWrite();
  const shadow = !!opts.shadow;
  const skipNarrate = !!opts.skipNarrate;
  const now = new Date();
  // Historical replay has no morning snap series. Do not retry live Odds into
  // the line-path store and do not hard-fail the eval day.
  // replayLike stays on the explicit flag. The 10:30 price lock is an odds
  // URL only, so a late live generate still uses Date.now() for pregame,
  // still runs PM, and still writes the ledger unless OMEGA_REPLAY_NO_WRITE.
  const replayLike = !!(opts.historicalSnapshot || opts.replay);
  const nowMs = now.getTime();
  const oddsSnapshot = resolveGenerateOddsSnapshot(dateISO, { ...opts, nowMs });
  const allowPaidOdds = opts.allowPaidOdds === true;

  console.log(`[omega-vnext] START ${MODEL_VERSION} date=${dateISO} force=${force} sim=${simMode} shadow=${shadow} oddsSnapshot=${oddsSnapshot || 'live'} replay=${replayLike} storedBoard=${!allowPaidOdds}`);

  // Live scheduled runs only. Manual, dry, replay, shadow, and sim do not wait.
  // Timeout returns ready:false and the card still builds from the stored board.
  let captureGate = null;
  try {
    captureGate = await awaitLiveCaptureGate({
      scheduled: opts.scheduled === true,
      dryRun,
      replay: replayLike,
      historicalSnapshot: opts.historicalSnapshot,
      shadow,
      simMode,
      dateISO,
      read: opts.read,
      readPinnacleLineMoves: opts.readPinnacleLineMoves,
      sleep: opts.sleep,
      now: opts.now,
      maxWaitMs: opts.maxWaitMs,
      pollMs: opts.pollMs,
      sportsForCard: opts.sportsForCard,
      env: opts.env,
    });
  } catch (err) {
    console.warn(`[omega-vnext] capture gate soft-fail: ${err && err.message}`);
    captureGate = { ready: false, waitedMs: 0, polls: 0, reason: 'timeout' };
  }

  const fetched = await ingest(dateISO, {
    historicalSnapshot: allowPaidOdds ? oddsSnapshot : null,
    storedBoardOnly: !allowPaidOdds,
    readPinnacleLineMoves: opts.readPinnacleLineMoves,
  });
  const snap = applyUnresolvedSkip(fetched);
  const servedSnapshot = (snap && snap.oddsSnapshotTimestamp) || null;
  console.log(`[omega-vnext] odds snapshot requested=${oddsSnapshot || 'live'} served=${servedSnapshot || 'unknown'}`);
  console.log(`[omega-vnext] ingest sports=${Object.keys(snap.oddsBySport || {}).join(',')}`);
  if (snap && snap.oddsBySport && oddsSnapshot && snap.storedSnapshot !== true && allowPaidOdds) {
    try {
      snap.oddsBySport = await retryMissingDraftKings(snap.oddsBySport, {
        dryRun,
        replay: replayLike,
        apiKey: process.env.ODDS_API_KEY,
      });
    } catch (e) {
      console.error(`[omega-vnext] dk-retry soft-fail: ${e.message}`);
    }
  }
  console.log(formatSkipLog(snap.unresolvedSkipped, snap.neutralSiteCounts));

  // X injury/roster hook. No token → documented stub, no fetch. The card
  // stores mode and count only. Tweet text is logged, never priced.
  let xNewsMeta = { mode: 'stub', count: 0 };
  try {
    const xNews = await fetchXNews({ dateISO });
    xNewsMeta = { mode: xNews.mode || 'stub', count: Number(xNews.count) || 0 };
    console.log(`[omega-vnext] x-news mode=${xNewsMeta.mode} count=${xNewsMeta.count}`);
  } catch (e) {
    xNewsMeta = { mode: 'error', count: 0 };
    console.error(`[omega-vnext] x-news soft-fail: ${e.message}`);
  }

  // Stamp generate-time lateNews before calibration. calibrateAll still
  // takes { cardDate } for modes B and C and spreads lateNews through.
  let candidates = projectAll(snap, dateISO);
  candidates = stampCandidates(candidates, snap);
  const rawBySport = {};
  for (const c of candidates) {
    const s = c && c.sport;
    if (!s) continue;
    rawBySport[s] = (rawBySport[s] || 0) + 1;
  }
  console.log(`[omega-vnext] raw candidates=${candidates.length}`);

  const unmatchedReport = buildUnmatchedReport(dateISO, snap.oddsBySport, now.toISOString());
  if (unmatchedReport.count) {
    const listed = ['NFL', 'NCAAF', 'MLB', 'NHL', 'NBA'].flatMap((s) => unmatchedReport.bySport[s] || []);
    console.warn(`[omega-vnext] unknown_team count=${unmatchedReport.count} names=${listed.join(' | ')}`);
  } else {
    console.log('[omega-vnext] unknown_team count=0');
  }

  // cardDate picks the prior-date record for OMEGA_CAL_MODE B and C.
  // Legacy and A do not read it. Gates, floors, Kelly, and unit caps are unchanged.
  console.log(`[omega-vnext] cal-mode=${resolveCalMode()} cardDate=${dateISO}`);
  candidates = calibrateAll(candidates, { cardDate: dateISO }).map(attachEv);
  candidates = annotateMajorBooks(candidates, snap);

  // Open→pick line move. The steam gate uses the 10:00 Pinnacle print
  // against the 3:00 baseline. A stored opener is the baseline only when
  // the 3:00 capture is absent. Retired 06:00/07:30/09:00/09:15 snaps are
  // ignored. A missing 3:00 or 10:00 is logged and is not filled from a
  // stale morning snap. Capture health does not require those retired slots.
  // Does not invent snaps, does not pull the Odds API, and does not force-fill leans.
  let morningPath = { path: null, earliest: null, latest: null };
  try {
    const loaded = await loadLinePath(dateISO);
    if (loaded) morningPath = loaded;
  } catch (e) {
    console.error(`[omega-vnext] line-move load failed: ${e.message}`);
  }
  let lineMoveDocForSelection = null;
  let lineMoveDocLoaded = Object.prototype.hasOwnProperty.call(opts, 'lineMoveDoc') || !!replayLike;
  if (Object.prototype.hasOwnProperty.call(opts, 'lineMoveDoc')) {
    lineMoveDocForSelection = opts.lineMoveDoc;
  } else if (!replayLike) {
    try {
      lineMoveDocForSelection = await readPinnacleLineMoves(dateISO);
      lineMoveDocLoaded = true;
    } catch (e) {
      console.error(`[omega-vnext] pinnacle line-move read soft-fail: ${e.message}`);
      lineMoveDocLoaded = true;
    }
  }
  let linePathMeta = linePathForSelection(morningPath, lineMoveDocForSelection, { dateISO });

  // Capture health requires the 3:00 and 10:00 ET pulls written by
  // capture-omega-pinnacle-lines (checks 0300/1000, or odds-master
  // baseline-0300 / check-0300 / check-1000). Retired 0600/0730/0900/0915
  // snaps are not required. Their absence does not warn. A missing 0300
  // or 1000 warns and does not block the card. Do not pull the Odds API
  // to fill a slot.
  let captureHealth = assessPullCaptureHealth(dateISO, {
    pinnacleDoc: lineMoveDocForSelection,
    linePath: linePathMeta,
  });

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

  // A missing 3:00 or 10:00 pull is a warning. It is not re-pulled.
  // The card always publishes. Zero usable pulls do not hard-fail.
  if (captureHealth.hardFail) {
    console.warn(JSON.stringify({
      event: 'captureHealthWarning',
      code: 'CAPTURE_HEALTH',
      date: dateISO,
      note: 'missing 3:00/10:00 pulls do not block the card',
      missingSlotsET: captureHealth.missingSlotsET,
      usableSnapCount: captureHealth.usableSnapCount,
    }));
    captureHealth = warnCaptureHealth(captureHealth, dateISO);
  }

  if (linePathMeta.earliest) {
    candidates = annotateLineMoves(candidates, linePathMeta.earliest, linePathMeta.latest || linePathMeta.earliest);
    const withOpen = candidates.filter(c => c.openPrint).length;
    const openSlot = linePathMeta.earliest.hhmm || linePathMeta.earliest.slot;
    const latestSlot = (linePathMeta.latest && (linePathMeta.latest.hhmm || linePathMeta.latest.slot)) || 'n/a';
    console.log(`[omega-vnext] line-move source=${linePathMeta.source || 'path'} open=${openSlot} latest=${latestSlot} annotated=${withOpen}/${candidates.length}`);
  } else {
    console.log(`[omega-vnext] line-move: no latest snapshot for ${dateISO}`);
  }

  const healthLog = { event: 'captureHealth', date: dateISO, shadow: !!shadow, ...captureHealth };
  if (captureHealth.warning || captureHealth.hardFail) console.warn(JSON.stringify(healthLog));
  else console.log(JSON.stringify(healthLog));

  // Ops-only signal: persist snapshot + optional HTTP callback. Does NOT change hardFail policy.
  if (!replayLike && !shadow && !dryRun) {
    try {
      const opsHealth = captureGate
        ? Object.assign({}, captureHealth, { captureGate })
        : captureHealth;
      await emitCaptureHealthOps(dateISO, opsHealth, { shadow: !!shadow });
    } catch (e) {
      console.warn(JSON.stringify({ event: 'captureHealthOpsSoftFail', date: dateISO, error: e.message }));
    }
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

  // DraftKings execution price. No DK line drops the candidate. The next
  // DK-priced side stays in the pool (backfill). Synthetic rows with no
  // bookPrices ladder are unchanged. EV is recomputed at the DK price.
  const execution = applyExecutionBook(candidates);
  candidates = execution.candidates;
  const dkExcluded = execution.excluded || [];
  if (dkExcluded.length) {
    console.log(`[omega-vnext] no-draftkings-line excluded=${dkExcluded.length}`);
  }

  // Blend-weight shift from the 3:00 and 10:00 captures. One adjusted
  // probability feeds edge, stake EV, and the letter grade. A missing
  // slot logs and adjusts 0. DraftKings lag does not stack on top.
  candidates = applyLineMoveProb(candidates, linePathMeta);
  const moved = candidates.filter((c) => c && Number(c.movementAdj) !== 0).length;
  const droppedMove = candidates.filter((c) => c && c.movementDrop).length;
  console.log(`[omega-vnext] line-move-prob adjusted=${moved} drop=${droppedMove}/${candidates.length}`);

  // Stale DraftKings vs the 10:00 one-book no-vig. When movement already
  // adjusted the row, this stamps features and does not rewrite edge.
  // Floors, caps, Kelly, and the lean fill run on the stamped row.
  candidates = applyDkLag(candidates, {
    linePath: linePathMeta && linePathMeta.path,
    opener: linePathMeta && linePathMeta.earliest,
  });
  const lagFired = candidates.filter((c) => c && c.lagEdge != null && c.lagEdge > 0).length;
  console.log(`[omega-vnext] dk-lag fired=${lagFired}/${candidates.length}`);

  // Published edge and EV are the pure sport-model probability at the bet price.
  // edge = p_model − implied(price). EV = p_model × decimal − 1.
  // The blend, the shrink, line-move, DK lag, and the Pinnacle fair do not enter.
  // Pinnacle stays on the row for CLV only. A missing model probability drops.
  candidates = applyPureModel(candidates);
  const purePriced = candidates.filter((c) => c && c.pureModelPriced).length;
  const pureMissing = candidates.filter((c) => c && c.pureModelMissing).length;
  console.log(`[omega-vnext] pure-model version=${PURE_MODEL_VERSION} priced=${purePriced} missing=${pureMissing}`);

  // A sport past 3× its margin limit is off this run. The stamp is the gate.
  // Health still records the alert. The sport does not fill a short card.
  const bannedSports = extremeMarginSports(candidates);
  if (bannedSports.length) {
    console.log(`[omega-vnext] bias-margin-extreme off-card sports=${bannedSports.join(',')}`);
  }
  const bannedSportSet = new Set(bannedSports);
  candidates = candidates.map((c) => (
    c && bannedSportSet.has(c.sport) ? { ...c, marginBiasExtreme: true } : c
  ));

  // Historical replay: pregame is vs the snapshot instant, not wall-clock now.
  // Live generate leaves asOf unset (Date.now() + 5-minute grace unchanged).
  // pregameAsOfMs is a clock only. It does not flip replayLike or the odds URL.
  const gateOpts = { cardDate: dateISO };
  if (replayLike) {
    const asOfMs = Date.parse(opts.historicalSnapshot);
    if (Number.isFinite(asOfMs)) gateOpts.asOfMs = asOfMs;
  }
  if (Number.isFinite(Number(opts.pregameAsOfMs))) {
    gateOpts.asOfMs = Number(opts.pregameAsOfMs);
  }
  const { yesPool, leanPool = [], rejected } = applyGates(candidates, gateOpts);
  if (gateOpts.asOfMs != null) {
    console.log(`[omega-vnext] pregame asOf=${new Date(gateOpts.asOfMs).toISOString()}`);
  }
  const placeVeto = rejected.filter(r => r.rejectReason === 'placeability-soft-veto').length;
  // Under 1% stays edge-floor. Those same-line Pinnacle pairs fill a short card.
  const pairedFill = LEAN_PAD
    ? rejected.filter((c) => eligiblePairedFill(c)).map((c) => ({
      ...c,
      tier: 'lean',
      label: 'lean',
      pairedFill: true,
      leanReason: c.leanReason || 'paired-ev',
    }))
    : [];
  console.log(`[omega-vnext] yesPool=${yesPool.length} lean=${leanPool.length} pairedFill=${pairedFill.length} rejected=${rejected.length} placeabilityVeto=${placeVeto}`);
  for (const c of yesPool.concat(leanPool, pairedFill)) {
    if (c) c.hardRockPriced = hasHardRockPrice(c);
  }
  const snapshotCoversQa = tenAmSnapshotCoversChecks(snap);

  const selectedRaw = selectStraights(yesPool, MAX_STRAIGHTS, LEAN_PAD ? leanPool : null, pairedFill);
  const top10Candidates = selectTop10(yesPool, 10);
  // 10:00 rank is probability edge, one game each. Stake EV breaks a tie
  // inside 0.2 percentage points. A parlay
  // leg with no Hard Rock price is swapped or noted. The note and the
  // bug log stay off the page. The card still publishes.
  const placement = ensureParlayPlaceable(
    selectedRaw,
    yesPool.concat(LEAN_PAD ? (leanPool || []) : [], pairedFill),
  );
  const selected = placement.straights;
  let bugLog = placement.bugs.slice();

  // QA hard-fails before narrate/store — drop + refill; empty OK
  let qaCtx = {};
  try {
    const sports = [...new Set(selected.map(c => c.sport).concat(yesPool.slice(0, 12).map(c => c.sport)))];
    qaCtx = await loadQaContext(dateISO, sports);
    console.log(`[omega-vnext] QA context loaded sports=${sports.join(',')}`);
  } catch (e) {
    console.error(`[omega-vnext] QA context load failed (continuing): ${e.message}`);
  }

  let drawdown = false;
  try {
    const grades = await gradedResultsForDrawdown(opts, dryRun, replayLike);
    drawdown = drawdownActive(grades);
  } catch (err) {
    console.error(`[omega-vnext] drawdown soft-fail: ${err && err.message}`);
    drawdown = false;
  }
  const qa = applyHardFails(selected, yesPool, qaCtx, {
    maxN: MAX_STRAIGHTS,
    modelVersion: MODEL_VERSION,
    leanPool: LEAN_PAD ? leanPool : null,
    pairedPool: pairedFill,
    drawdown,
  });
  let picks = qa.picks;
  const hardFails = qa.hardFails || [];
  if (hardFails.length) {
    console.log(`[omega-vnext] QA hard-fails=${hardFails.length}: ${hardFails.map(h => h.reason).join('; ')}`);
  }
  // Provisional straight-only trim; final 3.5u straights + 0.5u parlay (≤4.0u).
  picks = applyDailyCap(picks);

  // The parlay is always 3 legs at 0.25u from the best EV on distinct
  // games. A ticket whose combined EV is not positive is labeled and
  // still published. Fewer than 3 priced games is the only miss.
  let parlayPool = [].concat(yesPool || [], LEAN_PAD ? (leanPool || []) : [], pairedFill);
  const straightParlay = (rows, note) => parlayFromStraights(rows, {
    hrPlaceabilityNote: note || placement.note,
    pool: parlayPool,
  });
  let parlayLegs = straightParlay(picks);

  // The page calls this the posted line. A DraftKings number that has
  // moved, and a row already flagged against Pinnacle, does not publish.
  // Replay keeps the historical ticket. A missed scoreboard does not
  // invent a hold.
  let postedQuotes = [];
  if (!replayLike && !dryRun && picks.length) {
    try {
      const sports = [...new Set(picks.map((p) => p.sport).filter(Boolean))];
      postedQuotes = await fetchPostedQuotes(dateISO, sports);
      console.log(`[omega-vnext] posted quotes=${postedQuotes.length}`);
    } catch (err) {
      console.error(`[omega-vnext] posted-line check failed: ${err && err.message}`);
      postedQuotes = [];
    }
  }
  const spreadStale = postedQuotes.length
    ? gamesWithoutCurrentSpread(candidates, postedQuotes)
    : new Set();
  const holdOf = (row) => {
    if (replayLike || !row) return null;
    const market = String((row && (row.market || row.betType)) || '');
    if (/moneyline/i.test(market) && spreadStale.has(gameKey(row))) return 'line-moved';
    if (postedQuotes.length) {
      const moved = holdReason({ ...row, dataReviewFlag: null }, postedQuotes);
      if (moved) return moved;
    }
    if ((row.dataReviewFlag && row.dataReviewFlag.flagged) || reviewFlag(row)) return 'pinnacle-sanity';
    return null;
  };
  const keepPublishable = (list) => (list || []).filter((row) => !holdOf(row));
  parlayPool = keepPublishable(parlayPool);
  if (!replayLike) {
    const kept = [];
    for (const pick of picks) {
      const reason = holdOf(pick);
      if (reason) console.log(`[omega-vnext] hold ${reason} ${pick.sport || ''} ${pick.pick || pick.side || ''}`);
      else kept.push(pick);
    }
    if (kept.length !== picks.length) {
      picks = kept;
      parlayLegs = straightParlay(picks);
    }
  }

  let narr = { picks, parlayLegs, rejections: [], edgeSummary: '', insights: '', claudeVerified: false };
  if (!skipNarrate) {
    narr = await narrateAndVerify({
      picks,
      parlayLegs,
      dateFormatted,
      apiKey: process.env.XAI_API_KEY,
    });
    picks = narr.picks;
    if (narr.rejections && narr.rejections.length) {
      console.log(`[omega-vnext] narrate rejections=${narr.rejections.length} — reserve top-up runs after the cap`);
    }
    parlayLegs = straightParlay(picks);
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
  // Narrate and hard-fail can leave the card short. Refill from the private
  // reserve only. A full card keeps the parlay generate already priced.
  const topUpBlocked = require('./card_integrity').blockedRowsFor({
    qaHardFails: (hardFails || []).map((r) => (r && typeof r === 'object' ? { hardFail: true, ...r } : r)),
    rejections: (narr && narr.rejections) || [],
  });
  const reserved = applyGenerateReserve({
    picks,
    yesPool: keepPublishable(yesPool),
    leanPool: LEAN_PAD ? keepPublishable(leanPool) : [],
    pairedPool: keepPublishable(pairedFill),
    blocked: topUpBlocked,
    parlayPool,
    hrNote: placement.note,
    modelVersion: MODEL_VERSION,
  });
  let cardReserve = reserved.reserve;
  let generateTopUps = reserved.topUps || [];
  if (reserved.rebuilt) {
    picks = reserved.picks;
    parlayLegs = reserved.parlayLegs;
    picks = attachClvFields(picks, MODEL_VERSION, dateISO);
    parlayLegs = attachClvToParlay(parlayLegs, MODEL_VERSION, dateISO);
    if (generateTopUps.length) {
      console.log(`[omega-vnext] reserve top-up=${generateTopUps.length}: ${generateTopUps.map((t) => t.pick).join(', ')}`);
    }
  }
  picks = sortByGradeThenUnits(picks);

  // A publishable lean, including a same-line fill under 1%, is the card.
  // Do not fall through to "No Qualifying Plays" while one remains.
  let openLeans = [];
  let openPaired = [];
  if (picks.length === 0 && LEAN_PAD) {
    const blocked = new Set([
      ...(hardFails || []).map((h) => `${h.matchup}|${h.side || h.pick}`),
      ...((narr && narr.rejections) || []).map((r) => `${r.matchup}|${r.side || r.pick}`),
    ]);
    const blockedSide = (c) => blocked.has(`${c.matchup}|${c.side}`);
    openLeans = keepPublishable(leanPool).filter((c) => qualifiesAsLean(c) && !blockedSide(c));
    openPaired = keepPublishable(pairedFill).filter((c) => !blockedSide(c));
    if (openLeans.length || openPaired.length) {
      const rescued = selectStraights([], MAX_STRAIGHTS, openLeans, openPaired);
      if (rescued.length) {
        const leanPlace = ensureParlayPlaceable(rescued, yesPool.concat(openLeans, openPaired));
        if (leanPlace.bugs.length) bugLog = bugLog.concat(leanPlace.bugs);
        picks = leanPlace.straights.map((c) => toPickObject(c, { modelVersion: MODEL_VERSION }));
        parlayLegs = straightParlay(picks, leanPlace.note || placement.note);
        const recap = applyDailyUnitCap(picks, parlayLegs);
        picks = sortByGradeThenUnits(recap.picks);
        parlayLegs = recap.parlayLegs;
        console.log(`[omega-vnext] lean rescue picks=${picks.length}`);
      }
    }
  }

  if (!replayLike) {
    const finalKept = [];
    for (const pick of picks) {
      const reason = holdOf(pick);
      if (reason) console.log(`[omega-vnext] hold-final ${reason} ${pick.sport || ''} ${pick.pick || pick.side || ''}`);
      else finalKept.push(pick);
    }
    if (finalKept.length !== picks.length) {
      picks = finalKept;
      parlayLegs = picks.length ? straightParlay(picks) : [];
      if (!picks.length) {
        narr.edgeSummary = "WeBetAI went through today's board and did not lock a side. A price that is no longer the posted number does not get a stake. Forcing a pick would turn a pass into a guess.";
        narr.insights = 'Nothing made the card. The DraftKings number has moved off the price on the morning board, so the morning side is not a live bet.';
      }
    }
  }

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
    fair_sharp_p: c.fair_sharp_p != null ? c.fair_sharp_p : null,
    p_model: c.p_model != null ? c.p_model : null,
    line: c.line != null ? c.line : null,
    homeTeam: c.homeTeam || null,
    awayTeam: c.awayTeam || null,
    uncertainty: c.uncertainty != null ? c.uncertainty : null,
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
    book: c.book || null,
    hrFlags: c.hrFlags || null,
    lagEdge: c.lagEdge != null ? c.lagEdge : null,
    pinMove: c.pinMove != null ? c.pinMove : null,
    dkMove: c.dkMove != null ? c.dkMove : null,
    ...footballAuditFields(c),
    ...restAuditFields(c),
    selected: picks.some(p => {
      const labeled = formatMoneylinePick(c.side, c.market);
      return (p.pick === c.side || p.pick === labeled) && p.matchup === c.matchup;
    }),
  }));

  const rejectionLog = buildRejectionLog(hardFails, narr.rejections, rejected);
  const rejections = rejectionLog.rows;
  const rejectionCounts = rejectionLog.rejectionCounts;

  const empty = picks.length === 0;
  const publishedParlay = empty ? [] : (parlayLegs || []);
  const stakeDisplay = summaryStakeDisplay(picks, publishedParlay);
  logReviewFlags(picks, publishedParlay);
  const picksData = {
    date: dateISO,
    dateFormatted,
    model: MODEL_VERSION,
    picks,
    rejections,
    rejectionCounts,
    edgeSummary: narr.edgeSummary || '',
    insights: narr.insights || '',
    summary: {
      totalPicks: picks.length,
      totalStraightBets: picks.length,
      totalUnits: stakeDisplay.totalUnits,
      totalDollars: stakeDisplay.totalDollars,
      aplusLocks: picks.filter(p => p.rating === 'aplus').length,
      sportsCovered,
      modelVersion: MODEL_VERSION,
      qaHardFails: hardFails.length,
      cardLabel: straightCardLabel(picks),
      ...(generateTopUps.length ? { topUps: generateTopUps } : {}),
    },
    generatedAt: now.toISOString(),
    publishAt: (() => {
      try { return etLocalToUtcISO(dateISO, 11, 0); }
      catch (_) { return null; }
    })(),
    bugLog,
    parlayLegs: publishedParlay,
    // Private. publicPicksPayload drops this. Flag does not change the pool.
    gapReview: buildGapReview(candidates, picks, publishedParlay),
    // Private. Counts and the next 10 candidates when the card is short of
    // 3 straights or a 3-leg. Does not add a pick. publicPicksPayload drops it.
    shortfall: buildShortfall({
      picks,
      parlayLegs: publishedParlay,
      yesPool,
      rejected,
    }),
    // Private. Next-best straights not on the card, selectStraights order.
    // publicPicksPayload drops reserve. It does not change selection.
    reserve: cardReserve,
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
    priceLock: {
      requested: oddsSnapshot || null,
      servedAt: servedSnapshot,
      note: (snap && snap.snapshotNote) || null,
      replay: replayLike,
    },
    gateCounts: {
      yes: yesPool.length,
      floor: yesPool.length,
      lean: leanPool.length,
      rejected: rejected.length,
      edgeFloor: rejected.filter((r) => r && r.rejectReason === 'edge-floor').length,
      evStale: rejected.filter((r) => r && r.rejectReason === 'ev-stale').length,
      parlayEligible: empty ? 0 : ((parlayLegs[0] && parlayLegs[0].legs && parlayLegs[0].legs.length) || 0),
    },
    pmSoft: pmSoftMeta,
    teamIdentity: {
      unmatched: unmatchedReport.bySport,
      unmatchedCount: unmatchedReport.count,
    },
    // Private. publicPicksPayload drops selection. Top 10 is the 10:00
    // Edge rank, one game each. rerank-picks-omega at 10:15 refreshes news
    // and may replace a main from this priced pool. It does not pull odds.
    selection: {
      snapshotTime: servedSnapshot || oddsSnapshot || null,
      cardLabel: straightCardLabel(picks),
      rankedBy: 'edge',
      onePerGame: true,
      window: '10:00-10:15',
      rerankWindow: '10:15-10:30',
      top10: recordRankedList(picks, top10Rows(top10Candidates, 10)),
      snapshotCoversHardRock: snapshotCoversQa,
      snapshotCoversParlay: snapshotCoversQa,
      hrCoverage: top10Candidates.map((c) => ({
        matchup: c.matchup || null,
        market: c.market || null,
        side: c.side || null,
        hardRock: hasHardRockPrice(c),
      })),
      excludedGames: excludedGames([
        ...dkExcluded.map((c) => ({ ...c, rejectReason: c.excludeReason || 'no-draftkings-line' })),
        ...rejected,
      ]),
      xNews: xNewsMeta,
      starterFeed: cardStarterFeed(snap),
    },
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
  if (empty && shouldPublishNoPlays(picks, openLeans.concat(openPaired))) {
    // "No Qualifying Plays Today" card (lib/no-plays). Only a COMPLETED run gets here.
    // A publishable positive-EV lean never takes this branch.
    const slateCounts = slateCountsFor(snap, dateISO);
    if (!shadow && !dryRun && slateCounts.odds === 0 && slateCounts.espn > 0) {
      // Games on ESPN but no odds for any sport = feed failure, not a pass. Write nothing so
      // the previous card stays up until a real run completes.
      const err = new Error(`odds feed empty with ${slateCounts.espn} ESPN game(s) — not storing an empty card`);
      err.code = 'FEED_DOWN';
      throw err;
    }
    Object.assign(picksData, noPlaysFields(omegaReason({
      counts: slateCounts.bySport, dateISO, hardFails: hardFails.length,
    }), { noGames: slateCounts.total === 0 }));
    picksData.edgeSummary = picksData.noPlaysReason;
    picksData.insights = picksData.insights || '';
  } else if (empty) {
    console.error('[omega-vnext] positive-EV lean exists — not publishing No Qualifying Plays');
  }

  try {
    const audit = buildCardAudit({ snap, modelVersion: MODEL_VERSION });
    if (audit) picksData.audit = audit;
  } catch (err) {
    console.error(`[omega-vnext] card audit soft-fail: ${err && err.message}`);
  }
  try { attachAuditSummary(picksData, auditLog); }
  catch (err) { console.error(`[omega-audit] card summary soft-fail: ${err && err.message}`); }

  // Pinnacle line-move context. After picks, parlays, and Kelly are done.
  // Does not replace picksData.picks. A missing blob leaves the card as it was.
  try {
    const lineMoveDoc = lineMoveDocLoaded
      ? lineMoveDocForSelection
      : await readPinnacleLineMoves(dateISO);
    const pools = [].concat(yesPool || [], leanPool || [], rejected || []);
    const applied = applyLineMoveContext({
      picks: picksData.picks,
      parlayLegs: picksData.parlayLegs,
      candidates: pools,
      audit: picksData.audit || null,
      doc: lineMoveDoc,
      dateISO,
    });
    if (lineMoveDoc && applied.audit) picksData.audit = applied.audit;
    if (lineMoveDoc && applied.candidates) {
      for (let i = 0; i < pools.length; i += 1) {
        const summary = applied.candidates[i] && applied.candidates[i].lineMoveContext;
        if (summary && pools[i]) pools[i].lineMoveContext = summary;
      }
    }
  } catch (err) {
    console.error(`[omega-vnext] pinnacle line-move context soft-fail: ${err && err.message}`);
  }

  // Health is diagnostic. A failure here must not change picks or skip the store.
  let healthRecord = null;
  try {
    healthRecord = attachGenerateHealth(picksData, {
      dateISO,
      snap,
      rawBySport,
      candidates: candidates.slice(),
      yesPool: yesPool.slice(),
      oddsErrors: (snap && snap.oddsErrors) || [],
      shortfall: picksData.shortfall || null,
    });
  } catch (e) {
    console.warn(`[omega-health] attach soft-fail: ${e.message}`);
  }
  if (captureGate) {
    if (healthRecord && typeof healthRecord === 'object') healthRecord.captureGate = captureGate;
    if (!picksData.health || typeof picksData.health !== 'object') picksData.health = {};
    picksData.health.captureGate = captureGate;
  }
  if (healthRecord) {
    const skipHealthWrite = dryRun || replayLike || process.env.OMEGA_REPLAY_NO_WRITE === '1';
    let healthStored = false;
    if (!skipHealthWrite) {
      try {
        const stored = await storeHealthRecord(dateISO, healthRecord);
        healthStored = true;
        console.log(`[omega-health] stored key=${stored.key}`);
      } catch (e) {
        console.error(`[omega-health] store soft-fail: ${e.message}`);
      }
    }
    console.log(JSON.stringify({
      event: 'omegaHealth',
      date: dateISO,
      status: healthRecord.status,
      alerts: (healthRecord.alerts || []).length,
      stored: healthStored,
    }));
    for (const alert of healthRecord.alerts || []) {
      console.warn(`[omega-health] ALERT ${alert.sport || ''} ${alert.code} ${alert.detail || ''}`);
    }
  }

  // Private unmatched-name blob. dryRun does not write. Not a public card field.
  if (!dryRun) {
    try {
      const stored = await persistUnmatchedReport({ dryRun: false, dateISO, report: unmatchedReport });
      console.log(`[omega-vnext] unmatched key=${stored.key} count=${unmatchedReport.count}`);
    } catch (e) {
      console.error(`[omega-vnext] unmatched store soft-fail: ${e.message}`);
    }
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

  // Private full-candidate ledger. Live generate only. Not a card field:
  // this does not assign onto picksData, picks, or parlayLegs.
  try {
    const ledger = await persistCandidateLedger({
      dateISO,
      generatedAt: picksData.generatedAt,
      yesPool,
      leanPool,
      rejected,
      picks: picksData.picks,
      parlayLegs: picksData.parlayLegs,
      oddsBySport: snap && snap.oddsBySport,
      picksData,
      dryRun,
      shadow,
      simMode,
      replay: !!replayLike,
      historicalSnapshot: opts.historicalSnapshot || null,
    });
    if (ledger && ledger.wrote) {
      console.log(`[omega-vnext] candidate ledger key=${ledger.key} n=${ledger.count}`);
    }
  } catch (e) {
    console.error(`[omega-vnext] candidate ledger soft-fail: ${e.message}`);
  }

  try { attachAuditSummary(picksData, auditLog); }
  catch (err) { console.error(`[omega-audit] card summary soft-fail: ${err && err.message}`); }
  console.log(`[omega-vnext] DONE picks=${picks.length} parlay=${(picksData.parlayLegs || []).length} hardFails=${hardFails.length}`);
  picksData.cardStatus = 'draft';
  picksData.finalized = false;
  picksData.timelineStep = '10:00';
  if (!picksData.selection || typeof picksData.selection !== 'object') picksData.selection = {};
  picksData.selection.stage = picksData.selection.stage || 'top10';
  return picksData;
  } finally {
    if (auditLog) {
      try {
        await persistAuditLog(auditLog, { dryRun: !!opts.dryRun || replayNoWrite() });
      } catch (err) {
        console.error(`[omega-audit] persist soft-fail: ${err && err.message}`);
      }
    }
  }
}

/**
 * Logging only. Fields the candidate close pass needs from a stored rejection.
 * Selection, floors, and ranking do not read them.
 */
function rejectionAuditFields(r) {
  if (!r || typeof r !== 'object') return {};
  const out = {};
  for (const k of ['market', 'line', 'odds', 'fair_sharp_p', 'coverProb', 'ev', 'commenceTime', 'predictedClv', 'uncertainty', 'homeTeam', 'awayTeam', 'book', 'p_model']) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  const edge = r.edge != null ? r.edge : r.edgePct;
  if (edge !== undefined) out.edge = edge;
  return out;
}

/** Stored rejection rows per sport. Counts below include every rejection. */
const REJECTION_PER_SPORT_CAP = 25;

/**
 * Logging only. Keeps up to `cap` rows per sport in first-seen order.
 * bySportReason counts every input row, including rows the cap does not store.
 * Selection, floors, and ranking do not read this.
 */
function sampleRejectionsBySport(rows, cap = REJECTION_PER_SPORT_CAP) {
  const limit = Number.isFinite(cap) && cap >= 0 ? cap : REJECTION_PER_SPORT_CAP;
  const bySportReason = {};
  const kept = {};
  const stored = [];
  for (const r of rows || []) {
    const sport = r && r.sport ? String(r.sport) : 'unknown';
    const reason = (r && (r.reason || r.rejectReason)) || 'gate';
    if (!bySportReason[sport]) bySportReason[sport] = {};
    bySportReason[sport][reason] = (bySportReason[sport][reason] || 0) + 1;
    if (kept[sport] == null) kept[sport] = 0;
    if (kept[sport] < limit) {
      const row = { sport, matchup: r.matchup, side: r.side, reason, ...rejectionAuditFields(r), ...footballAuditFields(r), ...restAuditFields(r) };
      if (r && r.hardFail) row.hardFail = true;
      stored.push(row);
      kept[sport] += 1;
    }
  }
  return {
    rows: stored,
    rejectionCounts: {
      bySportReason,
      total: (rows || []).length,
      stored: stored.length,
      perSportCap: limit,
    },
  };
}

function buildRejectionLog(hardFails, narrRejections, rejected) {
  const rows = [];
  for (const h of hardFails || []) {
    rows.push({
      sport: h.sport || 'unknown',
      matchup: h.matchup,
      side: h.side,
      reason: `QA_HARDFAIL: ${h.reason}`,
      hardFail: true,
    });
  }
  for (const n of narrRejections || []) {
    const row = {
      sport: n.sport || 'unknown',
      matchup: n.matchup,
      side: n.side,
      reason: n.reason || 'narrate',
      ...rejectionAuditFields(n),
    };
    if (n.hardFail) row.hardFail = true;
    rows.push(row);
  }
  for (const r of rejected || []) {
    const row = {
      sport: r.sport || 'unknown',
      matchup: r.matchup,
      side: r.side,
      reason: r.rejectReason || r.reason || 'gate',
      ...rejectionAuditFields(r),
      ...footballAuditFields(r),
      ...restAuditFields(r),
    };
    if (r.hardFail) row.hardFail = true;
    rows.push(row);
  }
  return sampleRejectionsBySport(rows, REJECTION_PER_SPORT_CAP);
}

module.exports = {
  generateOmegaVnext,
  MODEL_VERSION,
  projectAll,
  slateCountsFor,
  sportsOnCard,
  todayET,
  assessCaptureHealth,
  sampleRejectionsBySport,
  buildRejectionLog,
  rejectionAuditFields,
  REJECTION_PER_SPORT_CAP,
};
