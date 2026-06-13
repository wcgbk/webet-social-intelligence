// user-prefs.js — save user preferences (sports etc.) onto the wbai-users record
// POST {sports: ["NBA","MLB"]} with wbai_session cookie. Used by Betty-led onboarding
// to merge guest localStorage prefs into the account after sign-in.

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
  if (!sports || !sports.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'no_valid_sports' }) };
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

    userRecord.prefs = { ...(userRecord.prefs || {}), sports, updated_at: new Date().toISOString() };
    await users.setJSON(`user_${sessionData.user_id}`, userRecord);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, prefs: userRecord.prefs }) };
  } catch (err) {
    console.error('[user-prefs] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
