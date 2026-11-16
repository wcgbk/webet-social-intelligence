'use strict';

/**
 * Seed omega-card-lock/picks-{date} from the live card or a local JSON file.
 * Token is read by the store helpers from process.env.NETLIFY_AUTH_TOKEN.
 * This script never prints that token.
 *
 *   node tools/omega-v2/seed-card-lock.js DATE [--from-file path] [--dry-run] [--force]
 */

const fs = require('fs');
const {
  seedCardLock,
  snapshotFromCard,
  lockTimeUtc,
  isCardLocked,
} = require('../../netlify/functions/lib/omega-vnext/card_lock');

function usage() {
  return 'usage: node tools/omega-v2/seed-card-lock.js DATE [--from-file path] [--dry-run] [--force]';
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function summaryLines(date, card) {
  const snap = snapshotFromCard(card);
  const lines = [
    `date ${date}`,
    `lockTime ${lockTimeUtc(date)}`,
    `lockedNow ${isCardLocked(date, new Date())}`,
    `straights ${(snap.picks || []).length}`,
  ];
  for (const pick of snap.picks || []) {
    lines.push([
      'pick',
      pick.sport || '',
      pick.matchup || '',
      pick.pick || '',
      pick.odds == null ? '' : String(pick.odds),
      pick.units || '',
      pick.stakeUsd == null ? '' : `$${pick.stakeUsd}`,
      pick.book || '',
    ].join(' | '));
  }
  lines.push(`parlays ${(snap.parlayLegs || []).length}`);
  for (const ticket of snap.parlayLegs || []) {
    lines.push([
      'parlay',
      ticket.type || '',
      ticket.combinedOdds == null ? '' : String(ticket.combinedOdds),
      ticket.units || '',
      ticket.stakeUsd == null ? '' : `$${ticket.stakeUsd}`,
      `legs ${Array.isArray(ticket.legs) ? ticket.legs.length : 0}`,
    ].join(' | '));
  }
  return lines.join('\n');
}

async function loadCard(date, fromFile) {
  if (fromFile) return JSON.parse(fs.readFileSync(fromFile, 'utf8'));
  const { readPicks } = require('../../netlify/functions/lib/omega-vnext/store');
  return readPicks(date);
}

async function main() {
  const argv = process.argv.slice(2);
  const date = argv.find((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  if (!date) {
    console.error(usage());
    process.exit(1);
  }
  const fromFile = flagValue(argv, '--from-file');
  if (argv.includes('--from-file') && !fromFile) {
    console.error(usage());
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const card = await loadCard(date, fromFile);
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    console.error(`no card for ${date}`);
    process.exit(1);
  }
  console.log(summaryLines(date, card));
  if (dryRun) return;
  const { readJson, storeJson } = require('../../netlify/functions/lib/omega-vnext/store');
  await seedCardLock(date, card, {
    force,
    readSnapshot: (key) => readJson(key),
    writeSnapshot: (key, value) => storeJson(key, value),
  });
  console.log(`seeded omega-card-lock/picks-${date}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
