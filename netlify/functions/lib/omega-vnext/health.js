'use strict';

// Generate-time health. Reads copies of data already in memory. No network.
// A throw inside the builder must not escape attachGenerateHealth.

const { SPORTS_ENABLED } = require('./config');
const { collectUnresolved, resolveTeamId, rowByIdentity } = require('./sports/team_identity');
const { gamesPlayedInfo, explicitPointsPerGame } = require('./sports/_common');
const { isCleanEpa } = require('./sports/epa');
const nhl = require('./sports/nhl');
const { sportsForCard, calendarHealth } = require('./season_calendar');

const SPORTS = ['MLB', 'NFL', 'NCAAF', 'NHL', 'NBA'];
const BANDS = {
  NFL: [10, 40],
  NCAAF: [7, 55],
  NHL: [1.5, 5.2],
  MLB: [2.5, 7],
  NBA: [90, 135],
};
const BIAS_LIMIT = {
  MLB: { total: 0.4, margin: 0.4 },
  NHL: { total: 0.3, margin: 0.3 },
  NFL: { total: 1.5, margin: 1 },
  NCAAF: { total: 1.5, margin: 1 },
  NBA: { total: 3, margin: 2 },
};

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const k of keys) {
    if (row[k] == null || row[k] === '') continue;
    const n = num(row[k]);
    if (n != null) return n;
  }
  return null;
}

