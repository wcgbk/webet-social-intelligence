'use strict';

const { closesHistoricalEnabled } = require('./default_on_flag');

/**
 * Paid Odds API /historical/ calls stay off unless OMEGA_CLOSES_HISTORICAL
 * is explicitly on. Unset, blank, off, 0, and false refuse. Manual
 * missingGames / retryNoClose invokes use the same switch.
 */
function assertHistoricalOddsAllowed(env, where) {
  if (closesHistoricalEnabled(env)) return;
  const err = new Error(`historical odds refused${where ? ` (${where})` : ''}: OMEGA_CLOSES_HISTORICAL is not on`);
  err.code = 'HISTORICAL_ODDS_REFUSED';
  throw err;
}

module.exports = { assertHistoricalOddsAllowed };
