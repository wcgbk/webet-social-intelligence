'use strict';

const {
  MODEL_VERSION, FLAG_ENV, SHRINK_N0, MIN_SPORT, NHL_ML_SHRINK_K, NHL_ML_WALKFORWARD_BEATS_NOVIG,
  forceTop3Enabled,
} = require('./constants');
const { fitWalkForward, applyCalibration } = require('./calibrate');
const {
  marketSkillEnabled, fitMarketSkill, disabledMarketSkill, applyMarketSkill,
  attachMarketSkillReport, publicMarketSkill, boardProbKey,
} = require('./market_skill');
const {
  gameKey, marketFamily, annotateCandidate, selectStraights, selectForcedTop3, pastPregameCutoff, pregameClockMs,
} = require('./select');
const { sizeStraights, sizeForcedStraights, sumUnits } = require('./size');
const { recheckPrices, validateCard, autoCorrectCard, parseAmerican, toParlay, toPick } = require('./guards');
const { summaryFrom } = require('../omega-vnext/assemble');
const { publishEdgeCard } = require('../omega-vnext/assemble');
const { sizeParlay, buildForcedParlay, legEvSkips, legFailsPriceEv, legBookSkips, quotedLeg } = require('./parlay');
const { americanToImplied } = require('../omega-vnext/odds_math');
const { applySportCoverage, stampQualified } = require('./coverage');
const { dkHrLineAgrees, quotePoint } = require('./board');
const { inputsLoggingEnabled, recordCandidateInputs } = require('./candidate_inputs');

const DK_HR_BOOKS = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

function finiteAmerican(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null;
  return parseAmerican(value);
}

/** hardrock / hardrockbet_oh publish as the same Hard Rock book. */
function canonicalPlaceBook(book) {
  const key = String(book || '').toLowerCase();
  if (key === 'hardrock' || key === 'hardrockbet' || key === 'hardrockbet_oh') return 'hardrockbet';
  if (key === 'draftkings') return 'draftkings';
  return key;
}

/**
 * Placeable DraftKings or Hard Rock price for this side and this number.
 * bestDkHr wins even when raw.book is a better number somewhere else.
 * A non-DK/HR book on that quote is not used. A quote point that differs
 * from the line the edge was computed on is not used. Without a usable
 * bestDkHr, only a posted DK/HR book is kept.
 */
function placeableDkHr(raw) {
  const px = raw && raw.bestDkHr;
  const edgeLine = raw && raw.line != null && raw.line !== ''
    ? raw.line
    : (raw && raw.betPoint != null && raw.betPoint !== '' ? raw.betPoint : null);
  if (px && typeof px === 'object') {
    const american = finiteAmerican(px.american);
    const postedBook = String(px.book || '').toLowerCase();
    if (american != null && postedBook && !DK_HR_BOOKS.has(postedBook)) {
      return { reject: 'no-dk-hr-price' };
    }
    if (american != null && !dkHrLineAgrees(edgeLine, quotePoint(px))) {
      return { reject: 'dk-hr-line-mismatch' };
    }
    if (american != null) {
      return { odds: american, book: canonicalPlaceBook(postedBook) || null, fromBest: true };
    }
  }
  const posted = String(raw && raw.book || '').toLowerCase();
  if (DK_HR_BOOKS.has(posted)) {
    return { odds: parseAmerican(raw.odds), book: canonicalPlaceBook(posted), fromBest: false };
  }
  return null;
}

function oddsLabel(american) {
  if (!Number.isFinite(american)) return null;
  return american > 0 ? `+${american}` : String(american);
}

function pipelineV2Enabled(opts, env) {
  const options = opts || {};
  if (Object.prototype.hasOwnProperty.call(options, 'pipelineV2') && options.pipelineV2 != null) {
    return !!options.pipelineV2;
  }
  const source = env == null ? process.env : env;
  const flag = source && source[FLAG_ENV];
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return true;
}

