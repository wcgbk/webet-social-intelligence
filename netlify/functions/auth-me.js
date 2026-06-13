// auth-me.js — Returns current authenticated user from session cookie
// GET /auth/me
// Used by /dashboard on load to restore auth state

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  str.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionId = cookies['wbai_session'];

  if (!sessionId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({
      name: 'wbai-users',
      siteID: process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606',
      token: process.env.NETLIFY_TOKEN,
    });

    // Look up session
    const sessionData = await store.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
    if (!sessionData || !sessionData.user_id) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_session' }) };
    }

    // Check session expiry
    if (sessionData.expires && Date.now() > sessionData.expires) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'session_expired' }) };
    }

    // Look up user record
    const userRecord = await store.get(`user_${sessionData.user_id}`, { type: 'json' }).catch(() => null);
    if (!userRecord) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'user_not_found' }) };
    }

    // Return public fields only — never send tokens to client
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        id: userRecord.id,
        name: userRecord.name,
        handle: userRecord.handle,
        avatar_url: userRecord.avatar_url,
        description: userRecord.description,
        followers: userRecord.followers,
        credit_balance: userRecord.credit_balance || 1000,
        provider: userRecord.provider,
        created_at: userRecord.created_at,
      }),
    };
  } catch (err) {
    console.error('[auth-me] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
