#!/usr/bin/env node
'use strict';
/**
 * Upsert one saved odds-master slot into clv.book_prices. No Odds API call.
 * node tools/ops/backfill-book-prices-from-blob.js YYYY-MM-DD [--slot 1000|0300]
 * Reads SUPABASE_SERVICE_ROLE_KEY and NETLIFY_AUTH_TOKEN from the environment.
 * Never prints those values.
 */
const { loadSlotEvents, upsertPulledBookPrices } = require('../../netlify/functions/lib/odds-master/book-prices');

function redact(msg) {
  let out = String(msg || '');
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'NETLIFY_AUTH_TOKEN', 'ODDS_API_KEY']) {
    const secret = process.env[name];
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]');
  }
  return out;
}

function parseArgs(argv) {
  const out = { slot: '1000' };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--slot') out.slot = args[++i];
    else if (!out.date) out.date = a;
    else throw new Error(`unknown arg ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date || '') || !['0300', '1000'].includes(out.slot)) {
    throw new Error('usage: node tools/ops/backfill-book-prices-from-blob.js YYYY-MM-DD [--slot 1000|0300]');
  }
  return out;
}

function countEvents(eventsBySport) {
  let n = 0;
  for (const evs of Object.values(eventsBySport || {})) n += (evs || []).length;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const loaded = await loadSlotEvents(args.date, args.slot);
  if (!loaded.at) {
    console.log(JSON.stringify({ ok: false, date: args.date, slot: args.slot, error: 'no saved pull blob' }));
    return 1;
  }
  const result = await upsertPulledBookPrices({
    dateISO: args.date,
    slot: args.slot,
    at: loaded.at,
    eventsBySport: loaded.eventsBySport,
    env: process.env,
  });
  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    slot: args.slot,
    at: loaded.at,
    games: countEvents(loaded.eventsBySport),
    upserted: result.upserted != null ? result.upserted : 0,
    skipped: result.skipped || null,
  }));
  return 0;
}

main().then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error(redact(err && err.message ? err.message : err));
  process.exit(1);
});
