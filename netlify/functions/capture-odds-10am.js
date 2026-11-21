'use strict';
/** 10:00 AM ET daily Odds pull -> odds-master check-1000 (Ben 2026-10-18:
 *  only 3AM + 10AM pulls). Cron "0 14,15 * * *". DST-proof via etGuard.
 *  Thin wrapper over lib/odds-master/pull. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { forceOverride, readBody } = require('./lib/slot-lock');

function pullArgs(event, deps) {
  const env = (deps && deps.env) || process.env;
  const qs = (event && event.queryStringParameters) || {};
  const body = readBody(event);
  const args = {
    slot: '1000',
    env,
    force: !!(deps && deps.force) || forceOverride(event, env),
  };
  if (deps && deps.now) args.now = deps.now instanceof Date ? deps.now : new Date(deps.now);
  if (deps && deps.read) args.read = deps.read;
  if (deps && deps.write) args.write = deps.write;
  if (deps && deps.oddsFetch) args.fetchImpl = deps.oddsFetch;
  else if (deps && deps.fetch) args.fetchImpl = deps.fetch;
  if (deps && deps.apiKey) args.apiKey = deps.apiKey;
  if (deps && deps.lockStore) args.lockStore = deps.lockStore;
  const dateISO = (deps && deps.dateISO) || qs.date || body.date;
  if (dateISO) args.dateISO = String(dateISO);
  return args;
}

async function runCapture(event, deps) {
  const pull = (deps && deps.runOddsMasterPull) || runOddsMasterPull;
  try {
    const r = await pull(pullArgs(event, deps));
    if (r && r.skipped) {
      // 503 asks the scheduler to retry a pull that already fetched and can be finished.
      const resumable = !!r.resumable;
      return {
        statusCode: resumable ? 503 : 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: !resumable, skipped: r.skipped, resumable, slot: '1000', date: r.date || null,
        }),
      };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...r }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
}

exports.handler = async (event) => {
  const skip = rejectUnlessEtSlot('capture-odds-10am', event, new Date());
  if (skip) return skip;
  return runCapture(event);
};
exports.handle = (event, deps) => runCapture(event, deps);
