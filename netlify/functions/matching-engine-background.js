/**
 * matching-engine-background.js — WeBet Social Matching Engine v2
 *
 * CONTROVERSY-FIRST pipeline (15-min timeout):
 * 1. Find heated debates (Reddit controversial + X conviction language)
 * 2. Score by controversy signal (split votes, reply ratio, conviction words)
 * 3. Match backwards into prediction markets (Kalshi + Polymarket as referees)
 * 4. Find the loudest person on each side (willing bettors)
 * 5. Generate WeBet bet strings via xAI Grok
 * 6. Store matched feed to Netlify Blobs
 *
 * Data Sources:
 *   - Reddit /controversial.json → split-vote debates (FREE, no auth)
 *   - Google Trends RSS          → real-time trending searches (FREE)
 *   - Hacker News Algolia        → front-page stories (FREE)
 *   - Kalshi API                 → sports/entertainment/weather markets (FREE reads)
 *   - Polymarket Gamma API       → politics/crypto/world markets (FREE reads)
 *   - X API v2                   → user search + controversy scoring (Bearer Token)
 *   - xAI Grok                   → bet string generation (API key)
 */

const { WEBET_STRING_SYSTEM_PROMPT, CATEGORIES, detectCategory, calculateAmount } = require("./webet-string-spec");

const XAI_API_KEY = process.env.XAI_API_KEY;
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_API = "https://gamma-api.polymarket.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// Conviction language — signals someone would put money on it
const CONVICTION_WORDS = [
  "guarantee", "lock", "100%", "no chance", "no way", "absolutely",
  "mark my words", "bet", "wager", "easy money", "slam dunk", "mortal lock",
  "book it", "guaranteed", "impossible", "never", "definitely", "certain",
];

// ═══════════════════════════════════════════════════════════════
// DATA SOURCE 1: REDDIT CONTROVERSIAL — Split-vote debates
// Uses /controversial.json (pre-sorted by Reddit's controversy algo)
// controversy_score = magnitude × balance where balance = min(up,down)/max(up,down)
// ═══════════════════════════════════════════════════════════════

const REDDIT_SUBS = [
  { sub: "sportsbook", category: "sports" },
  { sub: "sportsbetting", category: "sports" },
  { sub: "nba", category: "sports" },
  { sub: "nfl", category: "sports" },
  { sub: "politics", category: "politics" },
  { sub: "worldnews", category: "politics" },
  { sub: "wallstreetbets", category: "finance" },
  { sub: "cryptocurrency", category: "crypto" },
  { sub: "polymarket", category: "prediction-markets" },
  { sub: "PredictionMarkets", category: "prediction-markets" },
];

