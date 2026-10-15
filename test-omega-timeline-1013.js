'use strict';

/**
 * v12.3.73 timeline. 10:00 stays a draft. 10:15 re-ranks the top 10.
 * 10:30 drafts and checks Hard Rock at the displayed best US price.
 * 10:45 writes summaries. 11:00 is the only finalization.
 * No Odds API calls.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const ingest = require(path.join(root, 'ingest'));
const lines = require(path.join(root, 'pinnacle_line_move'));
const { applyExecutionBook, priceAtDraftKings, reviewHardRock } = require(path.join(root, 'selection_pass'));
const { rerankCard } = require(path.join(root, 'rerank'));
const { draftAndCheckHardRock, writeSummaries, finalizeCard, CONTEXT_INPUTS } = require(path.join(root, 'timeline'));
const { adjustCandidate } = require(path.join(root, 'line_move_prob'));
const et = require('./netlify/functions/lib/et-schedule');
const narrate = require('./netlify/functions/narrate-card-omega');
const post = require('./netlify/functions/post-card-omega');
const { americanToDecimal } = require(path.join(root, 'odds_math'));

function close(actual, expected, eps = 1e-4) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

function row(name, edge, extra) {
  return Object.assign({
    sport: 'NHL',
    matchup: `${name} Away @ ${name} Home`,
    awayTeam: `${name} Away`,
    homeTeam: `${name} Home`,
    pick: `${name} Home ML`,
    side: `${name} Home ML`,
    market: 'Moneyline',
    betType: 'Moneyline',
    odds: -110,
    edgePct: edge,
    ev: 0.04,
    evRaw: 0.04,
    coverProb: 0.58,
    p_cal: 0.58,
    fair_sharp_p: 0.52,
    tier: 'floor',
    book: 'draftkings',
    priceBook: 'draftkings',
  }, extra || {});
}

function priced(books, extra) {
  return Object.assign({
    sport: 'NHL',
    market: 'Moneyline',
    side: 'Home ML',
    matchup: 'Away @ Home',
    awayTeam: 'Away',
    homeTeam: 'Home',
    coverProb: 0.58,
    fair_sharp_p: 0.52,
    edgePct: 0.06,
    bookPrices: books,
  }, extra || {});
}

function scheduler() {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

(async () => {
  assert.ok(String(config.MODEL_VERSION).startsWith('v12.4.0'));
  assert.ok(String(config.MODEL_NOTES).startsWith('v12.4.0-webetai-pure:'));
  assert.ok(String(config.MODEL_NOTES).includes('v12.3.72-omega-vnext-price-lock:'));
  assert.strictEqual(config.PINNACLE_LINE_MOVE.checkBookmakers, 'pinnacle,draftkings,hardrockbet');
  assert.strictEqual(config.PINNACLE_LINE_MOVE.bookmakers, 'pinnacle');
  assert.ok(config.CHECK_BOOKS == null);
  assert.deepStrictEqual(lines.CHECK_BOOKS, ['pinnacle', 'draftkings', 'hardrockbet']);

  const url = ingest.buildOddsUrl('icehockey_nhl', 'test-key', null);
  const books = new URL(url).searchParams.get('bookmakers');
  assert.strictEqual((url.match(/bookmakers=/g) || []).length, 1);
  assert.ok(books.includes('hardrockbet'));
  assert.strictEqual((books.match(/hardrockbet/g) || []).length, 1);

  const hrBetter = applyExecutionBook([priced([
    { book: 'draftkings', american: -110 },
    { book: 'hardrockbet', american: -105 },
    { book: 'pinnacle', american: 150 },
  ])]);
  assert.strictEqual(hrBetter.excluded.length, 0);
  assert.strictEqual(hrBetter.candidates[0].book, 'hardrockbet');
  assert.strictEqual(hrBetter.candidates[0].priceBook, 'hardrockbet');
  assert.strictEqual(hrBetter.candidates[0].executionBook, 'draftkings');
  assert.strictEqual(hrBetter.candidates[0].odds, -105);
  assert.strictEqual(hrBetter.candidates[0].evBasis, 'stake-ev-at-best-us-price');
  close(hrBetter.candidates[0].ev, 0.58 * americanToDecimal(-105) - 1, 1e-3);

  const tie = applyExecutionBook([priced([
    { book: 'draftkings', american: -110 },
    { book: 'hardrockbet', american: -110 },
    { book: 'pinnacle', american: 100 },
  ])]);
  assert.strictEqual(tie.candidates[0].book, 'draftkings');
  assert.strictEqual(tie.candidates[0].executionBook, 'draftkings');
  assert.strictEqual(tie.candidates[0].odds, -110);

  const mismatch = applyExecutionBook([priced([
    { book: 'draftkings', american: -110, point: -1.5 },
    { book: 'hardrockbet', american: -105, point: -2.5 },
  ])]);
  assert.strictEqual(mismatch.candidates[0].book, 'draftkings');
  assert.strictEqual(mismatch.candidates[0].odds, -110);
  assert.strictEqual(mismatch.candidates[0].line, -1.5);

  const noDk = applyExecutionBook([priced([
    { book: 'hardrockbet', american: -105 },
    { book: 'pinnacle', american: -120 },
  ])]);
  assert.strictEqual(noDk.candidates.length, 1);
  assert.strictEqual(noDk.candidates[0].book, 'hardrockbet');
  assert.strictEqual(noDk.candidates[0].executionBook, 'hardrockbet');
  assert.strictEqual(noDk.candidates[0].odds, -105);
  assert.strictEqual(noDk.excluded.length, 0);

  const dkOnly = priceAtDraftKings(priced([{ book: 'draftkings', american: -115, point: -1.5 }]));
  assert.strictEqual(dkOnly.book, 'draftkings');
  assert.strictEqual(dkOnly.odds, -115);

  const top = [row('A', 0.02), row('B', 0.08), row('C', 0.05), row('D', 0.01)];
  const ranked = await rerankCard({
    card: {
      date: '2026-10-13',
      timelineStep: '10:00',
      cardStatus: 'draft',
      finalized: false,
      picks: top.map((item) => ({ ...item })),
      selection: { stage: 'top10', top10: top.map((item) => ({ ...item })) },
    },
    now: new Date('2026-10-13T14:15:00Z'),
    runNews: async () => ({ dropped: 0 }),
  });
  assert.strictEqual(ranked.oddsApi, false);
  assert.strictEqual(ranked.card.timelineStep, '10:15');
  assert.strictEqual(ranked.card.cardStatus, 'draft');
  assert.strictEqual(ranked.card.finalized, false);
  assert.strictEqual(ranked.card.picks.length, 4);
  assert.strictEqual(ranked.card.selection.stage, 'reranked');
  assert.deepStrictEqual(ranked.card.selection.contextInputs, CONTEXT_INPUTS);
  assert.strictEqual(ranked.card.selection.top10[0].side, 'B Home ML');
  assert.strictEqual(ranked.card.selection.top10[0].selected, true);
  assert.strictEqual(ranked.card.selection.top10[2].selected, true);
  assert.strictEqual(ranked.card.selection.top10[3].selected, false);
  assert.strictEqual(ranked.card.picks[0].odds, -110);

  const passPicks = ['A', 'B', 'C'].map((name) => row(name, 0.06, {
    odds: -105,
    // 0.58 at -105 is 13.2% stake EV and cannot be a parlay leg.
    coverProb: 0.55,
    p_cal: 0.55,
    book: 'hardrockbet',
    priceBook: 'hardrockbet',
    hardRock: { american: -105, point: null },
  }));
  const staleParlay = {
    qualifying: true,
    evRaw: 0.12,
    ev: '12.0%',
    legs: passPicks.map((pick) => ({
      ...pick,
      odds: -110,
      book: 'draftkings',
      priceBook: 'draftkings',
      hardRock: null,
    })),
  };
  const passed = draftAndCheckHardRock({
    date: '2026-10-13',
    timelineStep: '10:15',
    picks: passPicks,
    parlayLegs: [staleParlay],
    selection: { stage: 'reranked', top10: passPicks.map((pick) => ({ ...pick, selected: true })) },
  });
  assert.strictEqual(passed.oddsApi, false);
  assert.strictEqual(passed.verdict, 'PASS');
  assert.strictEqual(passed.card.hardRockCheck.blocksPublish, false);
  assert.strictEqual(passed.card.hardRockCheck.repriced, true);
  assert.strictEqual(passed.card.hardRockCheck.source, 'saved-10:00');
  assert.strictEqual(passed.card.picks.length, 3);
  assert.ok(passed.card.parlayLegs[0].legs.every((leg) => String(leg.odds).includes('105')));
  assert.strictEqual(passed.card.timelineStep, '10:30');
  assert.strictEqual(passed.card.finalized, false);

  const bad = ['D', 'E', 'F'].map((name) => row(name, 0.04, {
    odds: 150,
    book: 'draftkings',
    hardRock: { american: -500, point: null },
  }));
  const keptTicket = {
    qualifying: true,
    evRaw: 0.2,
    ev: '20.0%',
    legs: bad.map((pick) => ({ ...pick, hardRock: null })),
  };
  const failed = draftAndCheckHardRock({
    date: '2026-10-13',
    picks: bad.map((pick) => ({ ...pick })),
    parlayLegs: [JSON.parse(JSON.stringify(keptTicket))],
  });
  assert.strictEqual(failed.verdict, 'FAIL');
  assert.strictEqual(failed.card.hardRockCheck.blocksPublish, false);
  assert.strictEqual(failed.card.hardRockCheck.repriced, false);
  assert.strictEqual(failed.card.picks.length, 3);
  assert.strictEqual(failed.card.parlayLegs[0].legs[0].odds, 150);
  assert.ok(failed.card.picks.every((pick) => pick.hrPlaceable === false));

  const empty = draftAndCheckHardRock({ date: '2026-10-13', picks: [], parlayLegs: [] });
  assert.strictEqual(empty.verdict, 'FAIL');
  assert.strictEqual(empty.card.hardRockCheck.blocksPublish, false);
  assert.strictEqual(empty.card.picks.length, 0);

  const flagged = reviewHardRock({
    picks: [row('G', 0.04, { odds: '-110', line: -2.5, book: 'draftkings' })],
    parlayLegs: [],
  }, {});
  assert.strictEqual(flagged.changed, false);
  assert.strictEqual(flagged.verdict, 'FAIL');

  const summarized = writeSummaries({
    date: '2026-10-13',
    cardStatus: 'draft',
    picks: [row('H', 0.04)],
  });
  assert.strictEqual(summarized.oddsApi, false);
  assert.strictEqual(summarized.card.timelineStep, '10:45');
  assert.strictEqual(summarized.card.finalized, false);
  assert.strictEqual(summarized.card.cardStatus, 'draft');
  assert.strictEqual(summarized.card.writtenContext.source, 'offline-template');
  assert.ok(summarized.card.picks[0].coreReasoning);
  assert.ok(summarized.card.edgeSummary);

  const narrated = await narrate.runNarrate({
    env: {},
    now: new Date('2026-10-13T14:45:00Z'),
    card: { date: '2026-10-13', picks: [row('I', 0.04)], cardStatus: 'draft' },
  });
  assert.strictEqual(narrated.wrote, false);
  assert.strictEqual(narrated.oddsApi, false);
  assert.strictEqual(narrated.card.finalized, false);
  assert.strictEqual(narrated.card.timelineStep, '10:45');
  const unread = await narrate.runNarrate({
    env: {},
    now: new Date('2026-10-13T14:45:00Z'),
  });
  assert.strictEqual(unread.reason, 'no-card');
  assert.strictEqual(unread.wrote, false);

  const final = finalizeCard({ date: '2026-10-13', picks: [row('J', 0.04)], cardStatus: 'draft', finalized: false }, new Date('2026-10-13T15:00:00Z'));
  assert.strictEqual(final.card.cardStatus, 'final');
  assert.strictEqual(final.card.finalized, true);
  assert.strictEqual(final.card.timelineStep, '11:00');
  assert.strictEqual(final.changed, true);

  let reads = 0;
  const posted = await post.handle(scheduler(), new Date('2026-10-13T15:00:00Z'), {
    env: {},
    card: { date: '2026-10-13', picks: [row('K', 0.04)], cardStatus: 'draft', finalized: false },
    readJson: async () => { reads += 1; throw new Error('must not read'); },
    fetchImpl: async () => { throw new Error('network'); },
  });
  const body = JSON.parse(posted.body);
  assert.strictEqual(reads, 0);
  assert.strictEqual(body.posted, false);
  assert.strictEqual(body.reason, 'flag-off');
  assert.strictEqual(body.finalized, true);
  assert.strictEqual(body.wrote, false);

  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  assert.ok(toml.includes('[functions."narrate-card-omega"]'));
  assert.ok(toml.includes('schedule = "45 14,15 * * *"'));
  assert.ok(!/OMEGA_X_AUTOPOST\s*=\s*"true"/.test(toml));
  assert.deepStrictEqual(et.ET_SCHEDULE['narrate-card-omega'].etTimes, ['10:45']);
  assert.ok(et.activeTomlSchedules(toml).some((item) => item.functionName === 'narrate-card-omega'));

  const ready = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/card-readiness.js'), 'utf8');
  assert.ok(ready.includes('11 * 60'));

  const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  const majors = verifySrc.slice(verifySrc.indexOf('const HR_MAJOR_BOOKS'), verifySrc.indexOf('function hrMajorsFallback'));
  assert.ok(majors.includes('"pinnacle"'));
  assert.ok(majors.includes('"hardrockbet"'));
  assert.ok(majors.includes('"draftkings"'));
  assert.ok(!majors.includes('fanduel'));
  assert.ok(verifySrc.includes('function hrMajorsFallback'));
  assert.ok(verifySrc.includes('reviewHardRock(picksData, sportGames)'));
  assert.ok(verifySrc.includes('if (hrCheck.changed)'));
  assert.ok(verifySrc.includes('function runHardRockCheckLegacyFetch'));

  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes("picksData.cardStatus = 'draft'"));
  assert.ok(indexSrc.includes("picksData.timelineStep = '10:00'"));
  assert.ok(indexSrc.includes("picksData.finalized = false"));

  console.log('test-omega-timeline-1013 ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
