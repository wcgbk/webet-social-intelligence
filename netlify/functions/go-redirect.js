/**
 * go-redirect.js — Branded short links that auto-stamp UTMs.
 *
 *   /go/{source}/{campaign}/{content}
 *   /go/{source}/{campaign}/{content}/{path...}
 *   /go/{source}/{campaign}/{content}/{path...}?card=bettyv13&view=picks
 *   /go/{source}/{campaign}/{content}?to=/dashboard?card=bettyv13
 *
 * Examples:
 *   /go/x/betty_sep10/post_a
 *     → https://webetsocial.com/?utm_source=x&utm_medium=social&utm_campaign=betty_sep10&utm_content=post_a
 *   /go/x/cfb_week1/post_b/omega
 *     → https://webetsocial.com/omega?utm_source=x&utm_medium=social&utm_campaign=cfb_week1&utm_content=post_b
 *   /go/x/betty_sep11/alpha_main/dashboard?card=bettyv13
 *     → https://webetsocial.com/dashboard?card=bettyv13&utm_source=x&utm_medium=social&utm_campaign=betty_sep11&utm_content=alpha_main
 *
 * Medium defaults: email|sms → themselves; else social.
 * Only same-site relative destinations allowed (no open redirects).
 * Non-reserved query params on the /go/ URL are forwarded to the destination
 * (so ?card= / ?view= deep links survive).
 */
const SITE = 'https://webetsocial.com';
const SEG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function mediumFor(source) {
  if (source === 'email' || source === 'sms') return source;
  return 'social';
}

function parseGoPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'go' || parts.length < 4) return null;
  const source = parts[1];
  const campaign = parts[2];
  const content = parts[3];
  const extraPath = parts.slice(4);
  if (![source, campaign, content].every((p) => SEG.test(p))) return null;
  if (extraPath.some((p) => !SEG.test(p) && p !== '')) return null;
  return { source, campaign, content, extraPath };
}

function safeDestination(raw, extraPath) {
  let pathname = '/';
  const searchParams = new URLSearchParams();

  if (raw && typeof raw === 'string') {
    let p = raw.trim();
    if (!p.startsWith('/')) p = '/' + p;
    if (p.startsWith('//') || p.includes('://') || p.includes('\\')) {
      return { pathname: '/', searchParams };
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
      return { pathname: '/', searchParams };
    }
    const qIdx = p.indexOf('?');
    const hIdx = p.indexOf('#');
    let pathOnly = p;
    let search = '';
    if (qIdx >= 0) {
      pathOnly = p.slice(0, qIdx);
      search = p.slice(qIdx + 1);
      const hashInSearch = search.indexOf('#');
      if (hashInSearch >= 0) search = search.slice(0, hashInSearch);
    } else if (hIdx >= 0) {
      pathOnly = p.slice(0, hIdx);
    }
    pathname = pathOnly || '/';
    if (search) {
      new URLSearchParams(search).forEach((v, k) => {
        if (k) searchParams.set(k, v);
      });
    }
    return { pathname, searchParams };
  }

  if (extraPath && extraPath.length) {
    return { pathname: '/' + extraPath.join('/'), searchParams };
  }
  return { pathname: '/', searchParams };
}

exports.handler = async (event) => {
  const pathname = (event.path || '').split('?')[0];
  const parsed = parseGoPath(pathname);
  if (!parsed) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'Not found. Use /go/{source}/{campaign}/{content} or /go/{source}/{campaign}/{content}/{page}',
    };
  }

  const qs = event.queryStringParameters || {};
  const dest = safeDestination(qs.to, parsed.extraPath);
  const url = new URL(dest.pathname, SITE);

  dest.searchParams.forEach((v, k) => {
    url.searchParams.set(k, v);
  });

  // Forward leftover query params from the /go/ URL (except reserved `to`)
  for (const [k, raw] of Object.entries(qs)) {
    if (k === 'to' || raw == null) continue;
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (val === '') continue;
    url.searchParams.set(k, val);
  }

  // UTMs last so they always win
  url.searchParams.set('utm_source', parsed.source);
  url.searchParams.set('utm_medium', mediumFor(parsed.source));
  url.searchParams.set('utm_campaign', parsed.campaign);
  url.searchParams.set('utm_content', parsed.content);

  return {
    statusCode: 302,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'public, max-age=300',
    },
    body: '',
  };
};
