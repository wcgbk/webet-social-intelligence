'use strict';

/**
 * Per-game ESPN slate log for a later backtest. Not a pick input.
 * One JSON for every game on the ET date's scoreboard, stored at
 * `{date}/games/{HHMM}-ET` in omega-news-snapshots. The league snapshot
 * `{date}/{HHMM}-ET` is a different key and is left alone.
 *
 * Sports: NBA, NHL, NCAAM (groups=50), NFL, NCAAF (groups=80).
 * Each request is 5s. At most 6 run at once. The whole capture stops
 * starting work at the budget (60s). A failure is recorded. This never throws.
 * OMEGA_NEWS_SLATE=off is the rollback. OMEGA_NEWS_SNAPSHOT is not read here.
 */

const { newsSlateEnabled } = require('../omega-v2/constants');
const { pullJson, parseNhlScoreboard, normTeamName, normPlayerName } = require('./status_pull');
const { goaliesFromSummary } = require('./sports/nhl');
const {
  NEWS_SNAPSHOT_STORE,
  hhmmET,
  clip,
  writeNewsBlob,
  fetchedAtISO,
} = require('./news_snapshot');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const SLATE_TIMEOUT_MS = 5000;
const SLATE_BUDGET_MS = 60000;
const SLATE_CONCURRENCY = 6;

const SPORTS = [
  { sport: 'NBA', path: 'basketball/nba' },
  { sport: 'NHL', path: 'hockey/nhl' },
  { sport: 'NCAAM', path: 'basketball/mens-college-basketball', groups: '50', limit: 400 },
  { sport: 'NFL', path: 'football/nfl', depth: true },
  { sport: 'NCAAF', path: 'football/college-football', groups: '80', limit: 300, depth: true },
];

function sportCfg(sport) {
  return SPORTS.find((row) => row.sport === sport) || null;
}

function ymdCompact(dateISO) {
  return String(dateISO || '').trim().replace(/-/g, '');
}

function scoreboardUrlFor(sport, dateISO) {
  const cfg = sportCfg(sport);
  if (!cfg) return '';
  const q = [`dates=${ymdCompact(dateISO)}`];
  if (cfg.groups) {
    q.push(`groups=${cfg.groups}`);
    q.push(`limit=${cfg.limit || 300}`);
  }
  return `${ESPN}/${cfg.path}/scoreboard?${q.join('&')}`;
}

function summaryUrlFor(sport, eventId) {
  const cfg = sportCfg(sport);
  if (!cfg || eventId == null || eventId === '') return '';
  return `${ESPN}/${cfg.path}/summary?event=${encodeURIComponent(eventId)}`;
}

function leagueInjuryUrlFor(sport) {
  const cfg = sportCfg(sport);
  if (!cfg) return '';
  return `${ESPN}/${cfg.path}/injuries`;
}

function depthUrlFor(sport, teamId) {
  const cfg = sportCfg(sport);
  if (!cfg || !cfg.depth || teamId == null || teamId === '') return '';
  return `${ESPN}/${cfg.path}/teams/${encodeURIComponent(teamId)}/depthcharts`;
}

/** Blob key `{date}/games/{HHMM}-ET`, clock in America/New_York. */
function newsSlateKey(dateISO, when) {
  return `${dateISO}/games/${hhmmET(when)}-ET`;
}

