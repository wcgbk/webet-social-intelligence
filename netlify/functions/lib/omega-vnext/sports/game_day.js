'use strict';

/**
 * Game-day adjustments for NFL/CFB/MLB projections.
 * Rest/B2B from prior-day scoreboard; soft QB status; small HFA tweaks.
 * Soft-fail friendly: missing inputs leave margin/total/uncertainty unchanged.
 */

const { clamp } = require('../odds_math');
const { fuzzyTeam } = require('./_common');
const { QA_HARDFAIL, ENGINE_SOFT } = require('../config');

const HFA_ADJ = {
  NFL: { max: 0.4, shortRest: -0.35, extraRest: 0.25 },
  NCAAF: { max: 0.5, shortRest: -0.4, extraRest: 0.3 },
  MLB: { max: 0.05, shortRest: -0.04, extraRest: 0.03 },
};

/** Days since last game considered "short rest" by sport. */
const SHORT_REST_DAYS = { NFL: 6, NCAAF: 5, MLB: 1 };
const EXTRA_REST_DAYS = { NFL: 9, NCAAF: 8, MLB: 2 };

function normTeamKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function prevEtDate(dateISO) {
  const [y, m, d] = String(dateISO || '').split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Build { [teamName]: { playedYesterday, lastPlayedDate } } from ESPN scoreboard games.
 */
function restMapFromScoreboard(games, playedDateISO) {
  const out = {};
  for (const g of games || []) {
    for (const team of [g.homeTeam, g.awayTeam]) {
      if (!team) continue;
      out[team] = {
        playedYesterday: true,
        lastPlayedDate: playedDateISO || null,
        abbr: null,
      };
    }
  }
  return out;
}

function lookupRest(teamName, restByTeam) {
  if (!teamName || !restByTeam) return null;
  if (restByTeam[teamName]) return restByTeam[teamName];
  const hit = fuzzyTeam(teamName, restByTeam);
  return hit || null;
}

function restDaysProxy(sport, restRow) {
  if (!restRow || !restRow.playedYesterday) return null;
  // Prior-day scoreboard only tells us "played yesterday" → rest ≈ 1 calendar day.
  return 1;
}

function hfaAdjustment(sport, homeRestDays, awayRestDays) {
  const cfg = HFA_ADJ[sport] || HFA_ADJ.NFL;
  const short = SHORT_REST_DAYS[sport] != null ? SHORT_REST_DAYS[sport] : 6;
  const extra = EXTRA_REST_DAYS[sport] != null ? EXTRA_REST_DAYS[sport] : 9;
  let adj = 0;
  // Home played yesterday → short rest at home
  if (homeRestDays != null && homeRestDays <= (sport === 'MLB' ? 1 : 1)) {
    // For football, "played yesterday" is rare (TNF→Fri) but still short.
    if (sport === 'MLB' || homeRestDays <= 1) adj += cfg.shortRest * 0.5;
  }
  // Away played yesterday → road short rest favors home
  if (awayRestDays != null && awayRestDays <= 1) {
    adj += Math.abs(cfg.shortRest) * 0.6;
  }
  // If only home is fresh (no prior-day play) and away is short → already covered.
  // Extra rest home: we only know "didn't play yesterday" so skip strong extra-rest
  // unless restDays explicitly large (future schedule ingest).
  if (homeRestDays != null && homeRestDays >= extra) adj += cfg.extraRest;
  if (awayRestDays != null && awayRestDays >= extra) adj -= cfg.extraRest * 0.5;
  return clamp(adj, -cfg.max, cfg.max);
}

function lookupQb(teamName, qbByTeam) {
  if (!teamName || !qbByTeam || typeof qbByTeam !== 'object') return null;
  const direct = qbByTeam[teamName] || qbByTeam[normTeamKey(teamName)];
  if (direct) return direct;
  for (const [k, v] of Object.entries(qbByTeam)) {
    if (normTeamKey(k) === normTeamKey(teamName)) return v;
    if (fuzzyTeam(teamName, { [k]: v })) return v;
  }
  return null;
}

function qbSoftAdjust(sport, homeQb, awayQb) {
  if (sport !== 'NFL' && sport !== 'NCAAF') {
    return { marginAdj: 0, uncBump: 0, note: null };
  }
  const outStatuses = (QA_HARDFAIL && QA_HARDFAIL.qbOutStatuses) || ['out', 'doubtful'];
  let marginAdj = 0;
  let uncBump = 0;
  const notes = [];
  const apply = (qb, side) => {
    if (!qb) return;
    const st = String(qb.qbStatus || qb.status || '').toLowerCase();
    if (!st) return;
    const isOut = outStatuses.some(k => st.includes(k));
    const isQ = /questionable|q\b/.test(st);
    if (isOut) {
      // Soft discount — QA hard-fail may still drop later.
      marginAdj += side === 'home' ? -1.75 : 1.75;
      uncBump += 0.04;
      notes.push(`${side} QB ${qb.qbName || ''} (${st})`.trim());
    } else if (isQ) {
      uncBump += 0.025;
      notes.push(`${side} QB questionable${qb.qbName ? ` (${qb.qbName})` : ''}`);
    }
  };
  apply(homeQb, 'home');
  apply(awayQb, 'away');
  if (sport === 'NCAAF') marginAdj *= 1.1;
  return {
    marginAdj: clamp(marginAdj, -3.5, 3.5),
    uncBump,
    note: notes.length ? notes.join('; ') : null,
  };
}


/**
 * QB continuity (NFL and NCAAF). Empty map → 0. Do not invent a healthy slate.
 * No injury row → healthy (1). Out/doubtful/IR/questionable → not healthy (0).
 * Margin moves only by the healthy gap, capped at ±qbContinuityPts.
 * qbSoftAdjust still owns the larger out/doubtful discount; this does not add another one.
 * nfl.js / cfb.js then stack this with success or talent under maxAbsMarginAdj.
 */
function qbContinuityAdjust(sport, homeQb, awayQb, qbByTeam, caps) {
  if (sport !== 'NFL' && sport !== 'NCAAF') {
    return { marginAdj: 0, note: null, used: false };
  }
  if (!qbByTeam || typeof qbByTeam !== 'object' || Array.isArray(qbByTeam) || !Object.keys(qbByTeam).length) {
    return { marginAdj: 0, note: null, used: false };
  }
  const sportCaps = (caps && caps[sport]) || (ENGINE_SOFT && ENGINE_SOFT[sport]) || {};
  const pts = Number.isFinite(Number(sportCaps.qbContinuityPts))
    ? Number(sportCaps.qbContinuityPts)
    : 0.55;
  const maxM = Number.isFinite(Number(sportCaps.maxAbsMarginAdj))
    ? Math.abs(Number(sportCaps.maxAbsMarginAdj))
    : (sport === 'NCAAF' ? 2 : 1.5);
  const outStatuses = (QA_HARDFAIL && QA_HARDFAIL.qbOutStatuses) || ['out', 'doubtful'];
  const isInjured = (qb) => {
    if (!qb) return false;
    const st = String(qb.qbStatus || qb.status || '').toLowerCase();
    if (!st) return false;
    return outStatuses.some(k => st.includes(k)) || /questionable|q\b/.test(st);
  };
  const homeHealthy = !isInjured(homeQb) ? 1 : 0;
  const awayHealthy = !isInjured(awayQb) ? 1 : 0;
  const raw = (homeHealthy - awayHealthy) * pts;
  const marginAdj = clamp(raw, -Math.abs(pts), Math.abs(pts));
  const overall = clamp(marginAdj, -maxM, maxM);
  return {
    marginAdj: overall,
    note: Math.abs(overall) > 1e-9
      ? `qb-continuity home=${homeHealthy} away=${awayHealthy}`
      : null,
    used: Math.abs(overall) > 1e-9,
  };
}

/**
 * Apply rest / QB soft adjustments. Weather handled separately for MLB totals.
 */
function applyGameDayAdjustments({
  sport,
  modelMargin,
  modelTotal,
  uncertainty,
  home,
  away,
  restByTeam,
  qbByTeam,
  hfaBase,
} = {}) {
  let margin = Number(modelMargin);
  let total = Number(modelTotal);
  let unc = Number(uncertainty);
  if (!Number.isFinite(margin)) margin = 0;
  if (!Number.isFinite(total)) total = sport === 'MLB' ? 8.6 : 45;
  if (!Number.isFinite(unc)) unc = 0.2;

  const homeRest = lookupRest(home, restByTeam);
  const awayRest = lookupRest(away, restByTeam);
  const homeDays = restDaysProxy(sport, homeRest);
  const awayDays = restDaysProxy(sport, awayRest);
  const hfaAdj = hfaAdjustment(sport, homeDays, awayDays);
  margin += hfaAdj;

  const homeQb = lookupQb(home, qbByTeam);
  const awayQb = lookupQb(away, qbByTeam);
  const qb = qbSoftAdjust(sport, homeQb, awayQb);
  margin += qb.marginAdj;
  unc = Math.min(0.45, unc + qb.uncBump);

  const cont = qbContinuityAdjust(sport, homeQb, awayQb, qbByTeam);
  margin += cont.marginAdj;

  const meta = {
    restHome: homeDays,
    restAway: awayDays,
    playedYesterdayHome: !!(homeRest && homeRest.playedYesterday),
    playedYesterdayAway: !!(awayRest && awayRest.playedYesterday),
    hfaAdj: +hfaAdj.toFixed(3),
    hfaBase: hfaBase != null ? hfaBase : null,
    qbNote: qb.note,
    qbContinuity: cont.used ? { marginAdj: cont.marginAdj, note: cont.note } : null,
    weatherNote: null,
    applied: Math.abs(hfaAdj) > 0.001 || Math.abs(qb.marginAdj) > 0.001 || qb.uncBump > 0 || cont.used,
  };

  return {
    modelMargin: margin,
    modelTotal: total,
    uncertainty: unc,
    gameDay: meta,
  };
}

/**
 * MLB weather → soft total adjustment. Missing weather = no change.
 * tempF, condition, windMph, windDir optional.
 */
function applyWeatherTotalAdj(modelTotal, weather) {
  let total = Number(modelTotal);
  if (!Number.isFinite(total)) return { modelTotal: modelTotal, weatherNote: null, applied: false };
  if (!weather || typeof weather !== 'object') {
    return { modelTotal: total, weatherNote: null, applied: false };
  }
  const temp = weather.tempF != null ? Number(weather.tempF) : Number(weather.temperature);
  const wind = weather.windMph != null ? Number(weather.windMph) : Number(weather.windSpeed);
  const cond = String(weather.condition || weather.displayValue || '').toLowerCase();
  let adj = 0;
  const notes = [];
  if (Number.isFinite(temp)) {
    if (temp <= 45) { adj -= 0.35; notes.push(`cold ${temp}F`); }
    else if (temp <= 52) { adj -= 0.18; notes.push(`cool ${temp}F`); }
    else if (temp >= 88) { adj += 0.15; notes.push(`hot ${temp}F`); }
  }
  if (Number.isFinite(wind) && wind >= 12) {
    const dir = String(weather.windDir || weather.windDirection || '').toLowerCase();
    if (/out|o\.?\.?f\.?\.?|blow.?out/.test(dir) || /out/.test(cond)) {
      adj += 0.2;
      notes.push(`wind out ${wind}mph`);
    } else if (/in|i\.?\.?f\.?\.?|blow.?in/.test(dir)) {
      adj -= 0.15;
      notes.push(`wind in ${wind}mph`);
    } else {
      adj -= 0.05;
      notes.push(`wind ${wind}mph`);
    }
  }
  if (/rain|shower|storm|delay/.test(cond)) {
    adj -= 0.25;
    notes.push(cond.split(/[,/]/)[0].trim() || 'rain');
  }
  if (!notes.length) return { modelTotal: total, weatherNote: null, applied: false };
  total = clamp(total + adj, 5.5, 14.5);
  return { modelTotal: total, weatherNote: notes.join('; '), applied: true };
}

module.exports = {
  HFA_ADJ,
  SHORT_REST_DAYS,
  EXTRA_REST_DAYS,
  normTeamKey,
  prevEtDate,
  restMapFromScoreboard,
  lookupRest,
  hfaAdjustment,
  qbSoftAdjust,
  qbContinuityAdjust,
  applyGameDayAdjustments,
  applyWeatherTotalAdj,
};
