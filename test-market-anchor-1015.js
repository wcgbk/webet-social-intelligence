'use strict';
// The 2026-10-15 market-anchor flag must not change the published card.
// OMEGA_MARKET_ANCHOR=1 blended the model into Pinnacle, capped EV at 6%,
// and turned lean fill off. That published a 0-pick card. The flag is ignored.
process.env.OMEGA_MARKET_ANCHOR = '1';
const assert = require('assert');
const D = './netlify/functions/lib/omega-vnext/';
const config = require(D + 'config');
const pm = require(D + 'pure_model');
const { quarterKellyUnits } = require(D + 'select');
const { americanToImplied, americanToDecimal, deVigMarket } = require(D + 'odds_math');
const admin = require('./netlify/functions/admin-run-omega-chain-background');

assert.strictEqual(config.marketAnchorOn(), false);
assert.strictEqual(config.LEAN_PAD, true);
assert.strictEqual(config.GATES.maxEV, 0.12);
assert.strictEqual(config.GATES.minEV.NHL, 0.02);

// Blend helpers stay available for CLV research. They do not price the card.
assert.ok(Math.abs(pm.calibratedProbability(0.487, 0.42, 0.9) - (0.1 * 0.487 + 0.9 * 0.42)) < 1e-12);
assert.ok(pm.kFor('NHL', 'Moneyline') >= 0.7);
assert.ok(pm.kFor('MLB', 'Moneyline') >= 0.7);

const dv = deVigMarket([{ side: 'a', american: -120 }, { side: 'b', american: 100 }]);
const fa = dv.find((r) => r.side === 'a').fairP;
assert.ok(Math.abs(fa - (120 / 220) / ((120 / 220) + 0.5)) < 1e-6);

const row = pm.applyPureModelOne({
  sport: 'NHL', market: 'Moneyline', odds: 130, modelPureP: 0.487,
  pinnacleNoVigP: 0.42, book: 'draftkings',
});
const implied = americanToImplied(130);
const dec = americanToDecimal(130);
assert.strictEqual(row.pureModelPriced, true);
assert.strictEqual(row.coverProb, 0.487);
assert.ok(Math.abs(row.edgePct - (0.487 - implied)) < 1e-6, row.edgePct);
assert.ok(Math.abs(row.ev - (0.487 * dec - 1)) < 1e-6, row.ev);
assert.strictEqual(row.edgeBasis, 'pure-model-edge-vs-bet-price');
assert.notStrictEqual(row.coverProb, 0.42);

// A missing Pinnacle fair does not skip a pure-model price.
const none = pm.applyPureModelOne({
  sport: 'NHL', market: 'Moneyline', odds: 130, modelPureP: 0.5, book: 'draftkings',
});
assert.strictEqual(none.coverProb, 0.5);
assert.notStrictEqual(none.fairMissing, true);

const gates = require(D + 'gates');
const reasonFn = gates.gateReason;
assert.strictEqual(typeof reasonFn, 'function');
// 7% EV is inside the 12% stale cap. It is not an empty-card reject.
assert.strictEqual(reasonFn({
  ...row, ev: 0.07, coverProb: 0.5, edgePct: 0.03, p_fair: 0.47, pureModelPriced: true, liquid: true,
}), null);
// 1.5% edge versus the price is a lean candidate, not a Pinnacle floor.
assert.notStrictEqual(reasonFn({
  sport: 'MLB', market: 'Moneyline', odds: 130, coverProb: 0.45, ev: 0.015,
  edgePct: 0.015, p_fair: 0.435, pureModelPriced: true, liquid: true,
}), 'edge-floor-vs-fair');
assert.notStrictEqual(reasonFn({
  sport: 'MLB', market: 'Moneyline', odds: 130, coverProb: 0.45, ev: 0.0,
  edgePct: 0, p_fair: 0.45, pureModelPriced: true, liquid: true,
}), 'no-edge-vs-fair');
// Above 12% stays stale.
assert.strictEqual(reasonFn({
  ...row, ev: 0.13, coverProb: 0.7, edgePct: 0.1, pureModelPriced: true, liquid: true,
}), 'ev-stale');

assert.strictEqual(quarterKellyUnits(0.55, -110), 1.5);
// 2026-10-18: the 0.5u floor left quarterKellyUnits. 0.53 at -110 rounds to 0.25u.
assert.strictEqual(quarterKellyUnits(0.53, -110), 0.25);
assert.strictEqual(quarterKellyUnits(0.54, -110), 0.75);

const narrate = require(D + 'narrate');
const empty = narrate.buildCardFallbackCopy({ picks: [] });
assert.ok(empty.edgeSummary && empty.edgeSummary.length > 10);
const ins = narrate.buildCardFallbackCopy({ picks: [{ sport: 'MLB', pick: 'Milwaukee Brewers ML' }] }).insights;
assert.ok(/one straight and no parlay/.test(ins) && !/small parlay/.test(ins));

assert.strictEqual(admin.tokenOk({ headers: { 'x-admin-token': 'x' } }), false);

const c = {
  sport: 'NHL', market: 'Moneyline', odds: 320, modelPureP: 0.3, book: 'draftkings',
  pinnacleSide: { american: 300, oppAmerican: -400 }, pinnacleNoVigP: 0.2353,
};
const pf = pm.fairProbability(c);
assert.ok(pf > 0 && pf < 0.2353, `power fair ${pf}`);

const pub = require('./netlify/functions/lib/public-picks');
const fnPub = pub.publicPicksPayload || Object.values(pub).find((f) => typeof f === 'function');
const out = fnPub({ picks: [{ pick: 'X', matchup: 'A @ B', placeabilityFlag: 'Not available at Hard Rock.' }] });
assert.strictEqual(out.picks[0].placeabilityFlag, 'Not available at Hard Rock.');

console.log('PASS test-market-anchor-1015');
