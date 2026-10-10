'use strict';

/**
 * Game-day adjustments for NFL/CFB/MLB/NHL/NBA projections.
 * MLB/NHL/NBA rest is still the prior-day scoreboard (played yesterday).
 * NFL/NCAAF rest days come from the weekly scoreboard (rest_schedule.js)
 * when OMEGA_REST_ADJ is on (the default). OMEGA_REST_ADJ=0 keeps the
 * played-yesterday HFA proxy for football too.
 * NHL rest is goal-scale (B2B). NBA rest is point-scale (B2B).
 * No QB adjustment for hockey or basketball.
 * Soft-fail friendly: missing inputs leave margin/total/uncertainty unchanged.
 * Football rest does not move the total.
 */

const { clamp, etCalendarDate } = require('../odds_math');
const { rowByIdentity, rowByIdentityOrFuzzy, modelRow, resolveTeamId, isFbsTeamId } = require('./team_identity');
const { QA_HARDFAIL, ENGINE_SOFT, QB_INJURY, WEATHER_NFL, REST_ADJ, restAdjEnabled } = require('../config');

const HFA_ADJ = {
  NFL: { max: 0.4, shortRest: -0.35, extraRest: 0.25 },
  NCAAF: { max: 0.5, shortRest: -0.4, extraRest: 0.3 },
  MLB: { max: 0.05, shortRest: -0.04, extraRest: 0.03 },
  NHL: { max: 0.10, shortRest: -0.08, extraRest: 0.05 },
  // Point scale. Home B2B ≈ shortRest*0.5 (−1.5). Away B2B ≈ +1.8. Cap 2.5.
  NBA: { max: 2.5, shortRest: -3.0, extraRest: 0.8 },
};

/** Days since last game considered "short rest" by sport. */
const SHORT_REST_DAYS = { NFL: 6, NCAAF: 5, MLB: 1, NHL: 1, NBA: 1 };
const EXTRA_REST_DAYS = { NFL: 9, NCAAF: 8, MLB: 2, NHL: 2, NBA: 3 };

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

function lookupRest(teamName, restByTeam, sport, fallbackSeen) {
  if (!teamName || !restByTeam) return null;
  if (restByTeam[teamName]) return restByTeam[teamName];
  if (sport === 'NBA') return rowByIdentity(sport, restByTeam, teamName);
  if (sport === 'NFL' || sport === 'NCAAF') return modelRow(sport, restByTeam, teamName, { fallbackSeen }) || null;
  return rowByIdentityOrFuzzy(sport, restByTeam, teamName, { fallbackSeen }) || null;
}

function restDaysProxy(sport, restRow) {
  if (!restRow || !restRow.playedYesterday) return null;
  // Prior-day scoreboard only tells us "played yesterday" → rest ≈ 1 calendar day.
  // REST-PROXY-EXTRA-DAYS-DEAD: this returns 1 or null. EXTRA_REST_DAYS is
  // 2+ for every sport, so hfaAdjustment's extra-rest branch never fires on
  // the proxy. That branch stays for a future schedule-fed restDays.
  return 1;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Weekday of the ET calendar date, so a 00:20Z Friday kick is Thursday. */
function etWeekday(iso) {
  const ymd = etCalendarDate(iso);
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (![y, m, d].every(Number.isInteger)) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  });
}

/** Whole ET calendar days from the previous kickoff to this one. */
function etCalendarDaysBetween(prevIso, nextIso) {
  const a = etCalendarDate(prevIso);
  const b = etCalendarDate(nextIso);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  if (![ay, am, ad, by, bm, bd].every(Number.isInteger)) return null;
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86400000);
}

function restScheduleActive(sport, schedule) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return false;
  if (!restAdjEnabled()) return false;
  if (!schedule || typeof schedule !== 'object') return false;
  return schedule.loaded === true || schedule.fetchFailed === true;
}

/** Same matchup listed up to 36h off the odds commence is still this game. */
const CURRENT_GAME_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Latest regular-season kickoff for this ESPN team id on an earlier ET
 * calendar date. The current game is not rest: the same team-id pair
 * within ±36h of the odds commence is skipped, and a kickoff on the same
 * ET date is skipped. An ESPN stamp 60s before the odds commence is the
 * current game (rest would otherwise be 0).
 */
