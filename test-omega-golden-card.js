'use strict';

/**
 * Golden card for the frozen 2026-10-10 morning pool. No network.
 *
 * test-omega-1010-lock.js loads test/fixtures/live-1010-2026-10-10.json and
 * gates that snapshot as-is. Those rows have no bookPrices ladder, so
 * applyExecutionBook keeps non-DraftKings prices (the lock test wants that).
 * There is no 2026-10-11 candidate snapshot in the repo. test-omega-1011-card.js
 * builds synthetic rows and does not publish a full card.
 *
 * This file freezes a copy of the 10/10 snapshot with a one-book ladder on
 * every row. applyExecutionBook then keeps DraftKings and drops every other
 * book. The run is the generate selection path without a fetch:
 *
 *   applyExecutionBook → applyGates → selectStraights → applyHardFails({})
 *   → optimizeParlay → applyDailyUnitCap
 *
 * loadQaContext is not called. An empty QA context does not hit the network.
 * Narration is skipped. OMEGA_REPLAY_NO_WRITE is irrelevant here because this
 * file does not call the store.
 *
 * Regenerate the stored pick set after an intentional selection change:
 *
 *   OMEGA_REGEN_GOLDEN=1 node test-omega-golden-card.js
 *
 * Rebuild the frozen input from the live-1010 fixture, then the pick set:
 *
 *   OMEGA_REGEN_GOLDEN=input node test-omega-golden-card.js
 *
 * Both commands rewrite a fixture and still assert the card invariants.
 * They do not fetch odds and they do not write blobs. Review the diff.
 * Do not set the flag in CI.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = __dirname;
const vnext = path.join(repo, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(vnext, 'config'));
const { applyExecutionBook } = require(path.join(vnext, 'selection_pass'));
const { applyGates } = require(path.join(vnext, 'gates'));
const {
  selectStraights, applyDailyUnitCap, passesPublishFloor, matchupKey,
} = require(path.join(vnext, 'select'));
const { optimizeParlay } = require(path.join(vnext, 'parlay'));
const { applyHardFails } = require(path.join(vnext, 'qa_hardfail'));

const LIVE = path.join(repo, 'test/fixtures/live-1010-2026-10-10.json');
const INPUT = path.join(repo, 'test/fixtures/golden-card-2026-10-10.input.json');
const EXPECTED = path.join(repo, 'test/fixtures/golden-card-2026-10-10.expected.json');
const CARD_DATE = '2026-10-10';
const AS_OF = '2026-10-10T14:30:00Z';

function parseU(units) {
  return parseFloat(String(units || '0').replace(/[^0-9.]/g, '')) || 0;
}

function parsePct(value) {
  return parseFloat(String(value == null ? '' : value).replace('%', ''));
}

function stampCandidate(row) {
  const odds = typeof row.odds === 'number'
    ? row.odds
    : parseFloat(String(row.odds).replace(/[^0-9.+-]/g, ''));
  const book = row.book || 'draftkings';
  return {
    ...row,
    odds,
    book,
    bookPrices: [{
      book,
      american: odds,
      point: row.line == null ? null : Number(row.line),
    }],
  };
}

/**
 * Frozen input. Each yes[] and rejected[] row from the 10/10 snapshot gets
 * a ladder that contains only the book already on the row. DraftKings rows
 * stay priced at that American number. espnbet and bovada rows have no
 * DraftKings quote, so applyExecutionBook drops them and the next DraftKings
 * number on that game can fill the bet. liquid:false rows stay on the board
 * so the major-book gate still rejects them.
 */
function freezeFromLive(live) {
  const candidates = [];
  for (const bucket of ['yes', 'rejected']) {
    for (const row of live[bucket] || []) candidates.push(stampCandidate(row));
  }
  return {
    cardDate: CARD_DATE,
    asOf: AS_OF,
    derivedFrom: 'test/fixtures/live-1010-2026-10-10.json',
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(LIVE)).digest('hex'),
    derivation: [
      'Built from test/fixtures/live-1010-2026-10-10.json (the snapshot',
      'test-omega-1010-lock.js replays). Each row gets bookPrices: [{ book,',
      'american, point }] for the book already on the row. No odds were fetched.',
      'applyExecutionBook drops a ladder with no DraftKings quote (espnbet Over',
      '38.5 and bovada Sacramento State +9) and reprices every DraftKings row',
      'at that quote. There is no 2026-10-11 candidate snapshot; 1011 coverage',
      'is the synthetic rule test, not this card.',
    ].join(' '),
    candidates,
  };
}

