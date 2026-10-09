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
 *
 * GF/GA per game shrinks toward the league mean (K = 34) so an early rate
 * outside [1.5, 5.2] is clamped, not dropped onto the flat 6.2 baseline.
 * OMEGA_NHL_SHRINK_MODE and OMEGA_NHL_SHRINK_K pick the variant at call time.
 */
const { clamp } = require('../odds_math');
const { HFA, ENGINE_SOFT } = require('../config');
const {
  formatMatchup, mapGamesSoft, LEAGUE_PPG,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { rowByIdentityOrFuzzy } = require('./team_identity');
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
/**
 * Raw GF/GP or GA/GP above this is corrupt, not a hot start.
 * No NHL club averages 10+ over 2+ games. Real early extremes are ~7 and
 * still shrink. Above this returns the baseline ('implausible rate').
 */
const NHL_GPG_IMPLAUSIBLE = 10;
/**
 * Empirical-Bayes prior strength, in games, for GF/GP and GA/GP.
 * Per-game goals are roughly Poisson, so sampling variance ≈ LEAGUE_GPG (3.1).
 * Between-team true-talent SD is about 0.30 goals/game.
 * K = variance / talentSD^2 = 3.1 / 0.30^2 ≈ 34.4, taken as 34.
 * Chosen a priori, not fit on a replay.
 * gf_hat = (GF_sum + K * LEAGUE_GPG) / (gp + K), same for GA, then clamped
 * to [NHL_GPG_FLOOR, NHL_GPG_CAP]. OMEGA_NHL_SHRINK_K overrides K at call
 * time (0 or "off" = no shrink). OMEGA_NHL_SHRINK_MODE is 'all' (default),
 * 'oob' (shrink only clubs the old band would have nulled), or 'off'
 * (exact pre-shrink behavior). "0" / "off" disables the mode.
 */
const NHL_GPG_PRIOR_GAMES = 34;
/**
 * Season-sum GF/GA is eligible once games played reach this.
 * A sum is pf/pa above ~1.8× league gpg, or ingest's nhlSeasonGoals flag
 * (ESPN Goals For, which is cumulative even when the total is still small).
 * gp below this (one game) stays on the 6.2 / HFA baseline. Week-1 clubs
 * were stuck there when this was 5. [NHL_GPG_FLOOR, NHL_GPG_CAP] clamps the
 * shrunk rate; it does not drop the club. Win% and shot season-sums use
 * NHL_SOFT_MIN_GAMES, not this spine.
 */
const NHL_MIN_GAMES = 2;
const NHL_SOFT_MIN_GAMES = 5;
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

function envToggle(name) {
  const raw = process.env[name];
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s === '' ? null : s;
}

/** Read at call time so a replay can switch variants without a new commit. */
function shrinkSettings() {
  const modeText = envToggle('OMEGA_NHL_SHRINK_MODE');
  let mode = 'all';
  if (modeText === '0' || modeText === 'off') mode = 'off';
  else if (modeText === 'oob' || modeText === 'all') mode = modeText;
  const kText = envToggle('OMEGA_NHL_SHRINK_K');
  let k = NHL_GPG_PRIOR_GAMES;
  if (kText === '0' || kText === 'off') k = 0;
  else if (kText != null) {
    const n = Number(kText);
    if (Number.isFinite(n) && n >= 0) k = n;
  }
  return { mode, k };
}

function noneGpg(baseline) {
  return { gf: null, ga: null, gfRaw: null, gaRaw: null, gp: null, shrinkWeight: null, baseline };
}

function inGpgBand(x) {
  return x >= NHL_GPG_FLOOR && x <= NHL_GPG_CAP;
}

function goalsPair(st) {
  if (!st || typeof st !== 'object') return null;
  const pf = Number(st.pf != null ? st.pf : st.gf);
  const pa = Number(st.pa != null ? st.pa : st.ga);
  return { pf, pa };
}

/**
 * Pre-shrink teamGpg. Same nulls and the same { gf, ga } values as main
 * before this change. Kept so OMEGA_NHL_SHRINK_MODE=off matches that output.
 */
function legacyDetail(st) {
  const pair = goalsPair(st);
  if (!pair) return noneGpg('no goals data');
  const { pf, pa } = pair;
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || pf < 0 || pa < 0) return noneGpg('implausible rate');
  if (pf === 0 || pa === 0) return noneGpg('no goals data');
  if (st.nhlSeasonGoals !== true &&
      (pfLooksLikeStandingsPoints(st, pf) || pfLooksLikeStandingsPoints(st, pa))) {
    return noneGpg('standings-points guard');
  }
  let gf = pf;
  let ga = pa;
  const g = nhlGames(st);
  const seasonSum = st.nhlSeasonGoals === true || pf > LEAGUE_GPG * 1.8 || pa > LEAGUE_GPG * 1.8;
  if (seasonSum) {
    if (g < NHL_MIN_GAMES) return noneGpg('gp<2');
    gf = pf / g;
    ga = pa / g;
  }
  if (!Number.isFinite(gf) || !Number.isFinite(ga)) return noneGpg('implausible rate');
  if (gf > NHL_GPG_IMPLAUSIBLE || ga > NHL_GPG_IMPLAUSIBLE) return noneGpg('implausible rate');
  if (!(inGpgBand(gf) && inGpgBand(ga))) return noneGpg('out of band');
  return {
    gf,
    ga,
    gfRaw: gf,
    gaRaw: ga,
    gp: seasonSum ? g : (g > 0 ? g : null),
    shrinkWeight: 0,
    baseline: null,
  };
}

