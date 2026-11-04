'use strict';
/**
 * NHL projection — standings GF/GA + HFA, then optional soft residuals.
 * Moneyline, puck line (market Spread), and total. Blend matches MLB
 * (0.50 / 0.50 / 0.45) on no-vig Pinnacle/Circa. Calibrate runs later.
 *
 * SPORTS_ENABLED.NHL enabled 2026-09-30 (WeBet voice order). This module does not
 * read that flag: projectAll is the gate. A direct project() call still
 * emits candidates so the engine can be checked before enable.
 *
 * Missing shots or a goalie save rate soft-fail to 0. Residuals sit under
 * ENGINE_SOFT.NHL and then the Poisson score matrix. Final margin/total
 * soft-clamp (|spread| 6, total 12) and still emit a candidate.
 *
 * ESPN public inputs (site.api.espn.com / site.web.api.espn.com only):
 * team shots for/against per game, or a shot share, and the probable or
 * confirmed starter's season save% regressed by shots faced. Coefficients
 * are SHOT_SHARE_MARGIN, SHOT_VOLUME_TOTAL, and the goalie per-save rates
 * in ENGINE_SOFT.NHL. A probable starter counts at PROBABLE_GOALIE_WEIGHT.
 */
const { clamp } = require('../odds_math');
const { HFA, ENGINE_SOFT } = require('../config');
const {
  formatMatchup, fuzzyTeam, mapGamesSoft, LEAGUE_PPG,
  blendWithMarket,
} = require('./_common');
const { applyGameDayAdjustments } = require('./game_day');
const { collectMarketOutcomes, collectLinesForEdge, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');

const SPORT = 'NHL';
const LEAGUE_GPG = LEAGUE_PPG.NHL; // 3.1
const NEUTRAL_TOTAL = 6.2;
const NHL_MARGIN_CAP = 6;
const NHL_TOTAL_MIN = 3;
const NHL_TOTAL_MAX = 12;
const NHL_GPG_FLOOR = 1.5;
const NHL_GPG_CAP = 5.2;
const NHL_MIN_GAMES = 5;
const LG_SAVE = 0.905;
const BLEND = { ml: 0.50, spread: 0.50, total: 0.45 };
/**
 * Shot share = shots for / (shots for + shots against). League share is 0.50.
 * SHOT_SHARE_MARGIN is goals of margin per 1.0 share gap (home − away),
 * applied to expected goals before the Poisson matrix. A 0.08 gap
 * (about 54% vs 46%) is 0.096 goals. The 42-for / 20-against bag is a
 * 0.355 gap and still hits the ±0.30 stack cap. Missing shots → 0.
 *
 * SHOT_VOLUME_TOTAL is goals of total per combined shot above
 * 2 × LEAGUE_SHOTS_PG (about 29 shots a side). One extra shot is 0.015
 * goals. It nudges the total. It does not replace the standings total.
 */
const SHOT_SHARE_MARGIN = 1.20;
const SHOT_VOLUME_TOTAL = 0.015;
const LEAGUE_SHOTS_PG = 29;
/**
 * A probable starter who is not confirmed counts at this fraction of a
 * confirmed starter. A save% with no status flag stays at full weight.
 * confirmed:false with no probable flag stays at 0.
 */
const PROBABLE_GOALIE_WEIGHT = 0.60;
/** Home team share of regulation ties. OT/SO is about 54% home. */
const OT_HOME = 0.54;
/**
 * Phantom shots mixed into a starter's save rate at the league save rate.
 * A short sample cannot move expected goals as far as the raw SV%.
 */
const PHANTOM_SHOTS = 500;
const GOALIE_SHOTS_IF_MISSING = 400;

function capsOf(caps) {
  return caps || (ENGINE_SOFT && ENGINE_SOFT.NHL) || {
    maxAbsMarginAdj: 0.30,
    maxAbsTotalAdj: 0.35,
    winPctGoalsPerPoint: 1.2,
    goalieMaxAbsMarginAdj: 0.12,
    goalieMaxAbsTotalAdj: 0.10,
    goalieMarginPerSave: 8,
    goalieTotalPerSave: 6,
  };
}

function nhlGames(st) {
  if (!st || typeof st !== 'object') return 0;
  const g = Number(st.games);
  if (Number.isFinite(g) && g > 0) return g;
  const w = Number(st.wins);
  const l = Number(st.losses);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  const otlRaw = st.otLosses != null ? st.otLosses : st.otl;
  const otl = Number(otlRaw);
  const t = Number(st.ties);
  return w + l + (Number.isFinite(otl) ? otl : 0) + (Number.isFinite(t) ? t : 0);
}

/**
 * Season standings points (2*W + OTL) sometimes land in pf. Those are not goals.
 * A team cannot average more than 2 standings points per game, so a higher
 * per-game figure is a goal total even when it sits near that point guess.
 */
function pfLooksLikeStandingsPoints(st, pf) {
  if (!st || !(pf > 6)) return false;
  const g = nhlGames(st);
  if (g > 0 && pf / g > 2) return false;
  const wins = Number(st.wins);
  if (!Number.isFinite(wins) || wins < 0) return false;
  const otlRaw = st.otLosses != null ? st.otLosses : st.otl;
  const otl = Number(otlRaw);
  const guess = 2 * wins + (Number.isFinite(otl) ? otl : 0);
  if (guess < 8) return false;
  return Math.abs(pf - guess) <= Math.max(3, guess * 0.12);
}

/**
 * Goals for/against per game.
 * Season totals (pf 250) need a game count. Per-game rates (pf 3.2) pass through.
 * Unclean rows return null so the caller keeps the 6.2 / HFA baseline.
 */
function teamGpg(st) {
  if (!st || typeof st !== 'object') return null;
  const pf = Number(st.pf != null ? st.pf : st.gf);
  const pa = Number(st.pa != null ? st.pa : st.ga);
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || pf <= 0 || pa <= 0) return null;
  if (pfLooksLikeStandingsPoints(st, pf) || pfLooksLikeStandingsPoints(st, pa)) return null;
  let gf = pf;
  let ga = pa;
  if (pf > LEAGUE_GPG * 1.8 || pa > LEAGUE_GPG * 1.8) {
    const g = nhlGames(st);
    if (g < NHL_MIN_GAMES) return null;
    gf = pf / g;
    ga = pa / g;
  }
  if (!(gf >= NHL_GPG_FLOOR && gf <= NHL_GPG_CAP && ga >= NHL_GPG_FLOOR && ga <= NHL_GPG_CAP)) return null;
  return { gf, ga };
}

