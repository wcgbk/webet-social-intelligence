'use strict';

/**
 * On-demand Omega historical replay.
 * Default dryRun=true. Writes only omega-replay/{runId}/* when dryRun=false.
 * Never touches live picks-{date}.
 *
 * GET/POST /.netlify/functions/replay-omega-historical
 * Body/query: { from, to, dryRun, runId, maxDays, sports, skipNarrate }
 * skipNarrate defaults to true. dryRun defaults to true.
 * Scoring reads clv-{date} and settled picks. It never writes live picks-{date}.
 */

const { runReplayRange, DEFAULT_MAX_DAYS, HARD_MAX_DAYS } = require('./lib/omega-vnext/replay');

function json(code, body) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function parseSports(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

exports.handler = async (event) => {
  let body = {};
  try {
    if (event && event.body) body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (_) { body = {}; }
  const qs = (event && event.queryStringParameters) || {};
  const from = body.from || qs.from;
  const to = body.to || qs.to || from;
  if (!from) {
    return json(200, {
      ok: false,
      error: 'from required (YYYY-MM-DD)',
      hint: 'Default dryRun=true skipNarrate=true. Example: ?from=2026-09-15&to=2026-09-21&dryRun=true&maxDays=7&runId=mlb-late-sep&skipNarrate=true',
      defaults: { dryRun: true, skipNarrate: true, maxDays: DEFAULT_MAX_DAYS, hardMaxDays: HARD_MAX_DAYS },
    });
  }
  const dryRaw = body.dryRun != null ? body.dryRun : qs.dryRun;
  const dryRun = dryRaw === false || dryRaw === 'false' || dryRaw === 0 || dryRaw === '0' ? false : true;
  const skipRaw = body.skipNarrate != null ? body.skipNarrate : qs.skipNarrate;
  const skipNarrate = !(skipRaw === false || skipRaw === 'false' || skipRaw === 0 || skipRaw === '0');
  const maxDays = Number(body.maxDays || qs.maxDays || DEFAULT_MAX_DAYS);
  const runId = body.runId || qs.runId || `replay-${from}-to-${to}`;
  const sports = parseSports(body.sports || qs.sports);
  console.log(`[replay-omega-historical] from=${from} to=${to} dryRun=${dryRun} skipNarrate=${skipNarrate} maxDays=${maxDays} runId=${runId}`);
  try {
    const out = await runReplayRange({ from, to, dryRun, maxDays, runId, sports, skipNarrate });
    return json(200, { ok: true, ...out });
  } catch (e) {
    console.error(`[replay-omega-historical] soft-fail: ${e.message}`);
    return json(200, { ok: false, error: e.message, dryRun });
  }
};
