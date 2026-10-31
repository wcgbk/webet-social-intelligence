'use strict';

const {
  MODEL_VERSION, FLAG_ENV, PARLAY_STAKE_CAP, PARLAY_PROFIT_FLOOR, PARLAY_LEAN_STAKE, KELLY_FRACTION,
} = require('./constants');
const { fitWalkForward, applyCalibration } = require('./calibrate');
const { gameKey, marketFamily, annotateCandidate, selectStraights } = require('./select');
const { sizeStraights, sumUnits, roundQuarter, stakeUsd } = require('./size');
const { recheckPrices, toPick, validateCard, autoCorrectCard, parseAmerican } = require('./guards');
const { summaryFrom } = require('../omega-vnext/assemble');
const { publishEdgeCard } = require('../omega-vnext/assemble');
const { ensureCardParlay } = require('../omega-vnext/parlay');
const { fillNeverBlock, toPickObject } = require('../omega-vnext/select');
const {
  americanToImplied, kellyFraction,
} = require('../omega-vnext/odds_math');

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

function parsePct(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? v / 100 : v;
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return String(v).includes('%') || Math.abs(n) > 1 ? n / 100 : n;
}

function sameGameExtras(legs) {
  const counts = new Map();
  for (const leg of legs || []) {
    const key = String(leg.matchup || '').trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let extra = 0;
  for (const n of counts.values()) if (n > 1) extra += n - 1;
  return extra;
}

function haircutFactor(ticket) {
  const extras = sameGameExtras(ticket && ticket.legs);
  if (extras > 0) return Math.pow(0.95, extras);
  const raw = ticket && (ticket.correlationFactor != null ? ticket.correlationFactor : ticket.correlationHaircut);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return 1;
}

/** Quarter-Kelly on the haircut joint. A ticket the old rules built is never sized to zero. */
function parlayStakeUnits(ticket, straights) {
  const prob = parsePct(ticket && ticket.combinedProb);
  const american = parseAmerican(ticket && ticket.combinedOdds);
  const ev = parsePct(ticket && ticket.ev);
  let kellyU = 0;
  if (prob != null && american != null) {
    const frac = kellyFraction(prob, american, KELLY_FRACTION);
    if (frac > 0) kellyU = roundQuarter(frac * 100);
  }
  const straightUnits = (straights || []).reduce((sum, row) => sum + (Number(row.unitsNum != null ? row.unitsNum : row.units) || 0), 0);
  let cap = PARLAY_STAKE_CAP;
  if (straightUnits > 0) cap = Math.min(PARLAY_STAKE_CAP, Math.max(PARLAY_PROFIT_FLOOR, straightUnits));
  let units = ev != null && ev >= -1e-9 ? Math.max(PARLAY_PROFIT_FLOOR, kellyU) : PARLAY_LEAN_STAKE;
  if (units > cap) units = cap;
  units = roundQuarter(units);
  if (!(units >= 0.25)) units = 0.25;
  return units;
}

function stampParlay(ticket, straights) {
  if (!ticket) return null;
  const factor = haircutFactor(ticket);
  const units = parlayStakeUnits(ticket, straights);
  return {
    ...ticket,
    units: `${units}u`,
    unitsNum: units,
    stakeUsd: stakeUsd(units),
    modelVersion: MODEL_VERSION,
    correlationFactor: factor,
    correlationHaircut: factor < 1 ? (ticket.correlationHaircut && ticket.correlationHaircut !== '1' ? ticket.correlationHaircut : `0.95^(${sameGameExtras(ticket.legs)})`) : (ticket.correlationHaircut || '1'),
    legs: (ticket.legs || []).map((leg) => ({ ...leg, modelVersion: MODEL_VERSION })),
    parlayStake: 'quarter-kelly-capped',
  };
}

function straightAsLeg(row) {
  const odds = typeof row.odds === 'number' ? row.odds : parseAmerican(row.odds);
  const cover = row.calibration && row.calibration.pCal;
  return {
    sport: row.sport,
    matchup: row.matchup,
    side: row.pick,
    pick: row.pick,
    market: row.market,
    betType: row.market,
    odds,
    coverProb: cover,
    ev: row.ev,
    book: row.book || 'draftkings',
    bestDkHr: row.bestDkHr || (odds != null ? { american: odds, book: row.book || 'draftkings' } : null),
    commenceTime: row.commenceTime || '',
    homeTeam: row.homeTeam || null,
    awayTeam: row.awayTeam || null,
    line: row.line != null ? row.line : null,
    edgePct: row.edge,
    uncertainty: row.uncertaintyUsed,
    units: row.units > 0 ? `${row.units}u` : undefined,
    rating: row.edge >= 0.05 ? 'aplus' : (row.edge >= 0.035 ? 'a' : (row.edge >= 0.02 ? 'aminus' : 'b')),
  };
}

function ticketOf(built) {
  return built && built[0] ? built[0] : null;
}

/**
 * Parlay legs are the v1 historical slip on the full candidate pool.
 * The seed is the v1 card (qualified straights, then the never-block fill),
 * not the v2 straights. A leg that opposes a v2 straight stays on the ticket.
 * Stake and the same-game haircut are applied by the caller.
 * `straightRows` is unused on purpose: it must not seed or veto this slip.
 */
function historicalParlay(pool, straightRows, cardDate, v1Qualified) {
  void straightRows;
  let ticket = null;
  let exclusions = [];
  try {
    const filled = fillNeverBlock(v1Qualified || [], pool || [], 3);
    const v1Picks = filled.map((c) => toPickObject(c, { modelVersion: 'v1-fallback' }));
    const built = ensureCardParlay(pool || [], v1Picks, {
      cardDate,
      yesPool: pool || [],
      fromPublishedStraights: true,
    });
    ticket = ticketOf(built);
    exclusions = (built && built.parlayExclusions) || [];
  } catch (err) {
    ticket = null;
    exclusions = [];
  }
  return {
    ticket,
    exclusions,
    source: ticket ? 'v1-rules' : null,
    v1WouldParlay: !!ticket,
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
  const straights = sizeStraights(selectStraights(kept));
  const straightRows = straights.map(straightAsLeg);
  const parlayPool = Array.isArray(input.parlayPool) ? input.parlayPool : (input.candidates || []);
  const hist = historicalParlay(parlayPool, straightRows, date, input.v1Qualified || []);
  for (const drop of hist.exclusions || []) rejections.push(drop);
  const stamped = stampParlay(hist.ticket, straights);
  const parlayLegs = stamped ? [stamped] : [];
  const picks = straights.map(toPick);
  const straightUnits = +sumUnits(straights).toFixed(2);
  const parlayUnits = stamped ? Number(stamped.unitsNum) || 0 : 0;
  const dateFormatted = input.dateFormatted || date;
  const edgeSummary = picks.length
    ? `${dateFormatted}: ${picks.length} straight${picks.length === 1 ? '' : 's'} cleared the calibrated edge floor.`
    : (parlayLegs.length
      ? `${dateFormatted}: no straight cleared the edge floor. The parlay still publishes under the existing rules.`
      : `${dateFormatted}: no qualifying plays. The card passes.`);
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
    short: picks.length > 0 && picks.length < 3,
    v1WouldParlay: hist.v1WouldParlay === true,
    parlaySource: hist.source,
  };
  const published = autoCorrectCard(card);
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
  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam || ''} @ ${c.homeTeam || ''}`,
    pick: c.pick || c.side,
    side: c.side,
    market: c.market || c.betType,
    betType: c.betType,
    odds: c.oddsStr || c.odds,
    line: c.line,
    pModel: c.modelRawP != null ? c.modelRawP : (c.p_model != null ? c.p_model : (c.pModel != null ? c.pModel : c.coverProb)),
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
