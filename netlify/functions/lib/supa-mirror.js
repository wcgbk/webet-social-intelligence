'use strict';
/**
 * supa-mirror — daily mirror v2. Reads Netlify blobs and ESPN scoreboards,
 * upserts clv.* tables. No omega-vnext imports. No pick, grading, or card writes.
 * SUPABASE_MIRROR_V2 defaults on. off | 0 | false disables every entry point.
 * Writes are idempotent upserts and must not throw into the caller.
 */
const crypto = require('crypto');
const S = require('./clv-supabase');
const { buildDay, lineTypeFor } = require('./clv-sync');

const PICKS_STORE = 'edge-picks-omega';
const ODDS_STORE = 'odds-master';
const RESULTS_KEY = 'results-omega-cache-v9-kpi1030';
const MARKER_STORE = 'supa-mirror';
const BATCH = 500;
const BLOB_CONCURRENCY = 8;
const ESPN_TIMEOUT_MS = 10000;
const SHARP_KEY = /sharp|pinn|power|devig|novig|fair/i;
const MARKET_KEYS = new Set(['h2h', 'spreads', 'totals']);
const SIDE_KEYS = new Set(['home', 'away', 'over', 'under']);
const PARTS = ['odds', 'board', 'card', 'results', 'clv', 'kpi', 'scores'];
const ESPN_PATHS = [
  ['NFL', 'football/nfl', null],
  ['NCAAF', 'football/college-football', '80'],
  ['NHL', 'hockey/nhl', null],
  ['NBA', 'basketball/nba', null],
  ['NCAAM', 'basketball/mens-college-basketball', '50'],
  ['MLB', 'baseball/mlb', null],
];

const PK = {
  board_candidates: ['date', 'row_key'],
  board_rejections: ['date', 'row_key'],
  cards: ['date'],
  card_picks: ['date', 'kind', 'pick_key'],
  parlays: ['date'],
  daily_results: ['date'],
  scores: ['sport', 'event_id'],
  kpi_snapshots: ['date', 'kind'],
  pick_clv: ['date', 'pick_key'],
  mirror_runs: ['date', 'job'],
  book_prices: ['game_id', 'book', 'snapshot_ts'],
};
const NO_UPDATED_AT = new Set(['mirror_runs', 'book_prices']);

// clv.book_prices allowlist (Supabase Free plan, 500 MB cap). Override with
// SUPABASE_BOOK_PRICES_BOOKS / SUPABASE_BOOK_PRICES_SLOTS (comma list, or "all").
const DEFAULT_BOOK_PRICES_BOOKS = [
  'hardrockbet', 'hardrockbet_fl', 'hardrockbet_oh', 'pinnacle', 'draftkings', 'fanduel',
  'betmgm', 'williamhill_us', 'espnbet', 'fanatics', 'betrivers', 'betonlineag', 'bovada', 'lowvig',
];
const DEFAULT_BOOK_PRICES_SLOTS = ['0300', '1000'];

function envList(env, name, fallback) {
  const source = env == null ? process.env : env;
  const raw = source[name];
  if (raw == null || String(raw).trim() === '') return new Set(fallback);
  const text = String(raw).trim().toLowerCase();
  if (text === 'all' || text === '*') return null;
  return new Set(text.split(',').map((x) => x.trim()).filter(Boolean));
}

/** Pure. Keeps allowlisted books at allowlisted slots. */
function filterBookPriceRows(rows, env) {
  const books = envList(env, 'SUPABASE_BOOK_PRICES_BOOKS', DEFAULT_BOOK_PRICES_BOOKS);
  const slots = envList(env, 'SUPABASE_BOOK_PRICES_SLOTS', DEFAULT_BOOK_PRICES_SLOTS);
  return (rows || []).filter((r) => (!books || books.has(String(r.book).toLowerCase()))
    && (!slots || slots.has(String(r.slot).toLowerCase())));
}

