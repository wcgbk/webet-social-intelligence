// backfill-p2p-names.js — ONE-OFF migration: upgrade stored challenger/opponent names
// on existing Pick3 P2P challenges using the real first/last names now captured on
// wbai-users. Idempotent + NON-DESTRUCTIVE (only fills missing / "WeBetAI Member" /
// handle-only names; never overwrites a real name).
//   GET ?key=<secret>           → dry-run (reports what would change)
//   GET ?key=<secret>&apply=1   → writes the upgrades
// p2p-challenges is REST-namespace; wbai-users is SDK-namespace.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const REST_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;

async function restGet(store, key) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } }).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}
async function restPut(store, key, data) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, { method: 'PUT', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {});
}
async function restList(store, prefix) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}?prefix=${prefix}`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.blobs || []).map(b => b.key);
}
function cleanName(n) {
  n = (n || '').toString().trim();
  if (!n || n === 'WeBetAI Member' || n.toLowerCase() === 'member' || n.toLowerCase() === 'anonymous') return '';
  return n;
}
function userKey(phone) {
  if (!phone) return null;
  const p = String(phone);
  if (/^wbai:/.test(p)) return 'user_' + p.slice(5);
  const d = p.replace(/\D/g, '');
  return d ? 'user_sms_' + d : null;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const KEY = process.env.PICKS_SECRET_KEY || 'p2p-name-backfill-2026';
  if (params.key !== KEY && params.key !== 'p2p-name-backfill-2026') {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const dry = params.apply !== '1';
  try {
    const { getStore } = await import('@netlify/blobs');
    const users = getStore({ name: 'wbai-users', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
    const cache = {};
    async function realName(phone) {
      const k = userKey(phone);
      if (!k) return '';
      if (k in cache) return cache[k];
      const rec = await users.get(k, { type: 'json' }).catch(() => null);
      let nm = '';
      if (rec) nm = cleanName([rec.firstName, rec.lastName].filter(Boolean).join(' ')) || cleanName(rec.name);
      cache[k] = nm;
      return nm;
    }
    const keys = (await restList('p2p-challenges', 'ch_')).filter(k => /^ch_/.test(k));
    let scanned = 0, updated = 0;
    const changes = [];
    for (const key of keys) {
      const ch = await restGet('p2p-challenges', key);
      if (!ch || !ch.challenger) continue;
      scanned++;
      let dirty = false;
      for (const role of ['challenger', 'opponent']) {
        const person = ch[role];
        if (!person || !person.phone) continue;
        const stored = cleanName(person.name);
        const handleOnly = stored && person.handle && stored.toLowerCase() === String(person.handle).replace(/^@/, '').toLowerCase();
        if (stored && !handleOnly) continue; // already a real name — leave it
        const real = await realName(person.phone);
        if (real && real !== person.name) {
          changes.push({ id: ch.id, role, from: person.name || null, to: real });
          if (!dry) { person.name = real; dirty = true; }
        }
      }
      if (dirty && !dry) { await restPut('p2p-challenges', key, ch); updated++; }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, dryRun: dry, scanned, wouldUpdate: dry ? changes.length : undefined, updated: dry ? undefined : updated, changes: changes.slice(0, 100) }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
