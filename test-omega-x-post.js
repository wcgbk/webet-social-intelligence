'use strict';
/**
 * 11:00 ET card post. Nothing is sent unless OMEGA_X_AUTOPOST is exactly "true".
 * Brand words are rejected. This test never calls the network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const job = require('./netlify/functions/post-card-omega');

assert.strictEqual(job.autopostEnabled({}), false);
assert.strictEqual(job.autopostEnabled({ OMEGA_X_AUTOPOST: 'TRUE' }), false);
assert.strictEqual(job.autopostEnabled({ OMEGA_X_AUTOPOST: '1' }), false);
assert.strictEqual(job.autopostEnabled({ OMEGA_X_AUTOPOST: 'true' }), true);
assert.strictEqual(job.copyRejection('Alpha card'), 'brand-word');
assert.strictEqual(job.copyRejection('the omega model'), 'brand-word');
assert.strictEqual(job.copyRejection('Today\'s card\nNFL Jets @ Bills'), null);
assert.ok(!/\b(alpha|omega)\b/i.test(job.cardCopy({
  picks: [{ sport: 'NFL', matchup: 'Jets @ Bills', pick: 'Bills -2.5', odds: -110 }],
})));

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
assert.ok(toml.includes('schedule = "0 15,16 * * *"'));
assert.ok(!/OMEGA_X_AUTOPOST\s*=\s*"true"/.test(toml));

function scheduler() {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

(async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('network');
  };
  const off = await job.runPost({
    env: { OMEGA_X_AUTOPOST: 'false' },
    copy: 'Today\'s card',
    fetchImpl,
  });
  assert.strictEqual(off.posted, false);
  assert.strictEqual(off.reason, 'flag-off');
  assert.strictEqual(calls, 0);

  const brand = await job.runPost({
    env: { OMEGA_X_AUTOPOST: 'true' },
    copy: 'Omega card is live',
    fetchImpl,
  });
  assert.strictEqual(brand.posted, false);
  assert.strictEqual(brand.reason, 'brand-word');
  assert.strictEqual(calls, 0);

  const dry = await job.runPost({
    env: { OMEGA_X_AUTOPOST: 'true' },
    copy: 'Today\'s card',
    dryRun: true,
    fetchImpl,
  });
  assert.strictEqual(dry.reason, 'dry-run');
  assert.strictEqual(calls, 0);

  const noCreds = await job.runPost({
    env: { OMEGA_X_AUTOPOST: 'true' },
    copy: 'Today\'s card',
    fetchImpl,
  });
  assert.strictEqual(noCreds.posted, false);
  assert.strictEqual(noCreds.reason, 'no-credentials');
  assert.strictEqual(calls, 0);

  const sent = [];
  const ok = await job.runPost({
    env: {
      OMEGA_X_AUTOPOST: 'true',
      TWITTER_CONSUMER_KEY: 'ck',
      TWITTER_CONSUMER_SECRET: 'cs',
      TWITTER_ACCESS_TOKEN: 'at',
      TWITTER_ACCESS_TOKEN_SECRET: 'as',
    },
    copy: 'Today\'s card\nNFL Jets @ Bills Bills -2.5 -110',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: init.body });
      return { ok: true, json: async () => ({ data: { id: '1' } }) };
    },
  });
  assert.strictEqual(ok.posted, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].url, job.TWEET_URL);
  assert.ok(!/\b(alpha|omega)\b/i.test(sent[0].body));

  const early = await job.handle(scheduler(), new Date('2026-10-13T14:00:00Z'), {
    env: { OMEGA_X_AUTOPOST: 'true' },
    fetchImpl,
  });
  assert.strictEqual(JSON.parse(early.body).skipped, 'et-guard');

  const slot = await job.handle(scheduler(), new Date('2026-10-13T15:00:00Z'), {
    env: {},
    fetchImpl,
    readJson: async () => { throw new Error('must not read'); },
  });
  const body = JSON.parse(slot.body);
  assert.strictEqual(body.posted, false);
  assert.strictEqual(body.reason, 'flag-off');
  assert.strictEqual(calls, 0);
  console.log('test-omega-x-post: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
