/**
 * xClient.js — X API v2 client (OAuth 1.0a user context).
 *
 * Signing mirrors the repo's post-to-x.js / search-x.js pattern, generalized to
 * sign GET query params too (required for the mentions endpoint). Includes
 * rate-limit-aware retries with exponential backoff.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const log = require('./logger');

const { x } = config;

// RFC 3986 percent-encoding (encodeURIComponent misses ! * ' ( )).
function pctEncode(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Build a signed OAuth 1.0a Authorization header.
// `params` = the request's query params (GET) or {} (POST with JSON body,
// which is NOT part of the signature base per the OAuth spec).
function buildOAuthHeader(method, url, params = {}) {
  const oauthParams = {
    oauth_consumer_key: x.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: x.accessToken,
    oauth_version: '1.0',
  };

  const all = { ...oauthParams, ...params };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(all[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${pctEncode(url)}&${pctEncode(paramString)}`;
  const signingKey = `${pctEncode(x.consumerSecret)}&${pctEncode(x.accessTokenSecret)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  return 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`)
    .join(', ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Core request with retry/backoff.
 * - 429: wait until x-rate-limit-reset (or backoff), then retry.
 * - 5xx / network: exponential backoff.
 * - 4xx (except 429): fail fast (no point retrying a bad request).
 */
async function request({ method, path, query = {}, body }) {
  const url = `${x.apiBase}${path}`;
  const { maxAttempts, baseDelayMs } = config.retry;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Sign against the base URL + query params; send the SAME encoded query
    // so the signature matches the wire request exactly.
    const authHeader = buildOAuthHeader(method, url, query);
    const qs = Object.keys(query)
      .map((k) => `${pctEncode(k)}=${pctEncode(query[k])}`)
      .join('&');
    const fullUrl = qs ? `${url}?${qs}` : url;

    try {
      const res = await axios({
        method,
        url: fullUrl,
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        data: method.toUpperCase() === 'POST' ? (body || {}) : undefined,
        timeout: 20_000,
        validateStatus: () => true, // we handle status ourselves
      });

      if (res.status >= 200 && res.status < 300) return res.data;

      // Rate limited — honor reset header when present.
      if (res.status === 429) {
        const reset = Number(res.headers['x-rate-limit-reset']);
        let waitMs = baseDelayMs * 2 ** (attempt - 1);
        if (Number.isFinite(reset)) {
          waitMs = Math.max(waitMs, reset * 1000 - Date.now() + 1000);
        }
        waitMs = Math.min(waitMs, 15 * 60_000); // cap at 15m
        log.warn('x.rateLimited', { path, attempt, waitMs });
        if (attempt < maxAttempts) { await sleep(waitMs); continue; }
      }

      // Transient server errors — backoff + retry.
      if (res.status >= 500 && attempt < maxAttempts) {
        const waitMs = baseDelayMs * 2 ** (attempt - 1);
        log.warn('x.serverError', { path, status: res.status, attempt, waitMs });
        await sleep(waitMs);
        continue;
      }

      // Non-retryable (400/401/403/404/…) — surface a clean error.
      const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      throw new Error(`X API ${res.status} ${method} ${path}: ${detail}`);
    } catch (err) {
      const isNetwork = !err.response && (err.code || err.message);
      if (isNetwork && attempt < maxAttempts) {
        const waitMs = baseDelayMs * 2 ** (attempt - 1);
        log.warn('x.networkError', { path, attempt, waitMs, err: err.message });
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`X API exhausted ${maxAttempts} attempts: ${method} ${path}`);
}

// ── Public API ──

async function getMe() {
  const data = await request({ method: 'GET', path: '/users/me', query: { 'user.fields': 'username' } });
  return { id: data.data.id, username: data.data.username };
}

/**
 * GET /2/users/:id/mentions with expansions so we can resolve the parent tweet
 * (for reply-summons) and the author handle in one call.
 */
async function getMentions({ userId, sinceId, paginationToken, maxResults }) {
  const query = {
    max_results: maxResults,
    expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    'tweet.fields': 'created_at,entities,referenced_tweets,author_id,conversation_id,in_reply_to_user_id',
    'user.fields': 'username,name',
  };
  if (sinceId) query.since_id = sinceId;
  if (paginationToken) query.pagination_token = paginationToken;

  return request({ method: 'GET', path: `/users/${userId}/mentions`, query });
}

/** POST /2/tweets — reply when inReplyToTweetId set, else a standalone post. */
async function postTweet({ text, inReplyToTweetId }) {
  const body = { text };
  if (inReplyToTweetId) body.reply = { in_reply_to_tweet_id: String(inReplyToTweetId) };
  const data = await request({ method: 'POST', path: '/tweets', body });
  return { id: data.data?.id };
}

module.exports = { getMe, getMentions, postTweet, buildOAuthHeader, pctEncode };
