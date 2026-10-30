'use strict';
/**
 * sync-supabase-background — worker for sync-supabase (15 min budget).
 * Copies one ET date of odds-master pulls + clv-{date} pick closes into
 * clv.games / clv.odds_snapshots, insert-or-ignore. ?dryRun=1 builds rows only.
 * Summary is written to blob supabase-sync/run/{date}[-dry]. No Odds API call.
 */
const S = require('./lib/clv-supabase');
const { buildDay } = require('./lib/clv-sync');

const REQUIRED_ENV = ['SUPABASE_SERVICE_ROLE_KEY', 'NETLIFY_AUTH_TOKEN'];

async function run(date, { env, fetchImpl, dryRun, blobs }) {
  S.requireEnv(env, REQUIRED_ENV);
  const client = blobs || S.blobClient(env, fetchImpl);
  const started = new Date().toISOString();
  const built = await buildDay(date, client, { neighbourDates: [S.addDays(date, -1), S.addDays(date, 1)] });
  const bySport = {};
  for (const s of built.snaps) {
    const b = (bySport[s.sport] = bySport[s.sport] || { snapshot: 0, opening: 0, closing: 0 });
    b[s.line_type] = (b[s.line_type] || 0) + 1;
  }
  let posted = { games: 0, odds_snapshots: 0, requests: 0 };
  if (!dryRun) posted = await S.writeRows(built, env, fetchImpl);
  const summary = {
    ok: built.stats.errors.length === 0, date, dryRun: !!dryRun, started, finished: new Date().toISOString(),
    built: { games: built.games.length, odds_snapshots: built.snaps.length, bySport }, posted, stats: built.stats,
  };
  if (!summary.ok) console.error(`[sync-supabase] ${date} errors: ${JSON.stringify(built.stats.errors).slice(0, 500)}`);
  try { await client.set('supabase-sync', `run/${date}${dryRun ? '-dry' : ''}`, summary); } catch (e) {
    console.error(`[sync-supabase] log write failed: ${e.message}`);
  }
  return summary;
}

async function handle(event, deps = {}) {
  const env = deps.env || process.env;
  if (!S.isAuthorized(event, env)) return S.json(401, { ok: false, error: 'unauthorized' });
  const q = (event && event.queryStringParameters) || {};
  const date = q.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return S.json(400, { ok: false, error: 'bad date' });
  try {
    const summary = await run(date, { env, fetchImpl: deps.fetch, dryRun: q.dryRun === '1' || q.dryRun === 'true', blobs: deps.blobs });
    console.log(`[sync-supabase] ${date} ${JSON.stringify({ built: summary.built, posted: summary.posted })}`);
    return S.json(summary.ok ? 200 : 500, summary);
  } catch (e) {
    console.error(`[sync-supabase] FATAL ${date}: ${e.message}`);
    return S.json(500, { ok: false, date, error: e.message, missingEnv: e.missing });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
exports.run = run;
