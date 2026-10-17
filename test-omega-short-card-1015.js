'use strict';
// Short card (item 3). Later stages drop straights. The private reserve
// fills back to 3 in selectStraights order. No odds pull. No model-math change.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { selectStraights, toPickObject } = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights, isNoQualifyingParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const { summaryStakeDisplay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { buildShortfall } = require('./netlify/functions/lib/omega-vnext/shortfall');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { publicCard } = require('./netlify/functions/get-picks-omega');
const { normalizeEmptyCard } = require('./netlify/functions/lib/no-plays');
const {
  RESERVE_CAP,
  topUpStraights,
  buildReserve,
  applyGenerateReserve,
  finishShortCard,
  sideBlocked,
} = require('./netlify/functions/lib/omega-vnext/card_topup');
const verify = require('./netlify/functions/verify-picks-omega');
const { rerankCard } = require('./netlify/functions/lib/omega-vnext/rerank');
const { applyCardActions } = require('./netlify/functions/lib/omega-vnext/late_news');

assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.4.0-webetai-pure:'));
assert.strictEqual(config.ALLOW_SAME_GAME_TOPUP, false);
assert.strictEqual(config.LEAN_MAX_UNITS, 0.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.LEAN_PARLAY_UNITS, 0.25);
assert.strictEqual(config.MAX_STRAIGHTS, 3);
assert.strictEqual(config.ONE_STRAIGHT_PER_GAME, true);
assert.strictEqual(RESERVE_CAP, 12);

const T0 = '2026-10-15T23:00:00Z';

function cand(n, extra) {
  const away = `Away${n}`;
  const home = `Home${n}`;
  return {
    sport: 'NFL',
    matchup: `${away} @ ${home}`,
    side: `${home} +3`,
    market: 'Spread',
    line: 3,
    odds: -110,
    coverProb: 0.55,
    ev: 0.04,
    edgePct: 0.03,
    liquid: true,
    commenceTime: T0,
    homeTeam: home,
    awayTeam: away,
    book: 'draftkings',
    placeableBooks: ['draftkings', 'fanduel'],
    hardRockPriced: true,
    ...extra,
  };
}

function ml(n, ev, edge, extra) {
  return cand(n, {
    market: 'Moneyline',
    side: `Home${n}`,
    line: null,
    ev,
    edgePct: edge,
    ...extra,
  });
}

function pickName(row) {
  return String((row && (row.pick || row.side)) || '');
}

function names(rows) {
  return (rows || []).map(pickName);
}

function hasName(rows, needle) {
  const want = String(needle).toLowerCase();
  return (rows || []).some((row) => pickName(row).toLowerCase().includes(want));
}

function byName(rows, needle) {
  const want = String(needle).toLowerCase();
  return (rows || []).find((row) => pickName(row).toLowerCase().includes(want));
}

function legNames(parlayLegs) {
  const ticket = (parlayLegs || [])[0];
  return names(ticket && ticket.legs);
}

