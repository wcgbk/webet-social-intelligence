/**
 * get-exodus.js — Serves Authentic Press data from Netlify Blobs
 *
 * Endpoints (via ?type= query param):
 *   GET /api/get-exodus?type=briefings  — Latest briefings
 *   GET /api/get-exodus?type=challenges — Active challenges
 *   GET /api/get-exodus?type=leaderboard — User leaderboard
 *   GET /api/get-exodus?type=stats — Dashboard stats
 *
 * Isolated blob stores: exodus-briefings, exodus-challenges
 */

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=120, s-maxage=120",
};

// ── Blob helpers ──
async function getStoreData(storeName, key, fallback = null) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: storeName, siteID, token });
    const data = await store.get(key, { type: "json" });
    return data || fallback;
  } catch (e) {
    console.log(`[EXODUS-GET] Blob read failed (${storeName}/${key}): ${e.message}`);
    // Fallback to Netlify API
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token) return fallback;
      const res = await fetch(
        `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${storeName}/${key}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return fallback;
      return await res.json();
    } catch (_) {
      return fallback;
    }
  }
}

// ── GET briefings ──
async function getBriefings() {
  // Get index of recent briefings
  const index = await getStoreData("exodus-briefings", "briefing-index", []);
  const stats = await getStoreData("exodus-briefings", "exodus-stats", {});

  // Load the last 6 briefings (2 days worth)
  const briefings = [];
  const toLoad = index.slice(0, 6);

  for (const entry of toLoad) {
    const b = await getStoreData("exodus-briefings", entry.key, null);
    if (b) briefings.push(b);
  }

  // Also pull challenge count for stats
  const challenges = await getStoreData("exodus-challenges", "challenge-list", []);

  return {
    briefings,
    stats: {
      totalBriefings: stats.totalBriefings || briefings.length,
      totalChallenges: challenges.length,
      avgAccuracy: stats.avgAccuracy || null,
      lastGenerated: stats.lastGenerated || null,
    },
  };
}

// ── GET challenges ──
async function getChallenges() {
  const challenges = await getStoreData("exodus-challenges", "challenge-list", []);

  // Sort: open first, then accepted, then resolved (most recent first)
  const statusOrder = { open: 0, accepted: 1, resolved: 2 };
  challenges.sort((a, b) => {
    const sDiff = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    if (sDiff !== 0) return sDiff;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  return { challenges };
}

// ── GET leaderboard ──
async function getLeaderboard() {
  const challenges = await getStoreData("exodus-challenges", "challenge-list", []);

  // Build leaderboard from resolved challenges
  const resolved = challenges.filter(c => c.status === "resolved" && c.winner);
  const users = {};

  for (const c of resolved) {
    // Winner
    if (c.winner) {
      if (!users[c.winner]) users[c.winner] = { handle: c.winner, wins: 0, losses: 0, streak: "" };
      users[c.winner].wins++;
    }
    // Loser
    if (c.loser) {
      if (!users[c.loser]) users[c.loser] = { handle: c.loser, wins: 0, losses: 0, streak: "" };
      users[c.loser].losses++;
    }
  }

  // Also count open/accepted challenges for active users
  const active = challenges.filter(c => c.status !== "resolved");
  for (const c of active) {
    if (!users[c.from]) users[c.from] = { handle: c.from, wins: 0, losses: 0, streak: "" };
    if (!users[c.to]) users[c.to] = { handle: c.to, wins: 0, losses: 0, streak: "" };
  }

  // Calculate win % and sort
  const leaderboard = Object.values(users)
    .map(u => ({
      ...u,
      pct: u.wins + u.losses > 0 ? Math.round((u.wins / (u.wins + u.losses)) * 100) : 0,
      total: u.wins + u.losses,
    }))
    .filter(u => u.total > 0)
    .sort((a, b) => {
      // Sort by win %, then by total games
      if (b.pct !== a.pct) return b.pct - a.pct;
      return b.total - a.total;
    })
    .slice(0, 50);

  // Calculate streaks (simplified — just show W/L count)
  for (const u of leaderboard) {
    if (u.wins > u.losses) u.streak = `${u.wins - u.losses}W`;
    else if (u.losses > u.wins) u.streak = `${u.losses - u.wins}L`;
    else u.streak = "Even";
  }

  return { leaderboard };
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  const params = event.queryStringParameters || {};
  const type = params.type || "briefings";

  try {
    let data;
    switch (type) {
      case "briefings":
        data = await getBriefings();
        break;
      case "challenges":
        data = await getChallenges();
        break;
      case "leaderboard":
        data = await getLeaderboard();
        break;
      case "stats":
        data = await getStoreData("exodus-briefings", "exodus-stats", {});
        break;
      default:
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: "Invalid type. Use: briefings, challenges, leaderboard, stats" }),
        };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(data),
    };
  } catch (e) {
    console.error("[EXODUS-GET] Error:", e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
