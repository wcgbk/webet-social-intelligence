'use strict';

/**
 * report-clv-omega — daily running CLV totals.
 *
 * Schedule (netlify.toml): "15 13,14 * * *"
 *   13:15 UTC = 9:15am ET (EDT). 14:15 UTC = 9:15am ET (EST).
 *   etGuard keeps 09:15 ET only.
 *
 * Merges data/clv-ledger-seed.json with Omega clv-*, clv-candidates-*,
 * clv-candidates-v2/*, and omega-candidates/* blobs inside the lookback.
 * Writes only omega-clv-report/{date} and omega-clv-report/latest.
 *
 * Display only. Does not change a price, a probability, a stake, or a pick.
 * OMEGA_REPLAY_NO_WRITE=1 or ?dryRun=1 returns the report and writes nothing.
 * GET returns omega-clv-report/latest and does not recompute.
 */

const fs = require('fs');
const path = require('path');
const store = require('./lib/omega-vnext/store');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const ledger = require('./lib/clv-ledger');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SEED = require('../../data/clv-ledger-seed.json');

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

function loadSeedRows() {
  if (SEED && Array.isArray(SEED.rows)) return SEED.rows;
  const file = path.join(__dirname, '..', '..', 'data', 'clv-ledger-seed.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

async function safeRead(read, key) {
  try {
    return await read(key);
  } catch (e) {
    console.error(`[report-clv-omega] read ${key}: ${e.message}`);
    return null;
  }
}

async function loadLiveRows(asOf, read, lookbackDays) {
  const dates = ledger.liveDates(asOf, lookbackDays);
  const rows = [];
  for (const date of dates) {
    const picksMeta = await safeRead(read, `picks-${date}`);
    const modelVersion = picksMeta && (picksMeta.model || picksMeta.modelVersion) || null;
    const opts = { source: 'omega', date, modelVersion };
    const keys = [
      `clv-${date}`,
      `clv-candidates-v2/${date}`,
      `clv-candidates-${date}`,
      `omega-candidates/${date}`,
    ];
    for (const key of keys) {
      const blob = await safeRead(read, key);
      if (!blob) continue;
      rows.push(...ledger.rowsFromBlob(key, blob, opts));
    }
  }
  return { dates, rows };
}

async function runClvReport(opts) {
  const src = opts || {};
  const asOf = src.asOf;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw new Error(`clv report refused bad date: ${asOf}`);
  }
  const env = src.env || process.env;
  const read = src.readJson || ((key) => store.readJson(key));
  const seedRows = Array.isArray(src.seedRows) ? src.seedRows : loadSeedRows();
  const live = await loadLiveRows(asOf, read, src.lookbackDays);
  const now = src.now instanceof Date ? src.now : new Date();
  const report = ledger.buildReport({
    rows: seedRows.concat(live.rows),
    asOf,
    generatedAt: now.toISOString(),
    source: 'seed+blobs',
  });
  report.inputs = {
    seed: seedRows.length,
    live: live.rows.length,
    dates: live.dates.length,
    lookbackDays: src.lookbackDays == null ? ledger.LIVE_LOOKBACK_DAYS : src.lookbackDays,
  };
  const dryRun = !!src.dryRun;
  const blocked = dryRun || replayNoWrite(env);
  if (blocked) {
    return {
      report,
      wrote: false,
      keys: [],
      reason: dryRun ? 'dry-run' : 'no-write',
    };
  }
  const write = src.writeJson || ((key, data) => store.storeJson(key, data));
  const keys = [ledger.reportKey(asOf), ledger.LATEST_KEY];
  try {
    await write(keys[0], report);
    await write(keys[1], report);
  } catch (e) {
    console.error(`[report-clv-omega] write failed: ${e.message}`);
    return { report, wrote: false, keys: [], reason: 'write-failed', error: e.message };
  }
  return { report, wrote: true, keys, reason: null };
}

function envelope(result) {
  return {
    ...result.report,
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
  const etSkip = rejectUnlessEtSlot('report-clv-omega', event, when);
  if (etSkip) return etSkip;

  const method = String((event && event.httpMethod) || 'POST').toUpperCase();
  const dryRun = wantsDryRun(event);
  const readJson = deps && deps.readJson;
  const writeJson = deps && deps.writeJson;
  const env = (deps && deps.env) || process.env;
  const seedRows = deps && deps.seedRows;

  if (method === 'GET' && !dryRun) {
    const read = readJson || ((key) => store.readJson(key));
    let latest = null;
    try {
      latest = await read(ledger.LATEST_KEY);
    } catch (e) {
      console.error(`[report-clv-omega] latest read: ${e.message}`);
    }
    if (!latest) {
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
    const result = await runClvReport({
      asOf,
      now: when,
      readJson,
      writeJson,
      env,
      dryRun,
      seedRows,
      lookbackDays: deps && deps.lookbackDays,
    });
    return json(200, envelope(result));
  } catch (e) {
    console.error(`[report-clv-omega] failed: ${e.message}`);
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
exports.runClvReport = runClvReport;
