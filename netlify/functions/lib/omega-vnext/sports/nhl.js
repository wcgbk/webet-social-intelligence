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
 * Missing shots, savePct, or goalie rates soft-fail to 0. Residuals sit
 * under ENGINE_SOFT.NHL. Final margin/total soft-clamp (|spread| 6, total 12)
 * and still emit a candidate.
 */
const { clamp } = require('../odds_math');
const { HFA, ENGINE_SOFT } = require('../config');
const {
  formatMatchup, fuzzyTeam, mapGamesSoft, LEAGUE_PPG,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { applyGameDayAdjustments } = require('./game_day');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');

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
const LG_SHOOT = 0.10;
const BLEND = { ml: 0.50, spread: 0.50, total: 0.45 };

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

function shotProfile(bag, games) {
  if (!bag || typeof bag !== 'object') return null;
  const shotsFor = ratePerGame(bag.shotsFor != null ? bag.shotsFor : bag.shots, games, 60);
  const shotsAgainst = ratePerGame(
    bag.shotsAgainst != null ? bag.shotsAgainst : bag.shotsAgainstPerGame,
    games,
    60
  );
  const savePct = asUnitRate(bag.savePct != null ? bag.savePct : bag.savePercentage, 'save');
  let shootingPct = asUnitRate(
    bag.shootingPct != null ? bag.shootingPct : bag.shootingPercentage,
    'shoot'
  );
  if (shotsFor == null || shotsAgainst == null || savePct == null) return null;
  if (shootingPct == null) shootingPct = LG_SHOOT;
  if (savePct < 0.85 || savePct > 0.95) return null;
  if (shootingPct < 0.05 || shootingPct > 0.16) return null;
  if (shotsFor < 20 || shotsFor > 42 || shotsAgainst < 20 || shotsAgainst > 42) return null;
  return { shotsFor, shotsAgainst, savePct, shootingPct };
}

function espnSideBag(espnGame, side) {
  if (!espnGame || typeof espnGame !== 'object') return null;
  if (side === 'home') return espnGame.homeStats || espnGame.homeTeamStats || null;
  return espnGame.awayStats || espnGame.awayTeamStats || null;
}

function shotResidual(homeSt, awaySt, espnGame, baseHome, baseAway, cfg) {
  const none = { marginAdj: 0, totalAdj: 0, used: false, capped: false };
  const h = shotProfile(homeSt, nhlGames(homeSt)) || shotProfile(espnSideBag(espnGame, 'home'), nhlGames(homeSt));
  const a = shotProfile(awaySt, nhlGames(awaySt)) || shotProfile(espnSideBag(espnGame, 'away'), nhlGames(awaySt));
  if (!h || !a) return none;
  const homeExpShots = (h.shotsFor + a.shotsAgainst) / 2;
  const awayExpShots = (a.shotsFor + h.shotsAgainst) / 2;
  const denom = 1 - LG_SAVE;
  if (!(denom > 0)) return none;
  const homeFactor = clamp((1 - a.savePct) / denom, 0.70, 1.40);
  const awayFactor = clamp((1 - h.savePct) / denom, 0.70, 1.40);
  const effHome = homeExpShots * h.shootingPct * homeFactor;
  const effAway = awayExpShots * a.shootingPct * awayFactor;
  if (!Number.isFinite(effHome) || !Number.isFinite(effAway)) return none;
  const rawM = (effHome - effAway) - (baseHome - baseAway);
  const rawT = (effHome + effAway) - (baseHome + baseAway);
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

function goalieResidual(espnGame, cfg) {
  const none = { marginAdj: 0, totalAdj: 0, used: false, capped: false };
  const hg = goalieOf(espnGame, 'home');
  const ag = goalieOf(espnGame, 'away');
  if (!hg || !ag) return none;
  if (hg.confirmed === false || ag.confirmed === false) return none;
  const hs = asUnitRate(hg.savePct != null ? hg.savePct : hg.svPct, 'save');
  const asv = asUnitRate(ag.savePct != null ? ag.savePct : ag.svPct, 'save');
  if (hs == null || asv == null) return none;
  if (hs < 0.85 || hs > 0.95 || asv < 0.85 || asv > 0.95) return none;
  const perM = Number.isFinite(Number(cfg.goalieMarginPerSave)) ? Number(cfg.goalieMarginPerSave) : 8;
  const perT = Number.isFinite(Number(cfg.goalieTotalPerSave)) ? Number(cfg.goalieTotalPerSave) : 6;
  const capM = Number.isFinite(Number(cfg.goalieMaxAbsMarginAdj)) ? Number(cfg.goalieMaxAbsMarginAdj) : 0.12;
  const capT = Number.isFinite(Number(cfg.goalieMaxAbsTotalAdj)) ? Number(cfg.goalieMaxAbsTotalAdj) : 0.10;
  // Better home save → fewer away goals. Both above-average saves trim the total.
  const rawM = (hs - asv) * perM;
  const rawT = -((hs - LG_SAVE) + (asv - LG_SAVE)) * perT;
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
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
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
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const isHome = b.side === home;
      let pCover = spreadCoverProb(isHome ? modelMargin : -modelMargin, line, SPORT);
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
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      let p = totalCoverProb(modelTotal, line, b.side, SPORT);
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

module.exports = {
  project,
  SPORT,
  nhlStandingsEnv,
  applyNhlEngineSoft,
  teamGpg,
  NHL_MARGIN_CAP,
  NHL_TOTAL_MIN,
  NHL_TOTAL_MAX,
};
