'use strict';

/**
 * Non-QB injury / deactivation adjustment.
 *
 * QB out/doubtful is already priced in qbSoftAdjust. This path must not
 * add a second QB penalty. Kickers and punters are logged and not priced.
 * A position we cannot map is logged and does not move the margin.
 *
 * ASSUMPTION coefficients (not fit on CLV). One Out skill or offensive-line
 * player is 0.20 points toward the opponent. Doubtful weighs 0.75.
 * Questionable weighs 0.35. Each side is capped at 0.60 points before the
 * two sides are netted. The point cap is not raised for a long injury list.
 *
 * Cluster risk counts only Out/Doubtful starters, weighted by position
 * (QB highest, then offensive line, edge, corner). Depth outs do not
 * count. The weight is a probability haircut on the affected side and
 * the game total, plus a small total-points haircut for offensive
 * starters. It never excludes a side, a total, or the game. A long
 * injury list does not raise the point cap. A normal list of depth
 * players Out never removes a game.
 *
 * Long-term IR, PUP, and season-ending designations are already in the
 * market. They do not move the margin and they do not count toward the
 * cluster. Only a new game-status Out, Doubtful, Questionable, inactive,
 * or deactivation is priced.
 */
const { resolveTeamId } = require('./sports/team_identity');

const NON_QB_ASSUMPTION = Object.freeze({
  outPoints: 0.20,
  doubtfulWeight: 0.75,
  questionableWeight: 0.35,
  cap: 0.60,
  // Retired as a blanket gate. Depth-out counts stay on homeOuts/awayOuts.
  clusterOuts: 5,
});

/**
 * Starter cluster weights. Not fit on CLV. QB is the highest, then the
 * offensive line, then edge, then corner. QB points still come only from
 * qbSoftAdjust. A starter QB adds cluster weight and does not add a second
 * point penalty here.
 */
const STARTER_POS_WEIGHT = Object.freeze({
  qb: 3.0,
  quarterback: 3.0,
  ot: 1.6,
  t: 1.6,
  og: 1.6,
  g: 1.6,
  c: 1.6,
  ol: 1.6,
  de: 1.35,
  edge: 1.35,
  cb: 1.25,
  wr: 0.9,
  te: 0.8,
  s: 0.7,
  fs: 0.7,
  ss: 0.7,
  db: 0.7,
  nb: 0.7,
  lb: 0.65,
  ilb: 0.65,
  mlb: 0.65,
  olb: 0.65,
  dt: 0.6,
  dl: 0.6,
  nt: 0.6,
  rb: 0.5,
  fb: 0.5,
});

const STARTER_CLUSTER = Object.freeze({
  // Kept so a heavy starter list is visible. It does not exclude.
  highThreshold: 4.5,
  haircutPerWeight: 0.012,
  haircutCap: 0.05,
  uncertaintyPerWeight: 0.015,
  uncertaintyCap: 0.06,
  doubtfulWeight: 0.75,
  // Offensive starter weight → points off the total. Cap is not a gate.
  totalPointsPerWeight: 0.12,
  totalPointsCap: 1.5,
});

const TOTAL_HAIRCUT_POS = new Set([
  'ot', 't', 'og', 'g', 'c', 'ol', 'wr', 'te', 'rb', 'fb',
]);

const PRICED_POS = new Set([
  'rb', 'fb', 'wr', 'te', 'ot', 'og', 'c', 'ol', 'g', 't',
  'de', 'dt', 'dl', 'lb', 'cb', 's', 'fs', 'ss', 'edge', 'nt',
  'ilb', 'olb', 'mlb', 'nb', 'db',
]);

function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function posKey(pos) {
  return String(pos || '').trim().toLowerCase();
}

function isQbPosition(pos) {
  const p = posKey(pos);
  return p === 'qb' || p === 'quarterback';
}

function isSpecialist(pos) {
  const p = posKey(pos);
  return p === 'p' || p === 'k' || p === 'pk' || p === 'ls'
    || p === 'punter' || p === 'kicker' || p === 'long snapper';
}

/** IR / PUP / season-ending. Already priced. Not a game-status out. */
function isLongTermRosterStatus(status) {
  const s = String(status || '').toLowerCase();
  return /injured reserve|\bir\b|\bpup\b|physically unable|season-ending|season ending/.test(s);
}

function statusWeight(status) {
  const s = String(status || '').toLowerCase();
  if (isLongTermRosterStatus(s)) return 0;
  if (/inactive|deactivat|ruled out|\bout\b/.test(s)) return 1;
  if (/doubtful/.test(s)) return NON_QB_ASSUMPTION.doubtfulWeight;
  if (/questionable/.test(s)) return NON_QB_ASSUMPTION.questionableWeight;
  return 0;
}