function numProb(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 0 && v < 1) return v;
    if (v > 1 && v <= 100) return v / 100;
    return null;
  }
  const text = String(v).trim();
  const n = Number(text.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (text.includes('%') || n > 1) return n / 100;
  if (n > 0 && n < 1) return n;
  return null;
}

function normalizeCandidate(raw) {
  const pick = raw.pick || raw.side || '';
  const market = marketFamily(raw.market || raw.betType, pick);
  const quote = placeableDkHr(raw);
  const rejected = quote && quote.reject;
  const priced = !!(quote && !rejected);
  return {
    sport: String(raw.sport || '').toUpperCase(),
    matchup: raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`.trim(),
    pick: String(pick),
    market,
    marketFamily: market,
    odds: priced ? quote.odds : null,
    oddsText: priced && quote.fromBest ? (oddsLabel(quote.odds) || raw.odds) : raw.odds,
    line: raw.line != null ? raw.line : (raw.betPoint != null ? raw.betPoint : null),
    pModel: numProb(raw.pModel != null ? raw.pModel : (raw.modelRawP != null ? raw.modelRawP : raw.p_model)),
    pMkt: numProb(raw.pMkt != null ? raw.pMkt : (raw.fair_sharp_p != null ? raw.fair_sharp_p : raw.sharpFairP)),
    uncertainty: Number.isFinite(Number(raw.uncertainty)) ? Number(raw.uncertainty) : null,
    commenceTime: raw.commenceTime || '',
    book: priced ? quote.book : (raw.book || null),
    postedBook: raw.book || null,
    postedOdds: raw.odds,
    bestDkHr: raw.bestDkHr && typeof raw.bestDkHr === 'object' ? raw.bestDkHr : null,
    lineMismatch: rejected === 'dk-hr-line-mismatch',
    homeTeam: raw.homeTeam || null,
    awayTeam: raw.awayTeam || null,
    result: raw.result || null,
    clvPp: raw.clvPp != null && raw.clvPp !== '' ? Number(raw.clvPp) : null,
    coreReasoning: raw.coreReasoning || '',
    gameKey: gameKey(raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`),
    noDkHr: !priced,
    openPrint: raw.openPrint != null ? raw.openPrint : null,
    lineMove: raw.lineMove != null ? raw.lineMove : null,
  };
}

function dedupe(cands) {
  const map = new Map();
  for (const cand of cands) {
    const key = `${cand.gameKey}|${String(cand.pick).toLowerCase()}`;
    if (!map.has(key)) map.set(key, cand);
  }
  return [...map.values()];
}

/** Same screen as the main loop. A rescued row is not a free pass. */
function stageCandidate(cand, fit, asOfMs, prepared, rejections) {
  if (cand.lineMismatch) {
    rejections.push({
      matchup: cand.matchup,
      side: cand.pick,
      market: cand.market,
      sport: cand.sport,
      reason: 'dk-hr-line-mismatch',
      odds: cand.postedOdds != null ? cand.postedOdds : null,
      book: cand.postedBook || null,
      line: cand.line != null ? cand.line : null,
    });
    return;
  }
  if (cand.noDkHr) {
    rejections.push({
      matchup: cand.matchup,
      side: cand.pick,
      market: cand.market,
      sport: cand.sport,
      reason: 'no-dk-hr-price',
      odds: cand.postedOdds != null ? cand.postedOdds : null,
      book: cand.postedBook || null,
    });
    return;
  }
  if (pastPregameCutoff(cand.commenceTime, asOfMs)) {
    rejections.push({
      matchup: cand.matchup,
      side: cand.pick,
      market: cand.market,
      sport: cand.sport,
      reason: 'in-progress-or-started',
      commenceTime: cand.commenceTime || '',
    });
    return;
  }
  if (cand.pMkt == null && cand.odds != null) {
    const implied = americanToImplied(cand.odds);
    if (implied != null) cand.pMkt = implied;
  }
  if (cand.pModel == null || cand.pMkt == null || cand.odds == null) {
    rejections.push({
      matchup: cand.matchup,
      side: cand.pick,
      market: cand.market,
      sport: cand.sport,
      reason: cand.odds == null ? 'bad-price' : 'missing-prob',
    });
    return;
  }
  const calibration = applyCalibration(cand, fit);
  if (calibration && calibration.pCalRaw == null) calibration.pCalRaw = calibration.pCal;
  prepared.push({ ...cand, calibration });
}

