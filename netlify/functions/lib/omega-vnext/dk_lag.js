'use strict';

/**
 * DraftKings lags Pinnacle.
 *
 * A fitted market-anchor weight is 0 in every sport, so the model adds
 * nothing beyond the close. The edge that is real is a stale DraftKings
 * price against a fresher one-book no-vig: Pinnacle when that book posts
 * both sides, otherwise Circa (circa, else circasports). Mixed books are
 * not a de-vig.
 *
 * At the candidate's DraftKings price:
 *   marketEv = pinnacleNoVigP × DraftKings decimal − 1
 *   pinMove  = lock no-vig − baseline no-vig for this side
 *   dkMove   = lock DraftKings implied − baseline DraftKings implied
 *
 * The baseline is the 3:00 check when that poll is on the path, else the
 * stored opener. Retired 06:00..09:15 snaps are not a baseline. The lock
 * price is the candidate's current DraftKings
 * number (the latest snapshot). lagEdge equals marketEv only when Pinnacle
 * (or Circa) moved at least DK_LAG.minPinMovePp toward the side, DraftKings implied moved
 * less than DK_LAG.maxDkFollowRatio of that move, and marketEv > 0.
 * OMEGA_DK_LAG=0 records the moves and does not change cover or rank.
 *
 * A lag side publishes coverProb = max(model coverProb, anchor no-vig)
 * and adds lagEdge to the ranking edge (edgePct). Stake EV is recomputed
 * from that cover, so it is never based on a probability above the fresh
 * fair unless the model was already higher. Floors, caps, Kelly, and
 * parlay rules are unchanged.
 */

const { DK_LAG } = require('./config');
const { attachEv } = require('./edge');
const { americanToImplied, americanToDecimal, noVigTwoWay, formatEdgePct } = require('./odds_math');

const MORNING_SLOTS = ['0600', '0730', '0900', '0915'];
/** 3:00 baseline, then the open. 10:00 is the lock, not a baseline. */
const BASELINE_SLOTS = ['0300', 'open'];

