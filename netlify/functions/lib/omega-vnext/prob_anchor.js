'use strict';

/**
 * Post-calibration anchor, then the published edge.
 *
 * p_final = w(sport, market) * modelPureP + (1 - w) * p_fair
 * w = 1 is the model. w = 0 is the market. NBA is absent and is not touched.
 * modelPureP already carries the rating-error SD. coverProb is the fallback
 * only when modelPureP is missing, so calibration is not mixed in again.
 *
 * Fair order, same line. Each book is power-devigged on its own pair.
 * One book's side is never mixed with another book's opposite side.
 *   1. Pinnacle power no-vig (source 'pinnacle', fairQuality 'sharp')
 *   2. other SHARP_BOOKS that each post both sides — bookmaker, betonlineag,
 *      lowvig — unweighted mean (source 'sharp-books', fairQuality 'sharp')
 *   3. unweighted mean of every remaining stored book that posts both sides,
 *      when at least two do (source 'consensus')
 *   4. that one book's own power no-vig (source is the book key)
 *   5. no pair: the row is not dropped. coverProb stays. source 'none',
 *      fairQuality 'none'.
 * The mean is unweighted (ASSUMED, 2026-10-18 audit item 4; not fit on
 * this box). Circa is not used: the Odds API has no Circa book, and these
 * rows have no stored per-game Circa line. Contest PDF lines are a separate
 * NFL product.
 *
 * A soft fair is a retail-only set: one retail book, or a consensus made
 * only of retail books (DraftKings + Hard Rock, FanDuel + BetMGM, Caesars,
 * and the rest). Retail means not in SHARP_BOOKS. Hard Rock is retail
 * (product rule, 2026-10-18, not a fitted weight). Soft is not a sharp
 * reference: fairSoft true, fairQuality 'soft', evAtFairValid false, and
 * the published evAtFair is the text 'n/a (soft fair)' (never a number).
 * p_fair still anchors the row. The published fairSource appends '-soft'.
 *
 * Published edge = p - vigged implied(odds). Edge is not push-adjusted.
 * Published EV = (1 - pPush) * (p * decimal(odds) - 1).
 * Missing or zero pPush leaves that EV unscaled.
 * odds is the best retail quote already on the row. Edge, stake EV, and
 * a sharp EV@fair all use that same price. Pinnacle and the other sharp
 * americans are fair inputs. They are not substituted for the bet price.
 * This is not the marketAnchorOn() K-table. That switch stays off.
 */

const {
  MARKET_ANCHOR_MODEL_WEIGHT, ratingErrorSd, effectiveSd, SHARP_BOOKS,
} = require('./config');
const { americanToImplied, americanToDecimal, formatEdgePct } = require('./odds_math');
const { powerFair } = require('./pure_model');
const { powerTwoWay } = require('./sharp_fair');
const { pushAwareEv } = require('./push_ev');

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function sportAnchored(sport) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  return Object.prototype.hasOwnProperty.call(table, String(sport || '').toUpperCase());
}

/**
 * Per sport and market. A bare number in the table applies to every market.
 * 0 is the market. 0.05 is a real weight. Neither is missing, and neither
 * may fall through to a default (no `w || 0.25`). Null means the sport or
 * market is unanchored.
 *
 * Replay only, read here at call time, not at load:
 * OMEGA_ANCHOR_W_<SPORT>_<ML|SPREAD|TOTAL> (example OMEGA_ANCHOR_W_NFL_ML=0.6).
 * Family is marketFamily: total, spread (spread / puck line / run line),
 * else ML. A finite value in [0, 1] replaces that cell, including a sport
 * the table does not list. Unset, blank, non-numeric, or outside [0, 1]
 * leaves MARKET_ANCHOR_MODEL_WEIGHT. The constant is not rewritten.
 */
