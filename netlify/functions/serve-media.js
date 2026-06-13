// serve-media.js — Serve uploaded media from Netlify Blobs
// GET /api/serve-media?key=media-123456.png

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'key required' };

  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '');

  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const blobUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/betty-media/${safeKey}`;

    const res = await fetch(blobUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) return { statusCode: 404, body: 'Not found' };

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = safeKey.split('.').pop() || 'png';
    const contentType = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    }[ext] || 'application/octet-stream';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
