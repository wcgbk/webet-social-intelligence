'use strict';

const {
  SPORTS_ENABLED, ODDS_SPORT_KEYS, ESPN_LEAGUES,
} = require('./config');
const { isSameEtDay, etCalendarDate } = require('./odds_math');
const { buildPitcherIndex, emptyPitcherIndex, mlbSeasonFromDate } = require('./sports/mlb_env');

const ODDS_REGIONS = 'us,us2,eu';
const ODDS_MARKETS = 'h2h,spreads,totals';

function enabledSportLabels() {
  return Object.keys(SPORTS_ENABLED).filter(s => SPORTS_ENABLED[s]);
}

async function fetchJson(url, timeoutMs = 12000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url.split('?')[0]}`);
  return resp.json();
}

/**
 * Odds API multi-sport snapshot. Timestamped. Does not burn extras beyond one pass/sport.
 */
async function fetchOddsMultiSport(dateISO, opts = {}) {
  const apiKey = process.env.ODDS_API_KEY;
  const out = { bySport: {}, fetchedAt: new Date().toISOString(), snapshotNote: 'live' };
  if (!apiKey) {
    console.log('[omega-vnext/ingest] No ODDS_API_KEY — skipping odds');
    return out;
  }

  const sports = enabledSportLabels();
  for (const label of sports) {
    const key = ODDS_SPORT_KEYS[label];
    if (!key) continue;
    try {
      let url;
      if (opts.historicalSnapshot) {
        out.snapshotNote = `historical:${opts.historicalSnapshot}`;
        url = `https://api.the-odds-api.com/v4/historical/sports/${key}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}&date=${encodeURIComponent(opts.historicalSnapshot)}`;
      } else {
        url = `https://api.the-odds-api.com/v4/sports/${key}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
      }
      const data = await fetchJson(url, 15000);
      // historical endpoint wraps in { data: [...] }
      const rawEvents = Array.isArray(data) ? data : (data && data.data) || [];
      const events = filterEventsSameEtDay(rawEvents, dateISO);
      out.bySport[label] = events;
      const remaining = null; // header not available via fetch easily
      console.log(`[omega-vnext/ingest] ${label}: ${events.length}/${rawEvents.length} events (same-ET-day ${dateISO || 'n/a'})`);
    } catch (e) {
      console.error(`[omega-vnext/ingest] Odds ${label} failed: ${e.message}`);
      out.bySport[label] = [];
    }
  }
  return out;
}

function dateParamET(dateISO) {
  return String(dateISO || '').replace(/-/g, '');
}

/** Keep only events whose commence_time falls on cardDateISO (ET calendar day). */
function filterEventsSameEtDay(events, dateISO) {
  if (!dateISO) return events || [];
  const kept = [];
  let dropped = 0;
  for (const ev of events || []) {
    const t = ev.commence_time || ev.commenceTime || ev.date;
    if (t && isSameEtDay(t, dateISO)) kept.push(ev);
    else dropped += 1;
  }
  if (dropped) {
    console.log(`[omega-vnext/ingest] day-scope drop ${dropped} event(s) not on ${dateISO} ET`);
  }
  return kept;
}



function extractProbable(competitor) {
  if (!competitor) return null;
  const probs = competitor.probables || competitor.probablePitchers || [];
  if (Array.isArray(probs) && probs.length) {
    const p = probs[0];
    const name = (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || p.displayName || p.name || null;
    if (name) return { name, id: (p.athlete && p.athlete.id) || p.id || null };
  }
  // Some scoreboards nest under competitor.athletes / roster hints — skip if absent
  return null;
}

async function fetchEspnScoreboard(label, dateISO) {
  const cfg = ESPN_LEAGUES[label];
  if (!cfg) return { league: label, games: [] };
  const dates = dateParamET(dateISO);
  let url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/scoreboard`;
  if (dates) url += `?dates=${dates}`;
  // CFB often needs groups; keep simple for v1
  try {
    const data = await fetchJson(url, 10000);
    const games = (data.events || []).map(ev => {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
      const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
      const homeProb = extractProbable(home);
      const awayProb = extractProbable(away);
      return {
        id: ev.id,
        name: ev.name,
        shortName: ev.shortName,
        commenceTime: ev.date || comp.date,
        status: (comp.status && comp.status.type && comp.status.type.state) || 'pre',
        homeTeam: (home.team && (home.team.displayName || home.team.name)) || '',
        awayTeam: (away.team && (away.team.displayName || away.team.name)) || '',
        homeAbbr: (home.team && home.team.abbreviation) || '',
        awayAbbr: (away.team && away.team.abbreviation) || '',
        homeScore: home.score != null ? Number(home.score) : null,
        awayScore: away.score != null ? Number(away.score) : null,
        homeProbable: homeProb,
        awayProbable: awayProb,
        weather: extractWeather(comp),
      };
    });
    const sameDay = games.filter(g => !dateISO || !g.commenceTime || isSameEtDay(g.commenceTime, dateISO));
    if (sameDay.length !== games.length) {
      console.log(`[omega-vnext/ingest] ESPN ${label}: day-scope ${sameDay.length}/${games.length} on ${dateISO}`);
    }
    return { league: label, games: sameDay };
  } catch (e) {
    console.error(`[omega-vnext/ingest] ESPN ${label}: ${e.message}`);
    return { league: label, games: [] };
  }
}