function priorKickoff(schedule, teamId, commenceTime, opponentId) {
  if (!schedule || schedule.fetchFailed || !schedule.loaded) return null;
  if (!teamId || !commenceTime) return null;
  const cutoff = Date.parse(commenceTime);
  if (!Number.isFinite(cutoff)) return null;
  const cutoffEt = etCalendarDate(commenceTime);
  if (!cutoffEt) return null;
  const want = String(teamId);
  const opp = opponentId != null && opponentId !== '' ? String(opponentId) : null;
  let best = null;
  let bestT = -Infinity;
  for (const g of schedule.games || []) {
    if (!g || String(g.teamId) !== want) continue;
    const t = Date.parse(g.commence);
    if (!Number.isFinite(t)) continue;
    const rowOpp = g.opponentId != null && g.opponentId !== '' ? String(g.opponentId) : null;
    if (opp && rowOpp && rowOpp === opp && Math.abs(t - cutoff) <= CURRENT_GAME_WINDOW_MS) continue;
    const rowEt = etCalendarDate(g.commence);
    if (!rowEt || rowEt >= cutoffEt) continue;
    if (t > bestT) {
      bestT = t;
      best = g;
    }
  }
  return best;
}

function categoryForRest(sport, restDays, prevIso, nextIso) {
  if (restDays == null || !Number.isFinite(restDays) || restDays < 0) return 'unknown';
  if (sport === 'NCAAF') {
    const wd = etWeekday(nextIso);
    if (restDays <= 5 && (wd === 'Tue' || wd === 'Wed' || wd === 'Thu')) return 'short';
    if (restDays >= 13) return 'bye';
    return 'normal';
  }
  if (restDays <= 4) return 'short';
  if (restDays >= 13) return 'bye';
  if (restDays >= 10) return 'mini-bye';
  if (restDays === 6 && etWeekday(prevIso) === 'Mon' && etWeekday(nextIso) === 'Sun') return 'mnf';
  return 'normal';
}

function categoryPoints(sport, category) {
  const cfg = REST_ADJ[sport];
  if (!cfg || !category || category === 'unknown' || category === 'normal') return 0;
  if (category === 'short') return cfg.short;
  if (category === 'mini-bye') return cfg.miniBye || 0;
  if (category === 'bye') return cfg.bye || 0;
  if (category === 'mnf') return cfg.mnf || 0;
  return 0;
}

/** Home-margin points. Caps at REST_ADJ[sport].cap. Does not touch the total. */
function restMarginAdj(sport, homeCat, awayCat, opts) {
  const cfg = REST_ADJ[sport];
  if (!cfg) return 0;
  if (homeCat === 'unknown' || awayCat === 'unknown') return 0;
  let adj = categoryPoints(sport, homeCat) - categoryPoints(sport, awayCat);
  const neutral = !!(opts && opts.neutralSite === true);
  if (!neutral && awayCat === 'short' && Number.isFinite(Number(cfg.roadShort))) adj += Number(cfg.roadShort);
  const cap = Number(cfg.cap);
  if (Number.isFinite(cap)) adj = clamp(adj, -Math.abs(cap), Math.abs(cap));
  return round3(adj);
}

function teamRest(sport, schedule, teamName, commenceTime, opponentName) {
  const unknown = { restDays: null, category: 'unknown', prevCommence: null, teamId: null };
  if (!restScheduleActive(sport, schedule) || !schedule.loaded || schedule.fetchFailed) return unknown;
  const teamId = resolveTeamId(sport, teamName);
  if (!teamId) return unknown;
  // FCS (and anyone outside the FBS id list) only shows up on groups=80
  // when they play an FBS team. The gap between those games is not a bye.
  if (sport === 'NCAAF' && !isFbsTeamId(teamId)) {
    return { restDays: null, category: 'unknown', prevCommence: null, teamId: String(teamId) };
  }
  const opponentId = opponentName ? resolveTeamId(sport, opponentName) : null;
  const prior = priorKickoff(schedule, teamId, commenceTime, opponentId);
  if (!prior) return { restDays: null, category: 'unknown', prevCommence: null, teamId: String(teamId) };
  const days = etCalendarDaysBetween(prior.commence, commenceTime);
  return {
    restDays: days,
    category: categoryForRest(sport, days, prior.commence, commenceTime),
    prevCommence: prior.commence,
    teamId: String(teamId),
  };
}

