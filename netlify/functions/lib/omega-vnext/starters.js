'use strict';

/**
 * ESPN starting pitcher and starting goalie for the 10:30 price.
 * A confirmed starter wins. A projected or probable starter is used with
 * the confirmed flag false. A missing goalie falls back to the club's
 * most-played goalie, also unconfirmed. No name and no rate stays null,
 * and the existing residual stays 0.
 */

function personName(node) {
  if (!node || typeof node !== 'object') return null;
  const athlete = node.athlete && typeof node.athlete === 'object' ? node.athlete : null;
  const raw = (athlete && (athlete.displayName || athlete.fullName || athlete.name))
    || node.displayName || node.fullName || node.name || null;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || /^tbd$/i.test(name)) return null;
  return name;
}

function personId(node) {
  if (!node || typeof node !== 'object') return null;
  const athlete = node.athlete && typeof node.athlete === 'object' ? node.athlete : null;
  const id = athlete && athlete.id != null && athlete.id !== ''
    ? athlete.id
    : (node.playerId != null && node.playerId !== '' ? node.playerId : node.id);
  if (id == null || id === '') return null;
  return String(id);
}

function positionAbbr(node) {
  if (!node || typeof node !== 'object') return '';
  const athlete = node.athlete && typeof node.athlete === 'object' ? node.athlete : null;
  const pos = node.position || node.pos || (athlete && athlete.position) || null;
  if (!pos) return '';
  if (typeof pos === 'string') return pos.toUpperCase();
  return String(pos.abbreviation || pos.name || '').toUpperCase();
}

function statusText(node) {
  if (!node || typeof node !== 'object') return '';
  const status = node.status;
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object') {
    return `${status.type || ''} ${status.name || ''} ${status.description || ''} ${status.state || ''}`;
  }
  return '';
}

function isConfirmed(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.confirmed === true || node.starter === true || node.starter === 'true') return true;
  return /confirm/i.test(statusText(node));
}

function isPitcherPos(abbr) {
  return abbr === 'SP' || abbr === 'P' || abbr === 'RHP' || abbr === 'LHP' || abbr === 'PITCHER';
}

function isGoaliePos(abbr) {
  return abbr === 'G' || abbr === 'GOALIE' || abbr === 'GOALTENDER';
}

function normKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
  const left = normKey(a.name);
  const right = normKey(b.name);
  return !!(left && left === right);
}

