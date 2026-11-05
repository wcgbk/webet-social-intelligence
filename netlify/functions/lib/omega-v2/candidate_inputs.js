'use strict';

/**
 * Compact context recorded for every scored candidate at card build.
 * Read-only. A failure here returns an empty log and never changes a
 * probability, pick, stake, letter, or parlay.
 * Public ESPN pages only. No odds feed.
 */

const { fitWalkForward, applyCalibration } = require('./calibrate');
const { etCalendarDate } = require('../omega-vnext/odds_math');

const MAX_INPUT_ROWS = 240;
const MAX_INPUT_BYTES = 240000;
const FETCH_TIMEOUT_MS = 4000;
const FETCH_CONCURRENCY = 4;
const INJURY_CAP = 4;
// College football midweek cards sit 10–13 days after the previous Saturday.
const LOOKBACK_DAYS = { NFL: 8, NCAAF: 14, MLB: 5, NBA: 5, NHL: 6, NCAAM: 5 };

const ESPN_PATH = {
  MLB: ['baseball', 'mlb'],
  NFL: ['football', 'nfl'],
  NCAAF: ['football', 'college-football'],
  NBA: ['basketball', 'nba'],
  NHL: ['hockey', 'nhl'],
  NCAAM: ['basketball', 'mens-college-basketball'],
};

