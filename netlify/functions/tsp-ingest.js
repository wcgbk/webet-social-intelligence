// tsp-ingest.js
// POST /.netlify/functions/tsp-ingest (alias /api/tsp-ingest)
// Receives the FULL TSP.Live Hermes card from Ben's Grok Bot "TSP Live" agent every time it
// drops or grades a pick, and stores it (day-keyed, ET) in the isolated `tsp-live-picks` store.
// The bot POSTs the whole card each time (not a delta) — settlements arrive as `finalWL` on the
// same selections — so each POST REPLACES that day's card.
//
// Auth: `Authorization: Bearer <secret>` must match env TSP_INGEST_SECRET (falls back to the
// existing PICKS_SECRET_KEY so no new env var is strictly required; fails closed if neither set).
// Payload: { source, dateET, fetchedAt, unitSize, selections:[ {sport,event,pick,odds,units,
//            score,label,timeET,notes,finalWL} ] }.  Returns 200 { ok:true, count:N }.
//
// PRIVATE feed — TSP.Live is paid membership content. The reader (get-tsp-live-picks) is
// key-gated server-side; this data must never be exposed publicly.
// Storage: Netlify Blobs REST API (the SDK is unavailable on git-based deploys of this site —
// nft bundling with no root package.json — so all functions use REST, like alpha/omega/grok-bot).

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/tsp-live-picks`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SEL_STR = ['sport', 'league', 'event', 'pick', 'odds', 'line', 'label', 'timeET', 'gameTimeET', 'notes', 'finalWL', 'result'];
const MAX_SEL = 60;

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function normSel(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const f of SEL_STR) {
    if (s[f] === undefined || s[f] === null) continue;
    const v = String(s[f]).trim();
    if (v) out[f] = v.slice(0, 240);
  }
  if (s.units !== undefined && s.units !== null && isFinite(Number(s.units))) {
    out.units = Math.max(0, Math.min(25, Number(s.units)));
  }
  if (s.score !== undefined && s.score !== null && isFinite(Number(s.score))) {
    out.score = Number(s.score);
  }
  return out;
}

function parseBearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: true, message: 'POST only' }) };
  }

  const secret = process.env.TSP_INGEST_SECRET || process.env.PICKS_SECRET_KEY;
  if (!secret) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, message: 'Ingest not configured (TSP_INGEST_SECRET unset)' }) };
  }
  if (parseBearer(event) !== secret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };
  }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Storage not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'Invalid JSON body' }) };
  }

  const selectionsIn = Array.isArray(body.selections) ? body.selections : [];
  if (!selectionsIn.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'selections[] required' }) };
  }

  const dateKey = (body.dateET && /^\d{4}-\d{2}-\d{2}$/.test(body.dateET)) ? body.dateET : getEasternDateToday();
  const selections = selectionsIn.slice(0, MAX_SEL).map(normSel).filter((s) => s.pick);
  if (!selections.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'No selection had a "pick" field' }) };
  }

  const record = {
    source: body.source ? String(body.source).slice(0, 60) : 'TSP Live',
    dateET: dateKey,
    fetchedAt: body.fetchedAt || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    unitSize: (body.unitSize != null && isFinite(Number(body.unitSize))) ? Number(body.unitSize) : null,
    selections,
  };

  try {
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    const putResp = await fetch(`${STORE_URL}/picks-${dateKey}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!putResp.ok) {
      const errBody = await putResp.text();
      console.error(`[tsp-ingest] Blob PUT failed ${putResp.status}: ${errBody.substring(0, 200)}`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to store card' }) };
    }

    await fetch(`${STORE_URL}/latest-date`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'text/plain' },
      body: dateKey,
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: selections.length, dateET: dateKey }) };
  } catch (err) {
    console.error('[tsp-ingest] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to store card' }) };
  }
};
