'use strict';

const {
  MAX_EDGE, MAX_STRAIGHTS, EDGE_FLOOR_K, NO_VIG_BUCKETS, forceTop3From,
  PAIR_SANITY_PP, PAIR_SANITY_LO, PAIR_SANITY_HI, pairFixEnabled, longshotAdjEnabled,
  marketPEnabled, favCapEnabled, FAV_CAP_AMERICAN, powerDevigEnabled,
  evFirstEnabled, evFirstCappedEnabled, rawEvRankEnabled, KELLY_FRACTION,
  blendPEnabled, blendWeightFor, blendTrimEnabled, clampWinProb,
  webetaiFormulaEnabled, sportCapEnabled, FORMULA_MODELLESS_HAIRCUT, FORMULA_DOG_CAP_AMERICAN,
} = require('./constants');
const {
  blendProb, modelProbForBlend, formulaModelProb, formulaBlendWeight, canonSport, logit, logistic,
} = require('./blend');
const { dkHrLineAgrees, quotePoint } = require('./board');
const { applySharpPrep, applySharpFinish } = require('./sharp_gaps');
const { applyStatusVeto } = require('./status_veto');
const { filterSameEtDay } = require('./same_day');

/** Same-day filter. Flag off returns the same array. Does not log. */
function rankPool(list, opts) {
  const cardDate = opts && (opts.cardDate || opts.date);
  return filterSameEtDay(list, cardDate, opts).rows;
}

/** Same placeable books as a published straight. A missing book is not a reject. */
const PLACEABLE_BOOKS = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

/** Kickoff at or before asOf plus this window is not a pregame candidate. */
const PREGAME_GRACE_MS = 5 * 60 * 1000;

/**
 * Pregame clock. Replay passes opts.pregameAsOfMs. Live calls omit it and
 * use Date.now().
 */
function pregameClockMs(opts) {
  if (opts && Number.isFinite(Number(opts.pregameAsOfMs))) return Number(opts.pregameAsOfMs);
  return Date.now();
}

/**
 * True when commenceTime <= asOf + 5 minutes.
 * A missing or unparseable commenceTime is not dropped here.
 */
function pastPregameCutoff(commenceTime, asOfMs) {
  if (commenceTime == null || commenceTime === '') return false;
  const t = typeof commenceTime === 'number' ? commenceTime : Date.parse(commenceTime);
  if (!Number.isFinite(t)) return false;
  const clock = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  return t <= clock + PREGAME_GRACE_MS;
}
const { americanToImplied, americanToDecimal, evAtOdds } = require('../omega-vnext/odds_math');

function normTeam(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bsaint louis\b/g, 'st louis')
    .replace(/\bst\s+louis\b/g, 'st louis')
    .replace(/\s+/g, ' ')
    .trim();
}

function gameKey(matchup) {
  return normTeam(matchup).replace(/\s*@\s*/g, ' @ ');
}

function marketFamily(market, pick) {
  const token = String(market || '').toLowerCase();
  const text = String(pick || '');
  if (token === 'total' || token === 'totals' || /total/.test(token) || /^\s*(over|under)\b/i.test(text)) {
    return 'Total';
  }
  if (token === 'spread' || token === 'spreads' || /spread|puck|run line/.test(token)) return 'Spread';
  if (token === 'moneyline' || token === 'h2h' || token === 'ml' || /\bml\b/i.test(text)) return 'Moneyline';
  if (/[+-]\d/.test(text) && !/\bml\b/i.test(text)) return 'Spread';
  return 'Moneyline';
}

function totalSide(pick) {
  if (/^\s*over\b/i.test(pick || '')) return 'over';
  if (/^\s*under\b/i.test(pick || '')) return 'under';
  return null;
}

/**
 * Half-width of the linear blend across the 0.35 no-vig boundary.
 * Bucket SE and penalty stay the fitted table. Inside [0.33, 0.37) both
 * are interpolated so a 0.001 move cannot jump k*SE by 4pp (the hard step
 * is 1.5 * (0.037668 - 0.008385) = 4.39pp, plus the 3.24pp penalty step).
 * 0.02 is wide enough that a fair of 0.349 and Nashville's 0.3501 share a
 * side, and narrow enough that a price at 0.389 (Thunder) keeps the
 * middle-bucket SE. Interior points keep their bucket.
 */
const BOUNDARY_BLEND = 0.02;
const SMOOTH_BOUNDARY = 0.35;

/** No-vig bucket for the uncertainty floor. Last bucket includes p = 1. */
function bucketForNovig(pNovig) {
  const p = Number(pNovig);
  for (let i = 0; i < NO_VIG_BUCKETS.length; i += 1) {
    const bucket = NO_VIG_BUCKETS[i];
    const last = i === NO_VIG_BUCKETS.length - 1;
    if (p >= bucket.lo && (last || p < bucket.hi)) return bucket;
  }
  return NO_VIG_BUCKETS[NO_VIG_BUCKETS.length - 1];
}

/**
 * SE and long-shot penalty at pNovig. Hard bucket inside each band.
 * Across 0.35, linear in probability between the two adjacent buckets.
 */
