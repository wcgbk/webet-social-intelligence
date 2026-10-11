'use strict';

/**
 * NHL 60-minute joint, then overtime and a shootout.
 *
 * Season GF/GA already include overtime goals (about 0.15 per game) and
 * do not include a shootout goal. Regulation rates are the final rates
 * minus the OT goal the fixed point puts back, so the plain Poisson
 * E[final total] stays on the model total. A shootout decides the 2-way
 * moneyline and does not add a goal, so it does not move the puck line
 * or the total. Puck line −1.5 covers only on a regulation margin of 2
 * or more. An overtime win is a one-goal final and does not cover −1.5.
 * Moneyline = regulation win + the extras share of the tie (about half,
 * tilted by the regulation rate gap).
 *
 * Empty-net end game (NHL_EMPTY_NET, OMEGA_NHL_EMPTY_NET=0 disables it).
 * The first 60 − max(pullMinDown1, pullMinDown2) minutes stay an independent
 * Poisson at each club's regulation rate. The last minutes are a 10-second
 * Markov chain. Down 1, the trailer pulls with pullMinDown1 left. Down 2,
 * the trailer pulls with pullMinDown2 left. While the goalie is out the
 * leader scores at rateLeaderEN60 and the trailer at rateTrailer6v5_60.
 * A goal that leaves the margin outside {1, 2} puts the goalie back; a
 * new one- or two-goal deficit pulls again if the clock is still inside
 * that threshold. Ties and margins of 3+ stay at the club Poisson rate.
 * The chain does not model 6v4, a delayed penalty, or a pull down 3.
 * Ties after 60 minutes still take the same OT goal / shootout split.
 * Totals and the moneyline are read off that one final distribution, so
 * whole-goal push mass stays on the integer atoms.
 *
 * Published inputs, not fit on the replay:
 * - Beaudoin and Swartz, "Strategies for Pulling the Goalie in Hockey,"
 *   The American Statistician 64(2), 2010. https://doi.org/10.1198/tast.2010.09147
 *   Trailing clubs pull too late. The pull raises both the tying-goal rate
 *   and the chance the leader scores into an empty net, which fattens
 *   two-goal (and larger) regulation margins.
 * - Asness and Brown, "Pulling the Goalie: Hockey and Investment
 *   Implications," SSRN 3132563, draft 1 Oct 2018.
 *   https://doi.org/10.2139/ssrn.3132563
 *   2015-16 minutes with the goalie pulled and both clubs at full strength:
 *   1.97% per 10 seconds for the sixth attacker (7.09 goals per 60) and
 *   4.30% per 10 seconds for the club that kept its goalie (15.48 per 60).
 *   Coaches down one usually waited until inside two minutes. The paper's
 *   optimal pull is about 5:40 down one and 11:40 down two.
 * - Pinnacle, "How Often Do Empty Net Goals Affect Puck Line Results in
 *   the NHL?" (28 Jan 2026).
 *   https://www.pinnacle.com/betting-resources/en/hockey/how-often-do-empty-net-goals-affect-puck-line-results-in-the-nhl
 *   2025-26 through that date: 314 empty-net goals in 838 games, and 280
 *   games (33%) had at least one. GF/60 against an empty net: 2021-22
 *   18.89, 2022-23 18.03, 2023-24 17.04, 2024-25 17.92, 2025-26 17.87.
 *   The five-season mean is 17.95, configured here as 18.
 * - Edgehalla empty-net tracker, 2025-26 (full year) and 2026-27 (early).
 *   https://www.edgehalla.com/nhl/empty-net-goals
 *   https://www.edgehalla.com/nhl/empty-net-goals/2026-27
 *   2025-26: trailer 7.2 GF/60 while pulled, 21.3 empty-net goals against
 *   per 60 pulled, 16% of down-1 pulls (85/541) tied the game before the
 *   goalie returned. Median pull down 2 was 3:23. 2026-27 early sample:
 *   median down 1 was 2:04 and down 2 was 3:08; trailer 7.0 / 60 and
 *   empty-net 20.9 / 60. Configured pulls are the round minutes on that
 *   band: 2:00 down one, 3:00 down two.
 * - Hockey Graphs, "The State of Goalie Pulling in the NHL" (18 May 2020).
 *   https://hockey-graphs.com/2020/05/18/the-state-of-goalie-pulling-in-the-nhl/
 *   Across seven seasons the extra attacker scored about 6.5 per 60 at 6v5,
 *   near a 5v4 power play, and the empty-net rate sat well above that.
 *   Down-1 pulls moved only about 30 seconds earlier over those seasons.
 * - Desjardins, "Time Spent in Empty Net Game States," Arctic Ice Hockey
 *   (17 Feb 2019). https://www.arcticicehockey.com/time-spent-in-empty-net-game-states-1550402063/
 *   1.2% of regulation was empty-net time. Minutes 58-60 were 26.77%
 *   empty-net; minutes 56-58 were 2.06%.
 * - TrueEdge Wire, "NHL Puck Line and 60-Minute Regulation Bets" (27 Sep 2026),
 *   2025-26 finals. https://www.trueedgewire.com/article/nhl-puck-line-and-regulation-bets
 *   567/1312 games (43.2%) finished by exactly one goal, counting overtime
 *   and the shootout. Two-goal wins were 17.5%, three-goal wins 23.1%,
 *   four or more 16.2%. 508 skater empty-net goals, about 0.39 a game.
 *   Three-goal wins outnumbering two-goal wins is the empty-net signature.
 * The 7.2 extra-attacker rate matches Edgehalla 2025-26 and Asness-Brown's
 * 7.09. The leader rate uses Pinnacle's 17.95 (configured 18), between
 * Asness-Brown's 15.48 and Edgehalla's 21.3 pulled-time rate.
 */