function row(player, pos, status, comment) {
  const name = String(player || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return {
    player: name,
    pos: String(pos || '').trim(),
    status: String(status || '').trim(),
    comment: clip(comment),
  };
}

function athleteOf(inj) {
  if (!inj || typeof inj !== 'object') return null;
  if (inj.athlete && typeof inj.athlete === 'object') return inj.athlete;
  return inj;
}

function playerName(inj) {
  const athlete = athleteOf(inj);
  if (!athlete || typeof athlete !== 'object') return '';
  return athlete.displayName || athlete.fullName || athlete.shortName || inj.displayName || '';
}

function positionOf(inj) {
  const athlete = athleteOf(inj);
  const pos = (athlete && athlete.position) || (inj && inj.position);
  if (!pos) return '';
  if (typeof pos === 'string') return pos;
  return pos.abbreviation || pos.name || '';
}

function statusText(inj) {
  if (!inj || typeof inj !== 'object') return '';
  if (typeof inj.status === 'string') return inj.status;
  if (inj.status && typeof inj.status === 'object') {
    return inj.status.description || inj.status.name || inj.status.type || '';
  }
  if (inj.type && typeof inj.type === 'object') return inj.type.description || inj.type.abbreviation || '';
  if (typeof inj.type === 'string') return inj.type;
  return '';
}

function commentOf(inj) {
  if (!inj || typeof inj !== 'object') return '';
  const details = inj.details && typeof inj.details === 'object' ? inj.details : null;
  const type = inj.type && typeof inj.type === 'object' ? inj.type : null;
  const fantasy = details && details.fantasyStatus && typeof details.fantasyStatus === 'object'
    ? (details.fantasyStatus.description || details.fantasyStatus.displayDescription || '')
    : '';
  return inj.shortComment || inj.shortText || inj.longComment || (details && details.detail) || (details && details.type) || (type && type.description) || fantasy || '';
}

function compactInjuryList(list) {
  const out = [];
  for (const inj of list || []) {
    if (!inj || typeof inj !== 'object') continue;
    const made = row(playerName(inj), positionOf(inj), statusText(inj), commentOf(inj));
    if (made) out.push(made);
  }
  return out;
}

function teamOf(competitor) {
  const team = competitor && competitor.team;
  if (!team || typeof team !== 'object') return { name: '', id: '' };
  return {
    name: team.displayName || team.name || team.shortDisplayName || '',
    id: team.id != null && team.id !== '' ? String(team.id) : '',
  };
}

function sideFor(teamLike, game) {
  const team = teamLike && teamLike.team ? teamLike.team : teamLike;
  const id = team && team.id != null && team.id !== '' ? String(team.id) : '';
  const name = team ? (team.displayName || team.name || team.shortDisplayName || teamLike.displayName || '') : '';
  if (id && game.teams.home.id && id === game.teams.home.id) return 'home';
  if (id && game.teams.away.id && id === game.teams.away.id) return 'away';
  const key = normTeamName(name);
  if (key && key === normTeamName(game.teams.home.name)) return 'home';
  if (key && key === normTeamName(game.teams.away.name)) return 'away';
  if (teamLike && teamLike.homeAway === 'home') return 'home';
  if (teamLike && teamLike.homeAway === 'away') return 'away';
  return null;
}

function indexLeagueInjuries(data) {
  if (!data || typeof data !== 'object') return null;
  const byId = new Map();
  const byName = new Map();
  const blocks = [].concat(data.injuries || [], data.teams || []);
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const list = Array.isArray(block.injuries) ? block.injuries : (Array.isArray(block.athletes) ? block.athletes : []);
    if (!list.length && !block.displayName && !(block.team && block.team.displayName)) continue;
    const rows = compactInjuryList(list);
    const id = block.id != null && block.id !== '' ? String(block.id) : (block.team && block.team.id != null ? String(block.team.id) : '');
    const name = block.displayName || (block.team && (block.team.displayName || block.team.name)) || '';
    if (id) byId.set(id, rows);
    const key = normTeamName(name);
    if (key) byName.set(key, rows);
  }
  return { byId, byName };
}

function lookupLeague(index, team) {
  if (!index || !team) return null;
  if (team.id && index.byId.has(team.id)) return index.byId.get(team.id);
  const key = normTeamName(team.name);
  if (key && index.byName.has(key)) return index.byName.get(key);
  return null;
}

function enrichComments(rows, leagueRows) {
  if (!leagueRows || !leagueRows.length) return rows;
  const byPlayer = new Map();
  for (const item of leagueRows) {
    const key = normPlayerName(item.player);
    if (key && !byPlayer.has(key)) byPlayer.set(key, item);
  }
  return rows.map((item) => {
    if (item.comment) return item;
    const extra = byPlayer.get(normPlayerName(item.player));
    if (!extra || !extra.comment) return item;
    return { player: item.player, pos: item.pos, status: item.status, comment: extra.comment };
  });
}

