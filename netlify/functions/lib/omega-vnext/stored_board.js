'use strict';

/**
 * Rebuild an Odds API-shaped board from the stored 10:00 ET line-move
 * check. Books are pinnacle, draftkings, and hardrockbet. This does not
 * call the Odds API and it does not write a blob.
 */

const { ODDS_SPORT_KEYS } = require('./config');
const { readPinnacleLineMoves, readLineMoveKey, SCHEMA } = require('./pinnacle_line_move');

const BOOKS = ['pinnacle', 'draftkings', 'hardrockbet'];

function marketKey(market) {
  const name = String(market || '');
  if (/moneyline|^ml$/i.test(name)) return 'h2h';
  if (/spread/i.test(name)) return 'spreads';
  if (/total/i.test(name)) return 'totals';
  return null;
}

function outcomeName(quote) {
  if (/total/i.test(String(quote && quote.market || ''))) {
    if (quote.side === 'over' || /^over$/i.test(quote.team || '')) return 'Over';
    if (quote.side === 'under' || /^under$/i.test(quote.team || '')) return 'Under';
  }
  return quote && (quote.team || quote.side) || null;
}

function bookmakersFromCheck(check) {
  const bookmakers = [];
  const books = (check && check.books) || {};
  for (const book of BOOKS) {
    const quotes = books[book];
    if (!quotes || typeof quotes !== 'object') continue;
    const markets = new Map();
    for (const quote of Object.values(quotes)) {
      if (!quote || !Number.isFinite(Number(quote.price))) continue;
      const key = marketKey(quote.market);
      const name = outcomeName(quote);
      if (!key || !name) continue;
      if (!markets.has(key)) markets.set(key, []);
      const outcome = { name, price: Math.round(Number(quote.price)) };
      if (quote.line != null && quote.line !== '' && key !== 'h2h') outcome.point = Number(quote.line);
      markets.get(key).push(outcome);
    }
    if (!markets.size) continue;
    bookmakers.push({
      key: book,
      title: book,
      markets: [...markets.entries()].map(([key, outcomes]) => ({ key, outcomes })),
    });
  }
  return bookmakers;
}

/**
 * @param {{ events?: object[] }} doc readPinnacleLineMoves result
 * @returns {{ bySport: object, at: string|null }}
 */
function eventsFromLineMoves(doc) {
  const bySport = {};
  let at = null;
  for (const eventDoc of (doc && doc.events) || []) {
    if (!eventDoc) continue;
    const sport = eventDoc.sport;
    if (!sport) continue;
    const checks = (eventDoc.checks || []).filter((row) => row && String(row.slot) === '1000');
    const check = checks.length ? checks[checks.length - 1] : null;
    if (!check) continue;
    if (check.at) at = check.at;
    const bookmakers = bookmakersFromCheck(check);
    if (!bookmakers.length) continue;
    const event = {
      id: eventDoc.eventId,
      sport_key: ODDS_SPORT_KEYS[sport] || null,
      home_team: eventDoc.homeTeam || null,
      away_team: eventDoc.awayTeam || null,
      commence_time: eventDoc.commenceTime || null,
      bookmakers,
    };
    if (!bySport[sport]) bySport[sport] = [];
    bySport[sport].push(event);
  }
  return { bySport, at };
}

function eventIdentity(row) {
  if (!row || !row.sport || row.eventId == null) return null;
  return `${row.sport}/${row.eventId}`;
}

/**
 * The line-move date index is sometimes only the first event written.
 * odds-master by-date/{day} lists every game captured at 3:00 and 10:00.
 * Those event docs still hold the 10:00 check (pinnacle, DraftKings, Hard Rock).
 * An injected line-move reader skips this lookup unless readOddsMaster is set,
 * so a unit test does not touch the blob API.
 */
async function eventsOnDate(dateISO, events, opts) {
  const rows = Array.isArray(events) ? events.filter(Boolean) : [];
  const injectedMoves = opts && typeof opts.readPinnacleLineMoves === 'function';
  const injectedMaster = opts && typeof opts.readOddsMaster === 'function';
  if (injectedMoves && !injectedMaster) return rows;
  let dated = null;
  try {
    const readMaster = injectedMaster
      ? opts.readOddsMaster
      : require('./odds_master').readMasterKey;
    dated = await readMaster(`by-date/${dateISO}`, opts);
  } catch (_) {
    dated = null;
  }
  const listed = dated && Array.isArray(dated.events) ? dated.events : [];
  if (!listed.length) return rows;
  const seen = new Set(rows.map(eventIdentity).filter(Boolean));
  const readLine = (opts && opts.readLineMoveKey) || readLineMoveKey;
  for (const row of listed) {
    const id = eventIdentity(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let doc = null;
    try { doc = await readLine(`${row.sport}/${row.eventId}`, opts); } catch (_) { doc = null; }
    if (doc && doc.schema === SCHEMA) rows.push(doc);
  }
  return rows;
}

async function loadStoredTenAmBoard(dateISO, opts = {}) {
  const read = (opts && opts.readPinnacleLineMoves) || readPinnacleLineMoves;
  const doc = await read(dateISO, opts);
  const events = await eventsOnDate(dateISO, doc && doc.events, opts);
  if (!events.length) return null;
  const built = eventsFromLineMoves({ events });
  const count = Object.values(built.bySport).reduce((n, rows) => n + ((rows && rows.length) || 0), 0);
  if (!count) return null;
  return {
    bySport: built.bySport,
    fetchedAt: built.at || new Date().toISOString(),
    snapshotNote: 'stored-10:00',
    oddsSnapshotTimestamp: built.at || null,
    storedSnapshot: true,
    oddsErrors: [],
    paidPull: 0,
  };
}

module.exports = {
  loadStoredTenAmBoard,
  eventsFromLineMoves,
  bookmakersFromCheck,
};
