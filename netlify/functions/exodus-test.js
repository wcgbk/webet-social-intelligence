/**
 * exodus-test.js — Synchronous test version of the briefing pipeline
 * GET /api/exodus-test — runs the full pipeline and returns result (for debugging)
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const SOURCE_RELIABILITY = {
  "RealSKeshel": { accuracy: 87 }, "JohnFredericks": { accuracy: 82 },
  "DavidZere": { accuracy: 78 }, "Reuters": { accuracy: 91 },
  "AP": { accuracy: 89 }, "CNN": { accuracy: 62 }, "FoxNews": { accuracy: 77 },
  "nypost": { accuracy: 80 }, "nytimes": { accuracy: 71 },
};

exports.handler = async (event) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    log("[TEST] Starting Exodus pipeline test...");
    log(`[TEST] XAI_API_KEY: ${XAI_API_KEY ? "SET (" + XAI_API_KEY.slice(0,8) + "...)" : "MISSING"}`);
    log(`[TEST] ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "SET (" + ANTHROPIC_API_KEY.slice(0,8) + "...)" : "MISSING"}`);

    if (!XAI_API_KEY || !ANTHROPIC_API_KEY) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Missing API keys", logs }) };
    }

    // Step 1: Get trending from Grok
    log("[TEST] Step 1: Calling Grok for trending topics...");
    const grokRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: "grok-3",
        messages: [
          { role: "system", content: "You are a trending topics analyst for a conservative Truth Social audience (41.8K followers). Return the top 3 political/news topics trending on X RIGHT NOW that this audience cares about: media accountability, government spending, border security, election integrity, foreign policy. Each must have a verifiable data claim. Return as JSON array: [{\"topic\":\"Short punchy name\",\"description\":\"Specific claim being debated\",\"search_query\":\"search terms\",\"data_angle\":\"what stat makes this verifiable\"}]. JSON only." },
          { role: "user", content: "Top 3 political/news topics conservative Truth Social users would care about that are trending on X right now? Focus on verifiable data claims where mainstream media may be spinning." }
        ],
        temperature: 0.3,
      }),
    });

    const grokData = await grokRes.json();
    log(`[TEST] Grok response status: ${grokRes.status}`);

    if (!grokRes.ok) {
      log(`[TEST] Grok error: ${JSON.stringify(grokData)}`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Grok failed", grokData, logs }) };
    }

    const grokContent = grokData.choices?.[0]?.message?.content || "[]";
    log(`[TEST] Grok raw content length: ${grokContent.length}`);

    let topics;
    try {
      const jsonMatch = grokContent.match(/\[[\s\S]*\]/);
      topics = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(grokContent);
    } catch (e) {
      log(`[TEST] JSON parse error: ${e.message}`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Parse failed", raw: grokContent.slice(0, 500), logs }) };
    }

    log(`[TEST] Got ${topics.length} topics`);

    // Step 2: Source analysis for first topic only (speed)
    const topic = topics[0];
    log(`[TEST] Step 2: Analyzing sources for: ${topic.topic}`);

    const srcRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: "grok-3",
        messages: [
          { role: "system", content: 'Find 3+ notable X accounts discussing this topic. Return JSON: {"sources":[{"handle":"...","claim":"...","confirms":true}],"mainstream_narrative":"...","data_reality":"...","verdict":"CONFIRMED|DEVELOPING|LIKELY DISINFO|UNVERIFIED"}. JSON only.' },
          { role: "user", content: `Topic: "${topic.topic}" — ${topic.description}` }
        ],
        temperature: 0.3,
      }),
    });

    const srcData = await srcRes.json();
    const srcContent = srcData.choices?.[0]?.message?.content || "{}";
    let sourceAnalysis;
    try {
      const jsonMatch = srcContent.match(/\{[\s\S]*\}/);
      sourceAnalysis = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(srcContent);
    } catch (_) {
      sourceAnalysis = { sources: [], verdict: "UNVERIFIED" };
    }

    log(`[TEST] Sources found: ${(sourceAnalysis.sources || []).length}, Verdict: ${sourceAnalysis.verdict}`);

    // Step 3: Claude briefing for this one topic
    log("[TEST] Step 3: Generating briefing via Claude...");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        temperature: 0.3,
        messages: [{
          role: "user",
          content: `Generate ONE Authentic Press briefing item from this data. Return JSON only:
{"items":[{"topic":"...","verdict":"CONFIRMED|DEVELOPING|LIKELY DISINFO","sources":[{"handle":"...","accuracy":85,"confirms":true,"claim":"..."}],"narrative":"mainstream says...","data":"actual data...","challengePrompt":"conversational challenge..."}]}

Topic: ${topic.topic}
Description: ${topic.description}
Sources: ${JSON.stringify(sourceAnalysis.sources || [])}
Mainstream narrative: ${sourceAnalysis.mainstream_narrative || "Unknown"}
Data reality: ${sourceAnalysis.data_reality || "Unknown"}
Verdict: ${sourceAnalysis.verdict}

Use these accuracy scores for known sources: ${JSON.stringify(SOURCE_RELIABILITY)}
JSON only.`
        }]
      }),
    });

    const claudeData = await claudeRes.json();
    log(`[TEST] Claude status: ${claudeRes.status}`);

    if (!claudeRes.ok) {
      log(`[TEST] Claude error: ${JSON.stringify(claudeData)}`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Claude failed", claudeData, logs }) };
    }

    const claudeText = claudeData.content?.[0]?.text || "{}";
    let briefing;
    try {
      const jsonMatch = claudeText.match(/\{[\s\S]*\}/);
      briefing = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(claudeText);
    } catch (_) {
      briefing = { items: [] };
    }

    log(`[TEST] Briefing items: ${(briefing.items || []).length}`);

    // Step 4: Store to blobs
    log("[TEST] Step 4: Storing to blobs...");
    try {
      const { getStore } = await import("@netlify/blobs");
      const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
      const token = process.env.NETLIFY_AUTH_TOKEN || "";
      const store = getStore({ name: "exodus-briefings", siteID, token });

      const now = new Date();
      const dateKey = now.toISOString().split("T")[0];
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

      await store.setJSON(briefingKey, briefingData);

      // Update index
      let index = [];
      try { index = await store.get("briefing-index", { type: "json" }) || []; } catch (_) {}
      index.unshift({ key: briefingKey, date: dateKey, timeSlot, generatedAt: now.toISOString() });
      if (index.length > 90) index = index.slice(0, 90);
      await store.setJSON("briefing-index", index);

      // Update stats
      let stats = {};
      try { stats = await store.get("exodus-stats", { type: "json" }) || {}; } catch (_) {}
      stats.totalBriefings = (stats.totalBriefings || 0) + 1;
      stats.lastGenerated = now.toISOString();
      const accs = (briefing.items || []).flatMap(i => (i.sources || []).map(s => s.accuracy).filter(Boolean));
      if (accs.length > 0) stats.avgAccuracy = Math.round(accs.reduce((a, b) => a + b, 0) / accs.length);
      await store.setJSON("exodus-stats", stats);

      log(`[TEST] Stored: ${briefingKey}`);
    } catch (e) {
      log(`[TEST] Blob error: ${e.message}`);
    }

    log("[TEST] COMPLETE!");

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, briefing, topics, sourceAnalysis, logs }),
    };
  } catch (e) {
    log(`[TEST] Fatal: ${e.message}`);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message, logs }) };
  }
};
