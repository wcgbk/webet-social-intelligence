// get-clv-summary.js
// GET /.netlify/functions/get-clv-summary?book=alpha|omega&from=YYYY-MM-DD&to=YYYY-MM-DD
// Wires existing track-clv / track-clv-omega clv-{date} blobs. Honest nulls if missing.

const { summarizeClvFromStore, emptySummary } = require('./lib/clv-summary');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const STORES = {
  alpha: 'edge-picks-alpha',
  omega: 'edge-picks-omega',
};

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dateRange(from, to) {
  const dates = [];
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const params = event.queryStringParameters || {};
  const book = (params.book || 'alpha').toLowerCase();
  const storeName = STORES[book];
  if (!storeName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'book must be alpha or omega' }) };
  }
  const from = (params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from)) ? params.from : '2026-09-05';
  const to = (params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to)) ? params.to : todayET();

  const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ book, from, to, ...emptySummary('not configured') }) };
  }
  const authHeaders = { Authorization: `Bearer ${token}` };
  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${storeName}`;
  const dates = dateRange(from, to);
  const clv = await summarizeClvFromStore({ storeUrl, authHeaders, dates });
  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
    body: JSON.stringify({ book, from, to, ...clv }),
  };
};
