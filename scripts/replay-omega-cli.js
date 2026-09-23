#!/usr/bin/env node
'use strict';

/**
 * CLI: node scripts/replay-omega-cli.js --from 2026-09-15 --to 2026-09-21 --dry-run
 *
 * Default dry-run and skip narrate. Use --write to persist omega-replay/{runId}/*
 * (never live picks). --narrate opts into Claude copy. Scores CLV/ROI from
 * existing clv-{date} and settled results when those blobs exist.
 * Quota: ~1 Odds API historical call × sports × days — keep windows small.
 */

const { runReplayRange, DEFAULT_MAX_DAYS, HARD_MAX_DAYS } = require('../netlify/functions/lib/omega-vnext/replay');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  return argv[i + 1] != null ? argv[i + 1] : true;
}

async function main() {
  const from = arg('--from');
  const to = arg('--to', from);
  const dryRun = !process.argv.includes('--write');
  const skipNarrate = !process.argv.includes('--narrate');
  const maxDays = Number(arg('--max-days', DEFAULT_MAX_DAYS));
  const runId = arg('--run-id', `cli-${from}-to-${to}`);
  const sportsRaw = arg('--sports', null);
  const sports = sportsRaw ? String(sportsRaw).split(',').map(s => s.trim()) : null;
  if (!from) {
    console.error('Usage: node scripts/replay-omega-cli.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run|--write] [--max-days N] [--run-id ID] [--sports MLB,NFL] [--narrate]');
    console.error(`Defaults: dry-run, skip narrate, max-days=${DEFAULT_MAX_DAYS} (hard cap ${HARD_MAX_DAYS})`);
    console.error('Example (last NFL week window): --from 2026-09-15 --to 2026-09-21 --dry-run --max-days 7 --run-id mlb-late-sep');
    process.exit(2);
  }
  console.log(JSON.stringify({ from, to, dryRun, skipNarrate, maxDays, runId, sports }, null, 2));
  const out = await runReplayRange({ from, to, dryRun, maxDays, runId, sports, skipNarrate });
  console.log(JSON.stringify({ summary: out.summary, days: out.days }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
