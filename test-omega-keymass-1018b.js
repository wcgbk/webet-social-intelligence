'use strict';
// Moment-matched key PMF: mean/SD, explicit push, 0.03 rail, ARI +12.5.
const assert = require('assert');
const km = require('./netlify/functions/lib/omega-vnext/key_mass');

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a} (Δ ${a - b})`);
}

function withEnv(value, fn) {
  const prev = Object.prototype.hasOwnProperty.call(process.env, 'OMEGA_KEY_MASS')
    ? process.env.OMEGA_KEY_MASS
    : undefined;
  if (value == null) delete process.env.OMEGA_KEY_MASS;
  else process.env.OMEGA_KEY_MASS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.OMEGA_KEY_MASS;
    else process.env.OMEGA_KEY_MASS = prev;
  }
}

/** Plain normal with an explicit integer push. Same atoms as key_mass. */
function plainSpread(mean, line, std) {
  const thresh = -line;
  const integer = Math.abs(line - Math.round(line)) < 1e-6;
  if (!integer) return km.normCdfOpen((mean + line) / std);
  const k = Math.round(thresh);
  const pPush = km.normalBin(mean, std, k);
  const pWin = 1 - km.normCdfOpen((k + 0.5 - mean) / std);
  if (pPush > 1e-15 && pPush < 1) return pWin / (1 - pPush);
  return pWin;
}

function plainMl(mean, std) {
  const pPush = km.normalBin(mean, std, 0);
  const pWin = 1 - km.normCdfOpen((0.5 - mean) / std);
  if (pPush > 1e-15 && pPush < 1) return pWin / (1 - pPush);
  return pWin;
}

function pmfMoments(mean, sport, sd) {
  let s = 0;
  let m1 = 0;
  let m2 = 0;
  for (let k = -70; k <= 70; k++) {
    const p = km.marginBin(mean, k, sport, sd);
    assert.ok(p != null && p >= 0, `bin ${sport} ${mean} ${k}`);
    s += p;
    m1 += k * p;
    m2 += k * k * p;
  }
  const mu = m1 / s;
  return { s, mu, sd: Math.sqrt(Math.max(0, m2 / s - mu * mu)) };
}

// Default quote is the plain normal. The PMF lost the 855-row ML log-loss.
withEnv(null, () => {
  const ari = km.spreadQuote(-3.62, 12.5, 'NFL', 13.9);
  const plain = plainSpread(-3.62, 12.5, 13.9);
  near(ari.coverProb, plain, 1e-12, 'default ARI +12.5 is the plain normal');
  assert.strictEqual(ari.pPush, 0, 'half-point default has no push');
  const integer = km.spreadQuote(-3.62, 3, 'NFL', 13.9);
  near(integer.pPush, km.normalBin(-3.62, 13.9, -3), 1e-12, 'default integer push is the normal atom');
  assert.strictEqual(km.spreadQuote(-3.62, 3.5, 'NFL', 13.9).pPush, 0);
});

withEnv('0', () => {
  const ari = km.spreadQuote(-3.62, 12.5, 'NFL', 13.9);
  near(ari.coverProb, plainSpread(-3.62, 12.5, 13.9), 1e-12, 'OMEGA_KEY_MASS=0 stays on the normal');
});

withEnv('1', () => {
  for (const sport of ['NFL', 'NCAAF']) {
    for (let mean = -14; mean <= 14; mean++) {
      for (let sd = 10; sd <= 17; sd++) {
        const m = pmfMoments(mean, sport, sd);
        near(m.s, 1, 1e-8, `mass ${sport} ${mean} ${sd}`);
        near(m.mu, mean, 0.05, `mean ${sport} μ=${mean} sd=${sd} got ${m.mu}`);
        near(m.sd, sd, 0.1, `sd ${sport} μ=${mean} sd=${sd} got ${m.sd}`);
      }
    }
  }
  const ariMoments = pmfMoments(-3.62, 'NFL', 13.9);
  near(ariMoments.mu, -3.62, 0.05, 'ARI mean');
  near(ariMoments.sd, 13.9, 0.1, 'ARI sd');

  const pushCases = [
    [-3.62, 3, 'NFL', 13.9],
    [3, -3, 'NFL', 13.5],
    [0, 7, 'NFL', 13.22],
    [-1, 0, 'NFL', 13.5],
    [4, -7, 'NCAAF', 16],
  ];
  for (const [mean, line, sport, sd] of pushCases) {
    const q = km.spreadQuote(mean, line, sport, sd);
    const at = Math.round(-line);
    near(q.pPush, km.marginBin(mean, at, sport, sd), 1e-12, `push ${sport} ${line}`);
    assert.ok(q.pPush > 0, `integer push mass ${sport} ${line}`);
  }
  for (const line of [12.5, -2.5, 0.5, -7.5, 3.5]) {
    assert.strictEqual(km.spreadQuote(-3.62, line, 'NFL', 13.9).pPush, 0, `half ${line}`);
  }
  assert.strictEqual(km.spreadQuote(1.5, 0, 'NCAAF', 16).pPush, 0, 'NCAAF pickem does not push');

  // ASSUMED caps: 0.03 everywhere, and < 0.01 once the line is 10+ points from the mean.
  const means = [];
  for (let m = -14; m <= 14; m++) means.push(m);
  means.push(-3.62);
  const sds = [10, 13, 13.9, 17];
  for (const mean of means) {
    for (const sd of sds) {
      for (let line2 = -40; line2 <= 40; line2++) {
        const line = line2 / 2;
        const q = km.spreadQuote(mean, line, 'NFL', sd);
        const plain = plainSpread(mean, line, sd);
        const dist = Math.abs(mean + line);
        const delta = Math.abs(q.coverProb - plain);
        const cap = dist >= 10 ? 0.01 : 0.03;
        assert.ok(delta <= cap + 1e-9, `rail μ=${mean} L=${line} sd=${sd} Δ=${delta} dist=${dist}`);
        if (dist >= 10) assert.ok(delta < 0.01, `far rail ${delta}`);
      }
      for (const sport of ['NFL', 'NCAAF']) {
        const q = km.mlQuote(mean, sport, sd);
        const plain = sport === 'NCAAF'
          ? (1 - km.normCdfOpen((0.5 - mean) / sd)) + 0.5 * km.normalBin(mean, sd, 0)
          : plainMl(mean, sd);
        const delta = Math.abs(q.coverProb - plain);
        const dist = Math.abs(mean);
        const cap = dist >= 10 ? 0.01 : 0.03;
        assert.ok(delta <= cap + 1e-9, `ml rail ${sport} μ=${mean} sd=${sd} Δ=${delta}`);
      }
    }
  }

  const ari = km.spreadQuote(-3.62, 12.5, 'NFL', 13.9);
  const plainAri = plainSpread(-3.62, 12.5, 13.9);
  assert.ok(
    Math.abs(ari.coverProb - plainAri) <= 0.03 + 1e-9,
    `ARI +12.5 Δ ${ari.coverProb - plainAri} cover ${ari.coverProb} plain ${plainAri}`,
  );
  assert.strictEqual(ari.pPush, 0);
});

console.log('test-omega-keymass-1018b ok');