function statName(stat) {
  return String((stat && (stat.name || stat.abbreviation || stat.displayName)) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function statNumber(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const raw = stat.value != null ? stat.value : stat.displayValue;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/%/g, '').replace(/^\./, '0.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeSave(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1.5 && n <= 100) return n / 100;
  if (n > 100 && n <= 1000) return n / 1000;
  return n;
}

const SAVE_NAMES = new Set(['savepct', 'savepercentage', 'svpct', 'sv']);
const GAME_NAMES = new Set(['gamesplayed', 'games', 'gp', 'gamesstarted', 'gs']);
const GSAX_NAMES = new Set(['gsax', 'goalsavedaboveexpected', 'gsaa']);

function readStatBag(node) {
  const stats = [];
  if (node && Array.isArray(node.statistics)) stats.push(...node.statistics);
  if (node && Array.isArray(node.stats) && node.stats.every((s) => s && typeof s === 'object' && !Array.isArray(s))) {
    stats.push(...node.stats);
  }
  const named = node && (node.names || node.keys || node.labels);
  if (node && Array.isArray(node.stats) && Array.isArray(named)) {
    for (let i = 0; i < named.length && i < node.stats.length; i++) {
      stats.push({ name: named[i], value: node.stats[i] });
    }
  }
  let savePct = null;
  let games = null;
  let gsax = null;
  if (node && node.savePct != null) savePct = normalizeSave(node.savePct);
  if (node && node.savePercentage != null && savePct == null) savePct = normalizeSave(node.savePercentage);
  if (node && node.svPct != null && savePct == null) savePct = normalizeSave(node.svPct);
  if (node && node.games != null && Number.isFinite(Number(node.games))) games = Number(node.games);
  if (node && node.gamesPlayed != null && Number.isFinite(Number(node.gamesPlayed))) games = Number(node.gamesPlayed);
  if (node && node.gsax != null && Number.isFinite(Number(node.gsax))) gsax = Number(node.gsax);
  if (node && node.GSAx != null && Number.isFinite(Number(node.GSAx))) gsax = Number(node.GSAx);
  const seen = new Set();
  for (const stat of stats) {
    if (!stat || seen.has(stat)) continue;
    seen.add(stat);
    const name = statName(stat);
    const value = statNumber(stat);
    if (value == null) continue;
    if (savePct == null && SAVE_NAMES.has(name)) savePct = normalizeSave(value);
    if (games == null && GAME_NAMES.has(name)) games = value;
    if (gsax == null && GSAX_NAMES.has(name)) gsax = value;
  }
  return { savePct, games, gsax };
}

function parallelAthleteStats(group, athlete) {
  const names = group && (group.keys || group.names || group.labels);
  const values = athlete && athlete.stats;
  if (!Array.isArray(names) || !Array.isArray(values)) return {};
  const bag = { statistics: [] };
  for (let i = 0; i < names.length && i < values.length; i++) {
    bag.statistics.push({ name: names[i], value: values[i] });
  }
  return readStatBag(bag);
}

function pitcherFrom(node, confirmed) {
  const name = personName(node);
  if (!name) return null;
  return {
    name,
    id: personId(node),
    confirmed: !!confirmed,
    spConfirmed: !!confirmed,
  };
}

/**
 * Confirmed lineup pitcher, else the projected probable.
 * spConfirmed is false when only the probable is posted.
 */
function choosePitcher(competitor) {
  if (!competitor || typeof competitor !== 'object') return null;
  const lists = []
    .concat(Array.isArray(competitor.roster) ? competitor.roster : [])
    .concat(Array.isArray(competitor.lineup) ? competitor.lineup : [])
    .concat(Array.isArray(competitor.athletes) ? competitor.athletes : []);
  let confirmed = null;
  for (const row of lists) {
    if (!row || typeof row !== 'object') continue;
    const pos = positionAbbr(row);
    if (pos && !isPitcherPos(pos)) continue;
    if (!isConfirmed(row) && !isPitcherPos(pos)) continue;
    if (!isConfirmed(row)) continue;
    const pitcher = pitcherFrom(row, true);
    if (pitcher) confirmed = pitcher;
  }
  const probables = competitor.probables || competitor.probablePitchers || [];
  let projected = null;
  if (Array.isArray(probables)) {
    for (const row of probables) {
      const pitcher = pitcherFrom(row, isConfirmed(row));
      if (!pitcher) continue;
      if (pitcher.spConfirmed) return pitcher;
      if (!projected) projected = pitcher;
    }
  }
  if (confirmed) return confirmed;
  return projected;
}

function goalieRow(node, source) {
  const name = personName(node);
  if (!name) return null;
  const pos = positionAbbr(node);
  const kind = node && node._omegaKind;
  if (kind === 'pitcher') return null;
  if (pos && !isGoaliePos(pos) && source !== 'probable' && source !== 'goalies' && kind !== 'goalie') return null;
  const stats = readStatBag(node);
  const confirmed = isConfirmed(node);
  return {
    name,
    id: personId(node),
    savePct: stats.savePct,
    games: stats.games,
    gsax: stats.gsax,
    confirmed,
    projected: source === 'probable',
    fromStarter: confirmed,
  };
}

function pushRows(into, list, source) {
  for (const row of list || []) {
    const parsed = goalieRow(row, source);
    if (parsed) into.push(parsed);
  }
}

function goalieRows(competitor) {
  const rows = [];
  if (!competitor || typeof competitor !== 'object') return rows;
  pushRows(rows, competitor.probables, 'probable');
  pushRows(rows, competitor.probableGoalies, 'probable');
  pushRows(rows, competitor.goalies, 'goalies');
  pushRows(rows, competitor.roster, 'roster');
  pushRows(rows, competitor.athletes, 'roster');
  pushRows(rows, competitor.lineup, 'roster');
  return rows;
}

function copyStat(onto, from) {
  if (!from) return onto;
  const out = { ...onto };
  if (out.savePct == null && from.savePct != null) out.savePct = from.savePct;
  if (out.gsax == null && from.gsax != null) out.gsax = from.gsax;
  if (out.games == null && from.games != null) out.games = from.games;
  return out;
}

function finishGoalie(row, goalieConfirmed) {
  if (!row || !row.name) return null;
  const out = {
    name: row.name,
    id: row.id != null ? row.id : null,
    confirmed: !!goalieConfirmed,
    goalieConfirmed: !!goalieConfirmed,
  };
  if (row.savePct != null) out.savePct = row.savePct;
  if (row.svPct != null && out.savePct == null) out.savePct = row.svPct;
  if (row.gsax != null && Number.isFinite(Number(row.gsax))) out.gsax = Number(row.gsax);
  if (row.games != null && Number.isFinite(Number(row.games))) out.games = Number(row.games);
  return out;
}

/**
 * Confirmed ESPN goalie, else the projected probable, else the goalie
 * with the most games. The fallback and the probable are goalieConfirmed
 * false. savePct (and gsax, when that stat is on the same player) stay
 * on this object so both terms read one starter.
 */
function chooseGoalie(competitor) {
  const rows = goalieRows(competitor);
  if (!rows.length) return null;
  const confirmed = rows.find((row) => row.fromStarter);
  const projected = rows.find((row) => row.projected);
  let chosen = confirmed || projected || null;
  let goalieConfirmed = !!confirmed;
  if (!chosen) {
    const ranked = rows
      .filter((row) => row.games != null && Number.isFinite(row.games))
      .sort((a, b) => b.games - a.games);
    chosen = ranked[0] || null;
    goalieConfirmed = false;
  }
  if (!chosen) return null;
  let merged = { ...chosen };
  for (const row of rows) {
    if (!samePlayer(row, merged)) continue;
    merged = copyStat(merged, row);
  }
  return finishGoalie(merged, goalieConfirmed);
}

function scoreboardEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.competitions) return payload;
  const header = payload.header;
  const comp = header && header.competitions && header.competitions[0];
  if (!comp) return null;
  return {
    ...header,
    id: header.id || payload.id,
    competitions: header.competitions,
    season: header.season || payload.season,
  };
}

