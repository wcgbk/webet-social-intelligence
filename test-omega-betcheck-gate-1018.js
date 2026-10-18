'use strict';
const assert = require('assert');
const G = require('./netlify/functions/lib/omega-vnext/bet_check_gate');
const { fairPickFields } = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const V1 = require('./v1/model.js');
const { selectStraights } = require('./netlify/functions/lib/omega-vnext/select');
assert.deepStrictEqual(G.THRESHOLDS, V1.THRESHOLDS);
// Sheet Bet Check row 2: -110, p=0.55 (EXAMPLE, GOOD BET)
const s110 = V1.checkBet(-110, 0.55);
console.log('sheet/v1 -110:', s110.decimal, s110.impliedDisplay, s110.edgeDisplay, s110.evDisplay, s110.profitDisplay, s110.band, s110.credibility, s110.verdict);
assert.strictEqual(s110.verdict, 'GOOD BET'); assert.strictEqual(s110.profit, 8);
const g110 = G.checkCandidate({sport:'NFL',market:'Spread',odds:-110}, {pOverride:0.55});
console.log('gate -110:', g110);
assert.strictEqual(g110.verdict, 'GOOD BET'); assert.ok(Math.abs(g110.edgePts-2.619)<0.001);
assert.ok(Math.abs(g110.ev-0.05)<1e-9); assert.strictEqual(g110.profitPerUnit, 8);
assert.strictEqual(g110.kellyUnits, 1.5); // sheet has no Kelly col: quarter-Kelly 0.25*(0.05/0.9091)*100=1.375u -> 1.5u in 0.25u steps (pipeline select.js same rule)
// Today's candidates as pipeline rows (coverProb = anchored final p)
const eagles = {sport:'NFL',market:'Moneyline',side:'Philadelphia Eagles',matchup:'Carolina Panthers @ Philadelphia Eagles',odds:145,oddsStr:'+145',coverProb:0.4364905,ev:0.069404,p_model:0.5791,p_fair:0.388954,commenceTime:'2026-10-18T17:00:00Z',book:'hardrockbet',liquid:true};
const giants = {sport:'NFL',market:'Spread',side:'New York Giants',matchup:'New Orleans Saints @ New York Giants',odds:-125,oddsStr:'-125',coverProb:0.5643105,ev:0.015759,p_model:0.6535,p_fair:0.534586,line:1.5,commenceTime:'2026-10-18T17:00:00Z',book:'draftkings',liquid:true};
console.log('Eagles gate:', G.sheetCheckForCandidate(eagles).verdict, 'Giants gate:', G.sheetCheckForCandidate(giants).verdict);
assert.strictEqual(G.sheetCheckForCandidate(eagles).verdict, 'GOOD BET');
assert.strictEqual(G.sheetCheckForCandidate(giants).verdict, 'NO BET');
assert.strictEqual(G.passesSheetMinimums(giants), false);
// Lean fill can no longer publish a Giants-class lean; Eagles admitted, ranked by true p
const picked = selectStraights([eagles], 3, [{...giants, tier:'lean'}], []);
console.log('selectStraights picks:', picked.map(p=>p.side||p.pick));
assert.strictEqual(picked.length, 1);
// True-probability ranking: higher anchored p first, regardless of EV order
const ranked = G.rankByTrueProbability([eagles, giants]);
assert.strictEqual(ranked[0].side, 'New York Giants'); // 56.4% > 43.6% (Giants still gate-blocked from publishing; rank != admission)
// Flagged, retained (not silently killed)
const raw = G.checkCandidate({sport:'NFL',market:'Moneyline',odds:145}, {pOverride:0.5791});
assert.strictEqual(raw.verdict, 'DO NOT BET - AUDIT'); assert.strictEqual(raw.flagged, true);
// Parlay-leg fair fields survive a published pick
const leg = fairPickFields({odds:'+145', p_fair:0.388954, fairSource:'pinnacle', modelWeight:0.25, p_model:0.5791});
assert.strictEqual(leg.fairSource, 'pinnacle'); assert.strictEqual(leg.evAtFair, '-4.7%');
// Simplified p from core inputs only
assert.ok(Math.abs(G.simplifiedProbability({sport:'NFL',market:'Moneyline',p_model:0.5791,p_fair:0.388954}) - 0.4364905) < 1e-6);
console.log('betcheck-gate tests PASS');
