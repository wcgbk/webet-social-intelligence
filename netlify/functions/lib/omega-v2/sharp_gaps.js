'use strict';

/**
 * 3 AM -> 10 AM Pinnacle context for the v2 card.
 * Missing 3 AM prices do not veto and do not boost.
 * The bet book's own implied is not a fair when Pinnacle fair is on.
 * A 10 AM poll with no Pinnacle/Circa pair keeps the stored fair, tags the
 * row, and leaves it placeable. It does not empty the card.
 */

const { noVigTwoWay, americanToImplied } = require('../omega-vnext/odds_math');
const { MAX_EDGE, clampWinProb } = require('./constants');
const {
  lineMoveEnabled, moveShrinkEnabled, pinnacleFairEnabled, keyConvertEnabled,
  lineMoveVetoPp, lineMoveStalePp,
} = require('./constants');
const {
  sportOf, marketOf, conversionAllowed, convertCoverProb, pushProb, pushAwareEv, isIntegerPoint,
} = require('./key_convert');

const FOLLOW = 0.40;
const SHRINK = { NHL: 0.35 };
const pollCache = new WeakMap();

function normTeam(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\bsaint louis\b/g, 'st louis')
    .replace(/\s+/g, ' ')
    .trim();
}

function gkey(away, home) {
  const a = normTeam(away);
  const h = normTeam(home);
  if (!a || !h) return '';
  return `${a} @ ${h}`;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

function pointsEqual(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-6;
}

function round6(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 1e6) / 1e6;
}

function canonBook(key) {
  const s = String(key || '').toLowerCase();
  if (s === 'hardrock' || s === 'hardrockbet_oh') return 'hardrockbet';
  if (s === 'circasports' || s === 'circa_sports' || s === 'circa sports') return 'circa';
  return s;
}

function namesMatch(a, b) {
  const x = normTeam(a);
  const y = normTeam(b);
  return !!x && x === y;
}

function teamFromPick(pick) {
  let text = String(pick || '').trim();
  text = text.replace(/\s+ML$/i, '').replace(/\s+moneyline$/i, '').trim();
  if (/^(over|under)\b/i.test(text)) return null;
  const m = text.match(/^(.*?)(?:\s+[+-][0-9]+(?:\.[0-9]+)?)\s*$/);
  return (m ? m[1] : text).trim() || null;
}

function totalSide(pick) {
  if (/^\s*over\b/i.test(pick || '')) return 'over';
  if (/^\s*under\b/i.test(pick || '')) return 'under';
  return null;
}

function specOf(cand) {
  if (!cand) return null;
  const pick = cand.pick || cand.side || '';
  const market = marketOf(cand.market || cand.marketFamily || cand.betType);
  const sport = sportOf(cand.sport);
  if (market === 'Total') {
    const side = totalSide(pick);
    const point = num(cand.line);
    if (!side || point == null) return null;
    return { market, sport, side, point, team: null };
  }
  if (market === 'Spread') {
    const team = teamFromPick(pick);
    const point = num(cand.line);
    if (!team || point == null) return null;
    return { market, sport, side: null, point, team };
  }
  const team = teamFromPick(pick);
  if (!team) return null;
  return { market: 'Moneyline', sport, side: null, point: null, team };
}

function emptyBook(lastUpdate) {
  return { lastUpdate: lastUpdate || null, h2h: { home: null, away: null }, spreads: [], totals: [] };
}

function addOutcome(book, marketKey, name, price, point) {
  const px = num(price);
  if (px == null || px === 0) return;
  if (marketKey === 'h2h') return;
  const row = { name: String(name || ''), point: num(point), price: px };
  if (marketKey === 'spreads' && row.point != null) book.spreads.push(row);
  if (marketKey === 'totals' && row.point != null) book.totals.push(row);
}

