// Shared ESPN scoreboard fetch for Omega / NFL / CFB KPI graders.
// Client live scores use a matching URL builder in daily-omega, nfl, and cfb pages.
//
// Why this exists:
// - Omega MAIN is MLB+NFL+NCAAF but get-results-omega previously had no NFL/NCAAF
//   endpoints, so football picks stayed `pending` forever.
// - NCAAF without groups=80/90 collapses to Top-25 and misses most FBS/FCS games.
// - Late-night / Hawaii / UTC spill: a pick stored on ET date D may live on ESPN
//   date D-1 or D+1. We fetch the adjacent calendar days and merge.

const { fetchScoreboardJson, ESPN_WEB_HOST } = require('../../../js/live-score');

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
    urls.push(`${ESPN_WEB_HOST}/apis/site/v2/sports/${endpoint}/scoreboard${q.length ? '?' + q.join('&') : ''}`);
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

function espnTeamId(side) {
  if (!side) return '';
  const team = side.team || {};
  const id = team.id || side.id || '';
  return id ? String(id) : '';
}

// Shootout text ESPN puts on status.type. "Final/SO" and "FINAL/SO" count.
// "Final/OT" and "Final/2OT" do not. A bare SO token must sit on a slash or
// whitespace so it does not match inside another word.
function shootoutBlob(status) {
  const type = (status && status.type) || {};
  return [type.detail, type.shortDetail, type.description, type.name].filter(Boolean).join(' ');
}

function textIsShootout(blob) {
  const text = String(blob || '');
  if (!text) return false;
  if (/shootout/i.test(text)) return true;
  if (/final\s*\/\s*so\b/i.test(text)) return true;
  if (/(^|[\s/])SO([\s/]|$)/i.test(text) && !/\b\d*\s*OT\b/i.test(text)) return true;
  return false;
}

function textIsOvertime(blob) {
  const text = String(blob || '');
  if (!text || textIsShootout(text)) return false;
  return /\b\d*\s*OT\b/i.test(text);
}

function lineEntryIsShootout(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.shootout === true) return true;
  const bits = [entry.periodType, entry.displayName, entry.abbreviation, entry.name, entry.label];
  const type = entry.type;
  if (type && typeof type === 'object') bits.push(type.text, type.abbreviation, type.description, type.name);
  else if (type) bits.push(type);
  const label = bits.filter(Boolean).join(' ');
  if (!label) return false;
  if (/shootout/i.test(label)) return true;
  if (/(^|[\s/])SO([\s/]|$)/i.test(label)) return true;
  return false;
}

function linescoreHasShootout(away, home) {
  const lists = [];
  if (away && Array.isArray(away.linescores)) lists.push(away.linescores);
  if (home && Array.isArray(home.linescores)) lists.push(home.linescores);
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    for (let j = 0; j < list.length; j++) {
      if (lineEntryIsShootout(list[j])) return true;
    }
  }
  return false;
}

function winnerFromScores(awayScore, homeScore) {
  const away = Number(awayScore);
  const home = Number(homeScore);
  if (!Number.isFinite(away) || !Number.isFinite(home)) return null;
  if (away > home) return 'away';
  if (home > away) return 'home';
  return null;
}

function sportIsNhl(sport) {
  const s = String(sport || '').toUpperCase();
  return s === 'NHL' || s === 'HOCKEY';
}

// Raw ESPN status + competitors. Does not rewrite scores.
// period > 4 is a shootout only for an NHL board that is not overtime
// (Final/OT, Final/2OT) and not a numbered extra (Final/10).
function detectNhlShootout(status, away, home, sport) {
  const blob = shootoutBlob(status);
  const period = Number(status && status.period) || 0;
  const flagged = !!(status && (status.shootout === true || (status.type && status.type.shootout === true)));
  let shootout = flagged || textIsShootout(blob) || linescoreHasShootout(away, home);
  if (!shootout && sportIsNhl(sport) && period > 4 && !textIsOvertime(blob) && !/final\s*\/\s*\d+\b/i.test(blob)) {
    shootout = true;
  }
  const awayScore = away ? (parseInt(away.score, 10) || 0) : 0;
  const homeScore = home ? (parseInt(home.score, 10) || 0) : 0;
  return {
    shootout: shootout,
    shootoutWinner: shootout ? winnerFromScores(awayScore, homeScore) : null,
  };
}

// Normalized game (detail / period / linescore objects / shootout flag).
function shootoutFromGame(game, sport) {
  if (!game) return { shootout: false, shootoutWinner: null };
  if (game.shootout === true) {
    return { shootout: true, shootoutWinner: winnerFromScores(game.awayScore, game.homeScore) };
  }
  const awayLines = game.awayLineMeta || game.awayLinescores || game.awayLine;
  const homeLines = game.homeLineMeta || game.homeLinescores || game.homeLine;
  // Card pages store shortDetail || detail on game.detail. Keep that, and
  // any separate statusDetail / shortDetail, in the blob the detector reads.
  return detectNhlShootout({
    period: game.period,
    shootout: game.shootout,
    type: {
      detail: [game.statusDetail, game.detail].filter(Boolean).join(' '),
      shortDetail: game.shortDetail || '',
      description: game.statusDescription || game.description || '',
      name: game.statusName || '',
    },
  }, {
    score: game.awayScore,
    linescores: Array.isArray(awayLines) ? awayLines : [],
  }, {
    score: game.homeScore,
    linescores: Array.isArray(homeLines) ? homeLines : [],
  }, sport || game.sport || game._sport);
}

function mapEvent(ev, sport) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const away = (comp.competitors || []).find(c => c.homeAway === 'away');
  const home = (comp.competitors || []).find(c => c.homeAway === 'home');
  if (!away || !home) return null;
  const status = comp.status || ev.status || {};
  const so = detectNhlShootout(status, away, home, sport);
  return {
    awayTeam: (away.team && (away.team.displayName || away.team.shortDisplayName)) || '',
    awayAbbr: (away.team && away.team.abbreviation) || '',
    awayId: espnTeamId(away),
    awayScore: parseInt(away.score, 10) || 0,
    awayLine: (away.linescores || []).map(x => parseInt(x.value, 10) || 0),
    homeTeam: (home.team && (home.team.displayName || home.team.shortDisplayName)) || '',
    homeAbbr: (home.team && home.team.abbreviation) || '',
    homeId: espnTeamId(home),
    homeScore: parseInt(home.score, 10) || 0,
    homeLine: (home.linescores || []).map(x => parseInt(x.value, 10) || 0),
    state: (status.type && status.type.state) || 'pre',
    statusName: (status.type && status.type.name) || '',
    completed: !!(status.type && status.type.completed),
    period: status.period || 0,
    startISO: ev.date || comp.date || '',
    detail: (status.type && (status.type.shortDetail || status.type.detail)) || '',
    // Official scores stay the ESPN final (shootout goal included).
    shootout: so.shootout,
    shootoutWinner: so.shootoutWinner,
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

async function fetchOne(url, sport) {
  try {
    const data = await fetchScoreboardJson(url);
    if (!data) return [];
    return (data.events || []).map(ev => mapEvent(ev, sport)).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function fetchESPNScores(dateISO, sport) {
  const urls = scoreboardUrls(sport, dateISO);
  if (!urls.length) return [];
  const lists = await Promise.all(urls.map(url => fetchOne(url, sport)));
  return mergeGames(lists);
}

module.exports = {
  ESPN_ENDPOINTS,
  fetchESPNScores,
  scoreboardUrls,
  scoreboardDates,
  shiftIsoDate,
  mapEvent,
  detectNhlShootout,
  shootoutFromGame,
};