function teamWinPct(st) {
  if (!st || typeof st !== 'object') return null;
  const raw = Number(st.winPct);
  if (Number.isFinite(raw)) {
    if (raw >= 0 && raw <= 1) return raw;
    if (raw > 1 && raw <= 100) return raw / 100;
  }
  const g = nhlGames(st);
  const wins = Number(st.wins);
  if (g >= NHL_MIN_GAMES && Number.isFinite(wins) && wins >= 0 && wins <= g) return wins / g;
  return null;
}

/**
 * Home margin = (home goals − away goals) + HFA. Total = the sum.
 * Equal clubs land on HFA and 6.2. Missing either side stays on that baseline.
 */
function nhlStandingsEnv(homeSt, awaySt) {
  const hfa = Number.isFinite(Number(HFA && HFA.NHL)) ? Number(HFA.NHL) : 0.15;
  const neutral = {
    modelMargin: hfa,
    modelTotal: NEUTRAL_TOTAL,
    usedStandings: false,
    homeGoals: LEAGUE_GPG,
    awayGoals: LEAGUE_GPG,
  };
  const h = teamGpg(homeSt);
  const a = teamGpg(awaySt);
  if (!h || !a) return neutral;
  const homeGoals = (h.gf + a.ga) / 2;
  const awayGoals = (a.gf + h.ga) / 2;
  const modelTotal = homeGoals + awayGoals;
  const modelMargin = (homeGoals - awayGoals) + hfa;
  if (!Number.isFinite(modelTotal) || !Number.isFinite(modelMargin)) return neutral;
  return {
    modelMargin,
    modelTotal,
    usedStandings: true,
    homeGoals,
    awayGoals,
    homeGf: h.gf,
    homeGa: h.ga,
    awayGf: a.gf,
    awayGa: a.ga,
  };
}

function capPiece(marginAdj, totalAdj, maxM, maxT) {
  const mCap = Number.isFinite(Number(maxM)) ? Math.abs(Number(maxM)) : 0;
  const tCap = Number.isFinite(Number(maxT)) ? Math.abs(Number(maxT)) : 0;
  const m = clamp(Number(marginAdj) || 0, -mCap, mCap);
  const t = clamp(Number(totalAdj) || 0, -tCap, tCap);
  return {
    marginAdj: m,
    totalAdj: t,
    capped: Math.abs(m - (Number(marginAdj) || 0)) > 1e-9 || Math.abs(t - (Number(totalAdj) || 0)) > 1e-9,
  };
}

function asUnitRate(v, kind) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (kind === 'save') {
    if (n > 1.5 && n <= 100) return n / 100;
    if (n > 100 && n <= 1000) return n / 1000;
    return n;
  }
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function ratePerGame(raw, games, seasonMin) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > seasonMin) {
    if (!(games >= NHL_MIN_GAMES)) return null;
    return n / games;
  }
  return n;
}

