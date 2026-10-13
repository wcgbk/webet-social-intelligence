'use strict';

/**
 * Pinnacle / DraftKings line log. Context for the 10:00 ET card only.
 *
 * The open is the first price in the 3:00 ET pull, stored once at
 * sport/eventId, and never rewritten. Checks at 03:00 and 10:00 ET append.
 * Moves are the change between consecutive observations
 * (open → 3:00 → 10:00). 9:00 and 10:30 are not pulled.
 * Direction on the card context is from the 3:00 baseline when that print
 * exists, otherwise from the open. Steam needs the same direction at
 * Pinnacle and DraftKings.
 *
 * Selection reads that same pair. linePathForSelection turns the 10:00
 * check and the 3:00 baseline (else the open) into line-path polls.
 * A doc with no 10:00 snapshot does not pretend the last check is the
 * close. Retired 06:00/07:30/09:00/09:15 snaps are not a fallback.
 * The fair price is not rewritten here.
 * applyLineMoveContext still only copies the audit summary.
 */

const { PINNACLE_LINE_MOVE, STEAM_WINDOW_MIN, SITE_ID } = require('./config');
const { shapeOfficialLinePath } = require('./line_path');
const { noVigTwoWay, americanJuiceDelta, isSameEtDay } = require('./odds_math');
const { priceLockTimestamp } = require('./price_lock');
const { replayNoWrite, logBlocked } = require('./no_write');
const { resolveFetch, auditBlobCall } = require('./audit_log');

const LINE_MOVE_STORE = 'omega-pinnacle-line-moves';
const SCHEMA = 'omega-pinnacle-line-moves-v1';
const PINNACLE_SPORTS = ['MLB', 'NFL', 'NCAAF', 'NHL'];
const CHECK_SLOTS = ['0300', '1000'];
const SLOT_ORDER = ['open', '0300', '1000'];
const CHECK_BOOKS = ['pinnacle', 'draftkings'];
const LOCK_GRACE_MS = 15 * 60 * 1000;

function roundTo(value, digits) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return +n.toFixed(digits);
}

function centsBetween(prevPrice, nextPrice) {
  const worse = americanJuiceDelta(prevPrice, nextPrice);
  if (worse == null) return null;
  // Positive means the new American price is longer for this side.
  return +(-worse).toFixed(2);
}

function probPtsBetween(prevNoVig, nextNoVig) {
  if (prevNoVig == null || nextNoVig == null) return null;
  const a = Number(prevNoVig);
  const b = Number(nextNoVig);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return +((b - a) * 100).toFixed(4);
}

function pointBetween(prevLine, nextLine) {
  if (prevLine == null && nextLine == null) return null;
  const a = Number(prevLine);
  const b = Number(nextLine);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return +(b - a).toFixed(3);
}

function sameNum(a, b, eps) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= eps;
}

function quoteKey(quote) {
  const book = quote.book || 'pinnacle';
  return `${quote.eventId}|${book}|${quote.market}|${quote.side}`;
}

function eventKey(sport, eventId) {
  return `${sport}/${eventId}`;
}

function dateIndexKey(dateISO) {
  return `date/${dateISO}`;
}

function commenceEtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function slotRank(slot) {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? 99 : i;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyEventDoc(sport, eventId) {
  return {
    schema: SCHEMA,
    sport,
    eventId: String(eventId),
    store: LINE_MOVE_STORE,
    appendOnly: true,
    homeTeam: null,
    awayTeam: null,
    commenceTime: null,
    date: null,
    open: null,
    checks: [],
    moves: [],
    steams: [],
  };
}

function bookOf(event, bookKey) {
  const want = String(bookKey || 'pinnacle').toLowerCase();
  const books = (event && event.bookmakers) || [];
  return books.find((bk) => String(bk && bk.key || '').toLowerCase() === want) || null;
}

function eventOnCardDay(event, capturedAt) {
  if (!capturedAt || capturedAt.dateISO == null || capturedAt.dateISO === '') return true;
  return isSameEtDay(event.commence_time, capturedAt.dateISO);
}

function choosePair(outcomes, home, away, kind) {
  const rows = (outcomes || []).filter((o) => o && o.name && Number.isFinite(Number(o.price)));
  let best = null;
  let bestScore = Infinity;
  if (kind === 'total') {
    const overs = rows.filter((o) => /^over$/i.test(String(o.name).trim()));
    const unders = rows.filter((o) => /^under$/i.test(String(o.name).trim()));
    for (const over of overs) {
      for (const under of unders) {
        if (over.point == null || under.point == null) continue;
        if (Math.abs(Number(over.point) - Number(under.point)) > 1e-6) continue;
        const score = Math.abs(Math.abs(Number(over.price)) - Math.abs(Number(under.price)));
        if (score < bestScore) {
          bestScore = score;
          best = [over, under];
        }
      }
    }
    return best;
  }
  const homes = rows.filter((o) => o.name === home);
  const aways = rows.filter((o) => o.name === away);
  for (const h of homes) {
    for (const a of aways) {
      if (kind === 'spread') {
        if (h.point == null || a.point == null) continue;
        if (Math.abs(Number(h.point) + Number(a.point)) > 1e-6) continue;
      }
      const score = Math.abs(Math.abs(Number(h.price)) - Math.abs(Number(a.price)));
      if (score < bestScore) {
        bestScore = score;
        best = [h, a];
      }
    }
  }
  return best;
}

function quoteRow(base, side, team, outcome, noVig) {
  return {
    sport: base.sport,
    eventId: base.eventId,
    book: base.book,
    homeTeam: base.homeTeam,
    awayTeam: base.awayTeam,
    market: base.market,
    side,
    team,
    price: Math.round(Number(outcome.price)),
    line: outcome.point == null || outcome.point === '' ? null : roundTo(outcome.point, 3),
    noVig: noVig == null ? null : roundTo(noVig, 6),
    at: base.at,
  };
}

/**
 * One quote per side for h2h, spreads, and totals from a single book.
 * Alternate lines keep the pair whose prices are closest.
 * dateISO on capturedAt limits the board to that ET day. Omit it to keep
 * every event (the open watcher stores a game the night it appears).
 */
function quotesFromEvent(event, sport, capturedAt, bookKey) {
  if (!event || !eventOnCardDay(event, capturedAt)) return {};
  const bookName = String(bookKey || (capturedAt && capturedAt.book) || 'pinnacle').toLowerCase();
  const book = bookOf(event, bookName);
  if (!book) return {};
  const eventId = event.id == null ? '' : String(event.id);
  if (!eventId) return {};
  const home = event.home_team;
  const away = event.away_team;
  const out = {};
  const put = (row) => {
    if (!row || row.noVig == null) return;
    out[quoteKey(row)] = row;
  };
  for (const market of book.markets || []) {
    const key = String(market && market.key || '');
    const base = {
      sport,
      eventId,
      book: bookName,
      homeTeam: home,
      awayTeam: away,
      at: capturedAt && capturedAt.at,
    };
    if (key === 'h2h') {
      const pair = choosePair(market.outcomes, home, away, 'ml');
      if (!pair) continue;
      const nv = noVigTwoWay(pair[0].price, pair[1].price);
      if (!nv) continue;
      put(quoteRow({ ...base, market: 'Moneyline' }, 'home', home, pair[0], nv.p1));
      put(quoteRow({ ...base, market: 'Moneyline' }, 'away', away, pair[1], nv.p2));
    } else if (key === 'spreads') {
      const pair = choosePair(market.outcomes, home, away, 'spread');
      if (!pair) continue;
      const nv = noVigTwoWay(pair[0].price, pair[1].price);
      if (!nv) continue;
      put(quoteRow({ ...base, market: 'Spread' }, 'home', home, pair[0], nv.p1));
      put(quoteRow({ ...base, market: 'Spread' }, 'away', away, pair[1], nv.p2));
    } else if (key === 'totals') {
      const pair = choosePair(market.outcomes, home, away, 'total');
      if (!pair) continue;
      const nv = noVigTwoWay(pair[0].price, pair[1].price);
      if (!nv) continue;
      put(quoteRow({ ...base, market: 'Total' }, 'over', 'Over', pair[0], nv.p1));
      put(quoteRow({ ...base, market: 'Total' }, 'under', 'Under', pair[1], nv.p2));
    }
  }
  return out;
}

function quotesFromEvents(events, sport, capturedAt, bookKey) {
  const book = bookKey || (capturedAt && capturedAt.book) || 'pinnacle';
  const out = {};
  for (const event of events || []) {
    if (!event || !eventOnCardDay(event, capturedAt)) continue;
    Object.assign(out, quotesFromEvent(event, sport, capturedAt, book));
  }
  return out;
}

function quotesByEvent(quotes) {
  const map = new Map();
  for (const quote of Object.values(quotes || {})) {
    if (!quote || quote.eventId == null) continue;
    const id = String(quote.eventId);
    if (!map.has(id)) map.set(id, {});
    map.get(id)[quoteKey(quote)] = quote;
  }
  return map;
}

function quoteChanged(prev, next) {
  if (!prev || !next) return false;
  if (!sameNum(prev.price, next.price, 0)) return true;
  if (!sameNum(prev.line, next.line, 1e-6)) return true;
  if (!sameNum(prev.noVig, next.noVig, 1e-6)) return true;
  return false;
}

function sizeMove(prev, next, meta) {
  const at = meta && meta.at;
  return {
    sport: next.sport,
    eventId: next.eventId,
    book: next.book || (meta && meta.book) || 'pinnacle',
    market: next.market,
    side: next.side,
    team: next.team || null,
    fromSlot: (meta && meta.fromSlot) || null,
    toSlot: (meta && meta.toSlot) || null,
    previous: { price: prev.price, line: prev.line, noVig: prev.noVig },
    next: { price: next.price, line: next.line, noVig: next.noVig },
    cents: centsBetween(prev.price, next.price),
    probPts: probPtsBetween(prev.noVig, next.noVig),
    pointChange: pointBetween(prev.line, next.line),
    at,
  };
}

/** A first print is not a move. A later print is a move when price, line, or no-vig changed. */
function detectMoves(prevQuotes, nextQuotes, meta) {
  const moves = [];
  const next = nextQuotes || {};
  const prev = prevQuotes || {};
  for (const key of Object.keys(next).sort()) {
    const before = prev[key];
    if (!before) continue;
    if (!quoteChanged(before, next[key])) continue;
    moves.push(sizeMove(before, next[key], meta));
  }
  return moves;
}

function signOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return 0;
  return n > 0 ? 1 : -1;
}

