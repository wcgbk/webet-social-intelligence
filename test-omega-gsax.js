'use strict';
/**
 * NHL GSAx is added only when both clubs already carry the number,
 * and only inside the existing goalie cap. No network.
 */
const assert = require('assert');
const nhl = require('./netlify/functions/lib/omega-vnext/sports/nhl');

function residual(home, away) {
  return nhl.goalieResidual({
    homeGoalie: home,
    awayGoalie: away,
  });
}

const saveOnly = residual(
  { savePct: 0.91, confirmed: true },
  { savePct: 0.90, confirmed: true },
);
const oneSide = residual(
  { savePct: 0.91, gsax: 0.05, confirmed: true },
  { savePct: 0.90, confirmed: true },
);
assert.strictEqual(oneSide.gsax, 0);
assert.strictEqual(oneSide.marginAdj, saveOnly.marginAdj);
assert.strictEqual(oneSide.totalAdj, saveOnly.totalAdj);

const both = residual(
  { savePct: 0.91, gsax: 0.04, confirmed: true },
  { savePct: 0.90, gsax: -0.02, confirmed: true },
);
assert.ok(Math.abs(both.marginAdj - 0.12) < 1e-9, both.marginAdj);
assert.ok(Math.abs(both.totalAdj - (-0.01)) < 1e-9, both.totalAdj);
assert.strictEqual(both.capped, true);
assert.ok(both.marginAdj <= 0.12 + 1e-9);
assert.ok(Math.abs(both.totalAdj) <= 0.10 + 1e-9);

const ratesOnly = residual(
  { gsax: 0.05, confirmed: true },
  { gsax: -0.01, confirmed: true },
);
assert.ok(Math.abs(ratesOnly.marginAdj - 0.06) < 1e-9, ratesOnly.marginAdj);
assert.ok(Math.abs(ratesOnly.totalAdj - (-0.02)) < 1e-9, ratesOnly.totalAdj);
assert.strictEqual(ratesOnly.used, true);

const season = residual(
  { gsax: 12.4, games: 40, confirmed: true },
  { gsax: 4, games: 40, confirmed: true },
);
assert.ok(Math.abs(season.marginAdj - 0.12) < 1e-9, season.marginAdj);
assert.ok(Math.abs(season.totalAdj - (-0.10)) < 1e-9, season.totalAdj);

const none = residual({ name: 'Home' }, null);
assert.strictEqual(none.marginAdj, 0);
assert.strictEqual(none.gsax, 0);
assert.strictEqual(none.used, false);

console.log('test-omega-gsax: ok');
