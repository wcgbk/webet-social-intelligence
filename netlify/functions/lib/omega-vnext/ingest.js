'use strict';

const {
  SPORTS_ENABLED, ODDS_SPORT_KEYS, ESPN_LEAGUES,
} = require('./config');
const { isSameEtDay, etCalendarDate } = require('./odds_math');

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

async function ingest(dateISO, opts = {}) {
  const labels = enabledSportLabels();
  // Also fetch standings for disabled sports? No — only enabled.
  const [odds, ...espnParts] = await Promise.all([
    fetchOddsMultiSport(dateISO, opts),
    ...labels.map(l => fetchEspnScoreboard(l, dateISO)),
  ]);
  const espnBySport = {};
  for (const part of espnParts) espnBySport[part.league] = part;

  const standingsBySport = {};
  await Promise.all(labels.map(async (l) => {
    standingsBySport[l] = await fetchEspnStandings(l);
  }));

  return {
    dateISO,
    oddsBySport: odds.bySport,
    espnBySport,
    standingsBySport,
    fetchedAt: odds.fetchedAt,
    snapshotNote: odds.snapshotNote,
  };
}

module.exports = {
  ingest,
  fetchOddsMultiSport,
  fetchEspnScoreboard,
  fetchEspnStandings,
  enabledSportLabels,
  filterEventsSameEtDay,
  etCalendarDate,
  isSameEtDay,
};
