// generate-picks-cfb-background.js
// ── WeBetAI College Football Model v1.0-cfb ──
// SEPARATE ENVIRONMENT from alpha and NFL (edge-picks-cfb / /cfb), cloned from the NFL
// pipeline (generate-picks-nfl-background v1.1-nfl) and adapted for the FBS slate:
//   sharp-book consensus + two-sided de-vig, key-number cover (3/7), Pinnacle predCLV
//   floor -2c, 2+ major US books (Hard Rock preferred), 3% EV floor, NO forced leans,
//   3+1 of the published card, quarter-Kelly, caps 2.5u / 0.5u ML.
// CFB-specific discipline: there is NO static power-rating seed for 130+ FBS teams, so
// the projection is market-anchored by design — live ESPN standings (point diff + scoring
// rate) overlay when available, otherwise the market number IS the prior and the honest
// edge comes from line shopping + the shopped-point key-number math. Model drift from the
// consensus number is hard-clamped (±4 pts spread / ±5 pts total) so an empty early-season
// overlay can never manufacture phantom edges on big spreads.
// Off days write "No College Football Games Scheduled For Today".
//
// Cron always fires (11:05am ET). Off days write the no-games blob so /cfb never shows a
// stale card.
//
// POST body: { scheduled?: bool, force?: bool, dryRun?: bool, date?: "YYYY-MM-DD" }
//   force  — override the existing-picks overwrite guard (scheduled cards are protected)
//   dryRun — compute + log everything, write nothing

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = "edge-picks-cfb";
const MODEL_VERSION = "v1.0-cfb";

// ── The Odds API sport key — one key covers the FBS regular season + bowls.
const CFB_ODDS_SPORTS = ["americanfootball_ncaaf"];

// ── Season constants ──
// CFB margins are wider than NFL: empirical margin σ ≈ 16.5, total σ ≈ 12.5. HFA ≈ 2.5.
// League total ≈ 55.5. Market weight 0.70 (market-heavier than NFL's 0.50 because there is
// no rating seed); drift clamps below are the real guardrail.
const PHASE_CONFIG = {
  regular: {
    sigmaMargin: 16.5, sigmaTotal: 12.5, hfa: 2.5,
    marketWeight: 0.70, shrinkMult: 1.0,
    maxUnits: 2.5, mlMaxUnits: 0.5, evFloor: 0.03, leanEvFloor: 0.03,
    leagueTotal: 55.5,
    marginClamp: 4.0,   // |modelMargin − marketMargin| ≤ 4 pts
    totalClamp: 5.0,    // |modelTotal − consensusTotal| ≤ 5 pts
  },
};

// Shrinkage priors inherited from alpha's fitted constants (428 graded picks, Mar–Jun 2026),
// same as the NFL pipeline. No CFB-specific fit exists yet — that is what this store
// accumulates. Refit against graded edge-picks-cfb results once the sample is real.
const SHRINK_K = { Spread: 0.35, Total: 0.30, Moneyline: 0.50 };
const COVER_PROB_CAPS = { CFB_Spread: 0.57, CFB_Total: 0.60, CFB_Moneyline: 0.72 };
const LEAN_UNITS = 0.25;

// ── Book weighting (sharpness) + bettable retail set — identical to NFL ──
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

const INDOOR_VENUES = /alamodome|carrier dome|jma wireless|ford field|lucas oil|mercedes-benz|caesars superdome|nrg stadium|state farm stadium|allegiant|at&t stadium|u\.?s\.? bank|roof|dome/i;

// ── Team matching helpers ──
// CFB nicknames collide constantly (Tigers, Bulldogs, Wildcats…), so fuzzy matching keys on
// the SCHOOL (name minus the nickname word), never the nickname alone — "LSU Tigers" and
// "Auburn Tigers" must never match each other.
function normTeam(s) { return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim(); }
function schoolKey(name) {
  const parts = normTeam(name).split(" ");
  return parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || "");
}
function cfbTeamsMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const sa = schoolKey(a), sb = schoolKey(b);
  return sa.length > 2 && sa === sb;
}

// ── Math helpers (identical formulas to alpha/NFL) ──
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

