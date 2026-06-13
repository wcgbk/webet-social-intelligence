/**
 * exodus-scan-background.js — Authentic Press Briefing Generator
 *
 * Background function (15-min timeout). Pipeline:
 * 1. Pull trending topics from X via Grok API
 * 2. For each topic, find 3+ reliable sources discussing it
 * 3. Score source reliability against historical accuracy
 * 4. Generate Authentic Press Briefing via Claude API
 * 5. Store briefing to Netlify Blobs (exodus-briefings store)
 *
 * Isolated from all other site functions — uses its own blob store.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Source reliability database (seed data — grows over time) ──
const SOURCE_RELIABILITY = {
  // High-reliability independent sources
  "RealSKeshel": { name: "Seth Keshel", category: "election/data", accuracy: 87, track: [] },
  "JohnFredericks": { name: "John Fredericks", category: "conservative media", accuracy: 82, track: [] },
  "DavidZere": { name: "David Zere", category: "commentary", accuracy: 78, track: [] },
  "intheMatrixxx": { name: "Jeffrey Pedersen", category: "research", accuracy: 75, track: [] },
  "RealDailyWire": { name: "Daily Wire", category: "news", accuracy: 83, track: [] },
  "BreitbartNews": { name: "Breitbart", category: "news", accuracy: 76, track: [] },
  "OABOREALTOR": { name: "OAN", category: "news", accuracy: 74, track: [] },
  "nypost": { name: "NY Post", category: "news", accuracy: 80, track: [] },
  "FoxNews": { name: "Fox News", category: "news", accuracy: 77, track: [] },
  "Reuters": { name: "Reuters", category: "wire", accuracy: 91, track: [] },
  "AP": { name: "Associated Press", category: "wire", accuracy: 89, track: [] },
  // Accounts to cross-reference against (mainstream — track accuracy)
  "CNN": { name: "CNN", category: "mainstream", accuracy: 62, track: [] },
  "MSNBC": { name: "MSNBC", category: "mainstream", accuracy: 58, track: [] },
  "nytimes": { name: "NY Times", category: "mainstream", accuracy: 71, track: [] },
  "washingtonpost": { name: "Washington Post", category: "mainstream", accuracy: 68, track: [] },
  "ABC": { name: "ABC News", category: "mainstream", accuracy: 70, track: [] },
  "CBSNews": { name: "CBS News", category: "mainstream", accuracy: 69, track: [] },
};

// ── Grok API: Get trending topics ──
async function getTrendingTopics() {
  console.log("[EXODUS] Fetching trending topics via Grok...");

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-3",
        messages: [
          {
            role: "system",
            content: `You are a trending topics analyst for Authentic Press — a media accountability platform on Truth Social with 41.8K conservative followers. Your job is to identify the top 5 NEWS topics trending on X RIGHT NOW that this audience would engage with.

PRIORITY TOPICS (ranked by audience interest):
1. Media accountability — mainstream media caught lying, retracting, or spinning stories. Fact-checkers being wrong.
2. Government spending/waste — new spending bills, budget data, inflation numbers, economic data drops
3. Election integrity — voter fraud investigations, election lawsuits, registration data, ballot issues
4. Border/immigration — encounters data, policy changes, sanctuary city news, ICE operations
5. Foreign policy — military deployments, trade deals, sanctions, geopolitical moves with verifiable claims
6. Big Tech censorship — platform policies, content moderation controversies, algorithm bias
7. Crime/public safety — FBI crime stats, city-level data, DA policies, police funding
8. Energy/environment policy — gas prices, drilling permits, EV mandates, energy independence data

REQUIREMENTS:
- Each topic MUST have a verifiable claim that can be fact-checked with data
- Each topic MUST be something people are actively arguing about TODAY (not evergreen)
- Prefer topics where mainstream media narrative contradicts available data
- Include the specific data point or claim being debated

Return ONLY a JSON array:
[
  {
    "topic": "Short punchy topic name (max 8 words)",
    "description": "The specific claim being debated — what one side says vs what the data shows",
    "hashtags": ["#relevant", "#hashtags"],
    "search_query": "exact search terms to find X posts about this",
    "data_angle": "What specific data point or stat makes this verifiable",
    "x_post_url": "URL of the MOST viral/relevant X post about this topic (https://x.com/username/status/ID format). Must be a real post you can see trending RIGHT NOW.",
    "prediction_keywords": "2-3 keywords to search prediction markets for related bets (e.g. 'trump tariff', 'inflation CPI', 'border wall')"
  }
]

Return exactly 5 topics. JSON only, no markdown.`,
          },
          {
            role: "user",
            content: "What are the top 5 political/news topics that conservative Truth Social users would care about that are trending on X RIGHT NOW? Focus on topics with verifiable data claims where mainstream media may be spinning the narrative. Return as JSON array.",
          },
        ],
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "[]";
    // Extract JSON from potential markdown wrapping
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(content);
  } catch (e) {
    console.error("[EXODUS] Grok trending error:", e.message);
    return [];
  }
}

// ── Grok API: Find sources discussing a topic ──
async function findSourcesForTopic(topic) {
  console.log(`[EXODUS] Finding sources for: ${topic.topic}`);

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-3",
        messages: [
          {
            role: "system",
            content: `You are a source verification analyst for Authentic Press. For a given trending topic, find REAL, RECENT posts from notable X accounts discussing it.

PRIORITY SOURCES TO CHECK (these are accounts our audience trusts):
- Independent journalists: @RealSKeshel, @JohnFredericks, @ShawnFarash, @DavidZere, @Cernovich, @JackPosobiec, @RaheemKassam
- Data/research accounts: @RealClearNews, @WallStreetSilv, @zaborowitz, @EndWokeness, @LibsOfTikTok
- Wire services: @Reuters, @AP (for cross-reference)
- Government sources: @ABOREALTOR, @baborealtor, @USDebtClock, @ABOREALTOR_data
- Any verified account posting data/stats about this topic

ALSO CROSS-REFERENCE against mainstream (to show contrast):
- @CNN, @MSNBC, @nytimes, @washingtonpost, @ABC, @CBSNews

REQUIREMENTS:
- Only include sources that ACTUALLY posted about this topic in the last 24 hours
- Include what they SPECIFICALLY said (not generic takes)
- Always contrast the independent source narrative vs mainstream narrative
- Provide the actual data/stat that settles the debate

Return ONLY a JSON object:
{
  "top_post_url": "URL of the single most viral/engaged X post about this topic (https://x.com/handle/status/ID). Must be a REAL post from today.",
  "sources": [
    {
      "handle": "username (no @)",
      "claim": "SPECIFIC thing they said about this topic (one sentence, quote-like)",
      "confirms": true/false (does their claim confirm the data-backed reality?),
      "post_summary": "What their actual post said"
    }
  ],
  "mainstream_narrative": "What CNN/MSNBC/NYT are saying about this (one sentence)",
  "data_reality": "What the ACTUAL verifiable data shows — cite the specific number, stat, or document (2-3 sentences)",
  "consensus_count": 3,
  "total_sources": 5,
  "verdict": "CONFIRMED" or "DEVELOPING" or "LIKELY DISINFO" or "UNVERIFIED"
}

Be factual and data-driven. No opinion — only what sources said and what data shows.
JSON only, no markdown.`,
          },
          {
            role: "user",
            content: `Topic: "${topic.topic}"
Description: "${topic.description}"
Search terms: "${topic.search_query}"

Find notable X accounts discussing this. What are they saying? What does the data actually show?`,
          },
        ],
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(content);
  } catch (e) {
    console.error(`[EXODUS] Source finding error for ${topic.topic}:`, e.message);
    return { sources: [], verdict: "UNVERIFIED" };
  }
}

// ── Prediction Markets: Find related markets for a topic ──
async function findPredictionMarkets(topic) {
  const keywords = topic.prediction_keywords || topic.topic;
  const markets = [];

  // Polymarket via Gamma API
  try {
    const polyRes = await fetch(
      `https://gamma-api.polymarket.com/events?closed=false&limit=3&title=${encodeURIComponent(keywords)}`,
      { headers: { Accept: "application/json" } }
    );
    if (polyRes.ok) {
      const polyData = await polyRes.json();
      (polyData || []).slice(0, 2).forEach(ev => {
        const mkt = (ev.markets || [])[0];
        if (mkt) {
          const price = mkt.outcomePrices ? JSON.parse(mkt.outcomePrices)[0] : null;
          markets.push({
            platform: "Polymarket",
            title: (ev.title || mkt.question || "").slice(0, 100),
            probability: price ? Math.round(parseFloat(price) * 100) : null,
            url: `https://polymarket.com/event/${ev.slug || ""}`,
          });
        }
      });
    }
  } catch (e) {
    console.log(`[EXODUS] Polymarket lookup skipped: ${e.message}`);
  }

  // Kalshi API
  try {
    const kalshiRes = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/events?status=open&limit=3&with_nested_markets=true&series_ticker=&title=${encodeURIComponent(keywords)}`,
      { headers: { Accept: "application/json" } }
    );
    if (kalshiRes.ok) {
      const kalshiData = await kalshiRes.json();
      ((kalshiData.events || []).slice(0, 2)).forEach(ev => {
        const mkt = (ev.markets || [])[0];
        if (mkt) {
          markets.push({
            platform: "Kalshi",
            title: (ev.title || mkt.title || "").slice(0, 100),
            probability: mkt.last_price ? Math.round(mkt.last_price * 100) : (mkt.yes_ask ? Math.round(mkt.yes_ask * 100) : null),
            url: `https://kalshi.com/markets/${ev.event_ticker || ""}`,
          });
        }
      });
    }
  } catch (e) {
    console.log(`[EXODUS] Kalshi lookup skipped: ${e.message}`);
  }

  return markets;
}

// ── Claude API: Generate the formatted briefing ──
async function generateBriefing(topics, sourceData, predictionData) {
  console.log("[EXODUS] Generating Authentic Press Briefing via Claude...");

  const topicSummaries = topics.map((t, i) => {
    const sd = sourceData[i] || {};
    const pm = predictionData ? predictionData[i] || [] : [];
    return `
TOPIC ${i + 1}: ${t.topic}
Description: ${t.description}
X Post URL: ${sd.top_post_url || t.x_post_url || "none"}
Sources found: ${JSON.stringify(sd.sources || [])}
Mainstream narrative: ${sd.mainstream_narrative || "Unknown"}
Data reality: ${sd.data_reality || "Unknown"}
Consensus: ${sd.consensus_count || 0}/${sd.total_sources || 0} sources agree
Grok verdict: ${sd.verdict || "UNVERIFIED"}
Prediction markets: ${pm.length > 0 ? JSON.stringify(pm) : "No related markets found"}
`;
  }).join("\n---\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        temperature: 0.3,
        system: `You are the Authentic Press briefing writer for a Truth Social account with 41.8K conservative followers. Your job is to take raw trending topic data and produce a sharp, data-driven briefing that drives engagement.

VOICE & TONE:
- Direct, confident, slightly confrontational — like a friend who does their homework
- Lead with the DATA, not the opinion
- Always contrast what mainstream media says vs what the numbers actually show
- Challenge prompts should make readers want to tag someone and argue

RULES:
- Be factual. Cite specific numbers, stats, dates.
- Score each source's reliability using historical accuracy data.
- Every topic MUST have a clear "mainstream says X, data says Y" contrast.
- Challenge prompts should be short, punchy, and use phrases like:
  "Tag someone who still believes...", "Challenge your liberal friend on this one",
  "Bet on it. Who's right?", "Share this with someone who needs to see the receipts"

OUTPUT FORMAT — Return ONLY a JSON object:
{
  "items": [
    {
      "topic": "Short punchy topic name",
      "verdict": "CONFIRMED" | "DEVELOPING" | "LIKELY DISINFO" | "FALSE" | "UNVERIFIED",
      "xPostUrl": "The X post URL from the input data (pass it through exactly)",
      "summary": "2-3 sentence executive summary: WHY this is trending, what the debate is, and who is right based on the data. Written like a news brief — neutral but sharp.",
      "sources": [
        { "handle": "username (no @)", "accuracy": 85, "confirms": true, "claim": "their specific claim" }
      ],
      "narrative": "What mainstream media says (one sentence — keep it short)",
      "data": "What the actual data shows — CITE THE SPECIFIC NUMBER OR STAT (2-3 sentences max)",
      "predictionMarkets": [{ "platform": "Polymarket", "title": "market question", "probability": 72, "url": "..." }],
      "challengePrompt": "Short punchy challenge. Under 120 chars. Drives shares and tags."
    }
  ]
}

IMPORTANT: Pass through xPostUrl and predictionMarkets exactly from the input data. Add the "summary" field — it should explain WHY this topic is trending and what people are arguing about in 2-3 sharp sentences.

Source accuracy scores — use these known values when a source matches:
${Object.entries(SOURCE_RELIABILITY).map(([h, s]) => `@${h}: ${s.accuracy}% (${s.category})`).join("\n")}

For unknown sources, estimate accuracy: verified journalists 75-85%, government accounts 80-90%, anonymous accounts 50-65%.
JSON only, no markdown.`,
        messages: [
          {
            role: "user",
            content: `Generate the Authentic Press Briefing from this raw data:\n\n${topicSummaries}`,
          },
        ],
      }),
    });

    const result = await res.json();
    const text = result.content?.[0]?.text || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(text);
  } catch (e) {
    console.error("[EXODUS] Claude briefing error:", e.message);
    return { items: [] };
  }
}

// ── Store briefing to Netlify Blobs ──
async function storeBriefing(briefing) {
  console.log("[EXODUS] Storing briefing to blobs...");

  try {
    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "exodus-briefings", siteID, token });

    const now = new Date();
    const dateKey = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const hour = now.getUTCHours();
    const timeSlot = hour < 16 ? "morning" : hour < 20 ? "afternoon" : "evening";
    const briefingKey = `briefing-${dateKey}-${timeSlot}`;

    const briefingData = {
      ...briefing,
      date: dateKey,
      time: `${timeSlot.charAt(0).toUpperCase() + timeSlot.slice(1)} Briefing`,
      generatedAt: now.toISOString(),
      timeSlot,
    };

    // Store the individual briefing
    await store.setJSON(briefingKey, briefingData);

    // Update the index of all briefings (last 30 days)
    let index = [];
    try {
      index = await store.get("briefing-index", { type: "json" }) || [];
    } catch (_) { index = []; }

    // Add new entry, keep last 90 (30 days x 3 per day)
    index.unshift({ key: briefingKey, date: dateKey, timeSlot, generatedAt: now.toISOString() });
    if (index.length > 90) index = index.slice(0, 90);
    await store.setJSON("briefing-index", index);

    // Update stats
    let stats = {};
    try {
      stats = await store.get("exodus-stats", { type: "json" }) || {};
    } catch (_) { stats = {}; }
    stats.totalBriefings = (stats.totalBriefings || 0) + 1;
    stats.lastGenerated = now.toISOString();
    // Calculate average source accuracy across all items
    const accs = (briefing.items || []).flatMap(item =>
      (item.sources || []).map(s => s.accuracy).filter(Boolean)
    );
    if (accs.length > 0) {
      const avg = Math.round(accs.reduce((a, b) => a + b, 0) / accs.length);
      stats.avgAccuracy = stats.avgAccuracy
        ? Math.round((stats.avgAccuracy + avg) / 2)
        : avg;
    }
    await store.setJSON("exodus-stats", stats);

    console.log(`[EXODUS] Briefing stored: ${briefingKey}`);
    return briefingKey;
  } catch (e) {
    console.error("[EXODUS] Blob store error:", e.message);
    // Fallback: try Netlify API directly
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token) throw new Error("No NETLIFY_AUTH_TOKEN");

      const now = new Date();
      const dateKey = now.toISOString().split("T")[0];
      const hour = now.getUTCHours();
      const timeSlot = hour < 16 ? "morning" : hour < 20 ? "afternoon" : "evening";
      const briefingKey = `briefing-${dateKey}-${timeSlot}`;

      const baseUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/exodus-briefings`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      const briefingData = {
        ...briefing,
        date: dateKey,
        time: `${timeSlot.charAt(0).toUpperCase() + timeSlot.slice(1)} Briefing`,
        generatedAt: now.toISOString(),
        timeSlot,
      };

      await fetch(`${baseUrl}/${briefingKey}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(briefingData),
      });

      console.log(`[EXODUS] Briefing stored via API fallback: ${briefingKey}`);
      return briefingKey;
    } catch (e2) {
      console.error("[EXODUS] API fallback error:", e2.message);
      return null;
    }
  }
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  console.log("[EXODUS] ========== BRIEFING GENERATION STARTED ==========");
  const startTime = Date.now();

  try {
    // Validate env
    if (!XAI_API_KEY) throw new Error("Missing XAI_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

    // Step 1: Get trending topics from X via Grok
    const topics = await getTrendingTopics();
    console.log(`[EXODUS] Found ${topics.length} trending topics`);

    if (topics.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, message: "No trending topics found", briefingKey: null }),
      };
    }

    // Step 2: For each topic, find sources and cross-reference
    const sourceData = [];
    for (const topic of topics) {
      const sd = await findSourcesForTopic(topic);
      sourceData.push(sd);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[EXODUS] Source analysis complete for ${sourceData.length} topics`);

    // Step 2.5: Fetch prediction market data for each topic (parallel)
    console.log("[EXODUS] Fetching prediction market data...");
    const predictionData = await Promise.all(
      topics.map(t => findPredictionMarkets(t).catch(() => []))
    );
    const totalMarkets = predictionData.reduce((n, m) => n + m.length, 0);
    console.log(`[EXODUS] Found ${totalMarkets} prediction markets across ${topics.length} topics`);

    // Step 3: Generate formatted briefing via Claude
    const briefing = await generateBriefing(topics, sourceData, predictionData);
    console.log(`[EXODUS] Briefing generated with ${(briefing.items || []).length} items`);

    // Step 4: Store to blobs
    const briefingKey = await storeBriefing(briefing);

    // Step 5: Auto-post to Truth Social
    console.log("[EXODUS] Triggering Truth Social auto-post...");
    try {
      const siteUrl = process.env.URL || "https://webetsocial.com";
      const postRes = await fetch(`${siteUrl}/.netlify/functions/exodus-post-truth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-exodus-internal": "true",
        },
        body: JSON.stringify({ trigger: "auto", briefingKey }),
      });
      console.log(`[EXODUS] Truth Social post trigger: ${postRes.status}`);
    } catch (postErr) {
      // Non-fatal — briefing is stored even if posting fails
      console.error("[EXODUS] Truth Social post error (non-fatal):", postErr.message);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[EXODUS] ========== BRIEFING COMPLETE (${elapsed}s) ==========`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        briefingKey,
        itemCount: (briefing.items || []).length,
        elapsed: `${elapsed}s`,
      }),
    };
  } catch (e) {
    console.error("[EXODUS] Fatal error:", e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
