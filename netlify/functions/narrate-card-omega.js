'use strict';

/**
 * narrate-card-omega — 10:45 ET.
 * Schedule: "45 14,15 * * *" (10:45 ET in both EDT and EST).
 * Writes context and summaries from the card already in hand.
 * Does not call the Odds API. Does not finalize. Does not post.
 * dryRun and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { writeSummaries } = require('./lib/omega-vnext/timeline');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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

function wantsDryRun(event, env) {
  const qs = (event && event.queryStringParameters) || {};
  if (truthy(qs.dryRun) || truthy(qs.dryrun)) return true;
  const body = readBody(event);
  if (body && (truthy(body.dryRun) || truthy(body.dryrun))) return true;
  return replayNoWrite(env);
}

async function runNarrate(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const parts = etParts(now);
  const dateISO = opts.dateISO || parts.ymd;
  const env = opts.env || process.env;
  const dry = opts.dryRun === true || replayNoWrite(env);
  let card = opts.card || null;
  if (!card && typeof opts.readCard === 'function') {
    try { card = await opts.readCard(dateISO); } catch (_) { card = null; }
  }
  if (!card && opts.readCard == null && opts.card == null && opts.env == null) {
    try {
      const { readPicks } = require('./lib/omega-vnext/store');
      card = await readPicks(dateISO);
    } catch (_) {
      card = null;
    }
  }
  if (!card) {
    return { card: null, changed: false, wrote: false, date: dateISO, dryRun: dry, oddsApi: false, reason: 'no-card' };
  }
  const result = writeSummaries(card);
  if (dry || !result.changed) {
    return { ...result, wrote: false, date: dateISO, dryRun: dry, oddsApi: false };
  }
  if (typeof opts.writeCard === 'function') {
    await opts.writeCard(dateISO, result.card);
    return { ...result, wrote: true, date: dateISO, dryRun: false, oddsApi: false };
  }
  if (opts.env == null) {
    const { storePicks } = require('./lib/omega-vnext/store');
    await storePicks(dateISO, result.card, { force: true });
    return { ...result, wrote: true, date: dateISO, dryRun: false, oddsApi: false };
  }
  return { ...result, wrote: false, date: dateISO, dryRun: dry, oddsApi: false };
}

exports.runNarrate = runNarrate;

exports.handler = async (event, _context, now = new Date()) => {
  const skip = rejectUnlessEtSlot('narrate-card-omega', event, now);
  if (skip) return skip;
  const result = await runNarrate({
    now,
    dryRun: wantsDryRun(event),
  });
  return json(200, {
    ok: true,
    wrote: result.wrote,
    changed: result.changed,
    reason: result.reason || null,
    date: result.date,
    oddsApi: false,
    finalized: false,
    timelineStep: '10:45',
    picks: result.card && result.card.picks ? result.card.picks.length : 0,
  });
};