function project(capped) {
  const straights = (capped.picks || []).map((p) => ({
    sport: p.sport,
    matchup: p.matchup,
    pick: p.pick,
    betType: p.betType,
    book: p.book,
    line: p.line == null ? null : p.line,
    odds: p.odds,
    units: p.units,
    ev: p.ev,
    edgePct: p.edgePct,
    tier: p.tier,
    rating: p.rating,
  }));
  const ticket = (capped.parlayLegs || [])[0] || null;
  const parlay = ticket ? {
    type: ticket.type,
    units: ticket.units,
    ev: ticket.ev,
    legs: (ticket.legs || []).map((leg) => ({
      sport: leg.sport,
      matchup: leg.matchup,
      pick: leg.pick,
      betType: leg.betType,
      book: leg.book,
      line: leg.line == null ? null : leg.line,
      odds: leg.odds,
      ev: leg.ev,
    })),
  } : null;
  return { straights, parlay };
}

function runCard(frozen) {
  const execution = applyExecutionBook(frozen.candidates);
  const gated = applyGates(execution.candidates, {
    cardDate: frozen.cardDate,
    asOfMs: Date.parse(frozen.asOf),
  });
  const selected = selectStraights(gated.yesPool, config.MAX_STRAIGHTS, gated.leanPool);
  const qa = applyHardFails(selected, gated.yesPool, {}, {
    maxN: config.MAX_STRAIGHTS,
    modelVersion: config.MODEL_VERSION,
    leanPool: gated.leanPool,
  });
  assert.deepStrictEqual(qa.hardFails, [], 'frozen card must not hard-fail without a live QA feed');
  const leanLegs = (gated.leanPool || []).filter((c) => {
    const ev = Number(c && c.ev);
    return c && c.tier === 'lean' && ev + 1e-12 >= config.LEAN_MIN_EV;
  });
  const pool = gated.yesPool.filter((c) => passesPublishFloor(c)).concat(leanLegs);
  const parlay = optimizeParlay(pool, qa.picks, { cardDate: frozen.cardDate });
  const capped = applyDailyUnitCap(qa.picks, parlay);
  return { execution, gated, capped, projection: project(capped) };
}

function assertInvariants(card) {
  const { execution, projection } = card;
  const dropped = (execution.excluded || []).map((c) => `${c.book} ${c.side}`);
  assert.deepStrictEqual(dropped.sort(), [
    'bovada Sacramento State Hornets +9',
    'espnbet Over 38.5',
  ]);
  assert.ok(execution.candidates.length > 0);
  assert.ok(execution.candidates.every((c) => c.book === 'draftkings'), 'kept rows are DraftKings');

  const straights = projection.straights;
  assert.strictEqual(straights.length, config.MAX_STRAIGHTS, 'exactly 3 straights');
  assert.strictEqual(new Set(straights.map((p) => matchupKey(p))).size, straights.length, 'one straight per game');
  const floorPct = config.GATES.minEV.default * 100;
  const leanPct = config.LEAN_MIN_EV * 100;
  let straightUnits = 0;
  for (const pick of straights) {
    assert.strictEqual(pick.book, 'draftkings', pick.pick);
    const ev = parsePct(pick.ev);
    assert.ok(Number.isFinite(ev) && ev > 0, pick.ev);
    if (pick.tier === 'lean') {
      assert.ok(ev + 1e-9 >= leanPct, `${pick.pick} lean EV ${pick.ev}`);
      assert.ok(parseU(pick.units) <= config.LEAN_MAX_UNITS + 1e-9, pick.units);
    } else {
      assert.strictEqual(pick.tier, 'floor', pick.tier);
      assert.ok(ev + 1e-9 >= floorPct, `${pick.pick} floor EV ${pick.ev}`);
    }
    if (String(pick.rating || '').toLowerCase() === 'b') {
      assert.ok(parseU(pick.units) <= config.B_GRADE_UNIT_CAP + 1e-9, pick.units);
    }
    const units = parseU(pick.units);
    assert.ok(units <= config.MAX_STRAIGHT_UNITS_PER_PICK + 1e-9, pick.units);
    assert.ok(units > 0, pick.units);
    straightUnits += units;
  }
  assert.ok(straightUnits <= config.STRAIGHT_UNIT_BUDGET + 1e-9, `straights ${straightUnits}u`);

  const parlay = projection.parlay;
  assert.ok(parlay, 'card publishes a parlay');
  assert.strictEqual(parlay.legs.length, 3, 'parlay has exactly 3 legs');
  assert.strictEqual(new Set(parlay.legs.map((leg) => matchupKey(leg))).size, 3, 'parlay legs are three games');
  const fullCard = straights.some((p) => {
    const r = String(p.rating || '').toLowerCase().replace(/\s+/g, '');
    return r === 'aplus' || r === 'a+' || r === 'a' || r === 'aminus' || r === 'a-';
  });
  assert.strictEqual(parseU(parlay.units), fullCard ? config.PARLAY_FIXED_UNITS : config.LEAN_PARLAY_UNITS);
  assert.ok(parsePct(parlay.ev) > 0, parlay.ev);
  for (const leg of parlay.legs) {
    assert.strictEqual(leg.book, 'draftkings', leg.pick);
    assert.ok(parsePct(leg.ev) > 0, `${leg.pick} ${leg.ev}`);
  }
  const total = straightUnits + parseU(parlay.units);
  assert.ok(total <= config.DAILY_UNIT_CAP + 1e-9, `daily ${total}u`);
}