async function fetchRedditControversial() {
  console.log("[MATCHING] Fetching Reddit controversial debates...");
  const results = [];

  for (const { sub, category } of REDDIT_SUBS) {
    try {
      // Use /controversial instead of /hot — pre-sorted by split votes
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/controversial.json?t=day&limit=15`,
        { headers: { "User-Agent": "WeBetAI-Matching/1.0 (contact: ben@worldclassgrowth.com)" } }
      );

      if (!res.ok) {
        console.warn(`[MATCHING] Reddit r/${sub} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const posts = data?.data?.children || [];

      for (const post of posts) {
        const d = post.data;
        if (!d || d.stickied) continue;

        const titleLower = (d.title || "").toLowerCase();
        const bodyLower = (d.selftext || "").toLowerCase();
        const fullText = titleLower + " " + bodyLower;

        // Controversy score: how split is the community?
        // upvote_ratio near 0.5 = maximum controversy
        const splitScore = 1 - Math.abs((d.upvote_ratio || 0.5) - 0.5) * 2;

        // Conviction language in title or body
        const convictionHits = CONVICTION_WORDS.filter((w) => fullText.includes(w));

        // Heat = high comments + split vote = active two-sided debate
        const controversyScore =
          splitScore * (d.num_comments || 0) +
          convictionHits.length * 20;

        results.push({
          source: "reddit",
          subreddit: sub,
          category,
          title: d.title,
          body: (d.selftext || "").substring(0, 300),
          score: d.score || 0,
          comments: d.num_comments || 0,
          upvoteRatio: d.upvote_ratio || 0,
          splitScore: Math.round(splitScore * 100),
          convictionHits,
          controversyScore: Math.round(controversyScore),
          url: `https://reddit.com${d.permalink}`,
          postId: d.id,
          created: d.created_utc,
          author: d.author,
        });
      }
    } catch (err) {
      console.warn(`[MATCHING] Reddit r/${sub} error:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  // Sort by controversy score (most divisive first)
  results.sort((a, b) => b.controversyScore - a.controversyScore);
  console.log(`[MATCHING] Reddit: ${results.length} controversial posts found`);
  return results.slice(0, 40);
}

// ═══════════════════════════════════════════════════════════════
// DATA SOURCE 2: GOOGLE TRENDS + HACKER NEWS
// Cross-reference for trending amplification
// ═══════════════════════════════════════════════════════════════

async function fetchTrendingSocial() {
  console.log("[MATCHING] Fetching Google Trends + Hacker News...");
  const results = { google: [], hackernews: [] };

  try {
    const res = await fetch("https://trends.google.com/trending/rss?geo=US", {
      headers: { "User-Agent": "WeBetAI-Matching/1.0" },
    });
    if (res.ok) {
      const xml = await res.text();
      const items = xml.split("<item>").slice(1);
      results.google = items.slice(0, 20).map((item, i) => {
        const titleMatch = item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
                           item.match(/<title>(.+?)<\/title>/);
        const trafficMatch = item.match(/<ht:approx_traffic>(.+?)<\/ht:approx_traffic>/);
        return {
          source: "google-trends", platform: "google",
          topic: titleMatch ? titleMatch[1].trim() : "",
          rank: i + 1,
          volume: trafficMatch ? parseInt(trafficMatch[1].replace(/[^0-9]/g, "")) || 0 : 0,
        };
      }).filter((t) => t.topic);
    }
  } catch (err) { console.warn("[MATCHING] Google Trends error:", err.message); }

  try {
    const res = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20",
      { headers: { "User-Agent": "WeBetAI-Matching/1.0" } });
    if (res.ok) {
      const data = await res.json();
      results.hackernews = (data.hits || []).map((hit, i) => ({
        source: "hackernews", platform: "hackernews",
        topic: hit.title || "", rank: i + 1,
        volume: (hit.points || 0) + (hit.num_comments || 0),
      })).filter((t) => t.topic);
    }
  } catch (err) { console.warn("[MATCHING] HN error:", err.message); }

  console.log(`[MATCHING] Trends: Google=${results.google.length}, HN=${results.hackernews.length}`);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// REFEREE LOOKUP: Find prediction markets that can settle a debate
// Routes by category: Sports → Kalshi, Politics → Polymarket, etc.
// Then does client-side keyword matching against market titles.
// ═══════════════════════════════════════════════════════════════

// Category → which platform to check first, and which series/tags to filter
const CATEGORY_ROUTES = {
  sports:              { primary: "kalshi",     kalshiSeries: ["KXNBAGAME", "KXNFLGAME", "KXMLBGAME", "KXNHLGAME"], polyTag: null },
  politics:            { primary: "polymarket", kalshiSeries: null, polyTag: "2" },
  finance:             { primary: "kalshi",     kalshiSeries: null, polyTag: null },
  crypto:              { primary: "polymarket", kalshiSeries: null, polyTag: null },
  "prediction-markets": { primary: "polymarket", kalshiSeries: null, polyTag: null },
};

async function findRefereeMarket(debate) {
  const keywords = extractKeywords(debate.title.toLowerCase());
  if (keywords.length < 2) return null;

  const route = CATEGORY_ROUTES[debate.category] || { primary: "both" };
  let bestMatch = null;
  let bestScore = 0;

  // ── Kalshi lookup ──
  if (route.primary === "kalshi" || route.primary === "both") {
    try {
      let kalshiUrl = `${KALSHI_API}/markets?status=open&limit=200`;
      // If we have specific series, use them for targeted search
      if (route.kalshiSeries) {
        // Fetch from each relevant series
        for (const series of route.kalshiSeries) {
          try {
            const res = await fetch(`${KALSHI_API}/events?series_ticker=${series}&status=open&limit=50`);
            if (!res.ok) continue;
            const data = await res.json();
            const events = data.events || [];
            for (const evt of events) {
              for (const mkt of evt.markets || []) {
                const clean = cleanKalshiTitle(mkt, evt);
                const matchScore = keywordMatchScore(keywords, clean);
                if (matchScore > bestScore) {
                  bestScore = matchScore;
                  bestMatch = formatKalshiMarket(mkt, evt);
                }
              }
            }
          } catch (_) {}
        }
      } else {
        // General Kalshi scan — get recent high-volume markets
        const now = Math.floor(Date.now() / 1000);
        const weekOut = now + 7 * 24 * 60 * 60;
        const res = await fetch(`${kalshiUrl}&min_close_ts=${now}&max_close_ts=${weekOut}`);
        if (res.ok) {
          const data = await res.json();
          for (const mkt of data.markets || []) {
            const clean = cleanKalshiTitle(mkt);
            const matchScore = keywordMatchScore(keywords, clean);
            if (matchScore > bestScore) {
              bestScore = matchScore;
              bestMatch = formatKalshiMarket(mkt);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[MATCHING] Kalshi referee lookup error:", err.message);
    }
  }

  // ── Polymarket lookup ──
  if (route.primary === "polymarket" || route.primary === "both" || bestScore < 3) {
    try {
      let polyUrl = `${GAMMA_API}/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`;
      const res = await fetch(polyUrl, { headers: { "User-Agent": "WeBetAI-Matching/1.0" } });
      if (res.ok) {
        const markets = await res.json();
        for (const m of (Array.isArray(markets) ? markets : [])) {
          const matchScore = keywordMatchScore(keywords, m.question || "");
          if (matchScore > bestScore) {
            bestScore = matchScore;
            bestMatch = formatPolymarketMarket(m);
          }
        }
      }
    } catch (err) {
      console.warn("[MATCHING] Polymarket referee lookup error:", err.message);
    }
  }

  if (bestScore >= 2) {
    console.log(`[MATCHING] Referee found: [${bestMatch.platform}] "${bestMatch.title.substring(0, 50)}..." (match=${bestScore})`);
  }

  return bestScore >= 2 ? bestMatch : null;
}

function cleanKalshiTitle(mkt, evt) {
  // Kalshi's bulk /markets endpoint returns outcome strings as "title"
  // (e.g., "yes Los Angeles C,yes Toronto,yes New York...")
  // The actual question is in subtitle, event title, or needs extraction
  const raw = mkt.title || "";
  const subtitle = mkt.subtitle || "";
  const eventTitle = (evt && evt.title) || "";

  // If title looks like a multi-option outcome list, prefer subtitle or event title
  const isMultiOutcome = raw.includes(",yes ") || raw.includes(",no ") ||
    (raw.startsWith("yes ") && raw.length > 60);

  if (isMultiOutcome) {
    // subtitle is usually the actual yes/no question
    if (subtitle) return subtitle;
    if (eventTitle) return eventTitle;
    // Last resort: extract first outcome as a hint
    const first = raw.split(",")[0].replace(/^(yes|no)\s+/i, "").trim();
    return first || raw;
  }

  // subtitle is often more descriptive than title
  if (subtitle && subtitle.length > raw.length) return subtitle;
  return raw || subtitle;
}

function formatKalshiMarket(mkt, evt) {
  const yesBid = mkt.yes_bid_dollars || mkt.yes_bid || 0;
  const yesAsk = mkt.yes_ask_dollars || mkt.yes_ask || 0;
  const yesProb = yesBid > 0 && yesAsk > 0 ? Math.round(((yesBid + yesAsk) / 2) * 100) : 50;
  return {
    platform: "Kalshi",
    source: "kalshi",
    title: cleanKalshiTitle(mkt, evt),
    marketId: mkt.ticker,
    url: mkt.ticker ? `https://kalshi.com/markets/${mkt.event_ticker || ""}/${mkt.ticker}` : null,
    options: [
      { name: "Yes", probability: yesProb },
      { name: "No", probability: 100 - yesProb },
    ],
    volume: parseFloat(mkt.volume_24h_fp || mkt.volume_24h) || 0,
    liquidity: parseFloat(mkt.liquidity_dollars || mkt.liquidity) || 0,
    endDate: mkt.close_time || mkt.expiration_time,
    openInterest: parseFloat(mkt.open_interest_fp || 0),
  };
}

function formatPolymarketMarket(m) {
  let options = [];
  try {
    const outcomes = JSON.parse(m.outcomes || "[]");
    const prices = JSON.parse(m.outcomePrices || "[]");
    options = outcomes.map((name, i) => ({
      name, probability: Math.round(parseFloat(prices[i] || 0) * 100),
    }));
  } catch (_) {}

  return {
    platform: "Polymarket",
    source: "polymarket",
    title: m.question || "",
    marketId: m.id,
    url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
    options,
    volume: parseFloat(m.volume24hr) || 0,
    liquidity: parseFloat(m.liquidityNum) || 0,
    endDate: m.endDate,
    openInterest: 0,
  };
}

// Score how well keywords match a market title (0 = no match, higher = better)
function keywordMatchScore(keywords, marketTitle) {
  const titleLower = marketTitle.toLowerCase();
  const titleWords = extractKeywords(titleLower);
  let score = 0;
  for (const kw of keywords) {
    if (titleLower.includes(kw)) score += 1;
    // Exact word match scores higher
    if (titleWords.includes(kw)) score += 1;
  }
  return score;
}

// ═══════════════════════════════════════════════════════════════
// CONTROVERSY SCORING — Start from debates, not markets
// ═══════════════════════════════════════════════════════════════

function scoreControversies(debates, trends) {
  console.log("[MATCHING] Scoring controversies...");
  const scored = [];

  for (const debate of debates) {
    const keywords = extractKeywords(debate.title.toLowerCase());

    // Base: controversy score from Reddit (split votes × comments)
    let score = Math.min(debate.controversyScore, 100);

    // Boost for conviction language
    score += debate.convictionHits.length * 10;

    // Boost for high comment count (active argument)
    if (debate.comments > 200) score += 20;
    else if (debate.comments > 50) score += 10;
    else if (debate.comments > 20) score += 5;

    // Boost for very split votes (upvote_ratio 0.45-0.55)
    if (debate.splitScore >= 90) score += 25; // Nearly 50/50
    else if (debate.splitScore >= 70) score += 15;
    else if (debate.splitScore >= 50) score += 5;

    // Cross-reference with Google Trends
    const allTrends = [...(trends.google || []), ...(trends.hackernews || [])];
    const trendingOn = [];
    for (const trend of allTrends) {
      const trendLower = (trend.topic || "").toLowerCase();
      if (keywords.some((kw) => trendLower.includes(kw))) {
        trendingOn.push(trend.platform);
        score += 15;
      }
    }

    scored.push({
      ...debate,
      totalScore: Math.round(score),
      trendingOn: [...new Set(trendingOn)],
    });
  }

  scored.sort((a, b) => b.totalScore - a.totalScore);

  console.log(`[MATCHING] Scored ${scored.length} controversies. Top 5:`);
  scored.slice(0, 5).forEach((d, i) => {
    console.log(`  ${i + 1}. [${d.totalScore}] r/${d.subreddit} (${d.splitScore}% split, ${d.comments} comments) ${d.title.substring(0, 50)}...`);
  });

  return scored.slice(0, 20);
}

// ═══════════════════════════════════════════════════════════════
// X API: Find users in the debate (controversy-aware scoring)
// ═══════════════════════════════════════════════════════════════

async function findControversyUsers(debate, maxResults = 20) {
  if (!TWITTER_BEARER_TOKEN) return [];

  const keywords = extractKeywords(debate.title.toLowerCase()).slice(0, 4);
  if (keywords.length < 2) return [];

  // Search for conviction language + topic keywords
  const topicPart = keywords.slice(0, 3).join(" ");
  const query = `${topicPart} -is:retweet lang:en`;

  try {
    const params = new URLSearchParams({
      query,
      max_results: String(Math.min(maxResults, 100)),
      "tweet.fields": "public_metrics,author_id,created_at",
      "user.fields": "public_metrics,description,username,name",
      expansions: "author_id",
    });

    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?${params}`,
      { headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` } }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const tweets = data.data || [];
    const users = data.includes?.users || [];

    const userMap = {};
    for (const u of users) userMap[u.id] = u;

    const scored = [];
    for (const tweet of tweets) {
      const user = userMap[tweet.author_id];
      if (!user) continue;

      const m = tweet.public_metrics || {};
      const um = user.public_metrics || {};
      const bio = (user.description || "").toLowerCase();
      const text = (tweet.text || "").toLowerCase();

      // Controversy-aware scoring:
      // Reply ratio = controversy signal (replies > likes = "ratio'd")
      const replyRatio = (m.reply_count || 0) / Math.max(m.like_count || 1, 1);
      const isRatiod = (m.reply_count || 0) > (m.like_count || 0);

      // Conviction in tweet text
      const hasConviction = CONVICTION_WORDS.some((w) => text.includes(w));

      // Engagement depth
      const engagement =
        (m.like_count || 0) +
        (m.retweet_count || 0) * 2 +
        (m.reply_count || 0) * 3 + // Replies weighted highest (indicates debate)
        (m.quote_count || 0) * 3;

      const followers = Math.log10(Math.max(um.followers_count || 1, 1));

      const tweetAge = (Date.now() - new Date(tweet.created_at).getTime()) / (1000 * 60 * 60);
      const recency = tweetAge < 2 ? 1 : tweetAge < 6 ? 0.7 : tweetAge < 24 ? 0.4 : 0.2;

      const score =
        0.25 * Math.min(engagement / 100, 1) +
        0.20 * Math.min(replyRatio, 1) +     // High reply ratio = in the argument
        0.20 * recency +
        0.15 * (hasConviction ? 1 : 0) +      // Would they bet?
        0.10 * Math.min(followers / 6, 1) +
        0.10 * (isRatiod ? 1 : 0);            // Getting ratio'd = controversial take

      scored.push({
        handle: `@${user.username}`,
        name: user.name,
        followers: um.followers_count || 0,
        score: Math.round(score * 100),
        tweetText: tweet.text?.substring(0, 200),
        tweetId: tweet.id,
        isRatiod,
        hasConviction,
        engagement: {
          likes: m.like_count || 0,
          retweets: m.retweet_count || 0,
          replies: m.reply_count || 0,
          quotes: m.quote_count || 0,
          replyRatio: Math.round(replyRatio * 100) / 100,
        },
      });
    }

    // Dedupe by handle, keep highest score
    const seen = new Set();
    const deduped = [];
    scored.sort((a, b) => b.score - a.score);
    for (const u of scored) {
      if (!seen.has(u.handle)) { seen.add(u.handle); deduped.push(u); }
    }

    return deduped.slice(0, 10);
  } catch (err) {
    console.warn(`[MATCHING] X API error:`, err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// BET STRING GENERATOR — via xAI Grok
// ═══════════════════════════════════════════════════════════════

async function generateBetStrings(topics) {
  for (const t of topics) {
    t.detectedCategory = t.detectedCategory || detectCategory(t);
    // Map categories not in CATEGORIES spec to closest match
    const catMap = { finance: "media", crypto: "media", "prediction-markets": "politics" };
    const safeCat = catMap[t.detectedCategory] || t.detectedCategory;
    try {
      t.suggestedAmount = calculateAmount(t, safeCat);
    } catch (_) {
      t.suggestedAmount = 100;
    }
  }

  if (!XAI_API_KEY) {
    console.warn("[MATCHING] No xAI API key — generating template bet strings");
    return topics.map((t) => {
      const cat = CATEGORIES[t.detectedCategory] || CATEGORIES.media;
      const handle = t.topUsers?.[0]?.handle || "@friend";
      const prefix = cat.person === "first" ? "I Will " : "";
      const cleaned = t.title.replace(/^will\s+/i, "");
      return { ...t, betString: `${handle} WeBet $${t.suggestedAmount} ${prefix}${toTitleCase(cleaned)} By 12/31/26` };
    });
  }

  console.log(`[MATCHING] Generating bet strings for ${topics.length} topics via Grok...`);

  const inputBlock = topics.map((t, i) => {
    const topUser = t.topUsers?.[0]?.handle || "@friend";
    const yesOdds = t.referee?.options?.find((o) => o.name?.toLowerCase() === "yes")?.probability;
    const oddsStr = yesOdds != null ? `Yes: ${yesOdds}%` : "No odds available";
    const cat = CATEGORIES[t.detectedCategory] || CATEGORIES.media;
    const refPlatform = t.referee ? `[Settled by ${t.referee.platform}]` : "[No market — engagement bet]";
    return `${i + 1}. [${cat.emoji} ${cat.label}] "${t.title}" | ${oddsStr} | ${refPlatform} | Suggested: $${t.suggestedAmount} | ${topUser}`;
  }).join("\n");

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: "grok-3-mini",
        messages: [
          { role: "system", content: WEBET_STRING_SYSTEM_PROMPT },
          { role: "user", content: inputBlock },
        ],
        temperature: 0.4,
      }),
    });

    if (!res.ok) {
      console.warn(`[MATCHING] Grok returned ${res.status}`);
      return fallbackBetStrings(topics);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("@"));
    return topics.map((t, i) => ({ ...t, betString: lines[i] || fallbackSingleBetString(t) }));
  } catch (err) {
    console.error("[MATCHING] Grok error:", err.message);
    return fallbackBetStrings(topics);
  }
}

