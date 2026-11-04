'use strict';

/**
 * Health-record builder. No network. Does not load generate or the blob store.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const { buildHealthRecord } = require('./netlify/functions/lib/omega-vnext/health_record');

function sampleCard() {
  return {
    date: '2026-11-04',
    generatedAt: '2026-11-04T14:15:00.000Z',
    model: 'omega-v2-sharp-2026-11-01-dkhr',
    engine: 'omega-v2',
    pipelineV2: {
      pass: false,
      short: true,
      modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
    },
    meta: { pipelineV2: true },
    sportCoverage: { rows: [{ sport: 'NFL', kept: 1 }], corrected: [] },
    qaHardFails: [
      { matchup: 'A @ B', side: 'A', sport: 'NFL', reason: 'qb-out', hardFail: true },
    ],
    fallback: false,
    captureHealth: {
      ok: false,
      hardFail: false,
      warning: 'missing 0915',
      usableSnapCount: 2,
      missingSlotsET: ['0915'],
      reason: 'not copied onto captureStatus',
    },
    picks: [{ pick: 'A' }, { pick: 'B' }],
    parlayLegs: [{ legs: [1, 2] }],
  };
}

function testFields() {
  const card = sampleCard();
  const rec = buildHealthRecord(card, { writtenAt: '2026-11-04T14:16:00.000Z' });
  assert.strictEqual(rec.date, '2026-11-04');
  assert.strictEqual(rec.generatedAt, card.generatedAt);
  assert.strictEqual(rec.writtenAt, '2026-11-04T14:16:00.000Z');
  assert.strictEqual(rec.model, card.model);
  assert.strictEqual(rec.engine, 'omega-v2');
  assert.strictEqual(rec.pipelineV2, true);
  assert.deepStrictEqual(rec.sportCoverage, card.sportCoverage);
  assert.notStrictEqual(rec.sportCoverage, card.sportCoverage);
  assert.strictEqual(rec.qaHardFails, 1);
  assert.deepStrictEqual(rec.qaHardFailList, card.qaHardFails);
  assert.notStrictEqual(rec.qaHardFailList, card.qaHardFails);
  assert.notStrictEqual(rec.qaHardFailList[0], card.qaHardFails[0]);
  assert.strictEqual(rec.fallback, false);
  assert.deepStrictEqual(rec.captureStatus, {
    ok: false,
    hardFail: false,
    warning: 'missing 0915',
    usableSnapCount: 2,
    missingSlotsET: ['0915'],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rec.captureStatus, 'reason'), false);
  assert.strictEqual(rec.straightCount, 2);
  assert.strictEqual(rec.parlayCount, 1);
  assert.strictEqual(rec.pass, false);
  assert.strictEqual(rec.short, true);
  assert.strictEqual(rec.ok, false, 'a qa hard fail clears ok');

  const clean = buildHealthRecord({
    date: '2026-11-04',
    generatedAt: '2026-11-04T14:15:00.000Z',
    model: 'v12.5.4-omega-vnext',
    engine: 'omega-vnext',
    fallback: false,
    qaHardFails: [],
    picks: [{ pick: 'A' }, { pick: 'B' }, { pick: 'C' }],
    parlayLegs: [],
    captureHealth: {
      ok: true,
      hardFail: false,
      warning: null,
      usableSnapCount: 4,
      missingSlotsET: [],
    },
  }, { writtenAt: '2026-11-04T14:16:00.000Z' });
  assert.strictEqual(clean.pipelineV2, false);
  assert.strictEqual(clean.pass, null);
  assert.strictEqual(clean.short, null);
  assert.strictEqual(clean.qaHardFails, 0);
  assert.deepStrictEqual(clean.qaHardFailList, []);
  assert.strictEqual(clean.straightCount, 3);
  assert.strictEqual(clean.parlayCount, 0);
  assert.strictEqual(clean.sportCoverage, null);
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.captureStatus.usableSnapCount, 4);
  assert.strictEqual(clean.captureStatus.warning, null);

  const explicit = buildHealthRecord(sampleCard(), {
    writtenAt: '2026-11-04T14:16:00.000Z',
    captureHealth: {
      ok: false,
      hardFail: true,
      warning: 'zero snaps',
      usableSnapCount: 0,
      missingSlotsET: ['0600', '1000'],
    },
  });
  assert.strictEqual(explicit.captureStatus.hardFail, true);
  assert.strictEqual(explicit.captureStatus.usableSnapCount, 0);
  assert.deepStrictEqual(explicit.captureStatus.missingSlotsET, ['0600', '1000']);
  assert.strictEqual(explicit.ok, false, 'capture hardFail clears ok');
  assert.strictEqual(explicit.qaHardFails, 1);

  const fallback = buildHealthRecord({
    fallback: true,
    qaHardFails: [],
    captureHealth: { hardFail: false, ok: true, usableSnapCount: 1, missingSlotsET: [] },
    picks: [],
    parlayLegs: [{ legs: [] }],
    pipelineV2: { pass: true, short: false },
  }, { writtenAt: 't' });
  assert.strictEqual(fallback.fallback, true);
  assert.strictEqual(fallback.pipelineV2, true);
  assert.strictEqual(fallback.pass, true);
  assert.strictEqual(fallback.short, false);
  assert.strictEqual(fallback.parlayCount, 1);
  assert.strictEqual(fallback.ok, false, 'fallback clears ok');
}

function testNoMutation() {
  const card = sampleCard();
  const before = JSON.stringify(card);
  const rec = buildHealthRecord(card, {
    writtenAt: '2026-11-04T14:16:00.000Z',
    captureHealth: card.captureHealth,
  });
  rec.date = '1999-01-01';
  rec.qaHardFailList[0].reason = 'mutated';
  rec.qaHardFailList.push({ reason: 'extra' });
  rec.captureStatus.missingSlotsET.push('1000');
  rec.captureStatus.ok = true;
  rec.captureStatus.warning = 'changed';
  rec.sportCoverage.rows[0].kept = 99;
  rec.sportCoverage.injected = true;
  rec.pass = true;
  assert.strictEqual(JSON.stringify(card), before);
  assert.strictEqual(card.qaHardFails[0].reason, 'qb-out');
  assert.deepStrictEqual(card.captureHealth.missingSlotsET, ['0915']);
  assert.strictEqual(card.sportCoverage.rows[0].kept, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(card, 'ok'), false);
  assert.strictEqual(card.captureHealth.reason, 'not copied onto captureStatus');

  const keysBefore = Object.keys(card).sort();
  buildHealthRecord(card, { writtenAt: 't' });
  assert.deepStrictEqual(Object.keys(card).sort(), keysBefore);
}

function testNullSafety() {
  assert.doesNotThrow(() => buildHealthRecord(null));
  assert.doesNotThrow(() => buildHealthRecord(undefined));
  assert.doesNotThrow(() => buildHealthRecord(0));
  assert.doesNotThrow(() => buildHealthRecord('nope'));
  assert.doesNotThrow(() => buildHealthRecord([]));
  assert.doesNotThrow(() => buildHealthRecord({}));

  const empty = buildHealthRecord(null, { writtenAt: '2026-11-04T00:00:00.000Z' });
  assert.strictEqual(empty.date, null);
  assert.strictEqual(empty.generatedAt, null);
  assert.strictEqual(empty.writtenAt, '2026-11-04T00:00:00.000Z');
  assert.strictEqual(empty.model, null);
  assert.strictEqual(empty.engine, null);
  assert.strictEqual(empty.pipelineV2, false);
  assert.strictEqual(empty.sportCoverage, null);
  assert.strictEqual(empty.qaHardFails, 0);
  assert.deepStrictEqual(empty.qaHardFailList, []);
  assert.strictEqual(empty.fallback, false);
  assert.deepStrictEqual(empty.captureStatus, {
    ok: null,
    hardFail: false,
    warning: null,
    usableSnapCount: null,
    missingSlotsET: [],
  });
  assert.strictEqual(empty.straightCount, 0);
  assert.strictEqual(empty.parlayCount, 0);
  assert.strictEqual(empty.pass, null);
  assert.strictEqual(empty.short, null);
  assert.strictEqual(empty.ok, true);

  const partial = buildHealthRecord({
    date: '',
    generatedAt: '',
    model: '',
    engine: '',
    fallback: 'yes',
    qaHardFails: null,
    sportCoverage: 0,
    pipelineV2: true,
    picks: null,
    parlayLegs: { legs: [1] },
    captureHealth: {
      warning: 0,
      usableSnapCount: 0,
      missingSlotsET: '0600',
    },
  }, { writtenAt: 't', captureHealth: null });
  assert.strictEqual(partial.date, null);
  assert.strictEqual(partial.model, null);
  assert.strictEqual(partial.fallback, false, 'only fallback === true');
  assert.strictEqual(partial.qaHardFails, 0);
  assert.deepStrictEqual(partial.qaHardFailList, []);
  assert.strictEqual(partial.sportCoverage, null);
  assert.strictEqual(partial.pipelineV2, true);
  assert.strictEqual(partial.pass, null, 'a boolean flag has no pass/short');
  assert.strictEqual(partial.short, null);
  assert.strictEqual(partial.straightCount, 0);
  assert.strictEqual(partial.parlayCount, 0);
  assert.strictEqual(partial.captureStatus.ok, null);
  assert.strictEqual(partial.captureStatus.hardFail, false);
  assert.deepStrictEqual(partial.captureStatus.missingSlotsET, []);
  assert.strictEqual(partial.ok, true, 'null captureHealth is not a hard fail');

  const bareHealth = buildHealthRecord({ captureHealth: {} }, { writtenAt: 't' });
  assert.deepStrictEqual(bareHealth.captureStatus, {
    ok: null,
    hardFail: false,
    warning: null,
    usableSnapCount: null,
    missingSlotsET: [],
  });
  assert.strictEqual(bareHealth.ok, true);

  const zeroSnaps = buildHealthRecord({}, {
    writtenAt: 't',
    captureHealth: { usableSnapCount: 0, hardFail: false, ok: false, warning: 'degraded', missingSlotsET: [] },
  });
  assert.strictEqual(zeroSnaps.captureStatus.usableSnapCount, 0);
  assert.strictEqual(zeroSnaps.captureStatus.ok, false);
  assert.strictEqual(zeroSnaps.captureStatus.warning, 'degraded');
  assert.strictEqual(zeroSnaps.ok, true, 'ok follows hardFail, not captureStatus.ok');

  const stamped = buildHealthRecord({}, {});
  assert.match(stamped.writtenAt, /^\d{4}-\d{2}-\d{2}T/);
}

function testWiring() {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'),
    'utf8'
  );
  const helperSrc = fs.readFileSync(
    path.join(__dirname, 'netlify/functions/lib/omega-vnext/health_record.js'),
    'utf8'
  );
  assert.ok(/JSON\.parse\(JSON\.stringify/.test(helperSrc));
  assert.ok(!/\bfetch\s*\(/.test(helperSrc));
  const liveAt = indexSrc.indexOf('} else if (!dryRun) {');
  const storeAt = indexSrc.indexOf('await storePicks(dateISO, picksData, { force, simMode });', liveAt);
  const noWriteAt = indexSrc.indexOf("process.env.OMEGA_REPLAY_NO_WRITE !== '1'", storeAt);
  const buildAt = indexSrc.indexOf('buildHealthRecord(picksData', storeAt);
  const datedAt = indexSrc.indexOf('omega-health-${dateISO}', buildAt);
  const latestAt = indexSrc.indexOf("'omega-health-latest'", datedAt);
  const softAt = indexSrc.indexOf("event: 'omegaHealthWriteSoftFail'", storeAt);
  const pmAt = indexSrc.indexOf('let pmObserver = null', latestAt);
  assert.ok(liveAt > 0 && storeAt > liveAt, 'health write follows the live storePicks branch');
  assert.ok(noWriteAt > storeAt && buildAt > noWriteAt && datedAt > buildAt && latestAt > datedAt);
  assert.ok(softAt > storeAt && pmAt > latestAt, 'soft-fail stays in the live branch, before the pm observer');
  const shadowBranch = indexSrc.slice(indexSrc.indexOf('if (!dryRun && shadow)'), liveAt);
  assert.ok(!shadowBranch.includes('omega-health-'));
  assert.ok(!shadowBranch.includes('buildHealthRecord'));
}

testFields();
testNoMutation();
testNullSafety();
testWiring();
console.log('PASS test-omega-health-record');