function modelWeightFor(sport, market) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  const key = String(sport || '').toUpperCase();
  const fam = marketFamily(market);
  const suffix = fam === 'spread' ? 'SPREAD' : fam === 'total' ? 'TOTAL' : 'ML';
  if (key) {
    const raw = process.env[`OMEGA_ANCHOR_W_${key}_${suffix}`];
    if (raw != null && String(raw).trim() !== '') {
      const override = Number(raw);
      if (Number.isFinite(override) && override >= 0 && override <= 1) return override;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const entry = table[key];
  let w;
  if (entry != null && typeof entry === 'object') {
    if (!Object.prototype.hasOwnProperty.call(entry, fam)) return null;
    w = Number(entry[fam]);
  } else {
    w = Number(entry);
  }
  if (!Number.isFinite(w)) return null;
  if (w < 0) return 0;
  if (w > 1) return 1;
  return w;
}

function normalPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Acklam rational approximation. p outside (0, 1) returns null. */
function normalQuantile(p) {
  const x = Number(p);
  if (!(x > 0) || !(x < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  if (x < plow) {
    q = Math.sqrt(-2 * Math.log(x));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (x > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - x));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = x - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * SE of the anchored p. w * phi(z) * SD_rating / SD_eff.
 * z is the standard normal quantile of the model probability.
 * Missing n uses 6. A zero rating SD (NBA) returns 0.
 */
function ratingSeOf(row) {
  if (!row) return 0;
  const market = row.market || row.betType;
  const kind = /total/i.test(String(market || '')) ? 'total' : 'margin';
  const nRaw = row.ratingN != null ? row.ratingN : row.nGames;
  const n = Number(nRaw);
  const usedN = Number.isFinite(n) && n > 0 ? n : 6;
  const sdR = ratingErrorSd(row.sport, kind, usedN);
  const sdE = effectiveSd(row.sport, kind, usedN);
  if (!(sdR > 0) || !(sdE > 0)) return 0;
  const w = modelWeightFor(row.sport, market);
  // null is unanchored. 0 is a real weight and returns 0, not NaN.
  if (w == null) return 0;
  const pm = finiteProb(row.modelPureP);
  const p = pm != null ? pm : (finiteProb(row.p_model) != null ? finiteProb(row.p_model) : finiteProb(row.coverProb));
  if (p == null) return 0;
  const z = normalQuantile(p);
  if (z == null || !Number.isFinite(z)) return 0;
  return w * normalPdf(z) * sdR / sdE;
}

function pctString(p) {
  if (p == null || !Number.isFinite(Number(p))) return null;
  return `${(Number(p) * 100).toFixed(1)}%`;
}

function fairNumber(c) {
  const direct = finiteProb(c && c.p_fair);
  if (direct != null) return direct;
  const text = c && c.fairP;
  if (text == null || text === '') return null;
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  const p = String(text).includes('%') || n > 1 ? n / 100 : n;
  return finiteProb(p);
}

/**
 * American price the card is betting. The best retail quote is already on
 * the row as odds (else the same number in oddsStr). Pinnacle, bookmaker,
 * betonlineag, lowvig, dkQuote, and hardRock feed the fair. They do not
 * replace this price. Edge, stake EV, and EV@fair share it.
 */
function betAmerican(c) {
  if (!c) return null;
  const direct = Number(c.odds);
  if (Number.isFinite(direct) && direct !== 0) return direct;
  if (c.oddsStr == null || c.oddsStr === '') return null;
  const parsed = Number(String(c.oddsStr).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return parsed;
}

/**
 * Printed fair p, source, EV-at-fair, raw model p, and the anchor weight.
 * A sharp evAtFair is this row's p_fair at betAmerican (the retail quote).
 * It is not a second book's price. A soft fair publishes the text
 * 'n/a (soft fair)' and never a number. fairP stays, because p_fair still
 * anchors the row. fairSource is anchorFairSource, with '-soft' on a
 * retail-only set. fairQuality is 'sharp', 'soft', or 'none'.
 */
function fairPickFields(c) {
  const fair = fairNumber(c);
  const meta = fairMeta(c);
  const price = betAmerican(c);
  let evAtFair = null;
  if (meta.quality === 'soft') {
    evAtFair = 'n/a (soft fair)';
  } else if (meta.quality === 'sharp' && fair != null && price != null) {
    const evFair = pushAwareEv(fair, price, c && c.pPush);
    evAtFair = evFair == null || !Number.isFinite(evFair) ? null : formatEdgePct(evFair);
  }
  const raw = c && c.p_model != null ? Number(c.p_model) : null;
  const weight = c && c.anchorWeight != null ? Number(c.anchorWeight) : null;
  const sharpEv = meta.quality === 'sharp' && fair != null;
  return {
    fairP: pctString(fair),
    fairSource: meta.fairSource,
    fairSoft: meta.soft,
    fairQuality: meta.quality,
    evAtFairValid: sharpEv,
    evAtFair,
    p_model: raw != null && Number.isFinite(raw) ? +raw.toFixed(4) : null,
    p_fair: fair != null ? +Number(fair).toFixed(6) : null,
    modelWeight: weight != null && Number.isFinite(weight) ? weight : null,
  };
}

/** w = 1 returns pModel. w = 0 returns pFair. */
function anchorProbability(pModel, pFair, modelWeight) {
  const w = Number(modelWeight);
  const pm = Number(pModel);
  const pf = Number(pFair);
  if (!Number.isFinite(w) || !Number.isFinite(pm) || !Number.isFinite(pf)) return null;
  return (w * pm) + ((1 - w) * pf);
}

function oneLine(a, b) {
  if (a == null || a === '' || b == null || b === '') return true;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 1e-6 || Math.abs(x + y) < 1e-6;
}

/** Pinnacle power no-vig for this side. Null when the row has no same-line pair. */
function pinnacleFair(c) {
  const ps = c && c.pinnacleSide;
  if (!ps || !Number.isFinite(Number(ps.american)) || !Number.isFinite(Number(ps.oppAmerican))) return null;
  if (!oneLine(ps.point, ps.oppPoint)) return null;
  const powered = powerFair(c);
  if (powered != null) return powered;
  return finiteProb(c.pinnacleNoVigP);
}

function marketFamily(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return 'total';
  if (/spread|puck|run/i.test(m)) return 'spread';
  return 'ml';
}

function pairKey(c) {
  const line = c && c.line != null && c.line !== '' ? Number(c.line) : null;
  const abs = line == null || !Number.isFinite(line) ? 'ml' : Math.abs(line).toFixed(2);
  const game = (c && (c.matchup || `${c.awayTeam} @ ${c.homeTeam}`)) || '';
  return [
    String((c && c.sport) || ''),
    game,
    String((c && c.commenceTime) || ''),
    marketFamily(c && c.market),
    abs,
  ].join('\0');
}

function isOpposite(a, b) {
  if (!a || !b || a === b) return false;
  if (marketFamily(a.market) !== marketFamily(b.market)) return false;
  const fam = marketFamily(a.market);
  if (fam === 'total') {
    const ao = /^over\b/i.test(String(a.side || ''));
    const au = /^under\b/i.test(String(a.side || ''));
    const bo = /^over\b/i.test(String(b.side || ''));
    const bu = /^under\b/i.test(String(b.side || ''));
    if (!((ao && bu) || (au && bo))) return false;
    return Math.abs(Number(a.line) - Number(b.line)) < 1e-6;
  }
  if (fam === 'spread' && !(Math.abs(Number(a.line) + Number(b.line)) < 1e-6)) return false;
  return String(a.side || '') !== String(b.side || '');
}

function lineOf(c) {
  if (!c || c.line == null || c.line === '') return null;
  const n = Number(c.line);
  return Number.isFinite(n) ? n : null;
}

/** Null point means "this candidate's line". A different point is another bet. */
function pointMatches(point, line) {
  if (point == null || point === '') return true;
  const pt = Number(point);
  if (!Number.isFinite(pt)) return false;
  if (line == null) return true;
  return Math.abs(pt - line) < 1e-6;
}

function canonBook(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'hardrockbet_oh' || k === 'hardrock') return 'hardrockbet';
  return k;
}

function hasStoredBoard(c) {
  if (!c) return false;
  if (c.dkQuote) return true;
  if (c.hardRock && typeof c.hardRock === 'object') return true;
  return Array.isArray(c.bookPrices);
}

function boardPosts(c, book) {
  const name = canonBook(book);
  if (!name || !c) return false;
  if (c.dkQuote && name === 'draftkings') return true;
  if (c.hardRock && typeof c.hardRock === 'object' && name === 'hardrockbet') return true;
  const prices = Array.isArray(c.bookPrices) ? c.bookPrices : null;
  if (!prices) return false;
  return prices.some((p) => p && canonBook(p.book || p.key) === name);
}

/**
 * This side's American price at this line, one number per book.
 * dkQuote, hardRock, and bookPrices are the stored board. The bet price
 * fills a book only when that book posted on the board, or when the row
 * has no board (a synthetic fixture). It does not label another book's
 * american as this book, so a Hard Rock number cannot complete a DraftKings
 * pair. A price at another point is skipped, so an alt line cannot fill
 * this line. 2026-10-18: pairing rule, not a fitted weight.
 */
function pricesByBook(c) {
  const out = new Map();
  if (!c) return out;
  const line = lineOf(c);
  const put = (book, american, point) => {
    const name = canonBook(book);
    if (!name || out.has(name)) return;
    if (!pointMatches(point, line)) return;
    const am = Number(american);
    if (!Number.isFinite(am) || am === 0) return;
    out.set(name, am);
  };
  if (c.dkQuote) put('draftkings', c.dkQuote.american, c.dkQuote.point);
  const hr = c.hardRock;
  if (hr && typeof hr === 'object') {
    put('hardrockbet', hr.american != null ? hr.american : hr.price, hr.point);
  }
  const prices = Array.isArray(c.bookPrices) ? c.bookPrices : [];
  for (const p of prices) {
    if (!p) continue;
    put(p.book || p.key, p.american != null ? p.american : p.price, p.point);
  }
  const exec = canonBook(c.book || c.executionBook || c.priceBook);
  if (exec && (!hasStoredBoard(c) || boardPosts(c, exec))) put(exec, c.odds, line);
  return out;
}

/**
 * Power de-vig of one book's two prices. Same function Pinnacle uses
 * (sharp_fair.powerTwoWay via pure_model.powerFair). Not the proportional
 * split noVigTwoWay uses inside the juice band.
 */
function powerFairPair(a1, a2) {
  const i1 = americanToImplied(a1);
  const i2 = americanToImplied(a2);
  if (i1 == null || i2 == null) return null;
  const powered = powerTwoWay(i1, i2);
  return powered ? finiteProb(powered.p1) : null;
}

/**
 * Books that post BOTH sides of this line. Each fair is that book's own
 * pair. A DraftKings side is never de-vigged against a Hard Rock opposite.
 */
function pairedBookFairs(c, opp) {
  if (!c || !opp) return [];
  const left = pricesByBook(c);
  const right = pricesByBook(opp);
  const rows = [];
  for (const [book, am1] of left) {
    if (!right.has(book)) continue;
    const p = powerFairPair(am1, right.get(book));
    if (p == null) continue;
    rows.push({ book, p });
  }
  return rows;
}

function meanProb(rows) {
  if (!rows || !rows.length) return null;
  let sum = 0;
  for (const row of rows) sum += row.p;
  return finiteProb(sum / rows.length);
}

const OTHER_SHARP = new Set((SHARP_BOOKS || []).filter((b) => b !== 'pinnacle'));

/** Sharp reference books. The list is config.SHARP_BOOKS, not a fitted set. */
function isSharpBook(book) {
  const k = canonBook(book);
  return k === 'pinnacle' || OTHER_SHARP.has(k);
}

/**
 * Retail = not a sharp reference. Hard Rock, DraftKings, FanDuel, BetMGM,
 * Caesars, and every other stored book are retail. Not a weight.
 */
function isRetailBook(book) {
  const k = canonBook(book);
  return !!k && !isSharpBook(k);
}

function baseFairSource(c) {
  if (c && c.anchorFairSource) return String(c.anchorFairSource).replace(/-soft$/, '');
  if (c && c.fairSource) return String(c.fairSource).replace(/-soft$/, '');
  return 'none';
}

/**
 * pinnacle and sharp-books are sharp, including a sharp book key.
 * consensus is soft only when every book in the set is retail. A consensus
 * with no book list is the retail fallback: resolveFair peels sharp books
 * off before it emits 'consensus' (ASSUMED from that order, not a fit).
 * One retail book is soft. No source is none.
 */
function qualityFor(source, books) {
  if (!source || source === 'none') return 'none';
  if (source === 'pinnacle' || source === 'sharp-books' || isSharpBook(source)) return 'sharp';
  if (source === 'consensus') {
    if (books && books.length && books.some((b) => !isRetailBook(b))) return 'sharp';
    return 'soft';
  }
  if (isRetailBook(source)) return 'soft';
  return 'none';
}

function fairMeta(c) {
  const source = baseFairSource(c);
  const books = Array.isArray(c && c.anchorFairBooks) ? c.anchorFairBooks : null;
  const quality = qualityFor(source, books);
  const soft = quality === 'soft';
  return {
    source: source || 'none',
    quality,
    soft,
    fairSource: soft ? `${source}-soft` : (source || 'none'),
  };
}

/**
 * Pinnacle power no-vig, else other sharp books, else the stored board.
 * Does not read or write the bet price. books is the set that entered p_fair.
 */
function resolveFair(c, opp) {
  const pin = pinnacleFair(c);
  if (pin != null) return { pFair: pin, source: 'pinnacle', books: ['pinnacle'] };
  const pairs = pairedBookFairs(c, opp);
  const fromBoard = pairs.find((row) => row.book === 'pinnacle');
  if (fromBoard) return { pFair: fromBoard.p, source: 'pinnacle', books: ['pinnacle'] };
  const sharps = pairs.filter((row) => OTHER_SHARP.has(row.book));
  if (sharps.length) {
    const p = meanProb(sharps);
    if (p != null) return { pFair: p, source: 'sharp-books', books: sharps.map((row) => row.book) };
  }
  if (pairs.length >= 2) {
    const p = meanProb(pairs);
    if (p != null) return { pFair: p, source: 'consensus', books: pairs.map((row) => row.book) };
  }
  if (pairs.length === 1) return { pFair: pairs[0].p, source: pairs[0].book, books: [pairs[0].book] };
  return { pFair: null, source: 'none', books: [] };
}

/**
 * Anchor coverProb from modelPureP and the fair price.
 * A sport missing from the weight table is returned unchanged.
 * No fair: the row is kept, coverProb is not replaced, anchorFairSource is 'none'.
 * The incoming coverProb is kept as p_calibrated. It does not feed final p
 * when a fair price is present.
 */
function applyMarketAnchor(candidates) {
  const rows = candidates || [];
  const groups = new Map();
  for (const c of rows) {
    if (!c || !sportAnchored(c.sport)) continue;
    const key = pairKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return rows.map((c) => {
    if (!c) return c;
    const w = modelWeightFor(c.sport, c.market);
    // 0 still anchors: p_final is the fair. Only null leaves the row alone.
    if (w == null) return c;
    const fromPure = finiteProb(c.modelPureP);
    const pModel = fromPure != null ? fromPure : finiteProb(c.coverProb);
    const opp = (groups.get(pairKey(c)) || []).find((row) => isOpposite(c, row));
    const resolved = resolveFair(c, opp);
    const pFair = resolved.pFair;
    const dropped = pModel == null || pFair == null;
    const source = dropped ? 'none' : resolved.source;
    const books = dropped ? [] : (resolved.books || []);
    const meta = fairMeta({ anchorFairSource: source, anchorFairBooks: books });
    const se = ratingSeOf({
      ...c,
      modelPureP: pModel != null ? pModel : c.modelPureP,
      anchorWeight: w,
    });
    const stamped = {
      p_model: pModel != null ? +Number(pModel).toFixed(6) : (c.p_model != null ? c.p_model : null),
      p_fair: !dropped && pFair != null ? +Number(pFair).toFixed(6) : null,
      p_calibrated: finiteProb(c.coverProb),
      anchorWeight: w,
      anchorFairSource: meta.source,
      anchorFairBooks: books,
      fairSoft: meta.soft,
      fairQuality: meta.quality,
      evAtFairValid: meta.quality === 'sharp',
      ratingSe: Number.isFinite(se) ? se : 0,
    };
    if (dropped) {
      return { ...c, ...stamped, anchorFairSource: 'none', p_fair: null, fairSoft: false, fairQuality: 'none', evAtFairValid: false, anchorFairBooks: [] };
    }
    const p = anchorProbability(pModel, pFair, w);
    if (p == null || !Number.isFinite(p)) {
      return { ...c, ...stamped, anchorFairSource: 'none', anchorFairBooks: [], fairSoft: false, fairQuality: 'none', evAtFairValid: false };
    }
    return { ...c, ...stamped, coverProb: p };
  });
}

function retailBook(c) {
  const book = String((c && (c.book || c.priceBook || c.executionBook)) || '').toLowerCase();
  if (book === 'hardrockbet_oh' || book === 'hardrock') return 'hardrockbet';
  return book;
}

/**
 * edge = p - vigged implied. EV = (1 - pPush) * (p * decimal - 1).
 * p stays the conditional (no-push) probability. Edge is not scaled.
 * Missing or zero pPush leaves EV on p * decimal - 1.
 * Leaves coverProb and modelPureP. DK and Hard Rock stay liquid.
 * Clears the sharp-fair and movement flags the old pure-model step cleared,
 * so those gates do not start rejecting the calibrated row.
 */
function priceEdgeAtBet(c) {
  if (!c) return c;
  const p = Number(c.coverProb);
  if (!Number.isFinite(p)) return c;
  // Same retail quote fairPickFields uses for evAtFair. Not a sharp american.
  const price = betAmerican(c);
  const implied = americanToImplied(price);
  const dec = americanToDecimal(price);
  const edge = implied != null ? p - implied : null;
  const ev = dec != null ? pushAwareEv(p, price, c && c.pPush) : null;
  const retail = retailBook(c) === 'draftkings' || retailBook(c) === 'hardrockbet';
  return {
    ...c,
    sharpFairPriced: false,
    sharpFairReject: null,
    movementDrop: false,
    movementDropReason: null,
    ev: ev != null ? +ev.toFixed(6) : null,
    edgePct: edge != null ? +edge.toFixed(6) : null,
    edgePctDisplay: formatEdgePct(edge),
    edgeBasis: 'model-edge-vs-bet-price',
    evBasis: 'model-stake-ev',
    gradeBasis: 'model-edge-vs-bet-price',
    ...(retail ? { liquid: true } : {}),
  };
}

function priceEdgesAtBet(candidates) {
  return (candidates || []).map(priceEdgeAtBet);
}

module.exports = {
  anchorProbability,
  applyMarketAnchor,
  priceEdgeAtBet,
  priceEdgesAtBet,
  pinnacleFair,
  modelWeightFor,
  sportAnchored,
  ratingSeOf,
  normalPdf,
  normalQuantile,
  fairPickFields,
};
