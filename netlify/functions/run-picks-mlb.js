// run-picks-mlb.js
// Manual trigger: POST /.netlify/functions/run-picks-mlb?key=YOUR_SECRET
// Triggers the MLB F5 background pick generation function on demand.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST required" }) };
  }

  const params = event.queryStringParameters || {};
  const key = params.key;
  const secret = process.env.PICKS_SECRET_KEY;
  // 'mlb-run' is a hardcoded bypass for manual operational triggers (same pattern as alpha-run)
  if (secret && key !== secret && key !== 'mlb-run') {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-mlb-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manual: true, timestamp: new Date().toISOString(), date: params.date || undefined }),
      }
    );

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: "MLB F5 pick generation triggered. Results available in 1-2 minutes at /api/get-picks-mlb",
        status: response.status,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: err.message }),
    };
  }
};
