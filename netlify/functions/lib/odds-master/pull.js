'use strict';
/** The scheduled Odds API board pulls (Ben, 2026-10-18: 3am and 10am only).
 *  Closing lines are not a third schedule. When OMEGA_CLOSES_AT_3AM is on
 *  (default), capture-odds-3am fires capture-closes-3am-background, which
 *  writes closes from the last saved board in this store (10 AM, else 3 AM).
 *  That step spends zero Odds API credits.
 *  OMEGA_CLOSES_HISTORICAL=on restores a paid historical-close path.
 *  Slot 0300 = baseline/opening read; slot 1000 = board/decision read.
 *  One request per sport per pull: regions us,us2,eu, markets
 *  h2h,spreads,totals, American odds — the API returns every book in
 *  those regions, and EVERY book/market/outcome is stored (per-book
 *  price blobs + the raw event), so no slice is dropped at write time.
 *  Expected cost by the Odds API credit formula (markets x regions per
 *  request): 3 x 3 = 9 credits per sport, 6 sports = ~54 credits per
 *  pull, ~108/day. NCAAM (basketball_ncaab) is already in SPORTS, so the
 *  NCAAM projector adds 0 credits. One extra sport would be 9 per pull,
 *  18 per day. Stated, not measured — no live pull was fired to
 *  write this code. Games stored are the pull date's ET slate. */
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');
const { pullSlotLockEnabled, pullBookPricesEnabled, pullCreditsPersistEnabled, pullResumeEnabled } = require('../default_on_flag');
const { guardPullSlot, releaseHeldLock, pullLockKey, fresh } = require('../slot-lock');
const { upsertPulledBookPrices } = require('./book-prices');
const { persistPullCredits, headerNumber } = require('./credits');