function describeMatchRest(sport, schedule, home, away, commenceTime, opts) {
  const homeRow = teamRest(sport, schedule, home, commenceTime, away);
  const awayRow = teamRest(sport, schedule, away, commenceTime, home);
  return {
    restDays: { home: homeRow.restDays, away: awayRow.restDays },
    restCategory: { home: homeRow.category, away: awayRow.category },
    restAdj: restMarginAdj(sport, homeRow.category, awayRow.category, opts),
    totalAdj: 0,
  };
}

function restCoverageCounts(sport, schedule, slateGames) {
  const seen = new Set();
  let slate = 0;
  let known = 0;
  const fetchFailed = !!(schedule && schedule.fetchFailed);
  const canKnow = !!(schedule && schedule.loaded && !fetchFailed);
  for (const g of slateGames || []) {
    if (!g) continue;
    for (const name of [g.home, g.away]) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      slate += 1;
      if (!canKnow) continue;
      const opponent = name === g.home ? g.away : g.home;
      const row = teamRest(sport, schedule, name, g.commence, opponent);
      if (row.restDays != null) known += 1;
    }
  }
  return { known, slate, fetchFailed };
}

function stampRestAudit(raw, meta) {
  if (!raw || !meta || meta.restPending !== true) return raw;
  raw.restDays = meta.restDays;
  raw.restCategory = meta.restCategory;
  raw.restAdj = meta.restAdj;
  return raw;
}

function restAuditFields(c) {
  if (!c) return {};
  const out = {};
  if (c.restDays !== undefined) out.restDays = c.restDays;
  if (c.restCategory !== undefined) out.restCategory = c.restCategory;
  if (c.restAdj !== undefined) out.restAdj = c.restAdj;
  return out;
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
  // Dead on the played-yesterday proxy (restDaysProxy is 1 or null; extra is 2+).
  if (homeRestDays != null && homeRestDays >= extra) adj += cfg.extraRest;
  if (awayRestDays != null && awayRestDays >= extra) adj -= cfg.extraRest * 0.5;
  return clamp(adj, -cfg.max, cfg.max);
}

function lookupQb(teamName, qbByTeam, sport, fallbackSeen) {
  if (!teamName || !qbByTeam || typeof qbByTeam !== 'object') return null;
  const direct = qbByTeam[teamName] || qbByTeam[normTeamKey(teamName)];
  if (direct) return direct;
  if (sport === 'NFL' || sport === 'NCAAF') return modelRow(sport, qbByTeam, teamName, { fallbackSeen });
  for (const [k, v] of Object.entries(qbByTeam)) {
    if (normTeamKey(k) === normTeamKey(teamName)) return v;
    if (rowByIdentityOrFuzzy(sport, { [k]: v }, teamName, { fallbackSeen })) return v;
  }
  return null;
}

function qbSoftAdjust(sport, homeQb, awayQb) {
  if (sport !== 'NFL' && sport !== 'NCAAF') {
    return { marginAdj: 0, totalAdj: 0, uncBump: 0, note: null };
  }
  const outStatuses = (QA_HARDFAIL && QA_HARDFAIL.qbOutStatuses) || ['out', 'doubtful'];
  const cfg = (QB_INJURY && QB_INJURY[sport]) || { outMarginPts: 3.0, outTotalPts: -1.5, doubtfulWeight: 0.75, maxAbsMarginAdj: 5.0, maxAbsTotalAdj: 3.0 };
  let marginAdj = 0;
  let totalAdj = 0;
  let uncBump = 0;
  const notes = [];
  const apply = (qb, side) => {
    if (!qb) return;
    const st = String(qb.qbStatus || qb.status || '').toLowerCase();
    if (!st) return;
    const isOut = outStatuses.some(k => st.includes(k));
    const isQ = /questionable|q\b/.test(st);
    if (isOut) {
      // Known QB injury is priced into the projection, never a cancel (2026-09-28).
      const w = /doubtful/.test(st) ? cfg.doubtfulWeight : 1;
      marginAdj += (side === 'home' ? -1 : 1) * cfg.outMarginPts * w;
      totalAdj += cfg.outTotalPts * w;
      uncBump += 0.04;
      notes.push(`${side} QB ${qb.qbName || ''} (${st})`.trim());
    } else if (isQ) {
      uncBump += 0.025;
      notes.push(`${side} QB questionable${qb.qbName ? ` (${qb.qbName})` : ''}`);
    }
  };
  apply(homeQb, 'home');
  apply(awayQb, 'away');
  return {
    marginAdj: clamp(marginAdj, -cfg.maxAbsMarginAdj, cfg.maxAbsMarginAdj),
    totalAdj: clamp(totalAdj, -cfg.maxAbsTotalAdj, cfg.maxAbsTotalAdj),
    uncBump,
    note: notes.length ? notes.join('; ') : null,
  };
}


