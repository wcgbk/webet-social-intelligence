// get-picks-circa.js
// API: GET /api/get-picks-circa  (optional ?week=2026-W01 or ?week=1)
// Reads edge-picks-circa. If this contest week has no blob / empty picks, return
// a pending payload — never CFB, never a stale sample card.

const {
  CONTEST,
  parseWeekQuery,
  resolveContestWeek,
  pendingPayload,
  weekBlobKey,
  defaultKpis,
  defaultWeeks,
  visibleWeeks,
} = require("./lib/circa-contest");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

function ok(body, cache) {
  return {
    statusCode: 200,
    headers: { ...CORS, "Cache-Control": cache || "public, max-age=60, s-maxage=60" },
    body: JSON.stringify(body),
  };
}

function hasLivePicks(data) {
  return !!(data && Array.isArray(data.picks) && data.picks.length > 0 && data.preview !== true);
}

function normalizePayload(data, weekInfo) {
  if (!data || typeof data !== "object") return pendingPayload(weekInfo);
  const weekNum = data.weekNum || weekInfo.weekNum;
  return {
    preview: !!data.preview,
    pending: !hasLivePicks(data),
    error: false,
    contest: data.contest || CONTEST.name,
    weekLabel: data.weekLabel || pendingPayload(weekInfo).weekLabel,
    dateFormatted: data.dateFormatted || pendingPayload(weekInfo).dateFormatted,
    deadline: data.deadline || pendingPayload(weekInfo).deadline,
    strategy: data.strategy || pendingPayload(weekInfo).strategy,
    week: data.week || weekInfo.week,
    weekNum,
    picks: Array.isArray(data.picks) ? data.picks : [],
    kpis: data.kpis || defaultKpis(),
    weeks: visibleWeeks(
      Array.isArray(data.weeks) && data.weeks.length ? data.weeks : defaultWeeks(weekNum),
      Array.isArray(data.picks) ? data.picks : []
    ),
    modelVersion: data.modelVersion || data.model || CONTEST.modelVersion,
    generatedAt: data.generatedAt || null,
    pendingMessage: data.pendingMessage || pendingPayload(weekInfo).pendingMessage,
    lineSourceNote: data.lineSourceNote || null,
    lineSource: data.lineSource || null,
    sourceUrl: data.sourceUrl || null,
    rulesUrl: data.rulesUrl || CONTEST.rulesUrl,
    error: !!data.error,
    errorCode: data.errorCode || null,
    errorMessage: data.errorMessage || null,
  };
}

async function readBlobRest(key, asJson) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${CONTEST.storeName}/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return asJson ? resp.json() : (await resp.text()).trim();
}

async function readWeek(store, week) {
  const key = weekBlobKey(week);
  if (store) {
    try {
      const data = await store.get(key, { type: "json" });
      if (data) return data;
    } catch (e) {}
  }
  try {
    return await readBlobRest(key, true);
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    const params = event.queryStringParameters || {};
    const parsed = parseWeekQuery(params.week);
    const current = resolveContestWeek();
    const weekInfo = parsed || current;

    let store = null;
    try {
      const { getStore } = await import("@netlify/blobs");
      store = getStore(CONTEST.storeName);
    } catch (e) {
      console.log(`[get-picks-circa] Blobs SDK unavailable: ${e.message}`);
    }

    const data = await readWeek(store, weekInfo.week);
    if (hasLivePicks(data)) {
      const payload = normalizePayload(data, weekInfo);
      payload.pending = false;
      payload.preview = false;
      return ok(payload, "public, max-age=120, s-maxage=120, stale-while-revalidate=600");
    }

    // No live card for this week — pending empty state (do not fall back to another week's picks).
    const pending = pendingPayload(weekInfo, {
      kpis: (data && data.kpis) || defaultKpis(),
      weeks: (data && data.weeks) || defaultWeeks(weekInfo.weekNum),
      picks: (data && data.picks) || [],
    });
    return ok(pending);
  } catch (err) {
    console.error("[get-picks-circa] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch Circa picks" }),
    };
  }
};

exports.normalizePayload = normalizePayload;
exports.hasLivePicks = hasLivePicks;
