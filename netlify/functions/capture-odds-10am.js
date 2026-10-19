'use strict';
/** 10:00 AM ET daily Odds pull -> odds-master check-1000 (Ben 2026-10-18:
 *  only 3AM + 10AM pulls). Cron in netlify.toml: "0 14 * * *" = 10:00 EDT.
 *  EST shift (Nov 1): "0 15 * * *". Thin wrapper over lib/odds-master/pull. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
exports.handler = async () => {
  try { const r = await runOddsMasterPull({ slot: '1000' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...r }) }; }
  catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
