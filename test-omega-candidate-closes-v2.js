'use strict';
/**
 * Sharp closes for every gate-evaluated candidate.
 * Due window, one Odds call per sport, 3-credit bookmakers math, cap,
 * de-vig + line match, REST fallback when setJSON throws, merge, DST guard.
 * No real Odds API. No real blob writes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const v2 = require('./netlify/functions/lib/omega-vnext/candidate_closes_v2');
const cand = require('./netlify/functions/lib/omega-vnext/clv_candidates');
const { noVigTwoWay, americanToImplied, americanCentsDiff } = require('./netlify/functions/lib/omega-vnext/odds_math');
const et = require('./netlify/functions/lib/et-schedule');
const { handle } = require('./netlify/functions/capture-candidate-closes');

const SHARP_BOOKS_PARAM = 'pinnacle,circasports,lowvig,betonlineag,bookmaker';
const NOW = new Date('2026-10-09T23:00:00.000Z');
const ET_DAY = '2026-10-09';
const YDAY = '2026-10-08';

function totals(point, over, under) {
  return {
    key: 'totals',
    outcomes: [
      { name: 'Over', price: over, point },
      { name: 'Under', price: under, point },
    ],
  };
}

function h2h(home, away, homePrice, awayPrice) {
  return {
    key: 'h2h',
    outcomes: [
      { name: home, price: homePrice },
      { name: away, price: awayPrice },
    ],
  };
}

function book(key, markets) {
  return { key, markets };
}

function event(home, away, markets, id) {
  return { id: id || `${away}-${home}`, home_team: home, away_team: away, bookmakers: markets };
}

function candidate(over) {
  return {
    sport: over.sport || 'MLB',
    sportKey: over.sportKey,
    eventId: over.eventId || null,
    matchup: over.matchup,
    homeTeam: over.homeTeam,
    awayTeam: over.awayTeam,
    commenceTime: over.commenceTime,
    market: over.market || 'Total',
    side: over.side,
    line: over.line == null ? 8.5 : over.line,
    odds: over.odds == null ? -110 : over.odds,
    book: over.book || 'draftkings',
    fair_sharp_p: over.fair_sharp_p == null ? 0.48 : over.fair_sharp_p,
    p_model: 0.55,
    coverProb: 0.54,
    ev: 0.04,
    reason: over.reason || 'yes',
    published: !!over.published,
    generatedAt: '2026-10-09T13:40:00.000Z',
    fair_sharp_p_at_generate: over.fair_sharp_p_at_generate,
    closeNoVig: over.closeNoVig,
    closeBook: over.closeBook,
    closeAt: over.closeAt,
    result: over.result,
  };
}

function mlbRow(name, commence, extra) {
  const home = `${name} Host`;
  const away = `${name} Away`;
  return candidate({
    matchup: `${away} @ ${home}`,
    homeTeam: home,
    awayTeam: away,
    commenceTime: commence,
    side: 'Over 8.5',
    line: 8.5,
    ...extra,
  });
}

function schedulerEvent() {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

function oddsUrls(calls) {
  return calls.filter((c) => c.kind === 'odds').map((c) => c.url);
}

(async () => {
  assert.strictEqual(v2.CREDITS_PER_CALL, 3);
  assert.strictEqual(v2.DEFAULT_CREDIT_CAP, 90);
  assert.ok(v2.SHARP_CLOSE_BOOKS.length <= 10);
  assert.deepStrictEqual(v2.SHARP_CLOSE_BOOKS, SHARP_BOOKS_PARAM.split(','));
  assert.strictEqual(v2.creditCap(undefined, {}), 90);
  assert.strictEqual(v2.creditCap(undefined, { OMEGA_CANDIDATE_CLOSE_CREDIT_CAP: '12' }), 12);

  const sample = v2.sharpOddsUrl('baseball_mlb', 'k');
  const parsed = new URL(sample);
  assert.strictEqual(parsed.pathname, '/v4/sports/baseball_mlb/odds');
  assert.strictEqual(parsed.searchParams.get('bookmakers'), SHARP_BOOKS_PARAM);
  assert.strictEqual(parsed.searchParams.get('markets'), 'h2h,spreads,totals');
  assert.strictEqual(parsed.searchParams.get('oddsFormat'), 'american');
  assert.strictEqual(parsed.searchParams.has('regions'), false);
  assert.ok(!sample.includes('historical'));
  assert.ok(!v2.eventsUrl('baseball_mlb', 'k').includes('/odds'));

  const t0 = NOW.getTime();
  assert.strictEqual(v2.isDue(new Date(t0 + 20 * 60 * 1000).toISOString(), t0), true);
  assert.strictEqual(v2.isDue(new Date(t0 + 20 * 60 * 1000 + 1).toISOString(), t0), false);
  assert.strictEqual(v2.isDue(new Date(t0 - 5 * 60 * 1000 + 1).toISOString(), t0), true);
  assert.strictEqual(v2.isDue(new Date(t0 - 5 * 60 * 1000).toISOString(), t0), false);
  assert.strictEqual(v2.isDue(new Date(t0 - 2 * 60 * 1000).toISOString(), t0), true);
  assert.strictEqual(v2.isDue(new Date(t0 + 21 * 60 * 1000).toISOString(), t0), false);
  assert.strictEqual(v2.isDue(null, t0), false);

  // -110/-110 is exactly 0.5. Pinnacle wins when both books post the line.
  const even = event('Host', 'Away', [
    book('pinnacle', [totals(8.5, -110, -110)]),
    book('circasports', [totals(8.5, -115, -105)]),
  ]);
  const evenClose = v2.devigCandidate(even, { market: 'Total', side: 'Over 8.5', line: 8.5 });
  assert.strictEqual(evenClose.closeNoVig, 0.5);
  assert.strictEqual(evenClose.pointAdjusted, false);
  assert.strictEqual(evenClose.book, 'pinnacle');
  assert.strictEqual(evenClose.line, 8.5);

  const shifted = noVigTwoWay(-115, -105).p1;
  const offLine = event('Host', 'Away', [
    book('pinnacle', [totals(7.5, -115, -105)]),
  ]);
  const offClose = v2.devigCandidate(offLine, { market: 'Total', side: 'Over 8.5', line: 8.5 });
  assert.strictEqual(offClose.pointAdjusted, true);
  assert.strictEqual(offClose.line, 7.5);
  assert.strictEqual(offClose.book, 'pinnacle');
  assert.strictEqual(offClose.closeNoVig, shifted);

  const circaExact = event('Host', 'Away', [
    book('pinnacle', [totals(7.5, -115, -105)]),
    book('circasports', [totals(8.5, -110, -110)]),
  ]);
  const circaClose = v2.devigCandidate(circaExact, { market: 'Total', side: 'Over 8.5', line: 8.5 });
  assert.strictEqual(circaClose.pointAdjusted, false);
  assert.strictEqual(circaClose.book, 'circasports');
  assert.strictEqual(circaClose.line, 8.5);
  assert.strictEqual(circaClose.closeNoVig, 0.5);

  const bothExact = event('Host', 'Away', [
    book('pinnacle', [totals(8.5, -115, -105)]),
    book('circasports', [totals(8.5, -110, -110)]),
  ]);
  const pinWins = v2.devigCandidate(bothExact, { market: 'Total', side: 'Over 8.5', line: 8.5 });
  assert.strictEqual(pinWins.book, 'pinnacle');
  assert.strictEqual(pinWins.pointAdjusted, false);
  assert.strictEqual(pinWins.closeNoVig, shifted);

  const mlEvent = event('Bruins', 'Rangers', [
    book('pinnacle', [h2h('Bruins', 'Rangers', -150, 130)]),
  ]);
  const mlClose = v2.devigCandidate(mlEvent, { market: 'Moneyline', side: 'Rangers', line: null });
  assert.strictEqual(mlClose.pointAdjusted, false);
  assert.strictEqual(mlClose.line, null);
  assert.strictEqual(mlClose.closeNoVig, noVigTwoWay(130, -150).p1);
  assert.strictEqual(v2.devigCandidate(event('Bruins', 'Rangers', []), { market: 'Moneyline', side: 'Rangers' }), null);

  const orphan = candidate({
    matchup: 'Old Away @ Old Host',
    homeTeam: 'Old Host',
    awayTeam: 'Old Away',
    commenceTime: '2026-10-09T18:00:00Z',
    side: 'Over 9.5',
    line: 9.5,
    closeNoVig: 0.53,
    closeBook: 'pinnacle',
    closeAt: '2026-10-09T17:50:00.000Z',
    fair_sharp_p: 0.5,
  });
  const keptClose = candidate({
    matchup: 'Kept Away @ Kept Host',
    homeTeam: 'Kept Host',
    awayTeam: 'Kept Away',
    commenceTime: '2026-10-09T23:10:00Z',
    side: 'Over 8.5',
    line: 8.5,
    closeNoVig: 0.61,
    closeBook: 'pinnacle',
    closeAt: '2026-10-09T22:55:00.000Z',
    fair_sharp_p: 0.4,
    fair_sharp_p_at_generate: 0.4,
  });
  const dueA = mlbRow('Alpha', '2026-10-09T23:10:00Z', { fair_sharp_p: 0.47 });
  const dueB = mlbRow('Bravo', '2026-10-09T23:12:00Z');
  const dueNhl = candidate({
    sport: 'NHL',
    matchup: 'Rangers @ Bruins',
    homeTeam: 'Bruins',
    awayTeam: 'Rangers',
    commenceTime: '2026-10-09T23:08:00Z',
    market: 'Moneyline',
    side: 'Rangers',
    line: null,
    odds: 130,
    fair_sharp_p: 0.42,
  });
  const dueY = mlbRow('Yank', '2026-10-09T23:05:00Z', { fair_sharp_p: 0.49 });
  const notDue = mlbRow('Later', '2026-10-09T23:30:00Z');
  const already = mlbRow('Done', '2026-10-09T23:10:00Z', { closeNoVig: 0.57, closeBook: 'pinnacle' });

  const merged = v2.mergeCandidates(
    [orphan, keptClose],
    [dueA, { ...keptClose, closeNoVig: null, closeBook: null, closeAt: null, fair_sharp_p: 0.77 }],
  );
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged.find((r) => r.matchup === orphan.matchup).closeNoVig, 0.53);
  const keptMerged = merged.find((r) => r.matchup === keptClose.matchup);
  assert.strictEqual(keptMerged.closeNoVig, 0.61);
  assert.strictEqual(keptMerged.fair_sharp_p, 0.77);

  function boardFor(url) {
    if (url.includes('/events')) {
      if (url.includes('baseball_mlb')) {
        return [dueA, dueB, dueY].map((r) => ({ id: r.matchup, home_team: r.homeTeam, away_team: r.awayTeam }));
      }
      return [{ id: 'nhl', home_team: 'Bruins', away_team: 'Rangers' }];
    }
    if (url.includes('baseball_mlb/odds')) {
      return [dueA, dueB, dueY].map((r) => event(r.homeTeam, r.awayTeam, [
        book('pinnacle', [totals(8.5, -110, -110)]),
      ], r.matchup));
    }
    if (url.includes('icehockey_nhl/odds')) {
      return [event('Bruins', 'Rangers', [book('pinnacle', [h2h('Bruins', 'Rangers', -150, 130)])], 'nhl')];
    }
    throw new Error(`unexpected url ${url}`);
  }

  const http = [];
  const writes = {};
  const priorUsed = 6;
  const blobs = {
    [`clv-candidates-v2/${ET_DAY}`]: {
      date: ET_DAY,
      schema: 'clv-candidates-v2',
      candidates: [orphan, keptClose, already],
      credits: { cap: 90, byEtDay: { [ET_DAY]: { used: priorUsed, runs: [{ at: 'earlier', credits: priorUsed }] } } },
    },
    [`omega-candidates/${ET_DAY}`]: { candidates: [dueA, dueB, dueNhl, notDue, already, keptClose] },
    [`omega-candidates/${YDAY}`]: { candidates: [dueY] },
  };

  const result = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    creditCap: 90,
    readJson: async (key) => (blobs[key] ? JSON.parse(JSON.stringify(blobs[key])) : null),
    writeJson: async (key, data) => { writes[key] = data; },
    fetchImpl: async (url) => {
      const kind = url.includes('/odds') ? 'odds' : 'events';
      http.push({ kind, url });
      return { ok: true, status: 200, json: async () => boardFor(url) };
    },
  });

  const odds = oddsUrls(http);
  assert.strictEqual(odds.length, 2);
  assert.ok(odds.some((u) => u.includes('/sports/baseball_mlb/odds')));
  assert.ok(odds.some((u) => u.includes('/sports/icehockey_nhl/odds')));
  assert.strictEqual(http.filter((c) => c.kind === 'events').length, 2);
  for (const url of odds) {
    const q = new URL(url);
    assert.strictEqual(q.searchParams.get('bookmakers'), SHARP_BOOKS_PARAM);
    assert.strictEqual(q.searchParams.get('markets'), 'h2h,spreads,totals');
    assert.strictEqual(q.searchParams.has('regions'), false);
    assert.ok(!url.includes('historical'));
  }
  assert.strictEqual(result.creditsThisRun, 6);
  assert.strictEqual(result.calls.filter((c) => c.action === 'odds').length, 2);
  assert.ok(result.calls.every((c) => c.action !== 'odds' || c.credits === 3));

  const today = writes[`clv-candidates-v2/${ET_DAY}`];
  const yday = writes[`clv-candidates-v2/${YDAY}`];
  assert.ok(today);
  assert.ok(yday);
  assert.strictEqual(today.credits.byEtDay[ET_DAY].used, priorUsed + 6);
  assert.strictEqual(yday.credits.byEtDay[ET_DAY].used, 0);
  const usedSum = [today, yday].reduce((s, b) => s + (b.credits.byEtDay[ET_DAY].used || 0), 0);
  assert.strictEqual(usedSum, priorUsed + 6);
  assert.strictEqual(today.candidates.find((r) => r.matchup === orphan.matchup).closeNoVig, 0.53);
  const keptOut = today.candidates.find((r) => r.matchup === keptClose.matchup);
  assert.strictEqual(keptOut.closeNoVig, 0.61);
  assert.strictEqual(keptOut.fair_sharp_p, 0.4);
  const alpha = today.candidates.find((r) => r.matchup === dueA.matchup);
  assert.strictEqual(alpha.closeNoVig, 0.5);
  assert.strictEqual(alpha.pointAdjusted, false);
  assert.strictEqual(alpha.closeBook, 'pinnacle');
  assert.strictEqual(alpha.closeLine, 8.5);
  assert.strictEqual(alpha.fair_sharp_p_at_generate, 0.47);
  assert.strictEqual(alpha.clvProb, 0.5 - 0.47);
  assert.strictEqual(alpha.clvProbCents, +((0.5 - 0.47) * 100).toFixed(2));
  assert.strictEqual(alpha.clvVsOffered, 0.5 - americanToImplied(-110));
  assert.strictEqual(alpha.clvVsOfferedCents, +((0.5 - americanToImplied(-110)) * 100).toFixed(2));
  assert.strictEqual(alpha.clvAmericanCents, americanCentsDiff(-110, -110));
  assert.strictEqual(today.candidates.find((r) => r.matchup === notDue.matchup).closeNoVig, undefined);
  assert.strictEqual(today.candidates.find((r) => r.matchup === already.matchup).closeNoVig, 0.57);
  const yank = yday.candidates.find((r) => r.matchup === dueY.matchup);
  assert.strictEqual(yank.closeNoVig, 0.5);
  const nhl = today.candidates.find((r) => r.sport === 'NHL');
  assert.strictEqual(nhl.pointAdjusted, false);
  assert.strictEqual(nhl.closeNoVig, noVigTwoWay(130, -150).p1);
  assert.strictEqual(nhl.clvAmericanCents, americanCentsDiff(130, 130));

  // Frozen fair on the stored row wins over a later ledger fair.
  const frozenFair = 0.4;
  const frozenRow = mlbRow('Frozen', '2026-10-09T23:10:00Z', {
    fair_sharp_p: 0.7,
    fair_sharp_p_at_generate: frozenFair,
  });
  delete frozenRow.closeNoVig;
  const frozenWrites = {};
  await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    creditCap: 90,
    eventsBySportKey: { baseball_mlb: null },
    oddsBySportKey: {
      baseball_mlb: [event(frozenRow.homeTeam, frozenRow.awayTeam, [book('pinnacle', [totals(8.5, -110, -110)])])],
    },
    readJson: async (key) => {
      if (key === `omega-candidates/${ET_DAY}`) return { candidates: [{ ...frozenRow, fair_sharp_p_at_generate: undefined, fair_sharp_p: 0.7 }] };
      if (key === `clv-candidates-v2/${ET_DAY}`) return { candidates: [frozenRow], credits: { byEtDay: {} } };
      return null;
    },
    writeJson: async (key, data) => { frozenWrites[key] = data; },
    fetchImpl: async () => { throw new Error('reuse must not fetch'); },
  });
  const frozenOut = frozenWrites[`clv-candidates-v2/${ET_DAY}`].candidates.find((r) => r.matchup === frozenRow.matchup);
  assert.strictEqual(frozenOut.closeNoVig, 0.5);
  assert.strictEqual(frozenOut.fair_sharp_p_at_generate, frozenFair);
  assert.strictEqual(frozenOut.clvProb, 0.5 - frozenFair);

  // Point-adjusted close stores the sharp book's line. No fabricated shift.
  const adjRow = mlbRow('Adj', '2026-10-09T23:10:00Z', { fair_sharp_p: 0.5, odds: -110 });
  const adjWrites = {};
  const adj = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    eventsBySportKey: { baseball_mlb: [{ home_team: adjRow.homeTeam, away_team: adjRow.awayTeam }] },
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [adjRow] } : null),
    writeJson: async (key, data) => { adjWrites[key] = data; },
    fetchImpl: async (url) => {
      assert.ok(url.includes('/odds'));
      assert.ok(!url.includes('historical'));
      return {
        ok: true,
        json: async () => [event(adjRow.homeTeam, adjRow.awayTeam, [book('pinnacle', [totals(7.5, -115, -105)])])],
      };
    },
  });
  assert.strictEqual(adj.creditsThisRun, 3);
  const adjOut = adjWrites[`clv-candidates-v2/${ET_DAY}`].candidates[0];
  assert.strictEqual(adjOut.pointAdjusted, true);
  assert.strictEqual(adjOut.closeLine, 7.5);
  assert.strictEqual(adjOut.closeNoVig, shifted);
  assert.strictEqual(adjOut.closeBook, 'pinnacle');
  assert.strictEqual(adjOut.clvAmericanCents, null);
  assert.deepStrictEqual(adjOut.closeOddsPair, { side: -115, opp: -105 });

  // Cap: 88 + 3 > 90 stops before the paid call. 87 is allowed.
  async function runCap(used, cap) {
    const calls = [];
    const out = await v2.captureCandidateClosesV2({
      now: NOW,
      apiKey: 'k',
      creditCap: cap,
      readJson: async (key) => {
        if (key === `omega-candidates/${ET_DAY}`) return { candidates: [dueA, dueNhl] };
        if (key === `clv-candidates-v2/${ET_DAY}`) {
          return { candidates: [], credits: { byEtDay: { [ET_DAY]: { used, runs: [] } } } };
        }
        return null;
      },
      writeJson: async () => {},
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/events')) {
          return { ok: true, json: async () => [{ home_team: dueA.homeTeam, away_team: dueA.awayTeam }, { home_team: 'Bruins', away_team: 'Rangers' }] };
        }
        return { ok: true, json: async () => [] };
      },
    });
    return { out, calls };
  }
  const stopped = await runCap(88, 90);
  assert.ok(!stopped.calls.some((u) => u.includes('/odds')));
  assert.strictEqual(stopped.out.creditsThisRun, 0);
  assert.ok(stopped.out.calls.some((c) => c.action === 'skip-cap'));
  const allowed = await runCap(87, 90);
  assert.strictEqual(allowed.calls.filter((u) => u.includes('/odds')).length, 1);
  assert.strictEqual(allowed.out.creditsThisRun, 3);

  const tightCalls = [];
  const tight = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    creditCap: 3,
    eventsBySportKey: { baseball_mlb: null, icehockey_nhl: null },
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [dueA, dueNhl] } : null),
    writeJson: async () => {},
    fetchImpl: async (url) => {
      tightCalls.push(url);
      return { ok: true, json: async () => [] };
    },
  });
  assert.strictEqual(tightCalls.length, 1);
  assert.ok(tightCalls[0].includes('baseball_mlb/odds'));
  assert.strictEqual(tight.creditsThisRun, 3);
  assert.ok(tight.calls.some((c) => c.sportKey === 'icehockey_nhl' && c.action === 'skip-cap'));

  // Future game absent from /events: skip the paid call. A game already started still pulls.
  const futureCalls = [];
  const future = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    eventsBySportKey: { baseball_mlb: [] },
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [dueA] } : null),
    writeJson: async () => {},
    fetchImpl: async (url) => { futureCalls.push(url); return { ok: true, json: async () => [] }; },
  });
  assert.deepStrictEqual(futureCalls, []);
  assert.strictEqual(future.creditsThisRun, 0);
  assert.ok(future.calls.some((c) => c.action === 'skip-events'));

  const startedRow = mlbRow('Live', new Date(t0 - 2 * 60 * 1000).toISOString());
  const startedCalls = [];
  const started = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    eventsBySportKey: { baseball_mlb: [] },
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [startedRow] } : null),
    writeJson: async () => {},
    fetchImpl: async (url) => {
      startedCalls.push(url);
      return { ok: true, json: async () => [event(startedRow.homeTeam, startedRow.awayTeam, [book('pinnacle', [totals(8.5, -110, -110)])])] };
    },
  });
  assert.strictEqual(startedCalls.length, 1);
  assert.ok(startedCalls[0].includes('/odds'));
  assert.strictEqual(started.creditsThisRun, 3);

  // In-run cache reuse is 0 credits and still stamps the close.
  const reuseCache = new Map();
  reuseCache.set('baseball_mlb', [event(dueA.homeTeam, dueA.awayTeam, [book('pinnacle', [totals(8.5, -110, -110)])])]);
  const reuseWrites = {};
  const reuse = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    eventsBySportKey: { baseball_mlb: null },
    oddsCache: reuseCache,
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [dueA] } : null),
    writeJson: async (key, data) => { reuseWrites[key] = data; },
    fetchImpl: async () => { throw new Error('cached capture must not fetch'); },
  });
  assert.strictEqual(reuse.creditsThisRun, 0);
  assert.ok(reuse.calls.some((c) => c.action === 'reuse' && c.credits === 0));
  assert.strictEqual(reuseWrites[`clv-candidates-v2/${ET_DAY}`].candidates[0].closeNoVig, 0.5);

  // One sport's odds failure does not abort the other sport.
  const splitCalls = [];
  const splitWrites = {};
  const split = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    eventsBySportKey: { baseball_mlb: null, icehockey_nhl: null },
    readJson: async (key) => (key === `omega-candidates/${ET_DAY}` ? { candidates: [dueA, dueNhl] } : null),
    writeJson: async (key, data) => { splitWrites[key] = data; },
    fetchImpl: async (url) => {
      splitCalls.push(url);
      if (url.includes('baseball_mlb')) throw new Error('mlb odds down');
      return { ok: true, json: async () => [event('Bruins', 'Rangers', [book('pinnacle', [h2h('Bruins', 'Rangers', -150, 130)])])] };
    },
  });
  assert.strictEqual(split.ok, true);
  assert.strictEqual(split.creditsThisRun, 3);
  assert.ok(split.calls.some((c) => c.sportKey === 'baseball_mlb' && c.action === 'odds-error'));
  const splitNhl = splitWrites[`clv-candidates-v2/${ET_DAY}`].candidates.find((r) => r.sport === 'NHL');
  assert.ok(splitNhl.closeNoVig != null);
  assert.strictEqual(splitWrites[`clv-candidates-v2/${ET_DAY}`].candidates.find((r) => r.matchup === dueA.matchup).closeNoVig, undefined);

  // getStore returns a store whose setJSON throws MissingBlobsContext. REST PUT still lands.
  const restCalls = [];
  const restLedger = { candidates: [dueA] };
  const restExisting = {
    candidates: [orphan],
    credits: { byEtDay: {} },
  };
  const rest = await v2.captureCandidateClosesV2({
    now: NOW,
    apiKey: 'k',
    token: 'test-token',
    siteId: 'site-test',
    eventsBySportKey: { baseball_mlb: null },
    oddsBySportKey: {
      baseball_mlb: [event(dueA.homeTeam, dueA.awayTeam, [book('pinnacle', [totals(8.5, -110, -110)])])],
    },
    getStore: async () => ({
      get: async (key) => {
        if (key === `omega-candidates/${ET_DAY}`) return restLedger;
        if (key === `clv-candidates-v2/${ET_DAY}`) return restExisting;
        throw new Error('MissingBlobsContext');
      },
      setJSON: async () => { throw new Error('MissingBlobsContext'); },
    }),
    blobFetch: async (url, init) => {
      restCalls.push({ url, method: init && init.method, body: init && init.body });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    fetchImpl: async () => { throw new Error('injected odds must not fetch'); },
  });
  assert.strictEqual(rest.ok, true);
  assert.strictEqual(rest.creditsThisRun, 3);
  const puts = restCalls.filter((c) => c.method === 'PUT');
  assert.ok(puts.length >= 1);
  assert.ok(puts.every((c) => c.url.includes('api.netlify.com/api/v1/blobs/site-test/edge-picks-omega/clv-candidates-v2/')));
  const todayPut = puts.find((c) => c.url.endsWith(`/clv-candidates-v2/${ET_DAY}`));
  assert.ok(todayPut);
  const todayBody = JSON.parse(todayPut.body);
  assert.strictEqual(todayBody.candidates.find((r) => r.matchup === orphan.matchup).closeNoVig, 0.53);
  assert.strictEqual(todayBody.candidates.find((r) => r.matchup === dueA.matchup).closeNoVig, 0.5);

  const directPuts = [];
  const direct = await v2.writeWithFallback('clv-candidates-v2/2026-10-09', { schema: 'clv-candidates-v2', n: 1 }, {
    token: 'test-token',
    getStore: async () => ({ setJSON: async () => { throw new Error('MissingBlobsContext'); } }),
    blobFetch: async (url, init) => {
      directPuts.push({ url, method: init.method, body: init.body });
      return { ok: true, status: 200 };
    },
  });
  assert.strictEqual(direct.via, 'rest');
  assert.ok(directPuts[0].url.includes('clv-candidates-v2/2026-10-09'));
  assert.ok(directPuts[0].body.includes('MissingBlobsContext') === false);

  // Old recordCandidateCloses: same MissingBlobsContext on setJSON, REST still writes.
  // A thrown getBulk on one commence group does not drop the other.
  const oldHttp = [];
  const priorSide = {
    date: '2026-10-05', sport: 'MLB', matchup: 'A @ B', market: 'Total', side: 'Over 8.5',
    line: 8.5, odds: -110, fair_sharp_p: 0.5, closingNoVig: 0.51, clv: 0.01, clvCents: 1,
    captureMinsToCommence: 0, captureScore: 0,
  };
  const old = await cand.captureCandidateCloses({
    dateISO: '2026-10-06',
    nowMs: Date.parse('2026-10-07T16:00:00Z'),
    sides: [{
      sport: 'MLB', sportKey: 'baseball_mlb', matchup: 'A @ B', market: 'Total', side: 'Over 8.5',
      line: 8.5, odds: -110, fair_sharp_p: 0.5, commenceTime: '2026-10-05T23:00:00Z', qualityScore: 1,
    }],
    store: {
      get: async () => { throw new Error('MissingBlobsContext'); },
      setJSON: async () => { throw new Error('MissingBlobsContext'); },
    },
    allowRest: true,
    token: 'test-token',
    siteId: 'site-test',
    fetchImpl: async (url, init) => {
      oldHttp.push({ url, method: init.method, body: init.body });
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ sides: [priorSide] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    fetchBulk: async () => { throw new Error('should reuse stored close'); },
    extractClose: () => null,
    pickSideInfo: () => ({}),
    findMatchingGame: () => null,
  });
  assert.strictEqual(old.write.via, 'rest');
  assert.strictEqual(old.payload.sides[0].closingNoVig, 0.51);
  const oldPut = oldHttp.find((c) => c.method === 'PUT');
  assert.ok(oldPut.url.includes('/edge-picks-omega/clv-candidates-2026-10-06'));
  assert.ok(!oldPut.url.includes('clv-candidates-v2'));
  assert.ok(JSON.parse(oldPut.body).sides[0].closingNoVig === 0.51);
  assert.ok(!oldHttp.some((c) => c.method === 'PUT' && c.url.includes('/clv-2026')));

  const hi = '2026-10-05T23:00:00Z';
  const lo = '2026-10-05T20:00:00Z';
  const grouped = await cand.captureCandidateCloses({
    dateISO: '2026-10-05',
    nowMs: Date.parse('2026-10-06T16:00:00Z'),
    creditCap: 200,
    existing: { sides: [] },
    sides: [
      {
        sport: 'MLB', sportKey: 'baseball_mlb', matchup: 'A @ B', market: 'Total', side: 'Over 8.5',
        line: 8.5, odds: -110, fair_sharp_p: 0.5, commenceTime: hi, qualityScore: 10,
      },
      {
        sport: 'MLB', sportKey: 'baseball_mlb', matchup: 'C @ D', market: 'Total', side: 'Over 7.5',
        line: 7.5, odds: -110, fair_sharp_p: 0.5, commenceTime: lo, qualityScore: 1,
      },
    ],
    fetchBulk: async (sportKey, atISO) => {
      if (atISO === hi) throw new Error('getBulk boom');
      return [{ home_team: 'D', away_team: 'C' }];
    },
    extractClose: () => ({ sideRaw: 0.52, overround: 1.045, sideOdds: -115, closingLine: 7.5, anchor: 'pinnacle', anchorBook: 'pinnacle' }),
    pickSideInfo: () => ({ side: 'over' }),
    findMatchingGame: (pick, games) => (games && games[0] ? games[0] : null),
    gradePick: () => 'pending',
    findGameForGrading: () => null,
  });
  assert.strictEqual(grouped.credits.extraPulls, 1);
  assert.strictEqual(grouped.credits.extraCredits, 90);
  assert.strictEqual(grouped.payload.sides.find((s) => s.matchup === 'A @ B').closingNoVig, null);
  assert.ok(grouped.payload.sides.find((s) => s.matchup === 'C @ D').closingNoVig != null);
  assert.ok(grouped.plan.decisions.find((d) => d.commenceISO === hi).error);

  const gradeRow = {
    sport: 'MLB', matchup: 'A @ B', market: 'Moneyline', side: 'A', odds: -110,
    closeNoVig: 0.5, closeBook: 'pinnacle', result: null,
  };
  const finalRow = {
    sport: 'MLB', matchup: 'C @ D', market: 'Moneyline', side: 'C', odds: -120,
    closeNoVig: 0.44, result: 'loss',
  };
  const gradeRowBefore = JSON.stringify(gradeRow);
  let gradedWrite = null;
  const graded = await v2.gradeCandidateResults({
    dateISO: ET_DAY,
    readJson: async () => ({ schema: 'clv-candidates-v2', candidates: [gradeRow, finalRow] }),
    writeJson: async (key, data) => { gradedWrite = { key, data }; },
    fetchESPNScores: async () => [{ id: 'g' }],
    findGameForGrading: (pick) => (pick.matchup === 'A @ B' ? { done: true } : null),
    gradePick: (pick, game) => (game ? 'win' : 'pending'),
  });
  assert.strictEqual(graded.graded, 1);
  assert.strictEqual(graded.wrote, true);
  assert.ok(gradedWrite.key.startsWith('clv-candidates-v2/'));
  assert.strictEqual(gradedWrite.data.candidates[0].result, 'win');
  assert.strictEqual(gradedWrite.data.candidates[0].closeNoVig, 0.5);
  assert.strictEqual(gradedWrite.data.candidates[1].result, 'loss');
  assert.strictEqual(gradedWrite.data.candidates[1].closeNoVig, 0.44);
  assert.strictEqual(JSON.stringify(gradeRow), gradeRowBefore);

  const cov = v2.coverageBySportMarket([
    { sport: 'MLB', market: 'Total', closeNoVig: 0.5 },
    { sport: 'MLB', market: 'Total' },
    { sport: 'NHL', market: 'Moneyline', closeNoVig: 0.48 },
  ]);
  const mlbCov = cov.find((g) => g.sport === 'MLB');
  assert.strictEqual(mlbCov.candidates, 2);
  assert.strictEqual(mlbCov.withClose, 1);
  assert.strictEqual(mlbCov.pct, 50);
  assert.strictEqual(cov.find((g) => g.sport === 'NHL').pct, 100);

  async function guardAt(iso) {
    return handle(schedulerEvent(), new Date(iso), {
      readJson: async () => null,
      writeJson: async () => {},
      apiKey: '',
      fetchImpl: async () => { throw new Error('guard test must not fetch odds'); },
    });
  }
  async function expectRun(iso) {
    const res = await guardAt(iso);
    assert.strictEqual(res.statusCode, 200, iso);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, `${iso} ${res.body}`);
    assert.ok(!body.skipped, iso);
  }
  async function expectSkip(iso) {
    let read = false;
    const res = await handle(schedulerEvent(), new Date(iso), {
      readJson: async () => { read = true; throw new Error('capture ran outside the ET window'); },
    });
    assert.strictEqual(res.statusCode, 200, iso);
    assert.strictEqual(JSON.parse(res.body).skipped, 'et-guard', iso);
    assert.strictEqual(read, false, iso);
  }
  await expectRun('2026-10-09T15:30:00Z');
  await expectRun('2026-10-10T05:30:00Z');
  await expectSkip('2026-10-09T15:00:00Z');
  await expectSkip('2026-10-10T06:00:00Z');
  await expectRun('2026-11-05T16:30:00Z');
  await expectRun('2026-11-06T06:30:00Z');
  await expectSkip('2026-11-05T15:45:00Z');

  const manual = await handle({ httpMethod: 'GET' }, new Date('2026-10-09T15:00:00Z'), {
    readJson: async () => null,
    writeJson: async () => {},
    apiKey: '',
  });
  assert.strictEqual(JSON.parse(manual.body).ok, true);

  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  const schedules = et.activeTomlSchedules(toml);
  const row = schedules.find((s) => s.functionName === 'capture-candidate-closes');
  assert.ok(row);
  assert.strictEqual(row.cron, '*/15 15-23,0-6 * * *');
  assert.ok(et.ET_SCHEDULE['capture-candidate-closes'].etTimes.includes('11:30'));
  assert.ok(et.ET_SCHEDULE['capture-candidate-closes'].etTimes.includes('01:30'));
  assert.ok(!et.ET_SCHEDULE['capture-candidate-closes'].etTimes.includes('02:00'));
  assert.ok(!et.ET_SCHEDULE['capture-candidate-closes'].etTimes.includes('10:00'));

  const trackSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/track-clv-omega.js'), 'utf8');
  const healthSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-omega-capture-health.js'), 'utf8');
  assert.ok(trackSrc.includes('gradeCandidateResults'));
  assert.ok(/setJSON\(`clv-\$\{dateISO\}`/.test(trackSrc));
  assert.ok(trackSrc.includes('Stored CLV data via API fallback'));
  assert.ok(healthSrc.includes('readCaptureHealthLatest'));
  assert.ok(healthSrc.includes('opsOnly'));
  assert.ok(healthSrc.includes('candidateCloses'));

  console.log('test-omega-candidate-closes-v2: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
