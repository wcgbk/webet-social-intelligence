'use strict';

/**
 * regrade-omega-letters: B straights at 2.0% <= edge < 3.5% become A-
 * on rating, grade, and qualityGrade. Fake store. No blob network.
 */

const assert = require('assert');
const {
  handle,
  regradeOmegaLetters,
  parseEdgePct,
  ALLOWED_DATES,
  BLOB_STORE,
} = require('./netlify/functions/regrade-omega-letters');

assert.strictEqual(BLOB_STORE, 'edge-picks-omega');
assert.deepStrictEqual(ALLOWED_DATES, ['2026-10-31', '2026-11-01', '2026-11-02']);

assert.strictEqual(parseEdgePct('2.8%'), 2.8);
assert.strictEqual(parseEdgePct('2.0%'), 2);
assert.strictEqual(parseEdgePct('3.5%'), 3.5);
assert.strictEqual(parseEdgePct('1.96%'), 1.96);
assert.strictEqual(parseEdgePct(0.028), 2.8);
assert.strictEqual(parseEdgePct(2.8), 2.8);

function memoryStore(seed) {
  const data = Object.assign({}, seed);
  const writes = [];
  return {
    writes,
    data,
    async get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async setJSON(key, value) {
      writes.push({ key, value });
      data[key] = value;
    },
  };
}

function straight(extra) {
  return Object.assign({
    pick: 'Home ML',
    matchup: 'Away @ Home',
    odds: '-110',
    units: '0.75u',
    unitsNum: 0.75,
    stakeUsd: 113,
    result: 'win',
    confidence: 60,
    rating: 'b',
    grade: 'b',
    qualityGrade: 'b',
    edgePct: '2.8%',
  }, extra);
}

function cardFor(picks, extra) {
  return Object.assign({
    date: '2026-10-31',
    model: 'omega-v2-sharp-2026-10-30',
    picks,
    parlayLegs: [{
      units: '0.25u',
      legs: [straight({ pick: 'Parlay leg', grade: 'b', rating: 'b', qualityGrade: 'b', edgePct: '2.7%', units: '0.25u' })],
    }],
    summary: { totalPicks: picks.length },
  }, extra);
}

function untouched(before, after) {
  const drop = (row) => {
    const copy = Object.assign({}, row);
    delete copy.rating;
    delete copy.grade;
    delete copy.qualityGrade;
    return copy;
  };
  assert.deepStrictEqual(after.map(drop), before.map(drop));
}