/** Approximate arena coordinates, decimal degrees. Missing clubs stay null. */
const CITY_ROWS = [
  ['NHL', 'bruins', 42.366, -71.062], ['NHL', 'sabres', 42.875, -78.877],
  ['NHL', 'red wings', 42.341, -83.055], ['NHL', 'panthers', 26.158, -80.326],
  ['NHL', 'canadiens', 45.496, -73.570], ['NHL', 'senators', 45.297, -75.927],
  ['NHL', 'lightning', 27.943, -82.452], ['NHL', 'maple leafs', 43.643, -79.379],
  ['NHL', 'hurricanes', 35.803, -78.722], ['NHL', 'blue jackets', 39.969, -83.006],
  ['NHL', 'devils', 40.734, -74.171], ['NHL', 'islanders', 40.723, -73.591],
  ['NHL', 'rangers', 40.751, -73.994], ['NHL', 'flyers', 39.901, -75.172],
  ['NHL', 'penguins', 40.439, -79.989], ['NHL', 'capitals', 38.898, -77.021],
  ['NHL', 'blackhawks', 41.881, -87.673], ['NHL', 'avalanche', 39.739, -104.985],
  ['NHL', 'stars', 32.791, -96.810], ['NHL', 'wild', 44.945, -93.101],
  ['NHL', 'predators', 36.159, -86.779], ['NHL', 'blues', 38.627, -90.202],
  ['NHL', 'jets', 49.893, -97.144], ['NHL', 'ducks', 33.808, -117.877],
  ['NHL', 'flames', 51.037, -114.052], ['NHL', 'oilers', 53.547, -113.498],
  ['NHL', 'kings', 34.043, -118.267], ['NHL', 'sharks', 37.333, -121.901],
  ['NHL', 'kraken', 47.622, -122.354], ['NHL', 'canucks', 49.278, -123.109],
  ['NHL', 'golden knights', 36.103, -115.178], ['NHL', 'mammoth', 40.768, -111.901],
  ['NHL', 'hockey club', 40.768, -111.901],
  ['NBA', 'hawks', 33.757, -84.396], ['NBA', 'celtics', 42.366, -71.062],
  ['NBA', 'nets', 40.683, -73.975], ['NBA', 'hornets', 35.225, -80.839],
  ['NBA', 'bulls', 41.881, -87.674], ['NBA', 'cavaliers', 41.497, -81.688],
  ['NBA', 'mavericks', 32.791, -96.810], ['NBA', 'nuggets', 39.749, -105.008],
  ['NBA', 'pistons', 42.341, -83.055], ['NBA', 'warriors', 37.768, -122.388],
  ['NBA', 'rockets', 29.751, -95.362], ['NBA', 'pacers', 39.764, -86.156],
  ['NBA', 'clippers', 34.043, -118.267], ['NBA', 'lakers', 34.043, -118.267],
  ['NBA', 'grizzlies', 35.138, -90.051], ['NBA', 'heat', 25.781, -80.187],
  ['NBA', 'bucks', 43.045, -87.917], ['NBA', 'timberwolves', 44.980, -93.276],
  ['NBA', 'pelicans', 29.949, -90.082], ['NBA', 'knicks', 40.751, -73.994],
  ['NBA', 'thunder', 35.463, -97.515], ['NBA', 'magic', 28.539, -81.384],
  ['NBA', '76ers', 39.901, -75.172], ['NBA', 'sixers', 39.901, -75.172],
  ['NBA', 'suns', 33.446, -112.071], ['NBA', 'trail blazers', 45.532, -122.667],
  ['NBA', 'blazers', 45.532, -122.667], ['NBA', 'kings', 38.580, -121.500],
  ['NBA', 'spurs', 29.427, -98.438], ['NBA', 'raptors', 43.643, -79.379],
  ['NBA', 'jazz', 40.768, -111.901], ['NBA', 'wizards', 38.898, -77.021],
  ['NFL', 'cardinals', 33.528, -112.263], ['NFL', 'falcons', 33.755, -84.401],
  ['NFL', 'ravens', 39.278, -76.623], ['NFL', 'bills', 42.774, -78.787],
  ['NFL', 'panthers', 35.226, -80.853], ['NFL', 'bears', 41.863, -87.617],
  ['NFL', 'bengals', 39.095, -84.516], ['NFL', 'browns', 41.506, -81.700],
  ['NFL', 'cowboys', 32.748, -97.093], ['NFL', 'broncos', 39.744, -105.020],
  ['NFL', 'lions', 42.340, -83.046], ['NFL', 'packers', 44.501, -88.062],
  ['NFL', 'texans', 29.685, -95.411], ['NFL', 'colts', 39.760, -86.164],
  ['NFL', 'jaguars', 30.324, -81.637], ['NFL', 'chiefs', 39.049, -94.484],
  ['NFL', 'raiders', 36.091, -115.184], ['NFL', 'chargers', 33.953, -118.339],
  ['NFL', 'rams', 33.953, -118.339], ['NFL', 'dolphins', 25.958, -80.239],
  ['NFL', 'vikings', 44.974, -93.258], ['NFL', 'patriots', 42.091, -71.264],
  ['NFL', 'saints', 29.951, -90.081], ['NFL', 'giants', 40.813, -74.074],
  ['NFL', 'jets', 40.813, -74.074], ['NFL', 'eagles', 39.901, -75.168],
  ['NFL', 'steelers', 40.447, -80.016], ['NFL', '49ers', 37.403, -121.970],
  ['NFL', 'seahawks', 47.595, -122.332], ['NFL', 'buccaneers', 27.976, -82.503],
  ['NFL', 'titans', 36.166, -86.771], ['NFL', 'commanders', 38.908, -76.864],
  ['MLB', 'diamondbacks', 33.445, -112.067], ['MLB', 'braves', 33.890, -84.468],
  ['MLB', 'orioles', 39.284, -76.622], ['MLB', 'red sox', 42.347, -71.098],
  ['MLB', 'cubs', 41.948, -87.656], ['MLB', 'white sox', 41.830, -87.634],
  ['MLB', 'reds', 39.097, -84.507], ['MLB', 'guardians', 41.496, -81.685],
  ['MLB', 'rockies', 39.756, -104.994], ['MLB', 'tigers', 42.339, -83.049],
  ['MLB', 'astros', 29.757, -95.355], ['MLB', 'royals', 39.051, -94.480],
  ['MLB', 'angels', 33.800, -117.883], ['MLB', 'dodgers', 34.074, -118.240],
  ['MLB', 'marlins', 25.778, -80.220], ['MLB', 'brewers', 43.028, -87.971],
  ['MLB', 'twins', 44.982, -93.278], ['MLB', 'mets', 40.757, -73.846],
  ['MLB', 'yankees', 40.829, -73.926], ['MLB', 'athletics', 38.580, -121.500],
  ['MLB', 'phillies', 39.906, -75.166], ['MLB', 'pirates', 40.447, -80.006],
  ['MLB', 'padres', 32.707, -117.157], ['MLB', 'giants', 37.778, -122.389],
  ['MLB', 'mariners', 47.591, -122.333], ['MLB', 'cardinals', 38.623, -90.193],
  ['MLB', 'rays', 27.768, -82.653], ['MLB', 'rangers', 32.747, -97.084],
  ['MLB', 'blue jays', 43.641, -79.389], ['MLB', 'nationals', 38.873, -77.008],
];