/**
 * QB continuity (NFL and NCAAF). Empty map → 0. Do not invent a healthy slate.
 * No injury row or out/doubtful (priced by qbSoftAdjust) → 1. Questionable → 0.
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
    // Out/doubtful is already priced once by qbSoftAdjust. Counting it here too
    // would penalize the same known injury twice (2026-09-28). Continuity only
    // reflects a questionable QB, which qbSoftAdjust does not move the margin for.
    if (outStatuses.some(k => st.includes(k))) return false;
    return /questionable|q\b/.test(st);
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
 * Apply rest / QB soft adjustments. Weather is not applied here.
 * MLB totals use applyWeatherTotalAdj. NFL totals use applyNflWeatherTotalAdj.
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
  fallbackSeen,
  commenceTime,
  restSchedule,
  neutralSite,
} = {}) {
  let margin = Number(modelMargin);
  let total = Number(modelTotal);
  let unc = Number(uncertainty);
  if (!Number.isFinite(margin)) margin = 0;
  if (!Number.isFinite(total)) {
    if (sport === 'MLB') total = 8.6;
    else if (sport === 'NHL') total = 6.2;
    else if (sport === 'NBA') total = 228;
    else total = 45;
  }
  if (!Number.isFinite(unc)) unc = 0.2;

  const scheduleOn = restScheduleActive(sport, restSchedule);
  // The schedule path does not use the played-yesterday map. modelRow on
  // that map fuzzy-scans every football name and logs the refused match.
  let homeRest = null;
  let awayRest = null;
  if (!scheduleOn) {
    homeRest = lookupRest(home, restByTeam, sport, fallbackSeen);
    awayRest = lookupRest(away, restByTeam, sport, fallbackSeen);
  }
  const homeDays = restDaysProxy(sport, homeRest);
  const awayDays = restDaysProxy(sport, awayRest);
  let restMeta = null;
  let hfaAdj = 0;
  if (scheduleOn) {
    // Real kickoff gap replaces the played-yesterday proxy. The points
    // are applied on the epa margin path (applyEngineStack), outside the
    // stacked engine cap. A failed scoreboard stays at 0.
    restMeta = describeMatchRest(sport, restSchedule, home, away, commenceTime, {
      neutralSite: neutralSite === true,
    });
  } else {
    hfaAdj = hfaAdjustment(sport, homeDays, awayDays);
    margin += hfaAdj;
  }

  const homeQb = lookupQb(home, qbByTeam, sport, fallbackSeen);
  const awayQb = lookupQb(away, qbByTeam, sport, fallbackSeen);
  const qb = qbSoftAdjust(sport, homeQb, awayQb);
  margin += qb.marginAdj;
  total += qb.totalAdj || 0;
  unc = Math.min(0.45, unc + qb.uncBump);

  const cont = qbContinuityAdjust(sport, homeQb, awayQb, qbByTeam);
  margin += cont.marginAdj;

  const restAdj = restMeta ? restMeta.restAdj : 0;
  const meta = {
    restHome: scheduleOn && restMeta ? restMeta.restDays.home : homeDays,
    restAway: scheduleOn && restMeta ? restMeta.restDays.away : awayDays,
    playedYesterdayHome: !!(homeRest && homeRest.playedYesterday),
    playedYesterdayAway: !!(awayRest && awayRest.playedYesterday),
    hfaAdj: +hfaAdj.toFixed(3),
    hfaBase: hfaBase != null ? hfaBase : null,
    qbNote: qb.note,
    qbMarginAdj: +(qb.marginAdj || 0).toFixed(2),
    qbTotalAdj: +(qb.totalAdj || 0).toFixed(2),
    qbContinuity: cont.used ? { marginAdj: cont.marginAdj, note: cont.note } : null,
    weatherNote: null,
    applied: Math.abs(hfaAdj) > 0.001 || Math.abs(restAdj) > 0.001 || Math.abs(qb.marginAdj) > 0.001 || Math.abs(qb.totalAdj || 0) > 0.001 || qb.uncBump > 0 || cont.used,
  };
  if (scheduleOn && restMeta) {
    meta.restDays = restMeta.restDays;
    meta.restCategory = restMeta.restCategory;
    meta.restAdj = restMeta.restAdj;
    meta.restPending = true;
  }

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

function readNflTempF(weather) {
  const raw = weather.tempF != null ? weather.tempF : weather.temperature;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readNflWindMph(weather) {
  if (weather.windMph != null && weather.windMph !== '') {
    const n = Number(weather.windMph);
    if (Number.isFinite(n)) return n;
  }
  if (weather.windSpeed != null && weather.windSpeed !== '') {
    const n = Number(String(weather.windSpeed).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  const text = [weather.displayValue, weather.condition, weather.windDir]
    .filter(v => v != null && v !== '')
    .join(' ');
  const m = text.match(/(\d+(?:\.\d+)?)\s*mph\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * NFL wind / cold total adjustment. Indoor or missing weather → 0.
 * Subtracts only. Does not read or return a margin.
 */
