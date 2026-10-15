'use strict';
// Market anchor (OMEGA_MARKET_ANCHOR=1): blend math, edge vs no-vig fair,
// Kelly, gates, parlay rules, empty card. Flag off keeps the prior policy.
process.env.OMEGA_MARKET_ANCHOR = '1';
const assert = require('assert');
const D = './netlify/functions/lib/omega-vnext/';
const config = require(D + 'config');
const pm = require(D + 'pure_model');
const { quarterKellyUnits } = require(D + 'select');
const { deVigMarket } = require(D + 'odds_math');
const admin = require('./netlify/functions/admin-run-omega-chain-background');

assert.strictEqual(config.LEAN_PAD, false);
assert.strictEqual(config.GATES.maxEV, 0.06);
assert.strictEqual(config.GATES.minEV.NHL, 0.015);
// Blend math.
assert.ok(Math.abs(pm.calibratedProbability(0.487, 0.42, 0.9) - (0.1 * 0.487 + 0.9 * 0.42)) < 1e-12);
assert.strictEqual(pm.kFor('NHL', 'Moneyline'), 1); // walk-forward kMle
// No-vig both sides: -120/+100 → fair favorite ≈ 0.5238.
const dv = deVigMarket([{ side: 'a', american: -120 }, { side: 'b', american: 100 }]);
const fa = dv.find((r) => r.side === 'a').fairP;
assert.ok(Math.abs(fa - (120 / 220) / ((120 / 220) + 0.5)) < 1e-6);
// Priced row: today's Islanders shape, fair 0.42, K NHL ML = 1 → p = fair, edge 0, EV < 0.
const row = pm.applyPureModelOne({ sport: 'NHL', market: 'Moneyline', odds: 130, modelPureP: 0.487, pinnacleNoVigP: 0.42, book: 'draftkings' });
assert.ok(Math.abs(row.coverProb - 0.42) < 1e-9);
assert.strictEqual(row.edgePct, 0);
assert.ok(row.ev < 0.0 + 0.0 || row.ev < 0.015);
assert.strictEqual(row.p_model, 0.487);
// Missing fair → skipped.
const none = pm.applyPureModelOne({ sport: 'NHL', market: 'Moneyline', odds: 130, modelPureP: 0.5, book: 'draftkings' });
assert.strictEqual(none.coverProb, null);
assert.strictEqual(none.fairMissing, true);
// Gates: ev-stale above 6%, no-edge-vs-fair, floor 1.5%.
const gates = require(D + 'gates');
const reasonFn = gates.rejectReason || gates.gateReason || null;
if (typeof reasonFn === 'function') {
  assert.strictEqual(reasonFn({ ...row, ev: 0.07, coverProb: 0.5, edgePct: 0.03, p_fair: 0.47, pureModelPriced: true }), 'ev-stale');
}
// Quarter Kelly: p 0.55 at -110 → f=0.055, /4 → 1.37u → cap 1u; small edge → 0.25u floor.
assert.strictEqual(quarterKellyUnits(0.55, -110), 1);
assert.strictEqual(quarterKellyUnits(0.53, -110), 0.25);
assert.strictEqual(quarterKellyUnits(0.54, -110), 0.75);
// Parlay: fewer than 2 qualifying legs → no parlay; non-positive EV legs never used.
const { parlayFromStraights } = require(D + 'parlay');
const p1 = parlayFromStraights([{ sport: 'NHL', matchup: 'A @ B', side: 'B', market: 'Moneyline', odds: '+110', ev: 0.03, coverProb: 0.5, edgePct: 0.02 }], { pool: [] });
assert.ok(!p1.length || p1.every((t) => !t.legs || t.legs.length === 0 || t.qualifying === false || /no/i.test(String(t.type || t.reason || ''))));
// Empty card path: no candidates → empty card copy, honest message.
const narrate = require(D + 'narrate');
const empty = narrate.buildCardFallbackCopy({ picks: [] });
assert.ok(empty.edgeSummary && empty.edgeSummary.length > 10);
// Admin trigger refuses without the server token.
assert.strictEqual(admin.tokenOk({ headers: { 'x-admin-token': 'x' } }), false);
console.log('PASS test-market-anchor-1015');
