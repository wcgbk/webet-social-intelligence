'use strict';
const assert = require('assert');
const S = require('./netlify/functions/lib/omega-v1ab/sharp');
const { buildCard } = require('./netlify/functions/generate-picks-omega-v1-background');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const mk = (o) => ({ matchup: 'A @ B', side: 'A', market: 'Moneyline', odds: 100, coverProb: 0.53, edgePct: 0.03, uncertainty: 0.2, sport: 'NHL', bestDkHr: { book: 'draftkings', american: o.odds != null ? o.odds : 100 }, ...o });

t('1 calibration shrinks toward fair by uncertainty', () => {
  const x = S.calibrateSharp(mk({ coverProb: 0.55, edgePct: 0.05, uncertainty: 0.4 }));
  assert.ok(Math.abs(x.fair - 0.50) < 1e-9); assert.ok(Math.abs(x.pSharp - 0.53) < 1e-9);
  const y = S.calibrateSharp(mk({ uncertainty: 1 })); assert.ok(Math.abs(y.pSharp - y.fair) < 1e-9);
});
t('1b brier + reliability', () => {
  assert.ok(Math.abs(S.brierScore([{ p: 0.6, y: 1 }, { p: 0.6, y: 0 }]) - 0.26) < 1e-9);
  const b = S.reliabilityBuckets([{ p: 0.52, y: 1 }, { p: 0.53, y: 0 }]); assert.strictEqual(b.find(x => x.bucket === '50-55%').n, 2);
});
t('2 rank by calibrated edge, EV>0, edge>=0.5pp, odds band', () => {
  const pool = [
    mk({ matchup: 'G1', coverProb: 0.31, edgePct: 0.02, odds: 250, uncertainty: 0.1 }),
    mk({ matchup: 'G2', coverProb: 0.55, edgePct: 0.03, odds: -105, uncertainty: 0.2 }),
    mk({ matchup: 'G3', coverProb: 0.80, edgePct: 0.03, odds: -350, uncertainty: 0.1 }),
    mk({ matchup: 'G4', coverProb: 0.505, edgePct: 0.004, odds: 100, uncertainty: 0.2 }),
  ];
  const r = S.selectSharp(pool, { nowMs: 0 });
  assert.deepStrictEqual(r.qualified.map(x => x.matchup), ['G2', 'G1']);
  assert.ok(r.qualified[1].evSharp > r.qualified[0].evSharp, 'EV order would differ');
  assert.ok(/below 0.5pp/.test(r.rejected.find(x => x.matchup === 'G4').reason));
  assert.strictEqual(r.rejected.find(x => x.matchup === 'G3').reason, 'odds outside -300/+300');
  r.qualified.forEach((x, i, a) => { if (i) assert.ok(a[i - 1].calEdge >= x.calEdge); });
});
t('3 no padding + short label', () => {
  const r = S.selectSharp([mk({ matchup: 'G2', coverProb: 0.55, edgePct: 0.03, odds: -105 })], { nowMs: 0 });
  assert.strictEqual(r.picks.length, 1); assert.ok(/only 1 of 3/.test(S.shortCardLabel(1)));
  assert.strictEqual(S.shortCardLabel(3), null); assert.strictEqual(S.buildParlay(r.picks).length, 0);
});
t('4 market-match guard drops Senators-type mismatch', () => {
  // Oct 21 Senators -1.5 +200: p 47.7%, fair 51.7%, implied 33.3%
  const r = S.selectSharp([mk({ matchup: 'SJ @ OTT', coverProb: 0.477, edgePct: -0.04, odds: 200 })], { nowMs: 0 });
  assert.strictEqual(r.picks.length, 0); assert.ok(/market-match guard/.test(r.rejected[0].reason));
});
t('4b parlay legs reuse straights p/EV', () => {
  const pool = ['G1', 'G2'].map(m => mk({ matchup: m, coverProb: 0.55, edgePct: 0.03, odds: -105 }));
  const r = S.selectSharp(pool, { nowMs: 0 }); const pl = S.buildParlay(r.picks)[0];
  pl.legs.forEach((l, i) => assert.deepStrictEqual(l.sharp, r.picks[i].sharp));
  assert.strictEqual(pl.combinedProb, `${(r.picks[0].sharp.pSharp * r.picks[1].sharp.pSharp * 100).toFixed(1)}%`);
});
t('quarter Kelly units', () => {
  const x = S.calibrateSharp(mk({ coverProb: 0.55, edgePct: 0.03, odds: -105 }));
  assert.ok(Math.abs(x.kellyPct - 0.25 * ((x.decimal - 1) * x.pSharp - (1 - x.pSharp)) / (x.decimal - 1)) < 1e-12);
});
(async () => {
  const card = await buildCard(require('./test/fixtures/omega-card-2026-10-22.json'), { dateISO: '2026-10-22', nowMs: Date.parse('2026-10-22T14:45:00Z') });
  assert.deepStrictEqual(card.sharpQualified.map(q => q.side), ['Under 5.5', 'James Madison Dukes -10.5', 'Under 6.5', 'New York Islanders -1.5']);
  assert.deepStrictEqual(card.picks.map(p => p.units), ['0.5u', '0.25u', '0.25u']);
  assert.ok(Math.abs(card.sharpQualified[0].pSharp - 0.5065366221) < 1e-6);
  console.log(`ok today card; ${n + 1} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