function shotShareOnly(bag) {
  let share = Number(bag.shotShare != null ? bag.shotShare : bag.shotSharePct);
  if (!Number.isFinite(share)) return null;
  if (share > 1 && share <= 100) share /= 100;
  if (share <= 0.35 || share >= 0.65) return null;
  return { shotsFor: null, shotsAgainst: null, share };
}

/**
 * Per-game shots, or a shot share when the shot counts are absent.
 * A count above 42 is a season total and needs at least 5 games.
 */
function shotBag(bag, games) {
  if (!bag || typeof bag !== 'object') return null;
  const shotsFor = ratePerGame(bag.shotsFor != null ? bag.shotsFor : bag.shots, games, 42);
  const shotsAgainst = ratePerGame(
    bag.shotsAgainst != null ? bag.shotsAgainst : bag.shotsAgainstPerGame,
    games,
    42
  );
  const hasFor = shotsFor != null;
  const hasAgainst = shotsAgainst != null;
  if (hasFor || hasAgainst) {
    if (!hasFor || !hasAgainst) return null;
    if (shotsFor < 20 || shotsFor > 42 || shotsAgainst < 20 || shotsAgainst > 42) return null;
    const share = shotsFor / (shotsFor + shotsAgainst);
    if (!Number.isFinite(share)) return null;
    return { shotsFor, shotsAgainst, share };
  }
  return shotShareOnly(bag);
}

function espnSideBag(espnGame, side) {
  if (!espnGame || typeof espnGame !== 'object') return null;
  if (side === 'home') return espnGame.homeStats || espnGame.homeTeamStats || null;
  return espnGame.awayStats || espnGame.awayTeamStats || null;
}

function shotResidual(homeSt, awaySt, espnGame, _baseHome, _baseAway, cfg) {
  const none = { marginAdj: 0, totalAdj: 0, used: false, capped: false };
  const h = shotBag(homeSt, nhlGames(homeSt)) || shotBag(espnSideBag(espnGame, 'home'), nhlGames(homeSt));
  const a = shotBag(awaySt, nhlGames(awaySt)) || shotBag(espnSideBag(espnGame, 'away'), nhlGames(awaySt));
  if (!h || !a) return none;
  const rawM = (h.share - a.share) * SHOT_SHARE_MARGIN;
  let rawT = 0;
  if (h.shotsFor != null && h.shotsAgainst != null && a.shotsFor != null && a.shotsAgainst != null) {
    const expShots = (h.shotsFor + h.shotsAgainst + a.shotsFor + a.shotsAgainst) / 2;
    rawT = (expShots - (2 * LEAGUE_SHOTS_PG)) * SHOT_VOLUME_TOTAL;
  }
  if (!Number.isFinite(rawM) || !Number.isFinite(rawT)) return none;
  const piece = capPiece(rawM, rawT, cfg.maxAbsMarginAdj, cfg.maxAbsTotalAdj);
  const used = Math.abs(piece.marginAdj) > 1e-9 || Math.abs(piece.totalAdj) > 1e-9;
  return { ...piece, used };
}

function goalieOf(espnGame, side) {
  if (!espnGame || typeof espnGame !== 'object') return null;
  const keys = side === 'home'
    ? ['homeGoalie', 'homeGoalieConfirmed']
    : ['awayGoalie', 'awayGoalieConfirmed'];
  for (const k of keys) {
    const g = espnGame[k];
    if (g && typeof g === 'object') return g;
  }
  return null;
}

function regressSavePct(sv, shotsAgainst) {
  const rate = Number(sv);
  if (!Number.isFinite(rate)) return null;
  const sa = Number(shotsAgainst);
  const shots = Number.isFinite(sa) && sa > 0 ? sa : GOALIE_SHOTS_IF_MISSING;
  return (rate * shots + LG_SAVE * PHANTOM_SHOTS) / (shots + PHANTOM_SHOTS);
}

/**
 * Full weight when confirmation is omitted or true. A probable flag
 * scales the save edge. An explicit unconfirmed goalie with no probable
 * flag contributes nothing, which keeps the previous zero.
 */
function goalieTrust(g) {
  if (!g || typeof g !== 'object') return 0;
  const status = String(g.status || '').toLowerCase();
  const explicitProbable = g.probable === true || status === 'probable';
  if (g.confirmed === false && !explicitProbable) return 0;
  if (explicitProbable && g.confirmed !== true && status !== 'confirmed') return PROBABLE_GOALIE_WEIGHT;
  return 1;
}

