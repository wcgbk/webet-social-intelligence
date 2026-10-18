'use strict';
// NFL/NCAAF Lock layer (2026-10-18): formula/receipt stamps, missing-data
// pass, Grade A only for the verified standard bet. Sheet math unchanged.
const assert = require('assert');
const R = './netlify/functions/lib/omega-vnext/';
const { applyMarketAnchor } = require(R + 'prob_anchor');
const { gateReason } = require(R + 'gates');
const { selectStraights } = require(R + 'select');
const { sheetCheckForCandidate } = require(R + 'bet_check_gate');

const future = new Date(Date.now() + 86400000).toISOString();
// Anchored NFL row with formula + receipt: no lock pass, gate-clean on sheet numbers.
const good = {
  sport: 'NFL', market: 'Spread', side: 'Philadelphia Eagles +3', matchup: 'Carolina Panthers @ Philadelphia Eagles',
  odds: 100, line: 3, coverProb: 0.5499, ev: 0.0736, edgePct: 0.0377, liquid: true,
  commenceTime: future, modelPureP: 0.7205, modelProjection: -4.2,
  pinnacleSide: { american: -110, oppAmerican: -110, point: 3, oppPoint: -3 },
};
const [anchored] = applyMarketAnchor([{ ...good }]);
assert.ok(!anchored.lockPass, 'anchored football row must not lock-pass');
assert.strictEqual(anchored.lockFormulaLine, -4.2);
assert.strictEqual(anchored.lockReceiptLine, 3);

// No Pinnacle pair -> unanchored -> Lock mandatory pass at the gates.
const noReceipt = { ...good, pinnacleSide: null };
const [unanchored] = applyMarketAnchor([{ ...noReceipt }]);
assert.strictEqual(unanchored.lockPass, 'lock-missing-data');
assert.strictEqual(gateReason(unanchored, { cardDate: '2026-10-18' }), 'lock-missing-data');

// No formula line -> pass even with a receipt.
const noFormula = { ...good, modelProjection: null };
const [unrated] = applyMarketAnchor([{ ...noFormula }]);
assert.strictEqual(unrated.lockPass, 'lock-missing-data');

// Non-football sports are untouched by the Lock pass.
const mlb = { sport: 'MLB', market: 'Moneyline', side: 'Home', odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.026, liquid: true, commenceTime: future, modelPureP: 0.58, modelProjection: 1.2 };
const [mlbOut] = applyMarketAnchor([{ ...mlb }]);
assert.ok(!('lockPass' in mlbOut) || mlbOut.lockPass == null);

// Grade A prints only on the verified standard bet (selection -> pick object).
const picks = selectStraights([anchored], 3, null, []);
assert.strictEqual(picks.length, 1);
const { toPickObject } = require(R + 'select');
const pickObj = toPickObject(picks[0], {});
assert.strictEqual(pickObj.lockGrade, 'A');
assert.strictEqual(pickObj.lockFormulaLine, -4.2);
assert.strictEqual(pickObj.lockReceiptLine, 3);

// Sheet math untouched by the Lock layer.
const sheet = sheetCheckForCandidate({ sport: 'NFL', market: 'Moneyline', odds: -110, coverProb: 0.55 });
assert.ok(Math.abs(sheet.edgePts - 2.619) < 0.05 && Math.abs(sheet.ev - 0.05) < 0.0005 && sheet.profitPerUnit === 8);
console.log('lock-football tests PASS');
