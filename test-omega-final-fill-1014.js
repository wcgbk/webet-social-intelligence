'use strict';
// v12.3.74 final fill. Flat 2% EV, no edge floor, 12% stale cap,
// -250..+250, EV rank, lean fill, 3x0.25u parlay, stored 10:00 board.
const assert = require('assert');
const fs = require('fs');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { mainMinEv, minEdgeFor } = require('./netlify/functions/lib/omega-vnext/edge_floor');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const {
  compareByEv, orderedByScore, selectStraights, toPickObject, passesPublishFloor, eligibleForLeanPool,
} = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights, isNoQualifyingParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const { eventsFromLineMoves, loadStoredTenAmBoard } = require('./netlify/functions/lib/omega-vnext/stored_board');
const { parseEdgeFraction } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { fetchOddsMultiSport } = require('./netlify/functions/lib/omega-vnext/ingest');

assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.4.0-webetai-pure:'));
assert.strictEqual(config.GATES.minEV.NFL, 0.02);
assert.strictEqual(config.GATES.minEV.MLB, 0.02);
assert.strictEqual(config.GATES.minEV.NBA, 0.02);
assert.strictEqual(config.GATES.minEV.NHL, 0.02);
assert.strictEqual(config.GATES.minEV.NCAAF, 0.02);
assert.strictEqual(config.GATES.minEV.default, 0.02);
assert.strictEqual(config.GATES.maxEV, 0.12);
assert.strictEqual(config.GATES.minAmericanOdds, -250);
assert.strictEqual(config.GATES.maxAmericanOdds, 250);
assert.strictEqual(config.LEAN_PARLAY_UNITS, 0.25);
assert.strictEqual(config.LEAN_MAX_UNITS, 0.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.ok(Math.abs(parseEdgeFraction('-0.5%') + 0.005) < 1e-12);
assert.ok(Math.abs(parseEdgeFraction('1.4%') - 0.014) < 1e-12);
assert.strictEqual(parseEdgeFraction(-0.005), -0.005);
assert.strictEqual(mainMinEv(-250, 0.02), 0.02);
assert.strictEqual(mainMinEv(250, 0.02), 0.02);
assert.strictEqual(mainMinEv(180, null), 0.02);
assert.ok(minEdgeFor(300) > 0.03, 'the curve stays exported and is not the gate');

const asOf = { cardDate: '2026-10-14', asOfMs: Date.parse('2026-10-14T14:00:00Z') };

function side(extra) {
  return {
    sport: 'NFL',
    matchup: 'Jets @ Bills',
    side: 'Bills',
    market: 'Moneyline',
    line: null,
    odds: -110,
    coverProb: 0.55,
    ev: 0.04,
    edgePct: 0.01,
    liquid: true,
    uncertainty: 0.2,
    commenceTime: '2026-10-14T23:15:00Z',
    homeTeam: 'Bills',
    awayTeam: 'Jets',
    book: 'draftkings',
    ...extra,
  };
}

assert.strictEqual(gateReason(side({ edgePct: 0, ev: 0.02 }), asOf), 'edge-floor-se');
assert.strictEqual(gateReason(side({ edgePct: -0.02, ev: 0.03 }), asOf), 'edge-floor-se');
assert.strictEqual(gateReason(side({ odds: -250, ev: 0.02, edgePct: 0.03 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 250, ev: 0.02, edgePct: 0.03 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 260, ev: 0.08 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ odds: -260, ev: 0.08 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ ev: 0.12, edgePct: 0.05 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ ev: 0.10, edgePct: 0.05 }), asOf), null);
assert.strictEqual(gateReason(side({ ev: 0.019, edgePct: 0.04 }), asOf), 'ev-floor');

const logs = [];
const origLog = console.log;
console.log = (...args) => { logs.push(args.map(String).join(' ')); };
let staleReason;
try {
  staleReason = gateReason(side({ ev: 0.1200001, matchup: 'A @ B', side: 'A ML' }), asOf);
} finally {
  console.log = origLog;
}
assert.strictEqual(staleReason, 'ev-stale');
assert.ok(logs.some((line) => line.includes('[omega-vnext] ev-stale') && line.includes('reason=ev-above-cap')));

const stale = side({ ev: 0.15, matchup: 'A @ B', side: 'A ML' });
const gated = applyGates([
  side({ ev: 0.03, edgePct: 0.04 }),
  side({ ev: 0.01, edgePct: 0.04, matchup: 'C @ D', side: 'D', homeTeam: 'D', awayTeam: 'C' }),
  stale,
  side({ odds: 260, ev: 0.05, edgePct: 0.04, matchup: 'E @ F', side: 'F', homeTeam: 'F', awayTeam: 'E' }),
], asOf);
assert.strictEqual(gated.yesPool.length, 1);
assert.strictEqual(gated.yesPool[0].tier, 'floor');
assert.strictEqual(gated.leanPool.length, 1);
assert.strictEqual(gated.leanPool[0].leanReason, 'ev-floor');
assert.ok(gated.rejected.some((row) => row.rejectReason === 'ev-stale'));
assert.ok(gated.rejected.some((row) => row.rejectReason === 'odds-out-of-band'));
assert.ok(!gated.leanPool.some((row) => row.rejectReason === 'ev-stale' || row.ev > config.EV_CAP_ALL));
assert.strictEqual(eligibleForLeanPool(stale), false);

const dog = side({ ev: 0.08, edgePct: 0.01, matchup: 'A @ B', side: 'Dog', homeTeam: 'B', awayTeam: 'A' });
const fav = side({ ev: 0.03, edgePct: 0.09, matchup: 'C @ D', side: 'Fav', homeTeam: 'D', awayTeam: 'C' });
assert.ok(compareByEv(dog, fav) < 0);
assert.strictEqual(orderedByScore([dog, fav])[0].side, 'Dog');
const tieHi = side({ ev: 0.04, edgePct: 0.05, matchup: 'E @ F', side: 'Hi', homeTeam: 'F', awayTeam: 'E' });
const tieLo = side({ ev: 0.04, edgePct: 0.02, matchup: 'G @ H', side: 'Lo', homeTeam: 'H', awayTeam: 'G' });
assert.ok(compareByEv(tieHi, tieLo) < 0);
assert.strictEqual(orderedByScore([tieLo, tieHi])[0].side, 'Hi');

function game(matchup, sideName, ev, extra) {
  const parts = matchup.split(' @ ');
  return side({
    matchup,
    side: sideName,
    homeTeam: parts[1],
    awayTeam: parts[0],
    ev,
    edgePct: 0.001,
    ...extra,
  });
}

const floorOnly = game('A @ B', 'B +3', 0.05, { market: 'Spread', line: 3 });
const sameGame = game('A @ B', 'A +3', 0.04, { market: 'Spread', line: -3 });
const posHigh = game('C @ D', 'D ML', 0.015);
const posLow = game('E @ F', 'F ML', 0.012);
const zero = game('G @ H', 'H ML', 0);
const neg = game('I @ J', 'J ML', -0.02);
const otherBook = game('K @ L', 'L ML', 0.01, { book: 'fanduel' });
const staleFill = game('M @ N', 'N ML', 0.2);
const filled = selectStraights([floorOnly, sameGame], 3, [posLow, zero, neg, otherBook, staleFill, posHigh]);
assert.deepStrictEqual(filled.map((row) => row.side), ['B +3', 'D ML', 'F ML']);
assert.deepStrictEqual(filled.map((row) => row.tier), ['floor', 'lean', 'lean']);
assert.ok(filled.every((row) => passesPublishFloor(row) || row.tier === 'lean'));

const lastResort = selectStraights([floorOnly], 3, [posHigh, zero, neg, staleFill, otherBook]);
assert.deepStrictEqual(lastResort.map((row) => row.side), ['B +3', 'D ML']);
assert.deepStrictEqual(lastResort.map((row) => row.tier), ['floor', 'lean']);
assert.ok(!lastResort.some((row) => row.side === 'N ML' || row.side === 'L ML' || row.side === 'H ML' || row.side === 'J ML'));

const leanPick = toPickObject(lastResort[1]);
const floorPick = toPickObject(lastResort[0]);
assert.strictEqual(leanPick.tier, 'lean');
assert.strictEqual(leanPick.label, 'lean');
assert.strictEqual(leanPick.units, '0.5u');
assert.strictEqual(floorPick.tier, 'floor');
assert.strictEqual(floorPick.label, 'floor');

function pl(matchup, odds, coverProb) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, side: parts[1], market: 'Moneyline', odds, coverProb,
    edgePct: 0.01, homeTeam: parts[1], awayTeam: parts[0], book: 'draftkings', tier: 'floor',
  };
}
const weak = [
  pl('Jets @ Bills', -200, 0.5),
  pl('Dolphins @ Patriots', -200, 0.5),
  pl('Giants @ Cowboys', -200, 0.5),
];
const better = pl('Ravens @ Bengals', 130, 0.55);
const ticket = parlayFromStraights(weak, { pool: [better] });
assert.ok(isNoQualifyingParlay(ticket[0]), 'negative-EV legs are not a parlay');
const priced = [
  pl('Jets @ Bills', 120, 0.55),
  pl('Dolphins @ Patriots', 120, 0.55),
  pl('Giants @ Cowboys', 120, 0.40),
];
const underCover = parlayFromStraights(priced);
assert.ok(isNoQualifyingParlay(underCover[0]), 'a leg under 45% cover leaves fewer than 3 games');
const missing = parlayFromStraights(weak.slice(0, 2));
assert.ok(isNoQualifyingParlay(missing[0]));

