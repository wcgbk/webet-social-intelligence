'use strict';

/**
 * Blob → Supabase copy for one ET slate.
 *
 * Odds rows are the lean tape only: opener, 10:00 ET snapshot, kickoff close.
 * Readers are odds-master and omega-pinnacle-line-moves. Closes are the
 * prices the 3:00 ET historical pull stored. There is no 10:30 lock capture
 * in the blobs, and this job does not add an Odds API pull.
 *
 * Posts are insert-ignore. No merge, no update, no delete. Card and picks
 * blobs are read and never written. The optional log is store supabase-sync
 * keyed by the slate date.
 */

const crypto = require('crypto');
const ledger = require('./clv-ledger');
const oddsMaster = require('./omega-vnext/odds_master');
const lineMoves = require('./omega-vnext/pinnacle_line_move');
const { BLOB_STORE, MODEL_VERSION } = require('./omega-vnext/config');
const { replayNoWrite } = require('./omega-vnext/no_write');
const { isSchedulerEvent, rejectUnlessEtSlot } = require('./et-schedule');
const results = require('../get-results-omega')._test;
const gradingRules = require('./omega-grading-rules');

const SUPABASE_URL = 'https://qvfgebrkolfyggfizgkx.supabase.co';
const BATCH_LIMIT = 500;
const LOG_STORE = 'supabase-sync';
/** gradeDay stakes at this many dollars per unit. */
const DOLLAR_PER_UNIT = 150;
const LOCK_NOTE = 'No 10:30 ET lock capture is stored. Odds API pulls are 3:00 and 10:00 ET. snapshot rows are the 10:00 ET pull.';

const TABLES = {
  games: {
    schema: 'clv',
    table: 'games',
    onConflict: 'game_id',
  },
  odds_snapshots: {
    schema: 'clv',
    table: 'odds_snapshots',
    onConflict: 'game_id,book,market,side,point,line_type,snapshot_ts',
  },
  clv_results: {
    schema: 'clv',
    table: 'clv_results',
    onConflict: 'pick_key',
  },
  picks: {
    schema: 'kpi',
    table: 'picks',
    onConflict: 'pick_date,model,matchup,selection,is_parlay',
  },
};

const CLV_KEY_FNS = [
  (date) => `clv-${date}`,
  (date) => `clv-candidates-v2/${date}`,
  (date) => `clv-candidates-${date}`,
  (date) => `omega-candidates/${date}`,
];

const LINE_TYPES = { open: 'opening', 'check-1000': 'snapshot', close: 'closing' };

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name || '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const value = headers[key];
    if (Array.isArray(value)) return String(value[0] || '');
    return value == null ? '' : String(value);
  }
  return '';
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try {
    return JSON.parse(event.body);
  } catch (_) {
    return {};
  }
}

