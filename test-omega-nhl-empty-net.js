'use strict';
/**
 * Empty-net end game removed 2026-10-17. Season GF/GA already include
 * those goals. enumerate() is the plain Poisson regulation joint plus
 * the OT/shootout split. OMEGA_NHL_EMPTY_NET is ignored.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nhl = require(path.join(root, 'nhl_period'));

function withEnv(name, value, fn) {
  const prev = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function sumMap(map) {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function mapGet(map, k) {
  return map.has(k) ? map.get(k) : 0;
}

function expectedFrom(map) {
  let s = 0;
  for (const [k, p] of map) s += k * p;
  return s;
}

/** Plain Poisson regulation joint, then the same OT goal / shootout split. */
function poissonReference(modelMargin, modelTotal) {
  const reg = nhl.regulationLambdas(modelMargin, modelTotal);
  assert.ok(reg);
  const ph = poissonPmf(reg.lh);
  const pa = poissonPmf(reg.la);
  const tilt = reg.tilt;
  const margin = new Map();
  const total = new Map();
  const add = (map, k, p) => map.set(k, (map.get(k) || 0) + p);
  let pHomeReg = 0;
  let pAwayReg = 0;
  let pTie = 0;
  let pHomeBy2 = 0;
  const max = nhl.MAX_GOALS;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      const p = ph[i] * pa[j];
      if (!(p > 0)) continue;
      if (i > j) {
        pHomeReg += p;
        add(margin, i - j, p);
        add(total, i + j, p);
        if (i - j >= 2) pHomeBy2 += p;
      } else if (i < j) {
        pAwayReg += p;
        add(margin, i - j, p);
        add(total, i + j, p);
      } else {
        pTie += p;
        const pGoal = p * nhl.OT_GOAL_GIVEN_TIE;
        const pSo = p * (1 - nhl.OT_GOAL_GIVEN_TIE);
        add(margin, 1, pGoal * tilt);
        add(margin, -1, pGoal * (1 - tilt));
        add(margin, 0, pSo);
        add(total, i + j + 1, pGoal);
        add(total, i + j, pSo);
      }
    }
  }
  return {
    margin,
    total,
    pHomeReg,
    pAwayReg,
    pTie,
    pHomeBy2,
    pHomeML: pHomeReg + pTie * tilt,
    pAwayML: pAwayReg + pTie * (1 - tilt),
    tilt,
    expectedTotal: expectedFrom(total),
  };
}

function poissonPmf(lambda) {
  const max = nhl.MAX_GOALS;
  const lam = Math.max(0, Number(lambda) || 0);
  const p = new Float64Array(max + 1);
  p[0] = Math.exp(-lam);
  for (let k = 1; k <= max; k++) p[k] = p[k - 1] * lam / k;
  let s = 0;
  for (let k = 0; k <= max; k++) s += p[k];
  if (s > 0) {
    for (let k = 0; k <= max; k++) p[k] /= s;
  }
  return p;
}

function sameMaps(a, b, label) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    assert.strictEqual(mapGet(a, k), mapGet(b, k), `${label} ${k}`);
  }
}

function massWhere(map, pred) {
  let s = 0;
  for (const [k, p] of map) if (pred(k)) s += p;
  return s;
}

assert.deepStrictEqual(config.NHL_EMPTY_NET, { enabled: false });

const scenarios = [
  [0, 6.2],
  [0.15, 6.2],
  [0.6, 6.2],
  [-0.5, 5.8],
  [1.1, 7.1],
  [0, 6.19],
  [-0.3, 6.19],
];

