'use strict';

/**
 * NFL/CFB EPA-style off/def priors.
 * defEpa is defensive strength per play (higher = better, sign-flipped EPA allowed).
 * Both teams must match a clean prior; otherwise the caller keeps standings power.
 * Sierra blend only when standings pf/pa and a game count are clean.
 */

const { HFA } = require('../config');
const { clamp } = require('../odds_math');
const { fuzzyTeam, powerFromStandings } = require('./_common');

const SIERRA_W = 0.2;
const LEAGUE_SUCCESS = 0.43;

const SPORT_CFG = {
  NFL: {
    plays: 62,
    leaguePpg: 22,
    baseTotal: 45,
    totalSlope: 0.05,
    epaUncertainty: 0.13,
    totalUncBump: 0.04,
    family: 'nfl-epa-v1',
    fallback: {
      ml: 'nfl-normal-ml',
      spread: 'nfl-normal-spread',
      total: 'nfl-total-baseline',
    },
    marginCap: 24,
    totalMin: 32,
    totalMax: 66,
  },
  NCAAF: {
    plays: 68,
    leaguePpg: 27.5,
    baseTotal: 52,
    totalSlope: 0.04,
    epaUncertainty: 0.17,
    totalUncBump: 0.05,
    family: 'cfb-epa-v1',
    fallback: {
      ml: 'cfb-normal-ml',
      spread: 'cfb-normal-spread',
      total: 'cfb-total-baseline',
    },
    marginCap: 31,
    totalMin: 35,
    totalMax: 82,
  },
};

function isCleanEpa(row) {
  if (!row || typeof row !== 'object') return false;
  const off = Number(row.offEpa);
  const def = Number(row.defEpa);
  if (!Number.isFinite(off) || !Number.isFinite(def)) return false;
  // Per-play scale. Point-level numbers would explode the margin — reject.
  if (Math.abs(off) > 0.8 || Math.abs(def) > 0.8) return false;
  return true;
}

function lookupEpa(teamName, table) {
  const row = fuzzyTeam(teamName, table || {});
  if (!isCleanEpa(row)) return null;
  return {
    offEpa: Number(row.offEpa),
    defEpa: Number(row.defEpa),
    offSuccess: row.offSuccess,
    defSuccess: row.defSuccess,
  };
}

function gamesPlayed(st) {
  if (!st || typeof st !== 'object') return 0;
  if (Number.isFinite(Number(st.games)) && Number(st.games) > 0) return Number(st.games);
  const w = Number(st.wins);
  const l = Number(st.losses);
  const t = Number(st.ties);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  return w + l + (Number.isFinite(t) ? t : 0);
}

/**
 * Blend seed EPA toward current points/game when standings are clean.
 * Unclean (missing games, absurd ppg) returns the seed unchanged.
 */
function sierraAdjust(epa, standingsRow, cfg) {
  const base = {
    offEpa: Number(epa.offEpa),
    defEpa: Number(epa.defEpa),
    offSuccess: epa.offSuccess,
    defSuccess: epa.defSuccess,
    adjusted: false,
  };
  if (!standingsRow) return base;
  const pf = Number(standingsRow.pf);
  const pa = Number(standingsRow.pa);
  const g = gamesPlayed(standingsRow);
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || g < 2) return base;
  // ESPN sometimes sends season totals, sometimes per-game. Totals exceed ~1.8x league ppg.
  const threshold = cfg.leaguePpg * 1.8;
  const pfPg = pf > threshold ? pf / g : pf;
  const paPg = pa > threshold ? pa / g : pa;
  if (![pfPg, paPg].every(n => Number.isFinite(n) && n >= 6 && n <= 55)) return base;
  const offFromSt = (pfPg - cfg.leaguePpg) / cfg.plays;
  const defFromSt = (cfg.leaguePpg - paPg) / cfg.plays;
  const w = SIERRA_W;
  return {
    ...base,
    offEpa: (1 - w) * base.offEpa + w * offFromSt,
    defEpa: (1 - w) * base.defEpa + w * defFromSt,
    adjusted: true,
  };
}

function successTotalAdj(homeEpa, awayEpa) {
  const vals = [
    homeEpa.offSuccess, homeEpa.defSuccess, awayEpa.offSuccess, awayEpa.defSuccess,
  ].map(Number);
  if (vals.some(v => !Number.isFinite(v) || v <= 0 || v >= 1)) return 0;
  const [hos, hds, aos, ads] = vals;
  const offEnv = ((hos + aos) / 2) - LEAGUE_SUCCESS;
  const defEnv = ((hds + ads) / 2) - LEAGUE_SUCCESS;
  return (offEnv - defEnv) * 12;
}

function fallbackUncertainty(sport, homeSt, awaySt) {
  if (sport === 'NCAAF') return 0.22;
  return (homeSt && awaySt) ? 0.16 : 0.26;
}

/**
 * Home margin and total. engine family is null on the standings path.
 */
function footballProjection({ sport, home, away, standings, efficiency }) {
  const cfg = SPORT_CFG[sport] || SPORT_CFG.NFL;
  const table = efficiency && typeof efficiency === 'object' ? efficiency : {};
  const ratings = standings && typeof standings === 'object' ? standings : {};
  const homeSt = fuzzyTeam(home, ratings);
  const awaySt = fuzzyTeam(away, ratings);
  const hPow = powerFromStandings(homeSt);
  const aPow = powerFromStandings(awaySt);
  const hfa = HFA[sport] != null ? HFA[sport] : 0;
  const fallbackMargin = (hPow - aPow) + hfa;
  const fallbackTotal = cfg.baseTotal + Math.abs(hPow + aPow) * cfg.totalSlope;
  const homeEpa = lookupEpa(home, table);
  const awayEpa = lookupEpa(away, table);

  if (!homeEpa || !awayEpa) {
    return {
      modelMargin: fallbackMargin,
      modelTotal: fallbackTotal,
      uncertainty: fallbackUncertainty(sport, homeSt, awaySt),
      totalUncBump: cfg.totalUncBump,
      methods: { ...cfg.fallback, family: null },
      usedEpa: false,
    };
  }

  const hAdj = sierraAdjust(homeEpa, homeSt, cfg);
  const aAdj = sierraAdjust(awayEpa, awaySt, cfg);
  // (homeOff - awayDef) - (awayOff - homeDef), in points, plus HFA.
  const homeEdge = hAdj.offEpa - aAdj.defEpa;
  const awayEdge = aAdj.offEpa - hAdj.defEpa;
  let modelMargin = (homeEdge - awayEdge) * cfg.plays + hfa;
  let modelTotal = cfg.baseTotal + (homeEdge + awayEdge) * cfg.plays + successTotalAdj(hAdj, aAdj);
  modelMargin = clamp(modelMargin, -cfg.marginCap, cfg.marginCap);
  modelTotal = clamp(modelTotal, cfg.totalMin, cfg.totalMax);
  const family = cfg.family;
  return {
    modelMargin,
    modelTotal,
    uncertainty: cfg.epaUncertainty,
    totalUncBump: cfg.totalUncBump,
    methods: {
      ml: `${family}-ml`,
      spread: `${family}-spread`,
      total: `${family}-total`,
      family,
    },
    usedEpa: true,
  };
}

module.exports = {
  SIERRA_W,
  SPORT_CFG,
  isCleanEpa,
  lookupEpa,
  sierraAdjust,
  footballProjection,
  fallbackUncertainty,
};
