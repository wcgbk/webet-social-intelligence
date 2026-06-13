/**
 * search-x-users.js — Search X/Twitter users by handle or name
 * GET /api/search-x-users?q=elonmusk
 * Returns: { users: [{ id, name, handle, avatar }] }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const q = (event.queryStringParameters?.q || '').trim().replace(/^@/, '');
  if (!q || q.length < 2) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ users: [] }) };
  }

  const bearer = process.env.TWITTER_BEARER_TOKEN;
  if (!bearer) {
    console.error('Missing TWITTER_BEARER_TOKEN');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'X API not configured' }) };
  }

  try {
    // Try v2 user lookup by username first (exact match)
    const exactUrl = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(q)}?user.fields=profile_image_url,name,username,id`;
    const exactRes = await fetch(exactUrl, {
      headers: { 'Authorization': `Bearer ${bearer}` },
      signal: AbortSignal.timeout(6000),
    });

    const users = [];

    if (exactRes.ok) {
      const exactData = await exactRes.json();
      if (exactData.data) {
        const u = exactData.data;
        users.push({
          id: u.id,
          name: u.name,
          handle: '@' + u.username,
          avatar: u.profile_image_url || null,
        });
      }
    }

    // Also try v2 search for partial matches using the search endpoint
    // Twitter v2 doesn't have a dedicated user search, but we can try the v1.1 endpoint
    if (users.length === 0 || q.length >= 3) {
      try {
        // v1.1 user search (requires OAuth but let's try with bearer)
        // Actually v1.1 users/search requires OAuth 1.0a, so let's use v2 tweets search
        // as a proxy to find user handles from recent tweets
        const searchUrl = `https://api.twitter.com/2/tweets/search/recent?query=from:${encodeURIComponent(q)}&max_results=10&tweet.fields=author_id&expansions=author_id&user.fields=profile_image_url,name,username`;
        const searchRes = await fetch(searchUrl, {
          headers: { 'Authorization': `Bearer ${bearer}` },
          signal: AbortSignal.timeout(6000),
        });

        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.includes?.users) {
            for (const u of searchData.includes.users) {
              // Don't add duplicates
              if (!users.find(existing => existing.id === u.id)) {
                users.push({
                  id: u.id,
                  name: u.name,
                  handle: '@' + u.username,
                  avatar: u.profile_image_url || null,
                });
              }
            }
          }
        }
      } catch (_) {
        // Fallback search failed, that's ok
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ users: users.slice(0, 10) }),
    };
  } catch (err) {
    console.error('search-x-users error:', err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ users: [] }),
    };
  }
};
