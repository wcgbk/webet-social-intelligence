'use strict';
/** Repaired 2026-10-18: this entry previously failed to load
 *  ("Cannot find module './lib/omega-vnext/pinnacle_line_move'" — its
 *  odds_master/pinnacle_line_move modules were removed in the era reset)
 *  and had no cron. It is now a manual/on-demand alias for the single
 *  authorized odds-master pull (Ben: only 3AM + 10AM pulls). Scheduled
 *  pulls live in capture-odds-3am / capture-odds-10am. No historical
 *  closes are fetched here. A manual invoke outside a 0300/1000 slot is
 *  refused, so this file can never become a third paid pull. */
const { runOddsMasterPull } = require('./lib/odds-master/pull');
const { hhmmET, etDateISO } = require('./lib/omega-vnext/line_path');
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const slot = qs.slot === '0300' || qs.slot === '1000' ? qs.slot : (hhmmET() === '0300' ? '0300' : hhmmET() === '1000' ? '1000' : null);
  if (!slot) return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, skipped: 'slot', message: 'odds-master pulls run at 0300/1000 ET via capture-odds-3am/capture-odds-10am' }) };
  try { const r = await runOddsMasterPull({ slot, dateISO: qs.date || etDateISO() });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...r }) }; }
  catch (e) { return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
exports.handleCapture = exports.handler;