function recordParts(row) {
  const rec = row && row.record;
  if (typeof rec !== 'string') return null;
  const m = rec.trim().match(/^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  return { wins: +m[1], losses: +m[2], ties: m[3] != null ? +m[3] : 0 };
}

function explicitGp(row) {
  return firstNum(row, ['games', 'gp', 'gamesPlayed']);
}

function gamesOf(row) {
  const g = explicitGp(row);
  if (g != null) return g;
  const w = firstNum(row, ['wins']);
  const l = firstNum(row, ['losses']);
  if (w != null && l != null) {
    return w + l + (firstNum(row, ['ties']) || 0) + (firstNum(row, ['otLosses', 'otl']) || 0);
  }
  const rec = recordParts(row);
  if (!rec) return null;
  return rec.wins + rec.losses + rec.ties;
}

function pointsOf(row) {
  return firstNum(row, ['pf', 'pointsFor', 'goalsFor', 'gf', 'runsFor', 'points']);
}

function rateOf(row, sport) {
  const explicit = firstNum(row, ['avgPointsFor', 'pointsPerGame', 'pfPerGame', 'ppg', 'gpg', 'rpg']);
  if (explicit != null) return explicit;
  const pf = pointsOf(row);
  if (pf == null) return null;
  const gp = gamesOf(row);
  const band = BANDS[sport];
  if (gp != null && gp >= 2 && band && pf > band[1]) return pf / gp;
  return pf;
}

/**
 * NHL baseline and out-of-band follow the rate the projector uses
 * (teamGpgDetail). One definition for both counters.
 * Out of band: the detail baseline is a bad rate ('out of band',
 * 'implausible rate', 'standings-points guard'), or the rate the model
 * keeps is still outside [floor, cap]. Early raw rates that shrink into
 * the band are not an error.
 * Baseline: any detail baseline, including gp<2 and no goals data, which
 * are not out of band.
 * statSanity counts standings rows. Slate names with no standings row are
 * added with this same helper so the two loops do not replace each other.
 */
const NHL_OOB_REASONS = new Set(['out of band', 'implausible rate', 'standings-points guard']);

function nhlClubHealth(row) {
  const d = nhl.teamGpgDetail(row) || {};
  const baseline = !!d.baseline;
  let outOfBand = false;
  if (d.baseline && NHL_OOB_REASONS.has(d.baseline)) outOfBand = true;
  else if (!d.baseline && d.gf != null && d.ga != null) {
    const lo = nhl.NHL_GPG_FLOOR;
    const hi = nhl.NHL_GPG_CAP;
    if (d.gf < lo || d.gf > hi || d.ga < lo || d.ga > hi) outOfBand = true;
  }
  return { outOfBand, baseline };
}

function roundTo(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function modalShare(values, places) {
  const counts = new Map();
  for (const v of values) {
    const k = String(roundTo(v, places));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = 0;
  let bestKey = null;
  for (const [k, n] of counts) {
    if (n > best) { best = n; bestKey = k; }
  }
  return { n: values.length, share: values.length ? best / values.length : 0, value: bestKey };
}

function espnGames(snap, sport) {
  const espn = snap && snap.espnBySport && snap.espnBySport[sport];
  if (Array.isArray(espn)) return espn;
  if (espn && Array.isArray(espn.games)) return espn.games;
  return [];
}

function oddsEvents(snap, sport) {
  const odds = snap && snap.oddsBySport && snap.oddsBySport[sport];
  return Array.isArray(odds) ? odds : [];
}

function namesFor(snap, sport) {
  const names = [];
  for (const ev of oddsEvents(snap, sport)) {
    if (!ev) continue;
    if (ev.home_team) names.push(ev.home_team);
    if (ev.away_team) names.push(ev.away_team);
    if (ev.homeTeam) names.push(ev.homeTeam);
    if (ev.awayTeam) names.push(ev.awayTeam);
  }
  for (const g of espnGames(snap, sport)) {
    if (!g) continue;
    if (g.homeTeam) names.push(g.homeTeam);
    if (g.awayTeam) names.push(g.awayTeam);
    if (g.home) names.push(g.home);
    if (g.away) names.push(g.away);
  }
  const table = snap && snap.standingsBySport && snap.standingsBySport[sport];
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const key of Object.keys(table)) {
      if (!key.startsWith('_')) names.push(key);
    }
  }
  return names;
}

function statSanity(snap, sport) {
  const table = snap && snap.standingsBySport && snap.standingsBySport[sport];
  const rows = [];
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [key, row] of Object.entries(table)) {
      if (!key.startsWith('_') && row && typeof row === 'object') rows.push(row);
    }
  }
  const band = BANDS[sport];
  const rates = [];
  let gpZeroPoints = 0;
  let outOfBand = 0;
  let baselineTeams = 0;
  let recordMismatch = 0;
  for (const row of rows) {
    const gp = explicitGp(row);
    const pf = pointsOf(row);
    if (gp === 0 && pf != null && pf !== 0) gpZeroPoints += 1;
    const rate = rateOf(row, sport);
    if (rate != null) rates.push(rate);
    if (sport === 'NHL') {
      const club = nhlClubHealth(row);
      if (club.outOfBand) outOfBand += 1;
      if (club.baseline) baselineTeams += 1;
    } else if (rate != null && band && (rate < band[0] || rate > band[1])) {
      outOfBand += 1;
    }
    if (rowMismatch(row)) recordMismatch += 1;
  }
  const modal = modalShare(rates, 4);
  const constantStat = modal.n >= 4 && modal.share > 0.8;
  const stats = {
    teams: rows.length,
    gpZeroPoints,
    outOfBand,
    recordMismatch,
    constantStat,
    constantValue: constantStat ? modal.value : null,
    constantShare: modal.n ? +modal.share.toFixed(3) : 0,
  };
  if (sport === 'NHL') stats.baselineTeams = baselineTeams;
  return stats;
}

const GUARD_SPORTS = new Set(['NFL', 'NCAAF', 'NHL']);
const SCHEMA_FIELDS = {
  NFL: ['losses'],
  NCAAF: ['overall'],
  NHL: ['goalsFor', 'goalsAgainst'],
};

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function gpInfoFor(sport, row) {
  if (!row) return { gp: 0, source: 'unknown', known: false };
  if (sport === 'NHL') return nhl.nhlGamesInfo(row);
  return gamesPlayedInfo(row);
}

