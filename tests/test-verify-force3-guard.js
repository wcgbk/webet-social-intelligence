'use strict';
// Force-top3 verify guard. No network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls += 1;
  throw new Error('network disabled');
};

const verify = require('../netlify/functions/verify-picks-omega');
const edge = require('../netlify/functions/lib/omega-vnext/edge');
const noPlays = require('../netlify/functions/lib/no-plays');
const linePath = require('../netlify/functions/lib/omega-vnext/line_path');

const VETO = 'placeability-soft-veto: Hard Rock + majors coverage failed';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function straight(row) {
  return {
    pickId: row.pickId,
    pick: row.pick,
    side: row.pick,
    matchup: row.matchup,
    odds: row.odds,
    units: '0.25u',
    unitsNum: 0.25,
    sport: row.sport,
    betType: row.betType,
    market: row.betType,
    lineMove: row.lineMove || null,
  };
}

function makePicks() {
  return [
    straight({
      pickId: 'over-228',
      pick: 'Over 228.5',
      matchup: 'Phoenix Suns @ Denver Nuggets',
      odds: '-114',
      sport: 'NBA',
      betType: 'Total',
      lineMove: {
        _market: 'Total', lineMovePts: 1, towardScore: 0.91, steamAgainst: false,
        oddsMoveCents: -9, missingOpen: false,
      },
    }),
    straight({
      pickId: 'ucsd',
      pick: 'UC San Diego Tritons -19.5',
      matchup: 'Texas Southern Tigers @ UC San Diego Tritons',
      odds: '-105',
      sport: 'NCAAM',
      betType: 'Spread',
      lineMove: {
        _market: 'Spread', lineMovePts: 0, towardScore: -0.1, steamAgainst: false,
        oddsMoveCents: -10, missingOpen: false,
      },
    }),
    straight({
      pickId: 'under-232',
      pick: 'Under 232.5',
      matchup: 'Memphis Grizzlies @ Washington Wizards',
      odds: '-107',
      sport: 'NBA',
      betType: 'Total',
      lineMove: {
        _market: 'Total', lineMovePts: 3, towardScore: -2.99, steamAgainst: true,
        oddsMoveCents: 1, missingOpen: false,
      },
    }),
  ];
}

function makeCard() {
  const picks = makePicks();
  return {
    date: '2026-11-16',
    model: 'omega-v2-sharp-2026-11-01-dkhr',
    engine: 'omega-v2',
    selectionRule: 'force-top3',
    pipelineV2: { parlaySource: 'top3-straights', selectionRule: 'force-top3' },
    edgeSummary: 'Monday, November 16, 2026: top 3 plays by expected growth.',
    picks,
    parlayLegs: [{
      type: '3-leg',
      units: '0.25u',
      unitsNum: 0.25,
      legs: picks.map((p) => ({
        pick: p.pick, matchup: p.matchup, odds: p.odds, pickId: p.pickId,
      })),
    }],
    rejections: [{ side: 'earlier', matchup: 'A @ B', reason: 'ev-floor' }],
    summary: {
      totalPicks: 3,
      totalStraightBets: 3,
      totalUnits: '1u',
      sportsCovered: ['NBA', 'NCAAM'],
    },
  };
}

function reportsFor(card) {
  return card.picks.map((p) => ({
    pick: `${p.pick} ${p.odds}`,
    sport: p.sport,
    severity: 'clean',
    warnings: [],
    errors: [],
  }));
}

function lockSnap(card) {
  return clone({
    picks: card.picks,
    parlayLegs: card.parlayLegs,
    selectionRule: card.selectionRule,
    pipelineV2: card.pipelineV2,
    summary: card.summary,
    rejections: card.rejections,
    edgeSummary: card.edgeSummary,
    noPlays: card.noPlays,
    noPlaysTitle: card.noPlaysTitle,
    noPlaysReason: card.noPlaysReason,
    noGames: card.noGames,
    runComplete: card.runComplete,
  });
}

