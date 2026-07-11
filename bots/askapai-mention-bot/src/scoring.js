/**
 * scoring.js — Authenticity + framing scoring.
 *
 * Two modes:
 *   1. Backend (preferred): if ASKAPAI_BACKEND_URL is set, POST the content and
 *      use the returned {authenticity, framing, note}. Wire this to askapai.com's
 *      real engine (Guardian authenticity 0-100 + manipulation lens).
 *   2. Stub (fallback): a deterministic local heuristic so the bot is runnable
 *      end-to-end today. The framing buckets reuse the regex from the repo's
 *      scan-ap-mentions.js categorizeComplaint().
 *
 * scoreContent() ALWAYS returns a well-formed result; it never throws — a scoring
 * failure must not wedge the reply loop.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const log = require('./logger');

// URL extraction — prefer expanded_url from entities; fall back to text regex.
// Drops X/Twitter status links to the mention itself so we don't analyze our own thread.
const URL_RE = /https?:\/\/[^\s]+/gi;

function extractUrls(text = '', entities = null) {
  const urls = [];
  if (entities && Array.isArray(entities.urls)) {
    for (const u of entities.urls) {
      const v = u.expanded_url || u.unwound_url || u.url;
      if (v) urls.push(v);
    }
  }
  if (!urls.length) {
    const m = String(text).match(URL_RE);
    if (m) urls.push(...m);
  }
  // Drop permalinks to an X/Twitter status (that's the thread itself, not an
  // external claim to analyze). Keep every other link. The host must be exactly
  // x.com / twitter.com (or a subdomain), so notx.com/… isn't caught.
  const isStatusPermalink = (u) =>
    /https?:\/\/(?:[\w-]+\.)*(?:x|twitter)\.com\/\w+\/status\//i.test(u);
  return urls.filter((u) => !isStatusPermalink(u));
}

// ── Framing lens (stub) — mirrors scan-ap-mentions.js categorizeComplaint ──
function framingSignal(text = '') {
  const t = text.toLowerCase();
  let hits = 0;
  if (/word choice|framing|spin|narrative|mislead|manipulat/.test(t)) hits += 2;
  if (/left out|didn't mention|omit|missing|failed to/.test(t)) hits += 1;
  if (/fake|lie|liar|false|misinform|disinform|hoax/.test(t)) hits += 2;
  if (/bias|partisan|one-sided|slant|agenda/.test(t)) hits += 1;
  if (/breaking|shocking|you won't believe|destroys|slams|owned/.test(t)) hits += 1;
  if (hits >= 3) return 'high';
  if (hits >= 1) return 'medium';
  return 'low';
}

// Deterministic pseudo-authenticity so the stub is stable per input (no random
// jitter between retries). Real signal comes from the backend.
function stubAuthenticity(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  return 40 + (h[0] % 56); // 40–95 range keeps stub output plausible
}

function localStub({ url, text }) {
  const framing = framingSignal(text);
  const penalty = framing === 'high' ? 22 : framing === 'medium' ? 10 : 0;
  const base = stubAuthenticity(url || text || 'x');
  const authenticity = Math.max(1, Math.min(100, base - penalty));
  return {
    authenticity,
    framing,
    note: `stub score (no backend configured); framing=${framing}`,
    source: 'stub',
  };
}

async function callBackend({ url, text, tweetId }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.scoring.backendKey) headers['x-api-key'] = config.scoring.backendKey;
  const res = await axios.post(
    config.scoring.backendUrl,
    { url: url || null, text: text || null, tweetId: tweetId || null },
    { headers, timeout: 25_000, validateStatus: () => true }
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`scoring backend ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const d = res.data || {};
  const authenticity = Math.max(0, Math.min(100, Math.round(Number(d.authenticity))));
  const framing = ['low', 'medium', 'high'].includes(d.framing) ? d.framing : framingSignal(text);
  if (!Number.isFinite(authenticity)) throw new Error('backend returned no authenticity');
  return { authenticity, framing, note: d.note || '', source: 'backend' };
}

async function scoreContent({ url, text, tweetId }) {
  if (config.scoring.backendUrl) {
    try {
      return await callBackend({ url, text, tweetId });
    } catch (err) {
      log.warn('scoring.backendFailed.fallbackToStub', { err: err.message });
    }
  }
  return localStub({ url, text });
}

// Build the private-analysis deep link the reply points to.
function buildAnalyzeUrl({ url, tweetId }) {
  const base = config.scoring.analyzeBase;
  if (url) return `${base}?url=${encodeURIComponent(url)}`;
  return `${base}?tweet=${encodeURIComponent(tweetId)}`;
}

module.exports = { scoreContent, extractUrls, framingSignal, buildAnalyzeUrl };
