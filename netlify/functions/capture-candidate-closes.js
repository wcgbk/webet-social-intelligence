'use strict';

/**
 * capture-candidate-closes — sharp close + CLV for every gate-evaluated
 * Omega candidate. Private blobs only (omega-candidates in, clv-candidates-v2
 * out). Does not write picks-{date}, clv-{date}, or any KPI.
 *
 * Schedule (netlify.toml): "*\/15 15-23,0-6 * * *"
 *   UTC union of 11:30 ET–01:30 ET next day for both EDT and EST.
 *   EDT: 15:30 UTC = 11:30 ET through 05:30 UTC = 01:30 ET.
 *   EST: 16:30 UTC = 11:30 ET through 06:30 UTC = 01:30 ET.
 * etGuard (lib/et-schedule) keeps only those ET quarter-hours. Manual calls
 * bypass the guard.
 *
 * Each run: one live Odds API /odds call per sport with a due commence
 * group (within 20 min, or started <5 min ago, no close yet). bookmakers=
 * pinnacle,circasports,lowvig,betonlineag,bookmaker (≤10 books → 1 region)
 * and markets=h2h,spreads,totals → 3 credits. GET /events is free.
 * Cap OMEGA_CANDIDATE_CLOSE_CREDIT_CAP, default 90 per ET day.
 */

const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { captureCandidateClosesV2 } = require('./lib/omega-vnext/candidate_closes_v2');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function handle(event, now = new Date(), deps) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: JSON_HEADERS, body: '' };
  }
  const etSkip = rejectUnlessEtSlot('capture-candidate-closes', event, now);
  if (etSkip) return etSkip;
  try {
    const result = await captureCandidateClosesV2({ now, ...(deps || {}) });
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(result) };
  } catch (e) {
    console.error(`[capture-candidate-closes] failed: ${e.message}`);
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: e.message }) };
  }
}

exports.handler = (event) => handle(event, new Date());
exports.handle = handle;
