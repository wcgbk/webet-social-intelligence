// grok-bot-webhook.js
// POST /api/grok-bot-webhook — receives a sportsbook pick from Ben's Grok bot the moment
// it posts one, and appends it to the isolated `grok-bot-picks` blob store (day-keyed, ET).
// Auth: x-grok-secret header must match env GROK_BOT_WEBHOOK_SECRET, falling back to the
// existing PICKS_SECRET_KEY so no new env var is required (fails closed if neither is set).
// Payload: JSON, `pick` required; sport/matchup/betType/odds/book/units/analysis/postUrl/id optional.
// Dedup: by caller-supplied id, else by sport+matchup+pick+odds within the same ET day.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-grok-secret',
  'Content-Type': 'application/json',
};

const MAX_PICKS_PER_DAY = 300;
const STR_FIELDS = ['id', 'sport', 'league', 'matchup', 'pick', 'betType', 'line', 'odds', 'book', 'analysis', 'postUrl', 'postedAt'];
const MAX_LEN = { analysis: 2000, postUrl: 500 };

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function sanitize(body) {
  const out = {};
  for (const f of STR_FIELDS) {
    if (body[f] === undefined || body[f] === null) continue;
    const v = String(body[f]).trim();
    if (!v) continue;
    out[f] = v.slice(0, MAX_LEN[f] || 200);
  }
  if (body.units !== undefined && body.units !== null && isFinite(Number(body.units))) {
    out.units = Math.max(0, Math.min(25, Number(body.units)));
  }
  return out;
}

function dedupKey(p) {
  if (p.id) return `id:${p.id}`;
  return `k:${[p.sport, p.matchup, p.pick, p.odds].map(x => (x || '').toLowerCase()).join('|')}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: true, message: 'POST only' }) };
  }

  const secret = process.env.GROK_BOT_WEBHOOK_SECRET || process.env.PICKS_SECRET_KEY;
  if (!secret) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, message: 'Webhook not configured' }) };
  }
  const provided = event.headers['x-grok-secret'] || event.headers['X-Grok-Secret'];
  if (provided !== secret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'Invalid JSON body' }) };
  }

  const entry = sanitize(body);
  if (!entry.pick) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: true, message: 'Field "pick" is required' }) };
  }
  entry.receivedAt = new Date().toISOString();

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('grok-bot-picks');
    const dateKey = getEasternDateToday();
    const blobKey = `picks-${dateKey}`;

    const existing = (await store.get(blobKey, { type: 'json' })) || { date: dateKey, picks: [] };
    if (!Array.isArray(existing.picks)) existing.picks = [];

    const newKey = dedupKey(entry);
    if (existing.picks.some(p => dedupKey(p) === newKey)) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stored: false, duplicate: true, countToday: existing.picks.length }) };
    }

    existing.picks.unshift(entry);
    if (existing.picks.length > MAX_PICKS_PER_DAY) existing.picks.length = MAX_PICKS_PER_DAY;
    existing.updatedAt = entry.receivedAt;

    await store.setJSON(blobKey, existing);
    await store.set('latest-date', dateKey);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stored: true, countToday: existing.picks.length }) };
  } catch (err) {
    console.error('[grok-bot-webhook] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to store pick' }) };
  }
};
