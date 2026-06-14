// user-prefs.js — save user preferences onto the wbai-users record.
// POST with wbai_session cookie. Accepts {sports:[...]} (onboarding sport prefs)
// and/or {firstName, lastName} (real identity for P2P — so friends see a real name,
// not "WeBetAI Member"). Either field group is optional; at least one required.

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
const ALLOWED_SPORTS = ['NBA', 'MLB', 'NHL', 'NFL', 'NCAAB', 'Soccer', 'All'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionId = cookies['wbai_session'];
  if (!sessionId) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* noop */ }
  const sports = Array.isArray(body.sports)
    ? body.sports.map(s => String(s).slice(0, 12)).filter(s => ALLOWED_SPORTS.includes(s)).slice(0, 6)
    : null;
  const cleanNm = s => (typeof s === 'string' ? s.replace(/[<>]/g, '').trim().slice(0, 40) : '');
  const firstName = cleanNm(body.firstName);
  const lastName = cleanNm(body.lastName);
  const hasSports = !!(sports && sports.length);
  const hasName = !!(firstName || lastName);
  if (!hasSports && !hasName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'nothing_to_update' }) };
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_TOKEN;
    const users = getStore({ name: 'wbai-users', siteID, token });

    const sessionData = await users.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
    if (!sessionData || !sessionData.user_id) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_session' }) };
    }
    if (sessionData.expires && Date.now() > sessionData.expires) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'session_expired' }) };
    }
    const userRecord = await users.get(`user_${sessionData.user_id}`, { type: 'json' }).catch(() => null);
    if (!userRecord) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'user_not_found' }) };

    if (hasSports) {
      userRecord.prefs = { ...(userRecord.prefs || {}), sports, updated_at: new Date().toISOString() };
    }
    if (hasName) {
      if (firstName) userRecord.firstName = firstName;
      if (lastName) userRecord.lastName = lastName;
      const composed = [userRecord.firstName, userRecord.lastName].filter(Boolean).join(' ').trim();
      if (composed) userRecord.name = composed;
      userRecord.name_updated_at = new Date().toISOString();
    }
    await users.setJSON(`user_${sessionData.user_id}`, userRecord);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, name: userRecord.name || null, firstName: userRecord.firstName || null, lastName: userRecord.lastName || null, prefs: userRecord.prefs || null }) };
  } catch (err) {
    console.error('[user-prefs] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
