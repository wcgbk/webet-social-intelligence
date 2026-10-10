'use strict';

/**
 * NFL/CFB EPA-style off/def priors.
 * defEpa is defensive strength per play (higher = better, sign-flipped EPA allowed).
 * Both teams must match a clean prior; otherwise the caller keeps standings power.
 * Sierra blend only when standings pf/pa and a game count are clean.
 * In-season weight on current points/game ramps with each team's games played.
 * Seeds are zero-sum centered once at load (centerSeed). The JSON file stays raw.
 * v12.3.8: capped success→margin (NFL) and talent/spPlus blend (NCAAF).
 * NFL/NCAAF maxAbsMarginAdj is a stack cap (those signals + QB continuity).
 */

const { HFA, ENGINE_SOFT, SPORT_TOTAL_STD, centerDefaultEnabled } = require('../config');
const { clamp } = require('../odds_math');
const { powerFromStandings, gamesPlayed, explicitPointsPerGame } = require('./_common');
const { resolveTeamId, modelRow, logUnknownTeam, isFbsTeamId, teamRecord, rowByIdentity } = require('./team_identity');

/**
 * Sierra weight on current points/game. Prior seed weight is 1 − w.
 * w is 0 below 2 games (sierraAdjust keeps the seed).
 * w is 0.20 at 2 games, then rises linearly to 0.50 at midseason
 * games played, and stays at 0.50 after that.
 * Midseason is SPORT_CFG[sport].sierraMidseasonGp: NFL 9, NCAAF 6.
 * Each team uses its own gamesPlayed() count.
 * A cfg with no midseason gp, or midseason <= 2, keeps 0.20 for every gp >= 2.
 */
const SIERRA_W_GP2 = 0.2;
const SIERRA_W_CAP = 0.5;
const LEAGUE_SUCCESS = 0.43;
/** Sanity band for a per-game rate after season sums are divided. Not a divide trigger. */
const FOOTBALL_PPG_MIN = 6;
const FOOTBALL_PPG_MAX = 55;

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
    // Week 9. Linear Sierra ramp reaches 0.50 here, then stays capped.
    sierraMidseasonGp: 9,
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
    // Game 6 of a 12-game schedule. Linear Sierra ramp reaches 0.50 here.
    sierraMidseasonGp: 6,
  },
};

/**
 * Opponent-adjusted NCAAF ratings from completed games.
 *
 * Strength and pace are different quantities, so they do not share a
 * prior. Margin noise is about 14 points and between-team FBS strength
 * (off + def) is about 10: K_strength = 14^2 / 10^2 = 1.96, taken as 2.
 * Pace (off − def) is much tighter. Its prior variance is the seed
 * table's own pace dispersion, and one game's total is noisier than
 * that dispersion (SPORT_TOTAL_STD.NCAAF). K_pace = totalStd^2 / paceVar,
 * rounded, computed from the seed at solve time rather than stored as a
 * second magic number. Same shape as the NHL GF/GA prior. Neither K is
 * fit on a slate.
 *
 * The prior mean is the centered EPA seed in points (offEpa * plays,
 * defEpa * plays) when that school has a seed, otherwise 0 (average FBS).
 * Current-season weight is g / (g + K) on strength and on pace separately,
 * then off = (S + P) / 2 and def = (S − P) / 2. Results replace the seed;
 * they do not get blended again on the way out.
 *
 * Totals use a symmetric model, so the center is the mean points of
 * FBS-vs-FBS games decided by at most NCAAF_OA_BLOWOUT_MARGIN (28, four
 * scores). The raw mean sits higher because blowouts add garbage-time
 * points. Pace (off − def) still moves each game off that center.
 * A non-FBS side is one shared opponent, not a missing team. Its off and
 * def are fit from FBS-vs-non-FBS games, and those games also update the
 * FBS side. Dropping them left a 4-game team that scheduled a cupcake on
 * only 3 observations and shrunk it toward the prior.
 * Below NCAAF_OA_MIN_GAMES the pack is withheld and the EPA / standings
 * path is unchanged.
 */
const NCAAF_OA_PRIOR_GAMES = 2;

