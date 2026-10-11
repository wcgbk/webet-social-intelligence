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
 * two sides are netted. Five or more non-QB outs on one side is a cluster:
 * the game is excluded instead of inventing a larger number.
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
  clusterOuts: 5,
});

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

/**
 * Home outs reduce the home margin. Away outs increase it.
 * exclude is true when either side has clusterOuts or more full outs.
 */
function conservativeNonQbAdj(homeRows, awayRows) {
  const home = sidePoints(homeRows, 'home');
  const away = sidePoints(awayRows, 'away');
  const marginAdj = away.pts - home.pts;
  const exclude = home.outs >= NON_QB_ASSUMPTION.clusterOuts
    || away.outs >= NON_QB_ASSUMPTION.clusterOuts;
  return {
    marginAdj: +marginAdj.toFixed(4),
    exclude,
    homeOuts: home.outs,
    awayOuts: away.outs,
    logs: home.logs.concat(away.logs),
  };
}

module.exports = {
  NON_QB_ASSUMPTION,
  conservativeNonQbAdj,
  rowsForTeam,
  rowAppliesToGame,
  statusWeight,
  isLongTermRosterStatus,
  isQbPosition,
  isSpecialist,
};
