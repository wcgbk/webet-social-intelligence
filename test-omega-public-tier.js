'use strict';
// Public card tier is main or lean. Stored cards are not rewritten.
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

function serve(pick) {
  const card = { date: '2026-10-12', picks: [pick], parlayLegs: [] };
  const out = publicCard(card);
  return { out: out.picks[0], card };
}

const floor = { pick: 'Bills -3', units: '0.5u', rating: 'B', odds: '-110', edgePct: '2.1%', sport: 'NFL', tier: 'floor' };
const floorOut = serve(floor);
assert.strictEqual(floorOut.out.tier, 'main');
assert.strictEqual(floorOut.out.units, '0.5u');
assert.strictEqual(floorOut.out.rating, 'B');
assert.strictEqual(floorOut.out.edgePct, '2.1%');
assert.strictEqual(floorOut.out.odds, '-110');
assert.strictEqual(floor.tier, 'floor');

const lean = { pick: 'Jets +3', units: '0.5u', rating: 'B', odds: '+120', edgePct: '1.6%', sport: 'NFL', tier: 'lean' };
assert.strictEqual(serve(lean).out.tier, 'lean');
assert.strictEqual(lean.tier, 'lean');
assert.strictEqual(serve(lean).out.units, '0.5u');

const main = { pick: 'Over 44.5', units: '1u', rating: 'A', odds: '-110', sport: 'NFL', tier: 'main' };
assert.strictEqual(serve(main).out.tier, 'main');

const derived = { pick: 'Under 8.5', units: '0.5u', rating: 'B', odds: '-105', sport: 'NHL', dataVerified: 'lean-tier' };
const derivedOut = serve(derived);
assert.strictEqual(derivedOut.out.tier, 'lean');
assert.strictEqual(derived.dataVerified, 'lean-tier');
assert.strictEqual(derived.tier, undefined);
assert.strictEqual(derivedOut.out.units, '0.5u');
assert.strictEqual(derivedOut.out.rating, 'B');

assert.strictEqual(serve({ pick: 'A', units: '1u', rating: 'A-', odds: '-110', thinSlate: true }).out.tier, 'lean');
assert.strictEqual(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110', isLean: true }).out.tier, 'lean');
assert.strictEqual(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110', lean: true }).out.tier, 'lean');
assert.strictEqual(serve({ pick: 'A', units: '1u', rating: 'Lean', odds: '-110' }).out.tier, 'lean');
assert.strictEqual(serve({ pick: 'A', units: '0.5u', confidence: 'lean', odds: '-110', rating: 'B' }).out.tier, 'lean');
assert.strictEqual(serve({ pick: 'A', units: '0.5u', rating: 'B', odds: '-110' }).out.tier, 'main');

const html = fs.readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
assert.ok(html.includes("p.tier === 'lean'"));
assert.ok(html.includes('badge-lean">Lean'));
assert.ok(/pick-grade-cluster">\$\{ratingHTML\}\$\{leanBadgeHTML\}/.test(html));

console.log('PASS test-omega-public-tier');
