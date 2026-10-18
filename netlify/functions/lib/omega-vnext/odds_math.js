'use strict';

const { QUALITY_GRADE } = require('./config');

function americanToImplied(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function formatAmerican(american) {
  const a = Math.round(Number(american));
  if (!Number.isFinite(a)) return '';
  return a > 0 ? `+${a}` : `${a}`;
}

/** Two-way no-vig probabilities from a pair of American prices. */
function noVigTwoWay(a1, a2) {
  const i1 = americanToImplied(a1);
  const i2 = americanToImplied(a2);
  if (i1 == null || i2 == null) return null;
  const s = i1 + i2;
  if (s <= 0) return null;
  return { p1: i1 / s, p2: i2 / s, vig: s - 1 };
}

/** De-vig a list of {side, american} sharing one market. */
function deVigMarket(outcomes) {
  const rows = (outcomes || []).map(o => ({
    ...o,
    implied: americanToImplied(o.american),
  })).filter(o => o.implied != null);
  const sum = rows.reduce((s, r) => s + r.implied, 0);
  if (sum <= 0) return rows;
  return rows.map(r => ({ ...r, fairP: r.implied / sum, vig: sum - 1 }));
}

function evAtOdds(p, american) {
  const dec = americanToDecimal(american);
  if (dec == null || !Number.isFinite(p)) return null;
  return p * dec - 1;
}

/** Fractional Kelly stake as fraction of bankroll (0–1). */
function kellyFraction(p, american, fraction = 0.25) {
  const dec = americanToDecimal(american);
  if (dec == null || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const b = dec - 1;
  if (b <= 0) return 0;
  const q = 1 - p;
  const full = (b * p - q) / b;
  if (full <= 0) return 0;
  return full * fraction;
}

/** Convert Kelly fraction → display units (0.25u steps, min 0.25 when positive). */
function kellyToUnits(kellyFrac, unitCap = 2.0) {
  if (!kellyFrac || kellyFrac <= 0) return 0;
  // Heuristic: 1% bankroll Kelly ≈ 1.0u at $150 unit / ~$15k roll feel
  let u = kellyFrac * 100;
  u = Math.round(u * 4) / 4; // 0.25 steps
  u = Math.max(0.25, Math.min(unitCap, u));
  return u;
}

/**
 * Remapped for ≤3.5u straight budget (v12.0.9): A+ only at ≥1.25u hammers.
 * Previously 1.5u→A+ was too common when each straight capped at 1.5u.
 */
function unitsToRating(u) {
  if (u >= 1.25) return 'aplus';
  if (u >= 1.0) return 'a';
  if (u >= 0.75) return 'aminus';
  if (u >= 0.5) return 'bplus';
  return 'b';
}

function ratingToConfidence(rating) {
  return ({ aplus: 90, a: 82, aminus: 75, bplus: 68, b: 60, lean: 52 })[rating] || 60;
}

/**
 * American juice-ladder delta. Positive means `toAmerican` is a worse price
 * than `fromAmerican`. The +100/−100 gap is one cent, not 200.
 * +105 → −105 is 10. −110 → −130 is 20.
 */
function americanJuiceDelta(fromAmerican, toAmerican) {
  const from = Number(fromAmerican);
  const to = Number(toAmerican);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0 || to === 0) return null;
  const line = (a) => {
    if (a >= 100) return a - 100;
    if (a <= -100) return a + 100;
    return 0;
  };
  return line(from) - line(to);
}

/** Juice-ladder cents the bet beat the close by. Positive = beat. */
function americanCentsDiff(betAmerican, closeAmerican) {
  const delta = americanJuiceDelta(betAmerican, closeAmerican);
  if (delta == null) return null;
  return +delta.toFixed(2);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Standard normal CDF approximation. */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return clamp(p, 0.001, 0.999);
}


/**
 * Honest UI Edge badge value (fraction 0–1): calibrated EV at posted American odds.
 * EV = coverProb * decimal(odds) - 1. Never predictedClv cents, never raw coverProb.
 */
function calibratedEdgeFraction(coverProb, american) {
  return evAtOdds(coverProb, american);
}

/** Format as "X.X%" for card badges. */
function formatEdgePct(edgeFrac) {
  if (!Number.isFinite(edgeFrac)) return null;
  return `${(edgeFrac * 100).toFixed(1)}%`;
}

/**
 * Append " ML" when the market is moneyline and the pick string is bare team name.
 * Idempotent — skips if already has ML, spread number, or Over/Under.
 */
function formatMoneylinePick(side, market) {
  const s = String(side || '').trim();
  if (!s) return s;
  const m = String(market || '');
  const isML = /moneyline/i.test(m) || (/\bml\b/i.test(m) && !/spread|total|run line/i.test(m));
  if (!isML) return s;
  if (/\bML\b/i.test(s)) return s;
  if (/[+-]\d/.test(s)) return s;
  if (/^(?:F5\s+)?(?:Over|Under)\b/i.test(s)) return s;
  return `${s} ML`;
}


/** Parse edge as fraction — accepts 0.053, 5.3, or "5.3%". */
function parseEdgeFraction(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? v / 100 : v;
  const n = parseFloat(String(v).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}

/**
 * Quality score: calibrated edge + small expected-CLV bonus − uncertainty.
 * Does NOT use cover probability (hit rate ≠ quality).
 */
function qualityScore(edgeFrac, predictedClv, uncertainty) {
  const edge = parseEdgeFraction(edgeFrac);
  if (edge == null) return 0;

  // Edge remains decisive. CLV is expressed in cents-ish units and can move the
  // score by at most 0.15 percentage points; uncertainty is an even smaller nudge.
  const clv = Number(predictedClv);
  const clvBonus = Number.isFinite(clv) ? clamp(clv, -3, 3) * 0.0005 : 0;
  const unc = Number(uncertainty);
  const uncertaintyAdj = Number.isFinite(unc)
    ? clamp((0.18 - unc) * 0.005, -0.001, 0.001)
    : 0;
  return edge + clvBonus + uncertaintyAdj;
}

/** Letter grade from edge-first quality. Thresholds come from shared config. */
function qualityToRating(edgeFrac, predictedClv, uncertainty) {
  const edge = parseEdgeFraction(edgeFrac);
  if (edge == null) return 'b';
  const score = qualityScore(edge, predictedClv, uncertainty);
  if (score >= QUALITY_GRADE.aplus) return 'aplus';
  if (score >= QUALITY_GRADE.a) return 'a';
  if (score >= QUALITY_GRADE.aminus) return 'aminus';
  return 'b'; // <2.0% — B only (no B+ on quality path)
}

/** Resolve a persisted quality score, or calculate it from pick fields. */
function pickQualityScore(pick) {
  const persisted = Number(pick && pick.qualityScore);
  if (Number.isFinite(persisted)) return persisted;
  const edge = pick && pick.edgePct != null
    ? pick.edgePct
    : pick && pick.evRaw != null ? pick.evRaw : pick && pick.ev;
  const clv = pick && pick.predictedResidualClv != null
    ? pick.predictedResidualClv
    : pick && pick.predictedClv;
  return qualityScore(edge, clv, pick && pick.uncertainty);
}

/** Grade rank: lower = higher confidence (A+ first). */
function ratingRank(rating) {
  const r = String(rating || '').toLowerCase().replace(/\s+/g, '');
  const map = {
    aplus: 0, 'a+': 0,
    a: 1,
    aminus: 2, 'a-': 2,
    bplus: 3, 'b+': 3,
    b: 4,
    lean: 5,
  };
  return map[r] != null ? map[r] : 4;
}

/** Sort picks: grade (A+→B), quality, then units — all descending. */
function sortByGradeThenUnits(picks) {
  return [...(picks || [])].sort((a, b) => {
    const ra = ratingRank(a.rating || a.qualityGrade || a.confidence);
    const rb = ratingRank(b.rating || b.qualityGrade || b.confidence);
    if (ra !== rb) return ra - rb;
    const qualityDelta = pickQualityScore(b) - pickQualityScore(a);
    if (Math.abs(qualityDelta) > 1e-12) return qualityDelta;
    const ua = parseFloat(String(a.units || '0').replace(/[^0-9.]/g, '')) || 0;
    const ub = parseFloat(String(b.units || '0').replace(/[^0-9.]/g, '')) || 0;
    return ub - ua;
  });
}


/** America/New_York calendar date YYYY-MM-DD from ISO / Date. */
function etCalendarDate(isoOrDate) {
  if (isoOrDate == null || isoOrDate === '') return null;
  try {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch (_) {
    return null;
  }
}

/** True when commenceTime falls on cardDateISO in America/New_York. */
function isSameEtDay(commenceTime, cardDateISO) {
  const et = etCalendarDate(commenceTime);
  return et != null && et === String(cardDateISO || '');
}

module.exports = {
  americanToImplied,
  americanToDecimal,
  decimalToAmerican,
  formatAmerican,
  noVigTwoWay,
  deVigMarket,
  evAtOdds,
  kellyFraction,
  kellyToUnits,
  unitsToRating,
  ratingToConfidence,
  americanJuiceDelta,
  americanCentsDiff,
  clamp,
  normCdf,
  calibratedEdgeFraction,
  formatEdgePct,
  formatMoneylinePick,
  ratingRank,
  parseEdgeFraction,
  qualityScore,
  qualityToRating,
  pickQualityScore,
  sortByGradeThenUnits,
  etCalendarDate,
  isSameEtDay,
};
