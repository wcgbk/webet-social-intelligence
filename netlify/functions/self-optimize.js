// self-optimize.js
// Weekly performance OBSERVER for WeBetAI (v10.4 rebuild, 2026-08-03).
//
// Runs Sunday. Analyzes the last 45 days of graded results and stores an
// analytics + alarms report. As of v10.4 this is an OBSERVER, not a steerer:
// the generator no longer applies these parameters to live picks. The old
// closed loop inflated coverProb for whatever segment ran hot in the trailing
// window (momentum-chasing — it manufactured phantom EV and stuffed regressing
// segments into the top unit tier right as they mean-reverted), and its unit
// multipliers mostly evaporated in 0.5u rounding anyway. Sizing policy now
// lives in the generator's static per-market caps, changed deliberately.
//
// What this computes weekly:
// 1. Per-sport / per-market win rate AND ROI (real risked units, not count×1u)
// 2. Grade-level accuracy + a GRADE-INVERSION ALARM (A-tier hitting below
//    B-tier = the conviction ladder is anti-predictive — a bug signature)
// 3. Confidence calibration when cover data is present in the cache

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Parlay-leg CLV (v10.4.2 observer add-on) ──
// A variance-heavy parlay P/L can't tell you whether parlays are a real edge or luck. CLV can:
// are the LEGS we parlay actually beating the closing line? If yes, the compounding parlay
// profit is a real edge worth Kelly-scaling; if no, it's variance that will revert. Reads the
// clv-{date} blobs (per-pick CLV from track-clv) + picks-{date} blobs (the actual parlay legs),
// matches legs -> CLV records, aggregates overall + per leg-market. Observational only.
async function analyzeParlayLegCLV(token, days = 60) {
  const base = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha`;
  const H = { Authorization: `Bearer ${token}` };
  const getJSON = async (key) => {
    try { const r = await fetch(`${base}/${key}`, { headers: H }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  };
  const idx = await getJSON("picks-dates");
  let dates = Array.isArray(idx) ? idx : [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  dates = dates.filter(d => d >= cutoff).sort();
  if (!dates.length) return null;

  const overall = { n: 0, clvSum: 0, beat: 0 };
  const byMarket = {};
  let parlaysCovered = 0, legsTotal = 0, legsMatched = 0;

  const processDate = async (d) => {
    const [picks, clv] = await Promise.all([getJSON(`picks-${d}`), getJSON(`clv-${d}`)]);
    if (!picks || !clv || !Array.isArray(clv.picks)) return;
    const parlay = (picks.parlayLegs && picks.parlayLegs[0]) || null;
    const legs = (parlay && Array.isArray(parlay.legs)) ? parlay.legs : null;
    if (!legs || legs.length < 2) return;
    parlaysCovered++;
    const clvByKey = new Map(clv.picks.map(p => [`${p.pick}||${p.matchup}`, p]));
    for (const leg of legs) {
      legsTotal++;
      const rec = clvByKey.get(`${leg.pick}||${leg.matchup}`);
      if (!rec || typeof rec.clvCents !== "number") continue;
      legsMatched++;
      overall.n++; overall.clvSum += rec.clvCents; if (rec.beatClosing) overall.beat++;
      const m = rec.market || rec.betType || leg.betType || "Unknown";
      if (!byMarket[m]) byMarket[m] = { n: 0, clvSum: 0, beat: 0 };
      byMarket[m].n++; byMarket[m].clvSum += rec.clvCents; if (rec.beatClosing) byMarket[m].beat++;
    }
  };
  // Batch to bound concurrency (2 blob fetches/date) so this stays well under the function
  // timeout even across a 60-day window.
  const BATCH = 12;
  for (let i = 0; i < dates.length; i += BATCH) {
    await Promise.all(dates.slice(i, i + BATCH).map(processDate));
  }

  if (overall.n === 0) return { window: `${days}d`, parlaysCovered, legsTotal, legsMatched: 0, note: "no parlay legs matched a CLV record yet" };

  const fin = (b) => ({ n: b.n, avgCLVCents: +(b.clvSum / b.n).toFixed(2), beatCloseRate: +(b.beat / b.n).toFixed(3) });
  const out = {
    window: `${days}d`, parlaysCovered, legsTotal, legsMatched,
    coverage: +(legsMatched / legsTotal).toFixed(2),
    ...fin(overall),
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([k, v]) => [k, fin(v)])),
  };
  // Verdict: CLV is the only thing that separates a real parlay edge from variance.
  if (out.n >= 30 && out.beatCloseRate >= 0.53 && out.avgCLVCents > 0) {
    out.verdict = "positive";
    out.recommendation = `Parlay legs beat the close ${(out.beatCloseRate*100).toFixed(0)}% (avg +${out.avgCLVCents}c) over ${out.n} legs — the parlay edge is REAL. A modest Kelly-based stake increase is justified; source legs from the highest-CLV markets.`;
  } else if (out.n >= 30 && out.beatCloseRate < 0.48) {
    out.verdict = "negative";
    out.recommendation = `Parlay legs are NOT beating the close (${(out.beatCloseRate*100).toFixed(0)}%, avg ${out.avgCLVCents}c) over ${out.n} legs — the parlay profit is VARIANCE, not edge. Hold or cut the parlay stake; do not scale.`;
  } else {
    out.verdict = "inconclusive";
    out.recommendation = `${out.n} legs tracked (need ~30+ with a clear signal). Beat-close ${(out.beatCloseRate*100).toFixed(0)}%, avg ${out.avgCLVCents}c — hold the stake steady and keep tracking.`;
  }
  return out;
}

// ── Discord digest (v10.4.4) ──
// The observer is only useful if someone reads it. Each Sunday run posts a short model-health
// digest (parlay-CLV verdict, grade-inversion alarm, segment ROI) to a Discord webhook so it
// reaches the operator instead of sitting in a blob. Webhook lives in a blob (not git — it's a
// write-to-channel secret); env DISCORD_OBSERVER_WEBHOOK overrides.
function buildObserverDigest(params) {
  const d = (params.generatedAt || '').split('T')[0];
  const L = [`📊 **WeBetAI Weekly Observer** — ${d}`, `_sample: ${params.sampleSize} graded picks (observational; no live steering)_`, ''];
  const pl = params.parlayLegCLV;
  if (pl && pl.verdict) {
    const e = pl.verdict === 'positive' ? '🟢' : pl.verdict === 'negative' ? '🔴' : '🟡';
    L.push(`${e} **Parlay-leg CLV: ${pl.verdict.toUpperCase()}** — ${(pl.beatCloseRate * 100).toFixed(0)}% beat close, ${pl.avgCLVCents >= 0 ? '+' : ''}${pl.avgCLVCents}¢ avg (n=${pl.n})`);
    L.push(pl.recommendation);
    const mk = Object.entries(pl.byMarket || {}).filter(([, v]) => v.n >= 5)
      .sort((a, b) => b[1].avgCLVCents - a[1].avgCLVCents)
      .map(([m, v]) => `${m} ${v.avgCLVCents >= 0 ? '+' : ''}${v.avgCLVCents}¢/${(v.beatCloseRate * 100).toFixed(0)}%`);
    if (mk.length) L.push(`   legs by market (best→worst): ${mk.join(' · ')}`);
    L.push('');
  } else if (pl) {
    L.push(`🟡 **Parlay-leg CLV:** ${pl.legsMatched || 0} legs matched — ${pl.note || 'building sample'}`, '');
  }
  for (const a of (params.alerts || [])) if (!a.startsWith('PARLAY CLV')) L.push(`⚠️ ${a}`);
  if (params.marketROI && Object.keys(params.marketROI).length) {
    L.push('', `**Market ROI (45d):** ` + Object.entries(params.marketROI).map(([m, r]) => `${m} ${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%`).join(' · '));
  }
  return L.join('\n').slice(0, 1900);
}
async function postObserverDigest(token, params) {
  let webhook = process.env.DISCORD_OBSERVER_WEBHOOK || null;
  if (!webhook) {
    try {
      const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/observer-webhook`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) webhook = (await r.text()).trim();
    } catch (e) { /* ignore */ }
  }
  if (!webhook || !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
    console.log('[self-optimize] No Discord observer webhook configured — skipping digest');
    return;
  }
  try {
    const resp = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: buildObserverDigest(params), username: 'WeBetAI Observer' }),
    });
    console.log(`[self-optimize] Posted observer digest to Discord: HTTP ${resp.status}`);
  } catch (e) { console.log(`[self-optimize] Discord digest post failed (non-fatal): ${e.message}`); }
}