function sideOf(competitor, index) {
  const ha = competitor && (competitor.homeAway || competitor.homeaway);
  if (ha === 'home' || ha === 'away') return ha;
  if (competitor && competitor.home === true) return 'home';
  if (index === 0) return 'home';
  if (index === 1) return 'away';
  return null;
}

function competitorsOf(payload) {
  const event = scoreboardEvent(payload) || {};
  const comp = (event.competitions && event.competitions[0]) || {};
  return comp.competitors || [];
}

function teamName(competitor) {
  const team = competitor && competitor.team;
  if (!team) return '';
  return team.displayName || team.name || '';
}

function matchSide(game, competitor, index) {
  const ha = sideOf(competitor, index);
  if (ha === 'home' || ha === 'away') return ha;
  const name = normKey(teamName(competitor));
  if (name && game && normKey(game.homeTeam) === name) return 'home';
  if (name && game && normKey(game.awayTeam) === name) return 'away';
  return null;
}

function boxscoreSides(summary) {
  const players = summary && summary.boxscore && summary.boxscore.players;
  if (!Array.isArray(players)) return [];
  return players.map((group) => {
    const athletes = [];
    for (const stat of (group && group.statistics) || []) {
      const type = String((stat && (stat.type || stat.name)) || '').toLowerCase();
      const pitching = /pitch/.test(type);
      const goalie = /goal|goaltend/.test(type);
      if (!pitching && !goalie) continue;
      for (const athlete of (stat && stat.athletes) || []) {
        const parallel = parallelAthleteStats(stat, athlete);
        athletes.push({
          ...athlete,
          savePct: athlete && athlete.savePct != null ? athlete.savePct : parallel.savePct,
          games: athlete && athlete.games != null ? athlete.games : parallel.games,
          gsax: athlete && athlete.gsax != null ? athlete.gsax : parallel.gsax,
          statistics: []
            .concat((athlete && athlete.statistics) || [])
            .concat(parallel.savePct != null ? [{ name: 'savePct', value: parallel.savePct }] : [])
            .concat(parallel.games != null ? [{ name: 'games', value: parallel.games }] : [])
            .concat(parallel.gsax != null ? [{ name: 'gsax', value: parallel.gsax }] : []),
          _omegaKind: pitching ? 'pitcher' : 'goalie',
        });
      }
    }
    return {
      homeAway: group && (group.homeAway || (group.team && group.team.homeAway)),
      team: group && group.team,
      athletes,
      roster: athletes,
    };
  });
}

