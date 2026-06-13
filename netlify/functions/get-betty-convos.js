// get-betty-convos.js — Admin endpoint: returns all Betty SMS conversations
// GET /api/get-betty-convos — lists all conversations
// GET /api/get-betty-convos?phone=19178550103 — single conversation

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  // Simple admin auth — check for admin key
  const params = event.queryStringParameters || {};
  const key = params.key;
  const secret = process.env.PICKS_SECRET_KEY;
  if (secret && key !== secret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const phone = params.phone;

    if (phone) {
      // Fetch single conversation
      const url = "https://api.netlify.com/api/v1/blobs/" + SITE_ID + "/betty-conversations/" + phone.replace(/\D/g, "");
      const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (!resp.ok) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) };
      const data = await resp.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // List all conversations — fetch from Blobs list API
    const listUrl = "https://api.netlify.com/api/v1/blobs/" + SITE_ID + "/betty-conversations?prefix=";
    const listResp = await fetch(listUrl, { headers: { Authorization: "Bearer " + token } });

    if (!listResp.ok) {
      // Fallback: try the Blobs SDK list
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("betty-conversations");
        const { blobs } = await store.list();
        const convos = [];
        for (const blob of blobs.slice(0, 50)) {
          try {
            const convo = await store.get(blob.key, { type: "json" });
            if (convo && convo.messages && convo.messages.length > 0) {
              convos.push({
                phone: convo.phone || blob.key,
                key: blob.key,
                messageCount: convo.messages.length,
                lastMessage: convo.messages[convo.messages.length - 1],
                started: convo.started || convo.messages[0]?.ts,
              });
            }
          } catch (_) {}
        }
        convos.sort(function(a, b) {
          var ta = a.lastMessage?.ts || "";
          var tb = b.lastMessage?.ts || "";
          return tb.localeCompare(ta);
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ conversations: convos }) };
      } catch (e) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Cannot list conversations: " + e.message }) };
      }
    }

    const blobs = await listResp.json();
    // Fetch each conversation's metadata
    const convos = [];
    const keys = (blobs.blobs || blobs || []).slice(0, 50);
    for (const blob of keys) {
      const blobKey = blob.key || blob;
      try {
        const cUrl = "https://api.netlify.com/api/v1/blobs/" + SITE_ID + "/betty-conversations/" + blobKey;
        const cResp = await fetch(cUrl, { headers: { Authorization: "Bearer " + token } });
        if (cResp.ok) {
          const convo = await cResp.json();
          if (convo && convo.messages && convo.messages.length > 0) {
            convos.push({
              phone: convo.phone || blobKey,
              key: blobKey,
              messageCount: convo.messages.length,
              lastMessage: convo.messages[convo.messages.length - 1],
              started: convo.started || convo.messages[0]?.ts,
            });
          }
        }
      } catch (_) {}
    }
    convos.sort(function(a, b) {
      var ta = a.lastMessage?.ts || "";
      var tb = b.lastMessage?.ts || "";
      return tb.localeCompare(ta);
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ conversations: convos }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