// --- selectStraights order: floor, positive lean, paired. A zero EV does not fill. ---
{
  const floor = cand(1, { ev: 0.05, edgePct: 0.04, side: 'Home1 +3' });
  const pos = cand(2, { ev: 0.015, edgePct: 0.005, side: 'Home2 +3' });
  const zero = cand(3, { ev: 0, edgePct: 0.001, side: 'Home3 +3' });
  const paired = cand(4, {
    // Printed EV or edge under 1% is not a lean. 1.2% still ranks under Home2.
    ev: 0.012,
    edgePct: 0.005,
    side: 'Home4 +3',
    sharpFairPriced: true,
  });
  const selected = selectStraights([floor], 3, [pos, zero], [paired]);
  assert.deepStrictEqual(selected.map((row) => row.side), ['Home1 +3', 'Home2 +3', 'Home4 +3']);
  assert.deepStrictEqual(selected.map((row) => row.tier), ['floor', 'lean', 'lean']);
  assert.ok(!selected.some((row) => row.side === 'Home3 +3'));

  const reserve = buildReserve({
    yesPool: [floor],
    leanPool: [pos, zero],
    pairedPool: [paired],
    picks: [],
  });
  assert.deepStrictEqual(names(reserve), ['Home1 +3', 'Home2 +3', 'Home4 +3']);
  assert.strictEqual(reserve[2].pairedFill, true);
  const reserveSnap = JSON.stringify(reserve);
  const up = topUpStraights({ picks: [], reserve, blocked: [] });
  assert.strictEqual(JSON.stringify(reserve), reserveSnap, 'top-up does not mutate the reserve');
  assert.deepStrictEqual(names(up.picks), ['Home1 +3', 'Home2 +3', 'Home4 +3']);
  assert.strictEqual(up.exhausted, false);
  assert.ok(!hasName(up.picks, 'Home3'));
  assert.strictEqual(up.picks[0].tier, 'floor');
  assert.strictEqual(up.picks[1].tier, 'lean');
  assert.strictEqual(up.picks[1].units, '0.5u');
  assert.strictEqual(up.picks[2].units, '0.5u');

  const last = selectStraights([floor], 3, [zero], [paired]);
  assert.deepStrictEqual(last.map((row) => row.side), ['Home1 +3', 'Home4 +3']);
  assert.strictEqual(last[1].pairedFill, true);
  assert.strictEqual(last[1].tier, 'lean');
  const reserve2 = buildReserve({
    yesPool: [floor],
    leanPool: [zero],
    pairedPool: [paired],
    picks: [],
  });
  const up2 = topUpStraights({ picks: [], reserve: reserve2, blocked: [] });
  assert.deepStrictEqual(names(up2.picks), ['Home1 +3', 'Home4 +3']);
  assert.strictEqual(up2.picks[1].pairedFill, true);
  assert.strictEqual(up2.picks[1].tier, 'lean');
  assert.strictEqual(up2.picks[1].units, '0.5u');
  assert.ok(paired.ev > zero.ev);
}

// A blocked side never returns. A side already on the card is not added.
{
  const a = cand(1, { ev: 0.06, side: 'Home1 +3' });
  const b = cand(2, { ev: 0.05, side: 'Home2 +3' });
  const on = toPickObject(b);
  const reserve = buildReserve({ yesPool: [a, b], picks: [on] });
  assert.deepStrictEqual(names(reserve), ['Home1 +3']);
  const blocked = topUpStraights({
    picks: [],
    reserve: buildReserve({ yesPool: [a, b], picks: [] }),
    blocked: [{ matchup: a.matchup, side: a.side, reason: 'qa-hard-fail' }],
    target: 1,
  });
  assert.deepStrictEqual(names(blocked.picks), ['Home2 +3']);
  assert.ok(!hasName(blocked.picks, 'Home1'));
  const narrated = toPickObject(ml(1, 0.06, 0.045));
  assert.strictEqual(sideBlocked(narrated, [{ matchup: 'Away1 @ Home1', side: 'Home1 ML' }]), true);
  assert.strictEqual(sideBlocked(toPickObject(ml(2, 0.05, 0.04)), [{ matchup: 'Away1 @ Home1', side: 'Home1 ML' }]), false);
  assert.strictEqual(sideBlocked(narrated, [{ matchup: narrated.matchup, void: true }]), true);
}

// Reserve cap is 12 and does not change a full card's picks.
{
  const pool = [];
  for (let i = 1; i <= 16; i += 1) {
    pool.push(cand(i, { ev: 0.06 - i * 0.002, edgePct: 0.03, side: `Home${i} +3` }));
  }
  const selected = selectStraights(pool, 3);
  const picks = selected.map((row) => toPickObject(row));
  const out = applyGenerateReserve({
    picks,
    yesPool: pool,
    leanPool: [],
    pairedPool: [],
    blocked: [],
    parlayPool: pool,
  });
  assert.strictEqual(out.rebuilt, false);
  assert.strictEqual(out.picks, picks);
  assert.deepStrictEqual(out.added, []);
  assert.strictEqual(out.reserve.length, 12);
  assert.ok(names(out.reserve).includes('Home4 +3'));
  assert.ok(!names(out.reserve).includes('Home16 +3'));
  assert.ok(!names(out.reserve).some((name) => names(picks).includes(name)));
}