function smoothedNovigStats(pNovig) {
  const bucket = bucketForNovig(pNovig);
  const p = Number(pNovig);
  const idx = NO_VIG_BUCKETS.findIndex((row) => row.hi === SMOOTH_BOUNDARY);
  const left = idx >= 0 ? NO_VIG_BUCKETS[idx] : null;
  const right = left ? NO_VIG_BUCKETS[idx + 1] : null;
  if (!left || !right || !Number.isFinite(p)) {
    return { bucket, se: bucket.se, penalty: bucket.penalty };
  }
  const lo = SMOOTH_BOUNDARY - BOUNDARY_BLEND;
  const hi = SMOOTH_BOUNDARY + BOUNDARY_BLEND;
  if (p < lo || p >= hi) return { bucket, se: bucket.se, penalty: bucket.penalty };
  const t = (p - lo) / (hi - lo);
  return {
    bucket,
    se: left.se + t * (right.se - left.se),
    penalty: left.penalty + t * (right.penalty - left.penalty),
  };
}

/**
 * (pCal - longshot penalty) - pNovig must exceed k * SE.
 * SE and the penalty are the bucket values, blended across 0.35.
 */
function uncertaintyFloor(pCal, pNovig) {
  const smooth = smoothedNovigStats(pNovig);
  const edge = Number(pCal) - Number(pNovig);
  const penalty = smooth.penalty;
  const adjusted = edge - penalty;
  const floor = EDGE_FLOOR_K * smooth.se;
  return {
    bucket: smooth.bucket,
    se: smooth.se,
    edge,
    penalty,
    adjusted,
    floor,
    ok: Number.isFinite(adjusted) && adjusted > floor,
  };
}

/**
 * DraftKings or Hard Rock, on the number the edge was computed on.
 * A missing book is left alone. A posted non-DK/HR book, or a DK/HR quote
 * whose point is a different number, is not a price we can stake.
 */
function placeableReject(candidate) {
  const book = String(candidate && candidate.book || '').toLowerCase();
  if (book && !PLACEABLE_BOOKS.has(book)) return 'no-dk-hr-price';
  const px = candidate && candidate.bestDkHr;
  if (!px || typeof px !== 'object') return null;
  const pxBook = String(px.book || '').toLowerCase();
  const pxAmerican = Number(px.american);
  const pxHasPrice = Number.isFinite(pxAmerican) && pxAmerican !== 0;
  if (pxHasPrice && pxBook && !PLACEABLE_BOOKS.has(pxBook)) return 'no-dk-hr-price';
  if (pxHasPrice && !dkHrLineAgrees(candidate.line, quotePoint(px))) return 'dk-hr-line-mismatch';
  return null;
}

/**
 * Own-price vs Pinnacle fair. Same band and gap as board.js mispairedOwnOdds.
 * A longshot outside (PAIR_SANITY_LO, PAIR_SANITY_HI) is not this reject.
 * opts.fullRange drops that window (force-top3): any |pMkt - implied| past
 * PAIR_SANITY_PP is a mismatch. Flag off never passes fullRange.
 */
function priceFairMismatch(implied, pMkt, opts) {
  if (!pairFixEnabled()) return false;
  if (implied == null || !Number.isFinite(Number(implied))) return false;
  if (!(opts && opts.fullRange) && !(implied > PAIR_SANITY_LO && implied < PAIR_SANITY_HI)) return false;
  const fair = Number(pMkt);
  if (!(fair > 0 && fair < 1)) return false;
  return Math.abs(fair - implied) > PAIR_SANITY_PP;
}

function clampBetProb(p, env) {
  return clampWinProb(p, env);
}

/**
 * Bet probability. Base is the sharp no-vig price when OMEGA_V2_MARKET_P
 * is on (the default), otherwise pCal. The longshot penalty is
 * smoothedNovigStats(pMkt).penalty (~3.3pp below 0.35, 0 above, blended
 * across 0.33–0.37) and is subtracted only when OMEGA_V2_LONGSHOT_ADJ is
 * on. Clamped with clampWinProb: [0.01, 0.99] when OMEGA_V2_P_FLOOR is
 * on (the default), else [0.001, 0.999]. Non-finite stays null.
 * OMEGA_V2_POWER_DEVIG is off by default. When it is on and opts.pMktPower
 * is a real probability, that power no-vig is the bet probability and the
 * longshot trim is skipped.
 */
function forcedBetProb(pCal, pMkt, opts) {
  const env = opts && opts.env;
  const power = Number(opts && opts.pMktPower);
  if (powerDevigEnabled(env) && Number.isFinite(power) && power > 0 && power < 1) {
    return clampBetProb(power, env);
  }
  let p = marketPEnabled(env) ? Number(pMkt) : Number(pCal);
  if (longshotAdjEnabled(env)) {
    const penalty = smoothedNovigStats(pMkt).penalty;
    if (Number.isFinite(penalty)) p -= penalty;
  }
  return clampBetProb(p, env);
}

/** American price shorter than -300. -300 itself is in band. */
function favoriteOutOfBand(row) {
  const odds = Number(row && row.odds);
  return Number.isFinite(odds) && odds < FAV_CAP_AMERICAN;
}

/**
 * Formula price band. Longer than +400 or shorter than -300 is out.
 * +400 and -300 stay. This is a hard drop, not a favorite-cap fill.
 */
function priceOutOfBand(row) {
  const odds = Number(row && row.odds);
  if (!Number.isFinite(odds) || odds === 0) return false;
  if (odds > FORMULA_DOG_CAP_AMERICAN) return true;
  return odds < FAV_CAP_AMERICAN;
}

function projectionOf(row) {
  if (!row || row.modelProjection == null || row.modelProjection === '') return null;
  const value = Number(row.modelProjection);
  if (!Number.isFinite(value)) return null;
  const market = String(row.market || row.marketFamily || '');
  const kind = /total/i.test(market) ? 'total' : 'margin';
  return { kind, value, method: row.projMethod || null };
}

