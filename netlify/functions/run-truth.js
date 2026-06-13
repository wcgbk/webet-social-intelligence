/**
 * run-truth.js — Manual trigger for Authentic Press content generation
 *
 * POST /api/run-truth?key=SECRET
 * Invokes the background function to generate today's stories + reply drafts.
 */

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Simple auth
  const key = event.queryStringParameters?.key;
  const secret = process.env.PICKS_SECRET || process.env.TRUTH_SECRET;
  if (secret && key !== secret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // Invoke background function
    const siteUrl = process.env.URL || 'https://webetsocial.com';
    const res = await fetch(`${siteUrl}/.netlify/functions/generate-truth-content-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual', ts: Date.now() }),
    });

    return {
      statusCode: 202,
      headers: CORS,
      body: JSON.stringify({
        status: 'triggered',
        message: 'Authentic Press content generation started. Check /truth in ~30 seconds.',
        backgroundStatus: res.status,
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