function goalieResidual(espnGame, cfg) {
  const none = { marginAdj: 0, totalAdj: 0, used: false, capped: false };
  const hg = goalieOf(espnGame, 'home');
  const ag = goalieOf(espnGame, 'away');
  if (!hg || !ag) return none;
  const trustH = goalieTrust(hg);
  const trustA = goalieTrust(ag);
  if (!(trustH > 0) || !(trustA > 0)) return none;
  const hsRaw = asUnitRate(hg.savePct != null ? hg.savePct : hg.svPct, 'save');
  const asRaw = asUnitRate(ag.savePct != null ? ag.savePct : ag.svPct, 'save');
  if (hsRaw == null || asRaw == null) return none;
  if (hsRaw < 0.80 || hsRaw > 0.97 || asRaw < 0.80 || asRaw > 0.97) return none;
  const hs = regressSavePct(hsRaw, hg.shotsAgainst != null ? hg.shotsAgainst : hg.shots);
  const asv = regressSavePct(asRaw, ag.shotsAgainst != null ? ag.shotsAgainst : ag.shots);
  if (hs == null || asv == null) return none;
  // Band the regressed rate. A short bad sample (.812 on 197 shots) comes
  // back toward .905 and can count. A rate that stays outside .85–.95 is dropped.
  if (hs < 0.85 || hs > 0.95 || asv < 0.85 || asv > 0.95) return none;
  const perM = Number.isFinite(Number(cfg.goalieMarginPerSave)) ? Number(cfg.goalieMarginPerSave) : 8;
  const perT = Number.isFinite(Number(cfg.goalieTotalPerSave)) ? Number(cfg.goalieTotalPerSave) : 6;
  const capM = Number.isFinite(Number(cfg.goalieMaxAbsMarginAdj)) ? Number(cfg.goalieMaxAbsMarginAdj) : 0.12;
  const capT = Number.isFinite(Number(cfg.goalieMaxAbsTotalAdj)) ? Number(cfg.goalieMaxAbsTotalAdj) : 0.10;
  // Better home save → fewer away goals. Trust scales each edge vs the league.
  // Both above-average saves trim the total. Confirmed trust is 1, so this
  // matches the unweighted (save − league) residual.
  const homeEdge = (hs - LG_SAVE) * trustH;
  const awayEdge = (asv - LG_SAVE) * trustA;
  const rawM = (homeEdge - awayEdge) * perM;
  const rawT = -(homeEdge + awayEdge) * perT;
  const piece = capPiece(rawM, rawT, capM, capT);
  const used = Math.abs(piece.marginAdj) > 1e-9 || Math.abs(piece.totalAdj) > 1e-9;
  return { ...piece, used };
}

function winPctResidual(homeSt, awaySt, cfg) {
  const none = { marginAdj: 0, totalAdj: 0, used: false, capped: false };
  const hp = teamWinPct(homeSt);
  const ap = teamWinPct(awaySt);
  if (hp == null || ap == null) return none;
  const scale = Number.isFinite(Number(cfg.winPctGoalsPerPoint)) ? Number(cfg.winPctGoalsPerPoint) : 1.2;
  const piece = capPiece((hp - ap) * scale, 0, cfg.maxAbsMarginAdj, cfg.maxAbsTotalAdj);
  const used = Math.abs(piece.marginAdj) > 1e-9;
  return { ...piece, used };
}

/**
 * Soft residuals on top of the standings spine. Each piece is capped, then
 * the stack is capped again so shots + goalie + winPct cannot pass the spine.
 * WinPct runs only when GF/GA is unclean. Missing inputs → 0.
 */
function applyNhlEngineSoft({
  modelMargin,
  modelTotal,
  usedStandings,
  homeGoals,
  awayGoals,
  homeSt,
  awaySt,
  espnGame,
  caps,
} = {}) {
  const cfg = capsOf(caps);
  const baseM = Number.isFinite(Number(modelMargin)) ? Number(modelMargin) : (Number(HFA && HFA.NHL) || 0.15);
  const baseT = Number.isFinite(Number(modelTotal)) ? Number(modelTotal) : NEUTRAL_TOTAL;
  const bHome = Number.isFinite(Number(homeGoals)) ? Number(homeGoals) : LEAGUE_GPG;
  const bAway = Number.isFinite(Number(awayGoals)) ? Number(awayGoals) : LEAGUE_GPG;
  const win = usedStandings ? { marginAdj: 0, totalAdj: 0, used: false, capped: false } : winPctResidual(homeSt, awaySt, cfg);
  const shot = shotResidual(homeSt, awaySt, espnGame, bHome, bAway, cfg);
  const goalie = goalieResidual(espnGame, cfg);
  const sumM = win.marginAdj + shot.marginAdj + goalie.marginAdj;
  const sumT = win.totalAdj + shot.totalAdj + goalie.totalAdj;
  const stacked = capPiece(sumM, sumT, cfg.maxAbsMarginAdj, cfg.maxAbsTotalAdj);
  const capped = !!(stacked.capped || win.capped || shot.capped || goalie.capped);
  return {
    modelMargin: baseM + stacked.marginAdj,
    modelTotal: baseT + stacked.totalAdj,
    marginAdj: stacked.marginAdj,
    totalAdj: stacked.totalAdj,
    capped,
    enginesOn: Math.abs(stacked.marginAdj) > 1e-9 || Math.abs(stacked.totalAdj) > 1e-9,
    shots: shot.used ? { marginAdj: shot.marginAdj, totalAdj: shot.totalAdj } : null,
    goalie: goalie.used ? { marginAdj: goalie.marginAdj, totalAdj: goalie.totalAdj } : null,
    winPct: win.used ? { marginAdj: win.marginAdj } : null,
  };
}