function formulaEvRankOf(row) {
  const ranked = Number(row && row.evRank);
  if (Number.isFinite(ranked)) return ranked;
  const ev = Number(row && row.ev);
  return Number.isFinite(ev) ? ev : -Infinity;
}

function compareFormulaRank(a, b) {
  const ev = formulaEvRankOf(b) - formulaEvRankOf(a);
  if (ev) return ev;
  const edge = finiteRank(b && b.edge) - finiteRank(a && a.edge);
  if (edge) return edge;
  return String(a && a.pick).localeCompare(String(b && b.pick));
}

function rowGameKey(row) {
  if (row && row.gameKey != null && row.gameKey !== '') return String(row.gameKey);
  return gameKey(row && row.matchup);
}

/**
 * One side per game, best EV_rank first.
 * Qualified rows only. The sport cap is applied later, and only to the
 * published three. A missing qualified flag stays out of this pool.
 */
function formulaPool(annotated, opts) {
  const asOfMs = pregameClockMs(opts);
  const rows = rankPool(annotated, opts)
    .filter((c) => c && c.qualified !== false && !pastPregameCutoff(c.commenceTime, asOfMs));
  const best = new Map();
  for (const c of rows) {
    const key = rowGameKey(c);
    const prev = best.get(key);
    if (!prev || compareFormulaRank(c, prev) < 0) best.set(key, c);
  }
  return [...best.values()].sort(compareFormulaRank);
}

/**
 * At most 2 straights from one sport when any other sport still has a
 * side with EV_rank >= 0. Otherwise fill the card in EV_rank order.
 */
function applySportCap(list, limit) {
  const out = [];
  const counts = {};
  const used = new Set();
  for (const c of list || []) {
    if (out.length >= limit) break;
    const key = rowGameKey(c);
    if (used.has(key)) continue;
    const sport = canonSport(c.sport);
    if ((counts[sport] || 0) >= 2) {
      const other = (list || []).some((r) => {
        const rk = rowGameKey(r);
        if (used.has(rk)) return false;
        if (canonSport(r.sport) === sport) return false;
        return formulaEvRankOf(r) >= 0;
      });
      if (other) continue;
    }
    used.add(key);
    counts[sport] = (counts[sport] || 0) + 1;
    out.push({ ...c, forced: true });
  }
  return out;
}

function selectFormulaTop3(annotated, opts) {
  const pool = formulaPool(annotated, opts);
  const env = opts && opts.env;
  if (sportCapEnabled(env)) return applySportCap(pool, MAX_STRAIGHTS);
  return pool.slice(0, MAX_STRAIGHTS).map((c) => ({ ...c, forced: true }));
}

function unclampedFormulaP(pPin, pModel, w) {
  if (!(w > 0) || pModel == null) return pPin;
  const a = logit(pPin);
  const b = logit(pModel);
  if (a == null || b == null) return null;
  return logistic(((1 - w) * a) + (w * b));
}

/**
 * One probability for the printed win rate, the edge, the EV, the letter,
 * the rank, and the stake. No longshot trim on top of the power de-vig.
 * A side with no projection keeps p_pin and ranks on EV_rank = EV - 0.01.
 */
function applyFormulaBet(row, candidate, opts, ctx) {
  const env = opts && opts.env;
  let reason = ctx.straightReject;
  if (reason === 'edge-over-10pp') {
    reason = priceFairMismatch(ctx.implied, ctx.pMkt, { fullRange: true }) ? 'price-fair-mismatch' : null;
  }
  const band = priceOutOfBand(row);
  if (band && (reason == null || reason === 'price-fair-mismatch' || reason === 'edge-over-10pp')) {
    reason = 'price-band';
  }
  const pPin = Number.isFinite(Number(ctx.pMkt)) ? Number(ctx.pMkt) : null;
  const pModel = formulaModelProb(candidate, ctx.origPMkt);
  const w = pModel == null ? 0 : formulaBlendWeight(candidate.sport, env);
  const pFinal = pPin == null ? null : blendProb(pPin, pModel, w, env);
  if (reason == null && pFinal == null) reason = 'no-calibration';
  const dec = ctx.dec;
  const priceImplied = dec > 1 ? (1 / dec) : ctx.implied;
  const priceEdge = pFinal == null ? null : (pFinal - priceImplied);
  if (reason == null && priceEdge != null && priceEdge > MAX_EDGE) reason = 'price-edge-over-10pp';
  const priceEv = pFinal == null || !(dec > 1) ? null : (pFinal * dec - 1);
  const modelless = pModel == null;
  const evRank = priceEv == null ? null : (priceEv - (modelless ? FORMULA_MODELLESS_HAIRCUT : 0));
  const sharp = candidate && candidate._sharp && candidate._sharp.formula;
  const rawP = unclampedFormulaP(pPin, pModel, w);
  const pFloor = rawP != null && pFinal != null && Math.abs(rawP - pFinal) > 1e-9;
  const trace = {
    projection: projectionOf(candidate),
    p_model: pModel,
    p_pin: pPin,
    p_pin_method: sharp ? (sharp.method || 'pinnacle-power') : 'stored',
    w,
    p_final: pFinal,
    implied: priceImplied,
    decimal: dec,
    edge: priceEdge,
    ev: priceEv,
    evRank,
    discounts: {
      longshotTrim: false,
      pFloor,
      lineConversion: sharp && sharp.converted ? {
        fromPoint: sharp.fromPoint,
        toPoint: sharp.toPoint,
        sigma: sharp.sigma,
        distance: sharp.distance,
        method: sharp.method || null,
      } : null,
      priceBand: band ? 'price-band' : null,
      favCap: false,
      movedAgainst: false,
      modellessHaircut: modelless ? FORMULA_MODELLESS_HAIRCUT : 0,
      pushQ: sharp && sharp.pushQ ? sharp.pushQ : 0,
    },
    qualified: reason == null,
    rejectReason: reason,
  };
  return {
    ...row,
    implied: priceImplied,
    decimal: dec,
    pBet: pFinal,
    pPinnacle: pPin,
    pModelBlend: pModel,
    pBlend: pFinal,
    blendW: w,
    blendApplied: true,
    formulaApplied: true,
    breakeven: priceImplied,
    edge: priceEdge,
    ev: priceEv,
    evRank,
    longshotPenalty: 0,
    forced: true,
    forcePlaceable: reason == null,
    qualified: reason == null,
    parlayQualified: reason == null,
    rejectReason: reason,
    _formulaTrace: trace,
  };
}