const OT_GOALS_PER_GAME = 0.15;
const OT_GOAL_GIVEN_TIE = 0.55;
const LAMBDA_FLOOR = 0.35;
const MAX_GOALS = 16;
/** Asness and Brown score the pull on 10-second ticks. */
const EMPTY_NET_STEP_MIN = 10 / 60;

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
 * This fixed point is the plain Poisson. The empty-net step, when on,
 * lifts the mean a little above that anchor.
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

/**
 * Unset follows NHL_EMPTY_NET.enabled. "0" / "off" / "false" / "no" forces
 * the plain Poisson. Any other set value forces the end-game step.
 */
function emptyNetEnabled() {
  const cfg = require('./config').NHL_EMPTY_NET || {};
  const v = process.env.OMEGA_NHL_EMPTY_NET;
  if (v == null || String(v).trim() === '') return cfg.enabled !== false;
  const s = String(v).trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

function emptyNetParams() {
  const cfg = require('./config').NHL_EMPTY_NET || {};
  const pull1 = Number(cfg.pullMinDown1);
  const pull2 = Number(cfg.pullMinDown2);
  const lead = Number(cfg.rateLeaderEN60);
  const trail = Number(cfg.rateTrailer6v5_60);
  return {
    pullMinDown1: Number.isFinite(pull1) && pull1 > 0 ? pull1 : 0,
    pullMinDown2: Number.isFinite(pull2) && pull2 > 0 ? pull2 : 0,
    rateLeaderEN60: Number.isFinite(lead) && lead > 0 ? lead : 0,
    rateTrailer6v5_60: Number.isFinite(trail) && trail > 0 ? trail : 0,
  };
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
 * probAt(i, j) is the regulation probability of that score.
 */
function finishRegulation(probAt, reg, extra) {
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
      const p = probAt(i, j);
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
    emptyNet: false,
    pEmptyNetGoal: 0,
    expectedEmptyNetGoals: 0,
    ...extra,
  };
}

/**
 * Last W minutes. One goal per 10-second tick, competing exponential.
 * Returns the regulation joint and the empty-net goal accounting.
 */
function applyEmptyNet(lh, la, cfg) {
  const n = MAX_GOALS + 1;
  const windowMin = Math.max(cfg.pullMinDown1, cfg.pullMinDown2);
  const earlyFrac = clamp((60 - windowMin) / 60, 0, 1);
  const ph = poissonPmf(lh * earlyFrac);
  const pa = poissonPmf(la * earlyFrac);
  let cur = new Float64Array(n * n);
  let en = new Float64Array(n * n);
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) cur[i * n + j] = ph[i] * pa[j];
  }
  const steps = Math.round(windowMin / EMPTY_NET_STEP_MIN);
  const dt = steps > 0 ? windowMin / steps : 0;
  const rate5H = lh / 60;
  const rate5A = la / 60;
  const rateLead = cfg.rateLeaderEN60 / 60;
  const rateTrail = cfg.rateTrailer6v5_60 / 60;
  let expectedEmptyNetGoals = 0;
  for (let s = 0; s < steps; s++) {
    const tLeft = windowMin - s * dt;
    const next = new Float64Array(n * n);
    const nextEn = new Float64Array(n * n);
    const pull1 = tLeft <= cfg.pullMinDown1 + 1e-9;
    const pull2 = tLeft <= cfg.pullMinDown2 + 1e-9;
    for (let i = 0; i <= MAX_GOALS; i++) {
      for (let j = 0; j <= MAX_GOALS; j++) {
        const idx = i * n + j;
        const mass = cur[idx];
        const massEn = en[idx];
        if (mass === 0 && massEn === 0) continue;
        const margin = i - j;
        const abs = margin < 0 ? -margin : margin;
        let rh = rate5H;
        let ra = rate5A;
        let homeIsEmptyNet = false;
        let awayIsEmptyNet = false;
        if ((abs === 1 && pull1) || (abs === 2 && pull2)) {
          if (margin > 0) {
            rh = rateLead;
            ra = rateTrail;
            homeIsEmptyNet = true;
          } else {
            rh = rateTrail;
            ra = rateLead;
            awayIsEmptyNet = true;
          }
        }
        const r = rh + ra;
        const pStay = r > 0 ? Math.exp(-r * dt) : 1;
        const pGoal = 1 - pStay;
        const pH = r > 0 ? pGoal * rh / r : 0;
        const pA = r > 0 ? pGoal * ra / r : 0;
        const ih = i < MAX_GOALS ? i + 1 : MAX_GOALS;
        const ja = j < MAX_GOALS ? j + 1 : MAX_GOALS;
        const hIdx = ih * n + j;
        const aIdx = i * n + ja;
        next[idx] += mass * pStay;
        nextEn[idx] += massEn * pStay;
        if (homeIsEmptyNet) {
          nextEn[hIdx] += (mass + massEn) * pH;
          expectedEmptyNetGoals += (mass + massEn) * pH;
        } else {
          next[hIdx] += mass * pH;
          nextEn[hIdx] += massEn * pH;
        }
        if (awayIsEmptyNet) {
          nextEn[aIdx] += (mass + massEn) * pA;
          expectedEmptyNetGoals += (mass + massEn) * pA;
        } else {
          next[aIdx] += mass * pA;
          nextEn[aIdx] += massEn * pA;
        }
      }
    }
    cur = next;
    en = nextEn;
  }
  let pEmptyNetGoal = 0;
  for (let k = 0; k < en.length; k++) pEmptyNetGoal += en[k];
  return { cur, en, pEmptyNetGoal, expectedEmptyNetGoals, earlyFrac, windowMin };
}

/**
 * Home-final goal margin and final total (OT goal included, shootout goal not).
 * Returns null when the rates are not usable.
 */
function enumerate(modelMargin, modelTotal) {
  const reg = regulationLambdas(modelMargin, modelTotal);
  if (!reg) return null;
  if (!emptyNetEnabled()) {
    const ph = poissonPmf(reg.lh);
    const pa = poissonPmf(reg.la);
    return finishRegulation((i, j) => ph[i] * pa[j], reg, null);
  }
  const stepped = applyEmptyNet(reg.lh, reg.la, emptyNetParams());
  const n = MAX_GOALS + 1;
  const dist = finishRegulation((i, j) => {
    const idx = i * n + j;
    return stepped.cur[idx] + stepped.en[idx];
  }, reg, {
    emptyNet: true,
    pEmptyNetGoal: stepped.pEmptyNetGoal,
    expectedEmptyNetGoals: stepped.expectedEmptyNetGoals,
    emptyNetWindowMin: stepped.windowMin,
  });
  return dist;
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
  MAX_GOALS,
  EMPTY_NET_STEP_MIN,
  regulationLambdas,
  emptyNetEnabled,
  enumerate,
  totalProb,
  nhlMarketQuote,
};
