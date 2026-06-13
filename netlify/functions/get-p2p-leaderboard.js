// get-p2p-leaderboard.js — GET /api/get-p2p-leaderboard
// Returns all users sorted by the requested metric.
// ?sort=wins|profit|wagered|streak|winrate (default: wins)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

async function blobList(store, prefix) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}?prefix=${prefix || ''}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.blobs || [];
  } catch { return []; }
}

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

  const sort = (event.queryStringParameters || {}).sort || "wins";

  try {
    const blobs = await blobList('p2p-users', 'user-');
    const users = [];

    for (const blob of blobs) {
      try {
        const key = blob.key || blob;
        const user = await blobGet('p2p-users', typeof key === 'string' ? key : String(key));
        if (user) {
          const totalBets = (user.wins || 0) + (user.losses || 0) + (user.pushes || 0);
          users.push({
            handle: user.handle || `user_${user.phone?.slice(-4) || "?"}`,
            displayName: user.displayName || null,
            wins: user.wins || 0,
            losses: user.losses || 0,
            pushes: user.pushes || 0,
            totalBets,
            winRate: (user.wins || 0) + (user.losses || 0) > 0 ? Math.round(((user.wins || 0) / ((user.wins || 0) + (user.losses || 0))) * 1000) / 10 : 0,
            totalWagered: (user.totalWagered || 0) / 100,
            totalWon: (user.totalWon || 0) / 100,
            allTimePL: (user.allTimePL || 0) / 100,
            currentStreak: user.currentStreak || 0,
            bestStreak: user.bestStreak || 0,
          });
        }
      } catch (_) {}
    }

    // Sort
    const sortFns = {
      wins: (a, b) => b.wins - a.wins,
      profit: (a, b) => b.allTimePL - a.allTimePL,
      wagered: (a, b) => b.totalWagered - a.totalWagered,
      streak: (a, b) => b.currentStreak - a.currentStreak,
      winrate: (a, b) => b.winRate - a.winRate,
    };
    users.sort(sortFns[sort] || sortFns.wins);

    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=60" },
      body: JSON.stringify({ sort, users, total: users.length }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
