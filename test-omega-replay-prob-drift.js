'use strict';
// PROB_DRIFT is separate from the dollar gate. Harness lives outside the repo.
const assert = require('assert');
const diff = require('/workspace/omega-replay-2w/diff');

function pick(over) {
  return {
    sport: 'MLB',
    matchup: 'Baltimore Orioles @ New York Yankees',
    pick: 'Over 8.5',
    betType: 'Total',
    line: 8.5,
    odds: '-110',
    units: '1u',
    commenceTime: '2026-09-25T20:05:00Z',
    p_model: 0.54,
    p_cal: 0.52,
    ev: '4.0%',
    modelProjection: 9.1,
    ...over,
  };
}

const same = diff.probDriftBetween(
  { picks: [pick()], parlay: [] },
  { picks: [pick()], parlay: [] },
  '2026-09-25'
);
assert.strictEqual(same.length, 0);

const moved = diff.probDriftBetween(
  { picks: [pick(), pick({ commenceTime: '2026-09-25T23:06:00Z', pick: 'Over 9', line: 9, p_model: 0.51 })] },
  { picks: [pick({ p_model: 0.57, ev: '6.2%', modelProjection: 9.6 }), pick({ commenceTime: '2026-09-25T23:06:00Z', pick: 'Over 9', line: 9, p_model: 0.51 })] },
  '2026-09-25'
);
assert.strictEqual(moved.length, 1);
assert.strictEqual(moved[0].commenceTime, '2026-09-25T20:05:00Z');
assert.strictEqual(moved[0].moved.p_model.before, 0.54);
assert.strictEqual(moved[0].moved.p_model.after, 0.57);
assert.ok(moved[0].moved.ev);
assert.ok(moved[0].moved.modelProjection);
assert.ok(!moved[0].moved.p_cal, 'unchanged p_cal is not listed');

const missingField = diff.probDriftBetween(
  { picks: [pick({ p_cal: undefined })] },
  { picks: [pick({ p_cal: 0.61 })] },
  '2026-09-25'
);
assert.strictEqual(missingField.length, 0, 'a field recorded on only one side is not drift');

const leg = pick({ pick: 'Under 8.5', p_model: 0.48 });
const parlayMove = diff.probDriftBetween(
  { picks: [], parlay: [{ legs: [leg] }] },
  { picks: [], parlay: [{ legs: [pick({ pick: 'Under 8.5', p_model: 0.41 })] }] },
  '2026-09-25'
);
assert.strictEqual(parlayMove.length, 1);
assert.strictEqual(parlayMove[0].moved.p_model.after, 0.41);

const day = pick();
const night = pick({ commenceTime: '2026-09-25T23:06:00Z' });
assert.notStrictEqual(diff.straightKey(day), diff.straightKey(night));
assert.notStrictEqual(diff.probIdentity(day), diff.probIdentity(night));

console.log('PASS test-omega-replay-prob-drift');
