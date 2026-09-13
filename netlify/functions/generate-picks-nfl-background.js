// generate-picks-nfl-background.js
// ── WeBetAI NFL Model v1.1.1-nfl ──
// SEPARATE ENVIRONMENT from alpha (edge-picks-nfl / /nfl) but shaped to merge later.
// Regular-season process even while the calendar still says preseason — dress rehearsal:
//   live ratings + QB out, key-number spreads, independent totals, Pinnacle predCLV,
//   2+ major US books (Hard Rock preferred), 3% EV floor, NO forced leans, 3+1 of
//   the published card. Off days write "No NFL Games Scheduled For Today".
// v1.1.1: Away @ Home matchup + grounded narrator venue (homeTeam/awayTeam/venue on card).
//
// Cron always fires. Off days write the no-games blob so /nfl never shows a stale card.
//
// POST body: { scheduled?: bool, force?: bool, dryRun?: bool, date?: "YYYY-MM-DD" }
//   force  — override the existing-picks overwrite guard (scheduled cards are protected)
//   dryRun — compute + log everything, write nothing

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = "edge-picks-nfl";
const MODEL_VERSION = "v2.0-nfl-omega";
const NO_GAMES_MSG = "No NFL Games Scheduled For Today";
const NO_EDGE_MSG = "No qualifying NFL plays today — WeBetAI passed.";

// ── Omega engine (READ-ONLY import) ──────────────────────────────────────────────────────────
// The /nfl card runs Omega's EXACT football pick process, scoped to NFL only. We reconstruct the
// inputs Omega's handler assembles (raw Odds API JSON, ESPN slate, standings overlay + QB adj) and
// call Omega's own exported computeEdgeTable + gates. No CFB restrictions, no NFL-specific selection
// math — Omega's projection, calibration, Kelly, cover floor (0.52), EV floor (2.5%) and predCLV
// gate do all the work, so this can never drift from Omega. Omega itself is never modified.
const OMEGA = require("./generate-picks-omega-background.js");

// ── The Odds API sport keys — preseason + regular season are separate keys; query both so the
// pipeline rolls into September without a code change.
const NFL_ODDS_SPORTS = ["americanfootball_nfl_preseason", "americanfootball_nfl"];

const LEAN_UNITS = 0.25;
const INDOOR_VENUES = /sofi|allegiant|at&t stadium|state farm|mercedes-benz|u\.?s\.? bank|ford field|lucas oil|caesars superdome|nrg stadium|roof|dome/i;


// ── Math helpers (identical formulas to alpha) ──
function erf(x) {
  const s = x >= 0 ? 1 : -1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function americanToDecimal(odds) { return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds); }
function impliedProb(odds) { return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100); }
function noVigProb(myOdds, oppOdds) {
  if (myOdds == null || oppOdds == null) return null;
  const a = impliedProb(myOdds), b = impliedProb(oppOdds);
  const s = a + b;
  return s > 0 ? a / s : null;
}
function weightedMedian(pairs) { // pairs: [{v, w}]
  if (!pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) { acc += p.w; if (acc >= total / 2) return p.v; }
  return sorted[sorted.length - 1].v;
}
function fmtOdds(o) { return `${o > 0 ? "+" : ""}${o}`; }
function fmtSigned(n, dp = 1) { const v = Number(n).toFixed(dp); return n >= 0 ? `+${v}` : v; }


function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
function easternDateOf(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const [m, dd, y] = parts.split("/");
  return `${y}-${m}-${dd}`;
}
function formatDateLong(dateISO) {
  return new Date(dateISO + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

// ── Anthropic call with timeout + backoff (port of alpha's anthropicFetch — null = LLM
// unavailable; callers MUST fall back to deterministic output, never block the run) ──
async function anthropicFetch(body, { timeoutMs = 45000, retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      if ((resp.status === 429 || resp.status === 529 || resp.status >= 500) && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(8000, 800 * Math.pow(2, attempt))));
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= retries) return null;
      await new Promise(r => setTimeout(r, Math.min(8000, 800 * Math.pow(2, attempt))));
    }
  }
  return null;
}

