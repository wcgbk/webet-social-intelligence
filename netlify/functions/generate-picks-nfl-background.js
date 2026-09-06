// generate-picks-nfl-background.js
// ── WeBetAI NFL Model v1.1-nfl ──
// SEPARATE ENVIRONMENT from alpha (edge-picks-nfl / /nfl) but shaped to merge later.
// Regular-season process even while the calendar still says preseason — dress rehearsal:
//   live ratings + QB out, key-number spreads, independent totals, Pinnacle predCLV,
//   2+ major US books (Hard Rock preferred), 3% EV floor, NO forced leans, 3+1 of
//   the published card. Off days write "No NFL Games Scheduled For Today".
//
// Cron always fires. Off days write the no-games blob so /nfl never shows a stale card.
//
// POST body: { scheduled?: bool, force?: bool, dryRun?: bool, date?: "YYYY-MM-DD" }
//   force  — override the existing-picks overwrite guard (scheduled cards are protected)
//   dryRun — compute + log everything, write nothing

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = "edge-picks-nfl";
const MODEL_VERSION = "v1.1-nfl";
const NO_GAMES_MSG = "No NFL Games Scheduled For Today";
const NO_EDGE_MSG = "No qualifying NFL plays today — WeBetAI passed.";

// ── The Odds API sport keys — preseason + regular season are separate keys; query both so the
// pipeline rolls into September without a code change.
const NFL_ODDS_SPORTS = ["americanfootball_nfl_preseason", "americanfootball_nfl"];

// ── Season-phase constants ──
// Preseason: margins are tighter (nobody game-plans, starters sit) and totals lower. Regular
// season: NFL margin σ ≈ 13.2 (empirical, key-number lumpy), total σ ≈ 10.
// Dress-rehearsal: BOTH phases use regular-season process (user: test as we would in-season).
// Label on the card still reflects ESPN season type. Numbers do not get the old preseason
// damp / extra shrink / forced-lean that would teach the wrong lessons before Week 1.
const PHASE_CONFIG = {
  preseason: {
    sigmaMargin: 13.2, sigmaTotal: 10.0, hfa: 2.0,
    ratingDamp: 1.0, marketWeight: 0.50, shrinkMult: 1.0,
    maxUnits: 2.5, mlMaxUnits: 0.5, evFloor: 0.03, leanEvFloor: 0.03,
    leagueTotal: 44.5,
  },
  regular: {
    sigmaMargin: 13.2, sigmaTotal: 10.0, hfa: 2.0,
    ratingDamp: 1.0, marketWeight: 0.50, shrinkMult: 1.0,
    maxUnits: 2.5, mlMaxUnits: 0.5, evFloor: 0.03, leanEvFloor: 0.03,
    leagueTotal: 44.5,
  },
};

// Shrinkage priors inherited from alpha's fitted constants (428 graded picks, Mar-Jun 2026).
// No NFL-specific fit exists yet — that is exactly what the preseason run accumulates. Refit
// against the edge-picks-nfl store before Week 1.
const SHRINK_K = { Spread: 0.35, Total: 0.30, Moneyline: 0.50 };
const COVER_PROB_CAPS = { NFL_Spread: 0.57, NFL_Total: 0.60, NFL_Moneyline: 0.72 };
const LEAN_UNITS = 0.25;

// ── Book weighting (sharpness) + bettable retail set ──
const BOOK_SHARPNESS = {
  pinnacle: 3.0,
  betonlineag: 1.5, lowvig: 1.5, bookmaker: 1.5,
  draftkings: 1.2, fanduel: 1.2, betmgm: 1.2, caesars: 1.2, espnbet: 1.2,
};
const RETAIL_US_BOOKS = new Set([
  "draftkings", "fanduel", "betmgm", "caesars", "espnbet",
  "hardrockbet", "hardrockbet_oh", "betrivers", "fanatics", "ballybet", "betparx",
]);
const MAJOR_US_BOOKS = new Set([
  "draftkings", "fanduel", "betmgm", "caesars", "espnbet",
  "hardrockbet", "hardrockbet_oh", "betrivers", "fanatics",
]);
const HARD_ROCK = new Set(["hardrockbet", "hardrockbet_oh"]);
const SHARP_BOOK_KEYS = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk", "betfair", "matchbook", "circasports"];
function bookWeight(key) { return BOOK_SHARPNESS[(key || "").toLowerCase()] || 1.0; }
function isMajor(key) { return MAJOR_US_BOOKS.has((key || "").toLowerCase()); }
function isHardRock(key) { return HARD_ROCK.has((key || "").toLowerCase()); }
function sharpPri(key) {
  const i = SHARP_BOOK_KEYS.indexOf((key || "").toLowerCase());
  return i < 0 ? 99 : i;
}