// Generate: yesPool of 3, one narrate rejection, lean tops up at 0.5u, parlay rebuilt.
{
  const rejected = ml(1, 0.06, 0.045);
  const gradeA = ml(2, 0.05, 0.04);
  const gradeAm = ml(3, 0.03, 0.025);
  const lean = ml(4, 0.01, 0.005);
  const picks = [toPickObject(gradeA), toPickObject(gradeAm)];
  const narrateRejection = {
    matchup: rejected.matchup,
    side: 'Home1 ML',
    reason: 'news veto',
  };
  const yesPool = [rejected, gradeA, gradeAm];
  const out = applyGenerateReserve({
    picks,
    yesPool,
    leanPool: [lean],
    pairedPool: [],
    blocked: [narrateRejection],
    parlayPool: yesPool.concat([lean]),
    modelVersion: config.MODEL_VERSION,
  });
  assert.strictEqual(out.rebuilt, true);
  assert.strictEqual(out.picks.length, 3);
  assert.strictEqual(out.exhausted, false);
  assert.ok(!hasName(out.picks, 'Home1'), 'rejected side never returns');
  assert.ok(!hasName(legNames(out.parlayLegs), 'Home1'));
  const a = byName(out.picks, 'Home2');
  const am = byName(out.picks, 'Home3');
  const leanPick = byName(out.picks, 'Home4');
  assert.ok(a && am && leanPick);
  assert.strictEqual(a.rating, 'a');
  assert.strictEqual(a.units, '1u');
  assert.strictEqual(a.tier, 'floor');
  assert.strictEqual(am.rating, 'aminus');
  assert.strictEqual(am.units, '0.75u');
  assert.strictEqual(leanPick.tier, 'lean');
  assert.strictEqual(leanPick.units, '0.5u');
  assert.strictEqual(leanPick.label, 'lean');
  const ticket = out.parlayLegs[0];
  assert.strictEqual(ticket.qualifying, true);
  assert.strictEqual(ticket.legs.length, 3);
  assert.strictEqual(ticket.units, '0.5u');
  assert.strictEqual(new Set(ticket.legs.map((leg) => leg.matchup)).size, 3);
  assert.strictEqual(out.topUps.length, 1);
  assert.strictEqual(out.topUps[0].from, 'reserve');
  assert.strictEqual(out.topUps[0].reason, 'short-card');
  assert.ok(String(out.topUps[0].pick).includes('Home4'));
  const shown = summaryStakeDisplay(out.picks, out.parlayLegs);
  assert.strictEqual(shown.totalUnits, '2.75u');
  assert.strictEqual(shown.totalDollars, 413);
  assert.strictEqual(shown.units, 2.75);
  assert.ok(!names(out.reserve).includes('Home1 ML'));
  assert.strictEqual(picks.length, 2, 'caller picks stay the pre-top-up card');
}

// Lean-only card: parlay is 0.25u. Dollars follow the flat table.
{
  const leans = [1, 2, 3].map((n) => ml(n, 0.01, 0.005));
  const picks = [toPickObject({ ...leans[0], tier: 'lean' }), toPickObject({ ...leans[1], tier: 'lean' })];
  const out = applyGenerateReserve({
    picks,
    yesPool: [],
    leanPool: leans,
    pairedPool: [],
    blocked: [],
    parlayPool: leans,
  });
  assert.strictEqual(out.picks.length, 3);
  assert.ok(out.picks.every((row) => row.tier === 'lean' && row.units === '0.5u'));
  assert.strictEqual(out.parlayLegs[0].qualifying, true);
  assert.strictEqual(out.parlayLegs[0].legs.length, 3);
  assert.strictEqual(out.parlayLegs[0].units, '0.25u');
  const shown = summaryStakeDisplay(out.picks, out.parlayLegs);
  assert.strictEqual(shown.totalUnits, '1.75u');
  assert.strictEqual(shown.totalDollars, 263);
}

// 10/7-style: 2 straights and a 2-leg slip. Three distinct games now make 3 + a 3-leg.
{
  const keptA = ml(2, 0.05, 0.04);
  const keptB = ml(3, 0.03, 0.025);
  const filler = ml(4, 0.01, 0.005);
  const shortPicks = [toPickObject(keptA), toPickObject(keptB)];
  const oldTwoLeg = [{
    type: '2-leg-parlay',
    units: '0.5u',
    qualifying: true,
    legs: shortPicks.map((row) => ({ pick: row.pick, matchup: row.matchup, odds: row.odds, coverProb: row.coverProb })),
  }];
  assert.strictEqual(oldTwoLeg[0].legs.length, 2);
  const before = parlayFromStraights(shortPicks);
  assert.strictEqual(before[0].type, '2-leg-parlay');
  assert.strictEqual(before[0].qualifying, true);
  assert.strictEqual(before[0].legs.length, 2);
  const out = applyGenerateReserve({
    picks: shortPicks,
    yesPool: [keptA, keptB],
    leanPool: [filler],
    pairedPool: [],
    blocked: [],
    parlayPool: [keptA, keptB, filler],
  });
  assert.strictEqual(out.picks.length, 3);
  assert.strictEqual(out.parlayLegs[0].legs.length, 3);
  assert.strictEqual(out.parlayLegs[0].qualifying, true);
  assert.ok(!/^2-leg/.test(out.parlayLegs[0].type));
  assert.strictEqual(new Set(out.parlayLegs[0].legs.map((leg) => leg.matchup)).size, 3);
}

