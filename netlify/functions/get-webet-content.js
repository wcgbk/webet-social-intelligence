/**
 * get-webet-content.js — Serves generated WeBet content cards
 *
 * GET /api/get-webet-content
 *
 * Reads from "webet-truth-posts" Netlify Blob store.
 * Written by generate-webet-content-background.js.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  let data = null;

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-truth-posts', siteID, token });
    data = await store.get('latest-posts', { type: 'json' });
  } catch (sdkErr) {
    console.log('[get-webet-content] SDK fallback to API:', sdkErr.message);
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    if (token) {
      try {
        const res = await fetch(
          `https://api.netlify.com/api/v1/blobs/${siteId}/webet-truth-posts/latest-posts`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.ok) data = await res.json();
      } catch (e) {
        console.log('[get-webet-content] API fetch failed:', e.message);
      }
    }
  }

  if (!data || !data.posts || data.posts.length === 0) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=30' },
      body: JSON.stringify({ posts: [], empty: true, generatedAt: null }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
    body: JSON.stringify(data),
  };
};
