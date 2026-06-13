// run-picks-v2.js
// Manual trigger for optimized v2 picks generation.
// POST /.netlify/functions/run-picks-v2?key=SECRET
// Optional body: { "date": "2026-03-20" }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY || 'webetai2026';
  if (params.key !== secret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // Forward to v2 background function
  const siteUrl = process.env.URL || 'https://webetsocial.com';
  const body = event.body || '{}';

  try {
    const resp = await fetch(`${siteUrl}/.netlify/functions/generate-picks-v2-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
    console.log(`[run-picks-v2] Triggered v2 background function: ${resp.status}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ triggered: true, status: resp.status, version: 'v2' }),
    };
  } catch (err) {
    console.error('[run-picks-v2] Error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
