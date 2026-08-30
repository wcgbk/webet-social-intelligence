// live-ingest.js
// POST /.netlify/functions/live-ingest (alias /api/live-ingest)
// Receives the FULL live sportsbook card from Ben's "Live Sportsbook Picks" desktop agent every
// time it drops or grades a pick, and stores it (day-keyed, ET) in the isolated `live-picks` store.
// The agent POSTs the whole card each time (not a delta) — settlements arrive as `finalWL` on the
// same selections — so each POST REPLACES that day's card.
//
// Auth: `Authorization: Bearer <secret>` must match env LIVE_INGEST_SECRET (falls back to the
// existing PICKS_SECRET_KEY so no new env var is strictly required; fails closed if neither set).
// Payload: { source, dateET, fetchedAt, unitSize, selections:[ {sport,event,pick,odds,units,
//            score,label,timeET,notes,finalWL} ] }.  Returns 200 { ok:true, count:N }.
//
// PRIVATE feed. The reader (get-live-picks) is key-gated server-side; never expose publicly.
// Storage: Netlify Blobs REST API (the SDK is unavailable on git-based deploys of this site —
// nft bundling with no root package.json — so all functions use REST, like alpha/omega).

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/live-picks`;

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

// Stable identity for a pick across the day's re-POSTs (odds may drift, so exclude them).
function seqKey(s) {
  return [s.sport, s.event, s.pick].map((x) => (x == null ? '' : String(x)).toLowerCase().trim()).join('|');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: true, message: 'POST only' }) };
  }

  const secret = process.env.LIVE_INGEST_SECRET || process.env.PICKS_SECRET_KEY;
  if (!secret) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, message: 'Ingest not configured (LIVE_INGEST_SECRET unset)' }) };
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

  try {
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Merge a stable, monotonic firstSeq per pick so the page can show the most
    // recently-added picks at the top. Full-card POSTs re-send every pick each time;
    // a pick keeps the firstSeq it got when first seen, so new drops sort above older
    // ones and graded picks stay in place.
    let existingSeq = {}, maxSeq = 0;
    try {
      const readResp = await fetch(`${STORE_URL}/picks-${dateKey}`, { headers: authHeaders });
      if (readResp.ok) {
        const prev = await readResp.json().catch(() => null);
        if (prev && Array.isArray(prev.selections)) {
          prev.selections.forEach((p) => {
            const n = Number(p.firstSeq);
            if (isFinite(n)) { existingSeq[seqKey(p)] = n; if (n > maxSeq) maxSeq = n; }
          });
        }
      }
    } catch (e) { /* first write of the day / transient read failure → start fresh */ }

    selections.forEach((s) => {
      const k = seqKey(s);
      s.firstSeq = (existingSeq[k] != null) ? existingSeq[k] : ++maxSeq;
    });

    const record = {
      source: body.source ? String(body.source).slice(0, 60) : 'Live Sportsbook Picks',
      dateET: dateKey,
      fetchedAt: body.fetchedAt || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      unitSize: (body.unitSize != null && isFinite(Number(body.unitSize))) ? Number(body.unitSize) : null,
      selections,
    };

    const putResp = await fetch(`${STORE_URL}/picks-${dateKey}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!putResp.ok) {
      const errBody = await putResp.text();
      console.error(`[live-ingest] Blob PUT failed ${putResp.status}: ${errBody.substring(0, 200)}`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to store card' }) };
    }

    await fetch(`${STORE_URL}/latest-date`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'text/plain' },
      body: dateKey,
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: selections.length, dateET: dateKey }) };
  } catch (err) {
    console.error('[live-ingest] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to store card' }) };
  }
};
