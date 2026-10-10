'use strict';
// Coverage fixes: NCAAF scoreboard groups, exhaustive parlay search, private shortfall.
// No network. No Odds API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const ingest = require(path.join(root, 'ingest'));
const parlay = require(path.join(root, 'parlay'));
const { buildShortfall, requiredFloor } = require(path.join(root, 'shortfall'));
const { buildHealthRecord, compactHealth } = require(path.join(root, 'health'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { GATES } = require(path.join(root, 'config'));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function espnEvent(id, away, home, iso) {
  return {
    id,
    date: iso,
    name: `${away} at ${home}`,
    shortName: `${away} @ ${home}`,
    competitions: [{
      date: iso,
      neutralSite: false,
      status: { type: { state: 'pre' } },
      competitors: [
        { homeAway: 'away', team: { displayName: away, abbreviation: 'A' }, score: '0' },
        { homeAway: 'home', team: { displayName: home, abbreviation: 'H' }, score: '0' },
      ],
    }],
  };
}

(async () => {
  const urls = ingest.espnScoreboardUrls('NCAAF', '2026-09-26');
  assert.strictEqual(urls.length, 2);
  assert.ok(urls[0].includes('groups=90'));
  assert.ok(urls[0].includes('limit=400'));
  assert.ok(urls[1].includes('groups=80'));
  assert.ok(!ingest.espnScoreboardUrls('MLB', '2026-09-26').some((u) => u.includes('groups=')));
  assert.strictEqual(ingest.espnScoreboardUrls('NFL', '2026-09-27').length, 1);

  const prev = global.fetch;
  try {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('groups=90')) {
        return jsonResponse({
          events: [
            espnEvent('1', 'Ohio State Buckeyes', 'Illinois Fighting Illini', '2026-09-26T16:00:00Z'),
            espnEvent('late', 'Hawaii Rainbow Warriors', 'Wyoming Cowboys', '2026-09-27T16:00:00Z'),
          ],
        });
      }
      if (String(url).includes('groups=80')) {
        return jsonResponse({
          events: [
            espnEvent('1', 'Ohio State Buckeyes', 'Illinois Fighting Illini', '2026-09-26T16:00:00Z'),
            espnEvent('2', 'Furman Paladins', 'Richmond Spiders', '2026-09-26T20:00:00Z'),
          ],
        });
      }
      if (String(url).includes('baseball/mlb')) {
        return jsonResponse({
          events: [espnEvent('m1', 'New York Yankees', 'Boston Red Sox', '2026-09-26T17:00:00Z')],
        });
      }
      throw new Error('unexpected url ' + url);
    };
    const board = await ingest.fetchEspnScoreboard('NCAAF', '2026-09-26');
    assert.strictEqual(board.games.length, 2, 'merge groups and drop the next ET day');
    assert.deepStrictEqual(board.games.map((g) => g.id), ['1', '2']);
    assert.strictEqual(seen.filter((u) => u.includes('college-football')).length, 2);

    seen.length = 0;
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('groups=90')) {
        const err = new Error('HTTP 500');
        err.status = 500;
        throw err;
      }
      return jsonResponse({
        events: [espnEvent('2', 'Furman Paladins', 'Richmond Spiders', '2026-09-26T20:00:00Z')],
      });
    };
    const partial = await ingest.fetchEspnScoreboard('NCAAF', '2026-09-26');
    assert.strictEqual(partial.games.length, 1);
    assert.strictEqual(partial.games[0].awayTeam, 'Furman Paladins');

    seen.length = 0;
    global.fetch = async (url) => {
      seen.push(String(url));
      return jsonResponse({
        events: [espnEvent('m1', 'New York Yankees', 'Boston Red Sox', '2026-09-26T17:00:00Z')],
      });
    };
    const mlb = await ingest.fetchEspnScoreboard('MLB', '2026-09-26');
    assert.strictEqual(mlb.games.length, 1);
    assert.strictEqual(seen.length, 1);
    assert.ok(!seen[0].includes('groups='));
  } finally {
    global.fetch = prev;
  }

  // Top 24 by coverProb are only two games. The 25th leg is the only third game.
  // A capped search cannot publish a 3-leg. The full pool can.
  function leg(matchup, side, cover, ev) {
    const [away, home] = matchup.split(' @ ');
    return {
      sport: 'NFL',
      matchup,
      awayTeam: away,
      homeTeam: home,
      side,
      market: 'Moneyline',
      odds: 100,
      coverProb: cover,
      ev,
      commenceTime: '2026-10-04T17:00:00Z',
    };
  }
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(leg('Alpha @ Beta', `Alpha ${i}`, 0.62, 0.05));
  for (let i = 0; i < 12; i++) pool.push(leg('Gamma @ Delta', `Gamma ${i}`, 0.60, 0.04));
  pool.push(leg('Echo @ Foxtrot', 'Echo ML', 0.50, 0.03));
  const ticket = parlay.optimizeParlay(pool, []);
  assert.strictEqual(ticket.length, 1);
  assert.strictEqual(ticket[0].legs.length, 3);
  assert.strictEqual(ticket[0].candidatesScanned, 25);
  assert.ok(ticket[0].legs.some((l) => l.matchup === 'Echo @ Foxtrot'));
  assert.ok(!fs.readFileSync(path.join(root, 'parlay.js'), 'utf8').includes('pool.slice(0, 24)'));

  const rejected = [];
  for (let i = 0; i < 12; i++) {
    rejected.push({
      sport: i % 2 ? 'NFL' : 'MLB',
      matchup: `Away ${i} @ Home ${i}`,
      market: 'Total',
      side: `Over ${i}`,
      odds: -110,
      coverProb: 0.5,
      fair_sharp_p: 0.48,
      edgePct: 0.01,
      ev: 0.001 * (i + 1),
      rejectReason: 'ev-floor',
    });
  }
  const yesExtra = {
    sport: 'NHL',
    matchup: 'Rangers @ Bruins',
    market: 'Moneyline',
    side: 'Boston Bruins',
    odds: -120,
    coverProb: 0.58,
    fair_sharp_p: 0.54,
    edgePct: 0.03,
    ev: 0.04,
  };
  const picks = [{
    sport: 'MLB',
    matchup: 'Rays @ Yankees',
    pick: 'New York Yankees ML',
    betType: 'Moneyline',
  }];
  const short = buildShortfall({
    picks,
    parlayLegs: [],
    yesPool: [yesExtra],
    rejected,
  });
  assert.strictEqual(short.active, true);
  assert.strictEqual(short.straightsCleared, 1);
  assert.strictEqual(short.straightsTarget, 3);
  assert.strictEqual(short.parlayCleared, false);
  assert.strictEqual(short.parlayLegs, 0);
  assert.strictEqual(short.nextBest.length, 10);
  assert.strictEqual(short.nextBest[0].sport, 'NHL');
  assert.strictEqual(short.nextBest[0].game, 'Rangers @ Bruins');
  assert.strictEqual(short.nextBest[0].side, 'Boston Bruins');
  assert.strictEqual(short.nextBest[0].price, -120);
  assert.strictEqual(short.nextBest[0].p_cal, 0.58);
  assert.strictEqual(short.nextBest[0].p_sharp, 0.54);
  assert.strictEqual(short.nextBest[0].failingGate, 'not-selected');
  assert.strictEqual(short.nextBest[0].requiredFloor, null);
  assert.strictEqual(short.nextBest[1].side, 'Over 11');
  assert.strictEqual(short.nextBest[1].failingGate, 'ev-floor');
  assert.strictEqual(short.nextBest[1].requiredFloor, short.nextBest[1].sport === 'NFL' ? GATES.minEV.NFL : GATES.minEV.MLB);
  assert.ok(short.nextBest[1].ev >= short.nextBest[2].ev);
  assert.strictEqual(requiredFloor({ sport: 'MLB', odds: 450 }, 'odds-out-of-band'), GATES.maxAmericanOdds);
  assert.strictEqual(requiredFloor({ sport: 'MLB', odds: -450 }, 'odds-out-of-band'), GATES.minAmericanOdds);

  const fullPicks = [0, 1, 2].map((i) => ({
    sport: 'NFL',
    matchup: `A${i} @ B${i}`,
    pick: `B${i} -3`,
    betType: 'Spread',
  }));
  const full = buildShortfall({
    picks: fullPicks,
    parlayLegs: [{ legs: [{}, {}, {}], type: '3-leg-parlay-optimized' }],
    yesPool: [yesExtra],
    rejected,
  });
  assert.strictEqual(full.active, false);
  assert.strictEqual(full.straightsCleared, 3);
  assert.strictEqual(full.parlayCleared, true);
  assert.strictEqual(full.parlayLegs, 3);
  assert.deepStrictEqual(full.nextBest, []);

  const twoLeg = buildShortfall({
    picks: fullPicks,
    parlayLegs: [{ legs: [{}, {}] }],
    yesPool: [],
    rejected: [],
  });
  assert.strictEqual(twoLeg.active, true);
  assert.strictEqual(twoLeg.parlayLegs, 2);
  assert.strictEqual(twoLeg.parlayCleared, false);

  const record = buildHealthRecord({
    dateISO: '2026-10-08',
    snap: { espnBySport: {}, oddsBySport: {}, standingsBySport: {} },
    shortfall: short,
  });
  assert.strictEqual(record.shortfall, short);
  const compact = compactHealth(record);
  assert.strictEqual(compact.shortfall, undefined);
  assert.ok(!JSON.stringify(compact).includes('Rangers @ Bruins'));

  const pub = publicPicksPayload({
    model: 'v',
    picks: [{ pick: 'Boston Bruins ML', sport: 'NHL', odds: '-120', units: '1u' }],
    parlayLegs: [],
    shortfall: short,
    health: { status: 'ok' },
  });
  assert.strictEqual(pub.shortfall, undefined);
  assert.strictEqual(pub.health, undefined);
  assert.strictEqual(pub.picks.length, 1);
  assert.ok(!JSON.stringify(pub).includes('failingGate'));
  assert.ok(!JSON.stringify(pub).includes('nextBest'));

  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(idx.includes('buildShortfall({'));
  assert.ok(idx.includes('shortfall: picksData.shortfall'));

  console.log('PASS test-omega-coverage');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