function finishFromSums(gfSum, gaSum, gp, k, mode) {
  if (!(gp > 0) || !Number.isFinite(gfSum) || !Number.isFinite(gaSum)) return noneGpg('implausible rate');
  const gfRaw = gfSum / gp;
  const gaRaw = gaSum / gp;
  if (!Number.isFinite(gfRaw) || !Number.isFinite(gaRaw) || gfRaw < 0 || gaRaw < 0) {
    return noneGpg('implausible rate');
  }
  if (gfRaw > NHL_GPG_IMPLAUSIBLE || gaRaw > NHL_GPG_IMPLAUSIBLE) return noneGpg('implausible rate');
  if (mode === 'oob' && inGpgBand(gfRaw) && inGpgBand(gaRaw)) {
    return { gf: gfRaw, ga: gaRaw, gfRaw, gaRaw, gp, shrinkWeight: 0, baseline: null };
  }
  let gf = gfRaw;
  let ga = gaRaw;
  let shrinkWeight = 0;
  if (k > 0) {
    gf = (gfSum + k * LEAGUE_GPG) / (gp + k);
    ga = (gaSum + k * LEAGUE_GPG) / (gp + k);
    shrinkWeight = k / (gp + k);
  }
  return {
    gf: clamp(gf, NHL_GPG_FLOOR, NHL_GPG_CAP),
    ga: clamp(ga, NHL_GPG_FLOOR, NHL_GPG_CAP),
    gfRaw,
    gaRaw,
    gp,
    shrinkWeight,
    baseline: null,
  };
}

/**
 * Goals for/against per game.
 * Season sums (nhlSeasonGoals, or a total above ~1.8× league gpg) shrink as
 * (sum + K * LEAGUE_GPG) / (gp + K) once gp reaches NHL_MIN_GAMES.
 * Per-game rates with a known gp convert to sums, then shrink the same way.
 * A per-game rate with no gp keeps the old pass-through: in band, or null.
 * gp below NHL_MIN_GAMES on a season sum stays null (6.2 baseline).
 * [NHL_GPG_FLOOR, NHL_GPG_CAP] clamps the shrunk rate. It does not null it.
 * Zero goals after 2+ games is real data. A raw rate above
 * NHL_GPG_IMPLAUSIBLE, or a non-finite / negative total, is 'implausible rate'.
 * Standings points (2*W+OTL) still null, unless nhlSeasonGoals is set.
 * Returns null from teamGpg when baseline is set. teamGpgDetail keeps the reason.
 */
function teamGpgDetail(st) {
  const cfg = shrinkSettings();
  if (cfg.mode === 'off') return legacyDetail(st);
  const pair = goalsPair(st);
  if (!pair) return noneGpg('no goals data');
  const { pf, pa } = pair;
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || pf < 0 || pa < 0) return noneGpg('implausible rate');
  if (st.nhlSeasonGoals !== true &&
      (pfLooksLikeStandingsPoints(st, pf) || pfLooksLikeStandingsPoints(st, pa))) {
    return noneGpg('standings-points guard');
  }
  const g = nhlGames(st);
  const seasonSum = st.nhlSeasonGoals === true || pf > LEAGUE_GPG * 1.8 || pa > LEAGUE_GPG * 1.8;
  if (seasonSum) {
    if (g < NHL_MIN_GAMES) return noneGpg('gp<2');
    return finishFromSums(pf, pa, g, cfg.k, cfg.mode);
  }
  if (!(g > 0)) {
    if (!(pf > 0 && pa > 0)) return noneGpg('no goals data');
    if (pf > NHL_GPG_IMPLAUSIBLE || pa > NHL_GPG_IMPLAUSIBLE) return noneGpg('implausible rate');
    if (inGpgBand(pf) && inGpgBand(pa)) {
      return { gf: pf, ga: pa, gfRaw: pf, gaRaw: pa, gp: null, shrinkWeight: 0, baseline: null };
    }
    return noneGpg('out of band');
  }
  if ((pf === 0 || pa === 0) && g < NHL_MIN_GAMES) return noneGpg('no goals data');
  return finishFromSums(pf * g, pa * g, g, cfg.k, cfg.mode);
}

