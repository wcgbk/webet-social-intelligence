'use strict';

/**
 * 3 AM -> 10 AM Pinnacle veto, stale rank, fair price, and push EV.
 * No network. Flags off leaves a row byte-identical.
 */

const assert = require('assert');
const { annotateCandidate, selectForcedTop3, orderForcedPool } = require('./netlify/functions/lib/omega-v2/select');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick } = require('./netlify/functions/lib/omega-v2/guards');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');

const FUTURE = '2026-11-16T18:00:00Z';
const AS_OF = Date.parse('2026-11-16T15:05:00Z');

function saveEnv(keys) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

const ENV_KEYS = [
  'OMEGA_V2_LINE_MOVE',
  'OMEGA_V2_MOVE_SHRINK',
  'OMEGA_V2_PINNACLE_FAIR',
  'OMEGA_V2_KEY_CONVERT',
  'OMEGA_V2_LINE_MOVE_VETO_PP',
  'OMEGA_V2_LINE_MOVE_STALE_PP',
  'OMEGA_V2_FORCE_TOP3',
  'OMEGA_V2_MARKET_P',
  'OMEGA_V2_LONGSHOT_ADJ',
  'OMEGA_V2_EV_FIRST',
];

function book(key, last, outcomes, market) {
  return { key, last_update: last, markets: [{ key: market, outcomes }] };
}

function spreadEvent(away, home, books) {
  return {
    sport: 'NFL',
    away_team: away,
    home_team: home,
    commence_time: FUTURE,
    bookmakers: books,
  };
}

function jetsBooks(pinPt, pinPrice, oppPrice, dkPt, dkPrice, dkOpp, pinLast, dkLast) {
  const away = 'New York Jets';
  const home = 'New England Patriots';
  return [
    book('pinnacle', pinLast || '2026-11-16 10:05', [
      { name: away, price: pinPrice, point: pinPt },
      { name: home, price: oppPrice, point: -pinPt },
    ], 'spreads'),
    book('draftkings', dkLast || '2026-11-16 10:05', [
      { name: away, price: dkPrice, point: dkPt },
      { name: home, price: dkOpp, point: -dkPt },
    ], 'spreads'),
  ];
}

function pollsFrom(am, pm) {
  return {
    '0300': [spreadEvent('New York Jets', 'New England Patriots', am)],
    '1000': [spreadEvent('New York Jets', 'New England Patriots', pm)],
  };
}

function slateCand(away, home, over) {
  return cand({
    matchup: `${away} @ ${home}`,
    pick: `${away} +3.5`,
    homeTeam: home,
    awayTeam: away,
    gameKey: `${away.toLowerCase()} @ ${home.toLowerCase()}`,
    ...over,
  });
}

function pinSpread(away, home, pinPrice, pinOpp) {
  return spreadEvent(away, home, [
    book('pinnacle', '2026-11-16 10:05', [
      { name: away, price: pinPrice, point: 3.5 },
      { name: home, price: pinOpp, point: -3.5 },
    ], 'spreads'),
    book('draftkings', '2026-11-16 10:05', [
      { name: away, price: -110, point: 3.5 },
      { name: home, price: -110, point: -3.5 },
    ], 'spreads'),
  ]);
}

function dkSpread(away, home) {
  return spreadEvent(away, home, [
    book('draftkings', '2026-11-16 10:05', [
      { name: away, price: -110, point: 3.5 },
      { name: home, price: -110, point: -3.5 },
    ], 'spreads'),
  ]);
}

function cand(over) {
  return {
    sport: 'NFL',
    matchup: 'New York Jets @ New England Patriots',
    pick: 'New York Jets +3.5',
    market: 'Spread',
    odds: -110,
    line: 3.5,
    book: 'draftkings',
    homeTeam: 'New England Patriots',
    awayTeam: 'New York Jets',
    gameKey: 'new york jets @ new england patriots',
    commenceTime: FUTURE,
    calibration: { pCal: 0.52, pMkt: 0.50, pModel: 0.52, method: 'board' },
    ...over,
  };
}

