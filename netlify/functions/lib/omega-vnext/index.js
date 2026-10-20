'use strict';

const {
  MODEL_VERSION, MODEL_NOTES, SPORTS_ENABLED, MAX_STRAIGHTS, LINE_MOVE, PM_SOFT,
  nbaCardEnabled,
} = require('./config');
const { ingest } = require('./ingest');
const { noPlaysFields, omegaReason } = require('../no-plays');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { selectStraights, applyDailyUnitCap, applyExposureCaps, prepareEdgePositions, splitRawMiscalibrated, sortByGradeThenUnits, orderedByScore, formatMoneylinePick, samePublished } = require('./select');
const { publishEdgeCard, summaryFrom, dedupeRejections } = require('./assemble');
const { syncLegsToPublishedStraights } = require('./parlay');
const { narrateAndVerify, narrateParlayLegsOnly, alignEdgeSummary } = require('./narrate');
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

/** Same-day games per sport for the no-plays reason (ESPN first, odds as fallback). */
function slateCountsFor(snap) {
  const bySport = {};
  let espn = 0, odds = 0;
  for (const s of ['MLB', 'NFL', 'NCAAF']) {
    if (!SPORTS_ENABLED[s]) { bySport[s] = 0; continue; }
    const e = snap && snap.espnBySport && snap.espnBySport[s] && Array.isArray(snap.espnBySport[s].games)
      ? snap.espnBySport[s].games.length : 0;
    const o = snap && snap.oddsBySport && Array.isArray(snap.oddsBySport[s]) ? snap.oddsBySport[s].length : 0;
    espn += e; odds += o;
    bySport[s] = e || o;
  }
  return { bySport, espn, odds, total: Object.values(bySport).reduce((a, b) => a + b, 0) };
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
  // Preseason stays off the card. OMEGA_NBA=0 skips the board. The shadow
  // observer is a different module and is not called here.
  if (nbaCardEnabled()) {
    raw.push(...nba.project({
      oddsEvents: (snap.oddsBySport && snap.oddsBySport.NBA) || [],
      standings: (snap.standingsBySport && snap.standingsBySport.NBA) || {},
      gameDay,
      forCard: true,
    }).filter((c) => c && c.shadowOnly !== true && !c.preseason));
  }
  if (SPORTS_ENABLED.NHL) {
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
  const fixtureCandidates = Array.isArray(opts.fixtureCandidates) ? opts.fixtureCandidates : null;
  const replayLike = !!(opts.historicalSnapshot || opts.replay || fixtureCandidates);

  console.log(`[omega-vnext] START ${MODEL_VERSION} date=${dateISO} force=${force} sim=${simMode} shadow=${shadow}`);

  // Stored 3AM/10AM board (Ben 2026-10-18: only those two pulls). Live
  // generates read the odds-master 1000 board with all books; historical
  // replay keeps its snapshot path. No live Odds API call in generate.
  // fixtureCandidates is a local card replay: no board, no odds, no ESPN.
  let masterBoard = null;
  if (!opts.historicalSnapshot && !opts.replay && !fixtureCandidates) {
    try {
      const { loadMasterBoard } = require('../odds-master/board');
      masterBoard = await loadMasterBoard(dateISO);
    } catch (e) { console.error(`[omega-vnext] odds-master board load failed: ${e.message}`); }
  }
  const storedOddsBySport = masterBoard && Object.keys(masterBoard.eventsBySport || {}).length
    ? Object.fromEntries(Object.entries(masterBoard.eventsBySport).map(([k, v]) => [k, v.map(ev => ({ ...ev, sport_key: (require('./config').ODDS_SPORT_KEYS || {})[k] || ev.sport_key }))]))
    : null;
  let snap;
  let candidates;
  let preMiscalibrated = [];
  if (fixtureCandidates) {
    snap = { dateISO, oddsBySport: {}, espnBySport: {} };
    candidates = fixtureCandidates.map(c => ({ ...c }));
    console.log(`[omega-vnext] fixture candidates=${candidates.length} (no ingest)`);
  } else {
    snap = await ingest(dateISO, {
      historicalSnapshot: opts.historicalSnapshot,
      storedOddsBySport,
      storedFetchedAt: masterBoard ? (masterBoard.at1000 || masterBoard.at0300) : null,
    });
    console.log(`[omega-vnext] ingest sports=${Object.keys(snap.oddsBySport || {}).join(',')}`);

    candidates = projectAll(snap);
    console.log(`[omega-vnext] raw candidates=${candidates.length}`);

    // Raw modelRawP vs fair above 10pp is miscalibration before shrink can hide it.
    const rawSplit = splitRawMiscalibrated(candidates);
    preMiscalibrated = rawSplit.miscalibrated;
    candidates = rawSplit.candidates;
    console.log(`[omega-vnext] pre-calibration miscalibrated=${preMiscalibrated.length}`);
    candidates = calibrateAll(candidates).map(attachEv);
    candidates = annotateMajorBooks(candidates, snap);
  }

  // Open→pick US line-move (earliest morning snap → latest pre-generate).
  // Missing required snaps: one real Odds capture into the current ET slot, then re-load.
  // Zero usable snaps after that hard-fails. Partial snaps warn and continue.
  // Does not invent snaps and does not force-fill leans.
  let linePathMeta = { path: null, earliest: null, latest: null };
  if (masterBoard && masterBoard.polls && masterBoard.polls.length) {
    const polls = masterBoard.polls;
    linePathMeta = { path: { date: dateISO, polls }, earliest: polls[0], latest: polls[polls.length - 1] };
  } else if (!fixtureCandidates) {
    try {
      const loaded = await loadLinePath(dateISO);
      if (loaded) linePathMeta = loaded;
    } catch (e) {
      console.error(`[omega-vnext] line-move load failed: ${e.message}`);
    }
  }

  const requiredSlotsET = (LINE_MOVE && LINE_MOVE.captureSlotsET) || ['0600', '0730', '0900', '0915'];
  let captureHealth = assessCaptureHealth(dateISO, linePathMeta, { requiredSlotsET });
  let retriedCapture = false;
  let retryOk = null;
  // Retry only for snaps that should already exist (9:05 must not treat 9:15 as failed).
  const dueMissing = missingDueSlots(captureHealth.missingSlotsET, now);
  const retrySlot = null; // Ben 2026-10-18: generate never fires a paid capture retry; missing 0300/1000 snaps warn/hard-fail per capture health.
  const _unusedRetrySlot = (replayLike || storedOddsBySport) ? null : canonicalRetrySlot(now, {
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

  // One DK/Hard Rock price per game+market+side. Edges over 10pp are miscalibration.
  const prepared = prepareEdgePositions(candidates);
  candidates = prepared.positions;
  const edgeDiagnostics = {
    miscalibrated: preMiscalibrated.concat((prepared.diagnostics && prepared.diagnostics.miscalibrated) || []),
  };
  console.log(`[omega-vnext] positions=${candidates.length} miscalibrated=${edgeDiagnostics.miscalibrated.length} pre=${preMiscalibrated.length}`);

  // Historical replay: pregame is vs the snapshot instant, not wall-clock now.
  // Live generate leaves asOf unset (Date.now() + 5-minute grace unchanged).
  const gateOpts = { cardDate: dateISO };
  if (Number.isFinite(Number(opts.pregameAsOfMs))) {
    gateOpts.asOfMs = Number(opts.pregameAsOfMs);
  } else if (replayLike) {
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

  // QA hard-fails on gate-clearers. The never-block fill runs after, from DK/Hard Rock prices.
  let qaCtx = {};
  if (!fixtureCandidates) {
    try {
      const sports = [...new Set(selected.map(c => c.sport).concat(yesPool.slice(0, 12).map(c => c.sport)))];
      qaCtx = await loadQaContext(dateISO, sports);
      console.log(`[omega-vnext] QA context loaded sports=${sports.join(',')}`);
    } catch (e) {
      console.error(`[omega-vnext] QA context load failed (continuing): ${e.message}`);
    }
  }

  const qa = applyHardFails(selected, yesPool, qaCtx, {
    maxN: MAX_STRAIGHTS,
    modelVersion: MODEL_VERSION,
  });
  const hardFails = qa.hardFails || [];
  if (hardFails.length) {
    console.log(`[omega-vnext] QA hard-fails=${hardFails.length}: ${hardFails.map(h => h.reason).join('; ')}`);
  }

  const failKey = (matchup, side) => `${String(matchup || '').trim().toLowerCase()}|${String(side || '').trim().toLowerCase()}`;
  const failKeys = new Set(hardFails.map(h => failKey(h.matchup, h.side)));
  const open = (candidates || []).filter(c => !failKeys.has(failKey(c.matchup, c.side)));
  const stillRaw = (qa.picks || []).map(p => (
    open.find(c => samePublished(p, c)) || selected.find(c => samePublished(p, c)) || null
  )).filter(Boolean);

  const publishFrom = (positions, qualified, pool, seed) => publishEdgeCard({
    positions,
    qualified,
    yesPool: pool,
    rejected,
    miscalibrated: edgeDiagnostics.miscalibrated || [],
    hardFails,
    cardDate: dateISO,
    modelVersion: MODEL_VERSION,
    dateFormatted,
    picksSeed: seed,
  });

  let built = publishFrom(open, stillRaw, qa.yesPoolRemaining || yesPool, qa.picks);
  let picks = built.picks;
  let parlayLegs = built.parlayLegs;
  let narrRejections = [];

  let narr = {
    picks,
    parlayLegs,
    rejections: [],
    edgeSummary: built.edgeSummary || '',
    insights: '',
    claudeVerified: false,
  };
  if (!skipNarrate) {
    // Caps already ran inside publishEdgeCard, so narration quotes final units.
    narr = await narrateAndVerify({
      picks,
      parlayLegs,
      dateFormatted,
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    narrRejections = narrRejections.concat(narr.rejections || []);
    picks = narr.picks;
    parlayLegs = narr.parlayLegs || parlayLegs;
    if (narr.rejections && narr.rejections.length) {
      const veto = new Set(narr.rejections.map(r => String(r.side || r.pick || '').toLowerCase()).filter(Boolean));
      const vetoed = (c) => {
        const names = [c && c.side, c && c.pick, formatMoneylinePick(c && c.side, c && c.market)]
          .map(s => String(s || '').toLowerCase());
        return names.some(n => n && veto.has(n));
      };
      const narrPicks = (narr.picks || []).filter(p => !vetoed(p));
      const qualified2 = stillRaw.filter(c => narrPicks.some(p => samePublished(p, c)));
      built = publishFrom(
        open.filter(c => !vetoed(c)),
        qualified2,
        (qa.yesPoolRemaining || yesPool).filter(c => !vetoed(c)),
        narrPicks,
      );
      picks = built.picks;
      parlayLegs = await narrateParlayLegsOnly({
        parlayLegs: built.parlayLegs,
        dateFormatted,
        apiKey: process.env.ANTHROPIC_API_KEY,
        straightPicks: picks,
      });
      narr = await narrateAndVerify({
        picks,
        parlayLegs,
        dateFormatted,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      narrRejections = narrRejections.concat(narr.rejections || []);
      picks = narr.picks;
      parlayLegs = narr.parlayLegs || parlayLegs;
    }
  } else {
    console.log('[omega-vnext] skipNarrate=true (replay/eval path)');
  }

  // Narration may cut a stake. Re-apply the same caps, then quote whatever is left.
  {
    const capped = applyDailyUnitCap(picks, parlayLegs);
    const exposed = applyExposureCaps(capped.picks, capped.parlayLegs);
    for (const p of exposed.picks || []) {
      const u = parseFloat(String(p.units || '').replace(/[^0-9.]/g, '')) || 0;
      if (u > 0) continue;
      narrRejections.push({
        matchup: p.matchup || null,
        side: p.pick || p.side || null,
        market: p.betType || p.market || null,
        sport: p.sport || null,
        reason: 'exposure-cap',
      });
    }
    picks = exposed.picks.filter(p => (parseFloat(String(p.units || '').replace(/[^0-9.]/g, '')) || 0) > 0);
    parlayLegs = syncLegsToPublishedStraights(exposed.parlayLegs, picks);
  }
  picks = attachClvFields(picks, MODEL_VERSION, dateISO);
  parlayLegs = attachClvToParlay(parlayLegs, MODEL_VERSION, dateISO);
  picks = sortByGradeThenUnits(picks);
  narr.edgeSummary = alignEdgeSummary(narr.edgeSummary, picks, parlayLegs, dateFormatted);

  const summary = summaryFrom(picks, parlayLegs, {
    modelVersion: MODEL_VERSION,
    aplusLocks: picks.filter(p => p.rating === 'aplus').length,
    qaHardFails: hardFails.length,
  });

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

  const rejections = dedupeRejections([
    ...(narrRejections || []),
    ...(built.rejections || []),
  ]);

  const empty = picks.length === 0;
  const picksData = {
    date: dateISO,
    dateFormatted,
    model: MODEL_VERSION,
    picks,
    rejections,
    edgeSummary: narr.edgeSummary || '',
    insights: narr.insights || '',
    summary,
    generatedAt: now.toISOString(),
    parlayLegs: empty ? [] : parlayLegs,
    parlayPool: empty ? [] : (built.parlayPool || []),
    sgps: [],
    claudeVerified: !!narr.claudeVerified,
    fallback: false,
    candidateTable,
    diagnostics: edgeDiagnostics,
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
    // "No Qualifying Plays Today" card (lib/no-plays). Only a COMPLETED run gets here.
    const slateCounts = slateCountsFor(snap);
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
