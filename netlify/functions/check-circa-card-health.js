// check-circa-card-health.js
// Follow-up checker after Circa generate cron slots (Thu/Fri/Sat + holiday).
// If the week card is pending/empty/error or has fewer than 5 picks, persist
// alert blob (errorCode); WeBet Circa Grok Bot polls the circa-ops health blobs.

"use strict";

const {
  CONTEST,
  resolveContestWeek,
  weekKey,
  weekBlobKey,
} = require("./lib/circa-contest");
const {
  circaHealthCronSlot,
  evaluateCardHealth,
  writeCircaCardHealth,
  readBlob,
  STORE_NAME,
} = require("./lib/circa-card-health");

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

async function readCard(weekStr) {
  const key = weekBlobKey(weekStr);
  let card = await readBlob(key);
  if (card) return card;
  // REST fallback already inside readBlob; try latest if week matches
  const latest = await readBlob("latest");
  if (latest && (latest.week === weekStr || latest.weekNum === Number(String(weekStr).replace(/\D/g, "")))) {
    return latest;
  }
  return null;
}

exports.handler = async (event) => {
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {}
  const now = new Date();
  const slot = circaHealthCronSlot(now);
  if (!body.force && !slot) {
    console.log(`[circa-health] Outside health-check window (${now.toISOString()}) — no-op.`);
    return { statusCode: 200, body: "Circa health check no-op" };
  }

  const resolved = resolveContestWeek(now);
  const weekNum = resolved.weekNum;
  const week = resolved.week || weekKey(weekNum);
  if (resolved.preSeason || resolved.postSeason || weekNum < 1 || weekNum > CONTEST.totalWeeks) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "outside NFL season", week }) };
  }

  const card = await readCard(week);
  const evald = evaluateCardHealth(card, { weekNum, week });
  const health = await writeCircaCardHealth({
    weekNum,
    week,
    status: evald.status,
    errorCode: evald.errorCode,
    errorMessage: evald.errorMessage,
    picksCount: evald.picksCount,
    slot: slot || body.slot || "manual",
    source: "health-check",
    lineSource: card && card.lineSource,
    fromFixture: card && card.fromFixture,
    sourceUrl: card && card.sourceUrl,
  });

  if (health.status !== "ok") {
    console.error(
      `[circa-health] ALERT week=${week} errorCode=${health.errorCode} picks=${health.picksCount}`
    );
  } else {
    console.log(`[circa-health] OK week=${week} picks=${health.picksCount}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: health.status === "ok",
      health,
      slot: slot || "force",
      store: STORE_NAME,
    }),
  };
};

module.exports.evaluateCardHealth = evaluateCardHealth;
module.exports.circaHealthCronSlot = circaHealthCronSlot;
