'use strict';

/**
 * NHL 60-minute joint, then overtime and a shootout.
 *
 * Season GF/GA already include overtime goals (about 0.15 per game) and
 * do not include a shootout goal. Regulation rates are the final rates
 * minus the OT goal the fixed point puts back, so E[final total] stays
 * on the model total. A shootout decides the 2-way moneyline and does
 * not add a goal, so it does not move the puck line or the total.
 * Puck line −1.5 covers only on a regulation margin of 2 or more.
 * An overtime win is a one-goal final and does not cover −1.5.
 *
 * Empty-net goals are not split out. They already sit inside season GF/GA.
 */

const OT_GOALS_PER_GAME = 0.15;
const OT_GOAL_GIVEN_TIE = 0.55;
const LAMBDA_FLOOR = 0.35;
const MAX_GOALS = 16;

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function poissonPmf(lambda) {
  const lam = Math.max(0, Number(lambda) || 0);
  const p = new Float64Array(MAX_GOALS + 1);
  p[0] = Math.exp(-lam);
  for (let k = 1; k <= MAX_GOALS; k++) p[k] = p[k - 1] * lam / k;
  let s = 0;
  for (let k = 0; k <= MAX_GOALS; k++) s += p[k];
  if (s > 0) {
    for (let k = 0; k <= MAX_GOALS; k++) p[k] /= s;
  }
  return p;
}

function tieProb(ph, pa) {
  let s = 0;
  for (let k = 0; k <= MAX_GOALS; k++) s += ph[k] * pa[k];
  return s;
}

/** Home share of extras wins. Base 0.52, tilted by the regulation rate gap. */
function extrasHomeRate(lh, la) {
  const tilt = clamp((lh - la) * 0.04, -0.06, 0.06);
  return clamp(0.52 + tilt, 0.45, 0.60);
}

/**
 * Iterate regulation λ so the OT goal added on a tie brings the expected
 * final total and the expected final goal margin back to the model.
 */
function regulationLambdas(modelMargin, modelTotal) {
  const tot = Number(modelTotal);
  const mar = Number(modelMargin);
  if (!Number.isFinite(tot) || !Number.isFinite(mar)) return null;
  const homeFinal = (tot + mar) / 2;
  const awayFinal = (tot - mar) / 2;
  let lh = Math.max(LAMBDA_FLOOR, homeFinal - OT_GOALS_PER_GAME / 2);
  let la = Math.max(LAMBDA_FLOOR, awayFinal - OT_GOALS_PER_GAME / 2);
  let tilt = extrasHomeRate(lh, la);
  for (let n = 0; n < 16; n++) {
    const ph = poissonPmf(lh);
    const pa = poissonPmf(la);
    const eOt = tieProb(ph, pa) * OT_GOAL_GIVEN_TIE;
    tilt = extrasHomeRate(lh, la);
    const nextH = Math.max(LAMBDA_FLOOR, homeFinal - eOt * tilt);
    const nextA = Math.max(LAMBDA_FLOOR, awayFinal - eOt * (1 - tilt));
    const moved = Math.abs(nextH - lh) + Math.abs(nextA - la);
    lh = nextH;
    la = nextA;
    if (moved < 1e-5) break;
  }
  return { lh, la, tilt: extrasHomeRate(lh, la) };
}

function quoteFromWinPush(pWin, pPush) {
  const win = Math.max(0, pWin);
  const push = Math.max(0, Math.min(0.999, pPush));
  let cover = win;
  if (push >= 0.001 && push < 1) cover = win / (1 - push);
  if (cover < 0.001) cover = 0.001;
  if (cover > 0.999) cover = 0.999;
  return {
    coverProb: cover,
    pWin: win,
    pPush: push >= 0.001 ? push : 0,
    pLoss: Math.max(0, 1 - win - push),
  };
}

/**
 * Home-final goal margin and final total (OT goal included, shootout goal not).
 * Returns null when the rates are not usable.
 */
