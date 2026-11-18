'use strict';

/**
 * Default on. Unset or blank stays on.
 * off, 0, false, and no turn it off.
 * Pass env in tests. Omit it to read process.env.
 */
function defaultOnFlag(name, env) {
  const source = env == null ? process.env : env;
  const raw = source[name];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false' && text !== 'no';
}

function verifyCleanStampEnabled(env) {
  return defaultOnFlag('OMEGA_VERIFY_CLEAN_STAMP', env);
}

function copyVenueCheckEnabled(env) {
  return defaultOnFlag('OMEGA_COPY_VENUE_CHECK', env);
}

function v1BoardMapEnabled(env) {
  return defaultOnFlag('OMEGA_V1_BOARD_MAP', env);
}

function ncaamGradeEnabled(env) {
  return defaultOnFlag('OMEGA_NCAAM_GRADE', env);
}

/** 3 AM close worker. Default on. off / 0 / false skips the worker.
 *  The worker writes closes from saved boards. It does not buy historical odds.
 *  off / 0 / false restores the 5-minute close job. */
function closesAt3amEnabled(env) {
  return defaultOnFlag('OMEGA_CLOSES_AT_3AM', env);
}

/**
 * Paid historical closes. Default OFF.
 * Unset, blank, off, 0, and false stay off.
 * Only on, 1, true, and yes turn it on.
 * OMEGA_CLOSES_HISTORICAL=on restores the old historical-close path.
 */
function closesHistoricalEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source.OMEGA_CLOSES_HISTORICAL;
  if (raw == null || String(raw).trim() === '') return false;
  const text = String(raw).trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/** One pull per ET date and slot. off / 0 / false / no restores the unlocked pull. */
function pullSlotLockEnabled(env) {
  return defaultOnFlag('OMEGA_PULL_SLOT_LOCK', env);
}

/**
 * Drop columns clv.games / clv.odds_snapshots do not have before the Supabase post.
 * off / 0 / false / no sends the payload unchanged.
 */
function closesSupaWhitelistEnabled(env) {
  return defaultOnFlag('OMEGA_CLOSES_SUPA_WHITELIST', env);
}

/** Re-upsert clv.daily_results from the graded day. off / 0 / false / no keeps the cache-only mirror. */
function dailyResultsResyncEnabled(env) {
  return defaultOnFlag('OMEGA_DAILY_RESULTS_RESYNC', env);
}

/**
 * Today's ET date with no card yet is not a pass day.
 * off / 0 / false / no restores the no-picks placeholder and the old mirror rank.
 */
function kpiTodayPendingEnabled(env) {
  return defaultOnFlag('OMEGA_KPI_TODAY_PENDING', env);
}

/**
 * ESPN merge: a final score beats a stale in-progress copy of the same game.
 * off / 0 / false / no restores in-progress over final and the raw start string.
 */
function gradeFinalWinsEnabled(env) {
  return defaultOnFlag('OMEGA_GRADE_FINAL_WINS', env);
}

/**
 * CLV only when market, side, and line match, or a documented point adjustment
 * already produced clvMethod converted or alt-line. off restores the prior record.
 */
function clvLineMatchEnabled(env) {
  return defaultOnFlag('OMEGA_CLV_LINE_MATCH', env);
}

/**
 * Default deploy allowlist also accepts actors that start with webet-executor-.
 * An explicit OMEGA_DEPLOY_ACTORS list stays exact-match only.
 * off / 0 / false / no drops the prefix and keeps exact names only.
 */
function deployActorPrefixEnabled(env) {
  return defaultOnFlag('OMEGA_DEPLOY_ACTOR_PREFIX', env);
}

/**
 * Use the latest saved Pinnacle price after the 10 AM ET pull and before
 * commence. Default OFF. Only on / 1 / true / yes enable it.
 * Unset leaves the close-window chooser unchanged.
 */
function clvLatestSavedEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source.OMEGA_CLV_LATEST_SAVED;
  if (raw == null || String(raw).trim() === '') return false;
  const text = String(raw).trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

module.exports = {
  defaultOnFlag,
  verifyCleanStampEnabled,
  copyVenueCheckEnabled,
  v1BoardMapEnabled,
  ncaamGradeEnabled,
  closesAt3amEnabled,
  closesHistoricalEnabled,
  pullSlotLockEnabled,
  closesSupaWhitelistEnabled,
  dailyResultsResyncEnabled,
  kpiTodayPendingEnabled,
  gradeFinalWinsEnabled,
  clvLineMatchEnabled,
  deployActorPrefixEnabled,
  clvLatestSavedEnabled,
};
