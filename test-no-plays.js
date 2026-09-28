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
