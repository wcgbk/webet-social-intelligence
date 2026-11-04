'use strict';

/**
 * Join stored DraftKings and Hard Rock quotes onto derived rows.
 * Offline files only. No Odds API. A quote is kept only when the stored
 * book is DraftKings or Hard Rock and the game, market, side, and line match.
 * Another book's number is never relabeled.
 *
 * Snapshot order for one row, when more than one real quote matches:
 *   1. The stakeaudit card for that slate date (the published price and book)
 *   2. The odds-master 10:00 board from loadMasterBoard (same reader as dryrun-card.js)
 *   3. The latest morning line snap at or before pick time, else the closest snap
 *   4. The odds-master 3:00 board
 *   5. A file under /workspace/urgent1103 whose commence date is that slate
 * Inside one snapshot, the higher American number wins. Prices from
 * different snapshots are not mixed.
 */

const fs = require('fs');
const path = require('path');
const v2 = require('../../netlify/functions/lib/omega-v2');
const { loadMasterBoard } = require('../../netlify/functions/lib/odds-master/board');
const { extractGameBooks, gameKey: teamsKey } = require('../../netlify/functions/lib/omega-vnext/line_path');

const LINE_SNAP_ROOTS = [
  '/workspace/omega-replay-2w/inputs',
  '/workspace/retest-1020/harness/inputs',
  '/workspace/omega-clv-wf/inputs/blobs',
];
const MASTER_ROOT = '/workspace/supabase-netlify/stage/odds-master';
const CARD_DIR = '/workspace/stakeaudit';
const URGENT_DIR = '/workspace/urgent1103';

function canonBook(book) {
  const key = String(book || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'draftkings') return 'draftkings';
  if (key === 'hardrock' || key === 'hardrockbet' || key === 'hardrockbetoh') return 'hardrockbet';
  return '';
}

function foldMatchup(matchup) {
  return String(v2.gameKey(matchup) || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function foldTeam(name) {
  return foldMatchup(name);
}

function lineToken(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 1000) / 1000);
}

