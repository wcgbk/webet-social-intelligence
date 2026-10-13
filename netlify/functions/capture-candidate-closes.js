'use strict';

/**
 * capture-candidate-closes — sharp close + CLV for every gate-evaluated
 * Omega candidate. Private blobs only (omega-candidates in, clv-candidates-v2
 * out). Does not write picks-{date}, clv-{date}, or any KPI.
 *
 * Suspended. Closing lines come from the 3:00 ET historical capture.
 * A scheduled invoke still answers the ET guard. Every allowed invoke
 * returns before captureCandidateClosesV2 and does not call the Odds API.
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
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ok: true,
      skipped: 'odds-api-window',
      message: 'Closing lines come from the 3:00 ET historical capture. This job does not call the Odds API.',
    }),
  };
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
