'use strict';
/**
 * Full gate-evaluated candidate ledger. Private blob only.
 * Card / yes pool / rejections stay byte-identical with the ledger on or off.
 * No network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ledger = require('./netlify/functions/lib/omega-vnext/candidate_ledger');

const GENERATED = '2026-10-09T13:40:00.000Z';

function row(over) {
  return {
    sport: over.sport || 'MLB',
    matchup: over.matchup,
    market: over.market || 'Total',
    side: over.side,
    line: Object.prototype.hasOwnProperty.call(over, 'line') ? over.line : 8.5,
    odds: over.odds == null ? -110 : over.odds,
    book: over.book || 'draftkings',
    fair_sharp_p: over.fair_sharp_p == null ? 0.52 : over.fair_sharp_p,
    p_model: over.p_model == null ? 0.55 : over.p_model,
    coverProb: over.coverProb == null ? 0.54 : over.coverProb,
    ev: over.ev == null ? 0.04 : over.ev,
    homeTeam: over.homeTeam,
    awayTeam: over.awayTeam,
    commenceTime: over.commenceTime || '2026-10-09T23:10:00Z',
    rejectReason: over.rejectReason,
  };
}

function fixture() {
  const yesPool = [];
  for (let i = 0; i < 25; i++) {
    yesPool.push(row({
      matchup: `Yes ${i} @ Opp ${i}`,
      side: `Over ${i}.5`,
      line: i + 0.5,
      homeTeam: `Opp ${i}`,
      awayTeam: `Yes ${i}`,
    }));
  }
  const rejected = [];
  for (let i = 0; i < 30; i++) {
    rejected.push(row({
      matchup: `No ${i} @ Host ${i}`,
      side: `Under ${i}.5`,
      line: i + 0.5,
      homeTeam: `Host ${i}`,
      awayTeam: `No ${i}`,
      rejectReason: i % 2 ? 'ev-floor' : 'coverProb-floor',
    }));
  }
  // Duplicate of the first yes row. Yes pool is walked first, so reason stays "yes".
  rejected.push(row({
    matchup: 'Yes 0 @ Opp 0',
    side: 'Over 0.5',
    line: 0.5,
    homeTeam: 'Opp 0',
    awayTeam: 'Yes 0',
    rejectReason: 'ev-floor',
    fair_sharp_p: 0.99,
  }));
  yesPool.push(row({
    sport: 'NHL',
    matchup: 'Rangers @ Bruins',
    market: 'Moneyline',
    side: 'Rangers',
    line: null,
    homeTeam: 'Bruins',
    awayTeam: 'Rangers',
    odds: 130,
  }));
  yesPool.push(row({
    sport: 'CFB',
    matchup: 'Ohio State @ Michigan',
    market: 'Spread',
    side: 'Ohio State -3.5',
    line: -3.5,
    homeTeam: 'Michigan',
    awayTeam: 'Ohio State',
  }));
  rejected.push(row({
    sport: 'MLB',
    matchup: 'Dodgers @ Yankees',
    market: 'Total',
    side: 'Over 8.5',
    line: 8.5,
    homeTeam: 'Yankees',
    awayTeam: 'Dodgers',
    rejectReason: 'edge',
  }));
  const picks = [
    { pick: 'Rangers ML', matchup: 'Rangers @ Bruins', sport: 'NHL', market: 'Moneyline' },
  ];
  const parlayLegs = [
    { legs: [{ pick: 'Over 8.5', matchup: 'Dodgers @ Yankees', sport: 'MLB' }] },
  ];
  const card = {
    generatedAt: GENERATED,
    picks,
    parlayLegs,
    model: 'v12.3.13-omega-vnext-nhl-engine',
    note: 'published card',
  };
  return { yesPool, rejected, picks, parlayLegs, card };
}

function baseOpts(fix, extra) {
  return {
    dateISO: '2026-10-09',
    generatedAt: GENERATED,
    yesPool: fix.yesPool,
    rejected: fix.rejected,
    picks: fix.picks,
    parlayLegs: fix.parlayLegs,
    picksData: fix.card,
    oddsBySport: {
      MLB: [{ id: 'mlb-yankees', home_team: 'Yankees', away_team: 'Dodgers' }],
      NHL: [{ id: 'nhl-bruins', home_team: 'Bruins', away_team: 'Rangers' }],
      CFB: [{ id: 'cfb-mich', home_team: 'Michigan', away_team: 'Ohio State' }],
    },
    env: {},
    ...extra,
  };
}

(async () => {
  assert.strictEqual(ledger.ledgerEnabled({}), true);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: '' }), true);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: '0' }), false);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: 'false' }), false);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: 'off' }), false);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: 'no' }), false);
  assert.strictEqual(ledger.ledgerEnabled({ OMEGA_CANDIDATE_LEDGER: '1' }), true);
  assert.strictEqual(ledger.candidateLedgerKey('2026-10-09'), 'omega-candidates/2026-10-09');
  assert.throws(() => ledger.candidateLedgerKey('10/09'), /bad date/);
  assert.strictEqual(ledger.sportKeyFor('CFB'), 'americanfootball_ncaaf');
  assert.strictEqual(ledger.sportKeyFor('NCAAF'), 'americanfootball_ncaaf');
  assert.strictEqual(ledger.sportKeyFor('NHL'), 'icehockey_nhl');

  const live = fixture();
  const yesBefore = JSON.stringify(live.yesPool);
  const rejBefore = JSON.stringify(live.rejected);
  const cardBefore = JSON.stringify(live.card);
  const yankees = live.rejected.find((r) => r.matchup === 'Dodgers @ Yankees');
  const rangers = live.yesPool.find((r) => r.side === 'Rangers');

  let stored = null;
  const on = await ledger.persistCandidateLedger(baseOpts(live, {
    storeJson: async (key, payload) => { stored = { key, payload }; },
  }));
  assert.strictEqual(on.wrote, true);
  assert.strictEqual(on.key, 'omega-candidates/2026-10-09');
  assert.strictEqual(stored.key, 'omega-candidates/2026-10-09');
  assert.strictEqual(stored.payload.schema, 'omega-candidates-v1');
  assert.strictEqual(stored.payload.private, true);
  assert.strictEqual(stored.payload.generatedAt, GENERATED);
  // 25 MLB yes + NHL ML + CFB spread + 30 rejects + yankees total. Duplicate dropped.
  assert.strictEqual(stored.payload.count, 58);
  assert.strictEqual(stored.payload.candidates.length, 58);
  const dup = stored.payload.candidates.find((c) => c.matchup === 'Yes 0 @ Opp 0');
  assert.strictEqual(dup.reason, 'yes');
  assert.strictEqual(dup.fair_sharp_p, 0.52);
  assert.ok(stored.payload.candidates.every((c) => c.reason !== 'yes-pool-unselected'));
  const reasons = new Set(stored.payload.candidates.map((c) => c.reason));
  assert.ok(reasons.has('yes'));
  assert.ok(reasons.has('ev-floor'));
  assert.ok(reasons.has('coverProb-floor'));
  assert.ok(reasons.has('edge'));

  const ny = stored.payload.candidates.find((c) => c.matchup === 'Dodgers @ Yankees');
  assert.strictEqual(ny.eventId, 'mlb-yankees');
  assert.strictEqual(ny.sportKey, 'baseball_mlb');
  assert.strictEqual(ny.published, true);
  assert.strictEqual(ny.reason, 'edge');
  assert.strictEqual(ny.line, 8.5);
  assert.strictEqual(ny.odds, -110);
  assert.strictEqual(ny.book, 'draftkings');
  assert.strictEqual(ny.homeTeam, 'Yankees');
  assert.strictEqual(ny.awayTeam, 'Dodgers');
  assert.strictEqual(ny.commenceTime, '2026-10-09T23:10:00Z');
  assert.strictEqual(yankees.eventId, undefined);

  const ml = stored.payload.candidates.find((c) => c.side === 'Rangers');
  assert.strictEqual(ml.eventId, 'nhl-bruins');
  assert.strictEqual(ml.published, true);
  assert.strictEqual(ml.reason, 'yes');
  assert.strictEqual(ml.market, 'Moneyline');
  assert.strictEqual(ml.line, null);
  assert.strictEqual(rangers.eventId, undefined);

  const cfb = stored.payload.candidates.find((c) => c.sport === 'CFB');
  assert.strictEqual(cfb.sportKey, 'americanfootball_ncaaf');
  assert.strictEqual(cfb.eventId, 'cfb-mich');
  assert.strictEqual(cfb.published, false);

  const unpublished = stored.payload.candidates.find((c) => c.matchup === 'Yes 3 @ Opp 3');
  assert.strictEqual(unpublished.published, false);
  assert.strictEqual(unpublished.reason, 'yes');

  assert.strictEqual(JSON.stringify(live.yesPool), yesBefore);
  assert.strictEqual(JSON.stringify(live.rejected), rejBefore);
  assert.strictEqual(JSON.stringify(live.card), cardBefore);
  assert.ok(!Object.prototype.hasOwnProperty.call(live.card, 'candidates'));
  assert.ok(!Object.prototype.hasOwnProperty.call(live.card, 'omegaCandidates'));

  // Ledger off: identical card JSON, store helper never called.
  const offFix = fixture();
  let offCalled = false;
  const off = await ledger.persistCandidateLedger(baseOpts(offFix, {
    env: { OMEGA_CANDIDATE_LEDGER: 'off' },
    storeJson: async () => { offCalled = true; throw new Error('ledger wrote while disabled'); },
  }));
  assert.strictEqual(off.wrote, false);
  assert.strictEqual(off.reason, 'skipped');
  assert.strictEqual(offCalled, false);
  assert.strictEqual(JSON.stringify(offFix.card), JSON.stringify(live.card));
  assert.strictEqual(JSON.stringify(offFix.yesPool), JSON.stringify(live.yesPool));
  assert.strictEqual(JSON.stringify(offFix.rejected), JSON.stringify(live.rejected));

  const skips = [
    { dryRun: true },
    { shadow: true },
    { simMode: true },
    { replay: true },
    { replayLike: true },
    { historicalSnapshot: { events: [] } },
    { env: { OMEGA_REPLAY_NO_WRITE: '1' } },
    { env: { OMEGA_REPLAY_NO_WRITE: 'true' } },
  ];
  for (const extra of skips) {
    let called = false;
    const fix = fixture();
    const result = await ledger.persistCandidateLedger(baseOpts(fix, {
      ...extra,
      env: extra.env || {},
      storeJson: async () => { called = true; throw new Error('wrote'); },
    }));
    assert.strictEqual(result.wrote, false, JSON.stringify(extra));
    assert.strictEqual(called, false, JSON.stringify(extra));
    assert.strictEqual(JSON.stringify(fix.card), cardBefore);
  }

  const built = ledger.buildCandidateLedger(baseOpts(fixture(), {}));
  assert.strictEqual(built.candidates.length, 58);
  const dropped = ledger.buildCandidateLedger({
    dateISO: '2026-10-09',
    generatedAt: GENERATED,
    yesPool: [{ sport: 'MLB', side: 'Over 8.5', market: 'Total' }],
    rejected: [{ sport: 'MLB', matchup: 'A @ B', market: 'Total', rejectReason: 'ev-floor' }],
    env: {},
  });
  assert.strictEqual(dropped.count, 0);

  const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  assert.ok(indexSrc.includes('persistCandidateLedger'));
  assert.ok(!indexSrc.includes('picksData.candidates'));
  assert.ok(!indexSrc.includes('picksData.omegaCandidates'));
  assert.ok(!/picksData\s*=\s*ledger/.test(indexSrc));
  assert.ok(/candidate ledger soft-fail/.test(indexSrc));

  console.log('test-omega-candidate-ledger: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