function ingestEvent(ev, slot, index) {
  if (!ev) return;
  const away = ev.away_team || ev.awayTeam;
  const home = ev.home_team || ev.homeTeam;
  const key = gkey(away, home);
  if (!key) return;
  const id = `${slot}|${key}`;
  let game = index.get(id);
  if (!game) {
    game = {
      slot,
      key,
      sport: sportOf(ev.sport),
      away,
      home,
      commence: ev.commence_time || ev.commenceTime || null,
      books: {},
    };
    index.set(id, game);
  }
  for (const bm of ev.bookmakers || []) {
    const bk = canonBook(bm.key);
    if (!bk) continue;
    const book = game.books[bk] || emptyBook(bm.last_update || bm.lastUpdate);
    if (bm.last_update || bm.lastUpdate) book.lastUpdate = bm.last_update || bm.lastUpdate;
    for (const mkt of bm.markets || []) {
      const mk = mkt.key;
      if (mk === 'h2h') {
        for (const o of mkt.outcomes || []) {
          const px = num(o.price != null ? o.price : o.american);
          if (px == null) continue;
          if (namesMatch(o.name, home)) book.h2h.home = px;
          else if (namesMatch(o.name, away)) book.h2h.away = px;
        }
      } else if (mk === 'spreads' || mk === 'totals') {
        book[mk] = [];
        for (const o of mkt.outcomes || []) {
          addOutcome(book, mk, o.name, o.price != null ? o.price : o.american, o.point);
        }
      }
    }
    game.books[bk] = book;
  }
}

function ingestSnap(games, slot, index) {
  if (!games || typeof games !== 'object') return;
  for (const g of Object.values(games)) {
    if (!g) continue;
    const away = g.awayTeam || g.away_team;
    const home = g.homeTeam || g.home_team;
    ingestEvent({
      away_team: away,
      home_team: home,
      sport: g.sport,
      commence_time: g.commenceTime || g.commence_time,
      bookmakers: Object.entries(g.books || {}).map(([key, row]) => {
        const markets = [];
        const spreads = [];
        if (row && row.spreadHome != null) spreads.push({ name: home, price: row.spreadHomeOdds, point: row.spreadHome });
        if (row && row.spreadAway != null) spreads.push({ name: away, price: row.spreadAwayOdds, point: row.spreadAway });
        if (spreads.length) markets.push({ key: 'spreads', outcomes: spreads });
        const totals = [];
        if (row && row.total != null) {
          if (row.overOdds != null) totals.push({ name: 'Over', price: row.overOdds, point: row.total });
          if (row.underOdds != null) totals.push({ name: 'Under', price: row.underOdds, point: row.total });
        }
        if (totals.length) markets.push({ key: 'totals', outcomes: totals });
        const h2h = [];
        if (row && row.mlHome != null) h2h.push({ name: home, price: row.mlHome });
        if (row && row.mlAway != null) h2h.push({ name: away, price: row.mlAway });
        if (h2h.length) markets.push({ key: 'h2h', outcomes: h2h });
        return { key, last_update: row && (row.lastUpdate || row.last_update), markets };
      }),
    }, slot, index);
  }
}

function buildIndex(src) {
  const index = new Map();
  if (!src || typeof src !== 'object') return index;
  if (Array.isArray(src['0300']) || Array.isArray(src['1000']) || Array.isArray(src.close)) {
    for (const slot of ['0300', '1000', 'close']) {
      for (const ev of src[slot] || []) ingestEvent(ev, slot, index);
    }
  }
  if (src.games0300) ingestSnap(src.games0300, '0300', index);
  if (src.games1000) ingestSnap(src.games1000, '1000', index);
  if (Array.isArray(src.polls)) {
    for (const poll of src.polls) {
      const slot = poll && (poll.hhmm || poll.slot);
      if (poll && poll.games && slot) ingestSnap(poll.games, slot, index);
      if (poll && Array.isArray(poll.events) && slot) {
        for (const ev of poll.events) ingestEvent(ev, slot, index);
      }
    }
  }
  if (Array.isArray(src.events0300)) for (const ev of src.events0300) ingestEvent(ev, '0300', index);
  if (Array.isArray(src.events1000)) for (const ev of src.events1000) ingestEvent(ev, '1000', index);
  if (src.eventsBySport && typeof src.eventsBySport === 'object') {
    for (const events of Object.values(src.eventsBySport)) {
      for (const ev of events || []) ingestEvent(ev, '1000', index);
    }
  }
  return index;
}

function pollsOf(src) {
  if (!src || typeof src !== 'object') return null;
  if (pollCache.has(src)) return pollCache.get(src);
  const index = buildIndex(src);
  const out = index.size ? index : null;
  pollCache.set(src, out);
  return out;
}

