'use strict';

/**
 * NFL / NCAAF open-air total weather from api.weather.gov.
 * Stadium pins live in data/football-stadiums.json, keyed by league and
 * ESPN team id (the same number is a different club in each league).
 * Neutral and international sites use the ESPN competition venue id,
 * then the venue name. Unknown venue, or a pin outside NWS coverage,
 * adjusts the total by 0. A dome or a retractable roof (assumed closed)
 * adjusts by 0 and does not call NWS.
 *
 * One generate makes at most one /points call and one hourly call per
 * outdoor venue. /points is cached for the process. A time budget and a
 * per-call timeout soft-fail to no adjustment. OMEGA_FB_WEATHER=0 disables
 * the fetch and the nudge. OMEGA_FB_WEATHER_FIXTURE_DIR reads
 * {lat}_{lon}.points.json and {lat}_{lon}.hourly.json (4 decimal places)
 * and does not touch the network.
 * Spreads are not an input and are not returned.
 */

const fs = require('fs');
const path = require('path');
const { FB_WEATHER, fbWeatherEnabled } = require('../config');
const { resolveTeamId } = require('./team_identity');
const { espnSideId } = require('./_common');

const STADIUMS = require('../data/football-stadiums.json');
const USER_AGENT = 'omega-vnext/football-weather (https://webet.ai)';
const POINTS_ORIGIN = 'https://api.weather.gov/points/';
const PAST_GRACE_MS = 6 * 60 * 60 * 1000;

const pointsCache = new Map();
const NAME_INDEX = { NFL: new Map(), NCAAF: new Map() };
const AMBIGUOUS = Object.freeze({ ambiguous: true });

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function round1(n) {
  return Number(Number(n).toFixed(1));
}

function normName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Continental US, or Hawaii. Team pins must pass. International pins do not. */
function coordinatesInUsHi(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  const conus = la >= 24.4 && la <= 49.5 && lo >= -125 && lo <= -66.5;
  const hi = la >= 18.8 && la <= 22.3 && lo >= -160.5 && lo <= -154.5;
  return conus || hi;
}

