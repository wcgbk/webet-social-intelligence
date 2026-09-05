// get-picks-nfl.js
// API endpoint: GET /api/get-picks-nfl
// Returns today's NFL card from edge-picks-nfl. Off days (or a missing today blob)
// return "No NFL Games Scheduled For Today" — never the last game day's card.
// Optional: ?date=YYYY-MM-DD for historical picks.

const { publicPicksPayload } = require('./lib/public-picks');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const NO_GAMES_MSG = "No NFL Games Scheduled For Today";

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

function formatDateLong(dateISO) {
  return new Date(dateISO + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function stripPremium(picksData) {
  return publicPicksPayload(picksData);
}

function emptyPayload(dateKey, msg) {
  return {
    error: false,
    noPlays: msg || NO_GAMES_MSG,
    noGames: /No NFL Games Scheduled/i.test(msg || NO_GAMES_MSG),
    date: dateKey || getEasternDateToday(),
    dateFormatted: formatDateLong(dateKey || getEasternDateToday()),
    picks: [],
    rejections: [],
    parlayLegs: [],
    summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
  };
}

async function readBlobRest(baseUrl, authHeaders, key, asJson) {
  const resp = await fetch(`${baseUrl}/${key}`, { headers: authHeaders });
  if (!resp.ok) return null;
  return asJson ? resp.json() : (await resp.text()).trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedDate = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : null;
    const today = getEasternDateToday();
    const dateKey = requestedDate || today;

    const okHeaders = { ...CORS, 'Cache-Control': 'public, max-age=60, s-maxage=60' };

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("edge-picks-nfl");
      const picksData = await store.get(`picks-${dateKey}`, { type: "json" });
      if (picksData) {
        const cache = (picksData.picks && picksData.picks.length) ? 'public, max-age=120, s-maxage=120, stale-while-revalidate=600' : 'public, max-age=60, s-maxage=60';
        return { statusCode: 200, headers: { ...CORS, 'Cache-Control': cache }, body: JSON.stringify(stripPremium(picksData)) };
      }
      if (requestedDate) {
        return { statusCode: 200, headers: okHeaders, body: JSON.stringify({ ...emptyPayload(dateKey, `No NFL picks found for ${dateKey}.`), noGames: false }) };
      }
      return { statusCode: 200, headers: okHeaders, body: JSON.stringify(emptyPayload(today, NO_GAMES_MSG)) };
    } catch (blobErr) {
      console.error("[get-picks-nfl] Blobs SDK error:", blobErr.message);

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-nfl`;
        const authHeaders = { "Authorization": `Bearer ${token}` };
        try {
          const data = await readBlobRest(baseUrl, authHeaders, `picks-${dateKey}`, true);
          if (data) {
            const cache = (data.picks && data.picks.length) ? 'public, max-age=120, s-maxage=120, stale-while-revalidate=600' : 'public, max-age=60, s-maxage=60';
            return { statusCode: 200, headers: { ...CORS, 'Cache-Control': cache }, body: JSON.stringify(stripPremium(data)) };
          }
        } catch (e) {}
      }

      if (requestedDate) {
        return { statusCode: 200, headers: okHeaders, body: JSON.stringify({ ...emptyPayload(dateKey, `No NFL picks found for ${dateKey}.`), noGames: false }) };
      }
      return { statusCode: 200, headers: okHeaders, body: JSON.stringify(emptyPayload(today, NO_GAMES_MSG)) };
    }
  } catch (err) {
    console.error("[get-picks-nfl] Error:", err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch NFL picks" }),
    };
  }
};
