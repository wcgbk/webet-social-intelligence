'use strict';

/**
 * recal-report-omega — daily per-sport recalibration report.
 *
 * Schedule (netlify.toml): "15 13,14 * * *"
 *   13:15 UTC = 9:15am ET (EDT). 14:15 UTC = 9:15am ET (EST).
 *   etGuard keeps 09:15 ET only, before the 9:30 generate and the 10:30 lock.
 *
 * Reads omega-candidates/{date}, clv-candidates-v2/{date}, and picks-{date}
 * for the last 28 ET days. Writes only omega-recal-report/{date} and
 * omega-recal-report/latest.
 *
 * OMEGA_REPLAY_NO_WRITE=1 or ?dryRun=1 writes nothing and returns the report.
 * GET returns omega-recal-report/latest and does not recompute.
 *
 * Observe only. Does not change a live price, probability, floor, stake,
 * or selection. The fitted shrink K is reported and not applied.
 */

const store = require('./lib/omega-vnext/store');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const reportLib = require('./lib/omega-vnext/recal_report');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LOOKBACK_DAYS = 28;

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
  return qs.date || body.date || etParts(now).ymd;
}

async function safeRead(read, key) {
  try {
    return await read(key);
  } catch (e) {
    console.error(`[recal-report-omega] read ${key}: ${e.message}`);
    return null;
  }
}

function stampDate(blob, date) {
  if (Array.isArray(blob)) return { date, candidates: blob };
  if (blob && blob.date) return blob;
  return { ...(blob || {}), date };
}

async function loadWindow(asOf, read) {
  const dates = reportLib.datesEnding(asOf, LOOKBACK_DAYS);
  const ledgers = [];
  const closes = [];
  const results = [];
  for (const date of dates) {
    const ledger = await safeRead(read, `omega-candidates/${date}`);
    const close = await safeRead(read, `clv-candidates-v2/${date}`);
    const picks = await safeRead(read, `picks-${date}`);
    if (ledger) ledgers.push(stampDate(ledger, date));
    if (close) closes.push(stampDate(close, date));
    if (picks) results.push(stampDate(picks, date));
  }
  return { dates, ledgers, closes, results };
}

async function runRecalReport(opts) {
  const src = opts || {};
  const asOf = src.asOf;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw new Error(`recal report refused bad date: ${asOf}`);
  }
  const env = src.env || process.env;
  const read = src.readJson || ((key) => store.readJson(key));
  const loaded = await loadWindow(asOf, read);
  const now = src.now instanceof Date ? src.now : new Date();
  const report = reportLib.buildRecalReport({
    asOf,
    generatedAt: now.toISOString(),
    ledgers: loaded.ledgers,
    closes: loaded.closes,
    results: loaded.results,
  });
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
  const keys = [reportLib.reportKey(asOf), reportLib.LATEST_KEY];
  try {
    await write(keys[0], report);
    await write(keys[1], report);
  } catch (e) {
    console.error(`[recal-report-omega] write failed: ${e.message}`);
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
  const etSkip = rejectUnlessEtSlot('recal-report-omega', event, when);
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
      latest = await read(reportLib.LATEST_KEY);
    } catch (e) {
      console.error(`[recal-report-omega] latest read: ${e.message}`);
    }
    if (!latest) {
      return json(200, {
        ok: false,
        missing: true,
        observerOnly: true,
        applied: false,
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
    const result = await runRecalReport({ asOf, now: when, readJson, writeJson, env, dryRun });
    return json(200, envelope(result));
  } catch (e) {
    console.error(`[recal-report-omega] failed: ${e.message}`);
    return json(500, {
      ok: false,
      error: e.message,
      observerOnly: true,
      applied: false,
      wrote: false,
    });
  }
}

exports.handler = (event) => handle(event, new Date(), null);
exports.handle = handle;
exports.runRecalReport = runRecalReport;