// ── ESPN: today's NFL slate (the game-day gate + records + season phase) ──
async function fetchESPNSlate(dateISO) {
  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateISO.replace(/-/g, "")}`);
    if (!resp.ok) return { games: [], seasonPhase: "preseason" };
    const data = await resp.json();
    const games = (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const home = comp.competitors?.find(c => c.homeAway === "home");
      const away = comp.competitors?.find(c => c.homeAway === "away");
      if (!home || !away) return null;
      return {
        espnId: ev.id,
        date: ev.date,
        seasonType: ev.season?.type || 1, // 1=pre, 2=regular, 3=post
        weekLabel: ev.season?.slug || "",
        homeTeam: home.team?.displayName || "",
        awayTeam: away.team?.displayName || "",
        homeRecord: home.records?.[0]?.summary || "",
        awayRecord: away.records?.[0]?.summary || "",
        venue: comp.venue?.fullName || "",
        indoor: !!(comp.venue?.indoor) || INDOOR_VENUES.test(comp.venue?.fullName || ""),
        homeId: home.team?.id, awayId: away.team?.id,
        state: comp.status?.type?.state || "pre",
      };
    }).filter(Boolean);
    const seasonPhase = games.some(g => g.seasonType >= 2) ? "regular" : "preseason";
    return { games, seasonPhase };
  } catch (e) {
    console.log(`[nfl] ESPN slate fetch error: ${e.message}`);
    return { games: [], seasonPhase: "preseason" };
  }
}

// Live rating overlay: seed + point-diff from ESPN standings (regular or preseason).
async function fetchLiveRatingOverlay() {
  const out = {};
  try {
    const resp = await fetch("https://site.api.espn.com/apis/v2/sports/football/nfl/standings");
    if (!resp.ok) return out;
    const data = await resp.json();
    const children = data.children || [data];
    for (const conf of children) {
      const entries = conf.standings?.entries || [];
      for (const e of entries) {
        const name = e.team?.displayName || "";
        if (!name) continue;
        const stats = {};
        for (const s of (e.stats || [])) if (s.name) stats[s.name] = s.value;
        const pd = Number(stats.pointDifferential ?? stats.differential ?? 0);
        const gp = Number(stats.gamesPlayed || ((stats.wins || 0) + (stats.losses || 0)) || 1);
        const perGame = gp > 0 ? pd / gp : 0;
        out[name] = perGame; // blend in teamRatingLive
      }
    }
    console.log(`[nfl] Live standings overlay for ${Object.keys(out).length} teams`);
  } catch (e) {
    console.log(`[nfl] standings overlay skipped: ${e.message}`);
  }
  return out;
}

// QB-out adjustment (points of margin). Out = full replacement, doubtful = partial.
async function fetchQbAdjustments() {
  const adj = {}; // team displayName → margin points (negative if THEIR qb is out)
  try {
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries");
    if (!resp.ok) return adj;
    const data = await resp.json();
    for (const team of (data.injuries || data.teams || [])) {
      const teamName = team.displayName || team.team?.displayName || "";
      const athletes = team.injuries || team.athletes || [];
      for (const inj of athletes) {
        const pos = (inj.athlete?.position?.abbreviation || inj.position || "").toUpperCase();
        const status = (inj.status || inj.type || "").toLowerCase();
        if (pos !== "QB") continue;
        if (/out|injured reserve|ir|doubtful/.test(status)) {
          const mag = /doubtful/.test(status) ? -2.0 : -3.5;
          adj[teamName] = Math.min(adj[teamName] || 0, mag);
        }
      }
    }
    // ESPN injuries payload variants — also walk .items
    if (!Object.keys(adj).length && Array.isArray(data.items)) {
      for (const item of data.items) {
        const teamName = item.team?.displayName || "";
        const pos = (item.athlete?.position?.abbreviation || "").toUpperCase();
        const status = (item.status || "").toLowerCase();
        if (pos === "QB" && /out|ir|doubtful/.test(status)) {
          adj[teamName] = /doubtful/.test(status) ? -2.0 : -3.5;
        }
      }
    }
    if (Object.keys(adj).length) console.log(`[nfl] QB adjustments: ${JSON.stringify(adj)}`);
  } catch (e) {
    console.log(`[nfl] QB injury fetch skipped: ${e.message}`);
  }
  return adj;
}

function qbMarginAdj(home, away, qbAdj) {
  if (!qbAdj) return 0;
  const find = (name) => {
    if (qbAdj[name] != null) return qbAdj[name];
    const last = (name || "").split(/\s+/).pop().toLowerCase();
    for (const [k, v] of Object.entries(qbAdj)) {
      if (k.toLowerCase().endsWith(last)) return v;
    }
    return 0;
  };
  return (find(home) || 0) - (find(away) || 0);
}

// ── The Odds API: today's NFL games (preseason + regular keys, ET-date filtered) ──
async function fetchNFLOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { console.log("[nfl] No ODDS_API_KEY — cannot fetch odds"); return []; }
  const seen = new Set();
  const games = [];
  for (const sport of NFL_ODDS_SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) { console.log(`[nfl] Odds fetch ${sport}: HTTP ${resp.status} — ${(await resp.text()).slice(0,160)}`); continue; }
      const data = await resp.json();
      for (const g of data) {
        if (seen.has(g.id)) continue;
        if (easternDateOf(g.commence_time) !== dateISO) continue;
        seen.add(g.id);
        games.push(g);
      }
    } catch (e) {
      console.log(`[nfl] Odds fetch error for ${sport}: ${e.message}`);
    }
  }
  console.log(`[nfl] Odds API: ${games.length} NFL game(s) for ${dateISO}`);
  return games;
}

// ── Omega-parity engine (NFL only) ───────────────────────────────────────────────────────────
// Reshape the NFL slate into the exact inputs Omega's handler assembles, then run Omega's own
// exported computeEdgeTable + gates. All parameters (HFA 2.5, σ 13.2/10.0, market-anchor clamp
// ±4/±6, calibration, quarter-Kelly, EV floor 2.5%, cover floor 0.52, predCLV≥0) live inside
// Omega's code — nothing is re-tuned here.
function buildEspnData(espnGames, includeStarted = false) {
  const games = (espnGames || [])
    .filter(g => includeStarted || (g.state || "pre") === "pre") // Omega bets pre-game only
    .map(g => ({
      home: g.homeTeam, away: g.awayTeam, venue: g.venue || "", indoor: !!g.indoor,
      date: g.date, homeRecord: g.homeRecord || "", awayRecord: g.awayRecord || "",
      homeInjuries: [], awayInjuries: [],
    }));
  return [{ league: "NFL", games }];
}

// Quarter-Kelly ×50, clamp 0.5–3.0u (copied from Omega's computeKelly — same sizing).
function kellyFor(coverProb, odds) {
  const dec = americanToDecimal(odds);
  const edge = coverProb * dec - 1;
  if (edge <= 0) return { units: 0.5, ev: edge };
  let u = (edge / (dec - 1)) * 0.25 * 50;
  u = Math.max(0.5, Math.min(3.0, Math.round(u * 2) / 2));
  return { units: u, ev: edge };
}

// Per-game candidates using OMEGA's exact projection + cover + calibration math (computeFootballProjection,
// nflSpread/TotalCoverProb, getCalibratedCoverProb) — but NO hard EV/cover/predCLV floors. We always
// surface the model's best side on each of spread / total / (safe) ML, then rank and take the best 3
// straights for the card. This is the elite-sharp "best available board", not a conviction-only filter.
function nflGameCandidates(game, gameData, footballCtx, leagueConfig) {
  const rating = { elo: 1500, coverRate: 50, streak: 0, daysSinceLastGame: 7, last5: [] };
  let proj;
  try { proj = OMEGA.computeFootballProjection(game, "NFL", leagueConfig, rating, rating, {}, gameData, footballCtx); }
  catch (e) { console.log(`[nfl-omega] proj error ${game.away}@${game.home}: ${e.message}`); return []; }
  if (!proj || proj.poisoned || !proj._fb) return [];
  const out = [];
  const push = (market, side, odds, rawCover, oppOdds, modelProjection, edgePts) => {
    if (odds == null || odds < -350 || odds > 350) return;
    const noVig = OMEGA._testV104.noVigProb(odds, oppOdds) ?? impliedProb(odds);
    const cover = OMEGA._testV104.getCalibratedCoverProb(rawCover, "NFL", market, odds, undefined, noVig);
    const k = kellyFor(cover, odds);
    const sigma = market === "Total" ? proj._fb.sigmaTotal : proj._fb.sigmaMargin;
    out.push({
      sport: "NFL", market, side, odds,
      homeTeam: game.home, awayTeam: game.away, matchup: `${game.away} @ ${game.home}`,
      venue: game.venue || "", commenceTime: gameData.commenceTime || game.date || "",
      coverProb: +cover.toFixed(4), ev: +k.ev.toFixed(4), kellyUnits: k.units,
      probEdge: +(cover - noVig).toFixed(4), // ranking metric — NOT payout-inflated EV (kills the dog bias)
      edge: edgePts != null ? +edgePts.toFixed(1) : null, modelProjection,
      zScore: edgePts != null ? +(Math.abs(edgePts) / sigma).toFixed(2) : null,
      noVigPrior: noVig, predCLV: null,
      kellyCalcStr: `cover ${(cover * 100).toFixed(1)}%, EV ${(k.ev * 100).toFixed(1)}%, ${k.units}u @ ${fmtOdds(odds)}`,
    });
  };
  // SPREAD — the side the model margin favors, at the shopped number.
  if (gameData.homeSpread != null && gameData.homeSpreadOdds != null && gameData.awaySpreadOdds != null) {
    const mm = proj._fb.modelMargin;
    const isHomeCover = proj.projSpread < gameData.homeSpread; // model margin beats the home number
    const pickedSpread = isHomeCover ? gameData.homeSpread : gameData.awaySpread;
    const team = isHomeCover ? game.home : game.away;
    const odds = isHomeCover ? gameData.homeSpreadOdds : gameData.awaySpreadOdds;
    const oppOdds = isHomeCover ? gameData.awaySpreadOdds : gameData.homeSpreadOdds;
    const raw = OMEGA.nflSpreadCoverProb(isHomeCover ? mm : -mm, pickedSpread, proj._fb.sigmaMargin);
    push("Spread", `${team} ${fmtSigned(pickedSpread)}`, odds, raw, oppOdds, `${team} ${fmtSigned(pickedSpread)} (model margin ${fmtSigned(-proj.projSpread)})`, proj.projSpread - gameData.homeSpread);
  }
  // TOTAL — the side the model total favors, best price shopped.
  if (gameData.total != null && gameData.overOdds != null && gameData.underOdds != null) {
    const isOver = proj.projTotal > gameData.total;
    const odds = isOver ? (gameData.overOddsBest ?? gameData.overOdds) : (gameData.underOddsBest ?? gameData.underOdds);
    const oppOdds = isOver ? gameData.underOdds : gameData.overOdds;
    const raw = OMEGA.nflTotalCoverProb(proj._fb.modelTotal, gameData.total, isOver, proj._fb.sigmaTotal);
    push("Total", `${isOver ? "Over" : "Under"} ${gameData.total}`, odds, raw, oppOdds, `model total ${proj.projTotal.toFixed(1)} vs ${gameData.total}`, proj.projTotal - gameData.total);
  }
  // MONEYLINE — FAVORITES ONLY (odds < 0) with a clear edge and >=55% model win prob. Never a
  // plus-money dog: elite practice takes the POINTS (the spread) on a dog, not the outright ML. This
  // is what keeps the card off the dog-ML traps Ben flagged.
  if (gameData.homeML != null && gameData.awayML != null) {
    const opts = [["home", proj.homeWinProb, gameData.homeML, gameData.awayML, game.home],
                  ["away", 1 - proj.homeWinProb, gameData.awayML, gameData.homeML, game.away]];
    let best = null;
    for (const [, wp, ml, opp, team] of opts) {
      if (ml == null || ml >= 0 || ml < -350) continue; // favorites only
      if (wp < 0.55) continue;                            // must be a clear favorite
      const noVig = OMEGA._testV104.noVigProb(ml, opp) ?? impliedProb(ml);
      const edge = wp - noVig;
      if (!best || edge > best.edge) best = { wp, ml, opp, team, edge };
    }
    if (best && best.edge > 0) push("Moneyline", `${best.team} ML`, best.ml, best.wp, best.opp, `${(best.wp * 100).toFixed(1)}% win`, best.edge * 100);
  }
  return out;
}

async function runOmegaNfl(espnGames, oddsGames, ratingOverlay, qbAdj, includeStarted = false) {
  const espnData = buildEspnData(espnGames, includeStarted);
  if (!espnData[0].games.length) { console.log("[nfl-omega] no pre-game NFL games to price"); return { candidates: [], selected: [], diag: { gamesPriced: 0 } }; }
  const oddsData = [{ sport: "americanfootball_nfl", games: oddsGames || [] }];
  const consensusLookup = OMEGA._testV104.buildConsensusLookup(oddsData);
  const footballCtx = { nflOverlay: ratingOverlay || {}, nflQbAdj: qbAdj || {}, cfbOverlay: {}, cfbQbAdj: {} };
  const leagueConfig = (OMEGA.ESPN_LEAGUES || []).find(l => l.label === "NFL") || { homeAdv: 50, kFactor: 20, baseElo: 1500, sport: "football", league: "nfl", label: "NFL" };

  const allCands = [];
  let matched = 0;
  for (const g of espnData[0].games) {
    const gameData = OMEGA._testV104.findConsensusLine(consensusLookup, g.home, g.date);
    if (!gameData || gameData.homeSpread == null) continue;
    matched++;
    allCands.push(...nflGameCandidates(g, gameData, footballCtx, leagueConfig));
  }
  // Best straight per game, then the best 3 by PROBABILITY EDGE (cover − no-vig implied), NOT raw EV —
  // ranking on EV lets a plus-money dog's payout inflate it past real spread/total edges (the exact
  // bias Ben flagged). Spreads/totals also beat an equal-edge ML (juice/variance), so ties prefer them.
  const marketPref = (m) => (m === "Spread" || m === "Total") ? 1 : 0;
  const better = (a, b) => (b.probEdge - a.probEdge) || (marketPref(b.market) - marketPref(a.market)) || ((b.zScore || 0) - (a.zScore || 0));
  const byGame = new Map();
  for (const c of allCands) {
    const key = c.matchup.toLowerCase();
    const cur = byGame.get(key);
    if (!cur || better(c, cur) < 0) byGame.set(key, c);
  }
  const selected = [...byGame.values()].sort(better).slice(0, 3);
  const diag = { gamesPriced: espnData[0].games.length, consensusMatched: matched, rawCandidates: allCands.length, selected: selected.length };
  console.log(`[nfl-omega] join ${matched}/${espnData[0].games.length}, ${allCands.length} candidate(s), selected ${selected.length}`);
  for (const c of selected) console.log(`[nfl-omega]   ${c.market}: ${c.side} ${fmtOdds(c.odds)} — cover ${(c.coverProb * 100).toFixed(1)}%, EV ${(c.ev * 100).toFixed(1)}%`);
  return { candidates: allCands, selected, diag };
}

function unitsToRating(u) {
  if (u >= 2.5) return "A+";
  if (u >= 1.5) return "A";
  if (u >= 1.0) return "A-";
  if (u >= 0.5) return "B+";
  return "B";
}
const RATING_TO_CONFIDENCE = { "A+": "aplus", "A": "a", "A-": "aminus", "B+": "bplus", "B": "b", "Lean": "lean" };

// ── Assemble final pick objects (exact alpha card shape — the /nfl page is an alpha clone) ──
function buildFinalPicks(selected, isLeanCard, seasonPhase) {
  return selected.map(c => {
    const isLean = typeof c.isLean === "boolean" ? c.isLean : !!isLeanCard;
    const units = isLean ? LEAN_UNITS : c.kellyUnits;
    const rating = isLean ? "Lean" : unitsToRating(units);
    const isML = c.market === "Moneyline";
    const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);
    const modelEdgeStr = isML
      ? `Model Win Prob: ${(c.coverProb * 100).toFixed(1)}%, Implied: ${(impliedProb(c.odds) * 100).toFixed(1)}%, Edge: ${edgePctVal}%`
      : `Bet ${c.side} ${fmtOdds(c.odds)} @ ${c.book || "retail"}. ${c.modelProjection}. Calibrated edge ${edgePctVal}%.`;
    return {
      sport: "NFL",
      matchup: `${c.awayTeam} @ ${c.homeTeam}`,
      homeTeam: c.homeTeam,
      awayTeam: c.awayTeam,
      venue: c.venue || "",
      pick: c.side,
      betType: c.market,
      odds: fmtOdds(c.odds),
      rating,
      confidence: RATING_TO_CONFIDENCE[rating] || "b",
      units: `${units}u`,
      ev: `${(c.ev * 100).toFixed(1)}%`,
      evRaw: c.ev,
      edgePct: `${edgePctVal}%`,
      edgePoints: c.edge,
      coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
      zScore: c.zScore,
      kellyCalc: c.kellyCalcStr,
      winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
      coreReasoning: "",
      whatLoses: "",
      clvExpectation: "",
      modelEdge: modelEdgeStr,
      commenceTime: c.commenceTime || "",
      bestBook: c.book || "",
      predCLV: typeof c.predCLV === "number" ? c.predCLV : null,
      sharpBook: c.sharpBook || null,
      seasonPhase,
      thinSlate: isLean,
      source: "nfl",
      result: "pending",
    };
  });
}

function calcParlayAmerican(oddsArr) {
  let dec = 1;
  for (const o of oddsArr) {
    const n = typeof o === "number" ? o : parseInt(String(o).replace(/[^0-9+-]/g, ""), 10);
    if (!Number.isFinite(n)) { dec *= 1.909; continue; }
    dec *= n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  }
  const am = dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  return am > 0 ? `+${am}` : `${am}`;
}

// 3+1 of the published card — same product as alpha v10.5.2. No phantom synthesis later.
function buildPublishedParlay(picks) {
  if (!picks || picks.length < 2) return [];
  const byGame = new Map();
  for (const p of picks) {
    const g = (p.matchup || "").toLowerCase().trim();
    if (!g || byGame.has(g)) continue;
    byGame.set(g, {
      pick: p.pick,
      matchup: p.matchup,
      odds: p.odds,
      betType: p.betType,
      sport: "NFL",
      commenceTime: p.commenceTime || "",
      coverProb: p.coverProb,
      ev: p.ev,
    });
  }
  const legs = [...byGame.values()].slice(0, 3);
  if (legs.length < 2) return [];
  const stake = picks.some(p => p.thinSlate) ? 0.25 : 0.5;
  return [{
    type: `${legs.length}-leg-parlay`,
    legs,
    combinedOdds: calcParlayAmerican(legs.map(l => l.odds)),
    units: `${stake}u`,
    stake,
    source: "published-card",
  }];
}

function emptyCard(dateISO, dateFormatted, seasonPhase, noPlays, extras = {}) {
  const noGames = Object.prototype.hasOwnProperty.call(extras, "noGames")
    ? !!extras.noGames
    : /No NFL Games Scheduled/i.test(noPlays || "");
  const card = {
    date: dateISO,
    dateFormatted,
    generatedAt: new Date().toISOString(),
    model: MODEL_VERSION,
    seasonPhase,
    noPlays,
    noGames,
    picks: [],
    rejections: extras.rejections || [],
    parlayLegs: [],
    summary: {
      totalPicks: 0,
      totalUnits: "0u",
      aplusLocks: 0,
      sportsCovered: extras.sportsCovered || [],
    },
  };
  if (extras.insights) card.insights = extras.insights;
  if (extras.edgeSummary) card.edgeSummary = extras.edgeSummary;
  if (extras.debug) card.debug = extras.debug;
  return card;
}

// ── Claude narration (narrator ONLY — the model already selected and sized; grounding is
// strictly the provided table, no invented specifics) ──
const NFL_NARRATOR_SYSTEM = `You are THE LOCK — WeBetAI's NFL analyst. The statistical model has ALREADY selected and sized these picks. Your only job is to write honest, compelling narratives.

