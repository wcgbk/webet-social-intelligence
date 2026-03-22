// admin-feed.js — Netlify Function
// GET /api/admin-feed?category=trending&limit=5
// Orchestrates: search-x → convert-bet → Betty compose
// Returns array of editorial card objects for the admin dashboard

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Auth helper (copied inline — Netlify Functions can't share modules) ──────

function verifyAuth(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const secret = process.env.ADMIN_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, hmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  if (hmac.length !== expectedHmac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload.email || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Betty system prompt ──────────────────────────────────────────────────────

const BETTY_SYSTEM_PROMPT = `You are Betty, WeBetSocial's AI betting intelligence agent. Given a trending X post and its matched Polymarket prediction market data, compose a publish-ready social post that:
1. Opens with a hook about the trending topic (what's happening, why it matters)
2. Ties in the Polymarket data (odds, volume, what the market is pricing in)
3. Includes the WeBet bet string: "@Friend WeBet $5 [SIDE] — [bet claim]"
4. Includes a Polymarket verification line: "[odds]% [SIDE] on Polymarket · [volume] volume"
5. Ends with a CTA and link to webetsocial.com/feed

Produce TWO versions in JSON format:
{
  "xVersion": "Max 280 chars. Snappy, hashtag-ready. Link to webetsocial.com at end.",
  "truthVersion": "Max 500 chars. More direct, less slang. End with X migration CTA: Follow @WeBetSocialAI on X for live threads.",
  "headline": "Short headline for the card",
  "summary": "2-3 sentence summary of the trending topic and bet opportunity"
}

IMPORTANT: Return ONLY valid JSON, no markdown or extra text.`;

// ── Category → search query mapping ─────────────────────────────────────────

const CATEGORY_QUERIES = {
  trending: 'trending news predictions bold takes',
  politics: 'politics policy election prediction bold claim',
  sports: 'sports betting prediction bold take upset',
  crypto: 'crypto bitcoin ethereum prediction market bold take',
  markets: 'stock market economy prediction bold take',
  culture: 'entertainment culture viral prediction hot take',
  tech: 'tech AI startup prediction bold claim',
};

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Auth check — skip if token is 'open' or 'demo' (login disabled mode)
  const authHeader = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (authHeader !== 'open' && authHeader !== 'demo') {
    const auth = verifyAuth(event);
    if (!auth) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  try {
    const params = event.queryStringParameters || {};
    const category = params.category || 'trending';
    const limit = Math.min(parseInt(params.limit) || 5, 10);
    const siteURL = process.env.URL || 'https://webetsocial.com';
    const xaiKey = process.env.XAI_API_KEY;

    const searchQuery = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.trending;

    // ── Step 1: Search for trending posts ──────────────────────────────────
    console.log(`[admin-feed] Searching: "${searchQuery}" (category: ${category})`);

    let posts = [];
    try {
      const searchRes = await fetch(`${siteURL}/.netlify/functions/search-x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });

      const searchData = await searchRes.json();
      posts = (searchData.posts || []).slice(0, limit);
    } catch (err) {
      console.error('[admin-feed] search-x failed:', err.message);
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'Failed to fetch trending posts' }),
      };
    }

    if (posts.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ cards: [], category, message: 'No trending posts found' }),
      };
    }

    // ── Step 2: Convert each post to bet markets (parallel, max 5) ────────
    console.log(`[admin-feed] Converting ${posts.length} posts to bets`);

    const betPromises = posts.map(async (post) => {
      try {
        const convertRes = await fetch(`${siteURL}/.netlify/functions/convert-bet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: post.text,
            author: post.author,
            handle: post.handle,
            url: post.url,
          }),
        });

        if (!convertRes.ok) return { post, markets: [], aiBet: null };
        const data = await convertRes.json();
        return { post, markets: data.markets || [], aiBet: data.aiBet || null };
      } catch (err) {
        console.error(`[admin-feed] convert-bet failed for ${post.handle}:`, err.message);
        return { post, markets: [], aiBet: null };
      }
    });

    const betResults = await Promise.all(betPromises);

    // ── Step 3: Compose posts with Betty via xAI Grok ─────────────────────
    console.log(`[admin-feed] Composing ${betResults.length} editorial cards`);

    const cards = [];

    for (const result of betResults) {
      const { post, markets, aiBet } = result;

      let composed = null;
      if (xaiKey && markets.length > 0) {
        composed = await composeBettyPost(post, markets, xaiKey);
      }

      const card = {
        id: crypto.randomUUID(),
        category,
        createdAt: new Date().toISOString(),
        sourcePost: {
          text: post.text,
          author: post.author,
          handle: post.handle,
          url: post.url,
          likes: post.likes || 0,
          retweets: post.retweets || 0,
        },
        markets: markets.slice(0, 3),
        aiBet,
        composed: composed || {
          xVersion: '',
          truthVersion: '',
          headline: post.text.slice(0, 60) + (post.text.length > 60 ? '...' : ''),
          summary: post.text.slice(0, 200),
        },
        // Flatten composed fields for frontend consumption
        x_text: composed?.xVersion || '',
        truth_text: composed?.truthVersion || '',
        headline: composed?.headline || post.text.slice(0, 60),
        summary: composed?.summary || post.text.slice(0, 200),
        status: 'ready',
      };

      cards.push(card);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ items: cards, cards, category, count: cards.length }),
    };
  } catch (err) {
    console.error('[admin-feed] error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Betty post composition via xAI Grok ──────────────────────────────────────

async function composeBettyPost(post, markets, apiKey) {
  try {
    const marketSummary = markets.slice(0, 3).map((m) => {
      return `- ${m.question} | ${m.yesPrice}% YES | $${formatVolume(m.volume)} volume`;
    }).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          { role: 'system', content: BETTY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `TRENDING X POST by @${post.handle}:
"${post.text}"

Engagement: ${post.likes || 0} likes, ${post.retweets || 0} retweets

MATCHED POLYMARKET DATA:
${marketSummary}

Compose the social posts now.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error('[admin-feed] Grok compose error:', res.status);
      return null;
    }

    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').trim();

    let cleaned = content;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[admin-feed] compose error:', err.message);
    return null;
  }
}

function formatVolume(vol) {
  const n = parseFloat(vol) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}
