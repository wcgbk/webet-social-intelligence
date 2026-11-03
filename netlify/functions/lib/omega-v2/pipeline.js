'use strict';

const { MODEL_VERSION, FLAG_ENV } = require('./constants');
const { fitWalkForward, applyCalibration } = require('./calibrate');
const {
  gameKey, marketFamily, annotateCandidate, selectStraights, pastPregameCutoff, pregameClockMs,
} = require('./select');
const { sizeStraights, sumUnits } = require('./size');
const { recheckPrices, validateCard, autoCorrectCard, parseAmerican, toParlay, toPick } = require('./guards');
const { summaryFrom } = require('../omega-vnext/assemble');
const { publishEdgeCard } = require('../omega-vnext/assemble');
const { sizeParlay, legEvSkips, legFailsPriceEv } = require('./parlay');
const { americanToImplied } = require('../omega-vnext/odds_math');

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
 * Placeable DraftKings or Hard Rock price for this side.
 * bestDkHr wins even when raw.book is a better number somewhere else.
 * Without it, only a posted DK/HR book is kept. Null means no-dk-hr-price.
 * The line is not touched: bestDkHr is the same side and point.
 */
function placeableDkHr(raw) {
  const px = raw && raw.bestDkHr;
  if (px && typeof px === 'object') {
    const american = finiteAmerican(px.american);
    if (american != null) {
      return { odds: american, book: canonicalPlaceBook(px.book) || null, fromBest: true };
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
  return {
    sport: String(raw.sport || '').toUpperCase(),
    matchup: raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`.trim(),
    pick: String(pick),
    market,
    marketFamily: market,
    odds: quote ? quote.odds : null,
    oddsText: quote && quote.fromBest ? (oddsLabel(quote.odds) || raw.odds) : raw.odds,
    line: raw.line != null ? raw.line : (raw.betPoint != null ? raw.betPoint : null),
    pModel: numProb(raw.pModel != null ? raw.pModel : (raw.modelRawP != null ? raw.modelRawP : raw.p_model)),
    pMkt: numProb(raw.pMkt != null ? raw.pMkt : (raw.fair_sharp_p != null ? raw.fair_sharp_p : raw.sharpFairP)),
    uncertainty: Number.isFinite(Number(raw.uncertainty)) ? Number(raw.uncertainty) : null,
    commenceTime: raw.commenceTime || '',
    book: quote ? quote.book : (raw.book || null),
    postedBook: raw.book || null,
    postedOdds: raw.odds,
    homeTeam: raw.homeTeam || null,
    awayTeam: raw.awayTeam || null,
    result: raw.result || null,
    clvPp: raw.clvPp != null && raw.clvPp !== '' ? Number(raw.clvPp) : null,
    coreReasoning: raw.coreReasoning || '',
    gameKey: gameKey(raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`),
    noDkHr: !quote,
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

/**
 * Build one v2 card. Flag-off callers should use runPipeline, which delegates
 * to the production publisher and does not enter this function.
 */
async function buildCard(input) {
  const date = input && input.date;
  const history = Array.isArray(input && input.history) ? input.history : [];
  const fit = fitWalkForward(history, date);
  const asOfMs = pregameClockMs(input);
  const pregameOpts = { pregameAsOfMs: asOfMs };
  const normalized = dedupe((input.candidates || []).map(normalizeCandidate));
  const prepared = [];
  const rejections = [];
  for (const cand of normalized) {
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
      continue;
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
      continue;
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
      continue;
    }
    const calibration = applyCalibration(cand, fit);
    prepared.push({ ...cand, calibration });
  }
  const annotated = prepared.map((cand) => annotateCandidate(cand));
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
  const straights = sizeStraights(selectStraights(kept.filter((cand) => cand.qualified), pregameOpts));
  const parlayKept = kept.filter((cand) => cand.parlayQualified);
  for (const skip of legEvSkips(parlayKept)) rejections.push(skip);
  const parlayPoolLegs = parlayKept.filter((cand) => !legFailsPriceEv(cand));
  const sizedParlay = sizeParlay(parlayKept, straights, pregameOpts);
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
  const edgeSummary = picks.length
    ? `${dateFormatted}: ${picks.length} straight${picks.length === 1 ? '' : 's'} cleared a positive calibrated edge.`
    : (parlayLegs.length
      ? `${dateFormatted}: no straight cleared. The parlay is calibrated-edge legs with positive joint EV.`
      : `${dateFormatted}: no qualifying plays. The card passes.`);
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
      method: fit.pooled.method,
      shrinkK: fit.pooled.k,
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
    parlaySource: sizedParlay.publish ? 'calibrated-edge' : null,
  };
  const published = autoCorrectCard(card, pregameOpts);
  const errors = validateCard(published);
  if (errors.length) {
    published.qaNotes = (published.qaNotes || []).concat(errors);
    published.qaCorrected = true;
  }
  published.summary = summaryFrom(published.picks, published.parlayLegs, {
    modelVersion: MODEL_VERSION,
    aplusLocks: (published.picks || []).filter((p) => p.rating === 'aplus').length,
  });
  return published;
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
    recheck: input.recheck || null,
    hardFails: input.hardFails || [],
    pregameAsOfMs: input.pregameAsOfMs,
  });
  return card;
}

/**
 * Flag off: production publishEdgeCard, unchanged.
 * Flag on: v2 calibrate / select / size / parlay.
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
};