function gameAt(index, slot, cand) {
  if (!index) return null;
  let away = cand && cand.awayTeam;
  let home = cand && cand.homeTeam;
  if ((!away || !home) && cand && cand.matchup && String(cand.matchup).includes('@')) {
    const parts = String(cand.matchup).split('@');
    away = away || parts[0];
    home = home || parts[1];
  }
  const key = gkey(away, home);
  if (!key) return null;
  return index.get(`${slot}|${key}`) || null;
}

function bookOf(game, name) {
  if (!game || !game.books) return null;
  return game.books[canonBook(name)] || null;
}

function oppositeOf(rows, mine, spec) {
  if (!mine || !rows) return null;
  if (spec.market === 'Total') {
    const want = spec.side === 'over' ? 'under' : 'over';
    return rows.find((row) => pointsEqual(row.point, mine.point)
      && String(row.name || '').toLowerCase() === want) || null;
  }
  if (rows.length === 2) return rows.find((row) => row !== mine) || null;
  return rows.find((row) => row !== mine && Math.abs((row.point || 0) + (mine.point || 0)) < 0.51) || null;
}

function sideRows(book, spec) {
  if (!book) return [];
  if (spec.market === 'Total') return book.totals || [];
  if (spec.market === 'Spread') return book.spreads || [];
  return [];
}

function matchRow(row, spec) {
  if (!row) return false;
  if (spec.market === 'Total') return String(row.name || '').toLowerCase() === spec.side;
  if (spec.market === 'Spread') return namesMatch(row.name, spec.team);
  return false;
}

/** Power no-vig for this side at an exact number. Null when the pair is missing. */
function pairAt(game, bookName, spec, point) {
  const book = bookOf(game, bookName);
  if (!book) return null;
  if (spec.market === 'Moneyline') {
    if (point != null) return null;
    const isHome = namesMatch(spec.team, game.home);
    const isAway = namesMatch(spec.team, game.away);
    if (!isHome && !isAway) return null;
    const mine = isHome ? book.h2h.home : book.h2h.away;
    const opp = isHome ? book.h2h.away : book.h2h.home;
    const nv = noVigTwoWay(mine, opp);
    if (!nv) return null;
    return { p: nv.p1, point: null, price: mine, lastUpdate: book.lastUpdate };
  }
  const rows = sideRows(book, spec);
  const mine = rows.find((row) => matchRow(row, spec) && pointsEqual(row.point, point));
  if (!mine) return null;
  const opp = oppositeOf(rows, mine, spec);
  if (!opp || num(opp.price) == null) return null;
  const nv = noVigTwoWay(mine.price, opp.price);
  if (!nv) return null;
  return { p: nv.p1, point: mine.point, price: mine.price, lastUpdate: book.lastUpdate };
}

function nearestPair(game, bookName, spec) {
  const book = bookOf(game, bookName);
  if (!book || spec.market === 'Moneyline' || spec.point == null) return null;
  const rows = sideRows(book, spec).filter((row) => matchRow(row, spec));
  let best = null;
  for (const row of rows) {
    const dist = Math.abs(row.point - spec.point);
    if (dist < 1e-9 || dist > 1.5 + 1e-9) continue;
    if (!best || dist < best.dist) best = { row, dist };
  }
  if (!best) return null;
  return pairAt(game, bookName, spec, best.row.point);
}

/** Pinnacle (then Circa) power no-vig at the bet number, converting at most 1.5. */
function fairAt(game, spec) {
  if (!game || !spec) return null;
  const pin = pairAt(game, 'pinnacle', spec, spec.point);
  if (pin) {
    return {
      p: pin.p, book: 'pinnacle', point: pin.point, converted: false,
      q: isIntegerPoint(spec.point) ? pushProb(spec.sport, spec.market, spec.point) : 0,
      lastUpdate: pin.lastUpdate,
    };
  }
  for (const book of ['circa']) {
    const exact = pairAt(game, book, spec, spec.point);
    if (exact) {
      return {
        p: exact.p, book, point: exact.point, converted: false,
        q: isIntegerPoint(spec.point) ? pushProb(spec.sport, spec.market, spec.point) : 0,
        lastUpdate: exact.lastUpdate,
      };
    }
  }
  if (!conversionAllowed(spec.sport, spec.market)) return null;
  const near = nearestPair(game, 'pinnacle', spec);
  if (!near) return null;
  const side = spec.market === 'Total' ? spec.side : 'spread';
  const conv = convertCoverProb({
    sport: spec.sport,
    market: spec.market,
    p: near.p,
    fromPoint: near.point,
    toPoint: spec.point,
    side,
  });
  if (!conv) return null;
  return {
    p: conv.p, book: 'pinnacle', point: near.point, converted: true, q: conv.q, lastUpdate: near.lastUpdate,
  };
}

