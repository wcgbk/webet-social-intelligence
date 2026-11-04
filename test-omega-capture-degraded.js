'use strict';

/**
 * Live generate with zero usable morning snaps publishes a degraded card.
 * assessCaptureHealth still reports hardFail. cardCaptureHealth downgrades it.
 * No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const linePath = require('./netlify/functions/lib/omega-vnext/line_path');

function emptyAssessment() {
  return linePath.assessCaptureHealth('2026-09-22', { path: { polls: [] } }, {
    retriedCapture: true,
    retryOk: false,
  });
}

function oneSnapAssessment() {
  return linePath.assessCaptureHealth('2026-09-22', {
    path: { polls: [
      { hhmm: '0300', gameCount: 4, games: { a: { homeTeam: 'A' } } },
    ] },
  });
}

const raw = emptyAssessment();
assert.strictEqual(raw.hardFail, true);
assert.strictEqual(raw.usableSnapCount, 0);
assert.ok(/zero usable morning line snaps/.test(raw.reason));

let threw = false;
let card;
try {
  card = linePath.cardCaptureHealth(raw, { replayLike: false, dateISO: '2026-09-22' });
} catch (err) {
  threw = true;
}
assert.strictEqual(threw, false, 'live zero-snap downgrade does not throw');
assert.notStrictEqual(card, raw);
assert.strictEqual(raw.hardFail, true, 'raw assessment stays a hard fail');
assert.strictEqual(card.hardFail, false);
assert.strictEqual(card.ok, false);
assert.strictEqual(card.degraded, true);
assert.strictEqual(card.usableSnapCount, 0);
assert.strictEqual(card.retriedCapture, true);
assert.strictEqual(card.retryOk, false);
assert.ok(/zero usable morning line snaps/.test(card.warning));
assert.ok(/line-move annotation was skipped/.test(card.warning));
assert.ok(/zero usable morning line snaps/.test(card.reason));
assert.ok(/line-move annotation was skipped/.test(card.reason));
assert.ok(card.missingSlotsET.includes('1000'));

const partial = oneSnapAssessment();
const partialCard = linePath.cardCaptureHealth(partial, { replayLike: false, dateISO: '2026-09-22' });
assert.strictEqual(partialCard, partial, 'one usable snap is the same object');
assert.strictEqual(partialCard.hardFail, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(partialCard, 'degraded'), false);

const full = linePath.assessCaptureHealth('2026-09-22', {
  path: { polls: ['0300', '1000'].map((hhmm) => ({
    hhmm, gameCount: 2, games: { a: 1, b: 1 },
  })) },
});
const fullCard = linePath.cardCaptureHealth(full, { replayLike: false, dateISO: '2026-09-22' });
assert.strictEqual(fullCard, full);
assert.strictEqual(fullCard.ok, true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(fullCard, 'degraded'), false);

const replayEmpty = linePath.cardCaptureHealth(raw, { replayLike: true, dateISO: '2026-09-22' });
assert.strictEqual(replayEmpty.hardFail, false);
assert.strictEqual(replayEmpty.ok, false);
assert.strictEqual(replayEmpty.reason, null);
assert.strictEqual(replayEmpty.retriedCapture, false);
assert.strictEqual(replayEmpty.retryOk, null);
assert.strictEqual(
  replayEmpty.warning,
  'CAPTURE_HEALTH: historical replay skips live snap retry/hard-fail for 2026-09-22'
);
assert.strictEqual(Object.prototype.hasOwnProperty.call(replayEmpty, 'degraded'), false);

const replayFull = linePath.cardCaptureHealth(full, { replayLike: true, dateISO: '2026-09-22' });
assert.strictEqual(replayFull.ok, true);
assert.strictEqual(replayFull.hardFail, false);
assert.strictEqual(replayFull.warning, null);
assert.strictEqual(replayFull.reason, null);
assert.strictEqual(replayFull.retriedCapture, false);
assert.strictEqual(replayFull.retryOk, null);
assert.strictEqual(Object.prototype.hasOwnProperty.call(replayFull, 'degraded'), false);

const indexSrc = fs.readFileSync(
  path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'),
  'utf8'
);
const replayCall = indexSrc.indexOf('cardCaptureHealth(captureHealth, { replayLike: true, dateISO })');
const liveCall = indexSrc.indexOf('cardCaptureHealth(captureHealth, { replayLike: false, dateISO })');
const warnAt = indexSrc.indexOf('if (captureHealth.warning || captureHealth.hardFail) console.warn(JSON.stringify(healthLog))');
const emitAt = indexSrc.indexOf('await emitCaptureHealthOps(dateISO, captureHealth');
assert.ok(replayCall > 0 && replayCall < warnAt, 'replay health is set before the captureHealth log');
assert.ok(warnAt > 0 && emitAt > warnAt, 'ops signal still follows the captureHealth warning');
assert.ok(liveCall > emitAt, 'live downgrade happens after the zero-snap ops signal');
assert.ok(!/code = 'CAPTURE_HEALTH'/.test(indexSrc), 'generate does not throw CAPTURE_HEALTH');
assert.ok(/liveZeroSnaps/.test(indexSrc), 'zero usable snaps skip line-move annotation');
assert.ok(/line-move: no morning snaps/.test(indexSrc));
assert.ok(/const retrySlot = null/.test(indexSrc));

const bgSrc = fs.readFileSync(
  path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'),
  'utf8'
);
assert.ok(/err\.code === 'CAPTURE_HEALTH'/.test(bgSrc), '503 branch stays for any other thrower');
assert.ok(/statusCode: 503/.test(bgSrc));

console.log('PASS test-omega-capture-degraded');
