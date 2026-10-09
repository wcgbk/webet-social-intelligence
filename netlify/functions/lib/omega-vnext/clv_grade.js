'use strict';

/**
 * Realized CLV grade helpers (pure, no network).
 * CLV = noVig(close) − noVig(bet); positive ⇒ beat the close.
 *
 * From CLV_POINT_AWARE_FROM, a moved spread or total is not graded off the
 * new number's price. Prefer the close price at the bet's own point (same
 * sharp book's alternate outcomes). Otherwise shift the closing no-vig
 * through the sport's normal (SPORT_SPREAD_STD / SPORT_TOTAL_STD) using
 * normCdf. No key-number mass. F5 has no std: null CLV, reason point_moved.
 * Card dates before the cutover stay on the price-only formula.
 */
const { normCdf } = require('./odds_math');
const { SPORT_SPREAD_STD, SPORT_TOTAL_STD } = require('./config');
const { clvPointAware } = require('../omega-grading-rules');

/** Points closer than this are the same number (3.5 vs 3.5000001). */
const CLV_POINT_EPS = 1e-6;

function americanToImplied(american) {
  const a = parseInt(american, 10);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

/**
 * @param {number|string} betAmerican
 * @param {number|string} closeAmerican
 * @param {number} overround - market sum of raw implied (e.g. 1.045)
 * @returns {{ clv, clvCents, clvPct, beatClose, pickTimeNoVig, closingNoVig }|null}
 */
function gradeNoVigClv(betAmerican, closeAmerican, overround) {
  const betRaw = americanToImplied(betAmerican);
  const closeRaw = americanToImplied(closeAmerican);
  const ov = Number(overround);
  if (betRaw == null || closeRaw == null || !Number.isFinite(ov) || ov <= 0) return null;
  const pickTimeNoVig = +(betRaw / ov).toFixed(4);
  const closingNoVig = +(closeRaw / ov).toFixed(4);
  const clv = +(closingNoVig - pickTimeNoVig).toFixed(4);
  return {
    clv,
    clvCents: +(clv * 100).toFixed(2),
    clvPct: +(clv * 100).toFixed(4),
    beatClose: clv > 0,
    pickTimeNoVig,
    closingNoVig,
  };
}

/**
 * Published CLV de-vig: side raw implied divided by the sharp-anchor overround.
 * Same rounding track-clv writes on clv-{date} (`+(raw / overround).toFixed(4)`).
 */
function closingNoVigFromRaw(sideRaw, overround) {
  const raw = Number(sideRaw);
  const ov = Number(overround);
  if (!Number.isFinite(raw) || !Number.isFinite(ov) || ov <= 0) return null;
  return +(raw / ov).toFixed(4);
}

/**
 * CLV = closing no-vig − pick-time no-vig. Positive means the close moved toward the side.
 * `clvCents` is that difference times 100, rounded to 2 decimals, matching track-clv.
 */
function pointsEqual(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= CLV_POINT_EPS;
}

function pointsDiffer(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) > CLV_POINT_EPS;
}

/**
 * Inverse of normCdf. Binary search on that approximation (it clamps to
 * 0.001–0.999). Not a textbook probit. A zero point-move maps back to the
 * same rounded probability only up to the search tolerance.
 */
