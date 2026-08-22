// grok-beta-status.js — admin card on /dashboard

const { getVersion } = require("../../lib/grok-beta/version");
const { readStatus, readPublished } = require("../../lib/grok-beta/store");
const { easternDateISO } = require("../../lib/grok-beta/adapters");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const today = easternDateISO(new Date());
  const status = (await readStatus()) || {};
  const published = await readPublished(today);
  return {
    statusCode: 200,
    headers: { ...CORS, "Cache-Control": "no-store" },
    body: JSON.stringify({
      status: status.ok === false ? "blocked" : (published ? "active" : "idle"),
      lastRun: status.lastRun || null,
      date: status.date || today,
      picksToday: published && published.picks ? published.picks.length : (status.picksToday || 0),
      candidateCount: status.candidateCount || 0,
      gamesScanned: status.gamesScanned || 0,
      version: status.version || getVersion(),
      sportsScanned: status.sportsScanned || [],
    }),
  };
};