function oldSteamDrop(card) {
  const kept = [];
  let droppedSteam = 0;
  for (const pick of card.picks) {
    const r = pick.lineMove ? linePath.adverseSteamReason(pick.lineMove, { verify: true }) : null;
    if (r) {
      card.rejections = card.rejections || [];
      card.rejections.unshift({
        matchup: pick.matchup,
        side: pick.pick,
        reason: `QA_HARDFAIL: ${r}`,
        hardFail: true,
      });
      droppedSteam += 1;
      continue;
    }
    kept.push(pick);
  }
  if (droppedSteam > 0) {
    card.picks = kept;
    if (kept.length === 0) {
      card.parlayLegs = [];
      Object.assign(card, noPlays.noPlaysFields(
        "The line moved against today's candidates after they were priced, so the card is a pass."));
      card.edgeSummary = card.noPlaysReason;
    }
    if (card.summary) {
      card.summary.totalStraightBets = kept.length;
      card.summary.totalPicks = kept.length;
    }
    verify.enforceOmegaDailyUnitCap(card);
  }
  return droppedSteam;
}

function adverseOn(pick) {
  pick.lineMove = {
    _market: 'Total', lineMovePts: 3, towardScore: -2.99, steamAgainst: true,
    oddsMoveCents: 1, missingOpen: false,
  };
}

test('OMEGA_VERIFY_FORCE3_GUARD defaults on', () => {
  assert.strictEqual(edge.PLACEABILITY_VETO_REASON, VETO);
  assert.strictEqual(verify.force3GuardEnabled({}), true);
  assert.strictEqual(verify.force3GuardEnabled({ OMEGA_VERIFY_FORCE3_GUARD: '' }), true);
  for (const value of ['on', '1', 'true', 'yes', 'YES']) {
    assert.strictEqual(verify.force3GuardEnabled({ OMEGA_VERIFY_FORCE3_GUARD: value }), true, value);
  }
  for (const value of ['off', '0', 'false', 'OFF', 'False']) {
    assert.strictEqual(verify.force3GuardEnabled({ OMEGA_VERIFY_FORCE3_GUARD: value }), false, value);
  }
});

test('flag on + force-top3 annotates placeability and steam drops', () => {
  const card = makeCard();
  const beforeIds = card.picks.map((p) => p.pickId);
  const beforeParlay = clone(card.parlayLegs);
  const reps = reportsFor(card);
  const env = {};
  const place = verify.applyPlaceabilityVerifyPass(card, [
    { drop: true, reason: VETO },
    { drop: false },
    { drop: false },
  ], [], reps, { env });
  assert.strictEqual(place.dropped, 0);
  assert.strictEqual(place.parlayCleared, false);
  assert.strictEqual(place.annotated, 1);
  const steamReason = linePath.adverseSteamReason(card.picks[2].lineMove, { verify: true });
  assert.ok(steamReason);
  const steam = verify.applySteamVerifyPass(card, reps, { env });
  assert.strictEqual(steam.droppedSteam, 0);
  assert.strictEqual(steam.annotated, 1);
  assert.deepStrictEqual(card.picks.map((p) => p.pickId), beforeIds);
  assert.strictEqual(card.picks.length, 3);
  assert.deepStrictEqual(card.parlayLegs, beforeParlay);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.ok(card.verifyAnnotations.some((a) => (
    a.action === 'annotated' && a.side === 'Over 228.5' && a.matchup === 'Phoenix Suns @ Denver Nuggets' && a.reason === VETO
  )));
  assert.ok(card.verifyAnnotations.some((a) => (
    a.action === 'annotated' && a.side === 'Under 232.5' && a.reason === `QA_HARDFAIL: ${steamReason}`
  )));
  assert.ok(!card.rejections.some((r) => r.reason === VETO || String(r.reason).startsWith('QA_HARDFAIL')));
  assert.ok(card.rejections.some((r) => r.reason === 'ev-floor'));
  assert.ok(reps[0].warnings.includes(VETO));
  assert.strictEqual(reps[0].severity, 'warning');
  assert.ok(reps[2].warnings.includes(`QA_HARDFAIL: ${steamReason}`));
  assert.strictEqual(reps.length, 3);
  assert.ok(!card.noPlays);
});

test('pipelineV2.selectionRule force-top3 is guarded without a top-level stamp', () => {
  const card = makeCard();
  delete card.selectionRule;
  card.pipelineV2 = { selectionRule: 'force-top3', parlaySource: 'top3-straights' };
  const applied = verify.applyPlaceabilityVerifyPass(card, [
    { drop: true, reason: VETO }, { drop: false }, { drop: false },
  ], [], reportsFor(card), { env: { OMEGA_VERIFY_FORCE3_GUARD: 'yes' } });
  assert.strictEqual(applied.annotated, 1);
  assert.strictEqual(applied.dropped, 0);
  assert.strictEqual(card.picks.length, 3);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.strictEqual(verify.shouldEnforceForceTop3(card, lockSnap(card), { OMEGA_VERIFY_FORCE3_GUARD: 'yes' }), true);
});