function minutesBetween(fromAt, toAt) {
  const t0 = Date.parse(fromAt);
  const t1 = Date.parse(toAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.abs(t1 - t0) / 60000;
}

/** Named schedule steps steam across the multi-hour gap. Any other pair must fit in windowMinutes. */
function schedulePair(fromSlot, toSlot) {
  const a = SLOT_ORDER.indexOf(fromSlot);
  const b = SLOT_ORDER.indexOf(toSlot);
  return a >= 0 && b > a;
}

function steamPairAllowed(fromSlot, toSlot, fromAt, toAt, windowMinutes) {
  if (schedulePair(fromSlot, toSlot)) return true;
  const gap = minutesBetween(fromAt, toAt);
  if (gap == null) return false;
  return gap <= Number(windowMinutes) + 1e-9;
}

/**
 * Steam when both books move the same way between the same two observations.
 * Prob: |no-vig| >= steamProbPts on both, same sign.
 * Line: spread or total |point| >= steamLinePoints on both, same sign.
 * Either predicate is enough. One book, or opposite signs, is not steam.
 * windowMinutes is always stored. A gap that is not an open/3:00/10:00
 * step must also be <= windowMinutes (the later dense-check rule).
 */
function confirmSteam(pinMove, dkMove, opts = {}) {
  if (!pinMove || !dkMove) return null;
  if (pinMove.market !== dkMove.market || pinMove.side !== dkMove.side) return null;
  if (pinMove.eventId && dkMove.eventId && String(pinMove.eventId) !== String(dkMove.eventId)) return null;
  const windowMinutes = opts.windowMinutes != null
    ? Number(opts.windowMinutes)
    : Number(PINNACLE_LINE_MOVE.windowMinutes != null ? PINNACLE_LINE_MOVE.windowMinutes : STEAM_WINDOW_MIN);
  const probFloor = opts.steamProbPts != null ? Number(opts.steamProbPts) : Number(PINNACLE_LINE_MOVE.steamProbPts);
  const lineFloor = opts.steamLinePoints != null ? Number(opts.steamLinePoints) : Number(PINNACLE_LINE_MOVE.steamLinePoints);
  const fromSlot = opts.fromSlot || pinMove.fromSlot || null;
  const toSlot = opts.toSlot || pinMove.toSlot || null;
  const fromAt = opts.fromAt || null;
  const toAt = opts.toAt || pinMove.at || null;
  if (!steamPairAllowed(fromSlot, toSlot, fromAt, toAt, windowMinutes)) return null;
  const reasons = [];
  const pinProb = Number(pinMove.probPts);
  const dkProb = Number(dkMove.probPts);
  const probSign = signOf(pinProb);
  if (Number.isFinite(probFloor)
    && Math.abs(pinProb) + 1e-9 >= probFloor
    && Math.abs(dkProb) + 1e-9 >= probFloor
    && probSign !== 0
    && probSign === signOf(dkProb)) {
    reasons.push('prob');
  }
  const market = pinMove.market;
  const pinPt = Number(pinMove.pointChange);
  const dkPt = Number(dkMove.pointChange);
  const lineSign = signOf(pinPt);
  if ((market === 'Spread' || market === 'Total')
    && Number.isFinite(lineFloor)
    && Math.abs(pinPt) + 1e-9 >= lineFloor
    && Math.abs(dkPt) + 1e-9 >= lineFloor
    && lineSign !== 0
    && lineSign === signOf(dkPt)) {
    reasons.push('line');
  }
  if (!reasons.length) return null;
  const primary = reasons[0] === 'prob' ? probSign : lineSign;
  return {
    sport: pinMove.sport || null,
    eventId: pinMove.eventId,
    market,
    side: pinMove.side,
    fromSlot,
    toSlot,
    at: toAt,
    windowMinutes,
    reason: reasons.join('+'),
    direction: primary > 0 ? 'up' : 'down',
    pinnacle: {
      cents: pinMove.cents,
      probPts: pinMove.probPts,
      pointChange: pinMove.pointChange,
    },
    draftkings: {
      cents: dkMove.cents,
      probPts: dkMove.probPts,
      pointChange: dkMove.pointChange,
    },
  };
}

function steamsForStep(moves, meta) {
  const by = new Map();
  for (const move of moves || []) {
    const key = `${move.eventId}|${move.market}|${move.side}`;
    if (!by.has(key)) by.set(key, {});
    by.get(key)[move.book] = move;
  }
  const out = [];
  for (const pair of by.values()) {
    const row = confirmSteam(pair.pinnacle, pair.draftkings, meta);
    if (row) out.push(row);
  }
  return out;
}

function previousObservation(doc, slot) {
  const rank = slotRank(slot);
  const checks = ((doc && doc.checks) || []).filter((row) => row && slotRank(row.slot) < rank);
  checks.sort((a, b) => slotRank(b.slot) - slotRank(a.slot));
  if (checks.length) {
    const hit = checks[0];
    return { slot: hit.slot, at: hit.at, books: hit.books || {} };
  }
  if (doc && doc.open && slotRank('open') < rank) {
    return { slot: 'open', at: doc.open.at, books: { pinnacle: doc.open.quotes || {} } };
  }
  return null;
}

function atMs(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function cutoffMs(dateISO, cutoffIso) {
  if (cutoffIso) {
    const t = Date.parse(cutoffIso);
    if (Number.isFinite(t)) return t;
  }
  if (!dateISO) return Infinity;
  return Date.parse(priceLockTimestamp(dateISO));
}

function openVisible(open, endMs) {
  if (!open) return false;
  const t = atMs(open.at);
  if (t == null) return true;
  return t <= endMs;
}

function checkVisible(check, endMs) {
  if (!check) return false;
  const t = atMs(check.at);
  if (check.slot === '1030') return t == null || t <= endMs + LOCK_GRACE_MS;
  if (t == null) return false;
  return t <= endMs;
}

function moveVisible(move, endMs) {
  if (!move) return false;
  const t = atMs(move.at);
  if (move.toSlot === '1030') return t == null || t <= endMs + LOCK_GRACE_MS;
  if (t == null) return false;
  return t <= endMs;
}

function sidePack(quote) {
  if (!quote) return null;
  return { price: quote.price, line: quote.line, noVig: quote.noVig };
}

function sidesFromQuotes(quotes, market) {
  const sides = {};
  for (const quote of Object.values(quotes || {})) {
    if (!quote || (market && quote.market !== market)) continue;
    sides[quote.side] = sidePack(quote);
  }
  return sides;
}

function bookQuotes(obs, book) {
  if (!obs || !obs.books) return {};
  return obs.books[book] || {};
}

function netDirection(openSides, latestSides, market) {
  const openHome = market === 'Total' ? openSides.over : openSides.home;
  const latestHome = market === 'Total' ? latestSides.over : latestSides.home;
  if (!openHome || !latestHome || openHome.noVig == null || latestHome.noVig == null) return 'flat';
  const probDelta = Number(latestHome.noVig) - Number(openHome.noVig);
  if (Math.abs(probDelta) >= 0.0005) {
    if (market === 'Total') return probDelta > 0 ? 'over' : 'under';
    return probDelta > 0 ? 'home' : 'away';
  }
  if (openHome.line != null && latestHome.line != null) {
    const pointDelta = Number(latestHome.line) - Number(openHome.line);
    if (Math.abs(pointDelta) > 1e-9) {
      if (market === 'Total') return pointDelta > 0 ? 'over' : 'under';
      return pointDelta < 0 ? 'home' : 'away';
    }
  }
  return 'flat';
}

function referenceSide(market, direction) {
  if (market === 'Total') {
    if (direction === 'under') return 'under';
    return 'over';
  }
  if (direction === 'away') return 'away';
  return 'home';
}

function eventDocsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.events)) return doc.events.filter(Boolean);
  if (doc.eventId && doc.sport) return [doc];
  return [];
}