function view(row) {
  return {
    qualified: row.qualified,
    rejectReason: row.rejectReason || null,
    odds: row.odds,
    line: row.line,
    pBet: row.pBet,
    ev: row.ev,
    edge: row.edge,
    pMkt: row.calibration && row.calibration.pMkt,
  };
}

const saved = saveEnv(ENV_KEYS);
process.env.OMEGA_V2_FORCE_TOP3 = '1';
process.env.OMEGA_V2_MARKET_P = '1';
process.env.OMEGA_V2_LONGSHOT_ADJ = 'off';
// This file locks the a2b6bb1 sharp-then-fallback order. EV-first is separate.
process.env.OMEGA_V2_EV_FIRST = 'off';
for (const key of ENV_KEYS.slice(0, 4)) process.env[key] = 'off';
delete process.env.OMEGA_V2_LINE_MOVE_VETO_PP;
delete process.env.OMEGA_V2_LINE_MOVE_STALE_PP;

const baseOpts = { pregameAsOfMs: AS_OF, forceTop3: true };
const off = annotateCandidate(cand(), baseOpts);
const offPolls = annotateCandidate(cand(), { ...baseOpts, linePolls: pollsFrom(
  jetsBooks(3.5, -110, -110, 3.5, -110, -110),
  jetsBooks(3.5, -150, 130, 3.5, -110, -110),
) });
assert.deepStrictEqual(view(off), view(offPolls));
assert.strictEqual(off.lineMovePinn, undefined);
assert.strictEqual(off.staleSoft, undefined);

const movedAgainst = pollsFrom(
  jetsBooks(3.5, -150, 130, 3.5, -110, -110, '2026-11-16 03:01', '2026-11-16 03:01'),
  jetsBooks(3.5, -110, -110, 3.5, -110, -110, '2026-11-16 10:05', '2026-11-16 10:05'),
);
process.env.OMEGA_V2_LINE_MOVE = 'on';
const veto = annotateCandidate(cand(), { ...baseOpts, linePolls: movedAgainst });
assert.strictEqual(veto.qualified, false);
assert.strictEqual(veto.rejectReason, 'pinnacle-moved-against');
assert.ok(veto.lineMovePinn && veto.lineMovePinn.m <= -0.015, JSON.stringify(veto.lineMovePinn));

process.env.OMEGA_V2_LINE_MOVE_VETO_PP = '20';
const kept = annotateCandidate(cand(), { ...baseOpts, linePolls: movedAgainst });
assert.strictEqual(kept.qualified, true, kept.rejectReason);
assert.ok(kept.lineMovePinn.m <= -0.015 && kept.lineMovePinn.m > -0.20, JSON.stringify(kept.lineMovePinn));
delete process.env.OMEGA_V2_LINE_MOVE_VETO_PP;

const noMorning = { '1000': movedAgainst['1000'] };
const neutral = annotateCandidate(cand(), { ...baseOpts, linePolls: noMorning });
assert.strictEqual(neutral.qualified, true, neutral.rejectReason);
assert.strictEqual(neutral.lineMovePinn, undefined);

const toward = pollsFrom(
  jetsBooks(3.5, -110, -110, 3.5, -110, -110, '2026-11-16 03:01', '2026-11-16 03:01'),
  jetsBooks(3.5, -150, 130, 3.5, -110, -110, '2026-11-16 10:05', '2026-11-16 09:00'),
);
const stale = annotateCandidate(cand(), { ...baseOpts, linePolls: toward });
assert.strictEqual(stale.qualified, true, stale.rejectReason);
assert.strictEqual(stale.staleSoft, true);
assert.ok(stale.lineMovePinn.m >= 0.01, JSON.stringify(stale.lineMovePinn));
assert.ok(stale.softLagPp > 0);

const followed = pollsFrom(
  jetsBooks(3.5, -110, -110, 3.5, -110, -110),
  jetsBooks(3.5, -150, 130, 3.5, -150, 130),
);
const fresh = annotateCandidate(cand({ odds: -150 }), { ...baseOpts, linePolls: followed });
assert.strictEqual(fresh.staleSoft, undefined);
assert.ok(fresh.lineMovePinn && fresh.lineMovePinn.stale === false);

