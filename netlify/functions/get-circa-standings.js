// get-circa-standings.js
// API: GET /api/get-circa-standings?points=3.0
// Discovers latest Circa Million VIII Full Season (+ Last Place) standings PDFs,
// parses a compact points->place map, and returns WeBetAI place/prize estimate.

const { getStandings, CACHE_KEY } = require("./lib/circa-standings");
const { CONTEST } = require("./lib/circa-contest");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

function ok(body, cache) {
  return {
    statusCode: 200,
    headers: {
      ...CORS,
      "Cache-Control": cache || "public, max-age=120, s-maxage=300",
    },
    body: JSON.stringify(body),
  };
}

async function readBlobRest(key) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  const resp = await fetch(
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${CONTEST.storeName}/${key}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function writeBlobRest(key, value) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return false;
  const resp = await fetch(
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${CONTEST.storeName}/${key}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    }
  );
  return resp.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    const params = event.queryStringParameters || {};
    const points = params.points;

    let store = null;
    try {
      const { getStore } = await import("@netlify/blobs");
      store = getStore(CONTEST.storeName);
    } catch (e) {
      console.log(`[get-circa-standings] Blobs SDK unavailable: ${e.message}`);
    }

    const readBlob = async (key) => {
      if (store) {
        try {
          const v = await store.get(key, { type: "json" });
          if (v) return v;
        } catch (_) {
          /* fall through */
        }
      }
      return readBlobRest(key);
    };

    const writeBlob = async (key, value) => {
      if (store) {
        try {
          await store.setJSON(key, value);
          return true;
        } catch (e) {
          console.log(`[get-circa-standings] store.setJSON failed: ${e.message}`);
        }
      }
      return writeBlobRest(key, value);
    };

    const payload = await getStandings({ points, readBlob, writeBlob });
    if (payload.error) {
      return {
        statusCode: 503,
        headers: { ...CORS, "Cache-Control": "public, max-age=60" },
        body: JSON.stringify(payload),
      };
    }
    // Drop bulky bands from default response when points provided (keep rank).
    // Still include bands when ?bands=1 for debugging.
    if (points != null && params.bands !== "1") {
      const { bands, ...rest } = payload;
      return ok(rest);
    }
    return ok(payload, "public, max-age=300, s-maxage=900");
  } catch (err) {
    console.error("[get-circa-standings] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: true,
        message: "Failed to fetch Circa standings",
        displayName: "WeBetAI",
      }),
    };
  }
};

exports.CACHE_KEY = CACHE_KEY;
