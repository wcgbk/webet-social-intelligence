'use strict';
/** 3:00 AM ET daily Odds pull -> odds-master baseline-0300 (Ben 2026-10-18:
 *  only 3AM + 10AM pulls). Cron "0 7,8 * * *". DST-proof via etGuard.
 *  Thin wrapper over lib/odds-master/pull. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
exports.handler = async (event) => {
  const skip = rejectUnlessEtSlot('capture-odds-3am', event, new Date());
  if (skip) return skip;
  try { const r = await runOddsMasterPull({ slot: '0300' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...r }) }; }
  catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
