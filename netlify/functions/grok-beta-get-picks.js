// grok-beta-get-picks.js
// GET published Grok Beta card only (grok-beta/published/{date}.json).
// Never reads edge-picks-alpha.

const { easternDateISO, formatDateLong } = require("../../lib/grok-beta/adapters");
const { getVersion } = require("../../lib/grok-beta/version");
const { readPublished, readLatestDate } = require("../../lib/grok-beta/store");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function empty(dateKey, msg) {
  return {
    error: false,
    noPlays: msg || "Grok Beta has not priced this slate yet.",
    date: dateKey,
    dateFormatted: formatDateLong(dateKey),
    modelVersion: getVersion(),
    picks: [],
    rejections: [],
    parlayLegs: [],
    summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
    record: { wins: 0, losses: 0, pushes: 0, roi: null, units: 0, n: 0 },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const params = event.queryStringParameters || {};
  const today = easternDateISO(new Date());
  const dateKey = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : today;

  try {
    const data = await readPublished(dateKey);
    if (data) {
      return {
        statusCode: 200,
        headers: { ...CORS, "Cache-Control": "public, max-age=30, s-maxage=30" },
        body: JSON.stringify(data),
      };
    }
    if (!params.date) {
      const latest = await readLatestDate();
      if (latest && latest === today) {
        const again = await readPublished(latest);
        if (again) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify(again) };
        }
      }
    }
    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=15, s-maxage=15" },
      body: JSON.stringify(empty(dateKey, "Grok Beta has not priced this slate yet.")),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(empty(dateKey, "Grok Beta has not priced this slate yet.")),
    };
  }
};
