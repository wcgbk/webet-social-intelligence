/**
 * generate-truth-content-background.js — Background function
 *
 * The Authentic Press content engine:
 *   1. Pull trending political stories via Grok + X search
 *   2. Pull prediction market odds from Polymarket + Kalshi
 *   3. Use Claude to analyze coverage, extract data, generate story cards
 *   4. Generate Truth Social reply drafts for @AP mentions
 *   5. Store everything in Netlify Blobs for the /truth page + dashboard
 *
 * Triggered by: trigger-truth.js (scheduled) or run-truth.js (manual)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ═══════════════════════════════════════════════
// POLYMARKET — fetch political markets
// ═══════════════════════════════════════════════

async function fetchPoliticalMarkets() {
  try {
    const now = new Date();
    const weekOut = new Date(now.getTime() + 14 * 86400000);
    const minDate = now.toISOString();
    const maxDate = weekOut.toISOString();

    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false&end_date_min=${minDate}&end_date_max=${maxDate}`
    );
    if (!res.ok) return [];
    const markets = await res.json();

    return markets
      .filter(m => {
        const q = (m.question || '').toLowerCase();
        return /trump|biden|congress|senate|tariff|border|immigration|inflation|fed\b|election|supreme court|executive order|legislation|bill\b|vote|policy|government|president/i.test(q);
      })
      .slice(0, 20)
      .map(m => {
        const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
        return {
          question: m.question || '',
          yesPrice: parseFloat(prices[0]) || 0.5,
          noPrice: parseFloat(prices[1]) || 0.5,
          volume24h: parseFloat(m.volume24hr) || 0,
          url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
          source: 'Polymarket',
        };
      });
  } catch (err) {
    console.warn('Polymarket fetch failed:', err.message);
    return [];
  }
}

async function fetchKalshiPolitical() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const twoWeeks = now + 14 * 86400;
    const res = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&min_close_ts=${now}&max_close_ts=${twoWeeks}&limit=50`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.markets || [])
      .filter(m => {
        const q = (m.title || '').toLowerCase();
        return /trump|biden|congress|senate|tariff|border|inflation|fed\b|election|executive|legislation|bill\b|policy|government|president/i.test(q);
      })
      .slice(0, 20)
      .map(m => ({
        question: m.title || '',
        yesPrice: m.last_price_dollars || m.last_price || 0.5,
        noPrice: 1 - (m.last_price_dollars || m.last_price || 0.5),
        volume24h: parseFloat(m.volume_24h_fp || m.volume_24h) || 0,
        url: m.ticker ? `https://kalshi.com/markets/${m.event_ticker}/${m.ticker}` : null,
        source: 'Kalshi',
      }));
  } catch (err) {
    console.warn('Kalshi fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// X TRENDS — political trending via Grok
// ═══════════════════════════════════════════════

async function fetchPoliticalTrends(xaiKey) {
  if (!xaiKey) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4-fast-non-reasoning',
        stream: false,
        tools: [{ type: 'x_search' }],
        input: [{
          role: 'user',
          content: `Search X right now for the top 5 political/news stories being discussed in the last 12 hours. Focus on stories from AP, Reuters, CNN, Fox News, NYT, or major news outlets that are generating debate.

For each story, find:
1. The original news headline/claim
2. What people on X are saying about it (the main criticism or debate)
3. Any specific data points people are citing to counter the story
4. The journalist or outlet that published it

For each story, also find the MOST popular/viral X post discussing or debunking this story. Get the exact X post URL and the post author's handle and display name, and the text of that post.

Return ONLY a JSON array:
[{
  "headline": "the news headline or claim",
  "source": "AP" or "Reuters" or "CNN" etc,
  "authorHandle": "journalist X handle if findable, else outlet handle",
  "category": "Politics" or "Economy" or "Immigration" or "Foreign Policy" or "Tech/Science",
  "debate": "1-2 sentence summary of what X users are saying",
  "counterData": "specific data point critics are citing, if any",
  "xPostUrl": "url of a popular X post discussing this (must be real x.com URL)",
  "xPostAuthor": "display name of the X post author",
  "xPostHandle": "X handle of the post author (without @)",
  "xPostText": "the full text of the X post (up to 280 chars)"
}]`
        }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) return [];

    const data = await res.json();
    let content = '';
    if (data.output) {
      for (const item of data.output) {
        if (item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text' && c.text) { content = c.text; break; }
          }
        }
        if (content) break;
      }
    }

    if (!content) return [];
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('Grok trends failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// CLAUDE — Analyze stories + generate cards
// ═══════════════════════════════════════════════

async function analyzeWithClaude(trends, markets, anthropicKey) {
  if (!anthropicKey || trends.length === 0) return [];

  const marketContext = markets.slice(0, 15).map(m =>
    `- "${m.question}" → YES ${Math.round(m.yesPrice * 100)}% (${m.source})`
  ).join('\n');

  const trendContext = trends.map((t, i) =>
    `Story ${i + 1}: [${t.source}] "${t.headline}" | Category: ${t.category} | Debate: ${t.debate} | Counter-data: ${t.counterData || 'none cited'} | Author: @${t.authorHandle || t.source} | X Post: ${t.xPostUrl || 'none'} by @${t.xPostHandle || '?'} (${t.xPostAuthor || '?'}): "${t.xPostText || ''}"`
  ).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `You are Authentic Press, a neutral data service. You don't take sides. You surface the data behind headlines so people can decide for themselves.

TRENDING STORIES:
${trendContext}

PREDICTION MARKET DATA:
${marketContext}

For each story, generate a story card with:
1. headline: the original headline (as reported)
2. source: outlet name (AP, Reuters, CNN, etc.)
3. authorHandle: journalist/outlet X handle
4. category: Politics, Economy, Immigration, Foreign Policy, Tech/Science
5. time: relative time (e.g. "3 hours ago")
6. reported: what the outlet claimed (short, factual)
7. dataPoint: the most relevant counter-data or source data (neutral, factual)
8. omitted: what was left out of coverage (if anything, neutral framing)
9. marketOdds: one-sentence summary of prediction market odds related to this story
10. markets: array of [{question, probability}] — relevant prediction markets (probability 0-1)
11. coverage: array of [{outlet, summary, color}] — how 5 outlets covered the SAME story differently. Use these colors: AP=#ef4444, Reuters=#f97316, Fox News=#3b82f6, CNN=#ef4444, NYT/WSJ=#a3a3a3
12. xPost: object with {url, author, handle, text} — the viral X post discussing/debunking this story (pass through from the trend data exactly as provided)

CRITICAL: Be NEUTRAL. Don't editorialize. State facts. Let the data speak. If there's no counter-data, say so honestly. Don't manufacture controversy. Pass through the X post data exactly as provided — do NOT fabricate X posts.

Return ONLY a JSON array of story cards. No markdown fences.`
        }],
      }),
    });

    if (!res.ok) {
      console.error('Claude API error:', res.status);
      return [];
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Claude analysis failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// GENERATE TRUTH SOCIAL REPLY DRAFTS
// ═══════════════════════════════════════════════

async function generateReplyDrafts(stories, anthropicKey) {
  if (!anthropicKey || stories.length === 0) return [];

  const storyContext = stories.slice(0, 5).map((s, i) =>
    `Story ${i + 1}: "${s.headline}" | Data: ${s.dataPoint || 'N/A'} | Markets: ${s.marketOdds || 'N/A'} | Author: @${s.authorHandle || s.source}`
  ).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are Authentic Press (@AP on Truth Social) by WeBet. You are NOT the Associated Press. You are a neutral data service that surfaces the numbers behind every headline.

People tag @AP on Truth Social thinking they're talking to the Associated Press. When they complain about media coverage, you reply with neutral, data-backed context. You don't take sides — you add the data layer.

TODAY'S STORIES:
${storyContext}

Generate 3 types of Truth Social posts for EACH story:

1. ORIGINAL POST — a standalone post for the @AP profile that presents the data neutrally
2. REPLY TO COMPLAINER — a reply for when someone tags @AP complaining about this story. Include the "reveal" that you're Authentic Press, not Associated Press.
3. REPLY WITH MARKET DATA — a reply focused on prediction market odds vs how the story was framed

Each post should:
- Be under 500 characters (Truth Social limit)
- Be neutral, factual, data-first
- End with "Think you know better? Send this bet → webetsocial.com/challenge" CTA
- For replies, include: "We're Authentic Press by WeBet — the data behind every headline."
- NEVER take a political side
- NEVER use inflammatory language
- Add value with specific data points

Return ONLY a JSON array:
[{
  "storyIndex": 0,
  "type": "original" | "reply_complainer" | "reply_market",
  "text": "the post text",
  "targetDescription": "who this reply targets (for dashboard context)"
}]`
        }],
      }),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Reply draft generation failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════

exports.handler = async (event) => {
  console.log('=== Authentic Press content generation starting ===');

  const xaiKey = process.env.XAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const todayKey = new Date().toISOString().split('T')[0];

  // 1. Fetch data in parallel
  const [trends, polyMarkets, kalshiMarkets] = await Promise.all([
    fetchPoliticalTrends(xaiKey),
    fetchPoliticalMarkets(),
    fetchKalshiPolitical(),
  ]);

  const allMarkets = [...polyMarkets, ...kalshiMarkets];
  console.log(`Fetched: ${trends.length} trends, ${polyMarkets.length} Polymarket, ${kalshiMarkets.length} Kalshi`);

  // 2. Analyze with Claude
  const stories = await analyzeWithClaude(trends, allMarkets, anthropicKey);
  console.log(`Generated ${stories.length} story cards`);

  // 3. Generate reply drafts
  const replyDrafts = await generateReplyDrafts(stories, anthropicKey);
  console.log(`Generated ${replyDrafts.length} reply drafts`);

  // 4. Store stories for /truth page via Netlify Blobs API
  const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;

  const storyData = {
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    generated: new Date().toISOString(),
    stories: stories.map((s, i) => ({ ...s, id: `story-${todayKey}-${i}` })),
    marketsChecked: allMarkets.length,
    trendsFound: trends.length,
  };

  const draftData = {
    generated: new Date().toISOString(),
    drafts: replyDrafts,
    stories: stories.map(s => ({ headline: s.headline, source: s.source })),
  };

  if (netlifyToken) {
    const storeBase = `https://api.netlify.com/api/v1/blobs/${siteId}`;
    const headers = { Authorization: `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' };

    const [storyRes, draftRes] = await Promise.all([
      fetch(`${storeBase}/truth-stories/${todayKey}`, {
        method: 'PUT', headers, body: JSON.stringify(storyData),
      }),
      fetch(`${storeBase}/truth-drafts/${todayKey}`, {
        method: 'PUT', headers, body: JSON.stringify(draftData),
      }),
    ]);
    console.log(`Blob writes: stories=${storyRes.status}, drafts=${draftRes.status}`);
  } else {
    console.warn('No NETLIFY_AUTH_TOKEN — cannot write blobs');
  }

  console.log('=== Authentic Press content generation complete ===');

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      stories: stories.length,
      drafts: replyDrafts.length,
      markets: allMarkets.length,
    }),
  };
};
