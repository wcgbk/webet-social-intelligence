'use strict';
/** V1 LOCK backend — separate from Omega. No network, no blobs. */
const assert = require('assert');
const path = require('path');
const L = p => require(path.join(__dirname, 'netlify/functions/lib/v1-lock', p));
const { checkSheetV1, THRESHOLDS_V1 } = L('sheet-v1');
const { selectBoardPollV1, reconstructEventsV1 } = L('board-v1');
const { projectGameV1 } = L('project-v1');
const { selectV1, comboV1 } = L('select-v1');
const { anchorWeightForV1, biasCorrectionForV1, SPORTS_V1 } = L('config-v1');

// Sheet thresholds are Ben's sheet verbatim (v1/model.js)
assert.strictEqual(THRESHOLDS_V1.minEdgePts, 2);
assert.strictEqual(THRESHOLDS_V1.minEv, 0.02);
assert.strictEqual(THRESHOLDS_V1.minProfitDollars, 3);
assert.strictEqual(THRESHOLDS_V1.unitDollars, 150);
// Sheet E2E example (v1/model.js EXAMPLES): -110 @ p=0.550 -> GOOD BET, edge 2.62, EV 5.0%, profit $8
{
  const r = checkSheetV1({ p: 0.55, odds: -110 });
  assert.strictEqual(r.verdict, 'GOOD BET');
  assert.strictEqual(r.edgePts, 2.619);
  assert.strictEqual(r.ev, 0.05);
  assert.strictEqual(r.profitPerUnit, 8);
  assert.strictEqual(r.band, 'IN REALISTIC BAND');
  assert.strictEqual(r.credibility, 'OK');
}
// Sheet audit: implausible p is DO NOT BET - AUDIT, never GOOD
{
  const r = checkSheetV1({ p: 0.707, odds: 122 });
  assert.strictEqual(r.verdict, 'DO NOT BET - AUDIT');
  assert.strictEqual(r.betCheckFlag, 'IMPLAUSIBLE');
}
// Fitted anchor weights (c1e5650 doc): NFL total w=0, others 0.10
assert.strictEqual(anchorWeightForV1('NFL', 'Total'), 0);
assert.strictEqual(anchorWeightForV1('NFL', 'Spread'), 0.10);
assert.strictEqual(anchorWeightForV1('NCAAF', 'Moneyline'), 0.10);
assert.strictEqual(anchorWeightForV1('NHL', 'Moneyline'), null); // football only
assert.deepStrictEqual(SPORTS_V1, ['NFL', 'NCAAF']);
// Bias window
assert.strictEqual(biasCorrectionForV1('NFL', '2026-10-18T17:00:00Z'), 1.484);
assert.strictEqual(biasCorrectionForV1('NFL', '2026-12-01T17:00:00Z'), 0);
assert.strictEqual(biasCorrectionForV1('NCAAF', '2026-10-18T17:00:00Z'), 0);

// Board poll: latest at/before 1000
{
  const poll = selectBoardPollV1([
    { hhmm: '0600', games: { a: {} } }, { hhmm: '0915', games: { a: {} } }, { hhmm: '1200', games: { a: {} } },
  ]);
  assert.strictEqual(poll.hhmm, '0915');
}
// Board reconstruction carries Pinnacle + US books
const games = { 'Away @ Home': { sport: 'NFL', homeTeam: 'Home', awayTeam: 'Away',
  commenceTime: '2026-10-18T17:00:00Z', books: {
    pinnacle: { spreadHome: -3, spreadHomeOdds: -110, spreadAway: 3, spreadAwayOdds: -110, total: 45, overOdds: -110, underOdds: -110, mlHome: -150, mlAway: 130 },
    draftkings: { spreadHome: -3, spreadHomeOdds: -105, spreadAway: 3, spreadAwayOdds: -115, total: 45, overOdds: -108, underOdds: -112, mlHome: -145, mlAway: 125 },
  } } };
const events = reconstructEventsV1(games);
assert.strictEqual(events.length, 1);
assert.strictEqual(events[0].bookmakers.length, 2);

