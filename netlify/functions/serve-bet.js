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

  // 1) Load the bet page HTML (essential — the client reads the bet id from the
  //    /bet/:id path and fetches /api/get-bet itself). readFileSync works only
  //    when the file is bundled with the function; the CDN fallback must hit
  //    "/bet" (the exact /bet rule serves /bet/index.html) and NEVER
  //    "/bet/index.html", which matches the /bet/* rewrite and recurses back
  //    into this function (server-side fetch loop → timeout → 502).
  let html = '';
  try { html = fs.readFileSync(path.join(__dirname, '..', '..', 'bet', 'index.html'), 'utf8'); } catch (_) {}
  if (!html || !/<html/i.test(html)) {
    try { html = await (await fetch(`${SITE_URL}/bet`)).text(); } catch (_) { html = ''; }
  }
  if (!html || !/<html/i.test(html)) {
    // Couldn't get the page — bounce to the static /bet route (no blank 502).
    return { statusCode: 302, headers: { Location: '/bet' }, body: '' };
  }

  // 2) Best-effort dynamic OG tags from the bet record. Never fatal — if blobs
  //    are unavailable the static page (and its client-side fetch) still works.
  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-bets', siteID, token });
    const bet = await store.get(`bet-${betId}`, { type: 'json' }).catch(() => null);
    if (bet) {
      const title = `WeBetAI — ${bet.title || 'Place Your Bet'}`;
      const desc = bet.betString || `$${bet.amount || 1} bet: ${bet.title || 'Pick a side'}`;
      const ogImage = `${SITE_URL}/api/bet-image?id=${betId}`;
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
  } catch (_) { /* OG enhancement is optional — the static page already works */ }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    body: html,
  };
};

function escHtml(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
