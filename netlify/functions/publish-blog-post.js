/**
 * publish-blog-post.js — Write a blog article to betty/blog via Netlify Blobs
 *
 * POST /api/publish-blog-post
 * Body: { slug, title, tag, articleBodyHtml, excerpt, description, date, image, betUrl, webetString }
 *
 * Uses the green/white template matching /betty/blog/solving-liquidity.
 * Articles are served via get-blog-post.js at /betty/blog/{slug}.
 * Author is always "Betty - WeBetAI".
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SITE_URL = 'https://webetsocial.com';

// ── Content-specific image picker (shared logic with get-blog-post.js and listing page) ──
// Each keyword pattern gets a UNIQUE, topic-relevant Unsplash photo
const TOPIC_IMAGES = {
  supremeCourt:  'photo-1658958327132-a80f8a9409fb',   // Supreme Court building
  senate:        'photo-1738162345095-2ee323a4baec',   // US Capitol dome
  election:      'photo-1540910419892-4a36d2c3266c',   // person casting vote
  tariff:        'photo-1742576437150-3a79cae681f2',   // cargo ship containers
  politics:      'photo-1676312210846-104b89aafd81',   // gavel on American flag
  abortion:      'photo-1761001826423-7231bfe1ee37',   // crowd holding signs
  transgender:   'photo-1743193189315-afcfa03ad540',   // Olympic rings
  basketball:    'photo-1546519638-68e109498ffc',
  hockey:        'photo-1515703407324-5f753afd8be8',
  golf:          'photo-1535131749006-b7f58c99034b',
  baseball:      'photo-1529074963764-98f45c47344b',
  soccer:        'photo-1529074963764-98f45c47344b',
  crypto:        'photo-1639762681485-074b7f938ba0',
  finance:       'photo-1590283603385-17ffb3a7f29f',
  markets:       'photo-1611974789855-9c2a0a7236a3',
  tech:          'photo-1633265486064-086b219458ec',
  gambling:      'photo-1605792657660-596af9009e82',
  analytics:     'photo-1460925895917-afdab827c52f',
  liquidity:     'photo-1611974789855-9c2a0a7236a3',
  guardian:      'photo-1633265486064-086b219458ec',
};

function pickCategoryImage(tag, title, bodyHtml) {
  const text = `${tag} ${title} ${(bodyHtml || '').slice(0, 3000)}`.toLowerCase();
  let id = null;

  // Specific topics first (most unique)
  if (/supreme.?court|scotus|judicial review/.test(text)) id = TOPIC_IMAGES.supremeCourt;
  else if (/senate|congress|capitol|legislat/.test(text)) id = TOPIC_IMAGES.senate;
  else if (/tariff|trade war|import|export|cargo|shipping/.test(text)) id = TOPIC_IMAGES.tariff;
  else if (/abortion|roe|reproductive|pro-life|pro-choice/.test(text)) id = TOPIC_IMAGES.abortion;
  else if (/transgender|ioc|olympic|gender/.test(text)) id = TOPIC_IMAGES.transgender;
  else if (/election|midterm|ballot|vote|voter/.test(text)) id = TOPIC_IMAGES.election;
  else if (/immunity|ruling|judge|legal|justice|gavel/.test(text)) id = TOPIC_IMAGES.politics;
  else if (/politic|democrat|republican|trump|biden/.test(text)) id = TOPIC_IMAGES.politics;
  else if (/basketball|nba|warriors|lakers|celtics|play-in/.test(text)) id = TOPIC_IMAGES.basketball;
  else if (/hockey|nhl|stanley|avalanche|sabres/.test(text)) id = TOPIC_IMAGES.hockey;
  else if (/golf|masters|augusta|scheffler|pga/.test(text)) id = TOPIC_IMAGES.golf;
  else if (/baseball|mlb|pitcher/.test(text)) id = TOPIC_IMAGES.baseball;
  else if (/soccer|mls|premier|epl|champions/.test(text)) id = TOPIC_IMAGES.soccer;
  else if (/crypto|bitcoin|ethereum|blockchain/.test(text)) id = TOPIC_IMAGES.crypto;
  else if (/inflation|economy|dollar|finance|money|gdp|fed\b|interest rate|prices/.test(text)) id = TOPIC_IMAGES.finance;
  else if (/market|stock|trading|polymarket|kalshi|prediction/.test(text)) id = TOPIC_IMAGES.markets;
  else if (/tech|ai\b|cyber|security|software/.test(text)) id = TOPIC_IMAGES.tech;
  else if (/liquidity|exchange/.test(text)) id = TOPIC_IMAGES.liquidity;
  else if (/guardian|fact.check|authenticity/.test(text)) id = TOPIC_IMAGES.guardian;
  else if (/gambl|casino|bet|wager|odds/.test(text)) id = TOPIC_IMAGES.gambling;
  else if (/data|model|analytics|stat/.test(text)) id = TOPIC_IMAGES.analytics;
  else {
    const keys = Object.values(TOPIC_IMAGES);
    let hash = 0;
    for (let i = 0; i < title.length; i++) hash = ((hash << 5) - hash) + title.charCodeAt(i);
    id = keys[Math.abs(hash) % keys.length];
  }

  // Some IDs already have 'photo-' prefix from old pool
  const photoId = id.startsWith('photo-') ? id : id;
  return `https://images.unsplash.com/${photoId}?w=1200&h=630&fit=crop&q=80`;
}

function generateArticlePage({ title, description, slug, tag, date, image, articleBodyHtml, betUrl, webetString }) {
  const readTime = Math.max(3, Math.ceil((articleBodyHtml || '').split(/\s+/).length / 200));
  const safeTitle = (title || '').replace(/"/g, '&quot;');
  const safeDesc = (description || '').replace(/"/g, '&quot;');
  const ogImage = image || `${SITE_URL}/og-image.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} | WeBetAI</title>
  <meta name="description" content="${safeDesc}" />

  <meta property="og:type" content="article" />
  <meta property="og:url" content="${SITE_URL}/betty/blog/${slug}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="WeBetAI" />
  <meta property="article:author" content="Betty - WeBetAI" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${ogImage}" />
  <meta name="twitter:site" content="@WeBetSocialAI" />

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5.0.1/400.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5.0.1/500.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5.0.1/600.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5.0.1/700.css" />

  <style>
    :root {
      --white: #ffffff;
      --off-white: #f8f9fa;
      --bg: #f2f3f5;
      --olive: #1a2e1a;
      --teal: #004C54;
      --teal-light: #e6f4f1;
      --teal-border: #b8ddd6;
      --green: #2e7d32;
      --green-light: #e8f5e9;
      --green-border: #a5d6a7;
      --border-lt: #e0e3e8;
      --txt-b: #1a2e1a;
      --txt-m: #5f6b7a;
      --txt-l: #8b95a3;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Geist Sans', 'Inter', system-ui, sans-serif;
      background: var(--bg); color: var(--txt-b);
      -webkit-font-smoothing: antialiased; min-height: 100vh;
    }
    a { text-decoration: none; color: inherit; }

    .header {
      background: var(--white); border-bottom: 1px solid var(--border-lt);
      padding: .875rem 1.25rem; display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 100;
    }
    .logo { display: flex; align-items: center; gap: .5rem; text-decoration: none; color: var(--olive); }
    .logo-text { font-size: 1rem; font-weight: 700; }
    .header-nav { display: flex; gap: .5rem; align-items: center; flex-wrap: nowrap; overflow-x: auto; }
    .header-link {
      font-size: .625rem; font-weight: 600; color: var(--teal);
      background: var(--teal-light); border: 1px solid var(--teal-border);
      border-radius: 9999px; padding: .2rem .5rem; text-decoration: none;
      white-space: nowrap; flex-shrink: 0;
    }
    .header-link:hover { background: var(--teal-border); }
    .header-link.active { background: var(--teal); color: var(--white); border-color: var(--teal); font-weight: 700; }
    .mobile-menu-btn { display: none; background: none; border: none; cursor: pointer; padding: 4px; }
    .mobile-dropdown {
      display: none; position: absolute; top: 100%; right: 0;
      background: var(--white); border: 1px solid var(--border-lt); border-top: none;
      border-radius: 0 0 .75rem .75rem; box-shadow: 0 8px 24px rgba(0,0,0,0.1);
      padding: .5rem; z-index: 101; min-width: 160px;
    }
    .mobile-dropdown.open { display: flex; flex-direction: column; gap: .25rem; }
    .mobile-dropdown a { font-size: .8125rem; font-weight: 600; color: var(--teal); padding: .5rem .75rem; text-decoration: none; border-radius: .5rem; }
    .mobile-dropdown a:hover { background: var(--teal-light); }
    @media (max-width: 640px) { .header-nav { display: none; } .mobile-menu-btn { display: block; } }

    .article-header {
      background: var(--white); border-bottom: 1px solid var(--border-lt); padding: 40px 24px 36px;
    }
    .article-header-inner { max-width: 720px; margin: 0 auto; }
    .article-breadcrumb {
      display: flex; align-items: center; gap: 8px;
      font-size: 0.75rem; color: var(--txt-l); margin-bottom: 24px;
    }
    .article-breadcrumb a { color: var(--teal); transition: opacity 0.15s; }
    .article-breadcrumb a:hover { opacity: 0.7; }
    .article-tag {
      display: inline-block; padding: 3px 10px; border-radius: 99px;
      background: var(--teal-light); border: 1px solid var(--teal-border);
      color: var(--teal); font-size: 0.625rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 16px;
    }
    .article-header h1 {
      font-size: clamp(1.75rem, 4vw, 2.25rem); font-weight: 700;
      letter-spacing: -0.03em; line-height: 1.15; color: var(--olive); margin-bottom: 16px;
    }
    .article-meta-row {
      display: flex; align-items: center; gap: 12px; font-size: 0.75rem; color: var(--txt-m);
    }
    .betty-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: linear-gradient(135deg, var(--teal) 0%, var(--green) 100%);
      display: flex; align-items: center; justify-content: center;
      font-size: 0.6875rem; font-weight: 700; color: var(--white); flex-shrink: 0;
    }

    .article-body {
      max-width: 720px; margin: 0 auto; padding: 40px 24px 64px;
    }
    .article-body p {
      font-size: 1rem; color: var(--txt-b); opacity: 0.85; line-height: 1.75; margin-bottom: 20px;
    }
    .article-body h2 {
      font-size: 1.375rem; font-weight: 700; letter-spacing: -0.02em;
      line-height: 1.2; color: var(--olive); margin: 40px 0 14px;
    }
    .article-body h3 {
      font-size: 1.0625rem; font-weight: 700; color: var(--olive); margin: 28px 0 10px;
    }
    .article-body ul, .article-body ol {
      margin: 0 0 20px 20px; font-size: 0.9375rem; color: var(--txt-b); opacity: 0.85; line-height: 1.75;
    }
    .article-body li { margin-bottom: 6px; }
    .article-body strong { color: var(--olive); font-weight: 700; }
    .article-body em { color: var(--teal); font-style: normal; }

    .callout {
      background: var(--white); border: 1px solid var(--border-lt);
      border-left: 3px solid var(--teal); border-radius: .75rem;
      padding: 20px 24px; margin: 28px 0;
    }
    .callout p { margin-bottom: 0; font-size: 0.9375rem; }
    .callout-label {
      font-size: 0.6875rem; font-weight: 700; color: var(--teal);
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
    }
    .callout.webet-challenge { border-right: 3px solid var(--teal); }

    .article-divider { height: 1px; background: var(--border-lt); margin: 40px 0; }

    .back-to-blog {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 0.8125rem; font-weight: 600; color: var(--teal);
      padding: 8px 18px; border-radius: 99px;
      border: 1px solid var(--teal-border); background: var(--teal-light);
      transition: background 0.15s, border-color 0.15s; margin-top: 12px;
    }
    .back-to-blog:hover { background: var(--teal-border); }

    footer {
      background: var(--white); padding: 32px 24px; border-top: 1px solid var(--border-lt);
    }
    .footer-inner {
      max-width: 960px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      gap: 24px; flex-wrap: wrap;
    }
    .footer-left { display: flex; flex-direction: column; gap: 8px; }
    .footer-logo { display: flex; align-items: center; gap: 8px; }
    .footer-logo-text { font-size: 1rem; font-weight: 700; color: var(--olive); }
    .footer-copy { font-size: 0.75rem; color: var(--txt-l); }
    .footer-links { display: flex; gap: 24px; list-style: none; flex-wrap: wrap; }
    .footer-link { font-size: 0.75rem; color: var(--txt-m); text-decoration: none; transition: color 0.15s; }
    .footer-link:hover { color: var(--teal); }

    .fi { opacity: 0; transform: translateY(14px); transition: opacity 0.6s ease, transform 0.6s ease; }
    .fi.v { opacity: 1; transform: translateY(0); }

    @media (max-width: 768px) {
      .article-header { padding: 32px 20px 28px; }
      .article-body { padding: 28px 20px 48px; }
      .footer-inner { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>

<header class="header">
  <a href="/" class="logo">
    <svg viewBox="0 0 470 419" fill="none" style="width:32px; height:28px; flex-shrink:0;" xmlns="http://www.w3.org/2000/svg">
      <path d="M468.052 41.8933C475.338 21.4744 460.199 0 438.52 0H258.273C244.592 0 232.491 8.86935 228.372 21.915L224.279 34.8759C248.801 41.3632 269.435 57.9169 281.086 80.4478L294.349 106.096C294.585 106.553 294.786 106.963 294.999 107.431C298.607 115.353 334.405 193.978 357.551 245.403C365.813 263.759 378.664 292.426 378.664 292.426L468.052 41.8933Z" fill="#004C54"/>
      <path d="M2.5744 90.1347C-6.41714 56.7413 22.8839 25.563 56.7707 32.4661L209.173 63.5124C228.73 67.4964 245.223 80.5515 253.59 98.6714L370.845 352.594C385.077 383.414 362.565 418.605 328.618 418.605H139.079C110.723 418.605 85.8955 399.578 78.523 372.198L2.5744 90.1347Z" fill="#004C54"/>
    </svg>
    <span class="logo-text">WeBetAI</span>
  </a>
  <nav class="header-nav">
    <a href="/betty/blog" class="header-link active">Authentic Press</a>
    <a href="/guardian" class="header-link">Guardian</a>
    <a href="/edge" class="header-link">Edge Picks</a>
  </nav>
  <button class="mobile-menu-btn" onclick="document.getElementById('mobileDropdown').classList.toggle('open')" aria-label="Menu">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#004C54" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <div class="mobile-dropdown" id="mobileDropdown">
    <a href="/betty/blog">Authentic Press</a>
    <a href="/guardian">Guardian</a>
    <a href="/edge">Edge Picks</a>
  </div>
</header>

<div class="article-header">
  <div class="article-header-inner">
    <div class="article-breadcrumb">
      <a href="/betty/blog">Authentic Press</a>
      <span>/</span>
      <span>${tag || 'Analysis'}</span>
    </div>
    <span class="article-tag">${tag || 'Analysis'}</span>
    <h1>${title}</h1>
    <div class="article-meta-row">
      <div class="betty-avatar">B</div>
      <span>Betty - WeBetAI &middot; ${date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} &middot; ${readTime} min read</span>
    </div>
  </div>
</div>

<article class="article-body">
  ${webetString && betUrl ? `<div class="callout webet-challenge">
    <div class="callout-label">WeBet Challenge</div>
    <p><strong>${webetString}</strong></p>
    <p style="margin-top:8px"><a href="${betUrl}" style="color:var(--teal);font-weight:600;">Take This Bet &rarr;</a></p>
  </div>` : ''}

  ${articleBodyHtml}

  <div class="article-divider"></div>

  <a href="/betty/blog" class="back-to-blog">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
    Back to Authentic Press
  </a>
</article>

<footer>
  <div class="footer-inner">
    <div class="footer-left">
      <div class="footer-logo">
        <svg viewBox="0 0 470 419" fill="none" style="width:20px; height:18px; flex-shrink:0;" xmlns="http://www.w3.org/2000/svg">
          <path d="M468.052 41.8933C475.338 21.4744 460.199 0 438.52 0H258.273C244.592 0 232.491 8.86935 228.372 21.915L224.279 34.8759C248.801 41.3632 269.435 57.9169 281.086 80.4478L294.349 106.096C294.585 106.553 294.786 106.963 294.999 107.431C298.607 115.353 334.405 193.978 357.551 245.403C365.813 263.759 378.664 292.426 378.664 292.426L468.052 41.8933Z" fill="#004C54"/>
          <path d="M2.5744 90.1347C-6.41714 56.7413 22.8839 25.563 56.7707 32.4661L209.173 63.5124C228.73 67.4964 245.223 80.5515 253.59 98.6714L370.845 352.594C385.077 383.414 362.565 418.605 328.618 418.605H139.079C110.723 418.605 85.8955 399.578 78.523 372.198L2.5744 90.1347Z" fill="#004C54"/>
        </svg>
        <span class="footer-logo-text">WeBetAI</span>
      </div>
      <span class="footer-copy">&copy; 2026 WeBetSocialAI. All rights reserved.</span>
    </div>
    <ul class="footer-links">
      <li><a href="https://x.com/WeBetSocialAI" target="_blank" rel="noopener noreferrer" class="footer-link">@WeBetSocialAI on X</a></li>
      <li><a href="/" class="footer-link">Home</a></li>
      <li><a href="/betty/blog" class="footer-link">Authentic Press</a></li>
    </ul>
  </div>
</footer>

<script>
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(en) {
        if (en.isIntersecting) { en.target.classList.add('v'); obs.unobserve(en.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });
    document.querySelectorAll('.fi').forEach(function(el) { obs.observe(el); });
  } else {
    document.querySelectorAll('.fi').forEach(function(el) { el.classList.add('v'); });
  }
</script>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { slug, title, tag, articleBodyHtml, excerpt, description, date, betUrl, webetString } = body;
    // Support legacy "html" field for backwards compat
    const bodyHtml = articleBodyHtml || body.html || '';

    // Image: use explicit image field, extract from HTML, or pick category-appropriate stock photo
    let image = body.image || '';
    if (!image) {
      const imgMatch = bodyHtml.match(/<img[^>]+src=["']([^"']+)["']/i) ||
                        bodyHtml.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
      if (imgMatch) image = imgMatch[1];
    }
    if (!image) {
      image = pickCategoryImage(tag || 'Analysis', title || '', bodyHtml);
    }

    if (!slug || !title || !bodyHtml) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'slug, title, and articleBodyHtml are required' }) };
    }

    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 80);
    const fullPage = generateArticlePage({
      title, description: description || excerpt || '', slug: safeSlug,
      tag: tag || 'Analysis', date, image, articleBodyHtml: bodyHtml, betUrl, webetString,
    });

    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const blobToken = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-blog-posts', siteID, token: blobToken });

    await store.set(`article-${safeSlug}`, fullPage, {
      metadata: { title, slug: safeSlug, tag, image: image || '', excerpt: (excerpt || '').slice(0, 200), createdAt: new Date().toISOString() },
    });

    // Update blog index
    let index = [];
    try { index = (await store.get('article-index', { type: 'json' })) || []; } catch (_) {}
    index = index.filter(a => a.slug !== safeSlug);
    index.unshift({
      slug: safeSlug, title, tag, image: image || '', excerpt: (excerpt || '').slice(0, 200),
      createdAt: new Date().toISOString(), url: `${SITE_URL}/betty/blog/${safeSlug}`,
    });
    index = index.slice(0, 100);
    await store.setJSON('article-index', index);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ success: true, url: `${SITE_URL}/betty/blog/${safeSlug}`, slug: safeSlug }),
    };
  } catch (err) {
    console.error('[publish-blog-post] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