for (const flag of [null, '0', '1', 'on', 'true', 'off']) {
  withEnv('OMEGA_NHL_EMPTY_NET', flag, () => {
    for (const [margin, total] of scenarios) {
      const got = nhl.enumerate(margin, total);
      const ref = poissonReference(margin, total);
      assert.strictEqual(got.emptyNet, false, `emptyNet ${flag} ${margin}`);
      assert.strictEqual(got.pEmptyNetGoal, 0);
      assert.strictEqual(got.expectedEmptyNetGoals, 0);
      sameMaps(got.margin, ref.margin, `margin ${flag} ${margin}`);
      sameMaps(got.total, ref.total, `total ${flag} ${margin}`);
      assert.strictEqual(got.pHomeML, ref.pHomeML);
      assert.strictEqual(got.pAwayML, ref.pAwayML);
      assert.strictEqual(got.pTie, ref.pTie);
      assert.strictEqual(got.pHomeReg, ref.pHomeReg);
      assert.ok(Math.abs(got.expectedTotal - ref.expectedTotal) < 1e-12, `E[total] ${flag} ${margin}`);
      assert.ok(Math.abs(sumMap(got.margin) - 1) < 1e-12);
      assert.ok(Math.abs(sumMap(got.total) - 1) < 1e-12);
    }
  });
}

const flat = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.enumerate(0, 6.19));
assert.ok(Math.abs(flat.expectedTotal - 6.19) < 0.02, `E[total] ${flat.expectedTotal}`);
assert.ok(flat.expectedTotal < 6.25, `empty-net lift is gone ${flat.expectedTotal}`);

// BOS@LAK-style: home margin about -0.3, total 6.19. Over 5.5 stays near
// the plain-Poisson number (~0.57), not the old empty-net ~0.62.
const bosMargin = -0.3;
const bosTotal = 6.19;
const bosRef = poissonReference(bosMargin, bosTotal);
const bosOverRef = massWhere(bosRef.total, (t) => t > 5.5);
const bos = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => {
  const dist = nhl.enumerate(bosMargin, bosTotal);
  const ml = nhl.nhlMarketQuote({
    modelMargin: bosMargin, modelTotal: bosTotal, market: 'ml', sideIsHome: true,
  });
  const mlA = nhl.nhlMarketQuote({
    modelMargin: bosMargin, modelTotal: bosTotal, market: 'ml', sideIsHome: false,
  });
  const pl = nhl.nhlMarketQuote({
    modelMargin: bosMargin, modelTotal: bosTotal, market: 'spread', sideIsHome: true, line: -1.5,
  });
  const over = nhl.nhlMarketQuote({
    modelMargin: bosMargin, modelTotal: bosTotal, market: 'total', side: 'Over', line: 5.5,
  });
  const under = nhl.nhlMarketQuote({
    modelMargin: bosMargin, modelTotal: bosTotal, market: 'total', side: 'Under', line: 5.5,
  });
  return { dist, ml, mlA, pl, over, under };
});
assert.strictEqual(bos.ml.expectedTotal, bos.dist.expectedTotal);
assert.strictEqual(bos.pl.expectedTotal, bos.dist.expectedTotal);
assert.strictEqual(bos.over.expectedTotal, bos.dist.expectedTotal);
assert.strictEqual(bos.ml.pWin, bos.dist.pHomeML);
assert.strictEqual(bos.mlA.pWin, bos.dist.pAwayML);
assert.ok(Math.abs(bos.ml.coverProb + bos.mlA.coverProb - 1) < 1e-12);
assert.ok(Math.abs(bos.pl.pWin - massWhere(bos.dist.margin, (m) => m + -1.5 > 0)) < 1e-12);
assert.ok(Math.abs(bos.over.pWin - bosOverRef) < 1e-12, `over 5.5 ${bos.over.pWin} vs ref ${bosOverRef}`);
assert.ok(bos.over.pWin < 0.60, `BOS@LAK over 5.5 ${bos.over.pWin}`);
assert.ok(bos.over.pWin > 0.52, `BOS@LAK over 5.5 ${bos.over.pWin}`);
assert.strictEqual(bos.over.pPush, 0);
assert.ok(Math.abs(bos.over.pWin + bos.under.pWin - 1) < 1e-12);
assert.ok(Math.abs(bos.dist.expectedTotal - 6.19) < 0.02);
assert.ok(bos.dist.expectedTotal < 6.25);

const whole = nhl.nhlMarketQuote({
  modelMargin: 0.15, modelTotal: 6.2, market: 'spread', sideIsHome: true, line: -1,
});
assert.ok(whole.pPush > 0.05, `puck-line push ${whole.pPush}`);
assert.ok(Math.abs(whole.pWin + whole.pPush + whole.pLoss - 1) < 1e-12);

console.log('test-omega-nhl-empty-net: ok');
