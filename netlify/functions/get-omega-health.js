'use strict';

/**
 * GET /.netlify/functions/get-omega-health?date=YYYY-MM-DD
 * READ ONLY. Private generate-time health (blob omega-health-{date}).
 * Default is the latest stored record, else today ET. Does not grade or regenerate.
 */

const { readHealthRecord, readHealthLatest } = require('./lib/omega-vnext/store');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const qs = (event && event.queryStringParameters) || {};
  let dateISO = qs.date || null;
  if (dateISO && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'date=YYYY-MM-DD required' }),
    };
  }
  try {
    if (!dateISO) {
      const latest = await readHealthLatest();
      dateISO = (latest && latest.date) || todayET();
    }
    const report = await readHealthRecord(dateISO);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key: `omega-health-${dateISO}`,
        report,
        note: 'Generate-time health. Not part of the public card.',
      }),
    };
  } catch (e) {
    const status = e && e.status >= 500 ? e.status : 500;
    return {
      statusCode: status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message, report: null }),
    };
  }
};
