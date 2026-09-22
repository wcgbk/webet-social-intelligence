'use strict';

/**
 * MLB starter quality + park factor.
 * Quality is runs per 9 better than league (positive = better pitcher).
 * Missing SP/park leaves the Pythag margin and total unchanged.
 */

const { clamp } = require('../odds_math');
const { fuzzyTeam } = require('./_common');

const LEAGUE_FIP = 4.15;
const FIP_C = 3.10;
const LG_HR_FB = 0.115;
const MIN_IP = { player: 12, team: 200 };
/** Team ERA/FIP is already inside Pythag. Use only a fraction when the named SP has no line. */
const TEAM_PRIOR_WEIGHT = 0.45;
const SP_MARGIN_PER_RUN = 0.55;
const SP_TOTAL_PER_RUN = 0.45;
const PARK_MIN = 0.75;
const PARK_MAX = 1.40;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Baseball IP strings: "142.1" = 142 + 1 out. */
function parseIp(ip) {
  if (ip == null || ip === '') return null;
  const s = String(ip).trim();
  const m = s.match(/^(\d+)\.(\d)$/);
  if (m) {
    const outs = Number(m[2]);
    if (outs <= 2) return Number(m[1]) + outs / 3;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseEra(era) {
  if (era == null) return null;
  const s = String(era).trim();
  if (!s || s.includes('-')) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fipFromCounting(stat) {
  if (!stat) return null;
  const hr = num(stat.homeRuns);
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  const ip = parseIp(stat.inningsPitched);
  if ([hr, bb, k, ip].some(v => v == null) || ip <= 0) return null;
  const hbpN = hbp == null ? 0 : hbp;
  return (13 * hr + 3 * (bb + hbpN) - 2 * k) / ip + FIP_C;
}

function xfipFromCounting(stat) {
  if (!stat) return null;
  const hr = num(stat.homeRuns);
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  const air = num(stat.airOuts);
  const ip = parseIp(stat.inningsPitched);
  if ([hr, bb, k, air, ip].some(v => v == null) || ip <= 0) return null;
  const hbpN = hbp == null ? 0 : hbp;
  const fb = air + hr;
  if (fb <= 0) return null;
  const expectedHr = fb * LG_HR_FB;
  return (13 * expectedHr + 3 * (bb + hbpN) - 2 * k) / ip + FIP_C;
}

/** xFIP, else FIP, lightly blended with ERA when both exist. */
function pitcherRate(stat) {
  if (!stat) return null;
  const xfip = xfipFromCounting(stat);
  const fip = fipFromCounting(stat);
  const era = parseEra(stat.era);
  const primary = xfip != null ? xfip : fip;
  if (primary != null && era != null) return 0.8 * primary + 0.2 * era;
  if (primary != null) return primary;
  return era;
}

function emptyPitcherIndex() {
  return { byId: {}, byName: {}, byTeam: {} };
}

function recordFromSplit(split, source) {
  const stat = split && split.stat;
  if (!stat) return null;
  const ip = parseIp(stat.inningsPitched);
  const minIp = MIN_IP[source] != null ? MIN_IP[source] : MIN_IP.player;
  if (ip == null || ip < minIp) return null;
  const rate = pitcherRate(stat);
  if (!Number.isFinite(rate)) return null;
  const player = split.player || {};
  const name = player.fullName || split.name || (split.team && split.team.name) || null;
  const id = player.id != null ? String(player.id) : null;
  return {
    id,
    name,
    nameKey: normName(name),
    ip,
    era: parseEra(stat.era),
    fip: fipFromCounting(stat),
    xfip: xfipFromCounting(stat),
    quality: clamp(LEAGUE_FIP - rate, -2.5, 2.5),
    source,
  };
}

function preferRicher(prev, next) {
  if (!prev) return next;
  return (next.ip || 0) >= (prev.ip || 0) ? next : prev;
}

function buildPitcherIndex(playerPayload, teamPayload) {
  const idx = emptyPitcherIndex();
  const playerSplits = (((playerPayload || {}).stats || [])[0] || {}).splits || [];
  for (const split of playerSplits) {
    const rec = recordFromSplit(split, 'player');
    if (!rec) continue;
    if (rec.id) idx.byId[rec.id] = preferRicher(idx.byId[rec.id], rec);
    if (rec.nameKey) idx.byName[rec.nameKey] = preferRicher(idx.byName[rec.nameKey], rec);
  }
  const teamSplits = (((teamPayload || {}).stats || [])[0] || {}).splits || [];
  for (const split of teamSplits) {
    const teamName = split.team && split.team.name;
    if (!teamName) continue;
    const rec = recordFromSplit(split, 'team');
    if (!rec) continue;
    idx.byTeam[teamName] = rec;
  }
  return idx;
}

function coerceQualityRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (Number.isFinite(Number(row.quality))) {
    return {
      id: row.id != null ? String(row.id) : null,
      name: row.name || null,
      quality: clamp(Number(row.quality), -2.5, 2.5),
      source: row.source || 'player',
    };
  }
  return null;
}

/**
 * Individual FIP/xFIP/ERA when the probable matches.
 * If the starter is named but has no line, a discounted team rate is the prior.
 * No named probable → null (do not double-count team pitching already in Pythag).
 */
function resolveSpQuality(probable, stats, teamName) {
  const bag = stats && typeof stats === 'object' ? stats : {};
  const byId = bag.byId || {};
  const byName = bag.byName || {};
  if (probable && probable.id != null && byId[String(probable.id)]) {
    const row = coerceQualityRow(byId[String(probable.id)]);
    if (row) return { ...row, source: row.source === 'team' ? 'team' : 'player' };
  }
  const nameKey = normName(probable && probable.name);
  if (nameKey && byName[nameKey]) {
    const row = coerceQualityRow(byName[nameKey]);
    if (row) return { ...row, source: 'player', name: row.name || probable.name };
  }
  if (!probable || !probable.name) return null;
  const teamRow = coerceQualityRow(fuzzyTeam(teamName, bag.byTeam || {}));
  if (!teamRow) return null;
  return {
    ...teamRow,
    quality: clamp(teamRow.quality * TEAM_PRIOR_WEIGHT, -2.5, 2.5),
    source: 'team',
    name: probable.name,
  };
}

function factorOf(row) {
  if (row == null) return null;
  if (typeof row === 'number') return Number.isFinite(row) ? row : null;
  if (typeof row === 'string') {
    const n = Number(row);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof row !== 'object') return null;
  const raw = row.park != null ? row.park : row.factor;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function splitParkTable(parkFactors) {
  const nameTable = {};
  const abbrTable = {};
  const src = parkFactors && typeof parkFactors === 'object' ? parkFactors : {};
  for (const [k, v] of Object.entries(src)) {
    if (!k || k.startsWith('_')) continue;
    const factor = factorOf(v);
    if (!Number.isFinite(factor) || factor < PARK_MIN || factor > PARK_MAX) continue;
    const row = {
      factor,
      venue: v && typeof v === 'object' ? (v.venue || null) : null,
      abbr: v && typeof v === 'object' && v.abbr ? String(v.abbr).toUpperCase() : null,
      team: v && typeof v === 'object' && v.team ? v.team : k,
    };
    const upper = k.toUpperCase();
    if (k.length <= 4 && k === upper) abbrTable[upper] = row;
    else nameTable[k] = row;
    if (row.abbr) abbrTable[row.abbr] = row;
    if (v && typeof v === 'object' && v.team) nameTable[v.team] = row;
  }
  return { nameTable, abbrTable };
}

function resolvePark(homeTeam, parkFactors, espnGame) {
  const { nameTable, abbrTable } = splitParkTable(parkFactors);
  let row = fuzzyTeam(homeTeam, nameTable);
  if (!row && espnGame && espnGame.homeAbbr) {
    row = abbrTable[String(espnGame.homeAbbr).toUpperCase()] || null;
  }
  if (!row && homeTeam && String(homeTeam).length <= 4) {
    row = abbrTable[String(homeTeam).toUpperCase()] || null;
  }
  return row || null;
}

/**
 * Better SP (positive quality) adds margin for that side and lowers the total.
 * Park factor multiplies the run environment (Coors > 1).
 */
function applySpPark({ modelMargin, modelTotal, homeQ, awayQ, parkFactor }) {
  let margin = Number(modelMargin);
  let total = Number(modelTotal);
  if (!Number.isFinite(margin)) margin = 0;
  if (!Number.isFinite(total)) total = 8.6;
  const hq = homeQ && Number.isFinite(homeQ.quality) ? homeQ.quality : null;
  const aq = awayQ && Number.isFinite(awayQ.quality) ? awayQ.quality : null;
  const usedSp = hq != null || aq != null;
  if (usedSp) {
    const h = hq == null ? 0 : hq;
    const a = aq == null ? 0 : aq;
    margin += (h - a) * SP_MARGIN_PER_RUN;
    total += -(h + a) * SP_TOTAL_PER_RUN;
  }
  const usedPark = Number.isFinite(parkFactor);
  if (usedPark) total *= parkFactor;
  total = clamp(total, 5.5, 14.5);
  return { modelMargin: margin, modelTotal: total, usedSp, usedPark };
}

/** MLB season year. Jan/Feb still belong to the previous season. */
function mlbSeasonFromDate(dateISO) {
  const raw = String(dateISO || '');
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7));
  const year = Number.isFinite(y) && y > 1990 ? y : new Date().getUTCFullYear();
  if (Number.isFinite(m) && m >= 1 && m < 3) return year - 1;
  return year;
}

module.exports = {
  LEAGUE_FIP,
  FIP_C,
  TEAM_PRIOR_WEIGHT,
  SP_MARGIN_PER_RUN,
  SP_TOTAL_PER_RUN,
  parseIp,
  fipFromCounting,
  xfipFromCounting,
  pitcherRate,
  normName,
  emptyPitcherIndex,
  buildPitcherIndex,
  resolveSpQuality,
  resolvePark,
  applySpPark,
  mlbSeasonFromDate,
};
