'use strict';

/**
 * capture-omega-pinnacle-lines-background.js — 15-minute Pinnacle capture.
 *
 * No cron. capture-omega-pinnacle-lines fires this on a scheduler invoke and
 * passes the ET slot it already chose. This handler does not re-read the
 * clock for the slot. It still refuses a slot outside CHECK_SLOTS.
 *
 * The body has no secret. Authorization: Bearer or x-picks-secret must match
 * PICKS_SECRET_KEY (constant-time). A missing or wrong secret does not call
 * the Odds API. Historical closes cost 30 credits each, so this is not a
 * public endpoint.
 *
 * Writes capture-start/{date}/{slot} before the capture. A failed start
 * write is soft and does not skip the pull. The capture then writes
 * capture-done phase 'checks' before yesterday's closes and phase 'final'
 * after them.
 */

const crypto = require('crypto');
const { CHECK_SLOTS, writeCaptureStart, CAPTURE_START_SCHEMA } = require('./lib/omega-vnext/pinnacle_line_move');
const { handleCapture } = require('./capture-omega-pinnacle-lines');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name || '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const value = headers[key];
    if (Array.isArray(value)) return String(value[0] || '');
    return value == null ? '' : String(value);
  }
  return '';
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

function compactSlot(hhmm) {
  return String(hhmm || '').replace(':', '');
}

function envOf(context) {
  if (context && Object.prototype.hasOwnProperty.call(context, 'env')) return context.env || {};
  return process.env;
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left == null ? '' : left));
  const b = Buffer.from(String(right == null ? '' : right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Header auth only. The query string is not accepted, so a leaked URL
 * cannot spend Odds API credits. Compare is constant-time for equal lengths.
 */
function picksSecretOk(event, env) {
  const secret = env && env.PICKS_SECRET_KEY;
  if (!secret) return false;
  const presented = [];
  const auth = header(event, 'authorization').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) presented.push(bearer[1].trim());
  const alt = header(event, 'x-picks-secret');
  if (alt) presented.push(String(alt).trim());
  if (!presented.length) return false;
  let ok = false;
  for (const value of presented) {
    if (timingSafeEqualString(value, secret)) ok = true;
  }
  return ok;
}

function wantsDryRun(event, ctx) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs.dryRun === '1' || qs.dryRun === 'true' || qs.dryRun === 'yes') return true;
  return !!(ctx && ctx.dryRun);
}

async function handleBackground(event, context) {
  const ctx = context || {};
  const env = envOf(ctx);
  if (!picksSecretOk(event, env)) {
    console.log('[pinnacle-line-move] path=background-rejected reason=secret');
    return json(401, { ok: false, error: 'unauthorized' });
  }
  const body = readBody(event);
  const etSlot = compactSlot(body.etSlot || '');
  const dateISO = String(body.dateISO || body.date || '');
  if (!CHECK_SLOTS.includes(etSlot)) {
    console.log(`[pinnacle-line-move] path=background-rejected reason=slot etSlot=${etSlot}`);
    return json(400, { ok: false, skipped: 'slot', etSlot });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    console.log('[pinnacle-line-move] path=background-rejected reason=date');
    return json(400, { ok: false, error: 'bad date' });
  }
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const started = Date.now();
  const passedEnv = Object.prototype.hasOwnProperty.call(ctx, 'env') ? (ctx.env || {}) : undefined;
  const dryRun = wantsDryRun(event, ctx);
  try {
    await writeCaptureStart(dateISO, etSlot, {
      schema: CAPTURE_START_SCHEMA,
      date: dateISO,
      slot: etSlot,
      startedAt: now.toISOString(),
    }, {
      dryRun,
      env: passedEnv,
      read: ctx.read,
      write: ctx.write,
    });
  } catch (err) {
    console.error(`[pinnacle-line-move] capture-start soft-fail: ${err && err.message}`);
  }
  const result = await handleCapture(event, 'capture-omega-pinnacle-lines', {
    now,
    etSlot,
    dateISO,
    dryRun,
    apiKey: ctx.apiKey,
    fetchImpl: ctx.fetchImpl,
    fetchEvents: ctx.fetchEvents,
    fetchBookOdds: ctx.fetchBookOdds,
    read: ctx.read,
    write: ctx.write,
    env: passedEnv,
    labels: ctx.labels,
    creditFloor: ctx.creditFloor,
    yesterdayGames: ctx.yesterdayGames,
    skipExternalCloses: ctx.skipExternalCloses,
  });
  console.log(`[pinnacle-line-move] background total elapsedMs=${Date.now() - started} etSlot=${etSlot} date=${dateISO}`);
  return result;
}

exports.handler = (event, context) => handleBackground(event, context);
exports.handleBackground = handleBackground;
exports.picksSecretOk = picksSecretOk;
