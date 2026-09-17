// get-picks-circa.js
// API: GET /api/get-picks-circa  (optional ?week=2026-W01 or ?week=1)
// Reads edge-picks-circa. If this contest week has no blob / empty picks, return
// a pending payload — never CFB, never a stale sample card.
// On read, grades NFL ATS vs the Circa number in each pick (ESPN scoreboard),
// refreshes week KPIs, and patches result/score fields back to the blob when
// NETLIFY_AUTH_TOKEN or the Blobs SDK is available — never wipes the live card.

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
const {
  gradeCircaPayload,
  mergeGradeIntoCard,
  cacheControlFor,
} = require("./lib/circa-live-grade");

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
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const live = hasLivePicks(data);
  const weeksSrc = Array.isArray(data.weeks) && data.weeks.length ? data.weeks.map((w) => ({ ...w })) : defaultWeeks(weekNum);
  if (live) {
    const cur = weeksSrc.find((w) => w.current) || weeksSrc.find((w) => {
      const m = String(w.label || "").match(/week\s*(\d+)/i);
      return m && Number(m[1]) === Number(weekNum);
    });
    if (cur) {
      const st = String(cur.status || "").toLowerCase();
      if (st !== "completed" && st !== "graded" && st !== "final") cur.status = "live";
    }
  }
  const realError = !live && !!data.error;
  return {
    preview: live ? false : !!data.preview,
    pending: !live,
    contest: data.contest || CONTEST.name,
    weekLabel: data.weekLabel || pendingPayload(weekInfo).weekLabel,
    dateFormatted: data.dateFormatted || pendingPayload(weekInfo).dateFormatted,
    deadline: data.deadline || pendingPayload(weekInfo).deadline,
    strategy: data.strategy || pendingPayload(weekInfo).strategy,
    week: data.week || weekInfo.week,
    weekNum,
    picks,
    kpis: data.kpis || defaultKpis(),
    weeks: visibleWeeks(weeksSrc, picks),
    modelVersion: data.modelVersion || data.model || CONTEST.modelVersion,
    generatedAt: data.generatedAt || null,
    // Never echo a stale pendingMessage once the card has live picks.
    pendingMessage: live ? null : (data.pendingMessage || pendingPayload(weekInfo).pendingMessage),
    noPlays: live ? null : (data.noPlays || null),
    lineSourceNote: data.lineSourceNote || null,
    lineSource: data.lineSource || null,
    sourceUrl: data.sourceUrl || null,
    rulesUrl: data.rulesUrl || CONTEST.rulesUrl,
    error: realError,
    errorCode: realError ? (data.errorCode || null) : null,
    errorMessage: realError ? (data.errorMessage || null) : null,
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

async function writeBlob(store, key, data) {
  if (store) {
    try {
      await store.setJSON(key, data);
      return true;
    } catch (e) {
      console.log(`[get-picks-circa] store.setJSON ${key} failed: ${e.message}`);
    }
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return false;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${CONTEST.storeName}/${key}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      console.log(`[get-picks-circa] blob PUT ${key} failed ${resp.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`[get-picks-circa] blob PUT ${key} error: ${e.message}`);
    return false;
  }
}

// Persist graded result/score + kpis/weeks only. Never replace the live card.
async function persistGrade(store, weekStr, existing, graded) {
  if (!existing || !Array.isArray(existing.picks) || existing.picks.length === 0) return false;
  const patched = mergeGradeIntoCard(existing, graded);
  if (!patched || !patched.picks || patched.picks.length === 0) return false;
  const key = weekBlobKey(weekStr);
  const okWeek = await writeBlob(store, key, patched);
  try {
    let latestWeek = null;
    if (store) {
      try { latestWeek = await store.get("latest-week"); } catch (e) {}
    }
    if (latestWeek == null) latestWeek = await readBlobRest("latest-week", false);
    if (!latestWeek || String(latestWeek).trim() === weekStr) {
      await writeBlob(store, "latest", patched);
    }
  } catch (e) {}
  return okWeek;
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
      let graded = data;
      try {
        graded = await gradeCircaPayload(data);
      } catch (e) {
        console.error(`[get-picks-circa] ESPN grade failed: ${e.message}`);
        graded = data;
      }
      const payload = normalizePayload(graded, weekInfo);
      payload.pending = false;
      payload.preview = false;
      if (graded && graded._grade && graded._grade.changed && (store || process.env.NETLIFY_AUTH_TOKEN)) {
        try {
          await persistGrade(store, weekInfo.week, data, graded);
        } catch (e) {
          console.error(`[get-picks-circa] persist grade failed: ${e.message}`);
        }
      }
      return ok(payload, cacheControlFor(payload));
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
