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
const { handleShadow } = require('./omega-nba-shadow');

exports.handler = (event, context) => handleShadow(event, context, {
  mode: 'project',
  trustSchedule: true,
});
