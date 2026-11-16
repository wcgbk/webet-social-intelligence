'use strict';

/**
 * Line-aware CLV. Fixtures are the labeled rows behind adj.txt.
 * No network. Flag off returns the previous record unchanged.
 */

const assert = require('assert');
const fs = require('fs');
const { convertCoverProb } = require('./netlify/functions/lib/omega-v2/key_convert');
const { gradePowerClv } = require('./netlify/functions/lib/omega-vnext/clv_grade');
const {
  lineAwareClv, applyToRecord, lineAdjEnabled,
} = require('./netlify/functions/lib/clv-line-adj');
const track = require('./netlify/functions/track-clv-omega')._test;

const ROWS_PATH = '/workspace/omega-daily-qa-2026-11-15/clvline/rows.json';
const rows = JSON.parse(fs.readFileSync(ROWS_PATH, 'utf8'));

function inputOf(row, over) {
  return {
    sport: row.s,
    market: row.m,
    side: row.p,
    betLine: row.bl,
    closeLine: row.cl,
    clv: +(row.c / 100).toFixed(4),
    pickTimeNoVig: row.pn,
    closingNoVig: row.cn,
    ...over,
  };
}

function adjusted(row, env) {
  return lineAwareClv(inputOf(row), env);
}

assert.strictEqual(lineAdjEnabled({}), true);
assert.strictEqual(lineAdjEnabled({ OMEGA_CLV_LINE_ADJ: 'off' }), false);
assert.strictEqual(lineAdjEnabled({ OMEGA_CLV_LINE_ADJ: '0' }), false);
assert.strictEqual(lineAdjEnabled({ OMEGA_CLV_LINE_ADJ: '' }), true);

assert.strictEqual(rows.length, 64);
const moved = rows.filter((r) => r.bl != null && r.cl != null && r.bl !== r.cl);
assert.strictEqual(moved.length, 20, `moved rows ${moved.length}`);
const islanders = moved.find((r) => /islanders/i.test(r.p));
assert.ok(islanders, 'Islanders flip missing from the fixture');

const over455 = moved.find((r) => r.p === 'Over 45.5' && r.cl === 47.5);
const under233 = moved.find((r) => r.p === 'Under 236.5' && r.cl === 233.5);
const under238 = moved.find((r) => r.p === 'Under 238.5' && r.cl === 240.5);
assert.ok(over455 && under233 && under238);

const on455 = adjusted(over455);
assert.strictEqual(on455.clvMethod, 'converted');
assert.ok(on455.clvCents > 0, `Over 45.5 vs 47.5 should be positive, got ${on455.clvCents}`);
assert.strictEqual(over455.c, 0);
assert.strictEqual(on455.clvRawLine, 0);
assert.strictEqual(on455.lineDiff, 2);

const on233 = adjusted(under233);
assert.strictEqual(on233.clvMethod, 'converted');
assert.ok(on233.clvCents > 0, `Under 236.5 vs 233.5 should be positive, got ${on233.clvCents}`);
assert.ok(under233.c < 0);

const on238 = adjusted(under238);
assert.strictEqual(on238.clvMethod, 'converted');
assert.ok(on238.clvCents < 0, `Under 238.5 vs 240.5 should be negative, got ${on238.clvCents}`);

const onIsl = adjusted(islanders);
assert.strictEqual(onIsl.clvMethod, 'side-flip');
assert.strictEqual(onIsl.clv, null);
assert.strictEqual(onIsl.clvCents, null);
assert.strictEqual(onIsl.beatClosing, null);
assert.strictEqual(onIsl.clvRawLine, +(islanders.c / 100).toFixed(4));
assert.strictEqual(onIsl.lineDiff, 3);

for (const row of moved) {
  if (row === islanders) continue;
  const out = adjusted(row);
  assert.strictEqual(out.clvMethod, 'converted', `${row.d} ${row.p}`);
  assert.ok(out.clvCents != null, `${row.d} ${row.p} dropped`);
  assert.strictEqual(out.clvRawLine, +(row.c / 100).toFixed(4));
}