function schemaFieldPresent(row, field) {
  if (!row || typeof row !== 'object') return false;
  if (field === 'losses') return finiteNum(row.losses) != null;
  if (field === 'overall') {
    if (row.overall != null && row.overall !== '') return true;
    if (typeof row.record === 'string' && row.record.trim()) return true;
    return finiteNum(row.wins) != null && finiteNum(row.losses) != null;
  }
  if (field === 'goalsFor') {
    if (finiteNum(row.goalsFor) != null || finiteNum(row.gf) != null) return true;
    if (row.nhlSeasonGoals === true && finiteNum(row.pf) != null) return true;
    if (finiteNum(row.avgGoalsFor) != null || finiteNum(row.avgPointsFor) != null) return true;
    return false;
  }
  if (field === 'goalsAgainst') {
    if (finiteNum(row.goalsAgainst) != null || finiteNum(row.ga) != null) return true;
    if (row.nhlSeasonGoals === true && finiteNum(row.pa) != null) return true;
    if (finiteNum(row.avgGoalsAgainst) != null || finiteNum(row.avgPointsAgainst) != null) return true;
    return false;
  }
  return row[field] != null && row[field] !== '';
}

function footballHasScoring(row) {
  if (!row) return false;
  if (explicitPointsPerGame(row)) return true;
  const pf = finiteNum(row.pf);
  const pa = finiteNum(row.pa);
  if (pf != null && pa != null && pa !== 0) return true;
  if (row.winPct != null && finiteNum(row.winPct) != null) return true;
  return false;
}

function seasonCut(sport) {
  const band = BANDS[sport];
  if (!band) return Infinity;
  return band[1] * 1.5;
}

function footballRateMismatch(sport, row) {
  if (!row) return false;
  const band = BANDS[sport];
  if (!band) return false;
  const g = gamesPlayedInfo(row).gp;
  const explicit = explicitPointsPerGame(row);
  const cut = seasonCut(sport);
  if (g >= 2 && explicit) return explicit.pfPg > cut || explicit.paPg > cut;
  const pf = finiteNum(row.pf);
  const pa = finiteNum(row.pa);
  if (pf == null || pa == null) return false;
  if (g < 2 && (pf > cut || pa > cut)) return true;
  if (g >= 2) {
    const pfPg = pf / g;
    const paPg = pa / g;
    if (pfPg < band[0] || paPg < band[0]) return true;
  }
  return false;
}

function onBaseline(sport, name, row, snap) {
  if (sport === 'NHL') return nhlClubHealth(row).baseline;
  if (sport === 'NFL' || sport === 'NCAAF') {
    const eff = snap && snap.efficiencyBySport && snap.efficiencyBySport[sport];
    if (name && isCleanEpa(rowByIdentity(sport, eff || {}, name))) return false;
    return !footballHasScoring(row);
  }
  return false;
}