function parseAmerican(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null;
  const n = Number(String(value == null ? '' : value).replace(/[−–]/g, '-').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function etDate(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function marketOf(row) {
  return v2.marketFamily(row.market || row.betType, row.pick);
}

function sideAndLine(row) {
  const market = marketOf(row);
  const pick = String(row.pick || '');
  if (market === 'Total') {
    let side = null;
    if (/^\s*over\b/i.test(pick)) side = 'over';
    else if (/^\s*under\b/i.test(pick)) side = 'under';
    let line = row.betPoint != null && row.betPoint !== '' ? lineToken(row.betPoint) : null;
    if (line == null && row.line != null && row.line !== '') line = lineToken(row.line);
    if (line == null) {
      const m = pick.match(/\b(?:over|under)\s+([+-]?\d+(?:\.\d+)?)/i);
      if (m) line = lineToken(m[1]);
    }
    return { market, side, line };
  }
  if (market === 'Moneyline') {
    const team = foldTeam(pick.replace(/\s+ML\s*$/i, '').replace(/\s+moneyline\s*$/i, ''));
    return { market, side: team, line: 'ml' };
  }
  let line = row.betPoint != null && row.betPoint !== '' ? lineToken(row.betPoint) : null;
  if (line == null && row.line != null && row.line !== '') line = lineToken(row.line);
  if (line == null) {
    const m = pick.match(/([+-]\d+(?:\.\d+)?)\s*$/);
    if (m) line = lineToken(m[1]);
  }
  const team = foldTeam(pick.replace(/\s*[+-]\d+(?:\.\d+)?\s*$/, ''));
  return { market, side: team, line };
}

function quoteKey(slateDate, matchup, market, side, line) {
  if (!slateDate || !matchup || !market || !side || line == null || line === '') return null;
  return `${slateDate}|${foldMatchup(matchup)}|${market}|${side}|${line}`;
}

function rowQuoteKey(date, row) {
  const parsed = sideAndLine(row);
  return quoteKey(date, row.matchup, parsed.market, parsed.side, parsed.line);
}

function poolKey(row) {
  return `${v2.gameKey(row.matchup)}|${String(row.pick || '').toLowerCase()}`;
}

function dayRows(day) {
  const rows = [...(day.straights || [])];
  const legs = day.parlay && Array.isArray(day.parlay.legs) ? day.parlay.legs : [];
  for (const row of legs) rows.push(row);
  return rows;
}

function dayPool(day) {
  const map = new Map();
  for (const row of dayRows(day)) {
    const key = poolKey(row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function readJson(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function dateInPath(full) {
  const found = String(full).match(/20\d{2}-\d{2}-\d{2}/g);
  return found && found.length ? found[found.length - 1] : null;
}

function createIndex() {
  const map = new Map();
  let conflicts = 0;
  function add(key, snapId, meta, book, american) {
    const canon = canonBook(book);
    const n = Number(american);
    if (!key || !canon || !Number.isFinite(n) || n === 0) return;
    if (!map.has(key)) map.set(key, new Map());
    const snaps = map.get(key);
    if (!snaps.has(snapId)) snaps.set(snapId, { ...meta, prices: new Map() });
    const bucket = snaps.get(snapId);
    const prev = bucket.prices.get(canon);
    if (!prev) bucket.prices.set(canon, { american: n, conflict: false });
    else if (prev.american !== n) {
      prev.conflict = true;
      conflicts += 1;
    }
  }
  return {
    add,
    map,
    conflictCount() { return conflicts; },
  };
}

function teamsOf(gameKeyStr, game) {
  let home = game && game.homeTeam;
  let away = game && game.awayTeam;
  if (!home || !away) {
    const parts = String(gameKeyStr || '').split(/\s+@\s+/);
    if (parts.length === 2) {
      away = away || parts[0];
      home = home || parts[1];
    }
  }
  return { home: foldTeam(home), away: foldTeam(away), matchup: `${away || ''} @ ${home || ''}`.trim() };
}

function addGame(index, slateDate, gameKeyStr, game, meta) {
  if (!slateDate || !game || !game.books) return;
  const teams = teamsOf(gameKeyStr, game);
  if (!teams.home || !teams.away) return;
  const matchup = `${teams.away} @ ${teams.home}`;
  const snapId = `${slateDate}|${meta.source}|${meta.at || ''}`;
  for (const [book, row] of Object.entries(game.books)) {
    if (!row || typeof row !== 'object') continue;
    if (row.mlHome != null) {
      index.add(quoteKey(slateDate, matchup, 'Moneyline', teams.home, 'ml'), snapId, meta, book, row.mlHome);
    }
    if (row.mlAway != null) {
      index.add(quoteKey(slateDate, matchup, 'Moneyline', teams.away, 'ml'), snapId, meta, book, row.mlAway);
    }
    if (row.spreadHome != null && row.spreadHomeOdds != null) {
      index.add(
        quoteKey(slateDate, matchup, 'Spread', teams.home, lineToken(row.spreadHome)),
        snapId, meta, book, row.spreadHomeOdds,
      );
    }
    if (row.spreadAway != null && row.spreadAwayOdds != null) {
      index.add(
        quoteKey(slateDate, matchup, 'Spread', teams.away, lineToken(row.spreadAway)),
        snapId, meta, book, row.spreadAwayOdds,
      );
    }
    if (row.total != null && row.overOdds != null) {
      index.add(
        quoteKey(slateDate, matchup, 'Total', 'over', lineToken(row.total)),
        snapId, meta, book, row.overOdds,
      );
    }
    if (row.total != null && row.underOdds != null) {
      index.add(
        quoteKey(slateDate, matchup, 'Total', 'under', lineToken(row.total)),
        snapId, meta, book, row.underOdds,
      );
    }
  }
}

function isLineSnapFile(parentName, name) {
  if (name.includes('omega-line-snap-')) return true;
  if (name === 'omega-line-path' || name.startsWith('omega-line-path')) return true;
  if (parentName === 'omega-line-path' && /^\d{4}-\d{2}-\d{2}$/.test(name)) return true;
  return false;
}

function loadLineSnaps(index) {
  let files = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isLineSnapFile(path.basename(dir), entry.name)) continue;
      const doc = readJson(full, 8 * 1024 * 1024);
      if (!doc || typeof doc !== 'object') continue;
      files += 1;
      const polls = Array.isArray(doc.polls) ? doc.polls : [doc];
      const fileDate = (typeof doc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.date))
        ? doc.date
        : dateInPath(full);
      for (const poll of polls) {
        if (!poll || !poll.games || typeof poll.games !== 'object') continue;
        const slate = (typeof poll.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(poll.date))
          ? poll.date
          : fileDate;
        const hhmm = poll.hhmm || poll.slot || 'snap';
        const meta = {
          source: `line-snap-${String(hhmm).padStart(4, '0')}`,
          family: 'line-snap',
          at: poll.capturedAt || null,
        };
        for (const [gameKeyStr, game] of Object.entries(poll.games)) {
          addGame(index, slate, gameKeyStr, game, meta);
        }
      }
    }
  }
  for (const root of LINE_SNAP_ROOTS) {
    if (root && fs.existsSync(root)) walk(root);
  }
  return files;
}

async function readMaster(key) {
  const file = path.join(MASTER_ROOT, String(key).split('/').join('__'));
  return readJson(file, 8 * 1024 * 1024);
}

async function loadMaster(index, dates) {
  let boards = 0;
  if (!fs.existsSync(MASTER_ROOT)) return boards;
  for (const date of dates) {
    const board = await loadMasterBoard(date, readMaster);
    if (!board) continue;
    boards += 1;
    const slots = [
      ['games1000', 'odds-master-1000', board.at1000],
      ['games0300', 'odds-master-0300', board.at0300],
    ];
    for (const [field, source, at] of slots) {
      const games = board[field] || {};
      const meta = { source, family: 'odds-master', at: at || null };
      for (const [gameKeyStr, game] of Object.entries(games)) {
        addGame(index, date, gameKeyStr, game, meta);
      }
    }
  }
  return boards;
}

function loadCards(index) {
  let files = 0;
  if (!fs.existsSync(CARD_DIR)) return files;
  for (const name of fs.readdirSync(CARD_DIR)) {
    if (!/^card-\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const doc = readJson(path.join(CARD_DIR, name), 8 * 1024 * 1024);
    if (!doc || typeof doc !== 'object') continue;
    files += 1;
    const slate = name.slice(5, 15);
    const meta = {
      source: `stakeaudit-${name}`,
      family: 'stakeaudit',
      at: doc.generatedAt || null,
    };
    const snapId = `${slate}|stakeaudit|${name}`;
    const legs = [...(doc.picks || [])];
    for (const ticket of doc.parlayLegs || []) {
      for (const leg of ticket.legs || []) legs.push(leg);
    }
    for (const leg of legs) {
      const book = canonBook(leg && leg.book);
      const american = parseAmerican(leg && leg.odds);
      if (!book || american == null) continue;
      const key = rowQuoteKey(slate, leg);
      index.add(key, snapId, meta, book, american);
    }
  }
  return files;
}

function loadUrgent(index) {
  let files = 0;
  if (!fs.existsSync(URGENT_DIR)) return files;
  for (const name of fs.readdirSync(URGENT_DIR)) {
    if (!name.endsWith('.json')) continue;
    const doc = readJson(path.join(URGENT_DIR, name), 8 * 1024 * 1024);
    if (!doc || typeof doc !== 'object') continue;
    const events = Array.isArray(doc) ? doc : (doc.data || doc.events || null);
    if (!Array.isArray(events) || !events.length || !events[0] || !events[0].bookmakers) continue;
    files += 1;
    events.forEach((event, i) => {
      if (!event || !event.home_team || !event.away_team) return;
      const slate = etDate(event.commence_time);
      let game;
      try { game = extractGameBooks(event); } catch (_) { game = null; }
      if (!game) return;
      const matchup = teamsKey(event.away_team, event.home_team);
      addGame(index, slate, matchup, game, {
        source: `urgent1103-${name}`,
        family: 'urgent',
        at: event.commence_time || null,
        eventIndex: i,
      });
    });
  }
  return files;
}

function bestPrice(bucket) {
  let best = null;
  const books = [];
  for (const [book, row] of bucket.prices) {
    if (!row || row.conflict) continue;
    if (!canonBook(book)) continue;
    books.push(book);
    if (!best || row.american > best.american) best = { book, american: row.american };
  }
  if (!best) return null;
  return { book: best.book, american: best.american, also: books };
}

function closestSnap(rows, pickTs) {
  const target = Date.parse(pickTs || '');
  const stamped = rows
    .map((row) => ({ row, at: Date.parse(row.bucket.at || '') }))
    .filter((row) => Number.isFinite(row.at));
  if (Number.isFinite(target)) {
    const before = stamped.filter((row) => row.at <= target);
    if (before.length) {
      before.sort((a, b) => b.at - a.at);
      return before[0].row;
    }
    if (stamped.length) {
      stamped.sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target) || a.at - b.at);
      return stamped[0].row;
    }
  }
  if (stamped.length) {
    stamped.sort((a, b) => a.at - b.at);
    return stamped[0].row;
  }
  return rows[0];
}

function pointOf(key) {
  const line = String(key).split('|').pop();
  if (line === 'ml') return null;
  const n = Number(line);
  return Number.isFinite(n) ? n : null;
}

function chooseQuote(buckets, pickTs, key) {
  const ready = [];
  for (const bucket of buckets.values()) {
    const best = bestPrice(bucket);
    if (best) ready.push({ bucket, best });
  }
  if (!ready.length) return null;
  const family = (name) => ready.filter((row) => row.bucket.family === name);
  let picked = null;
  const cards = family('stakeaudit');
  if (cards.length) picked = cards[0];
  if (!picked) {
    const board = ready.filter((row) => row.bucket.source === 'odds-master-1000');
    if (board.length) picked = board[0];
  }
  if (!picked) {
    const snaps = family('line-snap');
    if (snaps.length) picked = closestSnap(snaps, pickTs);
  }
  if (!picked) {
    const open = ready.filter((row) => row.bucket.source === 'odds-master-0300');
    if (open.length) picked = open[0];
  }
  if (!picked) {
    const urgent = family('urgent');
    if (urgent.length) picked = urgent[0];
  }
  if (!picked) return null;
  const point = pointOf(key);
  return {
    american: picked.best.american,
    book: picked.best.book,
    point,
    source: picked.bucket.source,
    family: picked.bucket.family,
    at: picked.bucket.at || null,
    books: picked.best.also,
  };
}

function sourceBucket(quote) {
  if (!quote) return null;
  if (quote.family === 'line-snap') return 'line-snap';
  if (quote.family === 'stakeaudit') return 'stakeaudit';
  if (quote.family === 'urgent') return 'urgent1103';
  if (quote.source === 'odds-master-1000' || quote.source === 'odds-master-0300') return quote.source;
  return quote.family || quote.source;
}

async function joinStoredDkHr(derived) {
  const days = derived && Array.isArray(derived.days) ? derived.days : [];
  const dates = days.map((day) => day.date).filter(Boolean);
  const index = createIndex();
  const searched = {
    lineSnapFiles: loadLineSnaps(index),
    oddsMasterBoards: await loadMaster(index, dates),
    cardFiles: loadCards(index),
    urgentFiles: loadUrgent(index),
  };
  const quotes = new Map();
  const bySource = {};
  let storedRows = 0;
  let quotedStoredRows = 0;
  let candidateRows = 0;
  let quotedRows = 0;
  const unquotedDates = [];
  const examples = [];
  for (const day of days) {
    const pool = dayPool(day);
    candidateRows += pool.length;
    let dayQuoted = 0;
    for (const row of pool) {
      const key = rowQuoteKey(day.date, row);
      const buckets = key ? index.map.get(key) : null;
      const quote = buckets ? chooseQuote(buckets, row.pickTs, key) : null;
      if (!quote) continue;
      quotes.set(`${day.date}|${poolKey(row)}`, quote);
      dayQuoted += 1;
      quotedRows += 1;
      const bucket = sourceBucket(quote);
      bySource[bucket] = (bySource[bucket] || 0) + 1;
      if (examples.length < 5) {
        examples.push({
          date: day.date,
          pick: row.pick,
          matchup: row.matchup,
          book: quote.book,
          american: quote.american,
          line: quote.point,
          source: quote.source,
        });
      }
    }
    if (pool.length && !dayQuoted) unquotedDates.push(day.date);
    for (const row of dayRows(day)) {
      storedRows += 1;
      if (quotes.has(`${day.date}|${poolKey(row)}`)) quotedStoredRows += 1;
    }
  }
  const sufficient = candidateRows > 0 && quotedRows === candidateRows;
  const status = quotedRows === 0 ? 'no stored DK/HR quotes' : (sufficient ? 'full' : 'insufficient');
  return {
    quotes,
    summary: {
      candidateRows,
      quotedRows,
      storedRows,
      quotedStoredRows,
      bySource,
      unquotedDates,
      examples,
      conflicts: index.conflictCount(),
      searched,
      sufficient,
      status,
      realQuotes: true,
      primaryReplay: sufficient ? null : 'tools/omega-v2/replay-bp1104.js',
    },
  };
}

module.exports = {
  joinStoredDkHr,
  canonBook,
  rowQuoteKey,
};