function impliedAt(game, bookName, spec) {
  const hit = pairAt(game, bookName, spec, spec.point);
  if (!hit) return null;
  return { implied: americanToImplied(hit.price), lastUpdate: hit.lastUpdate, price: hit.price };
}

function shrinkLambda(sport) {
  const s = sportOf(sport);
  return SHRINK[s] || 0;
}

function clampBet(p, env) {
  return clampWinProb(p, env);
}

function computeMove(index, cand, spec) {
  const g3 = gameAt(index, '0300', cand);
  const g10 = gameAt(index, '1000', cand);
  if (!g3 || !g10) return null;
  const p3 = fairAt(g3, spec);
  const p10 = fairAt(g10, spec);
  if (!p3 || !p10 || p3.book !== 'pinnacle' || p10.book !== 'pinnacle') return null;
  const m = p10.p - p3.p;
  const betBook = canonBook(cand.book);
  const d3 = impliedAt(g3, betBook, spec);
  const d10 = impliedAt(g10, betBook, spec);
  const dkMove = d3 && d10 && d3.implied != null && d10.implied != null ? d10.implied - d3.implied : null;
  const pinAt = p10.lastUpdate == null ? null : String(p10.lastUpdate);
  const dkAt = d10 && d10.lastUpdate != null ? String(d10.lastUpdate) : null;
  const quoteOlder = !!(pinAt && dkAt && dkAt < pinAt);
  const levelLagPp = d10 && d10.implied != null ? (p10.p - d10.implied) * 100 : null;
  const dkLag = dkMove == null ? null : m - dkMove;
  return { p3: p3.p, p10: p10.p, m, dkMove, dkLag, quoteOlder, levelLagPp, fair10: p10 };
}

function staleOf(move, stalePp, cand) {
  if (cand && cand.staleSoft === true) return true;
  if (!move || !(move.m >= stalePp)) return false;
  if (move.dkMove != null && move.dkMove < FOLLOW * move.m) return true;
  if (move.quoteOlder) return true;
  if (move.dkMove == null && move.levelLagPp != null && move.levelLagPp >= 1.5) return true;
  return false;
}

function lineMoveRecord(move, stale) {
  if (!move) return null;
  return {
    p3: round6(move.p3),
    p10: round6(move.p10),
    m: round6(move.m),
    dkLag: move.dkLag == null ? null : round6(move.dkLag),
    stale: !!stale,
  };
}

/**
 * Stored fair stays. The tag is meta for rank only. sharpAudit keeps the
 * old drop reason without making the row unplaceable.
 */
function tagStoredFallback(candidate, moveOn, shrinkOn, record, stale, move) {
  const next = {
    ...candidate,
    calibration: candidate.calibration ? { ...candidate.calibration } : candidate.calibration,
    noSharpFair: true,
    fairSource: 'stored-fallback',
    sharpAudit: 'no-sharp-fair',
  };
  const needMove = (moveOn && (record || stale)) || (shrinkOn && move);
  if (!needMove) return next;
  next._sharp = {
    lineMovePinn: record,
    stale: !!stale,
    softLagPp: stale && move && move.dkLag != null
      ? round6(move.dkLag * 100)
      : (move && move.levelLagPp != null ? round6(move.levelLagPp) : null),
    shrink: shrinkOn && move ? { p3: move.p3, p10: move.p10 } : null,
    pushQ: 0,
    pushAware: false,
  };
  return next;
}

/**
 * Adjust the candidate before the existing annotate math.
 * Null means the row is unchanged. A rejectReason drops it before the cut.
 * noSharpFair keeps the stored fair and stays placeable.
 */
