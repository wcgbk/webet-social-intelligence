'use strict';

/**
 * Math gate checks the results blob and public picks, not only the card fixture.
 * Letter, stake, and B-cap mismatches block on or after that rule's effective
 * date. Earlier dates report and do not fail the process.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gate = require('./tools/omega-v2/math-gate');

const FIXTURES = path.join(__dirname, 'test/fixtures/omega-v2-cards');
const CARD_1103 = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'card-2026-11-03.json'), 'utf8'));

function stakeOf(units) {
  const u = parseFloat(String(units).replace(/[^0-9.]/g, ''));
  return Math.ceil(u * 150 - 1e-9);
}

function resultsFromCard(card, date) {
  const picks = card.picks.map((p) => ({
    sport: p.sport,
    matchup: p.matchup,
    pick: p.pick,
    odds: p.odds,
    units: p.units,
    rating: p.rating,
    stakeDollars: stakeOf(p.units),
  }));
  const ticket = (card.parlayLegs || [])[0];
  if (ticket) {
    picks.push({
      sport: 'PARLAY',
      pick: '3-Team Parlay (Optimized)',
      odds: ticket.combinedOdds,
      units: ticket.units,
      rating: 'P',
      edgePct: '99.0%',
      stakeDollars: stakeOf(ticket.units),
    });
  }
  return { date, picks };
}

function blocking(fails, rule) {
  return fails.filter((f) => f.blocking && (!rule || f.rule === rule));
}

// Hand-aligned 11/03 fixture does not block. The same stakes with the results
// blob's old letters do, including the B cap on Jets at 0.75u.
{
  const cardFails = gate.checkCard(CARD_1103, '2026-11-03');
  assert.strictEqual(blocking(cardFails).length, 0, 'hand-aligned fixture must not block');
  const aligned = resultsFromCard(CARD_1103, '2026-11-03');
  const alignedFails = gate.checkPublished(aligned, '2026-11-03', CARD_1103, { file: 'res-aligned.json' });
  assert.strictEqual(alignedFails.length, 0, `aligned results ${alignedFails.map((f) => f.msg).join('; ')}`);

  const live = resultsFromCard(CARD_1103, '2026-11-03');
  const oilers = live.picks.find((p) => p.pick === 'Edmonton Oilers');
  const preds = live.picks.find((p) => p.pick === 'Nashville Predators');
  const jets = live.picks.find((p) => p.pick === 'Winnipeg Jets');
  oilers.rating = 'aminus';
  preds.rating = 'A-';
  jets.rating = 'b';
  const fails = gate.checkPublished(live, '2026-11-03', CARD_1103, { file: 'res-2026-11-03.json' });
  assert.ok(blocking(fails, 'letter').some((f) => /Edmonton Oilers/.test(f.msg) && /want aplus/.test(f.msg)));
  assert.ok(blocking(fails, 'letter').some((f) => /Nashville Predators/.test(f.msg) && /want aplus/.test(f.msg)));
  assert.ok(blocking(fails, 'letter').some((f) => /Winnipeg Jets/.test(f.msg) && /want a/.test(f.msg)));
  assert.ok(blocking(fails, 'bcap').some((f) => /Winnipeg Jets/.test(f.msg) && /0\.75u/.test(f.msg)));
  assert.strictEqual(blocking(fails, 'dollars').length, 0, 'published dollar stakes match');
  assert.ok(!fails.some((f) => /Parlay/.test(f.msg) && f.rule === 'letter'), 'parlay rating P is not a letter');

  const early = gate.checkPublished(live, '2026-11-02', CARD_1103, { file: 'res-2026-11-02.json' });
  assert.ok(early.length >= 4, 'pre-rule results still report');
  assert.strictEqual(blocking(early).length, 0, 'pre-rule letter and cap do not block');
  assert.ok(early.every((f) => f.blocking === false));
}

// Stake dollars use the dollars effective date. Unit drift vs the card blocks
// from the first v2 day. A true B at 0.5u is inside the cap.
{
  const card = {
    picks: [{ pick: 'ZZ Stake', matchup: 'A @ B', units: '0.5u', unitsNum: 0.5, edgePct: '1.5%', rating: 'b' }],
  };
  const row = {
    pick: 'ZZ Stake',
    matchup: 'A @ B',
    units: '0.5u',
    rating: 'b',
    edgePct: '1.5%',
    grade: 'b',
    qualityGrade: 'b',
    confidence: 60,
    stakeDollars: 100,
    stakeUsd: 100,
  };
  const on = gate.checkPublished({ date: '2026-11-04', picks: [row] }, '2026-11-04', card, { file: 'stake.json' });
  assert.ok(blocking(on, 'dollars').length >= 1);
  const before = gate.checkPublished({ date: '2026-11-03', picks: [{ ...row }] }, '2026-11-03', card, { file: 'stake.json' });
  assert.ok(before.some((f) => f.rule === 'dollars'));
  assert.strictEqual(blocking(before, 'dollars').length, 0);
  assert.strictEqual(blocking(before, 'bcap').length, 0, '0.5u B is the cap, not over it');

  const drifted = {
    pick: 'ZZ Stake',
    matchup: 'A @ B',
    units: '1u',
    rating: 'b',
    edgePct: '1.5%',
    stakeDollars: 150,
  };
  const units = gate.checkPublished({ picks: [drifted] }, '2026-10-31', card, { file: 'units.json' });
  assert.ok(blocking(units, 'units').some((f) => /vs card/.test(f.msg)));
  assert.ok(units.some((f) => f.rule === 'bcap' && f.blocking === false));
}

// Public trim: a stale grade blocks with the letter rule. Confidence follows
// the stored letter. The picks-{date} name and a results cache both load.
{
  const pub = {
    date: '2026-11-03',
    picks: [{
      pick: 'Edmonton Oilers',
      matchup: 'Edmonton Oilers @ New Jersey Devils',
      units: '1.25u',
      rating: 'aplus',
      grade: 'aminus',
      qualityGrade: 'aplus',
      confidence: 90,
      edgePct: '5.4%',
      stakeUsd: 188,
    }],
    parlayLegs: [{
      units: '0.25u',
      stakeUsd: 38,
      legs: [{
        pick: 'Edmonton Oilers',
        matchup: 'Edmonton Oilers @ New Jersey Devils',
        units: '0.25u',
        rating: 'aplus',
        edgePct: '5.4%',
        confidence: 90,
      }],
    }],
  };
  const fails = gate.checkPublished(pub, '2026-11-03', null, { file: 'public-2026-11-03.json' });
  assert.ok(blocking(fails, 'letter').some((f) => /grade aminus/.test(f.msg)));
  assert.strictEqual(blocking(fails, 'bcap').length, 0, 'parlay leg is not the B cap');
  assert.strictEqual(fails.filter((f) => f.rule === 'confidence').length, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-v2-results-'));
  try {
    fs.writeFileSync(path.join(tmp, 'card-2026-11-03.json'), `${JSON.stringify(pub)}\n`);
    fs.writeFileSync(path.join(tmp, 'picks-2026-11-03'), `${JSON.stringify(pub)}\n`);
    fs.writeFileSync(path.join(tmp, 'res-2026-11-03.json'), JSON.stringify({
      days: [
        { date: '2026-10-01', picks: [{ pick: 'Old', units: '1u', rating: 'b', stakeDollars: 1 }] },
        {
          date: '2026-11-03',
          picks: [{
            pick: 'ZZ Cache',
            units: '0.75u',
            rating: 'b',
            edgePct: '4.7%',
            stakeDollars: 113,
          }],
        },
      ],
    }));
    fs.writeFileSync(path.join(tmp, 'res-copy.json'), fs.readFileSync(path.join(tmp, 'res-2026-11-03.json')));
    fs.writeFileSync(path.join(tmp, 'not-a-blob.txt'), '{}');
    fs.writeFileSync(path.join(tmp, 'results-omega-cache-v9-kpi1030'), fs.readFileSync(path.join(tmp, 'res-2026-11-03.json')));
    const skipped = gate.loadPublished([tmp], { fixtureRoot: tmp });
    assert.ok(skipped.errors.length === 0);
    assert.ok(!skipped.items.some((item) => path.basename(item.file).startsWith('card-')), 'fixture root skips hand-aligned cards');
    assert.ok(skipped.items.some((item) => path.basename(item.file) === 'picks-2026-11-03' && item.kind === 'public'));
    const cacheHits = skipped.items.filter((item) => item.date === '2026-11-03' && /ZZ Cache|Edmonton/.test(JSON.stringify(item.doc.picks)));
    assert.ok(cacheHits.length >= 1);
    assert.ok(!skipped.items.some((item) => item.date === '2026-10-01'), 'pre-v2 results days stay out of the window');
    const dupes = skipped.items.filter((item) => (item.doc.picks || []).some((p) => p.pick === 'ZZ Cache'));
    assert.strictEqual(dupes.length, 1, 'identical results days from two files count once');

    const kept = gate.loadPublished([tmp], { fixtureRoot: path.join(tmp, 'missing') });
    assert.ok(kept.items.some((item) => path.basename(item.file).startsWith('card-')));

    fs.writeFileSync(path.join(tmp, 'res-2026-11-04.json'), '{');
    const bad = gate.loadPublished([tmp], { fixtureRoot: tmp });
    assert.ok(bad.errors.some((err) => /res-2026-11-04/.test(err.file)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  assert.strictEqual(gate.normLetter('A+'), 'aplus');
  assert.strictEqual(gate.normLetter('A-'), 'aminus');
  assert.strictEqual(gate.normLetter('A−'), 'aminus');
  assert.strictEqual(gate.normLetter('b'), 'b');
  const dates = [];
  const start = new Date('2026-10-31T12:00:00Z');
  for (let i = 0; i < 31; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }
  const windowed = gate.windowDates(dates.concat(['2026-10-30', 'nope']));
  assert.strictEqual(windowed.length, 30);
  assert.ok(!windowed.includes('2026-10-30'));
  assert.ok(!windowed.includes('2026-10-31'));
  assert.strictEqual(windowed[0], '2026-11-01');
}

function runGate(resultsFile) {
  return spawnSync(process.execPath, [path.join(__dirname, 'tools/omega-v2/math-gate.js')], {
    cwd: __dirname,
    env: { ...process.env, OMEGA_V2_RESULTS: resultsFile },
    encoding: 'utf8',
  });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-v2-gate-'));
  try {
    const earlyFile = path.join(tmp, 'early.json');
    const lateFile = path.join(tmp, 'late.json');
    fs.writeFileSync(earlyFile, JSON.stringify({
      date: '2026-11-02',
      picks: [{ pick: 'ZZ Gate Dog', units: '0.75u', rating: 'b', edgePct: '2.8%', stakeDollars: 113 }],
    }));
    fs.writeFileSync(lateFile, JSON.stringify({
      date: '2026-11-03',
      picks: [{ pick: 'ZZ Block Dog', units: '0.75u', rating: 'b', edgePct: '4.7%', stakeDollars: 113 }],
    }));
    const early = runGate(earlyFile);
    assert.strictEqual(early.status, 0, early.stdout + early.stderr);
    assert.ok(/REPORT \[letter\].*ZZ Gate Dog/.test(early.stdout), early.stdout);
    assert.ok(!/BLOCK \[letter\].*ZZ Gate Dog/.test(early.stdout), early.stdout);
    assert.ok(/PASS omega-v2 math gate/.test(early.stdout));

    const late = runGate(lateFile);
    assert.strictEqual(late.status, 1, late.stdout + late.stderr);
    assert.ok(/BLOCK \[letter\].*ZZ Block Dog/.test(late.stdout), late.stdout);
    assert.ok(/BLOCK \[bcap\].*ZZ Block Dog/.test(late.stdout), late.stdout);
    assert.ok(/FAIL omega-v2 math gate/.test(late.stdout));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tipico = {
    picks: [],
    parlayLegs: [{
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: 38,
      combinedDecimal: 3.8095,
      legs: [
        { pick: 'Arizona Cardinals +6.5', matchup: 'Arizona Cardinals @ Dallas Cowboys', book: 'tipico_de', odds: '+100', pCal: 0.55 },
        { pick: 'Pittsburgh Steelers -3.5', matchup: 'Cleveland Browns @ Pittsburgh Steelers', book: 'hardrockbet', odds: '-105', pCal: 0.55 },
      ],
    }],
  };
  const earlyBook = gate.checkCard(tipico, '2026-11-01').filter((f) => f.rule === 'parlayBook');
  assert.strictEqual(earlyBook.length, 1);
  assert.strictEqual(earlyBook[0].blocking, false, '11/01 tipico is a report, not a block');
  assert.ok(/tipico_de/.test(earlyBook[0].msg));
  const lateBook = gate.checkCard(tipico, '2026-11-03').filter((f) => f.rule === 'parlayBook');
  assert.ok(lateBook.some((f) => f.blocking), 'tipico blocks on and after 2026-11-03');
  const alias = gate.checkCard({
    picks: [],
    parlayLegs: [{
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: 38,
      combinedDecimal: 4,
      legs: [
        { pick: 'A', matchup: 'A @ B', book: 'hardrock', odds: '+100', pCal: 0.6 },
        { pick: 'C', matchup: 'C @ D', odds: '+100', pCal: 0.6 },
      ],
    }],
  }, '2026-11-03');
  assert.ok(!alias.some((f) => f.rule === 'parlayBook'), 'hardrock alias and a missing book are placeable / not a book fail');

  const floored = gate.checkCard({
    picks: [],
    parlayLegs: [{
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: 38,
      combinedDecimal: 4,
      legs: [
        { pick: 'Dust 0 ML', matchup: 'Dust 0 Away @ Dust 0 Home', book: 'draftkings', odds: '+100', pCal: 0.502 },
        { pick: 'Dust 1 ML', matchup: 'Dust 1 Away @ Dust 1 Home', book: 'draftkings', odds: '+100', pCal: 0.502 },
      ],
    }],
  }, '2026-10-31');
  assert.ok(floored.some((f) => f.rule === 'parlay' && f.blocking && /floors sub-0\.25u/.test(f.msg)));
}

console.log('PASS test-omega-v2-results-gate');
