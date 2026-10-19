'use strict';
/** 3:00 AM ET daily Odds pull -> odds-master baseline-0300 (Ben 2026-10-18:
 *  only 3AM + 10AM pulls). Cron in netlify.toml: "0 7 * * *" = 03:00 EDT.
 *  EST shift (Nov 1): "0 8 * * *". Thin wrapper over lib/odds-master/pull. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
exports.handler = async () => {
  try { const r = await runOddsMasterPull({ slot: '0300' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...r }) }; }
  catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
