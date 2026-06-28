// generate-guardian-background.js
// Guardian Daily Digest Pipeline — Background function (15min timeout)
// Scans X via Grok for trending topics, scores authenticity, generates digest.
// Stores to "guardian-digest" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Guardian System Prompt: Authenticity scoring on real search results ──
const GUARDIAN_SCORE_SYSTEM = `You are WeBetAI Guardian — a social intelligence engine that finds the most CONTESTED conversations on X and scores them for authenticity.

Your goal is NOT just trending topics. You're looking for the conversations people are ARGUING about the most — topics with two clear sides where people disagree. These make the best WeBet debates.

HOW TO FIND THE FIGHTS:
1. Search for trending topics, then for EACH topic search for the most-replied-to posts
2. The "ratio" is the key signal: posts with more replies than likes = disagreement = WeBet gold
3. Quote tweets with opposing takes = two-sided debate
4. Look for topics where verified accounts disagree with each other
5. Prioritize topics where there's a VERIFIABLE outcome that could settle the argument

SCORE THESE 5 SIGNALS for each topic:

- CONTENTION SCORE: How split is the debate? Are people actually arguing, or just agreeing? Posts with high reply-to-like ratios, opposing quote tweets, and split sentiment score highest. (0-100, where 100 = maximum disagreement)
- ENGAGEMENT VELOCITY: Is this topic growing organically over hours, or did it spike unnaturally fast? (0-100)
- ACCOUNT DIVERSITY: Are many unique, established accounts discussing it, or is it concentrated among bots/low-follower accounts? (0-100)
- SOURCE QUALITY: Does this trace back to a primary verifiable source? Or is it unsourced claims? (0-100)
- SENTIMENT SPLIT: What % of posts take each side? Closer to 50/50 = higher score. 90/10 = low score. (0-100, where 100 = perfectly split debate)

Compute a composite AUTHENTICITY SCORE (average of all 5 signals, 0-100).
Classify: "verified" (75+), "developing" (50-74), "check_sources" (below 50).
Write a 1-2 sentence summary of what the two sides are arguing.
Include the contention_score separately so we can sort by it.

CRITICAL: For each topic, find the single most-engaged post (highest likes/reposts) and return its FULL URL (e.g. "https://x.com/username/status/1234567890"). Also return the handle of the person who posted it.

Then write a WeBet string — a specific, bettable event tied to the post's content. The WeBet string is the product.

EXACT FORMAT (no deviation):
@[PostAuthor] WeBet $[Amount] [Title Case Declarative Statement] [On/By] [M/D/YY]

RULES:
- Every word is Title Case. No exceptions.
- Outcome is ALWAYS a declarative statement. Never a question. Never "Will."
- Use "On" for events with an exact date. Use "By" for deadline-based outcomes.
- "$[Amount]" goes immediately after "WeBet" — stakes are front-loaded.
- Date is always last, formatted M/D/YY (no leading zeros on month).
- One sentence only. No emoji. No odds. No hashtags. No links. No parentheses.

AMOUNT LOGIC:
- >70% likely: $50-$100
- 40-60% coin flip: $150-$300
- <30% longshot: $300-$500
- News/disinfo: $120-$300

CATEGORY-SPECIFIC PATTERNS:
- Sports: @Handle WeBet $75 [Player] [Verb] [Stat] On [Date]
- Politics: @Handle WeBet $250 [Figure] [Verb] [Outcome] By [Date]
- News/Disinfo: @Handle WeBet $200 [Source] Reports [Claim] Confirmed By [Date]
- Culture: @Handle WeBet $100 [Subject] [Verb] [Milestone] By [Date]
- Engagement: @Handle WeBet $100 [Content] Gets [Metric] By [Date]

EXAMPLES:
@NASA WeBet $150 Artemis II Completes Lunar Flyby Without Mission Abort By 4/11/26
@JudiciaryGOP WeBet $300 Supreme Court Upholds Birthright Citizenship 6-3 By 6/30/26
@Phillies WeBet $75 Justin Crawford Hits .300+ Through His First 30 Games By 5/1/26

OUTPUT FORMAT — Return ONLY valid JSON:
{
  "digest": [
    {
      "rank": 1,
      "topic": "Short topic name",
      "volume": "Estimated post count",
      "contentionScore": 88,
      "authenticityScore": 92,
      "classification": "verified",
      "signals": {
        "contentionScore": 88,
        "engagementVelocity": 95,
        "accountDiversity": 90,
        "sourceQuality": 88,
        "sentimentSplit": 94
      },
      "sides": {
        "sideA": "Brief description of one side of the argument",
        "sideB": "Brief description of the opposing side"
      },
      "summary": "1-2 sentence summary of what the two sides are arguing about.",
      "primarySource": "The original source",
      "challengeMoment": "A specific verifiable claim that could settle the argument, or null",
      "category": "One of: sports, politics, economy, tech, science, culture, health, world",
      "topPostUrl": "https://x.com/username/status/1234567890 (the most-replied-to or most-ratioed post on this topic)",
      "topPostAuthor": "@username",
      "weBet": "Full WeBet string in exact format"
    }
  ],
  "digestSummary": "2-3 sentence editorial overview of today's biggest arguments and what's worth challenging your friends on."
}

IMPORTANT: Sort the digest by contentionScore DESCENDING. The most argued-about topics should be first. Topics where everyone agrees (low contention) should be last or excluded.`;

