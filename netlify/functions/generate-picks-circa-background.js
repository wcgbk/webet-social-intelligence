// generate-picks-circa-background.js
// ── WeBetAI Circa Million VIII contest card (NFL ATS, 5 picks) ──
// Isolated store: edge-picks-circa → /circa. Does not write Alpha/Omega/NFL cards.
//
// Official contest (https://www.circasports.com/circa-million):
//   NFL only · 5 spreads/week · 1 pt cover / 0.5 push · no juice
//   Lines Thu ~10:00 AM PT (Thanksgiving week Wed Nov 25 10am PT;
//   Christmas week Wed Dec 23 10am PT)
//   Picks due Sat 4:00 PM PT, or before the earliest selected kickoff
//
// Selection: calibrated cover probability (not dollar EV). One pick per game.
// Posted number: Circa Sports (`circasports`) when Odds API has it, else
// Pinnacle then consensus — noted on the card.
// Default-avoid kickoffs before Sat 4pm PT unless coverProb gap ≥ 4pp.
// Never include a game that already started. Skip/no-op outside NFL season.
//
// POST body: { scheduled?: bool, force?: bool, dryRun?: bool, week?: "2026-W01" }
//   force  — override the existing-picks overwrite guard
//   dryRun — compute + log everything, write nothing
// Scheduled refresh is allowed until Sat 4:00 PM PT; after the deadline the
// card is locked unless force:true.
//
// Holiday cron: trigger-picks-circa.js fires Wed 17:15 UTC on 2026-11-25 and
// 2026-12-23. After DST, 17:15 UTC is 9:15 AM PST — TODO if a 18:15 UTC shift
// is needed so the first card still lands after 10:00 AM PT.

const {
  CONTEST,
  parseWeekQuery,
  resolveContestWeek,
  weekKey,
  weekBlobKey,
  weekLabel,
  dateFormatted,
  deadlineText,
  saturdayDeadline,
  pendingPayload,
  defaultKpis,
  defaultWeeks,
  selectCircaCard,
  coverToRating,
  RATING_TO_CONFIDENCE,
  nick,
  strategyForCard,
  gameAlreadyStarted,
  isEarlyKickoff,
} = require("./lib/circa-contest");

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_NAME = CONTEST.storeName;
const MODEL_VERSION = CONTEST.modelVersion;
const NFL_ODDS_SPORT = "americanfootball_nfl";

const PHASE_CONFIG = {
  sigmaMargin: 13.2,
  hfa: 2.0,
  ratingDamp: 1.0,
  marketWeight: 0.50,
  shrinkMult: 1.0,
};
const SHRINK_K_SPREAD = 0.35;
const COVER_PROB_CAP = 0.57;

const BOOK_SHARPNESS = {
  circasports: 3.5,
  pinnacle: 3.0,
  betonlineag: 1.5, lowvig: 1.5, bookmaker: 1.5,
  draftkings: 1.2, fanduel: 1.2, betmgm: 1.2, caesars: 1.2, espnbet: 1.2,
};
const SHARP_BOOK_KEYS = ["circasports", "pinnacle", "betfair_ex_eu", "betfair_ex_uk", "betfair", "matchbook"];
function bookWeight(key) { return BOOK_SHARPNESS[(key || "").toLowerCase()] || 1.0; }
function sharpPri(key) {
  const i = SHARP_BOOK_KEYS.indexOf((key || "").toLowerCase());
  return i < 0 ? 99 : i;
}

const INDOOR_VENUES = /sofi|allegiant|at&t stadium|state farm|mercedes-benz|u\.?s\.? bank|ford field|lucas oil|caesars superdome|nrg stadium|roof|dome/i;

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
  const last = (name || "").trim().split(/\s+/).pop().toLowerCase();
  for (const [team, r] of Object.entries(NFL_TEAM_RATINGS)) {
    if (team.toLowerCase().endsWith(last)) return r;
  }
  return 0;
}

function erf(x) {
  const s = x >= 0 ? 1 : -1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function impliedProb(odds) { return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100); }
