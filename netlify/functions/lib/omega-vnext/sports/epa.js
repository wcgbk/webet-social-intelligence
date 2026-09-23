'use strict';

/**
 * NFL/CFB EPA-style off/def priors.
 * defEpa is defensive strength per play (higher = better, sign-flipped EPA allowed).
 * Both teams must match a clean prior; otherwise the caller keeps standings power.
 * Sierra blend only when standings pf/pa and a game count are clean.
 * v12.3.7: capped success→margin (NFL) and talent/spPlus blend (NCAAF) via ENGINE_SOFT.
 */

const { HFA, ENGINE_SOFT } = require('../config');
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
    talent: row.talent,
    spPlus: row.spPlus,
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
    talent: epa.talent,
    spPlus: epa.spPlus,
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

/**
 * NFL soft success→margin. Isolated contribution, HARD-capped by ENGINE_SOFT.NFL.
 * Soft-fail (unclean success) → 0.
 */
function successMarginAdj(homeEpa, awayEpa, caps) {
  const cfg = caps || (ENGINE_SOFT && ENGINE_SOFT.NFL) || {};
  const per = Number.isFinite(Number(cfg.successMarginPerRate)) ? Number(cfg.successMarginPerRate) : 8;
  const maxM = Number.isFinite(Number(cfg.maxAbsMarginAdj)) ? Math.abs(Number(cfg.maxAbsMarginAdj)) : 1.5;
  const vals = [
    homeEpa && homeEpa.offSuccess, homeEpa && homeEpa.defSuccess,
    awayEpa && awayEpa.offSuccess, awayEpa && awayEpa.defSuccess,
  ].map(Number);
  if (vals.some(v => !Number.isFinite(v) || v <= 0 || v >= 1)) {
    return { marginAdj: 0, used: false, capped: false };
  }
  const [hos, hds, aos, ads] = vals;
  const raw = ((hos - ads) - (aos - hds)) * per;
  const marginAdj = clamp(raw, -maxM, maxM);
  return {
    marginAdj,
    used: Math.abs(marginAdj) > 1e-9,
    capped: Math.abs(raw) > maxM + 1e-12,
    raw,
  };
}

/**
 * Normalize talent/spPlus to roughly −3..+3.
 * 0–100 scale → (v - 50) / 16.7; already small → pass through.
 */
function normalizeTalent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 100 && Math.abs(n) > 5) return clamp((n - 50) / 16.7, -3.5, 3.5);
  return clamp(n, -3.5, 3.5);
}

function talentOf(epaRow) {
  if (!epaRow) return null;
  if (epaRow.talent != null) return normalizeTalent(epaRow.talent);
  if (epaRow.spPlus != null) return normalizeTalent(epaRow.spPlus);
  return null;
}

/**
 * NCAAF talent/spPlus blend. Both teams required. HARD-capped.
 * Soft-fail → 0.
 */
function talentMarginAdj(homeEpa, awayEpa, caps) {
  const cfg = caps || (ENGINE_SOFT && ENGINE_SOFT.NCAAF) || {};
  const w = Number.isFinite(Number(cfg.talentWeight)) ? Number(cfg.talentWeight) : 0.22;
  const pts = Number.isFinite(Number(cfg.talentPtsPerUnit)) ? Number(cfg.talentPtsPerUnit) : 1;
  const maxM = Number.isFinite(Number(cfg.maxAbsMarginAdj)) ? Math.abs(Number(cfg.maxAbsMarginAdj)) : 2;
  const ht = talentOf(homeEpa);
  const at = talentOf(awayEpa);
  if (ht == null || at == null) {
    return { marginAdj: 0, used: false, capped: false };
  }
  const raw = (ht - at) * pts * w;
  const marginAdj = clamp(raw, -maxM, maxM);
  return {
    marginAdj,
    used: Math.abs(marginAdj) > 1e-9,
    capped: Math.abs(raw) > maxM + 1e-12,
    raw,
    homeTalent: ht,
    awayTalent: at,
  };
}

function fallbackUncertainty(sport, homeSt, awaySt) {
  if (sport === 'NCAAF') return 0.22;
  return (homeSt && awaySt) ? 0.16 : 0.26;
}

function tagEngines(methods, enginesOn) {
  if (!enginesOn || !methods) return methods;
  const out = { ...methods };
  for (const k of ['ml', 'spread', 'total']) {
    if (out[k] && !String(out[k]).includes('engines')) {
      out[k] = String(out[k]).replace(/-v1/, '-v1-engines');
      if (!String(out[k]).includes('engines')) out[k] = `${out[k]}-engines`;
    }
  }
  if (out.family && !String(out.family).includes('engines')) {
    out.family = String(out.family).includes('-v1')
      ? String(out.family).replace(/-v1/, '-v1-engines')
      : `${out.family}-engines`;
  }
  return out;
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
      engineSoft: { used: false },
    };
  }

  const hAdj = sierraAdjust(homeEpa, homeSt, cfg);
  const aAdj = sierraAdjust(awayEpa, awaySt, cfg);
  // (homeOff - awayDef) - (awayOff - homeDef), in points, plus HFA.
  const homeEdge = hAdj.offEpa - aAdj.defEpa;
  const awayEdge = aAdj.offEpa - hAdj.defEpa;
  let modelMargin = (homeEdge - awayEdge) * cfg.plays + hfa;
  let modelTotal = cfg.baseTotal + (homeEdge + awayEdge) * cfg.plays + successTotalAdj(hAdj, aAdj);

  const engineMeta = { used: false, success: null, talent: null };
  if (sport === 'NFL') {
    const sm = successMarginAdj(hAdj, aAdj, ENGINE_SOFT && ENGINE_SOFT.NFL);
    modelMargin += sm.marginAdj;
    engineMeta.success = sm;
    if (sm.used) engineMeta.used = true;
  }
  if (sport === 'NCAAF') {
    const tm = talentMarginAdj(hAdj, aAdj, ENGINE_SOFT && ENGINE_SOFT.NCAAF);
    modelMargin += tm.marginAdj;
    engineMeta.talent = tm;
    if (tm.used) engineMeta.used = true;
  }

  modelMargin = clamp(modelMargin, -cfg.marginCap, cfg.marginCap);
  modelTotal = clamp(modelTotal, cfg.totalMin, cfg.totalMax);
  const family = cfg.family;
  let methods = {
    ml: `${family}-ml`,
    spread: `${family}-spread`,
    total: `${family}-total`,
    family,
  };
  methods = tagEngines(methods, engineMeta.used);
  return {
    modelMargin,
    modelTotal,
    uncertainty: cfg.epaUncertainty,
    totalUncBump: cfg.totalUncBump,
    methods,
    usedEpa: true,
    engineSoft: engineMeta,
  };
}

module.exports = {
  SIERRA_W,
  SPORT_CFG,
  isCleanEpa,
  lookupEpa,
  sierraAdjust,
  successTotalAdj,
  successMarginAdj,
  talentMarginAdj,
  normalizeTalent,
  footballProjection,
  fallbackUncertainty,
};
