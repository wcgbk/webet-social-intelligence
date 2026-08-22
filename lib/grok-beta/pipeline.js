"use strict";

const { getVersion } = require("./version");
const { evaluateGame, selectAndCap, MAX_PICKS } = require("./engine");
const {
  easternDateISO, formatDateLong, gameEasternDate,
  fetchAllOdds, attachEspn, fetchKalshiBrief, fetchPolymarketBrief, matchPredPrice,
} = require("./adapters");
const {
  writeOddsSnapshot, writeCandidates, writePublished, writeStatus,
} = require("./store");
const { validateCandidates } = require("./validate");
const { stubCloseCapture } = require("./close-capture");

function emptyPublished(dateISO, extra) {
  const version = getVersion();
  return {
    error: false,
    date: dateISO,
    dateFormatted: formatDateLong(dateISO),
    modelVersion: version,
    generatedAt: new Date().toISOString(),
    noPlays: extra.noPlays || "Grok Beta has not priced this slate yet.",
    picks: [],
    rejections: extra.rejections || [],
    parlayLegs: [],
    edgeSummary: extra.edgeSummary || "",
    sportsScanned: extra.sportsScanned || [],
    gamesScanned: extra.gamesScanned || 0,
    candidateCount: extra.candidateCount || 0,
    summary: {
      totalPicks: 0,
      totalUnits: "0u",
      aplusLocks: 0,
      sportsCovered: [],
    },
    record: { wins: 0, losses: 0, pushes: 0, roi: null, units: 0, n: 0 },
    ...extra,
  };
}