test('flag on keeps the parlay when every straight would steam-drop', () => {
  const card = makeCard();
  for (const pick of card.picks) adverseOn(pick);
  const beforeParlay = clone(card.parlayLegs);
  const on = verify.applySteamVerifyPass(card, reportsFor(card), { env: { OMEGA_VERIFY_FORCE3_GUARD: 'true' } });
  assert.strictEqual(on.annotated, 3);
  assert.strictEqual(on.droppedSteam, 0);
  assert.strictEqual(card.picks.length, 3);
  assert.deepStrictEqual(card.parlayLegs, beforeParlay);
  assert.ok(!card.noPlays);
  assert.ok(card.verifyAnnotations.every((a) => a.action === 'annotated'));

  const off = makeCard();
  for (const pick of off.picks) adverseOn(pick);
  const offOld = clone(off);
  verify.applySteamVerifyPass(off, reportsFor(off), { env: { OMEGA_VERIFY_FORCE3_GUARD: 'off' } });
  oldSteamDrop(offOld);
  assert.deepStrictEqual(off, offOld);
  assert.strictEqual(off.picks.length, 0);
  assert.deepStrictEqual(off.parlayLegs, []);
  assert.ok(off.noPlays);
});

test('floor restores missing locked picks and the parlay', () => {
  const card = makeCard();
  const snap = lockSnap(card);
  const survivor = card.picks[1];
  survivor.odds = '-101';
  card.picks = [survivor];
  card.parlayLegs = [];
  card.rejections = [
    { side: 'earlier', matchup: 'A @ B', reason: 'ev-floor' },
    { side: 'Over 228.5', matchup: 'Phoenix Suns @ Denver Nuggets', reason: VETO, placeability: true },
    {
      side: 'Under 232.5',
      matchup: 'Memphis Grizzlies @ Washington Wizards',
      reason: 'QA_HARDFAIL: steam_against_line: 3 pts (threshold 1.5)',
      hardFail: true,
    },
    {
      side: 'Over 228.5',
      matchup: 'Portland Trail Blazers @ Minnesota Timberwolves',
      reason: 'no-dk-hr-price',
    },
  ];
  Object.assign(card, noPlays.noPlaysFields(
    "The line moved against today's candidates after they were priced, so the card is a pass."));
  card.edgeSummary = card.noPlaysReason;
  card.summary.totalPicks = 1;
  card.summary.totalStraightBets = 1;
  card.summary.totalUnits = '0.3u';
  card.summary.sportsCovered = ['NCAAM'];
  const snapJson = JSON.stringify(snap);
  const result = verify.enforceForceTop3Floor(card, snap);
  assert.strictEqual(JSON.stringify(snap), snapJson);
  assert.strictEqual(result.restored, 2);
  assert.strictEqual(result.parlayRestored, true);
  assert.deepStrictEqual(card.picks.map((p) => p.pickId), ['over-228', 'ucsd', 'under-232']);
  assert.strictEqual(card.picks[1], survivor);
  assert.strictEqual(card.picks[1].odds, '-101');
  assert.notStrictEqual(card.picks[0], snap.picks[0]);
  assert.notStrictEqual(card.parlayLegs, snap.parlayLegs);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.strictEqual(card.summary.totalPicks, 3);
  assert.strictEqual(card.summary.totalStraightBets, 3);
  assert.strictEqual(card.summary.totalUnits, '1u');
  assert.deepStrictEqual(card.summary.sportsCovered, ['NBA', 'NCAAM']);
  assert.ok(!card.noPlays && !card.noPlaysTitle && !card.noPlaysReason);
  assert.strictEqual(card.noGames, undefined);
  assert.strictEqual(card.runComplete, undefined);
  assert.strictEqual(card.edgeSummary, 'Monday, November 16, 2026: top 3 plays by expected growth.');
  assert.ok(card.rejections.some((r) => r.reason === 'ev-floor'));
  assert.ok(card.rejections.some((r) => r.reason === 'no-dk-hr-price'));
  assert.ok(!card.rejections.some((r) => r.reason === VETO));
  assert.ok(!card.rejections.some((r) => String(r.reason).startsWith('QA_HARDFAIL')));
  const restores = card.verifyAnnotations.filter((a) => a.action === 'restored-force-top3');
  assert.deepStrictEqual(restores.map((a) => a.side), ['Over 228.5', 'Under 232.5', 'parlay']);
});