function summaryInjurySides(summary, game) {
  if (!summary || !Array.isArray(summary.injuries)) return null;
  // null means this side was not in the summary, so the league list can fill it.
  // An empty array means the summary listed the team and had no rows.
  const sides = { home: null, away: null };
  for (const block of summary.injuries) {
    if (!block || typeof block !== 'object') continue;
    const side = sideFor(block.team || block, game);
    if (!side) continue;
    const list = Array.isArray(block.injuries) ? block.injuries : (Array.isArray(block.athletes) ? block.athletes : []);
    sides[side] = compactInjuryList(list);
  }
  return sides;
}

function injurySides(summarySides, leagueIndex, game) {
  if (!summarySides && !leagueIndex) return null;
  const out = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const leagueRows = lookupLeague(leagueIndex, game.teams[side]) || [];
    if (summarySides && Array.isArray(summarySides[side])) out[side] = enrichComments(summarySides[side], leagueRows);
    else out[side] = leagueRows;
  }
  return out;
}

function isStarter(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.starter === true) return true;
  const text = typeof item.status === 'string'
    ? item.status
    : (item.status && (item.status.type || item.status.name || item.status.description)) || '';
  if (item.probable === true && /starter|probable|projected|confirmed/i.test(String(text || 'probable'))) return true;
  return /starter|projected|confirmed/i.test(String(text));
}

function lineupStatus(item) {
  if (item && item.starter === true) return 'starter';
  const text = typeof item.status === 'string'
    ? item.status
    : (item.status && (item.status.type || item.status.name || item.status.description)) || '';
  if (/confirm/i.test(String(text))) return 'confirmed';
  if (/project/i.test(String(text))) return 'projected';
  if ((item && item.probable === true) || /probable/i.test(String(text))) return 'probable';
  return 'starter';
}

function pushUnique(list, made) {
  if (!made) return;
  const key = normPlayerName(made.player);
  if (list.some((item) => normPlayerName(item.player) === key)) return;
  list.push(made);
}

/**
 * Starters the summary actually marks. A full roster with no starter flag
 * is not a lineup: the field stays null.
 */
function lineupFromSummary(summary, game) {
  if (!summary || typeof summary !== 'object' || !game) return null;
  const sides = { home: [], away: [] };
  let any = false;
  const take = (side, item) => {
    if (!side || !isStarter(item)) return;
    const made = row(playerName(item), positionOf(item), lineupStatus(item), commentOf(item));
    if (!made) return;
    any = true;
    pushUnique(sides[side], made);
  };
  const rosters = Array.isArray(summary.rosters) ? summary.rosters : [];
  for (const block of rosters) {
    if (!block || typeof block !== 'object') continue;
    const side = sideFor(block, game) || (block.homeAway === 'home' || block.homeAway === 'away' ? block.homeAway : null);
    const list = Array.isArray(block.roster) ? block.roster : (Array.isArray(block.athletes) ? block.athletes : []);
    for (const item of list) take(side, item);
  }
  const groups = summary.boxscore && Array.isArray(summary.boxscore.players) ? summary.boxscore.players : [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const side = sideFor(group.team || group, game);
    const stats = Array.isArray(group.statistics) ? group.statistics : [];
    for (const stat of stats) {
      for (const item of (stat && stat.athletes) || []) take(side, item);
    }
  }
  const competitions = summary.header && Array.isArray(summary.header.competitions) ? summary.header.competitions : [];
  const comp = competitions[0] || null;
  for (const competitor of (comp && comp.competitors) || []) {
    const side = sideFor(competitor, game);
    for (const item of (competitor && competitor.probables) || []) {
      const pos = positionOf(item).toUpperCase();
      if (pos === 'G' || pos === 'GOALIE' || /goalie/i.test(String(item && item.name || ''))) continue;
      take(side, item);
    }
  }
  if (!any) return null;
  return sides;
}