// CFB key-number cover: extra mass at 3 and 7 (then 6/10/14). Slightly smaller bumps than
// the NFL — college margins are less key-number concentrated (more blowouts, 2-pt tries).
function cfbSpreadCoverProb(modelMargin, pointsReceived, sigma) {
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
  bump(3, 0.016); bump(7, 0.011); bump(6, 0.005); bump(10, 0.005); bump(14, 0.004);
  pWin = Math.min(0.72, Math.max(0.28, pWin));
  return pPush > 0.002 ? pWin / (1 - pPush) : pWin;
}

function cfbTotalCoverProb(modelTotal, line, isOver, sigma) {
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

// ── ESPN: today's FBS slate (the game-day gate + records) ──
// groups=80 = FBS; without it ESPN returns only Top-25 games and most of the slate is invisible.
async function fetchESPNSlate(dateISO) {
  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${dateISO.replace(/-/g, "")}&groups=80&limit=300`);
    if (!resp.ok) return { games: [], seasonPhase: "regular" };
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
        seasonType: ev.season?.type || 2, // CFB has no preseason
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
    return { games, seasonPhase: "regular" };
  } catch (e) {
    console.log(`[cfb] ESPN slate fetch error: ${e.message}`);
    return { games: [], seasonPhase: "regular" };
  }
}

// Live rating overlay from ESPN CFB standings: per-game point differential (margin signal)
// and per-game combined scoring rate (totals signal). Early season this is empty — the
// projection then stays fully market-anchored, which is the intended behavior.
async function fetchLiveRatingOverlay() {
  const out = {}; // displayName → { margin: pd/gp, totalRate: (PF+PA)/gp }
  try {
    const resp = await fetch("https://site.api.espn.com/apis/v2/sports/football/college-football/standings");
    if (!resp.ok) return out;
    const data = await resp.json();
    const walk = (node) => {
      if (!node) return;
      const entries = node.standings?.entries || [];
      for (const e of entries) {
        const name = e.team?.displayName || "";
        if (!name) continue;
        const stats = {};
        for (const s of (e.stats || [])) if (s.name) stats[s.name] = s.value;
        const wins = Number(stats.wins || 0), losses = Number(stats.losses || 0);
        const gp = Number(stats.gamesPlayed || (wins + losses) || 0);
        if (gp <= 0) continue; // no games yet → no signal, stay market-anchored
        const pd = Number(stats.pointDifferential ?? stats.differential ?? 0);
        const pf = Number(stats.pointsFor ?? NaN);
        const pa = Number(stats.pointsAgainst ?? NaN);
        out[name] = {
          margin: pd / gp,
          totalRate: (Number.isFinite(pf) && Number.isFinite(pa)) ? (pf + pa) / gp : null,
        };
      }
      for (const child of (node.children || [])) walk(child);
    };
    walk(data);
    if (Array.isArray(data.children)) for (const c of data.children) walk(c);
    console.log(`[cfb] Live standings overlay for ${Object.keys(out).length} teams`);
  } catch (e) {
    console.log(`[cfb] standings overlay skipped: ${e.message}`);
  }
  return out;
}

function overlayFor(name, overlay) {
  if (!overlay) return null;
  if (overlay[name]) return overlay[name];
  for (const [k, v] of Object.entries(overlay)) {
    if (cfbTeamsMatch(k, name)) return v;
  }
  return null;
}

// QB-out adjustment (points of margin). ESPN's CFB injury feed is spotty — treat it as a
// best-effort overlay, never a required input.
async function fetchQbAdjustments() {
  const adj = {}; // team displayName → margin points (negative if THEIR qb is out)
  try {
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/college-football/injuries");
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
          const mag = /doubtful/.test(status) ? -2.5 : -4.0;
          adj[teamName] = Math.min(adj[teamName] || 0, mag);
        }
      }
    }
    if (!Object.keys(adj).length && Array.isArray(data.items)) {
      for (const item of data.items) {
        const teamName = item.team?.displayName || "";
        const pos = (item.athlete?.position?.abbreviation || "").toUpperCase();
        const status = (item.status || "").toLowerCase();
        if (pos === "QB" && /out|ir|doubtful/.test(status)) {
          adj[teamName] = /doubtful/.test(status) ? -2.5 : -4.0;
        }
      }
    }
    if (Object.keys(adj).length) console.log(`[cfb] QB adjustments: ${JSON.stringify(adj)}`);
  } catch (e) {
    console.log(`[cfb] QB injury fetch skipped: ${e.message}`);
  }
  return adj;
}

function qbMarginAdj(home, away, qbAdj) {
  if (!qbAdj) return 0;
  const find = (name) => {
    if (qbAdj[name] != null) return qbAdj[name];
    for (const [k, v] of Object.entries(qbAdj)) {
      if (cfbTeamsMatch(k, name)) return v;
    }
    return 0;
  };
  return (find(home) || 0) - (find(away) || 0);
}

// ── The Odds API: today's CFB games (ET-date filtered) ──
async function fetchCFBOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { console.log("[cfb] No ODDS_API_KEY — cannot fetch odds"); return []; }
  const seen = new Set();
  const games = [];
  for (const sport of CFB_ODDS_SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) { console.log(`[cfb] Odds fetch ${sport}: HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      for (const g of data) {
        if (seen.has(g.id)) continue;
        if (easternDateOf(g.commence_time) !== dateISO) continue;
        seen.add(g.id);
        games.push(g);
      }
    } catch (e) {
      console.log(`[cfb] Odds fetch error for ${sport}: ${e.message}`);
    }
  }
  console.log(`[cfb] Odds API: ${games.length} CFB game(s) for ${dateISO}`);
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
// keep the best-EV offer per side. Line shopping IS a real, honest edge — the CFB model's
// own directional signal is deliberately tiny until the overlay has real games behind it. ──
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

  const ovHome = overlayFor(c.home, ratingOverlay);
  const ovAway = overlayFor(c.away, ratingOverlay);
  const qbAdjPts = qbMarginAdj(c.home, c.away, qbAdj);
  const marketMargin = c.consensusSpread != null ? -c.consensusSpread : 0;
  // No static seed exists for 130+ FBS teams: with a live overlay for BOTH teams the rating
  // margin is point-diff-based; without it the market number IS the prior (rating = market).
  const haveMarginOverlay = !!(ovHome && ovAway);
  const ratingMargin = haveMarginOverlay
    ? (ovHome.margin - ovAway.margin) + cfg.hfa
    : marketMargin;
  let modelMargin = cfg.marketWeight * marketMargin + (1 - cfg.marketWeight) * ratingMargin + qbAdjPts;
  // Hard clamp: the model may never drift more than marginClamp pts off the market number.
  modelMargin = Math.max(marketMargin - cfg.marginClamp, Math.min(marketMargin + cfg.marginClamp, modelMargin));

  const indoor = !!(espnGame && espnGame.indoor);
  const haveTotalOverlay = !!(ovHome && ovAway && ovHome.totalRate != null && ovAway.totalRate != null);
  let modelTotal = c.consensusTotal;
  if (c.consensusTotal != null) {
    if (haveTotalOverlay) {
      const ratingTotal = (ovHome.totalRate + ovAway.totalRate) / 2 + (indoor ? 0.8 : 0);
      modelTotal = 0.5 * ratingTotal + 0.5 * c.consensusTotal;
      modelTotal = Math.max(c.consensusTotal - cfg.totalClamp, Math.min(c.consensusTotal + cfg.totalClamp, modelTotal));
    } else {
      modelTotal = c.consensusTotal + (indoor ? 0.4 : 0);
    }
  }

  const shrink = (raw, market, prior) => {
    const cap = COVER_PROB_CAPS[`CFB_${market}`] || 0.60;
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
      sport: "NCAAF", market, side,
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
      const raw = cfbSpreadCoverProb(modelMargin, o.point, cfg.sigmaMargin);
      const prior = Math.min(0.95, Math.max(0.05, c.spreadHomeNoVig + (o.point - c.consensusSpread) * 0.038));
      return { raw, cover: shrink(raw, "Spread", prior), prior };
    });
    if (homeBest) {
      const added = pushCand("Spread", `${c.home} ${fmtSigned(homeBest.offer.point)}`, homeBest.offer, homeBest.raw, homeBest.prior,
        `${c.home} ${fmtSigned(-modelMargin)}`, `${c.home} ${fmtSigned(homeBest.offer.point)} @ ${fmtOdds(homeBest.offer.price)}`,
        modelMargin - (-homeBest.offer.point));
      if (added) attachPredCLV(added, c.sharp?.homeSpread, c.sharp?.awaySpread, c.offers.spreadAway.find(x => x.book === homeBest.offer.book)?.price);
    }
    const awayBest = bestOffer(c.offers.spreadAway, (o) => {
      const raw = cfbSpreadCoverProb(-modelMargin, o.point, cfg.sigmaMargin);
      const prior = Math.min(0.95, Math.max(0.05, (1 - c.spreadHomeNoVig) + (o.point - (-c.consensusSpread)) * 0.038));
      return { raw, cover: shrink(raw, "Spread", prior), prior };
    });
    if (awayBest) {
      const added = pushCand("Spread", `${c.away} ${fmtSigned(awayBest.offer.point)}`, awayBest.offer, awayBest.raw, awayBest.prior,
        `${c.away} ${fmtSigned(modelMargin)}`, `${c.away} ${fmtSigned(awayBest.offer.point)} @ ${fmtOdds(awayBest.offer.price)}`,
        (-modelMargin) - (-awayBest.offer.point));
      if (added) attachPredCLV(added, c.sharp?.awaySpread, c.sharp?.homeSpread, c.offers.spreadHome.find(x => x.book === awayBest.offer.book)?.price);
    }
  }

  // TOTALS — overlay-blended (or pure-consensus) total, then shop the number.
  if (c.consensusTotal != null && c.totalOverNoVig != null && modelTotal != null && (c.majorTotal || 0) >= 2) {
    const overBest = bestOffer(c.offers.over, (o) => {
      const raw = cfbTotalCoverProb(modelTotal, o.point, true, cfg.sigmaTotal);
      const prior = Math.min(0.95, Math.max(0.05, c.totalOverNoVig + (c.consensusTotal - o.point) * 0.035));
      return { raw, cover: shrink(raw, "Total", prior), prior };
    });
    if (overBest) {
      const added = pushCand("Total", `Over ${overBest.offer.point}`, overBest.offer, overBest.raw, overBest.prior,
        `${modelTotal.toFixed(1)} total`, `Over ${overBest.offer.point} @ ${fmtOdds(overBest.offer.price)}`, overBest.offer.point ? modelTotal - overBest.offer.point : 0);
      if (added) attachPredCLV(added, c.sharp?.over, c.sharp?.under, c.offers.under.find(x => x.book === overBest.offer.book)?.price);
    }
    const underBest = bestOffer(c.offers.under, (o) => {
      const raw = cfbTotalCoverProb(modelTotal, o.point, false, cfg.sigmaTotal);
      const prior = Math.min(0.95, Math.max(0.05, (1 - c.totalOverNoVig) + (o.point - c.consensusTotal) * 0.035));
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

// ── Match an odds-API game to the ESPN slate (records/venue context) — school-keyed ──
function findESPNGame(espnGames, home, away) {
  return espnGames.find(g =>
    cfbTeamsMatch(g.homeTeam, home) && cfbTeamsMatch(g.awayTeam, away)
  ) || null;
}

// ── Selection: one pick per game (highest EV), top 3, floors ──
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

// ── Assemble final pick objects (exact alpha card shape — the /cfb page is an alpha clone) ──
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
      sport: "NCAAF",
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
      source: "cfb",
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

// 3+1 of the published card — same product as alpha v10.5.2 / NFL. No phantom synthesis later.
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
      sport: "NCAAF",
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

function emptyCard(dateISO, dateFormatted, seasonPhase, noPlays) {
  return {
    date: dateISO,
    dateFormatted,
    generatedAt: new Date().toISOString(),
    model: MODEL_VERSION,
    seasonPhase,
    noPlays,
    noGames: /No College Football Games Scheduled/i.test(noPlays || ""),
    picks: [],
    rejections: [],
    parlayLegs: [],
    summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
  };
}

// ── Claude narration (narrator ONLY — the model already selected and sized; grounding is
// strictly the provided table, no invented specifics) ──
const CFB_NARRATOR_SYSTEM = `You are THE LOCK — WeBetAI's college football analyst. The statistical model has ALREADY selected and sized these picks. Your only job is to write honest, compelling narratives.

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
      p.coreReasoning = p.coreReasoning ||
        `WeBetAI scanned every spread, total, and moneyline on the college football slate and ${p.pick} at ${p.odds}${p.bestBook ? ` (${p.bestBook})` : ""} is the best value on this game. Calibrated cover ${p.coverProb} vs break-even at this price, ${p.ev} expected value. Stake is quarter-Kelly sized to the calibrated edge.`;
      p.whatLoses = p.whatLoses || "A game script that runs against the number — a late score or a stalled drive at a key number (3 or 7).";
      p.clvExpectation = p.clvExpectation || (typeof p.predCLV === "number"
        ? `Pick-time Pinnacle predCLV ${(p.predCLV * 100).toFixed(1)}¢ — hold if the close stays near this number.`
        : "Line expected to stay near the consensus number into kickoff.");
    }
    return {
      edgeSummary: `WeBetAI's college football model evaluated every market on today's slate and found its best value on ${picks.map(p => `${p.pick} (${p.odds})`).join(", ")}.`,
      insights: `${picks.length} college football pick${picks.length > 1 ? "s" : ""} today, ${picks.reduce((s, p) => s + parseFloat(p.units), 0)}u total exposure. Discipline: 3% EV floor, key-number cover, 2+ major books, Hard Rock preferred, quarter-Kelly, market-anchored projections.`,
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
      system: CFB_NARRATOR_SYSTEM,
      messages: [{ role: "user", content: `Date: ${dateFormatted}. Season phase: ${seasonPhase}.\nPicks table:\n${JSON.stringify(table, null, 2)}` }],
    });
    if (!resp || !resp.ok) { console.log(`[cfb] Narrator unavailable (${resp ? resp.status : "timeout"}) — using fallback`); return fallback(); }
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
    console.log(`[cfb] Narration error: ${e.message} — using fallback`);
    return fallback();
  }
}

// ── Storage (REST blob API, mirrors alpha/NFL incl. the v10.4 overwrite guard) ──
async function storePicks(dateISO, picksData, force, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) { console.error("[cfb] NETLIFY_AUTH_TOKEN not set, cannot store picks"); return false; }
  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`;
  const auth = { "Authorization": `Bearer ${token}` };

  // Overwrite guard: a scheduled card is protected; force:true carries settled results forward.
  try {
    const existResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: auth });
    if (existResp.ok) {
      const existing = await existResp.json();
      const existingPicks = Array.isArray(existing?.picks) ? existing.picks : [];
      if (existingPicks.length > 0 && !force) {
        console.error(`[cfb-guard] REFUSING overwrite: picks-${dateISO} already holds ${existingPicks.length} pick(s). POST with {"force":true} to override.`);
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
    console.log(`[cfb-guard] Existence check failed (${e.message}) — proceeding`);
  }

  try {
    const put = await fetch(`${storeUrl}/picks-${dateISO}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (!put.ok) { console.error(`[cfb] Blob PUT failed ${put.status}: ${(await put.text()).slice(0, 200)}`); return false; }

    await fetch(`${storeUrl}/latest-date`, {
      method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: dateISO,
    });

    let dates = [];
    try {
      const dResp = await fetch(`${storeUrl}/picks-dates`, { headers: auth });
      if (dResp.ok) dates = await dResp.json();
    } catch (e) {}
    if (!Array.isArray(dates)) dates = [];
    // Off-day "no games" blobs update latest-date (so /cfb is never stale) but stay off
    // picks-dates so the track record is not padded with every off day.
    if (opts.indexDates !== false && !dates.includes(dateISO)) {
      dates.push(dateISO); dates.sort();
      await fetch(`${storeUrl}/picks-dates`, {
        method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(dates),
      });
    }
    console.log(`[cfb] Picks stored to ${STORE_NAME}/picks-${dateISO}`);
    return true;
  } catch (e) {
    console.error(`[cfb] Blob store error: ${e.message}`);
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
  console.log(`[cfb] ${MODEL_VERSION} run for ${dateISO} (scheduled:${!!body.scheduled} force:${force} dryRun:${dryRun})`);

  const cfg = PHASE_CONFIG.regular;
  const { games: espnGames, seasonPhase } = await fetchESPNSlate(dateISO);
  if (!espnGames.length) {
    console.log(`[cfb] No CFB games on ${dateISO} (ET) — writing no-games card.`);
    const noGames = emptyCard(dateISO, dateFormatted, seasonPhase, "No College Football Games Scheduled For Today");
    if (!dryRun) await storePicks(dateISO, noGames, force, { indexDates: false });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no CFB games today", stored: !dryRun }) };
  }
  console.log(`[cfb] ${espnGames.length} CFB game(s) today · phase=${seasonPhase}`);

  const [ratingOverlay, qbAdj] = await Promise.all([fetchLiveRatingOverlay(), fetchQbAdjustments()]);

  const oddsGames = await fetchCFBOdds(dateISO);
  if (!oddsGames.length) {
    console.log(`[cfb] ESPN shows games but no odds available — writing no-plays card.`);
    const noOdds = emptyCard(dateISO, dateFormatted, seasonPhase, "No qualifying college football plays today — WeBetAI passed.");
    if (!dryRun) await storePicks(dateISO, noOdds, force);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0, skipped: "no CFB odds available" }) };
  }

  // Consensus + candidates per game
  const allCands = [];
  for (const g of oddsGames) {
    const consensus = buildGameConsensus(g);
    if (consensus.bookCount < 3) { console.log(`[cfb] ${g.away_team} @ ${g.home_team}: only ${consensus.bookCount} books — skipping`); continue; }
    const espnGame = findESPNGame(espnGames, consensus.home, consensus.away);
    const cands = computeCandidates(consensus, espnGame, cfg, ratingOverlay, qbAdj);
    if (cands.length) {
      console.log(`[cfb] ${g.away_team} @ ${g.home_team}: consensus ${consensus.home} ${fmtSigned(consensus.consensusSpread ?? 0)} / total ${consensus.consensusTotal} · ${cands.length} candidate(s)`);
      for (const cand of cands) console.log(`[cfb]   ${cand.market}: ${cand.side} ${fmtOdds(cand.odds)} @ ${cand.book} — cover ${(cand.coverProb * 100).toFixed(1)}%, EV ${(cand.ev * 100).toFixed(1)}%`);
    }
    allCands.push(...cands);
  }

  if (!allCands.length) {
    console.log("[cfb] No positive-EV candidates on the slate — writing no-plays card.");
    const noPlaysData = emptyCard(dateISO, dateFormatted, seasonPhase, "No qualifying college football plays today — WeBetAI passed.");
    if (!dryRun) await storePicks(dateISO, noPlaysData, force);
    return { statusCode: 200, body: JSON.stringify({ ok: true, picks: 0 }) };
  }

  // Selection + floors
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
    rejections: rejections.slice(0, 12),
    parlayLegs: buildPublishedParlay(picks),
    summary: {
      totalPicks: picks.length,
      totalUnits: `${parseFloat(totalUnits.toFixed(2))}u`,
      aplusLocks: picks.filter(p => p.rating === "A+").length,
      sportsCovered: ["NCAAF"],
    },
    edgeSummary,
    insights,
  };

  console.log(`[cfb] Card: ${picks.map(p => `${p.pick} ${p.odds} (${p.units}, ${p.rating})`).join(" | ")}`);
  if (dryRun) {
    console.log("[cfb] DRY RUN — nothing stored.");
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, picksData }) };
  }

  const stored = await storePicks(dateISO, picksData, force);
  console.log(`[cfb] Done in ${((Date.now() - started) / 1000).toFixed(1)}s (stored: ${stored})`);
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
module.exports.cfbTeamsMatch = cfbTeamsMatch;
module.exports.schoolKey = schoolKey;
module.exports.PHASE_CONFIG = PHASE_CONFIG;