const INDOOR_VENUES = /sofi|allegiant|at&t stadium|state farm|mercedes-benz|u\.?s\.? bank|ford field|lucas oil|caesars superdome|nrg stadium|roof|dome/i;

// ── Static power-rating seed (net points vs league average, 2025 season baseline) ──
// This is a SEED, not a live rating: preseason damping (×0.25) and the 70% market weight mean
// it moves a projection by at most ~±0.5 pts right now. During the regular season these get
// replaced by Elo built from live ESPN results (roadmap: build-ratings pass, mirrors alpha).
const NFL_TEAM_RATINGS = {
  "Arizona Cardinals": -0.5, "Atlanta Falcons": -0.5, "Baltimore Ravens": 5.5,
  "Buffalo Bills": 6.0, "Carolina Panthers": -3.0, "Chicago Bears": -1.0,
  "Cincinnati Bengals": 2.0, "Cleveland Browns": -5.5, "Dallas Cowboys": -1.0,
  "Denver Broncos": 3.5, "Detroit Lions": 5.5, "Green Bay Packers": 3.5,
  "Houston Texans": 1.5, "Indianapolis Colts": -1.0, "Jacksonville Jaguars": -3.0,
  "Kansas City Chiefs": 4.0, "Las Vegas Raiders": -3.5, "Los Angeles Chargers": 2.5,
  "Los Angeles Rams": 1.5, "Miami Dolphins": -0.5, "Minnesota Vikings": 3.0,
  "New England Patriots": -3.0, "New Orleans Saints": -3.5, "New York Giants": -4.0,
  "New York Jets": -2.5, "Philadelphia Eagles": 6.0, "Pittsburgh Steelers": 1.0,
  "San Francisco 49ers": 1.5, "Seattle Seahawks": 1.0, "Tampa Bay Buccaneers": 2.0,
  "Tennessee Titans": -5.0, "Washington Commanders": 3.0,
};
function teamRating(name) {
  if (NFL_TEAM_RATINGS[name] !== undefined) return NFL_TEAM_RATINGS[name];
  // Fuzzy fallback: match on nickname (last word) so odds-API naming drift can't zero a team.
  const last = (name || "").trim().split(/\s+/).pop().toLowerCase();
  for (const [team, r] of Object.entries(NFL_TEAM_RATINGS)) {
    if (team.toLowerCase().endsWith(last)) return r;
  }
  return 0;
}

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

// NFL key-number cover: extra mass at 3 and 7 (then 6/10/14). A 2.5 vs 3.5 is not 1σ of a normal.
function nflSpreadCoverProb(modelMargin, pointsReceived, sigma) {
  const need = -pointsReceived;
  const integer = Math.abs(pointsReceived % 1) < 1e-9;
  let pWin, pPush = 0;
  if (integer) {
    pPush = Math.max(0, normalCDF((need + 0.5 - modelMargin) / sigma) - normalCDF((need - 0.5 - modelMargin) / sigma));
    pWin = 1 - normalCDF((need + 0.5 - modelMargin) / sigma);
  } else {
    pWin = 1 - normalCDF((need - modelMargin) / sigma);
  }
  const bump = (kn, w) => {
    const L = Math.abs(pointsReceived);
    if (pointsReceived > 0 && L >= kn - 0.5 && L < kn) pWin -= w;      // +2.5: don't get the 3
    if (pointsReceived > 0 && L > kn && L <= kn + 0.5) pWin += w;      // +3.5: get the 3
    if (pointsReceived < 0 && L >= kn - 0.5 && L < kn) pWin += w;      // -2.5: don't need the 3
    if (pointsReceived < 0 && L > kn && L <= kn + 0.5) pWin -= w;      // -3.5: must clear 3
  };
  bump(3, 0.022); bump(7, 0.014); bump(6, 0.006); bump(10, 0.005); bump(14, 0.004);
  pWin = Math.min(0.72, Math.max(0.28, pWin));
  return pPush > 0.002 ? pWin / (1 - pPush) : pWin;
}

