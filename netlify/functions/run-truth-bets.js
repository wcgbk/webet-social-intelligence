/**
 * run-truth-bets.js — Manual trigger for WeBet content generation
 *
 * POST /api/run-truth-bets?key=SECRET
 *
 * Invokes generate-webet-content-background.js to regenerate
 * trending topic WeBet cards for the command center.
 */

const ADMIN_SECRET = process.env.PICKS_SECRET_KEY || process.env.ADMIN_SECRET;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  const key = (event.queryStringParameters || {}).key;
  if (!key || key !== ADMIN_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  console.log('[TRUTH-BETS] Manual content generation trigger fired');

  try {
    const siteUrl = process.env.URL || 'https://webetsocial.com';
    const res = await fetch(`${siteUrl}/.netlify/functions/generate-webet-content-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual', ts: Date.now() }),
    });

    console.log(`[TRUTH-BETS] Background function status: ${res.status}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        message: 'WeBet content generation started. Refresh command center in ~90 seconds.',
        ts: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[TRUTH-BETS] Error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
