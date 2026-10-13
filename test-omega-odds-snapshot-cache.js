'use strict';
/**
 * Odds API snapshot cache. No network.
 * Same key is one pull across two runs. A different market list or book
 * list misses. The apiKey never lands in the cache file.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const cache = require(path.join(root, 'odds_snapshot_cache'));
const { createAuditLog, runWithAudit } = require(path.join(root, 'audit_log'));
const { memoFetchJson, runWithFetchMemo, FRESH_SNAP_MS } = require(path.join(root, 'fetch_memo'));
const config = require(path.join(root, 'config'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.52-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.52-omega-vnext-price-lock:'));
assert.strictEqual(FRESH_SNAP_MS, 10 * 60 * 1000);
assert.strictEqual(cache.BLOB_STORE, 'odds-snapshots');

const SECRET = 'odds-secret-key-aaa';
const SECRET_2 = 'odds-secret-key-bbb';
const BODY = { id: 'g1', home_team: 'Boston Red Sox', bookmakers: [] };

function jsonResponse(body, headers) {
  const text = JSON.stringify(body);
  const bag = Object.assign({}, headers || {});
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const want = String(name || '').toLowerCase();
        return bag[want] != null ? bag[want] : null;
      },
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function oddsUrl(sport, query) {
  return `https://api.the-odds-api.com/v4/sports/${sport}/odds?${query}`;
}

(async () => {
  const prevDir = process.env.ODDS_SNAPSHOT_CACHE_DIR;
  const prevBlobs = process.env.ODDS_SNAPSHOT_CACHE_BLOBS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-odds-snap-'));
  process.env.ODDS_SNAPSHOT_CACHE_DIR = dir;
  delete process.env.ODDS_SNAPSHOT_CACHE_BLOBS;
  cache.clearMemoryForTests();

  const aligned = Math.floor(Date.parse('2026-10-12T14:07:00.000Z') / FRESH_SNAP_MS) * FRESH_SNAP_MS;
  assert.strictEqual(cache.snapshotBucket(aligned), cache.snapshotBucket(aligned + FRESH_SNAP_MS - 1));
  assert.notStrictEqual(cache.snapshotBucket(aligned), cache.snapshotBucket(aligned + FRESH_SNAP_MS));

  let calls = 0;
  const impl = async () => {
    calls += 1;
    return jsonResponse(BODY, {
      'x-requests-last': '2',
      'x-requests-remaining': '40',
      'x-requests-used': '10',
    });
  };

  const log = createAuditLog({ runId: 'snap-cache', date: '2026-10-12', fn: 'test' });
  const urlA = oddsUrl('baseball_mlb', `regions=us,eu&markets=h2h,spreads&oddsFormat=american&apiKey=${SECRET}`);
  const urlB = oddsUrl('baseball_mlb', `markets=spreads,h2h&regions=eu,us&oddsFormat=american&apiKey=${SECRET_2}`);

  try {
    const first = await cache.runWithSnapshotClock(aligned, () => runWithAudit(log, () => (
      runWithFetchMemo(() => memoFetchJson(urlA, 1000, impl))
    )));
    assert.strictEqual(calls, 1);
    cache.clearMemoryForTests();
    const second = await cache.runWithSnapshotClock(aligned + 60 * 1000, () => runWithAudit(log, () => (
      runWithFetchMemo(() => memoFetchJson(urlB, 1000, impl))
    )));
    assert.strictEqual(calls, 1, 'reordered lists and a different apiKey reuse the snapshot');
    assert.deepStrictEqual(second, BODY);
    first.id = 'mutated';
    assert.strictEqual(second.id, 'g1');

    const summary = log.summary();
    assert.strictEqual(summary.oddsSnapshotCache.hits, 1);
    assert.strictEqual(summary.oddsSnapshotCache.misses, 1);
    assert.strictEqual(summary.oddsSnapshotCache.creditsSaved, 2);
    const entries = log.entries();
    const spent = entries.filter((row) => row['x-requests-last'] != null);
    const hits = entries.filter((row) => row.note && row.note.includes('odds-snapshot-cache hit'));
    assert.strictEqual(spent.length, 1);
    assert.strictEqual(spent[0]['x-requests-last'], 2);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]['x-requests-last'], null);
    assert.ok(!JSON.stringify(entries).includes(SECRET));
    assert.ok(!JSON.stringify(entries).includes(SECRET_2));

    const marketsUrl = oddsUrl('baseball_mlb', `regions=us,eu&markets=totals,h2h&oddsFormat=american&apiKey=${SECRET}`);
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(marketsUrl, 1000, impl)));
    assert.strictEqual(calls, 2, 'different markets miss');

    const booksUrl = oddsUrl('baseball_mlb', `regions=us,eu&markets=h2h,spreads&bookmakers=fanduel,draftkings&oddsFormat=american&apiKey=${SECRET}`);
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(booksUrl, 1000, impl)));
    assert.strictEqual(calls, 3, 'different bookmakers miss');
    const booksAgain = oddsUrl('baseball_mlb', `bookmakers=draftkings,fanduel&markets=spreads,h2h&regions=eu,us&apiKey=${SECRET_2}`);
    cache.clearMemoryForTests();
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(booksAgain, 1000, impl)));
    assert.strictEqual(calls, 3, 'sorted bookmakers hit the same file');

    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(names.length >= 2);
    const rows = [];
    for (const name of names) {
      assert.ok(!name.includes(SECRET));
      assert.ok(!name.includes('apiKey'));
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.ok(!text.includes(SECRET), name);
      assert.ok(!text.includes(SECRET_2), name);
      assert.ok(!text.includes('apiKey'), name);
      rows.push(JSON.parse(text));
    }
    const slate = rows.find((row) => row.key && row.key.sport === 'baseball_mlb' && row.key.markets === 'h2h,spreads' && row.key.bookmakers === '');
    assert.ok(slate);
    assert.strictEqual(slate.key.regions, 'eu,us');
    assert.strictEqual(slate.key.eventId, '');
    assert.strictEqual(slate.key.snapshot, cache.snapshotBucket(aligned));
    assert.deepStrictEqual(slate.body, BODY);
    assert.strictEqual(slate.headers['x-requests-last'], '2');
    assert.strictEqual(slate.headers['x-requests-remaining'], '40');
    assert.strictEqual(slate.headers['x-requests-used'], '10');
    assert.ok(slate.fetchedAt);

    const booksRow = rows.find((row) => row.key && row.key.bookmakers === 'draftkings,fanduel');
    assert.ok(booksRow);
    assert.strictEqual(booksRow.key.markets, 'h2h,spreads');

    const eventA = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/ev-1/odds?regions=us&markets=h2h&bookmakers=draftkings&apiKey=${SECRET}`;
    const eventB = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/ev-2/odds?regions=us&markets=h2h&bookmakers=draftkings&apiKey=${SECRET}`;
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(eventA, 1000, impl)));
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(eventB, 1000, impl)));
    assert.strictEqual(calls, 5, 'event id is part of the key');
    cache.clearMemoryForTests();
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(eventA, 1000, impl)));
    assert.strictEqual(calls, 5);

    const historicalUrl = (date) => `https://api.the-odds-api.com/v4/historical/sports/icehockey_nhl/odds?regions=eu,us&markets=spreads,h2h&date=${encodeURIComponent(date)}&apiKey=${SECRET}`;
    const historical = historicalUrl('2026-10-10T14:30:00Z');
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(historical, 1000, impl)));
    cache.clearMemoryForTests();
    await cache.runWithSnapshotClock(aligned + FRESH_SNAP_MS + 5000, () => runWithFetchMemo(() => memoFetchJson(historical, 1000, impl)));
    assert.strictEqual(calls, 6, 'historical date is the snapshot, not the live bucket');
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(historicalUrl('2026-10-10T15:30:00Z'), 1000, impl)));
    assert.strictEqual(calls, 7);

    const live = oddsUrl('basketball_nba', `regions=us&markets=h2h&apiKey=${SECRET}`);
    await cache.runWithSnapshotClock(aligned, () => runWithFetchMemo(() => memoFetchJson(live, 1000, impl)));
    cache.clearMemoryForTests();
    await cache.runWithSnapshotClock(aligned + FRESH_SNAP_MS - 1, () => runWithFetchMemo(() => memoFetchJson(live, 1000, impl)));
    assert.strictEqual(calls, 8, 'same 10-minute bucket hits');
    cache.clearMemoryForTests();
    await cache.runWithSnapshotClock(aligned + FRESH_SNAP_MS, () => runWithFetchMemo(() => memoFetchJson(live, 1000, impl)));
    assert.strictEqual(calls, 9, 'next bucket misses');

    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    process.env.ODDS_SNAPSHOT_CACHE_DIR = path.join(blocker, 'child');
    cache.clearMemoryForTests();
    const broken = oddsUrl('baseball_mlb', `regions=us&markets=h2h&apiKey=${SECRET}&broken=1`);
    const still = await runWithFetchMemo(() => memoFetchJson(broken, 1000, impl));
    assert.deepStrictEqual(still, BODY);
    assert.strictEqual(calls, 10, 'a cache write error still returns the network body');

    const finalNames = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    for (const name of finalNames) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.ok(!text.includes(SECRET));
      assert.ok(!text.includes(SECRET_2));
      assert.ok(!/apiKey/i.test(text), name);
    }

    console.log('test-omega-odds-snapshot-cache ok');
  } finally {
    cache.clearMemoryForTests();
    if (prevDir == null) delete process.env.ODDS_SNAPSHOT_CACHE_DIR;
    else process.env.ODDS_SNAPSHOT_CACHE_DIR = prevDir;
    if (prevBlobs == null) delete process.env.ODDS_SNAPSHOT_CACHE_BLOBS;
    else process.env.ODDS_SNAPSHOT_CACHE_BLOBS = prevBlobs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
