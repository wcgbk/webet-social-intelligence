'use strict';

/**
 * Cell shift comes from prior morning boards, both sides.
 * Published picks still train the walk-forward. They do not set the shift
 * unless OMEGA_V2_BIAS_SOURCE=picks.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

function close(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);
}

const CARD = '2026-11-05';

function spreadRow(date, pModel, pMkt) {
  return {
    date,
    sport: 'NBA',
    market: 'Spread',
    pick: 'Away +3.5',
    pModel,
    pMkt,
  };
}

function many(n, pModel, pMkt) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const day = String((i % 27) + 1).padStart(2, '0');
    rows.push(spreadRow(`2026-10-${day}`, pModel, pMkt));
  }
  return rows;
}

function picksFrom(rows) {
  return rows.map((row, i) => ({ ...row, result: i % 2 ? 'win' : 'loss' }));
}

function nbaSpread(pModel, pMkt) {
  return { sport: 'NBA', market: 'Spread', pick: 'Away +3.5', pModel, pMkt };
}

async function main() {
  const saved = process.env.OMEGA_V2_BIAS_SOURCE;
  delete process.env.OMEGA_V2_BIAS_SOURCE;
  try {
    const read = [];
    const loaded = await v2.loadBoardHistory(CARD, {
      readDates: async () => {
        const dates = [];
        for (let i = 1; i <= 25; i += 1) dates.push(`2026-10-${String(i).padStart(2, '0')}`);
        dates.push('2026-11-04', '2026-11-05', '2026-11-06');
        return dates;
      },
      readBoard: async (date) => {
        read.push(date);
        if (date === '2026-10-20') return null;
        if (date === '2026-10-21') {
          return {
            date: '2026-11-05',
            candidates: [{ sport: 'NBA', market: 'Spread', side: 'Leaked +1', pModel: 0.9, pMkt: 0.4 }],
          };
        }
        if (date === '2026-11-04') {
          return {
            date: '2026-11-04',
            candidates: [
              { sport: 'NBA', market: 'Moneyline', side: 'Celtics ML', pModel: 0.61, pMkt: 0.52 },
              { sport: 'NBA', market: 'Total', pick: 'Over 220.5', pModel: 0.58, pMkt: 0.5 },
              { sport: 'NBA', market: 'Spread', side: 'No price', pModel: null, pMkt: 0.5 },
            ],
          };
        }
        return {
          date,
          candidates: [{ sport: 'NHL', market: 'Spread', side: 'Road +1.5', pModel: 0.55, pMkt: 0.5 }],
        };
      },
    });
    assert.deepStrictEqual(read[0], '2026-10-07');
    assert.deepStrictEqual(read[read.length - 1], '2026-11-04');
    assert.strictEqual(read.length, 20);
    assert.ok(!read.includes('2026-11-05'), 'card date is not read');
    assert.ok(!read.includes('2026-11-06'), 'a later date is not read');
    assert.ok(!read.includes('2026-10-01'), 'older than the last 20 is not read');
    assert.ok(loaded.every((row) => row.date < CARD));
    assert.ok(!loaded.some((row) => row.pick === 'Leaked +1'), 'a board stamped on the card date is ignored');
    assert.ok(!loaded.some((row) => row.pick === 'No price'));
    const nov4 = loaded.filter((row) => row.date === '2026-11-04');
    assert.strictEqual(nov4.length, 2);
    assert.strictEqual(nov4[0].pick, 'Celtics ML');
    assert.strictEqual(nov4[1].pick, 'Over 220.5');
    assert.strictEqual(loaded.filter((row) => row.sport === 'NHL').length, 17);

    const board = many(40, 0.62, 0.55);
    const picks = picksFrom(many(12, 0.80, 0.50));
    const picksShift = v2.fitCellBias(picks)['NBA|Spread'];
    const fit = v2.fitWalkForward(picks, CARD, { boardRows: board });
    assert.strictEqual(fit.biasSource, 'board');
    assert.strictEqual(fit.trainN, 12, 'published picks still set trainN');
    assert.strictEqual(fit.sportN.NBA, 12, 'published picks still set sportN');
    assert.strictEqual(fit.biasN['NBA|Spread'], 40);
    const applied = v2.applyCalibration(nbaSpread(0.62, 0.55), fit);
    close(applied.intercept, 0.07, 1e-4, 'board shift');
    assert.ok(Math.abs(applied.intercept - picksShift) > 0.01, 'picks gap is not the shift');

    const thinFit = v2.fitWalkForward(picks, CARD, { boardRows: many(39, 0.62, 0.55) });
    assert.strictEqual(thinFit.biasN['NBA|Spread'], 39);
    assert.strictEqual(thinFit.bias['NBA|Spread'], 0, 'under 40 the shift is 0');
    assert.strictEqual(v2.applyCalibration(nbaSpread(0.80, 0.50), thinFit).intercept, 0);

    const none = v2.fitWalkForward(picks, CARD);
    assert.strictEqual(none.biasSource, 'board');
    assert.strictEqual(none.trainN, 12);
    assert.strictEqual(v2.applyCalibration(nbaSpread(0.80, 0.50), none).intercept, 0, 'picks alone do not move the shift');

    process.env.OMEGA_V2_BIAS_SOURCE = 'picks';
    const oldFit = v2.fitWalkForward(picks, CARD, { boardRows: board });
    assert.strictEqual(oldFit.biasSource, 'picks');
    assert.strictEqual(oldFit.biasMin, 0);
    const oldCal = v2.applyCalibration(nbaSpread(0.80, 0.50), oldFit);
    close(oldCal.intercept, picksShift, 1e-9, 'picks flag matches the old fit');
    assert.ok(Math.abs(oldCal.intercept - applied.intercept) > 0.01);

    const forced = v2.fitWalkForward(picks, CARD, { boardRows: board, biasSource: 'board' });
    assert.strictEqual(forced.biasSource, 'board');
    close(v2.biasFor(forced.bias, nbaSpread(0.62, 0.55)), applied.intercept, 1e-12, 'explicit board wins over the env flag');
    delete process.env.OMEGA_V2_BIAS_SOURCE;

    const leakedBoards = board.concat([
      spreadRow(CARD, 0.2, 0.8),
      spreadRow('2026-11-06', 0.2, 0.8),
      { sport: 'NBA', market: 'Spread', pick: 'Away +3.5', pModel: 0.2, pMkt: 0.8 },
    ]);
    for (let i = 0; i < 40; i += 1) leakedBoards.push(spreadRow(CARD, 0.2, 0.8));
    const dirty = v2.fitWalkForward(picks, CARD, { boardRows: leakedBoards });
    close(dirty.bias['NBA|Spread'], fit.bias['NBA|Spread'], 1e-12, 'a board on or after the card date is ignored');
    assert.strictEqual(dirty.biasN['NBA|Spread'], 40);

    let threw = false;
    try {
      v2.fitWalkForward([{ ...picks[0], date: CARD }], CARD, { boardRows: board });
    } catch (err) {
      threw = /leakage/.test(err.message);
    }
    assert.ok(threw, 'a same-day graded row still throws');

    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const card = await v2.buildCard({
      date: CARD,
      pregameAsOfMs: Date.now(),
      history: picks,
      boardRows: board,
      candidates: [{
        sport: 'NBA',
        matchup: 'A @ B',
        pick: 'A +3.5',
        market: 'Spread',
        odds: '-110',
        book: 'draftkings',
        bestDkHr: { american: -110, book: 'draftkings', point: 3.5 },
        line: 3.5,
        pModel: 0.62,
        pMkt: 0.55,
        uncertainty: 0.18,
        commenceTime: future,
      }],
    });
    assert.strictEqual(card.calibration.biasSource, 'board');
    assert.strictEqual(card.calibration.biasN['NBA|Spread'], 40);
    assert.strictEqual(card.calibration.biasMin, 40);
    assert.strictEqual(card.calibration.trainN, 12);
    close(card.calibration.bias['NBA|Spread'], applied.intercept, 1e-12, 'card stamp');

    console.log('PASS test-omega-v2-bias-board');
  } finally {
    if (saved == null) delete process.env.OMEGA_V2_BIAS_SOURCE;
    else process.env.OMEGA_V2_BIAS_SOURCE = saved;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
