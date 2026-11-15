'use strict';

/**
 * Class (c) restorations: late-news QB lookup and parlayFromStraights.
 * Default off. "on" / "1" / "true" / "yes" enables the historical behavior.
 * Read at call time so a test can flip it without a new process.
 */
function missingImportsC() {
  const v = String(process.env.OMEGA_FIX_MISSING_IMPORTS_C || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

module.exports = { missingImportsC };
