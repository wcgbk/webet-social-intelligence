// get-p2p-user.js — GET /api/get-p2p-user?phone=xxx or ?handle=xxx
// Returns user stats and recent challenge history.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

async function blobGet(store, key) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const params = event.queryStringParameters || {};
  const phone = params.phone;
  const handle = params.handle;

  if (!phone && !handle) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "phone or handle required" }) };
  }

  try {
    let userKey = phone ? phone.replace(/\D/g, "") : null;

    // If handle provided, look up phone from handle index
    if (!userKey && handle) {
      const key = await blobGet('p2p-users', `handle-${handle.toLowerCase()}`);
      if (key) userKey = typeof key === 'string' ? key.trim() : String(key).trim();
    }

    if (!userKey) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "User not found" }) };

    const user = await blobGet('p2p-users', `user-${userKey}`);
    if (!user) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "User not found" }) };

    // Fetch recent challenges for this user
    let recentChallenges = [];
    try {
      const idx = await blobGet('p2p-challenges', 'index-' + (user.phone || userKey));
      if (idx && idx.challenges) {
        for (const cid of idx.challenges.slice(0, 10)) {
          const ch = await blobGet('p2p-challenges', cid);
          if (ch) recentChallenges.push({
            id: ch.id,
            date: ch.date,
            status: ch.status,
            wager: ch.wager,
            challengerName: ch.challenger?.name,
            opponentName: ch.opponent?.name,
            challengerPicks: ch.challenger?.picks || [],
            opponentPicks: ch.opponent?.picks || [],
            isChallenger: (ch.challenger?.phone || '').replace(/\D/g, '') === (user.phone || userKey),
          });
        }
      }
    } catch (_) {}

    // Mask phone for privacy
    const maskedPhone = user.phone ? `***${user.phone.slice(-4)}` : null;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        handle: user.handle,
        displayName: user.displayName,
        phone: maskedPhone,
        wins: user.wins || 0,
        losses: user.losses || 0,
        pushes: user.pushes || 0,
        totalBets: (user.wins || 0) + (user.losses || 0) + (user.pushes || 0),
        winRate: (user.wins || 0) + (user.losses || 0) > 0 ? Math.round(((user.wins || 0) / ((user.wins || 0) + (user.losses || 0))) * 1000) / 10 : 0,
        totalWagered: (user.totalWagered || 0) / 100,
        totalWon: (user.totalWon || 0) / 100,
        allTimePL: (user.allTimePL || 0) / 100,
        currentStreak: user.currentStreak || 0,
        bestStreak: user.bestStreak || 0,
        createdAt: user.createdAt,
        recentChallenges,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
