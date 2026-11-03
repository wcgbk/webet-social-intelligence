'use strict';

/**
 * QA rewrites rating, grade, qualityGrade, and confidence from the printed
 * edgePct (A+ ≥5, A ≥3.5, A− ≥2, else B; the printed tenth rounds half up).
 * The B 0.5u cap runs after that rewrite. Math checks repeat until stable,
 * at most 3 passes. Stakes move only when the corrected letter is B and the
 * straight is over 0.5u.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const v2 = require('./netlify/functions/lib/omega-v2');
const verify = require('./netlify/functions/verify-picks-omega');
const { letterFromPrintedEdge, shownEdgePoints } = require('./netlify/functions/lib/omega-v2/letter');

const PREGAME = Date.parse('2020-01-01T00:00:00Z');
const COMMENCE = '2026-10-30T23:00:00Z';
const CONF = { aplus: 90, a: 82, aminus: 75, b: 60 };

function dollars(units) {
  return Math.ceil(units * 150 - 1e-9);
}

const boundaries = [
  ['5.0%', 'aplus'],
  ['4.9%', 'a'],
  ['3.5%', 'a'],
  ['3.4%', 'aminus'],
  ['2.0%', 'aminus'],
  ['1.9%', 'b'],
  ['1.96%', 'aminus'],
  [0.05, 'aplus'],
  [0.04949, 'a'],
  [0.03449, 'aminus'],
  [0.01961, 'aminus'],
  [0.01949, 'b'],
];

for (const [raw, letter] of boundaries) {
  assert.strictEqual(letterFromPrintedEdge(raw), letter, `letter for ${raw}`);
  assert.strictEqual(shownEdgePoints('1.96%'), 2);
  assert.strictEqual(shownEdgePoints('2.0%'), 2);
  assert.strictEqual(shownEdgePoints('5.0%'), 5);
}

function straight(extra) {
  return {
    sport: 'NHL',
    matchup: 'Away @ Home',
    pick: 'Home',
    market: 'Moneyline',
    odds: '+160',
    units: '0.75u',
    unitsNum: 0.75,
    stakeUsd: dollars(0.75),
    stakeDollars: dollars(0.75),
    rating: 'b',
    grade: 'b',
    qualityGrade: 'b',
    confidence: 60,
    evRaw: 0.05,
    edgePct: '4.7%',
    winProbability: '40.4%',
    commenceTime: COMMENCE,
    modelVersion: v2.MODEL_VERSION,
    book: 'draftkings',
    ...extra,
  };
}

// Mislabeled A (printed 4.7%) keeps 0.75u. A true B at 1.9% is capped.
{
  const jets = straight({ pick: 'Winnipeg Jets', matchup: 'Winnipeg Jets @ Montréal Canadiens', edgePct: '4.7%' });
  const bee = straight({
    pick: 'True B',
    matchup: 'True B @ Rival',
    edgePct: '1.9%',
    odds: '-110',
    evRaw: 0.02,
    winProbability: '55%',
  });
  const beforeJets = JSON.parse(JSON.stringify(jets));
  const out = v2.autoCorrectCard({
    modelVersion: v2.MODEL_VERSION,
    leakageChecked: true,
    picks: [jets, bee],
    parlayLegs: [{
      type: '2-leg',
      units: '0.75u',
      unitsNum: 0.75,
      stakeUsd: dollars(0.75),
      modelVersion: v2.MODEL_VERSION,
      combinedOdds: '+450',
      legs: [
        { ...jets, units: '0.75u', unitsNum: 0.75 },
        { ...bee, units: '0.75u', unitsNum: 0.75 },
      ],
    }],
  }, { pregameAsOfMs: PREGAME });

  const j = out.picks.find((p) => p.pick === 'Winnipeg Jets');
  const b = out.picks.find((p) => p.pick === 'True B');
  assert.strictEqual(j.rating, 'a');
  assert.strictEqual(j.grade, 'a');
  assert.strictEqual(j.qualityGrade, 'a');
  assert.strictEqual(j.confidence, CONF.a);
  assert.strictEqual(j.units, '0.75u');
  assert.strictEqual(j.unitsNum, 0.75);
  assert.strictEqual(j.stakeUsd, 113);
  assert.strictEqual(j.stakeDollars, 113);
  assert.strictEqual(j.odds, beforeJets.odds);
  assert.strictEqual(j.book, 'draftkings');
  assert.ok(!out.qaNotes.some((note) => /b-grade cap/.test(note) && /Jets/.test(note)));

  assert.strictEqual(b.rating, 'b');
  assert.strictEqual(b.confidence, CONF.b);
  assert.strictEqual(b.units, '0.5u');
  assert.strictEqual(b.unitsNum, 0.5);
  assert.strictEqual(b.stakeUsd, 75);
  assert.strictEqual(b.stakeDollars, 75);
  assert.ok(out.qaNotes.includes('b-grade cap True B'));

  const ticket = out.parlayLegs[0];
  assert.strictEqual(ticket.units, '0.75u');
  assert.strictEqual(ticket.stakeUsd, dollars(0.75));
  const jLeg = ticket.legs.find((leg) => leg.pick === 'Winnipeg Jets');
  const bLeg = ticket.legs.find((leg) => leg.pick === 'True B');
  assert.strictEqual(jLeg.rating, 'a');
  assert.strictEqual(jLeg.confidence, CONF.a);
  assert.strictEqual(jLeg.units, '0.75u');
  assert.strictEqual(bLeg.rating, 'b');
  assert.strictEqual(bLeg.units, '0.75u', 'parlay leg stake is not the straight B cap');
}

// Verify QA: same rewrite, math recheck stops by pass 2, stakes hold except a real B.
{
  const card = {
    picks: [
      straight({ pick: 'Winnipeg Jets', matchup: 'Winnipeg Jets @ Montréal Canadiens', edgePct: '4.7%' }),
      straight({
        pick: 'Calgary Flames +2.5',
        matchup: 'Calgary Flames @ Colorado Avalanche',
        edgePct: '2.8%',
        units: '0.75u',
        unitsNum: 0.75,
        odds: '-120',
        book: 'hardrockbet',
      }),
      straight({
        pick: 'Over 54.5',
        matchup: 'Baltimore Ravens @ Buffalo Bills',
        edgePct: '1.9%',
        units: '0.25u',
        unitsNum: 0.25,
        stakeUsd: dollars(0.25),
        stakeDollars: dollars(0.25),
        odds: '-110',
        book: 'draftkings',
      }),
      straight({
        pick: 'Fat B',
        matchup: 'Fat B @ Rival',
        edgePct: '1.5%',
        rating: 'aplus',
        grade: 'aplus',
        qualityGrade: 'aplus',
        confidence: 90,
        units: '1.25u',
        unitsNum: 1.25,
        stakeUsd: dollars(1.25),
        stakeDollars: dollars(1.25),
        odds: '+150',
        book: 'draftkings',
      }),
    ],
    parlayLegs: [{
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: dollars(0.25),
      legs: [
        straight({ pick: 'Winnipeg Jets', edgePct: '4.7%', units: '0.25u', unitsNum: 0.25, stakeUsd: dollars(0.25), stakeDollars: dollars(0.25) }),
      ],
    }],
    summary: { totalPicks: 4, totalStraightBets: 4, totalUnits: '3.0u', aplusLocks: 1 },
  };
  const qa = verify.autoCorrectCard(card);
  assert.ok(qa.passes >= 1 && qa.passes <= 3, `passes ${qa.passes}`);
  assert.strictEqual(qa.passes, 2, 'one correcting pass, then a stable recheck');
  assert.strictEqual(qa.stable, true);
  assert.strictEqual(qa.stakeChanged, true);
  assert.ok(qa.reports.every((r) => r.checks.gradeMatch), 'math grade check agrees after the rewrite');

  const jets = card.picks.find((p) => p.pick === 'Winnipeg Jets');
  const flames = card.picks.find((p) => p.pick === 'Calgary Flames +2.5');
  const over = card.picks.find((p) => p.pick === 'Over 54.5');
  const fat = card.picks.find((p) => p.pick === 'Fat B');
  assert.strictEqual(jets.rating, 'a');
  assert.strictEqual(jets.grade, 'a');
  assert.strictEqual(jets.qualityGrade, 'a');
  assert.strictEqual(jets.confidence, 82);
  assert.strictEqual(jets.units, '0.75u');
  assert.strictEqual(jets.stakeUsd, 113);
  assert.strictEqual(flames.rating, 'aminus');
  assert.strictEqual(flames.confidence, 75);
  assert.strictEqual(flames.units, '0.75u');
  assert.strictEqual(flames.stakeUsd, 113);
  assert.strictEqual(over.rating, 'b');
  assert.strictEqual(over.confidence, 60);
  assert.strictEqual(over.units, '0.25u');
  assert.strictEqual(over.stakeUsd, 38);
  assert.strictEqual(fat.rating, 'b');
  assert.strictEqual(fat.grade, 'b');
  assert.strictEqual(fat.qualityGrade, 'b');
  assert.strictEqual(fat.confidence, 60);
  assert.strictEqual(fat.units, '0.5u');
  assert.strictEqual(fat.unitsNum, 0.5);
  assert.strictEqual(fat.stakeUsd, 75);
  assert.strictEqual(fat.stakeDollars, 75);
  assert.strictEqual(card.parlayLegs[0].units, '0.25u');
  assert.strictEqual(card.parlayLegs[0].legs[0].rating, 'a');
  assert.strictEqual(card.parlayLegs[0].legs[0].units, '0.25u');

  const again = verify.autoCorrectCard(card);
  assert.strictEqual(again.passes, 1);
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.stable, true);
  assert.strictEqual(fat.units, '0.5u');
}

// autoFix drops a negative-EV straight and still rewrites the letter. It does not cap the A.
{
  const jets = straight({
    pick: 'Winnipeg Jets',
    matchup: 'Winnipeg Jets @ Montréal Canadiens',
    edgePct: '4.7%',
    coreReasoning: 'WeBetAI sees a gap between its win probability and this price. The market is leaning the other way.',
    whatLoses: 'Montréal scores first and holds the lead through the third.',
  });
  const bad = straight({
    pick: 'Bad EV',
    matchup: 'Bad EV @ Rival',
    odds: '-110',
    units: '1u',
    unitsNum: 1,
    edgePct: '3.0%',
    rating: 'b',
    winProbability: '40%',
    coreReasoning: 'Short.',
    whatLoses: '',
  });
  const card = { picks: [jets, bad], parlayLegs: [], summary: { aplusLocks: 0, totalUnits: '1.8u' } };
  const reports = card.picks.map((p) => {
    const math = verify.runMathChecks(p);
    return { mathSeverity: math.severity, errors: math.errors, warnings: math.warnings, pick: `${p.pick} ${p.odds}` };
  });
  assert.strictEqual(reports[0].mathSeverity, 'warning');
  assert.strictEqual(reports[1].mathSeverity, 'critical');
  verify.autoFixPicks(card, reports).then((fix) => {
    assert.strictEqual(fix.replacements.length, 1);
    assert.strictEqual(fix.replacements[0].removed, 'Bad EV');
    assert.strictEqual(fix.qa.stable, true);
    assert.ok(fix.qa.passes <= 3);
    assert.strictEqual(card.picks.length, 1);
    assert.strictEqual(card.picks[0].pick, 'Winnipeg Jets');
    assert.strictEqual(card.picks[0].rating, 'a');
    assert.strictEqual(card.picks[0].confidence, 82);
    assert.strictEqual(card.picks[0].units, '0.75u');
    assert.strictEqual(card.picks[0].stakeUsd, 113);
    runFixtures();
    console.log('PASS test-omega-v2-qa-letter');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function runFixtures() {
  const dir = path.join(__dirname, 'test/fixtures/omega-v2-cards');
  const dates = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
  for (const date of dates) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `card-${date}.json`), 'utf8'));
    const before = JSON.parse(JSON.stringify(raw));
    const out = v2.autoCorrectCard(JSON.parse(JSON.stringify(raw)), { pregameAsOfMs: PREGAME });
    assert.strictEqual(out.picks.length, before.picks.length, `${date} pick count`);
    before.picks.forEach((published, i) => {
      const next = out.picks.find((p) => p.pick === published.pick && p.matchup === published.matchup);
      assert.ok(next, `${date} missing ${published.pick}`);
      const want = letterFromPrintedEdge(published.edgePct);
      assert.strictEqual(next.units, published.units, `${date} ${published.pick} units`);
      assert.strictEqual(next.book, published.book, `${date} ${published.pick} book`);
      assert.strictEqual(next.odds, published.odds, `${date} ${published.pick} odds`);
      assert.strictEqual(next.rating, want, `${date} ${published.pick} letter`);
      assert.strictEqual(next.grade, want);
      assert.strictEqual(next.qualityGrade, want);
      assert.strictEqual(next.confidence, CONF[want]);
      const u = parseFloat(String(next.units).replace(/[^0-9.]/g, ''));
      assert.strictEqual(next.stakeUsd, dollars(u), `${date} ${published.pick} stakeUsd`);
      if (want === 'b') assert.ok(u <= 0.5 + 1e-9, `${date} ${published.pick} B cap`);
      assert.strictEqual(out.picks[i].pick, published.pick, `${date} order`);
    });
    assert.strictEqual(out.parlayLegs.length, before.parlayLegs.length, `${date} parlay count`);
    before.parlayLegs.forEach((ticket, i) => {
      const next = out.parlayLegs[i];
      assert.strictEqual(next.units, ticket.units, `${date} parlay units`);
      assert.strictEqual(next.combinedOdds, ticket.combinedOdds, `${date} parlay odds`);
      const u = parseFloat(String(next.units).replace(/[^0-9.]/g, ''));
      assert.strictEqual(next.stakeUsd, dollars(u), `${date} parlay stakeUsd`);
      (ticket.legs || []).forEach((leg) => {
        const got = (next.legs || []).find((row) => row.pick === leg.pick && row.matchup === leg.matchup);
        assert.ok(got, `${date} missing leg ${leg.pick}`);
        assert.strictEqual(got.units, leg.units, `${date} leg ${leg.pick} units`);
        assert.strictEqual(got.odds, leg.odds);
        if (leg.edgePct != null && leg.edgePct !== '') {
          const want = letterFromPrintedEdge(leg.edgePct);
          assert.strictEqual(got.rating, want, `${date} leg ${leg.pick} letter`);
          assert.strictEqual(got.confidence, CONF[want]);
        }
      });
    });

    const qaCard = JSON.parse(JSON.stringify(raw));
    const qa = verify.autoCorrectCard(qaCard);
    assert.strictEqual(qa.stable, true, `${date} verify stable`);
    assert.ok(qa.passes <= 3);
    assert.strictEqual(qa.stakeChanged, false, `${date} verify must not resize a legal stake`);
    raw.picks.forEach((published) => {
      const next = qaCard.picks.find((p) => p.pick === published.pick);
      assert.strictEqual(next.units, published.units, `${date} verify units ${published.pick}`);
      assert.strictEqual(next.rating, letterFromPrintedEdge(published.edgePct));
      assert.strictEqual(next.confidence, CONF[letterFromPrintedEdge(published.edgePct)]);
    });
  }
}
