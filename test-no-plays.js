// "No Qualifying Plays Today" card + completed-run swap rule.
const assert = require('assert');
const np = require('./netlify/functions/lib/no-plays');
const { resolveLiveCard } = require('./netlify/functions/lib/omega-live-date');
const { isPlaceholder } = require('./netlify/functions/lib/last-card');
(async () => {
  assert.strictEqual(np.NO_PLAYS_TITLE, 'No Qualifying Plays Today');
  const f = np.noPlaysFields('x.');
  assert.strictEqual(f.noPlaysTitle, 'No Qualifying Plays Today');
  assert.ok(!/discipline/i.test(np.sportReason('nfl', { gamesPriced: 3 })));
  assert.ok(/no NFL games/.test(np.sportReason('nfl', { noGames: true })));
  assert.ok(/college football/.test(np.sportReason('cfb', { noGames: true })));
  assert.ok(np.normalizeEmptyCard({ picks: [] }, 'alpha').noPlaysReason);
  assert.ok(/Alpha/.test(np.normalizeEmptyCard({ picks: [] }, 'alpha').noPlaysReason));
  assert.ok(/Omega's NFL model/.test(np.sportReason('nfl', { gamesPriced: 3 })));
  const hoops = np.omegaReason({
    counts: { MLB: 0, NFL: 0, NCAAF: 3, NBA: 10, NHL: 6, NCAAM: 48 },
    dateISO: '2026-11-11',
  });
  assert.ok(/67 games/.test(hoops), hoops);
  assert.ok(/NBA, NHL, college basketball, and college football/.test(hoops), hoops);
  assert.ok(!/baseball/i.test(hoops), hoops);
  assert.ok(!/\b(Omega|Alpha)\b/.test(hoops), hoops);
  assert.ok(/edge floors/.test(hoops), hoops);
  const mlbOff = np.omegaReason({
    counts: { MLB: 0, NFL: 0, NCAAF: 0, NBA: 0, NHL: 0, NCAAM: 0 },
    dateISO: '2026-11-11',
  });
  assert.ok(/baseball/i.test(mlbOff), mlbOff);
  assert.ok(/no games/i.test(mlbOff), mlbOff);
  assert.ok(!/\b(Omega|Alpha)\b/.test(mlbOff), mlbOff);
  const mlbSlate = np.omegaReason({ counts: { MLB: 8, NBA: 0 }, dateISO: '2026-07-04' });
  assert.ok(/baseball/i.test(mlbSlate) && /8 games/.test(mlbSlate), mlbSlate);
  assert.ok(!/postseason/i.test(mlbSlate), mlbSlate);
  const badReason = "Baseball has a postseason off day. None of the 3 games on today's board cleared Omega's edge floors.";
  const badInsights = "Nothing made the card, so there is no sport mix to break down. If you are still shopping, watch probable starters in baseball, quarterback status in football, and the weather on outdoor games. Those are the items that move a number after the morning line. An empty Omega card is the call on a day like this.";
  const stored = {
    picks: [],
    date: '2026-11-11',
    noPlaysTitle: 'No Qualifying Plays Today',
    noPlaysReason: badReason,
    edgeSummary: badReason,
    insights: badInsights,
    claudeVerified: true,
    sportCoverage: {
      rows: [
        { sport: 'NBA', board: 10 },
        { sport: 'NHL', board: 6 },
        { sport: 'NCAAM', board: 48 },
        { sport: 'NFL', board: 0 },
        { sport: 'NCAAF', board: 3 },
        { sport: 'MLB', board: 0 },
      ],
    },
  };
  const fixed = np.normalizeEmptyCard(stored, 'omega');
  assert.ok(/67 games/.test(fixed.noPlaysReason), fixed.noPlaysReason);
  assert.ok(/NBA, NHL, college basketball, and college football/.test(fixed.noPlaysReason), fixed.noPlaysReason);
  assert.ok(!/baseball/i.test(fixed.noPlaysReason), fixed.noPlaysReason);
  assert.ok(!/\b(Omega|Alpha)\b/.test(fixed.noPlaysReason), fixed.noPlaysReason);
  assert.strictEqual(fixed.edgeSummary, fixed.noPlaysReason);
  assert.ok(!/probable starters in baseball/i.test(fixed.insights), fixed.insights);
  assert.ok(/injuries and starting lineups/i.test(fixed.insights), fixed.insights);
  assert.ok(/quarterback status/i.test(fixed.insights), fixed.insights);
  assert.ok(!/\b(Omega|Alpha)\b/.test(fixed.insights), fixed.insights);
  assert.strictEqual(fixed.picks.length, 0);
  assert.strictEqual(stored.noPlaysReason, badReason, 'read repair must not rewrite the stored blob');
  const mlbKept = np.normalizeEmptyCard({
    picks: [],
    date: '2026-06-01',
    noPlaysTitle: 'No Qualifying Plays Today',
    noPlaysReason: badReason,
    edgeSummary: badReason,
    insights: badInsights,
    sportCoverage: { rows: [{ sport: 'MLB', board: 9 }, { sport: 'NBA', board: 0 }] },
  }, 'omega');
  assert.ok(/baseball/i.test(mlbKept.noPlaysReason), mlbKept.noPlaysReason);
  assert.ok(/probable starters/i.test(mlbKept.insights), mlbKept.insights);
  const bare = np.normalizeEmptyCard({
    picks: [],
    noPlaysTitle: 'No Qualifying Plays Today',
    noPlaysReason: "None of today's games cleared Omega's edge floors.",
    edgeSummary: "None of today's games cleared Omega's edge floors.",
    insights: 'An empty Omega card.',
  }, 'omega');
  assert.ok(!/\b(Omega|Alpha)\b/.test(`${bare.noPlaysReason} ${bare.edgeSummary} ${bare.insights}`));
  const withPicks = np.normalizeEmptyCard({
    picks: [{ pick: 'Celtics ML' }],
    edgeSummary: "WeBetAI's Omega card covers NBA.",
    insights: 'Alpha would have forced a side.',
  }, 'omega');
  assert.strictEqual(withPicks.picks.length, 1);
  assert.ok(!/\b(Omega|Alpha)\b/.test(`${withPicks.edgeSummary} ${withPicks.insights}`));
  const stamped = {
    picks: [],
    claudeVerified: true,
    verified: true,
    fallback: false,
    narration: { status: 'ok', vetoesIgnored: 0 },
  };
  assert.strictEqual(np.unstampEmptyCard(stamped), true);
  assert.strictEqual(stamped.claudeVerified, false);
  assert.strictEqual(stamped.fallback, true);
  assert.strictEqual(stamped.verified, false);
  assert.strictEqual(stamped.narration.status, 'empty');
  assert.deepStrictEqual(stamped.picks, []);
  assert.strictEqual(np.unstampEmptyCard(stamped), false);
  const keptPick = { picks: [{ pick: 'A' }], claudeVerified: true, narration: { status: 'ok' } };
  assert.strictEqual(np.unstampEmptyCard(keptPick), false);
  assert.strictEqual(keptPick.claudeVerified, true);
  const verifySrc = require('fs').readFileSync('./netlify/functions/verify-picks-omega.js', 'utf8');
  const unstampAt = verifySrc.indexOf('unstampEmptyCard(result.data)');
  const noPicksAt = verifySrc.indexOf('summary: "No picks found"');
  assert.ok(unstampAt > 0 && noPicksAt > unstampAt, 'verify clears a true stamp before the empty return');
  // swap rule: only a missing blob falls back to the previous card
  assert.strictEqual(isPlaceholder(null), true);
  assert.strictEqual(isPlaceholder({ picks: [], noGames: true }), false);
  const store = { '2026-09-27': { picks: [{ pick: 'A' }] }, '2026-09-28': { picks: [] }, '2026-09-29': { picks: [] } };
  const load = async (k) => store[k] || null;
  const now = new Date('2026-09-28T16:00:00Z');
  const tries = ['2026-09-29', '2026-09-28', '2026-09-27'];
  assert.strictEqual((await resolveLiveCard(tries, load, { now })).dateKey, '2026-09-28'); // completed empty today wins
  delete store['2026-09-28'];
  assert.strictEqual((await resolveLiveCard(tries, load, { now })).dateKey, '2026-09-27'); // run not done: previous stays
  console.log('PASS test-no-plays');
})().catch((e) => { console.error(e); process.exit(1); });

// Audit 2026-09-28: silent pick eliminators.
(() => {
  const { applyStraightRows } = require('./netlify/functions/lib/omega-vnext/narrate');
  const templated = [{ pick: 'A', units: '1u', coreReasoning: 'a' }, { pick: 'B', units: '1u', coreReasoning: 'b' }];
  const r = applyStraightRows(templated, { picks: [{ idx: 0, coreReasoning: 'x'.repeat(50) }] });
  assert.strictEqual(r.outPicks.length, 2, 'narrator omission must not drop a pick');
  const r2 = applyStraightRows(templated, { picks: [{ idx: 1, veto: true, coreReasoning: 'news' }] });
  assert.strictEqual(r2.outPicks.length, 1); assert.strictEqual(r2.rejections.length, 1);
  const { samePlayerName } = require('./netlify/functions/lib/player-name');
  assert.ok(samePlayerName('José Berríos', 'Jose Berrios'));
  assert.ok(samePlayerName('Bobby Witt Jr.', 'Bobby Witt'));
  assert.ok(!samePlayerName('Gerrit Cole', 'Carlos Rodon'));
  console.log('PASS audit eliminators');
})();

(async () => {
  const narrate = require('./netlify/functions/lib/omega-vnext/narrate');
  const empty = await narrate.narrateAndVerify({
    picks: [],
    parlayLegs: [],
    dateFormatted: 'Wednesday, November 11',
    sports: ['NBA', 'NHL', 'NCAAM', 'NCAAF'],
  });
  assert.strictEqual(empty.claudeVerified, false);
  assert.strictEqual(empty.fallback, true);
  assert.strictEqual(empty.narration.status, 'empty');
  assert.strictEqual(empty.picks.length, 0);
  const blob = `${empty.edgeSummary} ${empty.insights}`;
  assert.ok(!/\b(Omega|Alpha)\b/.test(blob), blob);
  assert.ok(!/baseball/i.test(empty.insights), empty.insights);
  assert.ok(/injuries and starting lineups/i.test(empty.insights), empty.insights);
  assert.ok(/quarterback status/i.test(empty.insights), empty.insights);
  assert.ok(/weather/i.test(empty.insights), empty.insights);
  const unknown = narrate.buildCardFallbackCopy({ picks: [] });
  assert.ok(!/baseball|probable starters/i.test(unknown.insights), unknown.insights);
  assert.ok(/injuries, lineup changes/i.test(unknown.insights), unknown.insights);
  assert.ok(!/\b(Omega|Alpha)\b/.test(`${unknown.edgeSummary} ${unknown.insights}`));
  const mlb = narrate.emptyInsights(['MLB']);
  assert.ok(/probable starters/i.test(mlb), mlb);
  assert.ok(!/quarterback/i.test(mlb), mlb);
  console.log('PASS empty narrate copy');
})().catch((e) => { console.error(e); process.exit(1); });