/**
 * Build one v2 card. Flag-off callers should use runPipeline, which delegates
 * to the production publisher and does not enter this function.
 */
const boardStampState = new WeakMap();

async function buildCard(input) {
  const date = input && input.date;
  const history = Array.isArray(input && input.history) ? input.history : [];
  const boardRows = Array.isArray(input && input.boardRows) ? input.boardRows : [];
  const fit = fitWalkForward(history, date, {
    boardRows,
    biasSource: input && input.biasSource,
  });
  let marketSkill;
  try {
    marketSkill = marketSkillEnabled(input)
      ? fitMarketSkill(input && input.gradedBoardRows, date)
      : disabledMarketSkill();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[omega-v2] market skill fit skipped: ${msg}`);
    marketSkill = disabledMarketSkill();
  }
  const asOfMs = pregameClockMs(input);
  const pregameOpts = { pregameAsOfMs: asOfMs };
  const normalized = dedupe((input.candidates || []).map(normalizeCandidate));
  const prepared = [];
  const rejections = [];
  for (const cand of normalized) stageCandidate(cand, fit, asOfMs, prepared, rejections);
  let sportCoverage;
  try {
    sportCoverage = applySportCoverage(prepared, input.stageCounts, {
      boardBySport: input.boardBySport || null,
      candidates: input.candidates || [],
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[coverage] coverage check failed: ${msg}`);
    sportCoverage = {
      sports: [],
      biasLimit: null,
      corrected: [],
      rows: [],
      error: 'coverage check failed',
    };
  }
  const rescued = sportCoverage && Array.isArray(sportCoverage.added) ? sportCoverage.added : [];
  if (sportCoverage && Object.prototype.hasOwnProperty.call(sportCoverage, 'added')) {
    delete sportCoverage.added;
  }
  attachMarketSkillReport(sportCoverage, marketSkill);
  for (const raw of rescued) {
    try {
      const cand = normalizeCandidate(raw);
      cand.autoCorrected = true;
      stageCandidate(cand, fit, asOfMs, prepared, rejections);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`[coverage] rescued row skipped: ${msg}`);
    }
  }
  stampQualified(sportCoverage, null);
  // Coverage may replace pCal with an anchor. The weight runs on whatever
  // probability is about to be bet, and it keeps pCalRaw as the pre-weight
  // model probability so a later board fit does not compound.
  for (const cand of prepared) {
    if (!cand.calibration) continue;
    cand.calibration = applyMarketSkill(cand.calibration, marketSkill, cand.sport);
  }
  const annotated = prepared.map((cand) => annotateCandidate(cand));
  stampQualified(sportCoverage, annotated);
  for (const cand of annotated) {
    if (!cand.qualified && !cand.parlayQualified) {
      rejections.push({
        matchup: cand.matchup,
        side: cand.pick,
        market: cand.market,
        sport: cand.sport,
        reason: cand.rejectReason || 'not-qualified',
        odds: cand.odds,
        edge: cand.edge,
        edgeNovig: cand.edgeNovig,
        pCal: cand.calibration ? cand.calibration.pCal : null,
        pMkt: cand.calibration ? cand.calibration.pMkt : null,
      });
    }
  }
  const bettable = annotated.filter((cand) => cand.qualified || cand.parlayQualified);
  const checked = await recheckPrices(bettable, input.recheck);
  for (const drop of checked.dropped) rejections.push(drop);
  const kept = checked.kept;
  const forceTop3 = forceTop3Enabled();
  let straights;
  let parlayPoolLegs;
  let sizedParlay;
  if (forceTop3) {
    straights = sizeForcedStraights(selectForcedTop3(kept, pregameOpts));
    sizedParlay = buildForcedParlay(straights);
    parlayPoolLegs = kept.filter((cand) => cand.parlayQualified && quotedLeg(cand));
  } else {
    straights = sizeStraights(selectStraights(kept.filter((cand) => cand.qualified), pregameOpts));
    const parlayKept = kept.filter((cand) => cand.parlayQualified);
    for (const skip of legEvSkips(parlayKept)) rejections.push(skip);
    for (const skip of legBookSkips(parlayKept)) rejections.push(skip);
    parlayPoolLegs = parlayKept.filter((cand) => !legFailsPriceEv(cand) && quotedLeg(cand));
    sizedParlay = sizeParlay(parlayKept, straights, pregameOpts);
  }
  if (!sizedParlay.publish && sizedParlay.skipReason) {
    rejections.push({
      matchup: null,
      side: null,
      market: 'Parlay',
      sport: null,
      reason: sizedParlay.skipReason,
      ev: sizedParlay.ev,
    });
  }
  const parlayLegs = toParlay(sizedParlay, annotated.length);
  const picks = straights.map(toPick);
  const straightUnits = +sumUnits(straights).toFixed(2);
  const parlayUnits = sizedParlay.publish ? sizedParlay.units : 0;
  const dateFormatted = input.dateFormatted || date;
  const edgeSummary = forceTop3
    ? (picks.length
      ? `${dateFormatted}: top ${picks.length} plays by expected growth.`
      : `${dateFormatted}: no placeable plays.`)
    : (picks.length
      ? `${dateFormatted}: ${picks.length} straight${picks.length === 1 ? '' : 's'} cleared a positive calibrated edge.`
      : (parlayLegs.length
        ? `${dateFormatted}: no straight cleared. The parlay is calibrated-edge legs with positive joint EV.`
        : `${dateFormatted}: no qualifying plays. The card passes.`));
  const card = {
    date,
    dateFormatted,
    modelVersion: MODEL_VERSION,
    pipeline: 'omega-v2',
    picks,
    parlayLegs,
    parlayPool: parlayPoolLegs.map((cand) => ({
      matchup: cand.matchup,
      pick: cand.pick,
      market: cand.market,
      sport: cand.sport,
      odds: cand.oddsText != null ? cand.oddsText : cand.odds,
      commenceTime: cand.commenceTime || '',
      pCal: cand.calibration.pCal,
      pMkt: cand.calibration.pMkt,
      edgeNovig: cand.edgeNovig,
      book: cand.book || null,
    })),
    rejections,
    chosen: picks,
    summary: summaryFrom(picks, parlayLegs, { modelVersion: MODEL_VERSION, aplusLocks: picks.filter((p) => p.rating === 'aplus').length }),
    edgeSummary,
    insights: '',
    hardFails: input.hardFails || [],
    calibration: {
      trainN: fit.trainN,
      trainMaxDate: fit.trainMaxDate,
      // Pooled method and shrinkK are the unused pooled fit. A sport under
      // its floor does not take this map. Applied k is on each pick.
      method: fit.pooled.method,
      shrinkK: fit.pooled.k,
      pooledAppliesUnderFloor: false,
      sportN: fit.sportN || {},
      sportFloor: MIN_SPORT,
      shrinkN0: SHRINK_N0,
      nhlMlShrinkK: NHL_ML_SHRINK_K,
      nhlMlWalkforwardBeatsNovig: NHL_ML_WALKFORWARD_BEATS_NOVIG,
      biasSource: fit.biasSource,
      bias: fit.bias || {},
      biasN: fit.biasN || {},
      biasMin: fit.biasMin,
      marketSkill: publicMarketSkill(marketSkill),
      bySport: Object.fromEntries(Object.entries(fit.bySport).map(([sport, model]) => [sport, {
        n: model.n,
        k: model.k,
        method: model.method,
      }])),
    },
    priceRecheck: { checked: checked.checked, dropped: checked.dropped.length },
    leakageChecked: true,
    straightUnits,
    parlayUnits,
    totalUnits: +(straightUnits + parlayUnits).toFixed(2),
    pass: picks.length === 0 && parlayLegs.length === 0,
    short: picks.length > 0 && picks.length < 3,
    v1WouldParlay: false,
    parlaySource: forceTop3 ? 'top3-straights' : (sizedParlay.publish ? 'calibrated-edge' : null),
    ...(forceTop3 ? { selectionRule: 'force-top3' } : {}),
    sportCoverage,
  };
  const published = autoCorrectCard(card, pregameOpts);
  // Published line names the rank: quarter-Kelly growth, not raw EV.
  if (published.selectionRule === 'force-top3') {
    const n = (published.picks || []).length;
    const label = published.dateFormatted || published.date;
    published.edgeSummary = n
      ? `${label}: top ${n} plays by expected growth.`
      : `${label}: no placeable plays.`;
    published.parlaySource = 'top3-straights';
  }
  const errors = validateCard(published);
  if (errors.length) {
    published.qaNotes = (published.qaNotes || []).concat(errors);
    published.qaCorrected = true;
  }
  published.summary = summaryFrom(published.picks, published.parlayLegs, {
    modelVersion: MODEL_VERSION,
    aplusLocks: (published.picks || []).filter((p) => p.rating === 'aplus').length,
  });
  const overlay = [];
  for (const cand of prepared) {
    if (!cand.calibration) continue;
    overlay.push({
      key: boardProbKey(cand),
      pCal: cand.calibration.pCal,
      pCalRaw: cand.calibration.pCalRaw,
    });
  }
  boardStampState.set(published, { fit, skill: marketSkill, overlay });
  return published;
}

