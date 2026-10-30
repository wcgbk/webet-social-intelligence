'use strict';
/**
 * clv-supabase — standalone helpers for the Supabase CLV mirror (clv.games, clv.odds_snapshots).
 * No omega-vnext imports. No pick, grading or card code. Insert-or-ignore only.
 */
const crypto = require('crypto');

const SUPABASE_URL = 'https://qvfgebrkolfyggfizgkx.supabase.co';
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const BATCH = 500;
const ODDS_SPORT_KEYS = {
  NFL: 'americanfootball_nfl', NCAAF: 'americanfootball_ncaaf', NHL: 'icehockey_nhl',
  NBA: 'basketball_nba', NCAAM: 'basketball_ncaab', MLB: 'baseball_mlb',
};
const CONFLICT = {
  games: 'game_id',
  odds_snapshots: 'game_id,book,market,side,point,line_type,snapshot_ts',
};

class MissingEnvError extends Error {}

function requireEnv(env, names) {
  const missing = names.filter((n) => !(env && env[n]));
  if (missing.length) {
    const err = new MissingEnvError(`missing env: ${missing.join(', ')}`);
    err.missing = missing;
    throw err;
  }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function etYmd(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isAuthorized(event, env) {
  const secret = env && env.PICKS_SECRET_KEY;
  if (!secret || !event) return false;
  const h = event.headers || {};
  const q = event.queryStringParameters || {};
  const auth = String(h.authorization || h.Authorization || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : (h['x-picks-secret'] || q.key || '');
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seasonFor(sport, commence) {
  const d = commence ? new Date(commence) : new Date();
  const y = d.getUTCFullYear();
  if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAM') {
    return d.getUTCMonth() >= 7 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
  }
  return String(d.getUTCMonth() <= 1 ? y - 1 : y);
}

function marketFromBetType(betType, pick) {
  const t = String(betType || '').toLowerCase();
  if (/total|over|under/.test(t) || /^(over|under)\b/i.test(String(pick || ''))) return 'totals';
  if (/spread|puck|run ?line/.test(t)) return 'spreads';
  if (/ml|moneyline|h2h/.test(t) || /\bML\b/.test(String(pick || ''))) return 'h2h';
  return /[+-]\d/.test(String(pick || '')) ? 'spreads' : 'h2h';
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Odds API event -> clv.games row + clv.odds_snapshots rows (one book/market each). */
function rowsFromOddsEvent(sport, ev, { lineType, source, books, markets }) {
  const game = {
    game_id: ev.id, sport, season: seasonFor(sport, ev.commence_time), commence_time: ev.commence_time,
    home_team: ev.home_team, away_team: ev.away_team, source,
  };
  const snaps = [];
  for (const b of ev.bookmakers || []) {
    if (books && !books.includes(b.key)) continue;
    for (const m of b.markets || []) {
      if (markets && !markets.includes(m.key)) continue;
      for (const o of m.outcomes || []) {
        snaps.push({
          game_id: ev.id, sport, book: b.key, market: m.key, side: o.name,
          point: m.key === 'h2h' ? null : num(o.point), price: num(o.price), line_type: lineType,
          snapshot_ts: m.last_update || b.last_update, source,
        });
      }
    }
  }
  return { game, snaps };
}

async function postRows(table, rows, env, fetchImpl) {
  const out = { table, posted: 0, requests: 0 };
  if (!rows.length) return out;
  requireEnv(env, ['SUPABASE_SERVICE_ROLE_KEY']);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(CONFLICT[table])}`;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    out.requests += 1;
    const resp = await (fetchImpl || fetch)(url, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'Content-Profile': 'clv', Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`supabase ${table} HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    out.posted += batch.length;
  }
  return out;
}

function dedupe(rows, cols) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = cols.map((c) => String(r[c])).join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function writeRows({ games, snaps }, env, fetchImpl) {
  const g = await postRows('games', dedupe(games, ['game_id']), env, fetchImpl);
  const s = await postRows('odds_snapshots', dedupe(snaps, CONFLICT.odds_snapshots.split(',')), env, fetchImpl);
  return { games: g.posted, odds_snapshots: s.posted, requests: g.requests + s.requests };
}

/** Netlify Blobs REST (site token). Tries per-segment and fully-encoded key forms. */
function blobClient(env, fetchImpl) {
  const f = fetchImpl || fetch;
  const H = () => ({ Authorization: `Bearer ${env.NETLIFY_AUTH_TOKEN}` });
  const base = `https://api.netlify.com/api/v1/blobs/${SITE_ID}`;
  async function get(store, key) {
    const forms = [String(key).split('/').map(encodeURIComponent).join('/'), encodeURIComponent(key)];
    for (const k of [...new Set(forms)]) {
      const r = await f(`${base}/${store}/${k}`, { headers: H() });
      if (r.status === 404) continue;
      if (!r.ok) throw new Error(`blob GET ${store}/${key} HTTP ${r.status}`);
      let body = await r.json();
      if (body && typeof body.url === 'string' && Object.keys(body).length <= 2 && /^https:/.test(body.url)) {
        const r2 = await f(body.url);
        body = r2.ok ? await r2.json() : null;
      }
      return body;
    }
    return null;
  }
  async function list(store, prefix) {
    const keys = [];
    let cursor = null;
    for (let p = 0; p < 50; p += 1) {
      const u = new URL(`${base}/${store}`);
      u.searchParams.set('prefix', prefix);
      if (cursor) u.searchParams.set('cursor', cursor);
      const r = await f(u.toString(), { headers: H() });
      if (!r.ok) throw new Error(`blob LIST ${store}/${prefix} HTTP ${r.status}`);
      const d = await r.json();
      for (const b of d.blobs || []) keys.push(b.key);
      cursor = d.next_cursor;
      if (!cursor) break;
    }
    return keys;
  }
  async function set(store, key, value) {
    const k = String(key).split('/').map(encodeURIComponent).join('/');
    const r = await f(`${base}/${store}/${k}`, { method: 'PUT', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) throw new Error(`blob PUT ${store}/${key} HTTP ${r.status}`);
    return true;
  }
  return { get, list, set };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

module.exports = {
  SUPABASE_URL, SITE_ID, ODDS_SPORT_KEYS, CONFLICT, MissingEnvError,
  requireEnv, json, etYmd, addDays, isAuthorized, seasonFor, marketFromBetType, num,
  rowsFromOddsEvent, postRows, writeRows, dedupe, blobClient, mapLimit,
};
