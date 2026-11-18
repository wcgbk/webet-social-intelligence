'use strict';

/**
 * Line-aware closing value for spreads and totals.
 *
 * The stored close price is the anchor book's number. Comparing it to the
 * bet price when those numbers differ scores a different bet. This module
 * moves the close no-vig onto the bet's number, or drops the row when the
 * move is a side flip or past the sport cap.
 *
 * NFL and NCAAF use the push tables in key_convert.js (same half-point
 * step). NBA, NCAAM, NHL, and MLB totals, plus NBA and NCAAM spreads, use
 * a normal shift. Sigmas are the shared sport tables, except NBA totals,
 * which use the residual the NBA engine actually prices with.
 *
 * Flag OMEGA_CLV_LINE_ADJ defaults on. off / 0 / false leaves the record
 * untouched so the previous comparison comes back exactly.
 */

const { defaultOnFlag, clvLineMatchEnabled } = require('./default_on_flag');
const { sportOf, marketOf, convertCoverProb } = require('./omega-v2/key_convert');
const { SPORT_SPREAD_STD, SPORT_TOTAL_STD } = require('./omega-vnext/config');
const { normCdf } = require('./omega-vnext/odds_math');
const { gradePowerClv } = require('./omega-vnext/clv_grade');

const LINE_EPS = 1e-6;

function lineAdjEnabled(env) {
  return defaultOnFlag('OMEGA_CLV_LINE_ADJ', env);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundTo(n, places) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return +Number(n).toFixed(places);
}

