'use strict';
// NHL period prices include the rating-error SD the normal path already uses.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const nhl = require(path.join(root, 'sports/nhl'));
const nhlPeriod = require(path.join(root, 'nhl_period'));

function withEnv(extra, fn) {
  const prev = {};
  for (const key of Object.keys(extra)) {
    prev[key] = process.env[key];
    if (extra[key] == null) delete process.env[key];
    else process.env[key] = extra[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(extra)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function quote(args) {
  return nhl.periodQuote(args);
}

const MARGIN = 1.2;
const TOTAL = 6.0;

withEnv({ OMEGA_NHL_PERIOD_RATING_SD: null }, () => {
  const old = nhlPeriod.nhlMarketQuote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true,
  });
  assert.strictEqual(old.coverProb.toFixed(4), '0.6947');

  const home = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 8,
  });
  const away = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: false, nGames: 8,
  });
  assert.ok(home.coverProb > 0.5, home.coverProb);
  assert.ok(home.coverProb < old.coverProb, `${home.coverProb} vs ${old.coverProb}`);
  assert.ok(home.coverProb < 0.6947, home.coverProb);
  assert.ok(Math.abs(home.coverProb + away.coverProb - 1) < 1e-9, home.coverProb + away.coverProb);
  assert.strictEqual(home.pPush, 0);
  assert.strictEqual(away.pPush, 0);

  const wide = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 600,
  });
  assert.ok(Math.abs(wide.coverProb - old.coverProb) < 0.002, wide.coverProb);

  const oldDog = nhlPeriod.nhlMarketQuote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'spread', sideIsHome: false, line: 1.5,
  });
  const dog = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'spread', sideIsHome: false, line: 1.5, nGames: 8,
  });
  assert.ok(oldDog.coverProb > 0.5, oldDog.coverProb);
  assert.ok(Math.abs(dog.coverProb - 0.5) < Math.abs(oldDog.coverProb - 0.5), `${dog.coverProb} vs ${oldDog.coverProb}`);

  withEnv({ OMEGA_NHL_PERIOD_RATING_SD: '0' }, () => {
    const off = quote({
      modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 8,
    });
    assert.strictEqual(off.coverProb, old.coverProb);
    assert.strictEqual(off.pPush, old.pPush);
    assert.strictEqual(off.pWin, old.pWin);
    assert.strictEqual(off.expectedTotal, old.expectedTotal);
  });
});

const nhlSrc = fs.readFileSync(path.join(root, 'sports/nhl.js'), 'utf8');
const calls = nhlSrc.match(/periodQuote\(\{[\s\S]*?\}\)/g) || [];
assert.strictEqual(calls.length, 3, calls.join('\n'));
for (const call of calls) assert.ok(/\bnGames\b/.test(call), call);

console.log('test-omega-allsports-1018 ok');