// 10/12-style: 1 straight and no parlay. Two more distinct games fill 3 + a 3-leg.
{
  const only = ml(1, 0.05, 0.04);
  const second = ml(2, 0.04, 0.035);
  const third = ml(3, 0.01, 0.005);
  const shortPicks = [toPickObject(only)];
  const before = parlayFromStraights(shortPicks);
  assert.ok(isNoQualifyingParlay(before[0]));
  const out = applyGenerateReserve({
    picks: shortPicks,
    yesPool: [only, second],
    leanPool: [third],
    pairedPool: [],
    blocked: [],
    parlayPool: [only, second, third],
  });
  assert.strictEqual(out.picks.length, 3);
  assert.ok(hasName(out.picks, 'Home2'));
  assert.ok(hasName(out.picks, 'Home3'));
  assert.strictEqual(byName(out.picks, 'Home3').units, '0.5u');
  assert.strictEqual(out.parlayLegs[0].legs.length, 3);
  assert.strictEqual(out.parlayLegs[0].qualifying, true);
}

// Fewer than 3 distinct games: publish what remains, shortfall stays active, no 3-leg.
{
  const home = ml(1, 0.05, 0.04);
  const other = ml(1, 0.012, 0.006, { side: 'Away1' });
  const second = ml(2, 0.04, 0.03);
  const picks = [toPickObject(home)];
  const out = applyGenerateReserve({
    picks,
    yesPool: [home, second],
    leanPool: [other],
    pairedPool: [],
    blocked: [],
    parlayPool: [home, other, second],
  });
  assert.strictEqual(out.picks.length, 2);
  assert.strictEqual(out.exhausted, true);
  assert.ok(hasName(out.picks, 'Home1'));
  assert.ok(hasName(out.picks, 'Home2'));
  assert.ok(!hasName(out.picks, 'Away1'));
  assert.strictEqual(out.parlayLegs[0].type, '2-leg-parlay');
  assert.strictEqual(out.parlayLegs[0].legs.length, 2);
  assert.strictEqual(out.parlayLegs[0].qualifying, true);
  const short = buildShortfall({
    picks: out.picks,
    parlayLegs: out.parlayLegs,
    yesPool: out.reserve,
    rejected: [],
  });
  assert.strictEqual(short.active, true);
  assert.ok(out.picks.length > 0, 'a short card still publishes');
}

// Same-game rows are last resort and only when the flag is on.
{
  const home = toPickObject(ml(1, 0.05, 0.04));
  const second = toPickObject(ml(2, 0.04, 0.03));
  const other = ml(1, 0.02, 0.02, { side: 'Away1' });
  const third = ml(3, 0.03, 0.025);
  const reserve = buildReserve({
    yesPool: [other, third],
    picks: [home, second],
  });
  const off = topUpStraights({ picks: [home, second], reserve, blocked: [] });
  assert.strictEqual(off.picks.length, 3);
  assert.ok(hasName(off.added, 'Home3'));
  assert.ok(!hasName(off.added, 'Away1'));
  assert.ok(off.added.every((row) => row.sameGameFill !== true));

  const onlySame = buildReserve({ yesPool: [other], picks: [home, second] });
  const denied = topUpStraights({ picks: [home, second], reserve: onlySame, blocked: [] });
  assert.strictEqual(denied.picks.length, 2);
  assert.strictEqual(denied.exhausted, true);
  assert.deepStrictEqual(denied.added, []);

  const allowed = topUpStraights({
    picks: [home, second],
    reserve: onlySame,
    blocked: [],
    allowSameGame: true,
  });
  assert.strictEqual(allowed.picks.length, 3);
  assert.strictEqual(allowed.added.length, 1);
  assert.strictEqual(allowed.added[0].sameGameFill, true);
  assert.ok(pickName(allowed.added[0]).toLowerCase().includes('away1'));
  const finished = finishShortCard({
    picks: [home, second],
    reserve: onlySame,
    blocked: [],
    parlayPool: [other],
    allowSameGame: true,
  });
  assert.strictEqual(finished.picks.length, 3);
  assert.ok(isNoQualifyingParlay(finished.parlayLegs[0]), 'two games do not make a 3-leg');
  assert.strictEqual(finished.topUps[0].reason, 'same-game');
  assert.strictEqual(finished.topUps[0].from, 'reserve');
  assert.strictEqual(config.ALLOW_SAME_GAME_TOPUP, false);
}

