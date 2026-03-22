// admin-auth.js — Netlify Function
// POST /api/admin-auth
// Simple password-based auth for WeBetSocial admin dashboard
// Validates against ADMIN_EMAIL and ADMIN_PASSWORD env vars
// Returns a base64+HMAC token valid for 24 hours

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Token helpers (used by other admin functions too) ─────────────────────────

function generateToken(email) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET not configured');

  const payload = JSON.stringify({
    email,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });

  const encoded = Buffer.from(payload).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  return `${encoded}.${hmac}`;
}

function verifyToken(token) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, hmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload.email || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { email, password } = JSON.parse(event.body || '{}');

    if (!email || !password) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Email and password required' }),
      };
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      console.error('ADMIN_EMAIL or ADMIN_PASSWORD not configured');
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'Server configuration error' }),
      };
    }

    // Constant-time comparison for both email and password
    const emailMatch =
      email.length === adminEmail.length &&
      crypto.timingSafeEqual(Buffer.from(email.toLowerCase()), Buffer.from(adminEmail.toLowerCase()));

    const passwordMatch =
      password.length === adminPassword.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(adminPassword));

    if (!emailMatch || !passwordMatch) {
      return {
        statusCode: 401,
        headers: CORS,
        body: JSON.stringify({ error: 'Invalid credentials' }),
      };
    }

    const token = generateToken(email);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ token, email }),
    };
  } catch (err) {
    console.error('admin-auth error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Authentication failed' }),
    };
  }
};

// Export for reference (other functions copy verifyAuth inline)
exports._verifyToken = verifyToken;
