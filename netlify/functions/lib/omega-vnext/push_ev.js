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

/**
 * Fractional Kelly conditional on no push.
 * g(f) = (1 − pPush) * [p ln(1 + f b) + (1 − p) ln(1 − f)], with p and b
 * conditional on no push. The maximiser f* = (p b − (1 − p)) / b does not
 * contain pPush, so the fraction is not scaled by (1 − pPush).
 * Not FITTED. /workspace/audit-scratch/prop.js confirms the old scale is
 * not the numeric optimum. pushAwareEv stays push-aware. pPush is kept
 * so callers do not change. OMEGA_PUSH_EV still gates EV only.
 */
function pushAwareKelly(p, american, fraction, pPush) {
  void pPush;
  return kellyFraction(p, american, fraction);
}

module.exports = {
  pushKeep,
  pushAwareEv,
  pushAwareKelly,
};
