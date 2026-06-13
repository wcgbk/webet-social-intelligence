// get-kalshi.js
// API endpoint: GET /api/get-kalshi
// Returns latest Kalshi execution log + historical data

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: true, message: 'Not configured' }) };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-executions`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };
    const dateParam = event.queryStringParameters?.date;

    // If specific date requested
    if (dateParam) {
      const resp = await fetch(`${storeUrl}/exec-${dateParam}`, { headers: authHeaders });
      if (!resp.ok) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: true, message: 'No data for date' }) };
      const data = await resp.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // Otherwise return latest + dates index
    let latest = null;
    try {
      const latestResp = await fetch(`${storeUrl}/latest`, { headers: authHeaders });
      if (latestResp.ok) latest = await latestResp.json();
    } catch (e) { /* no latest */ }

    let dates = [];
    try {
      const datesResp = await fetch(`${storeUrl}/exec-dates`, { headers: authHeaders });
      if (datesResp.ok) dates = await datesResp.json();
    } catch (e) { /* empty */ }

    // Fetch all execution logs for history
    const history = [];
    for (const d of dates.slice(-14)) { // last 14 days
      try {
        const resp = await fetch(`${storeUrl}/exec-${d}`, { headers: authHeaders });
        if (resp.ok) {
          const log = await resp.json();
          history.push({
            date: d,
            executions: (log.executions || []).length,
            placed: (log.executions || []).filter(e => e.status === 'placed').length,
            dryRun: (log.executions || []).filter(e => e.status === 'dry_run').length,
            noMarket: (log.executions || []).filter(e => e.status === 'no_market').length,
            backfillExecutions: (log.backfillExecutions || log.scannerExecutions || []).length,
            backfillPlaced: (log.backfillExecutions || log.scannerExecutions || []).filter(e => e.status === 'placed').length,
            riskUsed: log.riskCap?.used || 0,
            riskMax: log.riskCap?.maxDollars || 50,
            errors: (log.errors || []).length,
            environment: log.environment,
          });
        }
      } catch (e) { /* skip */ }
    }

    const result = {
      latest,
      dates,
      history,
      config: {
        environment: process.env.KALSHI_ENV || 'demo',
        enabled: process.env.KALSHI_ENABLED === 'true',
        apiKeySet: !!process.env.KALSHI_API_KEY,
        privateKeySet: !!(process.env.KALSHI_PRIVATE_KEY || process.env.NETLIFY_AUTH_TOKEN), // key now in Blob
        dollarPerUnit: 5,
      },
    };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=30' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('[get-kalshi] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message }) };
  }
};