function truthy(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function wantsDryRun(event) {
  const qs = (event && event.queryStringParameters) || {};
  if (truthy(qs.dryRun) || truthy(qs.dryrun)) return true;
  const body = readBody(event);
  return !!(body && (truthy(body.dryRun) || truthy(body.dryrun)));
}

function envOf(deps) {
  if (deps && deps.env) return deps.env;
  return process.env;
}

function bearer(event) {
  const match = /^Bearer\s+(.+)$/i.exec(header(event, 'authorization').trim());
  return match ? match[1].trim() : '';
}

function picksSecretOk(event, env) {
  const secret = env && env.PICKS_SECRET_KEY;
  if (!secret) return false;
  if (bearer(event) === secret) return true;
  if (header(event, 'x-picks-secret') === secret) return true;
  const params = (event && event.queryStringParameters) || {};
  return !!(params.key && params.key === secret);
}

function adminTokenOk(token, env) {
  const secret = env && env.ADMIN_SECRET;
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const encoded = parts[0];
  const mac = parts[1];
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (mac.length !== expected.length) return false;
  const got = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload || !payload.email || !payload.exp) return false;
    if (Date.now() > payload.exp) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/** Scheduler passes. Manual calls need the picks secret or an admin-auth token. */
function isAuthorized(event, env) {
  const src = env || process.env;
  return picksSecretOk(event, src) || adminTokenOk(bearer(event), src);
}

function writesBlocked(env) {
  if (env && Object.prototype.hasOwnProperty.call(env, 'OMEGA_REPLAY_NO_WRITE')) {
    return replayNoWrite(env);
  }
  return replayNoWrite();
}

function targetDate(event, now) {
  const qs = (event && event.queryStringParameters) || {};
  const body = readBody(event);
  const raw = (qs && qs.date) || (body && body.date) || '';
  if (raw) return String(raw).trim();
  return ledger.shiftYmd(ledger.etYmd(now), -1);
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function americanOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^even$/i.test(text)) return 100;
  const n = Number(text.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function oddsNum(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = parseInt(String(value).replace(/[^0-9+-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function normSport(sport) {
  const s = String(sport || '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'CFB' || s === 'NCAAF' || s === 'COLLEGE FOOTBALL') return 'NCAAF';
  return s;
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function eventIdOf(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['eventId', 'event_id', 'oddsEventId']) {
    if (row[key] == null) continue;
    const text = String(row[key]).trim();
    if (text) return text;
  }
  return null;
}

function teamsOf(row) {
  const src = row || {};
  let home = src.homeTeam || src.home_team || null;
  let away = src.awayTeam || src.away_team || null;
  if ((!home || !away) && src.matchup) {
    const parts = String(src.matchup).split(/\s+(?:@|vs\.?|at)\s+/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      away = away || parts[0];
      home = home || parts[1];
    }
  }
  return {
    home: home || null,
    away: away || null,
    commence: src.commenceTime || src.commence_time || src.commence || null,
    sport: src.sport || null,
  };
}

function completeIdentity(info) {
  if (!info) return false;
  if (!normSport(info.sport)) return false;
  if (!normName(info.home) || !normName(info.away)) return false;
  return Number.isFinite(Date.parse(info.commence));
}

function emptyCounts() {
  return { games: 0, odds_snapshots: 0, clv_results: 0, picks: 0 };
}

function bindRead(read, storeName) {
  return async (key) => {
    try {
      const value = await read(storeName, key);
      return value == null ? null : value;
    } catch (err) {
      console.error(`[sync-supabase] read ${storeName}/${key}: ${err && err.message}`);
      return null;
    }
  };
}

async function defaultRead(storeName, key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(storeName);
    return await store.get(key, { type: 'json' });
  } catch (err) {
    console.error(`[sync-supabase] read ${storeName}/${key}: ${err && err.message}`);
    return null;
  }
}

async function defaultWriteLog(date, body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('sync log refused bad date');
  }
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(LOG_STORE);
  await store.setJSON(String(date), body);
}

function tokenParts(token) {
  const parts = String(token || '').split('/');
  if (parts.length < 3) return null;
  return {
    book: parts[0],
    market: parts[1],
    timestamp: parts.slice(2).join('/'),
  };
}

function rolesOf(doc, meta) {
  if (doc && Array.isArray(doc.roles) && doc.roles.length) return doc.roles.slice();
  if (meta && Array.isArray(meta.roles) && meta.roles.length) return meta.roles.slice();
  const one = (doc && doc.role) || (meta && meta.role) || null;
  return one ? [one] : [];
}

function lineTypesFor(roles) {
  const out = [];
  const seen = new Set();
  for (const role of roles || []) {
    const lineType = LINE_TYPES[role];
    if (!lineType || seen.has(lineType)) continue;
    seen.add(lineType);
    out.push(lineType);
  }
  return out;
}

function canonicalTimestamp(index, lineType) {
  if (!index) return null;
  if (lineType === 'opening') return (index.open && index.open.at) || null;
  if (lineType === 'snapshot') {
    const check = index.checks && index.checks['1000'];
    return (check && check.at) || null;
  }
  if (lineType === 'closing' && index.close) return index.close.snapshotAt || index.close.at || null;
  return null;
}

function timestampOk(index, lineType, timestamp) {
  if (lineType === 'closing' && index && index.close) {
    return timestamp === index.close.at || timestamp === index.close.snapshotAt;
  }
  const want = canonicalTimestamp(index, lineType);
  if (!want) return true;
  return timestamp === want;
}

function leanKey(row) {
  return [row.game_id, row.book, row.market, row.side, row.line_type].join('|');
}

function gameRecord(src, source) {
  if (!src || src.eventId == null || String(src.eventId).trim() === '') return null;
  const sport = normSport(src.sport);
  if (!sport) return null;
  return {
    game_id: String(src.eventId).trim(),
    sport,
    season: null,
    commence_time: src.commenceTime || src.commence_time || null,
    home_team: src.homeTeam || src.home_team || null,
    away_team: src.awayTeam || src.away_team || null,
    source,
  };
}

function addGame(games, record) {
  if (!record || !record.game_id || !record.sport) return;
  const prev = games.get(record.game_id);
  if (!prev) {
    games.set(record.game_id, record);
    return;
  }
  if (!prev.home_team && record.home_team) prev.home_team = record.home_team;
  if (!prev.away_team && record.away_team) prev.away_team = record.away_team;
  if (!prev.commence_time && record.commence_time) prev.commence_time = record.commence_time;
  if (!prev.sport && record.sport) prev.sport = record.sport;
}

function snapshotRow(partial) {
  const market = oddsMaster.apiMarket(partial.market);
  const side = partial.side ? String(partial.side).toLowerCase() : '';
  const price = numOrNull(partial.price);
  const gameId = partial.gameId ? String(partial.gameId) : '';
  const book = partial.book ? String(partial.book).toLowerCase() : '';
  if (!gameId || !book || !market || !side || price == null) return null;
  if (!partial.lineType || !partial.snapshotTs) return null;
  return {
    game_id: gameId,
    sport: normSport(partial.sport),
    book,
    market,
    side,
    point: numOrNull(partial.point),
    price,
    line_type: partial.lineType,
    snapshot_ts: partial.snapshotTs,
    source: partial.source,
  };
}

function rowsFromSides(doc, lineType) {
  const out = [];
  for (const [side, quote] of Object.entries((doc && doc.sides) || {})) {
    if (!quote) continue;
    const row = snapshotRow({
      gameId: doc.eventId,
      sport: doc.sport,
      book: doc.book,
      market: doc.market,
      side,
      point: quote.line,
      price: quote.price,
      lineType,
      snapshotTs: doc.timestamp,
      source: 'odds-master',
    });
    if (row) out.push(row);
  }
  return out;
}

function rowsFromQuoteMap(quotes, lineType, timestamp, fallback) {
  const out = [];
  const list = Array.isArray(quotes) ? quotes : Object.values(quotes || {});
  for (const quote of list) {
    if (!quote || typeof quote !== 'object') continue;
    const row = snapshotRow({
      gameId: quote.eventId != null ? quote.eventId : fallback.eventId,
      sport: quote.sport || fallback.sport,
      book: quote.book || fallback.book,
      market: quote.market,
      side: quote.side,
      point: quote.line != null ? quote.line : quote.point,
      price: quote.price,
      lineType,
      snapshotTs: quote.at || timestamp,
      source: fallback.source,
    });
    if (row) out.push(row);
  }
  return out;
}

async function loadOddsMaster(date, read, games, snaps) {
  const masterRead = bindRead(read, oddsMaster.STORE);
  const dated = await oddsMaster.readMasterKey(oddsMaster.dateKey(date), { read: masterRead });
  const events = dated && Array.isArray(dated.events) ? dated.events : [];
  for (const row of events) {
    if (!row || row.eventId == null || !row.sport) continue;
    const index = await oddsMaster.readIndex(row.sport, row.eventId, { read: masterRead });
    const gameSrc = index || {
      sport: row.sport,
      eventId: row.eventId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      commenceTime: row.commenceTime,
    };
    addGame(games, gameRecord(gameSrc, 'odds-master'));
    if (!index || !index.prices) continue;
    for (const [token, meta] of Object.entries(index.prices)) {
      const parsed = tokenParts(token);
      if (!parsed) continue;
      const doc = await oddsMaster.readMasterKey(
        oddsMaster.priceKey(index.sport, index.eventId, parsed.book, parsed.market, parsed.timestamp),
        { read: masterRead },
      );
      if (!doc || !doc.sides) continue;
      const roles = rolesOf(doc, meta);
      for (const lineType of lineTypesFor(roles)) {
        const stamp = doc.timestamp || parsed.timestamp;
        if (!timestampOk(index, lineType, stamp)) continue;
        for (const snap of rowsFromSides({ ...doc, timestamp: stamp }, lineType)) snaps.set(leanKey(snap), snap);
      }
    }
  }
}

async function loadLineMoves(date, read, games, snaps) {
  const lineRead = bindRead(read, lineMoves.LINE_MOVE_STORE);
  const pack = await lineMoves.readPinnacleLineMoves(date, { read: lineRead });
  const events = pack && Array.isArray(pack.events) ? pack.events : [];
  for (const doc of events) {
    if (!doc || doc.eventId == null) continue;
    addGame(games, gameRecord(doc, 'omega-pinnacle-line-moves'));
    const fallback = {
      eventId: doc.eventId,
      sport: doc.sport,
      source: 'omega-pinnacle-line-moves',
    };
    if (doc.open && doc.open.quotes) {
      for (const snap of rowsFromQuoteMap(doc.open.quotes, 'opening', doc.open.at, {
        ...fallback,
        book: 'pinnacle',
      })) {
        if (!snaps.has(leanKey(snap))) snaps.set(leanKey(snap), snap);
      }
    }
    for (const check of doc.checks || []) {
      if (!check || check.slot !== '1000') continue;
      const books = check.books || {};
      for (const book of Object.keys(books)) {
        for (const snap of rowsFromQuoteMap(books[book], 'snapshot', check.at, { ...fallback, book })) {
          if (!snaps.has(leanKey(snap))) snaps.set(leanKey(snap), snap);
        }
      }
    }
  }
}

function rawItems(blob) {
  if (!blob || typeof blob !== 'object') return [];
  if (Array.isArray(blob.candidates)) return blob.candidates;
  if (Array.isArray(blob.picks)) return blob.picks;
  if (Array.isArray(blob.sides)) return blob.sides;
  if (Array.isArray(blob.rows)) return blob.rows;
  return [];
}

function identFrom(item, date) {
  const teams = teamsOf(item);
  return {
    eventId: eventIdOf(item),
    sport: item.sport || teams.sport,
    home: teams.home,
    away: teams.away,
    commence: teams.commence,
    closePrice: americanOrNull(item.closingOdds != null ? item.closingOdds : item.closeOdds),
    closePoint: numOrNull(item.closingLine != null ? item.closingLine : item.closePoint),
    book: item.book || item.anchorBook || null,
    key: ledger.dedupeKey({
      source: 'omega',
      date: item.date || date,
      sport: item.sport,
      market: item.market || item.betType,
      side: item.side || item.pick,
      matchup: item.matchup,
      line: item.line != null ? item.line : item.betLine,
    }),
  };
}

function preferIdent(prev, next) {
  if (!prev) return next;
  if (!prev.eventId && next.eventId) return next;
  if ((!prev.home || !prev.away || !prev.commence) && next.home && next.away && next.commence) return next;
  return prev;
}

function noteSkip(skipped, seen, reason, info) {
  const row = {
    reason,
    sport: normSport(info.sport),
    home: info.home || null,
    away: info.away || null,
    commence: info.commence || null,
  };
  const key = [reason, row.sport, normName(row.home), normName(row.away), String(Date.parse(row.commence))].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  skipped.push(row);
  console.log(`[sync-supabase] skip ${reason} game sport=${row.sport} home=${row.home} away=${row.away} commence=${row.commence}`);
}

function resolveGameId(info, catalog, games, skipped, seen, source) {
  if (!info) return null;
  if (info.eventId) {
    const sport = normSport(info.sport);
    if (sport) {
      addGame(games, {
        game_id: info.eventId,
        sport,
        season: null,
        commence_time: info.commence || null,
        home_team: info.home || null,
        away_team: info.away || null,
        source,
      });
    }
    return info.eventId;
  }
  const hits = completeIdentity(info)
    ? catalog.filter((game) => {
      if (normSport(game.sport) !== normSport(info.sport)) return false;
      const commence = Date.parse(game.commence_time);
      if (!Number.isFinite(commence) || commence !== Date.parse(info.commence)) return false;
      const home = normName(game.home_team);
      const away = normName(game.away_team);
      const wantHome = normName(info.home);
      const wantAway = normName(info.away);
      return (home === wantHome && away === wantAway) || (home === wantAway && away === wantHome);
    })
    : [];
  if (hits.length === 1) return hits[0].game_id;
  if (completeIdentity(info)) noteSkip(skipped, seen, hits.length > 1 ? 'ambiguous' : 'unmatched', info);
  return null;
}

async function loadClv(date, read, games, catalog, skipped, seen) {
  const edgeRead = bindRead(read, BLOB_STORE);
  const merged = [];
  const idents = new Map();
  for (const keyFn of CLV_KEY_FNS) {
    const key = keyFn(date);
    const blob = await edgeRead(key);
    if (!blob) continue;
    const opts = {
      source: 'omega',
      date,
      modelVersion: blob.model || blob.modelVersion || null,
    };
    merged.push(...ledger.rowsFromBlob(key, blob, opts));
    for (const item of rawItems(blob)) {
      if (!item || typeof item !== 'object') continue;
      const ident = identFrom(item, date);
      idents.set(ident.key, preferIdent(idents.get(ident.key), ident));
      resolveGameId(ident, catalog, games, skipped, seen, 'clv');
    }
  }
  const rows = [];
  for (const row of ledger.mergeRows(merged)) {
    if (!row || row.date !== date || !row.key) continue;
    const ident = idents.get(row.key) || null;
    const gameId = ident ? resolveGameId(ident, catalog, games, skipped, seen, 'clv') : null;
    rows.push({
      pick_key: row.key,
      model: 'Omega',
      pick_date: row.date,
      sport: row.sport || null,
      game_id: gameId,
      market: row.market || null,
      selection: row.side == null || row.side === '' ? null : String(row.side),
      pick_price: row.entryPrice == null ? null : row.entryPrice,
      pick_point: row.line == null ? null : row.line,
      close_price: ident ? ident.closePrice : null,
      close_point: ident ? ident.closePoint : null,
      clv_cents: row.clvPp,
      clv_pct: row.clvPp == null ? null : Math.round((Number(row.clvPp) / 100) * 1e6) / 1e6,
      book: ident && ident.book ? ident.book : null,
      source: row.source || 'omega',
      data: {
        beatClose: !!row.beatClose,
        kind: row.kind || null,
        closeNoVigP: row.closeNoVigP == null ? null : row.closeNoVigP,
        modelVersion: row.modelVersion || null,
      },
    });
  }
  rows.sort((a, b) => String(a.pick_key).localeCompare(String(b.pick_key)));
  return rows;
}

function gradeOptions(deps, dryRun, now) {
  const opts = { now };
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'games')) opts.games = deps.games;
  else if (dryRun) opts.games = [];
  return opts;
}

function straightRow(date, card, src, graded) {
  const selection = graded.pick || src.pick;
  if (!selection) return null;
  const units = parseFloat(src.units) || 1;
  return {
    pick_date: date,
    model: 'Omega',
    sport: graded.sport || src.sport || null,
    market: src.betType || src.market || null,
    matchup: graded.matchup || src.matchup || null,
    selection: String(selection),
    odds: graded.odds == null || graded.odds === '' ? (src.odds == null || src.odds === '' ? null : String(src.odds)) : String(graded.odds),
    odds_num: oddsNum(graded.odds != null && graded.odds !== '' ? graded.odds : src.odds),
    units,
    result: graded.result || null,
    profit: numOrNull(graded.profit) == null ? 0 : numOrNull(graded.profit),
    risk: results.wholeUp(units * DOLLAR_PER_UNIT),
    score: graded.score || null,
    is_parlay: false,
    source: 'edge-picks-omega',
    data: {
      modelVersion: (card && (card.model || card.modelVersion)) || MODEL_VERSION,
      rating: graded.rating || src.rating || null,
      tier: src.tier || null,
    },
  };
}

function parlayRow(date, card, ticket, day, graded) {
  const selection = graded.pick || `${ticket.legs.length}-Team Parlay`;
  if (!selection || graded.result === 'skip') return null;
  const units = results.parlayUnitsFromTicket(ticket);
  let risk = Number(day.parlayRisk) || 0;
  if (graded.result === 'pending' || graded.result === 'skip') risk = 0;
  if (graded.result === 'push' && gradingRules.rulesV2(date)) risk = 0;
  return {
    pick_date: date,
    model: 'Omega',
    sport: 'PARLAY',
    market: 'parlay',
    matchup: graded.matchup || null,
    selection: String(selection),
    odds: graded.odds == null || graded.odds === '' ? null : String(graded.odds),
    odds_num: oddsNum(graded.odds),
    units,
    result: graded.result || null,
    profit: numOrNull(graded.profit) == null ? 0 : numOrNull(graded.profit),
    risk,
    score: graded.score || null,
    is_parlay: true,
    source: 'edge-picks-omega',
    data: {
      modelVersion: (card && (card.model || card.modelVersion)) || MODEL_VERSION,
      legs: ticket.legs.length,
      leanDay: ticket.leanDay === true,
    },
  };
}

async function loadPicks(date, read, games, catalog, skipped, seen, deps, dryRun, now) {
  const edgeRead = bindRead(read, BLOB_STORE);
  const card = await edgeRead(`picks-${date}`);
  if (!card || typeof card !== 'object') return [];
  const picks = Array.isArray(card.picks) ? card.picks : [];
  for (const pick of picks) resolveGameId(identFrom(pick, date), catalog, games, skipped, seen, 'picks');
  const ticket = results.cardParlayTicket(card);
  if (ticket) {
    for (const leg of ticket.legs) resolveGameId(identFrom(leg, date), catalog, games, skipped, seen, 'picks');
  }
  if (!picks.length) return [];
  let day = null;
  try {
    day = await results.gradeDay(date, card, gradeOptions(deps, dryRun, now));
  } catch (err) {
    console.error(`[sync-supabase] grade: ${err && err.message}`);
    throw err;
  }
  if (!day || !Array.isArray(day.picks)) return [];
  const straights = picks.slice(0, 3);
  const gradedStraights = day.picks.filter((row) => row && row.sport !== 'PARLAY');
  const out = [];
  gradedStraights.forEach((graded, index) => {
    const row = straightRow(date, card, straights[index] || {}, graded);
    if (row) out.push(row);
  });
  const parlayGraded = day.picks.find((row) => row && row.sport === 'PARLAY');
  if (ticket && parlayGraded) {
    const row = parlayRow(date, card, ticket, day, parlayGraded);
    if (row) out.push(row);
  }
  return out;
}

async function buildSync(opts) {
  const src = opts || {};
  const date = src.date;
  const deps = src.deps || null;
  const read = (deps && deps.read) || defaultRead;
  const errors = [];
  const skipped = [];
  const seen = new Set();
  const games = new Map();
  const snaps = new Map();
  try {
    await loadOddsMaster(date, read, games, snaps);
  } catch (err) {
    console.error(`[sync-supabase] odds-master: ${err && err.message}`);
    errors.push({ step: 'odds-master', error: err && err.message });
  }
  try {
    await loadLineMoves(date, read, games, snaps);
  } catch (err) {
    console.error(`[sync-supabase] line-moves: ${err && err.message}`);
    errors.push({ step: 'line-moves', error: err && err.message });
  }
  const catalog = [...games.values()];
  let clvRows = [];
  try {
    clvRows = await loadClv(date, read, games, catalog, skipped, seen);
  } catch (err) {
    console.error(`[sync-supabase] clv: ${err && err.message}`);
    errors.push({ step: 'clv', error: err && err.message });
  }
  let pickRows = [];
  try {
    pickRows = await loadPicks(date, read, games, catalog, skipped, seen, deps, !!src.dryRun, src.now);
  } catch (err) {
    console.error(`[sync-supabase] picks: ${err && err.message}`);
    errors.push({ step: 'picks', error: err && err.message });
    pickRows = [];
  }
  const gameRows = [...games.values()].sort((a, b) => String(a.game_id).localeCompare(String(b.game_id)));
  const snapRows = [...snaps.values()].sort((a, b) => leanKey(a).localeCompare(leanKey(b)));
  const covered = new Set(snapRows.filter((row) => row.line_type === 'snapshot').map((row) => row.game_id));
  for (const game of gameRows) {
    if (covered.has(game.game_id)) continue;
    console.log(`[sync-supabase] ${game.game_id} has no 10:00 snapshot; no 10:30 lock capture is stored`);
  }
  return {
    date,
    rows: {
      games: gameRows,
      odds_snapshots: snapRows,
      clv_results: clvRows,
      picks: pickRows,
    },
    skipped,
    errors,
  };
}

async function postRows(name, rows, opts) {
  const spec = TABLES[name];
  if (!spec) throw new Error(`unknown table ${name}`);
  const list = dedupeConflict(name, Array.isArray(rows) ? rows : []);
  const out = { posted: 0, requests: 0, errors: [] };
  if (!list.length) return out;
  const env = (opts && opts.env) || process.env;
  const key = env && env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    const error = 'SUPABASE_SERVICE_ROLE_KEY missing';
    console.error(`[sync-supabase] ${name}: ${error}`);
    out.errors.push({ table: name, error });
    return out;
  }
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const url = new URL(`${SUPABASE_URL}/rest/v1/${spec.table}`);
  url.searchParams.set('on_conflict', spec.onConflict);
  for (let i = 0; i < list.length; i += BATCH_LIMIT) {
    const batch = list.slice(i, i + BATCH_LIMIT);
    out.requests += 1;
    let resp;
    try {
      resp = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Profile': spec.schema,
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      console.error(`[sync-supabase] ${name} batch ${i}: ${err && err.message}`);
      out.errors.push({ table: name, offset: i, error: err && err.message });
      continue;
    }
    const status = resp && resp.status;
    if (!resp || !resp.ok) {
      let text = '';
      try {
        text = resp && typeof resp.text === 'function' ? await resp.text() : '';
      } catch (_) {
        text = '';
      }
      console.error(`[sync-supabase] ${name} batch ${i}: supabase ${status} ${String(text).slice(0, 200)}`);
      out.errors.push({ table: name, offset: i, status: status || null, error: `supabase ${status}` });
      continue;
    }
    out.posted += batch.length;
  }
  return out;
}

function conflictFields(name) {
  if (name === 'games') return ['game_id'];
  if (name === 'odds_snapshots') return ['game_id', 'book', 'market', 'side', 'point', 'line_type', 'snapshot_ts'];
  if (name === 'clv_results') return ['pick_key'];
  if (name === 'picks') return ['pick_date', 'model', 'matchup', 'selection', 'is_parlay'];
  return [];
}

function dedupeConflict(name, rows) {
  const fields = conflictFields(name);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = fields.map((field) => (row[field] == null ? '' : String(row[field]))).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function postAll(rows, opts) {
  const posted = emptyCounts();
  const errors = [];
  let requests = 0;
  for (const name of ['games', 'odds_snapshots', 'clv_results', 'picks']) {
    try {
      const result = await postRows(name, rows[name], opts);
      posted[name] = result.posted;
      requests += result.requests;
      errors.push(...result.errors);
    } catch (err) {
      console.error(`[sync-supabase] ${name}: ${err && err.message}`);
      errors.push({ table: name, error: err && err.message });
    }
  }
  return { posted, requests, errors };
}

function summarize(built, extra) {
  const rows = built.rows || { games: [], odds_snapshots: [], clv_results: [], picks: [] };
  const flags = extra || {};
  return {
    ok: (built.errors || []).length === 0,
    dryRun: !!flags.dryRun,
    date: built.date,
    counts: {
      games: rows.games.length,
      odds_snapshots: rows.odds_snapshots.length,
      clv_results: rows.clv_results.length,
      picks: rows.picks.length,
    },
    sample: {
      games: rows.games[0] || null,
      odds_snapshots: rows.odds_snapshots[0] || null,
      clv_results: rows.clv_results[0] || null,
      picks: rows.picks[0] || null,
    },
    rows,
    posted: flags.posted || emptyCounts(),
    requests: flags.requests || 0,
    skipped: built.skipped || [],
    errors: built.errors || [],
    oddsApiCalls: 0,
    wroteLog: !!flags.wroteLog,
    logReason: flags.logReason || null,
    lockNote: LOCK_NOTE,
  };
}

async function writeSyncLog(date, summary, deps, env) {
  if (deps && deps.dryRun) return { wrote: false, reason: 'dry-run' };
  if (writesBlocked(env)) return { wrote: false, reason: 'no-write' };
  const body = {
    date,
    ok: summary.ok,
    counts: summary.counts,
    posted: summary.posted,
    requests: summary.requests,
    skipped: summary.skipped,
    errors: summary.errors,
    lockNote: summary.lockNote,
    at: new Date().toISOString(),
  };
  try {
    const write = deps && typeof deps.writeLog === 'function' ? deps.writeLog : defaultWriteLog;
    await write(String(date), body);
    return { wrote: true, reason: null };
  } catch (err) {
    console.error(`[sync-supabase] log: ${err && err.message}`);
    return { wrote: false, reason: 'log-failed', error: err && err.message };
  }
}

async function handle(event, now, deps) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '' };
  }
  const when = now instanceof Date ? now : new Date();
  const etSkip = rejectUnlessEtSlot('sync-supabase', event, when);
  if (etSkip) return etSkip;
  const env = envOf(deps);
  if (!isSchedulerEvent(event) && !isAuthorized(event, env)) {
    return json(401, { ok: false, error: 'unauthorized', oddsApiCalls: 0 });
  }
  const date = targetDate(event, when);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(200, {
      ok: false,
      error: 'bad date',
      date,
      oddsApiCalls: 0,
      wroteLog: false,
      lockNote: LOCK_NOTE,
    });
  }
  const dryRun = wantsDryRun(event);
  try {
    const built = await buildSync({ date, now: when, deps, env, dryRun });
    let posted = emptyCounts();
    let requests = 0;
    if (!dryRun) {
      const fetchImpl = deps && deps.fetch ? deps.fetch : null;
      const sent = await postAll(built.rows, { env, fetchImpl: fetchImpl || fetch });
      posted = sent.posted;
      requests = sent.requests;
      built.errors.push(...sent.errors);
    }
    const log = { wrote: false, reason: dryRun ? 'dry-run' : null };
    const summary = summarize(built, { dryRun, posted, requests, wroteLog: false, logReason: log.reason });
    if (!dryRun) {
      const written = await writeSyncLog(date, summary, deps, env);
      summary.wroteLog = written.wrote;
      summary.logReason = written.reason;
      if (written.error) summary.logError = written.error;
    }
    summary.ok = built.errors.length === 0;
    return json(200, summary);
  } catch (err) {
    console.error(`[sync-supabase] failed: ${err && err.message}`);
    return json(200, {
      ok: false,
      error: err && err.message,
      date,
      dryRun,
      oddsApiCalls: 0,
      wroteLog: false,
      lockNote: LOCK_NOTE,
    });
  }
}

module.exports = {
  SUPABASE_URL,
  BATCH_LIMIT,
  LOG_STORE,
  LOCK_NOTE,
  TABLES,
  DOLLAR_PER_UNIT,
  handle,
  buildSync,
  postRows,
  isAuthorized,
  targetDate,
};