function enumerate(modelMargin, modelTotal) {
  const reg = regulationLambdas(modelMargin, modelTotal);
  if (!reg) return null;
  const ph = poissonPmf(reg.lh);
  const pa = poissonPmf(reg.la);
  const tilt = reg.tilt;
  const margin = new Map();
  const total = new Map();
  const add = (map, k, p) => map.set(k, (map.get(k) || 0) + p);
  let pHomeReg = 0;
  let pAwayReg = 0;
  let pTie = 0;
  let pHomeBy2 = 0;
  let expectedTotal = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (!(p > 0)) continue;
      if (i > j) {
        pHomeReg += p;
        add(margin, i - j, p);
        add(total, i + j, p);
        expectedTotal += (i + j) * p;
        if (i - j >= 2) pHomeBy2 += p;
      } else if (i < j) {
        pAwayReg += p;
        add(margin, i - j, p);
        add(total, i + j, p);
        expectedTotal += (i + j) * p;
      } else {
        pTie += p;
        const pGoal = p * OT_GOAL_GIVEN_TIE;
        const pSo = p * (1 - OT_GOAL_GIVEN_TIE);
        add(margin, 1, pGoal * tilt);
        add(margin, -1, pGoal * (1 - tilt));
        add(margin, 0, pSo);
        add(total, i + j + 1, pGoal);
        add(total, i + j, pSo);
        expectedTotal += (i + j + 1) * pGoal + (i + j) * pSo;
      }
    }
  }
  return {
    margin,
    total,
    pHomeReg,
    pAwayReg,
    pTie,
    pHomeBy2,
    expectedTotal,
    lh: reg.lh,
    la: reg.la,
    tilt,
    pHomeML: pHomeReg + pTie * tilt,
    pAwayML: pAwayReg + pTie * (1 - tilt),
  };
}

function sideMarginProb(dist, sideIsHome, pred) {
  let s = 0;
  for (const [h, p] of dist.margin) {
    const m = sideIsHome ? h : -h;
    if (pred(m)) s += p;
  }
  return s;
}

function totalProb(dist, pred) {
  let s = 0;
  for (const [t, p] of dist.total) {
    if (pred(t)) s += p;
  }
  return s;
}

/**
 * market: 'ml' | 'spread' | 'total'
 * sideIsHome selects the side for ml and spread.
 * line is the side's spread or the total.
 * side is 'Over' / 'Under' for totals.
 */
function nhlMarketQuote({ modelMargin, modelTotal, market, sideIsHome = true, line = null, side = '' } = {}) {
  const dist = enumerate(modelMargin, modelTotal);
  if (!dist) return null;
  const kind = String(market || '');
  if (kind === 'ml') {
    const pWin = sideIsHome ? dist.pHomeML : dist.pAwayML;
    return {
      ...quoteFromWinPush(pWin, 0),
      expectedTotal: dist.expectedTotal,
      pTie: dist.pTie,
      pHomeBy2: dist.pHomeBy2,
    };
  }
  if (kind === 'spread') {
    if (!Number.isFinite(line)) return null;
    const integer = Math.abs(line - Math.round(line)) < 1e-6;
    const pushAt = integer ? -Math.round(line) : null;
    const pPush = pushAt == null ? 0 : sideMarginProb(dist, sideIsHome, (m) => m === pushAt);
    const pWin = sideMarginProb(dist, sideIsHome, (m) => m + line > 0);
    return {
      ...quoteFromWinPush(pWin, pPush),
      expectedTotal: dist.expectedTotal,
      pTie: dist.pTie,
      pHomeBy2: dist.pHomeBy2,
    };
  }
  if (kind === 'total') {
    if (!Number.isFinite(line)) return null;
    const over = /over/i.test(String(side || ''));
    const integer = Math.abs(line - Math.round(line)) < 1e-6;
    const pushAt = integer ? Math.round(line) : null;
    const pPush = pushAt == null ? 0 : totalProb(dist, (t) => t === pushAt);
    const pWin = totalProb(dist, (t) => (over ? t > line : t < line));
    return {
      ...quoteFromWinPush(pWin, pPush),
      expectedTotal: dist.expectedTotal,
      pTie: dist.pTie,
      pHomeBy2: dist.pHomeBy2,
    };
  }
  return null;
}

module.exports = {
  OT_GOALS_PER_GAME,
  OT_GOAL_GIVEN_TIE,
  LAMBDA_FLOOR,
  regulationLambdas,
  nhlMarketQuote,
};
