// bootstrap-optimize.js
// One-time bootstrapper: loads backtest data + live results, merges them into
// the results-cache blob, then triggers self-optimize to compute initial parameters.
// This seeds the self-optimization loop with 230+ historical graded picks so the
// model starts learning immediately instead of waiting weeks for live data to accumulate.
//
// Run manually: POST /api/bootstrap-optimize

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { statusCode: 500, body: "Missing auth token" };

  console.log("[bootstrap] Starting optimization bootstrap from historical data");

  const allResults = [];

  // ── Source 1: Backtest data — EXCLUDED ──
  // The backtest (Jan 19 - Mar 28) was run retroactively. Model parameters were tuned
  // with knowledge of that period's outcomes. Using it for self-optimization is circular —
  // it reinforces existing biases rather than learning from honest out-of-sample data.
  // Only live picks (Mar 28+) qualify for the optimization corpus.
  console.log(`[bootstrap] Skipping backtest data (retroactive — not out-of-sample)`);

  // ── Source 1B: Graded results from the live results API ──
  // get-results.js grades picks against ESPN final scores on-the-fly.
  // This is the most reliable source of graded live data.
  try {
    const siteURL = process.env.URL || "https://webetsocial.com";
    const resp = await fetch(`${siteURL}/.netlify/functions/get-results`);
    if (resp.ok) {
      const data = await resp.json();
      for (const day of (data.days || [])) {
        for (const pick of (day.picks || [])) {
          if (!pick.result || pick.result === "pending") continue;
          if (pick.sport === "PARLAY") continue; // exclude parlays from optimizer
          allResults.push({
            date: day.date,
            source: "live-graded",
            sport: pick.sport,
            matchup: pick.matchup,
            pick: pick.pick,
            betType: inferBetType(pick.pick),
            odds: pick.odds,
            units: pick.units,
            rating: pick.rating,
            result: pick.result,
            profit: pick.profit || 0,
            edge: 0, // not available from results API
            edgePoints: 0,
            cover: 0,
            ev: 0,
            zScore: 0,
          });
        }
      }
      console.log(`[bootstrap] Loaded ${allResults.length} graded picks from live results API`);
    }
  } catch (e) {
    console.log(`[bootstrap] Live results API fetch failed: ${e.message}`);
  }

  // ── Source 2: Live blob data (for richer fields — edge, ev, zScore) ──
  try {
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks`;
    const authHeaders = { Authorization: `Bearer ${token}` };

    const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) {
      const dateIndex = await datesResp.json();
      const dates = (dateIndex.dates || dateIndex || []).slice(-30);

      for (const d of dates) {
        try {
          const picksResp = await fetch(`${storeUrl}/picks-${d}`, { headers: authHeaders });
          if (!picksResp.ok) continue;
          const picksData = await picksResp.json();

          // Grade against ESPN
          for (const pick of (picksData.picks || [])) {
            // Skip ungraded or already in backtest
            if (!pick.pick) continue;
            const existing = allResults.find(r => r.date === d && r.pick === pick.pick);
            if (existing) continue;

            allResults.push({
              date: d,
              source: "live",
              sport: pick.sport,
              matchup: pick.matchup,
              pick: pick.pick,
              betType: pick.betType || inferBetType(pick.pick),
              odds: pick.odds,
              units: pick.units,
              rating: pick.rating,
              result: pick.result || "pending",
              profit: pick.profit || 0,
              edge: parseFloat(pick.edgePoints || pick.edge || 0),
              edgePoints: parseFloat(pick.edgePoints || pick.edge || 0),
              cover: parseFloat(pick.coverProb || pick.winProbability || 0) / 100,
              ev: parseFloat(pick.ev || 0) / 100,
              zScore: pick.zScore || 0,
            });
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) {
    console.log(`[bootstrap] Live data fetch failed: ${e.message}`);
  }

  // Also try beta blob store
  try {
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-beta`;
    const authHeaders = { Authorization: `Bearer ${token}` };
    const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) {
      const dateIndex = await datesResp.json();
      const dates = (dateIndex.dates || dateIndex || []).slice(-30);
      for (const d of dates) {
        try {
          const picksResp = await fetch(`${storeUrl}/picks-${d}`, { headers: authHeaders });
          if (!picksResp.ok) continue;
          const picksData = await picksResp.json();
          for (const pick of (picksData.picks || [])) {
            if (!pick.pick) continue;
            const existing = allResults.find(r => r.date === d && r.pick === pick.pick);
            if (existing) continue;
            allResults.push({
              date: d, source: "live-beta",
              sport: pick.sport, matchup: pick.matchup, pick: pick.pick,
              betType: pick.betType || inferBetType(pick.pick),
              odds: pick.odds, units: pick.units, rating: pick.rating,
              result: pick.result || "pending", profit: pick.profit || 0,
              edge: parseFloat(pick.edgePoints || pick.edge || 0),
              edgePoints: parseFloat(pick.edgePoints || pick.edge || 0),
              cover: parseFloat(pick.coverProb || pick.winProbability || 0) / 100,
              ev: parseFloat(pick.ev || 0) / 100, zScore: pick.zScore || 0,
            });
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { /* skip */ }

  // Filter to only graded results
  const graded = allResults.filter(r => r.result === "win" || r.result === "loss" || r.result === "push");
  console.log(`[bootstrap] Total graded results: ${graded.length} (${allResults.length} total including pending)`);

  if (graded.length < 10) {
    return { statusCode: 200, body: JSON.stringify({ error: "Insufficient graded results (need 10+)", total: graded.length }) };
  }

  // ── Store merged results to results-cache for self-optimize to read ──
  try {
    await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/results-cache`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          results: graded,
          generatedAt: new Date().toISOString(),
          sources: { backtest: graded.filter(r => r.source === "backtest").length, live: graded.filter(r => r.source !== "backtest").length },
        }),
      }
    );
    console.log(`[bootstrap] Stored ${graded.length} results to results-cache`);
  } catch (e) {
    return { statusCode: 500, body: `Failed to store results: ${e.message}` };
  }

  // ── Trigger self-optimize ──
  try {
    const siteURL = process.env.URL || "https://webetsocial.com";
    const optResp = await fetch(`${siteURL}/.netlify/functions/self-optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggered: true }),
    });
    const optResult = await optResp.text();
    console.log(`[bootstrap] Self-optimize triggered: ${optResult}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        gradedResults: graded.length,
        bySport: countBy(graded, "sport"),
        byMarket: countBy(graded, "betType"),
        byResult: countBy(graded, "result"),
        optimizeResult: optResult,
      }),
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ success: true, gradedResults: graded.length, optimizeError: e.message }) };
  }
};

function inferBetType(pickStr) {
  if (!pickStr) return "Unknown";
  if (/over|under/i.test(pickStr)) return "Total";
  if (/\bML\b|moneyline/i.test(pickStr)) return "Moneyline";
  if (/[+-]\d/.test(pickStr)) return "Spread";
  return "Unknown";
}

function countBy(arr, key) {
  const counts = {};
  for (const item of arr) {
    const val = item[key] || "Unknown";
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}
