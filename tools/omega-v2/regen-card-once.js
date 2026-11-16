'use strict';

/**
 * One-shot regen of a locked card from the stored 3 AM and 10 AM boards.
 * No Odds API call. This file does not print tokens or secret values.
 *
 *   node tools/omega-v2/regen-card-once.js --date 2026-11-16 --dry-run
 *   node tools/omega-v2/regen-card-once.js --date 2026-11-16
 *
 * Env (presence only is printed, never the value):
 *   NETLIFY_AUTH_TOKEN   blob read/write for the regen-once blob and the card
 *   PICKS_SECRET_KEY     sync-supabase-background only
 *   URL                  optional site origin, default https://webetsocial.com
 *
 * Order:
 * 1. PUT omega-card-lock/regen-once-{date}
 *    { allow:true, expiresAt: now+20min, reason }. The lock accepts that
 *    shape once, deletes it before the write, and re-snapshots the new card.
 * 2. POST /.netlify/functions/generate-picks-omega-background
 *    { date, force:true, storedBoardOnly:true }.
 *    Generate has no picks secret. Narration runs before the single
 *    storePicks. That write consumes the blob, stores the card, and syncs v1.
 *    storedBoardOnly uses the saved 10:00 board and refuses a network odds
 *    fetch when that board is missing.
 * 3. Poll picks-{date} until the straight fingerprint changes.
 * 4. POST /.netlify/functions/verify-picks-omega
 *    { date, storedBoardOnly:true }. A manual POST is not a scheduler event,
 *    so the ET slot guard allows it. Locked numbers cannot move.
 * 5. POST /.netlify/functions/sync-supabase-background?date=
 *    with header x-picks-secret. That is the manual card_picks mirror.
 *    It reads stored blobs. It does not call The Odds API.
 * 6. seedCardLock(date, card, { force:true }), the same write as
 *    node tools/omega-v2/seed-card-lock.js DATE --force.
 *
 * Rerank is not called. The new lock would put the previous identity back,
 * and generate already ranked the card.
 */

const { seedCardLock, regenOnceKey } = require('../../netlify/functions/lib/omega-vnext/card_lock');

function present(name) {
  return process.env[name] ? 'set' : 'missing';
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function siteOrigin() {
  return String(process.env.URL || 'https://webetsocial.com').replace(/\/$/, '');
}

function fingerprint(card) {
  return (card && card.picks || []).map((pick) => [
    pick.sport, pick.matchup, pick.pick, pick.odds, pick.units, pick.ev, pick.pBlend, pick.stakeUsd,
  ].join('|')).join('\n');
}

function printSummary(card) {
  const lines = [];
  for (const pick of (card && card.picks) || []) {
    lines.push([
      pick.book || '',
      pick.odds == null ? '' : String(pick.odds),
      pick.pBlend == null ? '' : String(pick.pBlend),
      pick.pPinnacle == null ? '' : String(pick.pPinnacle),
      pick.pModel == null ? '' : String(pick.pModel),
      pick.breakeven == null ? '' : String(pick.breakeven),
      pick.edgePct == null ? '' : String(pick.edgePct),
      pick.ev == null ? '' : String(pick.ev),
      pick.grade || pick.rating || '',
      pick.units || '',
      pick.stakeUsd == null ? '' : `$${pick.stakeUsd}`,
    ].join(' | '));
  }
  const ticket = card && card.parlayLegs && card.parlayLegs[0];
  if (ticket) {
    lines.push([
      'parlay',
      ticket.combinedOdds == null ? '' : String(ticket.combinedOdds),
      ticket.units || '',
      ticket.stakeUsd == null ? '' : `$${ticket.stakeUsd}`,
      `legs ${Array.isArray(ticket.legs) ? ticket.legs.length : 0}`,
    ].join(' | '));
  } else {
    lines.push('parlay | none');
  }
  return lines.join('\n');
}

async function postJson(url, body, headers) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body == null ? undefined : JSON.stringify(body),
  });
  return resp.status;
}

async function main() {
  const argv = process.argv.slice(2);
  const date = argValue(argv, '--date') || argv.find((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  const dry = argv.includes('--dry-run');
  if (!date) {
    console.error('usage: node tools/omega-v2/regen-card-once.js --date YYYY-MM-DD [--dry-run]');
    process.exit(1);
  }
  const origin = siteOrigin();
  const reason = 'regen stored 10:00 board with the blend probability';
  const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const blob = { allow: true, expiresAt, reason };
  console.log([
    `date ${date}`,
    `dryRun ${dry}`,
    `origin ${origin}`,
    `regenKey ${regenOnceKey(date)}`,
    `expiresIn 20m`,
    `NETLIFY_AUTH_TOKEN ${present('NETLIFY_AUTH_TOKEN')}`,
    `PICKS_SECRET_KEY ${present('PICKS_SECRET_KEY')}`,
    'generate {date, force:true, storedBoardOnly:true}',
    'verify {date, storedBoardOnly:true}',
    'sync-supabase-background?date= header x-picks-secret',
    'seedCardLock --force',
  ].join('\n'));
  if (dry) {
    console.log('dry-run: no blob write, no POST, no lock reseed');
    return;
  }
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    console.error('NETLIFY_AUTH_TOKEN missing');
    process.exit(1);
  }
  const { readPicks, storeJson } = require('../../netlify/functions/lib/omega-vnext/store');
  const before = await readPicks(date);
  const beforeFp = fingerprint(before);
  await storeJson(regenOnceKey(date), blob);
  const generateStatus = await postJson(
    `${origin}/.netlify/functions/generate-picks-omega-background`,
    { date, force: true, storedBoardOnly: true },
  );
  console.log(`generate HTTP ${generateStatus}`);
  let card = null;
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    card = await readPicks(date);
    if (card && fingerprint(card) !== beforeFp) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!card || fingerprint(card) === beforeFp) {
    console.error('stored card did not change before the poll deadline');
    process.exit(1);
  }
  const verifyStatus = await postJson(
    `${origin}/.netlify/functions/verify-picks-omega`,
    { date, storedBoardOnly: true },
  );
  console.log(`verify HTTP ${verifyStatus}`);
  if (!process.env.PICKS_SECRET_KEY) {
    console.error('PICKS_SECRET_KEY missing; card is stored, mirror was not posted');
    process.exit(1);
  }
  const syncStatus = await postJson(
    `${origin}/.netlify/functions/sync-supabase-background?date=${date}`,
    null,
    { 'x-picks-secret': process.env.PICKS_SECRET_KEY },
  );
  console.log(`sync HTTP ${syncStatus}`);
  const finalCard = await readPicks(date);
  await seedCardLock(date, finalCard, { force: true });
  console.log('lock reseeded');
  console.log(printSummary(finalCard));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : 'regen failed');
  process.exit(1);
});