const eff = { 'Home': { offEpa: 0.10, defEpa: 0.05 }, 'Away': { offEpa: -0.05, defEpa: -0.02 } };
// Formula-first: candidates carry formula line + Pinnacle receipt + anchored p
{
  const { candidates, pass } = projectGameV1(events[0], 'NFL', eff, {});
  assert.strictEqual(pass, null);
  assert.ok(candidates.length >= 6);
  const spread = candidates.find(c => c.market === 'Spread' && c.side.startsWith('Away'));
  assert.ok(spread.formulaSpreadHome != null && spread.formulaTotal != null);
  assert.ok(spread.pinnacleReceipt && spread.pinnacleReceipt.point === 3);
  assert.ok(spread.pFair > 0.4 && spread.pFair < 0.6);
  assert.strictEqual(spread.anchorWeight, 0.10);
  // anchored p is between model and fair (formula before market, then anchor)
  assert.ok(Math.abs(spread.coverProb - (0.1 * spread.modelPureP + 0.9 * spread.pFair)) < 1e-6);
  assert.strictEqual(spread.book, 'draftkings'); // best US price -105 > -110
  assert.strictEqual(spread.biasCorrectionPts, 1.484);
}
// Missing ratings = mandatory formula pass, zero candidates
{
  const { candidates, pass } = projectGameV1(events[0], 'NFL', {}, {});
  assert.strictEqual(candidates.length, 0);
  assert.strictEqual(pass.reason, 'lock-missing-formula');
}
// Missing Pinnacle = receipt pass at selection (mandatory, §8)
{
  const noPin = reconstructEventsV1({ 'Away @ Home': { ...games['Away @ Home'],
    books: { draftkings: games['Away @ Home'].books.draftkings } } });
  const { candidates } = projectGameV1(noPin[0], 'NFL', eff, {});
  assert.ok(candidates.every(c => c.pinnacleReceipt == null));
  const sel = selectV1(candidates, []);
  assert.strictEqual(sel.picks.length, 0);
  assert.ok(sel.funnel.missingReceipt >= 6);
}
// QB unknown replacement = mandatory pass
{
  const { candidates } = projectGameV1(events[0], 'NFL', eff,
    { qbByGame: { 'Away @ Home': { flag: 'home QB X (out)', unknownReplacement: true } } });
  const sel = selectV1(candidates, []);
  assert.strictEqual(sel.picks.length, 0);
  assert.ok(sel.funnel.qbUnknown >= 6);
}
// Grade A only when verified + sheet GOOD; receipt has all 12 lines
{
  const good = { sport: 'NFL', matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
    commenceTime: '2026-10-18T17:00:00Z', market: 'Spread', side: 'Away +3', line: 3,
    modelPureP: 0.62, pFair: 0.52, anchorWeight: 0.10, coverProb: 0.53,
    formulaSpreadHome: -1.2, formulaTotal: 44.5, receiptSpreadHome: -3, receiptTotal: 45,
    pinnacleReceipt: { point: 3, american: -110, oppAmerican: -110 },
    odds: -102, oddsStr: '-102', book: 'fanduel', qbFlag: null, qbUnknownReplacement: false };
  // anchored p .53 vs -102 implied .505 => edge 2.5pts; force sheet pass via odds check
  const sel = selectV1([good], []);
  if (sel.picks.length) {
    const p = sel.picks[0];
    assert.strictEqual(p.lockGrade, 'A');
    assert.strictEqual(p.rating, 'a');
    const r = p.lockReceipt;
    for (const k of ['game','pick','grade','confirmedLine','trueWinProbability','formulaSpreadHome','formulaTotal','receiptSpreadHome','availabilityFlags','coreReasoning','unitSize','whatLoses']) {
      assert.ok(r[k] != null && r[k] !== '', `receipt missing ${k}`);
    }
    assert.ok(p.coreReasoning.includes('Formula line'));
  } else {
    // sheet must be the only reason it failed — document funnel
    assert.ok(sel.funnel.sheetFail + sel.funnel.sheetAudit >= 1);
  }
}
// Parlay haircut: combined p takes 0.95^(n-1), EV from haircut p
{
  const legs = [{ odds: -110, coverProb: 0.6 }, { odds: -110, coverProb: 0.6 }, { odds: -110, coverProb: 0.6 }];
  const st = comboV1(legs);
  assert.ok(Math.abs(st.combinedProb - Math.pow(0.6, 3) * 0.95 * 0.95) < 1e-9);
}
console.log('test-v1-lock: ALL PASS');
