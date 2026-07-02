// search-x.js — Netlify Function (v2 — trending-first approach)
// Pipeline:
//   1. Ask Grok "What's trending on X right now?" (with optional category filter)
//   2. For each trending topic, Grok finds the top viral post with a real URL
//   3. Each post comes back with: bettable claim, entities, sentiment, topic context
//   4. Cache 5 min, fallback chain: Grok → Twitter v1.1 → Twitter v2 → Nitter → stale cache → defaults

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — longer TTL so overlapping requests reuse results instead of each triggering a new Grok Live Search

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { query, category, liveSearch, live } = JSON.parse(event.body || '{}');
    // Grok Live Search (grok-4-fast + x_search) is billed per source — OFF by default.
    // Callers that specifically need live X posts must opt in with liveSearch:true.
    const useGrok = liveSearch === true || live === true;
    // Resolve to a stable, known category so overlapping requests (and distinct
    // per-market queries) share ONE cache entry instead of each spawning a Live Search.
    const cat = resolveCategoryKey((category || query || 'trending').trim());
    const cacheKey = 'search-v2-' + cat;

    // ── Check cache first ──
    let cachedPosts = null;
    try {
      const store = getStore('search-cache');
      const cached = await store.get(cacheKey, { type: 'json' });
      if (cached && cached.posts && cached.posts.length > 0) {
        const age = Date.now() - (cached.ts || 0);
        if (age < CACHE_TTL_MS) {
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({ posts: cached.posts, cached: true }),
          };
        }
        cachedPosts = cached.posts;
      }
    } catch (e) {
      console.log('Cache read skipped:', e.message);
    }

    // ── Try live search ──
    const xaiKey = process.env.XAI_API_KEY;
    let posts = null;

    // Strategies 1 & 2 (Grok Live Search) only run when a caller explicitly opts in.
    // This keeps the endpoint from silently burning xAI Live Search credits on
    // high-traffic or unattended callers.
    if (useGrok && xaiKey) {
      // Strategy 1: Grok trending-first (two-phase: get trends → get posts)
      console.log('Attempting Grok trending-first for:', cat);
      posts = await searchTrendingWithGrok(cat, xaiKey);
      console.log('Grok trending result:', posts ? `${posts.length} posts` : 'null');

      // Strategy 2: Grok keyword search fallback (old approach, single call)
      if (!posts) {
        console.log('Falling back to Grok keyword search');
        posts = await searchKeywordWithGrok(cat, xaiKey);
      }
    } else if (!useGrok) {
      console.log('Grok Live Search skipped (liveSearch not requested) for:', cat);
    }

    // Strategy 3: Twitter v1.1 OAuth
    if (!posts) {
      const oauthCreds = {
        consumerKey: process.env.TWITTER_CONSUMER_KEY,
        consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      };
      if (oauthCreds.consumerKey && oauthCreds.accessToken) {
        posts = await searchTwitterV1(cat, oauthCreds);
      }
    }

    // Strategy 4: Twitter API v2
    const twitterToken = process.env.TWITTER_BEARER_TOKEN;
    if (!posts && twitterToken) {
      posts = await searchTwitterAPI(cat, twitterToken);
    }

    // Strategy 5: Nitter RSS
    if (!posts) {
      posts = await searchNitter(cat);
    }

    // ── Cache successful results ──
    if (posts && posts.length > 0) {
      try {
        const store = getStore('search-cache');
        await store.setJSON(cacheKey, { posts, ts: Date.now() });
      } catch (e) {
        console.log('Cache write skipped:', e.message);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ posts }) };
    }

    // ── Fallback: stale cache ──
    if (cachedPosts && cachedPosts.length > 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ posts: cachedPosts, cached: true, stale: true }),
      };
    }

    // ── Fallback: curated defaults ──
    const defaults = getDefaultPosts(cat);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ posts: defaults, fallback: true }),
    };

  } catch (err) {
    console.error('search-x error:', err);
    const defaults = getDefaultPosts('trending');
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ posts: defaults, fallback: true }),
    };
  }
};