async function fetchEspnStandings(label) {
  const cfg = ESPN_LEAGUES[label];
  if (!cfg) return {};
  // NFL / CFB / MLB standings endpoints differ; best-effort
  const urls = [
    `https://site.api.espn.com/apis/v2/sports/${cfg.sport}/${cfg.league}/standings`,
    `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/standings`,
  ];
  for (const url of urls) {
    try {
      const data = await fetchJson(url, 10000);
      const ratings = {};
      const children = data.children || data.children || [];
      const entries = [];
      function walk(node) {
        if (!node) return;
        if (Array.isArray(node.standings && node.standings.entries)) {
          entries.push(...node.standings.entries);
        }
        if (Array.isArray(node.entries)) entries.push(...node.entries);
        (node.children || []).forEach(walk);
      }
      if (data.standings && data.standings.entries) entries.push(...data.standings.entries);
      walk(data);
      for (const e of entries) {
        const team = (e.team && (e.team.displayName || e.team.name)) || '';
        if (!team) continue;
        const stats = e.stats || [];
        const winPct = stats.find(s => s.name === 'winPercent' || s.name === 'avgPointsFor');
        const pf = stats.find(s => /pointsFor|avgPointsFor|runsFor/i.test(s.name || ''));
        const pa = stats.find(s => /pointsAgainst|avgPointsAgainst|runsAgainst/i.test(s.name || ''));
        const wins = stats.find(s => s.name === 'wins');
        const losses = stats.find(s => s.name === 'losses');
        ratings[team] = {
          winPct: winPct ? Number(winPct.value) : null,
          pf: pf ? Number(pf.value) : null,
          pa: pa ? Number(pa.value) : null,
          wins: wins ? Number(wins.value) : null,
          losses: losses ? Number(losses.value) : null,
        };
      }
      if (Object.keys(ratings).length) return ratings;
    } catch (_) { /* try next */ }
  }
  return {};
}

