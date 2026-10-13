'use strict';
/**
 * trigger-omega-nba-shadow.js — 21:30 UTC NBA shadow project.
 *
 * Netlify gives a scheduled function one cron and a body of { next_run }.
 * This wrapper is project-only. Grade is trigger-omega-nba-shadow-grade
 * at 12:00 UTC (previous ET date).
 *
 * Odds run only for a real schedule event or the internal PICKS_SECRET_KEY.
 * A naked POST is 403 and spends 0 credits. SPORTS_ENABLED.NBA stays false.
 * Writes omega-nba-shadow-{ET date} only. Does not write the daily card.
 */
const { handleShadow, mayFetchOrWrite } = require('./omega-nba-shadow');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');

exports.handler = (event, context) => {
  const now = (context && context.now instanceof Date) ? context.now : new Date();
  const etSkip = rejectUnlessEtSlot('trigger-omega-nba-shadow', event, now);
  if (etSkip) return etSkip;
  // Auth before the Odds API window skip. A naked POST is not a schedule
  // event. trustSchedule is not enough without the scheduler body. The
  // public handler uses the same mayFetchOrWrite check.
  if (!mayFetchOrWrite(event, { trustSchedule: true })) {
    return handleShadow(event, context, {
      mode: 'project',
      trustSchedule: true,
    });
  }
  // A live cron would pull NBA odds at 17:30 ET. Fixture tests pass
  // nbaShadowTest and already spend 0 credits. Production does not fetch.
  if (!(context && context.nbaShadowTest)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        skipped: 'odds-api-window',
        oddsCalls: 0,
        wrote: false,
        creditsEstimate: 0,
        message: 'NBA shadow does not call the Odds API. Pulls are 3:00 and 10:00 ET only.',
      }),
    };
  }
  return handleShadow(event, context, {
    mode: 'project',
    trustSchedule: true,
  });
};