/**
 * Morning-board rows for the day. coverProb is the probability the card
 * bets with. pCalRaw is the calibrated probability before the market-skill
 * weight. Flag off leaves the rows untouched. A row the card calibrated
 * uses that result. Any other row is calibrated with the same fit.
 */
function stampBoardCandidates(candidates, cardOrState) {
  const state = cardOrState && cardOrState.fit
    ? cardOrState
    : boardStampState.get(cardOrState);
  if (cardOrState && !cardOrState.fit) boardStampState.delete(cardOrState);
  const skill = state && state.skill;
  if (!skill || skill.enabled === false) {
    return (candidates || []).map((c) => ({ ...c }));
  }
  const fit = state.fit;
  const map = new Map();
  for (const row of state.overlay || []) {
    if (row && row.key) map.set(row.key, row);
  }
  return (candidates || []).map((cand) => {
    const copy = { ...cand };
    const hit = map.get(boardProbKey(cand));
    if (hit && Number.isFinite(Number(hit.pCal))) {
      copy.coverProb = Number(hit.pCal);
      const raw = Number(hit.pCalRaw);
      copy.pCalRaw = Number.isFinite(raw) ? raw : Number(hit.pCal);
      return copy;
    }
    if (!fit) return copy;
    let cal = null;
    try {
      const mapped = fromOmegaCandidate(cand);
      cal = applyCalibration({
        sport: mapped.sport,
        market: mapped.market,
        pick: mapped.pick,
        pModel: mapped.pModel,
        pMkt: mapped.pMkt,
      }, fit);
    } catch (_) {
      cal = null;
    }
    if (!cal || !Number.isFinite(Number(cal.pCal))) return copy;
    const weighted = applyMarketSkill({ ...cal, pCalRaw: cal.pCal }, skill, cand.sport);
    if (!weighted || !Number.isFinite(Number(weighted.pCal))) return copy;
    copy.coverProb = weighted.pCal;
    copy.pCalRaw = weighted.pCalRaw;
    return copy;
  });
}