/** Scheduler retry spacing. A younger lock still belongs to a live writer. */
const RESUME_STALE_MS = 15 * 1000;
const SPORTS = [
  ['NFL', 'americanfootball_nfl'], ['NCAAF', 'americanfootball_ncaaf'],
  ['NHL', 'icehockey_nhl'], ['NBA', 'basketball_nba'],
  ['NCAAM', 'basketball_ncaab'], ['MLB', 'baseball_mlb'],
];
const REGIONS = 'us,us2,eu';
const MARKETS = 'h2h,spreads,totals';
function etDateISO(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function isSameEtDay(iso, dateISO) {
  if (!iso) return false;
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === dateISO; } catch (_) { return false; }
}
function sidesFor(market, outcomes, home, away) {
  const sides = {};
  for (const o of outcomes || []) {
    const rec = { price: Number(o.price) };
    if (o.point != null) rec.line = Number(o.point);
    if (market === 'totals') {
      if (/^over$/i.test(o.name)) sides.over = rec;
      else if (/^under$/i.test(o.name)) sides.under = rec;
    } else if (o.name === home) sides.home = rec;
    else if (o.name === away) sides.away = rec;
  }
  return sides;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
/** Pure transform (testable, no network): Odds API events -> write ops. */
function planWrites(eventsBySport, slot, at, dateISO) {
  const writes = []; const events = []; const summary = { sports: {}, books: new Set(), games: 0 };
  for (const [label, evs] of Object.entries(eventsBySport || {})) {
    summary.sports[label] = 0;
    for (const ev of evs || []) {
      if (!ev || !ev.id || !ev.home_team || !ev.away_team) continue;
      if (!isSameEtDay(ev.commence_time, dateISO)) continue;
      summary.games++; summary.sports[label]++;
      events.push({ sport: label, eventId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time || null });
      const books = [];
      for (const bk of ev.bookmakers || []) {
        if (!bk || !bk.key) continue;
        books.push(bk.key); summary.books.add(bk.key);
        for (const m of bk.markets || []) {
          if (!MARKETS.split(',').includes(m.key)) continue;
          writes.push({ key: `${label}/${ev.id}/${bk.key}/${m.key}/${at}`,
            data: { sport: label, eventId: ev.id, book: bk.key, market: m.key, at, sides: sidesFor(m.key, m.outcomes, ev.home_team, ev.away_team) } });
        }
      }
      writes.push({ key: `${label}/${ev.id}/raw/${at}`, data: ev });
      writes.push({ key: `index/${label}/${ev.id}`, merge: { sport: label, eventId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time || null, books, slot, at } });
    }
  }
  summary.books = [...summary.books];
  return { writes, events, summary };
}

function checkpointKey(dateISO, slot) {
  return `pulls/${dateISO}/${slot}/checkpoint`;
}

function fetchedSportKey(dateISO, slot, label) {
  return `pulls/${dateISO}/${slot}/fetched/${label}`;
}

/** A pull doc with `at` is finished. phase fetched/partial is not. A missing phase stays finished. */
function pullDocComplete(doc) {
  if (!doc || !doc.at) return false;
  return doc.phase !== 'fetched' && doc.phase !== 'partial';
}

function snapshotCredits(creditResponses) {
  const out = [];
  for (const row of creditResponses || []) {
    const remaining = headerNumber(row && row.resp, 'x-requests-remaining');
    if (remaining == null) continue;
    out.push({
      sport: row.sport || null,
      remaining,
      used: headerNumber(row && row.resp, 'x-requests-used'),
    });
  }
  return out;
}

function responsesFromSnapshot(credits) {
  return (credits || []).map((row) => ({
    sport: row && row.sport,
    resp: {
      headers: {
        get(name) {
          const key = String(name || '').toLowerCase();
          if (key === 'x-requests-remaining' && row.remaining != null) return String(row.remaining);
          if (key === 'x-requests-used' && row.used != null) return String(row.used);
          return null;
        },
      },
    },
  }));
}

/**
 * Take a lock that is missing or older than the resume gap.
 * acquireBlobLock's 20 minute TTL would keep a killed writer in place.
 */
async function stealStaleLock({ read, write, key, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const current = await read(key);
  if (fresh(current, nowMs, RESUME_STALE_MS)) {
    return { ok: false, reason: 'held', holder: current && current.holder };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const acquiredAt = new Date(nowMs).toISOString();
  await write(key, { holder: id, acquiredAt, ttlMs: 20 * 60 * 1000 });
  const seen = await read(key);
  if (!seen || seen.holder !== id) return { ok: false, reason: 'held', holder: seen && seen.holder };
  return { ok: true, holder: id, key, acquiredAt };
}

/** Index, price, by-date, pull doc, book prices, credits. `at` is the fetch time, not the resume time. */
async function writePulledBoard({ read, write, env, dateISO, slot, at, eventsBySport, errors, creditResponses, fetchImpl }) {
  const { writes, events, summary } = planWrites(eventsBySport, slot, at, dateISO);
  await mapLimit(writes.filter(w => w.merge), 8, async (w) => {
    const prev = (await read(w.key)) || {};
    const next = { ...prev, sport: w.merge.sport, eventId: w.merge.eventId, homeTeam: w.merge.homeTeam, awayTeam: w.merge.awayTeam, commenceTime: w.merge.commenceTime,
      books: [...new Set([...(prev.books || []), ...w.merge.books])] };
    if (slot === '0300') next.baseline0300 = { at };
    else next.checks = { ...(prev.checks || {}), '1000': { at } };
    await write(w.key, next);
  });
  await mapLimit(writes.filter(w => !w.merge), 8, async (w) => { await write(w.key, w.data); });
  const prevDate = (await read(`by-date/${dateISO}`)) || { date: dateISO, events: [] };
  const byId = new Map((prevDate.events || []).map(e => [String(e.eventId), e]));
  for (const e of events) byId.set(String(e.eventId), e);
  await write(`by-date/${dateISO}`, { date: dateISO, events: [...byId.values()], updatedAt: at });
  const pullDoc = {
    date: dateISO, slot, at, phase: 'complete',
    games: summary.games, sports: summary.sports, books: summary.books, errors,
  };
  await write(`pulls/${dateISO}/${slot}`, pullDoc);
  if (pullBookPricesEnabled(env)) {
    try {
      pullDoc.bookPrices = await upsertPulledBookPrices({
        dateISO, slot, at, eventsBySport, env, fetchImpl,
      });
    } catch (e) {
      errors.push(`book-prices: ${String(e && e.message || e).slice(0, 200)}`);
      pullDoc.errors = errors;
    }
    try { await write(`pulls/${dateISO}/${slot}`, pullDoc); } catch (_) { /* blob already has the board */ }
  }
  if (pullCreditsPersistEnabled(env)) {
    try {
      const credits = await persistPullCredits({
        dateISO, slot, at, responses: creditResponses, env, read, write,
      });
      if (credits && credits.wrote) {
        pullDoc.credits = { remaining: credits.remaining, calls: credits.calls };
        try { await write(`pulls/${dateISO}/${slot}`, pullDoc); } catch (_) { /* board blob is already stored */ }
      }
    } catch (e) {
      errors.push(`credits: ${String(e && e.message || e).slice(0, 200)}`);
      pullDoc.errors = errors;
      try { await write(`pulls/${dateISO}/${slot}`, pullDoc); } catch (_) { /* board blob is already stored */ }
    }
  }
  return pullDoc;
}

/**
 * A checkpoint means the Odds API call already happened.
 * Returns a pull doc, a resumable skip, or null when there is nothing to finish.
 * Null lets the caller fetch. This function does not fetch.
 */
async function resumeFetchedSlot({ read, write, env, dateISO, slot, now, fetchImpl }) {
  let checkpoint = null;
  try { checkpoint = await read(checkpointKey(dateISO, slot)); } catch (_) { return null; }
  if (!checkpoint || checkpoint.phase !== 'fetched' || !checkpoint.at) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let held = null;
  if (pullSlotLockEnabled(env)) {
    const lockKey = pullLockKey(dateISO, slot);
    let lockDoc = null;
    try { lockDoc = await read(lockKey); } catch (_) { lockDoc = null; }
    if (fresh(lockDoc, nowMs, RESUME_STALE_MS)) {
      return { skipped: 'slot-locked', resumable: true, date: dateISO, slot };
    }
    const stolen = await stealStaleLock({ read, write, key: lockKey, now });
    if (!stolen.ok) return { skipped: 'slot-locked', resumable: true, date: dateISO, slot };
    held = stolen;
  }
  try {
    const errors = Array.isArray(checkpoint.errors) ? checkpoint.errors.slice() : [];
    const labels = Array.isArray(checkpoint.sports) && checkpoint.sports.length
      ? checkpoint.sports
      : SPORTS.map((row) => row[0]);
    const eventsBySport = {};
    for (const label of labels) {
      const payload = await read(fetchedSportKey(dateISO, slot, label));
      if (!Array.isArray(payload)) errors.push(`resume-missing:${label}`);
      eventsBySport[label] = Array.isArray(payload) ? payload : [];
    }
    return await writePulledBoard({
      read, write, env, dateISO, slot, at: checkpoint.at,
      eventsBySport, errors, creditResponses: responsesFromSnapshot(checkpoint.credits), fetchImpl,
    });
  } catch (err) {
    if (held) await releaseHeldLock({ read, write, key: held.key, holder: held.holder });
    throw err;
  }
}

async function runOddsMasterPull(opts = {}) {
  const slot = String(opts.slot || '');
  if (!['0300', '1000'].includes(slot)) throw new Error(`odds-master pull: slot must be 0300 or 1000, got ${slot}`);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateISO = opts.dateISO || etDateISO(now);
  const env = opts.env || process.env;
  const read = opts.read || readJson;
  const write = opts.write || writeJson;
  // Before any Odds API request. A scheduler retry (~15s, up to 3) that
  // arrives while this slot is in progress or already written is a no-op.
  // A thrown run releases the lock so that retry is not skipped as slot-locked.
  const fetchImpl = opts.fetchImpl || fetch;
  let held = null;
  // A throw on the pull-doc read fails open: pull, and do not take the lock.
  // That matches guardPullSlot. The next read in this run must not become the lock.
  let skipLock = false;
  if (pullSlotLockEnabled(env) && !opts.force) {
    let existing = null;
    try {
      existing = await read(`pulls/${dateISO}/${slot}`);
    } catch (err) {
      skipLock = true;
      console.error(`[odds-master] slot lock read failed open: ${err && err.message ? err.message : err}`);
    }
    if (!skipLock && pullDocComplete(existing)) return { skipped: 'slot-done', date: dateISO, slot };
    if (!skipLock && pullResumeEnabled(env)) {
      const resumed = await resumeFetchedSlot({ read, write, env, dateISO, slot, now, fetchImpl });
      if (resumed) return resumed;
    }
  }
  if (!skipLock && pullSlotLockEnabled(env)) {
    const skip = await guardPullSlot({
      enabled: true,
      force: !!opts.force,
      read,
      write,
      dateISO,
      slot,
      now,
      store: opts.lockStore,
    });
    if (skip && skip.skipped) return skip;
    if (skip && skip.holder) held = skip;
  }
  try {
    const at = now.toISOString();
    const apiKey = opts.apiKey || (env && env.ODDS_API_KEY) || process.env.ODDS_API_KEY;
    if (!apiKey) throw new Error('ODDS_API_KEY missing');
    const eventsBySport = {};
    const errors = [];
    const creditResponses = [];
    for (const [label, key] of SPORTS) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${key}/odds?regions=${REGIONS}&markets=${MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
        const resp = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        if (!resp.ok) throw new Error(`Odds ${key} HTTP ${resp.status}`);
        creditResponses.push({ sport: label, resp });
        eventsBySport[label] = await resp.json();
      } catch (e) { errors.push(`${label}: ${e.message}`); eventsBySport[label] = []; }
    }
    // Before the per-key fanout. A kill after this can finish without another Odds API call.
    if (pullResumeEnabled(env)) {
      const sports = [];
      for (const [label] of SPORTS) {
        await write(fetchedSportKey(dateISO, slot, label), eventsBySport[label] || []);
        sports.push(label);
      }
      await write(checkpointKey(dateISO, slot), {
        phase: 'fetched', at, date: dateISO, slot, sports,
        errors: errors.slice(), credits: snapshotCredits(creditResponses),
      });
    }
    return await writePulledBoard({
      read, write, env, dateISO, slot, at, eventsBySport, errors, creditResponses, fetchImpl,
    });
  } catch (err) {
    if (held) await releaseHeldLock({ read, write, key: held.key, holder: held.holder });
    throw err;
  }
}
module.exports = { runOddsMasterPull, planWrites, sidesFor, SPORTS, REGIONS, MARKETS, pullDocComplete, RESUME_STALE_MS };