function nflTotalCoverProb(modelTotal, line, isOver, sigma) {
  const integer = Math.abs(line % 1) < 1e-9;
  let pOver, pPush = 0;
  if (integer) {
    pPush = Math.max(0, normalCDF((line + 0.5 - modelTotal) / sigma) - normalCDF((line - 0.5 - modelTotal) / sigma));
    pOver = 1 - normalCDF((line + 0.5 - modelTotal) / sigma);
  } else {
    pOver = 1 - normalCDF((line - modelTotal) / sigma);
  }
  const pWin = isOver ? pOver : Math.max(0, 1 - pOver - pPush);
  const denom = 1 - pPush;
  return denom > 0 ? Math.min(0.70, Math.max(0.30, pWin / denom)) : 0.5;
}

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

function teamRatingLive(name, overlay) {
  const seed = teamRating(name);
  if (!overlay) return seed;
  const last = (name || "").trim().split(/\s+/).pop().toLowerCase();
  let live = overlay[name];
  if (live == null) {
    for (const [k, v] of Object.entries(overlay)) {
      if (k.toLowerCase().endsWith(last)) { live = v; break; }
    }
  }
  if (live == null || !Number.isFinite(live)) return seed;
  return seed * 0.55 + live * 0.45;
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
      if (!resp.ok) { console.log(`[nfl] Odds fetch ${sport}: HTTP ${resp.status}`); continue; }
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

// ── Consensus per game: weighted-median points, two-sided no-vig probs, sharp anchor ──
function buildGameConsensus(game) {
  const home = game.home_team, away = game.away_team;
  const spreadPts = [], totalPts = [];
  const spreadNoVig = [], totalNoVig = [], mlNoVig = [];
  const offers = { spreadHome: [], spreadAway: [], over: [], under: [], mlHome: [], mlAway: [] };
  let majorSpread = 0, majorTotal = 0, majorML = 0;
  let sharp = { pri: 99, book: null, homeML: null, awayML: null, over: null, under: null, homeSpread: null, awaySpread: null };

  for (const bk of (game.bookmakers || [])) {
    const key = (bk.key || "").toLowerCase();
    const w = bookWeight(key);
    const retail = RETAIL_US_BOOKS.has(key);
    const pri = sharpPri(key);
    if (pri < sharp.pri) {
      sharp = { pri, book: key, homeML: null, awayML: null, over: null, under: null, homeSpread: null, awaySpread: null };
    }
    for (const mkt of (bk.markets || [])) {
      if (mkt.key === "spreads") {
        const h = mkt.outcomes?.find(o => o.name === home);
        const a = mkt.outcomes?.find(o => o.name === away);
        if (h?.point == null || a?.point == null) continue;
        if (isMajor(key)) majorSpread++;
        if (pri === sharp.pri) { sharp.homeSpread = h.price; sharp.awaySpread = a.price; }
        spreadPts.push({ v: h.point, w });
        const nv = noVigProb(h.price, a.price);
        if (nv != null) spreadNoVig.push({ point: h.point, prob: nv, w, key });
        if (retail) {
          offers.spreadHome.push({ book: key, point: h.point, price: h.price, major: isMajor(key) });
          offers.spreadAway.push({ book: key, point: a.point, price: a.price, major: isMajor(key) });
        }
      } else if (mkt.key === "totals") {
        const ov = mkt.outcomes?.find(o => o.name === "Over");
        const un = mkt.outcomes?.find(o => o.name === "Under");
        if (ov?.point == null || un?.point == null) continue;
        if (isMajor(key)) majorTotal++;
        if (pri === sharp.pri) { sharp.over = ov.price; sharp.under = un.price; }
        totalPts.push({ v: ov.point, w });
        const nv = noVigProb(ov.price, un.price);
        if (nv != null) totalNoVig.push({ point: ov.point, prob: nv, w, key });
        if (retail) {
          offers.over.push({ book: key, point: ov.point, price: ov.price, major: isMajor(key) });
          offers.under.push({ book: key, point: un.point, price: un.price, major: isMajor(key) });
        }
      } else if (mkt.key === "h2h") {
        const h = mkt.outcomes?.find(o => o.name === home);
        const a = mkt.outcomes?.find(o => o.name === away);
        if (!h || !a) continue;
        if (isMajor(key)) majorML++;
        if (pri === sharp.pri) { sharp.homeML = h.price; sharp.awayML = a.price; }
        const nv = noVigProb(h.price, a.price);
        if (nv != null) mlNoVig.push({ prob: nv, w, key });
        if (retail) {
          offers.mlHome.push({ book: key, price: h.price, major: isMajor(key) });
          offers.mlAway.push({ book: key, price: a.price, major: isMajor(key) });
        }
      }
    }
  }

  // No-vig prior at (or nearest to) the consensus number. Pinnacle-first via weights.
  const consensusSpread = weightedMedian(spreadPts); // home-team point
  const consensusTotal = weightedMedian(totalPts);
  const wavg = (arr, sel) => {
    const tw = arr.reduce((s, x) => s + x.w, 0);
    return tw > 0 ? arr.reduce((s, x) => s + sel(x) * x.w, 0) / tw : null;
  };
  const atNum = (arr, num) => {
    if (num == null) return arr;
    const exact = arr.filter(x => Math.abs(x.point - num) < 0.01);
    return exact.length ? exact : arr;
  };
  const spreadHomeNoVig = spreadNoVig.length ? wavg(atNum(spreadNoVig, consensusSpread), x => x.prob) : null;
  const totalOverNoVig = totalNoVig.length ? wavg(atNum(totalNoVig, consensusTotal), x => x.prob) : null;
  const mlHomeNoVig = mlNoVig.length ? wavg(mlNoVig, x => x.prob) : null;

  return {
    home, away, commenceTime: game.commence_time,
    consensusSpread, consensusTotal,
    spreadHomeNoVig, totalOverNoVig, mlHomeNoVig,
    offers, bookCount: (game.bookmakers || []).length,
    majorSpread, majorTotal, majorML, sharp,
  };
}

// ── Candidate generation: for each game, evaluate every retail offer on every market and
// keep the best-EV offer per side. Line shopping IS a real, honest edge — especially in
// preseason where the model's own signal is deliberately tiny. ──
function attachPredCLV(cand, sharpOurs, sharpOpp, betOpp) {
  const sharpNV = noVigProb(sharpOurs, sharpOpp);
  if (sharpNV == null || cand.odds == null) return;
  const betNV = noVigProb(cand.odds, betOpp) ?? impliedProb(cand.odds);
  cand.sharpNoVig = +sharpNV.toFixed(4);
  cand.predCLV = +(sharpNV - betNV).toFixed(4);
  cand.sharpBook = "pinnacle";
}

function computeCandidates(consensus, espnGame, cfg, ratingOverlay, qbAdj) {
  const c = consensus;
  if (c.consensusSpread == null && c.mlHomeNoVig == null) return [];
  const cands = [];

  const rHome = teamRatingLive(c.home, ratingOverlay), rAway = teamRatingLive(c.away, ratingOverlay);
  const qbAdjPts = qbMarginAdj(c.home, c.away, qbAdj);
  const ratingMargin = (rHome - rAway) * cfg.ratingDamp + cfg.hfa + qbAdjPts;
  const marketMargin = c.consensusSpread != null ? -c.consensusSpread : ratingMargin;
  const modelMargin = cfg.marketWeight * marketMargin + (1 - cfg.marketWeight) * ratingMargin;
  const indoor = !!(espnGame && espnGame.indoor);
  const ratingTotal = (cfg.leagueTotal || 44.5) + (rHome + rAway) * 0.45 + (indoor ? 0.8 : 0);
  const modelTotal = c.consensusTotal != null ? 0.5 * ratingTotal + 0.5 * c.consensusTotal : ratingTotal;

  const shrink = (raw, market, prior) => {
    const cap = COVER_PROB_CAPS[`NFL_${market}`] || 0.60;
    const mkt = (typeof prior === "number" && prior > 0.01 && prior < 0.99) ? prior : null;
    if (mkt == null) return Math.min(raw, cap);
    const K = (SHRINK_K[market] ?? 0.35) * cfg.shrinkMult;
    return Math.min(mkt + K * (raw - mkt), cap);
  };

  const pushCand = (market, side, offer, rawProb, prior, modelProjection, consensusLine, edgePts) => {
    if (!offer || offer.price == null || offer.price < -300 || offer.price > 300) return null;
    const coverProb = shrink(rawProb, market, prior);
    const dec = americanToDecimal(offer.price);
    const ev = coverProb * dec - 1;
    if (ev <= 0) return null;
    let kellyUnits = ((ev / (dec - 1)) * 0.25) * 50; // quarter-Kelly ×50, alpha scale
    kellyUnits = Math.round(kellyUnits * 2) / 2;
    const capU = market === "Moneyline" ? cfg.mlMaxUnits : cfg.maxUnits;
    kellyUnits = Math.max(0.5, Math.min(capU, kellyUnits));
    const sigma = market === "Total" ? cfg.sigmaTotal : cfg.sigmaMargin;
    const cand = {
      sport: "NFL", market, side,
      homeTeam: c.home, awayTeam: c.away, commenceTime: c.commenceTime,
      odds: offer.price, book: offer.book,
      rawProb, coverProb, ev, kellyUnits,
      zScore: edgePts != null ? +(edgePts / sigma).toFixed(2) : null,
      modelProjection, consensusLine, edge: edgePts != null ? +edgePts.toFixed(1) : null,
      noVigPrior: prior,
      homeRecord: espnGame?.homeRecord || "", awayRecord: espnGame?.awayRecord || "",
      venue: espnGame?.venue || "",
      kellyCalcStr: `p=${coverProb.toFixed(3)}, dec=${dec.toFixed(2)}, EV=${(ev * 100).toFixed(1)}%, quarter-Kelly → ${kellyUnits}u (best line ${fmtOdds(offer.price)} @ ${offer.book})`,
    };
    cands.push(cand);
    return cand;
  };

  const bestOffer = (list, probFn) => {
    let best = null, bestEv = -Infinity, bestHr = null, bestHrEv = -Infinity;
    const majors = (list || []).filter(o => o.major);
    if (majors.length < 2 && (list || []).length) {
      // Not 2+ major books on this side — still evaluate but mark unplaceable later via skip
    }
    const pool = majors.length >= 2 ? list.filter(o => o.major) : [];
    if (!pool.length) return null;
    for (const o of pool) {
      const p = probFn(o);
      if (p == null) continue;
      const ev = p.cover * americanToDecimal(o.price) - 1;
      if (ev > bestEv) { bestEv = ev; best = { offer: o, ...p }; }
      if (isHardRock(o.book) && ev > bestHrEv) { bestHrEv = ev; bestHr = { offer: o, ...p }; }
    }
    // Prefer Hard Rock when within 0.5pp EV of the shopped best (product is HR-betable).
    if (bestHr && best && bestHrEv >= bestEv - 0.005) return bestHr;
    return best;
  };

  // SPREADS — key-number cover at the SHOPPED point (the number we actually bet).
  if (c.consensusSpread != null && c.spreadHomeNoVig != null && (c.majorSpread || 0) >= 2) {
    const homeBest = bestOffer(c.offers.spreadHome, (o) => {
      const raw = nflSpreadCoverProb(modelMargin, o.point, cfg.sigmaMargin);
      const prior = Math.min(0.95, Math.max(0.05, c.spreadHomeNoVig + (o.point - c.consensusSpread) * 0.048));
      return { raw, cover: shrink(raw, "Spread", prior), prior };
    });
    if (homeBest) {
      const added = pushCand("Spread", `${c.home} ${fmtSigned(homeBest.offer.point)}`, homeBest.offer, homeBest.raw, homeBest.prior,
        `${c.home} ${fmtSigned(-modelMargin)}`, `${c.home} ${fmtSigned(homeBest.offer.point)} @ ${fmtOdds(homeBest.offer.price)}`,
        modelMargin - (-homeBest.offer.point));
      if (added) attachPredCLV(added, c.sharp?.homeSpread, c.sharp?.awaySpread, c.offers.spreadAway.find(x => x.book === homeBest.offer.book)?.price);
    }
    const awayBest = bestOffer(c.offers.spreadAway, (o) => {
      const raw = nflSpreadCoverProb(-modelMargin, o.point, cfg.sigmaMargin);
      const prior = Math.min(0.95, Math.max(0.05, (1 - c.spreadHomeNoVig) + (o.point - (-c.consensusSpread)) * 0.048));
      return { raw, cover: shrink(raw, "Spread", prior), prior };
    });
    if (awayBest) {
      const added = pushCand("Spread", `${c.away} ${fmtSigned(awayBest.offer.point)}`, awayBest.offer, awayBest.raw, awayBest.prior,
        `${c.away} ${fmtSigned(modelMargin)}`, `${c.away} ${fmtSigned(awayBest.offer.point)} @ ${fmtOdds(awayBest.offer.price)}`,
        (-modelMargin) - (-awayBest.offer.point));
      if (added) attachPredCLV(added, c.sharp?.awaySpread, c.sharp?.homeSpread, c.offers.spreadHome.find(x => x.book === awayBest.offer.book)?.price);
    }
  }

  // TOTALS — independent rating total blended 50/50 with consensus, then shop the number.
  if (c.consensusTotal != null && c.totalOverNoVig != null && modelTotal != null && (c.majorTotal || 0) >= 2) {
    const overBest = bestOffer(c.offers.over, (o) => {
      const raw = nflTotalCoverProb(modelTotal, o.point, true, cfg.sigmaTotal);
      const prior = Math.min(0.95, Math.max(0.05, c.totalOverNoVig + (c.consensusTotal - o.point) * 0.045));
      return { raw, cover: shrink(raw, "Total", prior), prior };
    });
    if (overBest) {
      const added = pushCand("Total", `Over ${overBest.offer.point}`, overBest.offer, overBest.raw, overBest.prior,
        `${modelTotal.toFixed(1)} total`, `Over ${overBest.offer.point} @ ${fmtOdds(overBest.offer.price)}`, overBest.offer.point ? modelTotal - overBest.offer.point : 0);
      if (added) attachPredCLV(added, c.sharp?.over, c.sharp?.under, c.offers.under.find(x => x.book === overBest.offer.book)?.price);
    }
    const underBest = bestOffer(c.offers.under, (o) => {
      const raw = nflTotalCoverProb(modelTotal, o.point, false, cfg.sigmaTotal);
      const prior = Math.min(0.95, Math.max(0.05, (1 - c.totalOverNoVig) + (o.point - c.consensusTotal) * 0.045));
      return { raw, cover: shrink(raw, "Total", prior), prior };
    });
    if (underBest) {
      const added = pushCand("Total", `Under ${underBest.offer.point}`, underBest.offer, underBest.raw, underBest.prior,
        `${modelTotal.toFixed(1)} total`, `Under ${underBest.offer.point} @ ${fmtOdds(underBest.offer.price)}`, underBest.offer.point - modelTotal);
      if (added) attachPredCLV(added, c.sharp?.under, c.sharp?.over, c.offers.over.find(x => x.book === underBest.offer.book)?.price);
    }
  }

  // MONEYLINES — win prob from model margin; heavy prior anchor.
  if (c.mlHomeNoVig != null && (c.majorML || 0) >= 2) {
    const rawHomeWin = normalCDF(modelMargin / cfg.sigmaMargin);
    const homeBest = bestOffer(c.offers.mlHome, (o) => ({ raw: rawHomeWin, cover: shrink(rawHomeWin, "Moneyline", c.mlHomeNoVig), prior: c.mlHomeNoVig }));
    if (homeBest) {
      const added = pushCand("Moneyline", `${c.home} ML`, homeBest.offer, rawHomeWin, c.mlHomeNoVig,
        `${(shrink(rawHomeWin, "Moneyline", c.mlHomeNoVig) * 100).toFixed(1)}% win`, `${fmtOdds(homeBest.offer.price)}`, null);
      if (added) attachPredCLV(added, c.sharp?.homeML, c.sharp?.awayML, c.offers.mlAway.find(x => x.book === homeBest.offer.book)?.price);
    }
    const rawAwayWin = 1 - rawHomeWin;
    const awayBest = bestOffer(c.offers.mlAway, (o) => ({ raw: rawAwayWin, cover: shrink(rawAwayWin, "Moneyline", 1 - c.mlHomeNoVig), prior: 1 - c.mlHomeNoVig }));
    if (awayBest) {
      const added = pushCand("Moneyline", `${c.away} ML`, awayBest.offer, rawAwayWin, 1 - c.mlHomeNoVig,
        `${(shrink(rawAwayWin, "Moneyline", 1 - c.mlHomeNoVig) * 100).toFixed(1)}% win`, `${fmtOdds(awayBest.offer.price)}`, null);
      if (added) attachPredCLV(added, c.sharp?.awayML, c.sharp?.homeML, c.offers.mlHome.find(x => x.book === awayBest.offer.book)?.price);
    }
  }

  return cands.filter(x => typeof x.predCLV !== "number" || x.predCLV >= -0.02);
}

// ── Match an odds-API game to the ESPN slate (records/venue context) ──
function findESPNGame(espnGames, home, away) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const last = (s) => norm(s).split(" ").pop();
  return espnGames.find(g =>
    (norm(g.homeTeam) === norm(home) || last(g.homeTeam) === last(home)) &&
    (norm(g.awayTeam) === norm(away) || last(g.awayTeam) === last(away))
  ) || null;
}

