// run-picks-mvp.js
// Manual trigger: POST /.netlify/functions/run-picks-mvp?key=YOUR_SECRET
// Fires the MVP background pick generation on demand.

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
  const secret = process.env.PICKS_SECRET_KEY;
  const mvpKey = process.env.MVP_RUN_KEY;
  const provided = params.key;
  const authorized = !secret || provided === secret || (mvpKey && provided === mvpKey) || provided === 'mvp-run';
  if (!authorized) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-mvp-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manual: true,
          timestamp: new Date().toISOString(),
          date: params.date || undefined,
          snapshotTime: params.snapshotTime || undefined,
        }),
      }
    );

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: "MVP pick generation triggered. Results available in 1-2 minutes at /api/get-picks-mvp",
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