const other = annotateCandidate(cand({
  matchup: 'Buffalo Bills @ Miami Dolphins',
  pick: 'Buffalo Bills ML',
  market: 'Moneyline',
  line: null,
  homeTeam: 'Miami Dolphins',
  awayTeam: 'Buffalo Bills',
  gameKey: 'buffalo bills @ miami dolphins',
  calibration: { pCal: 0.52, pMkt: 0.50, pModel: 0.52, method: 'board' },
}), baseOpts);
const ranked = selectForcedTop3([other, stale], baseOpts);
assert.strictEqual(ranked[0].pick, stale.pick);

const equalEv = [
  { ...other, pick: 'Alpha', staleSoft: false, ev: -0.02, kellyGrowth: null, qualified: true, pBet: 0.4, decimal: americanToDecimal(-110) },
  { ...other, pick: 'Bravo', matchup: 'C @ D', gameKey: 'c @ d', staleSoft: true, ev: -0.02, kellyGrowth: null, qualified: true, pBet: 0.4, decimal: americanToDecimal(-110) },
];
const negOrder = selectForcedTop3(equalEv, baseOpts);
assert.strictEqual(negOrder[0].pick, 'Bravo');
const worse = selectForcedTop3([
  { ...equalEv[0], ev: -0.01, staleSoft: false },
  { ...equalEv[1], ev: -0.04 },
], baseOpts);
assert.strictEqual(worse[0].pick, 'Alpha');

process.env.OMEGA_V2_LINE_MOVE = 'off';
process.env.OMEGA_V2_MOVE_SHRINK = 'on';
const nhlPolls = {
  '0300': [{
    sport: 'NHL', away_team: 'Boston Bruins', home_team: 'Toronto Maple Leafs', commence_time: FUTURE,
    bookmakers: [book('pinnacle', '2026-11-16 03:01', [
      { name: 'Boston Bruins', price: -110 },
      { name: 'Toronto Maple Leafs', price: -110 },
    ], 'h2h')],
  }],
  '1000': [{
    sport: 'NHL', away_team: 'Boston Bruins', home_team: 'Toronto Maple Leafs', commence_time: FUTURE,
    bookmakers: [book('pinnacle', '2026-11-16 10:05', [
      { name: 'Boston Bruins', price: -150 },
      { name: 'Toronto Maple Leafs', price: 130 },
    ], 'h2h'), book('draftkings', '2026-11-16 10:05', [
      { name: 'Boston Bruins', price: -110 },
      { name: 'Toronto Maple Leafs', price: -110 },
    ], 'h2h')],
  }],
};
const nhl = annotateCandidate(cand({
  sport: 'NHL',
  matchup: 'Boston Bruins @ Toronto Maple Leafs',
  pick: 'Boston Bruins ML',
  market: 'Moneyline',
  line: null,
  homeTeam: 'Toronto Maple Leafs',
  awayTeam: 'Boston Bruins',
  gameKey: 'boston bruins @ toronto maple leafs',
}), { ...baseOpts, linePolls: nhlPolls });
assert.strictEqual(nhl.qualified, true, nhl.rejectReason);
assert.ok(nhl.pBet < 0.50, nhl.pBet);
const nhlOff = annotateCandidate(cand({
  sport: 'NHL',
  matchup: 'Boston Bruins @ Toronto Maple Leafs',
  pick: 'Boston Bruins ML',
  market: 'Moneyline',
  line: null,
  homeTeam: 'Toronto Maple Leafs',
  awayTeam: 'Boston Bruins',
  gameKey: 'boston bruins @ toronto maple leafs',
}), baseOpts);
assert.ok(Math.abs(nhlOff.pBet - 0.50) < 1e-12);
process.env.OMEGA_V2_MOVE_SHRINK = 'off';

