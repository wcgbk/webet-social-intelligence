'use strict';
/**
 * sync-supabase — daily trigger for the standalone Supabase CLV mirror (rewritten 2026-10-30).
 * Schedule "25 13,14 * * *"; etGuard keeps 09:25 ET only. Kicks sync-supabase-background
 * for yesterday (ET). Manual: ?date=YYYY-MM-DD[&dryRun=1] with PICKS_SECRET_KEY auth.
 * Fails loudly (HTTP 500 + console.error) when a required env var is missing.
 * No Odds API call. Does not read or write picks, grading or card code.
 */
const { isSchedulerEvent, rejectUnlessEtSlot } = require('./lib/et-schedule');
const S = require('./lib/clv-supabase');

const REQUIRED_ENV = ['SUPABASE_SERVICE_ROLE_KEY', 'NETLIFY_AUTH_TOKEN', 'PICKS_SECRET_KEY'];

async function handle(event, now, deps = {}) {
  const when = now instanceof Date ? now : new Date();
  const skip = rejectUnlessEtSlot('sync-supabase', event, when);
  if (skip) return skip;
  const env = deps.env || process.env;
  const scheduled = isSchedulerEvent(event);
  if (!scheduled && !S.isAuthorized(event, env)) return S.json(401, { ok: false, error: 'unauthorized' });
  try { S.requireEnv(env, REQUIRED_ENV); } catch (e) {
    console.error(`[sync-supabase] FATAL ${e.message}; nothing synced`);
    return S.json(500, { ok: false, error: e.message, missingEnv: e.missing });
  }
  const q = (event && event.queryStringParameters) || {};
  const date = q.date || S.addDays(S.etYmd(when), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return S.json(400, { ok: false, error: 'bad date', date });
  const dryRun = q.dryRun === '1' || q.dryRun === 'true';
  const base = env.URL || 'https://webetsocial.com';
  const url = `${base}/.netlify/functions/sync-supabase-background?date=${date}${dryRun ? '&dryRun=1' : ''}`;
  const resp = await (deps.fetch || fetch)(url, { method: 'POST', headers: { 'x-picks-secret': env.PICKS_SECRET_KEY } });
  if (resp.status !== 202 && !resp.ok) {
    console.error(`[sync-supabase] background trigger HTTP ${resp.status} for ${date}`);
    return S.json(500, { ok: false, error: `background trigger HTTP ${resp.status}`, date });
  }
  return S.json(202, { ok: true, queued: true, date, dryRun, log: `supabase-sync/run/${date}${dryRun ? '-dry' : ''}` });
}

exports.handler = (event, context) => handle(event, new Date());
exports.handle = handle;
exports.REQUIRED_ENV = REQUIRED_ENV;