for (const row of rows) {
  const same = row.bl == null || row.cl == null || row.bl === row.cl;
  if (!same) continue;
  const out = adjusted(row);
  assert.strictEqual(out.clvMethod, 'same-line', `${row.d} ${row.p}`);
  assert.strictEqual(out.clvCents, row.c, `${row.d} ${row.p} same-line cents changed`);
  assert.strictEqual(out.beatClosing, row.c > 0);
  if (row.bl == null) assert.strictEqual(out.lineDiff, null);
  else assert.strictEqual(out.lineDiff, 0);
}

for (const row of rows) {
  assert.strictEqual(lineAwareClv(inputOf(row), { OMEGA_CLV_LINE_ADJ: 'off' }), null);
  const rec = {
    clv: +(row.c / 100).toFixed(4),
    clvCents: row.c,
    beatClosing: row.c > 0,
    pickTimeNoVig: row.pn,
    closingNoVig: row.cn,
    closingLine: row.cl,
  };
  const off = applyToRecord(rec, {
    sport: row.s,
    market: row.m,
    side: row.p,
    betLine: row.bl,
    closeLine: row.cl,
  }, { OMEGA_CLV_LINE_ADJ: 'off' });
  assert.strictEqual(off, rec);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(off, 'clvMethod'), false);
  assert.strictEqual(off.clvCents, row.c);
}

// NFL +3 to +3.5 is the key-table half step (0.090 / 2), not a normal sigma.
const key = lineAwareClv({
  sport: 'NFL',
  market: 'Spread',
  side: 'Philadelphia Eagles +3.5',
  betLine: 3.5,
  closeLine: 3,
  clv: 0,
  pickTimeNoVig: 0.5,
  closingNoVig: 0.5,
}, {});
assert.strictEqual(key.clvMethod, 'converted');
assert.strictEqual(key.closingNoVig, 0.545);
assert.strictEqual(key.clvCents, 4.5);
const direct = convertCoverProb({
  sport: 'NFL', market: 'Spread', side: 'spread', fromPoint: 3, toPoint: 3.5, p: 0.5,
});
assert.ok(Math.abs(direct.p - 0.545) < 1e-12);
assert.strictEqual(convertCoverProb({
  sport: 'NFL', market: 'Spread', p: 0.5, fromPoint: 3, toPoint: 5, side: 'spread',
}), null);

// Caps. A total move of 6 still converts. 6.5 does not. NHL puck line any move does not.
const totalOk = lineAwareClv({
  sport: 'NBA', market: 'Total', side: 'Over 220', betLine: 220, closeLine: 226,
  clv: 0, pickTimeNoVig: 0.5, closingNoVig: 0.5,
}, {});
assert.strictEqual(totalOk.clvMethod, 'converted');
const totalCap = lineAwareClv({
  sport: 'NBA', market: 'Total', side: 'Over 220', betLine: 220, closeLine: 226.5,
  clv: 0.01, pickTimeNoVig: 0.5, closingNoVig: 0.51,
}, {});
assert.strictEqual(totalCap.clvMethod, 'over-cap');
assert.strictEqual(totalCap.clv, null);
assert.strictEqual(totalCap.clvRawLine, 0.01);

const nbaSpreadCap = lineAwareClv({
  sport: 'NBA', market: 'Spread', side: 'Celtics +9', betLine: 9, closeLine: 4,
  clv: -0.02, pickTimeNoVig: 0.52, closingNoVig: 0.5,
}, {});
assert.strictEqual(nbaSpreadCap.clvMethod, 'over-cap');
const nflSpreadCap = lineAwareClv({
  sport: 'NFL', market: 'Spread', side: 'Jets +7', betLine: 7, closeLine: 3,
  clv: 0.01, pickTimeNoVig: 0.5, closingNoVig: 0.51,
}, {});
assert.strictEqual(nflSpreadCap.clvMethod, 'over-cap');
const nhlMove = lineAwareClv({
  sport: 'NHL', market: 'Spread', side: 'Rangers -1.5', betLine: -1.5, closeLine: -2.5,
  clv: 0.02, pickTimeNoVig: 0.35, closingNoVig: 0.37,
}, {});
assert.strictEqual(nhlMove.clvMethod, 'over-cap');
assert.notStrictEqual(nhlMove.clvMethod, 'side-flip');

