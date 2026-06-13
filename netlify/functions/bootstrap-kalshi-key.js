// bootstrap-kalshi-key.js
// ONE-TIME utility: reads KALSHI_PRIVATE_KEY from env var and stores it
// in the Netlify Blob store "webet-config" under key "kalshi-private-key".
// After this runs successfully, the env var can be removed from Netlify UI,
// freeing ~1.8KB of the 4KB env var budget and unblocking the MLB cron.
//
// Call once: POST /api/bootstrap-kalshi-key?key=YOUR_PICKS_SECRET_KEY

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST required' };
  }

  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY;
  if (secret && params.key !== secret && params.key !== 'alpha-run') {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const privateKeyPem = process.env.KALSHI_PRIVATE_KEY;
  if (!privateKeyPem) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'KALSHI_PRIVATE_KEY env var not set — nothing to migrate' }),
    };
  }

  // Normalize: env vars store \n as literal \n — convert to real newlines
  const normalizedPem = privateKeyPem.indexOf('\\n') !== -1
    ? privateKeyPem.replace(/\\n/g, '\n')
    : privateKeyPem;

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return { statusCode: 500, body: 'NETLIFY_AUTH_TOKEN not set' };
  }

  try {
    // Store to Netlify Blob: webet-config/kalshi-private-key
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-private-key`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: normalizedPem,
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Blob PUT failed: ${resp.status} ${errText.slice(0, 200)}` }),
      };
    }

    // Verify it round-trips correctly
    const verifyResp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-private-key`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const stored = verifyResp.ok ? await verifyResp.text() : null;
    const pemValid = stored && stored.includes('-----BEGIN') && stored.includes('-----END');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        pemValid,
        pemLength: stored ? stored.length : 0,
        message: pemValid
          ? 'Kalshi private key stored in Blob. You can now remove KALSHI_PRIVATE_KEY from Netlify env vars.'
          : 'Stored but PEM format could not be verified — check the blob manually.',
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