/**
 * Straight gates.
 * Flag off: positive no-vig edge, positive EV at the DK/HR price, under the
 * miscalibration cap, and clear of k*SE in its no-vig bucket. Parlay
 * qualification is that no-vig screen. usableLegs also requires a positive
 * price EV. Nothing is added to fill a slot.
 * Flag on (force top 3): placeable DK/HR price, a real calibration, the 10pp
 * screen on edgeNovig, the price-fair mismatch guard over the full
 * probability range, and a 10pp screen on the price edge (pBet - implied).
 * Those screens stay on pCal - pMkt and on pBet - implied. They do not
 * switch when the bet probability uses the market price. pBet is the
 * market no-vig (or pCal, when that flag is off) minus the longshot
 * penalty. edge and ev are at pBet versus the DK/HR price. pModelCal
 * keeps the calibrated probability for audit. edgeNovig stays pCal - pMkt.
 * Rank is quarter-Kelly expected log growth at that pBet, not raw EV,
 * unless OMEGA_V2_BLEND_P is on. Then each band ranks by price EV.
 * Negative EV and the uncertainty floor do not remove the row.
 */
function annotateCandidate(candidate, opts) {
  const force = forceTop3From(opts);
  const origPMkt = candidate && candidate.calibration ? candidate.calibration.pMkt : null;
  const prep = applySharpPrep(candidate, opts);
  if (prep && prep.rejectReason) {
    const dropped = {
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: prep.rejectReason,
      ...(prep.lineMovePinn ? { lineMovePinn: prep.lineMovePinn } : {}),
      ...(force ? { forced: true, forcePlaceable: false } : {}),
    };
    if (force && webetaiFormulaEnabled(opts && opts.env)) {
      const moved = prep.rejectReason === 'pinnacle-moved-against';
      dropped.formulaApplied = true;
      dropped._formulaTrace = {
        projection: projectionOf(candidate),
        p_model: formulaModelProb(candidate, origPMkt),
        p_pin: null,
        p_pin_method: null,
        w: null,
        p_final: null,
        implied: null,
        edge: null,
        ev: null,
        evRank: null,
        discounts: {
          longshotTrim: false,
          pFloor: false,
          lineConversion: null,
          priceBand: null,
          favCap: false,
          movedAgainst: moved,
          noPinnacleFair: prep.rejectReason === 'no-pinnacle-fair',
          modellessHaircut: 0,
          pushQ: 0,
        },
        qualified: false,
        rejectReason: prep.rejectReason,
      };
    }
    return dropped;
  }
  if (prep && prep.candidate) candidate = prep.candidate;
  const finish = (row) => applySharpFinish(row, candidate, opts);
  const cal = candidate.calibration;
  if (!cal) {
    return finish({
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: 'no-calibration',
      ...(force ? { forced: true, forcePlaceable: false } : {}),
    });
  }
  const implied = americanToImplied(candidate.odds);
  const dec = americanToDecimal(candidate.odds);
  const pMkt = Number(cal.pMkt);
  if (implied == null || dec == null || !Number.isFinite(pMkt)) {
    return finish({
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: 'bad-price',
      ...(force ? { forced: true, forcePlaceable: false } : {}),
    });
  }
  const edge = cal.pCal - implied;
  // Both edges use the final map. The 10pp screen does not see the raw
  // model-minus-fair gap, and it does see an edge the map just created.
  const edgeNovig = cal.pCal - pMkt;
  const gate = uncertaintyFloor(cal.pCal, pMkt);
  const ev = evAtOdds(cal.pCal, candidate.odds);
  // Rank on the no-vig shrink, not on a later Platt lift, when the flag is
  // off. pShrink is the shipped shrink (calibrate.js). Missing pShrink
  // falls back to pCal. Flag-on rank is quarter-Kelly growth at pBet.
  const pShrink = Number.isFinite(Number(cal.pShrink)) ? Number(cal.pShrink) : Number(cal.pCal);
  const evShrink = evAtOdds(pShrink, candidate.odds);
  const bookReject = placeableReject(candidate);
  let rejectReason = null;
  if (bookReject) rejectReason = bookReject;
  else if (force) {
    if (!Number.isFinite(Number(cal.pCal)) || !Number.isFinite(edgeNovig)) rejectReason = 'no-calibration';
    else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
    else if (priceFairMismatch(implied, pMkt, { fullRange: true })) rejectReason = 'price-fair-mismatch';
  } else if (!(edgeNovig > 0)) rejectReason = 'novig-edge-not-positive';
  else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
  else if (!gate.ok) rejectReason = 'edge-below-uncertainty-floor';
  const straightReject = force
    ? rejectReason
    : (rejectReason || (!(edge > 0) || !(ev > 0) ? 'price-edge-not-positive' : null));
  const row = {
    ...candidate,
    implied,
    decimal: dec,
    edge,
    edgeNovig,
    edgeFloor: gate.floor,
    longshotPenalty: gate.penalty,
    ev,
    evShrink,
    pModelCal: cal.pCal,
    qualified: straightReject == null,
    parlayQualified: force ? straightReject == null : rejectReason == null,
    rejectReason: straightReject,
  };
  if (!force) return finish(row);
  const env = opts && opts.env;
  if (webetaiFormulaEnabled(env)) {
    return finish(applyFormulaBet(row, candidate, opts, {
      origPMkt,
      implied,
      dec,
      pMkt,
      straightReject,
    }));
  }
  const probOpts = {
    ...(opts || {}),
    pMktPower: candidate.pMktPower != null ? candidate.pMktPower : (opts && opts.pMktPower),
  };
  let pBet;
  let pPinnacle = null;
  let pModelBlend = null;
  let blendW = null;
  let blendApplied = false;
  if (blendPEnabled(env)) {
    const power = Number(probOpts.pMktPower);
    const usePower = powerDevigEnabled(env) && Number.isFinite(power) && power > 0 && power < 1;
    const base = usePower ? power : (marketPEnabled(env) ? Number(pMkt) : Number(cal.pCal));
    pPinnacle = Number.isFinite(base) ? base : null;
    let pPin = base;
    if (!usePower && blendTrimEnabled(env)) {
      const penalty = smoothedNovigStats(pMkt).penalty;
      if (Number.isFinite(penalty)) pPin -= penalty;
    }
    pPin = clampBetProb(pPin, env);
    pModelBlend = modelProbForBlend(candidate, origPMkt);
    blendW = pModelBlend == null ? 0 : blendWeightFor(candidate.sport, env);
    pBet = pPin == null ? null : blendProb(pPin, pModelBlend, blendW, env);
    blendApplied = true;
  } else {
    pBet = forcedBetProb(cal.pCal, pMkt, probOpts);
  }
  let reason = straightReject;
  if (reason == null && pBet == null) reason = 'no-calibration';
  const priceEdge = pBet == null ? edge : pBet - implied;
  // Full-range pair check is above. This is the price edge, not edgeNovig.
  if (reason == null && pBet != null && (pBet - implied) > MAX_EDGE) reason = 'price-edge-over-10pp';
  const priceEv = pBet == null ? ev : (pBet * dec - 1);
  const forcePlaceable = reason == null;
  const finished = finish({
    ...row,
    pBet,
    edge: priceEdge,
    ev: priceEv,
    forced: true,
    forcePlaceable,
    qualified: forcePlaceable,
    parlayQualified: forcePlaceable,
    rejectReason: reason,
    ...(blendApplied ? {
      blendApplied: true,
      pPinnacle,
      pModelBlend,
      pBlend: pBet,
      blendW,
      breakeven: implied,
    } : {}),
  });
  if (finished && finished.blendApplied && finished.pBet != null) finished.pBlend = finished.pBet;
  return finished;
}

