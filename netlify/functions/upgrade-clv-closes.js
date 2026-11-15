'use strict';

/**
 * upgrade-clv-closes — Supabase-only true-close upgrade for one clv-{date}.
 * GET or POST ?key=PICKS_SECRET_KEY&date=YYYY-MM-DD[&dry=1]
 * Reads clv-{date} and picks-{date}, upgrades early closes from
 * clv.odds_snapshots, writes the ledger back unless dry=1.
 * No Odds API calls.
 */

const { applyTrueClose, fillPublishedPickClv } = require('./lib/clv-true-close');

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

function ymdOk(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function eachDate(from, to) {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const out = [];
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > 31) return null;
  }
  return out;
}

function dateList(params) {
  const from = params && params.from;
  const to = params && params.to;
  if ((from != null && from !== '') || (to != null && to !== '')) {
    if (!ymdOk(from) || !ymdOk(to)) return { error: 'from and to required' };
    const dates = eachDate(from, to);
    if (!dates) return { error: 'bad date range' };
    return { dates, ranged: true, from, to };
  }
  const date = params && params.date;
  if (!ymdOk(date)) return { error: 'date required' };
  return { dates: [date], ranged: false };
}

async function upgradeDate(date, deps, env, dry) {
  let clvRaw;
  let picksRaw;
  try {
    clvRaw = await readKey(deps, `clv-${date}`);
    picksRaw = await readKey(deps, `picks-${date}`);
  } catch (err) {
    return { status: 500, body: { date, error: 'blob read failed' } };
  }
  if (!clvRaw || typeof clvRaw !== 'object' || Array.isArray(clvRaw)) {
    return { status: 404, body: { date, error: `no clv for ${date}` } };
  }

  const clv = JSON.parse(JSON.stringify(clvRaw));
  const picks = picksRaw && typeof picksRaw === 'object' ? JSON.parse(JSON.stringify(picksRaw)) : null;
  const before = {
    avgCLV: clv.avgCLV == null ? null : clv.avgCLV,
    pickClvSummary: clv.pickClvSummary || null,
  };

  const fetchImpl = (deps && deps.fetch) || fetch;
  let report;
  try {
    report = await applyTrueClose(clv, picks, env, fetchImpl);
  } catch (err) {
    return { status: 500, body: { date, error: 'upgrade failed' } };
  }
  try {
    const fill = await fillPublishedPickClv(clv, picks, env, fetchImpl, date);
    if (fill && fill.changed) report = Object.assign({}, report, { changed: true });
  } catch (err) {
    return { status: 500, body: { date, error: 'upgrade failed' } };
  }

  let wrote = false;
  if (!dry && report && report.changed) {
    try {
      await writeKey(deps, `clv-${date}`, clv);
      wrote = true;
    } catch (err) {
      return { status: 500, body: { date, error: 'blob write failed' } };
    }
  }

  return {
    status: 200,
    body: {
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
    },
  };
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const method = event && event.httpMethod;
  if (method && method !== 'GET' && method !== 'POST') return json(405, { error: 'GET or POST required' });

  const env = (deps && deps.env) || process.env;
  if (!authorized(event, env)) return json(401, { error: 'Unauthorized' });

  const params = (event && event.queryStringParameters) || {};
  const listed = dateList(params);
  if (listed.error) return json(400, { error: listed.error });
  const dry = params.dry === '1' || params.dry === 'true' || params.dry === 'yes';

  if (!listed.ranged) {
    const one = await upgradeDate(listed.dates[0], deps, env, dry);
    return json(one.status, one.body);
  }

  const days = [];
  for (const date of listed.dates) {
    const one = await upgradeDate(date, deps, env, dry);
    days.push(Object.assign({ status: one.status }, one.body));
  }
  return json(200, {
    dry,
    from: listed.from,
    to: listed.to,
    wrote: days.filter((day) => day.wrote).length,
    days,
  });
}

exports.handler = (event) => handle(event);
exports.handle = handle;