function writeJson(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function main() {
  const mode = String(process.env.OMEGA_REGEN_GOLDEN || '').trim().toLowerCase();
  const regenInput = mode === 'input' || mode === 'all';
  const regenExpected = regenInput || mode === '1' || mode === 'true' || mode === 'expected';

  let frozen;
  if (regenInput) {
    assert.ok(fs.existsSync(LIVE), `missing source snapshot ${LIVE}`);
    frozen = freezeFromLive(JSON.parse(fs.readFileSync(LIVE, 'utf8')));
  } else {
    assert.ok(fs.existsSync(INPUT), `missing ${INPUT}. Rebuild with OMEGA_REGEN_GOLDEN=input node test-omega-golden-card.js`);
    frozen = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  }

  const card = runCard(frozen);
  const again = runCard(JSON.parse(JSON.stringify(frozen)));
  assert.deepStrictEqual(again.projection, card.projection, 'same frozen input publishes the same card');
  assertInvariants(card);

  const expectedBody = {
    regen: 'OMEGA_REGEN_GOLDEN=1 node test-omega-golden-card.js',
    inputRegen: 'OMEGA_REGEN_GOLDEN=input node test-omega-golden-card.js',
    cardDate: frozen.cardDate,
    note: 'Rewrite only for an intentional selection change. Review the diff. The command does not fetch odds or write blobs.',
    comment: 'v12.4.2 textbook: same sides. These A- prices are quarter Kelly at the 1.5u cap. A full card parlays 0.5u. EV above 10% stays off the card. Parlay joint uses 0.95^(n-1).',
    straights: card.projection.straights,
    parlay: card.projection.parlay,
  };

  if (regenInput) {
    writeJson(INPUT, frozen);
    console.log(`rewrote ${path.relative(repo, INPUT)}`);
  }
  if (regenExpected) {
    writeJson(EXPECTED, expectedBody);
    console.log(`rewrote ${path.relative(repo, EXPECTED)}`);
  } else {
    assert.ok(fs.existsSync(EXPECTED), `missing ${EXPECTED}. Record it with OMEGA_REGEN_GOLDEN=1 node test-omega-golden-card.js`);
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    assert.deepStrictEqual(card.projection.straights, expected.straights, 'straight pick set drifted from the golden fixture');
    assert.deepStrictEqual(card.projection.parlay, expected.parlay, 'parlay pick set drifted from the golden fixture');
  }

  console.log('PASS test-omega-golden-card');
  console.log(JSON.stringify({
    straights: card.projection.straights.map((p) => `${p.pick} ${p.units} ${p.ev}`),
    parlay: card.projection.parlay.legs.map((leg) => leg.pick),
    parlayEv: card.projection.parlay.ev,
    parlayUnits: card.projection.parlay.units,
  }));
}

main();