function applySharpPrep(candidate, opts) {
  const env = opts && opts.env;
  const moveOn = lineMoveEnabled(env);
  const shrinkOn = moveShrinkEnabled(env);
  const fairOn = pinnacleFairEnabled(env);
  const keyOn = keyConvertEnabled(env);
  if (!moveOn && !shrinkOn && !fairOn && !keyOn) return null;
  const index = pollsOf(opts && opts.linePolls);
  if (!index) return null;
  const spec = specOf(candidate);
  if (!spec) {
    if (keyOn && candidate && candidate.needsKeyConvert) return { rejectReason: 'dk-hr-line-mismatch' };
    if (fairOn) return { candidate: tagStoredFallback(candidate) };
    return null;
  }
  const g10 = gameAt(index, '1000', candidate);
  const fair = g10 ? fairAt(g10, spec) : null;
  const move = (moveOn || shrinkOn) ? computeMove(index, candidate, spec) : null;
  const stalePp = lineMoveStalePp(env);
  const stale = moveOn && move ? staleOf(move, stalePp, candidate) : false;
  const record = move ? lineMoveRecord(move, stale) : null;
  if (moveOn && move && move.m <= -lineMoveVetoPp(env)) {
    return { rejectReason: 'pinnacle-moved-against', lineMovePinn: record };
  }
  if (keyOn && candidate && candidate.needsKeyConvert && !(fair && fair.p != null)) {
    return { rejectReason: 'dk-hr-line-mismatch', lineMovePinn: record };
  }
  if (fairOn && !fair) {
    return { candidate: tagStoredFallback(candidate, moveOn, shrinkOn, record, stale, move) };
  }
  const needCopy = (fairOn && fair) || (keyOn && fair && (fair.converted || (fair.q > 0)))
    || (moveOn && (record || stale)) || (shrinkOn && move);
  if (!needCopy) return null;
  const next = {
    ...candidate,
    calibration: candidate.calibration ? { ...candidate.calibration } : candidate.calibration,
  };
  if (fairOn && fair) {
    if (next.calibration) next.calibration.pMkt = fair.p;
    else next.pMkt = fair.p;
  } else if (keyOn && fair && fair.converted) {
    if (next.calibration) next.calibration.pMkt = fair.p;
    else next.pMkt = fair.p;
  }
  next._sharp = {
    lineMovePinn: record,
    stale: !!stale,
    softLagPp: stale && move && move.dkLag != null ? round6(move.dkLag * 100) : (move && move.levelLagPp != null ? round6(move.levelLagPp) : null),
    shrink: shrinkOn && move ? { p3: move.p3, p10: move.p10 } : null,
    pushQ: keyOn && fair && fair.q > 0 ? fair.q : 0,
    pushAware: !!(keyOn && fair && (fair.converted || fair.q > 0) && fair.q > 0),
  };
  return { candidate: next };
}

/** Rank bonus, push EV, and the NHL shrink. A no-op returns the same row. */
function applySharpFinish(row, candidate, opts) {
  const meta = candidate && candidate._sharp;
  if (!meta || !row) return row;
  const env = opts && opts.env;
  const shrinkOn = moveShrinkEnabled(env) && meta.shrink;
  const pushOn = keyConvertEnabled(env) && meta.pushAware && meta.pushQ > 0 && row.pBet != null;
  const stamp = meta.lineMovePinn || meta.stale;
  if (!shrinkOn && !pushOn && !stamp) return row;
  const next = { ...row };
  if (meta.lineMovePinn) next.lineMovePinn = meta.lineMovePinn;
  if (meta.stale) {
    next.staleSoft = true;
    next.softLagPp = meta.softLagPp;
  }
  if (shrinkOn && next.pBet != null && next.qualified) {
    const lam = shrinkLambda(next.sport);
    if (lam) {
      const p = clampBet(next.pBet - lam * (meta.shrink.p10 - meta.shrink.p3), env);
      if (p != null) {
        next.pBet = p;
        if (next.implied != null) next.edge = p - next.implied;
        if (next.decimal != null) next.ev = (p * (next.decimal - 1)) - (1 - p);
        if (next.implied != null && (p - next.implied) > MAX_EDGE) {
          next.qualified = false;
          next.parlayQualified = false;
          next.forcePlaceable = false;
          next.rejectReason = 'price-edge-over-10pp';
        }
      }
    }
  }
  if (pushOn && next.qualified !== false && next.decimal != null) {
    const ev = pushAwareEv(next.pBet, next.decimal, meta.pushQ);
    if (ev != null) {
      next.ev = ev;
      next.pushQ = meta.pushQ;
    }
  }
  return next;
}

/**
 * DK/HR 10 AM quotes whose number is not Pinnacle's, within 1.5 points.
 * Board-shaped rows. The caller maps them through the same candidate builder.
 */
