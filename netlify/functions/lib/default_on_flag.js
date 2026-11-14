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

module.exports = {
  defaultOnFlag,
  verifyCleanStampEnabled,
  copyVenueCheckEnabled,
  v1BoardMapEnabled,
};
