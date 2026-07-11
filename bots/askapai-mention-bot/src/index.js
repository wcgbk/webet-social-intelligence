#!/usr/bin/env node
/**
 * index.js — @AskApai mention-reply bot entry point.
 *
 * Modes (arg 1):
 *   loop      long-running poller + optional daily charity post (default)
 *   scan      one-shot scan cycle (ideal for cron / n8n Execute Command)
 *   charity   one-shot charity challenge post
 *   whoami    resolve + print the authenticated account (credential check)
 *   usage     print today's + lifetime usage/cost snapshot
 *
 * Cron example (every 2 min):   * /2 * * * *  cd bot && node src/index.js scan
 * n8n: run `node src/index.js scan` on a Schedule Trigger, or require() the
 *      exported functions from a Function node.
 */

'use strict';

require('dotenv').config();

const config = require('./config');
const log = require('./logger');
const scan = require('./scan');
const charity = require('./charity');
const usage = require('./usage');
const xClient = require('./xClient');

function assertCreds() {
  const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = config.x;
  const missing = [];
  if (!consumerKey) missing.push('TWITTER_CONSUMER_KEY / X_API_KEY');
  if (!consumerSecret) missing.push('TWITTER_CONSUMER_SECRET / X_API_SECRET');
  if (!accessToken) missing.push('TWITTER_ACCESS_TOKEN / X_ACCESS_TOKEN');
  if (!accessTokenSecret) missing.push('TWITTER_ACCESS_TOKEN_SECRET / X_ACCESS_SECRET');
  if (missing.length) {
    log.error('config.missingCredentials', { missing });
    process.exit(1);
  }
}

async function once() {
  assertCreds();
  const res = await scan.runCycle();
  await flushAll();
  return res;
}

async function flushAll() {
  const state = require('./state');
  await state.flush();
  await usage.flush();
}

let stopping = false;
let charityDoneForDay = null;

async function loop() {
  assertCreds();
  log.info('bot.start', {
    mode: 'loop',
    intervalMs: config.poll.intervalMs,
    dryRun: config.dryRun,
    charity: config.charity.enabled,
    caps: config.limits,
  });

  // Confirm identity up front so a bad token fails loudly at boot.
  try {
    await scan.resolveIdentity();
  } catch (err) {
    log.error('bot.identityFailed', { err: err.message });
    process.exit(1);
  }

  const tick = async () => {
    if (stopping) return;
    try {
      await maybeCharity();
      await scan.runCycle();
    } catch (err) {
      log.error('loop.cycleError', { err: err.message }); // survive & keep polling
    }
    if (!stopping) setTimeout(tick, config.poll.intervalMs);
  };

  tick();
}

async function maybeCharity() {
  if (!config.charity.enabled) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (charityDoneForDay === day) return;
  if (now.getUTCHours() === config.charity.hourUtc) {
    try {
      await charity.postChallenge();
    } catch (err) {
      log.error('charity.error', { err: err.message });
    }
    charityDoneForDay = day; // once per day regardless of outcome
  }
}

function installSignalHandlers() {
  const shutdown = async (sig) => {
    log.info('bot.shutdown', { sig });
    stopping = true;
    try { await flushAll(); } catch (_) { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: String(err && err.message || err) }));
}

async function main() {
  const mode = (process.argv[2] || 'loop').toLowerCase();
  installSignalHandlers();

  switch (mode) {
    case 'scan': {
      const res = await once();
      log.info('scan.oneShotDone', res);
      break;
    }
    case 'charity': {
      assertCreds();
      const res = await charity.postChallenge();
      log.info('charity.oneShotDone', res);
      break;
    }
    case 'whoami': {
      assertCreds();
      const me = await xClient.getMe();
      log.info('whoami', me);
      break;
    }
    case 'usage': {
      await usage.get();
      log.info('usage.snapshot', usage.snapshot());
      break;
    }
    case 'loop':
    default:
      await loop();
      return; // loop keeps the process alive
  }
}

main().catch((err) => {
  log.error('bot.fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