function normInv(p) {
  const target = Math.min(0.999, Math.max(0.001, Number(p)));
  if (!Number.isFinite(target)) return null;
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * How much easier the bet's number is than the close, in points.
 * Spreads and unders: higher number is easier (bet − close).
 * Overs: lower number is easier (close − bet).
 */
function favoredPointDelta(marketBase, isOver, betPoint, closePoint) {
  if (marketBase === 'totals' && isOver) return Number(closePoint) - Number(betPoint);
  return Number(betPoint) - Number(closePoint);
}

function sigmaForMarket(sport, marketBase, isF5) {
  if (isF5) return null;
  const table = marketBase === 'totals' ? SPORT_TOTAL_STD
    : (marketBase === 'spreads' ? SPORT_SPREAD_STD : null);
  if (!table) return null;
  const s = Number(table[sport]);
  if (!Number.isFinite(s) || s <= 0) return null;
  return s;
}

function priceOnlyClv(betRaw, closeRaw, overround, closeAmerican) {
  const ov = Number(overround);
  const closingNoVig = +(closeRaw / ov).toFixed(4);
  const pickTimeNoVig = betRaw != null ? +(betRaw / ov).toFixed(4) : null;
  const clv = pickTimeNoVig != null ? +(closingNoVig - pickTimeNoVig).toFixed(4) : null;
  const clvRaw = (betRaw != null && closeRaw != null) ? +(Number(closeRaw) - Number(betRaw)).toFixed(4) : null;
  return {
    clvMethod: null,
    clvReason: null,
    closingOdds: closeAmerican,
    pickTimeImplied: betRaw != null ? +Number(betRaw).toFixed(4) : null,
    closingImplied: closeRaw != null ? +Number(closeRaw).toFixed(4) : null,
    pickTimeNoVig,
    closingNoVig,
    closingOverround: +ov.toFixed(4),
    betDevigMethod: 'closing-overround',
    clv,
    clvCents: clv != null ? +(clv * 100).toFixed(2) : null,
    clvRaw,
    beatClosing: clv != null ? clv > 0 : null,
  };
}

/**
 * Realized CLV for one pick against one close.
 * betRaw / closeRaw are the handler's implied probabilities (not re-parsed).
 * alt* is the same sharp book's pair at the bet's point, when the snapshot
 * already contains it. Dates before CLV_POINT_AWARE_FROM ignore alts and
 * point moves and return the price-only row (clvMethod null).
 */
function gradeRealizedClv({
  dateISO,
  betRaw,
  closeRaw,
  overround,
  closeAmerican,
  betPoint,
  closePoint,
  sport,
  marketBase,
  isOver,
  isF5,
  altSideRaw,
  altOverround,
  altAmerican,
} = {}) {
  const moved = pointsDiffer(betPoint, closePoint);
  if (!clvPointAware(dateISO) || !moved) {
    return priceOnlyClv(betRaw, closeRaw, overround, closeAmerican);
  }
  const altRaw = Number(altSideRaw);
  const altOv = Number(altOverround);
  if (Number.isFinite(altRaw) && Number.isFinite(altOv) && altOv > 0 && altAmerican != null) {
    const row = priceOnlyClv(betRaw, altRaw, altOv, altAmerican);
    row.clvMethod = 'same-point';
    return row;
  }
  const sigma = sigmaForMarket(sport, marketBase, isF5);
  if (sigma == null) {
    const ov = Number(overround);
    return {
      clvMethod: 'point_moved',
      clvReason: 'point_moved',
      closingOdds: closeAmerican,
      pickTimeImplied: betRaw != null ? +Number(betRaw).toFixed(4) : null,
      closingImplied: closeRaw != null ? +Number(closeRaw).toFixed(4) : null,
      pickTimeNoVig: (betRaw != null && Number.isFinite(ov) && ov > 0) ? +(betRaw / ov).toFixed(4) : null,
      closingNoVig: null,
      closingOverround: Number.isFinite(ov) ? +ov.toFixed(4) : null,
      betDevigMethod: null,
      clv: null,
      clvCents: null,
      clvRaw: null,
      beatClosing: null,
    };
  }
  const base = priceOnlyClv(betRaw, closeRaw, overround, closeAmerican);
  const favoredDelta = favoredPointDelta(marketBase, isOver, betPoint, closePoint);
  const z = normInv(base.closingNoVig);
  const pAtBet = +normCdf(z + favoredDelta / sigma).toFixed(4);
  const clv = base.pickTimeNoVig != null ? +(pAtBet - base.pickTimeNoVig).toFixed(4) : null;
  return {
    ...base,
    clvMethod: 'point-normal',
    closingNoVig: pAtBet,
    betDevigMethod: 'point-normal',
    clv,
    clvCents: clv != null ? +(clv * 100).toFixed(2) : null,
    clvRaw: null,
    beatClosing: clv != null ? clv > 0 : null,
  };
}

function clvFromNoVig(closingNoVig, pickTimeNoVig) {
  if (closingNoVig == null || pickTimeNoVig == null) return null;
  if (!Number.isFinite(closingNoVig) || !Number.isFinite(pickTimeNoVig)) return null;
  const clv = +(closingNoVig - pickTimeNoVig).toFixed(4);
  return {
    clv,
    clvCents: +(clv * 100).toFixed(2),
    beatClose: clv > 0,
    pickTimeNoVig,
    closingNoVig,
  };
}

/** Attach realized-close aliases onto an existing track-clv record (mutates + returns). */
function attachRealizedAliases(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (rec.beatClosing != null && rec.beatClose == null) rec.beatClose = rec.beatClosing;
  if (rec.beatClose != null && rec.beatClosing == null) rec.beatClosing = rec.beatClose;
  if (rec.clv != null && Number.isFinite(rec.clv)) {
    if (rec.clvCents == null) rec.clvCents = +(rec.clv * 100).toFixed(2);
    if (rec.clvPct == null) rec.clvPct = +(rec.clv * 100).toFixed(4);
    if (rec.realizedClvCents == null) rec.realizedClvCents = rec.clvCents;
  }
  if (rec.closeSnapshotAt && !rec.realizedCloseAt) rec.realizedCloseAt = rec.closeSnapshotAt;
  if (rec.anchorBook && !rec.closeBook) rec.closeBook = rec.anchorBook;
  return rec;
}

/**
 * Summarize CLV rows by sport + market (observer artifact).
 * @param {Array} picks - CLV pick records with clv / beatClose
 */
function summarizeBySportMarket(picks, { floorDate = '2026-09-22' } = {}) {
  const bySport = {};
  const byMarket = {};
  let n = 0;
  let clvSum = 0;
  let beats = 0;
  for (const p of picks || []) {
    if (p.date && p.date < floorDate) continue;
    const cents = typeof p.clvCents === 'number' ? p.clvCents
      : (typeof p.realizedClvCents === 'number' ? p.realizedClvCents
        : (typeof p.clv === 'number' ? +(p.clv * 100).toFixed(2) : null));
    if (cents == null || !Number.isFinite(cents)) continue;
    const beat = p.beatClose === true || p.beatClosing === true;
    n++;
    clvSum += cents;
    if (beat) beats++;
    const s = p.sport || 'unknown';
    const m = p.market || p.betType || 'unknown';
    if (!bySport[s]) bySport[s] = { n: 0, clvSum: 0, beats: 0 };
    bySport[s].n++; bySport[s].clvSum += cents; if (beat) bySport[s].beats++;
    if (!byMarket[m]) byMarket[m] = { n: 0, clvSum: 0, beats: 0 };
    byMarket[m].n++; byMarket[m].clvSum += cents; if (beat) byMarket[m].beats++;
  }
  const finalize = (bucket) => {
    const out = {};
    for (const [k, v] of Object.entries(bucket)) {
      const meanCents = v.n ? +((v.clvSum / v.n).toFixed(2)) : null;
      out[k] = {
        n: v.n,
        meanClvCents: meanCents,
        // Probability, not a second copy of the cent figure. 2.0 cents → 0.02.
        meanClvPct: meanCents == null ? null : +(meanCents / 100).toFixed(4),
        beatClosePct: v.n ? +((v.beats / v.n) * 100).toFixed(1) : null,
      };
    }
    return out;
  };
  const meanClvCents = n ? +((clvSum / n).toFixed(2)) : null;
  return {
    n,
    meanClvCents,
    meanClvPct: meanClvCents == null ? null : +(meanClvCents / 100).toFixed(4),
    beatClosePct: n ? +((beats / n) * 100).toFixed(1) : null,
    bySport: finalize(bySport),
    byMarket: finalize(byMarket),
  };
}

/** ISO week key America/New_York: YYYY-Www */
function etIsoWeekKey(d = new Date()) {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay() || 7;
  et.setDate(et.getDate() + 4 - day);
  const yearStart = new Date(et.getFullYear(), 0, 1);
  const week = Math.ceil((((et - yearStart) / 86400000) + 1) / 7);
  return `${et.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isSundayET(d = new Date()) {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getDay() === 0;
}

module.exports = {
  americanToImplied,
  gradeNoVigClv,
  closingNoVigFromRaw,
  clvFromNoVig,
  CLV_POINT_EPS,
  pointsEqual,
  pointsDiffer,
  normInv,
  favoredPointDelta,
  gradeRealizedClv,
  attachRealizedAliases,
  summarizeBySportMarket,
  etIsoWeekKey,
  isSundayET,
};
