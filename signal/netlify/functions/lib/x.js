// X (Twitter) poster — OAuth 1.0a, HMAC-SHA1, hand-signed. Cloned from the Daily Dose
// poster but ACCOUNT-GUARDED to @wcgbk so it can never post as the wrong handle.
// Env: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//      WCG_X_ID (defaults to @wcgbk's numeric id) — the only account allowed to post.
const crypto = require("crypto");

// @wcgbk (Ben Klein) — verified from the X API. Override via WCG_X_ID if ever needed.
const WCG_X_ID = process.env.WCG_X_ID || "50018957";

function pct(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function oauthHeader(method, url, extra = {}) {
  const o = {
    oauth_consumer_key: process.env.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...o, ...extra };
  const ps = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(ps)].join("&");
  const sk = `${pct(process.env.X_CONSUMER_SECRET)}&${pct(process.env.X_ACCESS_SECRET)}`;
  o.oauth_signature = crypto.createHmac("sha1", sk).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map((k) => `${pct(k)}="${pct(o[k])}"`).join(", ");
}

async function uploadMedia(pngBuffer) {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const fd = new FormData();
  fd.append("media_data", pngBuffer.toString("base64"));
  fd.append("media_category", "tweet_image");
  const r = await fetch(url, { method: "POST", headers: { Authorization: oauthHeader("POST", url) }, body: fd });
  if (!r.ok) throw new Error("media upload " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).media_id_string;
}

async function postTweet(text, { mediaIds, replyTo, quoteTweetId } = {}) {
  const url = "https://api.twitter.com/2/tweets";
  const body = { text };
  if (mediaIds?.length) body.media = { media_ids: mediaIds };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  if (quoteTweetId) body.quote_tweet_id = quoteTweetId;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: oauthHeader("POST", url), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("post tweet " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).data;
}

// Which account do the configured creds post AS? Returns public handle/id only.
async function getAuthedAccount() {
  const url = "https://api.twitter.com/2/users/me";
  const r = await fetch(url, { headers: { Authorization: oauthHeader("GET", url) } });
  if (!r.ok) throw new Error("users/me " + r.status + " " + (await r.text()).slice(0, 120));
  return (await r.json()).data; // { id, name, username }
}

// Hard safety guard — refuse to post unless the authed account is @wcgbk.
async function assertOwner() {
  const acct = await getAuthedAccount();
  if (acct.id !== WCG_X_ID) {
    const e = new Error(`account guard: authed @${acct.username} (${acct.id}) is not @wcgbk`);
    e.guard = true;
    throw e;
  }
  return acct;
}

// X counts every link as 23 chars (t.co) and most emoji as 2. Weigh accordingly.
const URL_RE = /https?:\/\/\S+/g;
function weigh(s) {
  const noUrl = String(s || "").replace(URL_RE, "");
  const base = [...noUrl].reduce(
    (n, ch) => n + (ch.codePointAt(0) > 0xffff || /[\u{1F000}-\u{1FAFF}☀-➿️]/u.test(ch) ? 2 : 1), 0
  );
  return base + (String(s || "").match(URL_RE) || []).length * 23;
}

// Post a single tweet (optionally with an image), owner-guarded.
async function postSingle(text, png) {
  await assertOwner();
  const mediaIds = png ? [await uploadMedia(png)] : [];
  const t = await postTweet(text, { mediaIds });
  return { id: t?.id || null };
}

// Post a thread: tweets[0] is the index (gets the image if provided); the rest chain as replies.
async function postThread(tweets, png) {
  await assertOwner();
  const arr = (tweets || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!arr.length) throw new Error("empty thread");
  const mediaIds = png ? [await uploadMedia(png)] : [];
  const index = await postTweet(arr[0], { mediaIds });
  const ids = [index?.id || null];
  let prev = index?.id;
  for (let i = 1; i < arr.length; i++) {
    const p = await postTweet(arr[i], { replyTo: prev }).catch((e) => ({ error: String(e).slice(0, 140) }));
    ids.push(p?.id || null);
    if (p?.id) prev = p.id;
  }
  return { index: index?.id || null, ids };
}

module.exports = {
  WCG_X_ID, weigh, uploadMedia, postTweet, postSingle, postThread,
  getAuthedAccount, assertOwner,
  tweetUrl: (id) => (id ? `https://x.com/wcgbk/status/${id}` : null),
};