function visibleObservations(eventDoc, endMs) {
  const obs = [];
  if (eventDoc.open && openVisible(eventDoc.open, endMs)) {
    obs.push({
      slot: 'open',
      at: eventDoc.open.at,
      books: { pinnacle: eventDoc.open.quotes || {} },
    });
  }
  const checks = ((eventDoc.checks) || []).slice().sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
  for (const check of checks) {
    if (!checkVisible(check, endMs)) continue;
    obs.push({ slot: check.slot, at: check.at, books: check.books || {} });
  }
  return obs;
}

function marketsIn(obsList) {
  const groups = new Map();
  for (const obs of obsList) {
    for (const book of CHECK_BOOKS) {
      for (const quote of Object.values(bookQuotes(obs, book))) {
        if (!quote || !quote.market) continue;
        if (!groups.has(quote.market)) {
          groups.set(quote.market, {
            market: quote.market,
            homeTeam: quote.homeTeam || null,
            awayTeam: quote.awayTeam || null,
          });
        }
      }
    }
  }
  return [...groups.values()];
}

/**
 * Per game/market through the 10:30 ET lock: open, 3:00 baseline, latest,
 * net direction from that baseline (else the open), total Pinnacle move,
 * move count, and steam rows (each carries windowMinutes).
 */
function summarizeEvent(eventDoc, endMs) {
  const obs = visibleObservations(eventDoc, endMs);
  const moves = ((eventDoc.moves) || []).filter((m) => moveVisible(m, endMs));
  const steams = ((eventDoc.steams) || []).filter((s) => moveVisible(s, endMs));
  const games = [];
  for (const group of marketsIn(obs)) {
    const market = group.market;
    const openObs = obs.find((row) => row.slot === 'open') || null;
    const baselineObs = obs.find((row) => row.slot === '0300') || null;
    const directionObs = baselineObs || openObs;
    const latest = obs.length ? obs[obs.length - 1] : null;
    const openSides = openObs ? sidesFromQuotes(bookQuotes(openObs, 'pinnacle'), market) : {};
    const baselineSides = baselineObs ? sidesFromQuotes(bookQuotes(baselineObs, 'pinnacle'), market) : {};
    const directionSides = directionObs ? sidesFromQuotes(bookQuotes(directionObs, 'pinnacle'), market) : {};
    const latestSides = latest ? sidesFromQuotes(bookQuotes(latest, 'pinnacle'), market) : {};
    const dkObs = [...obs].reverse().find((row) => Object.values(bookQuotes(row, 'draftkings')).some((q) => q && q.market === market));
    const direction = netDirection(directionSides, latestSides, market);
    const directionFrom = baselineObs ? 'baseline-0300' : (openObs ? 'open' : null);
    const ref = referenceSide(market, direction);
    const marketMoves = moves.filter((m) => m.market === market);
    const marketSteams = steams.filter((s) => s.market === market);
    games.push({
      sport: eventDoc.sport,
      eventId: eventDoc.eventId,
      market,
      homeTeam: eventDoc.homeTeam || group.homeTeam || null,
      awayTeam: eventDoc.awayTeam || group.awayTeam || null,
      open: openObs ? { at: openObs.at, book: 'pinnacle', sides: openSides } : null,
      baseline: baselineObs ? { at: baselineObs.at, slot: '0300', book: 'pinnacle', sides: baselineSides } : null,
      directionFrom,
      latest: latest ? { at: latest.at, slot: latest.slot, sides: latestSides } : null,
      draftkings: dkObs ? { at: dkObs.at, slot: dkObs.slot, sides: sidesFromQuotes(bookQuotes(dkObs, 'draftkings'), market) } : null,
      netDirection: direction,
      totalMove: {
        cents: centsBetween(directionSides[ref] && directionSides[ref].price, latestSides[ref] && latestSides[ref].price),
        probPts: probPtsBetween(directionSides[ref] && directionSides[ref].noVig, latestSides[ref] && latestSides[ref].noVig),
        pointChange: pointBetween(directionSides[ref] && directionSides[ref].line, latestSides[ref] && latestSides[ref].line),
      },
      moveCount: marketMoves.length,
      steam: marketSteams.length > 0,
      steamReason: marketSteams.length ? [...new Set(marketSteams.map((s) => s.reason))].join('+') : null,
      steams: marketSteams,
      windowMinutes: Number(PINNACLE_LINE_MOVE.windowMinutes != null ? PINNACLE_LINE_MOVE.windowMinutes : STEAM_WINDOW_MIN),
    });
  }
  return games;
}

