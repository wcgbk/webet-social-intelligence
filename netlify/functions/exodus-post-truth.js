/**
 * exodus-post-truth.js — Auto-post Authentic Press Briefings to Truth Social
 *
 * Called after exodus-scan-background generates a new briefing.
 * Posts a thread to @AP on Truth Social:
 *   Post 1: Briefing header + first topic
 *   Post 2-5: Remaining topics (threaded replies)
 *   Final post: CTA to /exodus for challenges
 *
 * POST /api/exodus-post-truth (called internally by scan-background)
 * Also callable manually: POST /api/exodus-post-truth?key=SECRET
 *
 * Truth Social API: Mastodon-compatible at https://truthsocial.com/api/v1
 * 500 char limit per post.
 */

const TRUTH_API = "https://truthsocial.com/api/v1";
const TRUTH_TOKEN = process.env.TRUTH_SOCIAL_TOKEN;
const AUTH_KEY = process.env.PICKS_SECRET_KEY || process.env.ADMIN_SECRET;
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Post to Truth Social ──
async function postTruth(text, replyToId = null) {
  const body = { status: text };
  if (replyToId) body.in_reply_to_id = replyToId;

  const res = await fetch(`${TRUTH_API}/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TRUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[EXODUS-POST] Truth Social error (${res.status}): ${err}`);
    // Return error info for debugging
    return { error: true, status: res.status, message: err };
  }

  const data = await res.json();
  console.log(`[EXODUS-POST] Posted: ${data.id} (${text.length} chars)`);
  return data;
}

// ── Format a topic into a Truth Social post (max 500 chars) ──
function formatTopicPost(item, index, total) {
  const verdictEmoji = {
    CONFIRMED: "✅",
    DEVELOPING: "⏳",
    "LIKELY DISINFO": "🚨",
    FALSE: "❌",
    UNVERIFIED: "❓",
  }[item.verdict] || "❓";

  // Source line — top 3 sources with accuracy
  const srcLines = (item.sources || [])
    .slice(0, 3)
    .map((s) => {
      const icon = s.confirms ? "✅" : "❌";
      return `${icon} @${s.handle} (${s.accuracy || "?"}%)`;
    })
    .join("\n");

  // Build post — stay under 500 chars
  let post = `${verdictEmoji} ${item.topic}\n\n`;

  if (srcLines) post += `Sources:\n${srcLines}\n\n`;

  if (item.narrative) {
    // Truncate narrative if needed
    const narr = item.narrative.length > 80 ? item.narrative.slice(0, 77) + "..." : item.narrative;
    post += `Media says: "${narr}"\n\n`;
  }

  if (item.data) {
    // Truncate data if needed
    const dataText = item.data.length > 120 ? item.data.slice(0, 117) + "..." : item.data;
    post += `📊 ${dataText}\n\n`;
  }

  if (item.challengePrompt) {
    const cp = item.challengePrompt.length > 100 ? item.challengePrompt.slice(0, 97) + "..." : item.challengePrompt;
    post += `${cp}`;
  }

  // Ensure under 500 chars
  if (post.length > 495) {
    post = post.slice(0, 492) + "...";
  }

  return post;
}

// ── Get latest briefing from blobs ──
async function getLatestBriefing() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "exodus-briefings", siteID: SITE_ID, token });

    const index = (await store.get("briefing-index", { type: "json" })) || [];
    if (index.length === 0) return null;

    const latest = index[0];
    const briefing = await store.get(latest.key, { type: "json" });
    return briefing;
  } catch (e) {
    console.error("[EXODUS-POST] Blob read error:", e.message);
    return null;
  }
}

// ── Mark briefing as posted ──
async function markAsPosted(briefingDate, timeSlot) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "exodus-briefings", siteID: SITE_ID, token });

    let posted = {};
    try { posted = (await store.get("posted-to-truth", { type: "json" })) || {}; } catch (_) {}
    posted[`${briefingDate}-${timeSlot}`] = new Date().toISOString();
    await store.setJSON("posted-to-truth", posted);
  } catch (_) {}
}

// ── Check if already posted ──
async function alreadyPosted(briefingDate, timeSlot) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "exodus-briefings", siteID: SITE_ID, token });

    const posted = (await store.get("posted-to-truth", { type: "json" })) || {};
    return !!posted[`${briefingDate}-${timeSlot}`];
  } catch (_) {
    return false;
  }
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  // Auth: either internal call or manual with key
  const key = (event.queryStringParameters || {}).key;
  const isInternal = event.headers?.["x-exodus-internal"] === "true";
  if (!isInternal && (!key || key !== AUTH_KEY)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!TRUTH_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Missing TRUTH_SOCIAL_TOKEN" }) };
  }

  console.log("[EXODUS-POST] ========== POSTING BRIEFING TO TRUTH SOCIAL ==========");

  try {
    // Get latest briefing
    const briefing = await getLatestBriefing();
    if (!briefing || !briefing.items || briefing.items.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, message: "No briefing to post" }) };
    }

    // Check if already posted
    if (await alreadyPosted(briefing.date, briefing.timeSlot)) {
      console.log("[EXODUS-POST] Already posted this briefing, skipping");
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, message: "Already posted" }) };
    }

    const now = new Date();
    const timeLabel = briefing.time || "Briefing";
    const dateLabel = briefing.date || now.toISOString().split("T")[0];

    // Post 1: Header
    const header = `📡 AUTHENTIC PRESS BRIEFING
${dateLabel} | ${timeLabel}

${briefing.items.length} topics verified against ${briefing.items.reduce((n, i) => n + (i.sources?.length || 0), 0)} sources.

The scoreboard mainstream media doesn't keep.

Thread 🧵👇

#AuthenticPress #BetOnIt`;

    const headerPost = await postTruth(header);
    if (!headerPost || headerPost.error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: "Failed to post header", details: headerPost }) };
    }

    let lastPostId = headerPost.id;
    const postedIds = [headerPost.id];

    // Posts 2-N: Each topic as a threaded reply
    for (let i = 0; i < briefing.items.length; i++) {
      const item = briefing.items[i];
      const topicPost = formatTopicPost(item, i, briefing.items.length);

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 2000));

      const posted = await postTruth(topicPost, lastPostId);
      if (posted) {
        lastPostId = posted.id;
        postedIds.push(posted.id);
      }
    }

    // Final post: CTA
    await new Promise((r) => setTimeout(r, 2000));

    const cta = `📊 Full briefing with source accuracy scores:
webetsocial.com/exodus

Think the media got it right? Challenge someone.
Free to play. Track record is forever.

@WeBetSocialAI
#AuthenticPress #TruthScoreboard`;

    const ctaPost = await postTruth(cta, lastPostId);
    if (ctaPost) postedIds.push(ctaPost.id);

    // Mark as posted
    await markAsPosted(briefing.date, briefing.timeSlot);

    console.log(`[EXODUS-POST] Thread posted: ${postedIds.length} posts`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        postsCount: postedIds.length,
        postIds: postedIds,
        threadUrl: `https://truthsocial.com/@AP/${headerPost.id}`,
      }),
    };
  } catch (e) {
    console.error("[EXODUS-POST] Fatal:", e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
