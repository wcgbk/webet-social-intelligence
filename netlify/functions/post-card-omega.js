'use strict';

/**
 * post-card-omega — 11:00 ET.
 * Schedule: "0 15,16 * * *" (11:00 ET in both EDT and EST).
 * Posts only when OMEGA_X_AUTOPOST is exactly the string "true".
 * Copy that contains the words Alpha or Omega is rejected and not sent.
 * dryRun and OMEGA_REPLAY_NO_WRITE do not post. The flag is unset in this repo.
 */

const crypto = require('crypto');
const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const { replayNoWrite } = require('./lib/omega-vnext/no_write');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TWEET_URL = 'https://api.twitter.com/2/tweets';

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function truthyDry(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

function wantsDryRun(event) {
  const qs = (event && event.queryStringParameters) || {};
  if (truthyDry(qs.dryRun) || truthyDry(qs.dryrun)) return true;
  const body = readBody(event);
  return !!(body && (truthyDry(body.dryRun) || truthyDry(body.dryrun)));
}

function autopostEnabled(env) {
  return String((env || {}).OMEGA_X_AUTOPOST || '') === 'true';
}

function copyRejection(text) {
  const s = String(text || '');
  if (!s.trim()) return 'empty';
  if (/\balpha\b/i.test(s) || /\bomega\b/i.test(s)) return 'brand-word';
  return null;
}

function cardCopy(card) {
  const picks = Array.isArray(card && card.picks) ? card.picks.slice(0, 3) : [];
  const lines = ['Today\'s card'];
  for (const pick of picks) {
    const parts = [pick && pick.sport, pick && (pick.matchup || ''), pick && (pick.pick || pick.side || ''), pick && pick.odds];
    lines.push(parts.filter((part) => part != null && String(part).trim() !== '').join(' '));
  }
  const parlay = card && (card.parlay || (Array.isArray(card.parlays) ? card.parlays[0] : null));
  if (parlay && (parlay.odds || parlay.price)) lines.push(`Parlay ${parlay.odds || parlay.price}`);
  return lines.join('\n');
}

function encodeRFC3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader(env) {
  const consumerKey = env.TWITTER_CONSUMER_KEY;
  const consumerSecret = env.TWITTER_CONSUMER_SECRET;
  const accessToken = env.TWITTER_ACCESS_TOKEN;
  const accessTokenSecret = env.TWITTER_ACCESS_TOKEN_SECRET;
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) return null;
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort().map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(params[key])}`).join('&');
  const base = `POST&${encodeRFC3986(TWEET_URL)}&${encodeRFC3986(paramString)}`;
  const signingKey = `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(accessTokenSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return `OAuth ${Object.keys(params).sort().map((key) => `${encodeRFC3986(key)}="${encodeRFC3986(params[key])}"`).join(', ')}`;
}

async function defaultSend(text, env, fetchImpl) {
  if (!autopostEnabled(env)) return { posted: false, reason: 'flag-off' };
  const auth = oauthHeader(env);
  if (!auth) return { posted: false, reason: 'no-credentials' };
  if (typeof fetchImpl !== 'function') return { posted: false, reason: 'no-sender' };
  const res = await fetchImpl(TWEET_URL, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    return { posted: false, reason: `http-${status || 'error'}` };
  }
  let id = null;
  if (typeof res.json === 'function') {
    const data = await res.json();
    id = data && data.data && data.data.id ? data.data.id : null;
  }
  return { posted: true, reason: null, id };
}

async function runPost(opts) {
  const src = opts || {};
  const env = src.env || {};
  if (!autopostEnabled(env)) return { posted: false, wrote: false, reason: 'flag-off' };
  const copy = src.copy != null ? String(src.copy) : cardCopy(src.card);
  const rejected = copyRejection(copy);
  if (rejected) return { posted: false, wrote: false, reason: rejected };
  if (src.dryRun || replayNoWrite(env)) return { posted: false, wrote: false, reason: 'dry-run' };
  const send = typeof src.send === 'function'
    ? src.send
    : (text) => defaultSend(text, env, src.fetchImpl);
  const sent = await send(copy);
  return {
    posted: !!(sent && sent.posted),
    wrote: false,
    reason: sent && sent.reason ? sent.reason : null,
    id: sent && sent.id ? sent.id : null,
  };
}

async function handle(event, now, deps) {
  const when = now instanceof Date ? now : new Date();
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: JSON_HEADERS, body: '' };
  }
  const skip = rejectUnlessEtSlot('post-card-omega', event, when);
  if (skip) return skip;
  const src = deps || {};
  const env = src.env || process.env;
  if (!autopostEnabled(env)) {
    return json(200, { ok: true, posted: false, wrote: false, reason: 'flag-off', date: etParts(when).ymd });
  }
  const result = await runPost({
    env,
    copy: src.copy,
    card: src.card,
    dryRun: src.dryRun != null ? !!src.dryRun : wantsDryRun(event),
    send: src.send,
    fetchImpl: src.fetchImpl,
  });
  return json(200, { ok: true, date: etParts(when).ymd, ...result });
}

exports.handler = (event) => handle(event, new Date(), null);
exports.handle = handle;
exports.runPost = runPost;
exports.copyRejection = copyRejection;
exports.cardCopy = cardCopy;
exports.autopostEnabled = autopostEnabled;
exports.TWEET_URL = TWEET_URL;
