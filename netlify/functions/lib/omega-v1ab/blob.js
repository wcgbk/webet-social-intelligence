'use strict';
/** Minimal blob access: SDK first, Netlify REST fallback (blobs lib not always bundled). */
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
function store(name) {
  const rest = async (key, opts = {}) => {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
    return fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${name}/${encodeURIComponent(key)}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: opts.body,
    });
  };
  const sdk = async () => { const { getStore } = await import('@netlify/blobs'); return getStore(name); };
  return {
    async getJSON(key) {
      try { return await (await sdk()).get(key, { type: 'json' }); } catch (_) {
        const r = await rest(key); if (!r.ok) return null; return r.json();
      }
    },
    async setJSON(key, val) {
      try { return await (await sdk()).setJSON(key, val); } catch (_) {
        const r = await rest(key, { method: 'PUT', body: JSON.stringify(val) });
        if (!r.ok) throw new Error(`blob PUT ${name}/${key} -> ${r.status}`);
      }
    },
  };
}
module.exports = { store };
