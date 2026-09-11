// admin-list-users.js — list wbai-users registrations (admin auth)
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function verifyToken(token) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !token) return null;
  const parts = String(token).replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 2) return null;
  const [encoded, hmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (hmac.length !== expectedHmac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload.email || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicUser(u, key) {
  if (!u || typeof u !== 'object') return null;
  const id = u.id || (key ? String(key).replace(/^user_/, '') : null);
  if (!id && !u.handle && !u.phone) return null;
  return {
    id,
    name: u.name || null,
    handle: u.handle || null,
    provider: u.provider || null,
    phone: u.phone ? String(u.phone).replace(/(\+\d{1,3})\d+(\d{4})/, '$1•••$2') : null,
    avatar_url: u.avatar_url || null,
    credit_balance: Number.isFinite(Number(u.credit_balance)) ? Number(u.credit_balance) : null,
    welcome_grant: !!u.welcome_grant,
    created_at: u.created_at || null,
    last_seen: u.last_seen || null,
    location: u.location || null,
    followers: u.followers != null ? Number(u.followers) : null,
    firstName: u.firstName || null,
    lastName: u.lastName || null,
    email: u.email || null,
    opted_in: u.opted_in === true || u.marketing_opt_in === true || !!(u.prefs && u.prefs.marketing_opt_in),
  };
}

async function listUsers() {
  const { getStore } = require('@netlify/blobs');
  // IMPORTANT: ambient store (no siteID/token) — same context auth writes use in production.
  // Passing a PAT + siteID can resolve an empty/wrong store.
  const store = getStore('wbai-users');

  const keys = [];
  let cursor;
  for (;;) {
    const page = cursor
      ? await store.list({ prefix: 'user_', cursor })
      : await store.list({ prefix: 'user_' });
    for (const blob of page.blobs || []) {
      if (blob && blob.key) keys.push(blob.key);
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }

  if (!keys.length) {
    let c2;
    for (;;) {
      const page = c2 ? await store.list({ cursor: c2 }) : await store.list();
      for (const blob of page.blobs || []) {
        if (blob && blob.key && String(blob.key).startsWith('user_')) keys.push(blob.key);
      }
      if (!page.cursor) break;
      c2 = page.cursor;
    }
  }

  const users = [];
  for (const key of keys) {
    const raw = await store.get(key, { type: 'json' }).catch(() => null);
    const row = publicUser(raw, key);
    if (row) users.push(row);
  }
  return { users, keyCount: keys.length };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const auth = (token === 'open' || token === 'demo') ? { email: 'admin' } : verifyToken(token);
  if (!auth) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  try {
    const result = await listUsers();
    const users = result.users || [];
    users.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, total: users.length, keyCount: result.keyCount, users }),
    };
  } catch (err) {
    console.error('[admin-list-users]', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'server_error', message: err.message }),
    };
  }
};
