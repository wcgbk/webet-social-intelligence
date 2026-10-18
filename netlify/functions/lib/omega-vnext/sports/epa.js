'use strict';

/**
 * NFL/CFB EPA-style off/def priors.
 * defEpa is defensive strength per play (higher = better, sign-flipped EPA allowed).
 * Both teams must match a clean prior; otherwise the caller keeps standings power.
 * Sierra blend only when standings pf/pa and a game count are clean.
 * v12.3.8: capped success→margin (NFL) and talent/spPlus blend (NCAAF).
 * NFL/NCAAF maxAbsMarginAdj is a stack cap (those signals + QB continuity).
 */

const { HFA, ENGINE_SOFT } = require('../config');
const { clamp } = require('../odds_math');
const { fuzzyTeam, powerFromStandings, gamesPlayed } = require('./_common');

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
 * Seed `_meta.units` / `_meta.scale`. Centered is the default (cfb-talent-seed).
 * A 0–100 score is used only when the meta says so — never guessed from magnitude.
 */
function talentScaleMode(meta) {
  const units = String((meta && meta.units) || '');
  const scale = String((meta && meta.scale) || '');
  const blob = `${units} ${scale}`.toLowerCase();
  if (/centered|relative_talent/.test(blob)) return 'centered';
  if (/0\s*[-–]\s*100|percent|percentile|\bpct\b/.test(blob)) return 'pct_0_100';
  return 'centered';
}

/**
 * Normalize talent/spPlus onto roughly −3.5..+3.5.
 * Centered proxy: clamp; |value| > 15 soft-fails (that is a different scale).
 * pct_0_100: (v − 50) / 16.7. Do not infer 0–100 from "n > 5" — that flips a
 * strong centered team (6) into a weak one.
 */
function normalizeTalent(raw, scale) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const mode = scale === 'pct_0_100' ? 'pct_0_100' : 'centered';
  if (mode === 'pct_0_100') {
    if (n < 0 || n > 100) return null;
    return clamp((n - 50) / 16.7, -3.5, 3.5);
  }
  if (Math.abs(n) > 15) return null;
  return clamp(n, -3.5, 3.5);
}

