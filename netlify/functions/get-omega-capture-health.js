'use strict';

/**
 * GET /.netlify/functions/get-omega-capture-health
 * READ ONLY ops snapshot of last Omega captureHealth (omega-ops/*).
 * Does not change hardFail policy or pick math. Optional ?date=YYYY-MM-DD.
 */

const {
  readCaptureHealthLatest,
  readCaptureHealthDate,
  readJson,
} = require('./lib/omega-vnext/store');
const { coverageBySportMarket, candidateCloseKey } = require('./lib/omega-vnext/candidate_closes_v2');
const { etParts } = require('./lib/et-schedule');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  try {
    let snap = null;
    if (dateISO) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ ok: false, error: 'bad date (YYYY-MM-DD)' }),
        };
      }
      snap = await readCaptureHealthDate(dateISO);
    } else {
      snap = await readCaptureHealthLatest();
    }
    const coverageDate = dateISO || etParts(new Date()).ymd;
    let candidateCloses = null;
    try {
      const closeBlob = await readJson(candidateCloseKey(coverageDate));
      const rows = closeBlob && Array.isArray(closeBlob.candidates) ? closeBlob.candidates : [];
      const bySportMarket = coverageBySportMarket(rows);
      const candidates = rows.length;
      const withClose = rows.filter((row) => row && row.closeNoVig != null).length;
      candidateCloses = {
        date: coverageDate,
        key: candidateCloseKey(coverageDate),
        candidates,
        withClose,
        pct: candidates ? Math.round((1000 * withClose) / candidates) / 10 : 0,
        bySportMarket,
      };
    } catch (err) {
      candidateCloses = null;
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key: dateISO ? `omega-ops/capture-health-${dateISO}` : 'omega-ops/capture-health-latest',
        snapshot: snap,
        candidateCloses,
        note: 'Ops signal only — does not change CAPTURE_HEALTH hardFail or live pick selection.',
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message, snapshot: null }),
    };
  }
};
