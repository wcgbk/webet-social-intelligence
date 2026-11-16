'use strict';

/**
 * Class (c) restorations: late-news QB lookup and parlayFromStraights.
 * OMEGA_FIX_MISSING_IMPORTS_C.
 * Unset uses the default below. on / 1 / true / yes are on.
 * off / 0 / false / blank are off. Any other value is off.
 * Blank stays off even when the default is on.
 */
const MISSING_IMPORTS_DEFAULT_ON = true;

function parseEnvFlag(name, defaultOn, env) {
  const source = env == null ? process.env : env;
  if (source == null || source[name] == null) return !!defaultOn;
  const v = String(source[name]).trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === '') return false;
  return false;
}

function missingImportsC(env) {
  return parseEnvFlag('OMEGA_FIX_MISSING_IMPORTS_C', MISSING_IMPORTS_DEFAULT_ON, env);
}

module.exports = { missingImportsC, parseEnvFlag, MISSING_IMPORTS_DEFAULT_ON };
