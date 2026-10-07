'use strict';
/**
 * capture-omega-lines.js — Omega-dedicated US morning line-path capture.
 * Writes ONLY to edge-picks-omega (Alpha / edge-picks untouched).
 *
 * Slots: 6:00 / 7:30 ET here, 9:00 / 9:15 ET on capture-omega-lines-late.
 * Netlify crons fire both UTC hours. A scheduler invoke follows the ET guard
 * and keeps the matched ET slot even when the EDT-only UTC allowlist misses.
 * Manual calls still no-op outside ALLOWED_UTC_HHMM (±5 min) unless ?force=1.
 * 9:30 ET is not a capture slot — it races trigger-picks-omega.
 */

const { BLOB_STORE } = require('./lib/omega-vnext/config');
const { etDateISO, hhmmET } = require('./lib/omega-vnext/line_path');
const { runOmegaLineCapture } = require('./lib/omega-vnext/capture_runner');
const { rejectUnlessEtSlot, etGuard } = require('./lib/et-schedule');

/** UTC HHMM windows that map to 6:00 / 7:30 / 9:00 / 9:15 ET during EDT. */
const ALLOWED_UTC_HHMM = new Set(['1000', '1130', '1300', '1315']);

function utcHHMM(d = new Date()) {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

function nearestAllowedSlot(utcHmm) {
  // Allow ±5 min jitter around allowed slots
  const mins = parseInt(utcHmm.slice(0, 2), 10) * 60 + parseInt(utcHmm.slice(2), 10);
  for (const slot of ALLOWED_UTC_HHMM) {
    const sm = parseInt(slot.slice(0, 2), 10) * 60 + parseInt(slot.slice(2), 10);
    if (Math.abs(mins - sm) <= 5) return slot;
  }
  return null;
}

function etSlotLabel(utcSlot) {
  // EDT: UTC-4. 9:30 (1330) is intentionally absent.
  const map = { '1000': '0600', '1130': '0730', '1300': '0900', '1315': '0915' };
  return map[utcSlot] || hhmmET();
}

function compactSlot(hhmm) {
  return String(hhmm || '').replace(':', '');
}

async function handleCapture(event, functionName) {
  const qs = (event && event.queryStringParameters) || {};
  const force = !!qs.force;
  const now = new Date();
  if (!force) {
    const etSkip = rejectUnlessEtSlot(functionName, event, now);
    if (etSkip) return etSkip;
  }
  const guard = etGuard(functionName, event, now);
  const utcSlot = nearestAllowedSlot(utcHHMM(now));
  const matchedEt = !force && guard.scheduler && guard.run && guard.matched
    ? compactSlot(guard.matched)
    : null;
  if (!force && !matchedEt && !utcSlot) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        skipped: true,
        reason: 'outside Omega morning slots',
        utcHHMM: utcHHMM(now),
        allowed: [...ALLOWED_UTC_HHMM],
      }),
    };
  }

  const dateISO = qs.date || etDateISO(now);
  const etSlot = force
    ? (qs.slot || hhmmET(now))
    : (matchedEt || etSlotLabel(utcSlot || '1000'));

  try {
    const stored = await runOmegaLineCapture({
      force: true,
      dateISO,
      etSlot,
      now,
      includeDisabled: force,
    });
    const body = {
      date: stored.date,
      etSlot: stored.etSlot,
      utcSlot: utcSlot || (matchedEt ? 'et-guard' : 'forced'),
      gameCount: stored.gameCount,
      sports: stored.sports,
      snapKey: stored.snapKey,
      pathKey: stored.pathKey,
      store: stored.store || BLOB_STORE,
    };
    return { statusCode: 200, body: JSON.stringify(body) };
  } catch (e) {
    console.error(`[capture-omega-lines] failed: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}

exports.handler = (event) => handleCapture(event, 'capture-omega-lines');
exports.handleCapture = handleCapture;
exports.ALLOWED_UTC_HHMM = ALLOWED_UTC_HHMM;
exports.etSlotLabel = etSlotLabel;
exports.nearestAllowedSlot = nearestAllowedSlot;
