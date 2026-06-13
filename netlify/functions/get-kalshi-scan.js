// get-kalshi-scan.js
// Serves cached scanner results from Netlify Blobs.
// GET /api/get-kalshi-scan — returns latest cached scan
// GET /api/get-kalshi-scan?date=2026-03-31 — returns specific day's scan

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  try {
    const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ source: 'empty', message: 'Not configured' }) };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-scanner`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };
    const params = event.queryStringParameters || {};
    const date = params.date;

    const key = date ? `scan-${date}` : 'latest-scan';
    const resp = await fetch(`${storeUrl}/${key}`, { headers: authHeaders });

    if (resp.ok) {
      const cached = await resp.json();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ...cached, source: 'cache' }),
      };
    }

    // No cache — return empty with hint
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        source: 'empty',
        message: 'No cached scan available. Scanner runs automatically 3x daily (11:30am, 3pm, 7pm EDT).',
        timestamp: new Date().toISOString(),
        summary: { actionable: 0, marginal: 0, thin: 0, noMarket: 0 },
        actionableOpportunities: [],
        marginalOpportunities: [],
        allCheckedOpportunities: [],
      }),
    };
  } catch (err) {
    console.error('[get-kalshi-scan] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