function isOutStatus(status) {
  return statusWeight(status) === 1;
}

/**
 * Confirmed starter only. A missing flag is depth, not a starter.
 * Depth-chart order 1 and an explicit starter bit both count.
 */
function isConfirmedStarter(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.starter === false || row.starter === 'false' || row.isStarter === false) return false;
  if (row.starter === true || row.starter === 'true' || row.isStarter === true) return true;
  const depthRaw = row.depth != null ? row.depth
    : (row.depthOrder != null ? row.depthOrder : row.depthChartOrder);
  if (depthRaw != null && depthRaw !== '') {
    const n = Number(depthRaw);
    if (Number.isFinite(n)) return n === 1;
  }
  const role = `${row.role || ''} ${row.designation || ''}`.toLowerCase();
  if (/\b(backup|reserve|practice squad|non-?starter)\b/.test(role)) return false;
  if (/\b(starter|starting|first[- ]team)\b/.test(role)) return true;
  return false;
}

/** Out/inactive/deactivated = 1. Doubtful = 0.75. Questionable is not a cluster. */
function clusterStatusFactor(status) {
  const s = String(status || '').toLowerCase();
  if (!s || isLongTermRosterStatus(s)) return 0;
  if (/questionable/.test(s)) return 0;
  if (/doubtful/.test(s)) return STARTER_CLUSTER.doubtfulWeight;
  if (/inactive|deactivat|ruled out|\bout\b/.test(s)) return 1;
  return 0;
}

function positionClusterWeight(pos) {
  const w = STARTER_POS_WEIGHT[posKey(pos)];
  return Number.isFinite(w) ? w : 0;
}

function starterCluster(rows, side) {
  let weight = 0;
  const parts = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    if (!isConfirmedStarter(r)) continue;
    const status = r.status || r.kind || '';
    const factor = clusterStatusFactor(status);
    if (!factor) continue;
    const pw = positionClusterWeight(r.position);
    const add = pw * factor;
    if (add > 0) weight += add;
    parts.push({
      side,
      name: r.name || null,
      position: r.position || '',
      status,
      action: add > 0 ? 'starter-cluster' : 'starter-unweighted',
      points: 0,
      clusterWeight: +add.toFixed(3),
    });
  }
  return { weight: +weight.toFixed(4), parts };
}

/**
 * A row with gameTeamIds applies only when both ids are this game.
 * A row without that list is team-wide. A scoped row with no game context
 * does not apply.
 */
function rowAppliesToGame(row, game, sport) {
  const ids = row && row.gameTeamIds;
  if (!Array.isArray(ids) || !ids.length) return true;
  if (!game || !game.home || !game.away) return false;
  const homeId = resolveTeamId(sport, game.home);
  const awayId = resolveTeamId(sport, game.away);
  if (!homeId || !awayId) return false;
  const sides = new Set([String(homeId), String(awayId)]);
  return ids.every((id) => sides.has(String(id)));
}

function rowsForTeam(personnelBySport, sport, teamName, game) {
  if (!personnelBySport || !teamName) return [];
  const sportTable = personnelBySport[sport] && typeof personnelBySport[sport] === 'object'
    ? personnelBySport[sport]
    : personnelBySport;
  if (!sportTable || typeof sportTable !== 'object' || Array.isArray(sportTable)) return [];
  const direct = sportTable[teamName];
  const row = direct || Object.keys(sportTable).map((k) => [k, sportTable[k]]).find(([k]) => normName(k) === normName(teamName));
  const bag = direct || (row && row[1]);
  let rows = [];
  if (Array.isArray(bag)) rows = bag;
  else if (bag && Array.isArray(bag.players)) rows = bag.players;
  return rows.filter((player) => rowAppliesToGame(player, game, sport));
}

