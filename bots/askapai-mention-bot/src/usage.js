/**
 * usage.js — Cost + volume tracker with a hard daily budget guard.
 *
 * Every read (mention fetched) and write (reply / charity post) is metered so
 * spend is never a surprise. Daily counters roll over at UTC midnight; lifetime
 * totals accumulate. canReply() is the safety valve callers must check before
 * every POST.
 */

'use strict';

const config = require('./config');
const store = require('./store');
const log = require('./logger');

const DEFAULT = {
  day: null,
  daily: { reads: 0, replies: 0, charityPosts: 0, spendUsd: 0 },
  lifetime: { reads: 0, replies: 0, charityPosts: 0, spendUsd: 0 },
  updatedAt: null,
};

let cache = null;

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function get() {
  if (!cache) cache = await store.load(config.paths.usage, { ...DEFAULT });
  rollIfNeeded();
  return cache;
}

function rollIfNeeded() {
  const d = today();
  if (cache.day !== d) {
    if (cache.day) log.info('usage.rollover', { from: cache.day, to: d, prevDaily: cache.daily });
    cache.day = d;
    cache.daily = { reads: 0, replies: 0, charityPosts: 0, spendUsd: 0 };
  }
}

function round(n) {
  return Math.round(n * 1e4) / 1e4;
}

function recordReads(n = 1) {
  rollIfNeeded();
  const cost = n * config.cost.perRead;
  cache.daily.reads += n;
  cache.daily.spendUsd = round(cache.daily.spendUsd + cost);
  cache.lifetime.reads += n;
  cache.lifetime.spendUsd = round(cache.lifetime.spendUsd + cost);
  log.debug('usage.read', { n, cost: round(cost), dailyReads: cache.daily.reads });
}

function recordReply(kind = 'reply') {
  rollIfNeeded();
  const cost = config.cost.perReply;
  if (kind === 'charity') cache.daily.charityPosts += 1;
  else cache.daily.replies += 1;
  cache.daily.spendUsd = round(cache.daily.spendUsd + cost);
  if (kind === 'charity') cache.lifetime.charityPosts += 1;
  else cache.lifetime.replies += 1;
  cache.lifetime.spendUsd = round(cache.lifetime.spendUsd + cost);
  log.info('usage.write', { kind, cost, dailySpendUsd: cache.daily.spendUsd });
}

/**
 * Guard: is it safe to post one more reply today?
 * Returns { ok, reason } — callers MUST honor ok:false.
 */
function canReply() {
  rollIfNeeded();
  const { maxRepliesPerDay, maxDailySpendUsd } = config.limits;
  const totalWrites = cache.daily.replies + cache.daily.charityPosts;
  if (totalWrites >= maxRepliesPerDay) {
    return { ok: false, reason: `daily reply cap reached (${maxRepliesPerDay})` };
  }
  if (round(cache.daily.spendUsd + config.cost.perReply) > maxDailySpendUsd) {
    return { ok: false, reason: `daily spend cap reached ($${maxDailySpendUsd})` };
  }
  return { ok: true };
}

function snapshot() {
  rollIfNeeded();
  return JSON.parse(JSON.stringify({ day: cache.day, daily: cache.daily, lifetime: cache.lifetime }));
}

async function flush() {
  if (!cache) return;
  cache.updatedAt = new Date().toISOString();
  await store.save(config.paths.usage, cache);
}

module.exports = { get, recordReads, recordReply, canReply, snapshot, flush };
