'use strict';
// A clean force-top3 card is stamped verified/verifiedAt and written back
// without any pick-field edit. No network.
const assert = require('assert');
const verify = require('./netlify/functions/verify-picks-omega');

function straight(row) {
  return {
    pick: row.pick,
    odds: row.odds,
    units: row.units,
    stakeUsd: row.stakeUsd,
    rating: row.rating,
    grade: row.rating,
    qualityGrade: row.rating,
    confidence: row.confidence,
    edgePct: row.edgePct,
    winProbability: row.winProbability,
    sport: 'NCAAF',
    betType: row.betType,
    matchup: row.matchup,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    coreReasoning: 'WeBetAI likes this side at the posted number. The price is the bet.',
    whatLoses: '',
  };
}

const picks = [
  straight({
    pick: 'South Alabama Jaguars -3.5',
    odds: '+110',
    units: '1.75u',
    stakeUsd: 263,
    rating: 'a',
    confidence: 82,
    edgePct: '3.5%',
    winProbability: '51.1%',
    betType: 'Spread',
    matchup: 'Troy Trojans @ South Alabama Jaguars',
    homeTeam: 'South Alabama Jaguars',
    awayTeam: 'Troy Trojans',
  }),
  straight({
    pick: 'Alabama Crimson Tide',
    odds: '-600',
    units: '1.5u',
    stakeUsd: 225,
    rating: 'aminus',
    confidence: 75,
    edgePct: '2.9%',
    winProbability: '88.6%',
    betType: 'Moneyline',
    matchup: 'Alabama Crimson Tide @ Vanderbilt Commodores',
    homeTeam: 'Vanderbilt Commodores',
    awayTeam: 'Alabama Crimson Tide',
  }),
  straight({
    pick: 'Virginia Cavaliers',
    odds: '-450',
    units: '0.25u',
    stakeUsd: 38,
    rating: 'aminus',
    confidence: 75,
    edgePct: '2.7%',
    winProbability: '84.5%',
    betType: 'Moneyline',
    matchup: 'California Golden Bears @ Virginia Cavaliers',
    homeTeam: 'Virginia Cavaliers',
    awayTeam: 'California Golden Bears',
  }),
];

const parlayLegs = [{
  type: '3-leg',
  units: '1u',
  combinedOdds: '+186',
  legs: picks.map((p) => ({
    pick: p.pick,
    odds: p.odds,
    units: '1u',
    stakeUsd: p.stakeUsd,
    rating: p.rating,
    grade: p.grade,
    qualityGrade: p.qualityGrade,
    confidence: p.confidence,
    edgePct: p.edgePct,
    winProbability: p.winProbability,
  })),
}];

function card() {
  return {
    date: '2026-11-14',
    model: 'omega-v2-sharp-2026-11-01-dkhr',
    engine: 'omega-v2',
    selectionRule: 'force-top3',
    pipelineV2: { parlaySource: 'top3-straights', selectionRule: 'force-top3' },
    meta: { pipelineV2: true },
    picks: JSON.parse(JSON.stringify(picks)),
    parlayLegs: JSON.parse(JSON.stringify(parlayLegs)),
    claudeVerified: true,
    qaHardFails: [],
  };
}

(async () => {
  const clean = card();
  const beforePicks = JSON.stringify(clean.picks);
  const beforeParlay = JSON.stringify(clean.parlayLegs);
  const beforeFields = verify.pickStampSnapshot(clean);
  const writes = [];
  const stamped = await verify.stampCleanVerifiedCard(clean, {
    dateKey: '2026-11-14',
    now: new Date('2026-11-14T15:45:00.000Z'),
    writer: async (dateKey, data) => {
      writes.push({ dateKey, body: JSON.parse(JSON.stringify(data)) });
    },
  });
  assert.strictEqual(stamped.stamped, true, stamped.reason);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].dateKey, '2026-11-14');
  assert.strictEqual(writes[0].body.verified, true);
  assert.strictEqual(writes[0].body.verifiedAt, '2026-11-14T15:45:00.000Z');
  assert.strictEqual(JSON.stringify(writes[0].body.picks), beforePicks);
  assert.strictEqual(JSON.stringify(writes[0].body.parlayLegs), beforeParlay);
  assert.strictEqual(verify.pickStampSnapshot(writes[0].body), beforeFields);
  assert.strictEqual(JSON.stringify(clean.picks), beforePicks);
  assert.strictEqual(JSON.stringify(clean.parlayLegs), beforeParlay);

  const dirty = card();
  dirty.picks[0].rating = 'b';
  dirty.picks[0].grade = 'b';
  dirty.picks[0].qualityGrade = 'b';
  dirty.picks[0].confidence = 60;
  const dirtyBefore = JSON.stringify(dirty.picks);
  const dirtyWrites = [];
  const skipped = await verify.stampCleanVerifiedCard(dirty, {
    dateKey: '2026-11-14',
    now: new Date('2026-11-14T15:45:00.000Z'),
    writer: async () => { dirtyWrites.push(true); },
  });
  assert.strictEqual(skipped.stamped, false);
  assert.strictEqual(skipped.reason, 'would-change-picks');
  assert.strictEqual(dirtyWrites.length, 0);
  assert.strictEqual(JSON.stringify(dirty.picks), dirtyBefore);
  assert.strictEqual(dirty.verified, undefined);

  const { verifyCleanStampEnabled } = require('./netlify/functions/lib/default_on_flag');
  assert.strictEqual(verifyCleanStampEnabled(), true);
  for (const value of ['off', '0', 'false']) {
    const env = { OMEGA_VERIFY_CLEAN_STAMP: value };
    assert.strictEqual(verifyCleanStampEnabled(env), false, value);
    const offCard = card();
    const before = JSON.stringify(offCard);
    const offWrites = [];
    const off = await verify.stampCleanVerifiedCard(offCard, {
      dateKey: '2026-11-14',
      now: new Date('2026-11-14T15:45:00.000Z'),
      env,
      writer: async () => { offWrites.push(true); },
    });
    assert.strictEqual(off.stamped, false, value);
    assert.strictEqual(off.reason, 'flag-off', value);
    assert.strictEqual(offWrites.length, 0, value);
    assert.strictEqual(offCard.verified, undefined, value);
    assert.strictEqual(offCard.verifiedAt, undefined, value);
    assert.strictEqual(JSON.stringify(offCard), before, value);
  }

  console.log('PASS test-omega-v2-verify-stamp');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
