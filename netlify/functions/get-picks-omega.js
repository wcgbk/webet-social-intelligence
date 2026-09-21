// get-picks-omega.js
// API endpoint: GET /.netlify/functions/get-picks-omega
// Live card (no ?date=): newest edge-picks-omega date with real picks, ≤ tomorrow ET
// (Mon evening can serve the already-generated Tue card). Sticky fallback keeps the
// most recent prior day with picks when today/tomorrow is missing or empty noPlays —
// never blank the page at midnight before the morning cron.
// Optional: ?date=YYYY-MM-DD (sticky to prior day with picks unless ?forceEmpty=1).

const { publicPicksPayload } = require('./lib/public-picks');
const {
  todayET,
  tomorrowET,
  isISODate,
  hasRealPicks,
  normalizeDateList,
  liveTryDates,
  stickyTryDates,
  resolveCard,
} = require('./lib/omega-live-date');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const STORE_NAME = 'edge-picks-omega';
const SITE_ID_DEFAULT = '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

function liveCacheHeaders(isGenerating) {
  const age = isGenerating ? 10 : 60;
  return { ...CORS, 'Cache-Control': `public, max-age=${age}, s-maxage=${age}, stale-while-revalidate=300, must-revalidate` };
}

function emptyPayload(dateKey, message) {
  return {
    error: false,
    noPlays: message,
    date: dateKey,
    picks: [],
    rejections: [],
    summary: { totalPicks: 0, totalUnits: '0u', aplusLocks: 0, sportsCovered: [] },
  };
}

function generatingPayload(dateKey) {
  return emptyPayload(dateKey, "Today's card is generating. Check back by 11:00am ET.");
}

function stripPremium(picksData) {
  return publicPicksPayload(picksData);
}

function truthyParam(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

async function listDatesFromSdk(store) {
  const out = [];
  try {
    const dates = await store.get('picks-dates', { type: 'json' });
    if (Array.isArray(dates)) out.push(...dates);
  } catch (_) {}
  try {
    const latest = await store.get('latest-date');
    if (latest) out.push(String(latest).trim());
  } catch (_) {}
  return normalizeDateList(out);
}

async function listDatesFromRest(baseUrl, authHeaders) {
  const out = [];
  try {
    const datesResp = await fetch(`${baseUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) {
      const dates = await datesResp.json();
      if (Array.isArray(dates)) out.push(...dates);
    }
  } catch (_) {}
  try {
    const latestResp = await fetch(`${baseUrl}/latest-date`, { headers: authHeaders });
    if (latestResp.ok) {
      const latest = (await latestResp.text()).trim();
      if (latest) out.push(latest);
    }
  } catch (_) {}
  return normalizeDateList(out);
}

function okBody(picksData, generating) {
  return {
    statusCode: 200,
    headers: liveCacheHeaders(!!generating),
    body: JSON.stringify(stripPremium(picksData)),
  };
}

function emptyBody(dateKey, message, generating) {
  return {
    statusCode: 200,
    headers: liveCacheHeaders(!!generating),
    body: JSON.stringify(emptyPayload(dateKey, message)),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedDate = params.date;
    const historical = isISODate(requestedDate);
    const forceEmpty = truthyParam(params.forceEmpty);

    const serveResolved = async (loadPicks, knownDates) => {
      if (historical && forceEmpty) {
        const picksData = await loadPicks(requestedDate);
        if (!picksData) {
          return emptyBody(requestedDate, `No Omega picks found for ${requestedDate}.`, false);
        }
        return okBody(picksData, false);
      }

      if (historical) {
        const tryDates = stickyTryDates(knownDates, requestedDate);
        const resolved = await resolveCard(tryDates, loadPicks, { requirePicks: true });
        if (resolved && hasRealPicks(resolved.picksData)) {
          return okBody(resolved.picksData, false);
        }
        // Honest empty for the requested date when nothing sticky works.
        if (resolved && resolved.dateKey === requestedDate) {
          return okBody(resolved.picksData, false);
        }
        return emptyBody(requestedDate, `No Omega picks found for ${requestedDate}.`, false);
      }

      // Live: newest ≤ tomorrow ET with real picks; sticky prior if empty.
      const tryDates = liveTryDates(knownDates);
      const resolved = await resolveCard(tryDates, loadPicks, { requirePicks: true });
      if (resolved && hasRealPicks(resolved.picksData)) {
        return okBody(resolved.picksData, false);
      }
      // No card with picks yet — honest generating empty for today.
      return emptyBody(todayET(), "Today's card is generating. Check back by 11:00am ET.", true);
    };

    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore(STORE_NAME);

      const loadPicks = async (dateKey) => store.get(`picks-${dateKey}`, { type: 'json' });
      const knownDates = await listDatesFromSdk(store);
      return await serveResolved(loadPicks, knownDates);
    } catch (blobErr) {
      console.error('[get-picks-omega] Blobs SDK error:', blobErr.message);

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || SITE_ID_DEFAULT;

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/${STORE_NAME}`;
        const authHeaders = { Authorization: `Bearer ${token}` };
        const loadPicks = async (dateKey) => {
          try {
            const pr = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
            if (!pr.ok) return null;
            return await pr.json();
          } catch (_) {
            return null;
          }
        };
        const knownDates = await listDatesFromRest(baseUrl, authHeaders);
        return await serveResolved(loadPicks, knownDates);
      }

      return emptyBody(todayET(), "Today's card is generating. Check back by 11:00am ET.", true);
    }
  } catch (err) {
    console.error('[get-picks-omega] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Failed to fetch Omega picks' }),
    };
  }
};

// Exported for unit tests (resolver pure helpers live in lib/omega-live-date).
module.exports.todayET = todayET;
module.exports.tomorrowET = tomorrowET;
module.exports.hasRealPicks = hasRealPicks;
module.exports.liveTryDates = liveTryDates;
module.exports.stickyTryDates = stickyTryDates;
