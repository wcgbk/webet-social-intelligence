'use strict';

const { evAtOdds, kellyFraction } = require('./odds_math');
const { pushEvEnabled } = require('./gaps_flags');

function pushKeep(pPush) {
  const push = Number(pPush);
  if (!Number.isFinite(push) || push <= 0) return 1;
  if (push >= 0.5) return 0.5;
  return 1 - push;
}

/**
 * Stake EV when the posted price pushes.
 * coverProb is P(win | no push), the same object a two-way de-vig quotes.
 * A push returns the stake, so EV = (1 − P(push)) × (p_cond × decimal − 1).
 * Missing or zero push leaves evAtOdds unchanged.
 */
function pushAwareEv(p, american, pPush) {
  const naive = evAtOdds(p, american);
  if (naive == null || !pushEvEnabled()) return naive;
  return naive * pushKeep(pPush);
}

/** Quarter-Kelly scaled by the same (1 − P(push)) factor. */
function pushAwareKelly(p, american, fraction, pPush) {
  const base = kellyFraction(p, american, fraction);
  if (!pushEvEnabled()) return base;
  return base * pushKeep(pPush);
}

module.exports = {
  pushKeep,
  pushAwareEv,
  pushAwareKelly,
};