// ── CATEGORY DEFINITIONS (used by Grok prompts) ─────────────────────────────
const CATEGORY_CONTEXT = {
  trending: 'the hottest topics across all categories — politics, sports, crypto, entertainment, tech, markets',
  politics: 'US and world politics — elections, legislation, tariffs, Supreme Court, foreign policy, government actions',
  sports: 'live sports — NBA, NFL, MLB, NHL, UFC/MMA, soccer, tennis, golf. Focus on games happening today/this week, trades, injuries, playoff races',
  crypto: 'cryptocurrency and blockchain — Bitcoin, Ethereum, altcoins, DeFi, regulation, ETFs, price movements',
  entertainment: 'entertainment and pop culture — movies, music, TV shows, celebrity news, awards, streaming',
  tech: 'technology — AI, startups, Apple, Google, Microsoft, product launches, funding rounds, regulation',
  markets: 'financial markets — stocks, Fed/interest rates, earnings, IPOs, economic data, Wall Street',
  culture: 'viral culture and debates — memes, social media drama, trending discourse, hot takes',
};

// ── Resolve any raw query/category string to a stable known-category key ─────
// The trending search only distinguishes by CATEGORY_CONTEXT bucket (falling back
// to 'trending'), so distinct free-text queries that map to the same bucket should
// share a cache entry rather than each triggering a fresh Grok Live Search.
function resolveCategoryKey(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (CATEGORY_CONTEXT[s]) return s; // already a known category

  const KEYWORDS = {
    politics: ['politic', 'election', 'trump', 'biden', 'congress', 'senate', 'tariff', 'supreme court', 'policy', 'government'],
    sports: ['sport', 'nba', 'nfl', 'mlb', 'nhl', 'ufc', 'mma', 'soccer', 'tennis', 'golf', 'playoff', 'game '],
    crypto: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'altcoin', 'defi', 'blockchain', 'etf'],
    entertainment: ['movie', 'music', 'celebrity', 'tv show', 'streaming', 'awards', 'entertain', 'pop culture'],
    tech: ['tech', 'startup', 'apple', 'google', 'microsoft', 'product launch', 'funding', 'ai '],
    markets: ['stock', 's&p', 'fed', 'interest rate', 'earnings', 'ipo', 'wall street', 'market'],
    culture: ['meme', 'viral', 'culture', 'debate', 'discourse'],
  };
  for (const [key, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(k => s.includes(k))) return key;
  }
  return 'trending';
}

