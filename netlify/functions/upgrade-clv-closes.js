'use strict';

/**
 * upgrade-clv-closes — Supabase-only true-close upgrade for one clv-{date}.
 * GET or POST ?key=PICKS_SECRET_KEY&date=YYYY-MM-DD[&dry=1]
 * Reads clv-{date} and picks-{date}, upgrades early closes from
 * clv.odds_snapshots, writes the ledger back unless dry=1.
 * No Odds API calls.
 */

const { applyTrueClose } = require('./lib/clv-true-close');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function authorized(event, env) {
  const secret = env && env.PICKS_SECRET_KEY;
  const params = (event && event.queryStringParameters) || {};
  if (!secret || params.key == null || params.key === '' || params.key !== secret) return false;
  return true;
}

async function liveGet(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-omega');
    const data = await store.get(key, { type: 'json' });
    if (data) return data;
  } catch (e) { /* REST fallback */ }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  if (!token) return null;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/${key}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  return resp.json();
}

async function livePut(key, value) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-omega');
    await store.setJSON(key, value);
    return true;
  } catch (e) { /* REST fallback */ }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  if (!token) return false;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/${key}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return resp.ok;
}

async function readKey(deps, key) {
  if (deps && deps.store) return deps.store.get(key, { type: 'json' });
  return liveGet(key);
}

async function writeKey(deps, key, value) {
  if (deps && deps.store) {
    await deps.store.setJSON(key, value);
    return true;
  }
  return livePut(key, value);
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const method = event && event.httpMethod;
  if (method && method !== 'GET' && method !== 'POST') return json(405, { error: 'GET or POST required' });

  const env = (deps && deps.env) || process.env;
  if (!authorized(event, env)) return json(401, { error: 'Unauthorized' });

  const params = (event && event.queryStringParameters) || {};
  const date = params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return json(400, { error: 'date required' });
  const dry = params.dry === '1' || params.dry === 'true' || params.dry === 'yes';

  let clvRaw;
  let picksRaw;
  try {
    clvRaw = await readKey(deps, `clv-${date}`);
    picksRaw = await readKey(deps, `picks-${date}`);
  } catch (err) {
    return json(500, { error: 'blob read failed' });
  }
  if (!clvRaw || typeof clvRaw !== 'object' || Array.isArray(clvRaw)) {
    return json(404, { error: `no clv for ${date}` });
  }

  const clv = JSON.parse(JSON.stringify(clvRaw));
  const picks = picksRaw && typeof picksRaw === 'object' ? JSON.parse(JSON.stringify(picksRaw)) : null;
  const before = {
    avgCLV: clv.avgCLV == null ? null : clv.avgCLV,
    pickClvSummary: clv.pickClvSummary || null,
  };

  let report;
  try {
    report = await applyTrueClose(clv, picks, env, (deps && deps.fetch) || fetch);
  } catch (err) {
    return json(500, { error: 'upgrade failed' });
  }

  let wrote = false;
  if (!dry && report && report.changed) {
    try {
      await writeKey(deps, `clv-${date}`, clv);
      wrote = true;
    } catch (err) {
      return json(500, { error: 'blob write failed' });
    }
  }

  return json(200, {
    date,
    dry,
    wrote,
    picksExamined: report.picksExamined,
    upgraded: report.upgraded,
    stillEarly: report.stillEarly,
    noTrueClose: report.noTrueClose,
    before,
    after: {
      avgCLV: clv.avgCLV == null ? null : clv.avgCLV,
      pickClvSummary: clv.pickClvSummary || null,
    },
  });
}

exports.handler = (event) => handle(event);
exports.handle = handle;