function slateNames(snap, sport) {
  const out = [];
  const seen = new Set();
  for (const ev of oddsEvents(snap, sport)) {
    if (!ev) continue;
    for (const name of [ev.home_team, ev.away_team, ev.homeTeam, ev.awayTeam]) {
      if (name == null || name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Slate clubs with no standings row. statSanity already counted every row
 * through nhlClubHealth, so these are the only names still missing from
 * baselineTeams / outOfBand.
 */
function nhlSlateMissingHealth(snap) {
  let outOfBand = 0;
  let baselineTeams = 0;
  const table = (snap && snap.standingsBySport && snap.standingsBySport.NHL) || {};
  for (const name of slateNames(snap, 'NHL')) {
    const row = resolveTeamId('NHL', name) ? rowByIdentity('NHL', table, name) : null;
    if (row) continue;
    const club = nhlClubHealth(row);
    if (club.outOfBand) outOfBand += 1;
    if (club.baseline) baselineTeams += 1;
  }
  return { outOfBand, baselineTeams };
}

function standingsRows(snap, sport) {
  const table = snap && snap.standingsBySport && snap.standingsBySport[sport];
  const rows = [];
  if (!table || typeof table !== 'object' || Array.isArray(table)) return rows;
  for (const [key, row] of Object.entries(table)) {
    if (!key || key.startsWith('_') || !row || typeof row !== 'object') continue;
    rows.push(row);
  }
  return rows;
}

function inputStatGuards(snap, sport) {
  const counts = {
    gpUnknown: 0,
    rateScale: 0,
    nhlPointsAsGoals: 0,
    baselineTeams: 0,
    schemaMissing: 0,
  };
  const schemaFields = [];
  if (!GUARD_SPORTS.has(sport)) return { counts, schemaFields };
  const table = (snap && snap.standingsBySport && snap.standingsBySport[sport]) || {};
  for (const name of slateNames(snap, sport)) {
    const row = resolveTeamId(sport, name) ? rowByIdentity(sport, table, name) : null;
    const info = gpInfoFor(sport, row);
    if (!info.known) counts.gpUnknown += 1;
    const scale = sport === 'NHL' ? nhl.nhlRateMismatch(row) : footballRateMismatch(sport, row);
    if (scale) counts.rateScale += 1;
    if (sport === 'NHL' && row && row.nhlSeasonGoals !== true) {
      const pf = finiteNum(row.pf != null ? row.pf : row.gf);
      const pa = finiteNum(row.pa != null ? row.pa : row.ga);
      if (nhl.pfLooksLikeStandingsPoints(row, pf) || nhl.pfLooksLikeStandingsPoints(row, pa)) {
        counts.nhlPointsAsGoals += 1;
      }
    }
    // NHL baselineTeams is the standings count plus slate names with no row.
    // Counting slate rows here would replace that with a second definition.
    if (sport !== 'NHL' && onBaseline(sport, name, row, snap)) counts.baselineTeams += 1;
  }
  const rows = standingsRows(snap, sport);
  if (rows.length) {
    for (const field of SCHEMA_FIELDS[sport] || []) {
      if (rows.every((row) => !schemaFieldPresent(row, field))) schemaFields.push(field);
    }
  }
  counts.schemaMissing = schemaFields.length;
  return { counts, schemaFields };
}

function formatGuardLine(record) {
  const parts = [];
  for (const sport of ['NFL', 'NHL', 'NCAAF']) {
    const row = record && record.bySport && record.bySport[sport];
    const stats = (row && row.stats) || {};
    const names = row && Array.isArray(row.unresolved) ? row.unresolved : [];
    const shown = names.slice(0, 3).join('|');
    parts.push(
      `${sport} unresolved=${names.length}${shown ? ':' + shown : ''}`
      + ` gp_unknown=${stats.gpUnknown || 0}`
      + ` rate_scale=${stats.rateScale || 0}`
      + ` nhl_points_as_goals=${stats.nhlPointsAsGoals || 0}`
      + ` baseline_teams=${stats.baselineTeams || 0}`
      + ` schema_missing=${stats.schemaMissing || 0}`
    );
  }
  return `[omega-guard] ${parts.join(' ')}`;
}

function rowMismatch(row) {
  const gp = explicitGp(row);
  const w = firstNum(row, ['wins']);
  const l = firstNum(row, ['losses']);
  const t = firstNum(row, ['ties']);
  const ot = firstNum(row, ['otLosses', 'otl']);
  if (gp != null && gp > 0 && w != null && l != null) {
    const extra = (t || 0) + (ot || 0);
    if (w + l + extra !== gp) return true;
  }
  const rec = recordParts(row);
  if (rec && w != null && rec.wins !== w) return true;
  if (rec && l != null && rec.losses !== l) return true;
  return false;
}

function isTotalMarket(c) {
  return /total/i.test(String(c && c.market || ''));
}

function isSpreadMarket(c) {
  return /spread|puck|run line/i.test(String(c && c.market || ''));
}

function sideStarts(c, team) {
  if (!team) return false;
  return String(c.side || '').toLowerCase().startsWith(String(team).toLowerCase());
}

function countBySport(list) {
  const out = {};
  for (const s of SPORTS) out[s] = 0;
  for (const c of list || []) {
    const s = c && c.sport;
    if (!s) continue;
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

function sideSplit(list) {
  let over = 0;
  let under = 0;
  let home = 0;
  let away = 0;
  for (const c of list || []) {
    const side = String(c.side || '');
    if (isTotalMarket(c)) {
      if (/^over\b/i.test(side)) over += 1;
      else if (/^under\b/i.test(side)) under += 1;
    } else if (sideStarts(c, c.homeTeam)) home += 1;
    else if (sideStarts(c, c.awayTeam)) away += 1;
  }
  return { over, under, home, away };
}

function grouped(list) {
  const map = new Map();
  for (const c of list || []) {
    if (!c || !c.sport) continue;
    const key = c.sport + '\0' + String(c.matchup || '');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

function biasFor(candidates) {
  const bySport = {};
  for (const s of SPORTS) bySport[s] = { totalSum: 0, totalN: 0, marginSum: 0, marginN: 0, totals: [] };
  for (const rows of grouped(candidates).values()) {
    const sport = rows[0].sport;
    if (!bySport[sport]) bySport[sport] = { totalSum: 0, totalN: 0, marginSum: 0, marginN: 0, totals: [] };
    const bag = bySport[sport];
    let total = null;
    for (const c of rows) {
      if (!isTotalMarket(c) || c.modelProjection == null) continue;
      const line = c.consensusLine != null ? c.consensusLine : c.line;
      if (line == null || !Number.isFinite(Number(line)) || !Number.isFinite(Number(c.modelProjection))) continue;
      total = { model: Number(c.modelProjection), line: Number(line) };
      break;
    }
    if (total) {
      bag.totalSum += total.model - total.line;
      bag.totalN += 1;
      bag.totals.push(total.model);
    }
    let margin = null;
    for (const c of rows) {
      if (!isSpreadMarket(c) || c.line == null || c.modelProjection == null) continue;
      if (!Number.isFinite(Number(c.line)) || !Number.isFinite(Number(c.modelProjection))) continue;
      if (sideStarts(c, c.homeTeam)) {
        margin = Number(c.modelProjection) + Number(c.line);
        break;
      }
    }
    if (margin == null) {
      for (const c of rows) {
        if (!isSpreadMarket(c) || c.line == null || c.modelProjection == null) continue;
        if (sideStarts(c, c.awayTeam)) {
          margin = Number(c.modelProjection) - Number(c.line);
          break;
        }
      }
    }
    if (margin != null && Number.isFinite(margin)) {
      bag.marginSum += margin;
      bag.marginN += 1;
    }
  }
  const out = {};
  for (const s of SPORTS) {
    const bag = bySport[s];
    const modal = modalShare(bag.totals, 2);
    out[s] = {
      totalMean: bag.totalN ? +(bag.totalSum / bag.totalN).toFixed(3) : null,
      totalN: bag.totalN,
      marginMean: bag.marginN ? +(bag.marginSum / bag.marginN).toFixed(3) : null,
      marginN: bag.marginN,
      constantTotal: modal.n >= 2 && modal.share > 0.5,
      constantTotalValue: modal.n >= 2 && modal.share > 0.5 ? modal.value : null,
      constantTotalShare: modal.n ? +modal.share.toFixed(3) : 0,
    };
  }
  return out;
}

function buildHealthRecord(input) {
  const src = input || {};
  const snap = src.snap || {};
  const rawBySport = src.rawBySport || countBySport(src.candidates);
  const yesBySport = countBySport(src.yesPool);
  const bySport = {};
  const alerts = [];
  const calendar = src.dateISO ? calendarHealth(src.dateISO) : null;
  const onCard = calendar ? new Set(calendar.onCard) : null;
  for (const sport of SPORTS) {
    const enabled = onCard ? onCard.has(sport) : !!SPORTS_ENABLED[sport];
    const phaseRow = calendar && calendar.bySport ? calendar.bySport[sport] : null;
    const espnN = espnGames(snap, sport).length;
    const oddsN = oddsEvents(snap, sport).length;
    const raw = rawBySport[sport] || 0;
    const yes = yesBySport[sport] || 0;
    const unresolved = collectUnresolved(sport, namesFor(snap, sport));
    const zeroCandidates = !!(enabled && (espnN > 0 || oddsN > 0) && raw === 0);
    const stats = statSanity(snap, sport);
    const guards = inputStatGuards(snap, sport);
    const nhlBaseline = stats.baselineTeams;
    const nhlOutOfBand = stats.outOfBand;
    Object.assign(stats, guards.counts);
    if (sport === 'NHL') {
      const extra = nhlSlateMissingHealth(snap);
      stats.baselineTeams = (nhlBaseline || 0) + extra.baselineTeams;
      stats.outOfBand = nhlOutOfBand + extra.outOfBand;
    }
    bySport[sport] = {
      enabled,
      phase: phaseRow ? phaseRow.phase : null,
      phaseNote: phaseRow ? phaseRow.note : null,
      phaseSource: phaseRow ? phaseRow.source : null,
      raw,
      yes,
      espnGames: espnN,
      oddsEvents: oddsN,
      zeroCandidates,
      unresolved,
      skippedUnresolved: (snap.unresolvedSkipped && snap.unresolvedSkipped[sport]) || 0,
      neutralSite: (snap.neutralSiteCounts && snap.neutralSiteCounts[sport]) || 0,
      stats,
    };
    if (zeroCandidates) alerts.push({ sport, code: 'zero_candidates', detail: `espn=${espnN} odds=${oddsN} raw=0` });
    if (unresolved.length) alerts.push({ sport, code: 'unresolved_names', detail: unresolved.slice(0, 8).join(', ') });
    if (stats.constantStat) alerts.push({ sport, code: 'constant_stat', detail: `value=${stats.constantValue} share=${stats.constantShare}` });
    if (stats.gpZeroPoints) alerts.push({ sport, code: 'gp_zero_points', detail: `teams=${stats.gpZeroPoints}` });
    if (stats.outOfBand) alerts.push({ sport, code: 'rate_out_of_band', detail: `teams=${stats.outOfBand}` });
    if (stats.recordMismatch) alerts.push({ sport, code: 'record_mismatch', detail: `teams=${stats.recordMismatch}` });
    if (stats.gpUnknown) alerts.push({ sport, code: 'gp_unknown', detail: `teams=${stats.gpUnknown}` });
    if (stats.rateScale) alerts.push({ sport, code: 'rate_scale', detail: `teams=${stats.rateScale}` });
    if (stats.nhlPointsAsGoals) alerts.push({ sport, code: 'nhl_points_as_goals', detail: `teams=${stats.nhlPointsAsGoals}` });
    if (stats.baselineTeams) alerts.push({ sport, code: 'baseline_teams', detail: `teams=${stats.baselineTeams}` });
    for (const field of guards.schemaFields) {
      alerts.push({ sport, code: `schema_missing:${field}`, detail: `field=${field}` });
    }
  }
  const bias = biasFor(src.candidates);
  for (const sport of SPORTS) {
    const row = bias[sport];
    bySport[sport].bias = {
      totalMean: row.totalMean,
      totalN: row.totalN,
      marginMean: row.marginMean,
      marginN: row.marginN,
    };
    bySport[sport].constantTotal = row.constantTotal;
    if (row.constantTotal) {
      alerts.push({ sport, code: 'constant_total', detail: `value=${row.constantTotalValue} share=${row.constantTotalShare}` });
    }
    const lim = BIAS_LIMIT[sport];
    if (lim && row.totalN && Math.abs(row.totalMean) > lim.total) {
      alerts.push({ sport, code: 'bias_total', detail: `mean=${row.totalMean} n=${row.totalN}` });
    }
    if (lim && row.marginN && Math.abs(row.marginMean) > lim.margin) {
      alerts.push({ sport, code: 'bias_margin', detail: `mean=${row.marginMean} n=${row.marginN}` });
    }
  }
  const mlbGames = (bySport.MLB.espnGames || 0) + (bySport.MLB.oddsEvents || 0);
  const pitch = snap.mlbPitcherStats || {};
  const byIdN = pitch.byId && typeof pitch.byId === 'object' ? Object.keys(pitch.byId).length : 0;
  const byTeamN = pitch.byTeam && typeof pitch.byTeam === 'object' ? Object.keys(pitch.byTeam).length : 0;
  const mlbPitchersEmpty = mlbGames > 0 && byIdN === 0 && byTeamN === 0;
  if (mlbPitchersEmpty) alerts.push({ sport: 'MLB', code: 'mlb_pitchers_empty', detail: `games=${mlbGames}` });
  const oddsErrors = Array.isArray(src.oddsErrors) ? src.oddsErrors : (Array.isArray(snap.oddsErrors) ? snap.oddsErrors : []);
  for (const err of oddsErrors) {
    alerts.push({
      sport: err.sport || null,
      code: 'odds_error',
      detail: `status=${err.status == null ? '' : err.status} ${err.message || ''}`.trim(),
    });
  }
  // calendar (phase + stale) stays on this private record. compactHealth copies
  // `alerts` onto the public card, so a stale-calendar warning is not an alert.
  return {
    date: src.dateISO || null,
    status: alerts.length ? 'warn' : 'ok',
    alerts,
    bySport,
    calendar: calendar || null,
    unresolvedSkipped: snap.unresolvedSkipped || {},
    neutralSite: snap.neutralSiteCounts || {},
    splits: {
      candidates: sideSplit(src.candidates),
      yesPool: sideSplit(src.yesPool),
    },
    mlbPitchersEmpty,
    oddsErrors: oddsErrors.map(e => ({
      sport: e.sport || null,
      status: e.status == null ? null : e.status,
      message: e.message || '',
      creditHint: e.creditHint || null,
    })),
  };
}

function compactHealth(record) {
  if (!record) return null;
  const bySport = {};
  for (const sport of SPORTS) {
    const row = record.bySport && record.bySport[sport];
    if (!row) continue;
    bySport[sport] = {
      raw: row.raw,
      yes: row.yes,
      zeroCandidates: !!row.zeroCandidates,
      unresolved: Array.isArray(row.unresolved) ? row.unresolved.length : 0,
    };
  }
  return {
    status: record.status,
    alerts: record.alerts || [],
    bySport,
    mlbPitchersEmpty: !!record.mlbPitchersEmpty,
    oddsErrors: (record.oddsErrors || []).map(e => ({ sport: e.sport, status: e.status })),
  };
}

function attachGenerateHealth(picksData, input, buildFn) {
  const build = buildFn || buildHealthRecord;
  try {
    const record = build(input);
    if (picksData && record) picksData.health = compactHealth(record);
    if (record) console.log(formatGuardLine(record));
    return record;
  } catch (e) {
    console.warn(`[omega-health] build soft-fail: ${e && e.message ? e.message : e}`);
    return null;
  }
}

module.exports = {
  SPORTS,
  BANDS,
  BIAS_LIMIT,
  buildHealthRecord,
  compactHealth,
  attachGenerateHealth,
  formatGuardLine,
  rateOf,
  rowMismatch,
};