function roundCoord(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function coordKey(lat, lon) {
  return `${roundCoord(lat).toFixed(4)},${roundCoord(lon).toFixed(4)}`;
}

function clearPointsCache() {
  pointsCache.clear();
}

function indexNames(sport, row) {
  const idx = NAME_INDEX[sport];
  if (!idx || !row) return;
  const names = [row.name].concat(row.aliases || []);
  for (const name of names) {
    const key = normName(name);
    if (!key) continue;
    const prev = idx.get(key);
    if (!prev) {
      idx.set(key, row);
      continue;
    }
    if (prev === AMBIGUOUS) continue;
    const samePin = Math.abs(Number(prev.lat) - Number(row.lat)) <= 0.02
      && Math.abs(Number(prev.lon) - Number(row.lon)) <= 0.02;
    if (!samePin) idx.set(key, AMBIGUOUS);
  }
}

function buildNameIndex() {
  for (const sport of ['NFL', 'NCAAF']) {
    const teams = (STADIUMS.teams && STADIUMS.teams[sport]) || {};
    const venues = (STADIUMS.venues && STADIUMS.venues[sport]) || {};
    for (const row of Object.values(teams)) indexNames(sport, row);
    for (const row of Object.values(venues)) indexNames(sport, row);
  }
}

buildNameIndex();

function teamStadium(sport, teamId) {
  const league = STADIUMS.teams && STADIUMS.teams[sport];
  if (!league || teamId == null || teamId === '') return null;
  return league[String(teamId)] || null;
}

function venueById(sport, id) {
  const league = STADIUMS.venues && STADIUMS.venues[sport];
  if (!league || id == null || id === '') return null;
  return league[String(id)] || null;
}

function venueByName(sport, name) {
  const idx = NAME_INDEX[sport];
  if (!idx || !name) return null;
  const hit = idx.get(normName(name));
  if (!hit || hit === AMBIGUOUS) return null;
  return hit;
}

function decorate(row, how, neutral) {
  return {
    name: row.name || null,
    lat: Number(row.lat),
    lon: Number(row.lon),
    roof: row.roof || null,
    venueId: row.venueId != null ? String(row.venueId) : null,
    city: row.city || null,
    state: row.state || null,
    country: row.country || null,
    knownOpen: row.knownOpen === true,
    how,
    neutral: neutral === true,
    unknown: false,
  };
}

/**
 * Home stadium, unless the game is neutral or the competition venue is a
 * different building we know. Unknown venue → { unknown: true }.
 */
function resolveFootballVenue(sport, game) {
  const neutral = !!(game && game.neutralSite === true);
  const venue = game && game.venue && typeof game.venue === 'object' ? game.venue : null;
  const named = venue
    ? (venueById(sport, venue.id) || venueByName(sport, venue.name || venue.fullName))
    : null;
  const homeId = game
    ? (espnSideId(sport, game, 'home') || resolveTeamId(sport, game.homeTeam || game.home_team))
    : null;
  const home = teamStadium(sport, homeId);
  if (neutral) {
    if (named) return decorate(named, 'neutral-venue', true);
    return { unknown: true, how: 'neutral-unknown', neutral: true };
  }
  if (named && home && named.venueId && home.venueId && String(named.venueId) !== String(home.venueId)) {
    return decorate(named, 'venue-override', false);
  }
  if (home) return decorate(home, 'home', false);
  if (named) return decorate(named, 'venue', false);
  if (venue && (venue.id || venue.name || venue.fullName)) {
    return { unknown: true, how: 'unknown-venue', neutral: false };
  }
  return { unknown: true, how: 'no-home', neutral: false };
}

function roofClosed(row) {
  if (!row || row.unknown) return false;
  if (row.roof === 'dome') return true;
  if (row.roof === 'retractable' && row.knownOpen !== true) return true;
  return false;
}

/**
 * Total-only points. Open air only. Negative or zero.
 * wind: -k * max(0, wind - 10), cap -4.0
 * precip probability >= 70: -0.5
 * temperature < 20F: -0.5
 * combined cap -4.5
 */
function footballWeatherAdjustment(input) {
  const src = input || {};
  const sport = src.sport === 'NCAAF' ? 'NCAAF' : 'NFL';
  const cfg = FB_WEATHER;
  const k = cfg.k && Number.isFinite(Number(cfg.k[sport])) ? Number(cfg.k[sport]) : 0.35;
  const roof = src.roof || 'open';
  const openAir = roof === 'open' || (roof === 'retractable' && src.knownOpen === true);
  const zeros = { totalAdj: 0, windAdj: 0, precipAdj: 0, coldAdj: 0, applied: false, weatherNote: null };
  if (!openAir) {
    if (roof === 'dome' || roof === 'retractable') {
      return Object.assign({}, zeros, {
        weatherNote: roof === 'retractable' ? 'retractable closed' : 'dome',
      });
    }
    return zeros;
  }

  let windAdj = 0;
  let precipAdj = 0;
  let coldAdj = 0;
  const notes = [];
  const wind = src.windMph != null && src.windMph !== '' ? Number(src.windMph) : null;
  if (Number.isFinite(wind)) {
    windAdj = -k * Math.max(0, wind - Number(cfg.windBaseMph));
    const windCap = Number(cfg.windCap);
    if (Number.isFinite(windCap) && windCap > 0 && windAdj < -windCap) windAdj = -windCap;
    if (windAdj < 0) notes.push(`wind ${round1(wind)}mph ${round2(windAdj)}`);
  }
  const pop = src.precipProb != null && src.precipProb !== '' ? Number(src.precipProb) : null;
  if (Number.isFinite(pop) && pop >= Number(cfg.precipProbAt)) {
    precipAdj = -Number(cfg.precipAdj);
    notes.push(`precip ${round1(pop)}% ${precipAdj}`);
  }
  const temp = src.tempF != null && src.tempF !== '' ? Number(src.tempF) : null;
  if (Number.isFinite(temp) && temp < Number(cfg.coldBelowF)) {
    coldAdj = -Number(cfg.coldAdj);
    notes.push(`cold ${round1(temp)}F ${coldAdj}`);
  }
  let totalAdj = windAdj + precipAdj + coldAdj;
  const totalCap = Number(cfg.totalCap);
  if (Number.isFinite(totalCap) && totalCap > 0 && totalAdj < -totalCap) {
    totalAdj = -totalCap;
    notes.push(`cap ${totalAdj}`);
  }
  totalAdj = round2(totalAdj);
  windAdj = round2(windAdj);
  return {
    totalAdj,
    windAdj,
    precipAdj: round2(precipAdj),
    coldAdj: round2(coldAdj),
    applied: totalAdj < 0,
    weatherNote: notes.length ? notes.join('; ') : null,
  };
}

function parseWindMph(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const nums = String(value).match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(Number).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((sum, n) => sum + n, 0) / vals.length;
}

function averageHours(periods, kickoffMs) {
  const rows = [];
  for (const period of periods || []) {
    if (!period) continue;
    const start = Date.parse(period.startTime);
    const end = Date.parse(period.endTime);
    if (!Number.isFinite(start)) continue;
    rows.push({
      period,
      start,
      end: Number.isFinite(end) ? end : start + 60 * 60 * 1000,
    });
  }
  rows.sort((a, b) => a.start - b.start);
  const idx = rows.findIndex((row) => kickoffMs >= row.start && kickoffMs < row.end);
  if (idx < 0) return null;
  const slice = rows.slice(idx, idx + 3);
  const winds = [];
  const temps = [];
  const pops = [];
  for (const row of slice) {
    const wind = parseWindMph(row.period.windSpeed);
    if (wind != null) winds.push(wind);
    const temp = Number(row.period.temperature);
    const unit = String(row.period.temperatureUnit || 'F').toUpperCase();
    if (Number.isFinite(temp)) temps.push(unit === 'C' ? (temp * 9) / 5 + 32 : temp);
    const popNode = row.period.probabilityOfPrecipitation;
    const pop = popNode && popNode.value != null ? Number(popNode.value) : null;
    if (Number.isFinite(pop)) pops.push(pop);
  }
  const avg = (xs) => (xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null);
  return {
    windMph: avg(winds),
    tempF: avg(temps),
    precipProb: avg(pops),
    hours: slice.length,
  };
}

function withinHorizon(kickoffMs, nowMs) {
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(nowMs)) return false;
  const ahead = kickoffMs - nowMs;
  if (ahead < -PAST_GRACE_MS) return false;
  const days = Number(FB_WEATHER.horizonDays);
  const horizon = (Number.isFinite(days) ? days : 7) * 24 * 60 * 60 * 1000;
  return ahead <= horizon;
}

