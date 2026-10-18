// Circa card-health ops snapshot (edge-picks-circa store).
// Mirrors Omega capture-health pattern: persist latest + dated blob, read-only GET.
// Circa-only — does not touch Omega/Alpha.
// WeBet Circa Grok Bot polls the circa-ops health blobs; this module has no chat notifier.

"use strict";

const { CONTEST, resolveContestWeek, weekKey, circaCronSlot } = require("./circa-contest");

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = CONTEST.storeName;
const HEALTH_LATEST = "circa-ops/card-health-latest";
const HEALTH_ALERT = "circa-ops/card-health-alert";

function healthDateKey(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  return `circa-ops/card-health-${iso}`;
}

function blobAuth() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  return {
    storeUrl: `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`,
    auth: { Authorization: `Bearer ${token}` },
  };
}

async function putBlob(key, body) {
  const b = blobAuth();
  if (!b) return false;
  try {
    const resp = await fetch(`${b.storeUrl}/${key}`, {
      method: "PUT",
      headers: { ...b.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

async function readBlob(key) {
  const b = blobAuth();
  if (!b) return null;
  try {
    const resp = await fetch(`${b.storeUrl}/${key}`, { headers: b.auth });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function writeCircaCardHealth(snap) {
  const now = new Date();
  const payload = {
    ok: snap.status === "ok",
    status: snap.status || "unknown",
    errorCode: snap.errorCode || null,
    errorMessage: snap.errorMessage || null,
    weekNum: snap.weekNum || null,
    week: snap.week || null,
    picksCount: snap.picksCount != null ? snap.picksCount : null,
    slot: snap.slot || null,
    source: snap.source || "unknown",
    lineSource: snap.lineSource || null,
    fromFixture: snap.fromFixture != null ? !!snap.fromFixture : null,
    sourceUrl: snap.sourceUrl || null,
    checkedAt: now.toISOString(),
    opsOnly: true,
  };
  await putBlob(HEALTH_LATEST, payload);
  await putBlob(healthDateKey(now), payload);
  if (payload.status !== "ok") {
    await putBlob(HEALTH_ALERT, payload);
  }
  return payload;
}

/**
 * Health-check cron windows: ~5 minutes after each Circa generate slot
 * (Thu/Fri/Sat + holiday Wed) so the background generate has time to finish.
 */
function circaHealthCronSlot(now = new Date(), slackMin = 8) {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const near = (h, m) => Math.abs(mins - (h * 60 + m)) <= slackMin;
  // Generate slots: Thu 17:15/30/45 18:00 → check 17:20/35/50 18:05
  if (day === 4 && (near(17, 20) || near(17, 35) || near(17, 50) || near(18, 5))) return "first-check";
  // Fri 17:00/15/30/45 → check 17:05/20/35/50
  if (day === 5 && (near(17, 5) || near(17, 20) || near(17, 35) || near(17, 50))) return "refresh-check";
  // Sat 20:00 → check 20:05
  if (day === 6 && near(20, 5)) return "final-check";
  // Holiday Wed 17:15 → check 17:20
  if (day === 3 && near(17, 20)) return "holiday-check";
  return null;
}

function evaluateCardHealth(card, weekInfo) {
  if (!card || typeof card !== "object") {
    return {
      status: "error",
      errorCode: "circa-card-missing",
      errorMessage: "No Circa card blob for this contest week",
      picksCount: 0,
    };
  }
  const picks = Array.isArray(card.picks) ? card.picks : [];
  if (card.error || card.errorCode) {
    return {
      status: "error",
      errorCode: card.errorCode || "circa-card-error",
      errorMessage: card.errorMessage || card.pendingMessage || "Circa card stored with error",
      picksCount: picks.length,
    };
  }
  if (card.pending || picks.length === 0) {
    return {
      status: "error",
      errorCode: card.errorCode || "circa-card-pending",
      errorMessage: card.pendingMessage || card.noPlays || "Circa card pending/empty",
      picksCount: picks.length,
    };
  }
  if (picks.length < 5) {
    return {
      status: "error",
      errorCode: "circa-card-incomplete",
      errorMessage: `Circa card has ${picks.length} pick(s); expected 5`,
      picksCount: picks.length,
    };
  }
  return {
    status: "ok",
    errorCode: null,
    errorMessage: null,
    picksCount: picks.length,
  };
}


module.exports = {
  HEALTH_LATEST,
  HEALTH_ALERT,
  healthDateKey,
  writeCircaCardHealth,
  readCircaCardHealthLatest: () => readBlob(HEALTH_LATEST),
  readCircaCardHealthAlert: () => readBlob(HEALTH_ALERT),
  readCircaCardHealthDate: (iso) => readBlob(`circa-ops/card-health-${iso}`),
  circaHealthCronSlot,
  evaluateCardHealth,
  readBlob,
  putBlob,
  STORE_NAME,
};
