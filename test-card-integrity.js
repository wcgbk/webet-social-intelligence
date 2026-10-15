'use strict';
// Regression: 2026-10-15 card. Rays ML had qaHardFails sp_changed yet reached
// the card (A+) and the parlay; summary/narrative named an NFL play not on the
// card; a parlay leg had empty coreReasoning; Hard Rock FAIL passed silently.
const assert = require('assert');
const path = require('path');
const ci = require('./netlify/functions/lib/omega-vnext/card_integrity');
const { finalizeCard } = require('./netlify/functions/lib/omega-vnext/timeline');
const card = require(path.join(__dirname, 'test/fixtures/card-2026-10-15-rays-hardfail.json'));

const isRays = (r) => /Rays/.test(r.pick || r.side || '');
assert.ok(card.picks.some(isRays), 'fixture has the Rays straight');

// 1) One blocked list includes hard fails + rejections + extra.
const blocked = ci.blockedRowsFor(card, [{ pick: 'X', side: 'X' }]);
assert.ok(blocked.some((r) => /sp_changed/.test(r.reason || '')));
assert.ok(blocked.some((r) => r.pick === 'X'));

const out = ci.applyCardIntegrity(card);
const c = out.card;
assert.ok(out.changed);
// Exact Rays scenario: sp_changed hard fail never reaches card or parlay.
assert.ok(!c.picks.some(isRays), 'Rays straight dropped');
for (const pl of c.parlayLegs || []) assert.ok(!pl.legs.some(isRays), 'Rays parlay leg dropped');
assert.deepStrictEqual(c.hardFailGate.droppedStraights, ['Tampa Bay Rays ML']);
// Other picks unchanged in price/EV/grade.
for (const p of c.picks) {
  const orig = card.picks.find((o) => o.pick === p.pick);
  assert.ok(orig);
  assert.strictEqual(p.odds, orig.odds); assert.strictEqual(p.ev, orig.ev); assert.strictEqual(p.grade, orig.grade);
}
// 2) Text and sportsCovered match the final picks.
const sports = [...new Set(c.picks.map((p) => p.sport))];
assert.deepStrictEqual(c.summary.sportsCovered, sports);
assert.ok(!/NFL|Seattle|Denver|Rays/i.test(c.edgeSummary + ' ' + c.insights), 'no off-card play in text');
assert.deepStrictEqual(ci.textProblems(c), []);
// 3) Hard Rock FAIL is flagged on non-placeable picks.
for (const p of c.picks.filter((x) => x.book === 'draftkings')) assert.ok(/Hard Rock/.test(p.placeabilityFlag || ''));
// 4) No empty reasoning anywhere.
for (const r of c.picks.concat(...(c.parlayLegs || []).map((pl) => pl.legs))) assert.ok(String(r.coreReasoning || '').trim(), `reasoning ${r.pick}`);
// WeBetAI one word in rebuilt text.
assert.ok(!/WeBet AI|We Bet AI/.test(c.edgeSummary + c.insights));
// Idempotent: a second pass changes nothing.
assert.strictEqual(ci.applyCardIntegrity(c).changed, false);
// Final 11:00 gate runs the same integrity.
const fin = finalizeCard(card, new Date('2026-10-15T15:00:00Z')).card;
assert.ok(!fin.picks.some(isRays));
// A card with no hard fails and matching text keeps its picks.
const clean = ci.applyCardIntegrity({ ...c, qaHardFails: [] }).card;
assert.strictEqual(clean.picks.length, c.picks.length);
console.log('PASS test-card-integrity');