test('floor matches pickId before the pick name and stops at 3', () => {
  const card = makeCard();
  const snap = lockSnap(card);
  const replacement = { ...clone(card.picks[0]), pickId: 'other' };
  card.picks = [replacement];
  card.parlayLegs = [];
  verify.enforceForceTop3Floor(card, snap);
  assert.deepStrictEqual(card.picks.map((p) => p.pickId), ['other', 'over-228', 'ucsd']);
  assert.strictEqual(card.picks.length, 3);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
});

test('a replacement that already keeps 3 straights stays unchanged', () => {
  const card = makeCard();
  const snap = lockSnap(card);
  card.picks[0] = {
    ...card.picks[0],
    pickId: 'replacement',
    pick: 'Replacement ML',
    side: 'Replacement ML',
    matchup: 'A @ B',
  };
  const before = clone(card);
  const result = verify.enforceForceTop3Floor(card, snap);
  assert.strictEqual(result.restored, 0);
  assert.strictEqual(result.parlayRestored, false);
  assert.deepStrictEqual(card, before);
  assert.ok(!Object.prototype.hasOwnProperty.call(card, 'verifyAnnotations'));
});

test('floor restores a shortened parlay and leaves the 3 straights', () => {
  const card = makeCard();
  const snap = lockSnap(card);
  const picksRef = card.picks;
  card.parlayLegs = [{
    type: '2-leg',
    units: '0.25u',
    unitsNum: 0.1,
    legs: clone(snap.parlayLegs[0].legs.slice(0, 2)),
  }];
  card.summary.totalUnits = '0.9u';
  const result = verify.enforceForceTop3Floor(card, snap);
  assert.strictEqual(result.restored, 0);
  assert.strictEqual(result.parlayRestored, true);
  assert.strictEqual(card.picks, picksRef);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.strictEqual(card.parlayLegs[0].type, '3-leg');
  assert.strictEqual(card.summary.totalUnits, '1u');
  assert.deepStrictEqual(card.verifyAnnotations, [{
    side: 'parlay',
    matchup: '3-leg',
    reason: 'restored locked force-top3 parlay',
    action: 'restored-force-top3',
  }]);
});

test('flag off reproduces the old placeability and steam drops', () => {
  for (const value of ['off', '0', 'false']) {
    const env = { OMEGA_VERIFY_FORCE3_GUARD: value };
    const placeCard = makeCard();
    const placeOld = clone(placeCard);
    const decisions = [{ drop: true, reason: VETO }, { drop: false }, { drop: false }];
    const reps = reportsFor(placeCard);
    const applied = verify.applyPlaceabilityVerifyPass(placeCard, decisions, [], reps, { env });
    const oldApplied = edge.applyPlaceabilityDrops(placeOld, clone(decisions), []);
    assert.strictEqual(applied.dropped, oldApplied.dropped, value);
    assert.strictEqual(applied.parlayCleared, oldApplied.parlayCleared, value);
    assert.strictEqual(applied.annotated, 0, value);
    assert.deepStrictEqual(placeCard, placeOld, value);
    assert.strictEqual(placeCard.picks.length, 2, value);
    assert.strictEqual(placeCard.parlayLegs.length, 0, value);
    assert.ok(placeCard.rejections.some((r) => r.reason === VETO), value);
    assert.ok(!Object.prototype.hasOwnProperty.call(placeCard, 'verifyAnnotations'), value);
    assert.strictEqual(reps.length, 2, value);

    const steamCard = makeCard();
    const steamOld = clone(steamCard);
    const steam = verify.applySteamVerifyPass(steamCard, reportsFor(steamCard), { env });
    const oldDropped = oldSteamDrop(steamOld);
    assert.strictEqual(steam.droppedSteam, oldDropped, value);
    assert.strictEqual(steam.annotated, 0, value);
    assert.deepStrictEqual(steamCard, steamOld, value);
    assert.strictEqual(steamCard.picks.length, 2, value);
    assert.ok(steamCard.picks.every((p) => p.pick !== 'Under 232.5'), value);
    assert.strictEqual(steamCard.parlayLegs.length, 1, value);
    assert.ok(steamCard.rejections.some((r) => String(r.reason).startsWith('QA_HARDFAIL:')), value);
    assert.ok(!Object.prototype.hasOwnProperty.call(steamCard, 'verifyAnnotations'), value);
    assert.strictEqual(verify.shouldEnforceForceTop3(makeCard(), lockSnap(makeCard()), env), false, value);
  }
});

