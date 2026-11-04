'use strict';

/**
 * Close and CLV fields for every scored candidate on a card.
 * Reads boards already stored by the scheduled line pulls and the
 * in-memory slate cache the CLV tracker already fetched for published
 * picks. No remote odds request is made here.
 * Writes land on clv-{date}.candidates. Pick KPI fields are left alone.
 * Every public function catches its own failures.
 */

const { noVigTwoWay } = require('../omega-vnext/odds_math');
const {
  gameKey, lookupGame, extractGameBooks, foldAccents, foldGameKey,
} = require('../omega-vnext/line_path');

const MAX_CANDIDATES = 240;
const MAX_JSON_BYTES = 160000;
const WINDOW_BEFORE_MS = 20 * 60 * 1000;
const WINDOW_AFTER_MS = 3 * 60 * 1000;
const BET_GRACE_MS = 5 * 60 * 1000;
const POINT_EPS = 0.001;

const DK_HR = ['draftkings', 'hardrockbet'];
const US_BOOKS = [
  'draftkings', 'hardrockbet', 'fanduel', 'betmgm', 'caesars',
  'williamhill_us', 'espnbet', 'betrivers', 'fanatics', 'bovada',
];
const KEEP_IF_NULL = ['openPrice', 'openBook', 'betPrice', 'betBook', 'pinnacleFairBet'];
const CLOSE_FIELDS = [
  'pinnacleFairClose', 'closePrice', 'closeBook', 'clvPct', 'clvProbDelta', 'closeSource',
];

function safeMsg(err) {
  const msg = String(err && err.message || 'error');
  if (/bearer|token|authorization|api[_-]?key/i.test(msg)) return 'unavailable';
  return msg.slice(0, 180);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundTo(n, places) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(places));
}

