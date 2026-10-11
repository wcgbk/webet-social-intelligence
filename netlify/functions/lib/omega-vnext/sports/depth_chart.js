'use strict';

/**
 * Daily ESPN depth-chart starters for NFL and NCAAF quarterbacks.
 *
 * Verified 2026-10-11 against the public site endpoint (names inline):
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}/depthcharts
 * Ravens (id 33) return depthchart[].positions.qb.athletes in rank order.
 * QB1 is athletes[0] (Lamar Jackson, 3916387). There is no rank field.
 *
 * The core API lists rank but athletes are $ref links without names:
 *   https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/teams/{id}/depthcharts
 * That shape cannot fill {name, athleteId} without more calls, so it is not used.
 *
 * College football, same day: the site league path returns HTTP 200 with
 * team metadata and no depthchart. The core path returns HTTP 400
 * "Depth charts not supported for football|college-football". One such
 * body falls the whole NCAAF slate back. No throw.
 *
 * Fetches go through memoFetchJson so a run memoizes each URL. Frozen
 * replay (OMEGA_FROZEN_SNAP) never calls the network. A snap with no
 * depth chart uses the empty fallback.
 */

const { memoFetchJson, memoValue } = require('../fetch_memo');
const { resolveTeamId } = require('./team_identity');

const SOURCE = 'espn-site-depthcharts';
const SITE_DEPTH = 'https://site.api.espn.com/apis/site/v2/sports/football';
const TIMEOUT_MS = 8000;
const CONCURRENCY = 4;

function leagueSlug(sport) {
  const s = String(sport || '').toUpperCase();
  if (s === 'NFL') return 'nfl';
  if (s === 'NCAAF' || s === 'CFB') return 'college-football';
  return null;
}

function depthChartUrl(sport, teamId) {
  const league = leagueSlug(sport);
  if (!league) return null;
  const id = String(teamId || '').trim();
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  return `${SITE_DEPTH}/${league}/teams/${encodeURIComponent(id)}/depthcharts`;
}

function normalizeTeamIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    if (raw == null || raw === '') continue;
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Team ids on the already day-scoped slate. ESPN competitor id, else the name. */
function slateTeamIds(sport, games) {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    if (id == null || id === '') return;
    const s = String(id).trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    ids.push(s);
  };
  for (const game of games || []) {
    if (!game || typeof game !== 'object') continue;
    const home = game.homeId || game.homeTeamId || resolveTeamId(sport, game.homeTeam || game.home_team);
    const away = game.awayId || game.awayTeamId || resolveTeamId(sport, game.awayTeam || game.away_team);
    push(home);
    push(away);
  }
  return ids;
}

function emptyPack(sport, teamIds, reason) {
  return {
    ok: false,
    map: {},
    source: 'fallback',
    reason: reason || 'fallback',
    teams: [],
    fallbackTeams: normalizeTeamIds(teamIds),
    fetchedAt: new Date().toISOString(),
    sport: sport || null,
  };
}

function isQbNode(key, node) {
  if (!node || typeof node !== 'object') return false;
  if (String(key).toLowerCase() === 'qb') return true;
  const pos = node.position;
  if (!pos || typeof pos !== 'object') return false;
  const abbr = String(pos.abbreviation || '').toLowerCase();
  const name = String(pos.name || pos.displayName || '').toLowerCase();
  return abbr === 'qb' || name === 'qb' || name === 'quarterback';
}

function readAthlete(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const rank = raw.rank != null && Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : index + 1;
  const nested = raw.athlete && typeof raw.athlete === 'object' ? raw.athlete : null;
  const player = (raw.displayName || raw.fullName) ? raw : (nested || raw);
  if (player.$ref && !player.displayName && !player.fullName) return null;
  const id = player.id != null && player.id !== '' ? String(player.id)
    : (player.athleteId != null && player.athleteId !== '' ? String(player.athleteId) : null);
  const name = player.displayName || player.fullName || null;
  if (!id || typeof name !== 'string' || !name.trim()) return null;
  return { rank, order: index, name: name.trim(), athleteId: id };
}