function summarizeDoc(doc, opts = {}) {
  const dateISO = (opts && opts.dateISO) || (doc && doc.date) || null;
  const endMs = cutoffMs(dateISO, opts && opts.cutoffIso);
  const games = [];
  for (const eventDoc of eventDocsOf(doc)) {
    if (eventDoc.schema && eventDoc.schema !== SCHEMA) continue;
    games.push(...summarizeEvent(eventDoc, endMs));
  }
  games.sort((a, b) => {
    if (a.sport !== b.sport) return a.sport < b.sport ? -1 : 1;
    if (a.eventId !== b.eventId) return String(a.eventId) < String(b.eventId) ? -1 : 1;
    return a.market < b.market ? -1 : 1;
  });
  return games;
}

function canonicalMarket(market, side) {
  const m = String(market || '');
  const s = String(side || '');
  if (/total/i.test(m) || /^\s*(over|under)\b/i.test(s)) return 'Total';
  if (/spread|run line|puck/i.test(m)) return 'Spread';
  return 'Moneyline';
}

function summaryForCandidate(candidate, games) {
  if (!candidate) return null;
  const market = canonicalMarket(candidate.market || candidate.betType, candidate.side || candidate.pick);
  const eventId = candidate.eventId || candidate.event_id;
  if (eventId) {
    const hit = (games || []).find((g) => String(g.eventId) === String(eventId) && g.market === market);
    if (hit) return hit;
  }
  const home = String(candidate.homeTeam || '').toLowerCase();
  const away = String(candidate.awayTeam || '').toLowerCase();
  if (!home || !away) return null;
  return (games || []).find((g) => g.market === market
    && String(g.homeTeam || '').toLowerCase() === home
    && String(g.awayTeam || '').toLowerCase() === away) || null;
}

function slateAudit(doc, dateISO, attached, games) {
  const rows = games || summarizeDoc(doc, { dateISO });
  const events = eventDocsOf(doc);
  return {
    store: LINE_MOVE_STORE,
    date: dateISO || (doc && doc.date) || null,
    cutoff: '10:00 ET',
    eventCount: events.length,
    moveCount: rows.reduce((sum, row) => sum + (row.moveCount || 0), 0),
    steamCount: rows.reduce((sum, row) => sum + ((row.steams && row.steams.length) || 0), 0),
    games: rows,
    candidates: (attached || []).filter((c) => c && c.lineMoveContext).map((c) => ({
      sport: c.sport || null,
      eventId: c.eventId || c.event_id || null,
      matchup: c.matchup || null,
      market: c.market || c.betType || null,
      side: c.side || c.pick || null,
      lineMove: c.lineMoveContext,
    })),
  };
}

/**
 * Context only. Returns the same pick and parlay arrays.
 * Copies of candidates carry lineMove (the summary) and lineMoveContext.
 * Originals are not mutated, so a steam lineMove already copied onto a pick stays put.
 * No doc: audit and candidates come back unchanged.
 */
function applyLineMoveContext(input) {
  const src = input || {};
  const picks = src.picks || [];
  const parlayLegs = src.parlayLegs || [];
  if (!src.doc) {
    return { picks, parlayLegs, candidates: src.candidates || [], audit: src.audit || null };
  }
  const dateISO = src.dateISO || src.doc.date || null;
  const games = summarizeDoc(src.doc, { dateISO, cutoffIso: src.cutoffIso });
  const candidates = (src.candidates || []).map((c) => {
    const summary = summaryForCandidate(c, games);
    if (!summary) return { ...c, lineMoveContext: null };
    return { ...c, lineMove: summary, lineMoveContext: summary };
  });
  let audit = src.audit || null;
  if (audit) audit = { ...audit, lineMove: slateAudit(src.doc, dateISO, candidates, games) };
  return { picks, parlayLegs, candidates, audit };
}

