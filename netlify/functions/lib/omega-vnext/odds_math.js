'use strict';

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

function unitsToRating(u) {
  if (u >= 1.5) return 'aplus';
  if (u >= 1.0) return 'a';
  if (u >= 0.75) return 'aminus';
  if (u >= 0.5) return 'bplus';
  return 'b';
}

function ratingToConfidence(rating) {
  return ({ aplus: 90, a: 82, aminus: 75, bplus: 68, b: 60, lean: 52 })[rating] || 60;
}

/** Approx American cents difference for CLV proxy (positive = beat). */
function americanCentsDiff(betAmerican, closeAmerican) {
  const b = Number(betAmerican);
  const c = Number(closeAmerican);
  if (!Number.isFinite(b) || !Number.isFinite(c)) return null;
  // Normalize both to "cents of value" vs -110 baseline via implied edge
  const pb = americanToImplied(b);
  const pc = americanToImplied(c);
  if (pb == null || pc == null) return null;
  // Positive when you bet a better price than close (lower implied)
  return +((pc - pb) * 10000 / 100).toFixed(2); // rough cents-ish scale
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
  americanCentsDiff,
  clamp,
  normCdf,
};
