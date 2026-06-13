/**
 * get-blog-post.js — Serve blog articles stored in Netlify Blobs
 *
 * GET /api/get-blog-post?slug=topic-name
 *
 * Returns the full HTML page for articles published via publish-blog-post.js.
 * Static articles in betty/blog/ are served directly by Netlify CDN.
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  // Try query param first, then parse from path
  let slug = (event.queryStringParameters || {}).slug;
  if (!slug) {
    // Extract from path: /betty/blog/save-america-act-midterms or /.netlify/functions/get-blog-post/save-america-act-midterms
    const path = event.path || '';
    const match = path.match(/\/betty\/blog\/([^/]+)/) || path.match(/\/get-blog-post\/([^/]+)/) || path.match(/[?&]slug=([^&]+)/);
    slug = match ? match[1] : null;
  }
  // Also try the splat from redirect
  if (!slug && event.queryStringParameters) {
    slug = event.queryStringParameters.splat || event.queryStringParameters[':splat'];
  }
  if (!slug) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/plain' }, body: 'slug parameter required. Path: ' + (event.path || 'none') + ' QS: ' + JSON.stringify(event.queryStringParameters || {}) };
  }

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 80);

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const blobToken = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-blog-posts', siteID, token: blobToken });
    const html = await store.get(`article-${safeSlug}`);

    if (!html) {
      return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>Article not found</h1>' };
    }

    // Strip fade-in class from article content so it shows immediately
    let fixedHtml = html
      .replace(/class="article-header fi"/g, 'class="article-header"')
      .replace(/class="article-body fi"/g, 'class="article-body"');

    // Fix OG image: if still using generic og-image.png, find an article-specific image
    if (fixedHtml.includes('og-image.png')) {
      let articleImg = null;

      // 1. Try extracting from article body HTML
      const imgMatch = fixedHtml.match(/<img[^>]+src=["']([^"']+)["']/i) ||
                       fixedHtml.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
      if (imgMatch && imgMatch[1]) articleImg = imgMatch[1];

      // 2. Try the blog index for this slug's image
      if (!articleImg) {
        try {
          const index = await store.get('article-index', { type: 'json' });
          if (index) {
            const entry = index.find(a => a.slug === safeSlug);
            if (entry && entry.image) articleImg = entry.image;
          }
        } catch (_) {}
      }

      // 3. Pick content-specific image (same logic as publish-blog-post.js)
      if (!articleImg) {
        const T = {
          supremeCourt: 'photo-1658958327132-a80f8a9409fb', senate: 'photo-1738162345095-2ee323a4baec', election: 'photo-1540910419892-4a36d2c3266c',
          tariff: 'photo-1742576437150-3a79cae681f2', politics: 'photo-1676312210846-104b89aafd81', abortion: 'photo-1761001826423-7231bfe1ee37',
          transgender: 'photo-1743193189315-afcfa03ad540', basketball: 'photo-1546519638-68e109498ffc',
          hockey: 'photo-1515703407324-5f753afd8be8', golf: 'photo-1535131749006-b7f58c99034b',
          baseball: 'photo-1529074963764-98f45c47344b', soccer: 'photo-1529074963764-98f45c47344b',
          crypto: 'photo-1639762681485-074b7f938ba0', finance: 'photo-1590283603385-17ffb3a7f29f',
          markets: 'photo-1611974789855-9c2a0a7236a3', tech: 'photo-1633265486064-086b219458ec',
          gambling: 'photo-1605792657660-596af9009e82', analytics: 'photo-1460925895917-afdab827c52f',
        };
        const text = fixedHtml.toLowerCase().slice(0, 5000);
        let id = null;
        if (/supreme.?court|scotus|judicial review/.test(text)) id = T.supremeCourt;
        else if (/senate|congress|capitol|legislat/.test(text)) id = T.senate;
        else if (/tariff|trade war|import|export|cargo|shipping/.test(text)) id = T.tariff;
        else if (/abortion|roe|reproductive|pro-life|pro-choice/.test(text)) id = T.abortion;
        else if (/transgender|ioc|olympic|gender/.test(text)) id = T.transgender;
        else if (/election|midterm|ballot|vote|voter/.test(text)) id = T.election;
        else if (/immunity|ruling|judge|legal|justice|gavel/.test(text)) id = T.politics;
        else if (/politic|democrat|republican|trump|biden/.test(text)) id = T.politics;
        else if (/basketball|nba|warriors|lakers|celtics|play-in/.test(text)) id = T.basketball;
        else if (/hockey|nhl|stanley|avalanche|sabres/.test(text)) id = T.hockey;
        else if (/golf|masters|augusta|scheffler|pga/.test(text)) id = T.golf;
        else if (/baseball|mlb|pitcher/.test(text)) id = T.baseball;
        else if (/soccer|mls|premier|epl|champions/.test(text)) id = T.soccer;
        else if (/crypto|bitcoin|ethereum|blockchain/.test(text)) id = T.crypto;
        else if (/inflation|economy|dollar|finance|money|gdp|fed\b|interest rate|prices/.test(text)) id = T.finance;
        else if (/market|stock|trading|polymarket|kalshi|prediction/.test(text)) id = T.markets;
        else if (/tech|ai\b|cyber|security|software/.test(text)) id = T.tech;
        else if (/gambl|casino|bet|wager|odds/.test(text)) id = T.gambling;
        else if (/data|model|analytics|stat/.test(text)) id = T.analytics;
        else {
          const keys = Object.values(T);
          let hash = 0;
          for (let i = 0; i < safeSlug.length; i++) hash = ((hash << 5) - hash) + safeSlug.charCodeAt(i);
          id = keys[Math.abs(hash) % keys.length];
        }
        articleImg = `https://images.unsplash.com/${id}?w=1200&h=630&fit=crop&q=80`;
      }

      if (articleImg) {
        fixedHtml = fixedHtml.replace(/https:\/\/webetsocial\.com\/og-image\.png/g, articleImg);
      }

      // Fix title format: put article title first
      const titleMatch = fixedHtml.match(/<title>WeBetAI - Social Intelligence \| ([^<]+)<\/title>/);
      if (titleMatch) {
        fixedHtml = fixedHtml.replace(titleMatch[0], `<title>${titleMatch[1]} | WeBetAI</title>`);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
      body: fixedHtml,
    };
  } catch (e) {
    console.error('[get-blog-post] Error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Error loading article' };
  }
};