// ── Selection: one pick per game (highest EV), top 3, floors, LEAN fallback ──
function selectPicks(allCands, cfg) {
  const byGame = new Map();
  for (const cand of allCands) {
    const key = `${cand.awayTeam}@${cand.homeTeam}`;
    const cur = byGame.get(key);
    if (!cur || cand.ev > cur.ev) byGame.set(key, cand);
  }
  const perGame = [...byGame.values()].sort((a, b) => b.ev - a.ev);

  const qualified = perGame.filter(x => x.ev >= cfg.evFloor).slice(0, 3);
  return { picks: qualified, lean: false };
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
function buildFinalPicks(selected, isLean, seasonPhase) {
  return selected.map(c => {
    const units = isLean ? LEAN_UNITS : c.kellyUnits;
    const rating = isLean ? "Lean" : unitsToRating(units);
    const isML = c.market === "Moneyline";
    const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);
    const modelEdgeStr = isML
      ? `Model Win Prob: ${(c.coverProb * 100).toFixed(1)}%, Implied: ${(impliedProb(c.odds) * 100).toFixed(1)}%, Edge: ${edgePctVal}%`
      : `Bet ${c.side} ${fmtOdds(c.odds)} @ ${c.book || "retail"}. ${c.modelProjection}. Calibrated edge ${edgePctVal}%.`;
    return {
      sport: "NFL",
      matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
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
  return card;
}

// ── Claude narration (narrator ONLY — the model already selected and sized; grounding is
// strictly the provided table, no invented specifics) ──
const NFL_NARRATOR_SYSTEM = `You are THE LOCK — WeBetAI's NFL analyst. The statistical model has ALREADY selected and sized these picks. Your only job is to write honest, compelling narratives.

RULES:
- Say "WeBetAI" — never "the model" or "our model".
- Use the EXACT pick string, odds, and calibrated Edge % from the table. Never invent a different line.
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
      pick: p.pick, matchup: p.matchup, market: p.betType, odds: p.odds, bestBook: p.bestBook,
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
  const cfg = PHASE_CONFIG.regular;
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
    });
    if (!dryRun) await storePicks(dateISO, noOdds, force);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0, skipped: "no NFL odds available" }) };
  }

  // Consensus + candidates per game
  const allCands = [];
  for (const g of oddsGames) {
    const consensus = buildGameConsensus(g);
    if (consensus.bookCount < 3) { console.log(`[nfl] ${g.away_team} @ ${g.home_team}: only ${consensus.bookCount} books — skipping`); continue; }
    const espnGame = findESPNGame(espnGames, consensus.home, consensus.away);
    const cands = computeCandidates(consensus, espnGame, cfg, ratingOverlay, qbAdj);
    console.log(`[nfl] ${g.away_team} @ ${g.home_team}: consensus ${consensus.home} ${fmtSigned(consensus.consensusSpread ?? 0)} / total ${consensus.consensusTotal} · ${cands.length} candidate(s)`);
    for (const cand of cands) console.log(`[nfl]   ${cand.market}: ${cand.side} ${fmtOdds(cand.odds)} @ ${cand.book} — cover ${(cand.coverProb * 100).toFixed(1)}%, EV ${(cand.ev * 100).toFixed(1)}%`);
    allCands.push(...cands);
  }

  if (!allCands.length) {
    console.log("[nfl] No positive-EV candidates on the slate — writing no-plays card.");
    const noPlaysData = emptyCard(dateISO, dateFormatted, seasonPhase, NO_EDGE_MSG, {
      noGames: false,
      sportsCovered: ["NFL"],
    });
    if (!dryRun) await storePicks(dateISO, noPlaysData, force);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0 }) };
  }

  // Selection + floors + lean fallback
  const { picks: selected, lean } = selectPicks(allCands, cfg);
  const picks = buildFinalPicks(selected, lean, seasonPhase);

  // Rejections: everything considered but not shipped (transparency, mirrors alpha card)
  const pickSides = new Set(picks.map(p => p.pick));
  const rejections = [];
  const byGameBest = new Map();
  for (const cand of allCands) {
    const key = `${cand.awayTeam} vs. ${cand.homeTeam}`;
    if (!byGameBest.has(key) || cand.ev > byGameBest.get(key).ev) byGameBest.set(key, cand);
  }
  for (const [matchup, cand] of byGameBest) {
    if (pickSides.has(cand.side)) continue;
    rejections.push({
      matchup,
      reason: cand.ev < cfg.evFloor
        ? `Best market (${cand.side} ${fmtOdds(cand.odds)}) EV ${(cand.ev * 100).toFixed(1)}% — below the ${(cfg.evFloor * 100).toFixed(0)}% floor.`
        : `Edged out by higher-EV picks on today's card.`,
    });
  }

  // Same select-to-zero gap as CFB: candidates can exist and still fail the EV floor,
  // which used to store a normal empty-picks card with no noPlays (UI then says no games).
  if (!picks.length) {
    console.log("[nfl] Candidates existed but none cleared selection floors — writing no-plays card.");
    const noEdge = emptyCard(dateISO, dateFormatted, seasonPhase, NO_EDGE_MSG, {
      noGames: false,
      sportsCovered: ["NFL"],
      rejections,
      insights: "WeBetAI scanned today's NFL slate. Games are scheduled, but none cleared the edge filters. Passed rather than force a lean.",
      edgeSummary: NO_EDGE_MSG,
    });
    if (dryRun) {
      console.log("[nfl] DRY RUN — nothing stored.");
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, picks: 0, picksData: noEdge }) };
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

// ── Offline-test hooks (Netlify only invokes exports.handler; these let a local harness
// exercise the math with no network) ──
module.exports.buildGameConsensus = buildGameConsensus;
module.exports.computeCandidates = computeCandidates;
module.exports.selectPicks = selectPicks;
module.exports.buildFinalPicks = buildFinalPicks;
module.exports.buildPublishedParlay = buildPublishedParlay;
module.exports.noVigProb = noVigProb;
module.exports.weightedMedian = weightedMedian;
module.exports.PHASE_CONFIG = PHASE_CONFIG;