function fallbackBetStrings(topics) { return topics.map((t) => ({ ...t, betString: fallbackSingleBetString(t) })); }
function fallbackSingleBetString(t) {
  const cat = CATEGORIES[t.detectedCategory] || CATEGORIES.media;
  const handle = t.topUsers?.[0]?.handle || "@friend";
  const prefix = cat.person === "first" ? "I Will " : "";
  const cleaned = t.title.replace(/^will\s+/i, "");
  return `${handle} WeBet $${t.suggestedAmount || 100} ${prefix}${toTitleCase(cleaned)} By 12/31/26`;
}
function toTitleCase(str) { return str.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase()); }

// Extract keywords (skip stop words)
function extractKeywords(text) {
  const stopWords = new Set([
    "will", "the", "a", "an", "is", "are", "be", "by", "of", "in", "on",
    "to", "for", "at", "or", "and", "that", "this", "it", "with", "from",
    "has", "have", "do", "does", "did", "was", "were", "been", "being",
    "before", "after", "above", "below", "than", "more", "most", "who",
    "what", "when", "where", "which", "how", "not", "no", "yes", "any",
    "all", "each", "every", "if", "then", "than", "so", "but",
  ]);
  return text.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK: When Reddit is rate-limited, seed from prediction markets
// Converts high-volume markets into debate format for the pipeline
// ═══════════════════════════════════════════════════════════════

async function fetchFallbackPolymarket() {
  try {
    const res = await fetch(
      `${GAMMA_API}/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false`,
      { headers: { "User-Agent": "WeBetAI-Matching/1.0" } }
    );
    if (!res.ok) return [];
    const markets = await res.json();
    if (!Array.isArray(markets)) return [];

    return markets.filter((m) => m.question).map((m) => {
      let options = [];
      try {
        const outcomes = JSON.parse(m.outcomes || "[]");
        const prices = JSON.parse(m.outcomePrices || "[]");
        options = outcomes.map((name, i) => ({
          name, probability: Math.round(parseFloat(prices[i] || 0) * 100),
        }));
      } catch (_) {}

      // Simulate controversy signals from market data
      const spread = Math.abs((parseFloat(m.bestAsk) || 0) - (parseFloat(m.bestBid) || 0));
      const yesPrice = parseFloat((JSON.parse(m.outcomePrices || "[]"))[0] || 0.5);
      // Markets near 50/50 are inherently controversial
      const marketSplit = Math.round((1 - Math.abs(yesPrice - 0.5) * 2) * 100);

      return {
        source: "polymarket-fallback",
        subreddit: "polymarket",
        category: classifyCategory(m.question),
        title: m.question,
        body: "",
        score: 0,
        comments: 0,
        upvoteRatio: yesPrice, // Use market odds as proxy
        splitScore: marketSplit,
        convictionHits: [],
        controversyScore: marketSplit + Math.min(parseFloat(m.volume24hr || 0) / 10000, 50),
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : "",
        postId: m.id,
        created: Date.now() / 1000,
        author: "Polymarket",
        // Pre-attach referee since we already have the market
        _preAttachedReferee: {
          platform: "Polymarket",
          source: "polymarket",
          title: m.question,
          marketId: m.id,
          url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
          options,
          volume: parseFloat(m.volume24hr) || 0,
          liquidity: parseFloat(m.liquidityNum) || 0,
          endDate: m.endDate,
          openInterest: 0,
        },
      };
    });
  } catch (err) {
    console.warn("[MATCHING] Polymarket fallback error:", err.message);
    return [];
  }
}

async function fetchFallbackKalshi() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const weekOut = now + 7 * 24 * 60 * 60;
    const res = await fetch(`${KALSHI_API}/markets?status=open&limit=50&min_close_ts=${now}&max_close_ts=${weekOut}`);
    if (!res.ok) return [];
    const data = await res.json();
    const markets = data.markets || [];

    return markets
      .filter((m) => {
        const raw = m.title || "";
        // Skip multi-outcome parlay titles (comma-separated outcome lists)
        if (raw.includes(",yes ") || raw.includes(",no ")) return false;
        // Must have some title content
        return raw.length > 0 || (m.subtitle && m.subtitle.length > 0);
      })
      .map((m) => {
        const cleanTitle = cleanKalshiTitle(m);
        const yesBid = m.yes_bid_dollars || 0;
        const yesAsk = m.yes_ask_dollars || 0;
        const yesPrice = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : 0.5;
        const marketSplit = Math.round((1 - Math.abs(yesPrice - 0.5) * 2) * 100);

        return {
          source: "kalshi-fallback",
          subreddit: "kalshi",
          category: classifyCategory(cleanTitle),
          title: cleanTitle,
          body: "",
          score: 0,
          comments: 0,
          upvoteRatio: yesPrice,
          splitScore: marketSplit,
          convictionHits: [],
          controversyScore: marketSplit + Math.min(parseFloat(m.volume_24h_fp || 0) / 1000, 50),
          url: m.ticker ? `https://kalshi.com/markets/${m.event_ticker || ""}/${m.ticker}` : "",
          postId: m.ticker,
          created: Date.now() / 1000,
          author: "Kalshi",
          _preAttachedReferee: formatKalshiMarket(m),
        };
      })
      .slice(0, 20);
  } catch (err) {
    console.warn("[MATCHING] Kalshi fallback error:", err.message);
    return [];
  }
}