process.env.OMEGA_V2_PINNACLE_FAIR = 'on';
const fairKept = annotateCandidate(cand(), baseOpts);
assert.strictEqual(fairKept.calibration.pMkt, 0.50);
const fair = annotateCandidate(cand(), { ...baseOpts, linePolls: toward });
assert.ok(fair.calibration.pMkt > 0.54, fair.calibration.pMkt);
assert.ok(Math.abs(fair.pBet - fair.calibration.pMkt) < 1e-12);
assert.notStrictEqual(fair.noSharpFair, true);
assert.strictEqual(fair.fairSource, undefined);
const noSharp = {
  '1000': [spreadEvent('New York Jets', 'New England Patriots', [
    book('draftkings', '2026-11-16 10:05', [
      { name: 'New York Jets', price: -110, point: 3.5 },
      { name: 'New England Patriots', price: -110, point: -3.5 },
    ], 'spreads'),
  ])],
};
const fallbackFair = annotateCandidate(cand(), { ...baseOpts, linePolls: noSharp });
assert.strictEqual(fallbackFair.qualified, true, fallbackFair.rejectReason);
assert.strictEqual(fallbackFair.rejectReason, null);
assert.strictEqual(fallbackFair.noSharpFair, true);
assert.strictEqual(fallbackFair.fairSource, 'stored-fallback');
assert.strictEqual(fallbackFair.sharpAudit, 'no-sharp-fair');
assert.strictEqual(fallbackFair.calibration.pMkt, 0.50);
const circaOnly = {
  '1000': [spreadEvent('New York Jets', 'New England Patriots', [
    book('circa', '2026-11-16 10:05', [
      { name: 'New York Jets', price: -110, point: 3.5 },
      { name: 'New England Patriots', price: -110, point: -3.5 },
    ], 'spreads'),
  ])],
};
const circaFair = annotateCandidate(cand(), { ...baseOpts, linePolls: circaOnly });
assert.strictEqual(circaFair.qualified, true, circaFair.rejectReason);
assert.notStrictEqual(circaFair.noSharpFair, true);
assert.strictEqual(circaFair.fairSource, undefined);

function assertNoPublicFairTag(row) {
  const pick = toPick(row);
  assert.strictEqual(pick.noSharpFair, undefined);
  assert.strictEqual(pick.fairSource, undefined);
  assert.strictEqual(pick.sharpAudit, undefined);
  const text = JSON.stringify(pick);
  assert.ok(!text.includes('stored-fallback'));
  assert.ok(!text.includes('no-sharp-fair'));
  assert.ok(!text.includes('noSharpFair'));
}

const emptyNames = [
  ['Alpha Away', 'Alpha Home'],
  ['Bravo Away', 'Bravo Home'],
  ['Charlie Away', 'Charlie Home'],
  ['Delta Away', 'Delta Home'],
];
const emptyPoll = { '1000': emptyNames.map(([away, home]) => dkSpread(away, home)) };
const emptyRows = emptyNames.map(([away, home]) => annotateCandidate(
  slateCand(away, home),
  { ...baseOpts, linePolls: emptyPoll },
));
assert.ok(emptyRows.every((row) => row.qualified && row.noSharpFair === true && row.fairSource === 'stored-fallback'));
const emptyCard = selectForcedTop3(emptyRows, baseOpts);
assert.strictEqual(emptyCard.length, 3);
assert.ok(emptyCard.every((row) => row.noSharpFair === true && row.fairSource === 'stored-fallback' && row.sharpAudit === 'no-sharp-fair'));
const emptyParlay = buildForcedParlay(emptyCard);
assert.strictEqual(emptyParlay.publish, true, emptyParlay.skipReason);
assert.strictEqual(emptyParlay.legs.length, 3);
assert.deepStrictEqual(emptyParlay.legs.map((leg) => leg.pick), emptyCard.map((row) => row.pick));
assert.ok(emptyParlay.legs.every((leg) => leg.noSharpFair === true && leg.fairSource === 'stored-fallback'));
emptyCard.forEach(assertNoPublicFairTag);

