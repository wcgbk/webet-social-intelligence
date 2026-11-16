'use strict';

/**
 * Background worker for the 11:30 ET ops check.
 * grade-boards-omega posts this. No cron of its own.
 * OMEGA_DAILY_CHECK=off returns without reading stores.
 * Does not write the main card and does not call The Odds API.
 */

const { dailyCheckEnabled, runDailyCheck } = require('./lib/omega-vnext/daily_check');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

function eventDate(event) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs.date) return String(qs.date);
  const body = readBody(event);
  if (body && body.date) return String(body.date);
  return '';
}

async function handle(event, opts) {
  const options = opts || {};
  const env = options.env != null ? options.env : process.env;
  if (!dailyCheckEnabled(env)) return json(200, { ok: true, skipped: 'flag-off' });
  try {
    const picked = options.date || eventDate(event);
    const extra = { event, env };
    if (picked) extra.date = picked;
    if (options.now) extra.now = options.now;
    const report = await runDailyCheck(Object.assign({}, options, extra));
    return json(200, {
      ok: report.ok === true,
      date: report.date,
      dryRun: report.dryRun === true,
      skipped: report.skipped || null,
    });
  } catch (_) {
    return json(200, { ok: false, error: 'check-failed' });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
