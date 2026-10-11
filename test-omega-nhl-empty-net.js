'use strict';
/**
 * Empty-net end game on the NHL regulation joint.
 * OMEGA_NHL_EMPTY_NET=0 is the pre-change Poisson + OT/shootout distribution.
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
  const max = nhl.MAX_GOALS;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      const p = ph[i] * pa[j];
      if (!(p > 0)) continue;
      if (i > j) {
        pHomeReg += p;
        add(margin, i - j, p);
        add(total, i + j, p);
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
    pHomeML: pHomeReg + pTie * tilt,
    pAwayML: pAwayReg + pTie * (1 - tilt),
    tilt,
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

function pAbsMargin(dist, pred) {
  let s = 0;
  for (const [m, p] of dist.margin) {
    if (pred(Math.abs(m))) s += p;
  }
  return s;
}

function assertDistribution(dist, label) {
  assert.ok(Math.abs(sumMap(dist.margin) - 1) < 1e-12, `${label} margin ${sumMap(dist.margin)}`);
  assert.ok(Math.abs(sumMap(dist.total) - 1) < 1e-12, `${label} total ${sumMap(dist.total)}`);
  assert.ok(Math.abs(dist.pHomeReg + dist.pAwayReg + dist.pTie - 1) < 1e-12, `${label} reg`);
  assert.ok(Math.abs(dist.pHomeML + dist.pAwayML - 1) < 1e-12, `${label} ml`);
  assert.strictEqual(dist.pHomeML, dist.pHomeReg + dist.pTie * dist.tilt);
  assert.strictEqual(dist.pAwayML, dist.pAwayReg + dist.pTie * (1 - dist.tilt));
}

const cfg = config.NHL_EMPTY_NET;
assert.strictEqual(typeof cfg.enabled, 'boolean');
assert.strictEqual(cfg.pullMinDown1, 2);
assert.strictEqual(cfg.pullMinDown2, 3);
assert.strictEqual(cfg.rateLeaderEN60, 18);
assert.strictEqual(cfg.rateTrailer6v5_60, 7.2);

const scenarios = [
  [0, 6.2],
  [0.15, 6.2],
  [0.6, 6.2],
  [-0.5, 5.8],
  [1.1, 7.1],
];

for (const flag of ['0', 'off', 'false', 'no']) {
  withEnv('OMEGA_NHL_EMPTY_NET', flag, () => {
    assert.strictEqual(nhl.emptyNetEnabled(), false);
    for (const [margin, total] of scenarios) {
      const got = nhl.enumerate(margin, total);
      const ref = poissonReference(margin, total);
      assert.strictEqual(got.emptyNet, false);
      assert.strictEqual(got.pEmptyNetGoal, 0);
      sameMaps(got.margin, ref.margin, `margin ${flag} ${margin}`);
      sameMaps(got.total, ref.total, `total ${flag} ${margin}`);
      assert.strictEqual(got.pHomeML, ref.pHomeML);
      assert.strictEqual(got.pAwayML, ref.pAwayML);
      assert.strictEqual(got.pTie, ref.pTie);
      assert.strictEqual(got.pHomeReg, ref.pHomeReg);
    }
  });
}

for (const [margin, total] of scenarios) {
  const on = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.enumerate(margin, total));
  const off = withEnv('OMEGA_NHL_EMPTY_NET', '0', () => nhl.enumerate(margin, total));
  assert.strictEqual(on.emptyNet, true);
  assertDistribution(on, `on ${margin}`);
  assertDistribution(off, `off ${margin}`);

  const by2On = pAbsMargin(on, (a) => a >= 2);
  const by2Off = pAbsMargin(off, (a) => a >= 2);
  assert.ok(by2On > by2Off, `|margin|>=2 ${margin}: ${by2On} vs ${by2Off}`);
  const winOn = on.pHomeReg + on.pAwayReg;
  const winOff = off.pHomeReg + off.pAwayReg;
  assert.ok(by2On / winOn > by2Off / winOff, `|margin|>=2 | regulation winner ${margin}`);
  assert.ok(on.expectedTotal > off.expectedTotal, `total rises ${margin}`);
  assert.ok(on.expectedTotal - off.expectedTotal < 0.6, `total rise stays modest ${on.expectedTotal - off.expectedTotal}`);
  assert.ok(on.pEmptyNetGoal > 0.15 && on.pEmptyNetGoal < 0.45, `EN share ${on.pEmptyNetGoal}`);

  const ml = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
    modelMargin: margin, modelTotal: total, market: 'ml', sideIsHome: true,
  }));
  const mlA = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
    modelMargin: margin, modelTotal: total, market: 'ml', sideIsHome: false,
  }));
  assert.strictEqual(ml.pWin, on.pHomeML);
  assert.strictEqual(mlA.pWin, on.pAwayML);
  assert.strictEqual(ml.pPush, 0);
  assert.ok(Math.abs(ml.coverProb + mlA.coverProb - 1) < 1e-12);

  const sideHome = margin >= 0;
  const plOn = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
    modelMargin: margin, modelTotal: total, market: 'spread', sideIsHome: sideHome, line: -1.5,
  }));
  const plOff = withEnv('OMEGA_NHL_EMPTY_NET', '0', () => nhl.nhlMarketQuote({
    modelMargin: margin, modelTotal: total, market: 'spread', sideIsHome: sideHome, line: -1.5,
  }));
  assert.ok(plOn.pWin > plOff.pWin, `favorite -1.5 rises ${margin}`);
  if (sideHome) {
    assert.ok(Math.abs(plOn.pWin - on.pHomeBy2) < 1e-12, `−1.5 is home regulation margin ≥ 2 (${plOn.pWin} vs ${on.pHomeBy2})`);
  }

  let prevOver = 1;
  for (const line of [3.5, 4.5, 5.5, 6.5, 7.5, 8.5]) {
    const over = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
      modelMargin: margin, modelTotal: total, market: 'total', side: 'Over', line,
    }));
    assert.strictEqual(over.pPush, 0, `half line ${line}`);
    assert.ok(over.pWin < prevOver, `over ${line} monotone ${over.pWin} vs ${prevOver}`);
    prevOver = over.pWin;
    const under = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
      modelMargin: margin, modelTotal: total, market: 'total', side: 'Under', line,
    }));
    assert.ok(Math.abs(over.pWin + under.pWin - 1) < 1e-12, `half ${line}`);
  }

  for (const line of [4, 5, 6, 7]) {
    const over = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
      modelMargin: margin, modelTotal: total, market: 'total', side: 'Over', line,
    }));
    const under = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
      modelMargin: margin, modelTotal: total, market: 'total', side: 'Under', line,
    }));
    let atom = 0;
    for (const [t, p] of on.total) if (t === line) atom += p;
    assert.ok(atom > 0, `push atom ${line}`);
    assert.strictEqual(over.pPush, atom);
    assert.strictEqual(under.pPush, atom);
    assert.ok(Math.abs(over.pWin + over.pPush + over.pLoss - 1) < 1e-12, `whole ${line}`);
    assert.ok(over.pWin > 0 && under.pWin > 0);
  }
}

let prevTotal = 0;
let prevOver = 0;
for (const total of [5.0, 5.8, 6.2, 6.9, 7.6]) {
  const dist = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.enumerate(0.15, total));
  const over = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
    modelMargin: 0.15, modelTotal: total, market: 'total', side: 'Over', line: 6,
  }));
  assert.ok(dist.expectedTotal > prevTotal, `E[total] monotone at ${total}`);
  assert.ok(over.pWin > prevOver, `P(over 6) monotone at ${total}`);
  prevTotal = dist.expectedTotal;
  prevOver = over.pWin;
}

const wholeSpread = withEnv('OMEGA_NHL_EMPTY_NET', '1', () => nhl.nhlMarketQuote({
  modelMargin: 0.15, modelTotal: 6.2, market: 'spread', sideIsHome: true, line: -1,
}));
assert.ok(wholeSpread.pPush > 0.05, `puck-line push ${wholeSpread.pPush}`);
assert.ok(Math.abs(wholeSpread.pWin + wholeSpread.pPush + wholeSpread.pLoss - 1) < 1e-12);

console.log('test-omega-nhl-empty-net: ok');