function clampNhlBoard(margin, total) {
  const m0 = Number(margin);
  const t0 = Number(total);
  const m = clamp(Number.isFinite(m0) ? m0 : 0, -NHL_MARGIN_CAP, NHL_MARGIN_CAP);
  const t = clamp(Number.isFinite(t0) ? t0 : NEUTRAL_TOTAL, NHL_TOTAL_MIN, NHL_TOTAL_MAX);
  return {
    modelMargin: m,
    modelTotal: t,
    clamped: Math.abs(m - (Number.isFinite(m0) ? m0 : 0)) > 1e-6 || Math.abs(t - (Number.isFinite(t0) ? t0 : NEUTRAL_TOTAL)) > 1e-6,
  };
}

function buildMethods({ enginesOn, usedGameday }) {
  const base = {
    ml: 'nhl-standings-hfa',
    spread: 'nhl-normal-pl',
    total: 'nhl-total-baseline',
    family: 'nhl-standings-hfa',
  };
  if (enginesOn) {
    for (const k of ['ml', 'spread', 'total', 'family']) {
      if (base[k] && !String(base[k]).includes('engines')) base[k] = `${base[k]}-engines`;
    }
  }
  if (usedGameday) {
    for (const k of ['ml', 'spread', 'total', 'family']) {
      if (base[k] && !String(base[k]).includes('gameday')) base[k] = `${base[k]}-gameday`;
    }
  }
  return base;
}

function logFact(n) {
  let s = 0;
  for (let i = 2; i <= n; i += 1) s += Math.log(i);
  return s;
}

function poissonPmf(k, lam) {
  if (!(lam > 0)) return k === 0 ? 1 : 0;
  if (k < 0) return 0;
  return Math.exp(-lam + k * Math.log(lam) - logFact(k));
}

/**
 * Independent NHL price from expected goals.
 * Regulation is Poisson x Poisson. A tie goes to OT/SO and the home team
 * wins that at OT_HOME. Puck-line -1.5 needs a two-goal regulation win,
 * because an OT winner only wins by one. Totals add the OT goal on a tie.
 */
function nhlScoreMatrix(homeGoals, awayGoals, maxGoals) {
  const cap = maxGoals == null ? 12 : maxGoals;
  const lh = Math.max(0.2, Number(homeGoals) || 0);
  const la = Math.max(0.2, Number(awayGoals) || 0);
  const ph = [];
  const pa = [];
  for (let i = 0; i <= cap; i += 1) {
    ph.push(poissonPmf(i, lh));
    pa.push(poissonPmf(i, la));
  }
  const margin = new Map();
  const totals = new Map();
  let mass = 0;
  const add = (map, key, p) => map.set(key, (map.get(key) || 0) + p);
  for (let i = 0; i <= cap; i += 1) {
    for (let j = 0; j <= cap; j += 1) {
      const p = ph[i] * pa[j];
      if (!(p > 0)) continue;
      mass += p;
      if (i !== j) {
        add(margin, i - j, p);
        add(totals, i + j, p);
      } else {
        add(margin, 1, p * OT_HOME);
        add(margin, -1, p * (1 - OT_HOME));
        add(totals, i + j + 1, p);
      }
    }
  }
  return { margin, totals, mass };
}

function lambdasFromBoard(margin, total) {
  const m = Number.isFinite(Number(margin)) ? Number(margin) : 0;
  const t = Number.isFinite(Number(total)) ? Number(total) : NEUTRAL_TOTAL;
  return {
    home: Math.max(0.2, (t + m) / 2),
    away: Math.max(0.2, (t - m) / 2),
  };
}

function sideWinProb(massMap, thresh) {
  let win = 0;
  let loss = 0;
  for (const [k, p] of massMap) {
    if (Math.abs(k - thresh) < 1e-9) continue;
    if (k > thresh) win += p;
    else loss += p;
  }
  const live = win + loss;
  if (!(live > 0)) return 0.5;
  return clamp(win / live, 0.02, 0.98);
}

