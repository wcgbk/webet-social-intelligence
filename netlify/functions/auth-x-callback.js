// auth-x-callback.js — Handles X OAuth 2.0 PKCE callback for WeBetAI dashboard
// GET /auth/x/callback?code=...&state=...
// Exchanges code for token, fetches profile, creates session, redirects to /dashboard

const { randomBytes } = require('crypto');

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

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  if (error || !code) {
    console.error('[auth-x-callback] OAuth error or missing code:', error);
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  // Parse PKCE cookie
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const pkceRaw = cookies['wbai_pkce'];

  if (!pkceRaw) {
    console.error('[auth-x-callback] Missing PKCE cookie');
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  let pkce;
  try {
    pkce = JSON.parse(Buffer.from(pkceRaw, 'base64').toString('utf8'));
  } catch (e) {
    console.error('[auth-x-callback] Failed to parse PKCE cookie:', e.message);
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  // Verify CSRF state
  if (pkce.state !== state) {
    console.error('[auth-x-callback] State mismatch — possible CSRF');
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  const clientId = process.env.TWITTER_CLIENT_ID || 'NXN6TlUyZnFKbFJFSU5LbU9tVGg6MTpjaQ';
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const REDIRECT_URI = 'https://webetsocial.com/auth/x/callback';

  // Exchange auth code for access token
  const tokenHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientSecret) {
    tokenHeaders['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: tokenHeaders,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
      client_id: clientId,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('[auth-x-callback] Token exchange failed:', tokenRes.status, err);
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    console.error('[auth-x-callback] No access token in response');
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  // Fetch X user profile — try with extended fields first, fall back to minimal
  let xUser = null;
  const fieldSets = [
    'profile_image_url,description,public_metrics,created_at,location',  // no verified/verified_type (restricted)
    'profile_image_url,public_metrics',                                   // minimal fallback
    '',                                                                    // bare minimum
  ];

  for (const fields of fieldSets) {
    const url = fields
      ? `https://api.x.com/2/users/me?user.fields=${fields}`
      : 'https://api.x.com/2/users/me';
    const profileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (profileRes.ok) {
      const profileData = await profileRes.json();
      xUser = profileData.data || null;
      if (xUser) break;
    } else {
      const errBody = await profileRes.text();
      console.error('[auth-x-callback] Profile fetch failed:', profileRes.status, url, errBody);
      if (profileRes.status !== 403 && profileRes.status !== 400) break; // only retry on 403/400
    }
  }

  if (!xUser) {
    console.error('[auth-x-callback] Could not retrieve user profile after all attempts');
    return { statusCode: 302, headers: { Location: '/dashboard?auth=error' }, body: '' };
  }

  // Store user + session in Netlify Blobs
  const now = new Date().toISOString();
  const sessionId = randomBytes(32).toString('hex');

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({
      name: 'wbai-users',
      siteID: process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606',
      token: process.env.NETLIFY_TOKEN,
    });

    // Preserve existing credit balance if user already exists
    const existingUser = await store.get(`user_${xUser.id}`, { type: 'json' }).catch(() => null);
    const creditBalance = existingUser?.credit_balance ?? 1000;
    const createdAt = existingUser?.created_at ?? now;

    const userRecord = {
      id: xUser.id,
      name: xUser.name,
      handle: xUser.username,
      avatar_url: (xUser.profile_image_url || '').replace('_normal', '_400x400') || null,
      description: xUser.description || null,
      location: xUser.location || null,
      followers: xUser.public_metrics?.followers_count || 0,
      following: xUser.public_metrics?.following_count || 0,
      tweet_count: xUser.public_metrics?.tweet_count || 0,
      verified_type: xUser.verified_type || null,
      provider: 'x',
      credit_balance: creditBalance,
      created_at: createdAt,
      last_seen: now,
      // Store tokens server-side only — never sent to client
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
    };

    await store.set(`user_${xUser.id}`, JSON.stringify(userRecord));

    // Create session (30 day TTL tracked in payload)
    const sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await store.set(`session_${sessionId}`, JSON.stringify({ user_id: xUser.id, expires: sessionExpiry }));
  } catch (e) {
    console.error('[auth-x-callback] Blob store error:', e.message);
    // Don't fail the login — session just won't persist server-side
  }

  // Set session cookie (30 days) + clear PKCE cookie
  const sessionCookie = `wbai_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  const clearPkce = `wbai_pkce=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

  return {
    statusCode: 302,
    multiValueHeaders: {
      'Location': ['/dashboard?auth=success'],
      'Set-Cookie': [sessionCookie, clearPkce],
      'Cache-Control': ['no-store'],
    },
    body: '',
  };
};