// ── Grok Trending-First (the new approach) ──────────────────────────────────
async function searchTrendingWithGrok(category, apiKey) {
  try {
    const catContext = CATEGORY_CONTEXT[category] || CATEGORY_CONTEXT.trending;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4-fast-non-reasoning',
        stream: false,
        tools: [{ type: 'x_search' }],
        input: [
          {
            role: 'user',
            content: `You have access to real-time X/Twitter data. Your job is to find what people are ACTUALLY talking about RIGHT NOW on X.

CATEGORY FOCUS: ${catContext}

STEP 1: Search X to identify the 5 biggest trending topics/stories/debates happening RIGHT NOW in this category. These should be things people are actively posting about in the last few hours, not general evergreen topics.

STEP 2: For EACH trending topic, find ONE specific viral/popular X post about it. The post should:
- Have a strong opinion, hot take, prediction, or bold claim (something friends would argue about)
- Be from the last 24 hours
- Have real engagement (likes/retweets)
- Have a REAL post URL with a numeric status ID

CRITICAL RULES:
- Every "url" MUST be a real X post URL: https://x.com/username/status/REAL_NUMERIC_ID
- The status ID must be real — do NOT fabricate IDs
- Each post must be about a DIFFERENT trending topic (no duplicates)
- Prioritize posts with debatable claims over neutral news reporting

For each post, also extract:
- "topic": the trending topic this post is about (2-5 words, e.g. "Lakers vs Celtics", "Trump tariff announcement", "Bitcoin ETF inflows")
- "claim": the specific bettable claim or prediction in the post (e.g. "Lakers will sweep", "Tariffs will cause recession", "BTC hits 100K by summer")
- "sentiment": "bullish", "bearish", or "neutral" — the post author's stance
- "entities": array of key names/teams/tickers mentioned (e.g. ["Lakers", "LeBron", "Celtics"])

Return ONLY a JSON array, no markdown fences:
[{
  "text": "full post text",
  "author": "Display Name",
  "handle": "username",
  "url": "https://x.com/username/status/REAL_ID",
  "likes": 12500,
  "retweets": 3400,
  "topic": "trending topic name",
  "claim": "the bettable claim",
  "sentiment": "bullish",
  "entities": ["Entity1", "Entity2"]
}]`
          }
        ],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error('Grok trending API error:', res.status);
      return null;
    }

    const data = await res.json();
    let content = '';
    if (data.output) {
      for (const item of data.output) {
        if (item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text' && c.text) {
              content = c.text;
              break;
            }
          }
        }
        if (content) break;
      }
    }

    if (!content) return null;

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const posts = JSON.parse(cleaned);
    if (!Array.isArray(posts) || posts.length === 0) return null;

    const valid = posts
      .filter(p => p.url && p.text && p.handle && /\/status\/\d{10,}/.test(p.url))
      .slice(0, 5)
      .map(p => ({
        id: String(p.id || p.url.match(/\/status\/(\d+)/)?.[1] || ''),
        url: p.url,
        text: p.text,
        author: p.author || p.handle,
        handle: (p.handle || '').replace(/^@/, ''),
        date: p.date || '',
        likes: parseInt(p.likes) || 0,
        retweets: parseInt(p.retweets) || 0,
        // New fields from trending-first approach
        topic: p.topic || '',
        claim: p.claim || '',
        sentiment: p.sentiment || 'neutral',
        entities: Array.isArray(p.entities) ? p.entities : [],
      }));

    if (valid.length > 0) return valid;
    return null;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Grok trending timed out');
    } else {
      console.error('Grok trending error:', err.message);
    }
    return null;
  }
}

// ── Grok Keyword Search (fallback — old approach) ───────────────────────────
async function searchKeywordWithGrok(query, apiKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);

      const promptVariant = attempt === 0
        ? `Find 5 recent popular X posts about: ${query}`
        : `Search X for 5 trending tweets about: ${query}`;

      const res = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-4-fast-non-reasoning',
          stream: false,
          tools: [{ type: 'x_search' }],
          input: [
            {
              role: 'user',
              content: `${promptVariant}

CRITICAL: You MUST include the real X/Twitter post URL with the actual numeric status ID for each post. The URL format must be: https://x.com/username/status/1234567890123456789

Return ONLY a JSON array, no markdown fences, no explanation. Each object must have:
{"text":"...","author":"...","handle":"...","url":"https://x.com/handle/status/REAL_ID","likes":0,"retweets":0}

Focus on posts with bold claims, predictions, or hot takes. Prioritize high engagement. Every url field MUST contain a real /status/ numeric ID.`
            }
          ],
        }),
      });

      clearTimeout(timeout);
      if (!res.ok) continue;

      const data = await res.json();
      let content = '';
      if (data.output) {
        for (const item of data.output) {
          if (item.content) {
            for (const c of item.content) {
              if (c.type === 'output_text' && c.text) {
                content = c.text;
                break;
              }
            }
          }
          if (content) break;
        }
      }

      if (!content) continue;

      let cleaned = content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const posts = JSON.parse(cleaned);
      if (!Array.isArray(posts) || posts.length === 0) continue;

      const valid = posts
        .filter(p => p.url && p.text && p.handle && /\/status\/\d{10,}/.test(p.url))
        .slice(0, 5)
        .map(p => ({
          id: String(p.id || p.url.match(/\/status\/(\d+)/)?.[1] || ''),
          url: p.url,
          text: p.text,
          author: p.author || p.handle,
          handle: (p.handle || '').replace(/^@/, ''),
          date: p.date || '',
          likes: parseInt(p.likes) || 0,
          retweets: parseInt(p.retweets) || 0,
          topic: '',
          claim: '',
          sentiment: 'neutral',
          entities: [],
        }));

      if (valid.length > 0) return valid;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`Grok keyword attempt ${attempt + 1} timed out`);
      } else {
        console.error(`Grok keyword attempt ${attempt + 1} error:`, err.message);
      }
    }
  }
  return null;
}

