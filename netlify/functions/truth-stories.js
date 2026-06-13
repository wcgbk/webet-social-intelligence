/**
 * truth-stories.js — Serves today's Authentic Press story analysis
 *
 * Reads from Netlify Blobs (written by generate-truth-content-background.js)
 * Falls back to live generation if no cached stories exist.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const EMPTY = (date) => ({
  date: date || new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  stories: [],
  marketsChecked: 0,
  empty: true,
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const todayKey = new Date().toISOString().split('T')[0];
  const yesterdayKey = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Try Blobs SDK first, then fall back to Netlify API
  let data = null;

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('truth-stories');
    data = await store.get(todayKey, { type: 'json' });
    if (!data || !data.stories || data.stories.length === 0) {
      data = await store.get(yesterdayKey, { type: 'json' });
      if (data) data.stale = true;
    }
  } catch (sdkErr) {
    console.log('[truth-stories] SDK fallback to API:', sdkErr.message);
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    if (token) {
      const base = `https://api.netlify.com/api/v1/blobs/${siteId}/truth-stories`;
      const headers = { Authorization: `Bearer ${token}` };
      for (const key of [todayKey, yesterdayKey]) {
        try {
          const res = await fetch(`${base}/${key}`, { headers });
          if (res.ok) {
            data = await res.json();
            if (key === yesterdayKey && data) data.stale = true;
            if (data && data.stories && data.stories.length > 0) break;
          }
        } catch (e) {
          console.log('[truth-stories] API fetch failed for', key);
        }
      }
    }
  }

  if (!data || !data.stories || data.stories.length === 0) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify(EMPTY()),
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify(data),
  }
};
