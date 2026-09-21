// self-optimize.js
// Weekly performance OBSERVER for WeBetAI Alpha (aligned with self-optimize-omega.js, 2026-09-21).
//
// Runs Sunday. Analyzes the last 45 days of graded Alpha results and stores an
// analytics + alarms report. This is an OBSERVER, not a steerer:
// generators must NEVER apply these parameters to live picks. The old closed
// loop inflated coverProb for whatever segment ran hot in the trailing window
// (momentum-chasing — it manufactured phantom EV and stuffed regressing
// segments into the top unit tier right as they mean-reverted), and its unit
// multipliers mostly evaporated in 0.5u rounding anyway. Sizing policy now
// lives in the generator's static per-market caps, changed deliberately.
//
// What this computes weekly (stored for humans / dashboards / Discord digests):
// 1. Per-sport / per-market win rate AND ROI
// 2. Grade-level accuracy (diagnostic — not fed back into Kelly)
// 3. Edge-bucket performance + confidence calibration when cover data is present
//
// Storing the analytics blob is fine. Auto-steering from it is not.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { statusCode: 500, body: "Missing auth token" };

  console.log("[self-optimize] Starting self-optimization cycle");

  // ── Step 1: Fetch recent results ──
  // 2026-06-12: repointed from edge-picks/results-cache (production store — FROZEN since the
  // prod cron was paused Jun 5) to the live alpha track record. Alpha is the primary pipeline;
  // the observer report must reflect the model that is actually running (no auto-steer).
  let allResults = [];
  try {
    const resultsResp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha/results-alpha-cache-v5`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resultsResp.ok) {
      const data = await resultsResp.json();
      // Cache shape is { days: [{ date, picks: [...] }] } — flatten to graded straight picks,
      // derive betType from the pick string (cache rows don't carry it), keep last 45 days.
      const days = Array.isArray(data.days) ? data.days : [];
      const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().split("T")[0];
      for (const day of days) {
        if (!day.date || day.date < cutoff) continue;
        for (const p of day.picks || []) {
          if (p.sport === "PARLAY") continue;
          if (p.result !== "win" && p.result !== "loss") continue;
          const pickStr = p.pick || "";
          const betType = /^(Over|Under)/.test(pickStr) ? "Total"
            : / ML$/.test(pickStr) ? "Moneyline"
            : p.sport === "NHL" ? "Puck Line"
            : p.sport === "MLB" ? "Run Line"
            : "Spread";
          allResults.push({ ...p, betType, date: day.date });
        }
      }
      console.log(`[self-optimize] Loaded ${allResults.length} graded results from alpha track record (${days.length} days in cache)`);
    }
    // Fallback to the legacy production cache if the alpha cache is missing or thin
    if (allResults.length < 10) {
      const legacyResp = await fetch(
        `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/results-cache`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      if (legacyResp.ok) {
        const data = await legacyResp.json();
        allResults = data.results || data.picks || [];
        console.log(`[self-optimize] Fallback: loaded ${allResults.length} results from legacy edge-picks cache`);
      }
    }
  } catch (e) {
    console.log(`[self-optimize] Results fetch failed: ${e.message}`);
    return { statusCode: 500, body: "Failed to load results" };
  }

  if (allResults.length < 10) {
    console.log(`[self-optimize] Insufficient data (${allResults.length} results, need 10+)`);
    return { statusCode: 200, body: "Insufficient data for optimization" };
  }

  // ── Step 2: Compute per-bucket performance ──
  const buckets = {
    bySport: {},       // { "NBA": { wins, losses, profit, count } }
    byMarket: {},      // { "Total": { wins, losses, profit, count } }
    bySportMarket: {}, // { "NBA_Total": { ... } }
    byEdgeBucket: {},  // { "6-10": { wins, losses, accuracy } }
    byGrade: {},       // { "A": { wins, losses, accuracy } }
  };

  for (const r of allResults) {
    const sport = r.sport || "Unknown";
    const market = r.betType || r.market || "Unknown";
    const grade = r.rating || r.grade || "B";
    const won = r.result === "win";
    const profit = r.profit || 0;
    const edge = parseFloat(r.edgePoints || r.edge || 0);

    // By sport
    if (!buckets.bySport[sport]) buckets.bySport[sport] = { wins: 0, losses: 0, profit: 0, count: 0 };
    buckets.bySport[sport].count++;
    buckets.bySport[sport].profit += profit;
    if (won) buckets.bySport[sport].wins++; else buckets.bySport[sport].losses++;

    // By market
    if (!buckets.byMarket[market]) buckets.byMarket[market] = { wins: 0, losses: 0, profit: 0, count: 0 };
    buckets.byMarket[market].count++;
    buckets.byMarket[market].profit += profit;
    if (won) buckets.byMarket[market].wins++; else buckets.byMarket[market].losses++;

    // By sport+market
    const sm = `${sport}_${market}`;
    if (!buckets.bySportMarket[sm]) buckets.bySportMarket[sm] = { wins: 0, losses: 0, profit: 0, count: 0 };
    buckets.bySportMarket[sm].count++;
    buckets.bySportMarket[sm].profit += profit;
    if (won) buckets.bySportMarket[sm].wins++; else buckets.bySportMarket[sm].losses++;

    // By edge bucket
    const edgeBucket = edge < 3 ? "0-3" : edge < 6 ? "3-6" : edge < 10 ? "6-10" : edge < 15 ? "10-15" : "15+";
    if (!buckets.byEdgeBucket[edgeBucket]) buckets.byEdgeBucket[edgeBucket] = { wins: 0, losses: 0, count: 0 };
    buckets.byEdgeBucket[edgeBucket].count++;
    if (won) buckets.byEdgeBucket[edgeBucket].wins++; else buckets.byEdgeBucket[edgeBucket].losses++;

    // By grade
    if (!buckets.byGrade[grade]) buckets.byGrade[grade] = { wins: 0, losses: 0, count: 0 };
    buckets.byGrade[grade].count++;
    if (won) buckets.byGrade[grade].wins++; else buckets.byGrade[grade].losses++;
  }

  // ── Step 3: Compute the weekly report ──
  // observationalOnly: generators may load this blob for logging but apply NOTHING from it.
  // Multiplier fields remain as diagnostics of where the model has been sharp.
  const params = {
    generatedAt: new Date().toISOString(),
    sampleSize: allResults.length,
    observationalOnly: true,
    sportKellyMult: {},
    marketKellyMult: {},
    edgeBucketPerformance: {},
  };

  // Sport Kelly multipliers: normalize to overall win rate
  const overallWinRate = allResults.filter(r => r.result === "win").length / allResults.length;
  const MIN_SAMPLE = 8; // Lower threshold during early phase (< 100 results). Raise to 15 once corpus grows.
  const MAX_ADJ_PER_CYCLE = 0.10; // max 10% adjustment per cycle
  const MEAN_REVERSION = 0.02; // 2% drift back toward 1.0 per cycle

  for (const [sport, data] of Object.entries(buckets.bySport)) {
    if (data.count < MIN_SAMPLE) continue;
    const sportWinRate = data.wins / data.count;
    const rawMult = sportWinRate / Math.max(overallWinRate, 0.45);
    // Clamp to [1 - MAX_ADJ, 1 + MAX_ADJ] relative to current
    const clampedMult = Math.max(1.0 - MAX_ADJ_PER_CYCLE, Math.min(1.0 + MAX_ADJ_PER_CYCLE, rawMult));
    // Apply mean-reversion (pull toward 1.0 slightly)
    const finalMult = clampedMult + (1.0 - clampedMult) * MEAN_REVERSION;
    params.sportKellyMult[sport] = +finalMult.toFixed(3);
    console.log(`[self-optimize] ${sport}: ${data.wins}W-${data.losses}L (${(sportWinRate*100).toFixed(0)}%), mult=${finalMult.toFixed(3)}`);
  }

  // Market Kelly multipliers
  for (const [market, data] of Object.entries(buckets.byMarket)) {
    if (data.count < MIN_SAMPLE) continue;
    const marketWinRate = data.wins / data.count;
    const rawMult = marketWinRate / Math.max(overallWinRate, 0.45);
    const clampedMult = Math.max(1.0 - MAX_ADJ_PER_CYCLE, Math.min(1.0 + MAX_ADJ_PER_CYCLE, rawMult));
    const finalMult = clampedMult + (1.0 - clampedMult) * MEAN_REVERSION;
    params.marketKellyMult[market] = +finalMult.toFixed(3);
    console.log(`[self-optimize] ${market}: ${data.wins}W-${data.losses}L (${(marketWinRate*100).toFixed(0)}%), mult=${finalMult.toFixed(3)}`);
  }

  // coverProbAdjust REMOVED (observer rule). Shifting claimed probabilities toward whatever
  // segment ran hot in the trailing window is momentum-chasing — it corrupted calibration
  // and EV at the exact moment segments mean-reverted. Probability fixes belong in the
  // pricing model's calibration constants, changed deliberately, never from a live loop.
  // Per-segment win rates remain visible in buckets.bySportMarket (stored with history).

  // Edge bucket performance — identifies which edge ranges are profitable
  // This tells us whether to tighten or loosen edge thresholds
  for (const [bucket, data] of Object.entries(buckets.byEdgeBucket)) {
    params.edgeBucketPerformance[bucket] = {
      accuracy: data.count > 0 ? +(data.wins / data.count).toFixed(3) : 0,
      count: data.count,
    };
  }

  // ── Step 3b: ROI-weighted sport multipliers (profit-based, not just accuracy) ──
  // Win rate can be misleading — a sport could win 55% but lose money on -110 juice.
  // ROI captures the actual profitability.
  params.sportROI = {};
  for (const [sport, data] of Object.entries(buckets.bySport)) {
    if (data.count < MIN_SAMPLE) continue;
    const wagered = data.count * 150; // $150/unit approximate
    const roi = wagered > 0 ? data.profit / wagered : 0;
    params.sportROI[sport] = +roi.toFixed(4);

    // Diagnostic blend only — generators do not apply sportKellyMult (observer rule).
    if (roi > 0.05) {
      const roiBoost = Math.min(1.20, 1.0 + roi * 2);
      const accuracyMult = params.sportKellyMult[sport] || 1.0;
      params.sportKellyMult[sport] = +((accuracyMult * 0.7 + roiBoost * 0.3)).toFixed(3);
      console.log(`[self-optimize] ${sport} ROI=${(roi*100).toFixed(1)}%, diagnostic mult=${params.sportKellyMult[sport]}`);
    } else if (roi < -0.05) {
      const roiPenalty = Math.max(0.85, 1.0 + roi * 2);
      const accuracyMult = params.sportKellyMult[sport] || 1.0;
      params.sportKellyMult[sport] = +((accuracyMult * 0.7 + roiPenalty * 0.3)).toFixed(3);
      console.log(`[self-optimize] ${sport} ROI=${(roi*100).toFixed(1)}%, diagnostic mult=${params.sportKellyMult[sport]}`);
    }
  }

  // ── Step 3c: Grade-level accuracy analysis ──
  // Are A+ picks actually more accurate than B picks? If not, our grading system is miscalibrated.
  params.gradeAccuracy = {};
  for (const [grade, data] of Object.entries(buckets.byGrade)) {
    if (data.count < 5) continue;
    params.gradeAccuracy[grade] = {
      accuracy: +(data.wins / data.count).toFixed(3),
      count: data.count,
    };
    console.log(`[self-optimize] Grade ${grade}: ${data.wins}W-${data.losses}L (${(data.wins/data.count*100).toFixed(0)}%)`);
  }

  // ── Step 3d: Optimal edge threshold recommendation ──
  // Find the edge bucket with the best accuracy to recommend tightening/loosening thresholds
  const profitableBuckets = Object.entries(params.edgeBucketPerformance)
    .filter(([_, d]) => d.count >= 10 && d.accuracy > 0.52)
    .sort((a, b) => b[1].accuracy - a[1].accuracy);
  if (profitableBuckets.length > 0) {
    params.optimalEdgeRange = profitableBuckets[0][0];
    params.optimalEdgeAccuracy = profitableBuckets[0][1].accuracy;
    console.log(`[self-optimize] Optimal edge range: ${params.optimalEdgeRange} (${(params.optimalEdgeAccuracy*100).toFixed(0)}% accuracy)`);
  }

  // ── Step 3e: Confidence calibration ──
  // Compare predicted cover probability to actual hit rate.
  // Buckets: <50%, 50-55%, 55-60%, 60-65%, 65%+
  const coverBuckets = { "<50%": { pred: 0, actual: 0, n: 0 }, "50-55%": { pred: 0, actual: 0, n: 0 },
    "55-60%": { pred: 0, actual: 0, n: 0 }, "60-65%": { pred: 0, actual: 0, n: 0 }, "65%+": { pred: 0, actual: 0, n: 0 } };
  for (const r of allResults) {
    const cover = r.cover || (parseFloat(r.winProbability) / 100) || 0;
    if (cover <= 0) continue;
    const won = r.result === "win" ? 1 : 0;
    const bucket = cover < 0.50 ? "<50%" : cover < 0.55 ? "50-55%" : cover < 0.60 ? "55-60%" : cover < 0.65 ? "60-65%" : "65%+";
    coverBuckets[bucket].pred += cover;
    coverBuckets[bucket].actual += won;
    coverBuckets[bucket].n++;
  }
  params.confidenceCalibration = {};
  for (const [bucket, data] of Object.entries(coverBuckets)) {
    if (data.n < 5) continue;
    const avgPredicted = data.pred / data.n;
    const actualRate = data.actual / data.n;
    params.confidenceCalibration[bucket] = {
      avgPredicted: +avgPredicted.toFixed(3),
      actualRate: +actualRate.toFixed(3),
      gap: +(actualRate - avgPredicted).toFixed(3),
      n: data.n,
    };
    console.log(`[self-optimize] Calibration ${bucket}: predicted=${(avgPredicted*100).toFixed(0)}%, actual=${(actualRate*100).toFixed(0)}%, gap=${((actualRate-avgPredicted)*100).toFixed(0)}%`);
  }

  // ── Step 4: Store optimized parameters ──
  try {
    await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/self-optimize-params`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }
    );
    console.log(`[self-optimize] Stored observer report (${allResults.length} results analyzed; observationalOnly=true)`);
  } catch (e) {
    console.log(`[self-optimize] Failed to store params: ${e.message}`);
  }

  // ── Step 5: Store optimization history for trend tracking ──
  try {
    const historyKey = `self-optimize-history-${new Date().toISOString().split('T')[0]}`;
    await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/${historyKey}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, buckets }),
      }
    );
  } catch (e) { /* non-critical */ }

  return {
    statusCode: 200,
    body: JSON.stringify({
      sampleSize: allResults.length,
      observationalOnly: true,
      sportMults: params.sportKellyMult,
      marketMults: params.marketKellyMult,
    }),
  };
};
