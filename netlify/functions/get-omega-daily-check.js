'use strict';

/**
 * GET /.netlify/functions/get-omega-daily-check?date=YYYY-MM-DD
 * Read-only copy of the stored ops report. No secrets and no env values.
 */

const { readDailyReport, dailyCheckKey } = require('./lib/omega-vnext/daily_check');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const NOTE = 'Ops signal only. Does not change the card.';

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date ? String(qs.date) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return json(400, { ok: false, error: 'bad date (YYYY-MM-DD)' });
  }
  try {
    const report = await readDailyReport(dateISO, deps || {});
    return json(200, {
      ok: true,
      key: dailyCheckKey(dateISO),
      report: report || null,
      note: NOTE,
    });
  } catch (err) {
    const message = String(err && err.message ? err.message : 'read failed')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/apiKey=[^&\s]+/gi, 'apiKey=[redacted]')
      .slice(0, 240);
    return json(200, { ok: false, error: message, report: null });
  }
}

exports.handler = (event) => handle(event, {});
exports.handle = handle;
