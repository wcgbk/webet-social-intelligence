'use strict';
/** 3:00 AM ET daily Odds pull -> odds-master baseline-0300 (Ben 2026-10-18:
 *  only 3AM + 10AM pulls). Cron "0 7,8 * * *". DST-proof via etGuard.
 *  After the board save, fires capture-closes-3am-background when
 *  OMEGA_CLOSES_AT_3AM is on (default). That step writes closes from the
 *  last saved board and does not buy historical odds.
 *  OMEGA_CLOSES_HISTORICAL=on restores the paid historical path.
 *  The POST cannot fail the board. OMEGA_CLOSES_AT_3AM=off does not fire it. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { closesAt3amEnabled } = require('./lib/default_on_flag');

const CLOSE_TIMEOUT_MS = 2500;

async function fireCloses(env, fetchImpl) {
  if (!closesAt3amEnabled(env)) return { fired: false, reason: 'flag-off' };
  const siteURL = (env && env.URL) || 'https://webetsocial.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOSE_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env && env.PICKS_SECRET_KEY) headers['x-picks-secret'] = env.PICKS_SECRET_KEY;
    const response = await fetchImpl(
      `${siteURL}/.netlify/functions/capture-closes-3am-background`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
        signal: controller.signal,
      }
    );
    const status = response && response.status;
    if (status !== 202 && status !== 200) {
      console.error(`[capture-odds-3am] closes trigger HTTP ${status}`);
    }
    return { fired: true, status };
  } catch (err) {
    console.error(`[capture-odds-3am] closes trigger failed: ${err && err.message ? err.message : err}`);
    return { fired: false, error: 'trigger-failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function runCapture(event, deps) {
  const env = (deps && deps.env) || process.env;
  const fetchImpl = (deps && deps.fetch) || fetch;
  const pull = (deps && deps.runOddsMasterPull) || runOddsMasterPull;
  let pullResult = null;
  let pullError = null;
  try {
    pullResult = await pull({ slot: '0300' });
  } catch (err) {
    pullError = err;
  }
  let closes = null;
  try {
    closes = await fireCloses(env, fetchImpl);
  } catch (err) {
    closes = { fired: false, error: 'trigger-failed' };
  }
  const closesFired = !!(closes && closes.fired);
  if (pullError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: pullError.message, closesFired }),
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, ...(pullResult || {}), closesFired }),
  };
}

exports.handler = async (event) => {
  const skip = rejectUnlessEtSlot('capture-odds-3am', event, new Date());
  if (skip) return skip;
  return runCapture(event);
};
exports.handle = (event, deps) => runCapture(event, deps);
exports.fireCloses = fireCloses;
