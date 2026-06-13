// kalshi-sell.js
// Sell (close) a position on Kalshi by placing an opposing order
// GET /api/kalshi-sell?key=SECRET — list all positions
// POST /api/kalshi-sell?key=SECRET&ticker=TICK&side=yes|no&contracts=N — sell position

const crypto = require('crypto');
const { getKalshiPrivateKey } = require('./kalshi-key');
let _kalshiPrivateKey = null;
async function initKalshiKey() { if (!_kalshiPrivateKey) _kalshiPrivateKey = await getKalshiPrivateKey(); }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function getBaseUrl() {
  return (process.env.KALSHI_ENV === 'production')
    ? 'https://trading-api.kalshi.com/trade-api/v2'
    : 'https://demo-api.kalshi.co/trade-api/v2';
}

function signRequest(timestamp, method, path) {
  const privateKeyPem = _kalshiPrivateKey;
  if (!privateKeyPem) throw new Error('Kalshi private key not loaded — initKalshiKey() must be awaited first');
  const message = `${timestamp}${method}${path}`;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return signature.toString('base64');
}

function kalshiHeaders(method, path) {
  const ts = Date.now().toString();
  const signPath = `/trade-api/v2${path}`;
  return {
    'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signRequest(ts, method, signPath),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function kalshiFetch(method, path, body) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const opts = { method, headers: kalshiHeaders(method, path) };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  await initKalshiKey();

  const key = event.queryStringParameters?.key;
  if (key !== 'webet95picks2026') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // GET — list all positions
    if (event.httpMethod === 'GET') {
      const result = await kalshiFetch('GET', '/portfolio/positions');
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify(result.data),
      };
    }

    // POST — sell a position
    const ticker = event.queryStringParameters?.ticker;
    const side = event.queryStringParameters?.side; // 'yes' or 'no' — the side we HOLD
    const contracts = parseInt(event.queryStringParameters?.contracts || '0');

    if (!ticker || !side || !contracts) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'ticker, side, contracts required' }) };
    }

    // To close a position, we sell what we hold
    // If we hold YES, we sell YES. If we hold NO, we sell NO.
    const order = {
      ticker: ticker,
      action: 'sell',
      side: side,
      count: contracts,
      type: 'market', // market order for immediate fill
    };

    console.log(`[kalshi-sell] Selling ${contracts} ${side} on ${ticker}`);
    const result = await kalshiFetch('POST', '/portfolio/orders', order);

    return {
      statusCode: result.ok ? 200 : result.status,
      headers: CORS,
      body: JSON.stringify({ ok: result.ok, order, result: result.data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
