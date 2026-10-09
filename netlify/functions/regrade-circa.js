// regrade-circa.js — scheduled hourly (:40). Circa ops only (never Omega).
// Re-polls ESPN for every non-final pick on the frozen Saturday final cards
// (weeks 1..current), persists frozen-grade-* results, and writes
// circa-ops/stuck-game-alert if any game is still not final 6h after kickoff.
// Never regenerates or rewrites a card; frozen-card-* blobs are never overwritten.

const { CONTEST, resolveContestWeek, weekBlobKey } = require("./lib/circa-contest");
const { buildSeason, writeStuckAlert } = require("./lib/circa-season");

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

async function makeIo() {
  let store = null;
  try {
    const { getStore } = await import("@netlify/blobs");
    store = getStore(CONTEST.storeName);
  } catch (e) {}
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = (k) => `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${CONTEST.storeName}/${k}`;
  return {
    read: async (key) => {
      if (store) {
        try { const v = await store.get(key, { type: "json" }); if (v) return v; } catch (e) {}
      }
      if (!token) return null;
      try {
        const r = await fetch(url(key), { headers: { Authorization: `Bearer ${token}` } });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    },
    write: async (key, value) => {
      if (store) {
        try { await store.setJSON(key, value); return true; } catch (e) {}
      }
      if (!token) return false;
      try {
        const r = await fetch(url(key), {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        return r.ok;
      } catch (e) { return false; }
    },
  };
}

exports.handler = async () => {
  const now = new Date();
  const cur = resolveContestWeek(now);
  if (cur.preSeason) return { statusCode: 200, body: "Circa regrade no-op (pre-season)" };
  const io = await makeIo();
  const currentCard = await io.read(weekBlobKey(cur.weekNum));
  const season = await buildSeason(io, { currentWeekNum: cur.weekNum, currentCard, now });
  if (season.alerts.length) await writeStuckAlert(io, season.alerts, now);
  const summary = {
    ok: true,
    week: cur.weekNum,
    seasonTotal: { points: season.seasonTotal.points, record: season.seasonTotal.record },
    alerts: season.alerts.length,
  };
  console.log(`[regrade-circa] ${JSON.stringify(summary)}`);
  return { statusCode: 200, body: JSON.stringify(summary) };
};
