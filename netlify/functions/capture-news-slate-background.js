'use strict';

/**
 * On-demand per-game news slate capture. No schedule.
 * Writes omega-news-snapshots `{date}/games/{HHMM}-ET` only.
 * Does not touch the card, picks, grading, or KPIs. No Odds API call.
 *
 * Manual invoke uses the same PICKS_SECRET_KEY rule as check-supabase-freshness:
 * Authorization: Bearer, x-picks-secret, or ?key=. A missing or wrong secret is 401.
 * The key is never logged.
 * ?date=YYYY-MM-DD, or today America/New_York.
 * OMEGA_NEWS_SLATE=off returns without fetching.
 */

const crypto = require('crypto');
const { newsSlateEnabled } = require('./lib/omega-v2/constants');
const { captureNewsSlate } = require('./lib/omega-vnext/news_slate');
const { todayET } = require('./lib/omega-live-date');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = name.toLowerCase();
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
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

/** Same manual-invoke rule as check-supabase-freshness. Fail closed. */
function isAuthorized(event, env) {
  const source = env || process.env;
  const secret = source && source.PICKS_SECRET_KEY;
  if (!secret || !event) return false;
  const auth = header(event, 'authorization').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const got = bearer ? bearer[1].trim() : (header(event, 'x-picks-secret') || ((event.queryStringParameters || {}).key) || '');
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function eventDate(event, now) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs.date) return String(qs.date);
  const body = readBody(event);
  if (body && body.date) return String(body.date);
  return todayET(now || new Date());
}

async function handle(event, deps) {
  const options = deps || {};
  const env = options.env != null ? options.env : process.env;
  if (!isAuthorized(event, env)) return { statusCode: 401, body: 'Unauthorized' };
  if (!newsSlateEnabled(env)) return json(200, { ok: true, skipped: 'flag-off', wrote: false });
  const now = options.now || new Date();
  const dateISO = options.date || eventDate(event, now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return json(400, { ok: false, error: 'bad-date' });
  const capture = options.captureNewsSlate || captureNewsSlate;
  try {
    const result = await capture({
      env,
      dateISO,
      now,
      timeoutMs: 5000,
      budgetMs: 60000,
      fetchImpl: options.fetchImpl,
      store: options.store,
      blobFetch: options.blobFetch,
      noWrite: options.noWrite === true,
    });
    const counts = result && result.doc && result.doc.counts ? result.doc.counts : null;
    const failures = result && result.doc && Array.isArray(result.doc.failures) ? result.doc.failures.length : 0;
    return json(200, {
      ok: !!(result && result.doc),
      wrote: !!(result && result.wrote),
      skipped: result && result.skipped ? result.skipped : null,
      key: result && result.key ? result.key : null,
      date: dateISO,
      counts,
      failures,
      error: result && result.error ? result.error : null,
    });
  } catch (_) {
    return json(200, { ok: false, wrote: false, date: dateISO, error: 'soft-fail' });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
exports.isAuthorized = isAuthorized;
