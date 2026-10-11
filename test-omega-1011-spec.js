'use strict';
// 1011 spec additions: injuries reprice and never exclude, no post-publish
// card edits, open-to-10:30 steam is a selection input only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const gd = require(path.join(root, 'sports/game_day'));
const { gateReason, injuryClusterReason } = require(path.join(root, 'gates'));
const { conservativeNonQbAdj } = require(path.join(root, 'personnel'));
const late = require(path.join(root, 'late_news'));
const { sharpSteamSinceOpen, annotateLineMoves } = require(path.join(root, 'line_path'));
const { scoreCandidate } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { priceAtDraftKings } = require(path.join(root, 'selection_pass'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const et = require('./netlify/functions/lib/et-schedule');

const CARD = '2026-10-11';
const KICK = '2026-10-11T23:00:00Z';
const asOf = { cardDate: CARD, asOfMs: Date.parse('2026-10-11T14:00:00Z') };

function floorRow(extra) {
  return {
    sport: 'NFL',
    matchup: 'Baltimore Ravens @ Atlanta Falcons',
    side: 'Atlanta Falcons -3',
    market: 'Spread',
    line: -3,
    odds: -110,
    coverProb: 0.56,
    ev: 0.05,
    edgePct: 0.04,
    uncertainty: 0.12,
    commenceTime: KICK,
    homeTeam: 'Atlanta Falcons',
    awayTeam: 'Baltimore Ravens',
    book: 'draftkings',
    liquid: true,
    ...extra,
  };
}

(async () => {
  try {
    const lamar = gd.backupQbDelta({ qbStatus: 'out', qbName: 'Lamar Jackson' }, 'NFL');
    assert.strictEqual(lamar.source, 'named');
    assert.strictEqual(lamar.marginPts, 4.5);
    assert.strictEqual(lamar.totalPts, -2.25);
    const generic = gd.backupQbDelta({ qbStatus: 'out', qbName: 'Joe Backup' }, 'NFL');
    assert.strictEqual(generic.source, 'table');
    assert.strictEqual(generic.marginPts, 3);
    assert.strictEqual(generic.totalPts, -1.5);
    assert.ok(lamar.marginPts > generic.marginPts);
    assert.ok(lamar.totalPts < generic.totalPts);
    assert.strictEqual(gd.backupQbDelta({ qbStatus: 'doubtful', qbName: 'Lamar Jackson' }, 'NFL'), null);

    const qbOut = gd.applyGameDayAdjustments({
      sport: 'NFL',
      modelMargin: 0,
      modelTotal: 52.28,
      uncertainty: 0.18,
      home: 'Atlanta Falcons',
      away: 'Baltimore Ravens',
      restByTeam: {},
      qbByTeam: { 'Baltimore Ravens': { qbStatus: 'out', qbName: 'Lamar Jackson' } },
    });
    assert.ok(Math.abs(qbOut.gameDay.qbMarginAdj - 4.5) < 1e-9, qbOut.gameDay.qbMarginAdj);
    assert.ok(Math.abs(qbOut.gameDay.qbTotalAdj + 2.25) < 1e-9, qbOut.gameDay.qbTotalAdj);
    assert.ok(Math.abs(qbOut.modelTotal - (52.28 - 2.25)) < 1e-6, qbOut.modelTotal);
    assert.strictEqual(qbOut.startingQbOut, true);
    assert.strictEqual(gateReason(floorRow({
      market: 'Total', side: 'Over 47.5', line: 47.5, startingQbOut: true,
    }), asOf), null, 'a fresh QB out does not exclude the total');
    assert.strictEqual(gateReason(floorRow({ startingQbOut: true }), asOf), null);

    const starters = [1, 2, 3, 4, 5].map((i) => ({
      name: `WR${i}`, position: 'WR', status: 'out', starter: true,
    }));
    const cluster = conservativeNonQbAdj(starters, []);
    assert.strictEqual(cluster.homeSideExclude, false);
    assert.strictEqual(cluster.totalExclude, false);
    assert.strictEqual(cluster.exclude, false);
    assert.ok(cluster.probHaircut > 0);
    assert.ok(cluster.totalAdj < 0);
    assert.strictEqual(injuryClusterReason(), null);
    assert.strictEqual(gateReason(floorRow({
      personnelHomeExclude: true,
      personnelTotalExclude: true,
      market: 'Total',
      side: 'Over 44',
      line: 44,
    }), asOf), null, 'starter cluster does not exclude the total');

    const liveOut = {
      qbLoaded: true,
      awayQb: { qbStatus: 'out', qbName: 'Lamar Jackson' },
      homeQb: { qbStatus: null },
    };
    const injured = {
      sport: 'NFL',
      pick: 'Baltimore Ravens ML',
      betType: 'Moneyline',
      matchup: 'Baltimore Ravens @ Atlanta Falcons',
      homeTeam: 'Atlanta Falcons',
      awayTeam: 'Baltimore Ravens',
      odds: -110,
      coverProb: 0.56,
      fair_sharp_p: 0.50,
      ev: 0.07,
      edgePct: 0.06,
      uncertainty: 0.12,
      lateNews: { qb: { loaded: true, home: { qbStatus: null }, away: { qbStatus: null } } },
    };
    const qbDecision = late.decideLateNews(injured, liveOut);
    assert.strictEqual(qbDecision.action, 'reprice');
    assert.strictEqual(qbDecision.code, 'qb-out');
    assert.strictEqual(qbDecision.marginPts, 4.5);
    assert.strictEqual(qbDecision.totalPts, -2.25);
    const missed = late.finalizeNewsReprice(injured, qbDecision);
    assert.strictEqual(missed.action, 'drop');
    assert.strictEqual(missed.code, 'ev-floor');
    assert.strictEqual(missed.from, 'qb-out');
    const other = {
      ...injured,
      pick: 'Atlanta Falcons ML',
      coverProb: 0.62,
      fair_sharp_p: 0.52,
      ev: 0.18,
      edgePct: 0.10,
    };
    const kept = late.finalizeNewsReprice(other, late.decideLateNews(other, liveOut));
    assert.strictEqual(kept.action, 'reprice');
    assert.ok(kept.patch.ev >= 0.03, kept.patch && kept.patch.ev);
    assert.ok(kept.patch.coverProb > other.coverProb, 'opponent cover rises when the away QB is out');
    const noCover = late.finalizeNewsReprice({ ...injured, coverProb: null }, qbDecision);
    assert.strictEqual(noCover.action, 'reprice', 'missing cover cannot show an EV miss');
    const over = {
      ...injured,
      pick: 'Over 47.5',
      betType: 'Total',
      market: 'Total',
      coverProb: 0.62,
      fair_sharp_p: 0.52,
      ev: 0.18,
      edgePct: 0.10,
    };
    const overKept = late.finalizeNewsReprice(over, late.decideLateNews(over, liveOut));
    assert.strictEqual(overKept.action, 'reprice');
    assert.ok(overKept.patch.coverProb < over.coverProb);
    const card = { picks: [injured, other], parlayLegs: [] };
    const applied = late.applyCardActions(card, [
      { index: 0, ...missed },
      { index: 1, ...kept },
    ], new Date('2026-10-11T14:00:00Z'));
    assert.strictEqual(applied.dropped, 1);
    assert.strictEqual(applied.repriced, 1);
    assert.strictEqual(card.voidedPregame[0].voidCode, 'ev-floor');
    assert.strictEqual(card.picks[0].pick, 'Atlanta Falcons ML');
    assert.strictEqual(card.picks[0].odds, -110);
    assert.strictEqual(card.picks[0].newsReprice.code, 'qb-out');

    const sharp = sharpSteamSinceOpen(
      { sharpConsensus: { spreadHome: -3 }, books: { draftkings: { spreadHome: -3 } } },
      { sharpConsensus: { spreadHome: -4.5 }, books: { draftkings: { spreadHome: -3.5 } } },
      'Spread',
    );
    assert.strictEqual(sharp.sharpMovePts, -1.5);
    assert.strictEqual(sharp.sharpMoveSize, 1.5);
    assert.strictEqual(sharp.sharpMoveDir, 'down');
    assert.strictEqual(sharp.dkMovePts, -0.5);
    assert.strictEqual(sharp.dkLagsSharp, true);
    const caughtUp = sharpSteamSinceOpen(
      { sharpConsensus: { spreadHome: -3 }, books: { draftkings: { spreadHome: -3 } } },
      { sharpConsensus: { spreadHome: -4.5 }, books: { draftkings: { spreadHome: -4.5 } } },
      'Spread',
    );
    assert.strictEqual(caughtUp.dkLagsSharp, false);
    const small = sharpSteamSinceOpen(
      { sharpConsensus: { total: 45 }, books: { draftkings: { total: 45 } } },
      { sharpConsensus: { total: 45.25 }, books: { draftkings: { total: 45 } } },
      'Total',
    );
    assert.strictEqual(small.sharpMoveDir, 'up');
    assert.strictEqual(small.dkLagsSharp, false, 'a move under half a point is not a DK lag');
    const fair = 0.53;
    const annotated = annotateLineMoves([{
      awayTeam: 'Baltimore Ravens',
      homeTeam: 'Atlanta Falcons',
      market: 'Spread',
      side: 'Atlanta Falcons -3',
      line: -3,
      odds: -110,
      ev: 0.04,
      edgePct: 0.03,
      fair_sharp_p: fair,
    }], {
      games: {
        'baltimore ravens @ atlanta falcons': {
          sharpConsensus: { spreadHome: -3 },
          books: { draftkings: { spreadHome: -3 } },
        },
      },
    }, {
      games: {
        'baltimore ravens @ atlanta falcons': {
          sharpConsensus: { spreadHome: -4 },
          books: { draftkings: { spreadHome: -3 } },
        },
      },
    });
    assert.strictEqual(annotated[0].fair_sharp_p, fair, 'steam is not added to the fair price');
    assert.strictEqual(annotated[0].dkLagsSharp, true);
    assert.strictEqual(annotated[0].sharpMoveDir, 'down');
    assert.strictEqual(annotated[0].sharpMoveSize, 1);
    const plain = { edgePct: 0.04, ev: 0.05, fair_sharp_p: fair, odds: -110, uncertainty: 0.12 };
    const laggedScore = scoreCandidate({ ...plain, dkLagsSharp: true });
    const plainScore = scoreCandidate({ ...plain, dkLagsSharp: false });
    assert.ok(laggedScore > plainScore, 'DK lag is a selection nudge before the lock');
    assert.strictEqual(plain.fair_sharp_p, fair);

    const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
    assert.ok(!/await runOmegaSteamRecheck\s*\(/.test(verifySrc), 'verify does not recheck steam');
    assert.ok(!verifySrc.includes('[verify-steam] dropping'), 'verify does not drop for steam');
    assert.ok(verifySrc.includes('lateNews.runLateNews'), 'pre-publish verify still reprices news');
    assert.ok(verifySrc.includes('verifySchedule('), 'pre-publish verify can still swap a started side');
    assert.ok(verifySrc.includes('reviewHardRock(picksData, sportGames)'));
    assert.ok(verifySrc.includes('if (hrCheck.changed)'));
    assert.deepStrictEqual(et.ET_SCHEDULE['verify-picks-omega'].etTimes, ['10:30']);
    const priced = priceAtDraftKings({
      odds: -110,
      line: -3.5,
      coverProb: 0.56,
      fair_sharp_p: 0.50,
      bookPrices: [{ book: 'draftkings', american: -105, point: -3 }],
    });
    assert.strictEqual(priced.book, 'draftkings');
    assert.strictEqual(priced.odds, -105);
    assert.strictEqual(priced.line, -3);

    const pregameSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/pregame-check-omega.js'), 'utf8');
    assert.ok(!/runLateNews\s*\(/.test(pregameSrc), 'post-publish check does not reprice');
    assert.ok(!/writeCard\s*\(/.test(pregameSrc), 'post-publish check does not write the card');
    assert.strictEqual(et.ET_SCHEDULE['pregame-check-omega'].etTimes[0], '11:00');

    const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
    assert.ok(indexSrc.includes('const replayLike = !!(opts.historicalSnapshot || opts.replay);'));
    assert.ok(indexSrc.includes('Number(opts.pregameAsOfMs)'), 'optional pregame clock does not change the odds URL');

    const pub = publicPicksPayload({
      picks: [
        { pick: 'Atlanta Falcons -3', sport: 'NFL', odds: '-110', units: '1u', book: 'draftkings' },
        { pick: 'No book', sport: 'NFL', odds: '-110', units: '1u', book: '  ' },
      ],
      parlayLegs: [{
        type: '3-leg',
        legs: [{ pick: 'Lean Home +3', sport: 'NCAAF', odds: '-110', book: 'draftkings' }],
      }],
    });
    assert.strictEqual(pub.picks[0].book, 'draftkings');
    assert.ok(!Object.prototype.hasOwnProperty.call(pub.picks[1], 'book'));
    assert.strictEqual(pub.parlayLegs[0].legs[0].book, 'draftkings');

    const leg = (matchup, side, edge, extra) => {
      const [away, home] = matchup.split(' @ ');
      return {
        sport: 'NCAAF', matchup, side, market: 'Spread', line: 3,
        odds: -110, coverProb: 0.55, ev: extra && extra.ev != null ? extra.ev : 0.04,
        edgePct: edge, uncertainty: 0.12, commenceTime: KICK,
        homeTeam: home, awayTeam: away, book: 'draftkings',
        ...extra,
      };
    };
    const a = leg('A1 @ H1', 'H1 +3', 0.04);
    const b = leg('A2 @ H2', 'H2 +3', 0.035);
    const lean = leg('A3 @ H3', 'H3 +3', 0.02, { ev: 0.02, tier: 'lean' });
    const slip = optimizeParlay([a, b, lean], [a, b], { cardDate: CARD });
    assert.strictEqual(slip.length, 1);
    assert.strictEqual(slip[0].legs.length, 3);
    assert.ok(slip[0].legs.some((l) => l.pick === 'H3 +3'), 'a lean can be a parlay leg');
    assert.strictEqual(new Set(slip[0].legs.map((l) => l.matchup)).size, 3);
    assert.ok(parseFloat(slip[0].ev) > 0);

    console.log('PASS test-omega-1011-spec');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