test('non-force-top3 card still drops while the guard is on', () => {
  const env = { OMEGA_VERIFY_FORCE3_GUARD: 'on' };
  const card = makeCard();
  delete card.selectionRule;
  card.pipelineV2 = { parlaySource: 'ranked-pool' };
  card.engine = 'omega-v2';
  const old = clone(card);
  const decisions = [{ drop: true, reason: VETO }, { drop: false }, { drop: false }];
  const applied = verify.applyPlaceabilityVerifyPass(card, decisions, [], reportsFor(card), { env });
  const oldApplied = edge.applyPlaceabilityDrops(old, clone(decisions), []);
  assert.strictEqual(applied.dropped, 1);
  assert.strictEqual(applied.parlayCleared, true);
  assert.strictEqual(applied.annotated, 0);
  assert.deepStrictEqual(card, old);
  assert.deepStrictEqual(oldApplied, { dropped: 1, parlayCleared: true });
  assert.strictEqual(verify.isForceTop3VerifyCard(card), false);
  assert.strictEqual(verify.shouldEnforceForceTop3(card, lockSnap(card), env), false);

  const steamCard = makeCard();
  delete steamCard.selectionRule;
  steamCard.pipelineV2 = { parlaySource: 'ranked-pool' };
  const steamOld = clone(steamCard);
  const steam = verify.applySteamVerifyPass(steamCard, reportsFor(steamCard), { env });
  const oldDropped = oldSteamDrop(steamOld);
  assert.strictEqual(steam.droppedSteam, oldDropped);
  assert.strictEqual(steam.annotated, 0);
  assert.deepStrictEqual(steamCard, steamOld);
  assert.strictEqual(steamCard.picks.length, 2);
});

test('clean 3-pick card is unchanged', () => {
  const card = makeCard();
  card.summary.totalUnits = '1.0u';
  const snap = lockSnap(card);
  const before = clone(card);
  const floor = verify.enforceForceTop3Floor(card, snap);
  assert.strictEqual(floor.restored, 0);
  assert.strictEqual(floor.parlayRestored, false);
  assert.deepStrictEqual(card, before);
  assert.strictEqual(JSON.stringify(card), JSON.stringify(before));
  assert.ok(!Object.prototype.hasOwnProperty.call(card, 'verifyAnnotations'));

  const quiet = clone(before);
  for (const pick of quiet.picks) {
    if (pick.lineMove) pick.lineMove.steamAgainst = false;
  }
  const quietBefore = clone(quiet);
  const reps = reportsFor(quiet);
  const place = verify.applyPlaceabilityVerifyPass(
    quiet,
    quiet.picks.map(() => ({ drop: false })),
    [],
    reps,
    { env: { OMEGA_VERIFY_FORCE3_GUARD: 'true' } },
  );
  const steam = verify.applySteamVerifyPass(quiet, reps, { env: {} });
  assert.strictEqual(place.dropped, 0);
  assert.strictEqual(place.annotated, 0);
  assert.strictEqual(steam.droppedSteam, 0);
  assert.strictEqual(steam.annotated, 0);
  assert.deepStrictEqual(quiet, quietBefore);
  assert.strictEqual(JSON.stringify(quiet), JSON.stringify(quietBefore));
});

test('handler writes go through the force-top3 floor', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/verify-picks-omega.js'), 'utf8');
  assert.ok(/OMEGA_VERIFY_FORCE3_GUARD \(default on; =off\/0\/false rolls back\)/.test(src));
  const handlerSrc = src.slice(src.indexOf('exports.handler'));
  const wrapAt = handlerSrc.indexOf('async function writeVerifiedCard');
  const floorAt = handlerSrc.indexOf('enforceForceTop3Floor(');
  const updateAt = handlerSrc.indexOf('updatePicksBlob(');
  assert.ok(wrapAt > 0 && floorAt > wrapAt && updateAt > floorAt);
  assert.strictEqual((handlerSrc.match(/updatePicksBlob\s*\(/g) || []).length, 1);
  assert.ok(handlerSrc.includes('applyPlaceabilityVerifyPass'));
  assert.ok(handlerSrc.includes('applySteamVerifyPass'));
  assert.strictEqual(fetchCalls, 0);
});
