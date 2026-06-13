// kalshi-cancel.js
// Cancel an order on Kalshi by order ID
// Usage: DELETE /api/kalshi-cancel?key=SECRET&orderId=UUID

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  await initKalshiKey();

  const key = event.queryStringParameters?.key;
  if (key !== 'webet95picks2026') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const orderId = event.queryStringParameters?.orderId;
  if (!orderId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'orderId required' }) };
  }

  try {
    const path = `/portfolio/orders/${orderId}`;
    const base = getBaseUrl();
    const url = `${base}${path}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: kalshiHeaders('DELETE', path),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return {
      statusCode: resp.ok ? 200 : resp.status,
      headers: CORS,
      body: JSON.stringify({ ok: resp.ok, status: resp.status, orderId, data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
