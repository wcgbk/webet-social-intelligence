// trigger-kalshi-scan.js
// Scheduled function — runs 3x daily to scan ALL Kalshi sports markets independently.
// 15:30 UTC (11:30am EDT) — after picks + execution are done
// 19:00 UTC (3:00pm EDT) — afternoon price movement check
// 23:00 UTC (7:00pm EDT) — evening games about to start
// Calls kalshi-scan, caches results to Netlify Blobs for /scanner page.

exports.handler = async (event) => {
  console.log("[trigger-kalshi-scan] Scheduled scan triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";
  const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const token = process.env.NETLIFY_AUTH_TOKEN;

  try {
    // Call the existing kalshi-scan function
    const response = await fetch(
      `${siteURL}/.netlify/functions/kalshi-scan?key=webet95picks2026`,
      { method: "GET", headers: { "Content-Type": "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`Scan returned ${response.status}`);
    }

    const scanResult = await response.json();
    console.log(`[trigger-kalshi-scan] Scan complete: ${scanResult.summary?.actionable || 0} actionable, ${scanResult.totalMarketsScanned || 0} markets scanned`);

    if (!token) {
      console.warn('[trigger-kalshi-scan] No NETLIFY_AUTH_TOKEN — skipping blob cache');
      return { statusCode: 200, body: JSON.stringify({ status: 'ok', cached: false }) };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-scanner`;
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const hour = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });

    const payload = { ...scanResult, cachedAt: now.toISOString() };

    // Store latest + daily + hourly snapshots
    await Promise.all([
      fetch(`${storeUrl}/latest-scan`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(payload) }),
      fetch(`${storeUrl}/scan-${today}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(payload) }),
      fetch(`${storeUrl}/scan-${today}-${hour}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(payload) }),
    ]);

    console.log(`[trigger-kalshi-scan] Cached: latest-scan, scan-${today}, scan-${today}-${hour}`);

    return { statusCode: 200, body: JSON.stringify({
      status: "ok",
      actionable: scanResult.summary?.actionable || 0,
      markets: scanResult.totalMarketsScanned || 0,
      cachedAt: now.toISOString(),
    })};
  } catch (err) {
    console.error(`[trigger-kalshi-scan] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
