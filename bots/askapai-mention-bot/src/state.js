/**
 * state.js — Poll cursor + dedupe ledger.
 *
 * - sinceId: highest mention tweet id we've fully processed (X `since_id`).
 * - processedIds: rolling set of recently handled tweet ids (belt-and-suspenders
 *   against the overlap window / eventual-consistency of the mentions timeline).
 */

'use strict';

const config = require('./config');
const store = require('./store');

const MAX_PROCESSED = 5000; // bound the ledger

const DEFAULT = { sinceId: null, processedIds: [], updatedAt: null };

let cache = null;

async function get() {
  if (!cache) cache = await store.load(config.paths.state, { ...DEFAULT });
  // Normalize legacy/missing fields.
  if (!Array.isArray(cache.processedIds)) cache.processedIds = [];
  return cache;
}

function isProcessed(id) {
  return cache && cache.processedIds.includes(String(id));
}

function markProcessed(id) {
  const s = cache;
  const sid = String(id);
  if (!s.processedIds.includes(sid)) s.processedIds.push(sid);
  if (s.processedIds.length > MAX_PROCESSED) {
    s.processedIds = s.processedIds.slice(-MAX_PROCESSED);
  }
}

// X ids are numeric strings; compare as BigInt for correctness beyond 2^53.
function advanceSinceId(id) {
  const s = cache;
  if (!id) return;
  const next = String(id);
  if (!s.sinceId || BigInt(next) > BigInt(s.sinceId)) s.sinceId = next;
}

async function flush() {
  if (!cache) return;
  cache.updatedAt = new Date().toISOString();
  await store.save(config.paths.state, cache);
}

module.exports = { get, isProcessed, markProcessed, advanceSinceId, flush };
