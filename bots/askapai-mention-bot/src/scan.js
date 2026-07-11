/**
 * scan.js — One full mention-scan cycle: poll → filter → score → reply.
 *
 * Efficiency & safety:
 *   - since_id + processedIds dedupe (never pay to re-read/re-reply).
 *   - bounded pagination per cycle (config.poll.maxPagesPerCycle).
 *   - budget guard checked before every reply (usage.canReply()).
 *   - only replies to posts that actually @mention us (TOS: summoned only).
 *   - processes oldest→newest so a mid-batch crash never skips a mention.
 */

'use strict';

const config = require('./config');
const log = require('./logger');
const xClient = require('./xClient');
const state = require('./state');
const usage = require('./usage');
const apai = require('./apai');
const { buildReply } = require('./reply');

let RESOLVED_ID = config.account.userId;
let RESOLVED_HANDLE = config.account.handle;

async function resolveIdentity() {
  if (RESOLVED_ID) return { id: RESOLVED_ID, username: RESOLVED_HANDLE };
  const me = await xClient.getMe();
  RESOLVED_ID = me.id;
  RESOLVED_HANDLE = me.username || RESOLVED_HANDLE;
  log.info('identity.resolved', { id: RESOLVED_ID, handle: RESOLVED_HANDLE });
  return me;
}

// Does this tweet actually mention us? The endpoint guarantees it, but we
// double-check via entities when available (defense-in-depth for TOS compliance).
function mentionsUs(tweet) {
  const mentions = tweet.entities?.mentions;
  if (!Array.isArray(mentions) || !mentions.length) return true; // trust endpoint
  const me = RESOLVED_HANDLE.toLowerCase();
  return mentions.some((m) => (m.username || '').toLowerCase() === me);
}

// Decide what to analyze:
//   1) an external URL in the mention  → ?url=
//   2) else the parent tweet (a reply-summon) → ?tweet=<parentId>
//   3) else the mention's own text (a claim) → ?tweet=<mentionId>
function resolveTarget(tweet, includesById) {
  const urls = apai.extractUrls(tweet.text, tweet.entities);
  if (urls.length) {
    return { kind: 'url', url: urls[0], text: tweet.text, tweetId: tweet.id };
  }
  const parentRef = (tweet.referenced_tweets || []).find((r) => r.type === 'replied_to');
  if (parentRef) {
    const parent = includesById[parentRef.id];
    return { kind: 'parent', url: null, text: parent?.text || tweet.text, tweetId: parentRef.id };
  }
  return { kind: 'claim', url: null, text: tweet.text, tweetId: tweet.id };
}

async function runCycle() {
  const { id: userId } = await resolveIdentity();
  const st = await state.get();
  await usage.get();

  // ── Collect mentions across bounded pages ──
  const collected = [];
  const includes = { tweets: [], users: [] };
  let paginationToken = null;
  let pages = 0;

  do {
    const resp = await xClient.getMentions({
      userId,
      sinceId: st.sinceId || undefined,
      paginationToken: paginationToken || undefined,
      maxResults: config.poll.maxResults,
    });
    pages += 1;

    const batch = resp.data || [];
    usage.recordReads(batch.length); // meter reads
    collected.push(...batch);
    if (resp.includes?.tweets) includes.tweets.push(...resp.includes.tweets);
    if (resp.includes?.users) includes.users.push(...resp.includes.users);

    paginationToken = resp.meta?.next_token || null;
  } while (paginationToken && pages < config.poll.maxPagesPerCycle);

  if (!collected.length) {
    log.debug('scan.noNewMentions', { sinceId: st.sinceId });
    await state.flush();
    await usage.flush();
    return { processed: 0, replied: 0, skipped: 0 };
  }

  const includesById = {};
  for (const t of includes.tweets) includesById[t.id] = t;

  // Oldest → newest for monotonic since_id advance.
  collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  let replied = 0;
  let skipped = 0;

  for (const tweet of collected) {
    try {
      if (state.isProcessed(tweet.id)) { skipped += 1; state.advanceSinceId(tweet.id); continue; }
      if (String(tweet.author_id) === String(userId)) { // never reply to ourselves
        state.markProcessed(tweet.id); state.advanceSinceId(tweet.id); skipped += 1; continue;
      }
      if (!mentionsUs(tweet)) {
        state.markProcessed(tweet.id); state.advanceSinceId(tweet.id); skipped += 1; continue;
      }

      // Budget guard BEFORE any billable scoring/reply work.
      const guard = usage.canReply();
      if (!guard.ok) {
        log.warn('scan.budgetStop', { reason: guard.reason });
        break; // stop cleanly; leftover mentions picked up next run (sinceId not advanced past them)
      }

      const target = resolveTarget(tweet, includesById);
      // Ask Apai's chat exactly as a user would: "rate this post for
      // authenticity and manipulation" — then post her reply in her voice.
      const { reply: apaiReply, source } = await apai.askApai({ url: target.url, text: target.text, tweetId: target.tweetId });
      const analyzeUrl = apai.buildAnalyzeUrl({ url: target.url, tweetId: target.tweetId });
      const text = buildReply(apaiReply, analyzeUrl);

      if (config.dryRun) {
        log.info('scan.dryRun.reply', { to: tweet.id, kind: target.kind, replySource: source, text });
      } else {
        const posted = await xClient.postTweet({ text, inReplyToTweetId: tweet.id });
        usage.recordReply('reply');
        log.info('scan.replied', {
          to: tweet.id, replyId: posted.id, author: tweet.author_id,
          kind: target.kind, replySource: source,
        });
        replied += 1;
      }

      state.markProcessed(tweet.id);
      state.advanceSinceId(tweet.id);

      // Persist incrementally so a crash can't cause a re-reply.
      await state.flush();
      await usage.flush();

      if (!config.dryRun && config.poll.replyDelayMs) {
        await new Promise((r) => setTimeout(r, config.poll.replyDelayMs));
      }
    } catch (err) {
      // Per-mention failure must not kill the cycle. Do NOT advance sinceId past
      // an errored tweet so it's retried next run (unless it's a hard 4xx we've
      // already logged). Mark processed only on clearly non-retryable content.
      log.error('scan.replyError', { to: tweet.id, err: err.message });
      // Advance to avoid an infinite retry loop on a permanently bad tweet
      // (e.g. deleted / suspended author → 403/404).
      if (/\b(403|404)\b/.test(err.message)) {
        state.markProcessed(tweet.id);
        state.advanceSinceId(tweet.id);
      }
    }
  }

  await state.flush();
  await usage.flush();

  const snap = usage.snapshot();
  log.info('scan.cycleDone', {
    processed: collected.length, replied, skipped,
    dailyReplies: snap.daily.replies, dailySpendUsd: snap.daily.spendUsd,
  });
  return { processed: collected.length, replied, skipped };
}

module.exports = { runCycle, resolveIdentity };
