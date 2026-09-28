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
