'use strict';
/**
 * V1 LOCK backend config — SEPARATE from Omega (lib/omega-vnext/config.js is
 * Omega's; V1 never reads its selection settings).
 * Governing doc: NFL-NCAAF-LOCK.md v1.2 (Lock spec for NFL + NCAAF only).
 * Scope (§1, doc title): football only. NHL/NBA/MLB/NCAAM are OUT on V1 —
 * the Lock spec is football-only, so those sports are not scored, not
 * passed-through, and never appear on a V1 card.
 */
const MODEL_VERSION_V1 = 'v1-lock-1.0';
const ENGINE_V1 = 'v1-lock';
const SPORTS_V1 = ['NFL', 'NCAAF'];
/** HFA ratings constants — Lock §7.1 (NFL 2.0, NCAAF 2.6, zero neutral).
 *  footballProjection (shared ratings core) already applies these. */
const HFA_V1 = { NFL: 2.0, NCAAF: 2.6 };
/**
 * Fitted anchor weights (§4.4) — from the preserved modern lineage
 * (c1e5650, walkforward-cal4 expanding-window log-loss fit, 2026-09-22..10-08,
 * n=4160): NFL/NCAAF kMle=1.0 floored to w=0.10; NFL total fitted w=0 exactly
 * (bootstrap median, pure totals model adds no info beyond market), applied
 * as documented in c1e5650's MARKET_ANCHOR_MODEL_WEIGHT. w = model weight:
 * anchored p = w*modelPureP + (1-w)*p_fair(Pinnacle, power de-vig).
 */
const ANCHOR_WEIGHT_V1 = {
  NFL: { spread: 0.10, ml: 0.10, total: 0 },
  NCAAF: { spread: 0.10, ml: 0.10, total: 0.10 },
};
/**
 * Interim NFL margin bias correction (preserved modern lineage config):
 * +1.484 pts measured home-margin bias, subtracted pre-pricing, window
 * 2026-10-18..2026-11-01 (game commence date). Outside window: no correction.
 */
const NFL_BIAS_V1 = { pts: 1.484, from: '2026-10-18', to: '2026-11-01' };
const MAX_STRAIGHTS_V1 = 3; // sheet GOALS.straights (v1/model.js)
const PARLAY_UNITS_V1 = 0.5;
const CORR_HAIRCUT_V1 = 0.95; // per extra leg, Lock changelog v1.2 / §8 task rule
const BLOB_STORE_V1 = 'edge-picks-v1lock';
const OMEGA_BOARD_STORE = 'edge-picks-omega'; // read-only stored-board source
function anchorWeightForV1(sport, market) {
  const t = ANCHOR_WEIGHT_V1[String(sport || '').toUpperCase()];
  if (!t) return null;
  const m = String(market || '');
  if (/total/i.test(m)) return t.total;
  if (/spread/i.test(m)) return t.spread;
  return t.ml;
}
function biasCorrectionForV1(sport, commenceTime) {
  if (String(sport || '') !== 'NFL') return 0;
  const day = String(commenceTime || '').slice(0, 10);
  if (!day || day < NFL_BIAS_V1.from || day > NFL_BIAS_V1.to) return 0;
  return NFL_BIAS_V1.pts;
}
module.exports = {
  MODEL_VERSION_V1, ENGINE_V1, SPORTS_V1, HFA_V1, ANCHOR_WEIGHT_V1,
  NFL_BIAS_V1, MAX_STRAIGHTS_V1, PARLAY_UNITS_V1, CORR_HAIRCUT_V1,
  BLOB_STORE_V1, OMEGA_BOARD_STORE, anchorWeightForV1, biasCorrectionForV1,
};
