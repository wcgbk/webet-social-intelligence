'use strict';
// Admin-only: run the 10:15 rerank, 10:30 verify, 10:45 write-up and 11:00
// finalize on today's card, in order, in one background invocation.
// Auth: x-admin-token must equal OMEGA_ADMIN_RUN_TOKEN (server env, never
// returned). Missing env or a wrong token does nothing. No Odds API pull.
const crypto = require('crypto');

function tokenOk(event) {
  const want = process.env.OMEGA_ADMIN_RUN_TOKEN || '';
  const headers = (event && event.headers) || {};
  const got = headers['x-admin-token'] || headers['X-Admin-Token'] || '';
  if (!want || want.length < 24 || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.tokenOk = tokenOk;
exports.handler = async (event) => {
  if (!tokenOk(event)) {
    console.log('[admin-run-omega-chain] refused');
    return { statusCode: 403, body: 'forbidden' };
  }
  const manual = { httpMethod: 'POST', headers: {}, body: '{}', queryStringParameters: {} };
  const steps = [
    ['rerank', () => require('./rerank-picks-omega').handler(manual, {})],
    ['verify', () => require('./verify-picks-omega').handler(manual, {})],
    ['narrate', () => require('./narrate-card-omega').handler(manual, {})],
    ['post', () => require('./post-card-omega').handler(manual, {})],
  ];
  for (const [name, run] of steps) {
    try {
      const res = await run();
      console.log(`[admin-run-omega-chain] ${name} status=${res && res.statusCode} body=${String(res && res.body || '').slice(0, 300)}`);
    } catch (err) {
      console.error(`[admin-run-omega-chain] ${name} failed: ${err && err.message}`);
    }
  }
  return { statusCode: 200, body: 'done' };
};
