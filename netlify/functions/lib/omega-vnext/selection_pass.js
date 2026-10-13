'use strict';

/**
 * Selection pass. DraftKings is the execution book. Hard Rock flags only.
 * Ranking for the top 10 is edge, one candidate per game. Straights are the
 * first three of that list. The parlay is those three. Hard Rock coverage
 * is review-only and does not block publish.
 * See SELECTION_RULES.md.
 *
 * This module must not require gates, parlay, ingest, or hr_autocorrect.
 */

const { etLocalToUtcISO } = require('./price_lock');
const { attachEv, canonicalizeBook } = require('./edge');
const { minEdgeFor } = require('./edge_floor');
const { formatAmerican, etCalendarDate, parseEdgeFraction } = require('./odds_math');
const { toPickObject, matchupKey } = require('./select');

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
 * Keep a candidate only when DraftKings posts that side.
 * A candidate with no bookPrices array is a synthetic fixture and is left
 * on its existing price so gate and select tests stay eligible.
 * The dropped row is the backfill signal: the next DK-priced candidate
 * remains in the pool and can fill the bet.
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
    if (!priced) {
      excluded.push({ ...c, excludeReason: 'no-draftkings-line' });
      continue;
    }
    kept.push(stampHr(priced));
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
 * Floor pool. Edge descending, one candidate per game. A second market on
 * a game already taken is skipped. An exact edge tie keeps the earlier row.
 */
function selectTop10(pool, n) {
  const limit = n == null ? 10 : n;
  const sorted = [...(pool || [])].sort((a, b) => {
    const edge = edgeOf(b) - edgeOf(a);
    if (Math.abs(edge) > 1e-12) return edge;
    return 0;
  });
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

function bookIsDkOrUnknown(c) {
  if (!c || c.book == null || c.book === '') return true;
  return canonicalizeBook(c.book) === DK_BOOK;
}

/**
 * Drop picks that have started or left the slate, then backfill from
 * candidateTable up to 3. A known non-DK book cannot fill. Floors stay
 * at 3% EV and the odds-scaled edge curve. One straight per game.
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
  for (const c of card.candidateTable || []) {
    if (picks.length >= 3) break;
    if (!c || used.has(matchupKey(c))) continue;
    if (!bookIsDkOrUnknown(c)) continue;
    const odds = asAmerican(c.odds);
    const ev = asFraction(c.ev);
    const edge = edgeOf(c);
    const cover = asFraction(c.coverProb);
    if (!(ev >= 0.03) || !(edge > 0) || !Number.isFinite(odds)) continue;
    const need = minEdgeFor(odds, c.uncertainty);
    if (edge + 1e-12 < need) continue;
    if (verifyStartReason(c, now, cardDate, slateOpts)) continue;
    if (cardDate && !inSlate(c, cardDate)) continue;
    const pick = toPickObject({
      ...c,
      odds,
      ev,
      edgePct: edge,
      coverProb: Number.isFinite(cover) ? cover : c.coverProb,
      tier: 'floor',
      book: c.book || DK_BOOK,
    });
    picks.push(pick);
    used.add(matchupKey(pick));
    changed = true;
  }
  if (Array.isArray(card.parlayLegs)) {
    for (const pl of card.parlayLegs) {
      if (!pl || !Array.isArray(pl.legs)) continue;
      const next = pl.legs.filter((leg) => !verifyStartReason(leg, now, cardDate, slateOpts));
      if (next.length !== pl.legs.length) {
        pl.legs = next;
        changed = true;
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

/**
 * Flag Hard Rock gaps on the published card. Does not change pick, book,
 * odds, line, or parlay. changed is always false.
 */
function reviewHardRock(picksData, sportGames) {
  const flags = [];
  const apply = (pick) => {
    if (!pick) return;
    const games = sportGames && sportGames[pick.sport];
    const list = Array.isArray(games) ? games : [];
    const game = matchHrGame(list, pick.matchup);
    const hr = hrQuoteForPick(pick, game);
    if (!hr) return;
    const line = pick.line != null ? Number(pick.line) : null;
    const flag = hardRockReviewFlag({
      sport: pick.sport,
      line: Number.isFinite(line) ? line : pick.line,
      hardRock: hr,
    });
    if (!flag) return;
    pick.hrFlags = flag.flags;
    flags.push({ matchup: pick.matchup, pick: pick.pick || pick.side, flags: flag.flags });
  };
  for (const p of (picksData && picksData.picks) || []) apply(p);
  for (const pl of (picksData && picksData.parlayLegs) || []) {
    for (const leg of (pl && pl.legs) || []) apply(leg);
  }
  return { changed: false, flags, log: flags };
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
  hardRockReviewFlag,
  reviewHardRock,
  nflProjectionGap,
  liveInPlayReason,
  selectTop10,
  hasHardRockPrice,
  ensureParlayPlaceable,
  top10Row,
  top10Rows,
  excludedGames,
  verifyStartReason,
  verifySchedule,
  sampleInSlateKick,
  betKey,
};
