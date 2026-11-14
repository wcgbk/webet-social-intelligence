'use strict';

/**
 * Force-top3 filler: a straight with negative price EV (pBet × DK/HR decimal − 1)
 * is capped at 0.25u ($38) and marked filler. Grade, price, and positive-EV
 * stakes stay as they were. OMEGA_V2_FILLER=off / 0 / false is today's card.
 * The parlay stake is the same ticket either way. No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { annotateCandidate } = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights, priceEvAtBet } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, toParlay, autoCorrectCard, validateCard } = require('./netlify/functions/lib/omega-v2/guards');
const { letterFromPrintedEdge } = require('./netlify/functions/lib/omega-v2/letter');
const { MODEL_VERSION, fillerEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const { pickPublic } = require('./netlify/functions/lib/public-picks');
const narrate = require('./netlify/functions/lib/omega-vnext/narrate');
const verify = require('./netlify/functions/verify-picks-omega');

const AS_OF = Date.parse('2026-11-03T16:00:00Z');
const COMMENCE = '2026-11-04T00:00:00Z';
const saved = {
  force: process.env.OMEGA_V2_FORCE_TOP3,
  market: process.env.OMEGA_V2_MARKET_P,
  fav: process.env.OMEGA_V2_FAV_CAP,
  adj: process.env.OMEGA_V2_LONGSHOT_ADJ,
  filler: process.env.OMEGA_V2_FILLER,
};

function put(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv() {
  put('OMEGA_V2_FORCE_TOP3', saved.force);
  put('OMEGA_V2_MARKET_P', saved.market);
  put('OMEGA_V2_FAV_CAP', saved.fav);
  put('OMEGA_V2_LONGSHOT_ADJ', saved.adj);
  put('OMEGA_V2_FILLER', saved.filler);
}

function raw(over) {
  return {
    sport: 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: 'Moneyline',
    odds: over.odds,
    book: 'draftkings',
    gameKey: String(over.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    calibration: over.calibration,
  };
}

function annotate(over) {
  return annotateCandidate(raw(over));
}

try {
  process.env.OMEGA_V2_FORCE_TOP3 = '1';
  process.env.OMEGA_V2_MARKET_P = 'off';
  process.env.OMEGA_V2_FAV_CAP = 'off';
  delete process.env.OMEGA_V2_LONGSHOT_ADJ;
  delete process.env.OMEGA_V2_FILLER;

  assert.strictEqual(fillerEnabled(), true);
  assert.strictEqual(fillerEnabled({}), true);
  assert.strictEqual(fillerEnabled({ OMEGA_V2_FILLER: 'on' }), true);
  for (const value of ['off', '0', 'false']) {
    assert.strictEqual(fillerEnabled({ OMEGA_V2_FILLER: value }), false, value);
    process.env.OMEGA_V2_FILLER = value;
    assert.strictEqual(fillerEnabled(), false, value);
  }
  delete process.env.OMEGA_V2_FILLER;
  assert.strictEqual(fillerEnabled(), true);

  const negAnn = annotate({
    matchup: 'Fill Away @ Fill Home',
    pick: 'Fill Side',
    odds: -110,
    calibration: { pCal: 0.40, pMkt: 0.50, pModel: 0.40 },
  });
  const posAnn = annotate({
    matchup: 'Keep Away @ Keep Home',
    pick: 'Keep Side',
    odds: -110,
    calibration: { pCal: 0.55, pMkt: 0.52, pModel: 0.55 },
  });
  assert.ok(negAnn.ev < 0 && priceEvAtBet(negAnn) < 0, `neg ev ${negAnn.ev}`);
  assert.ok(posAnn.ev > 0 && priceEvAtBet(posAnn) > 0, `pos ev ${posAnn.ev}`);
  assert.strictEqual(letterFromPrintedEdge(negAnn.edge), 'b');
  assert.strictEqual(letterFromPrintedEdge(posAnn.edge), 'aminus');

  const negSized = sizeForcedStraights([negAnn])[0];
  const posSized = sizeForcedStraights([posAnn])[0];
  assert.strictEqual(negSized.units, 0.25);
  assert.strictEqual(negSized.stakeUsd, 38);
  assert.strictEqual(negSized.filler, true);
  assert.strictEqual(negSized.fillerReason, 'negative-ev');
  assert.strictEqual(letterFromPrintedEdge(negSized.edge), 'b');
  assert.strictEqual(posSized.units, 1.5);
  assert.strictEqual(posSized.stakeUsd, 225);
  assert.strictEqual(posSized.filler, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(posSized, 'filler'), false);

  process.env.OMEGA_V2_FILLER = 'off';
  const negOffSized = sizeForcedStraights([negAnn])[0];
  const posOffSized = sizeForcedStraights([posAnn])[0];
  assert.strictEqual(negOffSized.units, 0.25);
  assert.strictEqual(negOffSized.stakeUsd, 38);
  assert.strictEqual(negOffSized.filler, undefined);
  assert.strictEqual(letterFromPrintedEdge(negOffSized.edge), letterFromPrintedEdge(negSized.edge));
  assert.strictEqual(posOffSized.units, posSized.units);
  assert.strictEqual(posOffSized.stakeUsd, posSized.stakeUsd);
  assert.strictEqual(posOffSized.filler, undefined);
  delete process.env.OMEGA_V2_FILLER;

  function cardWithInflatedFiller() {
    const neg = toPick(negSized);
    const pos = toPick(posSized);
    const letter = {
      rating: 'a',
      grade: 'a',
      qualityGrade: 'a',
      confidence: 82,
      edgePct: '4.0%',
      winProbability: neg.winProbability,
      odds: neg.odds,
      book: neg.book,
    };
    Object.assign(neg, letter, { units: '0.75u', unitsNum: 0.75, stakeUsd: 113 });
    delete neg.filler;
    delete neg.fillerReason;
    const parlayLegs = toParlay(buildForcedParlay([negSized, posSized]), 2);
    return {
      letter,
      posUnits: pos.unitsNum,
      posStake: pos.stakeUsd,
      card: {
        modelVersion: MODEL_VERSION,
        leakageChecked: true,
        selectionRule: 'force-top3',
        picks: [neg, pos],
        parlayLegs: JSON.parse(JSON.stringify(parlayLegs)),
        parlayPool: [],
      },
    };
  }

  const inflated = cardWithInflatedFiller();
  const onCard = autoCorrectCard(JSON.parse(JSON.stringify(inflated.card)), { pregameAsOfMs: AS_OF });
  const fixed = onCard.picks.find((p) => p.pick === 'Fill Side');
  const kept = onCard.picks.find((p) => p.pick === 'Keep Side');
  assert.ok(fixed && kept);
  assert.strictEqual(fixed.unitsNum, 0.25);
  assert.strictEqual(fixed.units, '0.25u');
  assert.strictEqual(fixed.stakeUsd, 38);
  assert.strictEqual(fixed.filler, true);
  assert.strictEqual(fixed.fillerReason, 'negative-ev');
  assert.strictEqual(fixed.rating, inflated.letter.rating);
  assert.strictEqual(fixed.grade, inflated.letter.grade);
  assert.strictEqual(fixed.qualityGrade, inflated.letter.qualityGrade);
  assert.strictEqual(fixed.edgePct, inflated.letter.edgePct);
  assert.strictEqual(fixed.winProbability, inflated.letter.winProbability);
  assert.strictEqual(fixed.odds, inflated.letter.odds);
  assert.strictEqual(fixed.book, inflated.letter.book);
  assert.strictEqual(kept.unitsNum, inflated.posUnits);
  assert.strictEqual(kept.units, '1.5u');
  assert.strictEqual(kept.stakeUsd, inflated.posStake);
  assert.notStrictEqual(kept.filler, true);
  assert.strictEqual(onCard.parlayLegs.length, 1);
  assert.strictEqual(onCard.parlayLegs[0].legs.length, 2);

  const errors = validateCard(onCard);
  assert.deepStrictEqual(errors, [], errors.join('; '));

  const math = verify.runMathChecks(fixed, { selectionRule: 'force-top3' });
  assert.notStrictEqual(math.severity, 'critical');
  assert.strictEqual(math.checks.kellyMatch, true);
  const mathText = math.errors.concat(math.warnings).join('\n');
  assert.ok(!/sizing|quarter-Kelly|above Kelly/i.test(mathText), mathText);

  process.env.OMEGA_V2_FILLER = 'off';
  const offCard = autoCorrectCard(JSON.parse(JSON.stringify(inflated.card)), { pregameAsOfMs: AS_OF });
  const offFixed = offCard.picks.find((p) => p.pick === 'Fill Side');
  const offKept = offCard.picks.find((p) => p.pick === 'Keep Side');
  assert.strictEqual(offFixed.unitsNum, 0.75);
  assert.strictEqual(offFixed.units, '0.75u');
  assert.strictEqual(offFixed.stakeUsd, 113);
  assert.notStrictEqual(offFixed.filler, true);
  assert.strictEqual(offFixed.rating, inflated.letter.rating);
  assert.strictEqual(offFixed.edgePct, inflated.letter.edgePct);
  assert.strictEqual(offFixed.odds, inflated.letter.odds);
  assert.strictEqual(offKept.unitsNum, inflated.posUnits);
  assert.strictEqual(offKept.stakeUsd, inflated.posStake);
  assert.strictEqual(offCard.parlayLegs.length, 1);
  assert.strictEqual(offCard.parlayLegs[0].units, onCard.parlayLegs[0].units);
  assert.strictEqual(offCard.parlayLegs[0].stakeUsd, onCard.parlayLegs[0].stakeUsd);
  assert.deepStrictEqual(
    offCard.parlayLegs[0].legs.map((leg) => leg.pick),
    onCard.parlayLegs[0].legs.map((leg) => leg.pick),
  );
  delete process.env.OMEGA_V2_FILLER;

  const row = narrate.lockedRow(fixed, 0, 'straight');
  assert.strictEqual(row.filler, true);
  assert.ok(/smaller fill play/i.test(narrate.narratorSystemPrompt()));
  assert.ok(/do not call it a strong play/i.test(narrate.narratorSystemPrompt()));
  const userPrompt = narrate.narratorUserPrompt({
    dateFormatted: 'Tuesday, November 3, 2026',
    lockedStraights: [row],
    lockedLegs: [],
  });
  assert.ok(/"filler": true/.test(userPrompt));
  assert.ok(/smaller fill play/i.test(userPrompt));
  const prose = narrate.buildFallbackNarrative({
    ...fixed,
    coreReasoning: '',
    filler: true,
  });
  assert.ok(/smaller fill play/i.test(prose));
  assert.ok(!/strong play/i.test(prose), prose);
  assert.ok(!/strong disagreement/i.test(prose), prose);
  assert.ok(!/\b(Alpha|Omega)\b/.test(prose));

  const html = fs.readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
  assert.ok(html.includes('title="Added to complete the 3-pick card; lower expected value, minimum stake."'));
  assert.ok(html.includes('>Fill</span>'));
  assert.ok(html.includes('p.filler === true'));

  const pub = pickPublic(fixed);
  assert.strictEqual(pub.filler, true);
  assert.strictEqual(pub.stakeUsd, 38);
  assert.strictEqual(pub.fillerReason, undefined);

  console.log('PASS test-omega-v2-filler');
} finally {
  restoreEnv();
}
