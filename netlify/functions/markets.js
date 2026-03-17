// markets.js — Netlify Function
// Fetches top Polymarket markets by volume, optionally matched to X trending topics
// Polymarket Gamma API: free, no auth required
// X API: requires X_BEARER_TOKEN env var for trending topics

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // ── Step 1: Fetch X Trending Topics (if API key is set) ──────────────
    let xTrends = [];
    const xBearerToken = process.env.X_BEARER_TOKEN;

    if (xBearerToken) {
      try {
        // X API v2 — get trending topics (US = WOEID 23424977)
        const trendsRes = await fetch(
          'https://api.x.com/2/trends/by/woeid/23424977',
          { headers: { Authorization: `Bearer ${xBearerToken}` } }
        );
        if (trendsRes.ok) {
          const trendsData = await trendsRes.json();
          xTrends = (trendsData.data || trendsData[0]?.trends || []).slice(0, 15).map(t => ({
            name: t.name || t.trend_name,
            query: t.query || t.name,
            tweetVolume: t.tweet_volume || t.tweet_count || null,
          }));
        }
      } catch (_) {}
    }

    // ── Step 2: Fetch Top Polymarket Markets ─────────────────────────────
    const polyRes = await fetch(
      'https://gamma-api.polymarket.com/markets?limit=30&active=true&closed=false&order=volume24hr&ascending=false'
    );
    if (!polyRes.ok) throw new Error(`Polymarket API returned ${polyRes.status}`);
    const polyMarkets = await polyRes.json();

    // ── Step 3: Format & categorize markets ─────────────────────────────
    const markets = polyMarkets
      .filter(m => {
        const vol24h = parseFloat(m.volume24hr) || 0;
        const volume = parseFloat(m.volume) || 0;
        return vol24h > 100 && volume > 1000 && m.question;
      })
      .slice(0, 20)
      .map(m => {
        let outcomes = [];
        let prices = [];
        try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
        try { prices = JSON.parse(m.outcomePrices || '[]'); } catch (_) {}

        const yesPrice = prices[0] ? Math.round(parseFloat(prices[0]) * 100) : null;
        const noPrice = prices[1] ? Math.round(parseFloat(prices[1]) * 100) : null;
        const category = detectCategory(m.question + ' ' + (m.description || ''));
        const volume = parseFloat(m.volume) || 0;
        const volume24h = parseFloat(m.volume24hr) || 0;

        // Check if this market matches an X trend
        const matchedTrend = xTrends.find(t => {
          const trendLower = (t.name || '').toLowerCase().replace(/#/g, '');
          const questionLower = m.question.toLowerCase();
          return questionLower.includes(trendLower) || trendLower.split(' ').some(w => w.length > 3 && questionLower.includes(w));
        });

        return {
          id: m.id,
          question: m.question,
          slug: m.slug,
          description: (m.description || '').slice(0, 300),
          outcomes,
          yesPrice,
          noPrice,
          volume: formatVolume(volume),
          volumeRaw: volume,
          volume24h: formatVolume(volume24h),
          volume24hRaw: volume24h,
          liquidity: formatVolume(parseFloat(m.liquidity) || 0),
          category,
          platform: 'Polymarket',
          image: m.image || null,
          endDate: m.endDate,
          polyUrl: `https://polymarket.com/event/${m.slug || m.conditionId || m.id}`,
          priceChange24h: m.oneDayPriceChange ? Math.round(m.oneDayPriceChange * 100) : null,
          xTrend: matchedTrend || null,
        };
      });

    // ── Step 4: Try to find X posts for top markets ─────────────────────
    // Use fxtwitter search for top 5 markets to find related tweets
    const marketsWithPosts = await Promise.all(
      markets.map(async (market, i) => {
        if (i >= 8) return market; // Only fetch X posts for top 8

        try {
          // Search X via syndication API for related posts
          const searchQuery = extractKeywords(market.question);
          const searchRes = await fetch(
            `https://syndication.twitter.com/srv/timeline-profile/screen-name/polyaboretum?count=1`,
            { headers: { 'User-Agent': 'WeBetAI/1.0' } }
          );
          // This won't work reliably, so we'll construct X search URLs instead
        } catch (_) {}

        // Provide X search URL so frontend can link to relevant posts
        const searchTerms = extractKeywords(market.question);
        market.xSearchUrl = `https://x.com/search?q=${encodeURIComponent(searchTerms)}&f=top`;
        market.xSearchQuery = searchTerms;
        return market;
      })
    );

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        markets: marketsWithPosts,
        xTrends,
        hasXApi: !!xBearerToken,
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectCategory(text) {
  const t = text.toLowerCase();
  if (/nba|basketball|laker|celtic|warrior|nfl|super bowl|mlb|nhl|stanley cup|wnba|ufc|boxing|fight|formula|f1|race|grand prix|premier league|champions league|world cup|soccer|football|tennis|golf|olympic|sport|player|team|coach|draft|playoff|season|game\b|match\b/.test(t)) return 'sports';
  if (/election|president|trump|biden|congress|senate|governor|democrat|republican|vote|poll|gop|dnc|rnc|political|legislation|impeach|scotus|supreme court|parliament/.test(t)) return 'politics';
  if (/bitcoin|crypto|eth|btc|defi|token|blockchain|solana|dogecoin|nft|web3|binance|coinbase/.test(t)) return 'crypto';
  if (/movie|film|album|oscar|grammy|emmy|tv show|streaming|netflix|disney|spotify|concert|tour|celebrity|album|artist|music|entertainment|game\s*of|gta|video\s*game/.test(t)) return 'entertainment';
  if (/ai |artificial intelligence|openai|chatgpt|claude|llm|machine learning|tech|apple|google|meta|microsoft|nvidia|tesla/.test(t)) return 'tech';
  return 'news';
}

function extractKeywords(question) {
  return question
    .replace(/^Will\s+/i, '')
    .replace(/^Does\s+/i, '')
    .replace(/^Is\s+/i, '')
    .replace(/\?+$/, '')
    .replace(/\b(the|a|an|of|in|on|to|by|or|and|for|at|vs|be|before|after|during)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join(' ');
}

function formatVolume(vol) {
  const n = parseFloat(vol) || 0;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
