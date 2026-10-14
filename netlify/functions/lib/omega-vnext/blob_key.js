'use strict';

/**
 * Netlify Blobs object keys.
 *
 * The SDK stores a slash key as separate path segments (`date/2026-10-14`).
 * Encoding the whole key is a different object (`date%2F2026-10-14`).
 * REST fallbacks that encoded the whole key wrote the 10:00 snapshot index
 * where readers looking up `date/...` could not see it. Canonical REST
 * encoding keeps the slashes and encodes each segment, which is what the
 * SDK does. The fully encoded form is read-only, for blobs already stored
 * that way. New writes use the canonical key only.
 */

function canonicalBlobKey(key) {
  return String(key == null ? '' : key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function legacyEncodedBlobKey(key) {
  return encodeURIComponent(String(key == null ? '' : key));
}

function blobHasSlash(key) {
  return String(key == null ? '' : key).indexOf('/') !== -1;
}

function blobKeyAliases(key) {
  const raw = String(key == null ? '' : key);
  const canon = canonicalBlobKey(raw);
  const legacy = legacyEncodedBlobKey(raw);
  const out = [];
  for (const item of [raw, canon, legacy]) {
    if (item && out.indexOf(item) === -1) out.push(item);
  }
  return out;
}

function blobRestUrl(siteId, store, key, form) {
  const encoded = form === 'legacy' ? legacyEncodedBlobKey(key) : canonicalBlobKey(key);
  return `https://api.netlify.com/api/v1/blobs/${siteId}/${store}/${encoded}`;
}

module.exports = {
  canonicalBlobKey,
  legacyEncodedBlobKey,
  blobHasSlash,
  blobKeyAliases,
  blobRestUrl,
};
