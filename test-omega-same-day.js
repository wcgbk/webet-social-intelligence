'use strict';

/**
 * OMEGA_SAME_DAY_ONLY. Default on. A candidate stays only when its commence
 * time is the card's America/New_York calendar date. Missing commence times
 * drop. off / 0 / false / no is the previous selector. A blank value stays on.
 * The daily check reports the same rule and does not rewrite the card.
 */

const assert = require('assert');
const { etCalendarDate } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { sameDayOnlyEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const {
  filterSameEtDay, filterBoardByEtDay,
} = require('./netlify/functions/lib/omega-v2/same_day');
const { selectForcedTop3 } = require('./netlify/functions/lib/omega-v2/select');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { topUpStraights } = require('./netlify/functions/lib/omega-vnext/card_topup');
const { inSlate, slateReason } = require('./netlify/functions/lib/omega-vnext/selection_pass');
const {
  assessSameDay, dailyChecks, sameDayCheckEnabled,
} = require('./netlify/functions/lib/omega-vnext/daily_check');

const savedSame = process.env.OMEGA_SAME_DAY_ONLY;
const savedCheck = process.env.OMEGA_DAILY_CHECK_SAME_DAY;

function setSame(value) {
  if (value == null) delete process.env.OMEGA_SAME_DAY_ONLY;
  else process.env.OMEGA_SAME_DAY_ONLY = value;
}

function cand(over) {
  const pBet = over.pBet != null ? over.pBet : 0.58;
  return {
    qualified: true,
    sport: over.sport || 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    side: over.pick,
    market: 'Moneyline',
    odds: -110,
    decimal: 1 + (100 / 110),
    pBet,
    ev: over.ev != null ? over.ev : (pBet * (1 + (100 / 110)) - 1),
    edgePct: 0.04,
    coverProb: pBet,
    commenceTime: over.commenceTime,
    gameKey: String(over.matchup || '').toLowerCase(),
    book: 'draftkings',
    homeTeam: over.home || 'Home',
    awayTeam: over.away || 'Away',
    calibration: { pCal: pBet, pMkt: 0.52, pModel: pBet },
  };
}

function reserveRow(over) {
  return {
    sport: 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    side: over.pick,
    market: 'Moneyline',
    odds: -110,
    ev: over.ev,
    edgePct: 0.04,
    coverProb: 0.55,
    commenceTime: over.commenceTime,
    homeTeam: 'Home',
    awayTeam: 'Away',
    book: 'draftkings',
  };
}

function picksOf(rows) {
  return rows.map((row) => row.pick);
}

function main() {
  delete process.env.OMEGA_SAME_DAY_ONLY;
  assert.strictEqual(sameDayOnlyEnabled(), true);
  assert.strictEqual(sameDayOnlyEnabled({ OMEGA_SAME_DAY_ONLY: '' }), true);
  for (const off of ['off', '0', 'false', 'no']) {
    assert.strictEqual(sameDayOnlyEnabled({ OMEGA_SAME_DAY_ONLY: off }), false, off);
  }
  assert.strictEqual(sameDayOnlyEnabled({ OMEGA_SAME_DAY_ONLY: 'on' }), true);

  // DST fallback 2026-11-01 02:00 EDT -> 01:00 EST (06:00 UTC).
  assert.strictEqual(etCalendarDate('2026-11-02T04:30:00Z'), '2026-11-01');
  assert.strictEqual(etCalendarDate('2026-11-02T05:30:00Z'), '2026-11-02');
  assert.strictEqual(etCalendarDate('2026-11-01T03:30:00Z'), '2026-10-31');
  assert.strictEqual(etCalendarDate('2026-11-01T05:30:00Z'), '2026-11-01');
  assert.strictEqual(etCalendarDate('2026-11-01T06:30:00Z'), '2026-11-01');
  assert.strictEqual(etCalendarDate(''), null);
  assert.strictEqual(etCalendarDate('not-a-time'), null);

  const nov1 = [
    cand({ matchup: 'Late @ Same', pick: 'Late', pBet: 0.55, commenceTime: '2026-11-02T04:30:00Z' }),
    cand({ matchup: 'Early @ Next', pick: 'Next', pBet: 0.8, commenceTime: '2026-11-02T05:30:00Z' }),
    cand({ matchup: 'Prev @ Day', pick: 'Prev', pBet: 0.75, commenceTime: '2026-11-01T03:30:00Z' }),
    cand({ matchup: 'No @ Time', pick: 'Missing', pBet: 0.7 }),
    cand({ matchup: 'Fold @ Back', pick: 'Fold1', pBet: 0.56, commenceTime: '2026-11-01T05:30:00Z' }),
    cand({ matchup: 'Fold @ Est', pick: 'Fold2', pBet: 0.57, commenceTime: '2026-11-01T06:30:00Z' }),
  ];
  const onEnv = { OMEGA_SAME_DAY_ONLY: 'on' };
  const offEnv = { OMEGA_SAME_DAY_ONLY: 'off' };
  const filtered = filterSameEtDay(nov1, '2026-11-01', { env: onEnv });
  assert.strictEqual(filtered.applied, true);
  assert.deepStrictEqual(picksOf(filtered.rows), ['Late', 'Fold1', 'Fold2']);
  assert.strictEqual(filtered.bySport.NBA.nextDay, 1);
  assert.strictEqual(filtered.bySport.NBA.prevDay, 1);
  assert.strictEqual(filtered.bySport.NBA.missing, 1);
  assert.strictEqual(filtered.bySport.NBA.dropped, 3);
  assert.strictEqual(filtered.short, false);

  const sameRef = filterSameEtDay(nov1, '2026-11-01', { env: offEnv });
  assert.strictEqual(sameRef.applied, false);
  assert.strictEqual(sameRef.rows, nov1);
  for (const off of ['off', '0', 'false', 'no']) {
    const back = filterSameEtDay(nov1, '2026-11-01', { env: { OMEGA_SAME_DAY_ONLY: off } });
    assert.strictEqual(back.rows, nov1, off);
  }
  const blank = filterSameEtDay(nov1, '2026-11-01', { env: { OMEGA_SAME_DAY_ONLY: '' } });
  assert.strictEqual(blank.applied, true);
  assert.strictEqual(blank.rows.length, 3);

  const asOfNov1 = Date.parse('2026-11-01T15:00:00Z');
  const selectedOn = selectForcedTop3(nov1, {
    cardDate: '2026-11-01',
    pregameAsOfMs: asOfNov1,
    env: onEnv,
  });
  assert.deepStrictEqual(picksOf(selectedOn), ['Late']);
  const selectedOff = selectForcedTop3(nov1, {
    cardDate: '2026-11-01',
    pregameAsOfMs: asOfNov1,
    env: offEnv,
  });
  assert.strictEqual(selectedOff[0].pick, 'Next');

  const nov2 = [
    cand({ matchup: 'Night @ Before', pick: 'Before', pBet: 0.75, commenceTime: '2026-11-02T03:30:00Z' }),
    cand({ matchup: 'Night @ Card', pick: 'CardDay', pBet: 0.55, commenceTime: '2026-11-03T03:00:00Z' }),
  ];
  const selectedEarlier = selectForcedTop3(nov2, {
    cardDate: '2026-11-02',
    pregameAsOfMs: Date.parse('2026-11-01T12:00:00Z'),
    env: onEnv,
  });
  assert.deepStrictEqual(picksOf(selectedEarlier), ['CardDay']);
  const earlierOff = selectForcedTop3(nov2, {
    cardDate: '2026-11-02',
    pregameAsOfMs: Date.parse('2026-11-01T12:00:00Z'),
    env: offEnv,
  });
  assert.strictEqual(earlierOff[0].pick, 'Before');

  const straights = [
    cand({ matchup: 'A @ B', pick: 'A', pBet: 0.6, commenceTime: '2026-11-03T03:00:00Z' }),
    cand({ matchup: 'C @ D', pick: 'Off', pBet: 0.7, commenceTime: '2026-11-02T03:30:00Z' }),
    cand({ matchup: 'E @ F', pick: 'E', pBet: 0.58, commenceTime: '2026-11-03T02:00:00Z' }),
  ];
  const parlayOn = buildForcedParlay(straights, { cardDate: '2026-11-02', env: onEnv });
  assert.strictEqual(parlayOn.publish, true);
  assert.deepStrictEqual(parlayOn.legs.map((leg) => leg.pick), ['A', 'E']);
  const parlayOff = buildForcedParlay(straights, { cardDate: '2026-11-02', env: offEnv });
  assert.deepStrictEqual(parlayOff.legs.map((leg) => leg.pick), ['A', 'Off', 'E']);

  const reserve = [
    reserveRow({ matchup: 'Off @ Day', pick: 'OffDay', ev: 0.08, commenceTime: '2026-11-02T03:30:00Z' }),
    reserveRow({ matchup: 'On @ Day', pick: 'OnDay', ev: 0.05, commenceTime: '2026-11-03T03:00:00Z' }),
    reserveRow({ matchup: 'Also @ Off', pick: 'AlsoOff', ev: 0.09, commenceTime: '2026-11-03T05:30:00Z' }),
  ];
  const topped = topUpStraights({
    picks: [],
    reserve,
    target: 3,
    cardDate: '2026-11-02',
    env: onEnv,
  });
  assert.strictEqual(topped.picks.length, 1);
  assert.strictEqual(topped.picks[0].pick, 'OnDay ML');
  assert.ok(!topped.picks.some((pick) => /Off/.test(pick.pick)));
  assert.strictEqual(topped.exhausted, true);
  const toppedOff = topUpStraights({
    picks: [],
    reserve,
    target: 1,
    cardDate: '2026-11-02',
    env: offEnv,
  });
  assert.strictEqual(toppedOff.picks[0].pick, 'AlsoOff ML');

  const board = {
    NBA: [
      { sport: 'NBA', commence_time: '2026-11-03T03:00:00Z', id: 'same' },
      { sport: 'NBA', commence_time: '2026-11-02T03:30:00Z', id: 'prev' },
    ],
  };
  const boarded = filterBoardByEtDay(board, '2026-11-02', { env: onEnv });
  assert.deepStrictEqual(boarded.NBA.map((event) => event.id), ['same']);
  assert.strictEqual(filterBoardByEtDay(board, '2026-11-02', { env: offEnv }), board);

  setSame('on');
  assert.strictEqual(inSlate('2026-11-02T05:30:00Z', '2026-11-01'), false);
  assert.strictEqual(slateReason({ commenceTime: '2026-11-02T05:30:00Z' }, '2026-11-01'), 'not-same-et-day');
  assert.strictEqual(slateReason({ commenceTime: '2026-11-02T04:30:00Z' }, '2026-11-01'), null);
  assert.strictEqual(slateReason({ commenceTime: '2026-11-01T14:00:00Z' }, '2026-11-01'), 'starts-before-1115-et');
  assert.strictEqual(slateReason({}, '2026-11-01'), 'missing-commenceTime');
  setSame('off');
  assert.strictEqual(inSlate('2026-11-02T05:30:00Z', '2026-11-01'), true);
  assert.strictEqual(slateReason({ commenceTime: '2026-11-02T05:30:00Z' }, '2026-11-01'), null);
  setSame(null);

  const sameCard = {
    date: '2026-11-15',
    picks: [{ pick: 'Lions ML', commenceTime: '2026-11-15T23:30:00.000Z' }],
    parlayLegs: [{ legs: [{ pick: 'Lions ML', commenceTime: '2026-11-15T23:30:00.000Z' }] }],
  };
  assert.strictEqual(assessSameDay(sameCard, '2026-11-15').status, 'ok');
  assert.strictEqual(assessSameDay({ date: '2026-11-15', picks: [], parlayLegs: [] }, '2026-11-15').status, 'ok');
  const offCard = {
    date: '2026-11-15',
    picks: [{ pick: 'Late', commenceTime: '2026-11-16T05:30:00Z' }],
    parlayLegs: [{ legs: [{ pick: 'Late', commenceTime: '2026-11-16T05:30:00Z' }] }],
  };
  assert.strictEqual(assessSameDay(offCard, '2026-11-15').code, 'off-day');
  const missingCard = {
    date: '2026-11-15',
    picks: [{ pick: 'No clock' }],
    parlayLegs: [],
  };
  assert.strictEqual(assessSameDay(missingCard, '2026-11-15').code, 'off-day');
  assert.strictEqual(assessSameDay(null, '2026-11-15').code, 'card-missing');

  assert.strictEqual(sameDayCheckEnabled({}), true);
  assert.strictEqual(sameDayCheckEnabled({ OMEGA_DAILY_CHECK_SAME_DAY: 'off' }), false);
  const idsOn = dailyChecks({}).map((row) => row[0]);
  assert.ok(idsOn.includes('same-day'));
  assert.deepStrictEqual(idsOn.slice(0, 3), ['pulls', 'card', 'same-day']);
  const idsOff = dailyChecks({ OMEGA_DAILY_CHECK_SAME_DAY: 'off' }).map((row) => row[0]);
  assert.ok(!idsOff.includes('same-day'));
  assert.deepStrictEqual(idsOff.slice(0, 2), ['pulls', 'card']);

  console.log('PASS same-day');
}

try {
  main();
} finally {
  if (savedSame == null) delete process.env.OMEGA_SAME_DAY_ONLY;
  else process.env.OMEGA_SAME_DAY_ONLY = savedSame;
  if (savedCheck == null) delete process.env.OMEGA_DAILY_CHECK_SAME_DAY;
  else process.env.OMEGA_DAILY_CHECK_SAME_DAY = savedCheck;
}