function rowFromSideQuotes(quotes) {
  const row = {};
  for (const quote of Object.values(quotes || {})) {
    if (!quote) continue;
    if (quote.market === 'Moneyline' && quote.side === 'home') row.mlHome = quote.price;
    else if (quote.market === 'Moneyline' && quote.side === 'away') row.mlAway = quote.price;
    else if (quote.market === 'Spread' && quote.side === 'home') {
      row.spreadHome = quote.line;
      row.spreadHomeOdds = quote.price;
    } else if (quote.market === 'Spread' && quote.side === 'away') {
      row.spreadAway = quote.line;
      row.spreadAwayOdds = quote.price;
    } else if (quote.market === 'Total' && quote.side === 'over') {
      row.total = quote.line;
      row.overOdds = quote.price;
    } else if (quote.market === 'Total' && quote.side === 'under') {
      row.underOdds = quote.price;
      if (row.total == null) row.total = quote.line;
    }
  }
  return row;
}

function storedBookRow(obs, names) {
  for (const name of names) {
    const row = rowFromSideQuotes(bookQuotes(obs, name));
    if (Object.keys(row).length) return { name, row };
  }
  return null;
}

function gameFromObservation(eventDoc, obs) {
  const pin = rowFromSideQuotes(bookQuotes(obs, 'pinnacle'));
  const dk = rowFromSideQuotes(bookQuotes(obs, 'draftkings'));
  const books = {};
  if (Object.keys(pin).length) books.pinnacle = pin;
  if (Object.keys(dk).length) books.draftkings = dk;
  // Circa and Hard Rock are copied only when the stored observation
  // already has them. This does not add an Odds API bookmaker.
  const circa = storedBookRow(obs, ['circa', 'circasports']);
  const hardRock = storedBookRow(obs, ['hardrockbet', 'hardrock']);
  if (circa) books[circa.name] = circa.row;
  if (hardRock) books[hardRock.name] = hardRock.row;
  if (!Object.keys(books).length) return null;
  const away = eventDoc.awayTeam;
  const home = eventDoc.homeTeam;
  if (!away || !home) return null;
  return {
    homeTeam: home,
    awayTeam: away,
    capturedAt: obs.at || null,
    books,
    sharpConsensus: {
      spreadHome: pin.spreadHome != null ? pin.spreadHome : null,
      total: pin.total != null ? pin.total : null,
      mlHome: pin.mlHome != null ? pin.mlHome : null,
      mlAway: pin.mlAway != null ? pin.mlAway : null,
    },
  };
}

function pollFromSlot(slot, at, games) {
  const label = slot === 'open' ? 'open' : String(slot || '').padStart(4, '0');
  return {
    hhmm: label,
    slot: slot || label,
    capturedAt: at || null,
    games,
    gameCount: Object.keys(games).length,
    source: 'pinnacle-line-moves',
  };
}

/**
 * 10:00 check vs the 3:00 baseline (else the open), as line-path polls.
 * latest is slot 1000 only. A 0300-only doc does not become the close.
 * A stored open is included when present and is not a substitute for 1000.
 */
function selectionPollsFromDoc(doc, opts = {}) {
  const empty = { earliest: null, latest: null, path: null };
  const events = eventDocsOf(doc);
  if (!events.length) return empty;
  const dateISO = (opts && opts.dateISO) || (doc && doc.date) || null;
  const endMs = cutoffMs(dateISO, opts && opts.cutoffIso);
  const buckets = {
    open: { games: {}, at: null },
    '0300': { games: {}, at: null },
    '1000': { games: {}, at: null },
  };
  for (const eventDoc of events) {
    const obs = visibleObservations(eventDoc, endMs);
    if (!obs.length) continue;
    const away = eventDoc.awayTeam;
    const home = eventDoc.homeTeam;
    if (!away || !home) continue;
    const key = `${String(away).trim()} @ ${String(home).trim()}`.toLowerCase();
    for (const slot of ['open', '0300', '1000']) {
      const row = obs.find((item) => item.slot === slot);
      if (!row) continue;
      const game = gameFromObservation(eventDoc, row);
      if (!game) continue;
      buckets[slot].games[key] = game;
      if (!buckets[slot].at) buckets[slot].at = row.at || null;
    }
  }
  const polls = [];
  let earliest = null;
  let latest = null;
  if (Object.keys(buckets.open.games).length) {
    polls.push(pollFromSlot('open', buckets.open.at, buckets.open.games));
  }
  if (Object.keys(buckets['0300'].games).length) {
    earliest = pollFromSlot('0300', buckets['0300'].at, buckets['0300'].games);
    polls.push(earliest);
  } else if (polls.length && polls[0].hhmm === 'open') {
    earliest = polls[0];
  }
  if (Object.keys(buckets['1000'].games).length) {
    latest = pollFromSlot('1000', buckets['1000'].at, buckets['1000'].games);
    polls.push(latest);
  }
  if (!polls.length) return empty;
  return {
    earliest,
    latest,
    path: { date: dateISO, polls, source: 'pinnacle-line-moves' },
  };
}

/**
 * Selection line path. A 10:00 snapshot wins. Retired morning snaps are
 * ignored and logged. They are not the line-move input.
 */
