'use strict';

/**
 * Best-practice card formula.
 * Default on. =off restores the trimmed price, the old rank packs, and the old stake cap.
 * A side with no projection uses p_pin and ranks on EV_rank = EV - 0.01.
 */

const assert = require('assert');
const { logit, logistic, blendProb, formulaBlendWeight, formulaModelProb } = require('./netlify/functions/lib/omega-v2/blend');
const {
  webetaiFormulaEnabled, sportCapEnabled, straightCap05uEnabled, FORMULA_MODELLESS_HAIRCUT, FORMULA_BLEND_W,
} = require('./netlify/functions/lib/omega-v2/constants');
const {
  annotateCandidate, selectForcedTop3, smoothedNovigStats, buildDebugTrace,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights, quarterKellyFromDecimal } = require('./netlify/functions/lib/omega-v2/size');
const { toPick, autoCorrectCard } = require('./netlify/functions/lib/omega-v2/guards');
const { letterFromEv } = require('./netlify/functions/lib/omega-v2/letter');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { convertSigmaProb, normCdfOpen, formulaSigma } = require('./netlify/functions/lib/omega-v2/key_convert');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');

const AS_OF = Date.parse('2026-11-24T15:00:00Z');
const COMMENCE = '2026-11-25T00:00:00Z';

delete process.env.OMEGA_WEBETAI_FORMULA;
delete process.env.OMEGA_V2_SPORT_CAP;
delete process.env.OMEGA_V2_STRAIGHT_CAP_05U;

function close(a, b, label) {
  assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
}

function baseEnv(over) {
  return {
    OMEGA_V2_FORCE_TOP3: 'on',
    OMEGA_V2_MARKET_P: 'on',
    OMEGA_V2_LONGSHOT_ADJ: 'on',
    OMEGA_V2_BLEND_P: 'on',
    OMEGA_V2_BLEND_TRIM: 'on',
    ...(over || {}),
  };
}

function opts(env) {
  return { pregameAsOfMs: AS_OF, forceTop3: true, env };
}