// Public payload strips reserve. get-picks-omega goes through the same serializer.
{
  const secret = {
    pick: 'SECRET_RESERVE_ONLY',
    matchup: 'Secret @ Hidden',
    side: 'Secret',
    odds: '-110',
    units: '0.5u',
  };
  const stored = {
    model: config.MODEL_VERSION,
    picks: [toPickObject(ml(2, 0.05, 0.04))],
    parlayLegs: [],
    reserve: [secret],
    shortfall: { active: true, nextBest: [{ side: 'SECRET_RESERVE_ONLY' }] },
    summary: { topUps: [{ pick: 'Home2 ML', from: 'reserve', reason: 'short-card' }] },
  };
  const kept = normalizeEmptyCard(stored, 'omega');
  assert.ok(kept.reserve, 'normalizeEmptyCard leaves a full card private fields in place');
  const pub = publicPicksPayload(kept);
  const viaGet = publicCard(kept);
  for (const payload of [pub, viaGet]) {
    assert.strictEqual(payload.reserve, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'reserve'));
    assert.strictEqual(payload.shortfall, undefined);
    const blob = JSON.stringify(payload);
    assert.ok(!blob.includes('SECRET_RESERVE_ONLY'));
    assert.ok(!blob.includes('Secret @ Hidden'));
  }
}

// Verify: placeability drop refills from reserve. A failing reserve row is skipped.
// Exhausted reserve publishes 2 with shortfall active. No Odds API call.
{
  let fetches = 0;
  const prev = global.fetch;
  global.fetch = () => {
    fetches += 1;
    throw new Error('odds API must not be called');
  };
  try {
    const keptA = toPickObject(ml(2, 0.05, 0.04));
    const keptB = toPickObject(ml(3, 0.03, 0.025));
    const dropped = toPickObject(ml(1, 0.08, 0.045));
    const bad = toPickObject(ml(5, 0.07, 0.04, {
      hardRockPriced: false,
      placeableBooks: ['draftkings'],
    }));
    const good = toPickObject(ml(6, 0.04, 0.04, {
      hardRockPriced: true,
      placeableBooks: ['draftkings', 'fanduel'],
    }));
    bad.evRaw = 0.07;
    good.evRaw = 0.04;
    dropped.evRaw = 0.08;
    const card = {
      picks: [keptA, keptB],
      parlayLegs: [{
        type: '3-leg-parlay',
        units: '0.5u',
        qualifying: true,
        legs: [keptA, keptB, dropped].map((row) => ({
          pick: row.pick,
          matchup: row.matchup,
          odds: row.odds,
          coverProb: row.coverProb,
        })),
      }],
      reserve: [dropped, bad, good],
      summary: {},
    };
    const topped = verify.applyVerifyReserveTopUp(card, {
      blocked: [dropped],
      droppedSteam: 0,
      steamHardFails: 0,
    });
    assert.strictEqual(fetches, 0);
    assert.strictEqual(topped.topped, true);
    assert.strictEqual(card.picks.length, 3);
    assert.ok(hasName(card.picks, 'Home6'));
    assert.ok(!hasName(card.picks, 'Home5'), 'placeability failure is skipped');
    assert.ok(!hasName(card.picks, 'Home1'), 'dropped side stays blocked');
    assert.strictEqual(card.parlayLegs[0].legs.length, 3);
    assert.strictEqual(card.parlayLegs[0].qualifying, true);
    assert.ok(!hasName(card.parlayLegs[0].legs, 'Home1'));
    assert.ok(!hasName(card.parlayLegs[0].legs, 'Home5'));
    assert.strictEqual(topped.topUps.length, 1);
    assert.strictEqual(topped.topUps[0].from, 'reserve');
    assert.strictEqual(topped.topUps[0].reason, 'short-card');
    assert.strictEqual(card.summary.topUps[0].from, 'reserve');
    assert.strictEqual(card.shortfall.active, false);
    const shown = summaryStakeDisplay(card.picks, card.parlayLegs);
    assert.strictEqual(card.summary.totalUnits, shown.totalUnits);
    assert.strictEqual(card.summary.totalDollars, shown.totalDollars);

    const badOnly = [1, 2, 3, 4].map((n) => {
      const row = toPickObject(ml(10 + n, 0.09 - n * 0.01, 0.04, {
        hardRockPriced: false,
        placeableBooks: ['draftkings'],
      }));
      row.evRaw = 0.09 - n * 0.01;
      return row;
    });
    let rounds = 0;
    const seen = [];
    const exhaustedCard = {
      picks: [keptA, keptB],
      parlayLegs: [],
      reserve: badOnly,
      summary: {},
    };
    const exhausted = verify.applyVerifyReserveTopUp(exhaustedCard, {
      blocked: [],
      decide(row) {
        rounds += 1;
        seen.push(pickName(row));
        return { drop: true, reason: 'placeability-soft-veto' };
      },
    });
    assert.strictEqual(rounds, 3, 'placeability replacement stops after 3 rounds');
    assert.deepStrictEqual(seen, names(badOnly).slice(0, 3));
    assert.strictEqual(exhausted.topped, false);
    assert.strictEqual(exhausted.exhausted, true);
    assert.strictEqual(exhaustedCard.picks.length, 2);
    assert.strictEqual(exhaustedCard.shortfall.active, true);
    assert.ok(exhaustedCard.picks.length > 0);

    const steamCard = {
      picks: [keptA, keptB],
      parlayLegs: [],
      reserve: [good],
      summary: {},
    };
    const steam = verify.applyVerifyReserveTopUp(steamCard, {
      droppedSteam: 1,
      steamHardFails: 0,
      blocked: [],
    });
    assert.strictEqual(steam.topped, false);
    assert.strictEqual(steamCard.picks.length, 2);
    assert.strictEqual(steamCard.shortfall.active, true);
    assert.strictEqual(fetches, 0);
  } finally {
    global.fetch = prev;
  }
}

