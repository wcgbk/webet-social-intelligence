#!/usr/bin/env node
// Paid /historical Odds API URLs refuse unless OMEGA_CLOSES_HISTORICAL is explicitly on.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assertHistoricalOddsAllowed } = require('./netlify/functions/lib/historical-odds-guard');
const C = require('./netlify/functions/lib/closes-3am');

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function throwsRefused(fn) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a refusal');
  assert.strictEqual(caught.code, 'HISTORICAL_ODDS_REFUSED');
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
}

async function main() {
  await check('builder refuses unless the flag is explicitly on', async () => {
    const args = ['k', 'basketball_nba', '2026-11-16T15:00:00Z', '2026-11-16T14:00:00Z', '2026-11-16T16:00:00Z'];
    for (const env of [{}, { OMEGA_CLOSES_HISTORICAL: '' }, { OMEGA_CLOSES_HISTORICAL: 'off' }, { OMEGA_CLOSES_HISTORICAL: '0' }, { OMEGA_CLOSES_HISTORICAL: 'false' }]) {
      throwsRefused(() => C.buildHistoricalUrl(...args, env));
      throwsRefused(() => assertHistoricalOddsAllowed(env, 'test'));
    }
    const url = C.buildHistoricalUrl(...args, { OMEGA_CLOSES_HISTORICAL: 'on' });
    assert.ok(url.includes('/v4/historical/sports/basketball_nba/odds'));
    assert.ok(!url.includes('undefined'));
  });

  await check('manual missingGames and retryNoClose do not call historical', async () => {
    const calls = [];
    const result = await C.runCloses({
      now: new Date('2026-11-16T21:26:00Z'),
      env: { ODDS_API_KEY: 'test-key', OMEGA_CLOSES_HISTORICAL: 'off' },
      date: '2026-11-15',
      missingGames: true,
      retryNoClose: true,
      onlyMissing: true,
      slateEvents: [
        { sport: 'NBA', eventId: 'g1', homeTeam: 'Celtics', awayTeam: 'Knicks', commenceTime: '2026-11-15T23:00:00Z' },
      ],
      card: {
        picks: [
          { sport: 'NBA', eventId: 'g1', matchup: 'Knicks @ Celtics', pick: 'Celtics ML', betType: 'Moneyline', commenceTime: '2026-11-15T23:00:00Z' },
        ],
      },
      blobs: {
        async get() { return null; },
        async set() { return true; },
      },
      readBoard: async () => ({ events: [] }),
      readMaster: async () => null,
      fetch: async (url) => {
        calls.push(String(url));
        throw new Error('odds fetch');
      },
    });
    assert.strictEqual(result.mode, 'saved-board');
    assert.deepStrictEqual(result.calls, []);
    assert.deepStrictEqual(calls, []);
    assert.ok(calls.every((url) => !url.includes('/historical')));
  });

  await check('every historical URL builder calls the guard', async () => {
    const files = [];
    walk(process.cwd(), files);
    const hits = files.filter((file) => fs.readFileSync(file, 'utf8').includes('/v4/historical'));
    assert.ok(hits.length >= 8, `expected historical builders, saw ${hits.length}`);
    for (const file of hits) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes('assertHistoricalOddsAllowed'), file);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('historical odds guard ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