function dkLagEnabled(env) {
  const source = env || process.env;
  const raw = source.OMEGA_DK_LAG;
  if (raw == null || String(raw).trim() === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function round6(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function teamHit(side, team) {
  const stripped = String(side || '')
    .replace(/\b(over|under|ml)\b/ig, ' ')
    .replace(/[+-]\d+(?:\.\d+)?/g, ' ');
  const s = normName(stripped);
  const t = normName(team);
  if (!s || !t) return false;
  if (s === t) return true;
  if (s.endsWith(` ${t}`) || s.startsWith(`${t} `) || s.includes(` ${t} `)) return true;
  if (t.length >= 6 && (s.includes(t) || t.includes(s))) return true;
  const sl = s.split(' ').pop();
  const tl = t.split(' ').pop();
  return !!(sl && tl && sl.length > 3 && sl === tl);
}

/** total/over, total/under, spread|ML home, spread|ML away. Null when the side is ambiguous. */
function sideRole(c) {
  const marketRaw = String((c && c.market) || '');
  const side = String((c && (c.side || c.pick)) || '');
  let market = 'ML';
  if (/total/i.test(marketRaw) || /\b(over|under)\b/i.test(side)) market = 'total';
  else if (/spread|puck|run\s*line/i.test(marketRaw)) market = 'spread';
  else if (/[+-]\d/.test(side) && !/moneyline/i.test(marketRaw)) market = 'spread';
  if (market === 'total') {
    if (/\bunder\b/i.test(side)) return { market, role: 'under' };
    if (/\bover\b/i.test(side)) return { market, role: 'over' };
    return null;
  }
  const homeHit = teamHit(side, c && c.homeTeam);
  const awayHit = teamHit(side, c && c.awayTeam);
  if (homeHit && !awayHit) return { market, role: 'home' };
  if (awayHit && !homeHit) return { market, role: 'away' };
  return null;
}

function finiteOdds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/** Paired no-vig and the side's vigged implied. Null unless this book posts both sides. */
function probsFromRow(row, market, role) {
  if (!row || !market || !role) return null;
  let first = null;
  let second = null;
  let sideIsFirst = true;
  if (market === 'total') {
    first = finiteOdds(row.overOdds);
    second = finiteOdds(row.underOdds);
    sideIsFirst = role !== 'under';
  } else if (market === 'spread') {
    first = finiteOdds(row.spreadHomeOdds);
    second = finiteOdds(row.spreadAwayOdds);
    sideIsFirst = role !== 'away';
  } else {
    first = finiteOdds(row.mlHome);
    second = finiteOdds(row.mlAway);
    sideIsFirst = role !== 'away';
  }
  if (first == null || second == null) return null;
  const nv = noVigTwoWay(first, second);
  if (!nv) return null;
  const american = sideIsFirst ? first : second;
  return {
    noVig: sideIsFirst ? nv.p1 : nv.p2,
    implied: americanToImplied(american),
    american,
  };
}

function slotOf(poll) {
  if (!poll) return '';
  const raw = poll.hhmm != null ? poll.hhmm : poll.slot;
  if (raw == null || raw === '') return '';
  return String(raw).padStart(4, '0');
}

function anchorKeys(book) {
  const b = String(book || '').toLowerCase();
  if (b === 'pinnacle') return ['pinnacle'];
  if (b === 'circa' || b === 'circasports') return ['circa', 'circasports'];
  return b ? [b] : [];
}

function bookRow(game, book) {
  const books = game && game.books;
  if (!books) return null;
  const want = String(book || '').toLowerCase();
  if (books[want]) return books[want];
  for (const [key, row] of Object.entries(books)) {
    if (String(key).toLowerCase() === want) return row;
  }
  return null;
}

function findGame(games, away, home) {
  if (!games || typeof games !== 'object') return null;
  const key = `${String(away || '').trim()} @ ${String(home || '').trim()}`.toLowerCase();
  if (games[key]) return games[key];
  const na = normName(away);
  const nh = normName(home);
  if (!na || !nh) return null;
  for (const game of Object.values(games)) {
    if (!game) continue;
    if (normName(game.awayTeam) === na && normName(game.homeTeam) === nh) return game;
  }
  return null;
}

/**
 * 3:00 first, then the stored open. Retired 06:00..09:15 polls are ignored.
 * When neither 3:00 nor open is on the path, the explicit opener is the
 * baseline. A missing opener contributes nothing.
 */
function baselinePolls(polls, opener) {
  const list = (polls || []).filter((p) => p && p.games);
  const rank = { '0300': 0, open: 1 };
  const fresh = list
    .filter((p) => BASELINE_SLOTS.includes(slotOf(p)))
    .slice()
    .sort((a, b) => (rank[slotOf(a)] != null ? rank[slotOf(a)] : 9) - (rank[slotOf(b)] != null ? rank[slotOf(b)] : 9));
  if (fresh.length) return fresh;
  if (opener && opener.games) return [opener];
  return [];
}

/**
 * First baseline poll that has the same anchor book (Circa aliases match
 * each other; Pinnacle does not borrow Circa). DraftKings implied is read
 * off that same poll.
 */
function baselineQuotes(polls, opener, away, home, anchorBook, market, role) {
  const keys = anchorKeys(anchorBook);
  if (!keys.length || !market || !role) return null;
  for (const poll of baselinePolls(polls, opener)) {
    const game = findGame(poll.games, away, home);
    if (!game) continue;
    let pin = null;
    let bookUsed = null;
    for (const key of keys) {
      const q = probsFromRow(bookRow(game, key), market, role);
      if (q && Number.isFinite(q.noVig)) {
        pin = q;
        bookUsed = key;
        break;
      }
    }
    if (!pin) continue;
    const dk = probsFromRow(bookRow(game, 'draftkings'), market, role);
    return {
      pinNoVig: pin.noVig,
      dkImplied: dk && Number.isFinite(dk.implied) ? dk.implied : null,
      book: bookUsed,
      hhmm: slotOf(poll) || null,
    };
  }
  return null;
}

function executionAmerican(c) {
  if (!c) return null;
  const book = String((c.book || c.executionBook) || '').toLowerCase();
  const fromOdds = finiteOdds(typeof c.odds === 'number' ? c.odds : parseAmericanText(c && c.odds));
  if ((book === 'draftkings' || book === 'draftkings_us') && fromOdds != null) return fromOdds;
  if (c && c.dkQuote) {
    const q = finiteOdds(c.dkQuote.american);
    if (q != null) return q;
  }
  if (!book && fromOdds != null) return fromOdds;
  if (Array.isArray(c && c.bookPrices)) {
    const row = c.bookPrices.find((p) => p && String(p.book || '').toLowerCase() === 'draftkings');
    const n = row ? finiteOdds(pAmerican(row)) : null;
    if (n != null) return n;
  }
  return null;
}

function pAmerican(row) {
  return row.american != null ? row.american : row.price;
}

function parseAmericanText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const n = parseInt(String(value).replace(/[^0-9\-+]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function namesEq(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x))) return true;
  const xl = x.split(' ').pop();
  const yl = y.split(' ').pop();
  return !!(xl && yl && xl.length > 3 && xl === yl);
}

function quoteEventSide(event, book, market, role, line) {
  const keys = anchorKeys(book);
  const bms = (event && event.bookmakers) || [];
  let bk = null;
  for (const key of keys) {
    bk = bms.find((b) => b && String(b.key || '').toLowerCase() === key) || null;
    if (bk) break;
  }
  if (!bk) return null;
  const mkey = market === 'total' ? 'totals' : (market === 'spread' ? 'spreads' : 'h2h');
  const mkt = (bk.markets || []).find((m) => m && m.key === mkey);
  if (!mkt) return null;
  const row = rowFromOutcomes(mkt.outcomes || [], event, market, role, line);
  if (!row) return null;
  return probsFromRow(row, market, role);
}

function rowFromOutcomes(outcomes, event, market, role, line) {
  const wantLine = line != null && line !== '' && Number.isFinite(Number(line)) ? Number(line) : null;
  if (market === 'total') {
    const groups = new Map();
    for (const o of outcomes) {
      const pt = Number(o && o.point);
      if (!Number.isFinite(pt)) continue;
      const g = groups.get(pt) || { point: pt, over: null, under: null };
      if (/^over$/i.test(o.name)) g.over = finiteOdds(o.price);
      else if (/^under$/i.test(o.name)) g.under = finiteOdds(o.price);
      groups.set(pt, g);
    }
    const pairs = [...groups.values()].filter((g) => g.over != null && g.under != null);
    if (!pairs.length) return null;
    let chosen = null;
    if (wantLine == null) chosen = pairs[0];
    else chosen = pairs.find((g) => Math.abs(g.point - wantLine) < 1e-6) || null;
    if (!chosen) return null;
    return { overOdds: chosen.over, underOdds: chosen.under };
  }
  if (market === 'spread') {
    const home = event && event.home_team;
    const away = event && event.away_team;
    const pairs = [];
    for (const o of outcomes) {
      if (!o || !namesEq(o.name, home) || !Number.isFinite(Number(o.point))) continue;
      const opp = outcomes.find((x) => x && namesEq(x.name, away)
        && Math.abs(Number(x.point) + Number(o.point)) < 1e-6);
      if (!opp) continue;
      pairs.push({
        homePoint: Number(o.point),
        homeOdds: finiteOdds(o.price),
        awayOdds: finiteOdds(opp.price),
      });
    }
    const complete = pairs.filter((p) => p.homeOdds != null && p.awayOdds != null);
    if (!complete.length) return null;
    let chosen = null;
    if (wantLine == null) chosen = complete[0];
    else {
      chosen = complete.find((p) => {
        const sidePoint = role === 'away' ? -p.homePoint : p.homePoint;
        return Math.abs(sidePoint - wantLine) < 1e-6;
      }) || null;
    }
    if (!chosen) return null;
    return { spreadHomeOdds: chosen.homeOdds, spreadAwayOdds: chosen.awayOdds };
  }
  const home = (outcomes || []).find((o) => o && namesEq(o.name, event && event.home_team));
  const away = (outcomes || []).find((o) => o && namesEq(o.name, event && event.away_team));
  const mlHome = home ? finiteOdds(home.price) : null;
  const mlAway = away ? finiteOdds(away.price) : null;
  if (mlHome == null || mlAway == null) return null;
  return { mlHome, mlAway };
}

/** Pinnacle pair at this line, else Circa. A different number is not a pair. */
function lockAnchor(event, market, role, line) {
  for (const book of ['pinnacle', 'circa', 'circasports']) {
    const q = quoteEventSide(event, book, market, role, line);
    if (q && Number.isFinite(q.noVig)) {
      return { p: q.noVig, book, implied: q.implied, american: q.american };
    }
  }
  return null;
}

function lagDecision({ pinNow, pinBase, dkNow, dkBase, dkDecimal, enabled, thresholds }) {
  const cfg = thresholds || DK_LAG || { minPinMovePp: 1.0, maxDkFollowRatio: 0.5 };
  const minMove = Number(cfg.minPinMovePp) / 100;
  const ratio = Number(cfg.maxDkFollowRatio);
  const pinMove = (Number.isFinite(pinNow) && Number.isFinite(pinBase)) ? (pinNow - pinBase) : null;
  const dkMove = (Number.isFinite(dkNow) && Number.isFinite(dkBase)) ? (dkNow - dkBase) : null;
  const marketEv = (Number.isFinite(pinNow) && Number.isFinite(dkDecimal)) ? (pinNow * dkDecimal - 1) : null;
  let lagEdge = null;
  const on = enabled !== false;
  if (on && pinMove != null && dkMove != null && marketEv != null && Number.isFinite(minMove) && Number.isFinite(ratio)) {
    const toward = pinMove >= minMove - 1e-12;
    const lags = dkMove < (pinMove * ratio) - 1e-12;
    if (toward && lags && marketEv > 0) lagEdge = marketEv;
  }
  return {
    pinMove: round6(pinMove),
    dkMove: round6(dkMove),
    marketEv: round6(marketEv),
    lagEdge: lagEdge == null ? null : round6(lagEdge),
  };
}

function coverNow(c) {
  const n = Number(c && c.coverProb);
  return Number.isFinite(n) ? n : null;
}

function dkLagFeatures(c, opts) {
  const options = opts || {};
  const enabled = options.enabled != null ? !!options.enabled : dkLagEnabled(options.env || process.env);
  const role = sideRole(c);
  const anchorBook = c && (c.sharpAnchorBook || (c.pinnacleNoVigP != null ? 'pinnacle' : null));
  const pinNow = c && Number.isFinite(Number(c.pinnacleNoVigP)) ? Number(c.pinnacleNoVigP) : null;
  const dkAmerican = executionAmerican(c);
  const dkNow = dkAmerican != null ? americanToImplied(dkAmerican) : null;
  const dkDecimal = dkAmerican != null ? americanToDecimal(dkAmerican) : null;
  let pinBase = null;
  let dkBase = null;
  if (role && anchorBook && c) {
    const base = baselineQuotes(
      options.polls,
      options.opener,
      c.awayTeam,
      c.homeTeam,
      anchorBook,
      role.market,
      role.role,
    );
    if (base) {
      pinBase = base.pinNoVig;
      dkBase = base.dkImplied;
    }
  }
  const decision = lagDecision({
    pinNow,
    pinBase,
    dkNow,
    dkBase,
    dkDecimal,
    enabled,
    thresholds: options.thresholds,
  });
  return decision;
}

function applyOne(c, opts) {
  if (!c) return c;
  const features = dkLagFeatures(c, opts);
  // The probability path already moved cover, edge, and EV. Record the
  // lag features and do not add lagEdge on top of that probability.
  if (c.movementAdjusted) {
    return {
      ...c,
      lagEdge: null,
      pinMove: features.pinMove,
      dkMove: features.dkMove,
      marketEv: features.marketEv,
      movementSupersedesDkLag: true,
    };
  }
  const stamped = {
    lagEdge: features.lagEdge,
    pinMove: features.pinMove,
    dkMove: features.dkMove,
    marketEv: features.marketEv,
  };
  if (features.lagEdge == null) return { ...c, ...stamped };
  const pin = Number(c.pinnacleNoVigP);
  const cur = coverNow(c);
  const lift = Number.isFinite(pin) && (cur == null || pin > cur);
  const cover = lift ? pin : cur;
  // attachEv resets edgePct to cover − fair before lagEdge is added, so a
  // second pass does not stack the lag. A lift uses the anchor no-vig;
  // a model that was already higher keeps that cover.
  const next = attachEv({ ...c, coverProb: cover != null ? cover : c.coverProb });
  const base = Number(next.edgePct);
  const rank = (Number.isFinite(base) ? base : 0) + features.lagEdge;
  return {
    ...next,
    coverProb: cover != null ? cover : next.coverProb,
    edgePct: round6(rank) == null ? next.edgePct : +rank.toFixed(4),
    edgePctDisplay: formatEdgePct(rank),
    ...stamped,
  };
}

function applyDkLag(candidates, opts) {
  const options = opts || {};
  const polls = options.polls || (options.linePath && options.linePath.polls) || [];
  const opener = options.opener || null;
  const env = options.env || process.env;
  const enabled = options.enabled != null ? !!options.enabled : dkLagEnabled(env);
  const nextOpts = {
    polls,
    opener,
    enabled,
    thresholds: options.thresholds || DK_LAG,
    env,
  };
  return (candidates || []).map((c) => applyOne(c, nextOpts));
}

module.exports = {
  MORNING_SLOTS,
  BASELINE_SLOTS,
  dkLagEnabled,
  sideRole,
  probsFromRow,
  baselinePolls,
  baselineQuotes,
  quoteEventSide,
  lockAnchor,
  lagDecision,
  dkLagFeatures,
  executionAmerican,
  applyDkLag,
};
