'use strict';

const { MODEL_VERSION, FLAG_ENV } = require('./constants');
const { fitWalkForward, applyCalibration } = require('./calibrate');
const { gameKey, marketFamily, annotateCandidate, selectStraights } = require('./select');
const { sizeStraights, sumUnits, trimBudget } = require('./size');
const { sizeParlay } = require('./parlay');
const { recheckPrices, toPick, toParlay, validateCard, parseAmerican } = require('./guards');
const { summaryFrom } = require('../omega-vnext/assemble');
const { publishEdgeCard } = require('../omega-vnext/assemble');

function pipelineV2Enabled(opts, env) {
  const options = opts || {};
  if (Object.prototype.hasOwnProperty.call(options, 'pipelineV2')) return !!options.pipelineV2;
  const source = env == null ? process.env : env;
  const flag = source && source[FLAG_ENV];
  return flag === '1' || flag === 'true' || flag === 'on';
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
  const odds = parseAmerican(raw.odds);
  return {
    sport: String(raw.sport || '').toUpperCase(),
    matchup: raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`.trim(),
    pick: String(pick),
    market,
    marketFamily: market,
    odds,
    oddsText: raw.odds,
    line: raw.line != null ? raw.line : (raw.betPoint != null ? raw.betPoint : null),
    pModel: numProb(raw.pModel != null ? raw.pModel : (raw.modelRawP != null ? raw.modelRawP : raw.p_model)),
    pMkt: numProb(raw.pMkt != null ? raw.pMkt : (raw.fair_sharp_p != null ? raw.fair_sharp_p : raw.sharpFairP)),
    uncertainty: Number.isFinite(Number(raw.uncertainty)) ? Number(raw.uncertainty) : null,
    commenceTime: raw.commenceTime || '',
    book: raw.book || null,
    homeTeam: raw.homeTeam || null,
    awayTeam: raw.awayTeam || null,
    result: raw.result || null,
    clvPp: raw.clvPp != null && raw.clvPp !== '' ? Number(raw.clvPp) : null,
    coreReasoning: raw.coreReasoning || '',
    gameKey: gameKey(raw.matchup || `${raw.awayTeam || ''} @ ${raw.homeTeam || ''}`),
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
  const normalized = dedupe((input.candidates || []).map(normalizeCandidate));
  const prepared = [];
  const rejections = [];
  for (const cand of normalized) {
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
  const annotated = prepared.map((cand) => annotateCandidate(cand, fit));
  for (const cand of annotated) {
    if (!cand.qualified) {
      rejections.push({
        matchup: cand.matchup,
        side: cand.pick,
        market: cand.market,
        sport: cand.sport,
        reason: cand.rejectReason || 'not-qualified',
        edge: cand.edge,
        floor: cand.floor,
      });
    }
  }
  const qualified = annotated.filter((cand) => cand.qualified);
  const checked = await recheckPrices(qualified, input.recheck);
  for (const drop of checked.dropped) rejections.push(drop);
  const kept = checked.kept;
  let straights = sizeStraights(selectStraights(kept));
  let parlay = sizeParlay(kept, straights);
  if (parlay.publish) {
    const room = Math.max(0, 4 - parlay.units);
    straights = trimBudget(straights, Math.min(3.5, room));
    parlay = sizeParlay(kept, straights);
  }
  const picks = straights.map(toPick);
  const parlayLegs = toParlay(parlay, kept.length);
  const straightUnits = +sumUnits(straights).toFixed(2);
  const parlayUnits = parlay.publish ? parlay.units : 0;
  const dateFormatted = input.dateFormatted || date;
  const edgeSummary = picks.length
    ? `${dateFormatted}: ${picks.length} straight${picks.length === 1 ? '' : 's'} cleared the walk-forward edge floor.`
    : `${dateFormatted}: no qualifying plays. Nothing cleared the walk-forward edge floor, so the card passes.`;
  const card = {
    date,
    dateFormatted,
    modelVersion: MODEL_VERSION,
    pipeline: 'omega-v2',
    picks,
    parlayLegs,
    parlayPool: kept.map((cand) => ({
      matchup: cand.matchup,
      pick: cand.pick,
      market: cand.market,
      sport: cand.sport,
      odds: cand.oddsText != null ? cand.oddsText : cand.odds,
      commenceTime: cand.commenceTime || '',
      pCal: cand.calibration.pCal,
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
    short: picks.length > 0 && picks.length < MAX_STRAIGHTS_SAFE,
  };
  const errors = validateCard(card);
  if (errors.length) {
    const err = new Error(`omega-v2 card invalid: ${errors.join('; ')}`);
    err.errors = errors;
    throw err;
  }
  return card;
}

const MAX_STRAIGHTS_SAFE = 3;

function fromOmegaCandidate(c) {
  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam || ''} @ ${c.homeTeam || ''}`,
    pick: c.pick || c.side,
    side: c.side,
    market: c.market || c.betType,
    betType: c.betType,
    odds: c.oddsStr || c.odds,
    line: c.line,
    pModel: c.modelRawP != null ? c.modelRawP : (c.p_model != null ? c.p_model : c.pModel),
    pMkt: c.fair_sharp_p != null ? c.fair_sharp_p : (c.sharpFairP != null ? c.sharpFairP : c.pMkt),
    uncertainty: c.uncertainty,
    commenceTime: c.commenceTime,
    book: c.book,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    result: c.result,
    clvPp: c.clvPp,
    coreReasoning: c.coreReasoning,
  };
}

async function publishFromOmegaCandidates(input) {
  const card = await buildCard({
    date: input.date,
    dateFormatted: input.dateFormatted,
    candidates: (input.candidates || []).map(fromOmegaCandidate),
    history: input.history || [],
    recheck: input.recheck || null,
    hardFails: input.hardFails || [],
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
