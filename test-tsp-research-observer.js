'use strict';
/** TSP research observer — parse, isolation, no Omega live mutation. No network required. */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, 'netlify/functions/lib/tsp-research');
const cfg = require(path.join(root, 'config'));
const { parseCsv, summarizeWagerLog } = require(path.join(root, 'parse_csv'));
const { assertResearchKey } = require(path.join(root, 'store'));
const { buildFeedArtifact, buildDailyDigest } = require(path.join(root, 'fetch_public'));

assert.strictEqual(cfg.TSP_FETCH_ON_HOLD, true, 'member tsp.live fetch must stay on hold');
assert.strictEqual(cfg.BLOB_STORE, 'tsp-research');
assert.ok(cfg.BLOB_STORE !== 'edge-picks-omega');
assert.ok(Array.isArray(cfg.PUBLIC_FEEDS) && cfg.PUBLIC_FEEDS.length >= 5);
assert.ok(cfg.PUBLIC_LAMBDA_BASE.startsWith('https://'));

const csv = [
  'Date,League,Angle,Result,Base Ret,Hermes Score',
  '3/2/2022,NBA,Indiana/Orlando OVER,Win,1.00,30',
  '3/3/2022,NBA,Boston ML,Loss,-1.10,45',
  '3/4/2022,MLB,Yankees -1.5,Push,0,50',
].join('\n');

const parsed = parseCsv(csv);
assert.strictEqual(parsed.headers[0], 'Date');
assert.strictEqual(parsed.rows.length, 3);
const sum = summarizeWagerLog(parsed.rows);
assert.strictEqual(sum.wins, 1);
assert.strictEqual(sum.losses, 1);
assert.strictEqual(sum.pushes, 1);
assert.strictEqual(sum.winPct, 50);

const feed = cfg.PUBLIC_FEEDS.find((f) => f.key === 'hermes_elite');
const art = buildFeedArtifact(feed, csv);
assert.strictEqual(art.rowCount, 3);
assert.ok(art.summary.wins === 1);

const digest = buildDailyDigest({
  fetchedAt: '2026-09-22T15:00:00Z',
  sourceUrl: cfg.PUBLIC_LAMBDA_BASE,
  okCount: 1,
  errors: [],
  isolation: { blobStore: 'tsp-research', neverCopiesPicksIntoOmega: true },
  feeds: [art],
  disclaimer: 'OBSERVER',
}, { dateISO: '2026-09-22' });
assert.strictEqual(digest.date, '2026-09-22');
assert.strictEqual(digest.feeds[0].summary.wins, 1);

// Isolation: refuse Omega live-looking keys
assert.throws(() => assertResearchKey('picks-2026-09-22'), /refused/);
assert.throws(() => assertResearchKey('edge-picks-omega'), /refused/);
assert.doesNotThrow(() => assertResearchKey('snapshots/2026-09-22'));
assert.doesNotThrow(() => assertResearchKey('digests/2026-09-22'));
assert.doesNotThrow(() => assertResearchKey('manual/hermes-csv'));

// #82 paused member fetch-tsp-live again (flag + commented schedule). Research flag stays true.
// Omega generate must not require this module.
const liveSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/fetch-tsp-live.js'), 'utf8');
assert.ok(/const TSP_FETCH_ON_HOLD = true;/.test(liveSrc), 'fetch-tsp-live stays paused (#82)');
assert.ok(!/const TSP_FETCH_ON_HOLD = false;/.test(liveSrc));

// Omega live config store name unchanged / not pointed at tsp-research
const omegaCfg = require(path.join(__dirname, 'netlify/functions/lib/omega-vnext/config'));
const omegaBlob = omegaCfg.BLOB_STORE || omegaCfg.BLOB_STORE;
assert.ok(omegaBlob === 'edge-picks-omega' || omegaBlob === 'edge-picks-omega');
assert.notStrictEqual(omegaBlob, 'tsp-research');

console.log('test-tsp-research-observer: OK', {
  feeds: cfg.PUBLIC_FEEDS.length,
  blob: cfg.BLOB_STORE,
  hold: cfg.TSP_FETCH_ON_HOLD,
  model: omegaCfg.MODEL_VERSION || omegaCfg.MODEL_VERSION,
});