function normInv(p) {
  const target = Math.min(0.999, Math.max(0.001, Number(p)));
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function sideKind(market, side) {
  if (side && typeof side === 'object') {
    if (side.isUnder) return 'under';
    if (side.isOver) return 'over';
    if (side.marketBase === 'totals') return 'over';
    return marketOf(market) === 'Total' ? 'over' : 'spread';
  }
  if (marketOf(market) === 'Total') {
    return /\bunder\b/i.test(String(side || '')) ? 'under' : 'over';
  }
  return 'spread';
}

/**
 * Positive when the bet's number is easier to cover than the close number.
 * Spreads and unders: a higher number is easier. Overs: a lower number is.
 */
function easeGain(market, side, betLine, closeLine) {
  const diff = betLine - closeLine;
  if (market === 'Total' && side === 'over') return -diff;
  return diff;
}

function sigmaFor(sport, market) {
  if (sport === 'NBA' && market === 'Total') {
    try {
      const sd = Number(require('./omega-vnext/sports/nba').NBA_TOTAL_SD);
      if (sd > 0) return sd;
    } catch (_) { /* shared table */ }
  }
  if (market === 'Total') {
    const sd = Number(SPORT_TOTAL_STD[sport]);
    return sd > 0 ? sd : null;
  }
  const sd = Number(SPORT_SPREAD_STD[sport]);
  return sd > 0 ? sd : null;
}

function usesNormal(sport, market) {
  if (market === 'Total' && (sport === 'NBA' || sport === 'NCAAM' || sport === 'NHL' || sport === 'MLB')) return true;
  if (market === 'Spread' && (sport === 'NBA' || sport === 'NCAAM')) return true;
  return false;
}

function overCap(sport, market, absDiff) {
  if (market === 'Total') return absDiff > 6 + LINE_EPS;
  if (market !== 'Spread') return false;
  if (sport === 'NHL' || sport === 'MLB') return absDiff > LINE_EPS;
  if (sport === 'NBA' || sport === 'NCAAM') return absDiff > 4 + LINE_EPS;
  if (sport === 'NFL' || sport === 'NCAAF') return absDiff > 3.5 + LINE_EPS;
  return absDiff > 3.5 + LINE_EPS;
}

function shiftClose(sport, market, side, closeLine, betLine, p) {
  if (p == null || !(p > 0 && p < 1)) return null;
  if ((sport === 'NFL' || sport === 'NCAAF') && (market === 'Spread' || market === 'Total')) {
    const conv = convertCoverProb({
      sport,
      market,
      side: side === 'over' || side === 'under' ? side : 'spread',
      fromPoint: closeLine,
      toPoint: betLine,
      p,
      maxDist: 6,
    });
    return conv && Number.isFinite(conv.p) ? conv.p : null;
  }
  if (!usesNormal(sport, market)) return null;
  const sigma = sigmaFor(sport, market);
  if (!(sigma > 0)) return null;
  const gain = easeGain(market, side, betLine, closeLine);
  return normCdf(normInv(p) + gain / sigma);
}

function excluded(method, lineDiff, clvRawLine, input) {
  return {
    clv: null,
    clvCents: null,
    beatClosing: null,
    clvMethod: method,
    lineDiff,
    clvRawLine,
    closingNoVig: num(input.closingNoVig),
    pickTimeNoVig: num(input.pickTimeNoVig),
  };
}

/**
 * @returns {object|null} field patch, or null when the flag is off.
 * Null means the caller keeps the line-blind record exactly.
 */
function lineAwareClv(input, env) {
  if (!lineAdjEnabled(env)) return null;
  const src = input || {};
  const sport = sportOf(src.sport);
  const market = marketOf(src.market);
  const betLine = num(src.betLine);
  const closeLine = num(src.closeLine);
  const oldClv = num(src.clv);
  const clvRawLine = roundTo(oldClv, 4);
  const priced = market === 'Spread' || market === 'Total';
  const linesKnown = priced && betLine != null && closeLine != null;
  const moved = linesKnown && Math.abs(betLine - closeLine) > LINE_EPS;
  if (!moved) {
    const clv = roundTo(oldClv, 4);
    return {
      clv,
      clvCents: clv == null ? null : roundTo(clv * 100, 2),
      beatClosing: clv == null ? null : clv > 0,
      clvMethod: 'same-line',
      lineDiff: linesKnown ? 0 : null,
      clvRawLine,
      closingNoVig: num(src.closingNoVig),
      pickTimeNoVig: num(src.pickTimeNoVig),
    };
  }

  const lineDiff = roundTo(closeLine - betLine, 2);
  const alt = src.altQuote;
  if (alt && alt.sideOdds != null && alt.oppOdds != null && src.betOdds != null) {
    const powered = gradePowerClv(src.betOdds, alt.sideOdds, alt.oppOdds);
    if (powered) {
      return {
        clv: powered.clv,
        clvCents: powered.clvCents,
        beatClosing: powered.beatClose,
        clvMethod: 'alt-line',
        lineDiff,
        clvRawLine,
        closingNoVig: powered.closingNoVig,
        pickTimeNoVig: powered.pickTimeNoVig,
        betDevigMethod: 'power',
      };
    }
  }

  if (market === 'Spread' && betLine * closeLine < 0) {
    return excluded('side-flip', lineDiff, clvRawLine, src);
  }
  if (overCap(sport, market, Math.abs(lineDiff))) {
    return excluded('over-cap', lineDiff, clvRawLine, src);
  }

  const side = sideKind(src.market, src.side);
  const shifted = shiftClose(sport, market, side, closeLine, betLine, num(src.closingNoVig));
  if (shifted == null) return excluded('over-cap', lineDiff, clvRawLine, src);
  const closingNoVig = roundTo(shifted, 4);
  const pickNv = num(src.pickTimeNoVig);
  const clv = pickNv == null || closingNoVig == null ? null : roundTo(closingNoVig - pickNv, 4);
  return {
    clv,
    clvCents: clv == null ? null : roundTo(clv * 100, 2),
    beatClosing: clv == null ? null : clv > 0,
    clvMethod: 'converted',
    lineDiff,
    clvRawLine,
    closingNoVig,
    pickTimeNoVig: roundTo(pickNv, 4),
  };
}

function applyToRecord(rec, extra, env) {
  const patch = lineAwareClv({
    sport: extra && extra.sport,
    market: extra && extra.market,
    side: extra && extra.side,
    betLine: extra && extra.betLine,
    closeLine: extra && extra.closeLine != null ? extra.closeLine : (rec && rec.closingLine),
    clv: rec && rec.clv,
    pickTimeNoVig: rec && rec.pickTimeNoVig,
    closingNoVig: rec && rec.closingNoVig,
    altQuote: extra && extra.altQuote,
    betOdds: extra && extra.betOdds,
  }, env);
  if (!patch || !rec) return rec;
  const next = { ...rec };
  next.clv = patch.clv;
  next.clvCents = patch.clvCents;
  next.beatClosing = patch.beatClosing;
  next.clvMethod = patch.clvMethod;
  next.lineDiff = patch.lineDiff;
  next.clvRawLine = patch.clvRawLine;
  if (patch.closingNoVig != null) next.closingNoVig = patch.closingNoVig;
  if (patch.pickTimeNoVig != null) next.pickTimeNoVig = patch.pickTimeNoVig;
  if (patch.betDevigMethod) next.betDevigMethod = patch.betDevigMethod;
  return next;
}

function mismatchRecord(rec) {
  const next = { ...rec };
  next.clv = null;
  next.clvCents = null;
  next.beatClosing = null;
  next.clvReason = 'line-mismatch';
  return next;
}

/**
 * Keep CLV only for an exact line, or for a documented converted / alt-line
 * adjustment that is not a spread side flip. Otherwise null it.
 * Does not run inside applyToRecord: that function stays a no-op when its own flag is off.
 */
function enforceLineMatch(rec, extra, env) {
  if (!clvLineMatchEnabled(env) || !rec) return rec;
  const market = marketOf((extra && extra.market) || rec.market || rec.betType);
  const betLine = num(extra && extra.betLine != null ? extra.betLine : rec.betLine);
  const closeLine = num(extra && extra.closeLine != null ? extra.closeLine : rec.closingLine);
  const priced = market === 'Spread' || market === 'Total' || (betLine != null && closeLine != null);
  if (!priced) return rec;
  if (betLine == null || closeLine == null) return mismatchRecord(rec);
  const signFlip = market === 'Spread' && betLine * closeLine < 0;
  if (!signFlip && Math.abs(betLine - closeLine) <= LINE_EPS) return rec;
  const method = rec.clvMethod;
  const adjusted = !signFlip && rec.clv != null && (method === 'converted' || method === 'alt-line');
  if (adjusted) return rec;
  return mismatchRecord(rec);
}

module.exports = {
  lineAdjEnabled,
  lineAwareClv,
  applyToRecord,
  enforceLineMatch,
  sigmaFor,
  shiftClose,
  overCap,
};