exports.handler = async (event) => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { statusCode: 500, body: "Missing auth token" };

  console.log("[self-optimize] Starting self-optimization cycle");

  // ── Step 1: Fetch recent results ──
  // 2026-06-12: repointed from edge-picks/results-cache (production store — FROZEN since the
  // prod cron was paused Jun 5) to the live alpha track record. Alpha is the primary pipeline;
  // self-optimization must learn from the model that is actually running.
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
          // v10.4: F5 detected FIRST — "Nationals F5 ML" used to pollute the Moneyline
          // bucket and "F5 Over 4.5" was misfiled as Run Line, so market stats steered
          // (and now report) the wrong segments.
          const isF5 = /\bf5\b/i.test(pickStr);
          const betType = isF5
            ? (/over|under/i.test(pickStr) ? "F5 Total"
              : / ML\b/i.test(pickStr) ? "F5 Moneyline"
              : "F5 Run Line")
            : /^(Over|Under)/.test(pickStr) ? "Total"
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

  const DOLLARS_PER_UNIT = 150;
  for (const r of allResults) {
    const sport = r.sport || "Unknown";
    const market = r.betType || r.market || "Unknown";
    const grade = r.rating || r.grade || "B";
    const won = r.result === "win";
    const profit = r.profit || 0;
    // v10.4: real dollars risked per pick (units × $150). The old count×$150 assumed every
    // pick was 1u, which distorted every ROI this function reported.
    const risked = (parseFloat(r.units) || 1) * DOLLARS_PER_UNIT;
    const edge = parseFloat(r.edgePoints || r.edge || 0);

    // By sport
    if (!buckets.bySport[sport]) buckets.bySport[sport] = { wins: 0, losses: 0, profit: 0, risked: 0, count: 0 };
    buckets.bySport[sport].count++;
    buckets.bySport[sport].profit += profit;
    buckets.bySport[sport].risked += risked;
    if (won) buckets.bySport[sport].wins++; else buckets.bySport[sport].losses++;

    // By market
    if (!buckets.byMarket[market]) buckets.byMarket[market] = { wins: 0, losses: 0, profit: 0, risked: 0, count: 0 };
    buckets.byMarket[market].count++;
    buckets.byMarket[market].profit += profit;
    buckets.byMarket[market].risked += risked;
    if (won) buckets.byMarket[market].wins++; else buckets.byMarket[market].losses++;

    // By sport+market
    const sm = `${sport}_${market}`;
    if (!buckets.bySportMarket[sm]) buckets.bySportMarket[sm] = { wins: 0, losses: 0, profit: 0, risked: 0, count: 0 };
    buckets.bySportMarket[sm].count++;
    buckets.bySportMarket[sm].profit += profit;
    buckets.bySportMarket[sm].risked += risked;
    if (won) buckets.bySportMarket[sm].wins++; else buckets.bySportMarket[sm].losses++;

    // By edge bucket — only when the cache row actually carries an edge value (the
    // results cache historically didn't, which silently filed EVERY pick under "0-3").
    if (edge > 0) {
      const edgeBucket = edge < 3 ? "0-3" : edge < 6 ? "3-6" : edge < 10 ? "6-10" : edge < 15 ? "10-15" : "15+";
      if (!buckets.byEdgeBucket[edgeBucket]) buckets.byEdgeBucket[edgeBucket] = { wins: 0, losses: 0, count: 0 };
      buckets.byEdgeBucket[edgeBucket].count++;
      if (won) buckets.byEdgeBucket[edgeBucket].wins++; else buckets.byEdgeBucket[edgeBucket].losses++;
    }

    // By grade
    if (!buckets.byGrade[grade]) buckets.byGrade[grade] = { wins: 0, losses: 0, count: 0 };
    buckets.byGrade[grade].count++;
    if (won) buckets.byGrade[grade].wins++; else buckets.byGrade[grade].losses++;
  }

  // ── Step 3: Compute the weekly report ──
  // observationalOnly: the generator loads this blob for logging but applies NOTHING from it
  // (v10.4). The multiplier fields remain as diagnostics of where the model has been sharp.
  const params = {
    generatedAt: new Date().toISOString(),
    sampleSize: allResults.length,
    observationalOnly: true,
    alerts: [],
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

  // v10.4: coverProbAdjust REMOVED. Shifting claimed probabilities toward whatever segment
  // ran hot in the trailing window is momentum-chasing — it corrupted calibration and EV at
  // the exact moment segments mean-reverted. Probability fixes belong in the pricing model's
  // calibration constants, changed deliberately, never from a live feedback loop.
  // Per-segment win rates remain visible in buckets.bySportMarket (stored with history).

  // Edge bucket performance — identifies which edge ranges are profitable
  // This tells us whether to tighten or loosen edge thresholds
  for (const [bucket, data] of Object.entries(buckets.byEdgeBucket)) {
    params.edgeBucketPerformance[bucket] = {
      accuracy: data.count > 0 ? +(data.wins / data.count).toFixed(3) : 0,
      count: data.count,
    };
  }

  // ── Step 3b: Real ROI per sport AND per market (v10.4: actual risked dollars) ──
  // Win rate alone misleads — a market can win 55% and lose money at -110, while ML dogs can
  // win 48% and profit. ROI on real stakes is the honest number; CLV (from the weekly clv-*
  // blobs) is its market-validated companion in the review.
  params.sportROI = {};
  for (const [sport, data] of Object.entries(buckets.bySport)) {
    if (data.count < MIN_SAMPLE) continue;
    params.sportROI[sport] = data.risked > 0 ? +(data.profit / data.risked).toFixed(4) : 0;
    console.log(`[self-optimize] ${sport} ROI=${(params.sportROI[sport]*100).toFixed(1)}% on $${data.risked} risked`);
  }
  params.marketROI = {};
  for (const [market, data] of Object.entries(buckets.byMarket)) {
    if (data.count < MIN_SAMPLE) continue;
    params.marketROI[market] = data.risked > 0 ? +(data.profit / data.risked).toFixed(4) : 0;
    console.log(`[self-optimize] ${market} ROI=${(params.marketROI[market]*100).toFixed(1)}% on $${data.risked} risked (${data.wins}W-${data.losses}L)`);
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

  // ── Step 3c2: GRADE-INVERSION ALARM (v10.4) ──
  // If the A-tier (A+/A/A-) hits BELOW the B-tier on a real sample, the conviction ladder is
  // anti-predictive — a ranking/sizing bug signature, not variance. This exact inversion
  // preceded the post-All-Star-break slump and sat unread in gradeAccuracy every Sunday.
  const tierAcc = (grades) => grades.reduce((acc, g) => {
    const d = buckets.byGrade[g];
    if (d) { acc.w += d.wins; acc.n += d.wins + d.losses; }
    return acc;
  }, { w: 0, n: 0 });
  const aTier = tierAcc(["A+", "A", "A-"]);
  const bTier = tierAcc(["B+", "B", "B-"]);
  if (aTier.n >= 20 && bTier.n >= 20) {
    const aAcc = aTier.w / aTier.n, bAcc = bTier.w / bTier.n;
    if (aAcc < bAcc - 0.05) {
      const msg = `GRADE INVERSION: A-tier ${(aAcc * 100).toFixed(1)}% (n=${aTier.n}) below B-tier ${(bAcc * 100).toFixed(1)}% (n=${bTier.n}) — the conviction ladder is anti-predictive; audit ranking + per-market caps before trusting unit sizes`;
      params.alerts.push(msg);
      console.error(`[self-optimize] ⚠️ ${msg}`);
    } else {
      console.log(`[self-optimize] Grade ladder healthy: A-tier ${(aAcc * 100).toFixed(1)}% (n=${aTier.n}) vs B-tier ${(bAcc * 100).toFixed(1)}% (n=${bTier.n})`);
    }
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

  // ── Step 3f: Parlay-leg CLV — is the parlay a real edge or variance? ──
  // The signal that tells us whether to Kelly-scale the parlay stake or hold it steady.
  try {
    const plCLV = await analyzeParlayLegCLV(token, 60);
    if (plCLV) {
      params.parlayLegCLV = plCLV;
      const ranked = Object.entries(plCLV.byMarket || {})
        .filter(([, v]) => v.n >= 5)
        .sort((a, b) => b[1].avgCLVCents - a[1].avgCLVCents)
        .map(([m, v]) => `${m} ${v.avgCLVCents >= 0 ? '+' : ''}${v.avgCLVCents}c/${(v.beatCloseRate * 100).toFixed(0)}%`);
      if (ranked.length) console.log(`[self-optimize] Parlay-leg CLV by market (best→worst): ${ranked.join(' | ')}`);
      if (plCLV.recommendation) {
        console.log(`[self-optimize] Parlay-leg CLV verdict: ${plCLV.verdict} — ${plCLV.recommendation}`);
        params.alerts.push(`PARLAY CLV (${plCLV.verdict}): ${plCLV.recommendation}`);
      }
    }
  } catch (e) {
    console.log(`[self-optimize] Parlay-leg CLV analysis failed (non-fatal): ${e.message}`);
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
    console.log(`[self-optimize] Stored optimized parameters (${allResults.length} results analyzed)`);
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

  // ── Step 6: Push the digest to Discord so the operator actually sees it ──
  await postObserverDigest(token, params);

  return {
    statusCode: 200,
    body: JSON.stringify({
      observationalOnly: true,
      sampleSize: allResults.length,
      sportROI: params.sportROI,
      marketROI: params.marketROI,
      gradeAccuracy: params.gradeAccuracy,
      parlayLegCLV: params.parlayLegCLV,
      alerts: params.alerts,
    }),
  };
};
