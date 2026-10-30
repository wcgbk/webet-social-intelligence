'use strict';

/**
 * check-supabase-freshness — daily alarm for the Supabase CLV mirror.
 *
 * Schedule (netlify.toml): "45 13,14 * * *", etGuard keeps 09:45 ET only
 * (20 minutes after sync-supabase). Read-only on Supabase. No Odds API call.
 *
 * Stale = latest clv.odds_snapshots.created_at is older than the start of
 * yesterday (ET), or the Supabase key is missing / the query fails.
 * On stale: console.error, HTTP 500, and a supabase-sync/freshness/<date> blob.
 * Manual invoke needs PICKS_SECRET_KEY / admin auth (same as sync-supabase).
 */

const { isSchedulerEvent, rejectUnlessEtSlot } = require('./lib/et-schedule');
const crypto = require('crypto');
const SUPABASE_URL = 'https://qvfgebrkolfyggfizgkx.supabase.co';

// Same manual-invoke rule as other admin functions: PICKS_SECRET_KEY bearer / header / ?key=.
function isAuthorized(event, env) {
  const secret = env && env.PICKS_SECRET_KEY;
  if (!secret || !event) return false;
  const h = event.headers || {};
  const q = event.queryStringParameters || {};
  const auth = String(h.authorization || h.Authorization || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : (h['x-picks-secret'] || q.key || '');
  const a = Buffer.from(String(got)); const b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function etYmd(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Threshold = 00:00 ET of yesterday. Created on/after yesterday ET counts as fresh.
function yesterdayEt(now) {
  return etYmd(new Date(now.getTime() - 24 * 3600 * 1000));
}

async function latestCreatedAt(env, fetchImpl) {
  const key = env && env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('missing env: SUPABASE_SERVICE_ROLE_KEY');
  const url = `${SUPABASE_URL}/rest/v1/odds_snapshots?select=created_at&order=created_at.desc&limit=1`;
  const resp = await fetchImpl(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'clv' },
  });
  if (!resp.ok) throw new Error(`supabase HTTP ${resp.status}`);
  const rows = await resp.json();
  return rows && rows[0] ? rows[0].created_at : null;
}

function evaluate(latest, now) {
  const yday = yesterdayEt(now);
  if (!latest) return { fresh: false, yesterday: yday, latestEtDate: null };
  const latestEtDate = etYmd(new Date(latest));
  return { fresh: latestEtDate >= yday, yesterday: yday, latestEtDate };
}

async function writeAlert(date, body, deps) {
  try {
    const getStore = deps && deps.getStore ? deps.getStore : (await import('@netlify/blobs')).getStore;
    await getStore('supabase-sync').setJSON(`freshness/${date}`, body);
    return true;
  } catch (err) {
    console.error(`[check-supabase-freshness] alert blob write failed: ${err && err.message}`);
    return false;
  }
}

async function handle(event, now, deps) {
  const when = now instanceof Date ? now : new Date();
  const skip = rejectUnlessEtSlot('check-supabase-freshness', event, when);
  if (skip) return skip;
  const env = (deps && deps.env) || process.env;
  if (!isSchedulerEvent(event) && !isAuthorized(event, env)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  const fetchImpl = (deps && deps.fetch) || fetch;
  const date = etYmd(when);
  let result;
  try {
    const latest = await latestCreatedAt(env, fetchImpl);
    result = { ...evaluate(latest, when), latestCreatedAt: latest };
  } catch (err) {
    result = { fresh: false, error: err && err.message };
  }
  const body = { ok: result.fresh, checkedAt: when.toISOString(), date, table: 'clv.odds_snapshots', ...result };
  if (result.fresh) return json(200, body);
  console.error(`[check-supabase-freshness] STALE: ${JSON.stringify(body)}`);
  body.alertBlob = await writeAlert(date, body, deps);
  return json(500, body);
}

exports.handler = (event, context) => handle(event, context && context.now instanceof Date ? context.now : new Date(), context && context.deps);
exports.handle = handle;
exports.evaluate = evaluate;
exports.yesterdayEt = yesterdayEt;