function applyNflWeatherTotalAdj(modelTotal, weather, opts = {}) {
  const total = Number(modelTotal);
  const unchanged = {
    modelTotal: Number.isFinite(total) ? total : modelTotal,
    totalAdj: 0,
    weatherNote: null,
    applied: false,
  };
  if (!Number.isFinite(total)) return unchanged;
  const indoor = opts.indoor === true || (weather && weather.indoor === true);
  if (indoor) return unchanged;
  if (!weather || typeof weather !== 'object') return unchanged;

  const cfg = WEATHER_NFL || {};
  const windOn = Number(cfg.windOnMph);
  const windBase = Number(cfg.windBaseMph);
  const perMph = Number(cfg.windPtsPerMph);
  const windCap = Number(cfg.windCap);
  const coldAt = Number(cfg.coldAtOrBelowF);
  const coldPts = Number(cfg.coldAdj);
  const totalCap = Number(cfg.totalCap);

  const temp = readNflTempF(weather);
  const wind = readNflWindMph(weather);
  let windAdj = 0;
  let coldAdj = 0;
  const notes = [];
  if (Number.isFinite(wind) && Number.isFinite(windOn) && wind >= windOn && Number.isFinite(perMph) && perMph > 0) {
    const above = Number.isFinite(windBase) ? Math.max(0, wind - windBase) : 0;
    let pts = perMph * above;
    if (Number.isFinite(windCap) && windCap > 0) pts = Math.min(pts, windCap);
    windAdj = -pts;
    if (windAdj < 0) notes.push(`wind ${wind}mph ${windAdj}`);
  }
  if (Number.isFinite(temp) && Number.isFinite(coldAt) && temp <= coldAt && Number.isFinite(coldPts) && coldPts > 0) {
    coldAdj = -coldPts;
    notes.push(`cold ${temp}F ${coldAdj}`);
  }
  let adj = windAdj + coldAdj;
  if (Number.isFinite(totalCap) && totalCap > 0 && adj < -totalCap) {
    adj = -totalCap;
    notes.push(`cap ${adj}`);
  }
  if (!(adj < 0)) return unchanged;
  return {
    modelTotal: total + adj,
    totalAdj: adj,
    weatherNote: notes.join('; '),
    applied: true,
  };
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
  etWeekday,
  etCalendarDaysBetween,
  restScheduleActive,
  CURRENT_GAME_WINDOW_MS,
  priorKickoff,
  categoryForRest,
  restMarginAdj,
  teamRest,
  describeMatchRest,
  restCoverageCounts,
  stampRestAudit,
  restAuditFields,
  qbSoftAdjust,
  qbContinuityAdjust,
  applyGameDayAdjustments,
  applyWeatherTotalAdj,
  applyNflWeatherTotalAdj,
};
