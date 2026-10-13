'use strict';
/**
 * trigger-omega-shadow.js — 9:05 ET shadow dry-run.
 * POSTs generate-picks-omega-background with shadow:true.
 * That path writes ONLY omega-shadow/* inside edge-picks-omega.
 * It does not update latest-date, picks-dates, or live picks-{date}.
 * See docs/OMEGA-SHADOW-DRYRUN.md.
 */

const { rejectUnlessEtSlot } = require('./lib/et-schedule');

exports.handler = async (event) => {
  const etSkip = rejectUnlessEtSlot('trigger-omega-shadow', event);
  if (etSkip) return etSkip;
  // The 9:05 generate would pull the Odds API. Pulls are 3:00 and 10:00 only.
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      skipped: 'odds-api-window',
      shadow: false,
      message: 'The 9:05 shadow generate is suspended. Odds API pulls are 3:00 and 10:00 ET only.',
    }),
  };
};