const CITIES = {};
for (const [sport, nick, lat, lon] of CITY_ROWS) {
  if (!CITIES[sport]) CITIES[sport] = {};
  CITIES[sport][nick] = [lat, lon];
}

function inputsLoggingEnabled(opts, env) {
  const options = opts || {};
  if (Object.prototype.hasOwnProperty.call(options, 'logInputs') && options.logInputs != null) {
    return !!options.logInputs;
  }
  const source = env == null ? process.env : env;
  const flag = source && source.OMEGA_CANDIDATE_INPUTS;
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return true;
}

function safeMsg(err) {
  const msg = String(err && err.message || 'error');
  if (/bearer|token|authorization|api[_-]?key/i.test(msg)) return 'unavailable';
  return msg.slice(0, 180);
}

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    // Odds feeds shorten State to St. Applied to both sides, so Saint
    // names that already agree (St Louis / St. Louis) still agree.
    .replace(/\bst\b/g, 'state')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameTeam(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length > 3 && (long === short || long.endsWith(` ${short}`))) return true;
  return false;
}

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function prob(value) {
  if (value == null || value === '') return null;
  const n = Number(typeof value === 'string' ? value.replace('%', '') : value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) return n;
  if ((typeof value === 'string' && value.includes('%')) || (n > 1 && n <= 100)) return n / 100;
  return null;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

function sportOf(cand) {
  return String(cand && cand.sport || '').toUpperCase();
}

function teamsOf(cand) {
  let home = cand && cand.homeTeam ? String(cand.homeTeam) : '';
  let away = cand && cand.awayTeam ? String(cand.awayTeam) : '';
  if ((!home || !away) && cand && cand.matchup && String(cand.matchup).includes('@')) {
    const parts = String(cand.matchup).split('@');
    if (!away) away = String(parts[0] || '').trim();
    if (!home) home = String(parts[1] || '').trim();
  }
  return { home: home || null, away: away || null };
}

function addDays(iso, delta) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function daysBetween(earlier, later) {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function rowKeyOf(cand, idx) {
  try {
    const { rowKey } = require('./candidate_clv');
    if (cand && typeof cand === 'object') return rowKey(cand);
  } catch (_) { /* key fallback */ }
  return `unkeyed|${idx}`;
}

function pModelOf(cand) {
  if (!cand) return null;
  return prob(cand.modelRawP != null ? cand.modelRawP : (cand.p_model != null ? cand.p_model : cand.pModel));
}

function pMktOf(cand) {
  if (!cand) return null;
  return prob(cand.pMkt != null ? cand.pMkt : (cand.fair_sharp_p != null ? cand.fair_sharp_p : cand.sharpFairP));
}

/** Pinnacle no-vig when that book is the anchor. A different sharp book stays null. */
function pFairOf(cand) {
  if (!cand) return null;
  const pin = prob(cand.p_pinnacle != null ? cand.p_pinnacle : cand.pinnacleNoVig);
  if (pin != null) return pin;
  const anchor = String(cand.sharpAnchorBook || '').toLowerCase();
  if (anchor && anchor !== 'pinnacle') return null;
  return prob(cand.fair_sharp_p != null ? cand.fair_sharp_p : cand.sharpFairP);
}

function pCalOf(cand, fit) {
  const pModel = pModelOf(cand);
  const pMkt = pMktOf(cand);
  if (!fit || pModel == null || pMkt == null) return null;
  try {
    const cal = applyCalibration({
      sport: cand.sport,
      market: cand.market || cand.betType,
      pick: cand.pick || cand.side,
      pModel,
      pMkt,
    }, fit);
    return cal && Number.isFinite(cal.pCal) ? round4(cal.pCal) : null;
  } catch (_) {
    return null;
  }
}

function safeFit(history, dateISO, boardRows) {
  try {
    // Walk-forward reads pModel. Give it copies so a fit cannot rewrite the card's history.
    const rows = (Array.isArray(history) ? history : []).map((row) => (
      row && typeof row === 'object' ? { ...row } : row
    ));
    const boards = (Array.isArray(boardRows) ? boardRows : []).map((row) => (
      row && typeof row === 'object' ? { ...row } : row
    ));
    return fitWalkForward(rows, dateISO, { boardRows: boards });
  } catch (_) {
    return null;
  }
}

function cityOf(sport, team) {
  const table = CITIES[sport];
  if (!table || !team) return null;
  const parts = fold(team).split(' ').filter(Boolean);
  for (let n = Math.min(3, parts.length); n >= 1; n -= 1) {
    const nick = parts.slice(-n).join(' ');
    if (table[nick]) return table[nick];
  }
  return null;
}

function milesBetween(sport, home, away) {
  const a = cityOf(sport, home);
  const b = cityOf(sport, away);
  if (!a || !b) return null;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const miles = 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (!Number.isFinite(miles)) return null;
  return Math.round(miles);
}

function boundInputRows(rows) {
  let list = (rows || []).filter((row) => row && row.rowKey);
  let capped = false;
  const tooBig = () => {
    try { return JSON.stringify(list).length > MAX_INPUT_BYTES; } catch (_) { return true; }
  };
  if (list.length > MAX_INPUT_ROWS) {
    capped = true;
    list = list.slice(0, MAX_INPUT_ROWS);
  }
  if (tooBig()) {
    capped = true;
    list = list.map((row) => ({
      ...row,
      injuries: {
        home: ((row.injuries && row.injuries.home) || []).slice(0, 2),
        away: ((row.injuries && row.injuries.away) || []).slice(0, 2),
      },
    }));
  }
  if (tooBig()) {
    capped = true;
    list = list.map((row) => ({
      ...row,
      injuries: { home: [], away: [] },
      travel: row.travel
        ? { awayRoadGames: row.travel.awayRoadGames, approxMiles: null }
        : row.travel,
    }));
  }
  while (list.length && tooBig()) {
    capped = true;
    list.pop();
  }
  return { rows: list, capped };
}

function packInputs(result) {
  try {
    if (!result) return null;
    const rows = Array.isArray(result) ? result : result.rows;
    if (!Array.isArray(rows) || !rows.length) return null;
    const bounded = boundInputRows(rows);
    const bySport = {};
    for (const row of bounded.rows) {
      const sport = String(row && row.sport || 'UNK').toUpperCase() || 'UNK';
      bySport[sport] = (bySport[sport] || 0) + 1;
    }
    return {
      rows: bounded.rows,
      meta: {
        bySport,
        total: bounded.rows.length,
        scored: result && result.scored != null ? result.scored : rows.length,
        capped: !!bounded.capped,
      },
    };
  } catch (_) {
    return null;
  }
}

function applyStoredInputs(clvData, existingInputs) {
  if (!clvData || typeof clvData !== 'object' || clvData.candidateInputs) return;
  const packed = packInputs(existingInputs);
  if (!packed) return;
  clvData.candidateInputs = packed.rows;
  if (!clvData.candidateInputsMeta) clvData.candidateInputsMeta = packed.meta;
}

function statusRank(status) {
  const st = String(status || '').toLowerCase();
  if (/out|injured reserve|\bir\b|ruled out/.test(st)) return 'out';
  if (/doubtful/.test(st)) return 'doubtful';
  return null;
}

function injuryRowsFromPayload(data) {
  const out = [];
  const push = (team, inj) => {
    if (!inj || typeof inj !== 'object') return;
    const status = statusRank(
      inj.status
      || inj.type
      || (inj.type && inj.type.description)
      || (inj.details && inj.details.fantasyStatus && inj.details.fantasyStatus.description)
    );
    if (!status) return;
    const athlete = inj.athlete || {};
    const name = clipText(athlete.displayName || athlete.fullName || inj.displayName || inj.name, 40);
    if (!name) return;
    const posRaw = (athlete.position && (athlete.position.abbreviation || athlete.position.name))
      || inj.position
      || '';
    const pos = clipText(typeof posRaw === 'string' ? posRaw : '', 6);
    const starter = inj.starter === true || athlete.starter === true;
    out.push({
      team: team || null,
      name,
      pos: pos ? pos.toUpperCase() : null,
      status,
      starter,
    });
  };
  const blocks = []
    .concat((data && data.injuries) || [])
    .concat((data && data.teams) || []);
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const team = (block.displayName || (block.team && block.team.displayName) || block.teamName || '');
    const list = block.injuries || block.athletes || [];
    if (Array.isArray(list) && list.length) {
      for (const inj of list) push(team, inj);
    } else if (block.athlete || block.status || block.displayName) {
      push(team, block);
    }
  }
  if (!out.length && data && Array.isArray(data.items)) {
    for (const item of data.items) {
      const team = (item && item.team && item.team.displayName) || '';
      push(team, item);
    }
  }
  return out;
}

function injuriesFor(list, team) {
  const rows = (list || []).filter((row) => sameTeam(row.team, team) && (row.status === 'out' || row.status === 'doubtful'));
  rows.sort((a, b) => {
    if (a.starter !== b.starter) return a.starter ? -1 : 1;
    if (a.status !== b.status) return a.status === 'out' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  const seen = new Set();
  const capped = [];
  for (const row of rows) {
    const key = fold(row.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    capped.push({ name: row.name, pos: row.pos || null, status: row.status });
    if (capped.length >= INJURY_CAP) break;
  }
  return capped;
}

function gamesFromScoreboard(data, sport, dateHint) {
  const games = [];
  for (const ev of (data && data.events) || []) {
    const comp = (ev && ev.competitions && ev.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c && c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find((c) => c && c.homeAway === 'away') || competitors[1] || {};
    const homeName = (home.team && (home.team.displayName || home.team.name)) || '';
    const awayName = (away.team && (away.team.displayName || away.team.name)) || '';
    if (!homeName || !awayName) continue;
    const commence = ev.date || comp.date || null;
    const date = etCalendarDate(commence) || dateHint || null;
    if (!date) continue;
    games.push({
      sport,
      date,
      home: homeName,
      away: awayName,
    });
  }
  return games;
}

function espnGamesOf(snap) {
  const out = [];
  const bySport = snap && snap.espnBySport;
  if (!bySport || typeof bySport !== 'object') return out;
  for (const [sport, board] of Object.entries(bySport)) {
    const games = board && Array.isArray(board.games) ? board.games : (Array.isArray(board) ? board : []);
    for (const game of games) {
      if (!game) continue;
      out.push({ ...game, sport: sportOf({ sport: game.sport || sport }) });
    }
  }
  return out;
}

function findGame(games, sport, home, away) {
  for (const game of games || []) {
    if (sport && game.sport && sportOf(game) !== sport) continue;
    const gHome = game.homeTeam || game.home;
    const gAway = game.awayTeam || game.away;
    if (sameTeam(gHome, home) && sameTeam(gAway, away)) return game;
  }
  return null;
}

function addTeamDate(index, sport, team, date, road) {
  if (!team || !date) return;
  const key = `${sport}|${fold(team)}`;
  if (!index.has(key)) index.set(key, []);
  const list = index.get(key);
  const hit = list.find((row) => row.date === date);
  if (hit) {
    if (hit.road == null && road != null) hit.road = road;
    return;
  }
  list.push({ date, road: road == null ? null : !!road });
}

function datesFor(index, sport, team) {
  const direct = index.get(`${sport}|${fold(team)}`);
  if (direct) return direct.slice();
  const target = fold(team);
  if (!target) return [];
  for (const [key, rows] of index) {
    if (!key.startsWith(`${sport}|`)) continue;
    const name = key.slice(sport.length + 1);
    if (sameTeam(name, target)) return rows.slice();
  }
  return [];
}

function restFor(index, sport, team, gameDate) {
  const prior = datesFor(index, sport, team)
    .filter((row) => row.date && row.date < gameDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!prior.length) return { restDays: null, backToBack: null };
  const restDays = daysBetween(prior[prior.length - 1].date, gameDate);
  if (restDays == null || restDays < 0) return { restDays: null, backToBack: null };
  return { restDays, backToBack: restDays <= 1 };
}

function roadStreak(index, sport, team, gameDate) {
  const rows = datesFor(index, sport, team).slice();
  if (!rows.some((row) => row.date === gameDate)) rows.push({ date: gameDate, road: true });
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].date > gameDate) continue;
    if (rows[i].road === true) streak += 1;
    else break;
  }
  return streak;
}

function notePlayedYesterday(index, sport, restMap, gameDate) {
  const prev = addDays(gameDate, -1);
  if (!prev || !restMap || typeof restMap !== 'object') return;
  for (const [team, row] of Object.entries(restMap)) {
    if (!row || row.playedYesterday !== true) continue;
    addTeamDate(index, sport, team, prev, null);
  }
}

function probableName(game, side) {
  if (!game) return null;
  const probable = side === 'home' ? game.homeProbable : game.awayProbable;
  if (probable && probable.name) return clipText(probable.name, 40);
  const raw = side === 'home' ? game.homeProbablesRaw : game.awayProbablesRaw;
  if (!Array.isArray(raw)) return null;
  for (const row of raw) {
    const athlete = row && row.athlete;
    const name = (athlete && (athlete.displayName || athlete.fullName)) || (row && row.name) || null;
    if (name) return clipText(name, 40);
  }
  return null;
}

function qbListed(map, team) {
  if (!map || typeof map !== 'object') return null;
  if (map[team]) return map[team];
  for (const [key, row] of Object.entries(map)) {
    if (sameTeam(key, team) || (row && sameTeam(row.team, team))) return row;
  }
  return null;
}

function qbSide(sport, team, game, side, qbMaps) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  const listed = qbListed(qbMaps && qbMaps[sport], team);
  const probable = probableName(game, side);
  const listedName = listed && listed.qbName ? clipText(listed.qbName, 40) : null;
  const listedStatus = listed && listed.qbStatus ? statusRank(listed.qbStatus) || clipText(listed.qbStatus, 16) : null;
  if (probable) {
    const same = listedName && sameTeam(listedName, probable);
    return { name: probable, status: same && listedStatus ? listedStatus : 'probable' };
  }
  if (listedName) return { name: listedName, status: listedStatus || 'listed' };
  return null;
}

function slimGoalie(goalie) {
  if (!goalie || typeof goalie !== 'object') return null;
  const name = clipText(
    goalie.name
    || (goalie.athlete && (goalie.athlete.displayName || goalie.athlete.fullName))
    || goalie.displayName,
    40
  );
  if (!name) return null;
  const st = String(goalie.status || '').toLowerCase();
  let status = 'unknown';
  if (goalie.confirmed === true || st === 'confirmed' || st === 'starter') status = 'confirmed';
  else if (goalie.probable === true || st === 'probable') status = 'probable';
  else if (goalie.confirmed === false) status = 'unconfirmed';
  return { name, status };
}

function goaliePair(sport, game) {
  if (sport !== 'NHL' || !game) return null;
  const home = slimGoalie(game.homeGoalie);
  const away = slimGoalie(game.awayGoalie);
  if (!home && !away) return null;
  return { home, away };
}

function qbPair(sport, game, qbMaps, home, away) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  const homeQb = qbSide(sport, home, game, 'home', qbMaps);
  const awayQb = qbSide(sport, away, game, 'away', qbMaps);
  if (!homeQb && !awayQb) return null;
  return { home: homeQb, away: awayQb };
}

