'use strict';
/**
 * trigger-omega-nba-shadow-grade.js — 12:00 UTC NBA shadow grade.
 *
 * Grades the previous ET date from ESPN finals (0 Odds API credits) into
 * omega-nba-shadow-results-{date}. Separate from the 21:30 UTC project
 * wrapper because a Netlify schedule cannot pass a body.
 *
 * A naked POST is 403. SPORTS_ENABLED.NBA stays false.
 */
const { handleShadow } = require('./omega-nba-shadow');

exports.handler = (event, context) => handleShadow(event, context, {
  mode: 'grade-prev',
  trustSchedule: true,
});