// Category classifier (mirrors get-polymarket.js)
function classifyCategory(text) {
  const q = (text || "").toLowerCase();
  if (/trump|biden|election|president|congress|senate|governor|vote|democrat|republican|tariff|political|primary|impeach|regime|ceasefire|iran|china|xi jinping|putin|russia|ukraine|war\b|sanctions|nato|military|forces enter|diplomacy/.test(q)) return "politics";
  if (/bitcoin|btc|ethereum|eth\b|crypto|token|defi|blockchain|solana|dogecoin|xrp/.test(q)) return "crypto";
  if (/nba|nfl|mlb|nhl|soccer|football|basketball|tennis|ufc|championship|super bowl|world cup|mvp|playoff|lakers|celtics|warriors|yankees|dodgers|chiefs|eagles|fifa|spurs|finals/.test(q)) return "sports";
  if (/stock|fed\b|interest rate|gdp|recession|ipo|earnings|revenue|tesla|apple|inflation|oil|crude|gold|s&p|nasdaq|bps/.test(q)) return "finance";
  return "media";
}

// ═══════════════════════════════════════════════════════════════
// MAIN PIPELINE — CONTROVERSY FIRST
// ═══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  console.log("[MATCHING] ═══ Starting CONTROVERSY-FIRST matching engine v2 ═══");
  const startTime = Date.now();

  try {
    // ── Step 1: Find the fights (controversy sources in parallel) ──
    console.log("[MATCHING] Step 1: Finding heated debates...");
    const [debates, trends] = await Promise.all([
      fetchRedditControversial(),
      fetchTrendingSocial(),
    ]);

    console.log(`[MATCHING] Debates: ${debates.length} controversial posts`);

    // ── Fallback: If Reddit is rate-limited, seed from prediction markets ──
    if (debates.length === 0) {
      console.log("[MATCHING] Reddit returned 0 — falling back to market-seeded debates...");
      let polyFallback = [], kalshiFallback = [];
      try {
        polyFallback = await fetchFallbackPolymarket();
        console.log(`[MATCHING] Polymarket fallback: ${polyFallback.length} markets`);
      } catch (err) {
        console.error("[MATCHING] Polymarket fallback failed:", err.message);
      }
      try {
        kalshiFallback = await fetchFallbackKalshi();
        console.log(`[MATCHING] Kalshi fallback: ${kalshiFallback.length} markets`);
      } catch (err) {
        console.error("[MATCHING] Kalshi fallback failed:", err.message);
      }
      const marketSeeded = [...polyFallback, ...kalshiFallback];
      console.log(`[MATCHING] Total market-seeded: ${marketSeeded.length} topics`);
      for (const m of marketSeeded) debates.push(m);
    }

    // ── Step 2: Score controversies ──
    console.log("[MATCHING] Step 2: Scoring controversies...");
    const scoredDebates = scoreControversies(debates, trends);

    // ── Step 3: Match to prediction markets (referee lookup) ──
    console.log("[MATCHING] Step 3: Finding referee markets (Kalshi + Polymarket)...");
    const top15 = scoredDebates.slice(0, 15);
    let refereesFound = 0;
    // Map classifier outputs to CATEGORIES keys
    const catMap = { finance: "media", crypto: "media", "prediction-markets": "politics" };
    for (const debate of top15) {
      const rawCat = classifyCategory(debate.title);
      debate.detectedCategory = catMap[rawCat] || rawCat;
      // Use pre-attached referee from fallback, or look one up
      if (debate._preAttachedReferee) {
        debate.referee = debate._preAttachedReferee;
      } else {
        debate.referee = await findRefereeMarket(debate);
        await new Promise((r) => setTimeout(r, 300)); // Rate limit courtesy
      }
      if (debate.referee) refereesFound++;
    }
    console.log(`[MATCHING] Referees found: ${refereesFound}/${top15.length}`);

    // ── Step 4: Find X users in the debate ──
    console.log("[MATCHING] Step 4: Finding controversy participants on X...");
    const topDebates = top15.slice(0, 10);
    for (const debate of topDebates) {
      debate.topUsers = await findControversyUsers(debate);
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const debate of top15.slice(10)) {
      debate.topUsers = [];
    }

    // ── Step 5: Generate bet strings ──
    console.log("[MATCHING] Step 5: Generating WeBet bet strings...");
    const withBets = await generateBetStrings(top15);

    // ── Step 6: Store to Netlify Blobs ──
    console.log("[MATCHING] Step 6: Storing to Netlify Blobs...");
    const now = new Date();
    const dateKey = now.toISOString().split("T")[0];
    const cycleKey = `${now.getHours().toString().padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}`;

    const payload = {
      version: "v2-controversy-first",
      generatedAt: now.toISOString(),
      dateKey,
      cycleKey,
      pipelineDuration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      sourceCounts: {
        redditControversial: debates.length,
        googleTrends: (trends.google || []).length,
        hackerNews: (trends.hackernews || []).length,
        refereesMatched: refereesFound,
      },
      topics: withBets.map((d) => {
        const cat = CATEGORIES[d.detectedCategory] || CATEGORIES.media;
        return {
          title: d.title,
          url: d.url,
          platform: d.referee?.platform || `reddit/r/${d.subreddit}`,
          score: d.totalScore,
          splitScore: d.splitScore,
          comments: d.comments,
          upvoteRatio: d.upvoteRatio,
          convictionHits: d.convictionHits,
          options: d.referee?.options || [],
          betString: d.betString,
          suggestedAmount: d.suggestedAmount,
          signals: {
            predictionMarket: !!d.referee,
            marketPlatform: d.referee?.platform || null,
            marketTitle: d.referee?.title || null,
            marketUrl: d.referee?.url || null,
            reddit: { subreddit: d.subreddit, heat: d.controversyScore, author: d.author },
            trendingOn: d.trendingOn || [],
          },
          topUsers: (d.topUsers || []).slice(0, 5),
          category: {
            id: d.detectedCategory,
            label: cat.label,
            emoji: cat.emoji,
            person: cat.person,
            resolution: d.referee ? `${d.referee.platform}: ${d.referee.title}` : cat.resolution,
          },
        };
      }),
      rawTrends: {
        google: (trends.google || []).slice(0, 10),
        hackernews: (trends.hackernews || []).slice(0, 10),
      },
    };

    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-matching", siteID, token });

    await store.setJSON(`feed-${dateKey}-${cycleKey}`, payload);
    await store.setJSON("feed-latest", payload);
    await store.set("latest-key", `${dateKey}-${cycleKey}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[MATCHING] ═══ Pipeline v2 complete in ${elapsed}s ═══`);
    console.log(`[MATCHING] ${withBets.length} debates scored, ${refereesFound} matched to markets, ${topDebates.filter((d) => d.topUsers?.length > 0).length} matched with X users`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        version: "v2-controversy-first",
        duration: `${elapsed}s`,
        debateCount: withBets.length,
        refereesFound,
        xMatchedCount: topDebates.filter((d) => d.topUsers?.length > 0).length,
        top3: withBets.slice(0, 3).map((d) => ({
          title: d.title,
          score: d.totalScore,
          splitScore: d.splitScore,
          referee: d.referee?.platform || "none",
          betString: d.betString,
        })),
      }),
    };
  } catch (err) {
    console.error("[MATCHING] Pipeline error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