/** Price EV after the no-vig shrink. Callers that only stored `ev` keep that order. */
function rankEv(row) {
  const shrunk = Number(row && row.evShrink);
  if (Number.isFinite(shrunk)) return shrunk;
  const ev = Number(row && row.ev);
  return Number.isFinite(ev) ? ev : -Infinity;
}

function finiteRank(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : -Infinity;
}

/**
 * Expected log growth of a quarter-Kelly stake.
 * b = decimal - 1, full = (b*p - (1-p)) / b, f = KELLY_FRACTION * full.
 * Null when full Kelly is not positive or the inputs are not a real price.
 */
function kellyGrowth(p, decimal) {
  const prob = Number(p);
  const d = Number(decimal);
  if (!Number.isFinite(prob) || !Number.isFinite(d)) return null;
  const b = d - 1;
  if (!(b > 0)) return null;
  const full = (b * prob - (1 - prob)) / b;
  if (!(full > 0)) return null;
  const f = KELLY_FRACTION * full;
  const growth = prob * Math.log(1 + f * b) + (1 - prob) * Math.log(1 - f);
  return Number.isFinite(growth) ? growth : null;
}

/** Stored-fair fallback. A Pinnacle/Circa fair sorts strictly ahead of it. */
function storedFairFallback(row) {
  return !!(row && row.noSharpFair === true);
}

/**
 * Positive growth first (desc), then null growth by price EV (desc).
 * Ties break on edge, then pick name.
 * A stored-fair fallback sorts after every sharp-fair row.
 */
function compareForcedGrowth(a, b) {
  const aFall = storedFairFallback(a);
  const bFall = storedFairFallback(b);
  if (aFall !== bFall) return aFall ? 1 : -1;
  const ag = a.kellyGrowth;
  const bg = b.kellyGrowth;
  const aHas = ag != null;
  const bHas = bg != null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bg !== ag) return bg > ag ? 1 : -1;
  if (!aHas) {
    const ev = finiteRank(b.ev) - finiteRank(a.ev);
    if (ev) return ev;
    const aStale = a.staleSoft === true;
    const bStale = b.staleSoft === true;
    if (aStale !== bStale) return aStale ? -1 : 1;
  }
  return (finiteRank(b.edge) - finiteRank(a.edge))
    || String(a.pick).localeCompare(String(b.pick));
}