function goalieRowFromRecord(goalie) {
  if (!goalie || !goalie.name) return null;
  const status = goalie.confirmed ? 'confirmed' : (goalie.status || 'unconfirmed');
  return row(goalie.name, 'G', status, '');
}

function goaliesFromBoard(parsed) {
  if (!parsed) return null;
  const home = goalieRowFromRecord(parsed.homeGoalie);
  const away = goalieRowFromRecord(parsed.awayGoalie);
  if (!home && !away) return null;
  return { home: home ? [home] : [], away: away ? [away] : [] };
}

function goaliesFromSummaryBlock(summary, game) {
  const block = summary && summary.goalies;
  if (!block || typeof block !== 'object') return null;
  const sides = { home: [], away: [] };
  const put = (side, teamBlock) => {
    const athletes = teamBlock && Array.isArray(teamBlock.athletes) ? teamBlock.athletes : [];
    const athlete = athletes.find((item) => item && (item.displayName || item.fullName));
    if (!athlete) return;
    const made = row(athlete.displayName || athlete.fullName, 'G', 'probable', '');
    if (made) sides[side].push(made);
  };
  if (block.homeTeam || block.awayTeam) {
    put('home', block.homeTeam);
    put('away', block.awayTeam);
  }
  if (!sides.home.length && !sides.away.length) return null;
  return sides;
}

function goaliesFromHeader(summary) {
  let parsed = null;
  try { parsed = goaliesFromSummary(summary); } catch (_) { parsed = null; }
  if (!parsed) return null;
  const sides = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const goalie = parsed[side];
    if (!goalie || !goalie.name) continue;
    const made = row(goalie.name, 'G', goalie.status || (goalie.confirmed ? 'confirmed' : 'probable'), '');
    if (made) sides[side].push(made);
  }
  if (!sides.home.length && !sides.away.length) return null;
  return sides;
}

function mergeSides(primary, fill) {
  if (!primary && !fill) return null;
  const base = primary || { home: [], away: [] };
  const extra = fill || { home: [], away: [] };
  const out = {
    home: base.home && base.home.length ? base.home : (extra.home || []),
    away: base.away && base.away.length ? base.away : (extra.away || []),
  };
  if (!out.home.length && !out.away.length) return null;
  return out;
}

function qbStarterFromDepth(doc) {
  const charts = doc && (Array.isArray(doc.depthchart) ? doc.depthchart : (Array.isArray(doc.depthcharts) ? doc.depthcharts : []));
  for (const chart of charts) {
    const positions = chart && chart.positions;
    if (!positions || typeof positions !== 'object') continue;
    for (const [key, pos] of Object.entries(positions)) {
      const abbr = (pos && pos.position && (pos.position.abbreviation || pos.position.name)) || key;
      if (String(abbr).toUpperCase() !== 'QB' && String(key).toUpperCase() !== 'QB') continue;
      const athletes = pos && Array.isArray(pos.athletes) ? pos.athletes : [];
      const athlete = athletes[0];
      if (!athlete) continue;
      const made = row(athlete.displayName || athlete.fullName || playerName(athlete), 'QB', 'starter', '');
      if (made) return made;
    }
  }
  return null;
}

function qbStarterFromLineup(lineupSide) {
  for (const item of lineupSide || []) {
    if (String(item.pos || '').toUpperCase() === 'QB') return item;
  }
  return null;
}

function qbSides(injuries, starters) {
  const out = { home: [], away: [] };
  let any = false;
  for (const side of ['home', 'away']) {
    const fromInj = ((injuries && injuries[side]) || []).filter((item) => String(item.pos || '').toUpperCase() === 'QB');
    const rows = fromInj.map((item) => ({ player: item.player, pos: 'QB', status: item.status, comment: item.comment }));
    const starter = starters && starters[side];
    if (starter && !rows.some((item) => normPlayerName(item.player) === normPlayerName(starter.player))) {
      rows.push(starter.pos === 'QB' ? starter : { player: starter.player, pos: 'QB', status: starter.status || 'starter', comment: starter.comment || '' });
    }
    out[side] = rows;
    if (rows.length) any = true;
  }
  return any ? out : null;
}