function indexSchedule(games) {
  const index = new Map();
  for (const game of games || []) {
    if (!game) continue;
    const sport = sportOf(game);
    const home = game.home || game.homeTeam;
    const away = game.away || game.awayTeam;
    const date = game.date || etCalendarDate(game.commenceTime);
    if (!sport || !date || !home || !away) continue;
    addTeamDate(index, sport, home, date, false);
    addTeamDate(index, sport, away, date, true);
  }
  return index;
}

function blankRow(cand, idx) {
  let key = `unkeyed|${idx}`;
  try { key = rowKeyOf(cand, idx); } catch (_) { /* keep fallback */ }
  return {
    rowKey: key,
    sport: sportOf(cand) || null,
    matchup: clipText(cand && cand.matchup, 80),
    side: clipText(cand && (cand.side || cand.pick), 60),
    market: clipText(cand && (cand.market || cand.betType), 24),
    rest: {
      home: { restDays: null, backToBack: null },
      away: { restDays: null, backToBack: null },
    },
    travel: { awayRoadGames: null, approxMiles: null },
    injuries: { home: [], away: [] },
    goalie: null,
    qb: null,
    pModel: round4(pModelOf(cand)),
    pFair: round4(pFairOf(cand)),
    pCal: null,
  };
}

function oneInput(cand, idx, ctx, fit) {
  const base = blankRow(cand, idx);
  try {
    const sport = base.sport;
    const gameDate = etCalendarDate(cand && cand.commenceTime) || ctx.dateISO || null;
    const { home, away } = teamsOf(cand);
    if (sport && gameDate && home) base.rest.home = restFor(ctx.index, sport, home, gameDate);
    if (sport && gameDate && away) base.rest.away = restFor(ctx.index, sport, away, gameDate);
    if (sport && gameDate && away) {
      base.travel = {
        awayRoadGames: roadStreak(ctx.index, sport, away, gameDate),
        approxMiles: milesBetween(sport, home, away),
      };
    }
    const list = (ctx.injuries && ctx.injuries[sport]) || [];
    base.injuries = {
      home: home ? injuriesFor(list, home) : [],
      away: away ? injuriesFor(list, away) : [],
    };
    const game = findGame(ctx.espnGames, sport, home, away);
    base.goalie = goaliePair(sport, game);
    base.qb = qbPair(sport, game, ctx.qbMaps, home, away);
    base.pModel = round4(pModelOf(cand));
    base.pFair = round4(pFairOf(cand));
    base.pCal = pCalOf(cand, fit);
    return base;
  } catch (_) {
    try { base.pCal = pCalOf(cand, fit); } catch (__) { /* leave null */ }
    return base;
  }
}