/**
 * Price EV desc (p * decimal - 1), then the stale-soft tie-break, then edge,
 * then pick name. A stored row.ev is used only when the price EV is missing.
 * A stored-fair fallback still sorts after every sharp-fair row.
 * Used inside each band when OMEGA_V2_BLEND_P is on.
 */
/**
 * Probability the rank and the +EV tier use.
 * Flag off is pBet, which already includes the longshot haircut.
 * Flag on is the pre-penalty win probability: pPinnacle, else pMkt, else pCal.
 */
function rankProb(row, env) {
  if (!rawEvRankEnabled(env)) return row && row.pBet;
  const pin = Number(row && row.pPinnacle);
  if (Number.isFinite(pin)) return pin;
  const cal = row && row.calibration;
  const pMkt = Number(cal && cal.pMkt);
  if (Number.isFinite(pMkt)) return pMkt;
  const pCal = Number(cal && cal.pCal);
  if (Number.isFinite(pCal)) return pCal;
  return row && row.pBet;
}

function compareForcedEv(a, b, env) {
  const aFall = storedFairFallback(a);
  const bFall = storedFairFallback(b);
  if (aFall !== bFall) return aFall ? 1 : -1;
  const aEv = betPriceEv(rankProb(a, env), a && a.decimal);
  const bEv = betPriceEv(rankProb(b, env), b && b.decimal);
  const ev = finiteRank(bEv != null ? bEv : b.ev) - finiteRank(aEv != null ? aEv : a.ev);
  if (ev) return ev;
  const aStale = a.staleSoft === true;
  const bStale = b.staleSoft === true;
  if (aStale !== bStale) return aStale ? -1 : 1;
  return (finiteRank(b.edge) - finiteRank(a.edge))
    || String(a.pick).localeCompare(String(b.pick));
}

/**
 * Positive price EV first, then the American price closest to the -300
 * cap (smaller absolute price), then higher quarter-Kelly growth
 * (null last), then pick name.
 * A stored-fair fallback sorts after every sharp-fair row.
 */
function compareFavFill(a, b) {
  const aFall = storedFairFallback(a);
  const bFall = storedFairFallback(b);
  if (aFall !== bFall) return aFall ? 1 : -1;
  const aPos = Number(a.ev) > 0;
  const bPos = Number(b.ev) > 0;
  if (aPos !== bPos) return aPos ? -1 : 1;
  const ad = Math.abs(Number(a.odds));
  const bd = Math.abs(Number(b.odds));
  if (Number.isFinite(ad) && Number.isFinite(bd) && ad !== bd) return ad - bd;
  const ag = a.kellyGrowth;
  const bg = b.kellyGrowth;
  const aHas = ag != null;
  const bHas = bg != null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bg !== ag) return bg > ag ? 1 : -1;
  return String(a.pick).localeCompare(String(b.pick));
}

/**
 * Price EV on the probability and decimal the rank uses: p * decimal - 1.
 * That is the +EV tier. It is not row.ev. An annotated force row stores
 * p*(decimal-1)-(1-p), which matches in real math, and a push haircut only
 * scales that stored EV. At a fair price the two expressions can differ by
 * one ulp (stored ev about +1e-16 while p*decimal-1 is 0) and the log growth
 * can come back as 0 rather than null. A stored pool row can also carry a
 * pCal EV or a printed EV next to a different pBet, so growth and row.ev
 * can disagree in sign. Neither of those is the tier key.
 */
function betPriceEv(pBet, decimal) {
  const p = Number(pBet);
  const d = Number(decimal);
  if (!Number.isFinite(p) || !Number.isFinite(d) || !(d > 1)) return null;
  return p * d - 1;
}

function splitBetEv(list, env) {
  const pos = [];
  const rest = [];
  for (const row of list || []) {
    const ev = betPriceEv(rankProb(row, env), row && row.decimal);
    if (ev != null && ev > 0) pos.push(row);
    else rest.push(row);
  }
  return { pos, rest };
}

/**
 * a2b6bb1 packs, in order: in-band sharp, out-of-band sharp, in-band
 * stored-fair, out-of-band stored-fair. Out-of-band packs are omitted when
 * the cap is off, which leaves the unsplit rank.
 * OMEGA_V2_EV_FIRST, with the cap on, runs that same pack order on price-EV
 * > 0 and then again on the rest. A +EV favorite shorter than -300 beats an
 * in-band 0% or negative-EV filler. A -EV favorite does not. Inside each EV
 * class, sharp-fair rows still come before stored-fair fallbacks.
 * OMEGA_V2_EV_FIRST_CAPPED, with the cap on, keeps every in-band row ahead
 * of every out-of-band row. In-band order is +EV sharp, +EV stored-fair,
 * EV<=0 sharp, EV<=0 stored-fair, using the same price-EV split and the
 * same within-class order. Out-of-band rows stay in the existing favCapFill
 * order and are reached only after the in-band rows. CAPPED ignores
 * EV_FIRST. Cap off leaves the unsplit rank, so both flags are a no-op.
 */