const quote = (market, side, team, price, line) => ({ market, side, team, price, line });
const doc = {
  events: [{
    sport: 'NFL',
    eventId: 'e1',
    homeTeam: 'Bills',
    awayTeam: 'Jets',
    commenceTime: '2026-10-14T23:15:00Z',
    checks: [
      {
        slot: '0300',
        at: '2026-10-14T07:00:00Z',
        books: { draftkings: { a: quote('Moneyline', 'Bills', 'Bills', -140, null) } },
      },
      {
        slot: '1000',
        at: '2026-10-14T14:00:00Z',
        books: {
          pinnacle: { a: quote('Moneyline', 'Bills', 'Bills', -120, null) },
          draftkings: { b: quote('Moneyline', 'Bills', 'Bills', -115, null) },
          hardrockbet: { c: quote('Spread', 'Jets', 'Jets', 150, 3.5) },
        },
      },
    ],
  }],
};
const built = eventsFromLineMoves(doc);
assert.strictEqual(built.bySport.NFL.length, 1);
assert.strictEqual(built.at, '2026-10-14T14:00:00Z');
const books = built.bySport.NFL[0].bookmakers.map((row) => row.key).sort();
assert.deepStrictEqual(books, ['draftkings', 'hardrockbet', 'pinnacle']);
const dk = built.bySport.NFL[0].bookmakers.find((row) => row.key === 'draftkings');
assert.strictEqual(dk.markets[0].outcomes[0].price, -115);
const hr = built.bySport.NFL[0].bookmakers.find((row) => row.key === 'hardrockbet');
assert.strictEqual(hr.markets[0].key, 'spreads');
assert.strictEqual(hr.markets[0].outcomes[0].point, 3.5);