// ── Twitter API v1.1 Search with OAuth 1.0a ─────────────────────────────────
function generateOAuthSignature(method, baseUrl, params, consumerSecret, tokenSecret) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map(k => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`).join('&');
  const signatureBase = `${method}&${encodeRFC3986(baseUrl)}&${encodeRFC3986(paramString)}`;
  const signingKey = `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');
}

function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

async function searchTwitterV1(query, creds) {
  try {
    const baseUrl = 'https://api.twitter.com/1.1/search/tweets.json';
    const searchParams = {
      q: `${query} -filter:retweets -filter:replies`,
      lang: 'en',
      result_type: 'popular',
      count: '15',
      tweet_mode: 'extended',
    };

    const oauthParams = {
      oauth_consumer_key: creds.consumerKey,
      oauth_nonce: generateNonce(),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: creds.accessToken,
      oauth_version: '1.0',
    };

    const allParams = { ...searchParams, ...oauthParams };
    const signature = generateOAuthSignature('GET', baseUrl, allParams, creds.consumerSecret, creds.accessTokenSecret);
    oauthParams.oauth_signature = signature;

    const authHeader = 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
      `${encodeRFC3986(k)}="${encodeRFC3986(oauthParams[k])}"`
    ).join(', ');

    const url = `${baseUrl}?${Object.entries(searchParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: { 'Authorization': authHeader },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.statuses || data.statuses.length === 0) return null;

    return data.statuses
      .map(tweet => {
        const user = tweet.user || {};
        return {
          id: tweet.id_str,
          url: `https://x.com/${user.screen_name}/status/${tweet.id_str}`,
          text: tweet.full_text || tweet.text || '',
          author: user.name || 'Unknown',
          handle: user.screen_name || '',
          date: tweet.created_at,
          likes: tweet.favorite_count || 0,
          retweets: tweet.retweet_count || 0,
          engagement: (tweet.favorite_count || 0) + (tweet.retweet_count || 0),
          profileImage: user.profile_image_url_https || '',
          topic: '',
          claim: '',
          sentiment: 'neutral',
          entities: [],
        };
      })
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Twitter v1.1 timed out');
    } else {
      console.error('Twitter v1.1 error:', err.message);
    }
    return null;
  }
}

// ── Twitter API v2 Recent Search ────────────────────────────────────────────
async function searchTwitterAPI(query, token) {
  try {
    const url = new URL('https://api.twitter.com/2/tweets/search/recent');
    url.searchParams.set('query', `${query} -is:retweet -is:reply lang:en`);
    url.searchParams.set('max_results', '10');
    url.searchParams.set('tweet.fields', 'author_id,created_at,text,public_metrics');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'name,username');

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.data) return null;

    const users = {};
    if (data.includes?.users) {
      data.includes.users.forEach(u => { users[u.id] = u; });
    }

    return data.data
      .map(tweet => {
        const user = users[tweet.author_id] || {};
        const metrics = tweet.public_metrics || {};
        return {
          id: tweet.id,
          url: `https://x.com/${user.username || 'i'}/status/${tweet.id}`,
          text: tweet.text,
          author: user.name || 'Unknown',
          handle: user.username || '',
          date: tweet.created_at,
          likes: metrics.like_count || 0,
          retweets: metrics.retweet_count || 0,
          topic: '',
          claim: '',
          sentiment: 'neutral',
          entities: [],
        };
      })
      .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
      .slice(0, 5);
  } catch (err) {
    console.error('Twitter API error:', err);
    return null;
  }
}