function forcedPacks(inFair, outFair, cap, evFirst, evFirstCapped, env) {
  const base = [
    [inFair.sharp, false],
    [outFair.sharp, true],
    [inFair.fallback, false],
    [outFair.fallback, true],
  ];
  const packs = [];
  const push = (rows, fill) => {
    if (fill && !cap) return;
    packs.push({ rows: rows || [], fill: !!(fill && cap) });
  };
  if (evFirstCapped && cap) {
    const inSharp = splitBetEv(inFair.sharp, env);
    const inFall = splitBetEv(inFair.fallback, env);
    push(inSharp.pos, false);
    push(inFall.pos, false);
    push(inSharp.rest, false);
    push(inFall.rest, false);
    push(outFair.sharp, true);
    push(outFair.fallback, true);
    return packs;
  }
  if (!(evFirst && cap)) {
    for (const [rows, fill] of base) push(rows, fill);
    return packs;
  }
  const halves = base.map(([rows, fill]) => ({ split: splitBetEv(rows, env), fill }));
  for (const half of halves) push(half.split.pos, half.fill);
  for (const half of halves) push(half.split.rest, half.fill);
  return packs;
}

function takePacks(packs, limit) {
  const out = [];
  const used = new Set();
  for (const pack of packs) {
    for (const c of pack.rows) {
      if (out.length >= limit) return out;
      const key = c.gameKey != null && c.gameKey !== '' ? c.gameKey : gameKey(c.matchup);
      if (used.has(key)) continue;
      used.add(key);
      const row = { ...c, forced: true };
      if (pack.fill) row.favCapFill = true;
      out.push(row);
    }
  }
  return out;
}

function concatPacks(packs) {
  const out = [];
  for (const pack of packs) {
    for (const row of pack.rows) out.push(row);
  }
  return out;
}

/**
 * Top 3 placeable straights by quarter-Kelly expected log growth, one per game.
 * Growth uses pBet and the decimal price. full Kelly <= 0 stores null and
 * ranks after every positive-growth row, by price EV. Pregame cutoff still applies.
 * With the favorite cap on, prices shorter than -300 are out of band. In-band
 * rows fill the card first. Out-of-band rows fill empty slots only, one per
 * game, and those rows are marked favCapFill. Cap off is the unsplit rank.
 * Stored-fair fallbacks fill only after every sharp-fair row in both bands,
 * so a fallback takes a slot only when fewer than 3 sharp-fair rows exist.
 * OMEGA_V2_EV_FIRST keeps that sharp-before-fallback pack order inside the
 * +EV class and again inside the EV<=0 class, so only a +EV short favorite
 * jumps an in-band filler.
 * OMEGA_V2_EV_FIRST_CAPPED does not. Every in-band row, including an EV<=0
 * filler and a stored-fair fallback, stays ahead of any shorter-than--300
 * price. A +EV stored-fair row still ranks ahead of an in-band EV<=0 sharp.
 */
function bySharpFair(list) {
  const sharp = [];
  const fallback = [];
  for (const row of list || []) {
    if (storedFairFallback(row)) fallback.push(row);
    else sharp.push(row);
  }
  return { sharp, fallback };
}

/** Positive growth only. A non-positive row stays null so it cannot jump +EV. */
function growthForRank(row, pBet, decimal) {
  const g = kellyGrowth(pBet, decimal);
  if (g == null || !row || row.staleSoft !== true) return g;
  return g + 1e-6;
}

function selectForcedTop3(annotated, opts) {
  if (webetaiFormulaEnabled(opts && opts.env)) return selectFormulaTop3(annotated, opts);
  const asOfMs = pregameClockMs(opts);
  const env = opts && opts.env;
  const cap = favCapEnabled(env);
  const ranked = rankPool(annotated, opts)
    .filter((c) => c && c.qualified && !pastPregameCutoff(c.commenceTime, asOfMs))
    .map((c) => ({ ...c, kellyGrowth: growthForRank(c, c.pBet, c.decimal) }));
  const inBand = [];
  const outBand = [];
  for (const c of ranked) {
    if (cap && favoriteOutOfBand(c)) outBand.push(c);
    else inBand.push(c);
  }
  const byEv = blendPEnabled(env);
  const byPrice = (a, b) => compareForcedEv(a, b, env);
  inBand.sort(byEv ? byPrice : compareForcedGrowth);
  if (cap) outBand.sort(byEv ? byPrice : compareFavFill);
  const inFair = bySharpFair(inBand);
  const outFair = bySharpFair(outBand);
  const evFirst = evFirstEnabled(env);
  const evFirstCapped = evFirstCappedEnabled(env);
  return takePacks(forcedPacks(inFair, outFair, cap, evFirst, evFirstCapped, env), MAX_STRAIGHTS);
}

/**
 * Full v2 order for a stored qualified pool. Same split as selectForcedTop3:
 * in-band sharp, then out-of-band sharp, then stored-fair fallbacks in that
 * same band order. OMEGA_V2_EV_FIRST runs that order on +EV rows first.
 * OMEGA_V2_EV_FIRST_CAPPED lists every in-band row first.
 * News re-rank refills from this list. Does not slice to 3.
 * A missing `qualified` stays in (the pool is already the qualified set).
 * `qualified: false` stays out. The -300 cap is favCapEnabled.
 */
function orderForcedPool(annotated, opts) {
  if (webetaiFormulaEnabled(opts && opts.env)) return formulaPool(annotated, opts);
  const asOfMs = pregameClockMs(opts);
  const env = opts && opts.env;
  const cap = favCapEnabled(env);
  const ranked = rankPool(annotated, opts)
    .filter((c) => c && c.qualified !== false && !pastPregameCutoff(c.commenceTime, asOfMs))
    .map((c) => {
      const decimal = c.decimal || americanToDecimal(c.odds);
      const pBet = c.pBet != null ? c.pBet : (c.calibration && c.calibration.pCal);
      return { ...c, decimal, pBet, kellyGrowth: growthForRank(c, pBet, decimal) };
    });
  const inBand = [];
  const outBand = [];
  for (const c of ranked) {
    if (cap && favoriteOutOfBand(c)) outBand.push(c);
    else inBand.push(c);
  }
  const byEv = blendPEnabled(env);
  const byPrice = (a, b) => compareForcedEv(a, b, env);
  inBand.sort(byEv ? byPrice : compareForcedGrowth);
  if (cap) outBand.sort(byEv ? byPrice : compareFavFill);
  const inFair = bySharpFair(inBand);
  const outFair = bySharpFair(outBand);
  const evFirst = evFirstEnabled(env);
  const evFirstCapped = evFirstCappedEnabled(env);
  return concatPacks(forcedPacks(inFair, outFair, cap, evFirst, evFirstCapped, env));
}

