// run-kalshi.js
// Manual trigger: POST /api/run-kalshi?key=SECRET
// Triggers the kalshi-execute-background function

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const key = event.queryStringParameters?.key || '';
  const SECRET = process.env.PICKS_SECRET_KEY || 'webet95picks2026';
  if (key !== SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const siteURL = process.env.URL || 'https://webetsocial.com';
  const liveOverride = event.queryStringParameters?.live === 'true';

  try {
    const resp = await fetch(`${siteURL}/.netlify/functions/kalshi-execute-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual: true, liveOverride, timestamp: new Date().toISOString() }),
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        triggered: true,
        backgroundStatus: resp.status,
        message: 'Kalshi execution triggered. Check /kalshi for status.',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
