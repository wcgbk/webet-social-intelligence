'use strict';
/** Persist Odds API credit headers from the 3 AM and 10 AM board pulls.
 *  Store clv-close-capture, key credits/{date}. Same shape the daily check reads.
 *  Merges onto the closes job's doc. Does not replace its calls or its used count.
 *  OMEGA_PULL_CREDITS_PERSIST defaults on. =off skips the write.
 *  No extra Odds API call. */
const { readJson, writeJson } = require('./store');
const { pullCreditsPersistEnabled } = require('../default_on_flag');

const CREDIT_STORE = 'clv-close-capture';

function headerValue(resp, name) {
  if (!resp || !resp.headers || !name) return null;
  const h = resp.headers;
  if (typeof h.get === 'function') {
    const direct = h.get(name);
    if (direct != null && direct !== '') return direct;
    const lower = h.get(String(name).toLowerCase());
    if (lower != null && lower !== '') return lower;
    return null;
  }
  if (h[name] != null && h[name] !== '') return h[name];
  const lowerName = String(name).toLowerCase();
  if (h[lowerName] != null && h[lowerName] !== '') return h[lowerName];
  return null;
}

function headerNumber(resp, name) {
  const raw = headerValue(resp, name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pathForSlot(slot) {
  if (slot === '0300') return 'odds-master-0300';
  if (slot === '1000') return 'odds-master-1000';
  return null;
}

function callId(call) {
  if (!call) return '';
  return `${call.path}|${call.sport}|${call.at}`;
}

function newestRemaining(calls) {
  let best = null;
  for (const call of calls || []) {
    const n = Number(call && call.remaining);
    if (!Number.isFinite(n)) continue;
    const parsed = call.at ? Date.parse(call.at) : NaN;
    const t = Number.isFinite(parsed) ? parsed : 0;
    if (!best || t >= best.t) best = { t, remaining: n };
  }
  return best ? best.remaining : null;
}

async function persistPullCredits({ dateISO, slot, at, responses, env, read, write }) {
  if (!pullCreditsPersistEnabled(env)) return { skipped: 'flag-off' };
  const path = pathForSlot(slot);
  if (!path || !dateISO || !at) return { wrote: false, calls: 0 };
  const fresh = [];
  for (const row of responses || []) {
    const remaining = headerNumber(row && row.resp, 'x-requests-remaining');
    if (remaining == null) continue;
    fresh.push({
      at,
      path,
      sport: row.sport || null,
      remaining,
      used: headerNumber(row && row.resp, 'x-requests-used'),
    });
  }
  if (!fresh.length) return { wrote: false, calls: 0 };
  const readFn = read || readJson;
  const writeFn = write || writeJson;
  const key = `credits/${dateISO}`;
  let doc = null;
  try { doc = await readFn(key, CREDIT_STORE); } catch (_) { doc = null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = { date: dateISO, calls: [] };
  if (!Array.isArray(doc.calls)) doc.calls = [];
  const seen = new Set(doc.calls.map(callId));
  let added = 0;
  for (const call of fresh) {
    const id = callId(call);
    if (seen.has(id)) continue;
    doc.calls.push(call);
    seen.add(id);
    added += 1;
  }
  if (!doc.date) doc.date = dateISO;
  const remaining = newestRemaining(doc.calls);
  if (remaining != null) doc.remaining = remaining;
  await writeFn(key, doc, CREDIT_STORE);
  return { wrote: true, calls: added, remaining: doc.remaining };
}

module.exports = { persistPullCredits, headerNumber, CREDIT_STORE };
