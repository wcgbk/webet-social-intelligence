'use strict';

/**
 * Default on. Unset or blank stays on.
 * off, 0, and false turn it off.
 * Pass env in tests. Omit it to read process.env.
 */
function defaultOnFlag(name, env) {
  const source = env == null ? process.env : env;
  const raw = source[name];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
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

module.exports = {
  defaultOnFlag,
  verifyCleanStampEnabled,
  copyVenueCheckEnabled,
  v1BoardMapEnabled,
  ncaamGradeEnabled,
  closesAt3amEnabled,
  closesHistoricalEnabled,
};
