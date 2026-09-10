/**
 * go-redirect.js — Branded short links that auto-stamp UTMs.
 *
 *   /go/{source}/{campaign}/{content}
 *   /go/{source}/{campaign}/{content}/{path...}
 *   /go/{source}/{campaign}/{content}?to=/omega
 *
 * Examples:
 *   /go/x/betty_sep10/post_a
 *     → https://webetsocial.com/?utm_source=x&utm_medium=social&utm_campaign=betty_sep10&utm_content=post_a
 *   /go/x/cfb_week1/post_b/omega
 *     → https://webetsocial.com/omega?utm_source=x&utm_medium=social&utm_campaign=cfb_week1&utm_content=post_b
 *
 * Medium defaults: email|sms → themselves; else social.
 * Only same-site relative destinations allowed (no open redirects).
 */

const SITE = 'https://webetsocial.com';
const SEG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function mediumFor(source) {
  if (source === 'email' || source === 'sms') return source;
  return 'social';
}

function parseGoPath(pathname) {
  // pathname like /go/x/camp/content or /go/x/camp/content/omega/foo
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

function safeToPath(raw, extraPath) {
  if (raw && typeof raw === 'string') {
    let p = raw.trim();
    if (!p.startsWith('/')) p = '/' + p;
    if (p.startsWith('//') || p.includes('://') || p.includes('\\')) return '/';
    // block protocol-relative / weirdness
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return '/';
    return p.split('?')[0].split('#')[0] || '/';
  }
  if (extraPath && extraPath.length) {
    return '/' + extraPath.join('/');
  }
  return '/';
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
  const destPath = safeToPath(qs.to, parsed.extraPath);
  const url = new URL(destPath, SITE);
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
