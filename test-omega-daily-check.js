'use strict';

/**
 * Daily ops check. Fixtures only: no network, no Odds API, no card writes.
 * Grades and KPIs go through the live grader's pure functions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { gradeDay, aggregateDays } = require('./netlify/functions/get-results-omega')._test;
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { stakeUsd } = require('./netlify/functions/lib/omega-v2/size');
const {
  runDailyCheck,
  readDailyReport,
  writeDailyReport,
  refuseCardKey,
  dailyCheckKey,
  shiftYmd,
  creditStatus,
  sameMultiset,
  etWallUtcMs,
  generatedBeforeDeadline,
  assessPullSlot,
  assessBounds,
} = require('./netlify/functions/lib/omega-vnext/daily_check');
const { handle: backgroundHandle, handler: backgroundHandler } = require('./netlify/functions/check-omega-daily-background');
const { handle: getHandle } = require('./netlify/functions/get-omega-daily-check');
const { handler: gradeBoards } = require('./netlify/functions/grade-boards-omega');
const { SPORTS } = require('./netlify/functions/lib/odds-master/pull');

const DATE = '2026-11-15';
const PREV = '2026-11-14';
const DEC = americanToDecimal(-110);
const TEST_BLOB_TOKEN = 'test-token';
const TEST_SERVICE_KEY = 'sb-service-test-key';
const NEWS_FIRST_DAY = '2026-11-16';

function livePullDoc(slot, at) {
  const sports = {};
  for (const [label] of SPORTS) sports[label] = 0;
  sports.NFL = 3;
  return {
    date: DATE,
    slot,
    at,
    games: 3,
    books: ['draftkings'],
    errors: [],
    sports,
  };
}

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return ''; } },
    json: async () => body,
  };
}

function externalFixture() {
  const sha = 'a'.repeat(40);
  const prevMain = 'b'.repeat(40);
  const oldSha = 'c'.repeat(40);
  return {
    sha,
    prevMain,
    oldSha,
    failFetch: false,
    ledger: [{
      sha,
      prevMain,
      commits: [sha],
      actor: 'edge-executor',
      at: '2026-11-14T16:00:00.000Z',
    }],
    commits: [
      {
        sha,
        commit: {
          message: 'ops: blessed deploy\n\nbody',
          committer: { date: '2026-11-15T15:00:00.000Z' },
          author: { date: '2026-11-15T15:00:00.000Z' },
        },
      },
      {
        sha: oldSha,
        commit: {
          message: 'history before the ledger',
          committer: { date: '2026-11-14T15:00:00.000Z' },
        },
      },
      {
        sha: 'd'.repeat(40),
        commit: {
          message: 'outside the 48h window',
          committer: { date: '2026-11-10T12:00:00.000Z' },
        },
      },
    ],
    deploys: [
      {
        id: 'dep-old',
        state: 'ready',
        context: 'production',
        title: 'history before the ledger',
        commit_ref: oldSha,
        created_at: '2026-11-14T15:00:00.000Z',
        deploy_source: 'api',
      },
      {
        id: 'dep-titled',
        state: 'ready',
        context: 'production',
        title: 'ops: blessed deploy',
        commit_ref: sha,
        created_at: '2026-11-15T15:00:02.000Z',
        deploy_source: 'api',
      },
      {
        id: 'dep-live',
        state: 'ready',
        context: 'production',
        title: null,
        commit_ref: null,
        created_at: '2026-11-15T15:00:04.000Z',
        deploy_source: 'api',
      },
      {
        id: 'dep-preview',
        state: 'ready',
        context: 'deploy-preview',
        title: null,
        commit_ref: null,
        created_at: '2026-11-15T12:00:00.000Z',
      },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeCard(card) {
  Object.freeze(card.picks);
  for (const pick of card.picks) Object.freeze(pick);
  Object.freeze(card.parlayLegs);
  for (const ticket of card.parlayLegs) {
    Object.freeze(ticket.legs);
    for (const leg of ticket.legs) Object.freeze(leg);
    Object.freeze(ticket);
  }
  Object.freeze(card);
}

function straightRow(pick, matchup) {
  const pBet = 0.55;
  const units = 0.5;
  return {
    sport: 'NFL',
    matchup,
    pick,
    odds: '-110',
    book: 'draftkings',
    units,
    unitsNum: units,
    pBet,
    stakeUsd: stakeUsd(units),
    winProbability: '55.0%',
    evRaw: pBet * DEC - 1,
    grade: 'A',
  };
}

function priceParlay(card) {
  const ticket = card.parlayLegs[0];
  let product = 1;
  let joint = 1;
  for (const leg of ticket.legs) {
    product *= americanToDecimal(leg.odds);
    joint *= leg.pBet;
  }
  ticket.combinedDecimal = product;
  ticket.evRaw = joint * product - 1;
}

function buildBase() {
  const specs = [
    ['Lions ML', 'Lions @ Bears', 'Lions', 'Bears', 24, 17],
    ['Packers ML', 'Packers @ Vikings', 'Packers', 'Vikings', 21, 14],
    ['Chiefs ML', 'Chiefs @ Raiders', 'Chiefs', 'Raiders', 27, 20],
  ];
  const picks = specs.map((row) => straightRow(row[0], row[1]));
  const legs = picks.map((pick) => ({
    sport: pick.sport,
    matchup: pick.matchup,
    pick: pick.pick,
    odds: pick.odds,
    book: pick.book,
    pBet: pick.pBet,
  }));
  const card = {
    generatedAt: '2026-11-15T15:30:00.000Z',
    picks,
    parlayLegs: [{ legs, units: 0.25 }],
  };
  priceParlay(card);
  const prevCard = clone(card);
  prevCard.generatedAt = '2026-11-14T15:30:00.000Z';
  const games = specs.map((row) => ({
    sport: 'NFL',
    _sport: 'NFL',
    awayTeam: row[2],
    homeTeam: row[3],
    awayScore: row[4],
    homeScore: row[5],
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
  }));
  return { card, prevCard, games };
}

function mirrorRowsOf(card) {
  return {
    rows: (card.picks || []).map((row) => ({
      kind: 'straight',
      pick: row.pick,
      odds: row.odds,
      book: row.book,
      units: row.units,
    })),
  };
}

function v1Of(card) {
  return {
    picks: (card.picks || []).map((row) => ({
      pick: row.pick,
      odds: row.odds,
      book: row.book,
      units: row.units,
    })),
  };
}

function resync(data) {
  data.mirror = mirrorRowsOf(data.card);
  data.v1 = v1Of(data.card);
}

function checkOf(report, id) {
  const row = report.checks.find((item) => item.id === id);
  assert.ok(row, `missing check ${id}`);
  return row;
}

function assertCheck(report, id, status, code, label) {
  const row = checkOf(report, id);
  const evidence = row.evidence || {};
  assert.strictEqual(row.status, status, `${label} ${id} status=${row.status} code=${evidence.code} ${JSON.stringify(evidence).slice(0, 300)}`);
  if (code) assert.strictEqual(evidence.code, code, `${label} ${id} code ${JSON.stringify(evidence).slice(0, 400)}`);
  return row;
}

async function withSpy(fn) {
  const lines = [];
  const warns = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...args) => { lines.push(args.map((part) => String(part)).join(' ')); };
  console.warn = (...args) => { warns.push(args.map((part) => String(part)).join(' ')); };
  try {
    return await fn(lines, warns);
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

async function withEnv(patch, fn) {
  const prev = {};
  const keys = Object.keys(patch);
  for (const key of keys) prev[key] = process.env[key];
  try {
    for (const key of keys) {
      if (patch[key] == null) delete process.env[key];
      else process.env[key] = patch[key];
    }
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

async function main() {
  const base = buildBase();
  const graded = await gradeDay(PREV, base.prevCard, { games: base.games });
  assert.strictEqual(graded.parlayResult, 'win');
  assert.ok(graded.picks.filter((row) => row.sport !== 'PARLAY').every((row) => row.result === 'win'));
  const goodCache = { days: [graded], cumulative: aggregateDays([graded]).cumulative };

  assert.strictEqual(shiftYmd(DATE, -1), PREV);
  assert.strictEqual(shiftYmd('2026-11-01', -1), '2026-10-31');
  assert.strictEqual(shiftYmd('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(creditStatus(12000).status, 'ok');
  assert.strictEqual(creditStatus(11999).status, 'warn');
  assert.strictEqual(creditStatus(10000).code, 'credits-warn');
  assert.strictEqual(creditStatus(9999).code, 'credits-low');
  assert.strictEqual(creditStatus(null).code, 'credits-unknown');
  assert.strictEqual(sameMultiset(
    [{ pick: 'Lions ML', odds: '-110', book: 'hardrockbet', units: 0.5 }],
    [{ pick: 'Lions ML', odds: -110, book: 'hardrock', units: '0.50', kind: 'straight' }],
    true
  ), true);
  const wall = etWallUtcMs(DATE, 11, 0);
  assert.strictEqual(new Date(wall).toISOString(), '2026-11-15T16:00:00.000Z');
  assert.strictEqual(generatedBeforeDeadline('2026-11-15T16:00:00.000Z', DATE), true);
  assert.strictEqual(generatedBeforeDeadline('2026-11-15T16:00:01.000Z', DATE), false);
  assert.strictEqual(assessPullSlot('0300', { sports: [] }).code, 'no-slate');
  assert.strictEqual(assessPullSlot('0300', {
    marker: { ok: true },
    pullDoc: null,
    sports: ['NFL'],
  }).code, 'board-missing');
  const completePull = livePullDoc('0300', '2026-11-15T08:00:00.000Z');
  assert.strictEqual(assessPullSlot('0300', { pullDoc: completePull, sports: ['NFL'] }).code, 'ok');
  assert.strictEqual(assessPullSlot('0300', {
    marker: { ok: false },
    pullDoc: completePull,
    sports: ['NFL'],
  }).code, 'ok');
  const thinPull = { date: DATE, slot: '0300', at: '2026-11-15T08:00:00.000Z', games: 1 };
  assert.strictEqual(assessPullSlot('0300', { pullDoc: thinPull, sports: ['NFL'] }).code, 'partial-0300-pull');
  const erredPull = livePullDoc('0300', '2026-11-15T08:00:00.000Z');
  erredPull.errors = ['NHL: HTTP 500'];
  assert.strictEqual(assessPullSlot('0300', { pullDoc: erredPull }).code, 'partial-0300-pull');
  const shortPull = livePullDoc('0300', '2026-11-15T08:00:00.000Z');
  shortPull.requests = SPORTS.length - 1;
  assert.strictEqual(assessPullSlot('0300', { pullDoc: shortPull }).code, 'partial-0300-pull');
  const droppedSport = livePullDoc('0300', '2026-11-15T08:00:00.000Z');
  delete droppedSport.sports.MLB;
  assert.strictEqual(assessPullSlot('0300', { pullDoc: droppedSport }).code, 'partial-0300-pull');
  assert.throws(() => refuseCardKey('picks-2026-11-15'));
  assert.throws(() => refuseCardKey('latest-date'));
  assert.throws(() => refuseCardKey('omega-ops/capture-health-latest'));
  assert.strictEqual(dailyCheckKey(DATE), 'omega-ops/daily-check-2026-11-15');

  let seenWrite = null;
  await writeDailyReport(DATE, { ok: true }, {
    writeReport(key, report) { seenWrite = { key, report }; },
  });
  assert.strictEqual(seenWrite.key, 'omega-ops/daily-check-2026-11-15');
  assert.strictEqual(seenWrite.report.ok, true);

  function defaultData() {
    const card = clone(base.card);
    const prevCard = clone(base.prevCard);
    return {
      markers: { '0300': { ok: true, phase: 'done' }, '1000': { ok: true, phase: 'done' } },
      starts: {},
      moves: null,
      sports: ['NFL'],
      pulls: {
        '0300': livePullDoc('0300', '2026-11-15T08:00:00.000Z'),
        '1000': livePullDoc('1000', '2026-11-15T15:00:00.000Z'),
      },
      card,
      prevCard,
      v1: v1Of(card),
      mirror: mirrorRowsOf(card),
      cache: clone(goodCache),
      games: clone(base.games),
      clv: {
        picks: prevCard.picks.map((row) => ({
          pick: row.pick,
          matchup: row.matchup,
          closingOdds: '-108',
          clv: 1.2,
        })),
      },
      candidates: {
        candidates: prevCard.picks.map((row) => ({
          pick: row.pick,
          matchup: row.matchup,
          closeNoVig: 0.52,
        })),
      },
      news: { present: true, key: `${DATE}/1100-ET` },
      credits: { remaining: 15000, source: 'line-move', at: '2026-11-15T15:00:00.000Z' },
      external: externalFixture(),
    };
  }

  function makeWorld(mutate) {
    const calls = { mirror: [], v1: [], regrade: 0, write: [], webhook: [] };
    const data = defaultData();
    const deps = {
      env: { NETLIFY_AUTH_TOKEN: TEST_BLOB_TOKEN },
      now: new Date('2026-11-15T16:30:00.000Z'),
      date: DATE,
      async fetch(url, init) {
        const href = String(url);
        const ext = data.external;
        if (ext.failFetch) throw new Error('network down');
        const headers = (init && init.headers) || {};
        const auth = headers.Authorization || headers.authorization || '';
        if (href.includes('.supabase.co')) {
          const sbKey = deps.env.SUPABASE_SERVICE_ROLE_KEY || '';
          const apiKey = headers.apikey || headers.Apikey || '';
          const profile = headers['Accept-Profile'] || headers['accept-profile'] || '';
          if (!sbKey || auth !== `Bearer ${sbKey}` || apiKey !== sbKey) throw new Error('supabase auth mismatch');
          if (profile !== 'clv') throw new Error('supabase profile');
          ext.hits = ext.hits || [];
          ext.hits.push(href);
          const sb = ext.supabase || {};
          if (href.includes('/rest/v1/pick_clv')) return jsonResp(sb.pickClv || []);
          if (href.includes('/rest/v1/games')) return jsonResp(sb.games || []);
          if (href.includes('/rest/v1/odds_snapshots')) return jsonResp(sb.snapshots || []);
          return jsonResp([], 404);
        }
        if (href.includes('api.github.com')) {
          if (auth) throw new Error('github must stay unauthenticated');
          if (!href.includes('/commits?') || !href.includes('sha=main') || !href.includes('since=')) {
            throw new Error('github url');
          }
          return jsonResp(ext.commits);
        }
        if (auth !== `Bearer ${deps.env.NETLIFY_AUTH_TOKEN || ''}`) throw new Error('netlify auth mismatch');
        if (href.includes('/deploys')) {
          if (!href.includes('/deploys?per_page=50')) throw new Error('deploys url');
          return jsonResp(ext.deploys);
        }
        const siteStore = href.includes('/site:omega-ops') || href.includes('/site%3Aomega-ops');
        const ledgerRows = siteStore ? (ext.siteLedger || []) : ext.ledger;
        if (href.includes('/blobs/') && href.includes('/deploy-ledger/')) {
          const sha = decodeURIComponent(href.split('/deploy-ledger/').pop().split('?')[0]);
          const row = ledgerRows.find((item) => item.sha === sha);
          if (!row) return jsonResp({}, 404);
          return jsonResp(row);
        }
        if (href.includes('/blobs/') && (siteStore || href.includes('/omega-ops'))) {
          if (!siteStore && ext.legacyMissing) return jsonResp({ message: 'missing' }, 404);
          return jsonResp({
            blobs: ledgerRows.map((row) => ({ key: `deploy-ledger/${row.sha}` })),
          });
        }
        throw new Error(`unexpected url ${href.split('?')[0]}`);
      },
      writeReport(key, report) { calls.write.push({ key, report }); },
      readCaptureDone(_date, slot) { return data.markers[slot] || null; },
      readCaptureStart(_date, slot) { return data.starts[slot] || null; },
      readPinnacleLineMoves() { return data.moves; },
      sportsForCard() { return data.sports; },
      readOddsMasterPull(_date, slot) { return data.pulls[slot] || null; },
      readCard(date) { return date === PREV ? data.prevCard : data.card; },
      readV1Card() {
        if (calls.v1.length > 0 && Object.prototype.hasOwnProperty.call(data, 'v1After')) return data.v1After;
        return data.v1;
      },
      readMirrorPicks() {
        if (calls.mirror.length > 0 && Object.prototype.hasOwnProperty.call(data, 'mirrorAfter')) return data.mirrorAfter;
        return data.mirror;
      },
      async mirrorTodayCard(date, card) { calls.mirror.push({ date, card }); },
      async syncMainCardToV1(date, card) { calls.v1.push({ date, card }); },
      readResultsCache() {
        if (calls.regrade > 0 && Object.prototype.hasOwnProperty.call(data, 'cacheAfter')) return data.cacheAfter;
        return data.cache;
      },
      fetchGames() { return data.games; },
      async regrade() { calls.regrade += 1; return { ok: true }; },
      readClv() { return data.clv; },
      readCandidateCloses() { return data.candidates; },
      readNews() { return data.news; },
      readCredits() { return data.credits; },
      async postWebhook(url, report) {
        calls.webhook.push({ url, report });
        return { ok: true };
      },
    };
    if (mutate) mutate(data, deps, calls);
    return { data, deps, calls };
  }

  async function runCase(mutate) {
    return withSpy(async (lines, warns) => {
      const world = makeWorld(mutate);
      const report = await runDailyCheck(world.deps);
      return { report, world, lines, warns };
    });
  }

  const okRun = await withSpy(async (lines) => {
    const world = makeWorld();
    freezeCard(world.data.card);
    freezeCard(world.data.prevCard);
    for (const game of world.data.games) Object.freeze(game);
    const report = await runDailyCheck(world.deps);
    return { report, world, lines };
  });
  assert.strictEqual(okRun.report.schema, 'omega-ops-daily-check-v1');
  assert.strictEqual(okRun.report.date, DATE);
  assert.strictEqual(okRun.report.prevDate, PREV);
  assert.strictEqual(okRun.report.dryRun, false);
  assert.strictEqual(okRun.report.ok, true);
  assert.deepStrictEqual(okRun.report.checks.map((row) => row.id), [
    'pulls', 'card', 'mirror', 'bounds', 'grading', 'kpis', 'closes', 'news', 'credits', 'external-changes',
  ]);
  for (const row of okRun.report.checks) assert.strictEqual(row.status, 'ok', row.id);
  assert.strictEqual(okRun.world.calls.write.length, 1);
  assert.strictEqual(okRun.world.calls.write[0].key, 'omega-ops/daily-check-2026-11-15');
  assert.strictEqual(okRun.world.calls.mirror.length, 0);
  assert.strictEqual(okRun.world.calls.v1.length, 0);
  assert.strictEqual(okRun.world.calls.regrade, 0);
  assert.strictEqual(okRun.world.calls.webhook.length, 0);
  assert.ok(!okRun.lines.some((line) => line.includes('daily-check-')));
  assert.ok(!JSON.stringify(okRun.report).includes(TEST_BLOB_TOKEN));
  assert.ok(!JSON.stringify(okRun.report).includes('NETLIFY_AUTH_TOKEN'));

  const failCases = [
    ['missed 0300', (data) => { data.markers['0300'] = null; data.pulls['0300'] = null; }, 'pulls', 'fail', 'missed-0300-pull'],
    ['missed 1000', (data) => { data.markers['1000'] = null; data.pulls['1000'] = null; }, 'pulls', 'fail', 'missed-1000-pull'],
    ['partial 0300', (data) => { data.pulls['0300'].errors = ['NFL: HTTP 500']; }, 'pulls', 'fail', 'partial-0300-pull'],
    ['partial 1000', (data) => { data.pulls['1000'].ok = false; }, 'pulls', 'fail', 'partial-1000-pull'],
    ['started 0300', (data) => { data.markers['0300'] = null; data.pulls['0300'] = null; data.starts['0300'] = { at: '2026-11-15T08:01:00.000Z' }; }, 'pulls', 'fail', 'capture-started-not-finished'],
    ['board missing', (data) => { data.pulls['0300'] = null; }, 'pulls', 'fail', 'board-missing'],
    ['late card', (data) => { data.card.generatedAt = '2026-11-15T16:00:01.000Z'; }, 'card', 'fail', 'generated-after-1100-et'],
    ['missing generatedAt', (data) => { delete data.card.generatedAt; }, 'card', 'fail', 'generated-after-1100-et'],
    ['two straights', (data) => { data.card.picks = data.card.picks.slice(0, 2); resync(data); }, 'card', 'fail', 'straight-count'],
    ['no parlay', (data) => { data.card.parlayLegs = []; }, 'card', 'fail', 'parlay-leg-count'],
    ['parlay legs differ', (data) => { data.card.parlayLegs[0].legs[0].odds = '-105'; }, 'card', 'fail', 'parlay-legs-differ'],
    ['pBet low', (data) => { data.card.picks[0].pBet = 0.01; }, 'bounds', 'fail', 'pbet-range'],
    ['pBet high', (data) => { data.card.picks[0].pBet = 0.99; }, 'bounds', 'fail', 'pbet-range'],
    ['spread low', (data) => {
      data.card.picks[0].pick = 'Lions -3.5';
      data.card.picks[0].betType = 'spread';
      data.card.picks[0].pBet = 0.29;
      data.card.parlayLegs[0].legs[0].pick = 'Lions -3.5';
      resync(data);
    }, 'bounds', 'fail', 'pbet-spread-total'],
    ['total high', (data) => {
      data.card.picks[1].pick = 'Over 45.5';
      data.card.picks[1].betType = 'total';
      data.card.picks[1].pBet = 0.8;
      data.card.parlayLegs[0].legs[1].pick = 'Over 45.5';
      resync(data);
    }, 'bounds', 'fail', 'pbet-spread-total'],
    ['bad odds', (data) => {
      data.card.picks[0].odds = 50;
      data.card.parlayLegs[0].legs[0].odds = 50;
      resync(data);
    }, 'bounds', 'fail', 'odds'],
    ['bad book', (data) => {
      data.card.picks[0].book = 'fanduel';
      data.card.parlayLegs[0].legs[0].book = 'fanduel';
      resync(data);
    }, 'bounds', 'fail', 'book'],
    ['units off grid', (data) => { data.card.picks[0].units = 0.1; data.card.picks[0].unitsNum = 0.1; resync(data); }, 'bounds', 'fail', 'units'],
    ['units above cap', (data) => { data.card.picks[0].units = 2.25; data.card.picks[0].unitsNum = 2.25; resync(data); }, 'bounds', 'fail', 'units'],
    ['units below floor', (data) => { data.card.picks[0].units = 0; data.card.picks[0].unitsNum = 0; resync(data); }, 'bounds', 'fail', 'units'],
    ['B grade units', (data) => {
      data.card.picks[0].grade = 'B';
      data.card.picks[0].units = 0.75;
      data.card.picks[0].unitsNum = 0.75;
      data.card.picks[0].stakeUsd = stakeUsd(0.75);
      resync(data);
    }, 'bounds', 'fail', 'b-grade-units'],
    ['stake', (data) => { data.card.picks[0].stakeUsd = 74; }, 'bounds', 'fail', 'stake'],
    ['parlay units', (data) => { data.card.parlayLegs[0].units = 1.25; }, 'bounds', 'fail', 'parlay-units'],
    ['parlay decimal', (data) => { data.card.parlayLegs[0].combinedDecimal += 0.02; }, 'bounds', 'fail', 'parlay-decimal'],
    ['parlay ev', (data) => { data.card.parlayLegs[0].evRaw += 0.02; }, 'bounds', 'fail', 'parlay-ev'],
    ['win probability', (data) => { data.card.picks[0].winProbability = '40.0%'; }, 'bounds', 'fail', 'win-probability'],
    ['pick close missing', (data) => { data.clv = { picks: [] }; }, 'closes', 'fail', 'pick-close-missing'],
    ['candidate close missing', (data) => { data.candidates = { candidates: [] }; }, 'closes', 'fail', 'candidate-close-missing'],
    ['news missing', (data) => { data.news = null; }, 'news', 'warn', 'news-missing'],
    ['credits warn', (data) => { data.credits = { remaining: 11999, source: 'clv-close-capture' }; }, 'credits', 'warn', 'credits-warn'],
    ['credits low', (data) => { data.credits = { remaining: 9999, source: 'audit-log' }; }, 'credits', 'fail', 'credits-low'],
    ['credits boundary warn', (data) => { data.credits = { remaining: 10000, source: 'line-move' }; }, 'credits', 'warn', 'credits-warn'],
    ['credits unknown', (data) => { data.credits = null; }, 'credits', 'fail', 'credits-unknown'],
  ];

  for (const [label, mutate, id, status, code] of failCases) {
    const result = await runCase(mutate);
    assertCheck(result.report, id, status, code, label);
    assert.strictEqual(result.report.ok, false, label);
    assert.strictEqual(result.world.calls.write.length, 1, `${label} still stores the report`);
    assert.strictEqual(result.world.calls.write[0].key, 'omega-ops/daily-check-2026-11-15');
    assert.ok(result.lines.some((line) => line.includes(`[omega-ops] ALERT code=daily-check-${id}`)), label);
    if (id !== 'grading' && id !== 'kpis') {
      assert.strictEqual(result.world.calls.regrade, 0, label);
    }
  }

  const liveNoMarker = await runCase((data) => {
    data.markers['0300'] = null;
    data.markers['1000'] = { ok: false };
  });
  assertCheck(liveNoMarker.report, 'pulls', 'ok', 'ok', 'complete pull doc');
  assert.strictEqual(liveNoMarker.report.ok, true);
  assert.strictEqual(liveNoMarker.report.checks.find((row) => row.id === 'pulls').evidence.slots['0300'].marker, false);

  const partialDoc = await runCase((data) => {
    data.markers['0300'] = null;
    data.pulls['0300'] = livePullDoc('0300', '2026-11-15T08:00:00.000Z');
    data.pulls['0300'].errors = ['NBA: HTTP 500'];
  });
  assertCheck(partialDoc.report, 'pulls', 'fail', 'partial-0300-pull', 'partial live pull');
  assert.strictEqual(partialDoc.report.ok, false);

  const lineMiss = await runCase((data) => {
    data.markers['1000'] = null;
    data.pulls['1000'] = null;
    data.moves = { events: [{ checks: [{ slot: '1000', at: '2026-11-15T15:00:00.000Z' }] }] };
  });
  assertCheck(lineMiss.report, 'pulls', 'fail', 'missed-1000-pull', 'line-move without a pull doc');

  const newsWarn = await runCase((data) => { data.news = null; });
  const newsWarnEv = checkOf(newsWarn.report, 'news').evidence;
  assert.ok(!Object.prototype.hasOwnProperty.call(newsWarnEv, 'firstSnapshotExpected'));
  assert.deepStrictEqual(Object.keys(newsWarnEv).sort(), ['code']);

  const newsFirstDay = await runCase((data, deps) => {
    data.news = null;
    deps.date = NEWS_FIRST_DAY;
  });
  assertCheck(newsFirstDay.report, 'news', 'fail', 'news-missing', 'news on first snapshot day');
  assert.ok(!Object.prototype.hasOwnProperty.call(checkOf(newsFirstDay.report, 'news').evidence, 'firstSnapshotExpected'));
  assert.strictEqual(newsFirstDay.report.ok, false);

  const noSlate = await runCase((data) => {
    data.sports = [];
    data.markers = {};
    data.pulls = {};
    data.starts = {};
    data.moves = null;
  });
  assertCheck(noSlate.report, 'pulls', 'ok', 'no-slate', 'no slate');
  assert.strictEqual(noSlate.report.ok, true, 'no-slate does not blank the card');

  const exactWall = await runCase((data) => {
    data.card.generatedAt = new Date(wall).toISOString();
  });
  assertCheck(exactWall.report, 'card', 'ok', 'ok', '11:00 ET');

  const spreadOk = await runCase((data) => {
    data.card.picks.forEach((pick, index) => {
      pick.pick = `${pick.pick.split(' ')[0]} -3.5`;
      pick.betType = 'spread';
      pick.pBet = 0.55;
      pick.evRaw = 0.55 * DEC - 1;
      pick.winProbability = '55.0%';
      data.card.parlayLegs[0].legs[index].pick = pick.pick;
      data.card.parlayLegs[0].legs[index].pBet = 0.55;
    });
    priceParlay(data.card);
    resync(data);
  });
  assertCheck(spreadOk.report, 'bounds', 'ok', 'ok', 'spread inside');
  assertCheck(spreadOk.report, 'card', 'ok', 'ok', 'spread shape');

  const spreadEdge = await runCase((data) => {
    data.card.picks[0].pick = 'Lions -3.5';
    data.card.picks[0].betType = 'spread';
    data.card.picks[0].pBet = 0.3;
    data.card.picks[0].evRaw = 0.3 * DEC - 1;
    data.card.picks[0].winProbability = '30.0%';
    data.card.parlayLegs[0].legs[0].pick = 'Lions -3.5';
    data.card.parlayLegs[0].legs[0].pBet = 0.3;
    priceParlay(data.card);
    resync(data);
  });
  assertCheck(spreadEdge.report, 'bounds', 'ok', 'ok', 'spread 0.30');

  const missingCard = await runCase((data) => { data.card = null; });
  assertCheck(missingCard.report, 'card', 'fail', 'card-missing', 'card missing');
  assertCheck(missingCard.report, 'mirror', 'fail', 'card-missing', 'mirror follows card');
  assertCheck(missingCard.report, 'bounds', 'fail', 'card-missing', 'bounds follows card');
  assertCheck(missingCard.report, 'grading', 'ok', 'ok', 'yesterday still grades');
  assert.strictEqual(missingCard.world.calls.mirror.length, 0);
  assert.strictEqual(missingCard.world.calls.v1.length, 0);

  const mirrorFixed = await runCase((data) => {
    data.mirror = { rows: [] };
    data.mirrorAfter = mirrorRowsOf(data.card);
  });
  assertCheck(mirrorFixed.report, 'mirror', 'fixed', 'fixed', 'mirror fix');
  assert.strictEqual(mirrorFixed.world.calls.mirror.length, 1);
  assert.strictEqual(mirrorFixed.world.calls.mirror[0].date, DATE);
  assert.strictEqual(mirrorFixed.world.calls.mirror[0].card, mirrorFixed.world.data.card);
  assert.strictEqual(mirrorFixed.world.calls.v1.length, 0);
  assert.strictEqual(mirrorFixed.report.ok, true);
  assert.ok(mirrorFixed.lines.some((line) => line.includes('code=daily-check-mirror') && line.includes('status=fixed')));

  const mirrorStill = await runCase((data) => { data.mirror = { rows: [] }; });
  assertCheck(mirrorStill.report, 'mirror', 'fail', 'mirror', 'mirror still bad');
  assert.strictEqual(mirrorStill.world.calls.mirror.length, 1);
  assert.deepStrictEqual(mirrorStill.report.checks.find((row) => row.id === 'mirror').evidence.corrected, ['mirror']);

  const mirrorUnconfigured = await runCase((data) => {
    data.mirror = { rows: null, error: 'mirror-unconfigured' };
  });
  assertCheck(mirrorUnconfigured.report, 'mirror', 'fail', 'mirror', 'mirror unconfigured');
  assert.strictEqual(mirrorUnconfigured.world.calls.mirror.length, 0);
  assert.strictEqual(mirrorUnconfigured.report.checks.find((row) => row.id === 'mirror').evidence.mirror, 'mirror-unconfigured');

  const v1Fixed = await runCase((data) => {
    data.v1 = null;
    data.v1After = v1Of(data.card);
  });
  assertCheck(v1Fixed.report, 'mirror', 'fixed', 'fixed', 'v1 missing fix');
  assert.strictEqual(v1Fixed.world.calls.v1.length, 1);
  assert.strictEqual(v1Fixed.world.calls.v1[0].card, v1Fixed.world.data.card);
  assert.strictEqual(v1Fixed.world.calls.mirror.length, 0);

  const v1Still = await runCase((data) => {
    data.v1 = { picks: [{ pick: 'Other ML', odds: '-110', book: 'draftkings', units: 0.5 }] };
  });
  assertCheck(v1Still.report, 'mirror', 'fail', 'v1', 'v1 still bad');
  assert.strictEqual(v1Still.world.calls.v1.length, 1);
  assert.strictEqual(v1Still.world.calls.mirror.length, 0);

  const bothFixed = await runCase((data) => {
    data.mirror = { rows: [{ kind: 'straight', pick: 'Other ML', odds: '-110', book: 'draftkings', units: 0.5 }] };
    data.mirrorAfter = mirrorRowsOf(data.card);
    data.v1 = { picks: [] };
    data.v1After = v1Of(data.card);
  });
  assertCheck(bothFixed.report, 'mirror', 'fixed', 'fixed', 'both fix');
  assert.strictEqual(bothFixed.world.calls.mirror.length, 1);
  assert.strictEqual(bothFixed.world.calls.v1.length, 1);
  assert.strictEqual(bothFixed.world.calls.regrade, 0);

  const mirrorThrows = await runCase((data, deps) => {
    data.mirror = { rows: [] };
    data.v1 = null;
    data.v1After = v1Of(data.card);
    deps.mirrorTodayCard = async () => { throw new Error('mirror down'); };
  });
  assertCheck(mirrorThrows.report, 'mirror', 'fail', 'mirror', 'mirror throw');
  assert.strictEqual(mirrorThrows.world.calls.v1.length, 1);
  assertCheck(mirrorThrows.report, 'pulls', 'ok', 'ok', 'mirror throw isolation');

  const badGrade = clone(goodCache);
  badGrade.days[0].picks[0].result = 'loss';
  badGrade.cumulative = aggregateDays(badGrade.days).cumulative;

  const gradeFixed = await runCase((data) => {
    data.cache = clone(badGrade);
    data.cacheAfter = clone(goodCache);
  });
  assertCheck(gradeFixed.report, 'grading', 'fixed', 'fixed', 'grade fix');
  assertCheck(gradeFixed.report, 'kpis', 'ok', 'ok', 'kpi after grade fix');
  assert.strictEqual(gradeFixed.world.calls.regrade, 1);
  assert.strictEqual(gradeFixed.report.ok, true);

  const gradeStill = await runCase((data) => { data.cache = clone(badGrade); });
  assertCheck(gradeStill.report, 'grading', 'fail', 'mismatch', 'grade still bad');
  assert.strictEqual(gradeStill.world.calls.regrade, 1);
  assert.deepStrictEqual(gradeStill.report.checks.find((row) => row.id === 'grading').evidence.corrected, ['results-cache']);

  const ungraded = await runCase((data) => {
    const pending = clone(goodCache);
    for (const pick of pending.days[0].picks) {
      if (pick.sport !== 'PARLAY') pick.result = 'pending';
    }
    pending.days[0].parlayResult = 'pending';
    pending.cumulative = aggregateDays(pending.days).cumulative;
    data.cache = pending;
  });
  assertCheck(ungraded.report, 'grading', 'fail', 'ungraded', 'pending after final');
  assert.strictEqual(ungraded.world.calls.regrade, 1);

  const emptyDay = await runCase((data) => {
    data.cache = { days: [], cumulative: aggregateDays([]).cumulative };
  });
  assertCheck(emptyDay.report, 'grading', 'fail', 'ungraded', 'no graded day');
  assertCheck(emptyDay.report, 'kpis', 'ok', 'ok', 'empty kpi matches');
  assert.strictEqual(emptyDay.world.calls.regrade, 1);

  const preGame = await runCase((data, deps) => {
    data.games = data.games.map((game) => Object.assign({}, game, { state: 'pre', completed: false }));
    deps.dryRun = true;
  });
  assertCheck(preGame.report, 'grading', 'fail', 'mismatch', 'pregame uses live grader');
  assert.strictEqual(preGame.world.calls.regrade, 0);
  assert.strictEqual(preGame.world.calls.write.length, 0);

  const kpiFixed = await runCase((data) => {
    data.cache = clone(goodCache);
    data.cache.cumulative = Object.assign({}, data.cache.cumulative, { wins: 0 });
    data.cacheAfter = clone(goodCache);
  });
  assertCheck(kpiFixed.report, 'grading', 'ok', 'ok', 'grades already ok');
  assertCheck(kpiFixed.report, 'kpis', 'fixed', 'fixed', 'kpi fix');
  assert.strictEqual(kpiFixed.world.calls.regrade, 1);
  assert.strictEqual(kpiFixed.report.ok, true);

  const kpiStill = await runCase((data) => {
    data.cache = clone(goodCache);
    data.cache.cumulative = Object.assign({}, data.cache.cumulative, { wins: 0, roi: '0.0%' });
  });
  assertCheck(kpiStill.report, 'kpis', 'fail', 'kpi-mismatch', 'kpi still bad');
  assert.strictEqual(kpiStill.world.calls.regrade, 1);

  const kpiMissing = await runCase((data) => { data.cache = null; });
  assertCheck(kpiMissing.report, 'kpis', 'fail', 'kpi-cache-missing', 'kpi cache missing');
  assert.strictEqual(kpiMissing.world.calls.regrade, 1);

  const bothRebuild = await runCase((data) => {
    const bad = clone(badGrade);
    bad.cumulative = Object.assign({}, bad.cumulative, { wins: 99 });
    data.cache = bad;
    data.cacheAfter = clone(goodCache);
  });
  assertCheck(bothRebuild.report, 'grading', 'fixed', 'fixed', 'shared rebuild grade');
  assertCheck(bothRebuild.report, 'kpis', 'ok', 'ok', 'shared rebuild kpi');
  assert.strictEqual(bothRebuild.world.calls.regrade, 1);

  const dry = await runCase((data, deps) => {
    data.mirror = { rows: [] };
    data.v1 = null;
    data.cache = clone(badGrade);
    deps.dryRun = true;
    deps.webhookUrl = 'https://ops.example/hook';
  });
  assert.strictEqual(dry.report.dryRun, true);
  assertCheck(dry.report, 'mirror', 'fail', 'mirror-and-v1', 'dry mirror');
  assertCheck(dry.report, 'grading', 'fail', 'mismatch', 'dry grade');
  assert.strictEqual(dry.world.calls.mirror.length, 0);
  assert.strictEqual(dry.world.calls.v1.length, 0);
  assert.strictEqual(dry.world.calls.regrade, 0);
  assert.strictEqual(dry.world.calls.write.length, 0);
  assert.strictEqual(dry.world.calls.webhook.length, 0);

  const replay = await runCase((data, deps) => {
    data.news = null;
    data.mirror = { rows: [] };
    deps.env = { OMEGA_REPLAY_NO_WRITE: 'on' };
    deps.webhookUrl = 'https://ops.example/hook';
  });
  assert.strictEqual(replay.report.dryRun, true);
  assert.strictEqual(replay.world.calls.write.length, 0);
  assert.strictEqual(replay.world.calls.mirror.length, 0);
  assert.strictEqual(replay.world.calls.webhook.length, 0);

  const bodyDry = await runCase((data, deps) => {
    data.v1 = null;
    deps.event = { body: JSON.stringify({ dryRun: 1 }) };
  });
  assert.strictEqual(bodyDry.report.dryRun, true);
  assert.strictEqual(bodyDry.world.calls.v1.length, 0);
  assert.strictEqual(bodyDry.world.calls.write.length, 0);

  const flagged = await runCase((_data, deps) => {
    deps.env = { OMEGA_DAILY_CHECK: 'off' };
  });
  assert.strictEqual(flagged.report.skipped, 'flag-off');
  assert.deepStrictEqual(flagged.report.checks, []);
  assert.strictEqual(flagged.world.calls.write.length, 0);
  assert.strictEqual(flagged.world.calls.regrade, 0);
  assert.ok(!flagged.lines.some((line) => line.includes('daily-check-')));

  const isolated = await runCase((_data, deps) => {
    deps.readNews = async () => { throw new Error('news boom Bearer secret-token'); };
  });
  assertCheck(isolated.report, 'news', 'fail', 'check-failed', 'news throw');
  assertCheck(isolated.report, 'credits', 'ok', 'ok', 'credits after news throw');
  assertCheck(isolated.report, 'pulls', 'ok', 'ok', 'pulls after news throw');
  const newsEvidence = JSON.stringify(isolated.report.checks.find((row) => row.id === 'news').evidence);
  assert.ok(!newsEvidence.includes('secret-token'));
  assert.ok(newsEvidence.includes('Bearer [redacted]'));

  const hooked = await runCase((_data, deps) => {
    deps.env = Object.assign({}, deps.env, { OMEGA_OPS_WEBHOOK_URL: 'https://ops.example/hook' });
  });
  assert.strictEqual(hooked.world.calls.webhook.length, 1);
  assert.strictEqual(hooked.world.calls.webhook[0].url, 'https://ops.example/hook');
  assert.strictEqual(hooked.world.calls.webhook[0].report, hooked.report);
  assert.strictEqual(hooked.report.ok, true);

  const soft = await runCase((_data, deps, calls) => {
    deps.webhookUrl = 'https://ops.example/hook';
    deps.postWebhook = async () => { throw new Error('hook down Bearer secret-token'); };
    calls.webhook = calls.webhook;
  });
  assert.strictEqual(soft.report.ok, true);
  assert.ok(soft.warns.some((line) => line.includes('dailyCheckWebhookSoftFail')));
  assert.ok(!soft.warns.join('\n').includes('secret-token'));

  const softStatus = await runCase((_data, deps) => {
    deps.webhookUrl = 'https://ops.example/hook';
    deps.postWebhook = async () => ({ ok: false, status: 503 });
  });
  assert.ok(softStatus.warns.some((line) => line.includes('dailyCheckWebhookSoftFail') && line.includes('503')));

  const storeDown = await runCase((_data, deps) => {
    deps.writeReport = async () => { throw new Error('store down Bearer secret-token'); };
  });
  assert.strictEqual(storeDown.report.ok, true);
  assert.ok(storeDown.lines.some((line) => line.includes('daily-check-store-failed')));
  assert.ok(!storeDown.lines.join('\n').includes('secret-token'));

  const creditsOk = await runCase((data) => {
    data.credits = { remaining: 12000, source: 'audit-log' };
  });
  assertCheck(creditsOk.report, 'credits', 'ok', 'ok', '12000 credits');
  assert.strictEqual(creditsOk.report.ok, true);

  const directBounds = assessBounds({
    picks: [{
      pick: 'Lions ML', odds: '-110', book: 'draftkings', units: 0.5, pBet: 0.55,
      stakeUsd: 75, winProbability: '55.0%', evRaw: 0.55 * DEC - 1, grade: 'B',
    }],
    parlayLegs: [],
  });
  assert.strictEqual(directBounds.status, 'ok');

  const bg = await backgroundHandle(
    { queryStringParameters: { date: DATE } },
    makeWorld().deps
  );
  const bgBody = JSON.parse(bg.body);
  assert.strictEqual(bg.statusCode, 200);
  assert.strictEqual(bgBody.ok, true);
  assert.strictEqual(bgBody.date, DATE);
  assert.strictEqual(bgBody.dryRun, false);
  assert.strictEqual(bgBody.skipped, null);
  assert.ok(!/alpha|omega/i.test(bg.body));

  const bgOff = await backgroundHandle({}, { env: { OMEGA_DAILY_CHECK: 'off' } });
  assert.deepStrictEqual(JSON.parse(bgOff.body), { ok: true, skipped: 'flag-off' });

  const bgBad = await backgroundHandle({ queryStringParameters: { date: 'nope' } }, { env: {} });
  assert.deepStrictEqual(JSON.parse(bgBad.body), { ok: false, error: 'check-failed' });

  await withEnv({ OMEGA_DAILY_CHECK: 'off' }, async () => {
    const res = await backgroundHandler({});
    assert.strictEqual(JSON.parse(res.body).skipped, 'flag-off');
  });

  const stored = { schema: 'omega-ops-daily-check-v1', date: DATE, ok: true, checks: [] };
  const got = await getHandle(
    { queryStringParameters: { date: DATE } },
    { store: { async get(key) { assert.strictEqual(key, dailyCheckKey(DATE)); return stored; } } }
  );
  const gotBody = JSON.parse(got.body);
  assert.strictEqual(got.statusCode, 200);
  assert.strictEqual(gotBody.ok, true);
  assert.deepStrictEqual(gotBody.report, stored);
  assert.strictEqual(gotBody.note, 'Ops signal only. Does not change the card.');
  assert.ok(!/alpha|omega/i.test(gotBody.note));

  const missing = await getHandle(
    { queryStringParameters: { date: DATE } },
    { store: { async get() { return null; } } }
  );
  assert.strictEqual(JSON.parse(missing.body).report, null);
  assert.strictEqual(JSON.parse(missing.body).ok, true);

  const badGet = await getHandle({ queryStringParameters: { date: 'yesterday' } }, {});
  assert.strictEqual(badGet.statusCode, 400);
  const options = await getHandle({ httpMethod: 'OPTIONS' }, {});
  assert.strictEqual(options.statusCode, 200);
  const blown = await getHandle(
    { queryStringParameters: { date: DATE } },
    { store: { async get() { throw new Error('blob down Bearer secret-token'); } } }
  );
  const blownBody = JSON.parse(blown.body);
  assert.strictEqual(blown.statusCode, 200);
  assert.strictEqual(blownBody.ok, false);
  assert.ok(!blownBody.error.includes('secret-token'));

  for (const rel of [
    'netlify/functions/check-omega-daily-background.js',
    'netlify/functions/get-omega-daily-check.js',
  ]) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/exports\.config/.test(src), rel);
    assert.ok(!/\bschedule\b/.test(src), rel);
  }
  const graderSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/grade-boards-omega.js'), 'utf8');
  assert.ok(!/exports\.config/.test(graderSrc));
  assert.ok(graderSrc.includes('check-omega-daily-background'));

  const origFetch = global.fetch;
  try {
    await withEnv({ OMEGA_DAILY_CHECK: null, OMEGA_V2_BOARD_GRADER: null, URL: 'https://webetsocial.com' }, async () => {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(String(url));
        return { status: 202, ok: true };
      };
      const res = await gradeBoards({ queryStringParameters: { dryRun: '1', date: PREV } });
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.queued, true);
      assert.strictEqual(body.status, 202);
      assert.strictEqual(calls.length, 2);
      assert.ok(calls[0].includes('/.netlify/functions/check-omega-daily-background?'));
      assert.ok(calls[0].includes('dryRun=1'));
      assert.ok(calls[0].includes(`date=${PREV}`));
      assert.ok(calls[1].endsWith('/.netlify/functions/grade-boards-omega-background'));
    });

    await withEnv({ OMEGA_DAILY_CHECK: null, OMEGA_V2_BOARD_GRADER: null, URL: 'https://webetsocial.com' }, async () => {
      global.fetch = async (url) => {
        if (String(url).includes('check-omega-daily')) throw new Error('daily down');
        return { status: 202, ok: true };
      };
      const res = await withSpy(async (lines) => {
        const out = await gradeBoards({});
        return { out, lines };
      });
      const body = JSON.parse(res.out.body);
      assert.strictEqual(body.queued, true);
      assert.strictEqual(body.status, 202);
      assert.ok(res.lines.some((line) => line.includes('daily-check trigger failed')));
    });

    await withEnv({ OMEGA_V2_BOARD_GRADER: 'off', OMEGA_DAILY_CHECK: null, URL: 'https://webetsocial.com' }, async () => {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(String(url));
        return { status: 202, ok: true };
      };
      const res = await gradeBoards({});
      assert.deepStrictEqual(JSON.parse(res.body), { ok: true, skipped: 'kill-switch' });
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].includes('check-omega-daily-background'));
    });

    await withEnv({ OMEGA_DAILY_CHECK: 'off', OMEGA_V2_BOARD_GRADER: null, URL: 'https://webetsocial.com' }, async () => {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(String(url));
        return { status: 202, ok: true };
      };
      const res = await gradeBoards({});
      assert.strictEqual(JSON.parse(res.body).queued, true);
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].includes('grade-boards-omega-background'));
    });

    await withEnv({ OMEGA_DAILY_CHECK: null, OMEGA_V2_BOARD_GRADER: null, URL: 'https://webetsocial.com' }, async () => {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        return { status: 500, ok: false };
      };
      const res = await gradeBoards({});
      const body = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error, 'background trigger HTTP 500');
      assert.ok(calls >= 1);
    });

    await withEnv({ OMEGA_DAILY_CHECK: null, OMEGA_V2_BOARD_GRADER: null }, async () => {
      let calls = 0;
      global.fetch = async () => { calls += 1; return { status: 202, ok: true }; };
      const { etParts } = require('./netlify/functions/lib/et-schedule');
      const nowEt = etParts(new Date());
      const minutes = nowEt.hour * 60 + nowEt.minute;
      const inside = Math.abs(minutes - (11 * 60 + 30)) <= 10;
      const res = await gradeBoards({ body: JSON.stringify({ next_run: '2026-11-15T12:00:00.000Z' }) });
      const body = JSON.parse(res.body);
      if (inside) {
        assert.strictEqual(body.queued, true);
        assert.ok(calls >= 1);
      } else {
        assert.strictEqual(body.skipped, 'et-guard');
        assert.strictEqual(calls, 0);
      }
    });

    await withEnv({ OMEGA_DAILY_CHECK: null, OMEGA_V2_BOARD_GRADER: null, URL: 'https://webetsocial.com' }, async () => {
      global.fetch = (url, init) => {
        if (String(url).includes('check-omega-daily')) {
          return new Promise((_resolve, reject) => {
            const signal = init && init.signal;
            if (signal) {
              const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort);
            }
          });
        }
        return Promise.resolve({ status: 202, ok: true });
      };
      const started = Date.now();
      const res = await gradeBoards({});
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 2000, `timeout too short ${elapsed}`);
      assert.ok(elapsed < 5000, `grader blocked ${elapsed}`);
      assert.strictEqual(JSON.parse(res.body).queued, true);
    });
  } finally {
    global.fetch = origFetch;
  }

  const foreignCommit = await runCase((data) => {
    data.external.commits.push({
      sha: 'f'.repeat(40),
      commit: {
        message: 'foreign: not from deploy.sh',
        committer: { date: '2026-11-15T15:30:00.000Z' },
      },
    });
  });
  assertCheck(foreignCommit.report, 'external-changes', 'fail', 'foreign-commit', 'foreign commit');
  const foreignEv = checkOf(foreignCommit.report, 'external-changes').evidence;
  const foreignHit = foreignEv.flagged.find((row) => row.sha === 'f'.repeat(40));
  assert.ok(foreignHit, 'foreign commit evidence');
  assert.strictEqual(foreignHit.timeEt, '2026-11-15 10:30:00 ET');
  assert.strictEqual(foreignHit.title, 'foreign: not from deploy.sh');
  assert.strictEqual(foreignHit.deployId, null);
  assert.strictEqual(foreignCommit.world.calls.mirror.length, 0);
  assert.strictEqual(foreignCommit.world.calls.v1.length, 0);
  assert.strictEqual(foreignCommit.world.calls.regrade, 0);
  assert.strictEqual(foreignCommit.report.ok, false);
  assertCheck(foreignCommit.report, 'pulls', 'ok', 'ok', 'foreign commit leaves pulls');

  const rawDeploy = await runCase((data) => {
    data.external.deploys.push({
      id: 'dep-raw',
      state: 'ready',
      context: 'production',
      title: null,
      commit_ref: null,
      created_at: '2026-11-15T12:00:00.000Z',
      deploy_source: 'api',
    });
  });
  assertCheck(rawDeploy.report, 'external-changes', 'fail', 'untitled-deploy', 'raw netlify deploy');
  const rawHit = checkOf(rawDeploy.report, 'external-changes').evidence.flagged.find((row) => row.deployId === 'dep-raw');
  assert.ok(rawHit, 'raw deploy evidence');
  assert.strictEqual(rawHit.timeEt, '2026-11-15 07:00:00 ET');
  assert.strictEqual(rawHit.title, null);
  assert.strictEqual(rawHit.sha, null);
  assert.ok(!checkOf(rawDeploy.report, 'external-changes').evidence.flagged.some((row) => row.deployId === 'dep-live'));
  assert.strictEqual(rawDeploy.world.calls.regrade, 0);
  assertCheck(rawDeploy.report, 'card', 'ok', 'ok', 'raw deploy leaves card');

  const foreignDeploy = await runCase((data) => {
    data.external.deploys.push({
      id: 'dep-foreign',
      state: 'ready',
      context: 'production',
      title: 'manual ship',
      commit_ref: 'e'.repeat(40),
      created_at: '2026-11-15T13:00:00.000Z',
      deploy_source: 'api',
    });
  });
  assertCheck(foreignDeploy.report, 'external-changes', 'fail', 'foreign-deploy', 'titled deploy outside the ledger');
  const titledHit = checkOf(foreignDeploy.report, 'external-changes').evidence.flagged.find((row) => row.deployId === 'dep-foreign');
  assert.strictEqual(titledHit.sha, 'e'.repeat(40));
  assert.strictEqual(titledHit.title, 'manual ship');
  assert.strictEqual(titledHit.timeEt, '2026-11-15 08:00:00 ET');

  const unknownActor = await runCase((data) => {
    data.external.ledger[0].actor = 'stranger';
  });
  assertCheck(unknownActor.report, 'external-changes', 'fail', 'unknown-actor', 'unknown actor');
  const actorHit = checkOf(unknownActor.report, 'external-changes').evidence.flagged.find((row) => row.code === 'unknown-actor');
  assert.strictEqual(actorHit.sha, 'a'.repeat(40));
  assert.strictEqual(actorHit.actor, 'stranger');
  assert.strictEqual(actorHit.timeEt, '2026-11-14 11:00:00 ET');
  assert.strictEqual(actorHit.title, null);
  assert.strictEqual(unknownActor.world.calls.mirror.length, 0);
  assert.strictEqual(unknownActor.world.calls.regrade, 0);

  const allowedActor = await runCase((data, deps) => {
    data.external.ledger[0].actor = 'nightly';
    deps.env = Object.assign({}, deps.env, { OMEGA_DEPLOY_ACTORS: 'edge-executor, nightly' });
  });
  assertCheck(allowedActor.report, 'external-changes', 'ok', 'ok', 'comma allow list');

  const emptyLedger = await runCase((data) => {
    data.external.ledger = [];
    data.external.commits.push({
      sha: 'f'.repeat(40),
      commit: {
        message: 'foreign: not from deploy.sh',
        committer: { date: '2026-11-15T15:30:00.000Z' },
      },
    });
    data.external.deploys.push({
      id: 'dep-raw',
      state: 'ready',
      context: 'production',
      title: null,
      commit_ref: null,
      created_at: '2026-11-15T12:00:00.000Z',
    });
  });
  assertCheck(emptyLedger.report, 'external-changes', 'warn', 'baseline-pending', 'empty ledger');
  assert.ok(!checkOf(emptyLedger.report, 'external-changes').evidence.flagged);
  assert.strictEqual(emptyLedger.report.ok, false);
  assertCheck(emptyLedger.report, 'pulls', 'ok', 'ok', 'baseline leaves pulls');
  assertCheck(emptyLedger.report, 'credits', 'ok', 'ok', 'baseline leaves credits');

  const networkDown = await runCase((data) => {
    data.external.failFetch = true;
  });
  assertCheck(networkDown.report, 'external-changes', 'warn', 'github-unreachable', 'network failure');
  assert.strictEqual(networkDown.report.ok, false);
  for (const id of ['pulls', 'card', 'mirror', 'bounds', 'grading', 'kpis', 'closes', 'news', 'credits']) {
    assertCheck(networkDown.report, id, 'ok', 'ok', `network still runs ${id}`);
  }
  assert.strictEqual(networkDown.world.calls.mirror.length, 0);
  assert.strictEqual(networkDown.world.calls.regrade, 0);
  assert.ok(!JSON.stringify(networkDown.report).includes(TEST_BLOB_TOKEN));

  const missingToken = await runCase((_data, deps) => {
    deps.env = { NETLIFY_AUTH_TOKEN: '' };
  });
  assertCheck(missingToken.report, 'external-changes', 'warn', 'netlify-unreadable', 'missing netlify token');
  assertCheck(missingToken.report, 'pulls', 'ok', 'ok', 'missing token leaves pulls');

  const siteOnly = await runCase((data) => {
    data.external.siteLedger = data.external.ledger.map((row) => Object.assign({}, row, { commits: row.commits.slice() }));
    data.external.ledger = [];
    data.external.legacyMissing = true;
  });
  assertCheck(siteOnly.report, 'external-changes', 'ok', 'ok', 'site ledger namespace');
  assert.strictEqual(checkOf(siteOnly.report, 'external-changes').evidence.ledger, 1);
  assert.ok(!JSON.stringify(siteOnly.report).includes(TEST_BLOB_TOKEN));

  const bothNamespaces = await runCase((data) => {
    data.external.siteLedger = data.external.ledger.map((row) => Object.assign({}, row, { commits: row.commits.slice() }));
  });
  assertCheck(bothNamespaces.report, 'external-changes', 'ok', 'ok', 'deduped ledger');
  assert.strictEqual(checkOf(bothNamespaces.report, 'external-changes').evidence.ledger, 1);

  const siteActor = await runCase((data) => {
    data.external.ledger = [];
    data.external.legacyMissing = true;
    data.external.siteLedger = [{
      sha: 'a'.repeat(40),
      prevMain: 'b'.repeat(40),
      commits: ['a'.repeat(40)],
      actor: 'stranger',
      at: '2026-11-14T16:00:00.000Z',
    }];
  });
  assertCheck(siteActor.report, 'external-changes', 'fail', 'unknown-actor', 'site ledger actor');

  function withService(data, deps, supabase) {
    data.candidates = { candidates: [] };
    deps.env = Object.assign({}, deps.env, { SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY });
    data.external.supabase = supabase;
  }

  const fromPickClv = await runCase((data, deps) => {
    withService(data, deps, {
      pickClv: data.prevCard.picks.map((row, index) => ({
        pick: row.pick,
        matchup: row.matchup,
        closing_novig: index === 2 ? null : 0.51,
        closing_odds: -110,
      })),
    });
  });
  assertCheck(fromPickClv.report, 'closes', 'ok', 'ok', 'pick_clv candidate close');
  assert.ok(!JSON.stringify(fromPickClv.report).includes(TEST_SERVICE_KEY));
  const pickHits = fromPickClv.world.data.external.hits || [];
  assert.ok(pickHits.some((href) => href.includes('/rest/v1/pick_clv')));
  assert.ok(!pickHits.some((href) => href.includes('/rest/v1/games')), 'pick_clv covers every pick');

  const fromSnaps = await runCase((data, deps) => {
    withService(data, deps, {
      pickClv: [],
      games: [
        { game_id: 'g-lions', home_team: 'Bears', away_team: 'Lions', commence_time: '2026-11-14T18:00:00.000Z' },
        { game_id: 'g-pack', home_team: 'Vikings', away_team: 'Packers', commence_time: '2026-11-14T18:00:00.000Z' },
        { game_id: 'g-chiefs', home_team: 'Raiders', away_team: 'Chiefs', commence_time: '2026-11-15T01:00:00.000Z' },
        { game_id: 'g-sc', home_team: 'South Carolina', away_team: 'Clemson', commence_time: '2026-11-14T18:00:00.000Z' },
      ],
      snapshots: [
        { game_id: 'g-lions', market: 'h2h', side: 'Lions', price: -108 },
        { game_id: 'g-pack', market: 'h2h', side: 'Packers', price: -115 },
        { game_id: 'g-chiefs', market: 'h2h', side: 'Chiefs', price: -120 },
        { game_id: 'g-sc', market: 'h2h', side: 'Carolina', price: -110 },
      ],
    });
  });
  assertCheck(fromSnaps.report, 'closes', 'ok', 'ok', 'snapshot candidate close');
  const snapHits = fromSnaps.world.data.external.hits || [];
  const gameHit = snapHits.find((href) => href.includes('/rest/v1/games'));
  const snapHit = snapHits.find((href) => href.includes('/rest/v1/odds_snapshots'));
  assert.ok(gameHit && gameHit.includes('2026-11-13') && gameHit.includes('2026-11-16'), gameHit);
  assert.ok(snapHit && snapHit.includes('book=eq.pinnacle') && snapHit.includes('line_type=eq.closing'), snapHit);
  assert.ok(!JSON.stringify(fromSnaps.report).includes(TEST_SERVICE_KEY));

  const wrongMarket = await runCase((data, deps) => {
    data.prevCard.picks[0].pick = 'Lions -3.5';
    data.clv.picks[0].pick = 'Lions -3.5';
    withService(data, deps, {
      pickClv: data.prevCard.picks.slice(1).map((row) => ({
        pick: row.pick,
        matchup: row.matchup,
        closing_novig: 0.52,
      })),
      games: [
        { game_id: 'g-lions', home_team: 'Bears', away_team: 'Lions', commence_time: '2026-11-14T18:00:00.000Z' },
      ],
      snapshots: [
        { game_id: 'g-lions', market: 'h2h', side: 'Lions', price: -110 },
      ],
    });
  });
  assertCheck(wrongMarket.report, 'closes', 'fail', 'candidate-close-missing', 'h2h does not close a spread');

  const spreadSnap = await runCase((data, deps) => {
    data.prevCard.picks[0].pick = 'Lions -3.5';
    data.clv.picks[0].pick = 'Lions -3.5';
    withService(data, deps, {
      pickClv: data.prevCard.picks.slice(1).map((row) => ({
        pick: row.pick,
        matchup: row.matchup,
        closing_novig: 0.52,
      })),
      games: [
        { game_id: 'g-lions', home_team: 'Bears', away_team: 'Lions', commence_time: '2026-11-14T18:00:00.000Z' },
      ],
      snapshots: [
        { game_id: 'g-lions', market: 'spreads', side: 'Lions', point: -3, price: -110 },
      ],
    });
  });
  assertCheck(spreadSnap.report, 'closes', 'ok', 'ok', 'spread snapshot close');

  const decoyTeam = await runCase((data, deps) => {
    withService(data, deps, {
      pickClv: [],
      games: [
        { game_id: 'g-sc', home_team: 'South Carolina', away_team: 'Clemson', commence_time: '2026-11-14T18:00:00.000Z' },
      ],
      snapshots: [
        { game_id: 'g-sc', market: 'h2h', side: 'Carolina', price: -110 },
      ],
    });
  });
  assertCheck(decoyTeam.report, 'closes', 'fail', 'candidate-close-missing', 'carolina is not south carolina');

  const storedEmpty = await runCase((data, deps) => {
    withService(data, deps, { pickClv: [], games: [], snapshots: [] });
  });
  assertCheck(storedEmpty.report, 'closes', 'fail', 'candidate-close-missing', 'stored closes empty');
  assert.ok(!JSON.stringify(storedEmpty.report).includes(TEST_SERVICE_KEY));

  const deploySrc = fs.readFileSync(path.join(__dirname, 'deploy.sh'), 'utf8');
  const deployAt = deploySrc.indexOf('npx netlify deploy --prod');
  const tokenLine = 'NETLIFY_AUTH_TOKEN_LEDGER="$(npx netlify env:get NETLIFY_AUTH_TOKEN 2>/dev/null)"';
  const tokenAt = deploySrc.indexOf(tokenLine);
  const pushAt = deploySrc.indexOf('git push origin HEAD:main');
  const prevAt = deploySrc.indexOf('PREV_MAIN=');
  const plusX = deploySrc.indexOf('set +x');
  const curlAt = deploySrc.indexOf('curl -sS -o /dev/null');
  assert.ok(deployAt > 0, 'deploy line');
  assert.ok(tokenAt > deployAt, 'ledger token follows the deploy');
  assert.ok(plusX > deployAt && plusX < tokenAt, 'set +x before the token');
  assert.ok(prevAt > 0 && prevAt < pushAt, 'prevMain is captured before the push');
  assert.ok(deploySrc.includes('https://api.netlify.com/api/v1/blobs/'));
  assert.ok(deploySrc.includes('/omega-ops/deploy-ledger/'));
  assert.ok(curlAt > tokenAt, 'curl follows the token');
  assert.ok(deploySrc.slice(curlAt, curlAt + 700).includes('|| true'), 'ledger curl soft-fails');
  assert.ok(deploySrc.includes('unset NETLIFY_AUTH_TOKEN_LEDGER'));
  assert.ok(!/echo\b[^\n]*NETLIFY_AUTH_TOKEN_LEDGER/.test(deploySrc));
  assert.ok(!deploySrc.includes('npx netlify blobs:set'));
  const dailySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/daily_check.js'), 'utf8');
  assert.ok(dailySrc.includes('const GITHUB_TIMEOUT_MS = 10 * 1000'));
  assert.ok(dailySrc.includes('https://api.github.com/repos/wcgbk/webet-social-intelligence/commits'));
  assert.ok(dailySrc.includes('/deploys?per_page=50'));
  assert.ok(dailySrc.includes("DEFAULT_DEPLOY_ACTORS = 'edge-executor'"));

  const readBack = await readDailyReport(DATE, {
    store: { async get(key) { return { key, ok: true }; } },
  });
  assert.strictEqual(readBack.ok, true);
  console.log('test-omega-daily-check: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