function row(over) {
  return {
    sport: over.sport || 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: over.market || 'Moneyline',
    odds: over.odds,
    book: over.book || 'draftkings',
    gameKey: over.gameKey || String(over.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    homeTeam: over.homeTeam || null,
    awayTeam: over.awayTeam || null,
    line: over.line != null ? over.line : null,
    calibration: over.calibration,
    projMethod: over.projMethod || null,
    modelProjection: over.modelProjection != null ? over.modelProjection : null,
    sharpAnchor: over.sharpAnchor === true,
  };
}

function annotate(over, env) {
  return annotateCandidate(row(over), opts(env || baseEnv()));
}

function pct(p) {
  return `${(Number(p) * 100).toFixed(1)}%`;
}

function book(key, outcomes, market) {
  return { key, last_update: '2026-11-24 10:05', markets: [{ key: market, outcomes }] };
}

function spreadPoll(sport, away, home, books) {
  return {
    '1000': [{
      sport,
      away_team: away,
      home_team: home,
      commence_time: COMMENCE,
      bookmakers: books,
    }],
  };
}

function assertSameP(annotated) {
  const dec = americanToDecimal(annotated.odds);
  const implied = 1 / dec;
  close(annotated.implied, implied, 'implied is 1/decimal');
  close(annotated.edge, annotated.pBet - implied, 'edge uses p_final');
  close(annotated.ev, annotated.pBet * dec - 1, 'EV uses p_final');
  close(annotated.pBlend, annotated.pBet, 'pBlend is p_final');
  assert.strictEqual(annotated._formulaTrace.discounts.longshotTrim, false);
  const pick = toPick(annotated);
  assert.strictEqual(pick.winProbability, pct(annotated.pBet));
  close(pick.evRaw, annotated.ev, 'printed EV');
  close(pick.pBet, annotated.pBet, 'pick pBet');
  close(pick.pBlend, annotated.pBet, 'pick pBlend');
  assert.strictEqual(pick.rating, letterFromEv(annotated.ev));
  assert.strictEqual(pick._formulaTrace, undefined);
  const sized = sizeForcedStraights([annotated])[0];
  const kelly = quarterKellyFromDecimal(annotated.pBet, dec, 2, { floorToQuarter: true });
  let expectUnits = kelly.units >= 0.25 ? kelly.units : 0.25;
  if (letterFromEv(annotated.ev) === 'c') expectUnits = 0.25;
  else if (letterFromEv(annotated.ev) === 'b' && expectUnits > 0.5) expectUnits = 0.5;
  if (expectUnits > 0.5) expectUnits = 0.5;
  close(sized.units, expectUnits, 'stake uses p_final');
  close(sized.pBet, annotated.pBet, 'sized pBet');
}

async function main() {
  assert.strictEqual(webetaiFormulaEnabled(), true, 'unset master flag is on');
  assert.strictEqual(webetaiFormulaEnabled({}), true, 'omitted key is on when the process is unset');
  assert.strictEqual(sportCapEnabled(), true);
  assert.strictEqual(straightCap05uEnabled(), true);
  for (const off of ['off', '0', 'false', 'no']) {
    assert.strictEqual(webetaiFormulaEnabled({ OMEGA_WEBETAI_FORMULA: off }), false, off);
  }
  process.env.OMEGA_WEBETAI_FORMULA = 'off';
  assert.strictEqual(webetaiFormulaEnabled({ OMEGA_V2_BLEND_P: 'on' }), false, 'partial env inherits the process rollback');
  assert.strictEqual(webetaiFormulaEnabled({ OMEGA_WEBETAI_FORMULA: 'on' }), true, 'explicit on wins');
  delete process.env.OMEGA_WEBETAI_FORMULA;

  const pin = 0.54;
  const model = 0.62;
  const w = FORMULA_BLEND_W;
  close(w, 0.35, 'default weight');
  const z = ((1 - w) * logit(pin)) + (w * logit(model));
  close(blendProb(pin, model, w), logistic(z), 'logit blend');
  assert.strictEqual(formulaBlendWeight('NCAAM', {}), 0.35);
  assert.strictEqual(formulaBlendWeight('NBA', { OMEGA_V2_BLEND_W_NBA: '0.2' }), 0.2);
  assert.strictEqual(formulaBlendWeight('NBA', { OMEGA_V2_BLEND_W_NBA: '0.5' }), 0.35);

  const penalty = smoothedNovigStats(0.3).penalty;
  assert.ok(penalty > 0.02, `longshot penalty ${penalty}`);
  const off = annotate({
    matchup: 'Away @ Home',
    pick: 'Away ML',
    odds: 250,
    calibration: { pCal: 0.3, pMkt: 0.3, pModel: 0.3 },
  }, baseEnv({ OMEGA_WEBETAI_FORMULA: 'off' }));
  const on = annotate({
    matchup: 'Away @ Home',
    pick: 'Away ML',
    odds: 250,
    calibration: { pCal: 0.3, pMkt: 0.3, pModel: 0.3 },
  }, baseEnv());
  assert.strictEqual(on.formulaApplied, true);
  assert.strictEqual(on.pModelBlend, null);
  assert.strictEqual(on.blendW, 0);
  close(on.pBet, 0.3, 'no extra longshot trim');
  close(on.pPinnacle, 0.3, 'p_pin stored');
  assert.ok(off.pBet < on.pBet - 0.02, `flag-off still trims (${off.pBet} vs ${on.pBet})`);
  close(on.evRank, on.ev - FORMULA_MODELLESS_HAIRCUT, 'modelless haircut');
  process.env.OMEGA_WEBETAI_FORMULA = 'on';
  process.env.OMEGA_V2_STRAIGHT_CAP_05U = 'on';
  assertSameP(on);
  delete process.env.OMEGA_WEBETAI_FORMULA;
  delete process.env.OMEGA_V2_STRAIGHT_CAP_05U;

  const blended = annotate({
    matchup: 'Away @ Home',
    pick: 'Away ML',
    odds: -110,
    calibration: { pCal: 0.7, pMkt: 0.55, pModel: 0.7 },
  });
  const expectP = blendProb(0.55, 0.7, 0.35);
  close(blended.pBet, expectP, 'w=0.35 blend');
  assert.strictEqual(blended.qualified, true, `blend should clear the post-mix screen (${blended.rejectReason})`);
  const screened = annotate({
    matchup: 'Away @ Home',
    pick: 'Away ML',
    odds: -110,
    calibration: { pCal: 0.7, pMkt: 0.55, pModel: 0.7 },
  }, baseEnv({ OMEGA_WEBETAI_FORMULA: 'off' }));
  assert.strictEqual(screened.rejectReason, 'edge-over-10pp');

  for (const bad of [401, -301]) {
    const dropped = annotate({
      matchup: 'Away @ Home',
      pick: 'Away ML',
      odds: bad,
      calibration: { pCal: 0.55, pMkt: 0.55, pModel: 0.55 },
    });
    assert.strictEqual(dropped.qualified, false, String(bad));
    assert.strictEqual(dropped.rejectReason, 'price-band', String(bad));
  }
  for (const okOdds of [400, -300]) {
    const kept = annotate({
      matchup: 'Away @ Home',
      pick: 'Away ML',
      odds: okOdds,
      calibration: okOdds > 0
        ? { pCal: 0.25, pMkt: 0.25, pModel: 0.25 }
        : { pCal: 0.78, pMkt: 0.78, pModel: 0.78 },
    });
    assert.strictEqual(kept.qualified, true, `${okOdds} ${kept.rejectReason}`);
    assert.strictEqual(kept.favCapFill, undefined);
  }

  const anchor = annotate({
    sport: 'NCAAM',
    matchup: 'UMKC @ Kansas',
    pick: 'UMKC ML',
    odds: 110,
    projMethod: 'ncaam-sharp-anchor',
    modelProjection: 1.5,
    sharpAnchor: true,
    calibration: { pCal: 0.48, pMkt: 0.45, pModel: 0.48 },
  });
  assert.strictEqual(anchor.pModelBlend, null, 'anchored NCAAM is not a model');
  assert.strictEqual(formulaModelProb(anchor, 0.45), null);
  const standings = annotate({
    sport: 'NCAAM',
    matchup: 'Lehigh @ Army',
    pick: 'Lehigh ML',
    odds: -105,
    projMethod: 'ncaam-standings',
    modelProjection: 8.5,
    calibration: { pCal: 0.6, pMkt: 0.52, pModel: 0.6 },
  });
  close(standings.pModelBlend, 0.6, 'standings p_model');
  close(standings.blendW, 0.35, 'NCAAM weight');
  close(standings.pBet, blendProb(0.52, 0.6, 0.35), 'NCAAM blend');
  assert.strictEqual(standings._formulaTrace.projection.kind, 'margin');
  assert.strictEqual(standings._formulaTrace.projection.value, 8.5);

  const modeled = annotate({
    matchup: 'A @ B',
    pick: 'A ML',
    odds: 100,
    calibration: { pCal: 0.53, pMkt: 0.51, pModel: 0.53 },
  });
  const bare = annotate({
    matchup: 'C @ D',
    pick: 'C ML',
    odds: 100,
    calibration: { pCal: 0.52, pMkt: 0.52, pModel: 0.52 },
  });
  assert.ok(bare.ev > modeled.ev, `bare EV ${bare.ev} should exceed modeled EV ${modeled.ev}`);
  assert.ok(modeled.evRank > bare.evRank, `modeled EV_rank ${modeled.evRank} vs bare ${bare.evRank}`);
  const ranked = selectForcedTop3([bare, modeled], opts(baseEnv()));
  assert.strictEqual(ranked[0].pick, 'A ML');

  function side(sport, name, pMkt, pCal) {
    return annotate({
      sport,
      matchup: `${name} Away @ ${name} Home`,
      pick: `${name} ML`,
      odds: -110,
      calibration: { pCal, pMkt, pModel: pCal },
    });
  }
  const nba = [side('NBA', 'One', 0.56, 0.6), side('NBA', 'Two', 0.56, 0.6), side('NBA', 'Three', 0.56, 0.6)];
  const nhlPos = side('NHL', 'Ice', 0.53, 0.55);
  const nhlNeg = side('NHL', 'Cold', 0.5, 0.5);
  assert.ok(nhlPos.evRank >= 0, nhlPos.evRank);
  assert.ok(nhlNeg.evRank < 0, nhlNeg.evRank);
  const capOn = selectForcedTop3([...nba, nhlPos], opts(baseEnv()));
  assert.strictEqual(capOn.filter((r) => r.sport === 'NBA').length, 2);
  assert.strictEqual(capOn.filter((r) => r.sport === 'NHL').length, 1);
  const capOff = selectForcedTop3([...nba, nhlPos], opts(baseEnv({ OMEGA_V2_SPORT_CAP: 'off' })));
  assert.strictEqual(capOff.length, 3);
  assert.ok(capOff.every((r) => r.sport === 'NBA'), capOff.map((r) => r.sport).join(','));
  const fill = selectForcedTop3([...nba, nhlNeg], opts(baseEnv()));
  assert.strictEqual(fill.length, 3);
  assert.ok(fill.every((r) => r.sport === 'NBA'), fill.map((r) => `${r.sport}:${r.evRank}`).join(','));

  const stakeRow = annotate({
    matchup: 'Stake Away @ Stake Home',
    pick: 'Stake Away ML',
    odds: -110,
    calibration: { pCal: 0.59, pMkt: 0.59, pModel: 0.59 },
  });
  process.env.OMEGA_WEBETAI_FORMULA = 'on';
  process.env.OMEGA_V2_STRAIGHT_CAP_05U = 'on';
  const capped = sizeForcedStraights([stakeRow])[0];
  assert.strictEqual(capped.units, 0.5);
  assert.strictEqual(capped.stakeUsd, 75);
  process.env.OMEGA_V2_STRAIGHT_CAP_05U = 'off';
  const uncapped = sizeForcedStraights([stakeRow])[0];
  assert.strictEqual(uncapped.units, 2);
  assert.strictEqual(uncapped.stakeUsd, 300);
  process.env.OMEGA_WEBETAI_FORMULA = 'off';
  process.env.OMEGA_V2_STRAIGHT_CAP_05U = 'on';
  const rolled = sizeForcedStraights([annotate({
    matchup: 'Stake Away @ Stake Home',
    pick: 'Stake Away ML',
    odds: -110,
    calibration: { pCal: 0.59, pMkt: 0.59, pModel: 0.59 },
  }, baseEnv({ OMEGA_WEBETAI_FORMULA: 'off' }))])[0];
  assert.strictEqual(rolled.units, 2, 'master off restores the 2u cap');
  const corrected = autoCorrectCard({
    selectionRule: 'force-top3',
    modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
    leakageChecked: true,
    picks: [{
      pick: 'Stake Away ML',
      matchup: 'Stake Away @ Stake Home',
      units: '2u',
      unitsNum: 2,
      stakeUsd: 300,
      rating: 'a',
      grade: 'a',
      qualityGrade: 'a',
      evRaw: 0.12,
      ev: '12.0%',
      edgePct: '6.0%',
      blendApplied: true,
      pBet: 0.59,
      decimal: americanToDecimal(-110),
      odds: '-110',
      book: 'draftkings',
      commenceTime: COMMENCE,
    }],
    parlayLegs: [],
    parlayPool: [],
  }, { pregameAsOfMs: AS_OF });
  process.env.OMEGA_WEBETAI_FORMULA = 'on';
  const correctedOn = autoCorrectCard({
    selectionRule: 'force-top3',
    modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
    leakageChecked: true,
    picks: [{
      pick: 'Stake Away ML',
      matchup: 'Stake Away @ Stake Home',
      units: '2u',
      unitsNum: 2,
      stakeUsd: 300,
      rating: 'a',
      grade: 'a',
      qualityGrade: 'a',
      evRaw: 0.12,
      ev: '12.0%',
      edgePct: '6.0%',
      blendApplied: true,
      pBet: 0.59,
      decimal: americanToDecimal(-110),
      odds: '-110',
      book: 'draftkings',
      commenceTime: COMMENCE,
    }],
    parlayLegs: [],
    parlayPool: [],
  }, { pregameAsOfMs: AS_OF });
  assert.strictEqual(corrected.picks[0].unitsNum, 2);
  assert.strictEqual(correctedOn.picks[0].unitsNum, 0.5);
  assert.strictEqual(correctedOn.picks[0].stakeUsd, 75);
  delete process.env.OMEGA_WEBETAI_FORMULA;
  delete process.env.OMEGA_V2_STRAIGHT_CAP_05U;

  const nflKey = convertSigmaProb({
    sport: 'NFL', market: 'Spread', p: 0.5, fromPoint: 3, toPoint: 3.5, side: 'spread',
  });
  close(nflKey.p, 0.545, 'NFL key mass');
  assert.strictEqual(formulaSigma('NBA'), 12);
  assert.strictEqual(formulaSigma('NCAAM'), 11);
  assert.strictEqual(formulaSigma('NFL'), 13.5);
  assert.strictEqual(formulaSigma('NCAAF'), 16);
  assert.strictEqual(formulaSigma('NHL'), null);
  const nbaStep = convertSigmaProb({
    sport: 'NBA', market: 'Spread', p: 0.5, fromPoint: -3.5, toPoint: -3, side: 'spread',
  });
  close(nbaStep.p, normCdfOpen(0.5 / 12), 'NBA sigma step');
  assert.strictEqual(convertSigmaProb({
    sport: 'NBA', market: 'Spread', p: 0.5, fromPoint: -4, toPoint: -2.5, side: 'spread',
  }), null);
  const nhlSame = convertSigmaProb({
    sport: 'NHL', market: 'Spread', p: 0.42, fromPoint: -1.5, toPoint: -1.5, side: 'spread',
  });
  close(nhlSame.p, 0.42, 'NHL same line');
  assert.strictEqual(convertSigmaProb({
    sport: 'NHL', market: 'Spread', p: 0.42, fromPoint: -1.5, toPoint: -0.5, side: 'spread',
  }), null);

  const away = 'Boston Celtics';
  const home = 'Miami Heat';
  const pinBooks = [
    book('pinnacle', [
      { name: away, price: -110, point: -3.5 },
      { name: home, price: -110, point: 3.5 },
    ], 'spreads'),
    book('draftkings', [
      { name: away, price: -110, point: -2.5 },
      { name: home, price: -110, point: 2.5 },
    ], 'spreads'),
  ];
  const converted = annotateCandidate(row({
    sport: 'NBA',
    matchup: `${away} @ ${home}`,
    pick: `${away} -2.5`,
    market: 'Spread',
    odds: -110,
    line: -2.5,
    homeTeam: home,
    awayTeam: away,
    calibration: { pCal: 0.55, pMkt: 0.5, pModel: 0.55 },
  }), { ...opts(baseEnv()), linePolls: spreadPoll('NBA', away, home, pinBooks) });
  assert.strictEqual(converted.rejectReason, null, converted.rejectReason);
  assert.strictEqual(converted._formulaTrace.p_pin_method, 'pinnacle-sigma');
  assert.ok(converted._formulaTrace.discounts.lineConversion, 'conversion recorded');
  close(converted._formulaTrace.discounts.lineConversion.distance, 1, 'one point');
  assert.strictEqual(converted._formulaTrace.discounts.lineConversion.sigma, 12);

  const farBooks = [
    book('pinnacle', [
      { name: away, price: -110, point: -4 },
      { name: home, price: -110, point: 4 },
    ], 'spreads'),
    book('draftkings', [
      { name: away, price: -110, point: -2.5 },
      { name: home, price: -110, point: 2.5 },
    ], 'spreads'),
  ];
  const tooFar = annotateCandidate(row({
    sport: 'NBA',
    matchup: `${away} @ ${home}`,
    pick: `${away} -2.5`,
    market: 'Spread',
    odds: -110,
    line: -2.5,
    homeTeam: home,
    awayTeam: away,
    calibration: { pCal: 0.55, pMkt: 0.5, pModel: 0.55 },
  }), { ...opts(baseEnv()), linePolls: spreadPoll('NBA', away, home, farBooks) });
  assert.strictEqual(tooFar.rejectReason, 'no-pinnacle-fair');

  const bruins = 'Boston Bruins';
  const rangers = 'New York Rangers';
  const nhlBooks = [
    book('pinnacle', [
      { name: bruins, price: -110, point: -1.5 },
      { name: rangers, price: -110, point: 1.5 },
    ], 'spreads'),
    book('draftkings', [
      { name: bruins, price: -105, point: -0.5 },
      { name: rangers, price: -115, point: 0.5 },
    ], 'spreads'),
  ];
  const nhlMove = annotateCandidate(row({
    sport: 'NHL',
    matchup: `${bruins} @ ${rangers}`,
    pick: `${bruins} -0.5`,
    market: 'Spread',
    odds: -105,
    line: -0.5,
    homeTeam: rangers,
    awayTeam: bruins,
    calibration: { pCal: 0.55, pMkt: 0.52, pModel: 0.55 },
  }), { ...opts(baseEnv()), linePolls: spreadPoll('NHL', bruins, rangers, nhlBooks) });
  assert.strictEqual(nhlMove.rejectReason, 'no-pinnacle-fair');

  const circaOnly = [
    book('circa', [
      { name: away, price: -110, point: -2.5 },
      { name: home, price: -110, point: 2.5 },
    ], 'spreads'),
    book('draftkings', [
      { name: away, price: -110, point: -2.5 },
      { name: home, price: -110, point: 2.5 },
    ], 'spreads'),
  ];
  const circaDrop = annotateCandidate(row({
    sport: 'NBA',
    matchup: `${away} @ ${home}`,
    pick: `${away} -2.5`,
    market: 'Spread',
    odds: -110,
    line: -2.5,
    homeTeam: home,
    awayTeam: away,
    calibration: { pCal: 0.55, pMkt: 0.5, pModel: 0.55 },
  }), { ...opts(baseEnv()), linePolls: spreadPoll('NBA', away, home, circaOnly) });
  assert.strictEqual(circaDrop.rejectReason, 'no-pinnacle-fair');
  const circaOff = annotateCandidate(row({
    sport: 'NBA',
    matchup: `${away} @ ${home}`,
    pick: `${away} -2.5`,
    market: 'Spread',
    odds: -110,
    line: -2.5,
    homeTeam: home,
    awayTeam: away,
    calibration: { pCal: 0.55, pMkt: 0.5, pModel: 0.55 },
  }), {
    ...opts(baseEnv({ OMEGA_WEBETAI_FORMULA: 'off' })),
    linePolls: spreadPoll('NBA', away, home, circaOnly),
  });
  assert.strictEqual(circaOff.qualified, true, circaOff.rejectReason || 'off path keeps a circa fair');

  const trace = buildDebugTrace([on, blended, anchor], [blended], opts(baseEnv()));
  assert.strictEqual(trace.formula, true);
  assert.ok(trace.bestBySport.NBA);
  assert.ok(trace.note.includes('EV_rank = EV - 0.01'));
  assert.ok(!/alpha|omega/i.test(JSON.stringify(trace)), 'trace copy');

  const savedSame = process.env.OMEGA_SAME_DAY_ONLY;
  process.env.OMEGA_SAME_DAY_ONLY = 'off';
  delete process.env.OMEGA_WEBETAI_FORMULA;
  const card = await buildCard({
    date: '2026-11-24',
    debugTrace: true,
    pregameAsOfMs: AS_OF,
    history: [],
    gradedBoardRows: [],
    candidates: [
      {
        sport: 'NBA', matchup: 'Celtics @ Heat', pick: 'Celtics ML', market: 'Moneyline',
        odds: '-110', book: 'draftkings', pModel: 0.6, pMkt: 0.55,
        modelProjection: 4.5, projMethod: 'nba-margin', commenceTime: COMMENCE,
      },
      {
        sport: 'NHL', matchup: 'Bruins @ Rangers', pick: 'Bruins ML', market: 'Moneyline',
        odds: '-105', book: 'hardrockbet', pModel: 0.56, pMkt: 0.52,
        modelProjection: 0.4, projMethod: 'nhl-margin', commenceTime: COMMENCE,
      },
      {
        sport: 'NCAAM', matchup: 'Lehigh @ Army', pick: 'Lehigh ML', market: 'Moneyline',
        odds: '+120', book: 'draftkings', pModel: 0.5, pMkt: 0.46,
        modelProjection: 3, projMethod: 'ncaam-standings', commenceTime: COMMENCE,
      },
    ],
  });
  if (savedSame == null) delete process.env.OMEGA_SAME_DAY_ONLY;
  else process.env.OMEGA_SAME_DAY_ONLY = savedSame;
  assert.ok(card.picks.length >= 1 && card.picks.length <= 3, `picks ${card.picks.length}`);
  for (const pick of card.picks) {
    assert.ok(pick.unitsNum <= 0.5 + 1e-9, `${pick.pick} units ${pick.unitsNum}`);
    assert.strictEqual(pick._formulaTrace, undefined);
    assert.ok(!/alpha|omega/i.test(`${pick.pick} ${pick.edgePct || ''}`));
  }
  assert.ok(card.debugTrace && card.debugTrace.bestBySport);
  assert.ok(!/alpha|omega/i.test(card.edgeSummary || ''), card.edgeSummary);
  const traceSports = Object.keys(card.debugTrace.bestBySport);
  assert.ok(traceSports.length >= 1, traceSports.join(','));
  console.log('webetai formula ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
