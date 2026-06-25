/**
 * serve-bet.js — Serve bet page with dynamic OG meta tags
 *
 * GET /bet/:id
 *
 * Reads the bet data from blobs, injects dynamic OG tags into the
 * static bet page HTML so social media crawlers see the bet title,
 * description, and preview image.
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://webetsocial.com';

exports.handler = async (event) => {
  // Extract the bet ID from the ORIGINAL /bet/:id path. netlify.toml rewrites
  // /bet/* -> this function, and depending on the Netlify runtime the original
  // path can live in event.path, event.rawUrl, or a Netlify forwarding header —
  // so scan every candidate for the /bet/<id> pattern rather than trusting one.
  const h = event.headers || {};
  const candidates = [
    event.rawUrl,
    event.path,
    h['x-nf-original-path'], h['x-original-path'], h['x-forwarded-url'],
    h['x-nf-request-url'], h['x-rewrite-url'], h['x-original-url'],
  ];
  let betId = '';
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(/\/bet\/([a-zA-Z0-9]{3,})/);
    if (m) { betId = m[1]; break; }
  }
  // Splat may also arrive as ?id= (if the redirect is ever changed to pass it).
  if (!betId && event.queryStringParameters && event.queryStringParameters.id) {
    betId = String(event.queryStringParameters.id).replace(/[^a-zA-Z0-9]/g, '');
  }

  if (!betId || betId === 'index.html' || betId.includes('.')) {
    // Self-diagnostic: surface exactly what the runtime handed us so a missing
    // bet ID is debuggable in one shot instead of a blank "Bet ID required".
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'bet_id_required',
        _diag: { path: event.path || null, rawUrl: event.rawUrl || null, headerKeys: Object.keys(h) },
      }),
    };
  }

  try {
    // Read bet data
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-bets', siteID, token });
    const bet = await store.get(`bet-${betId}`, { type: 'json' });

    // Read the static bet page HTML
    let html;
    try {
      html = fs.readFileSync(path.join(__dirname, '..', '..', 'bet', 'index.html'), 'utf8');
    } catch (e) {
      // Fallback: try to fetch from CDN
      const res = await fetch(`${SITE_URL}/bet/index.html`);
      html = await res.text();
    }

    if (bet) {
      const title = `WeBetAI — ${bet.title || 'Place Your Bet'}`;
      const desc = bet.betString || `$${bet.amount || 1} bet: ${bet.title || 'Pick a side'}`;
      const ogImage = `${SITE_URL}/api/bet-image?id=${betId}`;

      // Replace static OG tags with dynamic ones
      html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
        .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escAttr(desc)}" />`)
        .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escAttr(title)}" />`)
        .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escAttr(desc)}" />`)
        .replace(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${ogImage}" />`)
        .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${SITE_URL}/bet/${betId}" />`)
        .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escAttr(title)}" />`)
        .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escAttr(desc)}" />`)
        .replace(/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="${ogImage}" />`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
      body: html,
    };
  } catch (err) {
    console.error('[serve-bet] Error:', err.message);
    // Fallback: redirect to static page
    return {
      statusCode: 302,
      headers: { Location: `/bet/index.html#${betId}` },
      body: '',
    };
  }
};

function escHtml(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
