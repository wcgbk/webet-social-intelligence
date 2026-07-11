/**
 * charity.js — Optional templated engagement posts.
 *
 * Posts a standalone "tag @AskApai to score this" challenge that invites users
 * to summon the bot (which then flows through the normal mention pipeline).
 * Template is chosen deterministically by day-of-year so scheduled runs are
 * idempotent-ish and don't repeat the same line two days running.
 */

'use strict';

const config = require('./config');
const log = require('./logger');
const xClient = require('./xClient');
const usage = require('./usage');

const H = config.account.handle;

const TEMPLATES = [
  `Tag @${H} on any post today and I'll score its authenticity + framing on the spot. Most-challenged claim by 8pm ET → we donate to the winner's charity. Go. 🎯`,
  `Truth check of the day: reply with a link and tag @${H}. I'll rate it 0-100 and flag the manipulation angle. Top claim tonight picks a charity we donate to.`,
  `See a headline that smells off? Tag @${H} with the link. Authenticity score + framing note in seconds. Best submission today = charity donation of your choice.`,
  `Daily challenge: find the most misleading post on your timeline, tag @${H}. I'll grade the spin. Winner names a charity, we give. 🕵️`,
];

function pickTemplate() {
  const start = Date.UTC(new Date().getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.now() - start) / 86_400_000);
  return TEMPLATES[dayOfYear % TEMPLATES.length];
}

async function postChallenge() {
  await usage.get();
  const guard = usage.canReply();
  if (!guard.ok) {
    log.warn('charity.skipBudget', { reason: guard.reason });
    return { posted: false, reason: guard.reason };
  }

  const text = pickTemplate();
  if (config.dryRun) {
    log.info('charity.dryRun', { text });
    return { posted: false, dryRun: true, text };
  }

  const posted = await xClient.postTweet({ text });
  usage.recordReply('charity');
  await usage.flush();
  log.info('charity.posted', { id: posted.id });
  return { posted: true, id: posted.id, text };
}

module.exports = { postChallenge, pickTemplate };