/**
 * Games of pace shrinkage implied by the seed table. Null when the table
 * has too few clean rows to estimate a prior variance — the solver then
 * uses the strength prior, which is the old shared-K behavior.
 * Pace variance is the population variance of (off − def) in points.
 */
function ncaafPacePriorGames(efficiency) {
  const plays = (SPORT_CFG.NCAAF && SPORT_CFG.NCAAF.plays) || 68;
  const noise = Number(SPORT_TOTAL_STD && SPORT_TOTAL_STD.NCAAF);
  const paces = [];
  for (const row of teamRows(efficiency)) {
    if (!isCleanEpa(row)) continue;
    paces.push((Number(row.offEpa) - Number(row.defEpa)) * plays);
  }
  if (paces.length < 8 || !Number.isFinite(noise) || noise <= 0) return null;
  const mean = paces.reduce((s, x) => s + x, 0) / paces.length;
  const variance = paces.reduce((s, x) => s + (x - mean) ** 2, 0) / paces.length;
  if (!(variance > 0)) return null;
  const k = Math.round((noise * noise) / variance);
  return Number.isFinite(k) && k >= 1 ? k : null;
}
const NCAAF_OA_BLOWOUT_MARGIN = 28;
const NCAAF_OA_MIN_GAMES = 40;
const NCAAF_OA_ITERS = 16;
/**
 * FBS-vs-FCS margins are regularly past the old 31-point EPA cap: the
 * non-FBS prior is about -36, so a good FBS side at home is a 40 to 55
 * point favorite and the market posts that number. Clipping those to 31
 * sits the model under the line and pulls the slate mean. 70 still stops
 * a broken rating from printing an impossible spread.
 */
const NCAAF_OA_MARGIN_CAP = 70;

/**
 * In-season weight on current points/game for one team's games played.
 * cfgOrSport is SPORT_CFG[sport] or 'NFL' / 'NCAAF'.
 */
function sierraWeight(gp, cfgOrSport) {
  const g = Number(gp);
  if (!Number.isFinite(g) || g < 2) return 0;
  const cfg = typeof cfgOrSport === 'string' ? SPORT_CFG[cfgOrSport] : cfgOrSport;
  const mid = cfg && Number(cfg.sierraMidseasonGp);
  if (!Number.isFinite(mid) || mid <= 2) return SIERRA_W_GP2;
  if (g >= mid) return SIERRA_W_CAP;
  return SIERRA_W_GP2 + (SIERRA_W_CAP - SIERRA_W_GP2) * ((g - 2) / (mid - 2));
}

/**
 * Season year of a card date (YYYY-MM-DD). It is the calendar year.
 * A 2027 card date is season year 2027, including January and February.
 * Null when the date does not parse. The label does not change projections.
 */
function cardSeasonYear(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year;
}

/**
 * Seed season label vs the card date. seedSeasonStale is true only when
 * appliesToSeason and the card season year are both finite and they differ.
 */
function seedSeasonStatus(meta, dateISO) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const season = Number(src.season);
  const applies = Number(src.appliesToSeason);
  const year = cardSeasonYear(dateISO);
  const haveApplies = Number.isFinite(applies);
  const haveYear = year != null;
  return {
    season: Number.isFinite(season) ? season : null,
    appliesToSeason: haveApplies ? applies : null,
    cardSeasonYear: year,
    seedSeasonStale: haveApplies && haveYear && applies !== year,
  };
}

function isCleanEpa(row) {
  if (!row || typeof row !== 'object') return false;
  const off = Number(row.offEpa);
  const def = Number(row.defEpa);
  if (!Number.isFinite(off) || !Number.isFinite(def)) return false;
  // Per-play scale. Point-level numbers would explode the margin — reject.
  if (Math.abs(off) > 0.8 || Math.abs(def) > 0.8) return false;
  return true;
}

function teamRows(table) {
  const rows = [];
  if (!table || typeof table !== 'object') return rows;
  for (const [key, row] of Object.entries(table)) {
    if (!key || key.startsWith('_')) continue;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    rows.push(row);
  }
  return rows;
}