function countBySport(rows) {
  const bySport = {};
  for (const row of rows || []) {
    const sport = String(row && row.sport || 'UNK').toUpperCase() || 'UNK';
    bySport[sport] = (bySport[sport] || 0) + 1;
  }
  return bySport;
}

async function defaultFetch(url) {
  const pull = globalThis.fetch;
  if (typeof pull !== 'function') return null;
  const resp = await pull(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp || !resp.ok) return null;
  return resp.json();
}

async function loadJson(url, loader, cache) {
  const href = String(url || '');
  if (cache.has(href)) return cache.get(href);
  // Public ESPN scoreboard and injury pages only.
  if (!/^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\//i.test(href)) {
    cache.set(href, null);
    return null;
  }
  let data = null;
  try {
    data = await loader(href);
  } catch (_) {
    data = null;
  }
  if (!data || typeof data !== 'object') data = null;
  cache.set(href, data);
  return data;
}

async function mapLimit(items, limit, fn) {
  const list = items || [];
  if (!list.length) return;
  let cursor = 0;
  const workers = Math.min(Math.max(limit, 1), list.length);
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      try { await fn(list[idx], idx); } catch (_) { /* one date is optional */ }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function loadContext(candidates, opts) {
  const dateISO = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.dateISO || '')) ? String(opts.dateISO) : null;
  const espnGames = espnGamesOf(opts.snap);
  const schedule = [];
  const pushSchedule = (game) => {
    if (!game || typeof game !== 'object') return;
    const date = game.date || etCalendarDate(game.commenceTime);
    const home = game.homeTeam || game.home || null;
    const away = game.awayTeam || game.away || null;
    // A row with no home was never indexed. Copy the fields either way.
    if (!date || !home) return;
    schedule.push({
      sport: sportOf(game),
      date,
      home,
      away,
    });
  };
  for (const game of opts.scheduleGames || []) pushSchedule(game);
  for (const game of espnGames) pushSchedule(game);
  const injuries = {};
  for (const [sport, list] of Object.entries(opts.injuriesBySport || {})) {
    injuries[String(sport).toUpperCase()] = Array.isArray(list)
      ? list.map((row) => (row && typeof row === 'object' ? { ...row } : row))
      : [];
  }
  if (Array.isArray(opts.injuries)) {
    for (const row of opts.injuries) {
      const sport = sportOf(row) || 'ALL';
      if (!injuries[sport]) injuries[sport] = [];
      injuries[sport].push(row && typeof row === 'object' ? { ...row } : row);
    }
  }
  const sports = [...new Set((candidates || []).map(sportOf).filter((s) => ESPN_PATH[s]))];
  const skipFetch = !!(opts.skipFetch || opts.replayLike || opts.historicalSnapshot);
  if (!skipFetch && dateISO && sports.length) {
    const loader = typeof opts.fetchJson === 'function' ? opts.fetchJson : defaultFetch;
    const cache = opts.cache instanceof Map ? opts.cache : new Map();
    const jobs = [];
    for (const sport of sports) {
      const back = LOOKBACK_DAYS[sport] || 4;
      for (let i = 1; i <= back; i += 1) {
        const day = addDays(dateISO, -i);
        if (day) jobs.push({ sport, day, kind: 'board' });
      }
      if (!injuries[sport]) jobs.push({ sport, kind: 'inj' });
    }
    await mapLimit(jobs, FETCH_CONCURRENCY, async (job) => {
      const path = ESPN_PATH[job.sport];
      if (!path) return;
      if (job.kind === 'inj') {
        const url = `https://site.api.espn.com/apis/site/v2/sports/${path[0]}/${path[1]}/injuries`;
        const data = await loadJson(url, loader, cache);
        injuries[job.sport] = injuryRowsFromPayload(data);
        return;
      }
      const ymd = job.day.replace(/-/g, '');
      // The bare college basketball board is a short featured list.
      // groups=50 is the public Division I board.
      const group = job.sport === 'NCAAM' ? '&groups=50' : '';
      const url = `https://site.api.espn.com/apis/site/v2/sports/${path[0]}/${path[1]}/scoreboard?dates=${ymd}&limit=400${group}`;
      const data = await loadJson(url, loader, cache);
      for (const game of gamesFromScoreboard(data, job.sport, job.day)) schedule.push(game);
    });
  }
  schedule.sort((a, b) => (
    String(a.date).localeCompare(String(b.date))
    || String(a.sport).localeCompare(String(b.sport))
    || String(a.home).localeCompare(String(b.home))
    || String(a.away).localeCompare(String(b.away))
  ));
  const index = indexSchedule(schedule);
  const restBySport = (opts.snap && opts.snap.gameDay && opts.snap.gameDay.restByTeam) || {};
  if (dateISO && restBySport && typeof restBySport === 'object') {
    for (const sport of sports) notePlayedYesterday(index, sport, restBySport[sport], dateISO);
  }
  const qbMaps = (opts.snap && opts.snap.gameDay && opts.snap.gameDay.qbStatusBySport) || {};
  return { dateISO, index, injuries, espnGames, qbMaps };
}

