'use strict';
/**
 * Backfill the Supabase daily mirror from Netlify blobs.
 * node tools/supa-mirror/backfill.js --from YYYY-MM-DD --to YYYY-MM-DD [--parts odds,board,card,results,clv,kpi,scores] [--dry]
 * Reads SUPABASE_SERVICE_ROLE_KEY and NETLIFY_AUTH_TOKEN from process.env. Never prints secrets.
 */
const { mirrorDay, PARTS } = require('../../netlify/functions/lib/supa-mirror');
const { addDays } = require('../../netlify/functions/lib/clv-supabase');

function parseArgs(argv) {
  const out = { parts: null, dry: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--from') out.from = args[++i];
    else if (a === '--to') out.to = args[++i];
    else if (a === '--parts') out.parts = String(args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry') out.dry = true;
    else throw new Error(`unknown arg ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(out.to || '')) {
    throw new Error('usage: node tools/supa-mirror/backfill.js --from YYYY-MM-DD --to YYYY-MM-DD [--parts odds,board,card,results,clv,kpi,scores] [--dry]');
  }
  if (out.from > out.to) throw new Error('from is after to');
  if (out.parts) {
    const bad = out.parts.filter((p) => !PARTS.includes(p));
    if (bad.length) throw new Error(`unknown parts: ${bad.join(',')}`);
  }
  return out;
}

function dates(from, to) {
  const out = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

function redact(msg, env) {
  let out = String(msg || '');
  const secrets = [env && env.SUPABASE_SERVICE_ROLE_KEY, env && env.NETLIFY_AUTH_TOKEN];
  for (const secret of secrets) {
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]');
  }
  return out;
}

async function backfill(opts) {
  const env = opts.env || process.env;
  const lines = [];
  for (const date of dates(opts.from, opts.to)) {
    let line;
    try {
      const result = await mirrorDay(date, {
        env,
        fetch: opts.fetch,
        blobs: opts.blobs,
        parts: opts.parts || undefined,
        dry: !!opts.dry,
        job: 'backfill',
        includeCumulative: false,
      });
      line = { date, ok: result.ok, counts: result.counts, errors: (result.errors || []).map((e) => redact(e, env)) };
    } catch (e) {
      line = { date, ok: false, counts: {}, errors: [redact(e && e.message, env)] };
    }
    lines.push(line);
    if (opts.print !== false) console.log(JSON.stringify(line));
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv);
  const lines = await backfill({ ...args, env: process.env, print: true });
  return lines.some((l) => !l.ok) ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(redact(e && e.message, process.env));
    process.exit(1);
  });
}

module.exports = { backfill, parseArgs, dates };