function linePathForSelection(morningMeta, doc, opts = {}) {
  const dateISO = opts && opts.dateISO;
  const pin = selectionPollsFromDoc(doc, opts);
  if (pin && pin.latest && pin.latest.gameCount > 0 && String(pin.latest.hhmm || pin.latest.slot) === '1000') {
    return { ...pin, source: 'pinnacle-latest' };
  }
  const morningPolls = (morningMeta && morningMeta.path && morningMeta.path.polls) || [];
  const shaped = shapeOfficialLinePath(morningPolls, dateISO);
  const earliest = (pin && pin.earliest) || shaped.earliest || null;
  if (shaped.latest && shaped.latest.gameCount !== 0) {
    const polls = [];
    if (earliest && earliest !== shaped.latest) polls.push(earliest);
    polls.push(shaped.latest);
    const pathPolls = (shaped.path && shaped.path.polls) || polls;
    return {
      path: { date: dateISO || null, polls: pathPolls, source: 'pull-0300-1000' },
      earliest,
      latest: shaped.latest,
      source: 'pull-0300-1000',
    };
  }
  const retired = morningPolls.some((poll) => {
    const slot = String((poll && (poll.hhmm || poll.slot)) || '');
    return slot === '0600' || slot === '0730' || slot === '0900' || slot === '0915';
  });
  if (retired || (morningMeta && (morningMeta.latest || morningMeta.earliest))) {
    console.warn(JSON.stringify({
      event: 'line-move-snapshot-missing',
      source: 'missing-0300-1000',
      date: dateISO || null,
      missing: shaped.missingSlots,
      ignoredRetiredSlots: ['0600', '0730', '0900', '0915'],
      note: 'refusing retired morning snapshots; line-move needs 0300 and 1000',
    }));
  }
  return {
    path: (pin && pin.path) || shaped.path || null,
    earliest,
    latest: null,
    source: 'missing-0300-1000',
    missingSlots: shaped.missingSlots,
  };
}

function writeBlocked(opts) {
  if (opts && opts.dryRun) return 'dryRun';
  if (replayNoWrite(opts && opts.env)) return 'OMEGA_REPLAY_NO_WRITE';
  return null;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function applyMeta(doc, meta) {
  if (!meta) return doc;
  if (meta.homeTeam) doc.homeTeam = meta.homeTeam;
  if (meta.awayTeam) doc.awayTeam = meta.awayTeam;
  if (meta.commenceTime) doc.commenceTime = meta.commenceTime;
  if (meta.date) doc.date = meta.date;
  return doc;
}

async function defaultRead(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(LINE_MOVE_STORE);
    return await auditBlobCall('GET', `${LINE_MOVE_STORE}/${key}`, () => store.get(key, { type: 'json' }));
  } catch (_) {
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token) return null;
      const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${LINE_MOVE_STORE}/${key}`;
      const resp = await resolveFetch(fetch, { kind: 'blob', provider: 'netlify-blobs' })(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp || !resp.ok) return null;
      return await resp.json();
    } catch (err) {
      return null;
    }
  }
}

async function defaultWrite(key, data) {
  if (replayNoWrite()) {
    logBlocked(`pinnacle-line-move ${key}`);
    return false;
  }
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(LINE_MOVE_STORE);
    await auditBlobCall('PUT', `${LINE_MOVE_STORE}/${key}`, () => store.setJSON(key, data));
    return true;
  } catch (sdkErr) {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw sdkErr;
    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${LINE_MOVE_STORE}/${encodeURIComponent(key)}`;
    const resp = await resolveFetch(fetch, { kind: 'blob', provider: 'netlify-blobs' })(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!resp || !resp.ok) throw new Error(`blob PUT ${key} → ${resp && resp.status}`);
    return true;
  }
}

async function ensureDateIndex(dateISO, sport, eventId, opts, read, write) {
  if (!dateISO) return { wrote: false, reason: 'no-date' };
  const key = dateIndexKey(dateISO);
  let index = null;
  try { index = await read(key); } catch (_) { index = null; }
  const events = index && Array.isArray(index.events) ? index.events.slice() : [];
  if (events.some((row) => row && row.sport === sport && String(row.eventId) === String(eventId))) {
    return { wrote: false, reason: 'indexed', key };
  }
  const next = {
    schema: SCHEMA,
    date: dateISO,
    store: LINE_MOVE_STORE,
    appendOnly: true,
    events: events.concat([{ sport, eventId: String(eventId) }]),
  };
  await write(key, next);
  return { wrote: true, reason: null, key };
}

async function readLineMoveKey(key, opts = {}) {
  const read = (opts && opts.read) || defaultRead;
  try {
    return await read(key);
  } catch (err) {
    console.error(`[pinnacle-line-move] read soft-fail: ${err && err.message}`);
    return null;
  }
}

async function readPinnacleLineMoves(dateISO, opts = {}) {
  const read = (opts && opts.read) || defaultRead;
  try {
    const index = await read(dateIndexKey(dateISO));
    if (!index || index.schema !== SCHEMA || !Array.isArray(index.events)) return null;
    const events = [];
    for (const row of index.events) {
      if (!row || !row.sport || row.eventId == null) continue;
      const doc = await read(eventKey(row.sport, row.eventId));
      if (doc && doc.schema === SCHEMA) events.push(doc);
    }
    return { schema: SCHEMA, date: dateISO, store: LINE_MOVE_STORE, events };
  } catch (err) {
    console.error(`[pinnacle-line-move] read soft-fail: ${err && err.message}`);
    return null;
  }
}