const alpha = slateCand('Alpha Away', 'Alpha Home');
const bravo = slateCand('Bravo Away', 'Bravo Home');
const charlie = slateCand('Charlie Away', 'Charlie Home', {
  calibration: { pCal: 0.57, pMkt: 0.55, pModel: 0.57, method: 'board' },
});
const delta = slateCand('Delta Away', 'Delta Home', {
  calibration: { pCal: 0.60, pMkt: 0.58, pModel: 0.60, method: 'board' },
});
const mixedPoll = {
  '1000': [
    pinSpread('Alpha Away', 'Alpha Home', -110, -110),
    pinSpread('Bravo Away', 'Bravo Home', -110, -110),
    dkSpread('Charlie Away', 'Charlie Home'),
    dkSpread('Delta Away', 'Delta Home'),
  ],
};
const mixedRows = [delta, charlie, bravo, alpha].map((row) => annotateCandidate(row, { ...baseOpts, linePolls: mixedPoll }));
assert.ok(mixedRows.every((row) => row.qualified), mixedRows.map((row) => `${row.pick}:${row.rejectReason}`).join(','));
const mixedCard = selectForcedTop3(mixedRows, baseOpts);
assert.deepStrictEqual(mixedCard.map((row) => row.pick), [
  'Alpha Away +3.5',
  'Bravo Away +3.5',
  'Delta Away +3.5',
]);
assert.notStrictEqual(mixedCard[0].noSharpFair, true);
assert.notStrictEqual(mixedCard[1].noSharpFair, true);
assert.strictEqual(mixedCard[2].noSharpFair, true);
assert.strictEqual(mixedCard[2].fairSource, 'stored-fallback');
const mixedParlay = buildForcedParlay(mixedCard);
assert.strictEqual(mixedParlay.publish, true, mixedParlay.skipReason);
assert.deepStrictEqual(mixedParlay.legs.map((leg) => leg.pick), mixedCard.map((row) => row.pick));

const echo = slateCand('Echo Away', 'Echo Home', {
  odds: -450,
  calibration: { pCal: 0.84, pMkt: 0.82, pModel: 0.84, method: 'board' },
});
const bandPoll = {
  '1000': [
    pinSpread('Alpha Away', 'Alpha Home', -110, -110),
    pinSpread('Bravo Away', 'Bravo Home', -110, -110),
    pinSpread('Echo Away', 'Echo Home', -450, 400),
    dkSpread('Delta Away', 'Delta Home'),
  ],
};
const bandRows = [delta, echo, bravo, alpha].map((row) => annotateCandidate(row, { ...baseOpts, linePolls: bandPoll }));
assert.ok(bandRows.every((row) => row.qualified), bandRows.map((row) => `${row.pick}:${row.rejectReason}`).join(','));
const bandCard = selectForcedTop3(bandRows, baseOpts);
assert.deepStrictEqual(bandCard.map((row) => row.pick), [
  'Alpha Away +3.5',
  'Bravo Away +3.5',
  'Echo Away +3.5',
]);
assert.strictEqual(bandCard[2].favCapFill, true);
assert.notStrictEqual(bandCard[2].noSharpFair, true);
const bandOrder = orderForcedPool(bandRows, baseOpts);
assert.deepStrictEqual(bandOrder.map((row) => row.pick), [
  'Alpha Away +3.5',
  'Bravo Away +3.5',
  'Echo Away +3.5',
  'Delta Away +3.5',
]);
assert.strictEqual(bandOrder[3].noSharpFair, true);
assert.strictEqual(bandOrder[3].fairSource, 'stored-fallback');
process.env.OMEGA_V2_PINNACLE_FAIR = 'off';

process.env.OMEGA_V2_KEY_CONVERT = 'on';
const halfOn = annotateCandidate(cand(), { ...baseOpts, linePolls: toward });
const halfOff = annotateCandidate(cand(), { ...baseOpts, linePolls: toward });
process.env.OMEGA_V2_KEY_CONVERT = 'off';
const halfOff2 = annotateCandidate(cand(), { ...baseOpts, linePolls: toward });
process.env.OMEGA_V2_KEY_CONVERT = 'on';
assert.deepStrictEqual(view(halfOn), view(halfOff2));
assert.strictEqual(halfOn.pushQ, undefined);

