/**
 * config.js — Centralized env + tunables for the @AskApai mention bot.
 *
 * All operational knobs live here so behavior is auditable in one place.
 * Load .env before anything else (index.js does this), then read process.env.
 */

'use strict';

const path = require('path');

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback) {
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = {
  // ── X API credentials (OAuth 1.0a user context for @AskApai) ──
  // Named to match the existing repo convention (post-to-x.js / search-x.js),
  // with X_* aliases accepted for convenience.
  x: {
    consumerKey: process.env.TWITTER_CONSUMER_KEY || process.env.X_API_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET || process.env.X_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN || process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || process.env.X_ACCESS_SECRET,
    apiBase: process.env.X_API_BASE || 'https://api.x.com/2',
  },

  // Account identity. userId is optional — resolved via GET /2/users/me if absent.
  account: {
    userId: process.env.ASKAPAI_USER_ID || null,
    handle: (process.env.ASKAPAI_HANDLE || 'AskApai').replace(/^@/, ''),
  },

  // ── Scoring backend (optional) ──
  // If set, POST {url,text,tweetId} here to get {authenticity,framing,note}.
  // If unset, the local heuristic stub in scoring.js is used.
  scoring: {
    backendUrl: process.env.ASKAPAI_BACKEND_URL || null,
    backendKey: process.env.ASKAPAI_BACKEND_KEY || null,
    analyzeBase: process.env.ASKAPAI_ANALYZE_BASE || 'https://askapai.com/analyze',
  },

  // ── Polling / pagination ──
  poll: {
    intervalMs: num(process.env.POLL_INTERVAL_MS, 90_000), // 90s default
    maxResults: Math.min(100, Math.max(5, num(process.env.MENTIONS_MAX_RESULTS, 25))),
    maxPagesPerCycle: Math.max(1, num(process.env.MENTIONS_MAX_PAGES, 2)), // bound spend
    replyDelayMs: num(process.env.REPLY_DELAY_MS, 3_000), // gap between replies
  },

  // ── Cost model (pay-per-use estimates; tune to your X tier) ──
  cost: {
    perRead: num(process.env.COST_PER_READ, 0.005),   // $ per mention read
    perReply: num(process.env.COST_PER_REPLY, 0.20),  // $ per reply posted
  },

  // ── Safety caps (hard stops to prevent runaway spend) ──
  limits: {
    maxRepliesPerDay: num(process.env.MAX_REPLIES_PER_DAY, 200),
    maxDailySpendUsd: num(process.env.MAX_DAILY_SPEND_USD, 50),
    maxReplyLen: 275, // leave headroom under X's 280
  },

  // ── Charity / engagement module ──
  charity: {
    enabled: bool(process.env.CHARITY_ENABLED, false),
    hourUtc: num(process.env.CHARITY_HOUR_UTC, 15), // 15:00 UTC ≈ 11am ET
  },

  // ── Retry policy ──
  retry: {
    maxAttempts: num(process.env.RETRY_MAX_ATTEMPTS, 4),
    baseDelayMs: num(process.env.RETRY_BASE_DELAY_MS, 2_000), // 2s,4s,8s,16s
  },

  // ── Persistence ──
  paths: {
    dataDir: DATA_DIR,
    state: path.join(DATA_DIR, 'state.json'),
    usage: path.join(DATA_DIR, 'usage.json'),
  },

  // Dry run: score + log but never POST to X.
  dryRun: bool(process.env.DRY_RUN, false),

  logLevel: process.env.LOG_LEVEL || 'info',
};