function teamGpg(st) {
  const d = teamGpgDetail(st);
  if (!d || d.baseline) return null;
  if (shrinkSettings().mode === 'off') return { gf: d.gf, ga: d.ga };
  return {
    gf: d.gf,
    ga: d.ga,
    gfRaw: d.gfRaw,
    gaRaw: d.gaRaw,
    gp: d.gp,
    shrinkWeight: d.shrinkWeight,
  };
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
  if (g >= NHL_SOFT_MIN_GAMES && Number.isFinite(wins) && wins >= 0 && wins <= g) return wins / g;
  return null;
}

function sideDiag(prefix, detail) {
  const d = detail || {};
  const onBase = !d || !!d.baseline;
  return {
    [`${prefix}GfRaw`]: onBase ? null : d.gfRaw,
    [`${prefix}GaRaw`]: onBase ? null : d.gaRaw,
    [`${prefix}Gp`]: onBase ? null : d.gp,
    [`${prefix}ShrinkWeight`]: onBase ? null : d.shrinkWeight,
    [`${prefix}Baseline`]: d.baseline || null,
  };
}

/**
 * Home margin = (home goals − away goals) + HFA. Total = the sum.
 * Equal clubs land on HFA and 6.2. Missing either side stays on that baseline.
 * gfRaw / gaRaw / gp / shrinkWeight are private diag on this env. They are
 * not copied onto candidates.
 */
function nhlStandingsEnv(homeSt, awaySt) {
  const hfa = Number.isFinite(Number(HFA && HFA.NHL)) ? Number(HFA.NHL) : 0.15;
  const h = teamGpgDetail(homeSt);
  const a = teamGpgDetail(awaySt);
  const diag = { ...sideDiag('home', h), ...sideDiag('away', a) };
  const neutral = {
    modelMargin: hfa,
    modelTotal: NEUTRAL_TOTAL,
    usedStandings: false,
    homeGoals: LEAGUE_GPG,
    awayGoals: LEAGUE_GPG,
    ...diag,
  };
  if (!h || h.baseline || !a || a.baseline) return neutral;
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
    ...diag,
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
    if (!(games >= NHL_SOFT_MIN_GAMES)) return null;
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

function projectGame(event, standings, espnGame, gameDay, fallbackSeen, baseline) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const homeSt = rowByIdentityOrFuzzy('NHL', standings, home, { fallbackSeen });
  const awaySt = rowByIdentityOrFuzzy('NHL', standings, away, { fallbackSeen });
  const env = nhlStandingsEnv(homeSt, awaySt);
  if (baseline) {
    if (env.homeBaseline) baseline.push(`${home || '?'} (${env.homeBaseline})`);
    if (env.awayBaseline) baseline.push(`${away || '?'} (${env.awayBaseline})`);
  }
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
    fallbackSeen,
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
    // Odds API h2h is 3-way and includes Draw. Drop it before any candidate
    // or de-vig so a Draw side never reaches the gates.
    const bundles = collectMarketOutcomes(event, 'h2h').filter((b) => {
      return String(b && b.side || '').trim().toLowerCase() !== 'draw';
    });
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
  const fallbackSeen = new Set();
  const baseline = [];
  const rows = mapGamesSoft(oddsEvents, (ev) => {
    const eg = findEspnGame(ev, games);
    return projectGame(ev, standings || {}, eg, gameDay || {}, fallbackSeen, baseline);
  });
  const seen = new Set();
  const uniq = [];
  for (const item of baseline) {
    if (seen.has(item)) continue;
    seen.add(item);
    uniq.push(item);
  }
  const list = uniq.length ? uniq.join(', ') : '(none)';
  console.log(`[omega-nhl] baseline teams: ${list}`);
  return rows;
}

module.exports = {
  project,
  SPORT,
  nhlStandingsEnv,
  applyNhlEngineSoft,
  teamGpg,
  teamGpgDetail,
  NHL_MIN_GAMES,
  NHL_GPG_PRIOR_GAMES,
  NHL_GPG_IMPLAUSIBLE,
  NHL_GPG_FLOOR,
  NHL_GPG_CAP,
  NHL_MARGIN_CAP,
  NHL_TOTAL_MIN,
  NHL_TOTAL_MAX,
};
