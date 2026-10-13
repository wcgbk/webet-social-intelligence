'use strict';

/**
 * report-calibration-omega — weekly calibration review.
 *
 * Schedule (netlify.toml): "15 10,11 * * 0"
 *   10:15 UTC = 6:15am ET (EDT). 11:15 UTC = 6:15am ET (EST).
 *   etGuard keeps Sunday 06:15 ET only, outside the card window.
 *
 * Report only. Reads an injected recal report, injected rows, or the
 * stored omega-recal-report/latest. Writes omega-calibration-weekly/{date}
 * and omega-calibration-weekly/latest when writes are allowed.
 * FIT_ENABLED stays false. The fitted shrink is not applied.
 * self-optimize-omega stays paused. Does not change a price, a stake, or a pick.
 * OMEGA_REPLAY_NO_WRITE=1 or ?dryRun=1 returns the report and writes nothing.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { FIT_ENABLED } = require('./lib/omega-vnext/walk_forward');
const reportLib = require('./lib/omega-vnext/recal_report');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LATEST_KEY = 'omega-calibration-weekly/latest';
const NOTE = 'Weekly calibration review. Report only. FIT stays off. The fitted shrink is not applied. self-optimize-omega stays paused. This does not change a live price, probability, floor, stake, or selection.';

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function truthy(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try { return JSON.parse(event.body); } catch (_) { return {}; }
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

function sportSummary(recal) {
  const sports = (recal && recal.sports) || {};
  const out = [];
  for (const sport of Object.keys(sports).sort()) {
    const windows = sports[sport] && sports[sport].windows;
    const cell = windows && (windows[28] || windows['28']);
    if (!cell) continue;
    out.push({
      sport,
      n: Number(cell.n) || 0,
      meanClv: cell.meanClv == null ? null : cell.meanClv,
      logLossModel: cell.logLossModel == null ? null : cell.logLossModel,
      brierModel: cell.brierModel == null ? null : cell.brierModel,
      logLossClose: cell.logLossClose == null ? null : cell.logLossClose,
      brierClose: cell.brierClose == null ? null : cell.brierClose,
    });
  }
  return out;
}

function reportKey(dateISO) {
  return `omega-calibration-weekly/${dateISO}`;
}

async function loadRecal(src, asOf, now) {
  if (src.recal) return src.recal;
  if (Array.isArray(src.rows)) {
    return reportLib.buildRecalReport({
      asOf,
      rows: src.rows,
      generatedAt: now.toISOString(),
    });
  }
  const read = typeof src.readJson === 'function'
    ? src.readJson
    : async (key) => {
      const store = require('./lib/omega-vnext/store');
      return store.readJson(key);
    };
  if (src.readJson !== null) {
    try {
      const stored = await read('omega-recal-report/latest');
      if (stored && stored.sports) return stored;
    } catch (e) {
      console.error(`[report-calibration-omega] recal read: ${e.message}`);
    }
  }
  return reportLib.buildRecalReport({ asOf, rows: [], generatedAt: now.toISOString() });
}

async function runWeeklyCalibration(opts) {
  const src = opts || {};
  const now = src.now instanceof Date ? src.now : new Date();
  const asOf = src.asOf || etParts(now).ymd;
  const env = src.env || process.env;
  const dryRun = !!src.dryRun;
  const blocked = dryRun || replayNoWrite(env);
  const recal = await loadRecal(src, asOf, now);
  const report = {
    schema: 'omega-calibration-weekly-v1',
    observerOnly: true,
    displayOnly: true,
    applied: false,
    fitEnabled: FIT_ENABLED === true,
    asOf: recal.asOf || asOf,
    generatedAt: now.toISOString(),
    sports: sportSummary(recal),
    driftFlags: Array.isArray(recal.driftFlags) ? recal.driftFlags : [],
    recommendation: recal.recommendation || null,
    note: NOTE,
  };
  if (blocked) {
    return {
      report,
      wrote: false,
      keys: [],
      reason: dryRun ? 'dry-run' : 'no-write',
    };
  }
  const write = src.writeJson || ((key, data) => {
    const store = require('./lib/omega-vnext/store');
    return store.storeJson(key, data);
  });
  const keys = [reportKey(report.asOf), LATEST_KEY];
  try {
    await write(keys[0], report);
    await write(keys[1], report);
  } catch (e) {
    console.error(`[report-calibration-omega] write failed: ${e.message}`);
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
  const etSkip = rejectUnlessEtSlot('report-calibration-omega', event, when);
  if (etSkip) return etSkip;
  const src = deps || {};
  const result = await runWeeklyCalibration({
    now: when,
    asOf: src.asOf || asOfFrom(event, when),
    dryRun: src.dryRun != null ? !!src.dryRun : wantsDryRun(event),
    env: src.env || process.env,
    rows: src.rows,
    recal: src.recal,
    readJson: src.readJson,
    writeJson: src.writeJson,
  });
  return json(200, envelope(result));
}

exports.handler = (event) => handle(event, new Date(), null);
exports.handle = handle;
exports.runWeeklyCalibration = runWeeklyCalibration;
exports.LATEST_KEY = LATEST_KEY;
exports.NOTE = NOTE;