function fromOmegaCandidate(c) {
  const pModel = c.modelRawP != null ? c.modelRawP : (c.p_model != null ? c.p_model : (c.pModel != null ? c.pModel : c.coverProb));
  const pMkt = c.fair_sharp_p != null ? c.fair_sharp_p : (c.sharpFairP != null ? c.sharpFairP : c.pMkt);
  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam || ''} @ ${c.homeTeam || ''}`,
    pick: c.pick || c.side,
    side: c.side,
    market: c.market || c.betType,
    betType: c.betType,
    odds: c.oddsStr || c.odds,
    line: c.line,
    pModel,
    pMkt,
    p_model: pModel != null ? pModel : null,
    fair_sharp_p: pMkt != null ? pMkt : null,
    uncertainty: c.uncertainty,
    commenceTime: c.commenceTime,
    book: c.book,
    bestDkHr: c.bestDkHr || null,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    result: c.result,
    clvPp: c.clvPp,
    coreReasoning: c.coreReasoning,
    openPrint: c.openPrint != null ? c.openPrint : null,
    lineMove: c.lineMove != null ? c.lineMove : null,
  };
}

async function publishFromOmegaCandidates(input) {
  const raw = input.candidates || [];
  const card = await buildCard({
    date: input.date,
    dateFormatted: input.dateFormatted,
    candidates: raw.map(fromOmegaCandidate),
    parlayPool: input.parlayPool || raw,
    v1Qualified: input.v1Qualified || [],
    history: input.history || [],
    boardRows: input.boardRows || [],
    gradedBoardRows: input.gradedBoardRows || [],
    marketSkill: input.marketSkill,
    biasSource: input.biasSource,
    recheck: input.recheck || null,
    hardFails: input.hardFails || [],
    pregameAsOfMs: input.pregameAsOfMs,
    stageCounts: input.stageCounts || null,
    boardBySport: input.boardBySport || null,
  });
  // Context log only. The card object above is already final.
  try {
    if (input && inputsLoggingEnabled(input)) {
      const logged = await recordCandidateInputs({
        candidates: Array.isArray(input.scoredCandidates) ? input.scoredCandidates : raw,
        snap: input.snap || null,
        history: input.history || [],
        boardRows: input.boardRows || [],
        dateISO: input.date,
        fetchJson: typeof input.inputsFetch === 'function' ? input.inputsFetch : null,
        skipFetch: !!(input.skipInputFetch || input.replayLike || input.historicalSnapshot),
        scheduleGames: input.scheduleGames || null,
        injuriesBySport: input.injuriesBySport || null,
        injuries: input.injuries || null,
      });
      if (logged && typeof input === 'object') {
        try { input.candidateInputsResult = logged; } catch (_) { /* caller may freeze input */ }
      }
    }
  } catch (err) {
    const msg = String(err && err.message || 'error');
    console.warn(`[candidate-inputs] skipped: ${/bearer|token|authorization|api[_-]?key/i.test(msg) ? 'unavailable' : msg.slice(0, 180)}`);
  }
  return card;
}

/**
 * Flag off: production publishEdgeCard, unchanged.
 * Flag on: v2 calibrate / select / size / parlay. Straights are the top 3
 * by quarter-Kelly expected growth.
 */
async function runPipeline(input) {
  if (!pipelineV2Enabled(input)) {
    return publishEdgeCard(input.prodArgs || {});
  }
  return buildCard(input.v2 || input);
}

module.exports = {
  pipelineV2Enabled,
  buildCard,
  publishFromOmegaCandidates,
  runPipeline,
  normalizeCandidate,
  fromOmegaCandidate,
  stampBoardCandidates,
};
