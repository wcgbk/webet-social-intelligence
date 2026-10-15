#!/usr/bin/env node
'use strict';

/**
 * No-write selection dry run from the stored 10:00 ET board.
 *
 * Does not call the Odds API. Does not write blobs or the database.
 * Does not post to X. Loads a Netlify token only to read
 * omega-pinnacle-line-moves. Never prints the token or a signed URL.
 *
 *   node tools/omega-dryrun-selection.js --date 2026-10-14
 *   node tools/omega-dryrun-selection.js --date 2026-10-14,2026-10-13,2026-10-10
 */

const fs = require('fs');

process.env.OMEGA_REPLAY_NO_WRITE = '1';
process.env.OMEGA_X_AUTOPOST = 'false';
delete process.env.ODDS_API_KEY;

function loadNetlifyToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return 'env';
  const path = '/home/box/.config/netlify/config.json';
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); } catch (_) { return 'missing-file'; }
  let json;
  try { json = JSON.parse(raw); } catch (_) { return 'bad-json'; }
  const users = json && json.users;
  if (!users || typeof users !== 'object') return 'no-users';
  for (const user of Object.values(users)) {
    const token = user && user.auth && user.auth.token;
    if (typeof token === 'string' && token.length > 0) {
      process.env.NETLIFY_AUTH_TOKEN = token;
      return 'config';
    }
  }
  return 'no-token';
}

const tokenSource = loadNetlifyToken();

const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : (url && url.url) || '';
  if (/the-odds-api\.com/i.test(String(href))) {
    throw new Error('paid odds pull blocked');
  }
  return realFetch(url, init);
};

const { generateOmegaVnext } = require('../netlify/functions/lib/omega-vnext');
const { priceLockTimestamp } = require('../netlify/functions/lib/omega-vnext/price_lock');

function argDates() {
  const i = process.argv.indexOf('--date');
  const raw = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '2026-10-14';
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

function redact(text) {
  return String(text || '')
    .replace(/apiKey=[^&\s]*/gi, 'apiKey=REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/https:\/\/[^\s)]+/gi, 'https://REDACTED')
    .replace(/X_BEARER_TOKEN|TWITTER_BEARER_TOKEN|ODDS_API_KEY|NETLIFY_AUTH_TOKEN/g, '[redacted-name]');
}

function printCard(date, card) {
  const picks = (card && card.picks) || [];
  const ticket = (card && card.parlayLegs && card.parlayLegs[0]) || null;
  const legs = (ticket && ticket.legs) || [];
  const lock = (card && card.priceLock) || {};
  console.log(`\n===== CARD ${date} model=${card && card.model} =====`);
  console.log(`snapshot note=${lock.note || 'none'} servedAt=${lock.servedAt || 'none'} straights=${picks.length} parlayLegs=${legs.length}`);
  console.log(`parlay units=${ticket && ticket.units} label=${ticket && ticket.label ? ticket.label : ''} qualifying=${ticket && ticket.qualifying} ev=${ticket && ticket.ev} type=${ticket && ticket.type}`);
  picks.forEach((p, i) => {
    console.log(
      `STRAIGHT ${i + 1} tier=${p.tier || ''} label=${p.label || ''} book=${p.book || p.executionBook || ''} odds=${p.odds} win=${p.winProbability || p.coverProb || ''} fair=${p.fair_sharp_p != null ? p.fair_sharp_p : ''} ev=${p.ev} edge=${p.modelEdge || p.edgePct || ''} units=${p.units} ${p.sport || ''} ${p.matchup || ''} ${p.pick || ''}`,
    );
  });
  legs.forEach((leg, i) => {
    console.log(
      `PARLAY ${i + 1} tier=${leg.tier || ''} book=${leg.book || ''} odds=${leg.odds} win=${leg.coverProb || leg.winProbability || ''} ev=${leg.ev} edge=${leg.edgePct || ''} ${leg.sport || ''} ${leg.matchup || ''} ${leg.pick || ''}`,
    );
  });
  if (picks.length !== 3 || legs.length !== 3) {
    console.log(`CARD SHORT ${date} straights=${picks.length} parlayLegs=${legs.length}`);
  }
}

(async () => {
  console.error(`[omega-dryrun] tokenSource=${tokenSource} autopost=${process.env.OMEGA_X_AUTOPOST} noWrite=1`);
  const dates = argDates();
  let short = false;
  for (const date of dates) {
    // Judge pregame against 10:00 ET that day. A later wall clock would
    // mark the saved slate in-progress. This clock does not pull odds.
    const card = await generateOmegaVnext({
      date,
      dryRun: true,
      skipNarrate: true,
      allowPaidOdds: false,
      pregameAsOfMs: Date.parse(priceLockTimestamp(date)),
    });
    printCard(date, card);
    const legs = card && card.parlayLegs && card.parlayLegs[0] && card.parlayLegs[0].legs;
    if (!card || !card.picks || card.picks.length !== 3 || !legs || legs.length !== 3) short = true;
  }
  if (short) process.exit(2);
})().catch((err) => {
  console.error(redact(err && err.stack ? err.stack : err));
  process.exit(1);
});