function synthesizeOffLine(pollDoc, boardRows) {
  const index = pollsOf(pollDoc);
  if (!index) return [];
  const have = new Set();
  for (const row of boardRows || []) {
    const line = num(row && row.line);
    const side = String(row && (row.side || row.pick) || '').toLowerCase();
    have.add(`${gkey(row && row.awayTeam, row && row.homeTeam)}|${side}|${line}|${canonBook(row && row.book)}`);
  }
  const out = [];
  for (const [id, game] of index) {
    if (!id.startsWith('1000|')) continue;
    const pin = bookOf(game, 'pinnacle');
    if (!pin) continue;
    for (const bk of ['draftkings', 'hardrockbet']) {
      const book = bookOf(game, bk);
      if (!book) continue;
      for (const market of ['Spread', 'Total']) {
        const rows = market === 'Total' ? book.totals : book.spreads;
        for (const outcome of rows || []) {
          const spec = market === 'Total'
            ? {
              market, sport: game.sport, side: String(outcome.name || '').toLowerCase(),
              point: outcome.point, team: null,
            }
            : {
              market, sport: game.sport, side: null, point: outcome.point, team: outcome.name,
            };
          if (spec.market === 'Total' && spec.side !== 'over' && spec.side !== 'under') continue;
          if (!conversionAllowed(game.sport, market)) continue;
          const exact = pairAt(game, 'pinnacle', spec, spec.point);
          if (exact) continue;
          const near = nearestPair(game, 'pinnacle', spec);
          if (!near) continue;
          const conv = convertCoverProb({
            sport: game.sport,
            market,
            p: near.p,
            fromPoint: near.point,
            toPoint: spec.point,
            side: spec.side || 'spread',
          });
          if (!conv) continue;
          const label = market === 'Total'
            ? `${spec.side === 'over' ? 'Over' : 'Under'} ${formatNum(spec.point)}`
            : `${outcome.name} ${formatSigned(spec.point)}`;
          const dedupe = `${game.key}|${label.toLowerCase()}|${spec.point}|${bk}`;
          if (have.has(dedupe)) continue;
          have.add(dedupe);
          out.push({
            sport: game.sport,
            matchup: `${game.away} @ ${game.home}`,
            side: label,
            market,
            odds: outcome.price,
            line: spec.point,
            book: bk,
            coverProb: conv.p,
            pMkt: conv.p,
            pModel: conv.p,
            commenceTime: game.commence,
            homeTeam: game.home,
            awayTeam: game.away,
            needsKeyConvert: true,
            bestDkHr: { american: outcome.price, book: bk, point: spec.point },
          });
        }
      }
    }
  }
  return out;
}

function formatNum(n) {
  const x = roundHalfPoint(n);
  return Number.isInteger(x) ? String(x) : String(x);
}

function formatSigned(n) {
  const x = roundHalfPoint(n);
  const text = formatNum(x);
  return x > 0 ? `+${text}` : text;
}

function roundHalfPoint(n) {
  return Math.round(Number(n) * 2) / 2;
}

/** Pinnacle close power no-vig at the bet number, then EV at the bet decimal. */
function closeEvForPick(pick, pollDoc) {
  const index = pollsOf(pollDoc);
  if (!index || !pick) return null;
  const cand = {
    sport: pick.sport,
    matchup: pick.matchup,
    pick: pick.side || pick.pick,
    side: pick.side || pick.pick,
    market: pick.market,
    line: pick.line,
    awayTeam: pick.awayTeam,
    homeTeam: pick.homeTeam,
    book: pick.book,
  };
  const spec = specOf(cand);
  const game = gameAt(index, 'close', cand);
  if (!spec || !game) return null;
  const fair = fairAt(game, spec);
  if (!fair) return null;
  const odds = num(pick.odds);
  const dec = odds == null ? null : (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));
  if (!(dec > 1)) return null;
  const q = fair.q > 0 ? fair.q : 0;
  const ev = q > 0 ? pushAwareEv(fair.p, dec, q) : (fair.p * dec - 1);
  if (ev == null || !Number.isFinite(ev)) return null;
  return { ev, pClose: fair.p, q };
}

module.exports = {
  normTeam,
  gkey,
  specOf,
  pollsOf,
  fairAt,
  computeMove,
  applySharpPrep,
  applySharpFinish,
  synthesizeOffLine,
  closeEvForPick,
  shrinkLambda,
  FOLLOW,
};
