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
 */
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

function statusWeight(status) {
  const s = String(status || '').toLowerCase();
  if (/out|ruled out|injured reserve|\bir\b|deactivat/.test(s)) return 1;
  if (/doubtful/.test(s)) return NON_QB_ASSUMPTION.doubtfulWeight;
  if (/questionable/.test(s)) return NON_QB_ASSUMPTION.questionableWeight;
  return 0;
}

function isOutStatus(status) {
  return statusWeight(status) === 1;
}

function rowsForTeam(personnelBySport, sport, teamName) {
  if (!personnelBySport || !teamName) return [];
  const sportTable = personnelBySport[sport] && typeof personnelBySport[sport] === 'object'
    ? personnelBySport[sport]
    : personnelBySport;
  if (!sportTable || typeof sportTable !== 'object' || Array.isArray(sportTable)) return [];
  const direct = sportTable[teamName];
  const row = direct || Object.keys(sportTable).map((k) => [k, sportTable[k]]).find(([k]) => normName(k) === normName(teamName));
  const bag = direct || (row && row[1]);
  if (!bag) return [];
  if (Array.isArray(bag)) return bag;
  if (Array.isArray(bag.players)) return bag.players;
  return [];
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
  statusWeight,
  isQbPosition,
  isSpecialist,
};
