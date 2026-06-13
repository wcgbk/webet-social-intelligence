/**
 * exodus-challenge.js — Challenge CRUD for Authentic Press
 *
 * POST /api/exodus-challenge
 *
 * Actions:
 *   { action: "create", from, to, claim, deadline, stakes }
 *   { action: "accept", challengeId }
 *   { action: "resolve", challengeId, winner }
 *
 * Stores everything in exodus-challenges blob store (isolated).
 */

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Blob helpers ──
async function getStore() {
  const { getStore: gs } = await import("@netlify/blobs");
  const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  const token = process.env.NETLIFY_AUTH_TOKEN || "";
  return gs({ name: "exodus-challenges", siteID, token });
}

async function getChallengeList() {
  try {
    const store = await getStore();
    return (await store.get("challenge-list", { type: "json" })) || [];
  } catch (_) {
    return [];
  }
}

async function saveChallengeList(list) {
  try {
    const store = await getStore();
    await store.setJSON("challenge-list", list);
    return true;
  } catch (e) {
    console.error("[EXODUS-CH] Save error:", e.message);
    // Fallback to API
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token) return false;
      await fetch(
        `https://api.netlify.com/api/v1/blobs/${SITE_ID}/exodus-challenges/challenge-list`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(list),
        }
      );
      return true;
    } catch (_) {
      return false;
    }
  }
}

// ── Generate short ID ──
function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Create challenge ──
async function createChallenge({ from, to, claim, deadline, stakes }) {
  if (!from || !to || !claim) {
    return { ok: false, error: "Missing required fields: from, to, claim" };
  }

  // Sanitize handles
  from = from.replace(/^@/, "").trim().slice(0, 50);
  to = to.replace(/^@/, "").trim().slice(0, 50);
  claim = claim.trim().slice(0, 500);
  stakes = ["free", "1", "5", "25"].includes(String(stakes)) ? String(stakes) : "free";

  const challenge = {
    id: shortId(),
    from,
    to,
    claim,
    deadline: deadline || null,
    stakes,
    status: "open",
    createdAt: new Date().toISOString(),
    winner: null,
    loser: null,
    resolvedAt: null,
  };

  const list = await getChallengeList();
  list.unshift(challenge);

  // Cap at 500 challenges
  if (list.length > 500) list.length = 500;

  const saved = await saveChallengeList(list);
  if (!saved) {
    return { ok: false, error: "Failed to save challenge" };
  }

  // Update stats
  try {
    const { getStore: gs } = await import("@netlify/blobs");
    const siteID2 = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token2 = process.env.NETLIFY_AUTH_TOKEN || "";
    const bStore = gs({ name: "exodus-briefings", siteID: siteID2, token: token2 });
    let stats = {};
    try { stats = (await bStore.get("exodus-stats", { type: "json" })) || {}; } catch (_) {}
    stats.totalChallenges = list.length;
    await bStore.setJSON("exodus-stats", stats);
  } catch (_) {}

  console.log(`[EXODUS-CH] Challenge created: ${challenge.id} — @${from} vs @${to}`);
  return { ok: true, challenge };
}

// ── Accept challenge ──
async function acceptChallenge({ challengeId }) {
  if (!challengeId) return { ok: false, error: "Missing challengeId" };

  const list = await getChallengeList();
  const idx = list.findIndex(c => c.id === challengeId);
  if (idx === -1) return { ok: false, error: "Challenge not found" };

  if (list[idx].status !== "open") {
    return { ok: false, error: "Challenge is not open" };
  }

  list[idx].status = "accepted";
  list[idx].acceptedAt = new Date().toISOString();

  const saved = await saveChallengeList(list);
  if (!saved) return { ok: false, error: "Failed to save" };

  console.log(`[EXODUS-CH] Challenge accepted: ${challengeId}`);
  return { ok: true, challenge: list[idx] };
}

// ── Resolve challenge ──
async function resolveChallenge({ challengeId, winner }) {
  if (!challengeId || !winner) return { ok: false, error: "Missing challengeId or winner" };

  const list = await getChallengeList();
  const idx = list.findIndex(c => c.id === challengeId);
  if (idx === -1) return { ok: false, error: "Challenge not found" };

  const c = list[idx];
  if (c.status === "resolved") {
    return { ok: false, error: "Already resolved" };
  }

  // Winner must be one of the participants
  const winnerHandle = winner.replace(/^@/, "").trim();
  if (winnerHandle !== c.from && winnerHandle !== c.to) {
    return { ok: false, error: "Winner must be a participant" };
  }

  c.status = "resolved";
  c.winner = winnerHandle;
  c.loser = winnerHandle === c.from ? c.to : c.from;
  c.resolvedAt = new Date().toISOString();

  list[idx] = c;
  const saved = await saveChallengeList(list);
  if (!saved) return { ok: false, error: "Failed to save" };

  console.log(`[EXODUS-CH] Challenge resolved: ${challengeId} — Winner: @${c.winner}`);
  return { ok: true, challenge: c };
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { action } = body;

    let result;
    switch (action) {
      case "create":
        result = await createChallenge(body);
        break;
      case "accept":
        result = await acceptChallenge(body);
        break;
      case "resolve":
        result = await resolveChallenge(body);
        break;
      default:
        result = { ok: false, error: "Invalid action. Use: create, accept, resolve" };
    }

    return {
      statusCode: result.ok ? 200 : 400,
      headers: CORS,
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error("[EXODUS-CH] Error:", e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
