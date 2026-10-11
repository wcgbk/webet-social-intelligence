#!/usr/bin/env node
'use strict';

/**
 * No-write selection dry run.
 *
 * Sets OMEGA_REPLAY_NO_WRITE=1 before the pipeline loads. That flag blocks
 * blob and store writes even if a caller forgot dryRun. ODDS_API_KEY is
 * read from the environment by ingest. This script never prints env values.
 *
 *   OMEGA_REPLAY_NO_WRITE=1 ODDS_API_KEY=... node tools/omega-dryrun-selection.js
 *   node tools/omega-dryrun-selection.js --date 2026-10-11
 *
 * Do not point this at a live blob store. The default date is 2026-10-11.
 */

process.env.OMEGA_REPLAY_NO_WRITE = '1';

const { generateOmegaVnext } = require('../netlify/functions/lib/omega-vnext');

function argDate() {
  const i = process.argv.indexOf('--date');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return '2026-10-11';
}

function redact(text) {
  return String(text || '')
    .replace(/apiKey=[^&\s]*/gi, 'apiKey=REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/X_BEARER_TOKEN|TWITTER_BEARER_TOKEN|ODDS_API_KEY|NETLIFY_AUTH_TOKEN/g, '[redacted-name]');
}

(async () => {
  const date = argDate();
  const card = await generateOmegaVnext({
    date,
    dryRun: true,
    skipNarrate: true,
  });
  const sel = (card && card.selection) || {};
  const out = {
    snapshotTime: sel.snapshotTime || (card && card.priceLock && card.priceLock.requested) || null,
    top10: sel.top10 || [],
    excludedGames: sel.excludedGames || [],
    straights: (card && card.picks || []).map((p) => ({
      game: p.matchup,
      side: p.pick,
      book: p.book || null,
      line: p.line != null ? p.line : null,
      odds: p.odds,
      edge: p.edgePct,
      winProb: p.coverProb || p.winProbability || null,
      ev: p.ev,
      hrFlags: p.hrFlags || null,
    })),
    parlay: (card && card.parlayLegs) || [],
    xNews: sel.xNews || null,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
})().catch((err) => {
  console.error(redact(err && err.message ? err.message : err));
  process.exit(1);
});
