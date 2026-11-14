'use strict';
// V1 sharp reads v2 board rows and the v2 parlay pool (pCal / edgeNovig / "+110").
// The sample is ten rows from the 2026-11-14 morning board. No network.
const assert = require('assert');
const S = require('./netlify/functions/lib/omega-v1ab/sharp');
const fixture = require('./test/fixtures/v1-morning-board-2026-11-14.json');

assert.strictEqual(fixture.candidates.length, 10);
assert.ok(!JSON.stringify(fixture).includes('/workspace/'), 'fixture must not store an absolute path');

function poolShape(row) {
  return {
    matchup: row.matchup,
    pick: row.side,
    market: row.market,
    sport: row.sport,
    odds: row.odds,
    commenceTime: row.commenceTime,
    pCal: row.coverProb,
    pMkt: row.pMkt,
    edgeNovig: row.edgePct,
    book: row.book,
  };
}

const rawPool = fixture.candidates.map(poolShape);
const rawMissing = rawPool.filter((row) => {
  const scored = S.calibrateSharp({ ...row, coverProb: undefined, edgePct: undefined, pCal: undefined, edgeNovig: undefined });
  return scored.reason === 'missing coverProb/edge/odds';
});
assert.strictEqual(rawMissing.length, rawPool.length, 'renamed fields are invisible until mapped');

const mapped = fixture.candidates.map((row) => S.calibrateSharp(S.mapCandidateForSharp(row)));
const mappedMissing = mapped.filter((row) => row.reason === 'missing coverProb/edge/odds');
assert.strictEqual(mappedMissing.length, 0, 'board rows with string odds are scored');
mapped.forEach((row) => {
  assert.ok(Number.isFinite(row.coverProb));
  assert.ok(Number.isFinite(row.edgePct));
  assert.ok(Math.abs(row.edgePct) <= 1, 'edgePct stays a fraction');
  assert.ok(Number.isFinite(row.odds));
});

const fromPool = rawPool.map((row) => S.calibrateSharp(row));
const poolMissing = fromPool.filter((row) => row.reason === 'missing coverProb/edge/odds');
assert.strictEqual(poolMissing.length, 0, 'pCal + edgeNovig + string odds are scored');
fromPool.forEach((row, i) => {
  assert.strictEqual(row.side, fixture.candidates[i].side);
  assert.ok(Math.abs(row.coverProb - fixture.candidates[i].coverProb) < 1e-12);
  assert.ok(Math.abs(row.edgePct - fixture.candidates[i].edgePct) < 1e-12);
});

// "3.5%" and 3.5 are percentage points. 0.035 is already a fraction.
assert.strictEqual(S.coerceFraction('3.5%'), 0.035);
assert.strictEqual(S.coerceFraction(3.5), 0.035);
assert.strictEqual(S.coerceFraction(0.035), 0.035);
assert.strictEqual(S.coerceAmerican('+110'), 110);
assert.strictEqual(S.coerceAmerican('-600'), -600);
assert.strictEqual(S.coerceAmerican(110), 110);

const sel = S.selectSharp(rawPool, { nowMs: Date.parse('2026-11-14T15:45:00Z') });
assert.ok(sel.all.every((row) => row.reason !== 'missing coverProb/edge/odds'));

assert.strictEqual(S.v1BoardMapEnabled(), true);
const { buildCard } = require('./netlify/functions/generate-picks-omega-v1-background');

(async () => {
  for (const value of ['off', '0', 'false']) {
    const env = { OMEGA_V1_BOARD_MAP: value };
    assert.strictEqual(S.v1BoardMapEnabled(env), false, value);
    const scored = rawPool.map((row) => S.calibrateSharp(row, { ...S.SHARP, env }));
    assert.ok(scored.every((row) => row.reason === 'missing coverProb/edge/odds'), value);
    const classic = S.calibrateSharp({
      side: 'Classic Side',
      market: 'Moneyline',
      matchup: 'Away Team @ Home Team',
      coverProb: 0.55,
      edgePct: 0.03,
      odds: -110,
      uncertainty: 1,
    }, { ...S.SHARP, env });
    assert.notStrictEqual(classic.reason, 'missing coverProb/edge/odds', value);
    assert.ok(Number.isFinite(classic.pSharp), value);
    assert.strictEqual(classic.odds, -110, value);
    const plusOdds = S.calibrateSharp({
      side: 'Plus Odds',
      market: 'Moneyline',
      matchup: 'Away Team @ Home Team',
      coverProb: 0.55,
      edgePct: 0.03,
      odds: '+110',
      uncertainty: 1,
    }, { ...S.SHARP, env });
    assert.strictEqual(plusOdds.odds, 110, value);
    assert.ok(Number.isFinite(plusOdds.pSharp), value);
    const evenOdds = S.calibrateSharp({
      side: 'Even Odds',
      market: 'Moneyline',
      matchup: 'Away Team @ Home Team',
      coverProb: 0.55,
      edgePct: 0.03,
      odds: 'even',
      uncertainty: 1,
    }, { ...S.SHARP, env });
    assert.strictEqual(evenOdds.reason, 'missing coverProb/edge/odds', value);
  }

  const cardOff = await buildCard({
    parlayPool: rawPool,
    picks: [],
    dateFormatted: 'Saturday, November 14, 2026',
  }, {
    dateISO: '2026-11-14',
    nowMs: Date.parse('2026-11-14T15:45:00Z'),
    env: { OMEGA_V1_BOARD_MAP: 'off' },
  });
  assert.strictEqual(cardOff.picks.length, 0);
  assert.strictEqual(cardOff.rejections.length, rawPool.length);
  assert.ok(cardOff.rejections.every((row) => row.reason === 'missing coverProb/edge/odds'));

  console.log('PASS test-omega-v1-board-map');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
