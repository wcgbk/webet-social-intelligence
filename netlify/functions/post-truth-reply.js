/**
 * post-truth-reply.js — Post approved content to Truth Social
 *
 * Uses the Mastodon-compatible API at truthsocial.com.
 * POST /api/post-truth-reply
 * Body: { text, inReplyToId?, delay? }
 *
 * Auth: Requires TRUTH_SOCIAL_TOKEN env var (OAuth bearer token)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TRUTH_API = 'https://truthsocial.com/api/v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  const token = process.env.TRUTH_SOCIAL_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'TRUTH_SOCIAL_TOKEN not configured',
        setup: 'Set TRUTH_SOCIAL_TOKEN env var in Netlify with your Truth Social OAuth bearer token',
      }),
    };
  }

  try {
    const { text, inReplyToId, delay } = JSON.parse(event.body || '{}');

    if (!text || text.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text is required' }) };
    }

    if (text.length > 500) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Text exceeds 500 char Truth Social limit' }) };
    }

    // Random delay (1-7 min) to appear human-like, if requested
    if (delay) {
      const delayMs = Math.floor(Math.random() * 360000) + 60000; // 1-7 min
      await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 30000))); // cap at 30s for function timeout
    }

    // Post via Mastodon-compatible API
    const body = { status: text };
    if (inReplyToId) body.in_reply_to_id = inReplyToId;

    const res = await fetch(`${TRUTH_API}/statuses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({
          error: 'Truth Social API error',
          status: res.status,
          detail: errText,
        }),
      };
    }

    const posted = await res.json();

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        id: posted.id,
        url: posted.url || posted.uri,
        text: posted.content,
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