async function recordCandidateInputs(opts = {}) {
  try {
    const candidates = (Array.isArray(opts.candidates) ? opts.candidates : []).map((cand) => (
      cand && typeof cand === 'object' ? { ...cand } : cand
    ));
    if (!candidates.length) {
      return { rows: [], bySport: {}, total: 0, scored: 0, capped: false };
    }
    const dateISO = String(opts.dateISO || opts.date || '');
    const ctx = await loadContext(candidates, { ...opts, dateISO });
    const fit = safeFit(opts.history, dateISO, opts.boardRows);
    const rows = candidates.map((cand, idx) => {
      try { return oneInput(cand, idx, ctx, fit); } catch (_) { return blankRow(cand, idx); }
    });
    const bounded = boundInputRows(rows);
    const bySport = countBySport(bounded.rows);
    const parts = Object.keys(bySport).sort().map((sport) => `${sport}=${bySport[sport]}`);
    let goalie = 0;
    let qb = 0;
    let inj = 0;
    let rest = 0;
    for (const row of bounded.rows) {
      if (row.goalie && (row.goalie.home || row.goalie.away)) goalie += 1;
      if (row.qb && (row.qb.home || row.qb.away)) qb += 1;
      const homeInj = (row.injuries && row.injuries.home) || [];
      const awayInj = (row.injuries && row.injuries.away) || [];
      if (homeInj.length || awayInj.length) inj += 1;
      const homeRest = row.rest && row.rest.home;
      const awayRest = row.rest && row.rest.away;
      if ((homeRest && homeRest.restDays != null) || (awayRest && awayRest.restDays != null)) rest += 1;
    }
    console.log(`[candidate-inputs] ${parts.join(' ')} total=${bounded.rows.length} scored=${candidates.length} rest=${rest} injuries=${inj} goalie=${goalie} qb=${qb}${bounded.capped ? ' capped=1' : ''}`);
    return {
      rows: bounded.rows,
      bySport,
      total: bounded.rows.length,
      scored: candidates.length,
      capped: bounded.capped,
    };
  } catch (err) {
    console.warn(`[candidate-inputs] skipped: ${safeMsg(err)}`);
    return { rows: [], bySport: {}, total: 0, scored: 0, capped: false, error: true };
  }
}

module.exports = {
  MAX_INPUT_ROWS,
  MAX_INPUT_BYTES,
  inputsLoggingEnabled,
  recordCandidateInputs,
  packInputs,
  applyStoredInputs,
  boundInputRows,
  injuryRowsFromPayload,
  milesBetween,
};