function fixtureDirFrom(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'fixtureDir')) {
    const dir = opts.fixtureDir;
    if (dir == null || String(dir).trim() === '') return null;
    return String(dir).trim();
  }
  const env = process.env.OMEGA_FB_WEATHER_FIXTURE_DIR;
  if (env == null || String(env).trim() === '') return null;
  return String(env).trim();
}

function fixturePath(dir, lat, lon, kind) {
  const name = `${roundCoord(lat).toFixed(4)}_${roundCoord(lon).toFixed(4)}.${kind}.json`;
  return path.join(dir, name);
}

function readFixture(dir, lat, lon, kind) {
  const file = fixturePath(dir, lat, lon, kind);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fetchJson(url, timeoutMs, fetchImpl) {
  const ms = Math.max(1, timeoutMs);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const abortTimer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  try {
    const resp = await withTimeout(fetchImpl(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json, application/json',
      },
    }), ms);
    if (!resp || resp.ok !== true) {
      const status = resp && resp.status != null ? resp.status : 'error';
      throw new Error(`HTTP ${status}`);
    }
    return await resp.json();
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

function cacheId(fixture, lat, lon) {
  return `${fixture || 'nws'}|${coordKey(lat, lon)}`;
}

async function loadPoints(lat, lon, ctx) {
  const id = cacheId(ctx.fixtureDir, lat, lon);
  if (pointsCache.has(id)) return pointsCache.get(id);
  let body;
  if (ctx.fixtureDir) {
    body = readFixture(ctx.fixtureDir, lat, lon, 'points');
  } else {
    ctx.calls.points += 1;
    body = await fetchJson(`${POINTS_ORIGIN}${coordKey(lat, lon)}`, ctx.timeLeft(), ctx.fetchImpl);
  }
  const hourly = body && body.properties && body.properties.forecastHourly;
  if (!hourly || typeof hourly !== 'string') throw new Error('points missing forecastHourly');
  const hit = { forecastHourly: hourly };
  pointsCache.set(id, hit);
  return hit;
}

async function loadHourly(lat, lon, points, ctx) {
  if (ctx.fixtureDir) return readFixture(ctx.fixtureDir, lat, lon, 'hourly');
  ctx.calls.hourly += 1;
  return fetchJson(points.forecastHourly, ctx.timeLeft(), ctx.fetchImpl);
}

function gameIdentity(sport, game) {
  const homeName = (game && (game.homeTeam || game.home_team)) || null;
  const awayName = (game && (game.awayTeam || game.away_team)) || null;
  return {
    sport,
    homeId: game ? (espnSideId(sport, game, 'home') || resolveTeamId(sport, homeName) || null) : null,
    awayId: game ? (espnSideId(sport, game, 'away') || resolveTeamId(sport, awayName) || null) : null,
    homeTeam: homeName,
    awayTeam: awayName,
    commenceTime: (game && (game.commenceTime || game.commence_time)) || null,
  };
}

function kickoffMsOf(game) {
  const iso = game && (game.commenceTime || game.commence_time || game.date);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function blankObs(sport, game, resolved) {
  return Object.assign(gameIdentity(sport, game), {
    stadium: resolved && resolved.name ? resolved.name : null,
    venueId: resolved && resolved.venueId ? resolved.venueId : null,
    roof: resolved && resolved.roof ? resolved.roof : null,
    knownOpen: !!(resolved && resolved.knownOpen),
    neutralSite: !!(resolved && resolved.neutral),
    lat: resolved && Number.isFinite(resolved.lat) ? resolved.lat : null,
    lon: resolved && Number.isFinite(resolved.lon) ? resolved.lon : null,
    how: resolved && resolved.how ? resolved.how : null,
    windMph: null,
    precipProb: null,
    tempF: null,
    source: 'none',
    fetchedAt: null,
    reason: null,
    error: null,
  });
}

function listGames(opts) {
  if (opts && Array.isArray(opts.games)) {
    return opts.games.map((row, i) => {
      if (row && row.game && row.sport) return { sport: row.sport, game: row.game, id: row.id || String(i) };
      return { sport: row && row.sport, game: row, id: (row && row.id) || String(i) };
    }).filter((row) => row.sport === 'NFL' || row.sport === 'NCAAF');
  }
  const boards = (opts && opts.espnBySport) || {};
  const out = [];
  for (const sport of ['NFL', 'NCAAF']) {
    const games = (boards[sport] && boards[sport].games) || [];
    games.forEach((game, i) => {
      if (game) out.push({ sport, game, id: game.id != null ? String(game.id) : `${sport}-${i}` });
    });
  }
  return out;
}

function groupGames(listed) {
  const groups = new Map();
  for (const item of listed) {
    const resolved = resolveFootballVenue(item.sport, item.game);
    const closed = roofClosed(resolved);
    const outside = !resolved.unknown && !closed && !coordinatesInUsHi(resolved.lat, resolved.lon);
    let key;
    if (resolved.unknown || closed || outside || !Number.isFinite(resolved.lat)) {
      key = `solo:${item.sport}:${item.id}`;
    } else {
      // One pin, one fetch, even when NFL and NCAAF share the building.
      key = coordKey(resolved.lat, resolved.lon);
    }
    if (!groups.has(key)) groups.set(key, { resolved, closed, outside, games: [] });
    const bucket = groups.get(key);
    bucket.games.push(Object.assign({}, item, { resolved }));
  }
  return Array.from(groups.values());
}

function failReason(err) {
  const message = err && err.name === 'AbortError'
    ? 'timeout'
    : String((err && err.message) || 'fetch failed');
  if (/timeout|aborted|abort/i.test(message)) return { reason: 'timeout', error: message };
  return { reason: 'error', error: message };
}

async function observeGroup(group, ctx) {
  const { resolved, closed, outside } = group;
  const rows = group.games.map((item) => blankObs(item.sport, item.game, item.resolved || resolved));
  const fill = (patch) => rows.map((row) => Object.assign(row, patch));

  if (resolved.unknown) return fill({ source: 'none', reason: 'unknown-venue' });
  if (closed) return fill({ source: 'roof', reason: 'roof' });
  if (outside) return fill({ source: 'none', reason: 'outside-nws' });

  const inRange = group.games.filter((item) => withinHorizon(kickoffMsOf(item.game), ctx.nowMs));
  if (!inRange.length) return fill({ source: 'none', reason: 'beyond-horizon' });
  if (ctx.timeLeft() < 50) return fill({ source: 'none', reason: 'budget', error: 'time budget' });

  try {
    const points = await loadPoints(resolved.lat, resolved.lon, ctx);
    if (ctx.timeLeft() < 50) return fill({ source: 'none', reason: 'budget', error: 'time budget' });
    const hourly = await loadHourly(resolved.lat, resolved.lon, points, ctx);
    const fetchedAt = new Date(ctx.nowMs).toISOString();
    const periods = hourly && hourly.properties && hourly.properties.periods;
    const source = ctx.fixtureDir ? 'fixture' : 'nws';
    return rows.map((row, i) => {
      const item = group.games[i];
      if (!withinHorizon(kickoffMsOf(item.game), ctx.nowMs)) {
        return Object.assign(row, { source: 'none', reason: 'beyond-horizon' });
      }
      const avg = averageHours(periods, kickoffMsOf(item.game));
      if (!avg) return Object.assign(row, { source, fetchedAt, reason: 'no-period' });
      return Object.assign(row, {
        source,
        fetchedAt,
        reason: 'ok',
        windMph: avg.windMph != null ? round2(avg.windMph) : null,
        precipProb: avg.precipProb != null ? round2(avg.precipProb) : null,
        tempF: avg.tempF != null ? round2(avg.tempF) : null,
        hours: avg.hours,
      });
    });
  } catch (err) {
    const failed = failReason(err);
    return fill({ source: 'none', reason: failed.reason, error: failed.error });
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit || 1, items.length || 1));
  if (!items.length) return out;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

function stampRow(map, row) {
  const sport = row.sport;
  const iso = row.commenceTime || '';
  const keys = [];
  if (row.homeId && row.awayId && iso) keys.push(`FB|${sport}|id|${row.homeId}|${row.awayId}|${iso}`);
  if (iso && row.homeTeam && row.awayTeam) {
    keys.push(`FB|${sport}|name|${normName(row.awayTeam)}|${normName(row.homeTeam)}|${iso}`);
  }
  if (row.homeId && row.awayId) keys.push(`FB|${sport}|id|${row.homeId}|${row.awayId}`);
  if (row.homeTeam && row.awayTeam) {
    const bare = `FB|${sport}|name|${normName(row.awayTeam)}|${normName(row.homeTeam)}`;
    if (!map[bare]) keys.push(bare);
  }
  for (const key of keys) {
    if (key && !map[key]) map[key] = row;
  }
}

/**
 * Fill weatherByGame for the NFL and NCAAF slate. Never throws.
 * Soft-fail rows stay in the map with a reason; the total hook ignores them.
 */
async function loadFootballWeather(opts) {
  const emptyCalls = { points: 0, hourly: 0 };
  if (!fbWeatherEnabled()) {
    return {
      weatherByGame: {},
      disabled: true,
      meta: { disabled: true, calls: emptyCalls, reasons: {}, elapsedMs: 0 },
    };
  }
  const started = Date.now();
  const budgetMs = opts && opts.budgetMs != null ? Number(opts.budgetMs) : Number(FB_WEATHER.budgetMs);
  const callTimeout = opts && opts.callTimeoutMs != null ? Number(opts.callTimeoutMs) : Number(FB_WEATHER.callTimeoutMs);
  const nowMs = opts && opts.now != null
    ? (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now))
    : Date.now();
  const fixtureDir = fixtureDirFrom(opts);
  const fetchImpl = (opts && opts.fetchImpl) || ((url, init) => fetch(url, init));
  const ctx = {
    fixtureDir,
    fetchImpl,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    deadline: started + (Number.isFinite(budgetMs) ? budgetMs : 8000),
    callTimeout: Number.isFinite(callTimeout) ? callTimeout : 2500,
    calls: { points: 0, hourly: 0 },
    timeLeft() {
      return Math.min(this.callTimeout, this.deadline - Date.now());
    },
  };
  const weatherByGame = {};
  const reasons = {};
  try {
    const groups = groupGames(listGames(opts));
    const limit = Number(FB_WEATHER.concurrency) || 6;
    const observed = await mapPool(groups, limit, (group) => observeGroup(group, ctx));
    for (const rows of observed) {
      for (const row of rows || []) {
        reasons[row.reason || 'none'] = (reasons[row.reason || 'none'] || 0) + 1;
        stampRow(weatherByGame, row);
      }
    }
  } catch (err) {
    return {
      weatherByGame,
      disabled: false,
      meta: {
        disabled: false,
        calls: ctx.calls,
        reasons,
        elapsedMs: Date.now() - started,
        error: err && err.message ? err.message : 'football weather failed',
        fixture: !!fixtureDir,
      },
    };
  }
  return {
    weatherByGame,
    disabled: false,
    meta: {
      disabled: false,
      calls: ctx.calls,
      reasons,
      elapsedMs: Date.now() - started,
      budgetMs: Number.isFinite(budgetMs) ? budgetMs : 8000,
      fixture: !!fixtureDir,
    },
  };
}

const SOFT_REASONS = new Set([
  'soft-fail', 'budget', 'timeout', 'error', 'no-period', 'beyond-horizon', 'disabled',
]);

function lookupFootballWeather(gameDay, sport, event, espnGame) {
  const map = (gameDay && gameDay.weatherByGame) || {};
  const homeName = (event && (event.home_team || event.homeTeam)) || (espnGame && (espnGame.homeTeam || espnGame.home_team)) || '';
  const awayName = (event && (event.away_team || event.awayTeam)) || (espnGame && (espnGame.awayTeam || espnGame.away_team)) || '';
  const homeId = (espnGame && espnSideId(sport, espnGame, 'home')) || resolveTeamId(sport, homeName);
  const awayId = (espnGame && espnSideId(sport, espnGame, 'away')) || resolveTeamId(sport, awayName);
  const iso = (event && (event.commence_time || event.commenceTime))
    || (espnGame && (espnGame.commenceTime || espnGame.commence_time))
    || '';
  const keys = [
    homeId && awayId && iso ? `FB|${sport}|id|${homeId}|${awayId}|${iso}` : null,
    iso && homeName && awayName ? `FB|${sport}|name|${normName(awayName)}|${normName(homeName)}|${iso}` : null,
    homeId && awayId ? `FB|${sport}|id|${homeId}|${awayId}` : null,
    homeName && awayName ? `FB|${sport}|name|${normName(awayName)}|${normName(homeName)}` : null,
  ];
  for (const key of keys) {
    if (key && map[key] && map[key].sport === sport) return map[key];
  }
  return null;
}

/**
 * Apply a stored NWS/fixture/roof row to the model total.
 * used false → caller keeps the previous total path (ESPN wind for NFL).
 * Spreads are not touched; this returns a total only.
 */
function footballTotalFromGameDay(ctx) {
  const modelTotal = ctx && ctx.modelTotal;
  const total = Number(modelTotal);
  const kept = Number.isFinite(total) ? total : modelTotal;
  const untouched = {
    used: false,
    modelTotal: kept,
    totalAdj: 0,
    weatherNote: null,
    applied: false,
    fbWeather: null,
  };
  if (!fbWeatherEnabled()) return untouched;
  const row = lookupFootballWeather(ctx && ctx.gameDay, ctx && ctx.sport, ctx && ctx.event, ctx && ctx.espnGame);
  if (!row || SOFT_REASONS.has(row.reason)) return untouched;
  const adj = footballWeatherAdjustment({
    sport: ctx.sport,
    roof: row.roof,
    knownOpen: row.knownOpen === true,
    windMph: row.windMph,
    precipProb: row.precipProb,
    tempF: row.tempF,
  });
  const fbWeather = {
    source: row.source,
    fetchedAt: row.fetchedAt,
    stadium: row.stadium,
    venueId: row.venueId,
    roof: row.roof,
    neutralSite: row.neutralSite === true,
    lat: row.lat,
    lon: row.lon,
    windMph: row.windMph,
    precipProb: row.precipProb,
    tempF: row.tempF,
    windAdj: adj.windAdj,
    precipAdj: adj.precipAdj,
    coldAdj: adj.coldAdj,
    totalAdj: adj.totalAdj,
    reason: row.reason,
    how: row.how,
  };
  return {
    used: true,
    modelTotal: adj.totalAdj === 0 || !Number.isFinite(total) ? kept : round2(total + adj.totalAdj),
    totalAdj: adj.totalAdj,
    weatherNote: adj.weatherNote,
    applied: adj.applied,
    fbWeather,
  };
}

module.exports = {
  USER_AGENT,
  STADIUMS,
  coordinatesInUsHi,
  coordKey,
  clearPointsCache,
  parseWindMph,
  averageHours,
  footballWeatherAdjustment,
  resolveFootballVenue,
  loadFootballWeather,
  lookupFootballWeather,
  footballTotalFromGameDay,
  fixtureDirFrom,
};
