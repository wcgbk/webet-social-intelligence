'use strict';
/**
 * Pregame gate clock: historical replay asOf vs live Date.now().
 * A past kickoff that is still in the future relative to the snapshot
 * must not be rejected as in-progress-or-started.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { gateReason, applyGates, resolvePregameAsOfMs, PREGAME_GRACE_MS } = require('./netlify/functions/lib/omega-vnext/gates');

const GRACE = 5 * 60 * 1000;
assert.strictEqual(PREGAME_GRACE_MS, GRACE, 'pregame grace stays 5 minutes');

function cand(commenceTime, extra = {}) {
  return {
    sport: 'NFL',
    matchup: 'A @ B',
    side: 'B -3',
    market: 'Spread',
    odds: -110,
    coverProb: 0.56,
    ev: 0.05,
    edgePct: 0.04,
    predictedClv: 1,
    liquid: true,
    homeTeam: 'B',
    awayTeam: 'A',
    commenceTime,
    ...extra,
  };
}

// Snapshot ~9:00am ET on a day that is already in the past vs wall clock.
const asOfIso = '2026-09-15T13:00:00Z';
const asOfMs = Date.parse(asOfIso);
assert.ok(asOfMs < Date.now() - GRACE, 'fixture snapshot is before real now');

// Evening kickoff that day: after the snapshot, before real now.
const afterSnapshot = '2026-09-15T23:05:00Z';
assert.ok(Date.parse(afterSnapshot) > asOfMs, 'historical candidate kicks off after asOf');
assert.ok(Date.parse(afterSnapshot) < Date.now() - GRACE, 'historical candidate is already started vs Date.now()');

// Kickoff an hour before the snapshot (outside the 5-minute grace).
const beforeSnapshot = '2026-09-15T12:00:00Z';
assert.ok(Date.parse(beforeSnapshot) < asOfMs - GRACE, 'started candidate is before asOf grace');

// --- historical asOfMs: past-vs-now but future-vs-snapshot is still pregame ---
{
  const reason = gateReason(cand(afterSnapshot), { asOfMs, cardDate: '2026-09-15' });
  assert.strictEqual(
    reason,
    null,
    'historical asOf: commenceTime after snapshot must not be in-progress-or-started',
  );
}

// ISO asOf string is accepted the same way (replay passes the snapshot timestamp).
{
  const reason = gateReason(cand(afterSnapshot), { asOf: asOfIso, cardDate: '2026-09-15' });
  assert.notStrictEqual(
    reason,
    'in-progress-or-started',
    'historical asOf ISO: commenceTime after snapshot stays pregame',
  );
  assert.strictEqual(reason, null, 'historical asOf ISO candidate clears pregame and other gates');
}

// --- commenceTime before asOf is in-progress-or-started ---
{
  const reason = gateReason(cand(beforeSnapshot), { asOfMs, cardDate: '2026-09-15' });
  assert.strictEqual(
    reason,
    'in-progress-or-started',
    'historical asOf: commenceTime before snapshot asOf is in-progress-or-started',
  );
  const viaIso = gateReason(cand(beforeSnapshot), { asOf: asOfIso, cardDate: '2026-09-15' });
  assert.strictEqual(viaIso, 'in-progress-or-started', 'historical asOf ISO rejects pre-snapshot kickoff');
}

// 5-minute grace is measured from asOf, not from Date.now().
{
  const insideGrace = new Date(asOfMs - 4 * 60 * 1000).toISOString();
  const outsideGrace = new Date(asOfMs - 6 * 60 * 1000).toISOString();
  assert.notStrictEqual(
    gateReason(cand(insideGrace), { asOfMs, cardDate: '2026-09-15' }),
    'in-progress-or-started',
    'historical asOf grace: kickoff 4 min before snapshot stays pregame',
  );
  assert.strictEqual(
    gateReason(cand(outsideGrace), { asOfMs, cardDate: '2026-09-15' }),
    'in-progress-or-started',
    'historical asOf grace: kickoff 6 min before snapshot is in-progress-or-started',
  );
}

// applyGates yes-pool: only the post-snapshot historical candidate survives.
{
  const { yesPool, rejected } = applyGates(
    [cand(afterSnapshot), cand(beforeSnapshot)],
    { asOfMs, cardDate: '2026-09-15' },
  );
  assert.strictEqual(yesPool.length, 1, 'historical asOf applyGates yesPool keeps post-snapshot game');
  assert.strictEqual(yesPool[0].commenceTime, afterSnapshot);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(
    rejected[0].rejectReason,
    'in-progress-or-started',
    'historical asOf applyGates rejects pre-snapshot game as in-progress-or-started',
  );
}

// Same historical kickoff with asOf omitted is rejected — that is the live clock.
{
  const reason = gateReason(cand(afterSnapshot));
  assert.strictEqual(
    reason,
    'in-progress-or-started',
    'asOf omitted: past commenceTime uses Date.now() and is in-progress-or-started',
  );
}

// --- live semantics when asOf is omitted ---
{
  const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const justStarted = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  assert.strictEqual(
    gateReason(cand(future)),
    null,
    'asOf omitted: future commenceTime stays pregame under Date.now()',
  );
  assert.strictEqual(
    gateReason(cand(past)),
    'in-progress-or-started',
    'asOf omitted: commenceTime before Date.now() grace is in-progress-or-started',
  );
  assert.notStrictEqual(
    gateReason(cand(justStarted)),
    'in-progress-or-started',
    'asOf omitted: 5-minute Date.now() grace still keeps a just-started game',
  );
  const { yesPool, rejected } = applyGates([cand(future), cand(past)]);
  assert.strictEqual(yesPool.length, 1, 'asOf omitted applyGates keeps only the future game');
  assert.strictEqual(rejected[0].rejectReason, 'in-progress-or-started');
}

// Unparseable asOf falls back to Date.now() and does not open the live gate.
{
  assert.ok(
    Math.abs(resolvePregameAsOfMs({ asOf: 'not-a-timestamp' }) - Date.now()) < 2000,
    'unparseable asOf falls back to Date.now()',
  );
  assert.strictEqual(
    gateReason(cand(afterSnapshot), { asOf: 'not-a-timestamp' }),
    'in-progress-or-started',
    'unparseable asOf does not treat a past kickoff as pregame',
  );
  const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(
    gateReason(cand(future), { asOf: 'not-a-timestamp' }),
    null,
    'unparseable asOf keeps live Date.now() acceptance of a future game',
  );
}

// Generator threads a parseable historicalSnapshot into applyGates as asOfMs.
{
  const indexSrc = fs.readFileSync(
    path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'),
    'utf8',
  );
  assert.ok(/replayLike/.test(indexSrc), 'generateOmegaVnext still detects historical replay');
  assert.ok(
    /Date\.parse\(opts\.historicalSnapshot\)/.test(indexSrc),
    'replay path parses historicalSnapshot into asOfMs',
  );
  assert.ok(
    /applyGates\(candidates, gateOpts\)/.test(indexSrc),
    'applyGates receives gateOpts including cardDate and optional asOfMs',
  );
  assert.ok(
    /gateOpts\.asOfMs = asOfMs/.test(indexSrc),
    'parseable historicalSnapshot is passed as asOfMs',
  );
}

// qa_hardfail / select have no second Date.now() pregame kill switch.
{
  const qa = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/qa_hardfail.js'), 'utf8');
  const sel = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/select.js'), 'utf8');
  assert.ok(!/in-progress-or-started/.test(qa), 'qa_hardfail has no pregame in-progress gate');
  assert.ok(!/in-progress-or-started/.test(sel), 'select has no pregame in-progress gate');
  assert.ok(!/pregameOnly/.test(qa) && !/pregameOnly/.test(sel));
}

console.log('PASS test-omega-gates-asof (historical asOf pregame vs live Date.now())');
