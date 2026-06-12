// auth-x-init.js — Initiates X OAuth 2.0 PKCE login flow for WeBetAI dashboard
// GET /.netlify/functions/auth-x-init
// Generates code_verifier + code_challenge, stores in cookie, redirects to X auth page

const { createHash, randomBytes } = require('crypto');

function base64url(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

exports.handler = async (event) => {
  const clientId = process.env.TWITTER_CLIENT_ID || 'NXN6TlUyZnFKbFJFSU5LbU9tVGg6MTpjaQ';
  const REDIRECT_URI = 'https://webetsocial.com/auth/x/callback';

  // Generate PKCE values
  const codeVerifier = base64url(randomBytes(48));  // 64-char URL-safe string
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(16));          // CSRF protection

  // Build X auth URL — x.com domain, NOT twitter.com: on mobile, users who log in
  // during the flow get their session on x.com; twitter.com/i/oauth2/authorize then
  // re-prompts "you have to be logged in" in a loop (verified on real iPhone 2026-06-12).
  const authUrl = new URL('https://x.com/i/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', 'tweet.read users.read offline.access');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // Store verifier + state in a short-lived httpOnly cookie (5 min)
  const pkcePayload = Buffer.from(JSON.stringify({ verifier: codeVerifier, state })).toString('base64');
  const cookie = `wbai_pkce=${pkcePayload}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;

  return {
    statusCode: 302,
    headers: {
      'Location': authUrl.toString(),
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
};