/** Mean over rows that have both fields. d = mean(off) − mean(def). */
function pairMean(rows, offKey, defKey) {
  let n = 0;
  let sumOff = 0;
  let sumDef = 0;
  for (const row of rows) {
    const off = Number(row[offKey]);
    const def = Number(row[defKey]);
    if (!Number.isFinite(off) || !Number.isFinite(def)) continue;
    n += 1;
    sumOff += off;
    sumDef += def;
  }
  if (!n) return null;
  const meanOff = sumOff / n;
  const meanDef = sumDef / n;
  const d = meanOff - meanDef;
  return { n, meanOff, meanDef, d, half: d / 2 };
}

/**
 * successTotalAdj environment is (offEnv − defEnv) × 12.
 * offEnv − defEnv = ((homeOff + awayOff) − (homeDef + awayDef)) / 2.
 * LEAGUE_SUCCESS cancels, so an average pair is (mean offSuccess − mean defSuccess) × 12.
 * defSuccess is higher-is-better (more stops), the same orientation as defEpa,
 * so the symmetric shift zeros that term. It would not zero a same-sign sum.
 * Skip the shift when any rate would leave (0, 1): successTotalAdj and
 * successMarginAdj then return 0 for that pair, and margins would move.
 */
function successShiftFor(rows) {
  const stats = pairMean(rows, 'offSuccess', 'defSuccess');
  if (!stats) {
    return { applied: false, d: 0, half: 0, n: 0, reason: 'no paired success rates' };
  }
  for (const row of rows) {
    const off = Number(row.offSuccess);
    const def = Number(row.defSuccess);
    if (!Number.isFinite(off) || !Number.isFinite(def)) continue;
    const off2 = off - stats.half;
    const def2 = def + stats.half;
    if (!(off2 > 0 && off2 < 1 && def2 > 0 && def2 < 1)) {
      return {
        applied: false,
        d: stats.d,
        half: stats.half,
        n: stats.n,
        meanOff: stats.meanOff,
        meanDef: stats.meanDef,
        reason: 'shift would leave (0, 1); success environment left uncentered',
      };
    }
  }
  return {
    applied: true,
    d: stats.d,
    half: stats.half,
    n: stats.n,
    meanOff: stats.meanOff,
    meanDef: stats.meanDef,
    reason: 'defSuccess is higher-is-better; symmetric shift zeros (mean offSuccess - mean defSuccess) * 12',
  };
}

/**
 * Shift that centerSeed would apply. Does not copy or mutate the table.
 * epa.d is mean(offEpa) − mean(defEpa) on the input (0 after a center).
 */
function seedCenterStats(table) {
  const rows = teamRows(table);
  const epa = pairMean(rows, 'offEpa', 'defEpa') || {
    n: 0, meanOff: null, meanDef: null, d: 0, half: 0,
  };
  return { epa, success: successShiftFor(rows) };
}

/**
 * Symmetric zero-sum re-center. d = mean(off) − mean(def);
 * off' = off − d/2; def' = def + d/2. Mean(off') === mean(def').
 * A both-seeded total uses (homeOff − awayDef) + (awayOff − homeDef), which is
 * 0 for an average pair once the means match. Every (off − def) drops by d,
 * so margins, the differences of those edges, stay put.
 * The same shift is applied to offSuccess/defSuccess when successShiftFor
 * says it zeros the success environment term without leaving (0, 1).
 * Idempotent. Does not mutate the input. Raw JSON stays the source of truth.
 * Call once at load. Do not call from footballProjection.
 */
function centerSeed(table) {
  const src = table && typeof table === 'object' ? table : {};
  const stats = seedCenterStats(src);
  const out = {};
  for (const [key, row] of Object.entries(src)) {
    if (!key || key.startsWith('_') || !row || typeof row !== 'object' || Array.isArray(row)) {
      out[key] = row;
      continue;
    }
    const next = { ...row };
    const off = Number(row.offEpa);
    const def = Number(row.defEpa);
    if (Number.isFinite(off) && Number.isFinite(def)) {
      next.offEpa = off - stats.epa.half;
      next.defEpa = def + stats.epa.half;
    }
    if (stats.success.applied) {
      const offS = Number(row.offSuccess);
      const defS = Number(row.defSuccess);
      if (Number.isFinite(offS) && Number.isFinite(defS)) {
        next.offSuccess = offS - stats.success.half;
        next.defSuccess = defS + stats.success.half;
      }
    }
    out[key] = next;
  }
  return out;
}

