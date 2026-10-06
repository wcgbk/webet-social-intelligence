'use strict';
/**
 * omega-nba-shadow — on-demand NBA shadow. Unscheduled.
 *
 * Does not write the daily card. SPORTS_ENABLED.NBA stays false, and this
 * function never calls generate-picks-omega or selectStraights.
 *
 * Live odds run only when OMEGA_NBA_SHADOW=1. Without that flag the handler
 * returns immediately and makes 0 Odds API calls.
 *
 *   POST /.netlify/functions/omega-nba-shadow
 *   { "dryRun": true }     project, do not write a blob
 *   { }                    write omega-nba-shadow-{ET date}
 *   { "grade": true }      ESPN finals only (0 odds credits) → omega-nba-shadow-results-{date}
 *   { "grade": true, "date": "YYYY-MM-DD", "dryRun": true }
 *
 * Cost when the flag is on and grade is not set: 1 HTTP call to
 * /v4/sports/basketball_nba/odds (regions us,us2,eu × markets
 * h2h,spreads,totals = 9 credits under the Odds API markets × regions rule).
 * The grader costs 0 odds credits. Nothing here is on a cron.
 */
const { runNbaShadow, gradeNbaShadow, ODDS_CREDITS_PER_RUN } = require('./lib/omega-vnext/nba_shadow');

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (_) {
    return {};
  }
}

function flagOn(params, body) {
  if (process.env.OMEGA_NBA_SHADOW === '1') return true;
  if (body && (body.shadow === true || body.OMEGA_NBA_SHADOW === '1')) return true;
  if (params && (params.OMEGA_NBA_SHADOW === '1' || params.shadow === '1')) return true;
  return false;
}

exports.handler = async (event) => {
  const body = readBody(event);
  const params = (event && event.queryStringParameters) || {};
  const headers = { 'Content-Type': 'application/json' };
  if (!flagOn(params, body)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        skipped: true,
        reason: 'OMEGA_NBA_SHADOW is not 1',
        oddsCalls: 0,
        creditsEstimate: 0,
        wrote: false,
      }),
    };
  }
  const dryRun = body.dryRun === true || params.dryRun === '1';
  const grade = body.grade === true || params.grade === '1';
  const dateISO = body.date || params.date || undefined;
  try {
    const result = grade
      ? await gradeNbaShadow({ dateISO, dryRun })
      : await runNbaShadow({ dateISO, dryRun });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: !result.error,
        grade,
        dryRun,
        wrote: result.wrote,
        key: result.key,
        date: result.date,
        oddsCalls: result.oddsCalls,
        creditsEstimate: result.creditsEstimate != null ? result.creditsEstimate : (result.oddsCalls ? ODDS_CREDITS_PER_RUN : 0),
        candidateCount: result.candidateCount != null ? result.candidateCount : null,
        yesCount: result.yesCount != null ? result.yesCount : null,
        rejectedCount: result.rejectedCount != null ? result.rejectedCount : null,
        graded: result.graded != null ? result.graded : null,
        record: result.record || null,
        preseason: result.preseason != null ? result.preseason : null,
        error: result.error || null,
        sportsEnabledNba: false,
      }),
    };
  } catch (err) {
    console.error(`[omega-nba-shadow] ${err.message}`);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message, wrote: false, oddsCalls: 0 }),
    };
  }
};
