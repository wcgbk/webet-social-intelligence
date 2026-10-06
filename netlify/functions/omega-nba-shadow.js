'use strict';
/**
 * omega-nba-shadow — NBA shadow HTTP entry. Not the daily card.
 *
 * SPORTS_ENABLED.NBA stays false. This function never calls
 * generate-picks-omega or selectStraights.
 *
 * The job is on because NBA_SHADOW.enabled is true in config.js. That
 * constant is independent of SPORTS_ENABLED.NBA. Server env
 * OMEGA_NBA_SHADOW=0 is the kill-switch. A client body, query string, or
 * curl env does not turn the job on.
 *
 * Who may fetch odds or write blobs:
 *   - trigger-omega-nba-shadow (21:30 UTC) and trigger-omega-nba-shadow-grade
 *     (12:00 UTC), which Netlify invokes with a schedule event
 *   - a request carrying the existing internal secret PICKS_SECRET_KEY
 *     (Authorization: Bearer, x-picks-secret, or ?key=), the same secret
 *     run-picks and live-ingest already use
 * Anyone else gets 403, or a read-only status when they ask to read.
 * The public URL does not trust a schedule header: that header is spoofable
 * on a web-reachable function. The scheduled wrappers pass trustSchedule.
 *
 * Cost when project runs: at most one /odds call (9 credits) per ET date,
 * skipped when the free /events preflight shows no same-ET-day NBA game.
 * Grade is ESPN only (0 credits) and writes omega-nba-shadow-results-{date}
 * with a W-L, units, and by-market summary plus a cumulative chain.
 */
const { SPORTS_ENABLED } = require('./lib/omega-vnext/config');
const shadow = require('./lib/omega-vnext/nba_shadow');

function header(event, name) {
  const h = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() !== want) continue;
    const value = h[key];
    if (Array.isArray(value)) return String(value[0] || '');
    return value == null ? '' : String(value);
  }
  return '';
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (_) {
    return {};
  }
}

/** Netlify scheduled invoke: X-NF-Event: schedule, user-agent "Netlify Clockwork". */
function isScheduledEvent(event) {
  const nf = header(event, 'x-nf-event').toLowerCase();
  if (nf === 'schedule' || nf === 'scheduled') return true;
  if (/netlify clockwork/i.test(header(event, 'user-agent'))) return true;
  return false;
}

/** Existing internal secret. Unset secret never matches (fail closed). */
function hasInternalSecret(event) {
  const secret = process.env.PICKS_SECRET_KEY;
  if (!secret) return false;
  const auth = /^Bearer\s+(.+)$/i.exec(header(event, 'authorization').trim());
  if (auth && auth[1].trim() === secret) return true;
  if (header(event, 'x-picks-secret') === secret) return true;
  const params = (event && event.queryStringParameters) || {};
  if (params.key && params.key === secret) return true;
  return false;
}

/**
 * trustSchedule is true only for the cron wrappers. The public function
 * leaves it false so a spoofed X-NF-Event cannot spend Odds API credits.
 */