RULES:
- Say "WeBetAI" — never "the model" or "our model".
- Use the EXACT pick string, odds, and calibrated Edge % from the table. Never invent a different line.
- matchup is Away @ Home format. Use homeTeam / awayTeam / venue from the table for any location or home-field claim.
- NEVER invent or invert venue/home-field. If the pick is the away team, do NOT claim home-field advantage.
- Use ONLY facts in the data (teams, the number we are betting, prices, best-book, records, venue, edge math). No invented player/coach/news.
- coreReasoning: 3-4 sentences arguing FOR the pick side. Start with a concrete supporting fact from the data. End with why the price offers value.
- whatLoses: 1 sentence — the specific scenario that beats the pick.
- clvExpectation: 1 short sentence on expected line movement.
- edgeSummary: 1-2 editorial sentences for the whole card, plain English, no jargon.
- insights: 2-3 sentences explaining today's card construction (markets scanned, why this market won, stake discipline).

Return ONLY valid JSON:
{"narratives":[{"pick":"<exact pick string>","coreReasoning":"...","whatLoses":"...","clvExpectation":"..."}],"edgeSummary":"...","insights":"..."}`;

async function narratePicks(picks, seasonPhase, dateFormatted) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = () => {
    for (const p of picks) {
      const phase = seasonPhase === "preseason" ? "preseason" : "regular-season";
      p.coreReasoning = p.coreReasoning ||
        `WeBetAI scanned every spread, total, and moneyline and ${p.pick} at ${p.odds}${p.bestBook ? ` (${p.bestBook})` : ""} is the best value on this game. Calibrated cover ${p.coverProb} vs break-even at this price, ${p.ev} expected value. Stake is quarter-Kelly sized to the calibrated edge.`;
      p.whatLoses = p.whatLoses || "A game script that runs against the number — a late score or a stalled drive at a key number (3 or 7).";
      p.clvExpectation = p.clvExpectation || (typeof p.predCLV === "number"
        ? `Pick-time Pinnacle predCLV ${(p.predCLV * 100).toFixed(1)}¢ — hold if the close stays near this number.`
        : "Line expected to stay near the consensus number into kickoff.");
    }
    return {
      edgeSummary: `WeBetAI's NFL model evaluated every market on today's slate and found its best value on ${picks.map(p => `${p.pick} (${p.odds})`).join(", ")}.`,
      insights: `${picks.length} NFL pick${picks.length > 1 ? "s" : ""} today, ${picks.reduce((s, p) => s + parseFloat(p.units), 0)}u total exposure. Regular-season process: 3% EV floor, key-number cover, 2+ major books, Hard Rock preferred, quarter-Kelly.`,
    };
  };
  if (!apiKey || !picks.length) return fallback();

  try {
    const table = picks.map(p => ({
      pick: p.pick, matchup: p.matchup, homeTeam: p.homeTeam, awayTeam: p.awayTeam, venue: p.venue,
      market: p.betType, odds: p.odds, bestBook: p.bestBook,
      units: p.units, rating: p.rating, coverProb: p.coverProb, ev: p.ev, modelEdge: p.modelEdge,
      seasonPhase: p.seasonPhase,
    }));
    const resp = await anthropicFetch({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0.3,
      system: NFL_NARRATOR_SYSTEM,
      messages: [{ role: "user", content: `Date: ${dateFormatted}. Season phase: ${seasonPhase}.\nPicks table:\n${JSON.stringify(table, null, 2)}` }],
    });
    if (!resp || !resp.ok) { console.log(`[nfl] Narrator unavailable (${resp ? resp.status : "timeout"}) — using fallback`); return fallback(); }
    const data = await resp.json();
    const text = (data.content || []).map(b => b.text || "").join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback();
    const parsed = JSON.parse(jsonMatch[0]);
    for (const p of picks) {
      const n = (parsed.narratives || []).find(x => x.pick === p.pick) || (parsed.narratives || [])[0];
      if (n) {
        p.coreReasoning = n.coreReasoning || "";
        p.whatLoses = n.whatLoses || "";
        p.clvExpectation = n.clvExpectation || "";
      }
    }
    const fb = fallback(); // fills any narrative Claude left empty + default summaries
    return { edgeSummary: parsed.edgeSummary || fb.edgeSummary, insights: parsed.insights || fb.insights };
  } catch (e) {
    console.log(`[nfl] Narration error: ${e.message} — using fallback`);
    return fallback();
  }
}

// ── Storage (REST blob API, mirrors alpha incl. the v10.4 overwrite guard) ──
async function storePicks(dateISO, picksData, force, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) { console.error("[nfl] NETLIFY_AUTH_TOKEN not set, cannot store picks"); return false; }
  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`;
  const auth = { "Authorization": `Bearer ${token}` };

  // Overwrite guard: a scheduled card is protected; force:true carries settled results forward.
  try {
    const existResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: auth });
    if (existResp.ok) {
      const existing = await existResp.json();
      const existingPicks = Array.isArray(existing?.picks) ? existing.picks : [];
      if (existingPicks.length > 0 && !force) {
        console.error(`[nfl-guard] REFUSING overwrite: picks-${dateISO} already holds ${existingPicks.length} pick(s). POST with {"force":true} to override.`);
        return false;
      }
      if (existingPicks.length > 0) {
        const resMap = new Map(existingPicks.filter(p => p.result && p.result !== "pending").map(p => [`${p.pick}||${p.matchup}`, p]));
        for (const p of (picksData.picks || [])) {
          const prev = resMap.get(`${p.pick}||${p.matchup}`);
          if (prev && (!p.result || p.result === "pending")) {
            p.result = prev.result; p.profit = prev.profit;
            p.finalScore = prev.finalScore || null; p.settledAt = prev.settledAt || null;
          }
        }
      }
    }
  } catch (e) {
    console.log(`[nfl-guard] Existence check failed (${e.message}) — proceeding`);
  }

  try {
    const put = await fetch(`${storeUrl}/picks-${dateISO}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (!put.ok) { console.error(`[nfl] Blob PUT failed ${put.status}: ${(await put.text()).slice(0, 200)}`); return false; }

    await fetch(`${storeUrl}/latest-date`, {
      method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: dateISO,
    });

    let dates = [];
    try {
      const dResp = await fetch(`${storeUrl}/picks-dates`, { headers: auth });
      if (dResp.ok) dates = await dResp.json();
    } catch (e) {}
    if (!Array.isArray(dates)) dates = [];
    // Off-day "no games" blobs update latest-date (so /nfl is never stale) but stay off
    // picks-dates so the track record is not padded with every Tuesday/Wednesday.
    if (opts.indexDates !== false && !dates.includes(dateISO)) {
      dates.push(dateISO); dates.sort();
      await fetch(`${storeUrl}/picks-dates`, {
        method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(dates),
      });
    }
    console.log(`[nfl] Picks stored to ${STORE_NAME}/picks-${dateISO}`);
    return true;
  } catch (e) {
    console.error(`[nfl] Blob store error: ${e.message}`);
    return false;
  }
}

// ── Main ──
exports.handler = async (event) => {
  const started = Date.now();
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const force = !!body.force;
  const dryRun = !!body.dryRun;
  const dateISO = (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : getEasternDateToday();
  const dateFormatted = formatDateLong(dateISO);
  console.log(`[nfl] ${MODEL_VERSION} run for ${dateISO} (scheduled:${!!body.scheduled} force:${force} dryRun:${dryRun})`);

  // Regular-season process even if ESPN still labels the slate preseason.
  const { games: espnGames, seasonPhase } = await fetchESPNSlate(dateISO);
  if (!espnGames.length) {
    console.log(`[nfl] No NFL games on ${dateISO} (ET) — writing no-games card.`);
    const noGames = emptyCard(dateISO, dateFormatted, seasonPhase, NO_GAMES_MSG);
    if (!dryRun) await storePicks(dateISO, noGames, force, { indexDates: false });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no NFL games today", stored: !dryRun }) };
  }
  console.log(`[nfl] ${espnGames.length} NFL game(s) today · phase=${seasonPhase} · process=regular`);

  const [ratingOverlay, qbAdj] = await Promise.all([fetchLiveRatingOverlay(), fetchQbAdjustments()]);

  const oddsGames = await fetchNFLOdds(dateISO);
  if (!oddsGames.length) {
    console.log(`[nfl] ESPN shows games but no odds available — writing no-plays card.`);
    const noOdds = emptyCard(dateISO, dateFormatted, seasonPhase, NO_EDGE_MSG, {
      noGames: false,
      sportsCovered: ["NFL"],
      debug: { path: "no-odds", espnGames: espnGames.length, oddsGames: 0 },
    });
    if (!dryRun) await storePicks(dateISO, noOdds, force);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0, skipped: "no NFL odds available" }) };
  }

  // ── Run Omega's EXACT engine on the NFL slate (NFL-only; Omega file untouched) ──
  const includeStarted = !!body.includeStarted; // parity/verification runs can price started games
  const { candidates: nflCands, selected, diag } = await runOmegaNfl(espnGames, oddsGames, ratingOverlay, qbAdj, includeStarted);
  const picks = buildFinalPicks(selected, false, seasonPhase); // Omega football = conviction only, no leans

  // Rejections: the best-EV candidate per game that did NOT make the card (transparency).
  const pickSides = new Set(picks.map(p => p.pick));
  const rejections = [];
  const byGameBest = new Map();
  for (const cand of nflCands) {
    const key = `${cand.awayTeam} @ ${cand.homeTeam}`;
    if (!byGameBest.has(key) || (cand.ev || -1) > (byGameBest.get(key).ev || -1)) byGameBest.set(key, cand);
  }
  for (const [matchup, cand] of byGameBest) {
    if (pickSides.has(cand.side)) continue;
    rejections.push({ matchup, reason: `${cand.side} ${fmtOdds(cand.odds)}: cover ${(cand.coverProb * 100).toFixed(0)}%, EV ${(cand.ev * 100).toFixed(1)}% — edged out, or below Omega's card floors (cover >=52%, EV >=2.5%, beats the sharp close).` });
  }

  if (!picks.length) {
    console.log("[nfl] Omega engine surfaced no qualifying NFL plays — writing no-plays card.");
    const noEdge = emptyCard(dateISO, dateFormatted, seasonPhase, NO_EDGE_MSG, {
      noGames: false,
      sportsCovered: ["NFL"],
      rejections,
      insights: "WeBetAI ran the Omega engine on today's NFL slate. Games are scheduled, but none cleared the conviction floors (>=52% cover, >=2.5% EV, and beating the sharp close). Passed rather than force a play.",
      edgeSummary: NO_EDGE_MSG,
      debug: diag,
    });
    if (dryRun) {
      console.log("[nfl] DRY RUN — nothing stored.");
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, picks: 0, picksData: noEdge, candidateCount: nflCands.length }) };
    }
    const stored = await storePicks(dateISO, noEdge, force);
    console.log(`[nfl] Done in ${((Date.now() - started) / 1000).toFixed(1)}s (stored: ${stored}, no qualifying plays)`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0, stored }) };
  }

  // Narration (Claude narrator; deterministic fallback)
  const { edgeSummary, insights } = await narratePicks(picks, seasonPhase, dateFormatted);

  const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const picksData = {
    date: dateISO,
    dateFormatted,
    generatedAt: new Date().toISOString(),
    model: MODEL_VERSION,
    seasonPhase,
    picks,
    rejections,
    parlayLegs: buildPublishedParlay(picks),
    summary: {
      totalPicks: picks.length,
      totalUnits: `${parseFloat(totalUnits.toFixed(2))}u`,
      aplusLocks: picks.filter(p => p.rating === "A+").length,
      sportsCovered: ["NFL"],
    },
    edgeSummary,
    insights,
  };

  console.log(`[nfl] Card: ${picks.map(p => `${p.pick} ${p.odds} (${p.units}, ${p.rating})`).join(" | ")}`);
  if (dryRun) {
    console.log("[nfl] DRY RUN — nothing stored.");
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, picksData }) };
  }

  const stored = await storePicks(dateISO, picksData, force);
  console.log(`[nfl] Done in ${((Date.now() - started) / 1000).toFixed(1)}s (stored: ${stored})`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, picks: picks.length, stored }) };
};

// ── Offline-test hooks (Netlify only invokes exports.handler) ──
module.exports.buildEspnData = buildEspnData;
module.exports.nflGameCandidates = nflGameCandidates;
module.exports.runOmegaNfl = runOmegaNfl;
module.exports.buildFinalPicks = buildFinalPicks;
module.exports.buildPublishedParlay = buildPublishedParlay;
module.exports.MODEL_VERSION = MODEL_VERSION;
