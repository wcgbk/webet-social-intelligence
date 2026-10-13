'use strict';

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const starters = require('./netlify/functions/confirm-starters-mlb');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.72-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.72-omega-vnext-price-lock:'));
assert.strictEqual(starters.omegaCardIsLogOnly('edge-picks-omega'), true);
assert.strictEqual(starters.omegaCardIsLogOnly('edge-picks-alpha'), false);

const current = {
  '2_10': {
    status: 'pre',
    awaySP: 'New Guy',
    homeSP: 'Gerrit Cole',
    awayTeam: 'Boston Red Sox',
    homeTeam: 'New York Yankees',
  },
};

function card() {
  return {
    picks: [{
      sport: 'MLB',
      matchup: 'Boston Red Sox @ New York Yankees',
      pick: 'Over 8.5',
      betType: 'Total',
      awaySP: 'Brayan Bello',
      homeSP: 'Gerrit Cole',
      units: '1u',
    }],
    summary: { totalPicks: 1, totalStraightBets: 1, totalUnits: '1.00u' },
    parlayLegs: [{ units: '0.5u', legs: [{ pick: 'Over 8.5' }, { pick: 'Yankees ML' }] }],
  };
}

const omega = card();
const logged = starters.processPicks(omega, current, { logOnly: true });
assert.strictEqual(logged.logOnly, true);
assert.strictEqual(logged.wrote, false);
assert.strictEqual(logged.wouldKill, 1);
assert.strictEqual(omega.picks.length, 1);
assert.strictEqual(omega.picks[0].killed, undefined);
assert.strictEqual(omega.parlayLegs.length, 1);
assert.strictEqual(omega.picks[0].awaySP, 'Brayan Bello');

const alpha = card();
const rewritten = starters.processPicks(alpha, current);
assert.strictEqual(rewritten.killed, 1);
assert.strictEqual(alpha.picks.length, 0);
assert.deepStrictEqual(alpha.parlayLegs, []);
assert.strictEqual(alpha.killedPicks.length, 1);

console.log('test-omega-starter-log ok');
