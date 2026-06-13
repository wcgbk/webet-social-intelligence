/**
 * get-truth-feed.js — Fetch Ben's (@AP) Truth Social timeline
 *
 * GET /api/get-truth-feed?limit=20
 *
 * Uses Mastodon-compatible API at truthsocial.com.
 * Returns recent posts for the command center feed sidebar.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const TRUTH_API = 'https://truthsocial.com/api/v1';

// Cache account ID across warm invocations
let cachedAccountId = null;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };
  }

  const token = process.env.TRUTH_SOCIAL_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'TRUTH_SOCIAL_TOKEN not configured' }) };
  }

  const limit = Math.min(40, parseInt((event.queryStringParameters || {}).limit) || 20);
  const authHeaders = { 'Authorization': `Bearer ${token}` };

  try {
    // Get account ID (cached across warm invocations)
    if (!cachedAccountId) {
      const credRes = await fetch(`${TRUTH_API}/accounts/verify_credentials`, { headers: authHeaders });
      if (!credRes.ok) {
        const errText = await credRes.text();
        return { statusCode: credRes.status, headers: CORS, body: JSON.stringify({ error: 'Truth Social auth failed', detail: errText }) };
      }
      const cred = await credRes.json();
      cachedAccountId = cred.id;
    }

    // Fetch timeline
    const statusRes = await fetch(
      `${TRUTH_API}/accounts/${cachedAccountId}/statuses?limit=${limit}&exclude_replies=false`,
      { headers: authHeaders }
    );

    if (!statusRes.ok) {
      const errText = await statusRes.text();
      return { statusCode: statusRes.status, headers: CORS, body: JSON.stringify({ error: 'Failed to fetch timeline', detail: errText }) };
    }

    const statuses = await statusRes.json();

    // Map to slim shape — strip HTML tags for plain text
    const posts = statuses.map(s => ({
      id: s.id,
      text: (s.content || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim(),
      html: s.content || '',
      url: s.url || s.uri || `https://truthsocial.com/@AP/posts/${s.id}`,
      createdAt: s.created_at,
      repliesCount: s.replies_count || 0,
      reblogsCount: s.reblogs_count || 0,
      favouritesCount: s.favourites_count || 0,
      inReplyToId: s.in_reply_to_id || null,
    }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ posts, accountId: cachedAccountId }),
    };
  } catch (err) {
    console.error('[get-truth-feed] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
