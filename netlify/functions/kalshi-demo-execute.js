// kalshi-demo-execute.js
// STAGE 2 — places REAL orders in Kalshi's DEMO environment (fake "freemium" tokens) for the
// Kalshi-matched picks the paper sim (kalshi-demo-run) produces, as picks come in.
//
// ⛔ SAFETY: this function is HARD-PINNED to Kalshi's DEMO env. There is NO production URL and NO
// env switch anywhere in this file, so it can never place a real-money order. Real money (Stage 3)
// is a deliberate, separate build that Ben authorizes — not a flag on this function.
//
// Credentials are loaded at runtime (never handled in plaintext here). Kalshi's demo and production
// use SEPARATE keys, so this reads DEMO-specific creds and keeps them independent of the prod key:
//   API key   : KALSHI_DEMO_API_KEY  (falls back to KALSHI_API_KEY)
//   private key: Blob webet-config/kalshi-demo-private-key  →  env KALSHI_DEMO_PRIVATE_KEY  →  shared
//                (shared = ./kalshi-key, i.e. the prod key — only as a last resort).
// Set the demo private key via POST /api/bootstrap-kalshi-demo-key (moves env → Blob).
//
// GET /.netlify/functions/kalshi-demo-execute?key=<gate>
//   &mode=verify        → just check demo creds + return balance (NO orders)
//   [default run]        → read matched picks, place demo orders for new OPEN Kalshi entries
//   &max=<n>             → cap orders this run (default MAX_ORDERS_PER_RUN)
// Auth gate = KALSHI_DEMO_KEY || LIVE_PICKS_KEY || PICKS_SECRET_KEY (same as the demo page).

const crypto = require('crypto');
const { getKalshiPrivateKey } = require('./kalshi-key');

const KALSHI_DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2'; // HARD-PINNED demo. Never prod.
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const EXEC_STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-demo-exec`;

const DOLLAR_PER_UNIT = 150;         // strategy sizing (1u = $150), same as the feed
const DEMO_MAX_COST_PER_ORDER = 50;  // cap each demo order's cost (fake $) so balance lasts testing
const MAX_ORDERS_PER_RUN = 10;       // backstop
const MAX_TOTAL_COST_PER_RUN = 300;  // backstop on total fake $ deployed per run

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

const DEMO_API_KEY = process.env.KALSHI_DEMO_API_KEY || process.env.KALSHI_API_KEY;

// ── Kalshi DEMO signed client (RSA-PSS SHA256), pinned to KALSHI_DEMO_BASE ──
let _privKey = null;
async function privKey() {
  if (_privKey) return _privKey;
  // 1) demo private key from Blob
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (token) {
    try {
      const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/webet-config/kalshi-demo-private-key`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const pem = await r.text(); if (pem && pem.includes('-----BEGIN')) { _privKey = pem; return _privKey; } }
    } catch (e) { /* fall through */ }
  }
  // 2) demo private key from env
  if (process.env.KALSHI_DEMO_PRIVATE_KEY) {
    const pem = process.env.KALSHI_DEMO_PRIVATE_KEY;
    _privKey = pem.indexOf('\\n') !== -1 ? pem.replace(/\\n/g, '\n') : pem;
    return _privKey;
  }
  // 3) last resort: the shared (prod) key — will 401 on demo, but keeps a single failure path
  _privKey = await getKalshiPrivateKey();
  return _privKey;
}

