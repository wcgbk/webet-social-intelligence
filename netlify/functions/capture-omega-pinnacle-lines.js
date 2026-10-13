'use strict';

/**
 * capture-omega-pinnacle-lines.js — Pinnacle and DraftKings line checks.
 *
 * 3:00 and 10:00 ET only. Writes omega-pinnacle-line-moves sport/eventId
 * keys and the odds-master price tape. Does not write the published card.
 * capture-omega-pinnacle-open is suspended: openers are the first price
 * in the 3:00 pull, and that handler returns before any Odds API call.
 *
 * Live Odds API: regions=eu, one call per book per sport. The 3:00 check
 * also requests yesterday's pregame historical closes. The 10:00 check
 * reuses a same-sport snapshot younger than 5 minutes.
 * Skips a priced pull when x-requests-remaining is below 49000.
 * ?dryRun=1 and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { etDateISO, hhmmET } = require('./lib/omega-vnext/line_path');
const { runPinnacleLineCapture } = require('./lib/omega-vnext/capture_runner');
const { CHECK_SLOTS } = require('./lib/omega-vnext/pinnacle_line_move');
const { rejectUnlessEtSlot, etGuard } = require('./lib/et-schedule');

function compactSlot(hhmm) {
  return String(hhmm || '').replace(':', '');
}

async function handleCapture(event, functionName, opts = {}) {
  const name = functionName || 'capture-omega-pinnacle-lines';
  if (name === 'capture-omega-pinnacle-open') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        skipped: 'odds-api-window',
        mode: 'open',
        wrote: false,
        pulls: 0,
        eventPolls: 0,
        message: 'Openers are the first price in the 3:00 ET pull. This job does not call the Odds API.',
      }),
    };
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const etSkip = rejectUnlessEtSlot(name, event, now);
  if (etSkip) return etSkip;
  const qs = (event && event.queryStringParameters) || {};
  const guard = etGuard(name, event, now);
  const mode = name === 'capture-omega-pinnacle-open' || opts.mode === 'open' ? 'open' : 'check';
  const dateISO = qs.date || etDateISO(now);
  const etSlot = guard.matched ? compactSlot(guard.matched) : compactSlot(hhmmET(now));
  if (mode === 'check' && !CHECK_SLOTS.includes(etSlot)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, skipped: 'slot', etSlot, mode }),
    };
  }
  const dryRun = qs.dryRun === '1' || qs.dryRun === 'true' || qs.dryRun === 'yes' || !!opts.dryRun;
  try {
    const stored = await runPinnacleLineCapture({
      mode,
      dateISO,
      etSlot,
      now,
      dryRun,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
      fetchEvents: opts.fetchEvents,
      fetchBookOdds: opts.fetchBookOdds,
      read: opts.read,
      write: opts.write,
      env: opts.env,
      labels: opts.labels,
      creditFloor: opts.creditFloor,
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stored),
    };
  } catch (err) {
    console.error(`[pinnacle-line-move] failed: ${err.message}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
}

exports.handler = (event) => handleCapture(event, 'capture-omega-pinnacle-lines');
exports.handleCapture = handleCapture;
