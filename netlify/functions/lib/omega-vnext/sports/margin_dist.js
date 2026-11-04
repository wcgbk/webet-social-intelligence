'use strict';

/**
 * Football margin distribution. A normal with extra mass on the key
 * numbers 3, 7, and 10 (and the matching negatives). Cover and moneyline
 * probabilities come from that discrete margin, with pushes removed so the
 * two-outcome price is P(win) / (P(win) + P(loss)).
 *
 * Targets are the long-run NFL landing rates. A normal with sigma 13.5 puts
 * about 2.9% on 3; the historical rate is about 9.5%. NCAAF keeps the same
 * keys at a lighter rate because the margin is wider (sigma 16).
 */

const { clamp } = require('../odds_math');

const KEYS = [3, 7, 10];
const NFL_TARGET = { 3: 0.095, 7: 0.055, 10: 0.035 };
const NCAAF_TARGET = { 3: 0.070, 7: 0.045, 10: 0.028 };
const SIGMA = { NFL: 13.5, NCAAF: 16 };

function normCdfRaw(z) {
  const az = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * az);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function normalMass(mean, sigma, lo, hi) {
  const by = new Map();
  for (let k = lo; k <= hi; k += 1) {
    const p = normCdfRaw((k + 0.5 - mean) / sigma) - normCdfRaw((k - 0.5 - mean) / sigma);
    by.set(k, p > 0 ? p : 0);
  }
  return by;
}

function isKey(k) {
  const a = Math.abs(k);
  return KEYS.indexOf(a) !== -1;
}

/**
 * Move probability onto each key until it reaches the target, taking from
 * the non-key neighbors. A key that the normal already overshoots is left.
 */
function applyKeyMass(by, targets) {
  for (const key of KEYS) {
    const target = targets[key];
    if (!(target > 0)) continue;
    for (const sign of [1, -1]) {
      const at = sign * key;
      const cur = by.get(at) || 0;
      if (cur >= target) continue;
      const donors = [];
      for (const d of [at - 1, at + 1, at - 2, at + 2, at - 4, at + 4]) {
        if (!by.has(d) || isKey(d)) continue;
        donors.push(d);
      }
      let pool = 0;
      for (const d of donors) pool += by.get(d);
      if (!(pool > 0)) continue;
      const take = Math.min(target - cur, pool * 0.85);
      for (const d of donors) {
        by.set(d, by.get(d) - (by.get(d) / pool) * take);
      }
      by.set(at, cur + take);
    }
  }
  let sum = 0;
  for (const v of by.values()) sum += v;
  if (sum > 0) {
    for (const [k, v] of by) by.set(k, v / sum);
  }
  return by;
}

function marginMass(mean, sport) {
  const key = String(sport || '').toUpperCase();
  const sigma = SIGMA[key] || SIGMA.NFL;
  const targets = key === 'NCAAF' ? NCAAF_TARGET : NFL_TARGET;
  return applyKeyMass(normalMass(mean, sigma, -60, 60), targets);
}

/**
 * P(this side wins the bet). `margin` is that side's expected margin
 * (positive = this side is better). `line` is that side's points
 * (null = moneyline).
 */
function footballCoverProb(margin, line, sport) {
  const mean = Number(margin);
  if (!Number.isFinite(mean)) return null;
  const by = marginMass(mean, sport);
  if (line == null) {
    let win = 0;
    let tie = 0;
    for (const [k, p] of by) {
      if (k > 0) win += p;
      else if (k === 0) tie += p;
    }
    return clamp(win + 0.5 * tie, 0.02, 0.98);
  }
  const points = Number(line);
  if (!Number.isFinite(points)) return null;
  const thresh = -points;
  let win = 0;
  let loss = 0;
  for (const [k, p] of by) {
    if (Math.abs(k - thresh) < 1e-9) continue;
    if (k > thresh) win += p;
    else loss += p;
  }
  const live = win + loss;
  if (!(live > 0)) return 0.5;
  return clamp(win / live, 0.02, 0.98);
}

function keyMassAt(margin, sport, point) {
  const by = marginMass(Number(margin) || 0, sport);
  return by.get(point) || 0;
}

module.exports = {
  footballCoverProb,
  keyMassAt,
  marginMass,
  NFL_TARGET,
  NCAAF_TARGET,
  SIGMA,
};
