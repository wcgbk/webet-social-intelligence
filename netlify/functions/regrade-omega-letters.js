'use strict';

/**
 * regrade-omega-letters — one-shot letter fix for three stored cards.
 * POST /api/regrade-omega-letters?key=PICKS_SECRET_KEY
 * Body: { date, dryRun }  dryRun defaults to true.
 * Dates: 2026-10-31, 2026-11-01, 2026-11-02.
 *
 * Straight picks (picks[] only) whose grade is b and whose edgePct parses
 * to a percentage from 2.0 up to but not including 3.5 become aminus on
 * rating, grade, and qualityGrade. Stake, units, odds, result, and
 * confidence stay as stored. Writes only when dryRun is boolean false.
 */

const { BLOB_STORE } = require('./lib/omega-vnext/config');

const ALLOWED_DATES = Object.freeze(['2026-10-31', '2026-11-01', '2026-11-02']);
const ALLOWED = new Set(ALLOWED_DATES);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function tidyPoints(n) {
  return Math.round(n * 1e6) / 1e6;
}

function parseEdgePct(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return tidyPoints(Math.abs(raw) <= 1 ? raw * 100 : raw);
  }
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const cleaned = text.replace(/[−–]/g, '-').replace(/[^0-9.+-]/g, '');
  if (!cleaned || cleaned === '+' || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  if (text.includes('%')) return tidyPoints(n);
  return tidyPoints(Math.abs(n) <= 1 ? n * 100 : n);
}

function gradeLetter(pick) {
  if (!pick || pick.grade == null) return '';
  return String(pick.grade).trim().toLowerCase();
}

function inBand(edge) {
  return edge != null && edge >= 2 && edge < 3.5;
}

function applyRegrade(card) {
  const picks = Array.isArray(card && card.picks) ? card.picks : [];
  const changes = [];
  const nextPicks = picks.map((pick, index) => {
    if (!pick || typeof pick !== 'object') return pick;
    const edge = parseEdgePct(pick.edgePct);
    if (gradeLetter(pick) !== 'b' || !inBand(edge)) return pick;
    const from = { rating: pick.rating, grade: pick.grade, qualityGrade: pick.qualityGrade };
    const to = { rating: 'aminus', grade: 'aminus', qualityGrade: 'aminus' };
    changes.push({
      index,
      pick: pick.pick == null ? null : pick.pick,
      matchup: pick.matchup == null ? null : pick.matchup,
      edgePct: pick.edgePct,
      edge,
      from,
      to,
    });
    return { ...pick, ...to };
  });
  return {
    changes,
    card: Object.assign({}, card, { picks: nextPicks }),
  };
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  return JSON.parse(event.body);
}

async function openStore() {
  const { getStore } = await import('@netlify/blobs');
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (token) {
    return getStore({
      name: BLOB_STORE,
      siteID: process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606',
      token,
    });
  }
  return getStore(BLOB_STORE);
}

/**
 * @param {{ date: string, dryRun?: boolean, store: { get: Function, setJSON: Function } }} opts
 * dryRun defaults to true. store is the edge-picks-omega blob store.
 */
async function regradeOmegaLetters(opts) {
  const date = opts && opts.date;
  const dryRun = !(opts && opts.dryRun === false);
  if (!ALLOWED.has(date)) {
    const err = new Error(`date must be ${ALLOWED_DATES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const store = opts.store;
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function') {
    const err = new Error('edge-picks-omega store unavailable');
    err.statusCode = 500;
    throw err;
  }
  const key = `picks-${date}`;
  const card = await store.get(key, { type: 'json' });
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    const err = new Error(`no card for ${date}`);
    err.statusCode = 404;
    throw err;
  }
  const applied = applyRegrade(card);
  const wrote = !dryRun && applied.changes.length > 0;
  if (wrote) await store.setJSON(key, applied.card);
  return {
    date,
    dryRun,
    wrote,
    changes: applied.changes,
  };
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!event || event.httpMethod !== 'POST') return json(405, { error: 'POST required' });

  const params = (event && event.queryStringParameters) || {};
  if (params.key !== process.env.PICKS_SECRET_KEY) return json(401, { error: 'Unauthorized' });

  let body;
  try {
    body = readBody(event);
  } catch (err) {
    return json(400, { error: 'invalid JSON' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'JSON object required' });
  if (!ALLOWED.has(body.date)) return json(400, { error: `date must be ${ALLOWED_DATES.join(', ')}` });

  try {
    const store = deps && deps.store ? deps.store : await openStore();
    const result = await regradeOmegaLetters({
      date: body.date,
      dryRun: body.dryRun,
      store,
    });
    return json(200, result);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    return json(status, { error: err.message || 'regrade failed' });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
exports.regradeOmegaLetters = regradeOmegaLetters;
exports.parseEdgePct = parseEdgePct;
exports.ALLOWED_DATES = ALLOWED_DATES;
exports.BLOB_STORE = BLOB_STORE;