/**
 * Moneyline, puck line, or total. `isHome` is this side.
 * Spread `line` is this side's points. Total `line` is the number.
 */
function nhlMarketProb({ margin, total, market, isHome, line, side }) {
  const lam = lambdasFromBoard(margin, total);
  const matrix = nhlScoreMatrix(lam.home, lam.away);
  const family = String(market || '');
  if (family === 'Moneyline' || /moneyline/i.test(family)) {
    let home = 0;
    let away = 0;
    for (const [k, p] of matrix.margin) {
      if (k > 0) home += p;
      else if (k < 0) away += p;
    }
    const p = isHome ? home : away;
    const s = home + away;
    return s > 0 ? clamp(p / s, 0.02, 0.98) : 0.5;
  }
  if (family === 'Total' || /total/i.test(family)) {
    const number = Number(line);
    let over = 0;
    let under = 0;
    for (const [k, p] of matrix.totals) {
      if (k > number) over += p;
      else if (k < number) under += p;
    }
    const wantOver = /over/i.test(side || '');
    return sideWinProb(new Map([[1, wantOver ? over : under], [-1, wantOver ? under : over]]), 0);
  }
  const points = Number(line);
  const signed = new Map();
  for (const [k, p] of matrix.margin) signed.set(isHome ? k : -k, p);
  return sideWinProb(signed, -points);
}

function findEspnGame(ev, espnGames) {
  if (!espnGames || !espnGames.length || !ev) return null;
  const home = (ev.home_team || '').toLowerCase();
  const away = (ev.away_team || '').toLowerCase();
  return espnGames.find(g => {
    const gh = (g.homeTeam || '').toLowerCase();
    const ga = (g.awayTeam || '').toLowerCase();
    return (gh.includes(home.split(' ').pop()) || home.includes((gh.split(' ').pop() || '')))
      && (ga.includes(away.split(' ').pop()) || away.includes((ga.split(' ').pop() || '')));
  }) || null;
}

