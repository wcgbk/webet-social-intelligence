'use strict';

/**
 * 10/19 Edge regression: one gate-clear MLB total, one >10pp NFL moneyline,
 * and several DK/Hard Rock prices that miss the floors. The card still
 * publishes 3 straights and a 3-leg parlay. A killed parlay leg refills.
 * Summary units match the published stakes. The model label is MODEL_VERSION.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const config = require('./netlify/functions/lib/omega-vnext/config');
const select = require('./netlify/functions/lib/omega-vnext/select');
const gates = require('./netlify/functions/lib/omega-vnext/gates');
const { publishEdgeCard } = require('./netlify/functions/lib/omega-vnext/assemble');
const { alignEdgeSummary } = require('./netlify/functions/lib/omega-vnext/narrate');
const verify = require('./netlify/functions/verify-picks-omega');
const starters = require('./netlify/functions/confirm-starters-mlb');

const cardDate = '2026-10-19';
const asOfMs = Date.parse('2026-10-19T16:00:00Z');
const commence = '2026-10-20T00:10:00Z';
const SP_KILL_REASON = 'Parlay dropped — fewer than 2 live legs after SP kill';

function parseU(u) {
  return parseFloat(String(u == null ? '' : u).replace(/[^0-9.]/g, '')) || 0;
}

function sumPublished(picks, parlayLegs) {
  const straight = (picks || []).reduce((s, p) => s + parseU(p.units), 0);
  const parlay = (parlayLegs || []).reduce((s, pl) => s + parseU(pl.units), 0);
  return Math.round((straight + parlay) * 100) / 100;
}

function row(overrides) {
  const odds = overrides.odds != null ? overrides.odds : -115;
  return {
    sport: 'NHL',
    market: 'Total',
    odds,
    coverProb: 0.51,
    ev: 0.01,
    edgePct: 0.012,
    predictedClv: 1,
    liquid: true,
    placeable: true,
    uncertainty: 0.12,
    book: 'draftkings',
    bestDkHr: { american: odds, book: 'draftkings' },
    commenceTime: commence,
    line: 5.5,
    ...overrides,
  };
}

function slate() {
  return [
    row({
      sport: 'MLB',
      matchup: 'Cleveland Guardians @ Tampa Bay Rays',
      homeTeam: 'Tampa Bay Rays',
      awayTeam: 'Cleveland Guardians',
      side: 'Over 6.5',
      market: 'Total',
      odds: -115,
      coverProb: 0.56,
      ev: 0.045,
      edgePct: 0.04,
      book: 'hardrockbet',
      bestDkHr: { american: -115, book: 'hardrockbet' },
      line: 6.5,
    }),
    row({
      sport: 'NFL',
      matchup: 'Washington Commanders @ San Francisco 49ers',
      homeTeam: 'San Francisco 49ers',
      awayTeam: 'Washington Commanders',
      side: 'Washington Commanders',
      market: 'Moneyline',
      odds: 180,
      coverProb: 0.5,
      ev: 0.08,
      edgePct: 0.1646,
      book: 'fanduel',
      bestDkHr: { american: 175, book: 'draftkings' },
      line: null,
    }),
    row({
      sport: 'NFL',
      matchup: 'Washington Commanders @ San Francisco 49ers',
      homeTeam: 'San Francisco 49ers',
      awayTeam: 'Washington Commanders',
      side: 'San Francisco 49ers -3.5',
      market: 'Spread',
      odds: -110,
      coverProb: 0.505,
      ev: 0.012,
      edgePct: 0.02,
      line: -3.5,
    }),
    row({
      sport: 'NHL',
      matchup: 'Anaheim Ducks @ New York Rangers',
      homeTeam: 'New York Rangers',
      awayTeam: 'Anaheim Ducks',
      side: 'Over 5.5',
      coverProb: 0.53,
      ev: 0.011,
      edgePct: 0.018,
      odds: -120,
      bestDkHr: { american: -120, book: 'draftkings' },
      line: 5.5,
    }),
    row({
      sport: 'NHL',
      matchup: 'Boston Bruins @ Toronto Maple Leafs',
      homeTeam: 'Toronto Maple Leafs',
      awayTeam: 'Boston Bruins',
      side: 'Over 6',
      coverProb: 0.52,
      ev: 0.01,
      edgePct: 0.012,
      odds: -130,
      bestDkHr: { american: -130, book: 'draftkings' },
      line: 6,
    }),
    row({
      sport: 'NHL',
      matchup: 'Colorado Avalanche @ Dallas Stars',
      homeTeam: 'Dallas Stars',
      awayTeam: 'Colorado Avalanche',
      side: 'Over 5',
      coverProb: 0.51,
      ev: 0.009,
      edgePct: 0.011,
      odds: -130,
      bestDkHr: { american: -130, book: 'hardrockbet' },
      line: 5,
    }),
  ];
}

function publishSlate() {
  const prepared = select.prepareEdgePositions(slate());
  const { yesPool, rejected } = gates.applyGates(prepared.positions, { cardDate, asOfMs });
  const qualified = select.selectStraights(yesPool, config.MAX_STRAIGHTS);
  const built = publishEdgeCard({
    positions: prepared.positions,
    qualified,
    yesPool,
    rejected,
    miscalibrated: prepared.diagnostics.miscalibrated,
    hardFails: [],
    cardDate,
    modelVersion: config.MODEL_VERSION,
    dateFormatted: 'Sunday, October 19, 2026',
  });
  return { prepared, yesPool, rejected, qualified, built };
}

assert.strictEqual(config.MODEL_VERSION, 'v12.5.4-omega-vnext');
assert.strictEqual(config.LEAN_PAD, false);

{
  const { prepared, yesPool, qualified, built } = publishSlate();
  assert.ok(qualified.length < 3, `gates already filled the card: ${qualified.length}`);
  assert.ok((prepared.diagnostics.miscalibrated || []).some(m => m.reason === 'edge-over-10pp' && /Commanders/.test(m.side || '')));

  const mlbRaw = prepared.positions.find(c => /Guardians/.test(c.matchup || ''));
  assert.ok(mlbRaw, 'MLB total stayed inside 10pp');
  assert.strictEqual(select.toPickObject(mlbRaw, { modelVersion: config.MODEL_VERSION }).units, '1.25u');

  const card = {
    model: config.MODEL_VERSION,
    summary: built.summary,
    picks: built.picks,
    parlayLegs: built.parlayLegs,
    rejections: built.rejections,
    parlayPool: built.parlayPool,
    edgeSummary: built.edgeSummary,
  };

  assert.strictEqual(card.picks.length, 3, `straights ${card.picks.map(p => p.pick).join(' | ')}`);
  assert.strictEqual(card.parlayLegs.length, 1);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3, `parlay ${card.parlayLegs[0] && card.parlayLegs[0].legs.map(l => l.pick).join(' | ')}`);
  assert.ok(card.rejections.length > 0, 'rejections populated');
  assert.ok(card.rejections.every(r => r && r.reason), 'every rejection has a reason');
  assert.ok(card.rejections.some(r => r.reason === 'edge-over-10pp'), 'over-10pp candidate is listed');
  assert.ok(!card.picks.some(p => /Washington Commanders/.test(p.pick || '')), 'miscalibrated ML stayed off the card');

  const publishedMlb = card.picks.find(p => /Over 6\.5/.test(p.pick || ''));
  assert.ok(publishedMlb, 'MLB total published');
  assert.notStrictEqual(publishedMlb.units, '1.25u', `post-cap units ${publishedMlb.units}`);
  assert.strictEqual(card.model, config.MODEL_VERSION);
  assert.strictEqual(card.summary.modelVersion, config.MODEL_VERSION);
  assert.ok(Math.abs(parseU(card.summary.totalUnits) - sumPublished(card.picks, card.parlayLegs)) < 0.001, card.summary.totalUnits);
  assert.ok(!/1\.25\s*units?/i.test(card.edgeSummary), card.edgeSummary);
  assert.ok(card.edgeSummary.includes(publishedMlb.units), card.edgeSummary);

  const dirty = 'WeBetAI sizes the Guardians total at 1.25 units after the cap.';
  const aligned = alignEdgeSummary(dirty, card.picks, card.parlayLegs, 'Sunday, October 19, 2026');
  assert.ok(!/1\.25\s*units?/i.test(aligned), aligned);
  assert.ok(aligned.includes(publishedMlb.units), aligned);
  assert.ok(aligned.includes(card.parlayLegs[0].units), aligned);

  const killedLeg = card.parlayLegs[0].legs.find(l => /Over 5\.5/.test(l.pick || '')) || card.parlayLegs[0].legs[2];
  const refilled = verify.resolveLockedParlay(card.parlayLegs, {
    removedPicks: [killedLeg.pick],
    pool: card.parlayPool,
    straightCard: card.picks,
  });
  assert.strictEqual(refilled.rebuilt, false);
  assert.strictEqual(refilled.action, 'refilled');
  assert.strictEqual(refilled.parlayLegs[0].legs.length, 3);
  assert.ok(!refilled.parlayLegs[0].legs.some(l => l.pick === killedLeg.pick));
  assert.strictEqual(card.picks.length, 3, 'a parlay-leg kill does not drop a straight');

  const noPool = verify.resolveLockedParlay(card.parlayLegs, {
    removedPicks: [killedLeg.pick],
    straightCard: card.picks,
  });
  assert.strictEqual(noPool.rebuilt, false);
  assert.notStrictEqual(noPool.action, 'refilled');
  assert.strictEqual(verify.straightRefillAllowed({ droppedSteam: 0, steamHardFails: 0, blockStraightRefill: false }), false);

  const quiet = {
    picks: card.picks.map(p => ({ ...p })),
    parlayLegs: JSON.parse(JSON.stringify(card.parlayLegs)),
    parlayPool: card.parlayPool,
    parlayKilledReason: SP_KILL_REASON,
    summary: { ...card.summary, aplusLocks: card.summary.aplusLocks || 0 },
  };
  const quietStats = starters.processPicks(quiet, {});
  assert.strictEqual(quietStats.scratches, 0);
  assert.strictEqual(quietStats.killed, 0);
  assert.strictEqual(quiet.parlayLegs[0].legs.length, 3);
  assert.ok(!quiet.parlayKilledReason);
  assert.ok(Math.abs(parseU(quiet.summary.totalUnits) - sumPublished(quiet.picks, quiet.parlayLegs)) < 0.001);

  const short = {
    picks: [{
      sport: 'MLB',
      matchup: 'Cleveland Guardians @ Tampa Bay Rays',
      pick: 'Over 6.5',
      betType: 'Total',
      units: '1u',
    }],
    parlayLegs: JSON.parse(JSON.stringify(card.parlayLegs)),
    summary: {
      totalPicks: 1,
      totalStraightBets: 1,
      totalUnits: '1.00u',
      sportsCovered: ['MLB'],
      aplusLocks: 0,
      modelVersion: config.MODEL_VERSION,
    },
  };
  const shortStats = starters.processPicks(short, {});
  assert.strictEqual(shortStats.killed, 0);
  assert.strictEqual(short.picks.length, 1);
  assert.strictEqual(short.parlayLegs[0].legs.length, 3);
  assert.ok(!short.parlayKilledReason);
  assert.ok(Math.abs(parseU(short.summary.totalUnits) - sumPublished(short.picks, short.parlayLegs)) < 0.001);
  assert.strictEqual(short.summary.modelVersion, config.MODEL_VERSION);
  assert.strictEqual(short.summary.aplusLocks, 0);

  const scratched = {
    picks: [
      {
        sport: 'MLB',
        matchup: 'Cleveland Guardians @ Tampa Bay Rays',
        pick: 'Over 6.5',
        betType: 'Total',
        units: '0.5u',
        awaySP: 'Tanner Bibee',
        homeSP: 'Shane Baz',
        rating: 'a',
      },
      { sport: 'NFL', matchup: 'Washington Commanders @ San Francisco 49ers', pick: 'San Francisco 49ers -3.5', betType: 'Spread', units: '0.5u', rating: 'b' },
      { sport: 'NHL', matchup: 'Anaheim Ducks @ New York Rangers', pick: 'Over 5.5', betType: 'Total', units: '0.5u', rating: 'b' },
    ],
    parlayLegs: [{
      type: '3-leg-parlay-optimized',
      units: '0.5u',
      legs: [
        { pick: 'Over 6.5', side: 'Over 6.5', matchup: 'Cleveland Guardians @ Tampa Bay Rays', sport: 'MLB', betType: 'Total', odds: '-115', coverProb: '56.0%', ev: '4.5%' },
        { pick: 'San Francisco 49ers -3.5', side: 'San Francisco 49ers -3.5', matchup: 'Washington Commanders @ San Francisco 49ers', sport: 'NFL', betType: 'Spread', odds: '-110', coverProb: '50.5%', ev: '1.2%' },
        { pick: 'Over 5.5', side: 'Over 5.5', matchup: 'Anaheim Ducks @ New York Rangers', sport: 'NHL', betType: 'Total', odds: '-120', coverProb: '53.0%', ev: '1.1%' },
      ],
    }],
    parlayPool: card.parlayPool,
    summary: { totalPicks: 3, totalStraightBets: 3, totalUnits: '2u', sportsCovered: ['MLB', 'NFL', 'NHL'], aplusLocks: 0 },
  };
  const scratchStats = starters.processPicks(scratched, {
    guardians_rays: {
      awayTeam: 'Cleveland Guardians',
      homeTeam: 'Tampa Bay Rays',
      awaySP: 'Slade Cecconi',
      homeSP: 'Shane Baz',
      status: 'pre',
    },
  });
  assert.strictEqual(scratchStats.scratches, 1);
  assert.strictEqual(scratchStats.killed, 1);
  assert.strictEqual(scratched.picks.length, 2);
  assert.ok(!scratched.picks.some(p => /Over 6\.5/.test(p.pick || '')));
  assert.strictEqual(scratched.parlayLegs[0].legs.length, 3);
  assert.ok(!scratched.parlayLegs[0].legs.some(l => /Guardians/.test(l.matchup || '') && /Over 6\.5/.test(l.pick || '')));
  assert.ok(!scratched.parlayKilledReason);
  assert.ok(Math.abs(parseU(scratched.summary.totalUnits) - sumPublished(scratched.picks, scratched.parlayLegs)) < 0.001);
}

{
  const commence2 = commence;
  const priced = (matchup, home, away, side, market, coverProb) => row({
    sport: 'NHL',
    matchup,
    homeTeam: home,
    awayTeam: away,
    side,
    market,
    coverProb,
    ev: 0.005,
    edgePct: 0.01,
    odds: -110,
    bestDkHr: { american: -110, book: 'draftkings' },
    commenceTime: commence2,
  });
  const four = [
    priced('A @ B', 'B', 'A', 'A ML', 'Moneyline', 0.55),
    priced('A @ B', 'B', 'A', 'Over 6', 'Total', 0.56),
    priced('C @ D', 'D', 'C', 'C ML', 'Moneyline', 0.54),
    priced('C @ D', 'D', 'C', 'D +1.5', 'Spread', 0.56),
  ];
  const thin = publishEdgeCard({
    positions: four,
    qualified: [],
    yesPool: [],
    rejected: four.map(c => ({ ...c, rejectReason: 'ev-floor' })),
    miscalibrated: [],
    hardFails: [],
    cardDate,
    modelVersion: config.MODEL_VERSION,
    dateFormatted: 'Sunday, October 19, 2026',
  });
  assert.strictEqual(thin.picks.length, 3, 'two priced games still fill a third straight from a second market');
  assert.strictEqual(new Set(thin.picks.map(p => p.matchup)).size, 2);
  assert.strictEqual(thin.parlayLegs[0].legs.length, 3);
  assert.ok(thin.picks.every(p => p.flag !== 'no-edge-lean' && p.rating === 'b' && p.units === '0.5u'));
}

{
  const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  const starterSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/confirm-starters-mlb.js'), 'utf8');
  assert.ok(indexSrc.indexOf('let built = publishFrom') < indexSrc.indexOf('await narrateAndVerify'));
  assert.ok(!/if \(kept\.length < 2 && Array\.isArray\(picksData\.parlayLegs\)\)/.test(starterSrc));
  assert.ok(indexSrc.includes('model: MODEL_VERSION'));
}

console.log('PASS test-omega-1019-never-block', {
  MODEL_VERSION: config.MODEL_VERSION,
});