function enabled(env) {
  const source = env == null ? process.env : env;
  const raw = source.SUPABASE_MIRROR_V2;
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function asNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--') return null;
  const n = Number(s.replace(/[%+,$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function unitsNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function playKey(sport, matchup, side) {
  return `${String(sport || '').toUpperCase()}|${normText(matchup)}|${normText(side)}`;
}

function decodeKey(k) {
  const s = String(k || '');
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function dedupeLast(rows, cols) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    map.set(cols.map((c) => String(row[c])).join('|'), row);
  }
  return [...map.values()];
}

function etHour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour');
  const n = hour ? Number(hour.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function slotFor(iso) {
  const hour = etHour(iso);
  if (hour === 3) return '0300';
  if (hour === 10) return '1000';
  return 'other';
}

/** UTC instant of 00:00 America/New_York on the given YYYY-MM-DD. */
function etMidnightUtc(ymd) {
  let utc = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(utc)) return null;
  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));
    const g = (t) => parts.find((p) => p.type === t).value;
    const seen = Date.parse(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}Z`);
    const want = Date.parse(`${ymd}T00:00:00Z`);
    const delta = want - seen;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc).toISOString();
}

function isFiller(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.filler === true || p.isFiller === true) return true;
  const badge = String(p.badge || '').toLowerCase();
  return badge === 'filler' || badge.includes('filler');
}

function sharpBag(cand) {
  const out = {};
  for (const [k, v] of Object.entries(cand || {})) {
    if (SHARP_KEY.test(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function parlayTickets(card) {
  const raw = card && card.parlayLegs;
  if (!Array.isArray(raw) || !raw.length) return [];
  const tickets = [];
  const flat = [];
  for (const item of raw) {
    if (item && Array.isArray(item.legs)) tickets.push(item);
    else if (item && (item.pick || item.matchup)) flat.push(item);
  }
  if (flat.length) {
    tickets.push({
      legs: flat,
      combinedOdds: card.combinedOdds != null ? card.combinedOdds : (card.parlayOdds != null ? card.parlayOdds : null),
      unitsNum: card.parlayUnits != null ? card.parlayUnits : null,
      stakeUsd: card.parlayStake != null ? card.parlayStake : (card.parlayStakeUsd != null ? card.parlayStakeUsd : null),
      result: card.parlayResult != null ? card.parlayResult : null,
      profit: card.parlayProfit != null ? card.parlayProfit : null,
    });
  }
  return tickets;
}

function pickKeyFor(p, kind) {
  if (p && p.pickId) return String(p.pickId);
  return sha1(`${p && p.matchup}|${p && p.pick}|${kind}`).slice(0, 16);
}

function cardPickRow(date, kind, p, rank) {
  return {
    date,
    kind,
    pick_key: pickKeyFor(p, kind),
    rank,
    sport: p.sport || null,
    matchup: p.matchup || null,
    home_team: p.homeTeam || null,
    away_team: p.awayTeam || null,
    commence_time: p.commenceTime || null,
    pick: p.pick || null,
    bet_type: p.betType || null,
    market: p.market || p.betType || null,
    line: asNum(p.line),
    odds: asNum(p.odds),
    book: p.book || null,
    units: p.unitsNum != null ? asNum(p.unitsNum) : unitsNum(p.units),
    stake_usd: asNum(p.stakeUsd),
    grade: p.grade || null,
    filler: isFiller(p),
    p_model: asNum(p.pModel != null ? p.pModel : p.p_model),
    p_mkt: asNum(p.pMkt != null ? p.pMkt : p.fair_sharp_p),
    p_cal: asNum(p.pCal),
    edge_novig: asNum(p.edgeNovig),
    ev: asNum(p.evRaw != null ? p.evRaw : p.ev),
    result: p.result || null,
    profit: asNum(p.profit),
    final_score: p.finalScore != null ? String(p.finalScore) : null,
    settled_at: p.settledAt || null,
    raw: p,
  };
}

function buildBoardRows(board, card, date) {
  const day = date || (board && board.date) || null;
  const straights = new Set();
  const legs = new Set();
  for (const p of (card && card.picks) || []) straights.add(playKey(p.sport, p.matchup, p.pick || p.side));
  for (const ticket of parlayTickets(card)) {
    for (const leg of ticket.legs || []) legs.add(playKey(leg.sport, leg.matchup, leg.pick || leg.side));
  }
  const rows = [];
  for (const c of (board && board.candidates) || []) {
    if (!c) continue;
    const side = c.side || c.pick || '';
    const key = playKey(c.sport, c.matchup, side);
    const line = c.line == null || c.line === '' ? '' : String(c.line);
    rows.push({
      date: day,
      row_key: sha1([c.sport, c.matchup, c.market, side, line, c.book].map((v) => (v == null ? '' : String(v))).join('|')).slice(0, 20),
      sport: c.sport || null,
      matchup: c.matchup || null,
      home_team: c.homeTeam || null,
      away_team: c.awayTeam || null,
      commence_time: c.commenceTime || null,
      market: c.market || null,
      side: side || null,
      line: asNum(c.line),
      odds: asNum(c.odds),
      book: c.book || null,
      p_model: asNum(c.pModel),
      p_mkt: asNum(c.pMkt),
      p_mkt_power: asNum(c.pMktPower),
      p_cal: asNum(c.coverProb),
      ev: asNum(c.ev),
      edge_pct: asNum(c.edgePct),
      uncertainty: asNum(c.uncertainty),
      sharp_prices: sharpBag(c),
      is_pick: straights.has(key),
      is_parlay_leg: legs.has(key),
      model_version: (board && board.modelVersion) || null,
      saved_at: (board && board.savedAt) || null,
      raw: c,
    });
  }
  return dedupeLast(rows, PK.board_candidates);
}

function buildCardRows(card, verification, date) {
  const empty = { cards: [], card_picks: [], parlays: [], board_rejections: [] };
  if (!card || typeof card !== 'object') return empty;
  const day = date || card.date || null;
  const tickets = parlayTickets(card);
  const legCount = tickets.reduce((n, t) => n + ((t.legs || []).length), 0);
  const summary = card.summary || {};
  const totalUnits = card.totalUnits != null ? unitsNum(card.totalUnits) : unitsNum(summary.totalUnits);
  const cards = [{
    date: day,
    model_version: card.modelVersion || card.model || summary.modelVersion || null,
    engine: card.engine || null,
    generated_at: card.generatedAt || null,
    total_picks: summary.totalPicks != null ? intOrNull(summary.totalPicks) : ((card.picks || []).length),
    total_units: totalUnits,
    parlay_legs: legCount,
    no_plays: card.noPlays === true || (typeof card.noPlays === 'string' && card.noPlays.length > 0) || card.noGames === true,
    verification: verification || null,
    payload: card,
  }];
  const cardPicks = [];
  (card.picks || []).forEach((p, i) => { if (p) cardPicks.push(cardPickRow(day, 'straight', p, i + 1)); });
  let rank = 1;
  for (const ticket of tickets) {
    for (const leg of ticket.legs || []) {
      if (!leg) continue;
      cardPicks.push(cardPickRow(day, 'parlay', leg, rank));
      rank += 1;
    }
  }
  const parlays = [];
  if (tickets.length) {
    const ticket = tickets[0];
    const units = ticket.unitsNum != null ? unitsNum(ticket.unitsNum) : (card.parlayUnits != null ? unitsNum(card.parlayUnits) : unitsNum(ticket.units));
    parlays.push({
      date: day,
      legs: legCount,
      combined_odds: asNum(ticket.combinedOdds != null ? ticket.combinedOdds : card.combinedOdds),
      units,
      stake_usd: asNum(ticket.stakeUsd != null ? ticket.stakeUsd : (card.parlayStake != null ? card.parlayStake : card.parlayStakeUsd)),
      result: ticket.result || card.parlayResult || null,
      profit: asNum(ticket.profit != null ? ticket.profit : card.parlayProfit),
      raw: tickets.length === 1 ? ticket : tickets,
    });
  }
  const rejections = [];
  for (const r of card.rejections || []) {
    if (!r) continue;
    rejections.push({
      date: day,
      row_key: sha1([r.sport, r.matchup, r.market, r.side, r.reason, r.odds, r.book].map((v) => (v == null ? '' : String(v))).join('|')).slice(0, 20),
      sport: r.sport || null,
      matchup: r.matchup || null,
      market: r.market || null,
      side: r.side || null,
      odds: asNum(r.odds),
      book: r.book || null,
      reason: r.reason || null,
      raw: r,
    });
  }
  return {
    cards,
    card_picks: dedupeLast(cardPicks, PK.card_picks),
    parlays,
    board_rejections: dedupeLast(rejections, PK.board_rejections),
  };
}

function buildResultRows(cache, date) {
  const day = ((cache && cache.days) || []).find((d) => d && d.date === date);
  if (!day) return [];
  const raw = { ...day };
  delete raw.picks;
  return [{
    date,
    record: day.record != null ? String(day.record) : null,
    wins: intOrNull(day.wins),
    losses: intOrNull(day.losses),
    pushes: intOrNull(day.pushes),
    pending: intOrNull(day.pending),
    wagered: asNum(day.wagered),
    profit: asNum(day.profit),
    roi: asNum(day.roi),
    parlay_result: day.parlayResult != null ? String(day.parlayResult) : null,
    parlay_profit: asNum(day.parlayProfit),
    no_plays: !!day.noPlays,
    raw,
  }];
}

function buildPickClvRows(doc, date) {
  const day = date || (doc && doc.date) || null;
  const rows = [];
  for (const p of (doc && doc.picks) || []) {
    if (!p) continue;
    const segment = p.segment || '';
    rows.push({
      date: day,
      pick_key: sha1(`${p.matchup}|${p.pick}|${segment}`).slice(0, 16),
      sport: p.sport || null,
      matchup: p.matchup || null,
      pick: p.pick || null,
      market: p.market || p.betType || null,
      segment: p.segment || null,
      units: p.units != null ? String(p.units) : null,
      pick_time_odds: asNum(p.pickTimeOdds),
      bet_line: asNum(p.betLine),
      closing_odds: asNum(p.closingOdds),
      closing_line: asNum(p.closingLine),
      anchor: p.anchor || p.anchorBook || null,
      pick_time_novig: asNum(p.pickTimeNoVig),
      closing_novig: asNum(p.closingNoVig),
      clv: asNum(p.clv),
      clv_cents: asNum(p.clvCents),
      beat_closing: p.beatClosing == null ? null : !!p.beatClosing,
      close_snapshot_at: p.closeSnapshotAt || null,
      commence_time: p.commenceTime || null,
      result: p.result || null,
      profit: asNum(p.profit),
      raw: p,
    });
  }
  return dedupeLast(rows, PK.pick_clv);
}

function cumulativePayload(cache) {
  if (!cache || typeof cache !== 'object') return null;
  const out = { ...cache };
  delete out.days;
  return out;
}

function buildKpiRows(date, docs) {
  const src = docs || {};
  const rows = [];
  if (src.tracking) rows.push({ date, kind: 'tracking', payload: src.tracking });
  if (src.clvReport) rows.push({ date, kind: 'clv-report', payload: src.clvReport });
  if (src.cumulative) rows.push({ date, kind: 'results-cumulative', payload: src.cumulative });
  return rows;
}

function sideRec(price, line, market) {
  const p = asNum(price);
  if (p == null) return null;
  const rec = { price: p };
  if (market !== 'h2h') {
    const ln = asNum(line);
    if (ln != null) rec.line = ln;
  }
  return rec;
}

function sidesFromPriceDoc(sides, market) {
  const out = {};
  for (const [k, s] of Object.entries(sides || {})) {
    if (!SIDE_KEYS.has(k) || !s) continue;
    const rec = sideRec(s.price, s.line, market);
    if (rec) out[k] = rec;
  }
  return out;
}

function sideKeyFromOutcome(name, market, home, away) {
  if (market === 'totals') {
    if (/^over$/i.test(name)) return 'over';
    if (/^under$/i.test(name)) return 'under';
    return null;
  }
  if (name === home) return 'home';
  if (name === away) return 'away';
  if (normText(name) && normText(name) === normText(home)) return 'home';
  if (normText(name) && normText(name) === normText(away)) return 'away';
  return null;
}

function marketsFromRaw(raw, home, away) {
  const byBook = new Map();
  for (const bk of (raw && raw.bookmakers) || []) {
    if (!bk || !bk.key || bk.key === 'raw' || bk.key === 'index') continue;
    const markets = {};
    for (const m of bk.markets || []) {
      if (!m || !MARKET_KEYS.has(m.key)) continue;
      const sides = {};
      for (const o of m.outcomes || []) {
        const sk = sideKeyFromOutcome(o && o.name, m.key, home, away);
        if (!sk) continue;
        const rec = sideRec(o.price, o.point, m.key);
        if (rec) sides[sk] = rec;
      }
      if (Object.keys(sides).length) markets[m.key] = sides;
    }
    if (Object.keys(markets).length) byBook.set(bk.key, markets);
  }
  return byBook;
}

function bookPriceRow(date, ev, book, ts, markets) {
  return {
    game_id: ev.eventId,
    book,
    snapshot_ts: ts,
    sport: ev.sport || null,
    slot: slotFor(ts),
    date,
    home_team: ev.homeTeam || null,
    away_team: ev.awayTeam || null,
    commence_time: ev.commenceTime || null,
    markets,
    source: 'netlify:odds-master',
  };
}

/**
 * Pure. `raw` items are {event, ts, body}. `prices` items are {event, key, doc}.
 * A raw body for a timestamp covers every book at that timestamp.
 */
function buildBookPriceRows(date, events, inputs) {
  const src = inputs || {};
  const rows = [];
  const covered = new Set();
  for (const item of src.raw || []) {
    const ev = item && item.event;
    const ts = item && item.ts;
    if (!ev || !ts || !item.body) continue;
    if (!lineTypeFor({ at: ts }, ev.commenceTime)) continue;
    const home = ev.homeTeam || item.body.home_team;
    const away = ev.awayTeam || item.body.away_team;
    const byBook = marketsFromRaw(item.body, home, away);
    covered.add(`${ev.eventId}|${ts}`);
    for (const [book, markets] of byBook) rows.push(bookPriceRow(date, ev, book, ts, markets));
  }
  const groups = new Map();
  for (const item of src.prices || []) {
    const ev = item && item.event;
    const doc = item && item.doc;
    if (!ev || !doc) continue;
    const book = doc.book;
    const market = doc.market;
    if (!book || book === 'raw' || book === 'index' || !MARKET_KEYS.has(market)) continue;
    const ts = doc.snapshotAt || doc.timestamp || doc.at || tsFromKey(item.key);
    if (!ts) continue;
    if (covered.has(`${ev.eventId}|${ts}`)) continue;
    if (!lineTypeFor({ at: ts, role: doc.role, pregame: doc.pregame }, ev.commenceTime)) continue;
    const id = `${ev.eventId}|${book}|${ts}`;
    if (!groups.has(id)) groups.set(id, { ev, book, ts, markets: {} });
    const sides = sidesFromPriceDoc(doc.sides, market);
    if (Object.keys(sides).length) groups.get(id).markets[market] = sides;
  }
  for (const g of groups.values()) {
    if (!Object.keys(g.markets).length) continue;
    rows.push(bookPriceRow(date, g.ev, g.book, g.ts, g.markets));
  }
  void events;
  return dedupeLast(rows, PK.book_prices);
}

function tsFromKey(key) {
  const parts = String(key || '').split('/');
  return parts.length >= 5 ? parts.slice(4).join('/') : null;
}

function parseEspn(payload, sport) {
  const events = payload && Array.isArray(payload.events)
    ? payload.events
    : (Array.isArray(payload) ? payload : []);
  const rows = [];
  for (const ev of events) {
    if (!ev || ev.id == null || ev.id === '') continue;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const comps = comp.competitors || [];
    const home = comps.find((c) => c && c.homeAway === 'home') || {};
    const away = comps.find((c) => c && c.homeAway === 'away') || {};
    const status = (comp.status && comp.status.type) || {};
    const commence = ev.date || comp.date || null;
    let date = null;
    if (commence) {
      const d = new Date(commence);
      if (!Number.isNaN(d.getTime())) date = S.etYmd(d);
    }
    rows.push({
      sport,
      event_id: String(ev.id),
      date,
      commence_time: commence,
      home_team: (home.team && home.team.displayName) || null,
      away_team: (away.team && away.team.displayName) || null,
      home_score: intOrNull(home.score),
      away_score: intOrNull(away.score),
      status: status.name || null,
      completed: status.completed == null ? null : !!status.completed,
      neutral_site: comp.neutralSite == null ? null : !!comp.neutralSite,
      source: 'espn',
    });
  }
  return dedupeLast(rows, PK.scores);
}

function espnUrl(sport, path, groups, ymd) {
  const u = new URL(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
  u.searchParams.set('dates', ymd);
  u.searchParams.set('limit', '500');
  if (groups) u.searchParams.set('groups', groups);
  return { sport, url: u.toString() };
}

async function fetchTimeout(fetchImpl, url, ms) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ac) ac.abort(); }, ms);
  try {
    return await fetchImpl(url, ac ? { signal: ac.signal } : {});
  } finally {
    clearTimeout(timer);
  }
}

async function fetchScores(date, fetchImpl) {
  const f = fetchImpl || fetch;
  const ymd = String(date || '').replace(/-/g, '');
  const rows = [];
  const errors = [];
  await S.mapLimit(ESPN_PATHS, ESPN_PATHS.length, async ([sport, path, groups]) => {
    const job = espnUrl(sport, path, groups, ymd);
    try {
      const resp = await fetchTimeout(f, job.url, ESPN_TIMEOUT_MS);
      if (!resp || !resp.ok) throw new Error(`espn ${sport} HTTP ${resp && resp.status}`);
      const body = await resp.json();
      rows.push(...parseEspn(body, sport));
    } catch (e) {
      errors.push(`${sport}: ${e.message}`);
    }
  });
  return { rows: dedupeLast(rows, PK.scores), errors };
}

function redact(msg, env) {
  let out = String(msg || '');
  const secrets = [env && env.SUPABASE_SERVICE_ROLE_KEY, env && env.NETLIFY_AUTH_TOKEN, env && env.ODDS_API_KEY];
  for (const secret of secrets) {
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]');
  }
  return out;
}

async function upsert(table, rows, env, fetchImpl) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return 0;
  const cols = PK[table];
  if (!cols) throw new Error(`unknown mirror table ${table}`);
  S.requireEnv(env, ['SUPABASE_SERVICE_ROLE_KEY']);
  const now = new Date().toISOString();
  const stamped = dedupeLast(list, cols).map((row) => {
    const out = { ...row };
    if (table === 'mirror_runs') out.ran_at = now;
    else if (!NO_UPDATED_AT.has(table)) out.updated_at = now;
    return out;
  });
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const f = fetchImpl || fetch;
  for (let i = 0; i < stamped.length; i += BATCH) {
    const batch = dedupeLast(stamped.slice(i, i + BATCH), cols);
    const url = `${S.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(cols.join(','))}`;
    const resp = await f(url, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'clv',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!resp || !resp.ok) {
      const text = resp && resp.text ? await resp.text().catch(() => '') : '';
      const status = resp && resp.status;
      throw new Error(redact(`supabase ${table} HTTP ${status}: ${String(text).slice(0, 300)}`, env));
    }
  }
  return stamped.length;
}

async function safeGet(blobs, store, key, errors, label) {
  try {
    return await blobs.get(store, key);
  } catch (e) {
    errors.push(`${label || key}: ${e.message}`);
    return null;
  }
}

async function collectPriceInputs(date, blobs) {
  const byDate = (await blobs.get(ODDS_STORE, `by-date/${date}`)) || { events: [] };
  const events = (byDate.events || []).filter((e) => e && e.eventId && e.sport);
  const raw = [];
  const prices = [];
  const errors = [];
  await S.mapLimit(events, BLOB_CONCURRENCY, async (ev) => {
    try {
      const listed = await blobs.list(ODDS_STORE, `${ev.sport}/${ev.eventId}/`);
      const keys = (listed || []).map((k) => ({ rawKey: k, dec: decodeKey(k) }));
      const rawKeys = keys.filter((k) => {
        const parts = k.dec.split('/');
        return parts[2] === 'raw' && parts.length >= 4;
      });
      const covered = new Set();
      for (const k of rawKeys) {
        const ts = k.dec.split('/').slice(3).join('/');
        const body = await blobs.get(ODDS_STORE, k.rawKey);
        if (body && Array.isArray(body.bookmakers)) {
          covered.add(ts);
          raw.push({ event: ev, ts, body });
        }
      }
      const priceKeys = keys.filter((k) => {
        const parts = k.dec.split('/');
        if (parts.length < 5) return false;
        const book = parts[2];
        if (!book || book === 'raw' || book === 'index') return false;
        const ts = parts.slice(4).join('/');
        return !covered.has(ts);
      });
      const docs = await S.mapLimit(priceKeys, 4, async (k) => ({
        event: ev,
        key: k.dec,
        doc: await blobs.get(ODDS_STORE, k.rawKey),
      }));
      for (const item of docs) if (item && item.doc) prices.push(item);
    } catch (e) {
      errors.push(`${ev.sport}/${ev.eventId}: ${e.message}`);
    }
  });
  return { events, raw, prices, errors };
}

async function writeTable(table, rows, env, fetchImpl, dry, counts, errors) {
  const n = (rows || []).length;
  if (!n) return;
  if (dry) {
    counts[table] = (counts[table] || 0) + dedupeLast(rows, PK[table]).length;
    return;
  }
  try {
    const posted = await upsert(table, rows, env, fetchImpl);
    counts[table] = (counts[table] || 0) + posted;
  } catch (e) {
    errors.push(redact(e.message, env));
  }
}

function markerHash(card, verification) {
  const states = [];
  for (const p of (card && card.picks) || []) {
    states.push([p.pickId || p.pick || '', p.result || '', p.profit == null ? '' : p.profit, p.finalScore || '']);
  }
  for (const ticket of parlayTickets(card)) {
    states.push(['ticket', ticket.result || '', ticket.profit == null ? '' : ticket.profit]);
    for (const leg of ticket.legs || []) {
      states.push([leg.pickId || leg.pick || '', leg.result || '', leg.profit == null ? '' : leg.profit, leg.finalScore || '']);
    }
  }
  const body = JSON.stringify({
    generatedAt: (card && card.generatedAt) || null,
    verifiedAt: (verification && verification.verifiedAt) || null,
    states,
  });
  return sha1(body);
}

async function mirrorDay(date, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const blobs = deps.blobs || S.blobClient(env, fetchImpl);
  const parts = new Set(deps.parts && deps.parts.length ? deps.parts : PARTS);
  const job = deps.job || 'daily';
  const dry = !!deps.dry;
  const counts = {};
  const errors = [];
  const wantSnapshots = deps.oddsSnapshots !== false;

  if (parts.has('odds')) {
    const priceDates = [...new Set([date, ...(deps.extraBookPriceDates || [])])];
    for (const d of priceDates) {
      try {
        if (wantSnapshots && d === date) {
          const built = await buildDay(d, blobs, {
            env,
            concurrency: BLOB_CONCURRENCY,
            neighbourDates: [S.addDays(d, -1), S.addDays(d, 1)],
          });
          for (const err of (built.stats && built.stats.errors) || []) errors.push(`odds ${d}: ${err}`);
          const games = S.dedupe(built.games || [], ['game_id']);
          const snaps = S.dedupe(built.snaps || [], S.CONFLICT.odds_snapshots.split(','));
          if (dry) {
            counts.games = (counts.games || 0) + games.length;
            counts.odds_snapshots = (counts.odds_snapshots || 0) + snaps.length;
          } else if (games.length || snaps.length) {
            try {
              const posted = await S.writeRows({ games, snaps }, env, fetchImpl);
              counts.games = (counts.games || 0) + (posted.games || 0);
              counts.odds_snapshots = (counts.odds_snapshots || 0) + (posted.odds_snapshots || 0);
            } catch (e) {
              errors.push(redact(`odds_snapshots ${d}: ${e.message}`, env));
            }
          }
        }
        const collected = await collectPriceInputs(d, blobs);
        for (const err of collected.errors) errors.push(`book_prices ${d}: ${err}`);
        const priceRows = filterBookPriceRows(buildBookPriceRows(d, collected.events, collected), env);
        await writeTable('book_prices', priceRows, env, fetchImpl, dry, counts, errors);
      } catch (e) {
        errors.push(redact(`odds ${d}: ${e.message}`, env));
      }
    }
  }

  let card = null;
  let verification = null;
  let board = null;
  if (parts.has('board') || parts.has('card')) {
    card = await safeGet(blobs, PICKS_STORE, `picks-${date}`, errors, `picks-${date}`);
    verification = parts.has('card')
      ? await safeGet(blobs, PICKS_STORE, `verification-${date}`, errors, `verification-${date}`)
      : null;
    board = parts.has('board')
      ? await safeGet(blobs, PICKS_STORE, `omega-v2/morning-board/${date}`, errors, `morning-board-${date}`)
      : null;
  }

  if (parts.has('board')) {
    try {
      await writeTable('board_candidates', buildBoardRows(board, card, date), env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`board: ${e.message}`, env));
    }
  }

  if (parts.has('card') && card) {
    try {
      const built = buildCardRows(card, verification, date);
      await writeTable('cards', built.cards, env, fetchImpl, dry, counts, errors);
      await writeTable('card_picks', built.card_picks, env, fetchImpl, dry, counts, errors);
      await writeTable('parlays', built.parlays, env, fetchImpl, dry, counts, errors);
      await writeTable('board_rejections', built.board_rejections, env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`card: ${e.message}`, env));
    }
  }

  let resultsCache = null;
  if (parts.has('results') || (parts.has('kpi') && deps.includeCumulative)) {
    resultsCache = await safeGet(blobs, PICKS_STORE, RESULTS_KEY, errors, RESULTS_KEY);
  }
  if (parts.has('results')) {
    try {
      await writeTable('daily_results', buildResultRows(resultsCache, date), env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`results: ${e.message}`, env));
    }
  }

  if (parts.has('clv')) {
    try {
      const clvDoc = await safeGet(blobs, PICKS_STORE, `clv-${date}`, errors, `clv-${date}`);
      await writeTable('pick_clv', buildPickClvRows(clvDoc, date), env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`clv: ${e.message}`, env));
    }
  }

  if (parts.has('kpi')) {
    try {
      const tracking = await safeGet(blobs, PICKS_STORE, `omega-tracking/${date}`, errors, `tracking-${date}`);
      const clvReport = await safeGet(blobs, PICKS_STORE, `omega-clv-report/${date}`, errors, `clv-report-${date}`);
      const docs = { tracking, clvReport };
      if (deps.includeCumulative) docs.cumulative = cumulativePayload(resultsCache);
      await writeTable('kpi_snapshots', buildKpiRows(date, docs), env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`kpi: ${e.message}`, env));
    }
  }

  if (parts.has('scores')) {
    try {
      const scored = await fetchScores(date, fetchImpl);
      for (const err of scored.errors) errors.push(`scores: ${err}`);
      await writeTable('scores', scored.rows, env, fetchImpl, dry, counts, errors);
    } catch (e) {
      errors.push(redact(`scores: ${e.message}`, env));
    }
  }

  if (!dry) {
    const summary = {
      counts: { ...counts },
      errors: errors.slice(0, 20),
      parts: [...parts],
      includeCumulative: !!deps.includeCumulative,
    };
    try {
      await upsert('mirror_runs', [{
        date, job, ok: errors.length === 0, summary,
      }], env, fetchImpl);
      counts.mirror_runs = (counts.mirror_runs || 0) + 1;
    } catch (e) {
      errors.push(redact(`mirror_runs: ${e.message}`, env));
    }
  }

  return { ok: errors.length === 0, counts, errors };
}

async function mirrorTodayCard(date, deps = {}) {
  const env = deps.env || process.env;
  const counts = {};
  const errors = [];
  if (!enabled(env)) return { ok: true, skipped: 'flag-off', counts, errors };
  const fetchImpl = deps.fetch || fetch;
  const blobs = deps.blobs || S.blobClient(env, fetchImpl);
  try {
    const card = deps.card || await blobs.get(PICKS_STORE, `picks-${date}`);
    if (!card) return { ok: true, skipped: 'no-card', counts, errors };
    const verification = deps.verification || await blobs.get(PICKS_STORE, `verification-${date}`);
    const hash = markerHash(card, verification);
    const markerKey = `today/${date}`;
    let marker = null;
    try { marker = await blobs.get(MARKER_STORE, markerKey); } catch (_) { marker = null; }
    if (marker && marker.hash === hash) return { ok: true, skipped: 'unchanged', counts, errors };
    const board = await blobs.get(PICKS_STORE, `omega-v2/morning-board/${date}`);
    const built = buildCardRows(card, verification, date);
    await writeTable('board_candidates', buildBoardRows(board, card, date), env, fetchImpl, false, counts, errors);
    await writeTable('board_rejections', built.board_rejections, env, fetchImpl, false, counts, errors);
    await writeTable('cards', built.cards, env, fetchImpl, false, counts, errors);
    await writeTable('card_picks', built.card_picks, env, fetchImpl, false, counts, errors);
    await writeTable('parlays', built.parlays, env, fetchImpl, false, counts, errors);
    const ok = errors.length === 0;
    if (ok) {
      try {
        await upsert('mirror_runs', [{
          date, job: 'today-card', ok: true, summary: { counts: { ...counts }, hash },
        }], env, fetchImpl);
        counts.mirror_runs = (counts.mirror_runs || 0) + 1;
        await blobs.set(MARKER_STORE, markerKey, { hash, at: new Date().toISOString() });
      } catch (e) {
        errors.push(redact(e.message, env));
      }
    }
    return { ok: errors.length === 0, counts, errors };
  } catch (e) {
    return { ok: false, counts, errors: [redact(e.message, env)] };
  }
}

async function mirrorAfterSync(date, deps = {}) {
  const base = ['board', 'card', 'results', 'clv', 'kpi', 'scores'];
  const prevDate = S.addDays(date, -1);
  const nextDate = S.addDays(date, 1);
  const prev = await mirrorDay(prevDate, { ...deps, parts: base, job: 'daily' });
  const cur = await mirrorDay(date, {
    ...deps,
    parts: [...base, 'odds'],
    oddsSnapshots: false,
    extraBookPriceDates: [nextDate],
    includeCumulative: true,
    job: 'daily',
  });
  const counts = {};
  for (const src of [prev, cur]) {
    for (const [k, v] of Object.entries(src.counts || {})) counts[k] = (counts[k] || 0) + v;
  }
  const errors = [...(prev.errors || []), ...(cur.errors || [])];
  return { ok: !!(prev.ok && cur.ok), counts, errors, prev, date: cur };
}

module.exports = {
  enabled,
  sha1,
  asNum,
  etMidnightUtc,
  slotFor,
  etHour,
  decodeKey,
  parlayTickets,
  markerHash,
  buildBoardRows,
  buildCardRows,
  buildResultRows,
  buildPickClvRows,
  buildKpiRows,
  buildBookPriceRows,
  filterBookPriceRows,
  DEFAULT_BOOK_PRICES_BOOKS,
  cumulativePayload,
  parseEspn,
  fetchScores,
  upsert,
  collectPriceInputs,
  mirrorDay,
  mirrorTodayCard,
  mirrorAfterSync,
  PK,
  PARTS,
  RESULTS_KEY,
  ESPN_PATHS,
  espnUrl,
};
