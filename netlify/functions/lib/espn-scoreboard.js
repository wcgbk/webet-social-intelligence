// Shared ESPN scoreboard fetch for Omega / NFL / CFB KPI graders.
// Client live scores use a matching URL builder in daily-omega, nfl, and cfb pages.
//
// Why this exists:
// - Omega MAIN is MLB+NFL+NCAAF but get-results-omega previously had no NFL/NCAAF
//   endpoints, so football picks stayed `pending` forever.
// - NCAAF without groups=80/90 collapses to Top-25 and misses most FBS/FCS games.
// - Late-night / Hawaii / UTC spill: a pick stored on ET date D may live on ESPN
//   date D-1 or D+1. We fetch the adjacent calendar days and merge.

const ESPN_ENDPOINTS = {
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  NCAAB: 'basketball/mens-college-basketball',
  MLB: 'baseball/mlb',
  NFL: 'football/nfl',
  NCAAF: 'football/college-football',
  EPL: 'soccer/eng.1',
  'La Liga': 'soccer/esp.1',
  'Serie A': 'soccer/ita.1',
  Bundesliga: 'soccer/ger.1',
  'Ligue 1': 'soccer/fra.1',
  MLS: 'soccer/usa.1',
  UCL: 'soccer/uefa.champions',
  UEL: 'soccer/uefa.europa',
  Europa: 'soccer/uefa.europa',
};

function shiftIsoDate(dateISO, days) {
  if (!dateISO) return null;
  const d = new Date(dateISO + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function scoreboardDates(dateISO) {
  const dates = [];
  if (!dateISO) return dates;
  const prev = shiftIsoDate(dateISO, -1);
  const next = shiftIsoDate(dateISO, 1);
  if (prev) dates.push(prev);
  dates.push(dateISO);
  if (next) dates.push(next);
  return dates;
}

function scoreboardUrls(sport, dateISO) {
  const endpoint = ESPN_ENDPOINTS[sport];
  if (!endpoint) return [];
  const isNcaaf = sport === 'NCAAF';
  const urls = [];
  const push = (d, groups) => {
    const q = [];
    if (d) q.push('dates=' + String(d).replace(/-/g, ''));
    if (groups) {
      q.push('groups=' + groups);
      q.push('limit=300');
    }
    urls.push(`https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard${q.length ? '?' + q.join('&') : ''}`);
  };
  for (const d of scoreboardDates(dateISO)) {
    if (isNcaaf) {
      // groups=90 = D1 (FBS+FCS). groups=80 = FBS (and some ESPN views treat it as
      // the featured/FBS slate). Merge both so FCS legs still grade.
      push(d, '90');
      push(d, '80');
    } else {
      push(d, null);
    }
  }
  return [...new Set(urls)];
}

function mapEvent(ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const away = (comp.competitors || []).find(c => c.homeAway === 'away');
  const home = (comp.competitors || []).find(c => c.homeAway === 'home');
  if (!away || !home) return null;
  const status = comp.status || ev.status || {};
  return {
    awayTeam: (away.team && (away.team.displayName || away.team.shortDisplayName)) || '',
    awayAbbr: (away.team && away.team.abbreviation) || '',
    awayScore: parseInt(away.score, 10) || 0,
    awayLine: (away.linescores || []).map(x => parseInt(x.value, 10) || 0),
    homeTeam: (home.team && (home.team.displayName || home.team.shortDisplayName)) || '',
    homeAbbr: (home.team && home.team.abbreviation) || '',
    homeScore: parseInt(home.score, 10) || 0,
    homeLine: (home.linescores || []).map(x => parseInt(x.value, 10) || 0),
    state: (status.type && status.type.state) || 'pre',
    statusName: (status.type && status.type.name) || '',
    completed: !!(status.type && status.type.completed),
    startISO: ev.date || comp.date || '',
    detail: (status.type && (status.type.shortDetail || status.type.detail)) || '',
  };
}

function gameKey(g) {
  const a = (g.awayAbbr || g.awayTeam || '').toLowerCase();
  const h = (g.homeAbbr || g.homeTeam || '').toLowerCase();
  return `${a}|${h}|${g.startISO || ''}`;
}

function mergeGames(lists) {
  const map = new Map();
  const rank = (g) => (g.state === 'in' ? 3 : g.state === 'post' ? 2 : 1);
  for (const list of lists) {
    for (const g of list || []) {
      const k = gameKey(g);
      const prev = map.get(k);
      if (!prev || rank(g) > rank(prev)) map.set(k, g);
    }
  }
  return [...map.values()];
}

async function fetchOne(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(mapEvent).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function fetchESPNScores(dateISO, sport) {
  const urls = scoreboardUrls(sport, dateISO);
  if (!urls.length) return [];
  const lists = await Promise.all(urls.map(fetchOne));
  return mergeGames(lists);
}

module.exports = {
  ESPN_ENDPOINTS,
  fetchESPNScores,
  scoreboardUrls,
  scoreboardDates,
  shiftIsoDate,
};
