// get-backtest.js — Serves backtest results from Netlify Blobs
// Endpoint: GET /api/get-backtest

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  const token = process.env.NETLIFY_AUTH_TOKEN;

  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/backtest-v10`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' },
        body: JSON.stringify(data),
      };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'No backtest data yet. Run backtest-v10.js first.' }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