function rosterSides(summary) {
  const rosters = summary && (summary.rosters || (summary.header && summary.header.rosters));
  return Array.isArray(rosters) ? rosters : [];
}

/**
 * Fill a mapped game from a playoff summary. Header probables, a confirmed
 * lineup, and boxscore starters all count. An already confirmed side stays.
 */
function applySummaryStarters(sport, game, summary) {
  if (!game || !summary || typeof summary !== 'object') return game;
  const label = String(sport || '').toUpperCase();
  const sides = { home: [], away: [] };
  const add = (competitor, index) => {
    const side = matchSide(game, competitor, index);
    if (side) sides[side].push(competitor);
  };
  competitorsOf(summary).forEach(add);
  boxscoreSides(summary).forEach(add);
  rosterSides(summary).forEach(add);
  if (label === 'NHL') {
    game.homeGoalie = mergeGoalie(game.homeGoalie, firstGoalie(sides.home));
    game.awayGoalie = mergeGoalie(game.awayGoalie, firstGoalie(sides.away));
  } else {
    game.homeProbable = mergePitcher(game.homeProbable, firstPitcher(sides.home));
    game.awayProbable = mergePitcher(game.awayProbable, firstPitcher(sides.away));
  }
  return game;
}

function firstPitcher(competitors) {
  let projected = null;
  for (const competitor of competitors || []) {
    const pitcher = choosePitcher(competitor);
    if (!pitcher) continue;
    if (pitcher.spConfirmed) return pitcher;
    if (!projected) projected = pitcher;
  }
  return projected;
}

function firstGoalie(competitors) {
  let projected = null;
  for (const competitor of competitors || []) {
    const goalie = chooseGoalie(competitor);
    if (!goalie) continue;
    if (goalie.goalieConfirmed) return goalie;
    if (!projected) projected = goalie;
  }
  return projected;
}

function mergePitcher(current, incoming) {
  if (!incoming || !incoming.name) return current || null;
  if (!current || !current.name) return incoming;
  if (incoming.spConfirmed && !current.spConfirmed) return incoming;
  return current;
}

function mergeGoalie(current, incoming) {
  if (!incoming || !incoming.name) return current || null;
  if (!current || !current.name) return incoming;
  if (incoming.goalieConfirmed && !current.goalieConfirmed) {
    return copyStat(incoming, samePlayer(current, incoming) ? current : null);
  }
  if (samePlayer(current, incoming)) return copyStat(current, incoming);
  return current;
}

function needsStarterSummary(sport, game) {
  const label = String(sport || '').toUpperCase();
  if (!game || game.id == null || game.id === '') return false;
  if (label === 'MLB') {
    if (game.preseason || game.seasonType !== 3) return false;
    const homeOk = game.homeProbable && game.homeProbable.spConfirmed === true;
    const awayOk = game.awayProbable && game.awayProbable.spConfirmed === true;
    return !(homeOk && awayOk);
  }
  if (label === 'NHL') {
    const ready = (g) => !!(g && g.savePct != null);
    return !(ready(game.homeGoalie) && ready(game.awayGoalie));
  }
  return false;
}

module.exports = {
  choosePitcher,
  chooseGoalie,
  applySummaryStarters,
  needsStarterSummary,
  scoreboardEvent,
  normalizeSave,
};