function sidePoints(rows, side) {
  const logs = [];
  let pts = 0;
  let outs = 0;
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    const status = r.status || r.kind || '';
    const position = r.position || '';
    const name = r.name || null;
    if (isQbPosition(position)) continue;
    if (isLongTermRosterStatus(status)) {
      logs.push({ side, name, position, status, action: 'logged-priced-in', points: 0 });
      continue;
    }
    const weight = statusWeight(status);
    if (!weight) {
      logs.push({ side, name, position, status, action: 'logged-unquantified', points: 0 });
      continue;
    }
    if (isSpecialist(position)) {
      logs.push({ side, name, position, status, action: 'logged-unquantified-specialist', points: 0 });
      continue;
    }
    if (!PRICED_POS.has(posKey(position))) {
      logs.push({ side, name, position, status, action: 'logged-unquantified', points: 0 });
      continue;
    }
    const add = NON_QB_ASSUMPTION.outPoints * weight;
    pts += add;
    if (isOutStatus(status)) outs += 1;
    logs.push({
      side, name, position, status, action: 'assumption-adj', points: +add.toFixed(3),
    });
  }
  if (pts > NON_QB_ASSUMPTION.cap) pts = NON_QB_ASSUMPTION.cap;
  return { pts, outs, logs };
}

/** Offensive starters only. Points off the total. Never an exclusion. */
function starterTotalPoints(rows) {
  let weight = 0;
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    if (!isConfirmedStarter(r)) continue;
    if (!TOTAL_HAIRCUT_POS.has(posKey(r.position))) continue;
    const factor = clusterStatusFactor(r.status || r.kind || '');
    if (!factor) continue;
    weight += positionClusterWeight(r.position) * factor;
  }
  let pts = weight * STARTER_CLUSTER.totalPointsPerWeight;
  if (pts > STARTER_CLUSTER.totalPointsCap) pts = STARTER_CLUSTER.totalPointsCap;
  return +pts.toFixed(4);
}

/**
 * Home outs reduce the home margin. Away outs increase it.
 * exclude, side flags, and the total flag stay false. A starter cluster
 * is a probability haircut and a total-points haircut. Depth outs never
 * remove a side, a total, or the game.
 */
function conservativeNonQbAdj(homeRows, awayRows) {
  const home = sidePoints(homeRows, 'home');
  const away = sidePoints(awayRows, 'away');
  const marginAdj = away.pts - home.pts;
  const homeCluster = starterCluster(homeRows, 'home');
  const awayCluster = starterCluster(awayRows, 'away');
  const combined = homeCluster.weight + awayCluster.weight;
  let probHaircut = STARTER_CLUSTER.haircutPerWeight * combined;
  if (probHaircut > STARTER_CLUSTER.haircutCap) probHaircut = STARTER_CLUSTER.haircutCap;
  let uncertaintyBump = STARTER_CLUSTER.uncertaintyPerWeight * combined;
  if (uncertaintyBump > STARTER_CLUSTER.uncertaintyCap) uncertaintyBump = STARTER_CLUSTER.uncertaintyCap;
  const totalPts = starterTotalPoints(homeRows) + starterTotalPoints(awayRows);
  const totalAdj = totalPts > 0 ? -Math.min(STARTER_CLUSTER.totalPointsCap, totalPts) : 0;
  return {
    marginAdj: +marginAdj.toFixed(4),
    exclude: false,
    homeOuts: home.outs,
    awayOuts: away.outs,
    homeCluster: homeCluster.weight,
    awayCluster: awayCluster.weight,
    homeSideExclude: false,
    awaySideExclude: false,
    totalExclude: false,
    totalAdj: +totalAdj.toFixed(4),
    probHaircut: +probHaircut.toFixed(4),
    uncertaintyBump: +uncertaintyBump.toFixed(4),
    logs: home.logs.concat(away.logs, homeCluster.parts, awayCluster.parts),
  };
}

/**
 * Pull modelRawP toward 0.5 by the starter/position probability haircut.
 * The haircut applies to side and total candidates alike. It does not
 * set an exclusion flag.
 */
function stampPersonnel(raw, gd) {
  if (!raw || !gd) return raw;
  raw.personnelHomeExclude = false;
  raw.personnelAwayExclude = false;
  raw.personnelTotalExclude = false;
  const h = Number(gd.personnelProbHaircut);
  if (h > 0 && Number.isFinite(Number(raw.modelRawP))) {
    const p = Number(raw.modelRawP);
    raw.modelRawP = p >= 0.5 ? Math.max(0.5, p - h) : Math.min(0.5, p + h);
    raw.personnelProbHaircut = h;
  } else if (h > 0) {
    raw.personnelProbHaircut = h;
  }
  return raw;
}

module.exports = {
  NON_QB_ASSUMPTION,
  STARTER_POS_WEIGHT,
  STARTER_CLUSTER,
  conservativeNonQbAdj,
  rowsForTeam,
  rowAppliesToGame,
  statusWeight,
  isLongTermRosterStatus,
  isQbPosition,
  isSpecialist,
  isConfirmedStarter,
  clusterStatusFactor,
  positionClusterWeight,
  starterTotalPoints,
  stampPersonnel,
};
