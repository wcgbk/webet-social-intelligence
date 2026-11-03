'use strict';

/**
 * Plumbing only: openPrint, lineMove, p_model, and fair_sharp_p survive
 * onto the published pick and into CLV enrichment. Line-path keys fold
 * accents so Montréal and Montreal are one game. No network.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const clv = require('./netlify/functions/lib/omega-vnext/clv_log');
const linePath = require('./netlify/functions/lib/omega-vnext/line_path');

const DATE = '2026-10-20';
const PREGAME = Date.parse('2026-10-20T12:00:00Z');
const COMMENCE = '2026-10-20T23:00:00Z';
const OPEN_PRINT = { book: 'draftkings', odds: -105, line: null, capturedAt: '2026-10-20T07:00:00Z' };
const LINE_MOVE = { oddsMoveCents: 5, lineMovePts: null, steamToward: true, steamAgainst: false };

function baseCandidate(over) {
  return {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeTeam: 'Kansas City Chiefs',
    side: 'Buffalo Bills ML',
    pick: 'Buffalo Bills ML',
    market: 'Moneyline',
    betType: 'Moneyline',
    oddsStr: '-110',
    odds: -110,
    book: 'draftkings',
    bestDkHr: { american: -110, book: 'draftkings' },
    modelRawP: 0.68,
    fair_sharp_p: 0.50,
    uncertainty: 0.18,
    commenceTime: COMMENCE,
    ...over,
  };
}

function identity(pick) {
  return {
    pick: pick.pick,
    odds: pick.odds,
    book: pick.book,
    units: pick.units,
    unitsNum: pick.unitsNum,
    stakeUsd: pick.stakeUsd,
  };
}

(async () => {
  const adapted = v2.fromOmegaCandidate(baseCandidate({
    openPrint: OPEN_PRINT,
    lineMove: LINE_MOVE,
  }));
  assert.strictEqual(adapted.pModel, 0.68);
  assert.strictEqual(adapted.pMkt, 0.50);
  assert.strictEqual(adapted.p_model, 0.68, 'fromOmegaCandidate maps pModel -> p_model');
  assert.strictEqual(adapted.fair_sharp_p, 0.50, 'fromOmegaCandidate maps pMkt -> fair_sharp_p');
  assert.deepStrictEqual(adapted.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(adapted.lineMove, LINE_MOVE);

  const camelOnly = v2.fromOmegaCandidate({
    sport: 'NHL',
    awayTeam: 'Winnipeg Jets',
    homeTeam: 'Montréal Canadiens',
    side: 'Winnipeg Jets',
    market: 'Moneyline',
    odds: '+160',
    book: 'draftkings',
    pModel: 0.349,
    pMkt: 0.357,
    openPrint: OPEN_PRINT,
    lineMove: LINE_MOVE,
  });
  assert.strictEqual(camelOnly.p_model, 0.349);
  assert.strictEqual(camelOnly.fair_sharp_p, 0.357);
  assert.strictEqual(camelOnly.pModel, 0.349);

  const withPath = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [adapted],
    history: [],
  });
  const bare = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [v2.fromOmegaCandidate(baseCandidate())],
    history: [],
  });
  assert.strictEqual(withPath.picks.length, 1);
  assert.deepStrictEqual(identity(withPath.picks[0]), identity(bare.picks[0]), 'line path fields do not change the ticket');

  const pick = withPath.picks[0];
  assert.strictEqual(pick.p_model, pick.pModel);
  assert.strictEqual(pick.fair_sharp_p, pick.pMkt);
  assert.ok(pick.pModel != null && pick.p_model != null);
  assert.deepStrictEqual(pick.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(pick.lineMove, LINE_MOVE);

  const enriched = clv.enrichBetTimeFields(pick, { date: DATE });
  assert.strictEqual(enriched.p_model, pick.pModel);
  assert.strictEqual(enriched.pModel, pick.pModel, 'stored pModel is kept');
  assert.strictEqual(enriched.fair_sharp_p, pick.pMkt);
  assert.deepStrictEqual(enriched.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(enriched.lineMove, LINE_MOVE);
  assert.deepStrictEqual(enriched.lockSnapshot.openPrint, OPEN_PRINT);

  const storedOnly = clv.enrichBetTimeFields({
    sport: 'NHL',
    matchup: 'Winnipeg Jets @ Montréal Canadiens',
    pick: 'Winnipeg Jets',
    betType: 'Moneyline',
    odds: '+160',
    book: 'draftkings',
    pModel: 0.349,
    pMkt: 0.357,
    openPrint: OPEN_PRINT,
    lineMove: LINE_MOVE,
  }, { date: '2026-11-03' });
  assert.strictEqual(storedOnly.p_model, 0.349, 'pModel fills p_model when the snake key is absent');
  assert.strictEqual(storedOnly.fair_sharp_p, 0.357, 'pMkt fills fair_sharp_p when the snake key is absent');
  assert.strictEqual(storedOnly.pModel, 0.349, 'enrich does not drop stored pModel');
  assert.deepStrictEqual(storedOnly.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(storedOnly.lineMove, LINE_MOVE);

  const seed = clv.betTimeClvSeed(storedOnly);
  assert.strictEqual(seed.p_model, 0.349);
  assert.strictEqual(seed.fair_sharp_p, 0.357);
  assert.deepStrictEqual(seed.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(seed.lineMove, LINE_MOVE);

  const bothKeys = clv.enrichBetTimeFields({
    sport: 'NHL',
    matchup: 'A @ B',
    pick: 'A',
    betType: 'Moneyline',
    odds: '+130',
    p_model: 0.41,
    pModel: 0.349,
    fair_sharp_p: 0.36,
    pMkt: 0.357,
  }, { date: '2026-11-03' });
  assert.strictEqual(bothKeys.p_model, 0.41, 'an existing p_model is not replaced');
  assert.strictEqual(bothKeys.pModel, 0.349, 'stored pModel stays beside p_model');
  assert.strictEqual(bothKeys.fair_sharp_p, 0.36);

  const rowPick = v2.toPick({
    sport: 'NHL',
    matchup: 'Winnipeg Jets @ Montréal Canadiens',
    pick: 'Winnipeg Jets',
    market: 'Moneyline',
    odds: 160,
    units: 0.75,
    stakeUsd: 113,
    edgeNovig: 0.047,
    edge: 0.02,
    ev: 0.051,
    calibration: { pModel: 0.349, pMkt: 0.357, pCal: 0.404, method: 'platt' },
    book: 'draftkings',
    commenceTime: '2026-11-04T00:10:00Z',
    openPrint: OPEN_PRINT,
    lineMove: LINE_MOVE,
  });
  assert.strictEqual(rowPick.p_model, 0.349);
  assert.strictEqual(rowPick.fair_sharp_p, 0.357);
  assert.strictEqual(rowPick.pModel, 0.349);
  assert.strictEqual(rowPick.odds, '+160');
  assert.strictEqual(rowPick.units, '0.75u');
  assert.strictEqual(rowPick.stakeUsd, 113);
  assert.deepStrictEqual(rowPick.openPrint, OPEN_PRINT);
  assert.deepStrictEqual(rowPick.lineMove, LINE_MOVE);

  assert.strictEqual(
    linePath.gameKey('Montréal Canadiens', 'Winnipeg Jets'),
    linePath.gameKey('Montreal Canadiens', 'Winnipeg Jets'),
  );
  assert.strictEqual(linePath.gameKey('Montréal Canadiens', 'Winnipeg Jets'), 'montreal canadiens @ winnipeg jets');
  assert.strictEqual(linePath.gameKey('Yankees', 'Red Sox'), 'yankees @ red sox');
  assert.strictEqual(linePath.foldAccents('Montréal'), 'Montreal');

  const legacyKey = 'montréal canadiens @ winnipeg jets';
  const foldedKey = linePath.gameKey('Montreal Canadiens', 'Winnipeg Jets');
  const snapGame = { awayTeam: 'Montréal Canadiens', homeTeam: 'Winnipeg Jets', books: {} };
  const foldedGame = { awayTeam: 'Montreal Canadiens', homeTeam: 'Winnipeg Jets', books: {} };
  assert.strictEqual(linePath.lookupGame({ [legacyKey]: snapGame }, 'Montreal Canadiens', 'Winnipeg Jets'), snapGame);
  assert.strictEqual(linePath.lookupGame({ [foldedKey]: foldedGame }, 'Montréal Canadiens', 'Winnipeg Jets'), foldedGame);
  assert.strictEqual(linePath.lookupGame({ [legacyKey]: snapGame }, 'Boston Bruins', 'Toronto Maple Leafs'), null);

  const annotated = linePath.annotateLineMoves([{
    awayTeam: 'Montreal Canadiens',
    homeTeam: 'Winnipeg Jets',
    market: 'Moneyline',
    side: 'Winnipeg Jets',
    odds: 160,
  }], {
    capturedAt: '2026-11-03T07:00:00Z',
    games: { [legacyKey]: snapGame },
  }, {
    games: { [legacyKey]: snapGame },
  });
  assert.strictEqual(annotated[0].lineMove.missingOpen, false, 'accented snap key still joins the unaccented team');
  assert.ok(annotated[0].openPrint === null || typeof annotated[0].openPrint === 'object');

  const reverse = linePath.annotateLineMoves([{
    awayTeam: 'Montréal Canadiens',
    homeTeam: 'Winnipeg Jets',
    market: 'Moneyline',
    side: 'Winnipeg Jets',
    odds: 160,
  }], {
    games: { [foldedKey]: foldedGame },
  });
  assert.strictEqual(reverse[0].lineMove.missingOpen, false, 'folded snap key still joins the accented team');

  console.log('PASS test-omega-v2-clv-path', {
    p_model: pick.p_model,
    fair_sharp_p: pick.fair_sharp_p,
    odds: pick.odds,
    units: pick.units,
    stakeUsd: pick.stakeUsd,
    book: pick.book,
    gameKey: linePath.gameKey('Montréal Canadiens', 'Winnipeg Jets'),
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