function sideCount(sides) {
  if (!sides) return 0;
  return ((sides.home && sides.home.length) || 0) + ((sides.away && sides.away.length) || 0);
}

function countDoc(games) {
  const bySport = {};
  for (const cfg of SPORTS) {
    bySport[cfg.sport] = { games: 0, injuryRows: 0, goalies: 0, qbs: 0, lineups: 0 };
  }
  for (const game of games || []) {
    const bucket = bySport[game.sport] || (bySport[game.sport] = { games: 0, injuryRows: 0, goalies: 0, qbs: 0, lineups: 0 });
    bucket.games += 1;
    bucket.injuryRows += sideCount(game.injuries);
    bucket.goalies += sideCount(game.goalies);
    bucket.qbs += sideCount(game.qb);
    if (game.lineup) bucket.lineups += 1;
  }
  const totals = { games: 0, injuryRows: 0, goalies: 0, qbs: 0, lineups: 0 };
  for (const bucket of Object.values(bySport)) {
    totals.games += bucket.games;
    totals.injuryRows += bucket.injuryRows;
    totals.goalies += bucket.goalies;
    totals.qbs += bucket.qbs;
    totals.lineups += bucket.lineups;
  }
  return Object.assign(totals, { bySport });
}

function parseBoard(data, sport, sourceUrl) {
  const events = data && Array.isArray(data.events) ? data.events : [];
  const games = [];
  for (const ev of events) {
    if (!ev || ev.id == null || ev.id === '') continue;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
    const home = competitors.find((c) => c && c.homeAway === 'home') || null;
    const away = competitors.find((c) => c && c.homeAway === 'away') || null;
    games.push({
      sport,
      gameId: String(ev.id),
      commence: ev.date || comp.date || comp.startDate || null,
      sourceUrl,
      teams: { home: teamOf(home), away: teamOf(away) },
    });
  }
  return games;
}

function classify(err) {
  const msg = String((err && err.message) || err || '');
  if (/timeout|abort/i.test(msg)) return 'timeout';
  return 'http';
}

async function fetchJson(url, timeoutMs, fetchImpl) {
  try {
    const body = await pullJson(url, timeoutMs, fetchImpl);
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: classify(err) };
  }
}