function lookupEpa(teamName, table, sport) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  const row = modelRow(sport, table || {}, teamName);
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
 * ESPN pointsFor/pointsAgainst are season sums. gp >= 2 always divides both.
 * gp < 2 returns the seed. Divided rates must land in [6, 55] or the seed is kept.
 * An explicit avgPointsFor-style pair is the rate and is not divided.
 * gamesPlayed() prefers an explicit count, then wins+losses when losses
 * was sent, else a W-L record. Wins alone are not a count.
 * Current-season weight is sierraWeight(that gp): 0.20 at gp 2, linear to
 * 0.50 at the sport midseason gp, capped at 0.50. Prior seed weight is 1 − w.
 * Home and away each use their own gp.
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
  const g = gamesPlayed(standingsRow);
  if (g < 2) return base;
  const explicit = explicitPointsPerGame(standingsRow);
  let pfPg;
  let paPg;
  if (explicit) {
    pfPg = explicit.pfPg;
    paPg = explicit.paPg;
  } else {
    const pf = Number(standingsRow.pf);
    const pa = Number(standingsRow.pa);
    if (!Number.isFinite(pf) || !Number.isFinite(pa)) return base;
    pfPg = pf / g;
    paPg = pa / g;
  }
  if (![pfPg, paPg].every(n => Number.isFinite(n) && n >= FOOTBALL_PPG_MIN && n <= FOOTBALL_PPG_MAX)) return base;
  const offFromSt = (pfPg - cfg.leaguePpg) / cfg.plays;
  const defFromSt = (cfg.leaguePpg - paPg) / cfg.plays;
  const w = sierraWeight(g, cfg);
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
 *
 * Football rest (short week, mini-bye, bye, MNF→Sun) is recorded on
 * gameDay by applyGameDayAdjustments and added here, after the stack.
 * It is not a `parts` entry, so ENGINE_SOFT.maxAbsMarginAdj cannot scale
 * it. Its own cap is REST_ADJ (±1.0). The total is not an input here
 * and is not moved.
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
  // Rest stays out of `parts` on purpose. See the comment above.
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
  // Rest is outside the stack. 0 when the schedule path is off, so the
  // played-yesterday proxy (already inside modelMargin) is unchanged.
  const restAdj = (gd && gd.restPending === true && Number.isFinite(Number(gd.restAdj)))
    ? Number(gd.restAdj)
    : 0;
  return {
    modelMargin: stacked.modelMargin + restAdj,
    engineSoft: nextSoft,
    gameDay: gd,
    enginesOn: Math.abs(stacked.rawSum) > 1e-9 || !!soft.used,
    stacked,
    restAdj,
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

/** Midnight America/New_York on dateISO, as epoch ms. Games at or after this are the card, not the fit. */
function etMidnightMs(dateISO) {
  const [y, m, d] = String(dateISO || '').split('-').map(Number);
  if (![y, m, d].every(Number.isInteger)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let t = Date.UTC(y, m - 1, d, 4, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const py = Number(parts.year);
    const pm = Number(parts.month);
    const pd = Number(parts.day);
    const ph = Number(parts.hour);
    const pmin = Number(parts.minute);
    if (py === y && pm === m && pd === d && ph === 0 && pmin === 0) return t;
    const cur = Date.UTC(py, pm - 1, pd, ph, pmin);
    const want = Date.UTC(y, m - 1, d, 0, 0);
    t += (want - cur);
  }
  return null;
}

function boardIsFinal(ev, comp) {
  const compState = comp && comp.status && comp.status.type && comp.status.type.state;
  const evState = ev && ev.status && ev.status.type && ev.status.type.state;
  return compState === 'post' || evState === 'post';
}

/**
 * Completed games from ESPN weekly scoreboards. One row per game.
 * FBS flags are the id table, not the board group.
 */
function ncaafCompletedGames(boards) {
  const games = [];
  const seen = new Set();
  const list = Array.isArray(boards) ? boards : [];
  for (const board of list) {
    for (const ev of (board && board.events) || []) {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      if (!boardIsFinal(ev, comp)) continue;
      const comps = comp.competitors || [];
      const home = comps.find((c) => c && c.homeAway === 'home') || comps[0];
      const away = comps.find((c) => c && c.homeAway === 'away') || comps[1];
      if (!home || !away || !home.team || !away.team) continue;
      const hs = Number(home.score);
      const as = Number(away.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      const commence = ev.date || comp.date || null;
      if (!commence || !Number.isFinite(Date.parse(commence))) continue;
      const hid = String(home.team.id);
      const aid = String(away.team.id);
      const key = `${hid}|${aid}|${commence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      games.push({
        hid,
        aid,
        hs,
        as,
        margin: hs - as,
        total: hs + as,
        neutral: comp.neutralSite === true,
        commence,
        hFbs: isFbsTeamId(hid),
        aFbs: isFbsTeamId(aid),
      });
    }
  }
  return games;
}

function seedPointsForId(efficiency, id, plays) {
  const rec = teamRecord('NCAAF', id);
  if (!rec || !rec.displayName) return null;
  const row = rowByIdentity('NCAAF', efficiency, rec.displayName);
  if (!isCleanEpa(row)) return null;
  return { o: Number(row.offEpa) * plays, d: Number(row.defEpa) * plays };
}

/**
 * Fit FBS off/def. boards are ESPN week payloads. Returns null when the
 * sample is too small or the date does not parse — caller keeps EPA /
 * standings. opts.minGames overrides the production floor for tests.
 */
function solveNcaafOpponentRatings(boards, opts = {}) {
  const asOf = etMidnightMs(opts.asOf);
  if (asOf == null) return null;
  const hfaBase = Number.isFinite(Number(opts.hfa)) ? Number(opts.hfa) : (HFA.NCAAF || 0);
  const shrinkK = Number.isFinite(Number(opts.priorGames)) ? Number(opts.priorGames) : NCAAF_OA_PRIOR_GAMES;
  const iters = Number.isFinite(Number(opts.iters)) ? Number(opts.iters) : NCAAF_OA_ITERS;
  const blowout = Number.isFinite(Number(opts.blowoutMargin)) ? Number(opts.blowoutMargin) : NCAAF_OA_BLOWOUT_MARGIN;
  const minGames = Number.isFinite(Number(opts.minGames)) ? Number(opts.minGames) : NCAAF_OA_MIN_GAMES;
  const plays = (SPORT_CFG.NCAAF && SPORT_CFG.NCAAF.plays) || 68;
  const efficiency = opts.efficiency && typeof opts.efficiency === 'object' ? opts.efficiency : {};
  const paceEstimated = ncaafPacePriorGames(efficiency);
  const paceK = Number.isFinite(Number(opts.pacePriorGames))
    ? Number(opts.pacePriorGames)
    : (paceEstimated != null ? paceEstimated : shrinkK);
  const games = ncaafCompletedGames(boards).filter((g) => Date.parse(g.commence) < asOf);
  const fbsGames = games.filter((g) => g.hFbs && g.aFbs);
  if (fbsGames.length < minGames) return null;
  const close = fbsGames.filter((g) => Math.abs(g.margin) <= blowout);
  const baseRows = close.length ? close : fbsGames;
  const leagueTotal = baseRows.reduce((s, g) => s + g.total, 0) / baseRows.length;
  const league = leagueTotal / 2;
  const ids = new Set();
  for (const g of fbsGames) { ids.add(g.hid); ids.add(g.aid); }
  // Cupcake games still belong to the FBS side. The non-FBS opponent is
  // the shared pool below, not a reason to drop the observation.
  for (const g of games) {
    if (g.hFbs && !g.aFbs) ids.add(g.hid);
    else if (!g.hFbs && g.aFbs) ids.add(g.aid);
  }
  const prior = new Map();
  for (const id of ids) {
    const pts = seedPointsForId(efficiency, id, plays);
    if (pts) prior.set(id, pts);
  }
  const off = new Map();
  const def = new Map();
  for (const id of ids) { off.set(id, 0); def.set(id, 0); }
  let fcsOff = 0;
  let fcsDef = 0;
  for (let it = 0; it < iters; it += 1) {
    const offSum = new Map();
    const defSum = new Map();
    const n = new Map();
    for (const id of ids) { offSum.set(id, 0); defSum.set(id, 0); n.set(id, 0); }
    for (const g of fbsGames) {
      const hfaPts = g.neutral ? 0 : hfaBase;
      // home score = league + homeOff - awayDef + hfa/2
      // away score = league + awayOff - homeDef - hfa/2
      const hOffObs = g.hs - league - hfaPts / 2 + def.get(g.aid);
      const aOffObs = g.as - league + hfaPts / 2 + def.get(g.hid);
      const aDefObs = league + off.get(g.hid) - (g.hs - hfaPts / 2);
      const hDefObs = league + off.get(g.aid) - (g.as + hfaPts / 2);
      offSum.set(g.hid, offSum.get(g.hid) + hOffObs);
      offSum.set(g.aid, offSum.get(g.aid) + aOffObs);
      defSum.set(g.hid, defSum.get(g.hid) + hDefObs);
      defSum.set(g.aid, defSum.get(g.aid) + aDefObs);
      n.set(g.hid, n.get(g.hid) + 1);
      n.set(g.aid, n.get(g.aid) + 1);
    }
    let fcsOffSum = 0;
    let fcsDefSum = 0;
    let fcsN = 0;
    for (const g of games) {
      if (g.hFbs === g.aFbs) continue;
      const hfaPts = g.neutral ? 0 : hfaBase;
      if (g.hFbs && !g.aFbs) {
        offSum.set(g.hid, offSum.get(g.hid) + (g.hs - league - hfaPts / 2 + fcsDef));
        defSum.set(g.hid, defSum.get(g.hid) + (league + fcsOff - (g.as + hfaPts / 2)));
        n.set(g.hid, n.get(g.hid) + 1);
        fcsOffSum += g.as - league + hfaPts / 2 + def.get(g.hid);
        fcsDefSum += league + off.get(g.hid) - (g.hs - hfaPts / 2);
        fcsN += 1;
      } else if (!g.hFbs && g.aFbs) {
        offSum.set(g.aid, offSum.get(g.aid) + (g.as - league + hfaPts / 2 + fcsDef));
        defSum.set(g.aid, defSum.get(g.aid) + (league + fcsOff - (g.hs - hfaPts / 2)));
        n.set(g.aid, n.get(g.aid) + 1);
        fcsOffSum += g.hs - league - hfaPts / 2 + def.get(g.aid);
        fcsDefSum += league + off.get(g.aid) - (g.as + hfaPts / 2);
        fcsN += 1;
      }
    }
    let so = 0;
    let sd = 0;
    let count = 0;
    for (const id of ids) {
      const g = n.get(id) || 0;
      const pr = prior.get(id);
      const po = pr ? pr.o : 0;
      const pd = pr ? pr.d : 0;
      // Strength and pace shrink on their own priors. Equal K reproduces
      // the old per-component shrink: off and def then move together.
      const ws = shrinkK > 0 ? g / (g + shrinkK) : 1;
      const wp = paceK > 0 ? g / (g + paceK) : 1;
      const sHat = g ? (offSum.get(id) + defSum.get(id)) / g : (po + pd);
      const pHat = g ? (offSum.get(id) - defSum.get(id)) / g : (po - pd);
      const S = g ? ws * sHat + (1 - ws) * (po + pd) : (po + pd);
      const P = g ? wp * pHat + (1 - wp) * (po - pd) : (po - pd);
      const o = (S + P) / 2;
      const d = (S - P) / 2;
      off.set(id, o);
      def.set(id, d);
      so += o;
      sd += d;
      count += 1;
    }
    const mo = count ? so / count : 0;
    const md = count ? sd / count : 0;
    for (const id of ids) {
      off.set(id, off.get(id) - mo);
      def.set(id, def.get(id) - md);
    }
    if (fcsN > 0) {
      fcsOff = fcsOffSum / fcsN;
      fcsDef = fcsDefSum / fcsN;
    }
  }
  // Publish the non-FBS pool from the final FBS ratings, not the lagged iterate.
  {
    let fcsOffSum = 0;
    let fcsDefSum = 0;
    let fcsN = 0;
    for (const g of games) {
      if (g.hFbs === g.aFbs) continue;
      const hfaPts = g.neutral ? 0 : hfaBase;
      if (g.hFbs && !g.aFbs && off.has(g.hid)) {
        fcsOffSum += g.as - league + hfaPts / 2 + def.get(g.hid);
        fcsDefSum += league + off.get(g.hid) - (g.hs - hfaPts / 2);
        fcsN += 1;
      } else if (!g.hFbs && g.aFbs && off.has(g.aid)) {
        fcsOffSum += g.hs - league - hfaPts / 2 + def.get(g.aid);
        fcsDefSum += league + off.get(g.aid) - (g.as + hfaPts / 2);
        fcsN += 1;
      }
    }
    if (fcsN > 0) {
      fcsOff = fcsOffSum / fcsN;
      fcsDef = fcsDefSum / fcsN;
    }
  }
  const fcsStrength = fcsOff + fcsDef;
  const byId = {};
  for (const id of ids) {
    byId[id] = { off: off.get(id), def: def.get(id) };
  }
  const seedById = {};
  for (const [id, pts] of prior) seedById[id] = { off: pts.o, def: pts.d };
  return {
    byId,
    seedById,
    leagueTotal,
    fcsOff,
    fcsDef,
    fcsStrength,
    games: fbsGames.length,
    closeGames: close.length,
    priorGames: shrinkK,
    pacePriorGames: paceK,
    blowoutMargin: blowout,
    hfa: hfaBase,
  };
}

function ncaafOaSide(pack, id) {
  if (!id) return null;
  const fit = pack.byId && pack.byId[String(id)];
  if (fit && Number.isFinite(Number(fit.off)) && Number.isFinite(Number(fit.def))) {
    return { off: Number(fit.off), def: Number(fit.def) };
  }
  if (!isFbsTeamId(id)) {
    return {
      off: Number.isFinite(Number(pack.fcsOff)) ? Number(pack.fcsOff) : 0,
      def: Number.isFinite(Number(pack.fcsDef)) ? Number(pack.fcsDef) : 0,
    };
  }
  const seed = pack.seedById && pack.seedById[String(id)];
  if (seed && Number.isFinite(Number(seed.off)) && Number.isFinite(Number(seed.def))) {
    return { off: Number(seed.off), def: Number(seed.def) };
  }
  return { off: 0, def: 0 };
}

/**
 * Home margin and total from the opponent-adjusted pack on efficiency._oa.
 * Null when the pack is absent — footballProjection keeps its other path.
 */
function projectNcaafOpponentAdjusted({ homeId, awayId, efficiency, hfaPts, cfg }) {
  const pack = efficiency && efficiency._oa;
  if (!pack || !pack.byId || !Number.isFinite(Number(pack.leagueTotal))) return null;
  if (!Number.isFinite(Number(pack.games)) || Number(pack.games) < 1) return null;
  if (!homeId || !awayId) return null;
  const H = ncaafOaSide(pack, homeId);
  const A = ncaafOaSide(pack, awayId);
  if (!H || !A) return null;
  const margin = (H.off + H.def) - (A.off + A.def) + hfaPts;
  const total = Number(pack.leagueTotal) + (H.off - H.def) + (A.off - A.def);
  const modelMargin = clamp(margin, -NCAAF_OA_MARGIN_CAP, NCAAF_OA_MARGIN_CAP);
  const modelTotal = clamp(total, cfg.totalMin, cfg.totalMax);
  return {
    modelMargin,
    modelTotal,
    uncertainty: cfg.epaUncertainty,
    totalUncBump: cfg.totalUncBump,
    methods: {
      ml: 'cfb-oa-v1-ml',
      spread: 'cfb-oa-v1-spread',
      total: 'cfb-oa-v1-total',
      family: 'cfb-oa-v1',
    },
    usedEpa: false,
    engineSoft: { used: false },
    unknownTeam: false,
    unknownNames: [],
  };
}

/**
 * Home margin and total. engine family is null on the standings path.
 */
function footballProjection({ sport, home, away, standings, efficiency, hfa } = {}) {
  const cfg = SPORT_CFG[sport] || SPORT_CFG.NFL;
  const table = efficiency && typeof efficiency === 'object' ? efficiency : {};
  const ratings = standings && typeof standings === 'object' ? standings : {};
  // Numeric hfa (including 0) overrides the sport constant. Neutral-site
  // callers pass 0. Omitted hfa keeps HFA[sport].
  const hfaPts = (hfa != null && Number.isFinite(Number(hfa)))
    ? Number(hfa)
    : (HFA[sport] != null ? HFA[sport] : 0);
  const homeId = resolveTeamId(sport, home);
  const awayId = resolveTeamId(sport, away);
  const unknownNames = [];
  if (!homeId) unknownNames.push(home);
  if (!awayId) unknownNames.push(away);
  if (unknownNames.length) {
    for (const name of unknownNames) logUnknownTeam(sport, name);
  }
  const unknownTeam = unknownNames.length > 0;
  // A missing side is the centered prior (0), not a made-up rating.
  // Margin is HFA only when both sides are unknown. OMEGA_CENTER_DEFAULT=0
  // restores the old rule: any unresolved name zeros the game to HFA.
  const bothUnknown = unknownNames.length >= 2;
  if (unknownTeam && (!centerDefaultEnabled() || bothUnknown)) {
    const fallbackTotal = cfg.baseTotal;
    return {
      modelMargin: hfaPts,
      modelTotal: fallbackTotal,
      uncertainty: fallbackUncertainty(sport, null, null),
      totalUncBump: cfg.totalUncBump,
      methods: { ...cfg.fallback, family: null },
      usedEpa: false,
      engineSoft: { used: false },
      unknownTeam: true,
      unknownNames,
    };
  }
  if (sport === 'NCAAF' && homeId && awayId) {
    const oa = projectNcaafOpponentAdjusted({ homeId, awayId, efficiency: table, hfaPts, cfg });
    if (oa) return oa;
  }
  const homeSt = homeId ? modelRow(sport, ratings, home) : null;
  const awaySt = awayId ? modelRow(sport, ratings, away) : null;
  const hPow = powerFromStandings(homeSt, sport);
  const aPow = powerFromStandings(awaySt, sport);
  const fallbackMargin = (hPow - aPow) + hfaPts;
  const fallbackTotal = cfg.baseTotal + Math.abs(hPow + aPow) * cfg.totalSlope;
  const homeEpa = homeId ? lookupEpa(home, table, sport) : null;
  const awayEpa = awayId ? lookupEpa(away, table, sport) : null;

  if (!homeEpa || !awayEpa) {
    return {
      modelMargin: fallbackMargin,
      modelTotal: fallbackTotal,
      uncertainty: fallbackUncertainty(sport, homeSt, awaySt),
      totalUncBump: cfg.totalUncBump,
      methods: { ...cfg.fallback, family: null },
      usedEpa: false,
      engineSoft: { used: false },
      unknownTeam,
      unknownNames,
    };
  }

  const hAdj = sierraAdjust(homeEpa, homeSt, cfg);
  const aAdj = sierraAdjust(awayEpa, awaySt, cfg);
  // (homeOff - awayDef) - (awayOff - homeDef), in points, plus HFA.
  const homeEdge = hAdj.offEpa - aAdj.defEpa;
  const awayEdge = aAdj.offEpa - hAdj.defEpa;
  const baseMargin = (homeEdge - awayEdge) * cfg.plays + hfaPts;
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
    unknownTeam,
    unknownNames,
  };
}

module.exports = {
  SIERRA_W_GP2,
  SIERRA_W_CAP,
  sierraWeight,
  cardSeasonYear,
  seedSeasonStatus,
  SPORT_CFG,
  isCleanEpa,
  seedCenterStats,
  centerSeed,
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
  NCAAF_OA_PRIOR_GAMES,
  ncaafPacePriorGames,
  NCAAF_OA_BLOWOUT_MARGIN,
  NCAAF_OA_MIN_GAMES,
  NCAAF_OA_MARGIN_CAP,
  etMidnightMs,
  ncaafCompletedGames,
  solveNcaafOpponentRatings,
  projectNcaafOpponentAdjusted,
};
