'use strict';

/**
 * Two-sided sharp prices on the morning board, the power de-vig switch,
 * and the per-pick close record. No sockets.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const edge = require('./netlify/functions/lib/omega-vnext/edge');
const { noVigTwoWay, americanToImplied, deVigMarket } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { slimCandidate } = require('./netlify/functions/lib/omega-v2/board');
const {
  forcedBetProb, smoothedNovigStats, annotateCandidate,
} = require('./netlify/functions/lib/omega-v2/select');
const { fromOmegaCandidate } = require('./netlify/functions/lib/omega-v2/pipeline');
const {
  boardSharpPricesEnabled, powerDevigEnabled, pickClvEnabled,
} = require('./netlify/functions/lib/omega-v2/constants');
const clv = require('./netlify/functions/lib/omega-v2/candidate_clv');
const { summarizeClvBlobs } = require('./netlify/functions/lib/clv-summary');
const { buildResultKpis } = require('./netlify/functions/lib/omega-vnext/result_kpis');
const { gameKey } = require('./netlify/functions/lib/omega-vnext/line_path');

const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';
const COMMENCE = '2026-11-01T18:00:00Z';
const SHARP_KEYS = ['sharpBook', 'sharpOdds', 'sharpOddsOther', 'sharpDevig', 'pMktPower'];
const OLD_KEYS = [
  'sport', 'matchup', 'side', 'market', 'odds', 'line', 'pModel', 'pMkt', 'coverProb',
  'ev', 'edgePct', 'uncertainty', 'book', 'edgeLine', 'dkLine', 'lineAgrees',
  'openPrice', 'openBook', 'commenceTime', 'homeTeam', 'awayTeam',
];

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} vs ${expected}`);
}

function pair(side, point, prices) {
  return { side, point, prices };
}

function bookRow(partial) {
  return {
    spreadHome: null, spreadHomeOdds: null, spreadAway: null, spreadAwayOdds: null,
    total: null, overOdds: null, underOdds: null,
    mlHome: null, mlAway: null,
    ...partial,
  };
}

function put(map, books) {
  map[gameKey(AWAY, HOME)] = {
    homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE, books,
  };
}

function roundTo(n, places) {
  return Number(n.toFixed(places));
}

function expectedPp(closeNoVig, american) {
  const closeP = roundTo(closeNoVig, 6);
  const implied = roundTo(americanToImplied(american), 6);
  return roundTo((closeP - implied) * 100, 2);
}

function powerOf(sideAmerican, otherAmerican) {
  return noVigTwoWay(sideAmerican, otherAmerican).p1;
}

function testPowerMath() {
  const side = -120;
  const other = 110;
  const i1 = americanToImplied(side);
  const i2 = americanToImplied(other);
  const mult = deVigMarket([
    { side: 't', american: side },
    { side: 'o', american: other },
  ]).find((row) => row.side === 't').fairP;
  const nv = noVigTwoWay(side, other);
  assert.ok(Math.abs(mult - (i1 / (i1 + i2))) < 1e-12);
  assert.ok(Math.abs(nv.p1 - Math.pow(i1, nv.k)) < 1e-8);
  assert.ok(Math.abs(Math.pow(i1, nv.k) + Math.pow(i2, nv.k) - 1) < 1e-8);
  assert.ok(Math.abs(nv.p1 - mult) > 1e-4, 'power and multiplicative differ at -120/+110');

  const paired = [
    pair('Home', null, [{ book: 'pinnacle', american: side }]),
    pair('Away', null, [{ book: 'pinnacle', american: other }]),
  ];
  const quote = edge.sharpQuoteForSide(paired, 'Home', null);
  assert.strictEqual(quote.book, 'pinnacle');
  assert.strictEqual(quote.odds, side);
  assert.strictEqual(quote.oddsOther, other);
  assert.strictEqual(quote.devig, 'power');
  close(quote.p, nv.p1, 'paired p');
  close(quote.pPower, nv.p1, 'paired power');
  assert.strictEqual(edge.sharpFairForSide(paired, 'Home', null), quote.p);

  const split = [
    pair('Home', null, [{ book: 'pinnacle', american: side }]),
    pair('Away', null, [{ book: 'circa', american: other }]),
  ];
  const mixed = edge.sharpQuoteForSide(split, 'Home', null);
  assert.strictEqual(mixed.book, 'consensus');
  assert.strictEqual(mixed.odds, side);
  assert.strictEqual(mixed.oddsOther, other);
  assert.strictEqual(mixed.devig, 'multiplicative');
  close(mixed.p, mult, 'mixed p');
  close(mixed.pPower, nv.p1, 'mixed power');
  assert.strictEqual(edge.sharpFairForSide(split, 'Home', null), mixed.p);

  const one = [pair('Home', null, [{ book: 'pinnacle', american: side }])];
  const lone = edge.sharpQuoteForSide(one, 'Home', null);
  assert.strictEqual(lone.devig, 'implied');
  assert.strictEqual(lone.pPower, null);
  assert.strictEqual(lone.oddsOther, null);
  close(lone.p, i1, 'one-sided implied');

  const fallback = [
    pair('Home', null, [
      { book: 'pinnacle', american: -150 },
      { book: 'bookmaker', american: side },
    ]),
    pair('Away', null, [{ book: 'bookmaker', american: other }]),
  ];
  const booked = edge.sharpQuoteForSide(fallback, 'Home', null);
  assert.strictEqual(booked.book, 'bookmaker');
  assert.strictEqual(booked.devig, 'power');
  assert.strictEqual(booked.odds, side);
  assert.strictEqual(booked.oddsOther, other);
  close(booked.pPower, nv.p1, 'bookmaker power');
}

function testSlimCandidateFlag() {
  assert.strictEqual(boardSharpPricesEnabled({}), true);
  assert.strictEqual(boardSharpPricesEnabled({ OMEGA_V2_BOARD_SHARP_PRICES: 'off' }), false);
  assert.strictEqual(boardSharpPricesEnabled({ OMEGA_V2_BOARD_SHARP_PRICES: '0' }), false);
  assert.strictEqual(boardSharpPricesEnabled({ OMEGA_V2_BOARD_SHARP_PRICES: 'false' }), false);

  const home = pair('Home', null, [
    { book: 'pinnacle', american: -120 },
    { book: 'draftkings', american: -115 },
  ]);
  const away = pair('Away', null, [
    { book: 'pinnacle', american: 110 },
    { book: 'draftkings', american: 105 },
  ]);
  const enriched = edge.enrichCandidateWithEdge({
    sport: 'NBA',
    matchup: 'Away @ Home',
    side: 'Home',
    market: 'Moneyline',
    modelRawP: 0.55,
    coverProb: 0.55,
    homeTeam: 'Home',
    awayTeam: 'Away',
    commenceTime: COMMENCE,
  }, home, [home, away]);
  const power = powerOf(-120, 110);
  assert.strictEqual(enriched.sharpBook, 'pinnacle');
  assert.strictEqual(enriched.sharpOdds, -120);
  assert.strictEqual(enriched.sharpOddsOther, 110);
  assert.strictEqual(enriched.sharpDevig, 'power');
  assert.strictEqual(enriched.pMktPower, power);
  assert.strictEqual(enriched.fair_sharp_p, power);

  const on = slimCandidate(enriched, {});
  assert.deepStrictEqual(Object.keys(on), OLD_KEYS.concat(SHARP_KEYS));
  assert.strictEqual(on.sharpBook, 'pinnacle');
  assert.strictEqual(on.sharpOdds, -120);
  assert.strictEqual(on.sharpOddsOther, 110);
  assert.strictEqual(on.sharpDevig, 'power');
  assert.strictEqual(on.pMktPower, power);
  assert.strictEqual(on.pMkt, power);

  const labeled = slimCandidate({
    ...enriched,
    sharpOdds: '+110',
    sharpOddsOther: '-120',
  }, { OMEGA_V2_BOARD_SHARP_PRICES: '1' });
  assert.strictEqual(labeled.sharpOdds, 110);
  assert.strictEqual(labeled.sharpOddsOther, -120);

  const off = slimCandidate(enriched, { OMEGA_V2_BOARD_SHARP_PRICES: 'off' });
  assert.deepStrictEqual(Object.keys(off), OLD_KEYS);
  for (const key of SHARP_KEYS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(off, key), false, key);
  }
  assert.strictEqual(off.pMkt, on.pMkt);
  assert.strictEqual(off.odds, on.odds);

  const bare = slimCandidate({
    sport: 'NBA', side: 'Home', market: 'Moneyline', odds: -110, fair_sharp_p: 0.52,
  }, {});
  for (const key of SHARP_KEYS) assert.strictEqual(bare[key], null, key);

  const adapted = fromOmegaCandidate(enriched);
  assert.strictEqual(adapted.pMktPower, power);
  assert.strictEqual(adapted.sharpBook, 'pinnacle');
  assert.strictEqual(adapted.sharpOdds, -120);
  assert.strictEqual(adapted.sharpOddsOther, 110);
  assert.strictEqual(adapted.sharpDevig, 'power');
  assert.strictEqual(adapted.fair_sharp_p, power);
}

function testPowerDevigLeavesBetProb() {
  assert.strictEqual(powerDevigEnabled({}), false);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: 'off' }), false);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: '0' }), false);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: 'false' }), false);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: 'on' }), true);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: '1' }), true);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: 'true' }), true);
  assert.strictEqual(powerDevigEnabled({ OMEGA_V2_POWER_DEVIG: 'yes' }), true);

  const constantsSrc = fs.readFileSync(
    path.join(__dirname, 'netlify/functions/lib/omega-v2/constants.js'),
    'utf8',
  );
  const documented = constantsSrc
    .replace(/\/\*|\*\//g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ');
  assert.ok(documented.includes(
    'Stays off until a replay on boards with two-sided prices beats the multiplicative+trim path.',
  ));

  const penalty = smoothedNovigStats(0.20).penalty;
  assert.ok(penalty > 0.03);
  const trimmed = forcedBetProb(0.30, 0.20, { env: {} });
  const withPower = forcedBetProb(0.30, 0.20, { env: {}, pMktPower: 0.17 });
  assert.strictEqual(withPower, trimmed);
  close(trimmed, 0.20 - penalty, 'trimmed pBet');

  const powered = forcedBetProb(0.30, 0.20, {
    env: { OMEGA_V2_POWER_DEVIG: '1' },
    pMktPower: 0.17,
  });
  assert.strictEqual(powered, 0.17);
  const missing = forcedBetProb(0.30, 0.20, { env: { OMEGA_V2_POWER_DEVIG: 'on' } });
  assert.strictEqual(missing, trimmed);

  const row = {
    sport: 'NBA',
    matchup: 'Away @ Home',
    pick: 'Away',
    market: 'Moneyline',
    odds: 400,
    book: 'draftkings',
    commenceTime: '2099-01-01T00:00:00Z',
    calibration: { pCal: 0.30, pMkt: 0.20, pModel: 0.30 },
  };
  const plain = annotateCandidate(row, { forceTop3: true, env: {} });
  const carried = annotateCandidate(
    { ...row, pMktPower: 0.17 },
    { forceTop3: true, env: {} },
  );
  assert.strictEqual(carried.pBet, plain.pBet);
  assert.strictEqual(carried.pBet, trimmed);
  const switched = annotateCandidate(
    { ...row, pMktPower: 0.17 },
    { forceTop3: true, env: { OMEGA_V2_POWER_DEVIG: 'on' } },
  );
  assert.strictEqual(switched.pBet, 0.17);

  const saved = process.env.OMEGA_V2_POWER_DEVIG;
  delete process.env.OMEGA_V2_POWER_DEVIG;
  try {
    assert.strictEqual(powerDevigEnabled(), false);
    assert.strictEqual(forcedBetProb(0.30, 0.20, { pMktPower: 0.17 }), trimmed);
  } finally {
    if (saved == null) delete process.env.OMEGA_V2_POWER_DEVIG;
    else process.env.OMEGA_V2_POWER_DEVIG = saved;
  }
}

function ticket(over) {
  return {
    sport: 'NFL',
    matchup: `${AWAY} @ ${HOME}`,
    side: over.side,
    pick: over.side,
    market: 'Moneyline',
    odds: over.odds,
    book: 'draftkings',
    homeTeam: HOME,
    awayTeam: AWAY,
    commenceTime: COMMENCE,
  };
}

async function testPickClvRecord() {
  assert.strictEqual(pickClvEnabled({}), true);
  assert.strictEqual(pickClvEnabled({ OMEGA_V2_PICK_CLV: 'off' }), false);
  assert.strictEqual(pickClvEnabled({ OMEGA_V2_PICK_CLV: '0' }), false);
  assert.strictEqual(pickClvEnabled({ OMEGA_V2_PICK_CLV: 'false' }), false);

  const games = {};
  put(games, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
  });
  const straight = ticket({ side: AWAY, odds: '+120' });
  const leg = ticket({ side: HOME, odds: -145 });
  const picksData = {
    picks: [straight],
    parlayLegs: [{ legs: [leg] }],
  };
  const clvData = {
    picks: [{ pick: 'Keep', clv: 0.01, clvCents: 1 }],
    avgCLV: 0.01,
    bySport: { NFL: { count: 1, clvSum: 0.01, beat: 1 } },
  };
  const snapshots = [{ source: 'track-clv', capturedAt: COMMENCE, role: 'close', games }];
  await clv.attachCandidateCloses(clvData, {
    dateISO: '2026-11-01',
    candidates: [straight, leg],
    picksData,
    snapshots,
  });

  assert.strictEqual(clvData.picks[0].clv, 0.01);
  assert.strictEqual(clvData.picks[0].clvCents, 1);
  assert.strictEqual(clvData.avgCLV, 0.01);
  assert.strictEqual(clvData.bySport.NFL.clvSum, 0.01);
  assert.strictEqual(clvData.pickClv.length, 2);

  const awayClose = powerOf(140, -160);
  const homeClose = powerOf(-160, 140);
  const straightRow = clvData.pickClv.find((row) => row.kind === 'straight');
  const legRow = clvData.pickClv.find((row) => row.kind === 'leg');
  assert.ok(straightRow && legRow);
  assert.strictEqual(straightRow.betPrice, 120);
  assert.strictEqual(straightRow.betImplied, roundTo(americanToImplied(120), 6));
  assert.strictEqual(straightRow.closeNoVig, roundTo(awayClose, 6));
  assert.strictEqual(straightRow.clvPp, expectedPp(awayClose, 120));
  assert.strictEqual(straightRow.sharpBook, 'pinnacle');
  assert.strictEqual(straightRow.sharpDevig, 'power');
  assert.strictEqual(straightRow.beatClose, straightRow.clvPp > 0);
  assert.strictEqual(legRow.betPrice, -145);
  assert.strictEqual(legRow.betImplied, roundTo(americanToImplied(-145), 6));
  assert.strictEqual(legRow.closeNoVig, roundTo(homeClose, 6));
  assert.strictEqual(legRow.clvPp, expectedPp(homeClose, -145));
  assert.strictEqual(legRow.sharpDevig, 'power');
  assert.ok(straightRow.clvPp < 0, 'dog price shorter than the close is negative');
  assert.ok(legRow.clvPp > 0, 'price longer than the close is positive');
  assert.notStrictEqual(straightRow.rowKey, legRow.rowKey);

  const scored = clvData.candidates.find((row) => String(row.side).includes(AWAY));
  assert.ok(scored, 'published straight stays on the candidate close rows');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(scored, 'clvPp'), false);

  assert.strictEqual(clvData.pickClvSummary.n, 2);
  assert.strictEqual(clvData.pickClvSummary.beatClosePct, 50);
  const mean = roundTo((straightRow.clvPp + legRow.clvPp) / 2, 2);
  assert.strictEqual(clvData.pickClvSummary.meanClvPp, mean);

  const morning = {};
  put(morning, {
    pinnacle: bookRow({ mlAway: 130, mlHome: -150 }),
    draftkings: bookRow({ mlAway: 125, mlHome: -145 }),
  });
  await clv.attachCandidateCloses(clvData, {
    dateISO: '2026-11-01',
    candidates: [straight, leg],
    picksData,
    snapshots: [{ source: 'odds-master-1000', capturedAt: '2026-11-01T14:00:00Z', role: 'board', games: morning }],
  });
  const kept = clvData.pickClv.find((row) => row.kind === 'straight');
  assert.strictEqual(kept.closeNoVig, straightRow.closeNoVig);
  assert.strictEqual(kept.clvPp, straightRow.clvPp);
  assert.strictEqual(kept.sharpBook, 'pinnacle');

  const oneSided = {};
  put(oneSided, { pinnacle: bookRow({ mlAway: 140 }) });
  const loneData = { picks: [{ pick: 'Keep', clv: 0.02 }] };
  await clv.attachCandidateCloses(loneData, {
    dateISO: '2026-11-01',
    picksData: { picks: [straight] },
    snapshots: [{ source: 'track-clv', capturedAt: COMMENCE, role: 'close', games: oneSided }],
  });
  assert.strictEqual(loneData.picks[0].clv, 0.02);
  assert.strictEqual(loneData.pickClv.length, 1);
  assert.strictEqual(loneData.pickClv[0].closeNoVig, null);
  assert.strictEqual(loneData.pickClv[0].clvPp, null);
  assert.strictEqual(loneData.pickClv[0].sharpDevig, null);
  assert.strictEqual(loneData.pickClvSummary.n, 0);
  assert.strictEqual(loneData.pickClvSummary.meanClvPp, null);

  const booked = {};
  put(booked, {
    pinnacle: bookRow({ mlAway: 140 }),
    bookmaker: bookRow({ mlAway: -110, mlHome: -110 }),
  });
  const bookedData = {};
  await clv.attachCandidateCloses(bookedData, {
    dateISO: '2026-11-01',
    picksData: { picks: [straight], parlayLegs: [] },
    snapshots: [{ source: 'track-clv', capturedAt: COMMENCE, role: 'close', games: booked }],
  });
  assert.strictEqual(bookedData.pickClv[0].sharpBook, 'bookmaker');
  assert.strictEqual(bookedData.pickClv[0].sharpDevig, 'power');
  assert.strictEqual(bookedData.pickClv[0].closeNoVig, roundTo(powerOf(-110, -110), 6));
  assert.strictEqual(bookedData.pickClv[0].clvPp, expectedPp(powerOf(-110, -110), 120));

  const offData = {
    picks: [{ pick: 'Keep', clv: 0.01 }],
    avgCLV: 0.01,
    bySport: { NFL: { count: 1, clvSum: 0.01, beat: 1 } },
  };
  await clv.attachCandidateCloses(offData, {
    dateISO: '2026-11-01',
    candidates: [straight],
    picksData,
    snapshots,
    env: { OMEGA_V2_PICK_CLV: 'off' },
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(offData, 'pickClv'), false);
  assert.strictEqual(offData.picks[0].clv, 0.01);
  assert.strictEqual(offData.avgCLV, 0.01);
  assert.ok(Array.isArray(offData.candidates));

  const summary = summarizeClvBlobs([{
    picks: [{ clvCents: 4, beatClosing: true, market: 'Moneyline' }],
    pickClv: [straightRow, legRow],
  }]);
  assert.strictEqual(summary.n, 1);
  assert.strictEqual(summary.meanCents, 4);
  assert.strictEqual(summary.beatClosePct, 100);
  assert.strictEqual(summary.pickClv.n, 2);
  assert.strictEqual(summary.pickClv.meanClvPp, mean);
  assert.strictEqual(summary.pickClv.beatClosePct, 50);

  const kpis = buildResultKpis({ pickClvRows: [straightRow, legRow] });
  assert.deepStrictEqual(kpis.pickClv, summary.pickClv);
  const passed = buildResultKpis({ pickClv: summary.pickClv });
  assert.deepStrictEqual(passed.pickClv, summary.pickClv);
  assert.deepStrictEqual(buildResultKpis({}).pickClv, { n: 0, meanClvPp: null, beatClosePct: null });

  const resultsSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-omega.js'), 'utf8');
  const reportSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/report-tracking-omega.js'), 'utf8');
  assert.ok(resultsSrc.includes('result.pickClv'));
  assert.ok(reportSrc.includes('pickClvRows'));
  assert.ok(!/fetch\s*\(/.test(fs.readFileSync(
    path.join(__dirname, 'netlify/functions/lib/omega-v2/candidate_clv.js'),
    'utf8',
  )));
}

(async () => {
  testPowerMath();
  testSlimCandidateFlag();
  testPowerDevigLeavesBetProb();
  await testPickClvRecord();
  console.log('PASS test-omega-v2-sharp-prices');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