// ── Nitter RSS Fallback ─────────────────────────────────────────────────────
const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.cz',
];

async function searchNitter(query) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/search/rss?q=${encodeURIComponent(query)}&f=tweets`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeBetAI/1.0)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const xml = await res.text();
      const posts = parseNitterRSS(xml);
      if (posts.length > 0) return posts.slice(0, 5);
    } catch (e) {
      continue;
    }
  }
  return null;
}

function parseNitterRSS(xml) {
  const posts = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const linkMatch = link.match(/\/([^/]+)\/status\/(\d+)/);
    if (!linkMatch) continue;
    const handle = linkMatch[1];
    const tweetId = linkMatch[2];
    const titleMatch = title.match(/^(.*?)\s*\(@(\w+)\):\s*([\s\S]*)$/);
    posts.push({
      id: tweetId,
      url: `https://x.com/${handle}/status/${tweetId}`,
      text: decodeEntities(titleMatch ? titleMatch[3].trim() : title),
      author: decodeEntities(titleMatch ? titleMatch[1].trim() : handle),
      handle,
      date: pubDate,
      likes: 0,
      retweets: 0,
      topic: '',
      claim: '',
      sentiment: 'neutral',
      entities: [],
    });
  }
  return posts;
}

function extractTag(xml, tag) {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdataMatch) return cdataMatch[1];
  const plainMatch = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return plainMatch ? plainMatch[1] : '';
}

function decodeEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// ── Curated default posts (always-available fallback) ─────────────────────
function getDefaultPosts(query) {
  const q = query.toLowerCase();

  if (q.includes('sport') || q.includes('nba') || q.includes('nfl') || q.includes('mlb') || q.includes('ufc')) {
    return [
      { id: 'default-s1', url: 'https://x.com/espn', text: 'The NBA playoffs are heating up. Who\'s taking the title this year? The favorites are looking strong but upsets are always possible.', author: 'Sports Talk', handle: 'SportsTalk', likes: 12400, retweets: 3200, topic: 'NBA Playoffs', claim: 'Favorites win the title', sentiment: 'neutral', entities: ['NBA'] },
      { id: 'default-s2', url: 'https://x.com/espn', text: 'NFL draft season is here. Which team makes the best pick? Mock drafts are all over the place this year.', author: 'Draft Central', handle: 'DraftCentral', likes: 8900, retweets: 2100, topic: 'NFL Draft', claim: 'Best draft pick debate', sentiment: 'neutral', entities: ['NFL'] },
      { id: 'default-s3', url: 'https://x.com/espn', text: 'UFC fight card this weekend is stacked. Bold prediction: we see at least two knockouts in the first round.', author: 'MMA Insider', handle: 'MMAInsider', likes: 6500, retweets: 1800, topic: 'UFC Fight Card', claim: 'Two first round KOs', sentiment: 'bullish', entities: ['UFC'] },
      { id: 'default-s4', url: 'https://x.com/espn', text: 'MLB opening day is around the corner. Which team surprises everyone this season? My money is on a dark horse.', author: 'Baseball Today', handle: 'BaseballToday', likes: 5200, retweets: 1400, topic: 'MLB Season', claim: 'Dark horse team wins', sentiment: 'bullish', entities: ['MLB'] },
      { id: 'default-s5', url: 'https://x.com/espn', text: 'Soccer transfer window rumors are wild this summer. Multiple record-breaking deals could happen.', author: 'Transfer Watch', handle: 'TransferWatch', likes: 7800, retweets: 2600, topic: 'Soccer Transfers', claim: 'Record-breaking deals', sentiment: 'bullish', entities: ['Soccer'] },
    ];
  }

  if (q.includes('crypto') || q.includes('bitcoin') || q.includes('ethereum')) {
    return [
      { id: 'default-c1', url: 'https://x.com/crypto', text: 'Bitcoin is testing resistance levels again. Are we about to see a breakout or another rejection? The charts are saying something interesting.', author: 'Crypto Analysis', handle: 'CryptoAnalysis', likes: 15600, retweets: 4300, topic: 'Bitcoin Price', claim: 'Bitcoin breakout imminent', sentiment: 'bullish', entities: ['Bitcoin', 'BTC'] },
      { id: 'default-c2', url: 'https://x.com/crypto', text: 'Ethereum staking yields are changing the game. ETH could flip the narrative this cycle. Watch the on-chain data.', author: 'ETH Daily', handle: 'ETHDaily', likes: 9200, retweets: 2800, topic: 'Ethereum', claim: 'ETH flips narrative', sentiment: 'bullish', entities: ['Ethereum', 'ETH'] },
      { id: 'default-c3', url: 'https://x.com/crypto', text: 'The next major crypto regulation announcement could send markets either way. Position accordingly.', author: 'Blockchain News', handle: 'BlockchainNews', likes: 7400, retweets: 2100, topic: 'Crypto Regulation', claim: 'Regulation moves markets', sentiment: 'neutral', entities: ['Crypto'] },
    ];
  }

  if (q.includes('tech') || q.includes('ai') || q.includes('apple') || q.includes('google')) {
    return [
      { id: 'default-t1', url: 'https://x.com/tech', text: 'AI is moving faster than regulators can keep up. The next 12 months will define the decade for tech policy.', author: 'Tech Insider', handle: 'TechInsider', likes: 18200, retweets: 5100, topic: 'AI Regulation', claim: 'AI outpaces regulators', sentiment: 'bearish', entities: ['AI'] },
      { id: 'default-t2', url: 'https://x.com/tech', text: 'Apple\'s next product launch could be their biggest pivot in years. The rumors are wild but some of them check out.', author: 'Apple Watch', handle: 'AppleWatch', likes: 12800, retweets: 3600, topic: 'Apple Launch', claim: 'Biggest Apple pivot', sentiment: 'bullish', entities: ['Apple'] },
      { id: 'default-t3', url: 'https://x.com/tech', text: 'Google is making aggressive moves in AI. Their latest model benchmarks are turning heads in the research community.', author: 'AI Research', handle: 'AIResearch', likes: 9500, retweets: 2900, topic: 'Google AI', claim: 'Google leads AI race', sentiment: 'bullish', entities: ['Google', 'AI'] },
    ];
  }

  // Default: politics / trending
  return [
    { id: 'default-p1', url: 'https://x.com/politics', text: 'The political landscape is shifting faster than polls can capture. Both sides are mobilizing for what could be the most consequential policy fight of the year.', author: 'Political Pulse', handle: 'PoliticalPulse', likes: 24500, retweets: 8200, topic: 'Policy Fight', claim: 'Consequential policy battle', sentiment: 'neutral', entities: ['Congress'] },
    { id: 'default-p2', url: 'https://x.com/politics', text: 'Trade policy changes are sending shockwaves through global markets. The economic implications could last years.', author: 'Econ Watch', handle: 'EconWatch', likes: 16800, retweets: 5400, topic: 'Trade Policy', claim: 'Trade shockwaves', sentiment: 'bearish', entities: ['tariffs', 'markets'] },
    { id: 'default-p3', url: 'https://x.com/politics', text: 'Foreign policy tensions are escalating. Multiple diplomatic channels are active behind the scenes. Watch for announcements this week.', author: 'Global Affairs', handle: 'GlobalAffairs', likes: 13200, retweets: 4100, topic: 'Foreign Policy', claim: 'Diplomatic announcements coming', sentiment: 'neutral', entities: ['diplomacy'] },
  ];
}
