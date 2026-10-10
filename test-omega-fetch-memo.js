'use strict';
/**
 * Pick-neutral cost cuts. No network. Proves memoized and skipped fetches
 * return the same bodies the uncached path would have kept.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const memo = require(path.join(root, 'fetch_memo'));
const ingest = require(path.join(root, 'ingest'));
const capture = require(path.join(root, 'capture_runner'));
const narrate = require(path.join(root, 'narrate'));
const config = require(path.join(root, 'config'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.16-omega-vnext-ncaaf-oa-wx');

const DATE = '2026-10-06';
const SAME_DAY = '2026-10-06T16:00:00Z'; // noon ET
const OTHER_DAY = '2026-10-07T16:00:00Z';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

async function withFetch(impl, fn) {
  const prev = global.fetch;
  const env = {
    ODDS_API_KEY: process.env.ODDS_API_KEY,
    NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = prev;
    for (const [k, v] of Object.entries(env)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function mlbEvent(id, commence) {
  return {
    id,
    commence_time: commence,
    home_team: 'Boston Red Sox',
    away_team: 'New York Yankees',
    bookmakers: [{ key: 'pinnacle', markets: [] }],
  };
}

(async () => {
  // ── slateOddsGate ──
  {
    let called = 0;
    const skip = await memo.slateOddsGate({
      sportKey: 'baseball_mlb',
      apiKey: 'k',
      dateISO: DATE,
      fetchImpl: async () => {
        called += 1;
        return jsonResponse([mlbEvent('off', OTHER_DAY)]);
      },
    });
    assert.strictEqual(skip.skip, true);
    assert.strictEqual(skip.reason, 'no-same-et-day');
    assert.strictEqual(skip.sameDay, 0);
    assert.strictEqual(called, 1);

    const keep = await memo.slateOddsGate({
      sportKey: 'baseball_mlb',
      apiKey: 'k',
      dateISO: DATE,
      fetchImpl: async () => jsonResponse([mlbEvent('on', SAME_DAY), mlbEvent('off', OTHER_DAY)]),
    });
    assert.strictEqual(keep.skip, false);
    assert.strictEqual(keep.reason, 'has-same-et-day');
    assert.strictEqual(keep.sameDay, 1);

    const down = await memo.slateOddsGate({
      sportKey: 'baseball_mlb',
      apiKey: 'k',
      dateISO: DATE,
      fetchImpl: async () => jsonResponse('nope', 503),
    });
    assert.strictEqual(down.skip, false);
    assert.strictEqual(down.reason, 'events-unavailable');

    let histCalls = 0;
    const hist = await memo.slateOddsGate({
      sportKey: 'baseball_mlb',
      apiKey: 'k',
      dateISO: DATE,
      historical: true,
      fetchImpl: async () => { histCalls += 1; return jsonResponse([]); },
    });
    assert.strictEqual(hist.skip, false);
    assert.strictEqual(hist.reason, 'historical');
    assert.strictEqual(histCalls, 0);
  }

  assert.strictEqual(memo.skipAlphaLiveOdds('soccer_epl', { historical: false }), true);
  assert.strictEqual(memo.skipAlphaLiveOdds('soccer_uefa_europa_conference_league', {}), true);
  assert.strictEqual(memo.skipAlphaLiveOdds('soccer_epl', { historical: true }), false);
  assert.strictEqual(memo.skipAlphaLiveOdds('baseball_mlb', {}), false);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('Anthropic HTTP 400: bad')), false);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('Anthropic HTTP 401')), false);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('Anthropic HTTP 403')), false);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('Anthropic HTTP 500')), true);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('Anthropic HTTP 429')), true);
  assert.strictEqual(memo.narrateErrorShouldRetry(new Error('no JSON in Claude response')), true);

  assert.strictEqual(memo.hasTrueClosingCapture({ clv: 0.01, captureMinsToCommence: 0, captureScore: 0 }), true);
  assert.strictEqual(memo.hasTrueClosingCapture({ clv: 0, captureMinsToCommence: 0, captureScore: 0 }), true);
  assert.strictEqual(memo.hasTrueClosingCapture({ clv: 0.01, captureMinsToCommence: 5, captureScore: 0 }), false);
  assert.strictEqual(memo.hasTrueClosingCapture({ clv: 0.01, captureMinsToCommence: 0, captureScore: 1 }), false);
  assert.strictEqual(memo.hasTrueClosingCapture({ clv: null, captureMinsToCommence: 0, captureScore: 0 }), false);
  assert.strictEqual(memo.hasTrueClosingCapture(null), false);

  // Failures are not cached. Successes are cloned, so a caller cannot poison the store.
  await withFetch(null, async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n === 1) return jsonResponse('no', 503);
      return jsonResponse({ k: 1 });
    };
    await memo.runWithFetchMemo(async () => {
      await assert.rejects(() => memo.memoFetchJson('https://example.test/fail'));
      const a = await memo.memoFetchJson('https://example.test/fail');
      a.k = 9;
      const b = await memo.memoFetchJson('https://example.test/fail');
      assert.strictEqual(b.k, 1);
      assert.notStrictEqual(a, b);
    });
    assert.strictEqual(n, 2);
  });

  // ── fetchOddsMultiSport: empty slate skips the paid URL; a slate matches the ET filter ──
  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return jsonResponse([mlbEvent('off', OTHER_DAY)]);
    };
    const empty = await ingest.fetchOddsMultiSport(DATE, {});
    assert.ok(urls.every((u) => u.includes('/events?')));
    assert.ok(!urls.some((u) => u.includes('/odds')));
    for (const label of ['MLB', 'NFL', 'NCAAF', 'NHL']) {
      assert.deepStrictEqual(empty.bySport[label], []);
    }
    assert.strictEqual(empty.bySport.NBA, undefined);
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const oddsPayload = [mlbEvent('on', SAME_DAY), mlbEvent('off', OTHER_DAY)];
    const urls = [];
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/events?')) {
        const same = u.includes('/baseball_mlb/');
        return jsonResponse([mlbEvent(same ? 'on' : 'off', same ? SAME_DAY : OTHER_DAY)]);
      }
      assert.ok(u.includes('/baseball_mlb/odds'));
      return jsonResponse(oddsPayload);
    };
    const out = await ingest.fetchOddsMultiSport(DATE, {});
    const expected = ingest.filterEventsSameEtDay(oddsPayload, DATE);
    assert.deepStrictEqual(out.bySport.MLB, expected);
    assert.strictEqual(out.bySport.MLB.length, 1);
    assert.strictEqual(out.bySport.MLB[0].id, 'on');
    assert.deepStrictEqual(out.bySport.NFL, []);
    assert.strictEqual(urls.filter((u) => u.includes('/odds')).length, 1);
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const urls = [];
    const oddsPayload = [mlbEvent('on', SAME_DAY)];
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/events?')) return jsonResponse('down', 500);
      return jsonResponse(oddsPayload);
    };
    const out = await ingest.fetchOddsMultiSport(DATE, {});
    assert.ok(urls.some((u) => u.includes('/odds')));
    assert.deepStrictEqual(out.bySport.MLB, ingest.filterEventsSameEtDay(oddsPayload, DATE));
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const urls = [];
    const snap = '2026-10-06T15:00:00Z';
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      assert.ok(!u.includes('/events'));
      assert.ok(u.includes('/historical/sports/'));
      return jsonResponse({ data: [mlbEvent('on', SAME_DAY), mlbEvent('off', OTHER_DAY)] });
    };
    const out = await ingest.fetchOddsMultiSport(DATE, { historicalSnapshot: snap });
    const enabled = ['MLB', 'NFL', 'NCAAF', 'NHL'];
    assert.strictEqual(urls.length, enabled.length);
    for (const label of enabled) {
      assert.strictEqual(out.bySport[label].length, 1);
      assert.strictEqual(out.bySport[label][0].id, 'on');
    }
    assert.ok(urls.some((u) => u.includes('icehockey_nhl')));
    assert.ok(!urls.some((u) => u.includes('basketball_nba')));
  });

  // ── ESPN memo: one network read, deep-equal copies, no leak across runs ──
  await withFetch(null, async () => {
    let n = 0;
    const standingsBody = {
      standings: {
        entries: [{
          team: { displayName: 'New York Yankees' },
          stats: [
            { name: 'winPercent', value: 0.6 },
            { name: 'wins', value: 90 },
            { name: 'losses', value: 60 },
            { name: 'pointsFor', value: 700 },
            { name: 'pointsAgainst', value: 650 },
          ],
        }],
      },
    };
    global.fetch = async () => {
      n += 1;
      return jsonResponse(standingsBody);
    };
    await memo.runWithFetchMemo(async () => {
      const a = await ingest.fetchEspnStandings('MLB');
      const b = await ingest.fetchEspnStandings('MLB');
      assert.deepStrictEqual(a, b);
      assert.strictEqual(a['New York Yankees'].wins, 90);
      delete a['New York Yankees'].wins;
      assert.strictEqual(b['New York Yankees'].wins, 90);
      assert.strictEqual(n, 1);
    });
    await ingest.fetchEspnStandings('MLB');
    assert.strictEqual(n, 2, 'memo must not survive the run');
  });

  await withFetch(null, async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      return jsonResponse({
        events: [{
          id: '401',
          name: 'Yankees at Red Sox',
          shortName: 'NYY @ BOS',
          date: SAME_DAY,
          competitions: [{
            date: SAME_DAY,
            status: { type: { state: 'pre' } },
            competitors: [
              { homeAway: 'home', team: { displayName: 'Boston Red Sox', abbreviation: 'BOS' }, score: '0' },
              { homeAway: 'away', team: { displayName: 'New York Yankees', abbreviation: 'NYY' }, score: '0' },
            ],
          }],
        }],
      });
    };
    await memo.runWithFetchMemo(async () => {
      const a = await ingest.fetchEspnScoreboard('MLB', DATE);
      const b = await ingest.fetchEspnScoreboard('MLB', DATE);
      assert.deepStrictEqual(a, b);
      assert.strictEqual(a.games.length, 1);
      delete a.games[0].homeTeam;
      assert.strictEqual(b.games[0].homeTeam, 'Boston Red Sox');
      assert.strictEqual(n, 1);
    });
  });

  // ── fresh snap reuse vs empty-slate skip ──
  const now = new Date('2026-10-06T14:00:00Z');
  const freshAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const exactAt = new Date(now.getTime() - memo.FRESH_SNAP_MS).toISOString();
  const staleAt = new Date(now.getTime() - memo.FRESH_SNAP_MS - 1000).toISOString();
  const futureAt = new Date(now.getTime() + 60 * 1000).toISOString();
  const games = {
    'new york yankees @ boston red sox': {
      sport: 'MLB', awayTeam: 'New York Yankees', homeTeam: 'Boston Red Sox',
    },
  };
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: freshAt, gameCount: 1, games }, now), true);
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: exactAt, gameCount: 1, games: {} }, now), true);
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: staleAt, gameCount: 1, games }, now), false);
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: futureAt, gameCount: 1, games }, now), false);
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: freshAt, gameCount: 0, games: {} }, now), false);
  assert.strictEqual(memo.isFreshReusableSnap({ capturedAt: freshAt, games: {} }, now), false);
  assert.strictEqual(memo.isFreshReusableSnap(null, now), false);

  assert.ok(capture.CAPTURE_SPORTS.includes('NBA'));
  assert.ok(capture.CAPTURE_SPORTS.includes('NHL'));
  assert.ok(!capture.captureLabels(false).includes('NBA'));
  assert.ok(capture.captureLabels(false).includes('NHL'));
  assert.ok(capture.captureLabels(true).includes('NBA'));

  const covered = {
    capturedAt: freshAt,
    gameCount: 1,
    games,
    sports: ['MLB:1', 'NFL:0', 'NCAAF:skip-empty', 'NHL:2'],
  };
  assert.strictEqual(memo.snapCoversSports(covered, capture.captureLabels(false)), true);
  assert.strictEqual(memo.snapCoversSports(covered, capture.captureLabels(true)), false);

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
    let gateN = 0;
    let oddsN = 0;
    let stored = null;
    const body = await capture.runOmegaLineCapture({
      now,
      dateISO: DATE,
      etSlot: '0915',
      apiKey: 'test-key',
      token: 'test-token',
      readSnap: async () => covered,
      storeLinePoll: async (_date, poll) => {
        stored = poll;
        return { gameCount: Object.keys(poll.games).length, snapKey: 'snap', pathKey: 'path' };
      },
      slateGate: async () => { gateN += 1; return { skip: false }; },
      fetchSportOdds: async () => { oddsN += 1; return []; },
    });
    assert.strictEqual(gateN, 0);
    assert.strictEqual(oddsN, 0);
    assert.strictEqual(body.reused, true);
    assert.deepStrictEqual(stored.games, covered.games);
    assert.strictEqual(stored.capturedAt, covered.capturedAt);
    assert.strictEqual(body.gameCount, 1);
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
    const keys = [];
    let oddsN = 0;
    const body = await capture.runOmegaLineCapture({
      now,
      dateISO: DATE,
      etSlot: '0915',
      apiKey: 'test-key',
      token: 'test-token',
      readSnap: async () => ({ ...covered, capturedAt: staleAt }),
      storeLinePoll: async (_date, poll) => ({
        gameCount: Object.keys(poll.games).length, snapKey: 'snap', pathKey: 'path',
      }),
      slateGate: async ({ sportKey }) => {
        keys.push(sportKey);
        return { skip: true, reason: 'no-same-et-day', sameDay: 0, events: 3 };
      },
      fetchSportOdds: async () => { oddsN += 1; return [mlbEvent('on', SAME_DAY)]; },
    });
    assert.strictEqual(oddsN, 0);
    assert.deepStrictEqual(keys, ['baseball_mlb', 'americanfootball_nfl', 'americanfootball_ncaaf', 'icehockey_nhl']);
    assert.ok(body.sports.every((s) => s.endsWith(':skip-empty')));
    assert.strictEqual(body.sports.length, 4);
    assert.ok(!body.sports.some((s) => s.startsWith('NBA')));
    assert.strictEqual(body.gameCount, 0);
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
    const keys = [];
    const body = await capture.runOmegaLineCapture({
      now,
      dateISO: DATE,
      etSlot: '0915',
      includeDisabled: true,
      apiKey: 'test-key',
      token: 'test-token',
      readSnap: async () => covered,
      storeLinePoll: async (_date, poll) => ({
        gameCount: Object.keys(poll.games).length, snapKey: 'snap', pathKey: 'path',
      }),
      slateGate: async ({ sportKey }) => {
        keys.push(sportKey);
        return { skip: true, reason: 'no-same-et-day', events: 0 };
      },
      fetchSportOdds: async () => { throw new Error('odds should not be called'); },
    });
    assert.ok(keys.includes('basketball_nba'));
    assert.ok(body.sports.includes('NBA:skip-empty'));
    assert.notStrictEqual(body.reused, true);
  });

  // ── narrate: permanent 4xx is one call; 5xx still retries; side is kept either way ──
  const pick = { pick: 'Yankees', matchup: 'Yankees @ Red Sox', odds: '-120', units: '1u', sport: 'MLB', betType: 'Moneyline' };
  await withFetch(null, async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      return jsonResponse('bad request', 400);
    };
    const out = await narrate.narrateAndVerify({
      picks: [pick], parlayLegs: [], dateFormatted: 'October 6, 2026', apiKey: 'test-anthropic',
    });
    assert.strictEqual(n, 1);
    assert.strictEqual(out.picks[0].pick, 'Yankees');
    assert.strictEqual(out.picks[0].odds, '-120');
    assert.strictEqual(out.picks[0].units, '1u');
  });
  await withFetch(null, async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      return jsonResponse('unavailable', 500);
    };
    const out = await narrate.narrateAndVerify({
      picks: [pick], parlayLegs: [], dateFormatted: 'October 6, 2026', apiKey: 'test-anthropic',
    });
    assert.strictEqual(n, 2);
    assert.strictEqual(out.picks[0].pick, 'Yankees');
    assert.strictEqual(out.picks[0].betType, 'Moneyline');
  });

  // ── alpha live soccer skip + events gate; historical path still pulls soccer ──
  const alpha = require('./netlify/functions/generate-picks-alpha-background');
  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const urls = [];
    const oddsPayload = [mlbEvent('on', SAME_DAY), mlbEvent('off', OTHER_DAY)];
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/events?')) return jsonResponse([mlbEvent('on', SAME_DAY)]);
      if (u.includes('alternate_spreads')) return jsonResponse('unprocessable', 422);
      return jsonResponse(oddsPayload);
    };
    const live = await alpha.fetchOdds(DATE, null);
    assert.ok(urls.every((u) => u.includes('baseball_mlb')));
    assert.strictEqual(urls.filter((u) => u.includes('/odds')).length, 2);
    assert.ok(urls.some((u) => u.includes('alternate_spreads')));
    assert.ok(urls.some((u) => u.includes('/odds') && !u.includes('alternate_')));
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].sport, 'baseball_mlb');
    assert.strictEqual(live[0].games.length, 1);
    assert.strictEqual(live[0].games[0].id, 'on');
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    const urls = [];
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      assert.ok(u.includes('/historical/'));
      assert.ok(!u.includes('/events'));
      return jsonResponse({ data: [mlbEvent('on', SAME_DAY)] });
    };
    const hist = await alpha.fetchOdds(DATE, '2026-10-06T15:00:00Z');
    assert.ok(urls.some((u) => u.includes('soccer_epl')));
    assert.ok(urls.some((u) => u.includes('soccer_uefa_europa_conference_league')));
    assert.ok(hist.some((s) => s.sport === 'soccer_epl' && s.games[0].id === 'on'));
  });

  // ── opening lines: empty events slate stores the same empty book a filtered pull would ──
  const opening = require('./netlify/functions/capture-opening-lines');
  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
    const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const off = `${etToday.slice(0, 8)}${String((Number(etToday.slice(8)) % 28) + 1).padStart(2, '0')}T16:00:00Z`;
    const urls = [];
    global.fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/events?')) return jsonResponse([mlbEvent('off', off)]);
      if (u.includes('api.netlify.com')) return jsonResponse({ ok: true });
      throw new Error(`unexpected odds call ${u}`);
    };
    const res = await opening.handler({});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).games, 0);
    assert.ok(!urls.some((u) => u.includes('/odds')));
  });

  await withFetch(null, async () => {
    process.env.ODDS_API_KEY = 'test-key';
    process.env.NETLIFY_AUTH_TOKEN = 'test-token';
    const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const on = `${etToday}T16:00:00Z`;
    const [yy, mm, dd] = etToday.split('-').map(Number);
    const next = new Date(Date.UTC(yy, mm - 1, dd + 1)).toISOString().slice(0, 10);
    const off = `${next}T16:00:00Z`;
    let putBody = null;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/events?')) {
        const same = u.includes('/baseball_mlb/');
        return jsonResponse([{ id: same ? 'on' : 'off', commence_time: same ? on : off }]);
      }
      if (u.includes('/odds?')) {
        return jsonResponse([
          {
            commence_time: on,
            home_team: 'Boston Red Sox',
            away_team: 'New York Yankees',
            bookmakers: [{
              markets: [
                { key: 'spreads', outcomes: [{ name: 'Boston Red Sox', point: -1.5 }] },
                { key: 'totals', outcomes: [{ name: 'Over', point: 8.5 }] },
                { key: 'h2h', outcomes: [{ name: 'Boston Red Sox', price: -140 }, { name: 'New York Yankees', price: 120 }] },
              ],
            }],
          },
          {
            commence_time: off,
            home_team: 'Boston Red Sox',
            away_team: 'New York Yankees',
            bookmakers: [{ markets: [{ key: 'spreads', outcomes: [{ name: 'Boston Red Sox', point: -3.5 }] }] }],
          },
        ]);
      }
      putBody = JSON.parse(init.body);
      return jsonResponse({ ok: true });
    };
    const res = await opening.handler({});
    assert.strictEqual(JSON.parse(res.body).games, 1);
    assert.strictEqual(putBody.gameCount, 1);
    const row = putBody.games['new york yankees @ boston red sox'];
    assert.ok(row);
    assert.strictEqual(row.openSpread, -1.5);
    assert.strictEqual(row.openTotal, 8.5);
    assert.strictEqual(Object.keys(putBody.games).length, 1);
  });

  // ── omega CLV ESPN body is shared inside one run ──
  const omegaClv = require('./netlify/functions/track-clv-omega');
  await withFetch(null, async () => {
    let n = 0;
    global.fetch = async () => {
      n += 1;
      return jsonResponse({
        events: [{
          competitions: [{
            status: { type: { state: 'post', name: 'STATUS_FINAL', completed: true }, period: 9 },
            competitors: [
              { homeAway: 'away', score: '3', team: { displayName: 'New York Yankees', abbreviation: 'NYY' } },
              { homeAway: 'home', score: '2', team: { displayName: 'Boston Red Sox', abbreviation: 'BOS' } },
            ],
          }],
        }],
      });
    };
    await memo.runWithFetchMemo(async () => {
      const a = await omegaClv._test.fetchESPNScores(DATE, 'MLB');
      const b = await omegaClv._test.fetchESPNScores(DATE, 'MLB');
      assert.deepStrictEqual(a, b);
      assert.strictEqual(a[0].awayScore, 3);
      a[0].awayScore = 99;
      assert.strictEqual(b[0].awayScore, 3);
      assert.strictEqual(n, 1);
    });
  });

  console.log('test-omega-fetch-memo: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