// Source: generate tops up after the cap. Verify refill is not inside the steam region.
// qa_hardfail still receives the lean and paired pools.
{
  const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  const genAt = indexSrc.indexOf('async function generateOmegaVnext');
  const gen = indexSrc.slice(genAt);
  const capAt = gen.indexOf('const capped = applyDailyUnitCap');
  const topAt = gen.indexOf('applyGenerateReserve');
  assert.ok(capAt > 0 && topAt > capAt, 'reserve top-up runs after the final unit cap');
  assert.ok(gen.includes('reserve: cardReserve'));
  assert.ok(/applyHardFails\([\s\S]*leanPool:[\s\S]*pairedPool:/.test(gen));
  const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  const steamAt = verifySrc.indexOf('let droppedSteam = 0');
  const steamEnd = verifySrc.indexOf('Step 3: Sharp handicapper review', steamAt);
  const steamRegion = verifySrc.slice(steamAt, steamEnd);
  assert.ok(!steamRegion.includes('applyVerifyReserveTopUp'));
  assert.ok(/blockStraightRefill\s*=\s*true/.test(steamRegion));
  assert.ok(/steamDropBlocksStraightRefill\(/.test(steamRegion));
  assert.ok(verifySrc.includes('applyVerifyReserveTopUp'));
  assert.ok(!/if\s*\(\s*!blockStraightRefill\s*&&/.test(verifySrc));
  assert.strictEqual((verifySrc.match(/buildQualityReplacement\(/g) || []).length, 1);
  assert.ok(!/leg-parlay-verified/.test(verifySrc));
  assert.ok(verifySrc.includes('sort-check rebuild skipped'));
  assert.ok(/sideBlocked\(/.test(verifySrc));
  const configSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/config.js'), 'utf8');
  assert.ok(/Same-game fill is a decision[\s\S]*for WeBet/.test(configSrc));
  assert.ok(/capSameGameExposure at GAME_EXPOSURE_CAP \(2\.0u\) still applies/.test(configSrc));
}

function spreadRow(side, matchup, edge, extra) {
  return {
    sport: 'NFL',
    market: 'Spread',
    side,
    matchup,
    homeTeam: matchup.split(' @ ')[1],
    awayTeam: matchup.split(' @ ')[0],
    commenceTime: '2026-10-13T23:30:00.000Z',
    odds: -110,
    edgePct: edge,
    ev: 0.04,
    coverProb: 0.55,
    line: -3,
    book: 'draftkings',
    tier: 'floor',
    placeableBooks: ['draftkings', 'fanduel'],
    hardRockPriced: true,
    ...extra,
  };
}

function cardFrom(rows) {
  const picks = rows.slice(0, 3).map((r) => ({
    ...r,
    pick: r.side,
    betType: r.market,
    edgePct: r.edgePct,
    evRaw: r.ev,
    tier: 'floor',
    units: '1u',
    coreReasoning: `${r.side} writeup`,
  }));
  return {
    date: '2026-10-13',
    model: config.MODEL_VERSION,
    picks,
    parlayLegs: [{ legs: picks.map((p) => ({ pick: p.pick, matchup: p.matchup, odds: p.odds, coverProb: p.coverProb })) }],
    candidateTable: rows.map((r) => ({ ...r, edge: r.edgePct })),
    selection: { window: '10:00-10:15', rerankWindow: '10:15-10:30', top10: [] },
    summary: { totalPicks: picks.length },
  };
}

async function rerankCases() {
  const published = [
    spreadRow('Alpha +3', 'Alpha @ Beta', 0.05),
    spreadRow('Gamma -2.5', 'Gamma @ Delta', 0.045),
    spreadRow('Epsilon +7', 'Epsilon @ Zeta', 0.04),
  ];
  const eta = spreadRow('Eta -1', 'Eta @ Theta', 0.035);
  const card = cardFrom(published);
  card.reserve = buildReserve({ yesPool: [eta], picks: card.picks, modelVersion: config.MODEL_VERSION });
  assert.ok(names(card.reserve).includes('Eta -1'));
  let fetches = 0;
  const dropped = await rerankCard({
    card,
    now: new Date('2026-10-13T14:15:00.000Z'),
    fetchImpl: () => {
      fetches += 1;
      throw new Error('odds API must not be called');
    },
    runNews: ({ picksData }) => applyCardActions(picksData, [{
      index: 0, action: 'drop', code: 'postponed', reason: 'Game postponed',
    }], new Date('2026-10-13T14:15:00.000Z')),
  });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(dropped.oddsApi, false);
  assert.strictEqual(dropped.changed, true);
  assert.strictEqual(dropped.card.picks.length, 3);
  assert.ok(dropped.card.picks.every((p) => p.pick !== 'Alpha +3'));
  assert.ok(dropped.card.picks.some((p) => p.pick === 'Eta -1' || p.side === 'Eta -1'));
  assert.strictEqual(dropped.card.parlayLegs[0].legs.length, 3);
  assert.ok(dropped.card.summary.topUps.some((row) => row.from === 'reserve' && String(row.pick).includes('Eta')));
  assert.strictEqual(card.picks[0].pick, 'Alpha +3');

  const draft = cardFrom(published);
  draft.reserve = buildReserve({ yesPool: [eta], picks: draft.picks, modelVersion: config.MODEL_VERSION });
  draft.timelineStep = '10:00';
  draft.selection.stage = 'top10';
  draft.selection.top10 = published.map((r) => ({ ...r, edge: r.edgePct }));
  const topped = await rerankCard({
    card: draft,
    now: new Date('2026-10-13T14:15:00.000Z'),
    fetchImpl: () => {
      fetches += 1;
      throw new Error('odds API must not be called');
    },
    runNews: ({ picksData }) => applyCardActions(picksData, [{
      index: 0, action: 'drop', code: 'postponed', reason: 'Game postponed',
    }], new Date('2026-10-13T14:15:00.000Z')),
  });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(topped.oddsApi, false);
  assert.strictEqual(topped.card.picks.length, 3);
  assert.ok(topped.card.picks.every((p) => p.pick !== 'Alpha +3'));
  assert.ok(topped.card.picks.some((p) => p.pick === 'Eta -1' || p.side === 'Eta -1'));
  assert.strictEqual(draft.picks[0].pick, 'Alpha +3');
}

rerankCases().then(() => {
  console.log('PASS test-omega-short-card-1015');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