function stripMeta(table) {
  const out = {};
  if (!table || typeof table !== 'object' || Array.isArray(table)) return out;
  for (const [k, v] of Object.entries(table)) {
    if (!k || k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function readTalentFile() {
  try {
    return require('./sports/data/cfb-talent-seed.json');
  } catch (e) {
    console.error(`[omega-vnext/ingest] CFB talent seed soft-fail: ${e.message}`);
    return null;
  }
}

function loadTalentSeed() {
  return stripMeta(readTalentFile() || {});
}

function talentSeedMeta() {
  const raw = readTalentFile();
  return (raw && raw._meta && typeof raw._meta === 'object') ? raw._meta : {};
}

/**
 * Attach optional talent/spPlus onto EPA rows without wiping EPA fields.
 * Exact team name only — mascot fuzzy match would cross LSU/Clemson/Auburn.
 * scale is 'centered' or 'pct_0_100' from the seed meta.
 */
function mergeTalentIntoEfficiency(epaTable, talentTable, scale) {
  const out = { ...(epaTable || {}) };
  const talent = talentTable || {};
  const talentScale = scale === 'pct_0_100' ? 'pct_0_100' : 'centered';
  for (const [team, row] of Object.entries(out)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (!Object.prototype.hasOwnProperty.call(talent, team)) continue;
    const t = talent[team];
    let talentVal = null;
    let spPlus = null;
    if (t != null && typeof t === 'object') {
      spPlus = t.spPlus != null ? t.spPlus : null;
      talentVal = t.talent != null ? t.talent : spPlus;
    } else if (Number.isFinite(Number(t))) {
      talentVal = Number(t);
    }
    if (!Number.isFinite(Number(talentVal))) continue;
    const next = { ...row, talent: Number(talentVal), talentScale };
    if (spPlus != null && Number.isFinite(Number(spPlus))) next.spPlus = Number(spPlus);
    out[team] = next;
  }
  return out;
}

function loadEfficiencySeeds() {
  const nfl = require('./sports/data/nfl-epa-seed.json');
  const cfb = require('./sports/data/cfb-epa-seed.json');
  const talent = loadTalentSeed();
  let scale = 'centered';
  try {
    const { talentScaleMode } = require('./sports/epa');
    scale = talentScaleMode(talentSeedMeta());
  } catch (e) {
    console.error(`[omega-vnext/ingest] talent scale soft-fail: ${e.message}`);
  }
  return {
    NFL: stripMeta(nfl),
    NCAAF: mergeTalentIntoEfficiency(stripMeta(cfb), talent, scale),
  };
}

function loadParkFactors() {
  return stripMeta(require('./sports/data/mlb-park-factors.json'));
}

/**
 * One StatsAPI pull per generate. Player lines preferred; team rates are a
 * fallback index only. Any failure returns an empty index — never throws.
 */
async function fetchMlbPitcherStats(dateISO) {
  const empty = emptyPitcherIndex();
  try {
    const season = mlbSeasonFromDate(dateISO);
    const playerUrl = `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${season}&sportId=1&playerPool=all&limit=2000&gameType=R`;
    const teamUrl = `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&sportId=1&group=pitching&stats=season&gameType=R`;
    const [playerRes, teamRes] = await Promise.allSettled([
      fetchJson(playerUrl, 8000),
      fetchJson(teamUrl, 8000),
    ]);
    if (playerRes.status === 'rejected') {
      console.error(`[omega-vnext/ingest] MLB player stats failed: ${playerRes.reason && playerRes.reason.message}`);
    }
    if (teamRes.status === 'rejected') {
      console.error(`[omega-vnext/ingest] MLB team pitching failed: ${teamRes.reason && teamRes.reason.message}`);
    }
    const players = playerRes.status === 'fulfilled' ? playerRes.value : null;
    const teams = teamRes.status === 'fulfilled' ? teamRes.value : null;
    if (!players && !teams) return empty;
    const idx = buildPitcherIndex(players, teams);
    console.log(`[omega-vnext/ingest] MLB pitcher stats season=${season} players=${Object.keys(idx.byId).length} teams=${Object.keys(idx.byTeam).length}`);
    return idx;
  } catch (e) {
    console.error(`[omega-vnext/ingest] MLB pitcher stats failed (standings fallback): ${e.message}`);
    return empty;
  }
}

/**
 * EPA seeds + park table + optional StatsAPI. Each piece fails soft to {}.
 * deps is for tests — production calls the real loaders.
 */

const { prevEtDate, restMapFromScoreboard } = require('./sports/game_day');

/** Soft QB out/doubtful/questionable map from ESPN injuries (football). */
async function fetchFootballQbStatusMap(leagueSlug) {
  const out = {};
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/${leagueSlug}/injuries`;
    const data = await fetchJson(url, 8000);
    const apply = (teamName, pos, status, athleteName) => {
      if ((pos || '').toUpperCase() !== 'QB') return;
      const st = String(status || '').toLowerCase();
      if (!st) return;
      if (!/(out|doubtful|questionable|injured reserve|\bir\b|ruled out)/i.test(st)) return;
      const key = teamName;
      // Prefer worse status if multiple
      const rank = (s) => (/out|ruled out|ir|injured reserve/.test(s) ? 3 : /doubtful/.test(s) ? 2 : 1);
      const prev = out[key];
      if (prev && rank(String(prev.qbStatus)) >= rank(st)) return;
      out[key] = { team: teamName, qbStatus: st, qbName: athleteName || null };
    };
    for (const team of (data.injuries || data.teams || [])) {
      const teamName = team.displayName || (team.team && team.team.displayName) || '';
      for (const inj of (team.injuries || team.athletes || [])) {
        apply(
          teamName,
          (inj.athlete && inj.athlete.position && inj.athlete.position.abbreviation) || inj.position,
          inj.status || inj.type,
          (inj.athlete && inj.athlete.displayName) || inj.displayName
        );
      }
    }
  } catch (e) {
    console.log(`[omega-vnext/ingest] QB status ${leagueSlug} soft-fail: ${e.message}`);
  }
  return out;
}

function extractWeather(comp) {
  if (!comp) return null;
  const w = comp.weather || comp.situation && comp.situation.weather || null;
  if (!w || typeof w !== 'object') return null;
  const temp = w.temperature != null ? Number(w.temperature) : (w.temp != null ? Number(w.temp) : null);
  const wind = w.windSpeed != null ? Number(String(w.windSpeed).replace(/[^\d.]/g, '')) : null;
  return {
    tempF: Number.isFinite(temp) ? temp : null,
    condition: w.condition || w.displayValue || w.type || null,
    windMph: Number.isFinite(wind) ? wind : null,
    windDir: w.windDirection || w.displayValue || null,
  };
}

async function loadGameDayContext(dateISO, labels, espnBySport) {
  const gameDay = {
    restByTeam: { MLB: {}, NFL: {}, NCAAF: {} },
    qbStatusBySport: { NFL: {}, NCAAF: {} },
    weatherByGame: {},
  };
  const prev = prevEtDate(dateISO);
  if (prev) {
    for (const label of labels) {
      if (!['MLB', 'NFL', 'NCAAF'].includes(label)) continue;
      try {
        const board = await fetchEspnScoreboard(label, prev);
        const map = restMapFromScoreboard((board && board.games) || [], prev);
        gameDay.restByTeam[label] = map;
        console.log(`[omega-vnext/ingest] rest ${label} playedYesterday=${Object.keys(map).length} (from ${prev})`);
      } catch (e) {
        console.error(`[omega-vnext/ingest] rest ${label} soft-fail: ${e.message}`);
        gameDay.restByTeam[label] = {};
      }
    }
  }
  try {
    if (labels.includes('NFL')) gameDay.qbStatusBySport.NFL = await fetchFootballQbStatusMap('nfl');
  } catch (e) {
    console.error(`[omega-vnext/ingest] NFL QB soft-fail: ${e.message}`);
  }
  try {
    if (labels.includes('NCAAF')) gameDay.qbStatusBySport.NCAAF = await fetchFootballQbStatusMap('college-football');
  } catch (e) {
    console.error(`[omega-vnext/ingest] CFB QB soft-fail: ${e.message}`);
  }
  // Weather from today's MLB ESPN board already fetched
  const mlbBoard = espnBySport && espnBySport.MLB;
  for (const g of (mlbBoard && mlbBoard.games) || []) {
    // weather may not be on our mapped games — leave empty unless present
    if (g.weather) {
      const key = `${g.awayTeam || ''}|${g.homeTeam || ''}`;
      gameDay.weatherByGame[key] = g.weather;
    }
  }
  return gameDay;
}

async function loadSportEngines(dateISO, deps) {
  const loadSeeds = (deps && deps.loadSeeds) || loadEfficiencySeeds;
  const loadParks = (deps && deps.loadParks) || loadParkFactors;
  const fetchPitchers = (deps && deps.fetchPitchers) || ((d) => fetchMlbPitcherStats(d));
  let efficiencyBySport = { NFL: {}, NCAAF: {} };
  let parkFactors = {};
  let mlbPitcherStats = emptyPitcherIndex();
  try {
    const seeds = await loadSeeds();
    efficiencyBySport = {
      NFL: stripMeta(seeds && seeds.NFL),
      NCAAF: stripMeta(seeds && (seeds.NCAAF || seeds.CFB)),
    };
  } catch (e) {
    console.error(`[omega-vnext/ingest] EPA/efficiency load failed (standings fallback): ${e.message}`);
    efficiencyBySport = { NFL: {}, NCAAF: {} };
  }
  try {
    parkFactors = stripMeta(await loadParks());
  } catch (e) {
    console.error(`[omega-vnext/ingest] park factors load failed (neutral fallback): ${e.message}`);
    parkFactors = {};
  }
  try {
    const fetched = await fetchPitchers(dateISO);
    mlbPitcherStats = fetched && typeof fetched === 'object'
      ? fetched
      : emptyPitcherIndex();
    if (!mlbPitcherStats.byId || !mlbPitcherStats.byName || !mlbPitcherStats.byTeam) {
      mlbPitcherStats = {
        byId: (mlbPitcherStats && mlbPitcherStats.byId) || {},
        byName: (mlbPitcherStats && mlbPitcherStats.byName) || {},
        byTeam: (mlbPitcherStats && mlbPitcherStats.byTeam) || {},
      };
    }
  } catch (e) {
    console.error(`[omega-vnext/ingest] MLB pitcher stats failed (standings fallback): ${e.message}`);
    mlbPitcherStats = emptyPitcherIndex();
  }
  const nNfl = Object.keys(efficiencyBySport.NFL || {}).length;
  const nCfb = Object.keys(efficiencyBySport.NCAAF || {}).length;
  const nParks = Object.keys(parkFactors || {}).length;
  const nPit = Object.keys((mlbPitcherStats && mlbPitcherStats.byId) || {}).length;
  console.log(`[omega-vnext/ingest] engines epa NFL=${nNfl} NCAAF=${nCfb} parks=${nParks} pitchers=${nPit}`);
  return { efficiencyBySport, parkFactors, mlbPitcherStats };
}

async function ingest(dateISO, opts = {}) {
  const labels = enabledSportLabels();
  // Also fetch standings for disabled sports? No — only enabled.
  const [odds, espnParts, standingsList, engines] = await Promise.all([
    fetchOddsMultiSport(dateISO, opts),
    Promise.all(labels.map(l => fetchEspnScoreboard(l, dateISO))),
    Promise.all(labels.map(async (l) => ({ label: l, ratings: await fetchEspnStandings(l) }))),
    loadSportEngines(dateISO),
  ]);
  const espnBySport = {};
  for (const part of espnParts) espnBySport[part.league] = part;
  const standingsBySport = {};
  for (const row of standingsList) standingsBySport[row.label] = row.ratings;

  let gameDay = { restByTeam: { MLB: {}, NFL: {}, NCAAF: {} }, qbStatusBySport: { NFL: {}, NCAAF: {} }, weatherByGame: {} };
  try {
    gameDay = await loadGameDayContext(dateISO, labels, espnBySport);
  } catch (e) {
    console.error(`[omega-vnext/ingest] gameDay soft-fail: ${e.message}`);
  }

  return {
    dateISO,
    oddsBySport: odds.bySport,
    espnBySport,
    standingsBySport,
    efficiencyBySport: engines.efficiencyBySport,
    mlbPitcherStats: engines.mlbPitcherStats,
    parkFactors: engines.parkFactors,
    gameDay,
    fetchedAt: odds.fetchedAt,
    snapshotNote: odds.snapshotNote,
  };
}

module.exports = {
  loadTalentSeed,
  talentSeedMeta,
  mergeTalentIntoEfficiency,
  ingest,
  fetchOddsMultiSport,
  fetchEspnScoreboard,
  fetchEspnStandings,
  fetchMlbPitcherStats,
  loadEfficiencySeeds,
  loadParkFactors,
  loadSportEngines,
  loadGameDayContext,
  fetchFootballQbStatusMap,
  enabledSportLabels,
  filterEventsSameEtDay,
  etCalendarDate,
  isSameEtDay,
};
