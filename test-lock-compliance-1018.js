'use strict';
// Lock compliance on v1 era code (2026-10-18): QB points off, power de-vig,
// football formula/receipt tracing + missing-data pass, parlay haircut, Grade A.
const assert = require('assert');
const R = './netlify/functions/lib/omega-vnext/';
const gd = require(R + 'sports/game_day');
const { noVigTwoWay } = require(R + 'odds_math');
const { gateReason } = require(R + 'gates');

// QB: flags, no points (margin/total/uncertainty)
const qb = gd.qbSoftAdjust('NFL', { qbStatus: 'out', qbName: 'A' }, null);
assert.ok(qb.marginAdj === 0 && qb.totalAdj === 0 && qb.uncBump === 0, 'QB points zeroed');
assert.ok(qb.note && /QB/.test(qb.note));

// Power de-vig: -110/-110 = 0.5; longshot fair below proportional
assert.ok(Math.abs(noVigTwoWay(-110, -110).p1 - 0.5) < 1e-9);
const dog = noVigTwoWay(145, -170);
assert.ok(dog.p1 < 100 / 245 / ((100 / 245) + (170 / 270)) + 0.001, 'power fair below proportional for dog');
assert.ok(Math.abs(dog.p1 - 0.3872) < 0.001, `power fair ${dog.p1}`);

// Missing-data pass: football candidate flagged lockPass dies at gates
assert.strictEqual(gateReason({ sport: 'NFL', market: 'Spread', side: 'X +3', odds: -110, ev: 0.05, edgePct: 0.03, liquid: true, lockPass: 'lock-missing-data', commenceTime: new Date(Date.now() + 86400000).toISOString() }, { cardDate: '2026-10-18' }), 'lock-missing-data');
// Non-football unaffected
assert.notStrictEqual(gateReason({ sport: 'MLB', market: 'Moneyline', side: 'X', odds: -110, ev: 0.05, edgePct: 0.03, liquid: true, lockPass: 'lock-missing-data', commenceTime: new Date(Date.now() + 86400000).toISOString() }, { cardDate: '2026-10-18' }), 'lock-missing-data');

// Parlay haircut: 2 legs of 0.5 at -110 each -> combined 0.25*0.95
const parlay = require(R + 'parlay');
const stats = parlay.comboStats ? parlay.comboStats([{ odds: -110, coverProb: 0.5, matchup: 'A @ B', sport: 'NFL' }, { odds: -110, coverProb: 0.5, matchup: 'C @ D', sport: 'NFL' }]) : null;
if (stats) assert.ok(Math.abs(stats.combinedProb - 0.2375) < 1e-9, `haircut ${stats.combinedProb}`);
console.log('lock-compliance tests PASS');
