'use strict';

/**
 * GET /.netlify/functions/get-omega-unmatched?date=YYYY-MM-DD
 * READ ONLY. Private diagnostics for NFL/NCAAF names that did not resolve
 * to an ESPN id on that generate (blob omega-unmatched-{date}).
 * Does not grade, rescore, or change a card.
 */

const { readUnmatchedTeams } = require('./lib/omega-vnext/store');

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
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'date=YYYY-MM-DD required' }),
    };
  }
  try {
    const report = await readUnmatchedTeams(dateISO);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key: `omega-unmatched-${dateISO}`,
        report,
        note: 'Names that did not resolve to an ESPN id. Not part of the public card.',
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message, report: null }),
    };
  }
};