function talentOf(epaRow) {
  if (!epaRow || typeof epaRow !== 'object') return null;
  const scale = epaRow.talentScale;
  if (epaRow.talent != null && epaRow.talent !== '') return normalizeTalent(epaRow.talent, scale);
  if (epaRow.spPlus != null && epaRow.spPlus !== '') return normalizeTalent(epaRow.spPlus, scale);
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

/**
 * Scale a sum of new-engine margin pieces down to ±maxAbs.
 * modelMargin already includes the raw sum. Rest / QB-out / HFA are not in
 * contributions and stay put. Returns the margin with the scaled sum swapped in.
 */
function applyStackedMarginCap(modelMargin, contributions, maxAbs) {
  let margin = Number(modelMargin);
  if (!Number.isFinite(margin)) margin = 0;
  const items = (Array.isArray(contributions) ? contributions : []).map((c) => ({
    key: c && c.key ? String(c.key) : 'adj',
    adj: Number.isFinite(Number(c && c.adj)) ? Number(c.adj) : 0,
  }));
  const rawSum = items.reduce((s, c) => s + c.adj, 0);
  const cap = Number.isFinite(Number(maxAbs)) ? Math.abs(Number(maxAbs)) : 0;
  let scale = 1;
  let capped = false;
  if (Math.abs(rawSum) > cap + 1e-12) {
    scale = Math.abs(rawSum) > 1e-12 ? cap / Math.abs(rawSum) : 0;
    capped = true;
  }
  const byKey = {};
  let sum = 0;
  for (const c of items) {
    const adj = c.adj * scale;
    byKey[c.key] = adj;
    sum += adj;
  }
  return {
    modelMargin: margin - rawSum + sum,
    byKey,
    rawSum,
    sum,
    capped,
    scale,
  };
}

function pieceAdj(row, field) {
  if (!row || !Number.isFinite(Number(row[field]))) return 0;
  return Number(row[field]);
}

/**
 * Apply the sport's stacked engine cap. Contributions already sit inside modelMargin.
 * NFL: success + QB continuity. NCAAF: talent + QB continuity.
 */
function applyEngineStack({ sport, modelMargin, engineSoft, gameDay } = {}) {
  const caps = (ENGINE_SOFT && ENGINE_SOFT[sport]) || {};
  const soft = engineSoft || { used: false };
  const gd = gameDay ? { ...gameDay } : null;
  const parts = [];
  if (sport === 'NFL') {
    parts.push({ key: 'success', adj: pieceAdj(soft.success, 'appliedMarginAdj') });
    parts.push({ key: 'continuity', adj: pieceAdj(gd && gd.qbContinuity, 'marginAdj') });
  } else if (sport === 'NCAAF') {
    parts.push({ key: 'talent', adj: pieceAdj(soft.talent, 'appliedMarginAdj') });
    parts.push({ key: 'continuity', adj: pieceAdj(gd && gd.qbContinuity, 'marginAdj') });
  }
  const stacked = applyStackedMarginCap(modelMargin, parts, caps.maxAbsMarginAdj);
  const nextSoft = { ...soft, stacked };
  if (nextSoft.success && stacked.byKey.success != null) {
    nextSoft.success = {
      ...nextSoft.success,
      rawMarginAdj: nextSoft.success.marginAdj,
      marginAdj: stacked.byKey.success,
    };
  }
  if (nextSoft.talent && stacked.byKey.talent != null) {
    nextSoft.talent = {
      ...nextSoft.talent,
      rawMarginAdj: nextSoft.talent.marginAdj,
      marginAdj: stacked.byKey.talent,
    };
  }
  if (gd && gd.qbContinuity && stacked.byKey.continuity != null) {
    gd.qbContinuity = {
      ...gd.qbContinuity,
      rawMarginAdj: gd.qbContinuity.marginAdj,
      marginAdj: stacked.byKey.continuity,
      stackCapped: stacked.capped,
    };
  }
  return {
    modelMargin: stacked.modelMargin,
    engineSoft: nextSoft,
    gameDay: gd,
    enginesOn: Math.abs(stacked.rawSum) > 1e-9 || !!soft.used,
    stacked,
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
  const hPow = powerFromStandings(homeSt, sport);
  const aPow = powerFromStandings(awaySt, sport);
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
  const baseMargin = (homeEdge - awayEdge) * cfg.plays + hfa;
  let modelTotal = cfg.baseTotal + (homeEdge + awayEdge) * cfg.plays + successTotalAdj(hAdj, aAdj);

  const engineMeta = { used: false, success: null, talent: null };
  let engineAdd = 0;
  if (sport === 'NFL') {
    const sm = successMarginAdj(hAdj, aAdj, ENGINE_SOFT && ENGINE_SOFT.NFL);
    engineAdd += sm.marginAdj;
    engineMeta.success = sm;
    if (sm.used) engineMeta.used = true;
  }
  if (sport === 'NCAAF') {
    const tm = talentMarginAdj(hAdj, aAdj, ENGINE_SOFT && ENGINE_SOFT.NCAAF);
    engineAdd += tm.marginAdj;
    engineMeta.talent = tm;
    if (tm.used) engineMeta.used = true;
  }

  // Sport margin cap can eat the engine add when the base is already on the rail.
  // appliedMarginAdj is the piece that actually remains inside modelMargin.
  const cappedBase = clamp(baseMargin, -cfg.marginCap, cfg.marginCap);
  let modelMargin = clamp(baseMargin + engineAdd, -cfg.marginCap, cfg.marginCap);
  const appliedEngine = modelMargin - cappedBase;
  const appliedScale = Math.abs(engineAdd) > 1e-12 ? appliedEngine / engineAdd : 1;
  const safeScale = appliedScale < 0 ? 0 : appliedScale;
  if (engineMeta.success) {
    engineMeta.success = {
      ...engineMeta.success,
      appliedMarginAdj: engineMeta.success.marginAdj * safeScale,
    };
  }
  if (engineMeta.talent) {
    engineMeta.talent = {
      ...engineMeta.talent,
      appliedMarginAdj: engineMeta.talent.marginAdj * safeScale,
    };
  }
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
  talentScaleMode,
  normalizeTalent,
  applyStackedMarginCap,
  applyEngineStack,
  footballProjection,
  fallbackUncertainty,
};
