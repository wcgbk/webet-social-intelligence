'use strict';

/**
 * 3:15 ET missed 3:00 pull check.
 * Reads the capture-done marker, the capture-start marker, and stored line
 * moves. Does not call the Odds API and does not re-pull.
 * A start marker with no done marker means the function was invoked and
 * died before the 3:00 board was marked. A done marker with phase 'checks'
 * means that board is stored. dryRun and OMEGA_REPLAY_NO_WRITE write nothing.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { readCaptureDone, readCaptureStart } = require('./lib/omega-vnext/capture_gate');
const { readPinnacleLineMoves } = require('./lib/omega-vnext/pinnacle_line_move');
const { sportsForCard } = require('./lib/omega-vnext/season_calendar');
const { opsAlert } = require('./lib/omega-vnext/ops_alert');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');
const { resolveFetch } = require('./lib/omega-vnext/audit_log');
const store = require('./lib/omega-vnext/store');

function missedPullKey(dateISO) {
  return `omega-ops/missed-pull-${dateISO}`;
}

function hasSlotCheck(doc, slot) {
  for (const eventDoc of (doc && doc.events) || []) {
    for (const check of (eventDoc && eventDoc.checks) || []) {
      if (check && String(check.slot) === slot) return true;
    }
  }
  return false;
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

async function handleMissedPull(event, context, deps) {
  const now = deps && deps.now instanceof Date ? deps.now : new Date();
  const etSkip = rejectUnlessEtSlot('monitor-omega-missed-pull', event, now);
  if (etSkip) return etSkip;
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = (qs && qs.date) || etParts(now).ymd;
  const readMoves = (deps && deps.readPinnacleLineMoves) || readPinnacleLineMoves;
  const sportsFn = (deps && deps.sportsForCard) || sportsForCard;
  let marker = null;
  try {
    marker = await readCaptureDone(dateISO, '0300', { read: deps && deps.read });
  } catch (_) {
    marker = null;
  }

  let report;
  if (marker && marker.ok !== false) {
    report = {
      date: dateISO,
      slot: '0300',
      severity: 'ok',
      code: 'ok',
      marker: true,
      ok: marker.ok !== false,
      phase: marker.phase || null,
      gameCount: marker.gameCount == null ? null : marker.gameCount,
      sports: marker.sports || [],
    };
    console.log(`[omega-ops] missed-pull ok date=${dateISO} phase=${report.phase || 'none'}`);
  } else if (marker && marker.ok === false) {
    report = {
      date: dateISO,
      slot: '0300',
      severity: 'alert',
      code: 'partial-0300-pull',
      marker: true,
      ok: false,
      phase: marker.phase || null,
      gameCount: marker.gameCount == null ? null : marker.gameCount,
      sports: marker.sports || [],
    };
    opsAlert('partial-0300-pull', `date=${dateISO} sports=${(report.sports || []).join(',')}`);
  } else {
    let started = null;
    try {
      started = await readCaptureStart(dateISO, '0300', { read: deps && deps.read });
    } catch (_) {
      started = null;
    }
    if (started) {
      report = {
        date: dateISO,
        slot: '0300',
        severity: 'alert',
        code: 'capture-started-not-finished',
        marker: false,
        started: true,
        startedAt: started.startedAt || null,
      };
      opsAlert('capture-started-not-finished', `date=${dateISO}`);
    } else {
      let moves = null;
      try {
        moves = await readMoves(dateISO);
      } catch (_) {
        moves = null;
      }
      if (hasSlotCheck(moves, '0300')) {
        report = {
          date: dateISO,
          slot: '0300',
          severity: 'warn',
          code: 'marker-missing-data-present',
          marker: false,
        };
        opsAlert('marker-missing-data-present', `date=${dateISO}`);
      } else {
        let sports = null;
        try {
          sports = sportsFn(dateISO, { env: deps && deps.env });
        } catch (_) {
          sports = null;
        }
        if (Array.isArray(sports) && sports.length === 0) {
          report = {
            date: dateISO,
            slot: '0300',
            severity: 'ok',
            code: 'no-slate',
            marker: false,
            sports: [],
          };
          console.log(`[omega-ops] missed-pull no-slate date=${dateISO}`);
        } else {
          const listed = Array.isArray(sports) ? sports : [];
          report = {
            date: dateISO,
            slot: '0300',
            severity: 'alert',
            code: 'missed-0300-pull',
            marker: false,
            sports: listed,
          };
          opsAlert('missed-0300-pull', `date=${dateISO} sports=${listed.join(',')}`);
        }
      }
    }
  }

  const dry = writesBlocked(event, deps);
  if (!dry) {
    const write = (deps && deps.writeJson) || ((key, data) => store.storeMissedPull(dateISO, data));
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
