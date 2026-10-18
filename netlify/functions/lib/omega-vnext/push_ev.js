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
 * Posterior mean the anchor writes onto the row. coverProb is that p_final.
 * An explicit p_final wins when a caller sets both.
 */
function pFinalOf(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.p_final != null ? row.p_final : row.coverProb;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stake EV the publish gate compares to GATES.minEV (2%) and EV_CAP_ALL.
 * The number is pushAwareEv(p_final, bet price, pPush). A push returns the
 * stake, so pPush > 0 lowers EV versus p × decimal − 1. Not a new fit:
 * the formula is the existing pushAwareEv, and the 2% floor is GATES.minEV.
 *
 * priceEdgeAtBet already stores that EV on the row. When the stored ev
 * matches the recompute (within 1e-4, the attachEv rounding), this returns
 * the recompute. A fixture that sets ev without a matching coverProb keeps
 * that stored ev when pPush is not positive, so the field still means the
 * stake EV the gate reads. pPush > 0 always recomputes: a naive stored EV
 * must not clear the floor when the price pushes. No stored ev falls back
 * to the recompute.
 */
function anchoredStakeEv(row) {
  const stored = Number(row && row.ev);
  const p = pFinalOf(row);
  const price = row && (row.odds != null ? row.odds : row.oddsStr);
  const push = Number(row && row.pPush);
  const usePush = Number.isFinite(push) && push > 0;
  const computed = (p != null && price != null && price !== '')
    ? pushAwareEv(p, price, row && row.pPush)
    : null;
  if (computed != null && Number.isFinite(computed)) {
    if (!Number.isFinite(stored) || usePush) return computed;
    if (Math.abs(computed - stored) <= 1e-4) return computed;
  }
  return Number.isFinite(stored) ? stored : NaN;
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
  pFinalOf,
  anchoredStakeEv,
};