async function mapPool(items, limit, canStart, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  if (!items.length) return out;
  const width = Math.min(Math.max(1, limit || 1), items.length);
  async function worker() {
    while (canStart()) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (_) {
        out[i] = { ok: false, error: 'soft-fail' };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}

function logSlate(pathUsed, key, doc) {
  const counts = (doc && doc.counts) || {};
  const failures = doc && Array.isArray(doc.failures) ? doc.failures.length : 0;
  const line = `[omega-news] slate path=${pathUsed} key=${key} games=${counts.games || 0} injuries=${counts.injuryRows || 0} goalies=${counts.goalies || 0} qbs=${counts.qbs || 0} lineups=${counts.lineups || 0} failures=${failures}`;
  if (pathUsed === 'failed') console.warn(line);
  else console.log(line);
}

async function buildSlate(opts) {
  const dateISO = opts.dateISO;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : SLATE_TIMEOUT_MS;
  const budgetMs = Number.isFinite(Number(opts.budgetMs)) ? Number(opts.budgetMs) : SLATE_BUDGET_MS;
  const concurrency = Number.isFinite(Number(opts.concurrency)) ? Number(opts.concurrency) : SLATE_CONCURRENCY;
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now;
  const started = nowMs();
  // Leave the per-request timeout for the blob write so the capture stays inside the budget.
  const writeReserve = opts.noWrite ? 0 : Math.min(timeoutMs, SLATE_TIMEOUT_MS);
  const usable = budgetMs > writeReserve ? budgetMs - writeReserve : budgetMs;
  const deadline = started + Math.max(0, usable);
  const fetchedAt = fetchedAtISO(opts.now);
  const failures = [];
  const canStart = () => nowMs() < deadline;

  const listJobs = [];
  for (const cfg of SPORTS) {
    listJobs.push({ kind: 'board', sport: cfg.sport, url: scoreboardUrlFor(cfg.sport, dateISO) });
    listJobs.push({ kind: 'injuries', sport: cfg.sport, url: leagueInjuryUrlFor(cfg.sport) });
  }
  const listResults = await mapPool(listJobs, concurrency, canStart, (job) => {
    const left = deadline - nowMs();
    if (left <= 0) return Promise.resolve({ ok: false, error: 'budget' });
    return fetchJson(job.url, Math.min(timeoutMs, left), opts.fetchImpl);
  });

  const boards = {};
  const leagues = {};
  listJobs.forEach((job, i) => {
    const result = listResults[i];
    if (!result) {
      failures.push({ sport: job.sport, gameId: null, url: job.url, error: 'budget' });
      return;
    }
    if (!result.ok) {
      failures.push({ sport: job.sport, gameId: null, url: job.url, error: result.error || 'http' });
      return;
    }
    if (job.kind === 'board') boards[job.sport] = result.body;
    else leagues[job.sport] = result.body;
  });

  const games = [];
  const leagueIndex = {};
  for (const cfg of SPORTS) {
    if (leagues[cfg.sport]) leagueIndex[cfg.sport] = indexLeagueInjuries(leagues[cfg.sport]);
    if (!boards[cfg.sport]) continue;
    const url = scoreboardUrlFor(cfg.sport, dateISO);
    for (const game of parseBoard(boards[cfg.sport], cfg.sport, url)) games.push(game);
  }

  let nhlGoalies = [];
  if (boards.NHL) {
    try { nhlGoalies = parseNhlScoreboard(boards.NHL); } catch (_) { nhlGoalies = []; }
  }
  const goalieByMatch = new Map();
  for (const game of nhlGoalies) {
    goalieByMatch.set(`${game.awayKey}|${game.homeKey}`, game);
  }

  const summaryJobs = games.map((game) => ({
    game,
    url: summaryUrlFor(game.sport, game.gameId),
  }));
  const summaryResults = await mapPool(summaryJobs, concurrency, canStart, (job) => {
    const left = deadline - nowMs();
    if (left <= 0) return Promise.resolve({ ok: false, error: 'budget' });
    return fetchJson(job.url, Math.min(timeoutMs, left), opts.fetchImpl);
  });
  const summaryById = new Map();
  summaryJobs.forEach((job, i) => {
    const result = summaryResults[i];
    if (!result) {
      failures.push({ sport: job.game.sport, gameId: job.game.gameId, url: job.url, error: 'budget' });
      return;
    }
    if (!result.ok) {
      failures.push({ sport: job.game.sport, gameId: job.game.gameId, url: job.url, error: result.error || 'http' });
      return;
    }
    summaryById.set(`${job.game.sport}|${job.game.gameId}`, { url: job.url, body: result.body });
  });

  const depthNeed = new Map();
  for (const game of games) {
    const cfg = sportCfg(game.sport);
    if (!cfg || !cfg.depth) continue;
    const summary = summaryById.get(`${game.sport}|${game.gameId}`) || null;
    const lineup = summary ? lineupFromSummary(summary.body, game) : null;
    for (const side of ['home', 'away']) {
      if (qbStarterFromLineup(lineup && lineup[side])) continue;
      const id = game.teams[side].id;
      const url = depthUrlFor(game.sport, id);
      if (!url) continue;
      depthNeed.set(url, { sport: game.sport, teamId: id, url });
    }
  }
  const depthJobs = Array.from(depthNeed.values());
  const depthResults = await mapPool(depthJobs, concurrency, canStart, (job) => {
    const left = deadline - nowMs();
    if (left <= 0) return Promise.resolve({ ok: false, error: 'budget' });
    return fetchJson(job.url, Math.min(timeoutMs, left), opts.fetchImpl);
  });
  const depthByTeam = new Map();
  depthJobs.forEach((job, i) => {
    const result = depthResults[i];
    if (!result || !result.ok) return;
    const starter = qbStarterFromDepth(result.body);
    if (starter) depthByTeam.set(`${job.sport}|${job.teamId}`, starter);
  });

  const records = games.map((game) => {
    const summary = summaryById.get(`${game.sport}|${game.gameId}`) || null;
    const summarySides = summary ? summaryInjurySides(summary.body, game) : null;
    const injuries = injurySides(summarySides, leagueIndex[game.sport] || null, game);
    const lineup = summary ? lineupFromSummary(summary.body, game) : null;
    let goalies = null;
    if (game.sport === 'NHL') {
      const match = goalieByMatch.get(`${normTeamName(game.teams.away.name)}|${normTeamName(game.teams.home.name)}`) || null;
      goalies = goaliesFromBoard(match);
      if (summary) {
        goalies = mergeSides(goalies, goaliesFromSummaryBlock(summary.body, game));
        goalies = mergeSides(goalies, goaliesFromHeader(summary.body));
      }
    }
    let qb = null;
    if (game.sport === 'NFL' || game.sport === 'NCAAF') {
      const starters = { home: null, away: null };
      for (const side of ['home', 'away']) {
        const fromLineup = qbStarterFromLineup(lineup && lineup[side]);
        const fromDepth = depthByTeam.get(`${game.sport}|${game.teams[side].id}`) || null;
        starters[side] = fromLineup || fromDepth;
      }
      qb = qbSides(injuries, starters);
    }
    return {
      fetchedAt,
      sourceUrl: summary ? summary.url : game.sourceUrl,
      gameId: game.gameId,
      sport: game.sport,
      teams: game.teams,
      commence: game.commence,
      injuries,
      lineup,
      goalies,
      qb,
    };
  });

  records.sort((a, b) => String(a.sport).localeCompare(String(b.sport))
    || String(a.commence || '').localeCompare(String(b.commence || ''))
    || String(a.gameId).localeCompare(String(b.gameId)));

  return {
    fetchedAt,
    date: dateISO,
    elapsedMs: Math.max(0, nowMs() - started),
    games: records,
    failures,
    counts: countDoc(records),
  };
}

/**
 * Fetch the slate and write `{date}/games/{HHMM}-ET`.
 * Returns without throwing. Flag off and replay do not fetch or write.
 * opts.noWrite builds the document and does not touch the blob store.
 * opts.store / opts.blobFetch inject the same writers the league snapshot uses.
 */
async function captureNewsSlate(opts = {}) {
  const env = opts.env == null ? process.env : opts.env;
  if (!newsSlateEnabled(env)) return { wrote: false, skipped: 'flag-off' };
  if (opts.replay || opts.replayLike) return { wrote: false, skipped: 'replay' };
  const dateISO = opts.dateISO || opts.date;
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
    return { wrote: false, skipped: null, error: 'soft-fail' };
  }
  const when = opts.now == null ? new Date() : opts.now;
  const key = newsSlateKey(dateISO, when);
  try {
    const doc = await buildSlate(Object.assign({}, opts, { dateISO }));
    if (opts.noWrite) {
      logSlate('no-write', key, doc);
      return { wrote: false, skipped: 'no-write', key, doc };
    }
    try {
      const pathUsed = await writeNewsBlob(key, doc, opts.timeoutMs || SLATE_TIMEOUT_MS, opts);
      logSlate(pathUsed, key, doc);
      return { wrote: true, key, skipped: null, path: pathUsed, doc };
    } catch (err) {
      logSlate('failed', key, doc);
      return { wrote: false, key, skipped: null, error: 'soft-fail', path: 'failed', doc };
    }
  } catch (err) {
    console.warn('[omega-news] slate soft-fail');
    return { wrote: false, skipped: null, error: 'soft-fail', key };
  }
}

module.exports = {
  SLATE_TIMEOUT_MS,
  SLATE_BUDGET_MS,
  SLATE_CONCURRENCY,
  SPORTS,
  scoreboardUrlFor,
  summaryUrlFor,
  leagueInjuryUrlFor,
  depthUrlFor,
  newsSlateKey,
  compactInjuryList,
  lineupFromSummary,
  captureNewsSlate,
};
