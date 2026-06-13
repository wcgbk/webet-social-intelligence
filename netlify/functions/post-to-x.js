/**
 * post-to-x.js — Post to X via API v2
 *
 * POST /api/post-to-x
 * Body: { text }
 *
 * Uses OAuth 1.0a (user context) to post tweets.
 * Supports long-form posts up to 25,000 chars for X Premium users.
 */

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── OAuth 1.0a signature (same pattern as search-x.js) ──
function buildOAuthHeader(method, url, params, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...params };
  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(creds.consumerSecret)}&${encodeURIComponent(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const header = 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return header;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  const creds = {
    consumerKey: process.env.TWITTER_CONSUMER_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  };

  if (!creds.consumerKey || !creds.accessToken) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'X API OAuth credentials not configured' }) };
  }

  try {
    const { text } = JSON.parse(event.body || '{}');

    if (!text || text.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text is required' }) };
    }

    if (text.length > 25000) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Text exceeds 25,000 char X limit' }) };
    }

    const tweetUrl = 'https://api.x.com/2/tweets';
    const tweetBody = { text };

    const authHeader = buildOAuthHeader('POST', tweetUrl, {}, creds);

    const res = await fetch(tweetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(tweetBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ error: 'X API error', status: res.status, detail: errText }),
      };
    }

    const posted = await res.json();
    const tweetId = posted.data?.id;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        id: tweetId,
        url: tweetId ? `https://x.com/i/status/${tweetId}` : null,
      }),
    };
  } catch (err) {
    console.error('[post-to-x] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