function mayFetchOrWrite(event, { trustSchedule = false } = {}) {
  if (hasInternalSecret(event)) return true;
  if (trustSchedule && isScheduledEvent(event)) return true;
  return false;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function readOnlyBody() {
  return {
    ok: true,
    readOnly: true,
    shadowEnabled: shadow.shadowLiveEnabled(),
    sportsEnabledNba: SPORTS_ENABLED.NBA === true,
    oddsCalls: 0,
    wrote: false,
    creditsEstimate: 0,
    keys: {
      project: 'omega-nba-shadow-{YYYY-MM-DD}',
      results: 'omega-nba-shadow-results-{YYYY-MM-DD}',
    },
  };
}

function forbiddenBody() {
  return {
    ok: false,
    error: 'forbidden',
    oddsCalls: 0,
    wrote: false,
    creditsEstimate: 0,
    sportsEnabledNba: SPORTS_ENABLED.NBA === true,
  };
}

function resultBody(result, extra) {
  return {
    ok: !result.error,
    wrote: !!result.wrote,
    key: result.key || null,
    date: result.date || null,
    oddsCalls: result.oddsCalls || 0,
    creditsEstimate: result.creditsEstimate != null
      ? result.creditsEstimate
      : (result.oddsCalls ? shadow.ODDS_CREDITS_PER_RUN : 0),
    candidateCount: result.candidateCount != null ? result.candidateCount : null,
    yesCount: result.yesCount != null ? result.yesCount : null,
    rejectedCount: result.rejectedCount != null ? result.rejectedCount : null,
    graded: result.graded != null ? result.graded : null,
    record: result.record || null,
    summary: result.summary || null,
    cumulative: result.cumulative || null,
    preseason: result.preseason != null ? result.preseason : null,
    skipped: !!result.skipped,
    reason: result.reason || null,
    error: result.error || null,
    sportsEnabledNba: SPORTS_ENABLED.NBA === true,
    ...extra,
  };
}

/**
 * @param {object} event
 * @param {object} [context]  context.nbaShadowTest is an in-process fixture hook
 * @param {{ mode?: string, trustSchedule?: boolean }} [forced]
 */
async function handleShadow(event, context, forced = {}) {
  const test = (context && context.nbaShadowTest) || null;
  const body = readBody(event);
  const params = (event && event.queryStringParameters) || {};
  const method = event && event.httpMethod ? String(event.httpMethod).toUpperCase() : '';
  const trustSchedule = forced.trustSchedule === true;
  const authorized = mayFetchOrWrite(event, { trustSchedule });

  if (!authorized) {
    if (method === 'GET' || body.read === true) return json(200, readOnlyBody());
    return json(403, forbiddenBody());
  }

  const killed = shadow.shadowKillReason();
  if (killed) {
    return json(200, {
      ok: false,
      skipped: true,
      reason: killed,
      oddsCalls: 0,
      wrote: false,
      creditsEstimate: 0,
      sportsEnabledNba: SPORTS_ENABLED.NBA === true,
    });
  }

  // An authorized read asks for status only. Cron wrappers set forced.mode,
  // so a schedule invoke still projects or grades.
  if (!forced.mode && (method === 'GET' || body.read === true)) {
    return json(200, readOnlyBody());
  }

  let mode = forced.mode || null;
  if (!mode) mode = (body.grade === true || params.grade === '1') ? 'grade' : 'project';
  // Cron wrappers ignore client dryRun and date. A dry-run would fetch odds
  // without writing the idempotency blob, and a client date would be a new
  // billed slate. In-process tests may still pin both. Secret manual runs
  // (no forced.mode) may pass date and dryRun.
  const dryRun = (test && test.dryRun === true)
    ? true
    : (forced.mode ? false : (body.dryRun === true || params.dryRun === '1'));

  let dateISO;
  if (mode === 'grade-prev') {
    dateISO = (test && test.dateISO) || shadow.previousShadowDate();
  } else if (forced.mode === 'project') {
    dateISO = (test && test.dateISO) || undefined;
  } else {
    dateISO = (test && test.dateISO) || body.date || params.date || undefined;
  }

  try {
    let result;
    if (mode === 'grade' || mode === 'grade-prev') {
      const gradeOpts = { dateISO, dryRun };
      if (test && test.slate) gradeOpts.slate = test.slate;
      if (test && test.finals) gradeOpts.finals = test.finals;
      if (test && test.store) gradeOpts.store = test.store;
      if (test && test.read) gradeOpts.read = test.read;
      if (test && Object.prototype.hasOwnProperty.call(test, 'priorResults')) {
        gradeOpts.priorResults = test.priorResults;
      }
      result = await shadow.gradeNbaShadow(gradeOpts);
    } else {
      const runOpts = { dateISO, dryRun };
      if (test && test.oddsEvents) {
        runOpts.oddsEvents = test.oddsEvents;
        runOpts.standings = test.standings || {};
        runOpts.espnGames = test.espnGames || { games: [] };
        runOpts.gameDay = test.gameDay || { restByTeam: { NBA: {} } };
        runOpts.preseason = !!test.preseason;
        if (test.prior) runOpts.prior = test.prior;
        if (test.asOf) runOpts.asOf = test.asOf;
      }
      if (test && test.store) runOpts.store = test.store;
      if (test && test.read) runOpts.read = test.read;
      if (test && test.fetchImpl) runOpts.fetchImpl = test.fetchImpl;
      result = await shadow.runNbaShadow(runOpts);
    }
    return json(200, resultBody(result, { grade: mode !== 'project', mode }));
  } catch (err) {
    console.error(`[omega-nba-shadow] ${err.message}`);
    return json(500, {
      ok: false,
      error: err.message,
      wrote: false,
      oddsCalls: 0,
      creditsEstimate: 0,
    });
  }
}

exports.handler = (event, context) => handleShadow(event, context, { trustSchedule: false });
exports.handleShadow = handleShadow;
exports.isScheduledEvent = isScheduledEvent;
exports.mayFetchOrWrite = mayFetchOrWrite;
