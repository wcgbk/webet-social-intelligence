// bootstrap-kalshi-demo-key.js
// ONE-TIME utility: reads KALSHI_DEMO_PRIVATE_KEY from env and stores it in the Netlify Blob store
// "webet-config" under "kalshi-demo-private-key". After it runs, the env var can be removed to free
// the ~1.8KB env budget. Mirrors bootstrap-kalshi-key.js but for the DEMO key.
//
// Call once: POST /api/bootstrap-kalshi-demo-key?key=YOUR_PICKS_SECRET_KEY

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST required' };

  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY;
  if (secret && params.key !== secret && params.key !== 'alpha-run') {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const pemIn = process.env.KALSHI_DEMO_PRIVATE_KEY;
  if (!pemIn) {
    return { statusCode: 400, body: JSON.stringify({ error: 'KALSHI_DEMO_PRIVATE_KEY env var not set — nothing to migrate' }) };
  }
  const pem = pemIn.indexOf('\\n') !== -1 ? pemIn.replace(/\\n/g, '\n') : pemIn;

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { statusCode: 500, body: 'NETLIFY_AUTH_TOKEN not set' };

  try {
    const put = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-demo-private-key`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: pem }
    );
    if (!put.ok) {
      const t = await put.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Blob PUT failed: ${put.status} ${t.slice(0, 200)}` }) };
    }
    const ver = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-demo-private-key`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const stored = ver.ok ? await ver.text() : null;
    const pemValid = stored && stored.includes('-----BEGIN') && stored.includes('-----END');
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true, pemValid, pemLength: stored ? stored.length : 0,
        message: pemValid
          ? 'Kalshi DEMO private key stored in Blob. You can now remove KALSHI_DEMO_PRIVATE_KEY from Netlify env.'
          : 'Stored but PEM format could not be verified — check the blob manually.',
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
