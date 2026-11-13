'use strict';
/**
 * 11:30 ET daily. Cron "30 15,16 * * *". DST-proof via etGuard.
 * Fires grade-boards-omega-background, which grades saved morning boards
 * into the board-graded cache. OMEGA_V2_BOARD_GRADER=off skips.
 * Does not build the card and does not call The Odds API.
 */
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { boardGraderEnabled } = require('./lib/omega-v2/board_grader');

exports.handler = async (event) => {
  const skip = rejectUnlessEtSlot('grade-boards-omega', event, new Date());
  if (skip) return skip;
  if (!boardGraderEnabled()) {
    console.log('[grade-boards-omega] datesGraded=0 rows=0 skipped=0 kill-switch=off');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, skipped: 'kill-switch' }),
    };
  }
  const siteURL = process.env.URL || 'https://webetsocial.com';
  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/grade-boards-omega-background`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );
    if (response.status !== 202 && !response.ok) {
      console.error(`[grade-boards-omega] background trigger HTTP ${response.status}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: `background trigger HTTP ${response.status}` }),
      };
    }
    console.log(`[grade-boards-omega] background triggered: ${response.status}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, queued: true, status: response.status }),
    };
  } catch (err) {
    console.error(`[grade-boards-omega] failed: ${err.message}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
