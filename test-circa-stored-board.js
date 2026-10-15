'use strict';
// Circa builds its market snapshot from the stored 10:00 / 3:00 ET NFL board.
// It must never call the Odds API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const circa = require('./netlify/functions/generate-picks-circa-background');

const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-circa-background.js'), 'utf8');
assert.ok(!/ODDS_API_KEY/.test(src), 'Circa does not read ODDS_API_KEY');
assert.ok(!/the-odds-api\.com/.test(src), 'Circa has no Odds API URL');

const board = [{
  id: 'nfl1', commence_time: '2026-10-18T17:00:00Z', home_team: 'Buffalo Bills', away_team: 'Kansas City Chiefs',
  bookmakers: [{ key: 'pinnacle', markets: [{ key: 'spreads', outcomes: [
    { name: 'Buffalo Bills', point: -2.5, price: -105 }, { name: 'Kansas City Chiefs', point: 2.5, price: -105 }] }] }],
}];

(async () => {
  const realFetch = global.fetch;
  let oddsCalls = 0;
  global.fetch = async (url) => { if (/odds-api/.test(String(url))) oddsCalls += 1; throw new Error('no network'); };
  try {
    const queries = [];
    const nowMs = Date.parse('2026-10-15T17:15:00Z'); // Thu 1:15 PM ET
    const cache = { findFreshSportPull: async (q) => {
      queries.push(q);
      return q.nowMs >= Date.parse('2026-10-15T14:00:00Z') && q.nowMs < Date.parse('2026-10-15T15:00:00Z')
        ? { body: board, fetchedAt: '2026-10-15T14:00:30Z' } : null;
    } };
    const events = await circa.fetchNFLSpreadOdds({ nowMs, dateISO: '2026-10-15', snapshotCache: cache });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(queries[0].sport, 'americanfootball_nfl');
    assert.strictEqual(queries[0].nowMs, Date.parse('2026-10-15T14:05:00Z'), 'first look is the 10:00 ET board');
    const m = circa.extractMarketSpread(events[0], 'Buffalo Bills', 'Kansas City Chiefs');
    assert.strictEqual(m.book, 'pinnacle');
    assert.strictEqual(m.homePoint, -2.5);

    // 10:00 missing -> 3:00 ET fallback
    const cache3 = { findFreshSportPull: async (q) => (q.nowMs < Date.parse('2026-10-15T08:00:00Z') ? { body: board, fetchedAt: '2026-10-15T07:00:20Z' } : null) };
    assert.strictEqual((await circa.fetchNFLSpreadOdds({ nowMs, dateISO: '2026-10-15', snapshotCache: cache3 })).length, 1);

    // Nothing stored -> empty, still no Odds API call
    const none = { findFreshSportPull: async () => null };
    assert.deepStrictEqual(await circa.fetchNFLSpreadOdds({ nowMs, dateISO: '2026-10-15', snapshotCache: none }), []);
    assert.strictEqual(oddsCalls, 0);
    console.log('PASS test-circa-stored-board');
  } finally {
    global.fetch = realFetch;
  }
})().catch((e) => { console.error(e); process.exit(1); });
