'use strict';

/**
 * Candidate context log. The published card stays the same with the log
 * on or off, and a throwing fetch does not block the card.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const v2 = require('./netlify/functions/lib/omega-v2');
const inputs = require('./netlify/functions/lib/omega-v2/candidate_inputs');
const clv = require('./netlify/functions/lib/omega-v2/candidate_clv');
const { applyCalibration, fitWalkForward } = require('./netlify/functions/lib/omega-v2/calibrate');

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const DATE = '2026-11-03';

function cardBody(card) {
  return {
    picks: card.picks,
    parlayLegs: card.parlayLegs,
    rejections: card.rejections,
    straightUnits: card.straightUnits,
    parlayUnits: card.parlayUnits,
    totalUnits: card.totalUnits,
    calibration: card.calibration,
    pass: card.pass,
    parlaySource: card.parlaySource,
  };
}

function leg(matchup, pick, market, over) {
  return {
    sport: 'NFL',
    matchup,
    pick,
    side: pick,
    market,
    odds: '-110',
    book: 'draftkings',
    pModel: 0.68,
    pMkt: 0.50,
    modelRawP: 0.68,
    fair_sharp_p: 0.50,
    p_pinnacle: 0.50,
    sharpAnchorBook: 'pinnacle',
    uncertainty: 0.18,
    commenceTime: FUTURE,
    line: market === 'Total' ? 45.5 : null,
    homeTeam: over.homeTeam,
    awayTeam: over.awayTeam,
    ...over,
  };
}

function slate() {
  return [
    leg('Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline', {
      homeTeam: 'Kansas City Chiefs',
      awayTeam: 'Buffalo Bills',
    }),
    leg('Dallas Cowboys @ Philadelphia Eagles', 'Over 45.5', 'Total', {
      homeTeam: 'Philadelphia Eagles',
      awayTeam: 'Dallas Cowboys',
      line: 45.5,
    }),
  ];
}

async function testCardIdenticalAndThrowingFetch() {
  const saved = process.env.OMEGA_CANDIDATE_INPUTS;
  delete process.env.OMEGA_CANDIDATE_INPUTS;
  try {
    assert.strictEqual(inputs.inputsLoggingEnabled({}), true);
    process.env.OMEGA_CANDIDATE_INPUTS = '0';
    assert.strictEqual(inputs.inputsLoggingEnabled({}), false);
    assert.strictEqual(inputs.inputsLoggingEnabled({ logInputs: true }), true);
  } finally {
    if (saved == null) delete process.env.OMEGA_CANDIDATE_INPUTS;
    else process.env.OMEGA_CANDIDATE_INPUTS = saved;
  }

  let offCalls = 0;
  const offFetch = async () => {
    offCalls += 1;
    throw new Error('should not fetch');
  };
  const off = await v2.publishFromOmegaCandidates({
    date: DATE,
    candidates: slate(),
    history: [],
    logInputs: false,
    inputsFetch: offFetch,
  });
  assert.strictEqual(offCalls, 0, 'logging off does not fetch');
  assert.ok(off.picks.length >= 1, 'the sample card publishes a straight');

  let onCalls = 0;
  const onFetch = async () => {
    onCalls += 1;
    throw new Error('inputs fetch down');
  };
  const live = slate();
  const before = JSON.stringify(live);
  const on = await v2.publishFromOmegaCandidates({
    date: DATE,
    candidates: live,
    scoredCandidates: live,
    history: [],
    logInputs: true,
    inputsFetch: onFetch,
    snap: { espnBySport: {}, gameDay: {} },
  });
  assert.ok(onCalls > 0, 'logging on attempts the public fetch');
  assert.deepStrictEqual(cardBody(on), cardBody(off));
  assert.deepStrictEqual(
    (on.picks || []).map((p) => ({ pick: p.pick, units: p.units, rating: p.rating, pCal: p.pCal, odds: p.odds })),
    (off.picks || []).map((p) => ({ pick: p.pick, units: p.units, rating: p.rating, pCal: p.pCal, odds: p.odds }))
  );
  assert.deepStrictEqual(on.parlayLegs, off.parlayLegs);
  assert.strictEqual(JSON.stringify(live), before);
}

async function testContextRecord() {
  const home = 'New York Rangers';
  const away = 'Boston Bruins';
  const cand = {
    sport: 'NHL',
    matchup: `${away} @ ${home}`,
    side: `${away} ML`,
    market: 'Moneyline',
    homeTeam: home,
    awayTeam: away,
    commenceTime: '2026-11-04T00:00:00Z',
    modelRawP: 0.47,
    p_pinnacle: 0.44,
    fair_sharp_p: 0.44,
    sharpAnchorBook: 'pinnacle',
    odds: 130,
    book: 'draftkings',
  };
  const nfl = {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    side: 'Buffalo Bills ML',
    market: 'Moneyline',
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    commenceTime: '2026-11-03T18:00:00Z',
    modelRawP: 0.61,
    fair_sharp_p: 0.52,
    p_pinnacle: 0.52,
    sharpAnchorBook: 'pinnacle',
    odds: -110,
    book: 'draftkings',
  };
  const names = ['A Starter', 'B Starter', 'C Wing', 'D Wing', 'E Extra', 'F Question'];
  const injuryRows = names.map((name, i) => ({
    team: away,
    name,
    pos: i === 5 ? 'G' : 'C',
    status: i === 1 ? 'doubtful' : (i === 5 ? 'questionable' : 'out'),
    starter: i < 2,
  }));
  const snap = JSON.parse(JSON.stringify(cand));
  const logged = await inputs.recordCandidateInputs({
    dateISO: DATE,
    candidates: [cand, nfl],
    history: [],
    skipFetch: true,
    scheduleGames: [
      { sport: 'NHL', date: '2026-11-02', home: 'New Jersey Devils', away },
      { sport: 'NHL', date: '2026-11-01', home: 'Philadelphia Flyers', away },
      { sport: 'NHL', date: '2026-10-30', home: away, away: 'Montreal Canadiens' },
      { sport: 'NHL', date: '2026-10-31', home, away: 'Buffalo Sabres' },
    ],
    injuriesBySport: { NHL: injuryRows },
    snap: {
      espnBySport: {
        NHL: {
          games: [{
            sport: 'NHL',
            homeTeam: home,
            awayTeam: away,
            homeGoalie: { name: 'Igor Shesterkin', confirmed: true, status: 'confirmed' },
            awayGoalie: { name: 'Jeremy Swayman', probable: true, confirmed: false, status: 'probable' },
          }],
        },
        NFL: {
          games: [{
            sport: 'NFL',
            homeTeam: 'Kansas City Chiefs',
            awayTeam: 'Buffalo Bills',
            awayProbable: { name: 'Josh Allen' },
          }],
        },
      },
      gameDay: {
        qbStatusBySport: {
          NFL: { 'Kansas City Chiefs': { team: 'Kansas City Chiefs', qbName: 'Patrick Mahomes', qbStatus: 'questionable' } },
        },
        restByTeam: {},
      },
    },
  });
  assert.strictEqual(JSON.stringify(cand), JSON.stringify(snap), 'logging does not rewrite the candidate');
  assert.strictEqual(logged.scored, 2);
  assert.strictEqual(logged.bySport.NHL, 1);
  assert.strictEqual(logged.bySport.NFL, 1);
  const nhl = logged.rows.find((row) => row.sport === 'NHL');
  const football = logged.rows.find((row) => row.sport === 'NFL');
  assert.strictEqual(nhl.rest.away.restDays, 1);
  assert.strictEqual(nhl.rest.away.backToBack, true);
  assert.strictEqual(nhl.rest.home.restDays, 3);
  assert.strictEqual(nhl.rest.home.backToBack, false);
  assert.strictEqual(nhl.travel.awayRoadGames, 3);
  assert.ok(nhl.travel.approxMiles > 150 && nhl.travel.approxMiles < 250, nhl.travel.approxMiles);
  assert.strictEqual(nhl.injuries.away.length, 4);
  assert.ok(!nhl.injuries.away.some((row) => row.name === 'F Question'));
  assert.strictEqual(nhl.injuries.away[0].name, 'A Starter');
  assert.deepStrictEqual(nhl.goalie.home, { name: 'Igor Shesterkin', status: 'confirmed' });
  assert.deepStrictEqual(nhl.goalie.away, { name: 'Jeremy Swayman', status: 'probable' });
  assert.strictEqual(nhl.qb, null);
  assert.strictEqual(nhl.pModel, 0.47);
  assert.strictEqual(nhl.pFair, 0.44);
  const fit = fitWalkForward([], DATE);
  const expectCal = applyCalibration({
    sport: 'NHL', market: 'Moneyline', pick: `${away} ML`, pModel: 0.47, pMkt: 0.44,
  }, fit);
  assert.strictEqual(nhl.pCal, Number(expectCal.pCal.toFixed(4)));
  assert.strictEqual(football.qb.away.name, 'Josh Allen');
  assert.strictEqual(football.qb.away.status, 'probable');
  assert.strictEqual(football.qb.home.name, 'Patrick Mahomes');
  assert.strictEqual(football.qb.home.status, 'questionable');
  assert.strictEqual(football.goalie, null);

  const thrown = await inputs.recordCandidateInputs({
    dateISO: DATE,
    candidates: [cand],
    history: [],
    fetchJson: async () => { throw new Error('boom'); },
  });
  assert.strictEqual(thrown.error, undefined);
  assert.strictEqual(thrown.rows.length, 1);
  assert.strictEqual(thrown.rows[0].pModel, 0.47);
  assert.strictEqual(thrown.rows[0].pFair, 0.44);
  assert.ok(thrown.rows[0].pCal != null);
}

async function testPersistDoesNotTouchPicks() {
  const logged = await inputs.recordCandidateInputs({
    dateISO: DATE,
    skipFetch: true,
    history: [],
    candidates: [{
      sport: 'NHL',
      matchup: 'Boston Bruins @ New York Rangers',
      side: 'Boston Bruins ML',
      market: 'Moneyline',
      homeTeam: 'New York Rangers',
      awayTeam: 'Boston Bruins',
      commenceTime: '2026-11-04T00:00:00Z',
      modelRawP: 0.41,
      fair_sharp_p: 0.4,
      p_pinnacle: 0.4,
      odds: 120,
      book: 'draftkings',
    }],
  });
  const writes = [];
  const prevPicks = [{ pick: 'Keep', clv: 0.01 }];
  const saved = await clv.seedCandidateClv({
    dateISO: DATE,
    candidates: [{
      sport: 'NHL',
      matchup: 'Boston Bruins @ New York Rangers',
      side: 'Boston Bruins ML',
      market: 'Moneyline',
      odds: 120,
      book: 'draftkings',
      homeTeam: 'New York Rangers',
      awayTeam: 'Boston Bruins',
      commenceTime: '2026-11-04T00:00:00Z',
    }],
    inputs: logged,
    readJson: async () => ({ date: DATE, picks: prevPicks, avgCLV: 0.01, bySport: { NHL: { count: 1 } } }),
    writeJson: async (key, data) => { writes.push({ key, data }); },
  });
  assert.strictEqual(saved.saved, true);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].key, `clv-${DATE}`);
  assert.deepStrictEqual(writes[0].data.picks, prevPicks);
  assert.strictEqual(writes[0].data.avgCLV, 0.01);
  assert.ok(Array.isArray(writes[0].data.candidates));
  assert.strictEqual(writes[0].data.candidateInputs.length, 1);
  assert.strictEqual(writes[0].data.candidateInputs[0].sport, 'NHL');
  assert.strictEqual(writes[0].data.candidateInputsMeta.bySport.NHL, 1);
  assert.ok(!writes[0].data.candidates[0].inputs, 'close rows stay free of the input blob');

  const clvData = { date: DATE, picks: [{ pick: 'Keep' }], avgCLV: 0.02, bySport: { NHL: { count: 1 } } };
  await clv.attachCandidateCloses(clvData, {
    dateISO: DATE,
    candidates: [{
      sport: 'NHL',
      matchup: 'Boston Bruins @ New York Rangers',
      side: 'Boston Bruins ML',
      market: 'Moneyline',
      odds: 120,
      book: 'draftkings',
    }],
    snapshots: [],
    existingInputs: writes[0].data.candidateInputs,
  });
  assert.strictEqual(clvData.avgCLV, 0.02);
  assert.strictEqual(clvData.picks[0].pick, 'Keep');
  assert.strictEqual(clvData.candidateInputs[0].pModel, 0.41);
}

async function testCollegeRestWindow() {
  const urls = [];
  const board = (home, away, iso) => ({
    events: [{
      date: iso,
      competitions: [{
        competitors: [
          { homeAway: 'home', team: { displayName: home } },
          { homeAway: 'away', team: { displayName: away } },
        ],
      }],
    }],
  });
  const logged = await inputs.recordCandidateInputs({
    dateISO: DATE,
    history: [],
    candidates: [
      {
        sport: 'NCAAF',
        matchup: 'Ohio Bobcats @ Akron Zips',
        side: 'Akron Zips ML',
        market: 'Moneyline',
        homeTeam: 'Akron Zips',
        awayTeam: 'Ohio Bobcats',
        commenceTime: '2026-11-04T00:30:00Z',
        modelRawP: 0.55,
        p_pinnacle: 0.5,
        fair_sharp_p: 0.5,
      },
      {
        sport: 'NCAAM',
        matchup: 'South Dakota St Jackrabbits @ Kansas St Wildcats',
        side: 'Kansas St Wildcats ML',
        market: 'Moneyline',
        homeTeam: 'Kansas St Wildcats',
        awayTeam: 'South Dakota St Jackrabbits',
        commenceTime: '2026-11-04T00:00:00Z',
        modelRawP: 0.62,
        p_pinnacle: 0.58,
        fair_sharp_p: 0.58,
      },
    ],
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('college-football/scoreboard') && url.includes('dates=20261024')) {
        return board('Akron Zips', 'Ohio Bobcats', '2026-10-24T20:00:00Z');
      }
      if (url.includes('mens-college-basketball/scoreboard') && url.includes('dates=20261102')) {
        return board('Kansas State Wildcats', 'South Dakota State Jackrabbits', '2026-11-02T23:00:00Z');
      }
      return null;
    },
  });
  assert.ok(urls.some((url) => url.includes('college-football/scoreboard?dates=20261024')));
  assert.ok(urls.some((url) => url.includes('mens-college-basketball/scoreboard') && url.includes('groups=50')));
  const football = logged.rows.find((row) => row.sport === 'NCAAF');
  const hoops = logged.rows.find((row) => row.sport === 'NCAAM');
  assert.strictEqual(football.rest.home.restDays, 10);
  assert.strictEqual(football.rest.away.restDays, 10);
  assert.strictEqual(football.rest.home.backToBack, false);
  assert.strictEqual(hoops.rest.home.restDays, 1);
  assert.strictEqual(hoops.rest.away.restDays, 1);
  assert.strictEqual(hoops.rest.home.backToBack, true);
  assert.strictEqual(hoops.pModel, 0.62);
}

function testNoOddsFeed() {
  const file = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-v2/candidate_inputs.js'), 'utf8');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(file));
  assert.ok(!/\bfetch\s*\(/.test(file));
  assert.ok(file.includes('site.api.espn.com'));
  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  assert.ok(!toml.includes('candidate_inputs'));
  const pipe = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-v2/pipeline.js'), 'utf8');
  assert.ok(pipe.includes('recordCandidateInputs'));
  assert.ok(pipe.includes('The card object above is already final'));
}

(async () => {
  await testCardIdenticalAndThrowingFetch();
  await testContextRecord();
  await testCollegeRestWindow();
  await testPersistDoesNotTouchPicks();
  testNoOddsFeed();
  console.log('PASS candidate inputs');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