// Anchor book posts the bet's own number: use that two-sided price.
const altGame = {
  home_team: 'South Alabama Jaguars',
  away_team: 'Southern Miss Golden Eagles',
  bookmakers: [{
    key: 'pinnacle',
    title: 'Pinnacle',
    markets: [
      { key: 'totals', outcomes: [
        { name: 'Over', price: -110, point: 47.5 },
        { name: 'Under', price: -110, point: 47.5 },
      ] },
      { key: 'alternate_totals', outcomes: [
        { name: 'Over', price: -140, point: 45.5 },
        { name: 'Under', price: 120, point: 45.5 },
        { name: 'Over', price: -110, point: 47.5 },
        { name: 'Under', price: -110, point: 47.5 },
      ] },
    ],
  }],
};
const altPick = { pick: 'Over 45.5', betType: 'Total', sport: 'NCAAF', odds: '-110' };
const altInfo = track.pickSideInfo(altPick);
const altClose = track.extractClose(altGame, altInfo, altPick);
assert.strictEqual(altClose.closingLine, 47.5);
assert.strictEqual(altClose.sideOdds, -110);
assert.ok(altClose.altQuote);
assert.strictEqual(altClose.altQuote.sideOdds, -140);
assert.strictEqual(altClose.altQuote.oppOdds, 120);
const altPower = gradePowerClv(-110, -140, 120);
const altRec = applyToRecord({
  clv: 0,
  clvCents: 0,
  beatClosing: false,
  pickTimeNoVig: 0.5,
  closingNoVig: 0.5,
  closingLine: 47.5,
}, {
  sport: 'NCAAF',
  market: 'Total',
  side: altInfo,
  betLine: 45.5,
  closeLine: 47.5,
  altQuote: altClose.altQuote,
  betOdds: -110,
}, {});
assert.strictEqual(altRec.clvMethod, 'alt-line');
assert.strictEqual(altRec.clv, altPower.clv);
assert.strictEqual(altRec.clvCents, altPower.clvCents);
assert.ok(altRec.clvCents > 0);
assert.strictEqual(altRec.clvRawLine, 0);

// A spread that flips, with no alt price, stays excluded even if a model could shift it.
const flipOnly = lineAwareClv({
  sport: 'NHL', market: 'Spread', side: 'New York Islanders -1.5',
  betLine: -1.5, closeLine: 1.5, clv: 0.422, pickTimeNoVig: 0.2933, closingNoVig: 0.7153,
}, {});
assert.strictEqual(flipOnly.clv, null);

const prev = { clv: 0.422, clvCents: 42.2, beatClosing: true, captureScore: 0, betType: 'Spread', market: 'Spread', segment: 'fullgame', source: 'full-game' };
const excludedRec = {
  clv: null, clvCents: null, beatClosing: null, clvMethod: 'side-flip', clvRawLine: 0.422,
  captureScore: 0, betType: 'Spread', market: 'Spread', segment: 'fullgame', source: 'full-game',
};
assert.strictEqual(track.chooseCapture(prev, excludedRec).clvMethod, 'side-flip');
const worse = { ...excludedRec, captureScore: 50 };
assert.strictEqual(track.chooseCapture(prev, worse).clv, 0.422);
const oldNull = { clv: null, captureScore: 0, betType: 'Spread', market: 'Spread', segment: 'fullgame', source: 'full-game' };
assert.strictEqual(track.chooseCapture(prev, oldNull).clv, 0.422);

console.log('PASS clv line adj');