/**
 * Store the Pinnacle open once. A second call for the same sport/eventId
 * does not write and does not replace the timestamp.
 */
async function storeOpen(sport, eventId, open, opts = {}) {
  const key = eventKey(sport, eventId);
  const read = opts.read || defaultRead;
  const block = writeBlocked(opts);
  let prev = null;
  try { prev = await read(key); } catch (_) { prev = null; }
  if (prev && prev.schema && prev.schema !== SCHEMA) {
    return { wrote: false, reason: 'schema', key, doc: prev, moves: [], steams: [] };
  }
  if (prev && prev.open) {
    return { wrote: false, reason: 'open-exists', key, doc: prev, moves: [], steams: [] };
  }
  const doc = prev ? clone(prev) : emptyEventDoc(sport, eventId);
  applyMeta(doc, open);
  doc.open = {
    at: open && open.at,
    book: 'pinnacle',
    quotes: (open && open.quotes) || {},
  };
  doc.updatedAt = open && open.at;
  if (block) {
    if (block === 'OMEGA_REPLAY_NO_WRITE') logBlocked(`pinnacle-line-move ${key}`);
    return { wrote: false, reason: block, key, doc, moves: [], steams: [] };
  }
  const write = opts.write || defaultWrite;
  await write(key, doc);
  const indexed = await ensureDateIndex(doc.date, sport, eventId, opts, read, write);
  return { wrote: true, reason: null, key, indexKey: indexed.key || null, doc, moves: [], steams: [] };
}

/**
 * Append one 0300 / 1000 check. The same slot is not written twice.
 * Moves and steams are computed against the previous observation only.
 */
async function storeCheck(sport, eventId, check, opts = {}) {
  const key = eventKey(sport, eventId);
  const read = opts.read || defaultRead;
  const block = writeBlocked(opts);
  const slot = check && check.slot;
  let prev = null;
  try { prev = await read(key); } catch (_) { prev = null; }
  if (prev && prev.schema && prev.schema !== SCHEMA) {
    return { wrote: false, reason: 'schema', key, doc: prev, moves: [], steams: [] };
  }
  const doc = prev ? clone(prev) : emptyEventDoc(sport, eventId);
  applyMeta(doc, check);
  if (!CHECK_SLOTS.includes(slot)) {
    return { wrote: false, reason: 'slot', key, doc, moves: [], steams: [] };
  }
  if ((doc.checks || []).some((row) => row && row.slot === slot)) {
    return { wrote: false, reason: 'duplicate', key, doc: prev || doc, moves: [], steams: [] };
  }
  const prior = previousObservation(doc, slot);
  const moves = [];
  for (const book of CHECK_BOOKS) {
    const prevQuotes = prior ? (prior.books && prior.books[book]) || {} : {};
    const nextQuotes = (check.books && check.books[book]) || {};
    moves.push(...detectMoves(prevQuotes, nextQuotes, {
      at: check.at,
      fromSlot: prior ? prior.slot : null,
      toSlot: slot,
      book,
    }));
  }
  const steams = steamsForStep(moves, {
    fromSlot: prior ? prior.slot : null,
    toSlot: slot,
    fromAt: prior ? prior.at : null,
    toAt: check.at,
    windowMinutes: opts.windowMinutes != null ? opts.windowMinutes : PINNACLE_LINE_MOVE.windowMinutes,
  });
  const stored = {
    slot,
    at: check.at,
    books: {
      pinnacle: (check.books && check.books.pinnacle) || {},
      draftkings: (check.books && check.books.draftkings) || {},
    },
    requestsRemaining: check.requestsRemaining == null ? null : check.requestsRemaining,
  };
  doc.checks = (doc.checks || []).concat([stored]);
  doc.moves = (doc.moves || []).concat(moves);
  doc.steams = (doc.steams || []).concat(steams);
  doc.updatedAt = check.at;
  if (block) {
    if (block === 'OMEGA_REPLAY_NO_WRITE') logBlocked(`pinnacle-line-move ${key}`);
    return { wrote: false, reason: block, key, doc, moves, steams };
  }
  const write = opts.write || defaultWrite;
  await write(key, doc);
  const indexed = await ensureDateIndex(doc.date, sport, eventId, opts, read, write);
  return { wrote: true, reason: null, key, indexKey: indexed.key || null, doc, moves, steams };
}

module.exports = {
  LINE_MOVE_STORE,
  SCHEMA,
  PINNACLE_SPORTS,
  CHECK_SLOTS,
  SLOT_ORDER,
  CHECK_BOOKS,
  centsBetween,
  probPtsBetween,
  pointBetween,
  quotesFromEvent,
  quotesFromEvents,
  quotesByEvent,
  detectMoves,
  sizeMove,
  confirmSteam,
  summarizeDoc,
  netDirection,
  summaryForCandidate,
  applyLineMoveContext,
  selectionPollsFromDoc,
  linePathForSelection,
  readLineMoveKey,
  readPinnacleLineMoves,
  storeOpen,
  storeCheck,
  eventKey,
  dateIndexKey,
  commenceEtDate,
  writeBlocked,
  shiftYmd,
  emptyEventDoc,
  canonicalMarket,
};
