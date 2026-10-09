'use strict';

/**
 * NFL / NCAAF days-since-previous-game from ESPN weekly scoreboards.
 * seasontype=2 (regular season) only. The date-range form dates=A-B
 * errors on ESPN now, so each call is one week: dates=YYYY&week=N.
 * At most the card week and the previous two weeks (≤3 calls per sport).
 *
 * OMEGA_REST_SCHEDULE_DIR, when set, reads <dir>/nfl-w<N>.json and
 * <dir>/ncaaf-w<N>.json and does not touch the network. No dir and a
 * failed fetch → fetchFailed, empty games, margin adj 0.
 * Team match is the ESPN team id only (team_identity). Names are not used.
 */

const fs = require('fs');
const path = require('path');
const { memoFetchJson, memoValue } = require('../fetch_memo');

const MAX_CALLS = 3;
const NFL_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const NCAAF_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

function scheduleDir(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'dir')) {
    const d = opts.dir;
    if (d == null || String(d).trim() === '') return null;
    return String(d).trim();
  }
  const env = process.env.OMEGA_REST_SCHEDULE_DIR;
  if (env == null || String(env).trim() === '') return null;
  return String(env).trim();
}

function blankSchedule(sport, extra) {
  return Object.assign({
    sport,
    loaded: false,
    fetchFailed: false,
    seasonYear: null,
    week: null,
    weeks: [],
    games: [],
    calls: 0,
    source: null,
    error: null,
  }, extra || {});
}

function failedSchedule(sport, message, extra) {
  return blankSchedule(sport, Object.assign({
    loaded: false,
    fetchFailed: true,
    games: [],
    error: message ? String(message) : 'weekly scoreboard unavailable',
  }, extra || {}));
}

/**
 * Week URL. week omitted only for the one calendar-discovery fallback.
 * Query order matches the live ESPN form: seasontype, week, dates, then
 * NCAAF FBS groups=80 and limit=300. Never dates=A-B.
 */
function weeklyScoreboardUrl(sport, seasonYear, week) {
  const year = encodeURIComponent(String(seasonYear));
  const base = sport === 'NCAAF' ? NCAAF_URL : NFL_URL;
  const parts = ['seasontype=2'];
  if (week != null && week !== '') parts.push(`week=${encodeURIComponent(String(week))}`);
  parts.push(`dates=${year}`);
  if (sport === 'NCAAF') {
    parts.push('groups=80');
    parts.push('limit=300');
  }
  return `${base}?${parts.join('&')}`;
}

function weekFilePath(dir, sport, week) {
  const n = Number(week);
  if (!Number.isInteger(n) || n < 0 || n > 30) return null;
  const prefix = sport === 'NCAAF' ? 'ncaaf' : 'nfl';
  return path.join(dir, `${prefix}-w${n}.json`);
}

function minWeek(sport) {
  return sport === 'NCAAF' ? 0 : 1;
}

function weeksToFetch(sport, week) {
  const min = minWeek(sport);
  const out = [];
  for (const w of [week, week - 1, week - 2]) {
    if (Number.isInteger(w) && w >= min) out.push(w);
  }
  return out;
}

function seasonYearFromDate(dateISO, board) {
  const fromBoard = board && (board.seasonYear != null ? board.seasonYear : (board.season && board.season.year));
  const yb = Number(fromBoard);
  if (Number.isInteger(yb) && yb > 1990) return yb;
  const [yy, mm] = String(dateISO || '').split('-').map(Number);
  if (!Number.isInteger(yy)) return null;
  if (Number.isInteger(mm) && mm <= 2) return yy - 1;
  return yy;
}

