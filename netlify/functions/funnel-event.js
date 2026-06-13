// funnel-event.js — lightweight funnel instrumentation (charter: funnel events)
// POST {e: "onboard_shown", p?: {...}}. One blob per event in the funnel-events store
// (append-only; no read-modify-write races). Anonymous by default; if a valid session
// cookie is present the canonical userId is attached. Fire-and-forget from the client.

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

const CORS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const ALLOWED_EVENTS = new Set([
  'onboard_shown', 'onboard_sports_chosen', 'onboard_edges_shown', 'onboard_signin_clicked',
  'onboard_prefs_saved', 'onboard_skipped',
  'pricing_view', 'checkout_view', 'checkout_paid', 'depth_unlock', 'login_view',
  'p2p_view', 'p2p_challenge_created', 'p2p_stake_escrowed',
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* noop */ }
  const e = String(body.e || '');
  if (!ALLOWED_EVENTS.has(e)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'unknown_event' }) };
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_TOKEN;

    // Optional identity (never required)
    let userId = null;
    const sessionId = parseCookies(event.headers.cookie || event.headers.Cookie || '')['wbai_session'];
    if (sessionId) {
      try {
        const users = getStore({ name: 'wbai-users', siteID, token });
        const s = await users.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
        if (s && s.user_id && (!s.expires || Date.now() < s.expires)) userId = s.user_id;
      } catch { /* anonymous is fine */ }
    }

    const store = getStore({ name: 'funnel-events', siteID, token });
    const day = new Date().toISOString().slice(0, 10);
    const key = `evt_${day}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const props = body.p && typeof body.p === 'object' ? JSON.parse(JSON.stringify(body.p).slice(0, 500)) : null;
    await store.setJSON(key, { e, userId, props, ts: new Date().toISOString(), ua: (event.headers['user-agent'] || '').slice(0, 80) });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[funnel-event] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