/**
 * Debug trace for a dry run. Not copied onto a published pick.
 * Best 3 qualified sides per sport, plus the global EV_rank.
 * A side with no p_model is ranked on EV_rank = EV - 0.01.
 */
function buildDebugTrace(annotated, selected, opts) {
  const formula = webetaiFormulaEnabled(opts && opts.env);
  const pool = formula
    ? formulaPool(annotated, opts)
    : orderForcedPool(annotated, opts);
  const rankOf = new Map();
  pool.forEach((row, i) => { rankOf.set(row, i + 1); });
  const selectedIds = new Set((selected || []).map((row) => {
    const pick = String(row && (row.pick || row.side) || '').toLowerCase();
    return `${rowGameKey(row)}|${pick}`;
  }));
  const drops = {};
  for (const row of annotated || []) {
    if (!row || row.qualified) continue;
    const reason = row.rejectReason || 'not-qualified';
    drops[reason] = (drops[reason] || 0) + 1;
  }
  const traced = pool.map((row) => {
    const base = row && row._formulaTrace ? { ...row._formulaTrace } : {
      projection: projectionOf(row),
      p_model: row && row.pModelBlend != null ? row.pModelBlend : null,
      p_pin: row && row.calibration ? row.calibration.pMkt : null,
      p_pin_method: row && row.pPinnacle != null ? 'stored' : null,
      w: row && row.blendW != null ? row.blendW : null,
      p_final: row && row.pBet != null ? row.pBet : null,
      implied: row && row.implied != null ? row.implied : null,
      edge: row && row.edge != null ? row.edge : null,
      ev: row && row.ev != null ? row.ev : null,
      evRank: formulaEvRankOf(row),
      discounts: {
        longshotTrim: !(row && row.formulaApplied),
        pFloor: false,
        lineConversion: null,
        priceBand: null,
        favCap: !!(row && row.favCapFill),
        movedAgainst: row && row.rejectReason === 'pinnacle-moved-against',
        modellessHaircut: row && row.formulaApplied ? 0 : 0,
        pushQ: row && row.pushQ ? row.pushQ : 0,
      },
      qualified: !!(row && row.qualified),
      rejectReason: row && row.rejectReason || null,
    };
    if (base.discounts && row && row.formulaApplied && row.pModelBlend == null) {
      base.discounts = { ...base.discounts, modellessHaircut: FORMULA_MODELLESS_HAIRCUT };
    }
    const id = `${rowGameKey(row)}|${String(row.pick || '').toLowerCase()}`;
    return {
      sport: canonSport(row.sport),
      matchup: row.matchup || null,
      pick: row.pick || null,
      market: row.market || null,
      odds: row.odds != null ? row.odds : null,
      book: row.book || null,
      ...base,
      finalRank: rankOf.get(row) || null,
      selected: selectedIds.has(id),
    };
  });
  const bestBySport = {};
  for (const row of traced) {
    const sport = row.sport || 'OTHER';
    if (!bestBySport[sport]) bestBySport[sport] = [];
    if (bestBySport[sport].length < 3) bestBySport[sport].push(row);
  }
  return {
    formula,
    modellessHaircut: FORMULA_MODELLESS_HAIRCUT,
    note: 'A side with no p_model uses p_pin. Its rank value is EV_rank = EV - 0.01 so a model-less sport is not favoured on a price gap.',
    bestBySport,
    pool: traced,
    drops,
  };
}

function selectStraights(annotated, opts) {
  if (forceTop3From(opts)) return selectForcedTop3(annotated, opts);
  const asOfMs = pregameClockMs(opts);
  const ranked = rankPool(annotated, opts)
    .filter((c) => c.qualified && !pastPregameCutoff(c.commenceTime, asOfMs))
    .sort((a, b) => (rankEv(b) - rankEv(a)) || (b.edge - a.edge) || String(a.pick).localeCompare(String(b.pick)));
  const out = [];
  const used = new Set();
  for (const c of ranked) {
    if (out.length >= MAX_STRAIGHTS) break;
    if (used.has(c.gameKey)) continue;
    used.add(c.gameKey);
    out.push(c);
  }
  return out;
}

module.exports = {
  normTeam,
  gameKey,
  marketFamily,
  totalSide,
  bucketForNovig,
  smoothedNovigStats,
  uncertaintyFloor,
  BOUNDARY_BLEND,
  rankEv,
  kellyGrowth,
  forcedBetProb,
  favoriteOutOfBand,
  priceOutOfBand,
  formulaEvRankOf,
  buildDebugTrace,
  annotateCandidate: (candidate, opts) => applyStatusVeto(annotateCandidate(candidate, opts), opts),
  selectStraights,
  selectForcedTop3,
  orderForcedPool,
  PREGAME_GRACE_MS,
  pregameClockMs,
  pastPregameCutoff,
};
