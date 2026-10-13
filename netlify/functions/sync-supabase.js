'use strict';

/**
 * sync-supabase — daily Netlify blob copy into Supabase.
 *
 * Schedule (netlify.toml): "25 13,14 * * *"
 *   13:25 UTC = 9:25am ET (EDT). 14:25 UTC = 9:25am ET (EST).
 *   etGuard keeps 09:25 ET only, after report-clv-omega and
 *   report-tracking-omega (09:15 ET).
 *
 * Default slate is yesterday ET. ?date=YYYY-MM-DD overrides it.
 * ?dryRun=1 builds every row and does not call Supabase.
 * A manual invoke needs the existing admin auth: PICKS_SECRET_KEY
 * (Authorization Bearer, x-picks-secret, or ?key=) or an admin-auth
 * token. Scheduler invocations are allowed through etGuard.
 *
 * Read-only on the card and picks blobs. Optional log blob is the
 * supabase-sync store keyed by the slate date. No Odds API call.
 * No 10:30 lock capture exists; the snapshot line is the 10:00 ET pull.
 */

const sync = require('./lib/supabase-sync');

function contextNow(context) {
  if (context && context.now instanceof Date) return context.now;
  return new Date();
}

function contextDeps(context) {
  if (!context || typeof context !== 'object') return null;
  if (context.deps && typeof context.deps === 'object') return context.deps;
  return null;
}

exports.handler = (event, context) => sync.handle(event, contextNow(context), contextDeps(context));
exports.handle = sync.handle;
exports.buildSync = sync.buildSync;
exports.postRows = sync.postRows;
exports.isAuthorized = sync.isAuthorized;
exports.LOCK_NOTE = sync.LOCK_NOTE;
exports.BATCH_LIMIT = sync.BATCH_LIMIT;
