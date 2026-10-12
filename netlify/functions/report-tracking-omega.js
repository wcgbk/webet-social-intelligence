'use strict';

/**
 * report-tracking-omega — daily Edge and Omega progress table.
 *
 * Schedule (netlify.toml): "15 13,14 * * *"
 *   13:15 UTC = 9:15am ET (EDT). 14:15 UTC = 9:15am ET (EST).
 *   etGuard keeps 09:15 ET only, after closes and finals, before the
 *   10:30 selection.
 *
 * One row per day. Three tracks, each for Edge (all versions) and Omega:
 *   engineering percentiles carried forward from data/engineering-scores.json
 *   track-record KPIs from get-results-omega (aggregateDays / the results cache)
 *   closing-line totals from the CLV ledger
 *
 * Writes only omega-tracking/{date} and omega-tracking/index.
 * Display only. Does not change a price, a probability, a stake, or a pick.
 * OMEGA_REPLAY_NO_WRITE=1 or ?dryRun=1 returns the table and writes nothing.
 * GET returns omega-tracking/index and does not recompute.
 */

const store = require('./lib/omega-vnext/store');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { cacheIsFresh, resultHasPending } = require('./lib/kpi-cache');
const ledger = require('./lib/clv-ledger');
const tracking = require('./lib/tracking-report');
const clvJob = require('./report-clv-omega');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SCORES = require('../../data/engineering-scores.json');

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function truthy(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
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

function wantsDryRun(event) {
  const qs = (event && event.queryStringParameters) || {};
  if (truthy(qs.dryRun) || truthy(qs.dryrun)) return true;
  const body = readBody(event);
  return !!(body && (truthy(body.dryRun) || truthy(body.dryrun)));
}

function asOfFrom(event, now) {
  const qs = (event && event.queryStringParameters) || {};
  const body = readBody(event);
  return qs.date || body.date || ledger.etYmd(now);
}

function loadScoreEntries() {
  return Array.isArray(SCORES.entries) ? SCORES.entries : [];
}

async function readResultsCacheDefault() {
  return store.readJson(tracking.RESULTS_CACHE_KEY);
}

async function invokeResultsDefault() {
  const results = require('./get-results-omega');
  const res = await results.handler({
    httpMethod: 'GET',
    queryStringParameters: { range: 'all', refresh: '1' },
  });
  let body = {};
  try {
    body = JSON.parse((res && res.body) || '{}');
  } catch (_) {
    body = {};
  }
  if (!res || res.statusCode >= 400 || body.error) {
    throw new Error(body.message || 'get-results-omega failed');
  }
  return body;
}

function resultsUsable(doc) {
  return !!(doc && doc.cumulative && doc.straight && doc.omegaOnly);
}

/**
 * Prefer a settled get-results-omega cache (kpi-cache). A cache that still
 * has a pending pick is used only while it is fresh. Otherwise call the
 * existing results handler, which grades with the same functions the
 * track-record page uses.
 */
async function loadResultsDocument(src, event) {
  if (src && src.results) return src.results;
  const readCache = (src && src.readResultsCache) || readResultsCacheDefault;
  const invoke = (src && src.invokeResults) || invokeResultsDefault;
  let cached = null;
  try {
    cached = await readCache();
  } catch (e) {
    console.error(`[report-tracking-omega] results cache: ${e.message}`);
    cached = null;
  }
  const probe = { queryStringParameters: (event && event.queryStringParameters) || {} };
  if (resultsUsable(cached)) {
    const settled = !resultHasPending(cached);
    if (settled || cacheIsFresh(cached, probe)) return cached;
  }
  try {
    const fresh = await invoke();
    if (resultsUsable(fresh)) return fresh;
  } catch (e) {
    console.error(`[report-tracking-omega] results refresh: ${e.message}`);
    if (resultsUsable(cached)) return cached;
    throw e;
  }
  if (resultsUsable(cached)) return cached;
  throw new Error('track record unavailable');
}

async function loadClvReport(asOf, now, src) {
  if (src && src.clvReport) return src.clvReport;
  const result = await clvJob.runClvReport({
    asOf,
    now,
    readJson: src && src.readJson,
    env: (src && src.env) || process.env,
    dryRun: true,
    seedRows: src && src.seedRows,
    lookbackDays: src && src.lookbackDays,
  });
  return result.report;
}

async function readPreviousRows(read) {
  let index = null;
  try {
    index = await read(tracking.INDEX_KEY);
  } catch (e) {
    console.error(`[report-tracking-omega] index read: ${e.message}`);
    return [];
  }
  if (!index || !Array.isArray(index.rows)) return [];
  return index.rows;
}

async function runTrackingReport(opts) {
  const src = opts || {};
  const asOf = src.asOf;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw new Error(`tracking report refused bad date: ${asOf}`);
  }
  const now = src.now instanceof Date ? src.now : new Date();
  const generatedAt = now.toISOString();
  const updatedAtEt = ledger.formatUpdatedAtEt(generatedAt);
  const entries = Array.isArray(src.entries) ? src.entries : loadScoreEntries();
  const results = await loadResultsDocument(src, src.event);
  const clvReport = await loadClvReport(asOf, now, src);
  const read = src.readJson || ((key) => store.readJson(key));
  const previousRows = Array.isArray(src.previousRows)
    ? src.previousRows
    : await readPreviousRows(read);
  const row = tracking.buildDayRow({
    date: asOf,
    entries,
    results,
    clvReport,
  });
  const index = tracking.buildIndex({
    row,
    previousRows,
    generatedAt,
    updatedAtEt,
  });
  index.source = 'report';
  const dayDoc = tracking.dayDocument(index, asOf);
  const dryRun = !!src.dryRun;
  const env = src.env || process.env;
  const blocked = dryRun || replayNoWrite(env);
  if (blocked) {
    return {
      index,
      day: dayDoc,
      wrote: false,
      keys: [],
      reason: dryRun ? 'dry-run' : 'no-write',
    };
  }
  const write = src.writeJson || ((key, data) => store.storeJson(key, data));
  const keys = [tracking.dayKey(asOf), tracking.INDEX_KEY];
  try {
    await write(keys[0], dayDoc);
    await write(keys[1], index);
  } catch (e) {
    console.error(`[report-tracking-omega] write failed: ${e.message}`);
    return { index, day: dayDoc, wrote: false, keys: [], reason: 'write-failed', error: e.message };
  }
  return { index, day: dayDoc, wrote: true, keys, reason: null };
}