const lineMoveSrc = fs.readFileSync(require.resolve('./netlify/functions/lib/omega-vnext/pinnacle_line_move.js'), 'utf8');
const blobKey = require('./netlify/functions/lib/omega-vnext/blob_key');
assert.ok(lineMoveSrc.includes("require('./blob_key')"));
assert.ok(!lineMoveSrc.includes('LINE_MOVE_STORE}/${encodeURIComponent(key)}'));
assert.strictEqual(blobKey.canonicalBlobKey('date/2026-10-14'), 'date/2026-10-14');
assert.strictEqual(blobKey.legacyEncodedBlobKey('date/2026-10-14'), 'date%2F2026-10-14');
assert.notStrictEqual(blobKey.canonicalBlobKey('date/2026-10-14'), blobKey.legacyEncodedBlobKey('date/2026-10-14'));

const secondDoc = {
  schema: 'omega-pinnacle-line-moves-v1',
  sport: 'NHL',
  eventId: 'game-2',
  homeTeam: 'Rangers',
  awayTeam: 'Devils',
  checks: [{
    slot: '1000',
    at: '2026-10-14T14:05:00Z',
    books: {
      pinnacle: { a: quote('Moneyline', 'Rangers', 'Rangers', -130, null) },
      draftkings: { b: quote('Moneyline', 'Rangers', 'Rangers', -125, null) },
    },
  }],
};
(async () => {
  const merged = await loadStoredTenAmBoard('2026-10-14', {
    readPinnacleLineMoves: async () => ({ schema: doc.schema, events: [] }),
    readOddsMaster: async (key) => {
      assert.strictEqual(key, 'by-date/2026-10-14');
      return { schema: 'odds-master-date-v1', events: [{ sport: 'NHL', eventId: 'game-2' }] };
    },
    readLineMoveKey: async (key) => {
      assert.strictEqual(key, 'NHL/game-2');
      return secondDoc;
    },
  });
  assert.ok(merged && merged.bySport.NHL && merged.bySport.NHL.length === 1);
  assert.strictEqual(merged.bySport.NHL[0].home_team, 'Rangers');
  assert.strictEqual(merged.snapshotNote, 'stored-10:00');

  let fetches = 0;
  const prevFetch = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    throw new Error('network blocked');
  };
  try {
    const board = await loadStoredTenAmBoard('2026-10-14', {
      readPinnacleLineMoves: async () => doc,
    });
    const missingBoard = await loadStoredTenAmBoard('2026-10-13', {
      readPinnacleLineMoves: async () => null,
    });
    const odds = await fetchOddsMultiSport('2026-10-14', {
      storedBoardOnly: true,
      readPinnacleLineMoves: async () => doc,
    });
    assert.strictEqual(odds.storedSnapshot, true);
    assert.strictEqual(odds.paidPull, 0);
    assert.strictEqual(odds.snapshotNote, 'stored-10:00');
    assert.ok(odds.bySport.NFL && odds.bySport.NFL.length === 1);
    const empty = await fetchOddsMultiSport('2026-10-13', {
      storedBoardOnly: true,
      readPinnacleLineMoves: async () => null,
    });
    assert.strictEqual(empty.snapshotNote, 'stored-10:00-missing');
    assert.strictEqual(empty.paidPull, 0);
    assert.strictEqual(empty.storedSnapshot, false);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(board.storedSnapshot, true);
    assert.strictEqual(board.paidPull, 0);
    assert.strictEqual(missingBoard, null);
  } finally {
    global.fetch = prevFetch;
  }
  console.log('PASS test-omega-final-fill-1014');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
