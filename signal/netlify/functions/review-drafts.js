// Approval dashboard backend for THE SIGNAL.
//   GET  ?key=…            → { pending:[…], recent:[…] }  (drafts + their images)
//   POST {action,id,key}   → approve (posts to X) | reject (marks rejected) | edit (replace text)
//   GET  ?whoami=1&key=…   → which X account the creds post as (diagnostic)
// Gated by REVIEW_KEY (falls back to TRIGGER_SECRET). The cron functions never need this —
// this endpoint exists only for the human-in-the-loop hybrid approval step.
const { connectLambda } = require("@netlify/blobs");
const { blobStore, postApproved } = require("./lib/engine.js");
const X = require("./lib/x.js");

function authed(event) {
  const q = (event && event.queryStringParameters) || {};
  const h = (event && event.headers) || {};
  const key = q.key || h["x-review-key"];
  const secret = process.env.REVIEW_KEY || process.env.TRIGGER_SECRET;
  return !!secret && key === secret;
}

async function listDrafts() {
  const store = blobStore("signal");
  let keys = [];
  try {
    const res = await store.list({ prefix: "draft:" });
    keys = (res.blobs || []).map((b) => b.key);
  } catch { /* */ }
  const drafts = [];
  for (const k of keys) {
    const d = await store.get(k, { type: "json" }).catch(() => null);
    if (d) drafts.push({ id: k, ...d });
  }
  drafts.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return drafts;
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch { /* */ }
  const headers = { "Content-Type": "application/json" };
  const q = (event && event.queryStringParameters) || {};

  if (!authed(event)) return { statusCode: 401, headers, body: JSON.stringify({ error: "unauthorized — append ?key=REVIEW_KEY" }) };

  // diagnostic: which account will we post as?
  if (q.whoami) {
    if (!process.env.X_ACCESS_TOKEN) return { statusCode: 412, headers, body: JSON.stringify({ error: "X tokens not configured" }) };
    try {
      const acct = await X.getAuthedAccount();
      return { statusCode: 200, headers, body: JSON.stringify({ handle: "@" + acct.username, id: acct.id, name: acct.name, isWcgbk: acct.id === X.WCG_X_ID }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: String(e).slice(0, 200) }) };
    }
  }

  if (event.httpMethod === "POST") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { /* */ }
    const { action, id, text } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "missing id" }) };
    const store = blobStore("signal");
    try {
      if (action === "approve") {
        const res = await postApproved(id);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...res }) };
      }
      if (action === "reject") {
        const d = await store.get(id, { type: "json" }).catch(() => null);
        if (d) { d.status = "rejected"; await store.setJSON(id, d); }
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rejected: id }) };
      }
      if (action === "edit") {
        const d = await store.get(id, { type: "json" }).catch(() => null);
        if (!d) return { statusCode: 404, headers, body: JSON.stringify({ error: "not found" }) };
        if (d.kind === "thread" && Array.isArray(text)) d.tweets = text;
        else if (typeof text === "string") d.text = text;
        await store.setJSON(id, d);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, edited: id }) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown action" }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(e).slice(0, 300) }) };
    }
  }

  // GET list
  const all = await listDrafts();
  const pending = all.filter((d) => d.status === "pending");
  const recent = all.filter((d) => d.status !== "pending").slice(0, 20);
  return { statusCode: 200, headers, body: JSON.stringify({ pending, recent }) };
};
