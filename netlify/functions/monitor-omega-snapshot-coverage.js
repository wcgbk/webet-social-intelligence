'use strict';

/**
 * 10:20 ET snapshot coverage. Reads stored 3:00 and 10:00 checks.
 * Does not pull the Odds API, does not grade, and does not write the card.
 * A zero-game October day is an alert. Offseason slates will alert too
 * until a season calendar is wired in. That is noise, not a price change.
 */

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { readPinnacleLineMoves } = require('./lib/omega-vnext/pinnacle_line_move');
const { readMasterKey, dateKey } = require('./lib/omega-vnext/odds_master');
const { assessSnapshotCoverage, morningWindowCoverage } = require('./lib/omega-vnext/snapshot_coverage');
const { opsAlert } = require('./lib/omega-vnext/ops_alert');
const store = require('./lib/omega-vnext/store');

function snapshotCoverageKey(dateISO) {
  return `omega-ops/snapshot-coverage-${dateISO}`;
}

async function handleSnapshotCoverage(event, context, deps) {
  const now = deps && deps.now instanceof Date ? deps.now : new Date();
  const etSkip = rejectUnlessEtSlot('monitor-omega-snapshot-coverage', event, now);
  if (etSkip) return etSkip;
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || etParts(now).ymd;
  const readMoves = (deps && deps.readPinnacleLineMoves) || readPinnacleLineMoves;
  const readMaster = (deps && deps.readMasterKey) || ((key) => readMasterKey(key));
  let pack = null;
  try {
    pack = await readMoves(dateISO);
  } catch (err) {
    opsAlert('snapshot-coverage-read-failed', `date=${dateISO} ${err && err.message}`);
    pack = null;
  }
  const events = (pack && pack.events) || [];
  let master = null;
  try {
    master = await readMaster(dateKey(dateISO));
  } catch (_) {
    master = null;
  }
  const masterGames = master && Array.isArray(master.events) ? master.events.length : null;
  const windows = deps && Array.isArray(deps.snapshotRows)
    ? morningWindowCoverage(deps.snapshotRows, dateISO)
    : null;
  const report = assessSnapshotCoverage(dateISO, events, { masterGames, windows });
  if (!report.ok) {
    const code = report.games === 0 ? 'snapshot-coverage-empty' : 'snapshot-coverage';
    opsAlert(code, `date=${dateISO} games=${report.games} missing0300=${report.missing0300} missing1000=${report.missing1000} indexShort=${report.indexShort}`);
  } else {
    console.log(`[omega-ops] snapshot-coverage ok date=${dateISO} games=${report.games}`);
  }
  const dry = qs.dryRun === '1' || qs.dryRun === 'true' || (deps && deps.dryRun);
  if (!dry) {
    const write = (deps && deps.writeJson) || ((key, data) => store.storeSnapshotCoverage(dateISO, data));
    try {
      await write(snapshotCoverageKey(dateISO), report);
    } catch (err) {
      opsAlert('snapshot-coverage-store-failed', `date=${dateISO} ${err && err.message}`);
    }
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: report.ok, report }),
  };
}

exports.handler = (event, context) => handleSnapshotCoverage(event, context);
exports.handleSnapshotCoverage = handleSnapshotCoverage;
exports.snapshotCoverageKey = snapshotCoverageKey;
