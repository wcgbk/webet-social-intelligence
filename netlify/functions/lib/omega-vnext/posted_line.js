'use strict';

/**
 * The page calls the number the posted line and tells the reader to bet it.
 * A spread or total that is no longer the DraftKings number on the ESPN
 * scoreboard is not that line. A row already flagged against Pinnacle
 * (model probability more than 12 points away, or a point gap past the
 * sport cap) is not a bet either. A missing quote does not hold the row.
 */

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quoteFromEspnEvent(event) {
  const comp = event && Array.isArray(event.competitions) ? event.competitions[0] : null;
  if (!comp) return null;
  const names = { home: '', away: '' };
  for (const team of comp.competitors || []) {
    const name = team && team.team && team.team.displayName;
    if (team && (team.homeAway === 'home' || team.homeAway === 'away') && name) {
      names[team.homeAway] = name;
    }
  }
  const odds = Array.isArray(comp.odds) ? comp.odds[0] : null;
  if (!odds || !names.home || !names.away) return null;
  const mag = finite(odds.spread);
  const abs = mag == null ? null : Math.abs(mag);
  const homeFav = !!(odds.homeTeamOdds && odds.homeTeamOdds.favorite);
  const awayFav = !!(odds.awayTeamOdds && odds.awayTeamOdds.favorite);
  let homeSpread = null;
  if (abs != null && homeFav) homeSpread = -abs;
  else if (abs != null && awayFav) homeSpread = abs;
  return {
    home: names.home,
    away: names.away,
    homeSpread,
    total: finite(odds.overUnder),
  };
}

function quotesFromScoreboard(data) {
  const events = data && Array.isArray(data.events) ? data.events : [];
  const quotes = [];
  for (const event of events) {
    const quote = quoteFromEspnEvent(event);
    if (quote) quotes.push(quote);
  }
  return quotes;
}

function sameTeam(a, b) {
  const left = normName(a);
  const right = normName(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function quoteForRow(row, quotes) {
  const home = row && (row.homeTeam || row.home_team);
  const away = row && (row.awayTeam || row.away_team);
  if (!home || !away) return null;
  for (const quote of quotes || []) {
    if (sameTeam(quote.home, home) && sameTeam(quote.away, away)) return quote;
  }
  return null;
}

function rowLine(row) {
  const direct = finite(row && row.line);
  if (direct != null) return direct;
  const text = String((row && (row.pick || row.side)) || '');
  const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
  return match ? finite(match[1]) : null;
}

function currentSpreadForRow(row, quote) {
  if (!quote || quote.homeSpread == null) return null;
  const text = String((row && (row.pick || row.side)) || '').toLowerCase();
  const away = normName(row && (row.awayTeam || row.away_team));
  const home = normName(row && (row.homeTeam || row.home_team));
  if (away && (text.startsWith(away) || text.startsWith(`${away} `))) return -quote.homeSpread;
  if (home && (text.startsWith(home) || text.startsWith(`${home} `))) return quote.homeSpread;
  return null;
}

/**
 * @returns {'pinnacle-sanity'|'line-moved'|null}
 */
function gameKey(row) {
  const away = normName(row && (row.awayTeam || row.away_team));
  const home = normName(row && (row.homeTeam || row.home_team));
  if (away && home) return `${away}|${home}`;
  const matchup = normName(row && row.matchup);
  return matchup || '';
}

/**
 * Games that have priced spreads, and none of those spreads is the current
 * DraftKings number. The moneyline on that game is the morning price too.
 * A game with no spread quote, or with one spread that still matches, is absent.
 */
function gamesWithoutCurrentSpread(rows, quotes) {
  const byGame = new Map();
  for (const row of rows || []) {
    const market = String((row && (row.market || row.betType)) || '');
    if (!/spread|puck|run line/i.test(market)) continue;
    const key = gameKey(row);
    if (!key) continue;
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(row);
  }
  const stale = new Set();
  for (const [key, list] of byGame) {
    const quote = quoteForRow(list[0], quotes);
    if (!quote || quote.homeSpread == null) continue;
    const anyCurrent = list.some((row) => holdReason({ ...row, dataReviewFlag: null }, quotes) == null);
    if (!anyCurrent) stale.add(key);
  }
  return stale;
}

function holdReason(row, quotes) {
  if (!row || typeof row !== 'object') return null;
  if (row.dataReviewFlag && row.dataReviewFlag.flagged) return 'pinnacle-sanity';
  const market = String(row.market || row.betType || '');
  const quote = quoteForRow(row, quotes);
  if (!quote) return null;
  const line = rowLine(row);
  if (line == null) return null;
  if (/total/i.test(market)) {
    if (quote.total == null) return null;
    return Math.abs(line - quote.total) > 0.01 ? 'line-moved' : null;
  }
  if (/spread|puck|run line/i.test(market)) {
    const current = currentSpreadForRow(row, quote);
    if (current == null) return null;
    return Math.abs(line - current) > 0.01 ? 'line-moved' : null;
  }
  return null;
}

const FOOTBALL_SCOREBOARD = {
  NCAAF: 'football/college-football',
  NFL: 'football/nfl',
};

async function fetchPostedQuotes(dateISO, sports) {
  const ymd = String(dateISO || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(ymd)) return [];
  const wanted = new Set((sports || []).map((sport) => String(sport || '').toUpperCase()));
  const quotes = [];
  for (const [sport, path] of Object.entries(FOOTBALL_SCOREBOARD)) {
    if (wanted.size && !wanted.has(sport)) continue;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) continue;
    const data = await response.json();
    quotes.push(...quotesFromScoreboard(data));
  }
  return quotes;
}

module.exports = {
  quoteFromEspnEvent,
  quotesFromScoreboard,
  gameKey,
  gamesWithoutCurrentSpread,
  holdReason,
  fetchPostedQuotes,
};
