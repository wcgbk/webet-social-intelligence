'use strict';

/**
 * parlayFromStraights and isNoQualifyingParlay left parlay.js in 61b9152.
 * parlay.js is frozen, so callers require this sibling.
 * isNoQualifyingParlay is the historical predicate (class a).
 * parlayFromStraights throws until OMEGA_FIX_MISSING_IMPORTS_C is on,
 * which is the pre-restore TypeError. The historical body loads only then.
 */
const { missingImportsC } = require('./missing_import_flag');

const NO_QUALIFYING_PARLAY = 'no qualifying parlay';

function isNoQualifyingParlay(ticket) {
  if (!ticket || typeof ticket !== 'object') return false;
  return ticket.qualifying === false
    || ticket.status === NO_QUALIFYING_PARLAY
    || ticket.type === 'no-qualifying-parlay';
}

function parlayFromStraights(straights, opts) {
  if (!missingImportsC()) throw new TypeError('parlayFromStraights is not a function');
  return require('./parlay_straights_impl').parlayFromStraights(straights, opts);
}

module.exports = { parlayFromStraights, isNoQualifyingParlay };
