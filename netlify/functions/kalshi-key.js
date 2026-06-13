// kalshi-key.js
// Shared utility: returns the Kalshi RSA private key PEM.
// Priority:
//   1. process.env.KALSHI_PRIVATE_KEY (backward compat while env var still set)
//   2. Netlify Blob: webet-config/kalshi-private-key (after migration)
//
// This indirection lets us remove the ~1.8KB env var and free the 4KB Netlify budget
// without changing any signing logic in the calling functions.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

let _cachedKey = null; // module-level cache — survives warm lambda invocations

async function getKalshiPrivateKey() {
  // Fast path: env var still set (before migration or as override)
  if (process.env.KALSHI_PRIVATE_KEY) {
    const pem = process.env.KALSHI_PRIVATE_KEY;
    return pem.indexOf('\\n') !== -1 ? pem.replace(/\\n/g, '\n') : pem;
  }

  // Module cache: avoid re-fetching on warm invocations
  if (_cachedKey) return _cachedKey;

  // Fetch from Netlify Blob
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('KALSHI_PRIVATE_KEY not set and NETLIFY_AUTH_TOKEN unavailable — cannot load key from Blob');

  const resp = await fetch(
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-private-key`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!resp.ok) {
    throw new Error(`Kalshi private key not in env var or Blob (HTTP ${resp.status}). Run /api/bootstrap-kalshi-key to migrate.`);
  }

  const pem = await resp.text();
  if (!pem || !pem.includes('-----BEGIN')) {
    throw new Error('Kalshi private key fetched from Blob but PEM format invalid');
  }

  _cachedKey = pem;
  console.log('[kalshi-key] Loaded private key from Blob (env var not set)');
  return _cachedKey;
}

module.exports = { getKalshiPrivateKey };