/** Noon America/New_York on dateISO, as epoch ms. */
function etNoonMs(dateISO) {
  const [y, m, d] = String(dateISO || '').split('-').map(Number);
  if (![y, m, d].every(Number.isInteger)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let t = Date.UTC(y, m - 1, d, 16, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const py = Number(parts.year);
    const pm = Number(parts.month);
    const pd = Number(parts.day);
    const ph = Number(parts.hour);
    const pmin = Number(parts.minute);
    if (py === y && pm === m && pd === d && ph === 12 && pmin === 0) return t;
    const cur = Date.UTC(py, pm - 1, pd, ph, pmin);
    const want = Date.UTC(y, m - 1, d, 12, 0);
    t += (want - cur);
  }
  return t;
}

function regularSeasonEntries(calendar) {
  const blocks = Array.isArray(calendar) ? calendar : [];
  const block = blocks.find((b) => String(b && b.value) === '2' || /regular/i.test(String((b && b.label) || '')));
  return (block && block.entries) || [];
}

function calendarOf(board) {
  if (!board || typeof board !== 'object') return null;
  if (Array.isArray(board.calendar)) return board.calendar;
  const leagues = board.leagues;
  if (leagues && leagues[0] && Array.isArray(leagues[0].calendar)) return leagues[0].calendar;
  return null;
}

function weekNumberForDate(calendar, dateISO) {
  const noon = etNoonMs(dateISO);
  if (noon == null) return null;
  for (const entry of regularSeasonEntries(calendar)) {
    const start = Date.parse(entry && entry.startDate);
    const end = Date.parse(entry && entry.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (noon >= start && noon < end) {
      const n = Number(entry.value);
      return Number.isInteger(n) ? n : null;
    }
  }
  return null;
}

function seasonTypeOf(ev) {
  const season = (ev && ev.season) || {};
  const typeObj = season.type && typeof season.type === 'object' ? season.type : null;
  const raw = typeObj ? (typeObj.type != null ? typeObj.type : typeObj.id) : season.type;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isSkippedStatus(ev, comp) {
  const st = (comp && comp.status && comp.status.type)
    || (ev && ev.status && ev.status.type)
    || {};
  const name = `${st.name || ''} ${st.description || ''} ${st.shortDetail || ''}`;
  return /cancel|postponed|suspended|forfeit/i.test(name);
}

/**
 * One row per team. Id is the ESPN competitor id. No display-name key.
 * opponentId is the other competitor so the current game (same pair) can
 * be excluded from rest.
 */
function gamesFromBoard(board, weekNum) {
  const out = [];
  for (const ev of (board && board.events) || []) {
    const st = seasonTypeOf(ev);
    if (st != null && st !== 2) continue;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    if (isSkippedStatus(ev, comp)) continue;
    const commence = ev.date || comp.date || comp.startDate || null;
    if (!commence || !Number.isFinite(Date.parse(commence))) continue;
    const competitors = comp.competitors || [];
    const ids = [];
    for (const c of competitors) {
      const id = c && c.team && c.team.id;
      if (id == null || id === '') continue;
      ids.push(String(id));
    }
    for (const c of competitors) {
      const id = c && c.team && c.team.id;
      if (id == null || id === '') continue;
      const teamId = String(id);
      const opponentId = ids.find((other) => other !== teamId) || null;
      out.push({
        teamId,
        opponentId,
        commence,
        week: weekNum,
      });
    }
  }
  return out;
}

async function readWeekFile(dir, sport, week) {
  const file = weekFilePath(dir, sport, week);
  if (!file) return null;
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    const err = new Error(`rest schedule ${sport} week ${week}: ${e.message}`);
    err.code = 'REST_FILE';
    throw err;
  }
}

async function calendarFromDir(dir, sport) {
  const order = [];
  for (let w = 1; w <= 20; w += 1) order.push(w);
  if (sport === 'NCAAF') order.push(0);
  for (const w of order) {
    const board = await readWeekFile(dir, sport, w);
    const calendar = calendarOf(board);
    if (calendar && calendar.length) {
      return { calendar, board, week: w, seasonYear: seasonYearFromDate(null, board) };
    }
  }
  return null;
}

async function loadFromDir(sport, dateISO, dir) {
  const found = await calendarFromDir(dir, sport);
  if (!found) {
    return failedSchedule(sport, 'rest schedule dir has no calendar', { source: 'dir', calls: 0 });
  }
  const week = weekNumberForDate(found.calendar, dateISO);
  if (week == null) {
    return failedSchedule(sport, `no regular-season week for ${dateISO}`, {
      source: 'dir',
      calls: 0,
      seasonYear: found.seasonYear,
    });
  }
  const weeks = weeksToFetch(sport, week);
  const games = [];
  const seen = new Set();
  for (const w of weeks) {
    const board = (w === found.week) ? found.board : await readWeekFile(dir, sport, w);
    if (!board) continue;
    for (const g of gamesFromBoard(board, w)) {
      const key = `${g.teamId}|${g.commence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      games.push(g);
    }
  }
  const seasonYear = found.seasonYear || seasonYearFromDate(dateISO, null);
  return blankSchedule(sport, {
    loaded: true,
    fetchFailed: false,
    seasonYear,
    week,
    weeks,
    games,
    calls: 0,
    source: 'dir',
    error: null,
  });
}

async function fetchBoard(url, fetchImpl, state) {
  if (state.calls >= MAX_CALLS) {
    const err = new Error('rest scoreboard call budget');
    err.code = 'REST_BUDGET';
    throw err;
  }
  state.calls += 1;
  return memoFetchJson(url, 10000, fetchImpl || fetch);
}

async function loadFromNetwork(sport, dateISO, dailyBoard, fetchImpl) {
  const state = { calls: 0 };
  let seasonYear = seasonYearFromDate(dateISO, dailyBoard);
  let calendar = calendarOf(dailyBoard);
  const byWeek = new Map();
  try {
    if (!calendar) {
      if (seasonYear == null) {
        return failedSchedule(sport, 'no season year for rest scoreboard', { source: 'network', calls: 0 });
      }
      const discovered = await fetchBoard(weeklyScoreboardUrl(sport, seasonYear, null), fetchImpl, state);
      calendar = calendarOf(discovered);
      const y = discovered && discovered.season && Number(discovered.season.year);
      if (Number.isInteger(y) && y > 1990) seasonYear = y;
      const discoveredWeek = discovered && discovered.week && Number(discovered.week.number);
      if (Number.isInteger(discoveredWeek)) byWeek.set(discoveredWeek, discovered);
    }
    const week = weekNumberForDate(calendar, dateISO);
    if (week == null) {
      return failedSchedule(sport, `no regular-season week for ${dateISO}`, {
        source: 'network',
        calls: state.calls,
        seasonYear,
      });
    }
    const weeks = weeksToFetch(sport, week);
    for (const w of weeks) {
      if (byWeek.has(w)) continue;
      if (state.calls >= MAX_CALLS) break;
      const board = await fetchBoard(weeklyScoreboardUrl(sport, seasonYear, w), fetchImpl, state);
      byWeek.set(w, board);
    }
    const games = [];
    const seen = new Set();
    for (const w of weeks) {
      const board = byWeek.get(w);
      if (!board) continue;
      for (const g of gamesFromBoard(board, w)) {
        const key = `${g.teamId}|${g.commence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        games.push(g);
      }
    }
    const missing = weeks.filter((w) => !byWeek.has(w));
    if (missing.length) {
      return failedSchedule(sport, `weekly scoreboard missing week ${missing.join(',')}`, {
        source: 'network',
        calls: state.calls,
        seasonYear,
        week,
        weeks,
      });
    }
    return blankSchedule(sport, {
      loaded: true,
      fetchFailed: false,
      seasonYear,
      week,
      weeks,
      games,
      calls: state.calls,
      source: 'network',
      error: null,
    });
  } catch (e) {
    return failedSchedule(sport, e && e.message ? e.message : 'weekly scoreboard unavailable', {
      source: 'network',
      calls: state.calls,
      seasonYear,
    });
  }
}

async function loadFootballRestScheduleUncached(sport, dateISO, opts) {
  const dir = scheduleDir(opts);
  if (dir) {
    try {
      return await loadFromDir(sport, dateISO, dir);
    } catch (e) {
      return failedSchedule(sport, e && e.message ? e.message : 'rest schedule dir unreadable', {
        source: 'dir',
        calls: 0,
      });
    }
  }
  const boards = (opts && opts.boards) || {};
  const daily = boards[sport] || (opts && opts.dailyBoard) || null;
  return loadFromNetwork(sport, dateISO, daily, opts && opts.fetchImpl);
}

async function loadFootballRestSchedule(sport, dateISO, opts) {
  const dir = scheduleDir(opts);
  const key = `omega-rest:${sport}:${dateISO}:${dir || 'net'}`;
  return memoValue(key, () => loadFootballRestScheduleUncached(sport, dateISO, opts));
}

async function loadFootballRestSchedules(dateISO, opts) {
  const labels = (opts && opts.labels) || ['NFL', 'NCAAF'];
  const out = {};
  for (const sport of labels) {
    if (sport !== 'NFL' && sport !== 'NCAAF') continue;
    try {
      out[sport] = await loadFootballRestSchedule(sport, dateISO, opts);
    } catch (e) {
      out[sport] = failedSchedule(sport, e && e.message ? e.message : 'weekly scoreboard unavailable');
    }
    const row = out[sport];
    console.log(
      `[omega-vnext/ingest] rest-days ${sport} source=${row.source || 'none'} week=${row.week == null ? '' : row.week} weeks=${(row.weeks || []).join(',')} games=${(row.games || []).length} calls=${row.calls || 0} failed=${row.fetchFailed ? 1 : 0}`
    );
  }
  return out;
}

module.exports = {
  MAX_CALLS,
  scheduleDir,
  weeklyScoreboardUrl,
  weekFilePath,
  weeksToFetch,
  weekNumberForDate,
  calendarOf,
  etNoonMs,
  gamesFromBoard,
  seasonYearFromDate,
  loadFootballRestSchedule,
  loadFootballRestSchedules,
  failedSchedule,
};
