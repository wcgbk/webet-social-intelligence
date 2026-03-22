// Local dev server for WeBetAI — serves static files + proxies Polymarket API
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const PORT = parseInt(process.env.PORT, 10) || 9990;

const MIME = {
  html: 'text/html', css: 'text/css', js: 'application/javascript',
  png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', mp4: 'video/mp4', json: 'application/json',
  ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WeBetAI/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function detectCategory(text) {
  const t = text.toLowerCase();
  if (/nba|basketball|laker|celtic|warrior|nfl|super bowl|mlb|nhl|stanley cup|wnba|ufc|boxing|fight|formula|f1|premier league|champions league|world cup|soccer|football|tennis|golf|olympic|sport|player|team|coach|draft|playoff|season|game\b|match\b/.test(t)) return 'sports';
  if (/election|president|trump|biden|congress|senate|governor|democrat|republican|vote|poll|gop|dnc|rnc|political|legislation|impeach|scotus|supreme court/.test(t)) return 'politics';
  if (/bitcoin|crypto|eth|btc|defi|token|blockchain|solana|dogecoin|nft|web3|binance|coinbase/.test(t)) return 'crypto';
  if (/movie|film|album|oscar|grammy|emmy|tv show|streaming|netflix|disney|spotify|concert|tour|celebrity|music|entertainment|gta|video\s*game/.test(t)) return 'entertainment';
  if (/ai |artificial intelligence|openai|chatgpt|claude|llm|machine learning|tech|apple|google|meta|microsoft|nvidia|tesla/.test(t)) return 'tech';
  return 'news';
}

function formatVolume(vol) {
  const n = parseFloat(vol) || 0;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function extractKeywords(question) {
  return question
    .replace(/^Will\s+/i, '').replace(/^Does\s+/i, '').replace(/^Is\s+/i, '')
    .replace(/\?+$/, '')
    .replace(/\b(the|a|an|of|in|on|to|by|or|and|for|at|vs|be|before|after|during)\b/gi, '')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
}

http.createServer(async (req, res) => {
  let url = req.url.split('?')[0];

  // ── API: /api/markets — proxy & format Polymarket data ──
  if (url === '/api/markets') {
    try {
      const raw = await httpsGet('https://gamma-api.polymarket.com/markets?limit=30&active=true&closed=false&order=volume24hr&ascending=false');
      const polyMarkets = JSON.parse(raw);

      const markets = polyMarkets
        .filter(m => {
          const vol24h = parseFloat(m.volume24hr) || 0;
          const volume = parseFloat(m.volume) || 0;
          return vol24h > 100 && volume > 1000 && m.question;
        })
        .slice(0, 20)
        .map(m => {
          let outcomes = [], prices = [];
          try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
          try { prices = JSON.parse(m.outcomePrices || '[]'); } catch (_) {}

          const yesPrice = prices[0] ? Math.round(parseFloat(prices[0]) * 100) : null;
          const noPrice = prices[1] ? Math.round(parseFloat(prices[1]) * 100) : null;
          const category = detectCategory(m.question + ' ' + (m.description || ''));
          const volume = parseFloat(m.volume) || 0;
          const volume24h = parseFloat(m.volume24hr) || 0;
          const searchTerms = extractKeywords(m.question);

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
            xTrend: null,
            xSearchUrl: `https://x.com/search?q=${encodeURIComponent(searchTerms)}&f=top`,
            xSearchQuery: searchTerms,
          };
        });

      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ markets, xTrends: [], hasXApi: false, fetchedAt: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Static file serving ──
  if (url.endsWith('/')) url += 'index.html';
  let fp = path.join(BASE, url);

  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) fp = path.join(fp, 'index.html');
  } catch (_) {}

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp).slice(1);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`WeBetAI dev server: http://localhost:${PORT}`));
