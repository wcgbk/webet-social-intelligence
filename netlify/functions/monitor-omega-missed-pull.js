'use strict';

/**
 * 3:15 ET missed 3:00 pull check.
 * Uses the same pulls/{date}/0300 completeness check as
 * check-omega-daily-check / get-omega-daily-check (assessPullSlot):
 * the board exists, errors is empty, and the expected sports are present.
 * Does not call the Odds API and does not re-pull.
 * dryRun and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { assessPullSlot } = require('./lib/omega-vnext/daily_check');
const { sportsForCard } = require('./lib/omega-vnext/season_calendar');
const { opsAlert } = require('./lib/omega-vnext/ops_alert');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { resolveFetch } = require('./lib/omega-vnext/audit_log');
const store = require('./lib/omega-vnext/store');
const { readJson: readOddsMasterJson } = require('./lib/odds-master/store');

function missedPullKey(dateISO) {
  return `omega-ops/missed-pull-${dateISO}`;
}

async function defaultReadPull(dateISO, slot) {
  return readOddsMasterJson(`pulls/${dateISO}/${slot}`);
}

function writesBlocked(event, deps) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs.dryRun === '1' || qs.dryRun === 'true' || qs.dryRun === 'yes') return true;
  if (deps && deps.dryRun) return true;
  return replayNoWrite(deps && deps.env);
}

function webhookUrl(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'webhookUrl')) return deps.webhookUrl || '';
  return process.env.OMEGA_OPS_WEBHOOK_URL || process.env.OMEGA_CAPTURE_HEALTH_WEBHOOK_URL || '';
}

async function defaultPost(url, report) {
  return resolveFetch(fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
}

function severityOf(status) {
  if (status === 'ok') return 'ok';
  if (status === 'warn') return 'warn';
  return 'alert';
}

async function handleMissedPull(event, context, deps) {
  const now = deps && deps.now instanceof Date ? deps.now : new Date();
  const etSkip = rejectUnlessEtSlot('monitor-omega-missed-pull', event, now);
  if (etSkip) return etSkip;
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = (qs && qs.date) || etParts(now).ymd;
  const readPull = (deps && deps.readOddsMasterPull) || defaultReadPull;
  const sportsFn = (deps && deps.sportsForCard) || sportsForCard;

  let pullDoc = null;
  try {
    pullDoc = await readPull(dateISO, '0300');
  } catch (_) {
    pullDoc = null;
  }

  let sports = null;
  try {
    sports = sportsFn(dateISO, { env: deps && deps.env });
    if (sports && typeof sports.then === 'function') sports = await sports;
  } catch (_) {
    sports = null;
  }

  const assessed = assessPullSlot('0300', { pullDoc, sports });
  const severity = severityOf(assessed.status);
  const report = {
    date: dateISO,
    slot: '0300',
    severity,
    code: assessed.code,
    board: !!assessed.board,
    marker: !!assessed.marker,
  };
  if (assessed.games != null) report.gameCount = assessed.games;
  if (Array.isArray(assessed.sports)) report.sports = assessed.sports;
  if (assessed.phase != null) report.phase = assessed.phase;
  if (assessed.errors != null) report.errors = assessed.errors;

  if (severity === 'ok') {
    console.log(`[omega-ops] missed-pull ${report.code} date=${dateISO}`);
  } else {
    const listed = Array.isArray(report.sports) ? report.sports.join(',') : '';
    opsAlert(report.code, `date=${dateISO}${listed ? ' sports=' + listed : ''}`);
  }

  const dry = writesBlocked(event, deps);
  if (!dry) {
    const write = (deps && deps.writeJson) || ((key, data) => store.storeJson(key, data));
    try {
      await write(missedPullKey(dateISO), report);
    } catch (err) {
      opsAlert('missed-pull-store-failed', `date=${dateISO} ${err && err.message}`);
    }
  }

  const url = webhookUrl(deps);
  if (!dry && url && (report.severity === 'alert' || report.severity === 'warn')) {
    const post = (deps && deps.postWebhook) || defaultPost;
    try {
      const resp = await post(url, report);
      if (resp && resp.ok === false) {
        console.warn(JSON.stringify({
          event: 'missedPullWebhookSoftFail',
          date: dateISO,
          status: resp.status,
        }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: 'missedPullWebhookSoftFail',
        date: dateISO,
        error: err && err.message,
      }));
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: report.severity === 'ok', report }),
  };
}

exports.handler = (event, context) => handleMissedPull(event, context);
exports.handleMissedPull = handleMissedPull;
exports.missedPullKey = missedPullKey;