/**
 * One team body. Never throws. ok false carries a schema reason.
 * Rank is the athlete order when the payload has no rank field.
 */
function parseDepthChart(body, teamId) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'schema-not-object' };
    }
    if (body.error) {
      const msg = (body.error && (body.error.message || body.error.code)) || 'endpoint-error';
      return { ok: false, reason: String(msg) };
    }
    if (body.status != null && String(body.status).toLowerCase() !== 'success') {
      return { ok: false, reason: `status-${body.status}` };
    }
    const charts = Array.isArray(body.depthchart) ? body.depthchart
      : (Array.isArray(body.depthcharts) ? body.depthcharts : null);
    if (!charts) return { ok: false, reason: 'missing-depthchart' };
    let found = null;
    for (const chart of charts) {
      if (!chart || typeof chart !== 'object') continue;
      const positions = chart.positions;
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)) continue;
      const group = [];
      let sawQb = false;
      for (const [key, node] of Object.entries(positions)) {
        if (!isQbNode(key, node)) continue;
        sawQb = true;
        const athletes = node && node.athletes;
        if (!Array.isArray(athletes)) return { ok: false, reason: 'qb-athletes-not-array' };
        athletes.forEach((raw, i) => {
          const parsed = readAthlete(raw, i);
          if (parsed) group.push(parsed);
        });
      }
      if (sawQb) {
        found = group;
        break;
      }
    }
    if (!found || !found.length) return { ok: false, reason: 'no-qb' };
    found.sort((a, b) => a.rank - b.rank || a.order - b.order);
    const qb1 = found.find((a) => a.rank === 1) || found[0];
    const qb2 = found.find((a) => a.rank === 2) || null;
    if (!qb1 || !qb1.name || !qb1.athleteId) return { ok: false, reason: 'qb1-incomplete' };
    const team = body.team && typeof body.team === 'object' ? body.team : {};
    const id = team.id != null && team.id !== '' ? String(team.id) : (teamId != null && teamId !== '' ? String(teamId) : null);
    if (!id) return { ok: false, reason: 'missing-team-id' };
    if (teamId != null && teamId !== '' && team.id != null && String(team.id) !== String(teamId)) {
      return { ok: false, reason: 'team-id-mismatch' };
    }
    const fetchedAt = typeof body.timestamp === 'string' && body.timestamp
      ? body.timestamp
      : new Date().toISOString();
    return {
      ok: true,
      row: {
        teamId: id,
        abbr: team.abbreviation ? String(team.abbreviation) : null,
        displayName: team.displayName || team.name || null,
        qb1: { name: qb1.name, athleteId: qb1.athleteId },
        qb2: qb2 ? { name: qb2.name, athleteId: qb2.athleteId } : null,
        source: SOURCE,
        fetchedAt,
      },
    };
  } catch (e) {
    return { ok: false, reason: 'schema-throw' };
  }
}

function leagueUnsupported(reason) {
  const text = String(reason || '');
  if (text === 'missing-depthchart') return true;
  return /depth charts not supported/i.test(text);
}