// ── Main handler ──
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log("[guardian] Background function started");

  try {
    const body = JSON.parse(event.body || "{}");
    const isManual = body.manual || false;
    const isScheduled = body.scheduled || false;

    // ── Date key ──
    const now = new Date();
    const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dateKey = `${eastern.getFullYear()}-${String(eastern.getMonth() + 1).padStart(2, "0")}-${String(eastern.getDate()).padStart(2, "0")}`;
    const timeLabel = eastern.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    console.log(`[guardian] Date: ${dateKey}, Time: ${timeLabel}, Manual: ${isManual}, Scheduled: ${isScheduled}`);

    // ── Step 1: Grok-4 with live X search + web search ──
    console.log("[guardian] Step 1: Calling Grok-4 with live X + web search...");

    const xaiKey = process.env.XAI_API_KEY;
    if (!xaiKey) {
      throw new Error("XAI_API_KEY not configured");
    }

    // Use /v1/responses endpoint with built-in x_search + web_search tools
    // This forces Grok to search X in real-time before answering
    const grokResponse = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        tools: [{ type: "x_search" }, { type: "web_search" }],
        instructions: GUARDIAN_SCORE_SYSTEM,
        input: [
          {
            role: "user",
            content: `It is ${timeLabel} Eastern on ${dateKey}. Search X right now for the most CONTESTED and argued-about conversations in the United States. Use LIVE search results only.

STEP 1: Find what's trending on X right now.
STEP 2: For EACH trending topic, search for the most-replied-to posts — the ones getting "ratioed" or generating heated debate. Look for posts where replies >> likes.
STEP 3: Identify the TWO SIDES of each argument. What are people disagreeing about?
STEP 4: Score each topic for contention (how split is the debate?) and authenticity.
STEP 5: Find the single most-ratioed or most-debated post for each topic and return its URL.

Prioritize topics where:
- People are actively arguing (high reply-to-like ratio)
- There are TWO clear sides
- The outcome is VERIFIABLE (can be settled with facts or time)
- The topic involves claims that could be challenged via a WeBet

Return the full JSON digest sorted by contention score (most argued first). Aim for 10-15 topics. Keep summaries to 1-2 sentences focused on what the two sides are.`,
          },
        ],
        temperature: 0.3,
        max_output_tokens: 16000,
      }),
    });

    if (!grokResponse.ok) {
      const errText = await grokResponse.text().catch(() => "");
      throw new Error(`Grok API error: ${grokResponse.status} — ${errText}`);
    }

    const grokData = await grokResponse.json();

    // Extract text content from /v1/responses format
    let rawContent = "";
    let searchCallCount = 0;
    for (const item of grokData.output || []) {
      if (item.type === "message") {
        for (const c of item.content || []) {
          if (c.type === "output_text") {
            rawContent += c.text;
          }
        }
      }
      // Count search calls for logging
      if (item.type === "custom_tool_call" || item.type === "web_search_call") {
        searchCallCount++;
      }
    }

    if (!rawContent) {
      throw new Error("Grok returned empty response");
    }

    console.log(`[guardian] Grok response received (${rawContent.length} chars, ${searchCallCount} live searches)`);

    // ── Step 2: Parse Grok's JSON response ──
    let digestData;
    try {
      // Strip markdown code fences if present
      let cleaned = rawContent.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      }
      digestData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[guardian] JSON parse error:", parseErr.message);
      console.log("[guardian] Raw content:", rawContent.substring(0, 500));
      throw new Error(`Failed to parse Grok response as JSON: ${parseErr.message}`);
    }

    // ── Step 3: Validate and clean digest ──
    if (!digestData.digest || !Array.isArray(digestData.digest)) {
      throw new Error("Grok response missing 'digest' array");
    }

    // Strip Grok citation XML tags from all string fields
    function stripGrokTags(str) {
      if (!str || typeof str !== "string") return str;
      return str
        .replace(/<grok:render[^>]*>.*?<\/grok:render>/gs, "")
        .replace(/<\/?grok:[^>]*>/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // Ensure all items have required fields
    const cleanedDigest = digestData.digest.map((item, i) => ({
      rank: item.rank || i + 1,
      topic: item.topic || "Unknown topic",
      volume: item.volume || "Unknown",
      authenticityScore: Math.min(100, Math.max(0, item.authenticityScore || 0)),
      classification: ["verified", "developing", "check_sources"].includes(item.classification)
        ? item.classification
        : item.authenticityScore >= 75 ? "verified" : item.authenticityScore >= 50 ? "developing" : "check_sources",
      signals: {
        engagementVelocity: item.signals?.engagementVelocity || 0,
        accountDiversity: item.signals?.accountDiversity || 0,
        sourceQuality: item.signals?.sourceQuality || 0,
        sentimentDistribution: item.signals?.sentimentDistribution || 0,
      },
      contentionScore: Math.min(100, Math.max(0, item.contentionScore || item.signals?.contentionScore || 0)),
      sides: item.sides || null,
      summary: stripGrokTags(item.summary) || "",
      primarySource: stripGrokTags(item.primarySource) || null,
      challengeMoment: stripGrokTags(item.challengeMoment) || null,
      category: item.category || "general",
      topPostUrl: item.topPostUrl || null,
      topPostAuthor: item.topPostAuthor || null,
      weBet: stripGrokTags(item.weBet) || null,
    }));

    // Sort by contention score first (most argued), then authenticity
    cleanedDigest.sort((a, b) => {
      const aScore = (a.contentionScore * 0.6) + (a.authenticityScore * 0.4);
      const bScore = (b.contentionScore * 0.6) + (b.authenticityScore * 0.4);
      return bScore - aScore;
    });

    // ── Step 4: Build final digest object ──
    const finalDigest = {
      date: dateKey,
      time: timeLabel,
      generatedAt: new Date().toISOString(),
      source: isManual ? "manual" : "scheduled",
      topicsScanned: digestData.topicsScanned || cleanedDigest.length,
      digestSummary: stripGrokTags(digestData.digestSummary) || "",
      digest: cleanedDigest,
      stats: {
        verified: cleanedDigest.filter((d) => d.classification === "verified").length,
        developing: cleanedDigest.filter((d) => d.classification === "developing").length,
        checkSources: cleanedDigest.filter((d) => d.classification === "check_sources").length,
        avgAuthenticityScore: Math.round(
          cleanedDigest.reduce((sum, d) => sum + d.authenticityScore, 0) / (cleanedDigest.length || 1)
        ),
        avgContentionScore: Math.round(
          cleanedDigest.reduce((sum, d) => sum + (d.contentionScore || 0), 0) / (cleanedDigest.length || 1)
        ),
        hotDebates: cleanedDigest.filter((d) => (d.contentionScore || 0) >= 75).length,
        challengeableMoments: cleanedDigest.filter((d) => d.challengeMoment).length,
      },
      pipeline: {
        model: "grok-4-1-fast + live X search",
        runtime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        cost: "$0.15-0.25 estimated",
      },
    };

    console.log(`[guardian] Digest built: ${cleanedDigest.length} topics, ${finalDigest.stats.verified} verified, ${finalDigest.stats.challengeableMoments} challengeable`);

    // ── Step 5: Store to Netlify Blobs ──
    console.log("[guardian] Storing to Netlify Blobs...");

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("guardian-digest");

      // Store dated digest + update latest pointer
      await store.setJSON(`digest-${dateKey}`, finalDigest);
      await store.set("latest-date", dateKey);

      // Also store as "latest" for quick access
      await store.setJSON("latest", finalDigest);

      console.log(`[guardian] Stored: digest-${dateKey} + latest-date + latest`);
    } catch (blobErr) {
      console.error("[guardian] Blob storage error:", blobErr.message);
      // Fallback: try Netlify API directly
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/guardian-digest`;
        const headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        };

        await Promise.all([
          fetch(`${baseUrl}/digest-${dateKey}`, { method: "PUT", headers, body: JSON.stringify(finalDigest) }),
          fetch(`${baseUrl}/latest-date`, { method: "PUT", headers: { ...headers, "Content-Type": "text/plain" }, body: dateKey }),
          fetch(`${baseUrl}/latest`, { method: "PUT", headers, body: JSON.stringify(finalDigest) }),
        ]);

        console.log("[guardian] Stored via Netlify API fallback");
      } else {
        throw new Error("Cannot store digest — no Blob SDK or auth token available");
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[guardian] Complete in ${totalTime}s`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        date: dateKey,
        topics: cleanedDigest.length,
        verified: finalDigest.stats.verified,
        avgScore: finalDigest.stats.avgAuthenticityScore,
        runtime: `${totalTime}s`,
      }),
    };
  } catch (err) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[guardian] FAILED after ${totalTime}s:`, err.message);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: true, message: err.message, runtime: `${totalTime}s` }),
    };
  }
};