function noVigProb(myOdds, oppOdds) {
  if (myOdds == null || oppOdds == null) return null;
  const a = impliedProb(myOdds), b = impliedProb(oppOdds);
  const s = a + b;
  return s > 0 ? a / s : null;
}
function weightedMedian(pairs) {
  if (!pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) { acc += p.w; if (acc >= total / 2) return p.v; }
  return sorted[sorted.length - 1].v;
}
function fmtOdds(o) {
  if (o == null || !Number.isFinite(Number(o))) return "-110";
  const n = Number(o);
  return `${n > 0 ? "+" : ""}${n}`;
}
function fmtSigned(n, dp = 1) {
  const v = Number(n);
  const rounded = Math.abs(v - Math.round(v)) < 1e-9;
  const str = rounded ? String(Math.round(v)) : v.toFixed(dp);
  return v >= 0 ? `+${str}` : str;
}

// NFL key-number cover (same mass bumps as generate-picks-nfl-background).
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
    if (pointsReceived > 0 && L >= kn - 0.5 && L < kn) pWin -= w;
    if (pointsReceived > 0 && L > kn && L <= kn + 0.5) pWin += w;
    if (pointsReceived < 0 && L >= kn - 0.5 && L < kn) pWin += w;
    if (pointsReceived < 0 && L > kn && L <= kn + 0.5) pWin -= w;
  };
  bump(3, 0.022); bump(7, 0.014); bump(6, 0.006); bump(10, 0.005); bump(14, 0.004);
  pWin = Math.min(0.72, Math.max(0.28, pWin));
  return pPush > 0.002 ? pWin / (1 - pPush) : pWin;
}

function shrinkCover(raw, prior) {
  const cap = COVER_PROB_CAP;
  const mkt = (typeof prior === "number" && prior > 0.01 && prior < 0.99) ? prior : null;
  if (mkt == null) return Math.min(raw, cap);
  const K = SHRINK_K_SPREAD * PHASE_CONFIG.shrinkMult;
  return Math.min(mkt + K * (raw - mkt), cap);
}

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

function mapEspnEvent(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === "home");
  const away = comp.competitors?.find(c => c.homeAway === "away");
  if (!home || !away) return null;
  return {
    espnId: ev.id,
    date: ev.date,
    seasonType: ev.season?.type || 2,
    weekNum: ev.week?.number || ev.season?.slug || "",
    homeTeam: home.team?.displayName || "",
    awayTeam: away.team?.displayName || "",
    homeRecord: home.records?.[0]?.summary || "",
    awayRecord: away.records?.[0]?.summary || "",
    venue: comp.venue?.fullName || "",
    indoor: !!(comp.venue?.indoor) || INDOOR_VENUES.test(comp.venue?.fullName || ""),
    state: comp.status?.type?.state || "pre",
  };
}

