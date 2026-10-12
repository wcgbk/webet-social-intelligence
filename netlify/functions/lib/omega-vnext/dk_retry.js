'use strict';

/**
 * At the 10:30 lock, a game whose DraftKings spread or total is missing
 * is retried on the live one-event odds endpoint every 2 minutes for up
 * to 10 minutes. If the line is still missing, that game is priced from
 * its moneyline only. The caller runs this only when the lock snapshot
 * is the board being priced.
 *
 * OMEGA_DK_RETRY=0 leaves the snapshot alone. dryRun and replay do not
 * retry unless OMEGA_DK_RETRY_TEST=1. =0 wins over the test flag.
 */

const { ODDS_SPORT_KEYS } = require('./config');
const { currentAudit } = require('./audit_log');

const WINDOW_MS = 10 * 60 * 1000;
const INTERVAL_MS = 2 * 60 * 1000;
const REGIONS = 'us,us2,eu';
const MARKETS = 'h2h,spreads,totals';

function retriesEnabled(opts) {
  if (String(process.env.OMEGA_DK_RETRY || '') === '0') return false;
  if (opts && (opts.dryRun || opts.replay)) return String(process.env.OMEGA_DK_RETRY_TEST || '') === '1';
  return true;
}

function bookmakersOf(event) {
  return event && Array.isArray(event.bookmakers) ? event.bookmakers : [];
}

function dkBook(event) {
  return bookmakersOf(event).find((b) => b && (b.key === 'draftkings' || b.title === 'DraftKings')) || null;
}

function marketOf(book, key) {
  return ((book && book.markets) || []).find((m) => m && m.key === key) || null;
}

function usableLine(market) {
  return ((market && market.outcomes) || []).some((o) => {
    const point = Number(o && o.point);
    const price = Number(o && (o.price != null ? o.price : o.american));
    return Number.isFinite(point) && Number.isFinite(price);
  });
}

function needsDkRetry(event) {
  const dk = dkBook(event);
  if (!dk) return true;
  return !usableLine(marketOf(dk, 'spreads')) || !usableLine(marketOf(dk, 'totals'));
}

function missingLabel(event) {
  const dk = dkBook(event);
  const parts = [];
  if (!dk || !usableLine(marketOf(dk, 'spreads'))) parts.push('spread');
  if (!dk || !usableLine(marketOf(dk, 'totals'))) parts.push('total');
  return parts.join('+') || 'none';
}

function eventBody(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) return payload[0] || null;
  if (Array.isArray(payload.bookmakers)) return payload;
  const data = payload.data;
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === 'object') return data;
  return null;
}

function cloneEvent(event) {
  return {
    ...event,
    bookmakers: bookmakersOf(event).map((b) => ({
      ...b,
      markets: (b.markets || []).map((m) => ({
        ...m,
        outcomes: Array.isArray(m.outcomes) ? m.outcomes.slice() : [],
      })),
    })),
  };
}

function mergeDkMarkets(event, live) {
  const body = eventBody(live);
  const liveDk = body ? dkBook(body) : null;
  if (!liveDk) return event;
  const next = cloneEvent(event);
  let dk = dkBook(next);
  if (!dk) {
    dk = { key: 'draftkings', title: 'DraftKings', markets: [] };
    next.bookmakers = next.bookmakers.concat(dk);
  }
  for (const key of ['spreads', 'totals']) {
    const incoming = marketOf(liveDk, key);
    if (!usableLine(incoming)) continue;
    dk.markets = (dk.markets || []).filter((m) => !m || m.key !== key).concat(incoming);
  }
  return next;
}

function stripToMoneyline(event) {
  const next = cloneEvent(event);
  next.bookmakers = next.bookmakers.map((b) => ({
    ...b,
    markets: (b.markets || []).filter((m) => m && m.key !== 'spreads' && m.key !== 'totals'),
  }));
  return next;
}

function eventOddsUrl(sportKey, eventId, apiKey) {
  const id = encodeURIComponent(eventId);
  const base = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${id}/odds?regions=${REGIONS}&markets=${MARKETS}&oddsFormat=american&bookmakers=draftkings`;
  if (!apiKey) return base;
  return `${base}&apiKey=${encodeURIComponent(apiKey)}`;
}

function writeAudit(opts, row) {
  if (opts && typeof opts.log === 'function') {
    opts.log(row);
    return;
  }
  const audit = currentAudit();
  if (audit && typeof audit.record === 'function') audit.record(row);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultFetchJson(url) {
  const { cachedFetch } = require('./odds_snapshot_cache');
  const res = await cachedFetch(fetch, url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!res.ok) {
    const err = new Error(`dk-retry HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function retryEvent(event, sportKey, opts) {
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const sleep = opts.sleep || defaultSleep;
  const apiKey = opts.apiKey || '';
  let current = event;
  if (!apiKey) {
    writeAudit(opts, {
      kind: 'http',
      provider: 'odds-api',
      method: 'GET',
      url: eventOddsUrl(sportKey, event.id, ''),
      status: null,
      ok: false,
      error: null,
      note: `dk-retry skipped no api key ${sportKey} ${event.id} missing=${missingLabel(current)}`,
    });
    return stripToMoneyline(current);
  }
  let elapsed = 0;
  while (elapsed <= WINDOW_MS) {
    const url = eventOddsUrl(sportKey, event.id, apiKey);
    const started = Date.now();
    let status = null;
    let ok = false;
    let error = null;
    let body = null;
    try {
      body = await fetchJson(url);
      status = 200;
      ok = true;
    } catch (e) {
      status = e && e.status != null ? Number(e.status) : null;
      error = (e && e.message) || 'dk-retry fetch failed';
      ok = false;
    }
    writeAudit(opts, {
      kind: 'http',
      provider: 'odds-api',
      method: 'GET',
      url,
      status: Number.isFinite(status) ? status : null,
      ms: Date.now() - started,
      ok,
      error,
      note: `dk-retry ${sportKey} ${event.id} elapsedMin=${elapsed / 60000} missing=${missingLabel(current)}`,
    });
    if (ok && body) current = mergeDkMarkets(current, body);
    if (!needsDkRetry(current)) return current;
    if (elapsed + INTERVAL_MS > WINDOW_MS) break;
    await sleep(INTERVAL_MS);
    elapsed += INTERVAL_MS;
  }
  return stripToMoneyline(current);
}

async function retryMissingDraftKings(oddsBySport, opts = {}) {
  const bag = oddsBySport && typeof oddsBySport === 'object' ? oddsBySport : {};
  if (!retriesEnabled(opts)) return bag;
  const out = { ...bag };
  for (const label of Object.keys(bag)) {
    const sportKey = ODDS_SPORT_KEYS[label];
    const events = bag[label];
    if (!sportKey || !Array.isArray(events)) continue;
    const next = [];
    for (const event of events) {
      if (!event || !needsDkRetry(event)) {
        next.push(event);
        continue;
      }
      if (event.id == null || event.id === '') {
        writeAudit(opts, {
          kind: 'http',
          provider: 'odds-api',
          method: 'GET',
          url: 'https://api.the-odds-api.com/v4/sports/events/odds',
          status: null,
          ok: false,
          error: null,
          note: `dk-retry skipped no event id ${label} missing=${missingLabel(event)}`,
        });
        next.push(stripToMoneyline(event));
        continue;
      }
      next.push(await retryEvent(event, sportKey, opts));
    }
    out[label] = next;
  }
  return out;
}

module.exports = {
  retryMissingDraftKings,
  needsDkRetry,
  retriesEnabled,
  WINDOW_MS,
  INTERVAL_MS,
};
