// auth-logout.js — Clears the WeBetAI session cookie
// POST /auth/logout
// Called by signOut() in dashboard — must be server-side to clear httpOnly cookie

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  function parseCookies(str) {
    const out = {};
    if (!str) return out;
    str.split(';').forEach(part => {
      const eq = part.indexOf('=');
      if (eq < 0) return;
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    });
    return out;
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionId = cookies['wbai_session'];

  // Optionally delete the session from Blob store
  if (sessionId) {
    try {
      const { getWbaiUsersStore } = require('./_lib/wbai-users-store');
      const store = await getWbaiUsersStore();
      await store.delete(`session_${sessionId}`).catch(() => {});
    } catch (_) {}
  }

  // Clear the session cookie
  const clearCookie = 'wbai_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

  return {
    statusCode: 200,
    headers: {
      'Set-Cookie': clearCookie,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ ok: true }),
  };
};