function sign(ts, method, path, pem) {
  const msg = `${ts}${method}/trade-api/v2${path}`;
  return crypto.sign('sha256', Buffer.from(msg), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString('base64');
}

async function kdemo(method, path, body) {
  const pem = await privKey();
  const ts = Date.now().toString();
  const headers = {
    'KALSHI-ACCESS-KEY': DEMO_API_KEY,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': sign(ts, method, path, pem),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${KALSHI_DEMO_BASE}${path}`, opts);
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function getBalance() {
  const { ok, data } = await kdemo('GET', '/portfolio/balance');
  if (!ok) return null;
  return { balance: (data.balance || 0) / 100, portfolioValue: (data.portfolio_value || 0) / 100 };
}

async function getPositions() {
  const { ok, data } = await kdemo('GET', '/portfolio/positions?limit=200&count_filter=position');
  if (!ok) return [];
  return (data.market_positions || []).map((p) => ({
    ticker: p.ticker, position: p.position, exposure: (p.market_exposure || 0) / 100,
    realizedPnl: (p.realized_pnl || 0) / 100, totalTraded: (p.total_traded || 0) / 100,
  }));
}

// Demo market must be tradeable, and we need a real demo price (demo liquidity differs from prod).
async function demoMarket(ticker) {
  const { ok, data } = await kdemo('GET', `/markets/${encodeURIComponent(ticker)}`);
  if (!ok || !data.market) return null;
  return data.market; // has status, yes_bid, yes_ask, no_bid, no_ask (cents)
}

function priceForSide(mkt, side) {
  // Buying YES fills at the yes ask; buying NO at the no ask. Kalshi returns cents.
  const c = side === 'yes' ? mkt.yes_ask : mkt.no_ask;
  if (c == null || c <= 0 || c >= 100) return null;
  return c / 100; // dollars 0..1
}

// ── blob helpers (our exec store only) ──
async function blobGetJSON(url, token) {
  try { const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (r.ok) return await r.json().catch(() => null); } catch (e) {} return null;
}
async function blobPut(url, token, body) {
  return fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function placeDemoOrder(ticker, side, contracts, priceDollars) {
  const clientOrderId = `webetdemo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const order = {
    ticker, side, action: 'buy', count: contracts,
    type: 'limit', time_in_force: 'good_till_canceled', client_order_id: clientOrderId,
  };
  if (side === 'yes') order.yes_price = Math.round(priceDollars * 100);
  else order.no_price = Math.round(priceDollars * 100);
  const { ok, status, data } = await kdemo('POST', '/portfolio/orders', order);
  if (ok) return { success: true, orderId: data.order && data.order.order_id, clientOrderId, order: data.order };
  return { success: false, status, error: data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const gate = process.env.KALSHI_DEMO_KEY || process.env.LIVE_PICKS_KEY || process.env.PICKS_SECRET_KEY;
  if (!gate) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, message: 'No gate key set' }) };
  if (params.key !== gate) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };

  if (!DEMO_API_KEY) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, status: 'NO_KALSHI_KEY', message: 'No Kalshi demo API key — set KALSHI_DEMO_API_KEY.' }) };
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;

  try {
    // Load the key up front so a bad/missing key fails clearly (not mid-order).
    try { await privKey(); } catch (e) {
      return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, status: 'NO_PRIVATE_KEY', message: e.message }) };
    }

    // Confirm demo creds by reading balance. Surface the RAW Kalshi response so we can tell a
    // wrong-env key (401/403) apart from other failures.
    const balRaw = await kdemo('GET', '/portfolio/balance');
    if (params.mode === 'verify') {
      const bodySnippet = (() => { try { return JSON.stringify(balRaw.data).slice(0, 300); } catch (e) { return ''; } })();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: balRaw.ok, env: 'demo', hardPinned: KALSHI_DEMO_BASE, kalshiStatus: balRaw.status,
        balance: balRaw.ok ? { balance: (balRaw.data.balance || 0) / 100, portfolioValue: (balRaw.data.portfolio_value || 0) / 100 } : null,
        kalshiBody: bodySnippet,
        note: balRaw.ok ? 'Demo credentials valid. No orders placed.' : 'Demo auth failed — see kalshiStatus/kalshiBody. Likely a production key (Kalshi demo needs its own key).',
      }) };
    }
    const balance = balRaw.ok ? { balance: (balRaw.data.balance || 0) / 100, portfolioValue: (balRaw.data.portfolio_value || 0) / 100 } : null;
    if (balance === null) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: true, status: 'AUTH_FAILED', env: 'demo', kalshiStatus: balRaw.status, message: 'Kalshi DEMO auth/balance failed — the stored keys may be production keys, not demo keys, or unset.' }) };
    }

    // ── RUN: pull matched picks from the paper sim, place demo orders for new OPEN Kalshi entries ──
    const dateKey = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : getEasternDateToday();
    const siteURL = process.env.URL || 'https://webetsocial.com';
    const runResp = await fetch(`${siteURL}/.netlify/functions/kalshi-demo-run?key=${encodeURIComponent(params.key)}&_=${Date.now()}`);
    const run = await runResp.json().catch(() => null);
    const entries = (run && Array.isArray(run.entries)) ? run.entries : [];

    // Idempotency: don't re-place a pick already placed today.
    const prior = token ? await blobGetJSON(`${EXEC_STORE_URL}/exec-${dateKey}`, token) : null;
    const placedByKey = {};
    if (prior && Array.isArray(prior.orders)) prior.orders.forEach((o) => { placedByKey[o.key] = o; });

    const maxOrders = Math.max(1, Math.min(MAX_ORDERS_PER_RUN, parseInt(params.max, 10) || MAX_ORDERS_PER_RUN));
    const orders = prior && Array.isArray(prior.orders) ? [...prior.orders] : [];
    const placed = [], skipped = [];
    let costThisRun = 0, newCount = 0;

    for (const e of entries) {
      const en = e.entry || {};
      const key = e.key;
      if (en.mode !== 'kalshi') { continue; }                       // book picks are paper-only
      if (e.status !== 'open') { skipped.push({ pick: e.pick, reason: `not open (${e.status})` }); continue; }
      if (placedByKey[key]) { skipped.push({ pick: e.pick, reason: 'already placed', orderId: placedByKey[key].orderId }); continue; }
      if (newCount >= maxOrders) { skipped.push({ pick: e.pick, reason: 'per-run order cap' }); continue; }
      if (costThisRun >= MAX_TOTAL_COST_PER_RUN) { skipped.push({ pick: e.pick, reason: 'per-run cost cap' }); continue; }

      // Confirm the market is tradeable in DEMO right now + get a real demo price.
      const mkt = await demoMarket(en.ticker);
      if (!mkt) { skipped.push({ pick: e.pick, ticker: en.ticker, reason: 'not found in demo env' }); continue; }
      if (mkt.status && mkt.status !== 'active') { skipped.push({ pick: e.pick, ticker: en.ticker, reason: `demo market ${mkt.status} (closed)` }); continue; }
      const price = priceForSide(mkt, en.side);
      if (!price) { skipped.push({ pick: e.pick, ticker: en.ticker, reason: 'no valid demo ask' }); continue; }

      const units = Number(e.units) || 1;
      const budget = Math.min(units * DOLLAR_PER_UNIT, DEMO_MAX_COST_PER_ORDER, MAX_TOTAL_COST_PER_RUN - costThisRun);
      const contracts = Math.max(1, Math.floor(budget / price));
      const cost = Math.round(contracts * price * 100) / 100;

      const res = await placeDemoOrder(en.ticker, en.side, contracts, price);
      if (res.success) {
        const rec = { key, pick: e.pick, sport: e.sport, event: e.event, ticker: en.ticker, side: en.side,
          contracts, limitPrice: price, cost, orderId: res.orderId, clientOrderId: res.clientOrderId,
          placedAt: new Date().toISOString() };
        orders.push(rec); placed.push(rec); placedByKey[key] = rec;
        costThisRun += cost; newCount++;
      } else {
        skipped.push({ pick: e.pick, ticker: en.ticker, reason: `order failed (${res.status})`, error: res.error });
      }
    }

    const positions = await getPositions();
    const balanceAfter = await getBalance();

    const log = {
      env: 'demo', hardPinned: KALSHI_DEMO_BASE, date: dateKey, ranAt: new Date().toISOString(),
      balanceBefore: balance, balanceAfter, positions,
      placedThisRun: placed.length, totalPlacedToday: orders.length, costThisRun: Math.round(costThisRun * 100) / 100,
      orders, placed, skipped,
    };
    if (token) {
      await blobPut(`${EXEC_STORE_URL}/exec-${dateKey}`, token, log);
      await blobPut(`${EXEC_STORE_URL}/latest`, token, log);
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(log) };
  } catch (err) {
    console.error('[kalshi-demo-execute]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Demo execute failed', detail: err.message }) };
  }
};
