'use strict';
// The public card does not carry a read-time tier field. Stored cards are not rewritten.
// The Edge page does not render a Lean or Main tag.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { publicCard } = require('./netlify/functions/get-picks-omega');
const { qualityToRating } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { QUALITY_GRADE } = require('./netlify/functions/lib/omega-vnext/config');

assert.strictEqual(QUALITY_GRADE.aplus, 0.05);
assert.strictEqual(QUALITY_GRADE.a, 0.035);
assert.strictEqual(QUALITY_GRADE.aminus, 0.02);
assert.strictEqual(qualityToRating(0.05), 'aplus');
assert.strictEqual(qualityToRating(0.035), 'a');
assert.strictEqual(qualityToRating(0.02), 'aminus');
assert.strictEqual(qualityToRating(0.019), 'b');

function serve(pick, extra) {
  const card = {
    date: '2026-10-12',
    picks: [pick],
    parlayLegs: (extra && extra.parlayLegs) || [],
  };
  const out = publicCard(card);
  return { out: out.picks[0], card, payload: out };
}

function noTier(row, label) {
  assert.ok(row && typeof row === 'object', label);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'tier'), false, label);
}

const floor = { pick: 'Bills -3', units: '0.5u', rating: 'B', odds: '-110', edgePct: '2.1%', sport: 'NFL', tier: 'floor' };
const floorOut = serve(floor);
noTier(floorOut.out, 'floor');
assert.strictEqual(floorOut.out.units, '0.5u');
assert.strictEqual(floorOut.out.rating, 'B');
assert.strictEqual(floorOut.out.edgePct, '2.1%');
assert.strictEqual(floorOut.out.odds, '-110');
assert.strictEqual(floor.tier, 'floor');

const lean = { pick: 'Jets +3', units: '0.5u', rating: 'B', odds: '+120', edgePct: '1.6%', sport: 'NFL', tier: 'lean' };
const leanOut = serve(lean, {
  parlayLegs: [{
    type: '2-leg',
    units: '0.25u',
    legs: [lean, { pick: 'Over 44.5', units: '0.25u', rating: 'B', odds: '-110', sport: 'NFL', tier: 'lean' }],
  }],
});
noTier(leanOut.out, 'lean');
assert.strictEqual(lean.tier, 'lean');
assert.strictEqual(leanOut.out.units, '0.5u');
noTier(leanOut.payload.parlayLegs[0].legs[0], 'parlay leg');
assert.strictEqual(leanOut.payload.parlayLegs[0].units, '0.25u');

const main = { pick: 'Over 44.5', units: '1u', rating: 'A', odds: '-110', sport: 'NFL', tier: 'main' };
noTier(serve(main).out, 'main');

const derived = { pick: 'Under 8.5', units: '0.5u', rating: 'B', odds: '-105', sport: 'NHL', dataVerified: 'lean-tier' };
const derivedOut = serve(derived);
noTier(derivedOut.out, 'derived');
assert.strictEqual(derived.dataVerified, 'lean-tier');
assert.strictEqual(derived.tier, undefined);
assert.strictEqual(derivedOut.out.units, '0.5u');
assert.strictEqual(derivedOut.out.rating, 'B');

noTier(serve({ pick: 'A', units: '1u', rating: 'A-', odds: '-110', thinSlate: true }).out, 'thin');
noTier(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110', isLean: true }).out, 'isLean');
noTier(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110', lean: true }).out, 'lean flag');
noTier(serve({ pick: 'A', units: '1u', rating: 'Lean', odds: '-110' }).out, 'rating lean');
noTier(serve({ pick: 'A', units: '0.5u', confidence: 'lean', odds: '-110', rating: 'B' }).out, 'confidence');
noTier(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110' }).out, 'half unit');

const html = fs.readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
assert.ok(!html.includes("p.tier === 'lean'"));
assert.ok(!html.includes('leanBadgeHTML'));
assert.ok(!html.includes('badge-lean">Lean'));
assert.ok(!html.includes("lean:'Lean'"));
assert.ok(!html.includes('>Main<'));
assert.ok(html.includes('pick-grade-cluster">${ratingHTML}'));

console.log('PASS test-omega-public-tier');
