'use strict';

/**
 * GET /.netlify/functions/get-omega-capture-health
 * READ ONLY ops snapshot of last Omega captureHealth (omega-ops/*).
 * Does not change hardFail policy or pick math. Optional ?date=YYYY-MM-DD.
 */

const {
  readCaptureHealthLatest,
  readCaptureHealthDate,
} = require('./lib/omega-vnext/store');

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
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key: dateISO ? `omega-ops/capture-health-${dateISO}` : 'omega-ops/capture-health-latest',
        snapshot: snap,
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