async function fetchESPNWeekSlate(weekNum, year) {
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${weekNum}&year=${year}&seasontype=2`,
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  ];
  const seen = new Set();
  const games = [];
  let espnWeek = weekNum;
  let seasonType = 2;
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.week?.number) espnWeek = data.week.number;
      if (data.season?.type) seasonType = data.season.type;
      for (const ev of (data.events || [])) {
        const g = mapEspnEvent(ev);
        if (!g || seen.has(g.espnId)) continue;
        const evWeek = ev.week?.number;
        if (evWeek && Number(evWeek) !== Number(weekNum) && url.includes("week=")) continue;
        if (!url.includes("week=") && evWeek && Number(evWeek) !== Number(weekNum)) continue;
        seen.add(g.espnId);
        games.push(g);
      }
    } catch (e) {
      console.log(`[circa] ESPN slate error: ${e.message}`);
    }
  }
  return { games, espnWeek, seasonType };
}

async function fetchLiveRatingOverlay() {
  const out = {};
  try {
    const resp = await fetch("https://site.api.espn.com/apis/v2/sports/football/nfl/standings");
    if (!resp.ok) return out;
    const data = await resp.json();
    const children = data.children || [data];
    for (const conf of children) {
      for (const e of (conf.standings?.entries || [])) {
        const name = e.team?.displayName || "";
        if (!name) continue;
        const stats = {};
        for (const s of (e.stats || [])) if (s.name) stats[s.name] = s.value;
        const pd = Number(stats.pointDifferential ?? stats.differential ?? 0);
        const gp = Number(stats.gamesPlayed || ((stats.wins || 0) + (stats.losses || 0)) || 1);
        out[name] = gp > 0 ? pd / gp : 0;
      }
    }
    console.log(`[circa] Live standings overlay for ${Object.keys(out).length} teams`);
  } catch (e) {
    console.log(`[circa] standings overlay skipped: ${e.message}`);
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

async function fetchQbAdjustments() {
  const adj = {};
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
    if (Object.keys(adj).length) console.log(`[circa] QB adjustments: ${JSON.stringify(adj)}`);
  } catch (e) {
    console.log(`[circa] QB injury fetch skipped: ${e.message}`);
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

async function fetchNFLSpreadOdds() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { console.log("[circa] No ODDS_API_KEY — cannot fetch odds"); return []; }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${NFL_ODDS_SPORT}/odds?regions=us,us2,eu&markets=spreads&oddsFormat=american&apiKey=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[circa] Odds fetch: HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    console.log(`[circa] Odds API: ${(data || []).length} NFL event(s)`);
    return data || [];
  } catch (e) {
    console.log(`[circa] Odds fetch error: ${e.message}`);
    return [];
  }
}

function findESPNGame(espnGames, home, away) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const last = (s) => norm(s).split(" ").pop();
  return espnGames.find(g =>
    (norm(g.homeTeam) === norm(home) || last(g.homeTeam) === last(home)) &&
    (norm(g.awayTeam) === norm(away) || last(g.awayTeam) === last(away))
  ) || null;
}

function spreadOutcomes(mkt, home, away) {
  const h = mkt.outcomes?.find(o => o.name === home);
  const a = mkt.outcomes?.find(o => o.name === away);
  if (h?.point == null || a?.point == null) return null;
  return { home: h, away: a };
}

function buildPostedSpread(game) {
  const home = game.home_team, away = game.away_team;
  const spreadPts = [];
  const spreadNoVig = [];
  let circa = null;
  let pinnacle = null;
  let sharp = { pri: 99, book: null, home: null, away: null };

  for (const bk of (game.bookmakers || [])) {
    const key = (bk.key || "").toLowerCase();
    const w = bookWeight(key);
    const pri = sharpPri(key);
    for (const mkt of (bk.markets || [])) {
      if (mkt.key !== "spreads") continue;
      const sides = spreadOutcomes(mkt, home, away);
      if (!sides) continue;
      spreadPts.push({ v: sides.home.point, w });
      const nv = noVigProb(sides.home.price, sides.away.price);
      if (nv != null) spreadNoVig.push({ point: sides.home.point, prob: nv, w, key });
      if (key === "circasports") circa = { book: key, home: sides.home, away: sides.away };
      if (key === "pinnacle") pinnacle = { book: key, home: sides.home, away: sides.away };
      if (pri < sharp.pri) sharp = { pri, book: key, home: sides.home, away: sides.away };
    }
  }

  const consensusSpread = weightedMedian(spreadPts);
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

  let posted, lineSource, lineNote;
  if (circa) {
    posted = circa;
    lineSource = "circasports";
    lineNote = null;
  } else if (pinnacle) {
    posted = pinnacle;
    lineSource = "pinnacle";
    lineNote = "Circa number not posted on the Odds API — using Pinnacle.";
  } else if (consensusSpread != null && sharp.home) {
    posted = { book: sharp.book || "consensus", home: sharp.home, away: sharp.away };
    lineSource = sharp.book || "consensus";
    lineNote = "Circa number not posted on the Odds API — using sharp/consensus. Confirm the official Circa contest number before submitting.";
  } else {
    return null;
  }

  return {
    home, away, commenceTime: game.commence_time,
    consensusSpread,
    spreadHomeNoVig,
    postedHomePoint: posted.home.point,
    postedAwayPoint: posted.away.point,
    postedHomePrice: posted.home.price,
    postedAwayPrice: posted.away.price,
    lineSource,
    lineNote,
    bookCount: (game.bookmakers || []).length,
  };
}

function computeSpreadSides(posted, espnGame, ratingOverlay, qbAdj) {
  const cfg = PHASE_CONFIG;
  const c = posted;
  if (c.postedHomePoint == null) return [];

  const rHome = teamRatingLive(c.home, ratingOverlay);
  const rAway = teamRatingLive(c.away, ratingOverlay);
  const qbAdjPts = qbMarginAdj(c.home, c.away, qbAdj);
  const ratingMargin = (rHome - rAway) * cfg.ratingDamp + cfg.hfa + qbAdjPts;
  const marketMargin = c.consensusSpread != null ? -c.consensusSpread : -c.postedHomePoint;
  const modelMargin = cfg.marketWeight * marketMargin + (1 - cfg.marketWeight) * ratingMargin;

  const homePrior = c.spreadHomeNoVig != null
    ? Math.min(0.95, Math.max(0.05, c.spreadHomeNoVig + (c.postedHomePoint - (c.consensusSpread ?? c.postedHomePoint)) * 0.048))
    : null;
  const awayPrior = homePrior != null ? Math.min(0.95, Math.max(0.05, 1 - homePrior)) : null;

  const homeRaw = nflSpreadCoverProb(modelMargin, c.postedHomePoint, cfg.sigmaMargin);
  const awayRaw = nflSpreadCoverProb(-modelMargin, c.postedAwayPoint, cfg.sigmaMargin);
  const homeCover = shrinkCover(homeRaw, homePrior);
  const awayCover = shrinkCover(awayRaw, awayPrior);

  const base = {
    sport: "NFL",
    market: "Spread",
    homeTeam: c.home,
    awayTeam: c.away,
    commenceTime: c.commenceTime,
    lineSource: c.lineSource,
    lineNote: c.lineNote,
    venue: espnGame?.venue || "",
    homeRecord: espnGame?.homeRecord || "",
    awayRecord: espnGame?.awayRecord || "",
    modelMargin,
    consensusSpread: c.consensusSpread,
    gameKey: `${c.away}@${c.home}`,
  };

  return [
    {
      ...base,
      side: "home",
      pickTeam: c.home,
      pick: `${nick(c.home)} ${fmtSigned(c.postedHomePoint)}`,
      odds: c.postedHomePrice,
      coverProb: homeCover,
      rawProb: homeRaw,
      postedPoint: c.postedHomePoint,
    },
    {
      ...base,
      side: "away",
      pickTeam: c.away,
      pick: `${nick(c.away)} ${fmtSigned(c.postedAwayPoint)}`,
      odds: c.postedAwayPrice,
      coverProb: awayCover,
      rawProb: awayRaw,
      postedPoint: c.postedAwayPoint,
    },
  ];
}

function buildFinalPicks(selected, weekNum) {
  return selected.map((c, i) => {
    const cover = Number(c.coverProb);
    const rating = coverToRating(cover);
    const edge = cover - 0.50;
    const edgePct = `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`;
    const coverPct = `${(cover * 100).toFixed(1)}%`;
    const fallback = c.lineNote
      ? `${c.lineNote} WeBetAI projects this spread at calibrated cover ${coverPct} (contest breakeven is 50 percent with no juice).`
      : `WeBetAI ranks this side by calibrated cover probability ${coverPct} at the ${c.lineSource === "circasports" ? "Circa Sports posted" : "market"} number ${c.pick}. Contest scoring has no juice — edge vs 50 percent is ${edgePct}.`;
    return {
      sport: "NFL",
      betType: "spread",
      confidence: RATING_TO_CONFIDENCE[rating] || "b",
      rating,
      matchup: `${c.awayTeam} @ ${c.homeTeam}`,
      homeTeam: c.homeTeam,
      awayTeam: c.awayTeam,
      venue: c.venue || "",
      pick: c.pick,
      odds: fmtOdds(c.odds),
      coverProb: coverPct,
      coverProbRaw: cover,
      edgePct,
      commenceTime: c.commenceTime || "",
      coreReasoning: c.coreReasoning || fallback,
      lineSource: c.lineSource,
      lineNote: c.lineNote || null,
      earlyKickoff: !!(c.earlyKickoff || isEarlyKickoff(c.commenceTime, weekNum)),
      source: "circa",
      result: "pending",
    };
  });
}

const CIRCA_NARRATOR_SYSTEM = `You are THE LOCK — WeBetAI's NFL contest analyst for Circa Million VIII. The statistical model has ALREADY selected these 5 against-the-spread picks by calibrated cover probability (the contest has no juice). Your only job is to write honest, compelling narratives.

RULES:
- Say "WeBetAI" — never "the model" or "our model".
- Use the EXACT pick string, odds, coverProb, and edgePct from the table. Never invent a different line.
- matchup is Away @ Home format. Use homeTeam / awayTeam / venue from the table for any location or home-field claim.
- NEVER invent or invert venue/home-field. If the pick is the away team, do NOT claim home-field advantage.
- Use ONLY facts in the data (teams, the contest number, Circa vs consensus note, records, venue, cover math). No invented player/coach/news.
- coreReasoning: 3-4 sentences arguing FOR the pick side. Start with a concrete supporting fact from the data. Mention key numbers 3/7 when the number sits on one. End with why this side ranks on a no-juice contest card.
- Do not discuss units, Kelly, or sportsbook EV.

Return ONLY valid JSON:
{"narratives":[{"pick":"<exact pick string>","coreReasoning":"..."}]}`;

async function narratePicks(picks, weekLabelStr) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = () => {
    for (const p of picks) {
      if (p.coreReasoning) continue;
      p.coreReasoning =
        `WeBetAI scanned the NFL spread board for ${weekLabelStr} and ranks ${p.pick} at ${p.odds}${p.lineSource === "circasports" ? " (Circa posted number)" : p.lineNote ? " (" + p.lineNote + ")" : ""} by calibrated cover ${p.coverProb}. Contest scoring has no juice, so this is a cover-probability pick, not a dollar-EV bet.`;
    }
    return picks;
  };
  if (!apiKey || !picks.length) return fallback();

  try {
    const table = picks.map(p => ({
      pick: p.pick, matchup: p.matchup, homeTeam: p.homeTeam, awayTeam: p.awayTeam, venue: p.venue,
      odds: p.odds, coverProb: p.coverProb, edgePct: p.edgePct,
      lineSource: p.lineSource, lineNote: p.lineNote, earlyKickoff: p.earlyKickoff,
    }));
    const resp = await anthropicFetch({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      temperature: 0.3,
      system: CIRCA_NARRATOR_SYSTEM,
      messages: [{ role: "user", content: `${weekLabelStr}.\nPicks table:\n${JSON.stringify(table, null, 2)}` }],
    });
    if (!resp || !resp.ok) { console.log(`[circa] Narrator unavailable (${resp ? resp.status : "timeout"}) — using fallback`); return fallback(); }
    const data = await resp.json();
    const text = (data.content || []).map(b => b.text || "").join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback();
    const parsed = JSON.parse(jsonMatch[0]);
    for (const p of picks) {
      const n = (parsed.narratives || []).find(x => x.pick === p.pick);
      if (n && n.coreReasoning) p.coreReasoning = n.coreReasoning;
    }
    return fallback();
  } catch (e) {
    console.log(`[circa] Narration error: ${e.message} — using fallback`);
    return fallback();
  }
}

function blobAuth() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  return {
    storeUrl: `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`,
    auth: { Authorization: `Bearer ${token}` },
  };
}

async function readBlobJson(key) {
  const b = blobAuth();
  if (!b) return null;
  try {
    const resp = await fetch(`${b.storeUrl}/${key}`, { headers: b.auth });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function putBlob(key, body, contentType) {
  const b = blobAuth();
  if (!b) { console.error("[circa] NETLIFY_AUTH_TOKEN not set, cannot store picks"); return false; }
  const put = await fetch(`${b.storeUrl}/${key}`, {
    method: "PUT",
    headers: { ...b.auth, "Content-Type": contentType || "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!put.ok) {
    console.error(`[circa] Blob PUT ${key} failed ${put.status}: ${(await put.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

function mergeKpis(existing, weekNum) {
  const kpis = (existing && existing.kpis) ? { ...defaultKpis(), ...existing.kpis } : defaultKpis();
  const weeks = defaultWeeks(weekNum);
  if (existing && Array.isArray(existing.weeks)) {
    for (const prev of existing.weeks) {
      const row = weeks.find(w => w.label === prev.label);
      if (!row) continue;
      if (prev.points != null) row.points = prev.points;
      if (prev.status && prev.status !== "upcoming") row.status = prev.status;
      if (prev.record) row.record = prev.record;
      if (prev.rate) row.rate = prev.rate;
    }
  }
  const cur = weeks.find(w => w.current);
  if (cur && (!cur.status || cur.status === "upcoming" || cur.status === "pending")) {
    cur.status = "pending";
  }
  return { kpis, weeks };
}

async function storeCard(weekStr, picksData, force, scheduled, now) {
  const key = weekBlobKey(weekStr);
  const existing = await readBlobJson(key);

  const existingPicks = Array.isArray(existing?.picks) ? existing.picks : [];
  const incomingPicks = Array.isArray(picksData?.picks) ? picksData.picks : [];
  const weekNum = picksData.weekNum || parseWeekQuery(weekStr)?.weekNum;
  const deadline = weekNum ? saturdayDeadline(weekNum) : null;
  const afterDeadline = deadline ? now >= deadline : false;

  if (existingPicks.length > 0 && incomingPicks.length === 0 && !force) {
    console.error(`[circa-guard] REFUSING to replace live ${key} (${existingPicks.length} pick(s)) with an empty/pending card.`);
    return false;
  }

  if (existingPicks.length > 0 && !force) {
    if (scheduled && !afterDeadline) {
      console.log(`[circa-guard] Scheduled refresh allowed before Sat 4pm PT (${existingPicks.length} existing pick(s)).`);
    } else if (scheduled && afterDeadline) {
      console.error(`[circa-guard] REFUSING scheduled overwrite after deadline: ${key} locked with ${existingPicks.length} pick(s). POST {"force":true} to override.`);
      return false;
    } else {
      console.error(`[circa-guard] REFUSING overwrite: ${key} already holds ${existingPicks.length} pick(s). POST with {"force":true} to override.`);
      return false;
    }
    const resMap = new Map(existingPicks.filter(p => p.result && p.result !== "pending").map(p => [`${p.pick}||${p.matchup}`, p]));
    for (const p of (picksData.picks || [])) {
      const prev = resMap.get(`${p.pick}||${p.matchup}`);
      if (prev && (!p.result || p.result === "pending")) {
        p.result = prev.result; p.profit = prev.profit;
        p.finalScore = prev.finalScore || null; p.settledAt = prev.settledAt || null;
      }
    }
  }

  const latest = await readBlobJson("latest");
  const merged = mergeKpis(latest && latest.week !== weekStr ? latest : existing, weekNum);
  picksData.kpis = merged.kpis;
  picksData.weeks = merged.weeks;
  if (incomingPicks.length) {
    const cur = (picksData.weeks || []).find(w => w.current);
    if (cur) cur.status = "live";
  }

  const ok = await putBlob(key, picksData);
  if (!ok) return false;
  await putBlob("latest", picksData);
  await putBlob("latest-week", weekStr, "text/plain");
  console.log(`[circa] Picks stored to ${STORE_NAME}/${key}`);
  return true;
}

function liveCardPayload({ weekNum, week, picks, strategy }) {
  return {
    preview: false,
    pending: false,
    contest: CONTEST.name,
    weekLabel: weekLabel(weekNum),
    dateFormatted: dateFormatted(weekNum),
    deadline: deadlineText(weekNum),
    strategy,
    week,
    weekNum,
    picks,
    kpis: defaultKpis(),
    weeks: defaultWeeks(weekNum),
    modelVersion: MODEL_VERSION,
    model: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
  };
}

exports.handler = async (event) => {
  const started = Date.now();
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const force = !!body.force;
  const dryRun = !!body.dryRun;
  const scheduled = !!body.scheduled;
  const now = new Date();

  const parsed = parseWeekQuery(body.week);
  const resolved = parsed || resolveContestWeek(now);
  const weekNum = resolved.weekNum;
  const week = resolved.week || weekKey(weekNum);
  console.log(`[circa] ${MODEL_VERSION} run for ${week} (scheduled:${scheduled} force:${force} dryRun:${dryRun} slot:${body.slot || "-"})`);

  if (resolved.preSeason || resolved.postSeason || weekNum < 1 || weekNum > CONTEST.totalWeeks) {
    console.log(`[circa] Outside NFL regular season (week=${weekNum}, pre=${resolved.preSeason}, post=${resolved.postSeason}) — no-op.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "outside NFL season", week }) };
  }

  const { games: espnGames, seasonType } = await fetchESPNWeekSlate(weekNum, CONTEST.seasonYear);
  if (seasonType && seasonType !== 2 && !espnGames.length) {
    console.log(`[circa] ESPN seasonType=${seasonType} and no regular-season games — no-op.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no NFL regular-season games", week }) };
  }
  if (!espnGames.length) {
    console.log(`[circa] No ESPN NFL games for ${week} — no-op.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no NFL games this week", week }) };
  }
  console.log(`[circa] ${espnGames.length} ESPN game(s) for ${week}`);

  const [ratingOverlay, qbAdj, oddsGames] = await Promise.all([
    fetchLiveRatingOverlay(),
    fetchQbAdjustments(),
    fetchNFLSpreadOdds(),
  ]);

  if (!oddsGames.length) {
    console.log("[circa] No odds available — writing pending card.");
    const pending = pendingPayload({ weekNum, week });
    if (dryRun) return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, pending: true, picksData: pending }) };
    const stored = await storeCard(week, pending, force, scheduled, now);
    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true, stored }) };
  }

  const allSides = [];
  for (const g of oddsGames) {
    const espnGame = findESPNGame(espnGames, g.home_team, g.away_team);
    if (!espnGame) continue;
    if (espnGame.state && espnGame.state !== "pre") {
      console.log(`[circa] skip started/final ${g.away_team} @ ${g.home_team} (${espnGame.state})`);
      continue;
    }
    if (gameAlreadyStarted(g.commence_time, now)) continue;
    const posted = buildPostedSpread(g);
    if (!posted) {
      console.log(`[circa] ${g.away_team} @ ${g.home_team}: no usable spread`);
      continue;
    }
    const sides = computeSpreadSides(posted, espnGame, ratingOverlay, qbAdj);
    for (const s of sides) {
      console.log(`[circa]   ${s.pick} @ ${fmtOdds(s.odds)} (${s.lineSource}) cover ${(s.coverProb * 100).toFixed(1)}%`);
    }
    allSides.push(...sides);
  }

  const selected = selectCircaCard(allSides, { now, weekNum });
  if (!selected.length) {
    console.log("[circa] No remaining unplayed spreads — writing pending card.");
    const pending = pendingPayload({ weekNum, week });
    pending.pendingMessage = `Week ${weekNum} card pending — no unplayed NFL spreads available yet.`;
    pending.noPlays = pending.pendingMessage;
    if (dryRun) return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, pending: true, picksData: pending }) };
    const stored = await storeCard(week, pending, force, scheduled, now);
    return { statusCode: 200, body: JSON.stringify({ ok: true, pending: true, stored, picks: 0 }) };
  }

  const picks = buildFinalPicks(selected, weekNum);
  await narratePicks(picks, weekLabel(weekNum));
  const strategy = strategyForCard(picks, weekNum);
  const picksData = liveCardPayload({ weekNum, week, picks, strategy });

  console.log(`[circa] Card: ${picks.map(p => `${p.pick} ${p.odds} (${p.coverProb})`).join(" | ")}`);
  if (dryRun) {
    console.log("[circa] DRY RUN — nothing stored.");
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, picksData }) };
  }

  const stored = await storeCard(week, picksData, force, scheduled, now);
  console.log(`[circa] Done in ${((Date.now() - started) / 1000).toFixed(1)}s (stored: ${stored})`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, picks: picks.length, stored, week }) };
};

module.exports.buildPostedSpread = buildPostedSpread;
module.exports.computeSpreadSides = computeSpreadSides;
module.exports.buildFinalPicks = buildFinalPicks;
module.exports.nflSpreadCoverProb = nflSpreadCoverProb;
module.exports.shrinkCover = shrinkCover;
module.exports.liveCardPayload = liveCardPayload;
module.exports.MODEL_VERSION = MODEL_VERSION;