const wholePolls = pollsFrom(
  jetsBooks(3, -110, -110, 3, -110, -110),
  jetsBooks(3, -110, -110, 3, -110, -110),
);
const whole = annotateCandidate(cand({ pick: 'New York Jets +3', line: 3 }), { ...baseOpts, linePolls: wholePolls });
process.env.OMEGA_V2_KEY_CONVERT = 'off';
const wholeOff = annotateCandidate(cand({ pick: 'New York Jets +3', line: 3 }), { ...baseOpts, linePolls: wholePolls });
assert.strictEqual(whole.pBet, wholeOff.pBet);
assert.ok(whole.pushQ > 0);
assert.ok(Math.abs(whole.ev - (1 - whole.pushQ) * wholeOff.ev) < 1e-9, `${whole.ev} vs ${wholeOff.ev}`);
assert.strictEqual(whole.calibration.pMkt, wholeOff.calibration.pMkt);

const converted = pollsFrom(
  jetsBooks(3.5, -110, -110, 3, -110, -110),
  jetsBooks(3.5, -110, -110, 3, -110, -110),
);
process.env.OMEGA_V2_KEY_CONVERT = 'on';
const offNumber = annotateCandidate(cand({
  pick: 'New York Jets +3',
  line: 3,
  needsKeyConvert: true,
  odds: -105,
}), { ...baseOpts, linePolls: converted });
assert.strictEqual(offNumber.qualified, true, offNumber.rejectReason);
assert.ok(Math.abs(offNumber.calibration.pMkt - 0.455) < 1e-9, offNumber.calibration.pMkt);
assert.strictEqual(offNumber.odds, -105);

for (const key of ['OMEGA_V2_LINE_MOVE', 'OMEGA_V2_MOVE_SHRINK', 'OMEGA_V2_PINNACLE_FAIR', 'OMEGA_V2_KEY_CONVERT']) {
  delete process.env[key];
}
const defaultsNoPolls = annotateCandidate(cand(), baseOpts);
assert.deepStrictEqual(view(defaultsNoPolls), view(off));
assert.strictEqual(defaultsNoPolls.lineMovePinn, undefined);
assert.strictEqual(defaultsNoPolls.staleSoft, undefined);

(async () => {
  process.env.OMEGA_V2_KEY_CONVERT = 'on';
  const card = await buildCard({
    date: '2026-11-16',
    candidates: [{
      sport: 'NFL',
      matchup: 'New York Jets @ New England Patriots',
      pick: 'New York Jets +3.5',
      market: 'Spread',
      odds: '-110',
      book: 'draftkings',
      pModel: 0.62,
      pMkt: 0.50,
      line: 3.5,
      homeTeam: 'New England Patriots',
      awayTeam: 'New York Jets',
      commenceTime: FUTURE,
      bestDkHr: { american: -105, book: 'draftkings', point: 3 },
    }],
    history: [],
    pregameAsOfMs: AS_OF,
  });
  assert.ok(card.rejections.some((row) => row.reason === 'dk-hr-line-mismatch'));
  assert.strictEqual(card.picks.length, 0);

  const accepted = await buildCard({
    date: '2026-11-16',
    candidates: [{
      sport: 'NFL',
      matchup: 'New York Jets @ New England Patriots',
      pick: 'New York Jets +3.5',
      market: 'Spread',
      odds: '-110',
      book: 'draftkings',
      pModel: 0.62,
      pMkt: 0.50,
      line: 3.5,
      homeTeam: 'New England Patriots',
      awayTeam: 'New York Jets',
      commenceTime: FUTURE,
      bestDkHr: { american: -105, book: 'draftkings', point: 3 },
    }],
    history: [],
    pregameAsOfMs: AS_OF,
    linePolls: converted,
  });
  assert.strictEqual(accepted.picks.length, 1, JSON.stringify(accepted.rejections));
  assert.strictEqual(accepted.picks[0].line, 3);
  assert.strictEqual(accepted.picks[0].odds, '-105');
  assert.ok(accepted.picks[0].pushQ > 0);
  restoreEnv(saved);
  console.log('PASS sharp gaps');
})().catch((err) => {
  restoreEnv(saved);
  console.error(err);
  process.exit(1);
});