function americanFrom(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v === 0) return null;
    return Math.round(v);
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'even' || s === 'ev' || s === 'even money') return 100;
  const n = Number(s.replace(/^\+/, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.round(n);
}

function canonicalBook(book) {
  const k = String(book || '').trim().toLowerCase();
  if (!k) return null;
  if (k === 'hardrock' || k === 'hardrockbet_oh') return 'hardrockbet';
  return k;
}

function foldMatchup(value) {
  return foldGameKey(foldAccents(value));
}

function marketOf(cand) {
  const market = String(cand && (cand.market || cand.betType) || '').toLowerCase();
  const side = String(cand && (cand.side || cand.pick) || '');
  if (/total/.test(market) || /^\s*(over|under)\b/i.test(side)) return 'total';
  if (/spread|run line|puck line|handicap/.test(market)) return 'spread';
  if (/money\s*line|\bml\b/.test(market)) return 'ml';
  if (/[+-]\d/.test(side) && !/\bml\b/i.test(side)) return 'spread';
  return 'ml';
}

function lineOf(cand, market) {
  if (market === 'ml') return null;
  const direct = num(cand && cand.line);
  if (direct != null) return direct;
  const side = String(cand && (cand.side || cand.pick) || '');
  if (market === 'total') {
    const m = side.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }
  const m = side.match(/([+-]\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function sideText(cand) {
  return String(cand && (cand.side || cand.pick) || '')
    .replace(/\bml\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normSide(cand, market) {
  const text = sideText(cand);
  if (market === 'total') {
    if (/\bover\b/i.test(text)) return 'over';
    if (/\bunder\b/i.test(text)) return 'under';
  }
  return foldMatchup(text.replace(/[+-]\d+(?:\.\d+)?/g, ' '));
}

function rowKey(cand) {
  const market = marketOf(cand);
  const line = lineOf(cand, market);
  const matchup = foldMatchup(
    (cand && cand.matchup)
    || `${cand && cand.awayTeam || ''} @ ${cand && cand.homeTeam || ''}`
  );
  const sport = String(cand && cand.sport || '').toUpperCase();
  const linePart = line == null ? '' : String(line);
  return `${sport}|${matchup}|${market}|${normSide(cand, market)}|${linePart}`;
}

function foldName(value) {
  return foldAccents(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function teamScore(side, team) {
  const s = foldName(side);
  const t = foldName(team);
  if (!s || !t) return 0;
  if (s === t) return 1000 + t.length;
  if (s.includes(t)) return 800 + t.length;
  if (t.includes(s) && s.length > 3) return 700 + s.length;
  const last = t.split(' ').pop();
  if (last && last.length > 3 && s.includes(last)) return 500 + last.length;
  return 0;
}

function sideRole(game, cand) {
  const market = marketOf(cand);
  const text = sideText(cand);
  if (market === 'total') {
    if (/\bover\b/i.test(text)) return 'over';
    if (/\bunder\b/i.test(text)) return 'under';
    return null;
  }
  const home = game && (game.homeTeam || game.home_team);
  const away = game && (game.awayTeam || game.away_team);
  const homeScore = teamScore(text, home);
  const awayScore = teamScore(text, away);
  if (!homeScore && !awayScore) return null;
  if (homeScore === awayScore) {
    return String(home || '').length >= String(away || '').length ? 'home' : 'away';
  }
  return homeScore > awayScore ? 'home' : 'away';
}

function rowFor(books, book) {
  if (!books || typeof books !== 'object') return null;
  const key = canonicalBook(book);
  if (!key) return null;
  if (books[key]) return books[key];
  const raw = String(book || '').trim().toLowerCase();
  if (raw && books[raw]) return books[raw];
  if (key === 'hardrockbet') {
    return books.hardrockbet || books.hardrock || books.hardrockbet_oh || null;
  }
  return null;
}

function priceOn(row, role, market) {
  if (!row || !role) return null;
  if (market === 'ml') {
    if (role === 'home') return { price: americanFrom(row.mlHome), point: null };
    if (role === 'away') return { price: americanFrom(row.mlAway), point: null };
  } else if (market === 'spread') {
    if (role === 'home') return { price: americanFrom(row.spreadHomeOdds), point: num(row.spreadHome) };
    if (role === 'away') return { price: americanFrom(row.spreadAwayOdds), point: num(row.spreadAway) };
  } else if (market === 'total') {
    if (role === 'over') return { price: americanFrom(row.overOdds), point: num(row.total) };
    if (role === 'under') return { price: americanFrom(row.underOdds), point: num(row.total) };
  }
  return null;
}

function samePoint(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return false;
  return Math.abs(Number(a) - Number(b)) <= POINT_EPS;
}

function quoteBooks(game, cand, books) {
  if (!game || !game.books) return null;
  const market = marketOf(cand);
  const role = sideRole(game, cand);
  const want = lineOf(cand, market);
  for (const book of books) {
    const row = rowFor(game.books, book);
    if (!row) continue;
    const quote = priceOn(row, role, market);
    if (!quote || quote.price == null) continue;
    if (market !== 'ml' && !samePoint(quote.point, want)) continue;
    return { price: quote.price, book: canonicalBook(book), point: quote.point };
  }
  return null;
}

function quoteDkHr(game, cand, betBook) {
  const order = [];
  const prefer = canonicalBook(betBook);
  if (prefer === 'draftkings' || prefer === 'hardrockbet') order.push(prefer);
  for (const book of DK_HR) if (!order.includes(book)) order.push(book);
  return quoteBooks(game, cand, order);
}

function quoteRetail(game, cand, betBook) {
  return quoteDkHr(game, cand, betBook)
    || quoteBooks(game, cand, US_BOOKS.filter((book) => book !== 'draftkings' && book !== 'hardrockbet'));
}

function pinnacleFair(game, cand) {
  if (!game) return null;
  const row = rowFor(game.books, 'pinnacle');
  if (!row) return null;
  const market = marketOf(cand);
  const role = sideRole(game, cand);
  if (!role) return null;
  const side = priceOn(row, role, market);
  const oppRole = role === 'home' ? 'away'
    : role === 'away' ? 'home'
    : role === 'over' ? 'under'
    : role === 'under' ? 'over'
    : null;
  const opp = priceOn(row, oppRole, market);
  if (!side || !opp || side.price == null || opp.price == null) return null;
  const want = lineOf(cand, market);
  if (market !== 'ml' && !samePoint(side.point, want)) return null;
  const fair = noVigTwoWay(side.price, opp.price);
  if (!fair || !Number.isFinite(fair.p1)) return null;
  return fair.p1;
}

function gameIn(snap, cand) {
  const games = snap && snap.games;
  if (!games || typeof games !== 'object' || Array.isArray(games)) return null;
  if (cand && cand.awayTeam && cand.homeTeam) {
    const hit = lookupGame(games, cand.awayTeam, cand.homeTeam);
    if (hit) return hit;
  }
  const matchup = foldMatchup(cand && cand.matchup || '');
  if (!matchup) return null;
  if (games[matchup]) return games[matchup];
  for (const key of Object.keys(games)) {
    if (foldMatchup(key) === matchup) return games[key];
  }
  const parts = matchup.split(' @ ');
  if (parts.length === 2) return lookupGame(games, parts[0], parts[1]);
  return null;
}

function capturedMs(snap) {
  const ms = Date.parse(snap && snap.capturedAt);
  return Number.isFinite(ms) ? ms : null;
}

function betSnapshots(snaps, betAtMs) {
  return (snaps || []).filter((snap) => {
    if (!snap || snap.role === 'close') return false;
    if (!Number.isFinite(betAtMs)) return true;
    const at = capturedMs(snap);
    if (at == null) return true;
    return at <= betAtMs + BET_GRACE_MS;
  }).sort((a, b) => (capturedMs(b) || -Infinity) - (capturedMs(a) || -Infinity));
}

function openSnapshots(snaps) {
  return (snaps || []).filter((snap) => snap && snap.role !== 'close')
    .sort((a, b) => (capturedMs(a) || Infinity) - (capturedMs(b) || Infinity));
}

function closeSnapshots(snaps, commenceMs) {
  if (!Number.isFinite(commenceMs)) return [];
  const hits = [];
  (snaps || []).forEach((snap, idx) => {
    const at = capturedMs(snap);
    if (at == null) return;
    const delta = at - commenceMs;
    if (delta < -WINDOW_BEFORE_MS || delta > WINDOW_AFTER_MS) return;
    const dist = Math.abs(delta);
    hits.push({ snap, idx, prefer: delta <= 0 ? dist : dist + 1 });
  });
  hits.sort((a, b) => a.prefer - b.prefer || a.idx - b.idx);
  return hits.map((hit) => hit.snap);
}

function bestCloseSnap(snaps, cand, commenceMs) {
  for (const snap of closeSnapshots(snaps, commenceMs)) {
    if (gameIn(snap, cand)) return snap;
  }
  return null;
}

function explicitBet(cand) {
  const price = americanFrom(cand && (cand.odds != null ? cand.odds : cand.oddsStr));
  const book = canonicalBook(cand && cand.book);
  if (price != null) return { price, book };
  const dk = cand && cand.bestDkHr;
  if (dk) {
    const alt = americanFrom(dk.american != null ? dk.american : dk.odds);
    if (alt != null) return { price: alt, book: canonicalBook(dk.book) || book };
  }
  return { price: null, book };
}

function blankRow(cand, publishedSet, idx) {
  let key = `unkeyed|${idx}`;
  try {
    if (cand && typeof cand === 'object') key = rowKey(cand);
  } catch (_) { /* keep fallback key */ }
  return {
    rowKey: key,
    sport: cand && cand.sport ? String(cand.sport).toUpperCase() : null,
    matchup: cand && cand.matchup ? String(cand.matchup) : null,
    side: cand && (cand.side || cand.pick) ? String(cand.side || cand.pick) : null,
    market: cand && typeof cand === 'object' ? marketOf(cand) : null,
    line: cand && typeof cand === 'object' ? lineOf(cand, marketOf(cand)) : null,
    commenceTime: cand && cand.commenceTime ? String(cand.commenceTime) : null,
    published: publishedSet.has(key),
    openPrice: null,
    openBook: null,
    betPrice: null,
    betBook: null,
    pinnacleFairBet: null,
    pinnacleFairClose: null,
    closePrice: null,
    closeBook: null,
    clvPct: null,
    clvProbDelta: null,
    closeSource: null,
  };
}

function gradeOne(cand, snaps, publishedSet, betAtMs) {
  const market = marketOf(cand);
  const key = rowKey(cand);
  let commence = cand.commenceTime ? String(cand.commenceTime) : '';
  if (!commence) {
    for (const snap of snaps) {
      const game = gameIn(snap, cand);
      if (game && game.commenceTime) {
        commence = String(game.commenceTime);
        break;
      }
    }
  }
  const commenceMs = Date.parse(commence);

  const bet = explicitBet(cand);
  let betPrice = bet.price;
  let betBook = bet.book;
  if (betPrice == null) {
    for (const snap of betSnapshots(snaps, betAtMs)) {
      const quote = quoteRetail(gameIn(snap, cand), cand, betBook);
      if (quote) {
        betPrice = quote.price;
        betBook = quote.book;
        break;
      }
    }
  }

  let openPrice = null;
  let openBook = null;
  if (cand.openPrint && cand.openPrint.odds != null) {
    openPrice = americanFrom(cand.openPrint.odds);
    openBook = canonicalBook(cand.openPrint.book);
  } else if (cand.openPrice != null) {
    openPrice = americanFrom(cand.openPrice);
    openBook = canonicalBook(cand.openBook);
  }
  if (openPrice == null) {
    for (const snap of openSnapshots(snaps)) {
      const quote = quoteRetail(gameIn(snap, cand), cand, null);
      if (quote) {
        openPrice = quote.price;
        openBook = quote.book;
        break;
      }
    }
  }

  let pinnacleFairBet = null;
  for (const snap of betSnapshots(snaps, betAtMs)) {
    const fair = pinnacleFair(gameIn(snap, cand), cand);
    if (fair != null) {
      pinnacleFairBet = roundTo(fair, 6);
      break;
    }
  }
  if (pinnacleFairBet == null && num(cand.pinnacleFairBet) != null) {
    pinnacleFairBet = roundTo(num(cand.pinnacleFairBet), 6);
  }

  let pinnacleFairClose = null;
  let closePrice = null;
  let closeBook = null;
  let closeSource = null;
  const closeSnap = bestCloseSnap(snaps, cand, commenceMs);
  if (closeSnap) {
    const game = gameIn(closeSnap, cand);
    const fair = pinnacleFair(game, cand);
    const quote = quoteDkHr(game, cand, betBook);
    if (fair != null) pinnacleFairClose = roundTo(fair, 6);
    if (quote) {
      closePrice = quote.price;
      closeBook = quote.book;
    }
    if (pinnacleFairClose != null || closePrice != null) closeSource = closeSnap.source || null;
  }

  let clvProbDelta = null;
  let clvPct = null;
  if (pinnacleFairClose != null && pinnacleFairBet != null) {
    clvProbDelta = roundTo(pinnacleFairClose - pinnacleFairBet, 6);
    clvPct = roundTo(clvProbDelta * 100, 4);
  }

  return {
    rowKey: key,
    sport: cand.sport ? String(cand.sport).toUpperCase() : null,
    matchup: cand.matchup ? String(cand.matchup) : null,
    side: cand.side || cand.pick ? String(cand.side || cand.pick) : null,
    market,
    line: lineOf(cand, market),
    commenceTime: commence || null,
    published: publishedSet.has(key),
    openPrice,
    openBook,
    betPrice,
    betBook,
    pinnacleFairBet,
    pinnacleFairClose,
    closePrice,
    closeBook,
    clvPct,
    clvProbDelta,
    closeSource,
  };
}

function gradeScoredCandidates(candidates, opts = {}) {
  const snaps = opts.snapshots || [];
  const publishedSet = new Set();
  for (const row of opts.published || []) {
    try { publishedSet.add(rowKey(row)); } catch (_) { /* skip bad published row */ }
  }
  const betAtMs = Date.parse(opts.betAt || '');
  const out = [];
  (candidates || []).forEach((cand, idx) => {
    try {
      if (!cand || typeof cand !== 'object') {
        out.push(blankRow(cand, publishedSet, idx));
        return;
      }
      out.push(gradeOne(cand, snaps, publishedSet, betAtMs));
    } catch (_) {
      out.push(blankRow(cand, publishedSet, idx));
    }
  });
  return out;
}

function hasClose(row) {
  return !!(row && (row.closeSource || row.pinnacleFairClose != null || row.closePrice != null));
}

function hasCloseClv(row) {
  return !!(row
    && row.closeSource
    && row.closePrice != null
    && row.pinnacleFairClose != null
    && Number.isFinite(row.clvProbDelta));
}

function mergeCandidateRows(prevRows, nextRows) {
  const map = new Map();
  const order = [];
  const put = (row) => {
    if (!row || !row.rowKey) return;
    if (!map.has(row.rowKey)) {
      map.set(row.rowKey, { ...row });
      order.push(row.rowKey);
      return;
    }
    const prev = map.get(row.rowKey);
    const merged = { ...prev, ...row };
    for (const field of KEEP_IF_NULL) {
      if (row[field] == null && prev[field] != null) merged[field] = prev[field];
    }
    if (!hasClose(row)) {
      for (const field of CLOSE_FIELDS) merged[field] = prev[field] != null ? prev[field] : row[field];
    }
    merged.published = !!(prev.published || row.published);
    map.set(row.rowKey, merged);
  };
  for (const row of prevRows || []) put(row);
  for (const row of nextRows || []) put(row);
  return order.map((key) => map.get(key));
}

function boundCandidates(rows, scoredCount) {
  let list = (rows || []).slice();
  const scored = scoredCount != null ? scoredCount : list.length;
  let capped = false;
  const tooBig = () => {
    try { return JSON.stringify(list).length > MAX_JSON_BYTES; } catch (_) { return true; }
  };
  if (list.length > MAX_CANDIDATES || tooBig()) {
    capped = true;
    list.sort((a, b) => {
      const ca = hasCloseClv(a) ? 0 : 1;
      const cb = hasCloseClv(b) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return String(a && a.rowKey || '').localeCompare(String(b && b.rowKey || ''));
    });
    if (list.length > MAX_CANDIDATES) list = list.slice(0, MAX_CANDIDATES);
    while (list.length && tooBig()) list.pop();
  }
  return { rows: list, scoredCount: scored, storedCount: list.length, capped };
}

function summarize(graded, bounded) {
  const bySport = {};
  const touch = (sport) => {
    const key = String(sport || 'UNK').toUpperCase() || 'UNK';
    if (!bySport[key]) bySport[key] = { scored: 0, withClose: 0 };
    return key;
  };
  for (const row of graded || []) {
    bySport[touch(row && row.sport)].scored += 1;
  }
  const storedRows = bounded && Array.isArray(bounded.rows) ? bounded.rows : (graded || []);
  let withClose = 0;
  for (const row of storedRows) {
    if (!hasCloseClv(row)) continue;
    withClose += 1;
    bySport[touch(row && row.sport)].withClose += 1;
  }
  return {
    scored: (graded || []).length,
    stored: bounded ? bounded.storedCount : storedRows.length,
    capped: bounded ? !!bounded.capped : false,
    withClose,
    bySport,
  };
}

function asGameMap(games) {
  if (!games) return {};
  if (!Array.isArray(games)) return games;
  const map = {};
  for (const ev of games) {
    if (!ev) continue;
    if (ev.books && (ev.homeTeam || ev.awayTeam)) {
      map[gameKey(ev.awayTeam, ev.homeTeam)] = ev;
      continue;
    }
    const home = ev.home_team || ev.homeTeam;
    const away = ev.away_team || ev.awayTeam;
    if (!home || !away) continue;
    try {
      map[gameKey(away, home)] = { ...extractGameBooks(ev) };
    } catch (_) { /* skip one bad event */ }
  }
  return map;
}

function snapshotsFromPolls(polls) {
  const out = [];
  for (const poll of polls || []) {
    if (!poll || !poll.games) continue;
    const hhmm = String(poll.hhmm || poll.slot || '').replace(/[^\d]/g, '').slice(0, 4) || 'unk';
    out.push({
      source: `line-snap-${hhmm}`,
      capturedAt: poll.capturedAt || null,
      role: 'board',
      games: asGameMap(poll.games),
    });
  }
  return out;
}

function snapshotsFromMaster(masterBoard) {
  if (!masterBoard) return [];
  const out = [];
  const add = (games, source, capturedAt) => {
    const map = asGameMap(games);
    if (map && Object.keys(map).length) {
      out.push({ source, capturedAt: capturedAt || null, role: 'board', games: map });
    }
  };
  add(masterBoard.games0300, 'odds-master-0300', masterBoard.at0300);
  add(masterBoard.games1000, 'odds-master-1000', masterBoard.at1000);
  return out;
}

function snapshotsFromContext({ masterBoard, linePathMeta } = {}) {
  const masterSnaps = snapshotsFromMaster(masterBoard);
  const polls = (linePathMeta && linePathMeta.path && linePathMeta.path.polls)
    || (linePathMeta && linePathMeta.polls)
    || [];
  if (masterSnaps.length) {
    const same = !!(linePathMeta && linePathMeta.path && masterBoard
      && linePathMeta.path.polls === masterBoard.polls);
    if (same) return masterSnaps;
    return masterSnaps.concat(snapshotsFromPolls(polls));
  }
  return snapshotsFromPolls(polls);
}

function cacheEntries(cache) {
  if (!cache) return [];
  if (typeof cache.entries === 'function') return Array.from(cache.entries());
  if (Array.isArray(cache)) return cache;
  if (typeof cache === 'object') return Object.entries(cache);
  return [];
}

function snapshotsFromBulkCache(cache, nowIso) {
  const out = [];
  for (const pair of cacheEntries(cache)) {
    const rawKey = String(pair && pair[0] || '');
    const games = pair && pair[1];
    const sep = rawKey.lastIndexOf('|');
    const at = sep >= 0 ? rawKey.slice(sep + 1) : 'live';
    const live = !at || at === 'live';
    const map = asGameMap(Array.isArray(games) ? games : []);
    if (!Object.keys(map).length) continue;
    out.push({
      source: live ? 'track-clv-live' : 'track-clv',
      capturedAt: live ? (nowIso || null) : at,
      role: 'close',
      games: map,
    });
  }
  return out;
}

function candidatesFromCard(picksData) {
  if (!picksData || typeof picksData !== 'object') return [];
  const rows = [];
  for (const pick of picksData.picks || []) rows.push(pick);
  for (const ticket of picksData.parlayLegs || []) {
    for (const leg of ticket && ticket.legs || []) rows.push(leg);
  }
  for (const row of picksData.parlayPool || []) rows.push(row);
  for (const row of picksData.candidateTable || []) rows.push(row);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    let key;
    try { key = rowKey(row); } catch (_) { continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function publishedFromCard(picksData) {
  const out = [];
  for (const pick of (picksData && picksData.picks) || []) out.push(pick);
  for (const ticket of (picksData && picksData.parlayLegs) || []) {
    for (const leg of ticket && ticket.legs || []) out.push(leg);
  }
  return out;
}

async function loadStoredSnapshots(dateISO) {
  let master = null;
  let linePathMeta = null;
  try {
    const { loadMasterBoard } = require('../odds-master/board');
    master = await loadMasterBoard(dateISO);
  } catch (_) { master = null; }
  try {
    const { loadLinePath } = require('../omega-vnext/line_path');
    linePathMeta = await loadLinePath(dateISO);
  } catch (_) { linePathMeta = null; }
  return snapshotsFromContext({ masterBoard: master, linePathMeta });
}

async function seedCandidateClv(opts = {}) {
  try {
    if (opts.dryRun || opts.shadow || opts.simMode || opts.replayLike || opts.replay || opts.historicalSnapshot) {
      return { saved: false, reason: 'no-write' };
    }
    const dateISO = String(opts.dateISO || opts.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { saved: false, reason: 'bad-date' };
    const candidates = opts.candidates;
    if (!Array.isArray(candidates) || !candidates.length) return { saved: false, reason: 'empty' };
    if (typeof opts.writeJson !== 'function') return { saved: false, reason: 'no-store' };
    const snapshots = Array.isArray(opts.snapshots)
      ? opts.snapshots
      : snapshotsFromContext({ masterBoard: opts.masterBoard, linePathMeta: opts.linePathMeta });
    const graded = gradeScoredCandidates(candidates, {
      snapshots,
      published: opts.published || [],
      betAt: opts.betAt,
    });
    let prev = null;
    if (typeof opts.readJson === 'function') {
      try { prev = await opts.readJson(`clv-${dateISO}`); } catch (_) { prev = null; }
    }
    const doc = (prev && typeof prev === 'object' && !Array.isArray(prev))
      ? { ...prev }
      : { date: dateISO };
    if (!Array.isArray(doc.picks)) doc.picks = [];
    const merged = mergeCandidateRows(doc.candidates, graded);
    const bounded = boundCandidates(merged, candidates.length);
    doc.candidates = bounded.rows;
    doc.candidateClv = summarize(graded, bounded);
    try {
      const { packInputs } = require('./candidate_inputs');
      const packed = packInputs(opts.inputs);
      if (packed) {
        doc.candidateInputs = packed.rows;
        doc.candidateInputsMeta = packed.meta;
      }
    } catch (_) { /* input log is optional */ }
    try {
      await opts.writeJson(`clv-${dateISO}`, doc);
    } catch (_) {
      return { saved: false, reason: 'write-failed' };
    }
    return { saved: true, key: `clv-${dateISO}`, ...doc.candidateClv };
  } catch (err) {
    console.warn(`[candidate-clv] seed skipped: ${safeMsg(err)}`);
    return { saved: false, reason: 'error' };
  }
}

function keepStoredInputs(clvData, opts) {
  try {
    const { applyStoredInputs } = require('./candidate_inputs');
    applyStoredInputs(clvData, opts && opts.existingInputs);
  } catch (_) { /* leave the document unchanged */ }
}

async function attachCandidateCloses(clvData, opts = {}) {
  try {
    if (!clvData || typeof clvData !== 'object') return clvData;
    keepStoredInputs(clvData, opts);
    const dateISO = opts.dateISO;
    let candidates = Array.isArray(opts.candidates) ? opts.candidates : null;
    if (!candidates && dateISO && typeof opts.readJson === 'function') {
      try {
        const board = await opts.readJson(`omega-v2/morning-board/${dateISO}`);
        if (board && Array.isArray(board.candidates) && board.candidates.length) {
          candidates = board.candidates;
        }
      } catch (_) { /* board read is optional */ }
    }
    if (!candidates || !candidates.length) candidates = candidatesFromCard(opts.picksData);
    if (!candidates || !candidates.length) {
      if (!clvData.candidates && Array.isArray(opts.existingCandidates)) {
        clvData.candidates = opts.existingCandidates;
      }
      return clvData;
    }
    let snapshots;
    if (Array.isArray(opts.snapshots)) snapshots = opts.snapshots.slice();
    else snapshots = await loadStoredSnapshots(dateISO);
    try {
      snapshots = snapshots.concat(snapshotsFromBulkCache(opts.bulkCache, opts.nowIso));
    } catch (_) { /* cache shape is optional */ }
    const graded = gradeScoredCandidates(candidates, {
      snapshots,
      published: Array.isArray(opts.published) ? opts.published : publishedFromCard(opts.picksData),
      betAt: opts.betAt,
    });
    const prev = Array.isArray(opts.existingCandidates) ? opts.existingCandidates : clvData.candidates;
    const merged = mergeCandidateRows(prev, graded);
    const bounded = boundCandidates(merged, candidates.length);
    clvData.candidates = bounded.rows;
    clvData.candidateClv = summarize(graded, bounded);
    return clvData;
  } catch (err) {
    console.warn(`[candidate-clv] close fill skipped: ${safeMsg(err)}`);
    try {
      if (clvData && Array.isArray(opts.existingCandidates)) {
        clvData.candidates = boundCandidates(opts.existingCandidates, opts.existingCandidates.length).rows;
      }
    } catch (_) { /* leave the document unchanged */ }
    keepStoredInputs(clvData, opts);
    return clvData;
  }
}

module.exports = {
  MAX_CANDIDATES,
  MAX_JSON_BYTES,
  rowKey,
  gradeScoredCandidates,
  mergeCandidateRows,
  boundCandidates,
  summarize,
  hasCloseClv,
  snapshotsFromContext,
  snapshotsFromMaster,
  snapshotsFromPolls,
  snapshotsFromBulkCache,
  candidatesFromCard,
  seedCandidateClv,
  attachCandidateCloses,
};
