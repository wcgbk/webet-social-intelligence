'use strict';

/**
 * Selection pass. The displayed price is the best DraftKings or Hard Rock
 * American price. Ranking for the top 10 is stake EV, one candidate per
 * game. Edge breaks a tie. Hard Rock coverage is review-only and does not
 * block publish.
 * See SELECTION_RULES.md.
 *
 * This module must not require gates, parlay, ingest, or hr_autocorrect.
 */

const { etLocalToUtcISO } = require('./price_lock');
const { attachEv, canonicalizeBook } = require('./edge');
const { sharpFairEnabled } = require('./sharp_fair');
const { mainMinEv } = require('./edge_floor');
const { GATES } = require('./config');
const { formatAmerican, etCalendarDate, parseEdgeFraction, americanToDecimal } = require('./odds_math');
const { toPickObject, matchupKey, compareByEv } = require('./select');

const DK_BOOK = 'draftkings';
const HR_BOOK = 'hardrockbet';
const PREGAME_GRACE_MS = 5 * 60 * 1000;
const NFL_KEY_NUMBERS = [3, -3, 7, -7];

function addDays(dateISO, days) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Slate is 11:15 ET on the card date, inclusive, through 6:00 ET next day, exclusive. */
function slateBounds(cardDate) {
  const d = String(cardDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const start = etLocalToUtcISO(d, 11, 15);
  const end = etLocalToUtcISO(addDays(d, 1), 6, 0);
  return { start, end, startMs: Date.parse(start), endMs: Date.parse(end) };
}

function commenceMs(c) {
  if (c == null) return null;
  const raw = typeof c === 'string' || typeof c === 'number'
    ? c
    : (c.commenceTime || c.commence_time || c.date);
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}

function inSlate(commence, cardDate) {
  if (!cardDate) return true;
  const bounds = slateBounds(cardDate);
  if (!bounds) return true;
  const ms = commenceMs(commence);
  if (ms == null) return false;
  return ms >= bounds.startMs && ms < bounds.endMs;
}

/**
 * null when the game is inside the slate.
 * starts-before-1115-et: same ET date, before 11:15.
 * future-date: at or after 6:00 ET the next day.
 * not-same-et-day: every other outside window (earlier dates).
 * missing-commenceTime: no parseable start. Verify does not drop on this.
 */
function slateReason(c, cardDate, opts) {
  if (!cardDate) return null;
  const ms = commenceMs(c);
  if (ms == null) return 'missing-commenceTime';
  const bounds = slateBounds(cardDate);
  if (!bounds) return null;
  if (ms >= bounds.startMs && ms < bounds.endMs) return null;
  void opts;
  const et = etCalendarDate(new Date(ms).toISOString());
  if (et === String(cardDate) && ms < bounds.startMs) return 'starts-before-1115-et';
  if (ms >= bounds.endMs) return 'future-date';
  return 'not-same-et-day';
}

function quoteFromPrices(prices, book) {
  const want = canonicalizeBook(book);
  let best = null;
  for (const p of prices || []) {
    if (!p || canonicalizeBook(p.book) !== want) continue;
    const american = Number(p.american);
    if (!Number.isFinite(american)) continue;
    if (!best || american > best.american) {
      best = { book: want, american, point: p.point != null ? Number(p.point) : null };
    }
  }
  return best;
}

function dkQuoteOf(c) {
  if (c && c.dkQuote && Number.isFinite(Number(c.dkQuote.american))) {
    return {
      book: DK_BOOK,
      american: Number(c.dkQuote.american),
      point: c.dkQuote.point != null ? Number(c.dkQuote.point) : (c.line != null ? Number(c.line) : null),
    };
  }
  if (!Array.isArray(c && c.bookPrices)) return null;
  return quoteFromPrices(c.bookPrices, DK_BOOK);
}

/** Reprice at DraftKings. Null when this side has no DK quote. */
function priceAtDraftKings(c) {
  const q = dkQuoteOf(c);
  if (!q) return null;
  const line = q.point != null && Number.isFinite(q.point) ? q.point : (c.line != null ? c.line : null);
  return attachEv({
    ...c,
    odds: q.american,
    oddsStr: formatAmerican(q.american),
    book: DK_BOOK,
    line,
    dkQuote: q,
    executionBook: DK_BOOK,
  });
}

/**
 * Best Hard Rock price on this side. Used when DraftKings has no quote.
 * The line is the Hard Rock point. Stake EV uses that American price.
 */
function priceAtHardRock(c) {
  const rows = [];
  const push = (american, point) => {
    const price = Number(american);
    if (!Number.isFinite(price)) return;
    const pt = point != null && point !== '' ? Number(point) : null;
    rows.push({ book: HR_BOOK, american: price, point: Number.isFinite(pt) ? pt : null });
  };
  if (Array.isArray(c && c.bookPrices)) {
    for (const p of c.bookPrices) {
      if (!p || canonicalizeBook(p.book || p.key) !== HR_BOOK) continue;
      push(p.american != null ? p.american : p.price, p.point);
    }
  }
  if (c && c.hardRock && typeof c.hardRock === 'object') {
    push(c.hardRock.american != null ? c.hardRock.american : c.hardRock.price, c.hardRock.point);
  }
  if (sharpFairEnabled() && rows.length) {
    const want = c.line != null && c.line !== '' ? Number(c.line) : null;
    const same = rows.filter((row) => {
      if (want == null || !Number.isFinite(want)) return row.point == null;
      return row.point != null && Math.abs(row.point - want) < 1e-6;
    });
    rows.length = 0;
    for (const row of same) rows.push(row);
  }
  if (!rows.length) return null;
  let best = rows[0];
  let bestDec = americanToDecimal(best.american);
  for (const row of rows.slice(1)) {
    const dec = americanToDecimal(row.american);
    if (Number.isFinite(dec) && (!Number.isFinite(bestDec) || dec > bestDec + 1e-12)) {
      best = row;
      bestDec = dec;
    }
  }
  const line = best.point != null ? best.point : (c.line != null ? c.line : null);
  return attachEv({
    ...c,
    odds: best.american,
    oddsStr: formatAmerican(best.american),
    book: HR_BOOK,
    priceBook: HR_BOOK,
    displayBook: HR_BOOK,
    line,
    hardRock: { american: best.american, point: best.point },
    executionBook: HR_BOOK,
    evBasis: 'stake-ev-at-best-us-price',
  });
}

/**
 * Keep a candidate when DraftKings or Hard Rock posts that side.
 * DraftKings is priced first, then the better of DraftKings and Hard Rock
 * on the DraftKings line. Hard Rock alone is kept. A candidate with no
 * bookPrices array is a synthetic fixture and stays on its existing price.
 * The dropped row is no-draftkings-line only when both books are missing.
 */
function applyExecutionBook(candidates) {
  const kept = [];
  const excluded = [];
  for (const c of candidates || []) {
    if (!c) continue;
    if (!Array.isArray(c.bookPrices)) {
      kept.push(stampHr(c));
      continue;
    }
    const priced = priceAtDraftKings(c);
    if (priced) {
      kept.push(stampHr(applyBestUsDisplay(priced)));
      continue;
    }
    const hr = priceAtHardRock(c);
    if (hr) {
      kept.push(stampHr(hr));
      continue;
    }
    excluded.push({ ...c, excludeReason: 'no-draftkings-line' });
  }
  return { candidates: kept, excluded };
}

function crossesNflKey(dk, hr) {
  const lo = Math.min(dk, hr);
  const hi = Math.max(dk, hr);
  for (const key of NFL_KEY_NUMBERS) {
    if (key + 1e-9 >= lo && key - 1e-9 <= hi) return key;
  }
  return null;
}

/**
 * Review only. Never a reject.
 * Flag when |DK − HR| >= 1.0, or in the NFL when a 0.5 gap crosses 3 or 7
 * (the key sits on the closed interval between the two numbers).
 * No Hard Rock number is not a flag.
 */
function hardRockReviewFlag(c) {
  if (!c) return null;
  const hr = c.hardRock;
  if (!hr || hr.point == null || c.line == null) return null;
  const dk = Number(c.line);
  const hp = Number(hr.point);
  if (!Number.isFinite(dk) || !Number.isFinite(hp)) return null;
  const gap = Math.abs(dk - hp);
  const flags = [];
  if (gap + 1e-9 >= 1) {
    flags.push({ type: 'point-gap', gap: +gap.toFixed(2), dkLine: dk, hrLine: hp });
  }
  const half = Math.abs(gap - 0.5) < 1e-6;
  if (half && String(c.sport || '').toUpperCase() === 'NFL') {
    const key = crossesNflKey(dk, hp);
    if (key != null) {
      flags.push({ type: 'nfl-key-cross', key, gap: 0.5, dkLine: dk, hrLine: hp });
    }
  }
  if (!flags.length) return null;
  return { flagged: true, flags, book: HR_BOOK, neverReject: true };
}

function samePoint(a, b) {
  const an = a == null || a === '' ? null : Number(a);
  const bn = b == null || b === '' ? null : Number(b);
  const aOk = an != null && Number.isFinite(an);
  const bOk = bn != null && Number.isFinite(bn);
  if (!aOk && !bOk) return true;
  if (!aOk || !bOk) return false;
  return Math.abs(an - bn) < 1e-6;
}

/**
 * Displayed price is the better American decimal of Hard Rock and DraftKings
 * on the DraftKings line. A tie stays on DraftKings. Pinnacle is never the
 * displayed price. DraftKings remains executionBook. Stake EV uses this price.
 */
function applyBestUsDisplay(priced) {
  const dkAmerican = Number(priced && priced.odds);
  const dkLine = priced && priced.line != null && priced.line !== '' ? Number(priced.line) : null;
  const line = Number.isFinite(dkLine) ? dkLine : null;
  let chosen = { book: DK_BOOK, american: dkAmerican };
  let bestDec = americanToDecimal(dkAmerican);
  for (const hr of matchingHrQuotes(priced, line)) {
    const dec = americanToDecimal(hr.american);
    if (Number.isFinite(dec) && Number.isFinite(bestDec) && dec > bestDec + 1e-12) {
      bestDec = dec;
      chosen = hr;
    }
  }
  return attachEv({
    ...priced,
    odds: chosen.american,
    oddsStr: formatAmerican(chosen.american),
    book: chosen.book,
    priceBook: chosen.book,
    displayBook: chosen.book,
    executionBook: DK_BOOK,
    evBasis: 'stake-ev-at-best-us-price',
  });
}

function matchingHrQuotes(c, line) {
  const rows = [];
  const push = (american, point) => {
    const price = Number(american);
    if (!Number.isFinite(price)) return;
    const pt = point != null && point !== '' ? Number(point) : null;
    if (!samePoint(Number.isFinite(pt) ? pt : null, line)) return;
    rows.push({ book: HR_BOOK, american: price, point: Number.isFinite(pt) ? pt : null });
  };
  if (Array.isArray(c && c.bookPrices)) {
    for (const p of c.bookPrices) {
      if (!p || canonicalizeBook(p.book || p.key) !== HR_BOOK) continue;
      push(p.american != null ? p.american : p.price, p.point);
    }
  }
  if (c && c.hardRock && typeof c.hardRock === 'object') {
    push(c.hardRock.american != null ? c.hardRock.american : c.hardRock.price, c.hardRock.point);
  }
  return rows;
}

function stampHr(c) {
  const flag = hardRockReviewFlag(c);
  if (!flag) {
    if (c && c.hrFlags) {
      const next = { ...c };
      delete next.hrFlags;
      return next;
    }
    return c;
  }
  return { ...c, hrFlags: flag.flags, hrReview: flag };
}

/**
 * NFL |projection − sharp| > 10. Spreads and moneylines already reject past
 * FB_MARKET_GAP.NFL.margin (10) as model_market_gap. A game whose spread
 * projection is more than 10 off is stamped nflGameProjectionGap and every
 * remaining market, including a total inside its own cap, drops here.
 * This also catches NFL totals whose own gap is above 10 and still inside
 * the wider total cap (13). Exactly 10 is allowed. Other sports return null.
 */
function nflProjectionGap(c) {
  if (!c || c.sport !== 'NFL') return null;
  if (c.nflGameProjectionGap === true) return 'nfl-projection-gap';
  if (!/total/i.test(String(c.market || ''))) return null;
  let gap = null;
  if (c.modelTotalRaw != null && c.marketTotal != null
    && Number.isFinite(Number(c.modelTotalRaw)) && Number.isFinite(Number(c.marketTotal))) {
    gap = Math.abs(Number(c.modelTotalRaw) - Number(c.marketTotal));
  } else if (c.modelProjection != null && (c.consensusLine != null || c.marketLine != null)) {
    const mkt = c.consensusLine != null ? c.consensusLine : c.marketLine;
    if (Number.isFinite(Number(c.modelProjection)) && Number.isFinite(Number(mkt))) {
      gap = Math.abs(Number(c.modelProjection) - Number(mkt));
    }
  } else if (c.modelLineGap != null && Number.isFinite(Number(c.modelLineGap))) {
    gap = Math.abs(Number(c.modelLineGap));
  }
  if (gap != null && gap > 10 + 1e-9) return 'nfl-projection-gap';
  return null;
}

function liveInPlayReason(c) {
  if (!c) return null;
  if (c.inPlay === true || c.live === true || c.in_play === true) return 'live-in-play';
  const st = String(c.priceState || c.marketStatus || '').toLowerCase();
  if (st === 'in-play' || st === 'live' || st === 'inplay') return 'live-in-play';
  return null;
}

function betKey(c) {
  return [
    c && c.matchup,
    c && (c.commenceTime || ''),
    c && c.market,
    c && c.side,
    c && c.line,
  ].join('|');
}

function evOf(c) {
  const n = Number(c && c.ev);
  return Number.isFinite(n) ? n : -Infinity;
}

function edgeOf(c) {
  const n = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Floor pool. Stake EV descending, one candidate per game. An EV tie
 * uses edge. A second market on a game already taken is skipped.
 */
function selectTop10(pool, n) {
  const limit = n == null ? 10 : n;
  const sorted = [...(pool || [])].sort(compareByEv);
  const seen = new Set();
  const out = [];
  for (const c of sorted) {
    const key = matchupKey(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Hard Rock posted a numeric price for this side. Missing is not a reject. */
function hasHardRockPrice(c) {
  if (!c) return false;
  const hr = c.hardRock;
  if (hr && Number.isFinite(Number(hr.american))) return true;
  if (!Array.isArray(c.bookPrices)) return false;
  return c.bookPrices.some((p) => {
    const book = String((p && (p.book || p.key)) || '');
    if (!/hardrock/i.test(book)) return false;
    const american = p.american != null ? p.american : p.price;
    return Number.isFinite(Number(american));
  });
}

/**
 * Parlay legs are the straights. A leg with no Hard Rock price is logged
 * and swapped for the next edge-ranked one-per-game candidate that has one.
 * No replacement: the leg stays and the ticket carries a note. Never drops
 * the card.
 */
function ensureParlayPlaceable(straights, pool) {
  const current = (straights || []).filter(Boolean).slice();
  const ranked = selectTop10(pool, Math.max(30, (pool || []).length));
  const used = new Set(current.map((c) => matchupKey(c)));
  const bugs = [];
  let changed = false;
  for (let i = 0; i < current.length; i += 1) {
    if (hasHardRockPrice(current[i])) continue;
    const replacement = ranked.find((c) => c && !used.has(matchupKey(c)) && hasHardRockPrice(c));
    const entry = {
      at: new Date().toISOString(),
      kind: 'hard-rock-parlay-leg',
      silent: true,
      matchup: current[i].matchup || null,
      side: current[i].side || null,
      market: current[i].market || null,
      action: replacement ? 'swapped' : 'noted',
      replacement: replacement ? {
        matchup: replacement.matchup || null,
        side: replacement.side || null,
        market: replacement.market || null,
      } : null,
    };
    bugs.push(entry);
    if (!replacement) continue;
    used.delete(matchupKey(current[i]));
    used.add(matchupKey(replacement));
    current[i] = { ...replacement, tier: replacement.tier || current[i].tier || 'floor' };
    changed = true;
  }
  const noted = bugs.filter((b) => b.action === 'noted');
  const note = noted.length
    ? `${noted.length} parlay leg${noted.length === 1 ? '' : 's'} had no Hard Rock price.`
    : null;
  return { straights: current, bugs, changed, note };
}

function top10Row(c) {
  return {
    game: (c && (c.matchup || `${c.awayTeam || ''} @ ${c.homeTeam || ''}`)) || '',
    side: c && c.side,
    dkLine: c && c.line != null ? c.line : null,
    dkPrice: c && c.odds != null ? c.odds : null,
    book: (c && (c.book || c.executionBook)) || null,
    edge: c && (c.edgePct != null ? c.edgePct : c.edge),
    winProb: c && c.coverProb != null ? c.coverProb : null,
    ev: c && c.ev != null ? c.ev : null,
    hrFlags: (c && c.hrFlags) || null,
    sport: c && c.sport,
    market: c && c.market,
    commenceTime: (c && c.commenceTime) || null,
  };
}

function top10Rows(pool, n) {
  return selectTop10(pool, n).map(top10Row);
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Same game when the matchup uses "vs", "at", or "@", in either team order. */
function gameTeams(s) {
  const text = normText(s).replace(/\./g, '');
  const parts = text.split(/\s+(?:@|vs|at)\s+/);
  if (parts.length < 2) return text;
  return [parts[0], parts.slice(1).join(' ')].map((t) => t.trim()).filter(Boolean).sort().join('|');
}

function normSide(s) {
  return normText(s).replace(/\s+ml$/, '').trim();
}

function rowGame(row) {
  return (row && (row.game || row.matchup)) || '';
}

function rowSide(row) {
  return (row && (row.side || row.pick)) || '';
}

function pickSide(p) {
  return (p && (p.pick || p.side)) || '';
}

function betId(game, side) {
  return `${gameTeams(game)}|${normSide(side)}`;
}

function pickBetId(p) {
  return betId(p && p.matchup, pickSide(p));
}

function rowBetId(row) {
  return betId(rowGame(row), rowSide(row));
}

function edgeOf(row) {
  if (!row) return null;
  return parseEdgeFraction(row.edgePct != null ? row.edgePct : row.edge);
}

/** Display rounding is 0.1 percentage points. A larger gap is a real difference. */
const EDGE_MATCH_EPS = 0.00051;

function sameEdgeValue(a, b) {
  const ea = edgeOf(a);
  const eb = edgeOf(b);
  if (ea == null || eb == null) return ea == null && eb == null;
  return Math.abs(ea - eb) <= EDGE_MATCH_EPS;
}

function slotSnap(row, kind) {
  if (!row) return null;
  if (kind === 'card') {
    return { game: row.matchup || null, side: pickSide(row) || null, edge: row.edgePct != null ? row.edgePct : (row.edge != null ? row.edge : null) };
  }
  return { game: rowGame(row) || null, side: rowSide(row) || null, edge: row.edge != null ? row.edge : (row.edgePct != null ? row.edgePct : null) };
}

/**
 * The re-ranked list of record. Final straights, in edge order, are marked
 * selected and lead the list. The rest of the 10:00 top 10 follows.
 */
function recordRankedList(picks, poolTop10) {
  const pool = Array.isArray(poolTop10) ? poolTop10 : [];
  const indexOf = (p) => {
    const id = pickBetId(p);
    const i = pool.findIndex((row) => row && rowBetId(row) === id);
    return i === -1 ? null : i;
  };
  const head = (picks || []).filter(Boolean).slice().sort((a, b) => {
    const ia = indexOf(a);
    const ib = indexOf(b);
    if (ia != null && ib != null && ia !== ib) return ia - ib;
    const ea = edgeOf(a);
    const eb = edgeOf(b);
    return (eb == null ? -Infinity : eb) - (ea == null ? -Infinity : ea);
  }).map((p) => ({ ...top10Row({
    matchup: p.matchup,
    side: p.side || p.pick,
    line: p.line,
    odds: p.odds,
    book: p.book,
    edgePct: p.edgePct != null ? p.edgePct : p.edge,
    coverProb: p.coverProb,
    ev: p.ev,
    hrFlags: p.hrFlags,
    sport: p.sport,
    market: p.betType || p.market,
    commenceTime: p.commenceTime,
  }), selected: true }));
  const seen = new Set(head.map(rowBetId));
  const rest = pool.filter((row) => row && !seen.has(rowBetId(row)));
  return head.concat(rest).slice(0, 10);
}

/**
 * 10:30 sort check. The card's top 3 must match the selected re-ranked rows
 * on game, side, and edge. A mismatch rebuilds that order from the list.
 * The bug entry is for the backend log only.
 */
function applySilentSortCheck(picksData) {
  const data = picksData || {};
  const ranked = data.selection && Array.isArray(data.selection.top10) ? data.selection.top10 : [];
  const selected = ranked.filter((row) => row && row.selected);
  const expected = (selected.length ? selected : ranked).filter(Boolean).slice(0, 3);
  const picks = Array.isArray(data.picks) ? data.picks.slice() : [];
  if (!expected.length || !picks.length) return { changed: false };
  const card = picks.slice(0, 3);
  const differed = [];
  const n = Math.max(card.length, expected.length);
  for (let i = 0; i < n; i += 1) {
    const pick = card[i];
    const row = expected[i];
    const same = pick && row && pickBetId(pick) === rowBetId(row) && sameEdgeValue(pick, row);
    if (same) continue;
    differed.push({ index: i, card: slotSnap(pick, 'card'), ranked: slotSnap(row, 'ranked') });
  }
  if (!differed.length) return { changed: false };

  const corrected = [];
  const table = Array.isArray(data.candidateTable) ? data.candidateTable : [];
  for (let i = 0; i < expected.length; i += 1) {
    const row = expected[i];
    const existing = picks.find((p) => p && pickBetId(p) === rowBetId(row));
    if (existing) {
      corrected.push(existing);
      continue;
    }
    const fromTable = table.find((c) => c && betId(c.matchup, c.side || c.pick) === rowBetId(row));
    if (fromTable) {
      corrected.push(toPickObject({
        ...fromTable,
        edgePct: fromTable.edgePct != null ? fromTable.edgePct : fromTable.edge,
        market: fromTable.market || fromTable.betType,
        side: fromTable.side || fromTable.pick,
      }, { modelVersion: data.model }));
      continue;
    }
    if (card[i]) corrected.push(card[i]);
  }
  if (!corrected.length) return { changed: false };
  const unchanged = corrected.length === card.length && corrected.every((p, i) => p === card[i]);
  const entry = {
    at: new Date().toISOString(),
    kind: 'sort-check',
    silent: true,
    date: data.date || null,
    original: card.map((p) => slotSnap(p, 'card')),
    corrected: corrected.map((p) => slotSnap(p, 'card')),
    differed,
  };
  return { changed: !unchanged, picks: unchanged ? picks : corrected, entry };
}

function excludedGames(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const game = r.matchup || `${r.awayTeam || ''} @ ${r.homeTeam || ''}`;
    const reason = r.excludeReason || r.rejectReason || r.reason || 'excluded';
    const key = `${game}|${r.commenceTime || ''}|${r.sport || ''}`;
    if (!by.has(key)) {
      by.set(key, {
        game,
        sport: r.sport || null,
        commenceTime: r.commenceTime || null,
        reasons: [],
      });
    }
    const label = `${reason}${r.side ? `: ${r.side}` : ''}${r.market ? ` (${r.market})` : ''}`;
    const row = by.get(key);
    if (!row.reasons.includes(label)) row.reasons.push(label);
  }
  return [...by.values()];
}

/**
 * Missing or unparseable commence does not drop.
 * Drop a live/in-play flag, a start more than 5 minutes ago, or a slate miss.
 */
function verifyStartReason(pick, nowMs, cardDate, opts) {
  if (!pick) return null;
  const live = liveInPlayReason(pick);
  if (live) return live;
  const t = commenceMs(pick);
  if (t == null) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (t < now - PREGAME_GRACE_MS) return 'live-in-play';
  if (cardDate) {
    const reason = slateReason(pick, cardDate, { ...(opts || {}), nowMs: now });
    if (reason && reason !== 'missing-commenceTime') return reason;
  }
  return null;
}

function asAmerican(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9\-+]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function asFraction(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) > 1 ? v / 100 : v;
  return parseEdgeFraction(v);
}

function bookIsRetailOrUnknown(c) {
  if (!c || c.book == null || c.book === '') return true;
  const book = canonicalizeBook(c.book);
  return book === DK_BOOK || book === HR_BOOK;
}

function staleEv(ev) {
  const maxEV = Number(GATES.maxEV);
  return Number.isFinite(ev) && Number.isFinite(maxEV) && ev > maxEV + 1e-12;
}

function takeBackfill(c, now, cardDate, slateOpts, used, minEv) {
  if (!c || used.has(matchupKey(c))) return null;
  if (!bookIsRetailOrUnknown(c)) return null;
  const odds = asAmerican(c.odds);
  const ev = asFraction(c.ev);
  const edge = edgeOf(c);
  const cover = asFraction(c.coverProb);
  if (!Number.isFinite(odds) || !Number.isFinite(ev)) return null;
  if (staleEv(ev)) return null;
  if (minEv != null && !(ev + 1e-12 >= minEv)) return null;
  if (verifyStartReason(c, now, cardDate, slateOpts)) return null;
  if (cardDate && !inSlate(c, cardDate)) return null;
  const floor = ev + 1e-12 >= mainMinEv(odds);
  return toPickObject({
    ...c,
    odds,
    ev,
    edgePct: Number.isFinite(edge) ? edge : c.edgePct,
    coverProb: Number.isFinite(cover) ? cover : c.coverProb,
    tier: floor ? 'floor' : 'lean',
    book: c.book || DK_BOOK,
  });
}

function parlayTicketEv(legs) {
  let dec = 1;
  let prob = 1;
  for (const leg of legs || []) {
    const odds = asAmerican(leg && leg.odds);
    const p = asFraction(leg && (leg.p_cal != null ? leg.p_cal : leg.coverProb));
    const d = americanToDecimal(odds);
    if (!Number.isFinite(d) || !(d > 1) || !Number.isFinite(p)) return null;
    dec *= d;
    prob *= p;
  }
  return prob * dec - 1;
}

/**
 * Drop picks that have started or left the slate, then backfill from
 * candidateTable up to 3. DraftKings, Hard Rock, or an unknown book can
 * fill. First pass is the 2% EV floor. A second pass takes any finite EV
 * that is not ev-stale. One straight per game. A dropped parlay leg is
 * refilled from that table up to 3, at 0.25u, and labeled when the
 * combined EV is not positive. This does not throw.
 */
function verifySchedule(picksData, nowMs) {
  const card = picksData || {};
  const cardDate = card.date || null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const slateOpts = { nowMs: now };
  const dropped = [];
  const picks = [];
  let changed = false;
  for (const p of card.picks || []) {
    const reason = verifyStartReason(p, now, cardDate, slateOpts);
    if (reason) {
      dropped.push({ pick: p.pick || p.side, matchup: p.matchup, reason });
      changed = true;
      continue;
    }
    picks.push(p);
  }
  const used = new Set(picks.map(matchupKey));
  const table = card.candidateTable || [];
  const fillFrom = (minEv) => {
    for (const c of table) {
      if (picks.length >= 3) break;
      const pick = takeBackfill(c, now, cardDate, slateOpts, used, minEv);
      if (!pick) continue;
      picks.push(pick);
      used.add(matchupKey(pick));
      changed = true;
    }
  };
  fillFrom(mainMinEv(null));
  if (picks.length < 3) fillFrom(null);
  if (Array.isArray(card.parlayLegs)) {
    for (const pl of card.parlayLegs) {
      if (!pl || !Array.isArray(pl.legs)) continue;
      if (pl.qualifying === false || pl.type === 'no-qualifying-parlay') continue;
      const next = pl.legs.filter((leg) => !verifyStartReason(leg, now, cardDate, slateOpts));
      if (next.length !== pl.legs.length) {
        pl.legs = next;
        changed = true;
      }
      const usedGames = new Set(pl.legs.map(matchupKey));
      for (const c of table) {
        if (pl.legs.length >= 3) break;
        if (!c || usedGames.has(matchupKey(c))) continue;
        const leg = takeBackfill(c, now, cardDate, slateOpts, usedGames, null);
        if (!leg) continue;
        leg.units = '0.25u';
        pl.legs.push(leg);
        usedGames.add(matchupKey(leg));
        changed = true;
      }
      if (pl.legs.length) {
        pl.units = '0.25u';
        pl.qualifying = pl.legs.length === 3 ? true : pl.qualifying;
        const ticketEv = pl.legs.length === 3 ? parlayTicketEv(pl.legs) : null;
        if (ticketEv != null && !(ticketEv > 0)) {
          pl.label = 'combined EV not positive';
          pl.leanDay = true;
        }
      }
    }
  }
  card.picks = picks;
  return { picks, dropped, changed, log: dropped };
}

function lastWord(name) {
  return String(name || '').trim().split(/\s+/).pop().toLowerCase();
}

function matchHrGame(games, matchup) {
  const m = String(matchup || '').toLowerCase();
  return (games || []).find((g) => {
    const home = String(g.home_team || '');
    const away = String(g.away_team || '');
    if (m.includes(lastWord(home)) && m.includes(lastWord(away))) return true;
    const hSchool = home.toLowerCase().replace(/\s+\S+$/, '');
    const aSchool = away.toLowerCase().replace(/\s+\S+$/, '');
    return hSchool.length > 3 && aSchool.length > 3 && m.includes(hSchool) && m.includes(aSchool);
  }) || null;
}

function hrQuoteForPick(pick, game) {
  if (!pick || !game) return null;
  const marketName = String(pick.betType || pick.market || '');
  let key = null;
  if (/total/i.test(marketName)) key = 'totals';
  else if (/moneyline|^ml$/i.test(marketName)) key = 'h2h';
  else if (/spread/i.test(marketName)) key = 'spreads';
  if (!key) return null;
  const book = (game.bookmakers || []).find((b) => canonicalizeBook(b && b.key) === HR_BOOK);
  if (!book) return null;
  const market = (book.markets || []).find((mk) => mk.key === key);
  if (!market) return null;
  const label = pick.pick || pick.side || '';
  let outcome = null;
  if (key === 'totals') {
    const side = /under/i.test(label) ? 'Under' : 'Over';
    outcome = (market.outcomes || []).find((o) => o.name === side);
  } else {
    const team = key === 'h2h'
      ? String(label).replace(/\s*ML\s*$/i, '').trim()
      : String(label).replace(/[-+]?\d+(\.\d+)?\s*$/, '').trim();
    outcome = (market.outcomes || []).find((o) => lastWord(o.name) === lastWord(team));
  }
  if (!outcome) return null;
  const point = outcome.point != null && outcome.point !== '' ? Number(outcome.point) : null;
  return {
    book: HR_BOOK,
    american: Number(outcome.price),
    point: Number.isFinite(point) ? point : null,
  };
}

function displayedAmerican(pick) {
  return asAmerican(pick && pick.odds);
}

/**
 * Placeable when Hard Rock posts the same market side, the same line, and
 * the displayed American price. The displayed book is Hard Rock or
 * DraftKings. Pinnacle never counts. Does not change odds, line, or book.
 * changed is always false. A miss is a flag, not a drop.
 */
function reviewHardRock(picksData, sportGames) {
  const flags = [];
  const lines = [];
  const apply = (pick, kind, index) => {
    if (!pick) return;
    const row = placeableAtDisplayed(pick, sportGames);
    pick.hrPlaceable = row.placeable;
    if (!row.placeable) {
      pick.hrFlags = [{
        type: 'not-placeable-at-displayed-price',
        displayed: row.displayed,
        hardRock: row.hardRockAmerican,
        line: pick.line != null ? pick.line : null,
      }];
      flags.push({ matchup: pick.matchup, pick: pick.pick || pick.side, flags: pick.hrFlags });
    }
    lines.push({
      kind,
      index,
      matchup: pick.matchup || null,
      pick: pick.pick || pick.side || null,
      book: pick.book || pick.priceBook || null,
      displayed: row.displayed,
      line: pick.line != null ? pick.line : null,
      hardRockAmerican: row.hardRockAmerican,
      placeable: row.placeable,
    });
  };
  const picks = (picksData && picksData.picks) || [];
  picks.forEach((pick, index) => apply(pick, 'straight', index));
  const tickets = (picksData && picksData.parlayLegs) || [];
  tickets.forEach((pl) => {
    if (pl && pl.qualifying === false) return;
    ((pl && pl.legs) || []).forEach((leg, index) => apply(leg, 'parlay', index));
  });
  const considered = lines.filter((row) => row && row.kind === 'straight').concat(
    lines.filter((row) => row && row.kind === 'parlay'),
  );
  const verdict = picks.length && considered.every((row) => row.placeable) ? 'PASS' : 'FAIL';
  return { changed: false, flags, lines, verdict, log: flags };
}

function placeableAtDisplayed(pick, sportGames) {
  const displayed = displayedAmerican(pick);
  const line = pick && pick.line != null && pick.line !== '' ? Number(pick.line) : null;
  const book = canonicalizeBook((pick && (pick.priceBook || pick.book)) || '');
  const fromBoard = hrQuoteMatching(pick, sportGames, line);
  const fromSaved = matchingHrQuotes(pick, Number.isFinite(line) ? line : null)
    .find((row) => row.american === displayed) || matchingHrQuotes(pick, Number.isFinite(line) ? line : null)[0] || null;
  const hr = fromBoard || fromSaved;
  if (book === HR_BOOK && displayed != null && !hr) {
    return { placeable: true, displayed, hardRockAmerican: displayed };
  }
  if (!hr || displayed == null) {
    return { placeable: false, displayed, hardRockAmerican: hr ? hr.american : null };
  }
  if (!samePoint(hr.point, Number.isFinite(line) ? line : null)) {
    return { placeable: false, displayed, hardRockAmerican: hr.american };
  }
  return {
    placeable: hr.american === displayed,
    displayed,
    hardRockAmerican: hr.american,
  };
}

function hrQuoteMatching(pick, sportGames, line) {
  const games = sportGames && pick && sportGames[pick.sport];
  const list = Array.isArray(games) ? games : [];
  const game = matchHrGame(list, pick && pick.matchup);
  const hr = hrQuoteForPick(pick, game);
  if (!hr || !Number.isFinite(hr.american)) return null;
  if (!samePoint(hr.point, Number.isFinite(line) ? line : null)) return null;
  return hr;
}

/**
 * A kickoff a few hours ahead that still sits inside its own ET slate.
 * Used by tests so a wall-clock near midnight does not land before 11:15.
 */
function sampleInSlateKick(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let t = now + 3 * 60 * 60 * 1000;
  for (let i = 0; i < 48; i += 1) {
    const iso = new Date(t).toISOString();
    const et = etCalendarDate(iso);
    if (et && inSlate(iso, et) && t > now + 60 * 1000) return iso;
    t += 60 * 60 * 1000;
  }
  return new Date(now + 3 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  DK_BOOK,
  HR_BOOK,
  addDays,
  slateBounds,
  inSlate,
  slateReason,
  priceAtDraftKings,
  applyExecutionBook,
  applyBestUsDisplay,
  hardRockReviewFlag,
  reviewHardRock,
  placeableAtDisplayed,
  nflProjectionGap,
  liveInPlayReason,
  selectTop10,
  hasHardRockPrice,
  ensureParlayPlaceable,
  top10Row,
  top10Rows,
  recordRankedList,
  applySilentSortCheck,
  excludedGames,
  verifyStartReason,
  verifySchedule,
  sampleInSlateKick,
  betKey,
};