function finish(sport, results, fetchedAt) {
  const map = {};
  const teams = [];
  const fallbackTeams = [];
  const reasons = [];
  for (const row of results || []) {
    if (!row) continue;
    if (row.ok && row.row && row.row.teamId) {
      map[String(row.row.teamId)] = row.row;
      teams.push(String(row.row.teamId));
    } else {
      if (row.teamId != null && row.teamId !== '') fallbackTeams.push(String(row.teamId));
      if (row.reason) reasons.push(row.reason);
    }
  }
  const ok = teams.length > 0;
  return {
    ok,
    map,
    source: ok ? SOURCE : 'fallback',
    reason: ok ? (fallbackTeams.length ? 'partial' : null) : (reasons[0] || 'fallback'),
    teams,
    fallbackTeams,
    fetchedAt: fetchedAt || new Date().toISOString(),
    sport,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  if (!items.length) return out;
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit || 1, items.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

async function fetchOne(sport, teamId, fetchImpl) {
  const id = String(teamId);
  const url = depthChartUrl(sport, id);
  if (!url) return { teamId: id, ok: false, reason: 'bad-team-id' };
  try {
    console.log(`[omega-vnext/depth] GET ${url}`);
    const data = await memoFetchJson(url, TIMEOUT_MS, fetchImpl || fetch);
    const parsed = parseDepthChart(data, id);
    if (!parsed.ok) return { teamId: id, ok: false, reason: parsed.reason };
    return { teamId: id, ok: true, row: parsed.row };
  } catch (e) {
    const msg = e && e.message ? e.message : 'fetch-failed';
    console.log(`[omega-vnext/depth] ${sport} ${id} soft-fail: ${msg}`);
    return { teamId: id, ok: false, reason: msg };
  }
}

async function fetchLive(sport, teamIds, fetchImpl) {
  const fetchedAt = new Date().toISOString();
  if (leagueSlug(sport) === 'college-football' && teamIds.length) {
    const probe = await fetchOne(sport, teamIds[0], fetchImpl);
    if (!probe.ok && leagueUnsupported(probe.reason)) {
      console.log(`[omega-vnext/depth] ${sport} depth chart unsupported (${probe.reason}); fallback ${teamIds.length} teams`);
      return {
        ok: false,
        map: {},
        source: 'fallback',
        reason: probe.reason,
        teams: [],
        fallbackTeams: teamIds.slice(),
        fetchedAt,
        sport,
      };
    }
    const rest = await mapLimit(teamIds.slice(1), CONCURRENCY, (id) => fetchOne(sport, id, fetchImpl));
    const pack = finish(sport, [probe, ...rest], fetchedAt);
    console.log(`[omega-vnext/depth] ${sport} teams=${pack.teams.length} fallback=${pack.fallbackTeams.length} source=${pack.source}`);
    return pack;
  }
  const results = await mapLimit(teamIds, CONCURRENCY, (id) => fetchOne(sport, id, fetchImpl));
  const pack = finish(sport, results, fetchedAt);
  console.log(`[omega-vnext/depth] ${sport} teams=${pack.teams.length} fallback=${pack.fallbackTeams.length} source=${pack.source}`);
  return pack;
}

function readFrozenSnap() {
  const file = process.env.OMEGA_FROZEN_SNAP;
  if (!file) return undefined;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    return require(resolved);
  } catch (e) {
    return null;
  }
}

/** Stored pack for this sport, or null when the frozen snap has no chart. */
function frozenDepthPack(sport) {
  const snap = readFrozenSnap();
  if (snap === undefined) return undefined;
  const charts = snap && snap.gameDay && snap.gameDay.depthCharts;
  const pack = charts && (charts[sport] || charts[String(sport || '').toUpperCase()]);
  const map = pack && pack.map && typeof pack.map === 'object' ? pack.map : null;
  if (!map || !Object.keys(map).length) return null;
  return {
    ok: true,
    map,
    source: pack.source || SOURCE,
    reason: null,
    teams: Array.isArray(pack.teams) && pack.teams.length ? pack.teams.slice() : Object.keys(map),
    fallbackTeams: Array.isArray(pack.fallbackTeams) ? pack.fallbackTeams.slice() : [],
    fetchedAt: pack.fetchedAt || (snap && snap.fetchedAt) || null,
    sport,
    frozen: true,
  };
}

/**
 * Depth charts for the given slate team ids.
 * Never throws. A schema or HTTP failure is an empty map plus a reason.
 * @param {{sport?: string, teamIds?: string[], fetchImpl?: typeof fetch, date?: string}} [opts]
 */
async function fetchDepthCharts(opts) {
  const sport = opts && opts.sport;
  const date = opts && (opts.date || opts.dateISO) || '';
  const fetchImpl = opts && opts.fetchImpl;
  const teamIds = normalizeTeamIds(opts && opts.teamIds);
  try {
    if (process.env.OMEGA_FROZEN_SNAP) {
      const stored = frozenDepthPack(sport);
      if (stored) return stored;
      return emptyPack(sport, teamIds, 'frozen-snap-no-depth');
    }
    if (!leagueSlug(sport)) return emptyPack(sport, teamIds, 'unsupported-sport');
    if (!teamIds.length) return emptyPack(sport, [], 'no-slate-teams');
    const key = `depth-chart:${sport}:${date}:${teamIds.join(',')}`;
    return await memoValue(key, () => fetchLive(sport, teamIds, fetchImpl));
  } catch (e) {
    return emptyPack(sport, teamIds, (e && e.message) || 'depth-chart-failed');
  }
}

function starterFeedStamp(packs) {
  const teams = [];
  const fallbackTeams = [];
  const reasons = [];
  let live = false;
  for (const sport of ['NFL', 'NCAAF']) {
    const pack = packs && packs[sport];
    if (!pack) continue;
    for (const id of pack.teams || []) teams.push(`${sport}:${id}`);
    for (const id of pack.fallbackTeams || []) fallbackTeams.push(`${sport}:${id}`);
    if ((pack.teams || []).length && pack.source && pack.source !== 'fallback') live = true;
    if (pack.reason) reasons.push(`${sport}:${pack.reason}`);
  }
  const stamp = {
    source: live ? SOURCE : 'fallback',
    teams,
    fallbackTeams,
  };
  if (reasons.length) stamp.reason = reasons.join(',');
  return stamp;
}

/** The three selection fields. Missing feed is an explicit fallback. */
function cardStarterFeed(snap) {
  const feed = snap && snap.gameDay && snap.gameDay.starterFeed;
  return {
    source: feed && feed.source ? String(feed.source) : 'fallback',
    teams: feed && Array.isArray(feed.teams) ? feed.teams.slice() : [],
    fallbackTeams: feed && Array.isArray(feed.fallbackTeams) ? feed.fallbackTeams.slice() : [],
  };
}

/** True when a frozen gameDay already carries a chart. */
function snapHasDepth(gameDay) {
  if (!gameDay || typeof gameDay !== 'object') return false;
  const feed = gameDay.starterFeed;
  if (feed && feed.source && feed.source !== 'fallback' && Array.isArray(feed.teams) && feed.teams.length) {
    return true;
  }
  const charts = gameDay.depthCharts;
  if (!charts || typeof charts !== 'object') return false;
  for (const pack of Object.values(charts)) {
    if (!pack || typeof pack !== 'object') continue;
    if (pack.map && typeof pack.map === 'object' && Object.keys(pack.map).length) return true;
    if (Array.isArray(pack.teams) && pack.teams.length) return true;
  }
  return false;
}

/**
 * Frozen replay only. No network. A snap without charts gets the fallback stamp.
 * Returns the same object when it already has depth data.
 */
function freezeDepthFallback(gameDay, original) {
  if (snapHasDepth(gameDay)) return gameDay || {};
  const copy = gameDay && original && gameDay !== original ? gameDay : Object.assign({}, gameDay || {});
  copy.depthCharts = copy.depthCharts && typeof copy.depthCharts === 'object' ? copy.depthCharts : {};
  copy.starterFeed = {
    source: 'fallback',
    teams: [],
    fallbackTeams: [],
    reason: 'frozen-snap-no-depth',
  };
  return copy;
}

module.exports = {
  SOURCE,
  SITE_DEPTH,
  depthChartUrl,
  slateTeamIds,
  parseDepthChart,
  fetchDepthCharts,
  starterFeedStamp,
  cardStarterFeed,
  snapHasDepth,
  freezeDepthFallback,
};
