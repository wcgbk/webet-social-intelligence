// upload-media.js — Upload base64 image to Netlify Blobs, return public URL
// POST /api/upload-media
// Body: { data: "base64string", type: "image/png", name: "photo.png", key: "adminkey" }
// Returns: { url: "https://..." }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { data, type, name, key } = body;

    const secret = process.env.PICKS_SECRET_KEY;
    if (secret && key !== secret) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    if (!data) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'data (base64) required' }) };
    }

    // Strip data URI prefix if present
    const base64 = data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length > 5 * 1024 * 1024) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'File too large (max 5MB)' }) };
    }

    // Generate unique key
    const ts = Date.now();
    const ext = (type || 'image/png').split('/')[1] || 'png';
    const blobKey = `media-${ts}.${ext}`;

    // Store in Netlify Blobs
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const blobUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/betty-media/${blobKey}`;

    const putRes = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': type || 'image/png',
      },
      body: buffer,
    });

    if (!putRes.ok) {
      throw new Error('Blob upload failed: ' + putRes.status);
    }

    // Serve via a function URL that reads the blob
    const publicUrl = `https://webetsocial.com/.netlify/functions/serve-media?key=${blobKey}`;

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ success: true, url: publicUrl, key: blobKey }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