function envelope(result) {
  return {
    ...result.index,
    ok: true,
    wrote: result.wrote,
    keys: result.keys,
    reason: result.reason,
    error: result.error || null,
  };
}

async function handle(event, now, deps) {
  const when = now instanceof Date ? now : new Date();
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: JSON_HEADERS, body: '' };
  }
  const etSkip = rejectUnlessEtSlot('report-tracking-omega', event, when);
  if (etSkip) return etSkip;

  const method = String((event && event.httpMethod) || 'POST').toUpperCase();
  const dryRun = wantsDryRun(event);
  const readJson = deps && deps.readJson;
  const writeJson = deps && deps.writeJson;
  const env = (deps && deps.env) || process.env;

  if (method === 'GET' && !dryRun) {
    const read = readJson || ((key) => store.readJson(key));
    let latest = null;
    try {
      latest = await read(tracking.INDEX_KEY);
    } catch (e) {
      console.error(`[report-tracking-omega] index read: ${e.message}`);
    }
    if (!tracking.isIndex(latest)) {
      return json(200, {
        ok: false,
        missing: true,
        observerOnly: true,
        applied: false,
        displayOnly: true,
        wrote: false,
      });
    }
    return json(200, latest);
  }

  const asOf = asOfFrom(event, when);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    return json(400, { ok: false, error: 'bad date', observerOnly: true, applied: false, wrote: false });
  }
  try {
    const result = await runTrackingReport({
      asOf,
      now: when,
      event,
      readJson,
      writeJson,
      env,
      dryRun,
      entries: deps && deps.entries,
      results: deps && deps.results,
      clvReport: deps && deps.clvReport,
      previousRows: deps && deps.previousRows,
      readResultsCache: deps && deps.readResultsCache,
      invokeResults: deps && deps.invokeResults,
      seedRows: deps && deps.seedRows,
      lookbackDays: deps && deps.lookbackDays,
    });
    return json(200, envelope(result));
  } catch (e) {
    console.error(`[report-tracking-omega] failed: ${e.message}`);
    return json(500, {
      ok: false,
      error: e.message,
      observerOnly: true,
      applied: false,
      displayOnly: true,
      wrote: false,
    });
  }
}

exports.handler = (event) => handle(event, new Date(), null);
exports.handle = handle;
exports.runTrackingReport = runTrackingReport;
exports.loadResultsDocument = loadResultsDocument;