async function runGrokBeta(opts = {}) {
  const started = Date.now();
  const now = opts.now ? new Date(opts.now) : new Date();
  const dateISO = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : easternDateISO(now);
  const version = getVersion();
  const dryRun = !!opts.dryRun;
  const skipValidate = !!opts.skipValidate;
  const force = !!opts.force;
  console.log(`[grok-beta] ${version} run date=${dateISO} dryRun=${dryRun} force=${force}`);

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    const payload = emptyPublished(dateISO, { noPlays: "Grok Beta blocked: ODDS_API_KEY missing.", blocked: "ODDS_API_KEY" });
    if (!dryRun) {
      await writePublished(dateISO, payload);
      await writeStatus({ lastRun: new Date().toISOString(), date: dateISO, picksToday: 0, version, ok: false, blocked: "ODDS_API_KEY" });
    }
    return payload;
  }

  const oddsBundles = await fetchAllOdds(apiKey);
  const sportsScanned = oddsBundles.filter(b => (b.games || []).length).map(b => b.meta?.label || b.sport);
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const snapshot = {
    date: dateISO,
    capturedAt: now.toISOString(),
    version,
    sports: oddsBundles.map(b => ({
      sport: b.sport,
      label: b.meta?.label,
      gameCount: (b.games || []).length,
      remaining: b.remaining || null,
      error: b.error || null,
    })),
    games: oddsBundles.flatMap(b => (b.games || []).map(g => ({
      sport: b.sport,
      id: g.id,
      home_team: g.home_team,
      away_team: g.away_team,
      commence_time: g.commence_time,
      bookmakers: g.bookmakers,
    }))),
  };
  if (!dryRun) await writeOddsSnapshot(dateISO, ts, snapshot);

  const remaining = [];
  const skipped = { started: 0, wrongDay: 0 };
  for (const b of oddsBundles) {
    for (const g of b.games || []) {
      const ct = Date.parse(g.commence_time);
      if (!Number.isFinite(ct)) continue;
      if (gameEasternDate(g.commence_time) !== dateISO) { skipped.wrongDay++; continue; }
      if (ct <= now.getTime()) { skipped.started++; continue; }
      remaining.push({ bundle: b, game: g });
    }
  }

  // Re-bundle remaining games for ESPN attach
  const remainingBundles = [];
  const bySport = new Map();
  for (const r of remaining) {
    if (!bySport.has(r.bundle.sport)) {
      const copy = { ...r.bundle, games: [] };
      bySport.set(r.bundle.sport, copy);
      remainingBundles.push(copy);
    }
    bySport.get(r.bundle.sport).games.push(r.game);
  }

  const { enriched } = await attachEspn(remainingBundles, dateISO);

  let predMarkets = [];
  try {
    const [k, p] = await Promise.all([fetchKalshiBrief(), fetchPolymarketBrief()]);
    predMarkets = [...k, ...p];
  } catch (e) {
    console.log(`[grok-beta] pred markets optional fail: ${e.message}`);
  }

  const allCandidates = [];
  const allRejections = [];
  let liveOrPostponed = 0;
  for (const game of enriched) {
    if (game.postponed) {
      allRejections.push({ matchup: `${game.awayTeam} @ ${game.homeTeam}`, reason: "postponed/canceled" });
      liveOrPostponed++;
      continue;
    }
    if (game.espnState && game.espnState !== "pre") {
      allRejections.push({ matchup: `${game.awayTeam} @ ${game.homeTeam}`, reason: `espn state ${game.espnState}` });
      liveOrPostponed++;
      continue;
    }
    const ct = Date.parse(game.commenceTime);
    if (Number.isFinite(ct) && ct <= now.getTime()) {
      skipped.started++;
      continue;
    }
    const pm = matchPredPrice(game.homeTeam, game.awayTeam, predMarkets);
    const predPrice = pm ? { market: "h2h", side: "home", price: pm.priceHome } : null;
    const { candidates, rejections } = evaluateGame(game, game.oddsGame, predPrice);
    allCandidates.push(...candidates);
    allRejections.push(...rejections);
  }

  const capped = selectAndCap(allCandidates);
  const candidateDoc = {
    date: dateISO,
    version,
    frozenAt: new Date().toISOString(),
    snapshotKey: `odds/${dateISO}/${ts}`,
    gamesRemaining: remaining.length,
    skipped,
    sportsScanned,
    candidates: capped,
    rejectedBeforeCap: allCandidates.length - capped.length,
    rejections: allRejections.slice(0, 400),
  };
  if (!dryRun) await writeCandidates(dateISO, candidateDoc);

  let validated = { picks: capped, rejections: [], agentReports: [] };
  if (!skipValidate && capped.length) {
    validated = await validateCandidates(capped);
  }

  const picks = (validated.picks || []).slice(0, MAX_PICKS);
  const totalUnits = picks.reduce((s, p) => s + (parseFloat(p.units) || 0), 0);
  const sportsCovered = [...new Set(picks.map(p => p.sport))];

  let noPlays = null;
  let edgeSummary = "";
  if (!picks.length) {
    if (remaining.length === 0 && skipped.started > 0) {
      noPlays = `Grok Beta scanned today's slate — every listed game has already started (${skipped.started} started). No remaining unstarted games to price.`;
    } else if (remaining.length === 0) {
      noPlays = "Grok Beta has not priced this slate yet.";
    } else {
      noPlays = `Grok Beta scanned ${remaining.length} unstarted game(s) across ${(sportsScanned).join(", ") || "today's feeds"}. Nothing cleared the 4.8pt edge / 5.5% EV floor.`;
    }
    edgeSummary = noPlays;
  } else {
    edgeSummary = `Grok Beta (independent book) published ${picks.length} pick(s) totaling ${totalUnits.toFixed(2)}u. Separate model from Alpha.`;
  }

  const published = {
    error: false,
    date: dateISO,
    dateFormatted: formatDateLong(dateISO),
    modelVersion: version,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    noPlays,
    picks,
    rejections: [...(validated.rejections || []), ...allRejections].slice(0, 250),
    parlayLegs: [],
    edgeSummary,
    insights: picks.length
      ? `Independent day-one engine. Shin de-vig, sport-family scoring (runs/points/goals), 4.8pt edge floor, 5.0u run cap. Agents may only reject or cut stake.`
      : "",
    sportsScanned,
    gamesScanned: remaining.length,
    candidateCount: allCandidates.length,
    skipped,
    summary: {
      totalPicks: picks.length,
      totalUnits: `${totalUnits.toFixed(2)}u`,
      aplusLocks: picks.filter(p => p.rating === "A" || p.rating === "A+").length,
      sportsCovered,
    },
    record: { wins: 0, losses: 0, pushes: 0, roi: null, units: 0, n: 0 },
    agentReports: (validated.agentReports || []).map(a => ({ agent: a.agent, ok: a.ok, error: a.error || null })),
  };

  if (!dryRun) {
    await writePublished(dateISO, published);
    await stubCloseCapture(dateISO, published);
    await writeStatus({
      lastRun: published.generatedAt,
      date: dateISO,
      picksToday: picks.length,
      candidateCount: allCandidates.length,
      gamesScanned: remaining.length,
      sportsScanned,
      version,
      ok: true,
      elapsedMs: published.elapsedMs,
    });
  }

  console.log(`[grok-beta] done picks=${picks.length} candidates=${allCandidates.length} remainingGames=${remaining.length} ${Date.now() - started}ms`);
  return published;
}

module.exports = { runGrokBeta, emptyPublished };