function projectGame(event, standings, espnGame, gameDay) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const homeSt = fuzzyTeam(home, standings);
  const awaySt = fuzzyTeam(away, standings);
  const env = nhlStandingsEnv(homeSt, awaySt);
  const soft = applyNhlEngineSoft({
    modelMargin: env.modelMargin,
    modelTotal: env.modelTotal,
    usedStandings: env.usedStandings,
    homeGoals: env.homeGoals,
    awayGoals: env.awayGoals,
    homeSt,
    awaySt,
    espnGame,
    caps: ENGINE_SOFT && ENGINE_SOFT.NHL,
  });
  let uncertainty = env.usedStandings ? 0.20 : 0.30;
  const gdBag = gameDay || {};
  const restTable = (gdBag.restByTeam && (gdBag.restByTeam.NHL || gdBag.restByTeam)) || {};
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin: soft.modelMargin,
    modelTotal: soft.modelTotal,
    uncertainty,
    home,
    away,
    restByTeam: restTable,
    qbByTeam: {},
    hfaBase: HFA.NHL,
  });
  const board = clampNhlBoard(gd.modelMargin, gd.modelTotal);
  const modelMargin = board.modelMargin;
  const modelTotal = board.modelTotal;
  uncertainty = gd.uncertainty;
  const usedGameday = !!(gd.gameDay && gd.gameDay.applied);
  const methods = buildMethods({ enginesOn: soft.enginesOn, usedGameday });
  const gameDayMeta = {
    ...(gd.gameDay || {}),
    applied: usedGameday,
    sanityClamped: board.clamped,
    enginesApplied: soft.enginesOn,
  };
  const engineSoft = {
    used: soft.enginesOn,
    marginAdj: +soft.marginAdj.toFixed(3),
    totalAdj: +soft.totalAdj.toFixed(3),
    capped: soft.capped,
    shots: soft.shots,
    goalie: soft.goalie,
    winPct: soft.winPct,
  };
  const out = [];

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = nhlMarketProb({
        margin: modelMargin, total: modelTotal, market: 'Moneyline', isHome, side: b.side,
      });
      p = blendWithMarket(p, noVigPinnacleCircaImplied(bundles, b), BLEND.ml);
      out.push(enrichCandidateWithEdge({
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null,
        modelRawP: p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
      }, b, bundles));
    }
  }

  {
    const bundles = collectLinesForEdge(event, 'spreads');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const isHome = b.side === home;
      let pCover = nhlMarketProb({
        margin: modelMargin, total: modelTotal, market: 'Spread', isHome, line, side: b.side,
      });
      pCover = blendWithMarket(pCover, noVigPinnacleCircaImplied(bundles, b), BLEND.spread);
      const sideLabel = line > 0 ? `${b.side} +${line}` : `${b.side} ${line}`;
      out.push(enrichCandidateWithEdge({
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line,
        modelRawP: pCover, projMethod: methods.spread, uncertainty,
        consensusLine: line, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
      }, b, bundles));
    }
  }

  {
    const bundles = collectLinesForEdge(event, 'totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      let p = nhlMarketProb({
        margin: modelMargin, total: modelTotal, market: 'Total', isHome: false, line, side: b.side,
      });
      p = blendWithMarket(p, noVigPinnacleCircaImplied(bundles, b), BLEND.total);
      out.push(enrichCandidateWithEdge({
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${line}`, line,
        modelRawP: p, projMethod: methods.total, uncertainty: uncertainty + 0.05,
        consensusLine: line, modelProjection: +modelTotal.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
      }, b, bundles));
    }
  }

  return out;
}

function project({ oddsEvents, standings, gameDay, espnGames } = {}) {
  const games = (espnGames && espnGames.games) || espnGames || [];
  return mapGamesSoft(oddsEvents, (ev) => {
    const eg = findEspnGame(ev, games);
    return projectGame(ev, standings || {}, eg, gameDay || {});
  });
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[% ,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function statFromList(stats, names) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  for (const s of stats || []) {
    const name = String((s && (s.name || s.abbreviation)) || '').toLowerCase();
    if (!want.has(name)) continue;
    const n = numOrNull(s.value != null ? s.value : s.displayValue);
    if (n != null) return n;
  }
  return null;
}

function positionAbbr(pos) {
  if (pos == null) return '';
  if (typeof pos === 'string') return pos;
  return pos.abbreviation || pos.name || '';
}

function isSkaterPos(pos) {
  const p = String(pos || '').toUpperCase();
  return p === 'C' || p === 'LW' || p === 'RW' || p === 'D' || p === 'F' || p === 'W';
}

/**
 * One probable/confirmed starter from an ESPN competitor probable.
 * Save% may be missing. The caller fills it from the athlete overview.
 * Returns null for a skater or an empty slot.
 */
function goalieFromProbable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const athlete = raw.athlete || {};
  const pos = positionAbbr(athlete.position);
  if (isSkaterPos(pos)) return null;
  const name = athlete.displayName || athlete.fullName || raw.displayName || null;
  let savePct = raw.savePct != null ? raw.savePct : raw.svPct;
  if (savePct == null) savePct = statFromList(raw.statistics, ['savePct', 'savePercentage', 'svPct']);
  let shots = raw.shotsAgainst != null ? raw.shotsAgainst : raw.shots;
  if (shots == null) shots = statFromList(raw.statistics, ['shotsAgainst', 'shots']);
  const statusObj = raw.status && typeof raw.status === 'object' ? raw.status : null;
  const statusStr = String(
    (statusObj && (statusObj.type || statusObj.name)) || (typeof raw.status === 'string' ? raw.status : '')
  ).toLowerCase();
  const confirmed = raw.starter === true || raw.confirmed === true
    || statusStr === 'confirmed' || statusStr === 'starter';
  if (!name && savePct == null) return null;
  const id = athlete.id != null ? athlete.id : (raw.playerId != null ? raw.playerId : raw.id);
  const shotN = numOrNull(shots);
  return {
    id: id != null ? String(id) : null,
    name,
    savePct: savePct != null ? savePct : null,
    shotsAgainst: shotN != null && shotN > 0 ? shotN : null,
    confirmed,
    probable: !confirmed,
    status: confirmed ? 'confirmed' : 'probable',
  };
}

function firstGoalieFromCompetitor(competitor) {
  const list = competitor && Array.isArray(competitor.probables) ? competitor.probables : [];
  for (const raw of list) {
    const g = goalieFromProbable(raw);
    if (g) return g;
  }
  return null;
}

function goaliesFromSummary(summary) {
  const competitions = summary && summary.header && summary.header.competitions;
  const comp = Array.isArray(competitions) ? competitions[0] : null;
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c && c.homeAway === 'home') || null;
  const away = competitors.find((c) => c && c.homeAway === 'away') || null;
  return {
    home: firstGoalieFromCompetitor(home),
    away: firstGoalieFromCompetitor(away),
  };
}

/**
 * Season goalie line from the public athlete overview.
 * Regular season only. Career and projected splits are ignored.
 */
function parseAthleteGoalieOverview(overview) {
  const stats = overview && overview.statistics;
  const block = Array.isArray(stats)
    ? stats.find((b) => b && Array.isArray(b.names) && Array.isArray(b.splits))
    : (stats && Array.isArray(stats.names) ? stats : null);
  if (!block) return null;
  const split = (block.splits || []).find((s) => /regular season/i.test(String(s && s.displayName || '')));
  if (!split || !Array.isArray(split.stats)) return null;
  const read = (name) => {
    const i = block.names.indexOf(name);
    if (i < 0) return null;
    return split.stats[i];
  };
  const savePct = read('savePct');
  const shots = numOrNull(read('shotsAgainst'));
  if (savePct == null && !(shots > 0)) return null;
  return {
    savePct: savePct != null ? savePct : null,
    shotsAgainst: shots > 0 ? shots : null,
  };
}

/** Roster row keyed by athlete id. Used when the overview shape is a roster. */
function parseRosterGoalie(doc, athleteId) {
  const roster = doc && (doc.roster || doc.athletes);
  if (!Array.isArray(roster) || athleteId == null) return null;
  const row = roster.find((r) => {
    const id = (r && r.athlete && r.athlete.id) || (r && r.id);
    return String(id) === String(athleteId);
  });
  if (!row) return null;
  const pos = positionAbbr(row.athlete && row.athlete.position);
  if (isSkaterPos(pos)) return null;
  const shots = numOrNull(row.shotsAgainst != null ? row.shotsAgainst : row.shots);
  return {
    savePct: row.savePct != null ? row.savePct : (row.svPct != null ? row.svPct : null),
    shotsAgainst: shots > 0 ? shots : null,
  };
}

function mergeGoalieStats(base, extra) {
  if (!base || typeof base !== 'object') return null;
  const g = { ...base };
  if (extra && typeof extra === 'object') {
    if ((g.savePct == null || g.savePct === '') && extra.savePct != null) g.savePct = extra.savePct;
    const shots = numOrNull(g.shotsAgainst != null ? g.shotsAgainst : g.shots);
    const extraShots = numOrNull(extra.shotsAgainst != null ? extra.shotsAgainst : extra.shots);
    if (!(shots > 0) && extraShots > 0) g.shotsAgainst = extraShots;
  }
  const rate = asUnitRate(g.savePct != null ? g.savePct : g.svPct, 'save');
  if (rate == null) return null;
  g.savePct = rate;
  return g;
}

/**
 * Team shot profile from the public team statistics payload, or a flat bag.
 * Season totals (shots above 42) are divided by games. Under 5 games → null.
 */
function parseTeamShotStats(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let bag = payload;
  const cats = payload.results && payload.results.stats && payload.results.stats.categories;
  if (Array.isArray(cats)) {
    bag = {};
    for (const cat of cats) {
      for (const s of (cat && cat.stats) || []) {
        if (!s || !s.name) continue;
        const n = numOrNull(s.value != null ? s.value : s.displayValue);
        if (n != null) bag[s.name] = n;
      }
    }
  }
  const games = numOrNull(bag.games != null ? bag.games : bag.gamesPlayed);
  let shotsFor = numOrNull(bag.shotsTotal != null ? bag.shotsTotal : (bag.shotsFor != null ? bag.shotsFor : bag.shots));
  let shotsAgainst = numOrNull(bag.shotsAgainst);
  if (shotsFor == null || shotsAgainst == null) return null;
  if (shotsFor > 42 || shotsAgainst > 42) {
    if (!(games >= NHL_MIN_GAMES)) return null;
    shotsFor /= games;
    shotsAgainst /= games;
  }
  if (shotsFor < 20 || shotsFor > 42 || shotsAgainst < 20 || shotsAgainst > 42) return null;
  const share = shotsFor / (shotsFor + shotsAgainst);
  if (!Number.isFinite(share)) return null;
  return {
    shotsFor,
    shotsAgainst,
    shotShare: share,
    savePct: bag.savePct != null ? bag.savePct : (bag.savePercentage != null ? bag.savePercentage : null),
    shootingPct: bag.shootingPct != null ? bag.shootingPct : (bag.shootingPercentage != null ? bag.shootingPercentage : null),
    games: games != null ? games : null,
  };
}

module.exports = {
  project,
  SPORT,
  nhlStandingsEnv,
  applyNhlEngineSoft,
  teamGpg,
  nhlMarketProb,
  regressSavePct,
  goalieFromProbable,
  firstGoalieFromCompetitor,
  goaliesFromSummary,
  parseAthleteGoalieOverview,
  parseRosterGoalie,
  mergeGoalieStats,
  parseTeamShotStats,
  goalieTrust,
  OT_HOME,
  PHANTOM_SHOTS,
  SHOT_SHARE_MARGIN,
  SHOT_VOLUME_TOTAL,
  LEAGUE_SHOTS_PG,
  PROBABLE_GOALIE_WEIGHT,
  LG_SAVE,
  NHL_MARGIN_CAP,
  NHL_TOTAL_MIN,
  NHL_TOTAL_MAX,
};
