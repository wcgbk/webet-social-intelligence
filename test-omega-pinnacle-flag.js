'use strict';
/**
 * Pinnacle sanity flag. Fixture lines only. Flag, do not drop or reprice.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { reviewFlag, logReviewFlags } = require(path.join(root, 'pinnacle_flag'));
const { enrichCandidateWithEdge } = require(path.join(root, 'edge'));
const { toPickObject } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { noVigTwoWay } = require(path.join(root, 'odds_math'));
const { createAuditLog } = require(path.join(root, 'audit_log'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const config = require(path.join(root, 'config'));

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'test/fixtures/pinnacle-sanity.json'), 'utf8'));

(async () => {
  assert.strictEqual(config.MODEL_VERSION, 'v12.3.41-omega-vnext-price-lock');
  assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.41-omega-vnext-price-lock:'));

  const enriched = enrichCandidateWithEdge(fixture.spread, fixture.home, [fixture.home, fixture.away]);
  const expectedNv = noVigTwoWay(-120, 100);
  assert.ok(Math.abs(enriched.pinnacleNoVig - expectedNv.p1) < 1e-9);
  assert.strictEqual(enriched.pinnaclePoint, -3);
  assert.strictEqual(enriched.odds, -110);
  assert.strictEqual(fixture.spread.odds, -110);

  const flagged = reviewFlag({ ...enriched, coverProb: 0.62 });
  assert.ok(flagged);
  assert.strictEqual(flagged.flagged, true);
  assert.strictEqual(flagged.pointGap, 7.5);
  assert.strictEqual(flagged.modelLine, 10.5);
  assert.strictEqual(flagged.pinnacleLine, -3);
  assert.strictEqual(flagged.pointThreshold, 7);
  assert.strictEqual(flagged.probThreshold, 0.12);
  assert.ok(flagged.probGap != null && flagged.probGap <= 0.12, flagged.probGap);
  assert.strictEqual(flagged.modelProb, 0.62);
  assert.ok(Math.abs(flagged.pinnacleNoVig - expectedNv.p1) < 1e-4);

  assert.strictEqual(reviewFlag({
    sport: 'NFL', market: 'Moneyline', coverProb: 0.62, pinnacleNoVig: 0.5,
  }), null);
  assert.ok(reviewFlag({
    sport: 'NFL', market: 'Moneyline', coverProb: 0.63, pinnacleNoVig: 0.5,
  }));
  assert.strictEqual(reviewFlag({
    sport: 'NFL', market: 'Spread', modelProjection: 10, pinnaclePoint: -3, coverProb: 0.5, pinnacleNoVig: 0.5,
  }), null);
  assert.strictEqual(reviewFlag({ sport: 'MLB', market: 'Total', coverProb: 0.7 }), null);

  for (const row of fixture.boundaries) {
    const flag = reviewFlag(row);
    assert.strictEqual(!!flag, row.flag, `${row.sport} ${row.market} ${row.modelProjection}`);
    if (flag) {
      assert.ok(flag.probGap != null || flag.pointGap != null);
      assert.ok(Object.prototype.hasOwnProperty.call(flag, 'modelProb'));
      assert.ok(Object.prototype.hasOwnProperty.call(flag, 'pinnacleNoVig'));
      assert.ok(Object.prototype.hasOwnProperty.call(flag, 'modelLine'));
      assert.ok(Object.prototype.hasOwnProperty.call(flag, 'pinnacleLine'));
    }
  }

  const quiet = {
    sport: 'NFL', market: 'Moneyline', side: 'Buffalo Bills', matchup: 'Miami Dolphins @ Buffalo Bills',
    homeTeam: 'Buffalo Bills', awayTeam: 'Miami Dolphins', odds: -110, coverProb: 0.56,
    ev: 0.04, edgePct: 0.04, pinnacleNoVig: 0.5, modelProjection: 2,
  };
  const loud = {
    ...quiet,
    side: 'Buffalo Bills -3',
    market: 'Spread',
    coverProb: 0.8,
    pinnacleNoVig: 0.5,
    modelProjection: 14,
    pinnaclePoint: -3,
    line: -3,
  };
  const oddsBefore = [quiet.odds, loud.odds];
  const picks = [quiet, loud].map((c) => toPickObject(c));
  assert.strictEqual(picks.length, 2);
  assert.deepStrictEqual([quiet.odds, loud.odds], oddsBefore);
  assert.strictEqual(picks[0].dataReviewFlag, undefined);
  assert.strictEqual(picks[0].odds, '-110');
  assert.strictEqual(picks[1].odds, '-110');
  assert.strictEqual(picks[1].dataReviewFlag.pointGap, 11);
  assert.ok(picks[1].dataReviewFlag.probGap > 0.12);
  assert.strictEqual(loud.odds, -110);

  const legs = [1, 2, 3].map((i) => ({
    sport: i === 2 ? 'NFL' : 'NHL',
    matchup: `Away ${i} @ Home ${i}`,
    awayTeam: `Away ${i}`,
    homeTeam: `Home ${i}`,
    side: `Home ${i}`,
    market: i === 2 ? 'Spread' : 'Moneyline',
    odds: -110,
    coverProb: 0.58,
    ev: 0.08,
    edgePct: 0.06,
    commenceTime: '2026-10-12T23:00:00Z',
    modelProjection: i === 2 ? 12 : 0.4,
    pinnacleNoVig: 0.5,
    pinnaclePoint: i === 2 ? -3 : null,
    line: i === 2 ? -3 : null,
  }));
  const oddsCopy = legs.map((l) => l.odds);
  const ticket = optimizeParlay(legs, []);
  assert.strictEqual(ticket.length, 1);
  assert.strictEqual(ticket[0].legs.length, 3);
  assert.deepStrictEqual(legs.map((l) => l.odds), oddsCopy);
  const spreadLeg = ticket[0].legs.find((l) => l.betType === 'Spread');
  const quietLeg = ticket[0].legs.find((l) => l.sport === 'NHL');
  assert.ok(spreadLeg.dataReviewFlag);
  assert.strictEqual(spreadLeg.dataReviewFlag.pointGap, 9);
  assert.strictEqual(spreadLeg.dataReviewFlag.probGap, 0.08);
  assert.strictEqual(quietLeg.dataReviewFlag, undefined);
  assert.strictEqual(spreadLeg.odds, '-110');

  const audit = createAuditLog({ runId: 'pinnacle-flag', date: '2026-10-12' });
  const logged = logReviewFlags(picks, ticket, audit);
  assert.strictEqual(logged, 2);
  const notes = audit.entries().map((row) => row.note);
  assert.strictEqual(notes.length, 2);
  assert.ok(notes.every((note) => note.includes('probGap=') && note.includes('pointGap=')));
  assert.ok(notes.some((note) => note.includes('pointGap=11')));
  assert.ok(notes.some((note) => note.includes('pointGap=9')));

  const published = publicPicksPayload({ picks, parlayLegs: ticket });
  assert.strictEqual(published.picks.length, 2);
  assert.ok(published.picks[1].dataReviewFlag);
  assert.strictEqual(published.picks[1].odds, '-110');
  assert.ok(published.parlayLegs[0].legs.some((l) => l.dataReviewFlag));

  console.log('test-omega-pinnacle-flag ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
