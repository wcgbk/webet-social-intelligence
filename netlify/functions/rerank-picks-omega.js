'use strict';

/**
 * rerank-picks-omega — 10:15 ET.
 * Schedule: "15 14,15 * * *" (10:15 ET in both EDT and EST).
 * Reads the 10:00 card and refreshes injuries. Does not call the Odds API.
 * Writes the card only when the re-rank changes it and writes are allowed.
 * dryRun and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { rerankCard } = require('./lib/omega-vnext/rerank');

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

async function runRerank(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const parts = etParts(now);
  const dateISO = opts.dateISO || parts.ymd;
  const env = opts.env || process.env;
  const dry = opts.dryRun === true || replayNoWrite(env);
  let card = opts.card || null;
  if (!card && typeof opts.readCard === 'function') {
    try { card = await opts.readCard(dateISO); } catch (_) { card = null; }
  }
  if (!card && opts.readCard == null && opts.card == null) {
    try {
      const { readPicks } = require('./lib/omega-vnext/store');
      card = await readPicks(dateISO);
    } catch (_) {
      card = null;
    }
  }
  const result = await rerankCard({
    card,
    now,
    fetchImpl: opts.fetchImpl,
    runNews: opts.runNews,
    pool: opts.pool,
  });
  if (!result.changed || result.lastKnownGood || dry) {
    return { ...result, wrote: false, date: dateISO, dryRun: dry };
  }
  if (typeof opts.writePicks === 'function') {
    await opts.writePicks(dateISO, result.card);
    return { ...result, wrote: true, date: dateISO, dryRun: false };
  }
  const { storePicks } = require('./lib/omega-vnext/store');
  await storePicks(dateISO, result.card, { force: true });
  return { ...result, wrote: true, date: dateISO, dryRun: false };
}

exports.runRerank = runRerank;

exports.handler = async (event, _context, now = new Date()) => {
  const skip = rejectUnlessEtSlot('rerank-picks-omega', event, now);
  if (skip) return skip;
  const result = await runRerank({
    now,
    dryRun: wantsDryRun(event),
  });
  return json(200, {
    ok: true,
    wrote: result.wrote,
    changed: result.changed,
    lastKnownGood: result.lastKnownGood,
    reason: result.reason,
    date: result.date,
    oddsApi: false,
    picks: result.card && result.card.picks ? result.card.picks.length : 0,
  });
};
