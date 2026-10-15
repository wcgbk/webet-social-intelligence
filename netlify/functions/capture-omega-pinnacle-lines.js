'use strict';

/**
 * capture-omega-pinnacle-lines.js — scheduled entry for the Pinnacle check.
 *
 * 3:00 and 10:00 ET only. The cron stays on this file. A scheduler invoke
 * decides the ET slot once (guard.matched) and fires
 * capture-omega-pinnacle-lines-background, then returns. That function has
 * the 15-minute limit. The POST body is { scheduled, etSlot, dateISO } and
 * carries no secret. The secret is the x-picks-secret header.
 * If PICKS_SECRET_KEY is unset, or the call throws or returns a status
 * other than 202 or any other 2xx, this entry runs handleCapture inline so
 * a missing env var cannot silence the pull. Manual and HTTP invokes stay
 * inline. Tests and ops call handleCapture.
 *
 * Writes omega-pinnacle-line-moves sport/eventId keys and the odds-master
 * price tape. Does not write the published card.
 * capture-omega-pinnacle-open is suspended: openers are the first price
 * in the 3:00 pull, and that handler returns before any Odds API call.
 *
 * Live Odds API: regions=eu, one call per book per sport. The 3:00 check
 * also requests yesterday's pregame historical closes. The 10:00 check
 * reuses a same-sport snapshot younger than 5 minutes.
 * The 49,000 credit stop does not apply to this 3:00 or 10:00 pull.
 * It applies to backfill and extra pulls only.
 * ?dryRun=1 and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { etDateISO, hhmmET } = require('./lib/omega-vnext/line_path');
const { runPinnacleLineCapture } = require('./lib/omega-vnext/capture_runner');
const { CHECK_SLOTS } = require('./lib/omega-vnext/pinnacle_line_move');
const { rejectUnlessEtSlot, etGuard, isSchedulerEvent } = require('./lib/et-schedule');

const NAME = 'capture-omega-pinnacle-lines';
const BACKGROUND_NAME = 'capture-omega-pinnacle-lines-background';

function compactSlot(hhmm) {
  return String(hhmm || '').replace(':', '');
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function envOf(context) {
  if (context && Object.prototype.hasOwnProperty.call(context, 'env')) return context.env || {};
  return process.env;
}

function captureOptsOf(context) {
  const opts = context && context.captureOpts;
  return opts && typeof opts === 'object' ? opts : {};
}

function backgroundAccepted(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return false;
  if (n === 202) return true;
  return n >= 200 && n < 300;
}

async function handleCapture(event, functionName, opts = {}) {
  const name = functionName || NAME;
  if (name === 'capture-omega-pinnacle-open') {
    return json(200, {
      ok: true,
      skipped: 'odds-api-window',
      mode: 'open',
      wrote: false,
      pulls: 0,
      eventPolls: 0,
      message: 'Openers are the first price in the 3:00 ET pull. This job does not call the Odds API.',
    });
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const etSkip = rejectUnlessEtSlot(name, event, now);
  if (etSkip) return etSkip;
  const qs = (event && event.queryStringParameters) || {};
  const guard = etGuard(name, event, now);
  const mode = name === 'capture-omega-pinnacle-open' || opts.mode === 'open' ? 'open' : 'check';
  const dateISO = opts.dateISO || qs.date || etDateISO(now);
  const etSlot = opts.etSlot
    ? compactSlot(opts.etSlot)
    : (guard.matched ? compactSlot(guard.matched) : compactSlot(hhmmET(now)));
  if (mode === 'check' && !CHECK_SLOTS.includes(etSlot)) {
    return json(200, { ok: true, skipped: 'slot', etSlot, mode });
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
      yesterdayGames: opts.yesterdayGames,
      skipExternalCloses: opts.skipExternalCloses,
    });
    return json(200, stored);
  } catch (err) {
    console.error(`[pinnacle-line-move] failed: ${err.message}`);
    return json(500, { error: err.message });
  }
}

async function runEntry(event, context) {
  const ctx = context || {};
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const etSkip = rejectUnlessEtSlot(NAME, event, now);
  if (etSkip) return etSkip;
  const baseOpts = Object.assign({}, captureOptsOf(ctx), { now });
  if (!isSchedulerEvent(event)) {
    console.log('[pinnacle-line-move] path=inline-manual');
    return handleCapture(event, NAME, baseOpts);
  }
  const env = envOf(ctx);
  const qs = (event && event.queryStringParameters) || {};
  const guard = etGuard(NAME, event, now);
  const dateISO = qs.date || etDateISO(now);
  const etSlot = guard.matched ? compactSlot(guard.matched) : compactSlot(hhmmET(now));
  if (!CHECK_SLOTS.includes(etSlot)) {
    console.log(`[pinnacle-line-move] path=skip-slot etSlot=${etSlot}`);
    return json(200, { ok: true, skipped: 'slot', etSlot, mode: 'check' });
  }
  const inline = () => handleCapture(event, NAME, Object.assign({}, baseOpts, { etSlot, dateISO }));
  const secret = env.PICKS_SECRET_KEY;
  if (!secret) {
    console.log('[pinnacle-line-move] path=inline-fallback reason=no-secret');
    return inline();
  }
  const siteURL = env.URL || 'https://webetsocial.com';
  const fetchImpl = typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : fetch;
  const url = `${siteURL}/.netlify/functions/${BACKGROUND_NAME}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-picks-secret': secret,
      },
      body: JSON.stringify({ scheduled: true, etSlot, dateISO }),
      signal: ctrl.signal,
    });
    const status = response && response.status;
    if (!backgroundAccepted(status)) {
      console.log(`[pinnacle-line-move] path=inline-fallback reason=background-status status=${status}`);
      return inline();
    }
    console.log(`[pinnacle-line-move] path=background status=${status} etSlot=${etSlot} date=${dateISO}`);
    return json(200, {
      ok: true,
      path: 'background',
      etSlot,
      dateISO,
      backgroundStatus: status,
    });
  } catch (err) {
    console.log(`[pinnacle-line-move] path=inline-fallback reason=background-error ${err && err.message}`);
    return inline();
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = (event, context) => runEntry(event, context);
exports.handleCapture = handleCapture;
exports.runEntry = runEntry;
exports.backgroundAccepted = backgroundAccepted;