(async () => {
  const picks = [
    straight({ pick: 'Low edge', edgePct: '2.0%' }),
    straight({ pick: 'Mid', edgePct: '2.8%', matchup: 'A @ B' }),
    straight({ pick: 'Just under A', edgePct: '3.49%' }),
    straight({ pick: 'Exact A', edgePct: '3.5%' }),
    straight({ pick: 'Still B', edgePct: '1.9%' }),
    straight({ pick: 'Unrounded', edgePct: '1.96%' }),
    straight({ pick: 'Already A', grade: 'a', rating: 'a', qualityGrade: 'a', edgePct: '2.8%' }),
    straight({ pick: 'High B', edgePct: '4.0%' }),
    straight({ pick: 'No edge', edgePct: null }),
    straight({ pick: 'Upper B', grade: 'B', rating: 'B', qualityGrade: 'B', edgePct: '2.5%' }),
    straight({ pick: 'Not a letter b', grade: 'b+', rating: 'b+', qualityGrade: 'b+', edgePct: '2.5%' }),
    straight({ pick: 'Fraction', edgePct: 0.028 }),
  ];
  const original = cardFor(picks);
  const snapshot = JSON.parse(JSON.stringify(original));
  const store = memoryStore({ 'picks-2026-10-31': original });

  const dry = await regradeOmegaLetters({ date: '2026-10-31', store });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(store.writes.length, 0);
  assert.deepStrictEqual(original, snapshot, 'dry run must not mutate the stored card');
  assert.deepStrictEqual(dry.changes.map((row) => row.pick), ['Low edge', 'Mid', 'Just under A', 'Upper B', 'Fraction']);
  for (const row of dry.changes) {
    assert.deepStrictEqual(row.to, { rating: 'aminus', grade: 'aminus', qualityGrade: 'aminus' });
    assert.ok(row.edge >= 2 && row.edge < 3.5);
  }
  assert.strictEqual(dry.changes[1].matchup, 'A @ B');
  assert.strictEqual(dry.changes[1].index, 1);

  const explicit = await regradeOmegaLetters({ date: '2026-10-31', dryRun: true, store });
  assert.strictEqual(explicit.wrote, false);
  assert.strictEqual(store.writes.length, 0);

  const asString = await regradeOmegaLetters({ date: '2026-10-31', dryRun: 'false', store });
  assert.strictEqual(asString.dryRun, true);
  assert.strictEqual(asString.wrote, false);
  assert.strictEqual(store.writes.length, 0);

  const live = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false, store });
  assert.strictEqual(live.wrote, true);
  assert.strictEqual(live.dryRun, false);
  assert.strictEqual(store.writes.length, 1);
  assert.strictEqual(store.writes[0].key, 'picks-2026-10-31');
  const written = store.writes[0].value;
  assert.deepStrictEqual(original, snapshot, 'write copies the card');
  assert.strictEqual(written.summary.totalPicks, snapshot.summary.totalPicks);
  assert.deepStrictEqual(written.parlayLegs, snapshot.parlayLegs);
  assert.strictEqual(written.parlayLegs[0].legs[0].grade, 'b');
  untouched(snapshot.picks, written.picks);
  const changedIdx = new Set(live.changes.map((row) => row.index));
  written.picks.forEach((pick, index) => {
    if (changedIdx.has(index)) {
      assert.strictEqual(pick.rating, 'aminus');
      assert.strictEqual(pick.grade, 'aminus');
      assert.strictEqual(pick.qualityGrade, 'aminus');
    } else {
      assert.deepStrictEqual(
        { rating: pick.rating, grade: pick.grade, qualityGrade: pick.qualityGrade },
        { rating: snapshot.picks[index].rating, grade: snapshot.picks[index].grade, qualityGrade: snapshot.picks[index].qualityGrade }
      );
    }
    assert.strictEqual(pick.confidence, snapshot.picks[index].confidence);
    assert.strictEqual(pick.units, snapshot.picks[index].units);
    assert.strictEqual(pick.unitsNum, snapshot.picks[index].unitsNum);
    assert.strictEqual(pick.stakeUsd, snapshot.picks[index].stakeUsd);
    assert.strictEqual(pick.odds, snapshot.picks[index].odds);
    assert.strictEqual(pick.result, snapshot.picks[index].result);
  });

  const again = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false, store });
  assert.strictEqual(again.wrote, false);
  assert.deepStrictEqual(again.changes, []);
  assert.strictEqual(store.writes.length, 1, 'a second pass does not write');

  const missing = memoryStore({});
  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-11-01', dryRun: false, store: missing }),
    (err) => err.statusCode === 404
  );
  assert.strictEqual(missing.writes.length, 0);

  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-11-03', dryRun: false, store }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-10-30', store }),
    (err) => err.statusCode === 400
  );

  const savedKey = process.env.PICKS_SECRET_KEY;
  process.env.PICKS_SECRET_KEY = 'test-key';
  try {
    const denied = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'nope' },
      body: JSON.stringify({ date: '2026-11-02', dryRun: false }),
    });
    assert.strictEqual(denied.statusCode, 401);
    assert.strictEqual(JSON.parse(denied.body).error, 'Unauthorized');

    const missingKey = await handle({
      httpMethod: 'POST',
      queryStringParameters: {},
      body: JSON.stringify({ date: '2026-11-02' }),
    });
    assert.strictEqual(missingKey.statusCode, 401);

    const get = await handle({
      httpMethod: 'GET',
      queryStringParameters: { key: 'test-key' },
    });
    assert.strictEqual(get.statusCode, 405);

    const badDate = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-09-01', dryRun: false }),
    });
    assert.strictEqual(badDate.statusCode, 400);

    const badJson = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: '{',
    });
    assert.strictEqual(badJson.statusCode, 400);

    const nov = cardFor([
      straight({ pick: 'Nov 1', edgePct: '2.2%', confidence: 60, result: 'loss', units: '0.5u', odds: '+140' }),
    ], { date: '2026-11-01' });
    const novSnap = JSON.parse(JSON.stringify(nov));
    const novStore = memoryStore({ 'picks-2026-11-01': nov });
    const ok = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-11-01' }),
    }, { store: novStore });
    assert.strictEqual(ok.statusCode, 200);
    const okBody = JSON.parse(ok.body);
    assert.strictEqual(okBody.dryRun, true);
    assert.strictEqual(okBody.wrote, false);
    assert.strictEqual(okBody.changes.length, 1);
    assert.strictEqual(novStore.writes.length, 0);
    assert.deepStrictEqual(nov, novSnap);

    const posted = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-11-02', dryRun: false }),
    }, {
      store: memoryStore({
        'picks-2026-11-02': cardFor([
          straight({ pick: 'Nov 2', edgePct: '3.4%', confidence: 60, result: null, units: '1u', odds: '-105' }),
        ], { date: '2026-11-02' }),
      }),
    });
    assert.strictEqual(posted.statusCode, 200);
    const postedBody = JSON.parse(posted.body);
    assert.strictEqual(postedBody.wrote, true);
    assert.strictEqual(postedBody.changes.length, 1);
    assert.strictEqual(postedBody.changes[0].to.grade, 'aminus');
    const saved = postedBody;
    assert.ok(saved.changes[0].edge >= 2 && saved.changes[0].edge < 3.5);
  } finally {
    if (savedKey == null) delete process.env.PICKS_SECRET_KEY;
    else process.env.PICKS_SECRET_KEY = savedKey;
  }

  console.log('PASS regrade-omega-letters');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
