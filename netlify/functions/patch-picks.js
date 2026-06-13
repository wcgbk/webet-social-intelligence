// patch-picks.js — Bulk write pick data to Netlify Blobs via SDK
// POST /api/patch-picks?key=SECRET
// Body: { store: "edge-picks-95", entries: { "key": value, ... } }
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '{"error":"POST required"}' };

  const params = event.queryStringParameters || {};
  if (params.key !== process.env.PICKS_SECRET_KEY) {
    return { statusCode: 401, headers: CORS, body: '{"error":"Unauthorized"}' };
  }

  try {
    const { getStore } = await import("@netlify/blobs");
    const body = JSON.parse(event.body || '{}');
    const storeName = body.store || "edge-picks-95";
    const entries = body.entries || {};
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const store = getStore({ name: storeName, siteID, token });

    let count = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === 'string') {
        await store.set(key, value);
      } else {
        await store.setJSON(key, value);
      }
      count++;
      if (count % 10 === 0) console.log(`[patch-picks] Written ${count} entries...`);
    }

    console.log(`[patch-picks] Done: wrote ${count} entries to ${storeName}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, store: storeName, written: count }),
    };
  } catch (err) {
    console.error("[patch-picks] Error:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
