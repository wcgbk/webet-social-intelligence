'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const blobKey = require('./netlify/functions/lib/omega-vnext/blob_key');
const lines = require('./netlify/functions/lib/omega-vnext/pinnacle_line_move');
const master = require('./netlify/functions/lib/omega-vnext/odds_master');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

assert.strictEqual(blobKey.canonicalBlobKey('date/2026-10-14'), 'date/2026-10-14');
assert.strictEqual(blobKey.legacyEncodedBlobKey('date/2026-10-14'), 'date%2F2026-10-14');
assert.notStrictEqual(blobKey.canonicalBlobKey('date/2026-10-14'), blobKey.legacyEncodedBlobKey('date/2026-10-14'));
assert.ok(blobKey.blobRestUrl('site', 'omega-pinnacle-line-moves', 'date/2026-10-14', 'canonical').endsWith('/date/2026-10-14'));
assert.ok(blobKey.blobRestUrl('site', 'odds-master', 'by-date/2026-10-14', 'legacy').includes('by-date%2F2026-10-14'));
assert.ok(!blobKey.blobRestUrl('site', 'edge-picks-omega', 'clv-candidates-v2/2026-10-09', 'canonical').includes('%2F'));

const fnDir = path.join(__dirname, 'netlify/functions');
const offenders = [];
for (const file of walk(fnDir, [])) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('encodeURIComponent(key)')) offenders.push(path.relative(__dirname, file));
}
assert.deepStrictEqual(offenders, []);

for (const rel of [
  'netlify/functions/lib/omega-vnext/pinnacle_line_move.js',
  'netlify/functions/lib/omega-vnext/odds_master.js',
]) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  assert.ok(src.includes("require('./blob_key')"), rel);
  assert.ok(!src.includes('encodeURIComponent(key)'), rel);
}

function mem() {
  const blobs = new Map();
  const writes = [];
  return {
    blobs,
    writes,
    async read(key) {
      if (!blobs.has(key)) return null;
      return JSON.parse(JSON.stringify(blobs.get(key)));
    },
    async write(key, data) {
      writes.push(key);
      blobs.set(key, JSON.parse(JSON.stringify(data)));
    },
  };
}

function eventDoc(sport, eventId) {
  return {
    schema: lines.SCHEMA,
    sport,
    eventId,
    commenceTime: '2026-10-14T23:00:00Z',
    homeTeam: 'Home',
    awayTeam: 'Away',
    checks: [],
  };
}

(async () => {
  const store = mem();
  await lines.ensureDateIndex('2026-10-14', 'NHL', 'e1', {}, store.read, store.write);
  await lines.ensureDateIndex('2026-10-14', 'NHL', 'e2', {}, store.read, store.write);
  const index = store.blobs.get('date/2026-10-14');
  assert.deepStrictEqual(index.events.map((row) => row.eventId), ['e1', 'e2']);
  assert.ok(store.blobs.has('date/2026-10-14/event/NHL/e1'));
  assert.ok(store.blobs.has('date/2026-10-14/event/NHL/e2'));

  const kept = JSON.stringify(store.blobs.get('date/2026-10-14'));
  const thrown = await lines.ensureDateIndex('2026-10-14', 'NHL', 'e3', {}, async () => {
    throw new Error('index-down');
  }, store.write);
  assert.strictEqual(thrown.reason, 'marker-only');
  assert.strictEqual(JSON.stringify(store.blobs.get('date/2026-10-14')), kept);
  assert.ok(store.blobs.has('date/2026-10-14/event/NHL/e3'));

  store.blobs.set('date/2026-10-14', {
    schema: lines.SCHEMA,
    date: '2026-10-14',
    events: [{ sport: 'NHL', eventId: 'e1' }],
  });
  store.blobs.set('NHL/e1', eventDoc('NHL', 'e1'));
  store.blobs.set('NHL/e2', eventDoc('NHL', 'e2'));
  async function list(prefix) {
    return [...store.blobs.keys()].filter((key) => String(key).startsWith(prefix));
  }
  const recovered = await lines.readPinnacleLineMoves('2026-10-14', { read: store.read, list });
  assert.ok(recovered.events.some((row) => row.eventId === 'e1'));
  assert.ok(recovered.events.some((row) => row.eventId === 'e2'));

  const stale = mem();
  stale.blobs.set('date/2026-10-14', {
    schema: lines.SCHEMA,
    events: [{ sport: 'NHL', eventId: 'e1' }],
  });
  await lines.ensureDateIndex('2026-10-14', 'NFL', 'e2', {}, stale.read, stale.write);
  assert.deepStrictEqual(
    stale.blobs.get('date/2026-10-14').events.map((row) => `${row.sport}/${row.eventId}`),
    ['NHL/e1', 'NFL/e2'],
  );

  const quotes = {
    a: { market: 'Moneyline', side: 'home', team: 'Home', price: -110, line: null },
  };
  const tape = mem();
  async function quote(eventId) {
    return master.storeQuotes({
      sport: 'NHL',
      eventId,
      book: 'pinnacle',
      role: 'check-1000',
      timestamp: '2026-10-14T14:00:00Z',
      quotes,
      homeTeam: 'Home',
      awayTeam: 'Away',
      commenceTime: '2026-10-14T23:00:00Z',
    }, { read: tape.read, write: tape.write });
  }
  assert.strictEqual((await quote('e1')).wrote, true);
  assert.strictEqual((await quote('e2')).wrote, true);
  const dated = tape.blobs.get('by-date/2026-10-14');
  assert.deepStrictEqual(dated.events.map((row) => row.eventId), ['e1', 'e2']);
  assert.ok(tape.blobs.has('by-date/2026-10-14/event/NHL/e3') === false);
  assert.ok(tape.blobs.has(master.dateEventMarkerKey('2026-10-14', 'NHL', 'e1')));

  const full = JSON.stringify(tape.blobs.get('by-date/2026-10-14'));
  const failedRead = async (key) => {
    if (key === 'by-date/2026-10-14') throw new Error('date-down');
    return tape.read(key);
  };
  const third = await master.storeQuotes({
    sport: 'NHL',
    eventId: 'e3',
    book: 'pinnacle',
    role: 'check-1000',
    timestamp: '2026-10-14T14:00:00Z',
    quotes,
    homeTeam: 'Home',
    awayTeam: 'Away',
    commenceTime: '2026-10-14T23:00:00Z',
  }, { read: failedRead, write: tape.write });
  assert.strictEqual(third.wrote, true);
  assert.strictEqual(JSON.stringify(tape.blobs.get('by-date/2026-10-14')), full);
  assert.ok(tape.blobs.has(master.dateEventMarkerKey('2026-10-14', 'NHL', 'e3')));

  const blocked = [];
  const denied = await master.storeQuotes({
    sport: 'NHL',
    eventId: 'e9',
    book: 'pinnacle',
    role: 'open',
    timestamp: '2026-10-14T14:00:00Z',
    quotes,
    homeTeam: 'Home',
    awayTeam: 'Away',
    commenceTime: '2026-10-14T23:00:00Z',
  }, {
    read: async () => { throw new Error('index-down'); },
    write: async (key) => { blocked.push(key); },
  });
  assert.strictEqual(denied.reason, 'read-failed');
  assert.deepStrictEqual(blocked, []);

  console.log('PASS test-omega-blob-keys');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
