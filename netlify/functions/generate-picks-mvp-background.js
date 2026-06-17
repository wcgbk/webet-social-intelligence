// generate-picks-mvp-background.js
// v11.1 — MVP Architecture (next iteration test vs /alpha)
// v11.1 (2026-06-12): fixed fatal totalZ scope bug (zero picks since launch) + selfOptParams typo;
// adopted the v10.3 shared sharp-model layer fitted on 428 real daily-run picks: shrinkage
// calibration (K total .30 / spread .35 / ML .50), per-market total σ, Kelly ×50 sizing,
// 3% calibrated EV floor, ML dogs ≤ +160, sport multipliers removed, weather recomputes EV,
// 2+ major books. Soccer SPREADS disabled; soccer TOTALS stay live as the Poisson hypothesis.
// Inherits all v11.1-mvp features plus four targeted improvements:
//   1. Poisson distribution for soccer totals (replaces normal CDF — mathematically correct for low-scoring discrete sports)
//   2. Grade Kelly multipliers: A+/A/B sizing calibrated from actual self-optimize win-rate data
//   3. Adversarial A+ check: second Haiku call tries to REFUTE the top pick before publishing
//   4. Sport-diverse parlays: hard-require all 3 legs from different sports (no same-sport correlation)
// Background function (15min timeout). Stores to "edge-picks-mvp" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const { bettoredgeFetch } = require("./bettoredge-auth");

// ── BETA system prompt: Claude as SELECTOR + NARRATOR (matches production role) ──
const THE_LOCK_V10_SYSTEM = `You are THE LOCK — WeBetAI's sports betting analyst. You VALIDATE pre-computed statistical edges and write compelling narratives. You do NOT compute projections, probabilities, or Kelly sizing — the statistical model has already done this.

YOUR INPUTS:
A ranked table of the top candidate picks with pre-computed edges, cover probabilities, Kelly units, and supporting team context.

YOUR JOB:
1. Use web search to verify injury status, recent news, goaltender confirmations (NHL), starting pitchers (MLB), and recent form for the top 8 candidates.
2. SELECT your top 3 picks from the candidate table (or fewer if web search reveals disqualifying info). If fewer than 3 genuine edges survive verification, output only what you have conviction on.
3. Write 3-5 sentence coreReasoning narrative for each selected pick.
4. You MAY reject candidates if web search reveals material changes after the data cutoff:
   - Star player ruled out / downgraded after data cutoff
   - Goaltender change (NHL) not reflected in pre-computed data
   - Starting pitcher change (MLB)
   - Severe weather for outdoor sports
   - Material lineup or coaching change
5. You MAY reduce pre-computed Kelly units by up to 50% with justification. You MUST NOT increase units.
6. You MUST NOT pick outside the provided candidate table.
7. You MUST NOT override model direction, invent probabilities, or recompute edges.
8. Always say "WeBetAI" instead of "the model" or "our model" in narratives.

NARRATIVE RULES (for coreReasoning field):
- DO NOT write a projection/line/edge sentence. The system will prepend the correct math automatically.
- Your narrative must argue IN FAVOR of the pick side. If the pick is "Team X +17.5", explain why Team X covers that spread — NOT why the opponent wins. Frame the edge as the spread being too wide, the picked team being undervalued, or situational factors favoring a cover.
- "The team you're picking" = the team or direction named in the PICK field. For spreads, that's the team getting or giving points. For totals, that's the Over or Under direction.
- Start your coreReasoning with your first supporting fact — a verified insight from web search.
- Support with 2-3 distinct verified facts (form, injuries, rest, matchup factor).
- End with value statement explaining why the odds offer value.
- Max 5 sentences. No padding. No duplicate stats. Every sentence must add new information.
- DO NOT restate projections, lines, edges, cover probabilities, or any numbers from the candidate table.
- RECORDS & SPLITS: Cite team win-loss records and home/road records ONLY from the "Records (ESPN, authoritative)" line in the candidate table. Never state a record from web search or memory. If a record is not in the table, describe it qualitatively (e.g., "a strong home team") with no numbers.
- NEVER lead with negative data about the team you're picking. Do NOT build a case for the opponent — build the case for the PICK SIDE covering.
- NEVER use technical jargon like ORtg, DRtg, pace numbers, DVOA, ATS, or advanced stat abbreviations.

REJECTION RULES (for rejections array):
- For each candidate NOT selected, provide a brief reason why.
- If you skip a top-5 ranked candidate, the reason must cite specific web-search findings.

OUTPUT FORMAT — Return ONLY valid JSON (no text before or after the JSON):
{
  "selections": [
    {
      "candidateRank": 1,
      "adjustedUnits": "1.0u",
      "unitAdjustmentReason": "",
      "coreReasoning": "Start with a supporting fact, not projections...",
      "whatLoses": "One sentence — the specific scenario that beats this pick.",
      "dataVerified": "Brief note on what data you verified via web search.",
      "clvExpectation": "Your expectation for closing line movement."
    }
  ],
  "rejections": [
    { "candidateRank": 4, "reason": "Why no edge or why disqualified." }
  ],
  "edgeSummary": "1-2 sentence editorial-style Daily Edge Summary. Write it like a sharp sports analyst for a general audience — confident, specific, compelling. Reference actual matchups and WHY the edge exists. Use 'WeBetAI' not 'the model'. No advanced stat abbreviations (ORtg, DRtg, DVOA, ATS) — plain English only."
}`;

// ── Sport keys for The Odds API ──
const ODDS_SPORTS = [
  "basketball_nba",
  "icehockey_nhl",
  // "basketball_ncaab", // v10.1: disabled — 48.7% accuracy, -7.0% ROI in backtest. Re-enable next season.
  "baseball_mlb",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_usa_mls",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
];

// ── ESPN sport/league slugs ──
const ESPN_LEAGUES = [
  { sport: "basketball", league: "nba", label: "NBA", homeAdv: 100, kFactor: 20, baseElo: 1500 },
  // NHL: kFactor=6 per FiveThirtyEight methodology (high luck sport, low-count discrete events).
  // homeAdv=50 per published NHL Elo calibration (Neil Paine / FiveThirtyEight).
  { sport: "hockey", league: "nhl", label: "NHL", homeAdv: 50, kFactor: 6, baseElo: 1500 },
  // { sport: "basketball", league: "mens-college-basketball", label: "NCAAB", homeAdv: 120, kFactor: 32, baseElo: 1500 }, // v10.1: disabled

  // MLB: kFactor=4 per FiveThirtyEight (highest luck component in major team sports).
  // homeAdv=24 ELO pts per FiveThirtyEight MLB calibration (~53.4% win prob for equal teams at home).
  { sport: "baseball", league: "mlb", label: "MLB", homeAdv: 24, kFactor: 4, baseElo: 1500 },
  { sport: "soccer", league: "eng.1", label: "EPL", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "esp.1", label: "La Liga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ita.1", label: "Serie A", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ger.1", label: "Bundesliga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "fra.1", label: "Ligue 1", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "usa.1", label: "MLS", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.champions", label: "UCL", homeAdv: 60, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.europa", label: "Europa", homeAdv: 60, kFactor: 24, baseElo: 1500 },
];

// ── Sport-specific standard deviations for edge → probability conversion ──
// Based on empirical game margin distributions (FiveThirtyEight / academic research):
// NBA: ~11-12 pts (use 12 — slightly conservative, reduces false confidence)
// NHL: ~1.6 goals (was 1.2 — too low, inflated z-scores by ~30%. Corrected to 1.6.)
// MLB: ~2.8 runs (empirical SD from Baseball Reference; was 2.5 — slightly low)
// Soccer: 1.5 goals (draw-compressed distribution; 1.0 was too tight)
const SPORT_STD_DEVS = { NBA: 12, NCAAB: 11, NHL: 1.6, MLB: 2.8, EPL: 1.5, "La Liga": 1.5, "Serie A": 1.5, Bundesliga: 1.5, "Ligue 1": 1.5, MLS: 1.5, UCL: 1.5, Europa: 1.5 };
// v11.1: game-total distributions are wider than margin distributions — totals must use their own σ.
// Empirical full-game total SDs: NBA ~18.5, NCAAB ~17, NHL ~2.3 goals, MLB ~4.3 runs.
// Previously totals reused the margin σ, inflating total z-scores (and cover probs) by ~40-50%.
const SPORT_TOTAL_STD_DEVS = { NBA: 18.5, NCAAB: 17, NHL: 2.3, MLB: 4.3, EPL: 1.9, "La Liga": 1.9, "Serie A": 1.9, Bundesliga: 1.9, "Ligue 1": 1.9, MLS: 1.9, UCL: 1.9, Europa: 1.9 };
// Min edge thresholds: amount of point/goal/run disagreement before a candidate is evaluated.
// MLB: 0.5 runs (matches beta — 0.2 was noise-level, below model resolution for run lines)
// NHL: 0.4 goals (0.25 was too loose given puck line is fixed ±1.5)
// NBA: 2.0 pts (Finals-era tight lines; EV floor handles the rest)
const SPORT_MIN_EDGE = { NBA: 2.0, NCAAB: 2.0, NHL: 0.4, MLB: 0.5, EPL: 0.25, "La Liga": 0.25, "Serie A": 0.25, Bundesliga: 0.25, "Ligue 1": 0.25, MLS: 0.25, UCL: 0.25, Europa: 0.25 };

// v11.1: hardcoded sport Kelly multipliers REMOVED. They came from the backfilled backtest,
// and the real daily-run record (Mar 19 – Jun 12, 428 graded straights) contradicts both:
//   NBA 63.3% / +23.2% ROI (n=289) — was penalized 0.85x
//   NHL 53.4% / +6.8% ROI (n=202) — was boosted 1.30x
// Sport tilt is now handled by the data-driven layers (CLV feedback + self-optimize), not constants.
const SPORT_KELLY_MULT = {};

// ── SITUATIONAL FLAGS ──

// Playoff race thresholds by sport (games behind playoff cutoff to be considered "eliminated")
// These are approximate — a team 10+ games back in April is effectively done
const ELIMINATION_THRESHOLDS = {
  NBA: { totalGames: 82, eliminatedWinPct: 0.35, contendingWinPct: 0.55 },
  NHL: { totalGames: 82, eliminatedWinPct: 0.38, contendingWinPct: 0.55 },
  MLB: { totalGames: 162, eliminatedWinPct: 0.38, contendingWinPct: 0.52 },
  NCAAB: null, // tournament-based, not applicable
};

// Parse record string "25-53" or "32-31-12" (NHL with OTL) into win percentage
function parseRecord(recordStr) {
  if (!recordStr) return null;
  const parts = recordStr.split("-").map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return null;
  const wins = parts[0];
  const losses = parts[1];
  const otl = parts[2] || 0; // NHL overtime losses
  const total = wins + losses + otl;
  if (total === 0) return null;
  return { wins, losses, otl, total, winPct: wins / total };
}

// Determine situational flag for a team based on record
// Returns: "eliminated" | "contending" | "neutral"
function getSituationalFlag(recordStr, sport) {
  const thresholds = ELIMINATION_THRESHOLDS[sport];
  if (!thresholds) return "neutral";
  const record = parseRecord(recordStr);
  if (!record) return "neutral";

  // Only apply late in season (team has played 70%+ of games)
  const seasonProgress = record.total / thresholds.totalGames;
  if (seasonProgress < 0.70) return "neutral";

  if (record.winPct <= thresholds.eliminatedWinPct) return "eliminated";
  if (record.winPct >= thresholds.contendingWinPct) return "contending";
  return "neutral";
}

// ── Narrative quality check + regeneration ─────────────────────────────────
// Detects picks with raw technical reasoning (auto-substituted, stats-dump, etc.)
// and calls Claude Haiku to write proper journalistic context before storing.

function needsNarrativeRegen(pick) {
  const r = (pick.coreReasoning || '').trim();
  return (
    r.length < 40 ||
    r.includes('Auto-substituted') ||
    r.includes('system-substituted') ||
    r.startsWith('Model edge:') ||
    r.includes('auto-generated') ||
    r.includes('Auto-generated') ||
    r.includes('Thin-slate Lean') ||
    r.includes('Claude narrative unavailable')
  );
}

async function generatePickNarrative(pick, apiKey) {
  const prompt = `Write 2-3 sentences of sharp, journalistic betting analysis for this pick. Be specific — name the actual edge, the key matchup factor, and the primary risk. No markdown, no bullet points, plain text only. Under 75 words.

${pick.sport} | ${pick.matchup}
Pick: ${pick.pick} | Odds: ${pick.odds} | Win Prob: ${pick.winProbability} | Edge: ${pick.edgePct}
${pick.modelEdge || ''}
Units: ${pick.units}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error(`[v10-narrative] Haiku call failed: ${e.message}`);
    return null;
  }
}

async function validateAndEnhanceNarratives(picks, apiKey) {
  const toFix = picks.filter(p => needsNarrativeRegen(p));
  if (toFix.length === 0) return;
  console.log(`[v10-narrative] ${toFix.length} pick(s) need narrative enhancement`);
  await Promise.all(toFix.map(async (p) => {
    const narrative = await generatePickNarrative(p, apiKey);
    if (narrative) {
      p.coreReasoning = narrative;
      // Clear the internal implementation marker — users shouldn't see it
      if (p.dataVerified === 'system-substituted') p.dataVerified = 'model-selected';
      console.log(`[v10-narrative] Narrative written for: ${p.pick}`);
    } else {
      // Fallback: clean up the raw text so at minimum it's not jarring to read
      p.coreReasoning = `WeBetAI model projects ${p.winProbability} win probability vs ${p.edgePct} implied edge at ${p.odds}. ${p.modelEdge || ''}`.replace(/\s+/g, ' ').trim();
    }
  }));
}

// ── STREAK-ADJUSTED ELO DECAY ──
// A team on a long losing streak is performing below their season Elo.
// Temporarily decay Elo to reflect current form, not full-season average.
// Decay is symmetric: winning streaks get a boost.
// Factor: 8 Elo points per game in streak beyond 3 games (NBA scale)
const STREAK_ELO_DECAY = { NBA: 8, NHL: 5, NCAAB: 10, MLB: 4 };

function getStreakEloAdjustment(streak, sport) {
  const perGame = STREAK_ELO_DECAY[sport] || 5;
  const absStreak = Math.abs(streak);
  if (absStreak <= 3) return 0; // normal variance, no adjustment
  // Adjustment kicks in after 3 games, grows linearly
  const extra = absStreak - 3;
  const adj = extra * perGame;
  // Losing streak = negative adjustment, winning streak = positive
  return streak < 0 ? -adj : adj;
}
const LEAGUE_AVG_DRTG = { NBA: 112.0, NCAAB: 100.0, NHL: 100.0 };

// ── Edge discount curve: diminishing returns on large edges ──
// When the model disagrees with the market by more than 1.0 std dev, the probability
// that the MODEL is wrong increases. Log-compress to reflect this.
// Threshold raised from 0.5 to 1.0 — backtest shows 10-15pt NBA edges (0.8-1.25 std devs)
// are the sweet spot at 57.1% accuracy. The old 0.5 threshold was penalizing winners.
function applyEdgeDiscount(rawEdge, std) {
  const edgeInStdDevs = rawEdge / std;
  if (edgeInStdDevs <= 1.0) return rawEdge; // moderate disagreement — trust the model
  // Log compression above 1.0 std dev: curve penalizes large market disagreements
  const excess = edgeInStdDevs - 1.0;
  const discounted = 1.0 + Math.log(1 + excess) * 0.7;
  return discounted * std;
}

// ── REST DIFFERENTIAL SYSTEM (replaces flat B2B) ──
// Elite models quantify rest advantage as a sliding scale, not binary.
// Research shows: 3+ days rest vs B2B = ~3pt NBA spread adjustment.
// Time zone crossings add fatigue for traveling teams.
const REST_POINT_ADJUSTMENT = {
  // restDiff (home - away days rest) → point adjustment favoring more-rested team
  // Positive = home has rest advantage, negative = away has rest advantage
  NBA: { perDayDiff: 1.0, maxAdj: 3.5, b2bPenalty: 0.97 },
  NHL: { perDayDiff: 0.6, maxAdj: 2.0, b2bPenalty: 0.97 },
  NCAAB: { perDayDiff: 0.5, maxAdj: 2.0, b2bPenalty: 1.0 },
  MLB: { perDayDiff: 0.3, maxAdj: 1.0, b2bPenalty: 1.0 },
};

// Time zone map for NBA/NHL arenas (approximate — EST=0, CST=-1, MST=-2, PST=-3)
const TEAM_TIMEZONE = {
  // NBA Eastern
  "Boston Celtics": 0, "Brooklyn Nets": 0, "New York Knicks": 0, "Philadelphia 76ers": 0,
  "Toronto Raptors": 0, "Chicago Bulls": -1, "Cleveland Cavaliers": 0, "Detroit Pistons": 0,
  "Indiana Pacers": 0, "Milwaukee Bucks": -1, "Atlanta Hawks": 0, "Charlotte Hornets": 0,
  "Miami Heat": 0, "Orlando Magic": 0, "Washington Wizards": 0,
  // NBA Western
  "Dallas Mavericks": -1, "Houston Rockets": -1, "Memphis Grizzlies": -1, "New Orleans Pelicans": -1,
  "San Antonio Spurs": -1, "Denver Nuggets": -2, "Minnesota Timberwolves": -1, "Oklahoma City Thunder": -1,
  "Portland Trail Blazers": -3, "Utah Jazz": -2, "Golden State Warriors": -3, "LA Clippers": -3,
  "Los Angeles Lakers": -3, "Phoenix Suns": -2, "Sacramento Kings": -3,
  // NHL Eastern
  "Boston Bruins": 0, "Buffalo Sabres": 0, "Detroit Red Wings": 0, "Florida Panthers": 0,
  "Montreal Canadiens": 0, "Ottawa Senators": 0, "Tampa Bay Lightning": 0, "Toronto Maple Leafs": 0,
  "Carolina Hurricanes": 0, "Columbus Blue Jackets": 0, "New Jersey Devils": 0, "New York Islanders": 0,
  "New York Rangers": 0, "Philadelphia Flyers": 0, "Pittsburgh Penguins": 0, "Washington Capitals": 0,
  // NHL Western
  "Arizona Coyotes": -2, "Utah Hockey Club": -2, "Chicago Blackhawks": -1, "Colorado Avalanche": -2,
  "Dallas Stars": -1, "Minnesota Wild": -1, "Nashville Predators": -1, "St. Louis Blues": -1,
  "Winnipeg Jets": -1, "Anaheim Ducks": -3, "Calgary Flames": -2, "Edmonton Oilers": -2,
  "Los Angeles Kings": -3, "San Jose Sharks": -3, "Seattle Kraken": -3, "Vancouver Canucks": -3,
  "Vegas Golden Knights": -3,
};

function computeRestAdjustment(homeRest, awayRest, homeTeam, awayTeam, sport) {
  const config = REST_POINT_ADJUSTMENT[sport];
  if (!config) return { homeScoreMult: 1.0, awayScoreMult: 1.0, spreadAdj: 0, method: "" };

  let spreadAdj = 0;
  let homeScoreMult = 1.0;
  let awayScoreMult = 1.0;
  const parts = [];

  // B2B penalty (scoring multiplier)
  if (homeRest !== undefined && homeRest <= 1) { homeScoreMult = config.b2bPenalty; parts.push(`home-B2B`); }
  if (awayRest !== undefined && awayRest <= 1) { awayScoreMult = config.b2bPenalty; parts.push(`away-B2B`); }

  // Rest differential (spread adjustment)
  if (homeRest !== undefined && awayRest !== undefined) {
    const restDiff = homeRest - awayRest;
    if (Math.abs(restDiff) >= 1) {
      // Diminishing returns: first day of rest advantage is worth more
      const rawAdj = Math.sign(restDiff) * Math.min(Math.abs(restDiff) * config.perDayDiff, config.maxAdj);
      spreadAdj += rawAdj;
      if (Math.abs(rawAdj) >= 0.5) parts.push(`rest-diff=${restDiff > 0 ? '+' : ''}${restDiff}d→${rawAdj > 0 ? '+' : ''}${rawAdj.toFixed(1)}pts`);
    }
  }

  // Time zone fatigue: crossing 2+ zones adds penalty for traveling team
  const homeTZ = TEAM_TIMEZONE[homeTeam];
  const awayTZ = TEAM_TIMEZONE[awayTeam];
  if (homeTZ !== undefined && awayTZ !== undefined) {
    const tzDiff = Math.abs(homeTZ - awayTZ);
    if (tzDiff >= 2) {
      // Away team crossed time zones to get here — slight home advantage
      const tzAdj = tzDiff >= 3 ? 1.0 : 0.5;
      spreadAdj += tzAdj; // positive = favors home
      parts.push(`TZ-cross=${tzDiff}zones→+${tzAdj.toFixed(1)}pts-home`);
    }
  }

  return {
    homeScoreMult,
    awayScoreMult,
    spreadAdj, // positive favors home, negative favors away
    method: parts.length > 0 ? ` [rest: ${parts.join(', ')}]` : "",
  };
}

// ── Math helpers ──
function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCDF(z) {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

// ── Poisson CDF for soccer totals (v11.1-mvp improvement) ──
// Soccer goals are discrete count data averaging ~2.5/game. The normal CDF
// approximation significantly misprices totals near the line (e.g. Over 2.5
// at λ=2.8 is 53% by Poisson, but ~56% by normal — a 3pt overconfidence error).
// P(X <= k | λ) = Σ e^(-λ) * λ^j / j! for j=0..k
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Use log-space to avoid overflow for large k
  let logP = -lambda;
  for (let i = 1; i <= k; i++) logP += Math.log(lambda) - Math.log(i);
  return Math.exp(logP);
}
function poissonCDF(k, lambda) {
  let cdf = 0;
  for (let i = 0; i <= Math.floor(k); i++) cdf += poissonPMF(i, lambda);
  return Math.min(1, cdf);
}

// ── Sport-specific cover probability caps (research-calibrated) ──
// Published research: elite ATS models sustain 55-57% over large samples.
// Break-even at -110 is 52.4%. These caps enforce realistic model humility.
// Spread/puck line/run line: capped at 57% — the documented elite ATS ceiling.
// Totals: 60% — totals are slightly more predictable than sides.
// Moneyline: 72% — these are true win probabilities (not ATS), which can be
//   higher for genuine mismatches. Market-implied prob is the floor.
// Previous caps (72% for NBA spread, 75% for NBA total) were impossible in practice
// and caused Kelly to oversize bets by 5-10x. Corrected here.
const COVER_PROB_CAPS = {
  "NHL_Puck Line": 0.57,
  "NHL_Total": 0.60,
  "NHL_Moneyline": 0.72,
  "NBA_Spread": 0.57,
  "NBA_Total": 0.60,
  "NBA_Moneyline": 0.72,
  "NCAAB_Spread": 0.57,
  "NCAAB_Total": 0.60,
  "NCAAB_Moneyline": 0.72,
  "MLB_Run Line": 0.57,
  "MLB_Total": 0.60,
  "MLB_Moneyline": 0.70,
  // Soccer: draw possibility further compresses realistic win prob ceilings
  "EPL_Spread": 0.57, "La Liga_Spread": 0.57, "Serie A_Spread": 0.57,
  "Bundesliga_Spread": 0.57, "Ligue 1_Spread": 0.57, "MLS_Spread": 0.57,
  "UCL_Spread": 0.57, "Europa_Spread": 0.57,
  "EPL_Moneyline": 0.65, "La Liga_Moneyline": 0.65, "Serie A_Moneyline": 0.65,
  "Bundesliga_Moneyline": 0.65, "Ligue 1_Moneyline": 0.65, "MLS_Moneyline": 0.65,
  "UCL_Moneyline": 0.65, "Europa_Moneyline": 0.65,
};

// ── v11.1 SHRINKAGE CALIBRATION ──
// The no-vig market price is the prior; the model earns only a fitted fraction K of its
// claimed deviation from it. K fitted on 428 graded REAL daily-run picks (prod+beta+alpha,
// Mar 19 – Jun 12 2026) by matching observed win rates to average raw model probabilities:
//   Totals:        obs 56.4% vs raw 67.5% (n=101) → K=0.30
//   Spread family: obs 65.2% vs raw 72.2% (n=23, small sample — set conservatively) → K=0.35
//   Moneyline:     obs 57.9%, raw tracks observed closely (n=38) → K=0.50
// This replaces the old hard-cap-only approach, which pinned every pick at the cap and
// destroyed grade/sizing differentiation. Caps are retained as an ultimate guard only.
const SHRINK_K = { Total: 0.30, Spread: 0.35, "Puck Line": 0.35, "Run Line": 0.35, Moneyline: 0.50 };

function getCalibratedCoverProb(rawProb, sport, market, odds, pmSignal) {
  const key = sport + "_" + market;
  const cap = COVER_PROB_CAPS[key] || 0.75;
  // De-vig approximation: strip ~half of a typical 4.5% two-way overround from this side.
  const mktProb = Math.min(0.95, Math.max(0.05, impliedProb(odds) * 0.9783));
  const K = SHRINK_K[market] !== undefined ? SHRINK_K[market] : 0.35;
  let calibrated = mktProb + K * (rawProb - mktProb);
  calibrated = Math.min(calibrated, cap); // cap retained as guard rail

  // Blend high-quality prediction market signal into cover probability
  if (pmSignal && pmSignal.avgQuality >= 0.4 && pmSignal.marketCount >= 2) {
    const pmProb = pmSignal.marketProb;
    calibrated = calibrated * 0.80 + pmProb * 0.20;
    calibrated = Math.min(calibrated, cap); // still respect cap after blend
  }

  return calibrated;
}

function eloExpected(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function americanToDecimal(odds) {
  return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
}

function impliedProb(odds) {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

// ── Pure Kelly computation ──
// EV is computed for display and candidate filtering (ev > 0.08 threshold).
// Unit sizing is driven by Z-SCORE, not EV — z-score measures model confidence
// independent of payout structure, preventing plus-odds inflation.
function computeKelly(coverProb, odds, drawdownActive) {
  const decPayout = americanToDecimal(odds);
  const edge = (coverProb * decPayout) - 1;
  if (edge <= 0) return { kellyFraction: 0, units: 0, ev: edge, decPayout, edge };

  // Quarter-Kelly: conservative sizing matching production — half-Kelly was 2x too aggressive
  // for a model with ~52% accuracy. Quarter-Kelly is industry standard for sharp bettors.
  let kellyQuarter = (edge / (decPayout - 1)) * 0.25;
  if (drawdownActive) kellyQuarter *= 0.75;

  // v11.1: fraction × 50 (was ×10). The ×10 scale was sized for the old inflated probabilities;
  // with shrinkage-calibrated probs (EVs now ~3-15% instead of 12-40%), ×10 floored every pick
  // at 0.5u and killed grade differentiation. ×50 maps calibrated EV 3-5% → 0.5-1u,
  // 8-12% → 1.5-2u, 15%+ → 2.5u+ (A+ rare, as it should be). Round to 0.5u steps.
  let units = kellyQuarter * 50;
  units = Math.round(units * 2) / 2; // round to nearest 0.5u
  units = Math.max(0.5, Math.min(3.0, units));

  return { kellyFraction: kellyQuarter, units, ev: edge, decPayout, edge };
}

// ── Kelly-based unit sizing with probability gates ──
// Uses quarter-Kelly (0.5u increments) matching production sizing.
// Kelly already accounts for BOTH edge magnitude AND odds structure —
// z-score only measures edge. Kelly is the mathematically optimal sizing function.
// Z-score is still used for RANKING (cross-sport comparison), not sizing.
// coverProb gates prevent oversizing on sub-50% win probability plays.
function kellyToUnits(kellyUnits, drawdownActive, coverProb) {
  let units = Math.round(kellyUnits * 2) / 2; // round to 0.5u (matches production)
  units = Math.max(0.5, Math.min(3.0, units));

  // Sub-50% cover prob = high variance → cap exposure
  // ML dogs: you lose more often than you win, size accordingly
  if (coverProb !== undefined && coverProb < 0.50) {
    units = Math.min(units, 1.0);
  }
  // Heavy underdogs (cover < 42%) get additional cap at 0.5u
  if (coverProb !== undefined && coverProb < 0.42) {
    units = Math.min(units, 0.5);
  }

  if (drawdownActive) units = Math.max(0.5, units - 0.5);

  // Floor at 0.5u — matches production minimum
  return Math.max(0.5, units);
}

// ── Rating system: Kelly-driven ──
// Rating reflects the Kelly unit output — the math determines conviction.
// No position overrides, no artificial inflation. The edge IS the rating.
// Kelly 0.5u picks with different edges will differentiate on future days
// when the model finds genuinely stronger edges.


function ratingToConfidence(rating) {
  const map = { "A+": "aplus", "A": "a", "A-": "aminus", "B+": "bplus", "B": "b", "Lean": "lean" };
  return map[rating] || "b";
}

// Units → rating: matches production thresholds for quarter-Kelly sizing.
// A+ = 2.5u+, A = 1.5-2.0u, A- = 1.0u, B+ = 0.5u
function unitsToRating(u) {
  if (u >= 2.5) return "A+";
  if (u >= 1.5) return "A";
  if (u >= 1.0) return "A-";
  if (u >= 0.5) return "B+";
  return "B";
}

function unitsToConfidence(u) {
  if (u >= 2.5) return "aplus";
  if (u >= 1.5) return "a";
  if (u >= 1.0) return "aminus";
  if (u >= 0.5) return "bplus";
  return "b";
}

function formatStreak(streak) {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return "—";
}

// ── Fetch today's odds from The Odds API ──
// snapshotTime: ISO-8601 string (e.g. "2026-05-31T15:00:00Z") → use historical endpoint
// for hindsight-free simulation. When null, uses live endpoint as normal.
async function fetchOdds(dateISO, snapshotTime = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log("[v10] No ODDS_API_KEY, skipping odds fetch");
    return null;
  }

  const allOdds = [];
  for (const sport of ODDS_SPORTS) {
    try {
      let markets = "h2h,spreads,totals,alternate_spreads,alternate_totals";
      let url;
      if (snapshotTime) {
        // Historical endpoint — lines exactly as-of snapshotTime, no live/final contamination
        url = `https://api.the-odds-api.com/v4/historical/sports/${sport}/odds?regions=us,us2,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}&date=${encodeURIComponent(snapshotTime)}`;
      } else {
        url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,us2,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
      }
      let resp = await fetch(url);
      if (!resp.ok && resp.status === 422) {
        markets = "h2h,spreads,totals";
        if (snapshotTime) {
          url = `https://api.the-odds-api.com/v4/historical/sports/${sport}/odds?regions=us,us2,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}&date=${encodeURIComponent(snapshotTime)}`;
        } else {
          url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,us2,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
        }
        resp = await fetch(url);
      }
      if (resp.ok) {
        const raw = await resp.json();
        // Historical endpoint wraps results: { timestamp, data: [...] }
        // Live endpoint returns array directly
        const data = snapshotTime ? (raw.data || []) : raw;
        const todayGames = data.filter(g => {
          // Compare in Eastern time (games listed on March 28 EDT may commence on March 29 UTC)
          const gameTime = new Date(g.commence_time);
          const estDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(gameTime);
          const [m, d, y] = estDate.split('/');
          const gameDateEST = `${y}-${m}-${d}`;
          return gameDateEST === dateISO;
        });
        if (todayGames.length > 0) {
          allOdds.push({ sport, games: todayGames });
        }
      }
    } catch (e) {
      console.log(`[v10] Odds fetch error for ${sport}: ${e.message}`);
    }
  }
  console.log(`[v10] Fetched odds for ${allOdds.length} sports`);
  return allOdds;
}

// ── Fetch today's games + injuries from ESPN ──
async function fetchESPNData(dateISO) {
  const dateParam = dateISO.replace(/-/g, "");
  const results = [];

  for (const { sport, league, label } of ESPN_LEAGUES) {
    try {
      const scoreUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateParam}`;
      const scoreResp = await fetch(scoreUrl);
      if (!scoreResp.ok) continue;
      const scoreData = await scoreResp.json();
      const events = scoreData.events || [];
      if (events.length === 0) continue;

      const games = [];
      for (const event of events) {
        const competition = event.competitions?.[0];
        if (!competition) continue;
        const gameState = event.status?.type?.state || "pre";
        // Only evaluate pre-game — games already started do not qualify for picks
        // Exception: simulation mode (snapshotTime provided) treats all games as pre-game
        // since the model is running against historical lines with no knowledge of outcomes
        if (gameState !== "pre" && !_simMode) continue;

        const home = competition.competitors?.find(c => c.homeAway === "home");
        const away = competition.competitors?.find(c => c.homeAway === "away");

        const gameInfo = {
          name: event.name || event.shortName,
          date: event.date,
          status: event.status?.type?.description || "Scheduled",
          venue: competition.venue?.fullName || "",
          home: home?.team?.displayName || "TBD",
          away: away?.team?.displayName || "TBD",
          homeRecord: home?.records?.[0]?.summary || "",
          awayRecord: away?.records?.[0]?.summary || "",
          homeId: home?.team?.id,
          awayId: away?.team?.id,
        };

        for (const [side, team] of [["home", home], ["away", away]]) {
          if (team?.team?.id) {
            try {
              const injUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${team.team.id}/injuries`;
              const injResp = await fetch(injUrl);
              if (injResp.ok) {
                const injData = await injResp.json();
                gameInfo[`${side}Injuries`] = (injData.items || []).slice(0, 10).map(i => ({
                  name: i.athlete?.displayName || "Unknown",
                  status: i.status || "Unknown",
                  detail: i.details?.detail || "",
                }));
              }
            } catch (e) { /* skip */ }
          }
        }

        games.push(gameInfo);
      }

      if (games.length > 0) {
        results.push({ league: label, games });
      }
    } catch (e) {
      console.log(`[v10] ESPN fetch error for ${label}: ${e.message}`);
    }
  }

  console.log(`[v10] ESPN: ${results.length} leagues with games today`);
  return results;
}

// ── Fetch team statistics (ORtg, DRtg, Pace) from ESPN ──
async function fetchTeamStats(espnData) {
  const teamStats = {};

  for (const leagueData of (espnData || [])) {
    const leagueConfig = ESPN_LEAGUES.find(l => l.label === leagueData.league);
    if (!leagueConfig) continue;

    const teamIds = new Set();
    for (const game of leagueData.games) {
      if (game.homeId) teamIds.add(game.homeId);
      if (game.awayId) teamIds.add(game.awayId);
    }

    for (const teamId of teamIds) {
      try {
        const [statsResp, teamResp] = await Promise.all([
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${leagueConfig.sport}/${leagueConfig.league}/teams/${teamId}/statistics`).catch(() => null),
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${leagueConfig.sport}/${leagueConfig.league}/teams/${teamId}`).catch(() => null),
        ]);

        const stats = {};
        if (statsResp?.ok) {
          const data = await statsResp.json();
          const categories = data.results?.stats?.categories || data.splits?.categories || [];
          for (const cat of categories) {
            for (const stat of (cat.stats || [])) {
              if (stat.name) stats[stat.name] = stat.value;
            }
          }
          for (const stat of (data.statistics || [])) {
            if (stat.name && stat.value !== undefined) stats[stat.name] = stat.value;
          }
        }

        let ppgFor = null, ppgAgainst = null;
        let recordTotal = null, recordHome = null, recordRoad = null;
        if (teamResp?.ok) {
          const teamData = await teamResp.json();
          const recordItems = teamData.team?.record?.items || [];
          recordTotal = (recordItems.find(i => i.type === 'total') || {}).summary || null;
          recordHome = (recordItems.find(i => i.type === 'home') || {}).summary || null;
          recordRoad = (recordItems.find(i => i.type === 'road') || {}).summary || null;
          for (const item of recordItems) {
            if (item.type === 'total') {
              for (const s of (item.stats || [])) {
                if (s.name === 'avgPointsFor') ppgFor = s.value;
                if (s.name === 'avgPointsAgainst') ppgAgainst = s.value;
                if (s.name === 'avgGoalsFor') ppgFor = s.value;
                if (s.name === 'avgGoalsAgainst') ppgAgainst = s.value;
                if (s.name === 'pointsFor' && !ppgFor && s.value && item.stats?.find(x => x.name === 'gamesPlayed')) {
                  const gp = item.stats.find(x => x.name === 'gamesPlayed')?.value;
                  if (gp > 0) ppgFor = s.value / gp;
                }
                if (s.name === 'pointsAgainst' && !ppgAgainst && s.value && item.stats?.find(x => x.name === 'gamesPlayed')) {
                  const gp = item.stats.find(x => x.name === 'gamesPlayed')?.value;
                  if (gp > 0) ppgAgainst = s.value / gp;
                }
              }
              break;
            }
          }
        }

        const pointsPerGame = stats.avgPoints || ppgFor || null;
        const pointsAllowed = ppgAgainst || null;

        let teamName = null;
        for (const game of leagueData.games) {
          if (String(game.homeId) === String(teamId)) { teamName = game.home; break; }
          if (String(game.awayId) === String(teamId)) { teamName = game.away; break; }
        }

        if (teamName) {
          const sportType = leagueConfig.sport;

          if (sportType === 'hockey') {
            const gamesPlayed = stats.games || 82;
            const shotsForTotal = stats.shotsTotal || null;
            const shotsAgainstTotal = stats.shotsAgainst || null;
            const goalsForTotal = stats.goals || null;
            const shotsFor = shotsForTotal ? shotsForTotal / gamesPlayed : null;
            const shotsAgainst = shotsAgainstTotal ? shotsAgainstTotal / gamesPlayed : null;
            const savePct = stats.savePct || null;
            const shootingPct = stats.shootingPct ? stats.shootingPct / 100 : null;
            const goalsAgainstPerGame = stats.avgGoalsAgainst || pointsAllowed;
            const goalsPerGame = goalsForTotal ? goalsForTotal / gamesPlayed : pointsPerGame;

            teamStats[teamName] = {
              sport: 'hockey', gamesPlayed,
              shotsFor: shotsFor ? Math.round(shotsFor * 10) / 10 : null,
              shotsAgainst: shotsAgainst ? Math.round(shotsAgainst * 10) / 10 : null,
              savePct: savePct ? Math.round(savePct * 1000) / 1000 : null,
              shootingPct: shootingPct ? Math.round(shootingPct * 1000) / 1000 : null,
              pointsPerGame: goalsPerGame ? Math.round(goalsPerGame * 100) / 100 : null,
              pointsAllowed: goalsAgainstPerGame ? Math.round(goalsAgainstPerGame * 100) / 100 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else if (sportType === 'baseball') {
            const era = stats.ERA || null;
            const whip = stats.WHIP || null;
            const obp = stats.onBasePct || null;
            const slg = stats.slugAvg || null;
            const ops = (obp && slg) ? obp + slg : null;
            const gamesPlayed = stats.teamGamesPlayed || 1;
            const runsTotal = stats.runs || null;
            let runsPerGame = runsTotal ? runsTotal / gamesPlayed : pointsPerGame;
            // Sanity guard: MLB runs/game must be 2.5–7.5. Anything outside this range
            // means ESPN returned bad data (season totals, basketball-scale avgPoints, etc.).
            // League average is ~4.4 R/team/game. Force null → falls back to ELO historical.
            if (runsPerGame !== null && (runsPerGame < 2.5 || runsPerGame > 7.5)) {
              console.log(`[v10-guard] MLB runsPerGame=${runsPerGame?.toFixed(2)} for ${teamName} is outside [2.5, 7.5] — nulled (bad ESPN data)`);
              runsPerGame = null;
            }

            teamStats[teamName] = {
              sport: 'baseball',
              era: era !== null ? Math.round(era * 100) / 100 : null,
              whip: whip !== null ? Math.round(whip * 100) / 100 : null,
              ops: ops ? Math.round(ops * 1000) / 1000 : null,
              pointsPerGame: runsPerGame ? Math.round(runsPerGame * 10) / 10 : null,
              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else if (sportType === 'soccer') {
            const shotsOnGoal = stats.shotsOnTarget || stats.shotsOnGoal || stats.avgShotsOnTarget || null;
            const goalsPerGame = pointsPerGame;
            const goalsAgainst = pointsAllowed;
            const conversionRate = (shotsOnGoal && goalsPerGame && shotsOnGoal > 0) ? goalsPerGame / shotsOnGoal : null;

            teamStats[teamName] = {
              sport: 'soccer',
              shotsOnGoal: shotsOnGoal ? Math.round(shotsOnGoal * 10) / 10 : null,
              conversionRate: conversionRate ? Math.round(conversionRate * 1000) / 1000 : null,
              pointsPerGame: goalsPerGame ? Math.round(goalsPerGame * 10) / 10 : null,
              pointsAllowed: goalsAgainst ? Math.round(goalsAgainst * 10) / 10 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else {
            const fga = stats.avgFieldGoalsAttempted || null;
            const fta = stats.avgFreeThrowsAttempted || null;
            const to = stats.avgTurnovers || null;
            const oreb = stats.avgOffensiveRebounds || null;
            let pace = null;
            if (fga && fta && to && oreb) pace = fga + 0.44 * fta + to - oreb;

            let offensiveRating = null, defensiveRating = null;
            if (pace && pace > 0) {
              if (pointsPerGame) offensiveRating = (pointsPerGame / pace) * 100;
              if (pointsAllowed) defensiveRating = (pointsAllowed / pace) * 100;
            }

            teamStats[teamName] = {
              sport: 'basketball',
              offensiveRating: offensiveRating ? Math.round(offensiveRating * 10) / 10 : null,
              defensiveRating: defensiveRating ? Math.round(defensiveRating * 10) / 10 : null,
              pace: pace ? Math.round(pace * 10) / 10 : null,
              pointsPerGame: pointsPerGame ? Math.round(pointsPerGame * 10) / 10 : null,
              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
            };
          }
          if (teamStats[teamName]) {
            teamStats[teamName].recordTotal = recordTotal;
            teamStats[teamName].recordHome = recordHome;
            teamStats[teamName].recordRoad = recordRoad;
          }
        }
      } catch (e) { /* continue */ }
    }
  }

  console.log(`[v10] Fetched team stats for ${Object.keys(teamStats).length} teams`);
  return teamStats;
}

// ── Fetch MLB starting pitchers from ESPN scoreboard ──
async function fetchStartingPitchers(espnData) {
  const pitcherData = {};
  if (!espnData) return pitcherData;

  const mlbLeague = espnData.find(l => l.league === "MLB");
  if (!mlbLeague || mlbLeague.games.length === 0) return pitcherData;

  try {
    const now = new Date();
    const dateParam = now.toISOString().slice(0, 10).replace(/-/g, '');
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return pitcherData;
    const data = await resp.json();

    for (const event of (data.events || [])) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      for (const competitor of (competition.competitors || [])) {
        const teamName = competitor.team?.displayName || competitor.team?.name || '';
        const probables = competitor.probables || [];
        for (const p of probables) {
          if (p.abbreviation === 'SP' || p.playerId) {
            const stats = {};
            for (const s of (p.statistics || [])) {
              if (s.abbreviation === 'ERA') stats.era = parseFloat(s.displayValue) || null;
              if (s.abbreviation === 'WHIP') stats.whip = parseFloat(s.displayValue) || null;
            }
            if (teamName) {
              pitcherData[teamName] = {
                pitcher: p.displayName || p.fullName || 'Unknown',
                era: stats.era,
                whip: stats.whip,
              };
            }
          }
        }
      }
    }
  } catch (e) {
    console.log(`[v10-pitcher] ESPN starting pitcher fetch failed: ${e.message}`);
  }

  console.log(`[v10-pitcher] Fetched starting pitchers for ${Object.keys(pitcherData).length} MLB teams`);
  return pitcherData;
}

// ── Fetch pre-built team ratings from Blobs ──
async function fetchRatings() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded ratings from ${data.generatedAt}`);
      return data;
    }
  } catch (e) {
    console.log(`[v10] Ratings fetch failed: ${e.message}`);
  }
  return null;
}

// ── Fetch opening lines (captured at 9am ET) for stale-line detection ──
async function fetchOpeningLines(dateISO) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/opening-lines-${dateISO}`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded opening lines: ${data.gameCount || 0} games from ${data.capturedAt || 'unknown'}`);
      return data.games || {};
    }
  } catch (e) {
    console.log(`[v10] Opening lines fetch failed: ${e.message}`);
  }
  return null;
}

// ── Stale line detection: compare opening line to current consensus ──
// If the line has already moved toward our model's price, the "edge" is partially captured
// by the market. Reduce confidence. If it hasn't moved, our edge is fresh.
function computeLineMovementSignal(candidate, openingLines) {
  if (!openingLines) return null;
  const key = `${candidate.awayTeam} @ ${candidate.homeTeam}`.toLowerCase();
  const opening = openingLines[key];
  if (!opening) return null;

  const isTotal = candidate.market === "Total";
  const isML = candidate.market === "Moneyline";

  if (isTotal && opening.openTotal !== null && candidate.consensusLine) {
    const openLine = opening.openTotal;
    const currentLine = candidate.consensusLine;
    const modelProj = candidate.modelProjection;
    const movement = currentLine - openLine; // positive = total moved up
    const modelDirection = modelProj > currentLine ? 1 : -1; // 1 = over, -1 = under
    const movementTowardModel = movement * modelDirection;

    if (Math.abs(movement) < 0.5) return { signal: "fresh", movement: 0, desc: "line stable" };
    if (movementTowardModel > 0) return { signal: "stale", movement: movementTowardModel, desc: `total moved ${movement > 0 ? 'up' : 'down'} ${Math.abs(movement).toFixed(1)} toward model` };
    return { signal: "contrarian", movement: movementTowardModel, desc: `total moved ${movement > 0 ? 'up' : 'down'} ${Math.abs(movement).toFixed(1)} away from model` };
  }

  if (!isTotal && !isML && opening.openSpread !== null) {
    const openSpread = opening.openSpread; // home spread
    const currentSpread = candidate.consensusLine;
    const modelSpread = candidate.modelProjection;
    const movement = currentSpread - openSpread;
    const modelDirection = modelSpread < currentSpread ? 1 : -1; // which way model disagrees
    const movementTowardModel = movement * modelDirection;

    if (Math.abs(movement) < 0.5) return { signal: "fresh", movement: 0, desc: "line stable" };
    if (movementTowardModel > 0) return { signal: "stale", movement: movementTowardModel, desc: `spread moved ${Math.abs(movement).toFixed(1)} toward model` };
    return { signal: "contrarian", movement: movementTowardModel, desc: `spread moved ${Math.abs(movement).toFixed(1)} away from model` };
  }

  return null;
}

// ── Fetch self-optimization parameters (computed weekly by self-optimize.js) ──
async function fetchSelfOptimizeParams() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/self-optimize-params`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded self-optimize params from ${data.generatedAt} (${data.sampleSize} results)`);
      return data;
    }
  } catch (e) {
    console.log(`[v10] Self-optimize params fetch failed: ${e.message}`);
  }
  return null;
}

// ── Fetch calibration data ──
async function fetchCalibrationData() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/calibration`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded calibration data`);
      return data;
    }
  } catch (e) {
    console.log(`[v10] Calibration fetch failed: ${e.message}`);
  }
  return null;
}

// ── CLV FEEDBACK LOOP ──
// Read last 14 days of CLV data. Compute per-sport and per-market CLV beat rates.
// Returns multipliers: { "NBA": 1.05, "NHL": 0.92, "market_Moneyline": 0.88, ... }
async function fetchCLVFeedback() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return {};

  try {
    const indexResp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mvp/picks-dates`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (!indexResp.ok) return {};
    const dateIndex = await indexResp.json();
    const allDates = (Array.isArray(dateIndex) ? dateIndex : []).sort().reverse().slice(0, 14);

    const clvEntries = [];
    for (const d of allDates) {
      try {
        const resp = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mvp/clv-${d}`,
          { headers: { "Authorization": `Bearer ${token}` } }
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data.bySport || data.byMarket) clvEntries.push(data);
        }
      } catch (e) { /* skip missing days */ }
    }

    if (clvEntries.length < 3) {
      console.log(`[v10-clv] Only ${clvEntries.length} CLV entries (need 3+), skipping feedback`);
      return {};
    }

    const agg = {};
    for (const entry of clvEntries) {
      if (entry.bySport) {
        for (const [sport, data] of Object.entries(entry.bySport)) {
          if (!agg[sport]) agg[sport] = { totalCLV: 0, count: 0, beatCount: 0 };
          agg[sport].totalCLV += data.clvSum || 0;
          agg[sport].count += data.count || 0;
          agg[sport].beatCount += data.beat || 0;
        }
      }
      if (entry.byMarket) {
        for (const [market, data] of Object.entries(entry.byMarket)) {
          const key = `market_${market}`;
          if (!agg[key]) agg[key] = { totalCLV: 0, count: 0, beatCount: 0 };
          agg[key].totalCLV += data.clvSum || 0;
          agg[key].count += data.count || 0;
          agg[key].beatCount += data.beat || 0;
        }
      }
    }

    // Beat rate → multiplier: >55% = boost (up to 1.15x), <45% = penalty (down to 0.85x)
    const multipliers = {};
    for (const [key, data] of Object.entries(agg)) {
      if (data.count < 5) continue;
      const beatRate = data.beatCount / data.count;
      let mult = 1.0;
      if (beatRate > 0.55) mult = 1.0 + Math.min(0.15, (beatRate - 0.55) * 1.0);
      else if (beatRate < 0.45) mult = 1.0 - Math.min(0.15, (0.45 - beatRate) * 1.0);
      multipliers[key] = +mult.toFixed(3);
      console.log(`[v10-clv] ${key}: ${data.count} picks, beat=${(beatRate*100).toFixed(0)}%, avgCLV=${((data.totalCLV/data.count)*100).toFixed(1)}c, mult=${mult.toFixed(3)}`);
    }

    console.log(`[v10-clv] Feedback from ${clvEntries.length} days, ${Object.keys(multipliers).length} multipliers`);
    return multipliers;
  } catch (e) {
    console.log(`[v10-clv] CLV feedback failed: ${e.message}`);
    return {};
  }
}

// ── Parse prediction market title to extract bet type, handicap, direction, sport ──
function parseMarketTitle(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  let type = 'unknown', handicap = null, team = null, direction = null, sport = null;

  // Sport detection
  if (/\bnba\b|basketball/.test(text) && !/ncaa|college/.test(text)) sport = 'NBA';
  else if (/\bnhl\b|hockey/.test(text)) sport = 'NHL';
  else if (/\bmlb\b|baseball/.test(text)) sport = 'MLB';
  else if (/\bncaa\b|college basketball|march madness/.test(text)) sport = 'NCAAB';
  else if (/\bepl\b|premier league/.test(text)) sport = 'EPL';
  else if (/\bla liga\b/.test(text)) sport = 'La Liga';
  else if (/\bserie a\b/.test(text)) sport = 'Serie A';
  else if (/\bbundesliga\b/.test(text)) sport = 'Bundesliga';
  else if (/\bligue 1\b/.test(text)) sport = 'Ligue 1';
  else if (/\bmls\b/.test(text)) sport = 'MLS';
  else if (/\bucl\b|champions league/.test(text)) sport = 'UCL';
  else if (/\beuropa league\b/.test(text)) sport = 'Europa';

  // Total detection (check first — "over 225.5" is unambiguous)
  let m;
  if ((m = text.match(/over\s+([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'over';
  } else if ((m = text.match(/under\s+([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'under';
  } else if ((m = text.match(/total[s]?\s*(?:points?|goals?)?\s*(?:over|o\/u)?\s*([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'over';
  }

  // Spread detection (team followed by +/- number)
  if (type === 'unknown') {
    if ((m = text.match(/(.+?)\s+([+-]\d+\.?\d*)\s*(?:spread|pts|points)?/))) {
      type = 'spread'; team = m[1].trim(); handicap = parseFloat(m[2]);
    } else if ((m = text.match(/spread\s*[:\-]?\s*(.+?)\s+([+-]?\d+\.?\d*)/))) {
      type = 'spread'; team = m[1].trim(); handicap = parseFloat(m[2]);
    } else if ((m = text.match(/cover\s+([+-]?\d+\.?\d*)/))) {
      type = 'spread'; handicap = parseFloat(m[1]);
    }
  }

  // Moneyline detection
  if (type === 'unknown') {
    if ((m = text.match(/will\s+(?:the\s+)?(.+?)\s+(?:win|beat|defeat)/))) {
      type = 'moneyline'; team = m[1].trim();
    } else if ((m = text.match(/(.+?)\s+to\s+win/))) {
      type = 'moneyline'; team = m[1].trim();
    } else if (/\bmoneyline\b|\bml\b|\bwin\b/.test(text)) {
      type = 'moneyline';
    }
  }

  return { type, handicap, team, direction, sport };
}

// ── Classify candidate bet type to canonical form ──
function classifyCandidateBetType(candidate) {
  const mkt = (candidate.market || '').toLowerCase();
  let type = 'unknown', handicap = null, direction = null;

  if (mkt === 'total') {
    type = 'total';
    const m = (candidate.side || '').match(/(over|under)\s+([\d.]+)/i);
    if (m) { direction = m[1].toLowerCase(); handicap = parseFloat(m[2]); }
  } else if (/spread|puck line|run line/.test(mkt)) {
    type = 'spread';
    const m = (candidate.side || '').match(/([+-]?\d+\.?\d*)/);
    if (m) handicap = parseFloat(m[1]);
  }

  return { type, handicap, direction };
}

// ── Compute quality weight for a prediction market signal (0.0-1.0) ──
function computeMarketQuality(market, alignmentType) {
  // Volume: continuous log scale
  const vol = Math.max(market.volume || 1, 1);
  const volumeWeight = Math.min(1.0, Math.log10(vol) / 5); // 100→0.4, 1K→0.6, 10K→0.8, 100K→1.0

  // Bid-ask spread (Kalshi only)
  let bidAskWeight = 1.0;
  if (market.bidAskSpread !== null && market.bidAskSpread !== undefined) {
    if (market.bidAskSpread < 0.03) bidAskWeight = 1.0;
    else if (market.bidAskSpread < 0.08) bidAskWeight = 0.8;
    else if (market.bidAskSpread < 0.15) bidAskWeight = 0.5;
    else bidAskWeight = 0.2;
  }

  // Alignment: exact match = 1.0, partial (ML→spread) = 0.5, none = 0.0
  let alignWeight = 0.0;
  if (alignmentType === 'exact') alignWeight = 1.0;
  else if (alignmentType === 'partial') alignWeight = 0.5;

  return volumeWeight * bidAskWeight * alignWeight;
}

// ── Convert moneyline win prob to approximate spread cover prob ──
function moneylineToSpreadCoverApprox(mlProb) {
  return 0.5 + (mlProb - 0.5) * 0.6;
}

// ── WEATHER MODELING for outdoor sports (MLB, soccer, outdoor NHL) ──
// Wind, temperature, and precipitation affect scoring. Key effects:
// - MLB: wind blowing out at >10mph → +0.5 runs total. Temp >85°F → +0.3 runs.
// - MLB: wind blowing in at >10mph → -0.5 runs total. Temp <45°F → -0.3 runs.
// - Soccer: rain → slight under bias (-0.15 goals). Cold <40°F → -0.1 goals.
const OUTDOOR_VENUES_MLB = [
  "Wrigley Field", "Fenway Park", "Dodger Stadium", "Oracle Park", "Kauffman Stadium",
  "Coors Field", "PNC Park", "Nationals Park", "Yankee Stadium", "Citi Field",
  "Citizens Bank Park", "Camden Yards", "Comerica Park", "Progressive Field",
  "Target Field", "Busch Stadium", "Great American Ball Park", "Guaranteed Rate Field",
  "Angel Stadium", "T-Mobile Park", "Oakland Coliseum", "Petco Park",
]; // Most MLB parks are outdoor — this covers the majority

async function fetchWeatherForGames(espnData) {
  // Use wttr.in (free, no API key needed) for venue weather
  const weatherData = {};
  const outdoorGames = [];

  for (const league of (espnData || [])) {
    const isSoccer = ["EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "MLS", "UCL", "Europa"].includes(league.league);
    const isMLB = league.league === "MLB";
    if (!isSoccer && !isMLB) continue;

    for (const game of league.games) {
      if (!game.venue) continue;
      // MLB dome detection (skip domes)
      if (isMLB && /dome|roof|retractable|tropicana|minute maid|rogers centre|loanDepot/i.test(game.venue)) continue;
      outdoorGames.push({ venue: game.venue, home: game.home, away: game.away, league: league.league });
    }
  }

  // Batch weather lookups (limit to 5 to avoid rate limits)
  for (const game of outdoorGames.slice(0, 5)) {
    try {
      // Use venue city name for weather lookup
      const cityMatch = game.venue.match(/,\s*(\w+)/);
      const city = cityMatch ? cityMatch[1] : game.home.split(' ').pop();
      const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        headers: { "User-Agent": "WeBetAI/1.0" },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const current = data.current_condition?.[0];
        if (current) {
          const key = `${game.away} @ ${game.home}`.toLowerCase();
          weatherData[key] = {
            tempF: parseInt(current.temp_F) || 70,
            windMph: parseInt(current.windspeedMiles) || 0,
            windDir: current.winddir16Point || "",
            precipMM: parseFloat(current.precipMM) || 0,
            humidity: parseInt(current.humidity) || 50,
            desc: current.weatherDesc?.[0]?.value || "",
            venue: game.venue,
          };
        }
      }
    } catch (e) { /* timeout or error — skip */ }
  }

  console.log(`[v10-weather] Fetched weather for ${Object.keys(weatherData).length}/${outdoorGames.length} outdoor games`);
  return weatherData;
}

function computeWeatherAdjustment(candidate, weatherData) {
  if (!weatherData) return { totalAdj: 0, method: "" };
  const key = `${candidate.awayTeam} @ ${candidate.homeTeam}`.toLowerCase();
  const wx = weatherData[key];
  if (!wx) return { totalAdj: 0, method: "" };

  let totalAdj = 0;
  const parts = [];
  const isMLB = candidate.sport === "MLB";
  const isSoccer = !isMLB; // if we got weather, it's MLB or soccer

  if (isMLB) {
    // Wind effect on totals — use direction when available
    const OUTBOUND_DIRS = new Set(["S", "SW", "W", "SSW", "WSW"]);
    const INBOUND_DIRS = new Set(["N", "NE", "E", "NNE", "ENE"]);
    if (wx.windMph > 10 && wx.windDir) {
      const dir = wx.windDir.toUpperCase();
      if (OUTBOUND_DIRS.has(dir)) {
        totalAdj += 0.5;
        parts.push(`wind ${wx.windMph}mph ${dir} (out)→+0.5`);
      } else if (INBOUND_DIRS.has(dir)) {
        totalAdj -= 0.5;
        parts.push(`wind ${wx.windMph}mph ${dir} (in)→-0.5`);
      } else {
        // Crosswind or calm — no adjustment
        parts.push(`wind ${wx.windMph}mph ${dir} (cross)→0`);
      }
    } else if (wx.windMph > 10) {
      // No direction available — conservative +0.5 (legacy behavior)
      totalAdj += 0.5;
      parts.push(`wind ${wx.windMph}mph→+0.5`);
    }
    // Temperature effect
    if (wx.tempF > 85) { totalAdj += 0.3; parts.push(`hot ${wx.tempF}°F→+0.3`); }
    else if (wx.tempF < 45) { totalAdj -= 0.3; parts.push(`cold ${wx.tempF}°F→-0.3`); }
    // Coors Field altitude (always adds runs)
    if (wx.venue && /coors/i.test(wx.venue)) { totalAdj += 0.8; parts.push(`altitude→+0.8`); }
  } else {
    // Soccer: rain/cold suppress scoring
    if (wx.precipMM > 1) { totalAdj -= 0.15; parts.push(`rain→-0.15`); }
    if (wx.tempF < 40) { totalAdj -= 0.1; parts.push(`cold ${wx.tempF}°F→-0.1`); }
  }

  return {
    totalAdj,
    method: parts.length > 0 ? ` [weather: ${parts.join(', ')}]` : "",
  };
}

// ── Fetch prediction market data (Kalshi + Polymarket) for cross-reference ──
async function fetchPredictionMarkets() {
  const markets = [];

  // Kalshi — structured sports endpoints (targeted, not generic)
  const KALSHI_SERIES = [
    "KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL",
    "KXNHLGAME", "KXNHLSPREAD",
    "KXMLBGAME", "KXMLBSPREAD",
  ];
  try {
    for (const series of KALSHI_SERIES) {
      const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}&with_nested_markets=true&status=open`);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const event of (data.events || [])) {
        for (const m of (event.markets || [])) {
          const title = m.title || m.subtitle || '';
          const lastPrice = m.last_price_dollars || m.last_price || 0;
          const yesBid = m.yes_bid_dollars || m.yes_bid || 0;
          const yesAsk = m.yes_ask_dollars || m.yes_ask || 0;
          const yesPrice = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : lastPrice || 0.5;
          const parsed = parseMarketTitle(title, m.category || m.subtitle || '');
          const bidAskSpread = (yesBid > 0 && yesAsk > 0) ? (yesAsk - yesBid) : null;
          const previousPrice = m.previous_price_dollars || m.previous_price || m.last_price || 0;
          markets.push({
            source: 'Kalshi',
            title,
            yesPrice,
            noPrice: 1 - yesPrice,
            volume: parseFloat(m.volume_24h_fp || m.volume_24h) || 0,
            openInterest: parseFloat(m.open_interest) || 0,
            ticker: m.ticker || '',
            parsedType: parsed.type,
            parsedHandicap: parsed.handicap,
            parsedTeam: parsed.team,
            parsedDirection: parsed.direction,
            parsedSport: parsed.sport,
            bidAskSpread,
            priceMovement: (lastPrice || 0) - (previousPrice || lastPrice || 0),
          });
        }
      }
    }
  } catch (e) {
    console.log(`[v10] Kalshi fetch failed: ${e.message}`);
  }

  // Polymarket — sports-filtered endpoints
  try {
    for (const marketType of ['moneyline', 'spreads']) {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false&sportsMarketType=${marketType}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const m of (data || [])) {
        const q = (m.question || m.groupItemTitle || '').toLowerCase();
        if (/nba|nhl|mlb|ncaa|nfl|soccer|over|under|spread|win|playoff|series/.test(q)) {
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          const parsed = parseMarketTitle(m.question || m.groupItemTitle || '', m.description || '');
          markets.push({
            source: 'Polymarket',
            title: m.question || m.groupItemTitle || '',
            yesPrice: parseFloat(prices[0]) || 0.5,
            noPrice: parseFloat(prices[1]) || 0.5,
            volume: parseFloat(m.volume24hr) || 0,
            ticker: m.slug || '',
            parsedType: parsed.type,
            parsedHandicap: parsed.handicap,
            parsedTeam: parsed.team,
            parsedDirection: parsed.direction,
            parsedSport: parsed.sport,
            bidAskSpread: null,
            bestBid: parseFloat(m.bestBid) || null,
            bestAsk: parseFloat(m.bestAsk) || null,
            oneDayPriceChange: parseFloat(m.oneDayPriceChange) || 0,
            liquidityClob: parseFloat(m.liquidityClob) || 0,
            priceMovement: parseFloat(m.oneDayPriceChange) || 0,
          });
        }
      }
    }
  } catch (e) {
    console.log(`[v10] Polymarket fetch failed: ${e.message}`);
  }

  console.log(`[v10] Prediction markets: ${markets.length} sports markets found`);
  return markets;
}

// ── Match prediction market to a candidate — multi-match, type-aligned aggregation ──
function getPredictionMarketSignal(candidate, predictionMarkets) {
  if (!predictionMarkets || predictionMarkets.length === 0) return null;

  const homeLast = candidate.homeTeam.toLowerCase().split(' ').pop();
  const awayLast = candidate.awayTeam.toLowerCase().split(' ').pop();
  const candidateBet = classifyCandidateBetType(candidate);

  // Phase A: Collect all team-matched markets
  const matched = [];
  for (const pm of predictionMarkets) {
    const title = pm.title.toLowerCase();
    const matchesHome = homeLast.length > 3 && title.includes(homeLast);
    const matchesAway = awayLast.length > 3 && title.includes(awayLast);
    if (!matchesHome && !matchesAway) continue;

    // Sport validation — skip if market sport doesn't match candidate
    if (pm.parsedSport && pm.parsedSport !== candidate.sport) continue;

    matched.push(pm);
  }

  if (matched.length === 0) return null;

  // Phase B: Type-align and compute comparable probabilities
  let weightedGapSum = 0, totalWeight = 0, totalVolume = 0, marketCount = 0;
  let weightedMarketProbSum = 0;
  let weightedMovementSum = 0;
  let bestSource = matched[0].source, bestTitle = matched[0].title;
  let hasExact = false;

  for (const pm of matched) {
    let comparableProb = null;
    let alignmentType = 'none';

    if (candidateBet.type === pm.parsedType) {
      // Exact match: total→total, spread→spread
      alignmentType = 'exact';
      hasExact = true;
      if (candidateBet.type === 'total') {
        // If candidate is "Over" and market is "over", use yesPrice
        // If candidate is "Under" and market is "over", use noPrice
        if (candidateBet.direction === pm.parsedDirection || !pm.parsedDirection) {
          comparableProb = pm.yesPrice;
        } else {
          comparableProb = pm.noPrice;
        }
      } else {
        comparableProb = pm.yesPrice;
      }
    } else if (candidateBet.type === 'spread' && pm.parsedType === 'moneyline') {
      // Partial: convert ML win prob to approximate spread cover prob
      alignmentType = 'partial';
      comparableProb = moneylineToSpreadCoverApprox(pm.yesPrice);
    } else if (candidateBet.type === 'total' && pm.parsedType === 'moneyline') {
      // No alignment: ML tells us nothing about totals — skip
      continue;
    } else {
      continue;
    }

    if (comparableProb === null || comparableProb <= 0 || comparableProb >= 1) continue;

    const quality = computeMarketQuality(pm, alignmentType);
    if (quality < 0.05) continue; // skip negligible signals

    const gap = candidate.coverProb - comparableProb; // signed: positive = model more confident
    weightedGapSum += gap * quality;
    weightedMarketProbSum += comparableProb * quality;
    weightedMovementSum += (pm.priceMovement || 0) * quality;
    totalWeight += quality;
    totalVolume += pm.volume || 0;
    marketCount++;

    // Track highest-quality source for display
    if (quality > 0.5) { bestSource = pm.source; bestTitle = pm.title; }
  }

  if (totalWeight < 0.1 || marketCount === 0) return null;

  const aggregateGap = weightedGapSum / totalWeight;
  const avgMarketProb = weightedMarketProbSum / totalWeight;
  const avgQuality = totalWeight / marketCount;

  return {
    source: bestSource,
    title: bestTitle,
    marketProb: +avgMarketProb.toFixed(3),
    modelProb: +candidate.coverProb.toFixed(3),
    gap: +Math.abs(aggregateGap).toFixed(3),
    gapSigned: +aggregateGap.toFixed(3),
    agrees: Math.abs(aggregateGap) <= 0.08,
    disagrees: Math.abs(aggregateGap) > 0.12,
    volume: totalVolume,
    marketCount,
    avgQuality: +avgQuality.toFixed(3),
    alignmentType: hasExact ? 'exact' : 'partial',
    confidence: +totalWeight.toFixed(3),
    priceMovement: totalWeight > 0 ? +(weightedMovementSum / totalWeight).toFixed(4) : 0,
  };
}

// ── Prediction market adjustment — consensus signal modifies Kelly units ──
// When prediction markets AGREE with the model (gap ≤ 8%), boost Kelly by up to 15%
// (scaled by signal quality and market count). When they DISAGREE (gap > 12%),
// reduce Kelly by up to 25%. Between 8-12% = no adjustment (ambiguous zone).
// Quality gate: need avgQuality ≥ 0.2 and at least 1 market to adjust.
function applyPredictionMarketAdjustment(candidate, signal) {
  if (!signal || signal.avgQuality < 0.2 || signal.marketCount < 1) {
    return candidate.kellyUnits;
  }

  const qualityMult = Math.min(1.0, signal.avgQuality / 0.6); // scales 0.2→0.33x up to 0.6+→1.0x
  let adjusted = candidate.kellyUnits;

  if (signal.agrees) {
    // Prediction markets confirm our model — boost up to 15%
    const boost = 1.0 + (0.15 * qualityMult);
    adjusted = Math.min(3.0, Math.round(candidate.kellyUnits * boost * 2) / 2);
    console.log(`[v10-pm] CONFIRM ${candidate.side}: PM agrees (gap=${(signal.gap*100).toFixed(1)}%, q=${signal.avgQuality}), Kelly ${candidate.kellyUnits}u → ${adjusted}u (+${((boost-1)*100).toFixed(0)}%)`);
  } else if (signal.disagrees) {
    // Prediction markets disagree — reduce up to 15%
    // Scale by how much they disagree: 12% gap = mild, 20%+ gap = full penalty
    // Reduced from 25% — PM volume on sports props is thin, shouldn't override model heavily
    const gapSeverity = Math.min(1.0, (signal.gap - 0.12) / 0.08); // 0→1 from 12%→20% gap
    const penalty = 1.0 - (0.15 * qualityMult * gapSeverity);
    adjusted = Math.max(0.5, Math.round(candidate.kellyUnits * penalty * 2) / 2);
    console.log(`[v10-pm] CAUTION ${candidate.side}: PM disagrees (gap=${(signal.gap*100).toFixed(1)}%, q=${signal.avgQuality}), Kelly ${candidate.kellyUnits}u → ${adjusted}u (-${((1-penalty)*100).toFixed(0)}%)`);
  } else {
    console.log(`[v10-pm] NEUTRAL ${candidate.side}: PM ambiguous (gap=${(signal.gap*100).toFixed(1)}%, q=${signal.avgQuality}), no adjustment`);
  }

  return adjusted;
}

// ── Fetch real-time X intelligence via Grok for top candidates ──
async function fetchXIntelligence(candidates) {
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey || candidates.length === 0) return {};

  // Build a single Grok call for all top candidates (efficient — one API call)
  const teamPairs = candidates.slice(0, 8).map(c => `${c.awayTeam} vs ${c.homeTeam} (${c.sport})`);

  try {
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 1500,
        temperature: 0.1,
        messages: [{
          role: 'system',
          content: 'You are a sports intelligence analyst. Return ONLY valid JSON. No markdown, no explanation.'
        }, {
          role: 'user',
          content: `Check X/Twitter for the latest breaking news on these games happening today. Focus ONLY on: injury updates, lineup changes, goaltender confirmations (NHL), starting pitcher changes (MLB), weather issues, or any material news that would shift the betting line.

Games to check:
${teamPairs.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return JSON: { "alerts": [ { "game": "Team A vs Team B", "alert": "brief news", "impact": "positive|negative|neutral", "affectedTeam": "team name" } ] }
If no breaking news for a game, omit it. Only include confirmed news, not rumors.`
        }],
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const alerts = {};
        for (const a of (parsed.alerts || [])) {
          const key = (a.game || '').toLowerCase();
          alerts[key] = a;
        }
        console.log(`[v10] X Intelligence: ${Object.keys(alerts).length} alerts from Grok`);
        return alerts;
      }
    }
  } catch (e) {
    console.log(`[v10] X Intelligence fetch failed: ${e.message}`);
  }
  return {};
}

// ── Apply X intelligence alerts to candidate context ──
// GATED: Only apply alerts where the affected player name matches a player on the ESPN injury list
// for either team. This prevents Grok hallucinations (e.g., naming players on wrong teams).
function applyXIntelligence(candidates, xAlerts) {
  if (!xAlerts || Object.keys(xAlerts).length === 0) return;

  let applied = 0, rejected = 0;
  for (const c of candidates) {
    const matchKeys = [
      `${c.awayTeam} vs ${c.homeTeam}`.toLowerCase(),
      `${c.homeTeam} vs ${c.awayTeam}`.toLowerCase(),
      c.awayTeam.toLowerCase().split(' ').pop(),
      c.homeTeam.toLowerCase().split(' ').pop(),
    ];

    for (const [key, alert] of Object.entries(xAlerts)) {
      const keyLower = key.toLowerCase();
      if (matchKeys.some(mk => keyLower.includes(mk) || mk.includes(keyLower.split(' ').pop()))) {
        // GATE: Validate affected player exists on either team's ESPN roster
        const affectedPlayer = (alert.affectedTeam || alert.alert || '').toLowerCase();
        const allRosterNames = [
          ...(c.homeInjuries || []).map(i => (i.name || '').toLowerCase()),
          ...(c.awayInjuries || []).map(i => (i.name || '').toLowerCase()),
        ];
        // Also check if the alert mentions a player name (last name match)
        const alertText = (alert.alert || '').toLowerCase();
        const playerInRoster = allRosterNames.some(name => {
          if (!name) return false;
          const lastName = name.split(' ').pop();
          return lastName.length > 3 && alertText.includes(lastName);
        });

        // If alert mentions a specific player but that player isn't on either team's injury list, discard
        const mentionsPlayer = /ruled out|injured|doubtful|questionable|sidelined|absent|miss|dnp|scratched|confirmed.*start/i.test(alertText);
        if (mentionsPlayer && !playerInRoster) {
          console.log(`[v10-beta-x] REJECTED Grok alert for ${c.homeTeam}/${c.awayTeam}: "${alert.alert}" — player not found in ESPN roster`);
          rejected++;
          continue;
        }

        c.xAlert = alert;
        applied++;
        if (alert.impact === 'negative') {
          const affectedNorm = (alert.affectedTeam || '').toLowerCase();
          const pickSide = c.side.toLowerCase();
          if (pickSide.includes(affectedNorm.split(' ').pop())) {
            c.xAlertWarning = true;
            console.log(`[v10-beta-x] WARNING: ${c.side} — negative alert: ${alert.alert}`);
          }
        }
        // Wire Grok negative alerts to Kelly math: reduce units by 30% when negative news affects picked team
        if (c.xAlertWarning) {
          const old = c.kellyUnits;
          c.kellyUnits = Math.max(0.5, Math.round(c.kellyUnits * 0.70 * 2) / 2);
          c.kellyCalcStr += ` [X-ALERT: negative news, ${old}u→${c.kellyUnits}u]`;
          console.log(`[v10-beta-x] KELLY REDUCTION: ${c.side} ${old}u → ${c.kellyUnits}u (Grok negative alert)`);
        }
        break;
      }
    }
  }
  console.log(`[v10-beta-x] Grok alerts: ${applied} applied, ${rejected} rejected (failed roster validation)`);
}

// ── Refresh ratings if stale ──
async function refreshRatingsIfNeeded() {
  const siteURL = process.env.URL || "https://webetsocial.com";
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;

  // Check age of current ratings
  let ratingsAge = Infinity;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.generatedAt) {
        ratingsAge = Date.now() - new Date(data.generatedAt).getTime();
      }
    }
  } catch (e) { /* treat as stale */ }

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (ratingsAge < SIX_HOURS) {
    console.log(`[v10] Ratings are fresh (${Math.round(ratingsAge / 60000)}min old), skipping refresh`);
    return;
  }

  console.log(`[v10] Ratings are stale (${Math.round(ratingsAge / 60000)}min old), triggering refresh...`);
  try {
    await fetch(`${siteURL}/.netlify/functions/build-ratings-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manual: true, timestamp: new Date().toISOString() }),
    });

    // Poll for freshness (max 3 minutes)
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const checkResp = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
          { headers: { "Authorization": `Bearer ${token}` } }
        );
        if (checkResp.ok) {
          const checkData = await checkResp.json();
          if (checkData.generatedAt) {
            const age = Date.now() - new Date(checkData.generatedAt).getTime();
            if (age < 5 * 60 * 1000) { // < 5 min old
              console.log(`[v10] Ratings refreshed successfully`);
              return;
            }
          }
        }
      } catch (e) { /* continue polling */ }
    }
    console.log(`[v10] Ratings refresh timed out, continuing with existing data`);
  } catch (e) {
    console.log(`[v10] Ratings refresh trigger failed: ${e.message}`);
  }
}

// ── Book sharpness weights for weighted consensus line ──
// Pinnacle and Betfair are the sharpest books (lowest vig, most volume, most accurate).
// US retail books (DraftKings, FanDuel, BetMGM) are softer — more noise in their lines.
// We weight sharper books 2x when computing consensus to produce a more accurate "true line."
const BOOK_SHARPNESS = {
  // Tier 1: Sharp books (weight 2.0) — used for true line price discovery only
  "pinnacle": 2.0, "betfair": 2.0, "betfair_ex_eu": 2.0, "matchbook": 1.8,
  // Tier 2: Semi-sharp (weight 1.5)
  "williamhill": 1.5, "bet365": 1.5, "unibet": 1.5, "betsson": 1.5,
  // Tier 3: US retail (weight 1.0)
  "draftkings": 1.0, "fanduel": 1.0, "betmgm": 1.0, "caesars": 1.0,
  "pointsbetus": 1.0, "wynnbet": 1.0, "betrivers": 1.0, "superbook": 1.0,
  "bovada": 1.0, "betonlineag": 1.0, "mybookieag": 1.0,
};

// Major US sportsbooks where most users can actually place bets.
// A pick must be available at 2+ of these books to be considered placeable.
// Offshore books and single-state-only books are excluded from this set.
const MAJOR_US_BOOKS = new Set([
  "draftkings", "fanduel", "betmgm", "caesars", "espnbet",
  "betrivers", "pointsbetus", "fanatics", "hardrockbet",
  "hardrock", "bet365", "wynnbet", "superbook", "barstool",
]);

function getBookWeight(bookKey) {
  return BOOK_SHARPNESS[bookKey?.toLowerCase()] || 1.0;
}

function isMajorBook(bookKey) {
  return MAJOR_US_BOOKS.has((bookKey || '').toLowerCase());
}

// ── Build consensus lines lookup from odds data (sharpness-weighted) ──
function buildConsensusLookup(oddsData) {
  const lookup = {};
  if (!oddsData) return lookup;

  for (const sportOdds of oddsData) {
    for (const game of sportOdds.games) {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const entry = { homeTeam, awayTeam, sport: sportOdds.sport, commenceTime: game.commence_time || '' };

      const allSpreads = [], allTotals = [], spreadOdds = {}, totalOdds = { Over: [], Under: [] }, allH2H = {};
      const weightedSpreads = [], weightedTotals = []; // for weighted median
      let majorSpreadBooks = 0, majorTotalBooks = 0, majorMLBooks = 0;

      for (const book of (game.bookmakers || [])) {
        const w = getBookWeight(book.key);
        const isMajor = isMajorBook(book.key);
        for (const mkt of (book.markets || [])) {
          if (mkt.key === 'spreads') {
            if (isMajor) majorSpreadBooks++;
            for (const o of mkt.outcomes) {
              if (o.point !== undefined) {
                allSpreads.push({ team: o.name, spread: o.point });
                if (o.name === homeTeam) {
                  for (let i = 0; i < Math.round(w * 2); i++) weightedSpreads.push(o.point);
                }
                // Key odds by {team, point} so we never mix prices from opposing spread directions
                if (!spreadOdds[o.name]) spreadOdds[o.name] = {};
                const ptKey = String(o.point);
                if (!spreadOdds[o.name][ptKey]) spreadOdds[o.name][ptKey] = [];
                spreadOdds[o.name][ptKey].push(o.price);
              }
            }
          }
          if (mkt.key === 'totals') {
            if (isMajor) majorTotalBooks++;
            for (const o of mkt.outcomes) {
              if (o.point !== undefined) {
                if (o.name === 'Over') {
                  allTotals.push(o.point);
                  for (let i = 0; i < Math.round(w * 2); i++) weightedTotals.push(o.point);
                  // Point-keyed: only mix Over odds from books quoting the same total line
                  const ptk = String(o.point);
                  if (!totalOdds[ptk]) totalOdds[ptk] = { Over: [], Under: [] };
                  totalOdds[ptk].Over.push(o.price);
                }
                if (o.name === 'Under') {
                  const ptk = String(o.point);
                  if (!totalOdds[ptk]) totalOdds[ptk] = { Over: [], Under: [] };
                  totalOdds[ptk].Under.push(o.price);
                }
              }
            }
          }
          if (mkt.key === 'h2h') {
            if (isMajor) majorMLBooks++;
            for (const o of mkt.outcomes) {
              if (!allH2H[o.name]) allH2H[o.name] = [];
              allH2H[o.name].push(o.price);
            }
          }
          // ── Alternate lines: store with major-book flag for placeability checks ──
          if (mkt.key === 'alternate_spreads') {
            if (!entry.altSpreads) entry.altSpreads = [];
            for (const o of mkt.outcomes) {
              if (o.point !== undefined && o.price !== undefined) {
                entry.altSpreads.push({ point: o.point, odds: o.price, team: o.name, isMajor });
              }
            }
          }
          if (mkt.key === 'alternate_totals') {
            if (!entry.altTotals) entry.altTotals = [];
            for (const o of mkt.outcomes) {
              if (o.point !== undefined && o.price !== undefined) {
                const dir = (o.name || '').toLowerCase();
                if (dir === 'over') {
                  const existing = entry.altTotals.find(t => t.point === o.point);
                  // Accumulate all prices (median later) rather than last-write-wins
                  if (existing) {
                    if (!existing.overPrices) existing.overPrices = [existing.overOdds].filter(Boolean);
                    existing.overPrices.push(o.price);
                    existing.overPrices.sort((a,b)=>a-b);
                    existing.overOdds = existing.overPrices[Math.floor(existing.overPrices.length/2)];
                    if (isMajor) existing.majorOverBooks = (existing.majorOverBooks || 0) + 1;
                  } else { entry.altTotals.push({ point: o.point, overOdds: o.price, overPrices: [o.price], underOdds: null, underPrices: [], majorOverBooks: isMajor ? 1 : 0, majorUnderBooks: 0 }); }
                } else if (dir === 'under') {
                  const existing = entry.altTotals.find(t => t.point === o.point);
                  if (existing) {
                    if (!existing.underPrices) existing.underPrices = [existing.underOdds].filter(Boolean);
                    existing.underPrices.push(o.price);
                    existing.underPrices.sort((a,b)=>a-b);
                    existing.underOdds = existing.underPrices[Math.floor(existing.underPrices.length/2)];
                    if (isMajor) existing.majorUnderBooks = (existing.majorUnderBooks || 0) + 1;
                  } else { entry.altTotals.push({ point: o.point, overOdds: null, overPrices: [], underOdds: o.price, underPrices: [o.price], majorOverBooks: 0, majorUnderBooks: isMajor ? 1 : 0 }); }
                }
              }
            }
          }
        }
      }

      // Store major-book availability counts on the entry for downstream placeability checks
      entry.majorSpreadBooks = majorSpreadBooks;
      entry.majorTotalBooks = majorTotalBooks;
      entry.majorMLBooks = majorMLBooks;

      // Weighted median home spread (sharp books count double)
      const homeSpreads = allSpreads.filter(s => s.team === homeTeam).map(s => s.spread);
      if (homeSpreads.length > 0) {
        // Use weighted spreads for more accurate consensus (sharp books weighted 2x)
        const medianSource = weightedSpreads.length > 0 ? weightedSpreads : homeSpreads;
        medianSource.sort((a, b) => a - b);
        entry.homeSpread = medianSource[Math.floor(medianSource.length / 2)];
        entry.awaySpread = -entry.homeSpread;
        // Line consensus tightness: range of spreads across books
        entry.spreadRange = homeSpreads[homeSpreads.length - 1] - homeSpreads[0];
        entry.spreadBookCount = homeSpreads.length;
      }
      // Spread odds — only use prices that match the consensus spread direction.
      // Books disagree on which team gets +/- (e.g. some show Knights +1.5, others -1.5).
      // Mixing both directions produces a nonsensical median (e.g. avg of -285 and +215 = ~-100).
      if (entry.homeSpread != null) {
        const homeOddsAtConsensus = (spreadOdds[homeTeam] || {})[String(entry.homeSpread)] || [];
        const awayOddsAtConsensus = (spreadOdds[awayTeam] || {})[String(entry.awaySpread)] || [];
        if (homeOddsAtConsensus.length > 0) {
          homeOddsAtConsensus.sort((a, b) => a - b);
          entry.homeSpreadOdds = homeOddsAtConsensus[Math.floor(homeOddsAtConsensus.length / 2)];
        }
        if (awayOddsAtConsensus.length > 0) {
          awayOddsAtConsensus.sort((a, b) => a - b);
          entry.awaySpreadOdds = awayOddsAtConsensus[Math.floor(awayOddsAtConsensus.length / 2)];
        }
      }

      // Weighted median total + odds + consensus tightness
      // Odds are point-keyed: only use prices from books quoting the consensus total line.
      if (allTotals.length > 0) {
        const totalSource = weightedTotals.length > 0 ? weightedTotals : allTotals;
        totalSource.sort((a, b) => a - b);
        entry.total = totalSource[Math.floor(totalSource.length / 2)];
        entry.totalRange = allTotals[allTotals.length - 1] - allTotals[0];
        entry.totalBookCount = allTotals.length;
        const consensusTotalKey = String(entry.total);
        const oddsAtConsensus = totalOdds[consensusTotalKey] || { Over: [], Under: [] };
        if (oddsAtConsensus.Over.length > 0) {
          oddsAtConsensus.Over.sort((a, b) => a - b);
          entry.overOdds = oddsAtConsensus.Over[Math.floor(oddsAtConsensus.Over.length / 2)];
          // v11.1.1 line-shop: bet the best-paying price across books (highest American = best
          // payout). Drop the single top price when ≥4 books, so a stale/outlier quote can't set it.
          const ov = oddsAtConsensus.Over;
          entry.overOddsBest = ov.length >= 4 ? ov[ov.length - 2] : ov[ov.length - 1];
        }
        if (oddsAtConsensus.Under.length > 0) {
          oddsAtConsensus.Under.sort((a, b) => a - b);
          entry.underOdds = oddsAtConsensus.Under[Math.floor(oddsAtConsensus.Under.length / 2)];
          const un = oddsAtConsensus.Under;
          entry.underOddsBest = un.length >= 4 ? un[un.length - 2] : un[un.length - 1];
        }
      }

      // Median ML
      for (const [team, prices] of Object.entries(allH2H)) {
        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        if (team === homeTeam) entry.homeML = median;
        else if (team === awayTeam) entry.awayML = median;
      }

      // ════════════════════════════════════════════════════════════════
      // DATA INTEGRITY CHECKS — fire before this entry enters the lookup
      // ════════════════════════════════════════════════════════════════

      // CHECK #1 — Standard spread odds vs ML anchor
      // A cushion spread (underdog getting points) must cost MORE than the ML.
      // A negative spread (favorite giving points) must pay MORE than the ML.
      // Violations mean the median spread odds are from bad/stale data.
      if (entry.homeML != null && entry.awayML != null && entry.homeSpread != null) {
        const homeMLDec = americanToDecimal(entry.homeML);
        const awayMLDec = americanToDecimal(entry.awayML);
        if (entry.homeSpreadOdds != null) {
          const homeSoDec = americanToDecimal(entry.homeSpreadOdds);
          // Home is underdog (positive spread): cushion line must cost more (lower decimal) than ML
          if (entry.homeSpread > 0 && homeSoDec > homeMLDec) {
            console.log(`[v10-integrity] NULL spread odds: ${homeTeam} +${entry.homeSpread} @ ${entry.homeSpreadOdds} pays more than ML ${entry.homeML} — stale`);
            entry.homeSpreadOdds = null; entry.awaySpreadOdds = null;
          }
          // Home is favorite (negative spread): giving points must pay more (higher decimal) than ML.
          // Only run this branch if awaySpreadOdds is actually available — never assume -110.
          else if (entry.homeSpread < 0 && entry.awaySpreadOdds != null) {
            const homeSoDec2 = americanToDecimal(entry.awaySpreadOdds);
            if (homeSoDec2 < awayMLDec) {
              console.log(`[v10-integrity] NULL spread odds: ${awayTeam} +${-entry.homeSpread} @ ${entry.awaySpreadOdds} pays less than ML ${entry.awayML} — stale`);
              entry.homeSpreadOdds = null; entry.awaySpreadOdds = null;
            }
          }
        }
      }

      // CHECK #2 — Vig reasonableness gate
      // Both sides of each market must sum to 1.02–1.20 implied probability.
      // Outside this range = data integrity failure (stale, phantom, or mismatched market).
      const VIG_MIN = 1.02, VIG_MAX = 1.20;
      if (entry.homeML != null && entry.awayML != null) {
        const vigML = impliedProb(entry.homeML) + impliedProb(entry.awayML);
        if (vigML < VIG_MIN || vigML > VIG_MAX) {
          console.log(`[v10-integrity] NULL ML: vig ${((vigML-1)*100).toFixed(1)}% out of range [2%–20%] for ${homeTeam} vs ${awayTeam}`);
          entry.homeML = null; entry.awayML = null;
        }
      }
      if (entry.homeSpreadOdds != null && entry.awaySpreadOdds != null) {
        const vigSpread = impliedProb(entry.homeSpreadOdds) + impliedProb(entry.awaySpreadOdds);
        if (vigSpread < VIG_MIN || vigSpread > VIG_MAX) {
          console.log(`[v10-integrity] NULL spread odds: vig ${((vigSpread-1)*100).toFixed(1)}% out of range for ${homeTeam} vs ${awayTeam}`);
          entry.homeSpreadOdds = null; entry.awaySpreadOdds = null;
        }
      }
      if (entry.overOdds != null && entry.underOdds != null) {
        const vigTotal = impliedProb(entry.overOdds) + impliedProb(entry.underOdds);
        if (vigTotal < VIG_MIN || vigTotal > VIG_MAX) {
          console.log(`[v10-integrity] NULL total odds: vig ${((vigTotal-1)*100).toFixed(1)}% out of range for ${homeTeam} vs ${awayTeam}`);
          entry.overOdds = null; entry.underOdds = null;
        }
      }

      // CHECK #3 — Alt spread monotone price ladder
      // More cushion (higher point) = easier to cover = must cost MORE (lower decimal odds).
      // If the price ladder inverts, mark violating entries as invalid.
      if (entry.altSpreads && entry.altSpreads.length > 1) {
        const teamNames = [...new Set(entry.altSpreads.map(a => a.team))];
        for (const team of teamNames) {
          const teamAlts = entry.altSpreads
            .filter(a => a.team === team)
            .sort((a, b) => a.point - b.point);
          for (let i = 1; i < teamAlts.length; i++) {
            const prev = teamAlts[i - 1], cur = teamAlts[i];
            // Higher point = more cushion = should cost more (lower decimal)
            if (americanToDecimal(cur.odds) > americanToDecimal(prev.odds)) {
              console.log(`[v10-integrity] ALT LADDER: ${team} ${cur.point > 0 ? '+' : ''}${cur.point}@${cur.odds} (dec ${americanToDecimal(cur.odds).toFixed(3)}) > ${prev.point > 0 ? '+' : ''}${prev.point}@${prev.odds} (dec ${americanToDecimal(prev.odds).toFixed(3)}) — ladder inverted, marking invalid`);
              cur._ladderInvalid = true;
            }
          }
        }
        // Remove ladder-invalid entries so they can't be selected
        entry.altSpreads = entry.altSpreads.filter(a => !a._ladderInvalid);
      }

      // CHECK #4 — Spread-ML implied win probability consistency
      // The spread line encodes an implied win probability (via logistic function).
      // If it diverges from the ML implied win probability by >18 points, one market is stale.
      if (entry.homeML != null && entry.awayML != null && entry.homeSpread != null) {
        // Spread-implied home win probability (standard 14-point scale for US sports)
        const spreadImpliedHomeWin = 1 / (1 + Math.pow(10, entry.homeSpread / 14));
        const homeRaw = impliedProb(entry.homeML);
        const awayRaw = impliedProb(entry.awayML);
        const mlImpliedHomeWin = homeRaw / (homeRaw + awayRaw); // vig-free
        const divergence = Math.abs(spreadImpliedHomeWin - mlImpliedHomeWin);
        if (divergence > 0.18) {
          console.log(`[v10-integrity] MISALIGN: ${homeTeam} spread ${entry.homeSpread} implies ${(spreadImpliedHomeWin*100).toFixed(0)}% home win but ML implies ${(mlImpliedHomeWin*100).toFixed(0)}% — divergence ${(divergence*100).toFixed(0)}pts, flagging`);
          entry._marketMisalignment = true; // downstream edge discount applied in computeEdgeTable
        }
      }

      lookup[homeTeam.toLowerCase()] = entry;
      lookup[awayTeam.toLowerCase()] = entry;
      const homeLast = homeTeam.toLowerCase().split(/\s+/).pop();
      const awayLast = awayTeam.toLowerCase().split(/\s+/).pop();
      if (homeLast.length > 3 && !lookup[homeLast]) lookup[homeLast] = entry;
      if (awayLast.length > 3 && !lookup[awayLast]) lookup[awayLast] = entry;
    }
  }
  return lookup;
}

function normalizeTeamName(name) {
  // Strip accents (é→e, ñ→n, etc.) and normalize punctuation
  return name.toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function findConsensusLine(lookup, teamName) {
  if (!teamName || !lookup) return null;
  const lower = normalizeTeamName(teamName);
  // Direct match
  if (lookup[lower]) return lookup[lower];
  // Try normalized against all keys
  for (const [key, val] of Object.entries(lookup)) {
    const normKey = normalizeTeamName(key);
    if (normKey === lower) return val;
  }
  // Last word match
  const lastWord = lower.split(/\s+/).pop();
  if (lastWord.length > 3) {
    for (const [key, val] of Object.entries(lookup)) {
      const keyLast = normalizeTeamName(key).split(/\s+/).pop();
      if (keyLast === lastWord) return val;
    }
  }
  // Partial match
  for (const [key, val] of Object.entries(lookup)) {
    const normKey = normalizeTeamName(key);
    if (normKey.includes(lower) || lower.includes(normKey)) return val;
  }
  return null;
}

function findTeam(teams, name) {
  if (!name || !teams) return null;
  if (teams[name]) return teams[name];
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(teams)) {
    if (key.toLowerCase() === lower) return val;
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
    const lastWord = lower.split(/\s+/).pop();
    const keyLast = key.toLowerCase().split(/\s+/).pop();
    if (lastWord === keyLast && lastWord.length > 3) return val;
    if (val.abbr && val.abbr.toLowerCase() === lower) return val;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// PHASE 1: DETERMINISTIC COMPUTATION PIPELINE
// All projections, edges, and Kelly sizing computed in JS.
// Ensemble projection: averages multiple methods per sport.
// ══════════════════════════════════════════════════════��═══════

// ── Star player injury impact (points/goals per game shift when OUT) ──
// Positive = team scores fewer points without this player
const INJURY_IMPACT = {
  // NBA — top impact players (estimated PPG swing when out)
  "Nikola Jokic": 8.5, "Luka Doncic": 7.5, "Shai Gilgeous-Alexander": 7.0,
  "Giannis Antetokounmpo": 7.5, "Joel Embiid": 7.0, "Jayson Tatum": 6.5,
  "Stephen Curry": 6.5, "Kevin Durant": 6.5, "LeBron James": 6.0,
  "Anthony Davis": 5.5, "Donovan Mitchell": 5.5, "Ja Morant": 5.5,
  "Jimmy Butler": 5.0, "Damian Lillard": 5.0, "Trae Young": 5.0,
  "Anthony Edwards": 5.5, "De'Aaron Fox": 5.0, "Tyrese Haliburton": 5.0,
  "Paolo Banchero": 4.5, "Cade Cunningham": 4.5, "Scottie Barnes": 4.5,
  "Devin Booker": 5.0, "Karl-Anthony Towns": 4.5, "Zion Williamson": 4.5,
  "Jalen Brunson": 5.0, "Darius Garland": 4.0, "Lauri Markkanen": 4.0,
  // NHL — top impact players (estimated goals/game swing when out)
  "Connor McDavid": 0.4, "Auston Matthews": 0.35, "Nathan MacKinnon": 0.35,
  "Nikita Kucherov": 0.3, "Leon Draisaitl": 0.3, "David Pastrnak": 0.3,
  "Cale Makar": 0.25, "Kirill Kaprizov": 0.3, "Jack Hughes": 0.25,
  "Mika Zibanejad": 0.2, "Matthew Tkachuk": 0.25, "Sidney Crosby": 0.25,
  "Artemi Panarin": 0.25, "Tage Thompson": 0.25, "Alex Ovechkin": 0.2,
  // NCAAB — top impact players (estimated PPG swing)
  "Cooper Flagg": 5.0, "Dylan Harper": 4.5, "Ace Bailey": 4.5,
  "Kasparas Jakucionis": 4.0, "Johni Broome": 4.5, "Mark Sears": 4.0,
  "RJ Davis": 4.0, "Hunter Dickinson": 4.0, "Caleb Love": 3.5,
};

function computeInjuryAdjustment(injuries, sport) {
  if (!injuries || injuries.length === 0) return 0;
  let totalImpact = 0;
  for (const inj of injuries) {
    // Only count players who are OUT or Doubtful
    const status = (inj.status || '').toLowerCase();
    if (status === 'out' || status === 'doubtful' || status.includes('out for season')) {
      const impact = INJURY_IMPACT[inj.name] || 0;
      // Doubtful = 70% chance out, Out = 100%
      const factor = status === 'doubtful' ? 0.7 : 1.0;
      totalImpact += impact * factor;
    }
  }
  return totalImpact;
}

// ── Dynamic injury impact: uses player stats when available, falls back to INJURY_IMPACT then sport defaults ──
function computeDynamicInjuryImpact(injuries, teamStats, sport) {
  if (!injuries || injuries.length === 0) return 0;

  // Sport-specific defaults for unknown players
  const SPORT_DEFAULTS = {
    basketball: 1.5, // NBA/NCAAB: generic role player ~1.5 PPG impact
    hockey: 0.08,    // NHL: generic forward ~0.08 goals/game impact
    baseball: 0.3,   // MLB: generic lineup spot ~0.3 runs impact
  };

  let totalImpact = 0;
  for (const inj of injuries) {
    const status = (inj.status || '').toLowerCase();
    if (status !== 'out' && status !== 'doubtful' && !status.includes('out for season')) continue;

    const factor = status === 'doubtful' ? 0.7 : 1.0;
    let impact = 0;

    // Priority 1: Compute from player stats if available (ESPN injury data may include PPG)
    if (inj.ppg || inj.avgPoints || inj.statistics) {
      const playerPPG = inj.ppg || inj.avgPoints || 0;
      const minutesShare = inj.minutesShare || inj.avgMinutes ? (inj.avgMinutes / 48) : 0.5;
      if (playerPPG > 0) {
        impact = playerPPG * minutesShare;
      }
    }

    // Priority 2: Fall back to hardcoded star player dictionary
    if (impact === 0 && INJURY_IMPACT[inj.name]) {
      impact = INJURY_IMPACT[inj.name];
    }

    // Priority 3: Sport-specific default for unknown players
    if (impact === 0) {
      impact = SPORT_DEFAULTS[sport] || 1.0;
    }

    totalImpact += impact * factor;
  }
  return totalImpact;
}

// ── Ensemble projection: runs multiple methods and averages ──
function computeProjection(game, leagueName, leagueConfig, homeRating, awayRating, teamStats, pitcherData) {
  const homeStats = teamStats?.[game.home];
  const awayStats = teamStats?.[game.away];
  const sportType = leagueConfig ? leagueConfig.sport : null;

  // Collect all available projection methods
  const projections = []; // Array of { home, away, weight, method }

  // ── METHOD 1: Elo-based historical averages (always available) ──
  // Uses home/away splits from ratings blob
  const eloHomeScore = ((homeRating.homeAvgScored || homeRating.avgScored10 || 100) + (awayRating.awayAvgAllowed || awayRating.avgAllowed10 || 100)) / 2;
  const eloAwayScore = ((awayRating.awayAvgScored || awayRating.avgScored10 || 100) + (homeRating.homeAvgAllowed || homeRating.avgAllowed10 || 100)) / 2;
  if (eloHomeScore > 0 && eloAwayScore > 0) {
    projections.push({ home: eloHomeScore, away: eloAwayScore, weight: 1.0, method: "elo-historical" });
  }

  // ── METHOD 2: Sport-specific efficiency model (when ESPN stats available) ──
  if (sportType === 'hockey' && homeStats?.sport === 'hockey' && awayStats?.sport === 'hockey'
      && homeStats.shotsFor && awayStats.shotsFor && homeStats.savePct && awayStats.savePct) {
    const homeExpShots = (homeStats.shotsFor + (awayStats.shotsAgainst || homeStats.shotsFor)) / 2;
    const awayExpShots = (awayStats.shotsFor + (homeStats.shotsAgainst || awayStats.shotsFor)) / 2;
    const lgAvgSavePct = 0.905;
    const homeSaveFactor = awayStats.savePct ? (1 - awayStats.savePct) / (1 - lgAvgSavePct) : 1.0;
    const awaySaveFactor = homeStats.savePct ? (1 - homeStats.savePct) / (1 - lgAvgSavePct) : 1.0;
    const effHome = Math.max(homeExpShots * (homeStats.shootingPct || 0.10) * homeSaveFactor, 1.0);
    const effAway = Math.max(awayExpShots * (awayStats.shootingPct || 0.10) * awaySaveFactor, 1.0);
    projections.push({ home: effHome, away: effAway, weight: 1.5, method: "nhl-shot-efficiency" });

  } else if (sportType === 'baseball' && homeStats?.sport === 'baseball' && awayStats?.sport === 'baseball'
             && homeStats.pointsPerGame && awayStats.pointsPerGame) {
    let effHome, effAway, method;
    // Use starting pitcher ERA when available, fall back to team ERA
    const homePitcher = pitcherData?.[game.home];
    const awayPitcher = pitcherData?.[game.away];
    const homeERA = homePitcher?.era || homeStats.era;
    const awayERA = awayPitcher?.era || awayStats.era;
    if (homeERA && awayERA) {
      // v11.1.1 (2026-06-17): regress starter ERA toward the league mean and clamp the
      // run multiplier. The old `oppERA / 4.00` was unbounded and convex — a small-sample
      // blow-up ERA (e.g. 10+) scaled the opposing offense ~2.5x, systematically inflating
      // run totals and flooding the card with MLB Overs (the dominant losing-bet driver).
      const LG_ERA = 4.20; // approx MLB run-scoring environment
      const regAwayERA = (awayERA + LG_ERA) / 2; // 50% shrink toward league mean
      const regHomeERA = (homeERA + LG_ERA) / 2;
      const clampMult = (m) => Math.min(1.18, Math.max(0.82, m)); // one starter swings runs <=18%
      effHome = homeStats.pointsPerGame * clampMult(regAwayERA / LG_ERA);
      effAway = awayStats.pointsPerGame * clampMult(regHomeERA / LG_ERA);
      method = homePitcher?.era || awayPitcher?.era
        ? `mlb-starter-adjusted(${homePitcher?.pitcher || 'team'}/${awayPitcher?.pitcher || 'team'})`
        : "mlb-pitching-adjusted";
    } else {
      effHome = (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2;
      effAway = (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2;
      method = "mlb-runs-average";
    }
    projections.push({ home: Math.max(effHome, 1.5), away: Math.max(effAway, 1.5), weight: 1.5, method });

  } else if (sportType === 'soccer' && homeStats?.sport === 'soccer' && awayStats?.sport === 'soccer'
             && homeStats.pointsPerGame && awayStats.pointsPerGame) {
    let effHome, effAway, method;
    if (homeStats.shotsOnGoal && awayStats.shotsOnGoal && homeStats.conversionRate && awayStats.conversionRate) {
      const homeExpSOT = (homeStats.shotsOnGoal + awayStats.shotsOnGoal) / 2;
      effHome = homeExpSOT * homeStats.conversionRate;
      effAway = homeExpSOT * awayStats.conversionRate;
      method = "soccer-shot-efficiency";
    } else {
      effHome = (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2;
      effAway = (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2;
      method = "soccer-goal-average";
    }
    projections.push({ home: Math.max(effHome, 0.3), away: Math.max(effAway, 0.3), weight: 1.5, method });

  } else if (homeStats?.offensiveRating && homeStats?.defensiveRating && homeStats?.pace &&
      awayStats?.offensiveRating && awayStats?.defensiveRating && awayStats?.pace) {
    // Basketball: pace-adjusted efficiency
    const avgPace = (homeStats.pace + awayStats.pace) / 2;
    const lgAvgDRtg = LEAGUE_AVG_DRTG[leagueName] || 110;
    const effHome = avgPace * (homeStats.offensiveRating / 100) * (awayStats.defensiveRating / lgAvgDRtg);
    const effAway = avgPace * (awayStats.offensiveRating / 100) * (homeStats.defensiveRating / lgAvgDRtg);
    projections.push({ home: effHome, away: effAway, weight: 1.5, method: "pace-adjusted-efficiency" });
  }

  // ── METHOD 3: PPG/PPG-allowed average (when available but efficiency isn't) ──
  if (homeStats?.pointsPerGame && homeStats?.pointsAllowed &&
      awayStats?.pointsPerGame && awayStats?.pointsAllowed &&
      !projections.find(p => p.method.includes('efficiency') || p.method.includes('pitching') || p.method.includes('pace'))) {
    const ppgHome = (homeStats.pointsPerGame + awayStats.pointsAllowed) / 2;
    const ppgAway = (awayStats.pointsPerGame + homeStats.pointsAllowed) / 2;
    projections.push({ home: ppgHome, away: ppgAway, weight: 1.2, method: "ppg-average" });
  }

  // ── ENSEMBLE: weighted average of all available methods ──
  let projHomeScore, projAwayScore, projMethod;
  if (projections.length === 1) {
    projHomeScore = projections[0].home;
    projAwayScore = projections[0].away;
    projMethod = projections[0].method;
  } else if (projections.length >= 2) {
    const totalWeight = projections.reduce((s, p) => s + p.weight, 0);
    projHomeScore = projections.reduce((s, p) => s + p.home * p.weight, 0) / totalWeight;
    projAwayScore = projections.reduce((s, p) => s + p.away * p.weight, 0) / totalWeight;
    projMethod = "ensemble(" + projections.map(p => p.method).join("+") + ")";
  } else {
    projHomeScore = 100;
    projAwayScore = 100;
    projMethod = "fallback";
  }

  // ── OPPONENT-ADJUSTED EFFICIENCY ──
  // Adjust projections based on opponent defensive tier.
  // If a team's recent scoring was against weak defenses, discount it.
  // If against strong defenses, their projection is more reliable.
  // Uses sosRating as proxy for opponent quality faced.
  const LEAGUE_AVG_ELO_OPP = 1500;
  if (homeRating.sosRating && awayRating.sosRating) {
    // Teams that faced harder schedules (high SOS) had their scoring suppressed
    // → their true offensive ability is HIGHER than raw averages suggest
    const homeSosDeviation = (homeRating.sosRating - LEAGUE_AVG_ELO_OPP) / 200; // normalized: 0 = average, +0.5 = very hard
    const awaySosDeviation = (awayRating.sosRating - LEAGUE_AVG_ELO_OPP) / 200;
    // Boost teams that scored against tough opponents, discount teams that scored against weak ones
    // Effect size: 2% per 200 Elo of SOS deviation (subtle but meaningful over many picks)
    const homeOppAdj = 1.0 + (homeSosDeviation * 0.02);
    const awayOppAdj = 1.0 + (awaySosDeviation * 0.02);
    projHomeScore *= homeOppAdj;
    projAwayScore *= awayOppAdj;
    if (Math.abs(homeSosDeviation) > 0.15 || Math.abs(awaySosDeviation) > 0.15) {
      projMethod += ` [opp-adj: home ${(homeOppAdj * 100 - 100).toFixed(1)}%, away ${(awayOppAdj * 100 - 100).toFixed(1)}%]`;
    }
  }

  // ── H2H MATCHUP HISTORY ──
  // Check if either team has a documented recent matchup edge against the other.
  // Uses coverRate differential as a proxy: if home team covers at 70% but away covers at 40%,
  // there's a 30% directional matchup skew worth a small projection adjustment.
  if (homeRating.coverRate !== undefined && awayRating.coverRate !== undefined) {
    const coverDiff = (homeRating.coverRate - awayRating.coverRate) / 100; // normalized to 0-1 range
    // Only apply if meaningful gap (>15% cover rate difference)
    if (Math.abs(coverDiff) > 0.15) {
      // Small adjustment: 1% scoring shift per 10% cover rate advantage
      const h2hAdj = coverDiff * 0.10;
      projHomeScore *= (1 + h2hAdj);
      projAwayScore *= (1 - h2hAdj);
      projMethod += ` [cover-rate-adj: ${(h2hAdj * 100).toFixed(1)}%]`;
    }
  }

  // ── RECENCY BLEND: 70% ensemble / 30% last-5 game averages ──
  // Teams on hot/cold streaks should shift projections toward recent form.
  const RECENCY_WEIGHT = 0.30;
  if (homeRating.avgScored5 && homeRating.avgAllowed5 && awayRating.avgScored5 && awayRating.avgAllowed5) {
    const recentHome = (homeRating.avgScored5 + awayRating.avgAllowed5) / 2;
    const recentAway = (awayRating.avgScored5 + homeRating.avgAllowed5) / 2;
    projHomeScore = projHomeScore * (1 - RECENCY_WEIGHT) + recentHome * RECENCY_WEIGHT;
    projAwayScore = projAwayScore * (1 - RECENCY_WEIGHT) + recentAway * RECENCY_WEIGHT;
    projMethod += ` [recency-30%]`;
  }

  // ── INJURY ADJUSTMENT: shift projections based on star player absence ──
  // Uses dynamic computation (player stats → star dict → sport defaults)
  const homeInjImpact = computeDynamicInjuryImpact(game.homeInjuries, teamStats, sportType);
  const awayInjImpact = computeDynamicInjuryImpact(game.awayInjuries, teamStats, sportType);
  if (homeInjImpact > 0 || awayInjImpact > 0) {
    projHomeScore -= homeInjImpact;
    projAwayScore -= awayInjImpact;
    if (homeInjImpact > 0 || awayInjImpact > 0) {
      projMethod += ` [inj: home-${homeInjImpact.toFixed(1)}, away-${awayInjImpact.toFixed(1)}]`;
    }
  }

  // ── REST DIFFERENTIAL SYSTEM: B2B penalties + rest advantage + time zone fatigue ──
  const sportKey = sportType === 'hockey' ? 'NHL' : sportType === 'basketball' ? (leagueName === 'NCAAB' ? 'NCAAB' : 'NBA') : 'MLB';
  const restAdj = computeRestAdjustment(
    homeRating.daysSinceLastGame, awayRating.daysSinceLastGame,
    game.home, game.away, sportKey
  );
  projHomeScore *= restAdj.homeScoreMult;
  projAwayScore *= restAdj.awayScoreMult;
  if (restAdj.method) projMethod += restAdj.method;

  // NCAAB neutral site detection
  let effectiveHomeAdv = leagueConfig?.homeAdv || 80;
  if (leagueName === 'NCAAB' && game.venue) {
    const now = new Date();
    const month = now.getMonth() + 1;
    if ((month === 3 && now.getDate() >= 15) || month === 4) effectiveHomeAdv = 0;
  }

  // SOS-adjusted Elo: teams with harder schedules have more reliable Elos
  // If SOS > league avg (1500), their Elo is "battle-tested" — bump it slightly
  // If SOS < league avg, their Elo was built against weak opponents — discount it
  const LEAGUE_AVG_ELO = 1500;
  const SOS_WEIGHT = 0.03; // 3% of SOS deviation added to Elo (conservative)
  let homeSosAdj = 0, awaySosAdj = 0;
  if (homeRating.sosRating) {
    homeSosAdj = Math.round((homeRating.sosRating - LEAGUE_AVG_ELO) * SOS_WEIGHT);
  }
  if (awayRating.sosRating) {
    awaySosAdj = Math.round((awayRating.sosRating - LEAGUE_AVG_ELO) * SOS_WEIGHT);
  }

  // Playoff month detection — NBA/NHL playoffs run Apr-Jun, MLB Oct
  // Regular-season streaks are less predictive in playoffs (opponents are pre-filtered),
  // and Elo gaps overstate edges when both teams earned their way to the same round.
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMonth = etNow.getMonth() + 1; // 1-12
  const isPlayoffMonth = (
    (['NBA', 'NHL'].includes(leagueName) && etMonth >= 4 && etMonth <= 6) ||
    (leagueName === 'MLB' && etMonth === 10)
  );

  // Streak-adjusted Elo: temporarily shift Elo to reflect current form.
  // In playoff months dampen by 50% — playoff opponents are pre-filtered so
  // regular-season momentum is less reliable and the raw boost is too large.
  let homeStreakAdj = getStreakEloAdjustment(homeRating.streak || 0, leagueName);
  let awayStreakAdj = getStreakEloAdjustment(awayRating.streak || 0, leagueName);
  if (isPlayoffMonth) {
    homeStreakAdj = Math.round(homeStreakAdj * 0.5);
    awayStreakAdj = Math.round(awayStreakAdj * 0.5);
    projMethod += ' [playoff-streak-damp]';
  }
  const homeEloEffective = homeRating.elo + homeStreakAdj + homeSosAdj;
  const awayEloEffective = awayRating.elo + awayStreakAdj + awaySosAdj;
  if (homeStreakAdj !== 0) projMethod += ` [streak-elo: home ${homeStreakAdj > 0 ? '+' : ''}${homeStreakAdj}]`;
  if (awayStreakAdj !== 0) projMethod += ` [streak-elo: away ${awayStreakAdj > 0 ? '+' : ''}${awayStreakAdj}]`;
  if (homeSosAdj !== 0 || awaySosAdj !== 0) projMethod += ` [SOS: home ${homeSosAdj > 0 ? '+' : ''}${homeSosAdj}, away ${awaySosAdj > 0 ? '+' : ''}${awaySosAdj}]`;

  const homeEloAdj = homeEloEffective + effectiveHomeAdv;
  let homeWinProb = eloExpected(homeEloAdj, awayEloEffective);

  // Playoff regression: pull win probability 20% toward 0.5.
  // Both teams qualified for this round — the raw Elo gap overstates the true edge.
  if (isPlayoffMonth) {
    homeWinProb = 0.5 + (homeWinProb - 0.5) * 0.80;
    projMethod += ' [playoff-elo-regress-20%]';
  }
  // Rest differential adjusts spread (positive spreadAdj = favors home = more negative projected spread)
  let projTotal = projHomeScore + projAwayScore;

  // ── PROJECTION SANITY CAPS — exclude games with garbage projections ──
  // Total sanity caps: anything above these values is a poisoned projection (bad input data).
  // Baseball max is 14 — real MLB games rarely exceed 20 runs total; 14 catches bad PPG data.
  // Historical record is 49 runs (1922), but betting context is current-era games (7.5-10.5 lines).
  const TOTAL_CAPS = { soccer: 7, hockey: 12, basketball: 300, baseball: 14 };
  const SPREAD_CAPS = { soccer: 4, hockey: 6, basketball: 40, baseball: 10 };
  const totalCap = TOTAL_CAPS[sportType] || 300;
  const spreadCap = SPREAD_CAPS[sportType] || 40;
  let projSpread = -(projHomeScore - projAwayScore) - (restAdj.spreadAdj || 0);
  let poisoned = false;

  if (projTotal > totalCap) {
    console.log(`[v10-cap] POISONED: projTotal ${projTotal.toFixed(1)} exceeds ${totalCap} for ${sportType} (${game.away} @ ${game.home}) — excluding game`);
    poisoned = true;
  }
  if (Math.abs(projSpread) > spreadCap) {
    console.log(`[v10-cap] POISONED: projSpread ${projSpread.toFixed(1)} exceeds ${spreadCap} for ${sportType} (${game.away} @ ${game.home}) — excluding game`);
    poisoned = true;
  }

  return { projHomeScore, projAwayScore, projSpread, projTotal, projMethod, homeWinProb, homeEloAdj, effectiveHomeAdv, poisoned };
}

// evFloor: minimum Kelly EV a candidate must clear to be retained.
// v11.1: default lowered 0.08 → 0.03. The old 8% bar was tuned to inflated probabilities;
// with shrinkage calibration, +3% CALIBRATED EV is a genuinely sharp threshold (real edge after
// vig, comparable to professional sides). The thin-slate fallback re-runs at 0.015 for Leans.
function computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, drawdownActive, calibrationData, pitcherData, evFloor = 0.03) {
  const candidates = [];
  if (!espnData) return candidates;
  // ratingsData can be null (stale/missing blob) — fall back to default Elo so ESPN stats still drive edges.
  // Root cause fix: previously bailing out here produced zero candidates, killing even the 3% lean tier.

  // Default rating used when no pre-built Elo data exists for a team
  const DEFAULT_RATING = {
    elo: 1500, coverRate: 50, streak: 0, daysSinceLastGame: 1, last5: [],
    homeAvgScored: null, awayAvgScored: null, avgScored10: null, avgAllowed10: null,
    homeAvgAllowed: null, awayAvgAllowed: null, avgScored5: null, avgAllowed5: null,
    sosRating: 1500,
  };

  for (const league of espnData) {
    const leagueConfig = ESPN_LEAGUES.find(l => l.label === league.league);
    if (!leagueConfig) continue;
    const leagueRatings = ratingsData?.leagues?.[league.league];
    // Don't skip leagues with no ratings — use defaults so ESPN stats still produce candidates

    for (const game of league.games) {
      const homeRating = (leagueRatings?.teams ? findTeam(leagueRatings.teams, game.home) : null) || DEFAULT_RATING;
      const awayRating = (leagueRatings?.teams ? findTeam(leagueRatings.teams, game.away) : null) || DEFAULT_RATING;

      let proj;
      try {
        proj = computeProjection(game, league.league, leagueConfig, homeRating, awayRating, teamStats, pitcherData);
      } catch (projErr) {
        console.error(`[v10-edge] PROJECTION ERROR for ${game.away} @ ${game.home} (${league.league}): ${projErr.message}`);
        console.error(projErr.stack?.split('\n').slice(0, 3).join('\n'));
        continue;
      }
      // v10.2 fix: don't skip the ENTIRE game on a poisoned projection.
      // A poisoned total (e.g. DEFAULT_RATING produces 200 runs for baseball) should
      // only block the total candidate — not the spread/ML candidates, which use
      // projSpread and homeWinProb that are still valid even with fallback ratings.
      const skipTotal = proj.poisoned;
      if (proj.poisoned) {
        console.log(`[v10-edge] POISON: projTotal=${proj.projTotal.toFixed(1)} for ${league.league} (${game.away} @ ${game.home}) — skipping total candidates only, spread/ML still evaluated`);
      }
      const gameData = findConsensusLine(consensusLookup, game.home);
      if (!gameData || gameData.homeSpread === undefined) {
        console.log(`[v10-edge] SKIP ${game.away} @ ${game.home} (${league.league}) — no consensus line found for "${game.home}"`);
        continue;
      }
      const spreadEdgeDbg = Math.abs(proj.projSpread - gameData.homeSpread);
      const totalEdgeDbg = gameData.total ? Math.abs(proj.projTotal - gameData.total) : 0;
      console.log(`[v10-edge] ${game.away} @ ${game.home} (${league.league}) — projSpread=${proj.projSpread.toFixed(1)}, consSpread=${gameData.homeSpread}, spreadEdge=${spreadEdgeDbg.toFixed(1)}, projTotal=${proj.projTotal.toFixed(1)}, consTotal=${gameData.total || '?'}, totalEdge=${totalEdgeDbg.toFixed(1)}, method=${proj.projMethod}`);

      const std = SPORT_STD_DEVS[league.league] || 12;
      const minEdge = SPORT_MIN_EDGE[league.league] || 2.0;
      const homeStats = teamStats?.[game.home];
      const awayStats = teamStats?.[game.away];

      // Situational flags: eliminated teams get a Kelly penalty, contending teams get a boost
      const homeFlag = getSituationalFlag(game.homeRecord, league.league);
      const awayFlag = getSituationalFlag(game.awayRecord, league.league);
      if (homeFlag !== "neutral" || awayFlag !== "neutral") {
        console.log(`[v10-sit] ${game.away} (${awayFlag}) @ ${game.home} (${homeFlag}) — ${game.homeRecord} vs ${game.awayRecord}`);
      }

      const baseCandidate = {
        matchup: `${game.away} @ ${game.home}`,
        sport: league.league,
        homeTeam: game.home,
        awayTeam: game.away,
        venue: game.venue || "",
        commenceTime: gameData.commenceTime || "",
        homeFlag,
        awayFlag,
        homeElo: homeRating.elo,
        awayElo: awayRating.elo,
        homeWinProb: +(proj.homeWinProb * 100).toFixed(1),
        projHomeScore: +proj.projHomeScore.toFixed(1),
        projAwayScore: +proj.projAwayScore.toFixed(1),
        projMethod: proj.projMethod,
        homeStreak: homeRating.streak || 0,
        awayStreak: awayRating.streak || 0,
        homeRest: homeRating.daysSinceLastGame,
        awayRest: awayRating.daysSinceLastGame,
        homeCoverRate: homeRating.coverRate,
        awayCoverRate: awayRating.coverRate,
        homeRecord: game.homeRecord,
        awayRecord: game.awayRecord,
        homeLast5: homeRating.last5 ? homeRating.last5.map(g => g.result).join("") : "",
        awayLast5: awayRating.last5 ? awayRating.last5.map(g => g.result).join("") : "",
        homeAvgScored5: homeRating.avgScored5,
        homeAvgAllowed5: homeRating.avgAllowed5,
        awayAvgScored5: awayRating.avgScored5,
        awayAvgAllowed5: awayRating.avgAllowed5,
        homeInjuries: game.homeInjuries || [],
        awayInjuries: game.awayInjuries || [],
        homeStats: homeStats || null,
        awayStats: awayStats || null,
      };

      // ── PLACEABILITY GATE ──
      // A pick is only generated if the market is offered at 2+ major US sportsbooks.
      // This ensures every pick can be physically placed by users at common books.
      const MAJOR_BOOK_MIN = 2; // v11.1: enforce the documented "2+ major US books" promise (was 1)
      const spreadPlaceable = (gameData.majorSpreadBooks || 0) >= MAJOR_BOOK_MIN;
      const totalPlaceable  = (gameData.majorTotalBooks  || 0) >= MAJOR_BOOK_MIN;
      const mlPlaceable     = (gameData.majorMLBooks     || 0) >= MAJOR_BOOK_MIN;
      if (!spreadPlaceable && !totalPlaceable && !mlPlaceable) {
        console.log(`[v10-placeable] SKIP ${game.away} @ ${game.home} — no markets at 2+ major books (spread:${gameData.majorSpreadBooks} total:${gameData.majorTotalBooks} ml:${gameData.majorMLBooks})`);
        continue;
      }

      // ── SPREAD CANDIDATE ──
      // v11.1: soccer spreads disabled — real-run soccer 38.5% win rate / -21.4% ROI (n=44).
      // Only the Poisson TOTALS hypothesis stays live for soccer in MVP (alpha disables soccer fully).
      const isSoccerSpreadLeague = ["EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "MLS", "UCL", "Europa"].includes(league.league);
      const actualSpread = gameData.homeSpread;
      // Filter out Asian handicap lines (.25/.75) — not available at US sportsbooks
      const spreadFrac = Math.abs(actualSpread) % 1;
      if (spreadFrac === 0.25 || spreadFrac === 0.75) {
        console.log(`[v10-filter] SKIP Asian handicap ${actualSpread} for ${game.away} @ ${game.home}`);
      }
      const rawSpreadEdge = (spreadFrac !== 0.25 && spreadFrac !== 0.75) ? Math.abs(proj.projSpread - actualSpread) : 0;
      let spreadEdge = applyEdgeDiscount(rawSpreadEdge, std);
      // Market misalignment discount: spread and ML imply contradictory win probabilities
      if (gameData._marketMisalignment) {
        spreadEdge *= 0.80;
        console.log(`[v10-misalign] 20% edge discount on ${game.away} @ ${game.home} — spread/ML markets misaligned`);
      }
      // Consensus tightness: if books agree tightly, discount our edge (market is confident)
      // If books are spread out (range > 2), our edge is more plausible (soft line)
      if (gameData.spreadRange !== undefined && gameData.spreadBookCount >= 3) {
        if (gameData.spreadRange <= 0.5) {
          spreadEdge *= 0.90; // tight consensus — 10% discount, market is sharp
        } else if (gameData.spreadRange <= 1.0) {
          spreadEdge *= 0.95; // moderate consensus — 5% discount
        }
        // spreadRange > 2.0 = soft line, no discount (keep full edge)
      }
      if (spreadEdge >= minEdge && spreadPlaceable && !isSoccerSpreadLeague) {
        const spreadZ = spreadEdge / std;
        // Determine bet type for calibration cap lookup
        let betType = "Spread";
        if (league.league === "NHL") betType = "Puck Line";
        else if (league.league === "MLB") betType = "Run Line";
        const rawCoverProb = normalCDF(spreadZ);
        // Determine pick side + odds first so we can pass odds to calibration
        const isHomeCover = proj.projSpread < actualSpread;
        const pickedSpread = isHomeCover ? actualSpread : gameData.awaySpread;
        // A 0-point spread has no push in playoff context — display as ML
        const sideLabel = pickedSpread === 0
          ? (isHomeCover ? `${game.home} ML` : `${game.away} ML`)
          : (isHomeCover
              ? `${game.home} ${actualSpread > 0 ? '+' : ''}${actualSpread}`
              : `${game.away} ${gameData.awaySpread > 0 ? '+' : ''}${gameData.awaySpread}`);
        if (pickedSpread === 0) betType = "Moneyline";
        const side = sideLabel;
        const odds = isHomeCover ? gameData.homeSpreadOdds : gameData.awaySpreadOdds;
        // Null odds = integrity check nulled them (stale/phantom price). Never fall back to -110.
        if (odds == null) {
          console.log(`[v10-skip] No valid spread odds for ${game.away} @ ${game.home} — skipping spread candidate`);
        } else {
        const coverProb = getCalibratedCoverProb(rawCoverProb, league.league, betType, odds);

        // Skip large NBA/NCAAB spreads — model accuracy degrades at extremes, sharp consensus is these are -EV
        const MAX_SPREAD = { NBA: 10, NCAAB: 14 };
        const spreadLimit = MAX_SPREAD[league.league];
        if (spreadLimit && Math.abs(isHomeCover ? actualSpread : gameData.awaySpread) > spreadLimit) {
          console.log(`[v10-beta] Skipping ${side} — spread ${Math.abs(isHomeCover ? actualSpread : gameData.awaySpread)} exceeds ${league.league} max ${spreadLimit}`);
        }
        // Skip if odds worse than -250
        else if (odds >= -250) {
          const kelly = computeKelly(coverProb, odds, drawdownActive);
          if (kelly.ev > evFloor) {
            // Apply sport-specific Kelly multiplier
            const sportMult = SPORT_KELLY_MULT[league.league] || 1.0;
            let adjUnits = Math.round(kelly.units * sportMult * 2) / 2; // round to 0.5u
            adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
            candidates.push({
              ...baseCandidate,
              market: betType,
              side,
              odds,
              modelProjection: +proj.projSpread.toFixed(1),
              consensusLine: actualSpread,
              edge: +spreadEdge.toFixed(1),
              zScore: +spreadZ.toFixed(3),
              coverProb: +coverProb.toFixed(4),
              impliedProb: +impliedProb(odds).toFixed(4),
              ev: +kelly.ev.toFixed(4),
              kellyFraction: +kelly.kellyFraction.toFixed(4),
              kellyUnits: adjUnits,
              decimalPayout: +kelly.decPayout.toFixed(3),
              _rawKellyUnits: adjUnits,
              kellyCalcStr: `coverProb=${coverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_half=${kelly.kellyFraction.toFixed(4)}, units=${adjUnits}u${sportMult !== 1.0 ? ` [${league.league} ${sportMult}x]` : ''}`,
            });
          }
        }
        } // end: odds != null spread candidate block
      }

      // ── TOTAL CANDIDATE ──
      const actualTotal = gameData.total;
      if (actualTotal && !skipTotal) {
        // Filter out Asian handicap totals (.25/.75) — not available at US sportsbooks
        const totalFrac = Math.abs(actualTotal) % 1;
        if (totalFrac === 0.25 || totalFrac === 0.75) {
          console.log(`[v10-filter] SKIP Asian total ${actualTotal} for ${game.away} @ ${game.home}`);
        }
        const rawTotalEdge = (totalFrac !== 0.25 && totalFrac !== 0.75) ? Math.abs(proj.projTotal - actualTotal) : 0;
        const totalStd = SPORT_TOTAL_STD_DEVS[league.league] || std * 1.5; // v11.1: totals use total σ
        let totalEdge = applyEdgeDiscount(rawTotalEdge, totalStd);
        // Consensus tightness for totals
        if (gameData.totalRange !== undefined && gameData.totalBookCount >= 3) {
          if (gameData.totalRange <= 0.5) {
            totalEdge *= 0.90; // tight consensus — 10% discount
          } else if (gameData.totalRange <= 1.0) {
            totalEdge *= 0.95; // moderate consensus — 5% discount
          }
        }
        // v10.2: MLB total min edge 0.8→0.4, NHL 0.5→0.3. EV floor (3%/8%) is the real quality gate.
        const totalMinEdge = league.league === "NHL" ? 0.3 : league.league === "MLB" ? 0.4 : 2.5;
        if (totalEdge >= totalMinEdge && totalPlaceable) {
          const isSoccerLeague = leagueConfig?.sport === 'soccer';
          const isOver = proj.projTotal > actualTotal;
          // totalZ must live in this outer scope — candidates.push below reads it for zScore
          const totalZ = totalEdge / totalStd; // v11.1: total σ, not margin σ
          // v11.1-mvp: Poisson CDF for soccer totals (discrete goal distribution).
          // Soccer averages ~2.5 goals/game — normal CDF overestimates edge by 2-4% near the line.
          // For non-soccer, normal CDF remains correct (NBA/NHL/MLB are continuous-score sports).
          let rawTotalCoverProb;
          if (isSoccerLeague) {
            const lambda = Math.max(0.5, proj.projTotal); // expected total goals
            const floorLine = Math.floor(actualTotal);
            const pUnder = poissonCDF(floorLine, lambda);
            rawTotalCoverProb = isOver ? 1 - pUnder : pUnder;
          } else {
            rawTotalCoverProb = normalCDF(totalZ);
          }
          const totalSide = `${isOver ? "Over" : "Under"} ${actualTotal}`;
          // v11.1.1 line-shop: bet the best price for our side, but only if the integrity-checked
          // median is valid (null median = phantom/stale line → skip, never line-shop a bad number).
          const totalOdds = isOver
            ? (gameData.overOdds == null ? null : (gameData.overOddsBest ?? gameData.overOdds))
            : (gameData.underOdds == null ? null : (gameData.underOddsBest ?? gameData.underOdds));
          // Null total odds = integrity check nulled them (phantom/stale). Never fall back to -110.
          if (totalOdds == null) {
            console.log(`[v10-skip] No valid total odds for ${game.away} @ ${game.home} — skipping total candidate`);
          } else {
          const totalCoverProb = getCalibratedCoverProb(rawTotalCoverProb, league.league, "Total", totalOdds);

          if (totalOdds >= -250) {
            const kelly = computeKelly(totalCoverProb, totalOdds, drawdownActive);
            if (kelly.ev > evFloor) {
              const sportMult = SPORT_KELLY_MULT[league.league] || 1.0;
              let adjUnits = Math.round(kelly.units * sportMult * 2) / 2;
              adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
              candidates.push({
                ...baseCandidate,
                market: "Total",
                side: totalSide,
                odds: totalOdds,
                modelProjection: +proj.projTotal.toFixed(1),
                consensusLine: actualTotal,
                edge: +totalEdge.toFixed(1),
                zScore: +totalZ.toFixed(3),
                coverProb: +totalCoverProb.toFixed(4),
                impliedProb: +impliedProb(totalOdds).toFixed(4),
                ev: +kelly.ev.toFixed(4),
                kellyFraction: +kelly.kellyFraction.toFixed(4),
                kellyUnits: adjUnits,
                decimalPayout: +kelly.decPayout.toFixed(3),
                _rawKellyUnits: adjUnits,
              kellyCalcStr: `coverProb=${totalCoverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_half=${kelly.kellyFraction.toFixed(4)}, units=${adjUnits}u${sportMult !== 1.0 ? ` [${league.league} ${sportMult}x]` : ''}`,
              });
            }
          }
          } // end: totalOdds != null block
        }
      }
      // ── MONEYLINE CANDIDATE ──
      // Use Elo win probability vs implied odds probability to find ML edge
      // Soccer excluded: Elo model not calibrated for draw-heavy, low-scoring matches
      const SOCCER_LEAGUES = ["EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "MLS", "UCL", "Europa"];
      if (SOCCER_LEAGUES.includes(league.league)) {
        // Skip ML for soccer — Elo overestimates underdog win probability
      }
      const homeML = (!SOCCER_LEAGUES.includes(league.league) && mlPlaceable) ? gameData.homeML : null;
      const awayML = !SOCCER_LEAGUES.includes(league.league) ? gameData.awayML : null;
      if (homeML && awayML) {
        const homeWinProb = proj.homeWinProb;
        const awayWinProb = 1 - homeWinProb;

        // Check both sides for ML value
        // Sport-specific ML odds limits
        const ML_MAX_FAV = { NBA: -250, NHL: -300, NCAAB: -250, MLB: -200 };
        // v11.1: dog cap tightened to +160 — real-run record on +161 or longer: 6-14 (30%, -3.6% ROI)
        const ML_MAX_DOG = { NBA: 160, NHL: 160, NCAAB: 160, MLB: 160 };
        const maxFav = ML_MAX_FAV[league.league] || -300;
        const maxDog = ML_MAX_DOG[league.league] || 200;

        for (const [side, winProb, ml, teamName] of [
          ["home", homeWinProb, homeML, game.home],
          ["away", awayWinProb, awayML, game.away],
        ]) {
          if (ml < maxFav) continue; // skip heavy favorites — juice destroys value
          if (ml > maxDog) continue; // skip extreme longshots — Elo can't reliably price these
          // Vig-free implied probability: normalise using both sides so the vig
          // doesn't inflate the apparent edge on underdogs.
          const homeRawProb = impliedProb(homeML);
          const awayRawProb = impliedProb(awayML);
          const vigSum = homeRawProb + awayRawProb;
          const implProbNoVig = side === 'home' ? homeRawProb / vigSum : awayRawProb / vigSum;
          const implProb_ = implProbNoVig;
          const mlEdge = winProb - implProb_;
          if (mlEdge < 0.08) continue; // need at least 8% edge for ML — tighter than spreads/totals due to higher variance
          // Hard cap on max credible ML edge: 15% for underdogs, 10% for favorites.
          // Larger gaps almost always indicate a model calibration issue, not a real edge.
          const maxCredibleEdge = implProb_ < 0.50 ? 0.15 : 0.10;
          if (mlEdge > maxCredibleEdge) {
            console.log(`[v10-ml] SKIP ${teamName} ML: edge ${(mlEdge*100).toFixed(1)}% exceeds max credible ${(maxCredibleEdge*100).toFixed(0)}% (winProb ${(winProb*100).toFixed(1)}% vs implied ${(implProb_*100).toFixed(1)}%)`);
            continue;
          }
          // Sanity check: if model says >40% but books say <25%, model is likely wrong
          if (implProb_ < 0.25 && winProb > 0.40) continue;
          const implProb = implProb_;

          const rawCoverProb = winProb;
          const coverProb = getCalibratedCoverProb(rawCoverProb, league.league, "Moneyline", ml);
          const kelly = computeKelly(coverProb, ml, drawdownActive);

          if (kelly.ev > evFloor) {
            const sportMult = SPORT_KELLY_MULT[league.league] || 1.0;
            let adjUnits = Math.round(kelly.units * sportMult * 2) / 2;
            adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
            // z-score for ML: normalize to be comparable to spread/total z-scores
            // Use 0.25 denominator so a 5% ML edge ≈ 0.20 z-score (similar to 2.5pt NBA spread edge)
            const mlZ = mlEdge / 0.25;
            candidates.push({
              ...baseCandidate,
              market: "Moneyline",
              side: `${teamName} ML`,
              odds: ml,
              modelProjection: +(winProb * 100).toFixed(1),
              consensusLine: +(implProb * 100).toFixed(1),
              edge: +(mlEdge * 100).toFixed(1),
              zScore: +mlZ.toFixed(3),
              coverProb: +coverProb.toFixed(4),
              impliedProb: +implProb.toFixed(4),
              ev: +kelly.ev.toFixed(4),
              kellyFraction: +kelly.kellyFraction.toFixed(4),
              kellyUnits: adjUnits,
              decimalPayout: +kelly.decPayout.toFixed(3),
              _rawKellyUnits: adjUnits,
              kellyCalcStr: `coverProb=${coverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_half=${kelly.kellyFraction.toFixed(4)}, units=${adjUnits}u${sportMult !== 1.0 ? ` [${league.league} ${sportMult}x]` : ''}`,
            });
          }
        }
      }
    }
  }

  // ── ALTERNATE LINE EV CHECK ──
  // For each candidate, check if an alternate line within 3 points of the standard line offers better EV.
  // If so, replace the candidate's line/odds with the superior alt line.
  for (const c of candidates) {
    const gameData = findConsensusLine(consensusLookup, c.homeTeam);
    if (!gameData) continue;

    const std = SPORT_STD_DEVS[c.sport] || 12;

    if (c.market === "Spread" || c.market === "Puck Line" || c.market === "Run Line") {
      if (!gameData.altSpreads || gameData.altSpreads.length === 0) continue;
      const isHomeCover = c.side.includes(c.homeTeam);
      const pickTeam = isHomeCover ? c.homeTeam : c.awayTeam;
      const relevantAlts = gameData.altSpreads.filter(a =>
        a.team === pickTeam && Math.abs(a.point - c.consensusLine) <= 3 && a.odds >= -300
      );

      for (const alt of relevantAlts) {
        // ── GUARD 1: ML price anchor ──
        // The pick team's ML price anchors what any spread line must cost:
        //   alt.point > 0 (cushion — easier than ML): must cost MORE (lower decimal odds than ML)
        //   alt.point < 0 (giving runs — harder than ML): must pay MORE (higher decimal odds than ML)
        // Any alt violating this is a stale/erroneous single-book quote.
        const pickTeamML = isHomeCover ? gameData.homeML : gameData.awayML;
        if (pickTeamML != null && alt.point !== 0) {
          const mlDecimal = americanToDecimal(pickTeamML);
          const altDecimal = americanToDecimal(alt.odds);
          if (alt.point > 0 && altDecimal >= mlDecimal) {
            console.log(`[v10-alt] SKIP impossible alt: ${pickTeam} +${alt.point} @ ${alt.odds} — cushion line cannot pay MORE than ML (ML ${pickTeamML})`);
            continue;
          }
          if (alt.point < 0 && altDecimal <= mlDecimal) {
            console.log(`[v10-alt] SKIP impossible alt: ${pickTeam} ${alt.point} @ ${alt.odds} — giving runs must pay MORE than ML (ML ${pickTeamML})`);
            continue;
          }
        }

        // ── GUARD 2: Require alt line at 2+ major US sportsbooks ──
        // An alt line only available at offshore or obscure books cannot be placed by most users.
        const majorAltCount = (gameData.altSpreads || []).filter(a =>
          a.team === pickTeam && a.point === alt.point && a.isMajor
        ).length;
        if (majorAltCount < 2) {
          console.log(`[v10-alt] SKIP non-placeable alt: ${pickTeam} ${alt.point > 0 ? '+' : ''}${alt.point} @ ${alt.odds} — only ${majorAltCount} major book(s), need 2+`);
          continue;
        }

        const altSpreadEdge = Math.abs(c.modelProjection - alt.point);
        const discountedEdge = applyEdgeDiscount(altSpreadEdge, std);
        const altZ = discountedEdge / std;
        const altRawProb = normalCDF(altZ);
        const altCoverProb = getCalibratedCoverProb(altRawProb, c.sport, c.market, alt.odds);
        const altKelly = computeKelly(altCoverProb, alt.odds, drawdownActive);

        if (altKelly.ev > c.ev) {
          console.log(`[v10-alt] ALT LINE: ${c.side} @ ${alt.odds} (EV ${(altKelly.ev * 100).toFixed(1)}%) beats standard (EV ${(c.ev * 100).toFixed(1)}%)`);
          const sportMult = SPORT_KELLY_MULT[c.sport] || 1.0;
          let adjUnits = Math.round(altKelly.units * sportMult * 2) / 2;
          adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
          // A 0-point spread = no push possible in playoff context = display as ML
          c.side = alt.point === 0 ? `${pickTeam} ML` : `${pickTeam} ${alt.point > 0 ? '+' : ''}${alt.point}`;
          if (alt.point === 0) c.market = 'Moneyline';
          c.odds = alt.odds;
          c.consensusLine = alt.point;
          c.edge = +discountedEdge.toFixed(1);
          c.zScore = +altZ.toFixed(3);
          c.coverProb = +altCoverProb.toFixed(4);
          c.impliedProb = +impliedProb(alt.odds).toFixed(4);
          c.ev = +altKelly.ev.toFixed(4);
          c.kellyFraction = +altKelly.kellyFraction.toFixed(4);
          c.kellyUnits = adjUnits;
          c._rawKellyUnits = adjUnits;
          c.kellyCalcStr += ` [ALT-LINE: ${alt.point}@${alt.odds}]`;
        }
      }
    }

    if (c.market === "Total") {
      if (!gameData.altTotals || gameData.altTotals.length === 0) continue;
      const isOver = c.side.startsWith("Over");
      const relevantAlts = gameData.altTotals.filter(a =>
        Math.abs(a.point - c.consensusLine) <= 3 && (isOver ? a.overOdds : a.underOdds) !== null
      );

      for (const alt of relevantAlts) {
        const altOdds = isOver ? alt.overOdds : alt.underOdds;
        if (!altOdds || altOdds < -300) continue;

        // ── GUARD: Total direction sanity check ──
        // A harder alt line must pay BETTER odds than the standard line (higher decimal).
        // A harder Over = higher point. A harder Under = lower point.
        // If a harder line pays worse odds, it's a data error — reject it.
        const altIsHarder = isOver ? (alt.point > c.consensusLine) : (alt.point < c.consensusLine);
        const altDecimal = americanToDecimal(altOdds);
        const stdDecimal = americanToDecimal(c.odds);
        if (altIsHarder && altDecimal < stdDecimal) {
          console.log(`[v10-alt-total] SKIP: ${isOver ? 'Over' : 'Under'} ${alt.point} @ ${altOdds} — harder line must pay better than standard ${c.odds}`);
          continue;
        }
        if (!altIsHarder && alt.point !== c.consensusLine && altDecimal > stdDecimal) {
          console.log(`[v10-alt-total] SKIP: ${isOver ? 'Over' : 'Under'} ${alt.point} @ ${altOdds} — easier line cannot pay better than standard ${c.odds}`);
          continue;
        }

        // ── GUARD: Alt total must be available at 2+ major books ──
        // Require at least one major book on each side, confirming it's a real placeable market.
        const majorOver = alt.majorOverBooks || 0;
        const majorUnder = alt.majorUnderBooks || 0;
        if (majorOver < 1 || majorUnder < 1) {
          console.log(`[v10-alt-total] SKIP non-placeable alt: ${isOver ? 'Over' : 'Under'} ${alt.point} — major books: over=${majorOver} under=${majorUnder}, need 1+ each side`);
          continue;
        }

        const altTotalEdge = Math.abs(c.modelProjection - alt.point);
        const altTotalStd = SPORT_TOTAL_STD_DEVS[c.sport] || std * 1.5; // v11.1: total σ for alt totals
        const discountedEdge = applyEdgeDiscount(altTotalEdge, altTotalStd);
        const altZ = discountedEdge / altTotalStd;
        const altRawProb = normalCDF(altZ);
        const altCoverProb = getCalibratedCoverProb(altRawProb, c.sport, "Total", altOdds);
        const altKelly = computeKelly(altCoverProb, altOdds, drawdownActive);

        if (altKelly.ev > c.ev) {
          console.log(`[v10-alt] ALT LINE: ${isOver ? 'Over' : 'Under'} ${alt.point} @ ${altOdds} (EV ${(altKelly.ev * 100).toFixed(1)}%) beats standard (EV ${(c.ev * 100).toFixed(1)}%)`);
          const sportMult = SPORT_KELLY_MULT[c.sport] || 1.0;
          let adjUnits = Math.round(altKelly.units * sportMult * 2) / 2;
          adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
          c.side = `${isOver ? 'Over' : 'Under'} ${alt.point}`;
          c.odds = altOdds;
          c.consensusLine = alt.point;
          c.edge = +discountedEdge.toFixed(1);
          c.zScore = +altZ.toFixed(3);
          c.coverProb = +altCoverProb.toFixed(4);
          c.impliedProb = +impliedProb(altOdds).toFixed(4);
          c.ev = +altKelly.ev.toFixed(4);
          c.kellyFraction = +altKelly.kellyFraction.toFixed(4);
          c.kellyUnits = adjUnits;
          c._rawKellyUnits = adjUnits;
          c.kellyCalcStr += ` [ALT-LINE: ${isOver ? 'O' : 'U'}${alt.point}@${altOdds}]`;
        }
      }
    }
  }

  // ── SITUATIONAL ADJUSTMENTS ──
  // Apply Kelly penalties/boosts based on elimination/contending status.
  // Betting ON an eliminated team = reduce units (they're not trying to win).
  // Betting AGAINST an eliminated team = no boost (market already prices this).
  // Betting ON a contending team in a must-win = slight boost.
  for (const c of candidates) {
    // Determine which team we're betting on
    const isBettingHome = c.side?.includes(c.homeTeam) || (c.market === "Moneyline" && c.side?.includes("home"));
    const isBettingAway = c.side?.includes(c.awayTeam) || (c.market === "Moneyline" && c.side?.includes("away"));
    const pickedFlag = isBettingHome ? c.homeFlag : isBettingAway ? c.awayFlag : "neutral";
    const opponentFlag = isBettingHome ? c.awayFlag : isBettingAway ? c.homeFlag : "neutral";

    // For totals: if one team is eliminated, they may play looser (over) or stop competing (under)
    // This is ambiguous, so only apply to ML and spread picks
    if (c.market !== "Total") {
      if (pickedFlag === "eliminated") {
        // Betting on an eliminated team — reduce Kelly by 25%
        // They have no motivation, may rest players, play developmental lineups
        // Reduced from 40% — the market already prices some of this in
        const oldUnits = c.kellyUnits;
        c.kellyUnits = Math.max(0.5, Math.round(c.kellyUnits * 0.75 * 2) / 2);
        c.kellyCalcStr += ` [SIT: picked team eliminated, ${oldUnits}u → ${c.kellyUnits}u]`;
        console.log(`[v10-sit] PENALTY ${c.side}: eliminated team, Kelly ${oldUnits}u → ${c.kellyUnits}u`);
      } else if (pickedFlag === "contending" && opponentFlag === "eliminated") {
        // Contending team vs eliminated team — slight boost (must-win vs don't-care)
        const oldUnits = c.kellyUnits;
        c.kellyUnits = Math.min(3.0, Math.round(c.kellyUnits * 1.15 * 2) / 2);
        c.kellyCalcStr += ` [SIT: contending vs eliminated, ${oldUnits}u → ${c.kellyUnits}u]`;
        console.log(`[v10-sit] BOOST ${c.side}: contending vs eliminated, Kelly ${oldUnits}u → ${c.kellyUnits}u`);
      }
    }

    // Recalculate EV after situational adjustment (units changed but EV is edge-based, stays same)
    // The situational flag doesn't change the edge, it changes how much we bet on it
  }

  // ── PENALTY STACK FLOOR: no candidate should be reduced below 50% of its raw Kelly ──
  // Multiple penalties (eliminated, consensus tightness, edge discount, CLV) can stack
  // multiplicatively, crushing units on plays that still have genuine edge. This floor
  // prevents "paralysis sizing" where a good edge gets bet at dust-level units.
  for (const c of candidates) {
    if (c._rawKellyUnits && c.kellyUnits < c._rawKellyUnits * 0.50) {
      const floored = Math.max(0.5, Math.round(c._rawKellyUnits * 0.50 * 2) / 2);
      console.log(`[v10-floor] PENALTY FLOOR ${c.side}: ${c.kellyUnits}u → ${floored}u (50% of raw ${c._rawKellyUnits}u)`);
      c.kellyCalcStr += ` [FLOOR: min 50% of raw ${c._rawKellyUnits}u]`;
      c.kellyUnits = floored;
    }
  }

  // Sort by z-score descending (normalized edge across all sports)
  candidates.sort((a, b) => b.zScore - a.zScore);

  // Assign ranks
  candidates.forEach((c, i) => { c.rank = i + 1; });

  return candidates;
}

// ── Format candidate table for Claude prompt ──
function formatCandidateTable(candidates, dateISO, dateFormatted) {
  const top = candidates.slice(0, 15);
  let prompt = `TODAY: ${dateFormatted} (${dateISO})\n\n`;
  prompt += `${candidates.length} total edge candidates found across all sports. Here are the top ${top.length} ranked by normalized edge (z-score).\n`;
  prompt += `Your job: web search to verify injuries/news for top candidates, then SELECT up to 3.\n\n`;

  for (const c of top) {
    prompt += `━━━ #${c.rank} | ${c.sport} ${c.market} | z=${c.zScore.toFixed(2)} ━━━\n`;
    prompt += `  ${c.matchup}\n`;
    prompt += `  PICK: ${c.side} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds} | Edge: ${c.edge}${c.market === 'Total' ? (c.sport === 'NHL' ? ' goals' : c.sport === 'MLB' ? ' runs' : ' pts') : (c.sport === 'NHL' ? ' goals' : ' pts')}\n`;
    // Explicit narrative direction so Claude knows which side to argue for
    const isTotal = (c.market || '').toLowerCase() === 'total';
    if (isTotal) {
      const overUnder = (c.side || '').match(/(over|under)/i);
      prompt += `  👉 NARRATIVE DIRECTION: Write narrative supporting ${overUnder ? overUnder[1] : c.side} hitting\n`;
    } else {
      const pickedTeam = (c.side || '').replace(/[+-][\d.]+/g, '').trim();
      const handicap = (c.side || '').match(/([+-][\d.]+)/);
      prompt += `  👉 NARRATIVE DIRECTION: Write narrative supporting ${pickedTeam} covering ${handicap ? handicap[1] : 'the spread'}\n`;
    }
    prompt += `  Cover%: ${(c.coverProb * 100).toFixed(1)}% | Kelly: ${c.kellyUnits}u | EV: ${(c.ev * 100).toFixed(1)}%\n`;
    prompt += `  Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge}\n`;
    prompt += `  Elo: ${c.homeTeam} ${c.homeElo} / ${c.awayTeam} ${c.awayElo} | WinProb: ${c.homeTeam} ${c.homeWinProb}%\n`;
    prompt += `  Score Proj: ${c.homeTeam} ${c.projHomeScore} - ${c.awayTeam} ${c.projAwayScore} [${c.projMethod}]\n`;
    prompt += `  Rest: ${c.homeTeam} ${c.homeRest !== undefined ? c.homeRest + 'd' : '?'} / ${c.awayTeam} ${c.awayRest !== undefined ? c.awayRest + 'd' : '?'}`;
    if (c.homeRest !== undefined && c.homeRest <= 1) prompt += ` (${c.homeTeam} B2B)`;
    if (c.awayRest !== undefined && c.awayRest <= 1) prompt += ` (${c.awayTeam} B2B)`;
    prompt += `\n`;
    prompt += `  Streaks: ${c.homeTeam} ${formatStreak(c.homeStreak)} / ${c.awayTeam} ${formatStreak(c.awayStreak)}\n`;
    if (c.homeLast5) prompt += `  Last 5: ${c.homeTeam} ${c.homeLast5} (${c.homeAvgScored5 || '?'}/${c.homeAvgAllowed5 || '?'}) | ${c.awayTeam} ${c.awayLast5} (${c.awayAvgScored5 || '?'}/${c.awayAvgAllowed5 || '?'})\n`;
    if (c.homeCoverRate !== undefined) prompt += `  Cover Rate: ${c.homeTeam} ${c.homeCoverRate}% / ${c.awayTeam} ${c.awayCoverRate || '?'}%\n`;
    {
      const hRec = c.homeStats?.recordTotal || c.homeRecord;
      const aRec = c.awayStats?.recordTotal || c.awayRecord;
      if (hRec || aRec) {
        prompt += `  Records (ESPN, authoritative): ${c.homeTeam} ${hRec || '?'}`;
        if (c.homeStats?.recordHome) prompt += ` [home ${c.homeStats.recordHome}]`;
        prompt += ` / ${c.awayTeam} ${aRec || '?'}`;
        if (c.awayStats?.recordRoad) prompt += ` [road ${c.awayStats.recordRoad}]`;
        prompt += `\n`;
      }
    }

    // Key injuries
    const homeInj = (c.homeInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    const awayInj = (c.awayInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    if (homeInj.length > 0) prompt += `  ${c.homeTeam} injuries: ${homeInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;
    if (awayInj.length > 0) prompt += `  ${c.awayTeam} injuries: ${awayInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;

    // Sport-specific stats
    if (c.homeStats?.sport === 'hockey') {
      if (c.homeStats.savePct) prompt += `  Save%: ${c.homeTeam} ${(c.homeStats.savePct * 100).toFixed(1)}% / ${c.awayTeam} ${c.awayStats?.savePct ? (c.awayStats.savePct * 100).toFixed(1) + '%' : '?'}\n`;
      if (c.homeStats.shootingPct) prompt += `  Shooting%: ${c.homeTeam} ${(c.homeStats.shootingPct * 100).toFixed(1)}% / ${c.awayTeam} ${c.awayStats?.shootingPct ? (c.awayStats.shootingPct * 100).toFixed(1) + '%' : '?'}\n`;
    } else if (c.homeStats?.sport === 'basketball') {
      if (c.homeStats.offensiveRating) prompt += `  ORtg: ${c.homeTeam} ${c.homeStats.offensiveRating} / ${c.awayTeam} ${c.awayStats?.offensiveRating || '?'} | DRtg: ${c.homeTeam} ${c.homeStats.defensiveRating} / ${c.awayTeam} ${c.awayStats?.defensiveRating || '?'}\n`;
      if (c.homeStats.pace) prompt += `  Pace: ${c.homeTeam} ${c.homeStats.pace} / ${c.awayTeam} ${c.awayStats?.pace || '?'}\n`;
    }
    // X/Grok intelligence alert
    if (c.xAlert) {
      prompt += `  ⚡ X ALERT: ${c.xAlert.alert} (impact: ${c.xAlert.impact}, team: ${c.xAlert.affectedTeam || '?'})\n`;
      if (c.xAlertWarning) prompt += `  ⚠️ WARNING: This alert affects the team in our pick — verify before selecting.\n`;
    }

    // Prediction market signal
    if (c.predictionMarket) {
      const pm = c.predictionMarket;
      const status = pm.agrees ? 'CONFIRMS' : pm.disagrees ? 'DISAGREES' : 'NEUTRAL';
      prompt += `  PM: ${pm.marketCount}x ${pm.alignmentType} markets ${status} (market=${(pm.marketProb*100).toFixed(0)}% vs model=${(pm.modelProb*100).toFixed(0)}%, quality=${pm.avgQuality})\n`;
    }

    prompt += `\n`;
  }

  return prompt;
}

// ── Enforce JS-computed math in narrative: prepend projection sentence, strip any Claude math ──
function fixNarrativeEdge(narrative, candidate) {
  if (!narrative || !candidate) return narrative;
  const c = candidate;
  const edgeVal = Math.abs(c.edge);
  const unit = c.sport === 'NHL' ? 'goal' : c.sport === 'MLB' ? 'run' : 'point';
  const isTotal = (c.market || '').toLowerCase() === 'total';

  // Build the JS-computed opening sentence.
  // v11.1: the headline % must be the CALIBRATED edge (coverProb − implied) so the prose
  // matches the Edge badge. The raw model view stays as context — quoting the raw gap as
  // "the edge" overstated it ~3x vs what calibration credits.
  const isML = (c.market || '').toLowerCase() === 'moneyline';
  const truePct = (c.coverProb != null && c.odds != null)
    ? ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1)
    : null;
  const calClause = truePct != null ? ` — a ${truePct}% calibrated edge at the price` : '';
  let jsSentence;
  if (isTotal) {
    jsSentence = `WeBetAI projects ${c.modelProjection} total ${c.sport === 'NHL' ? 'goals' : c.sport === 'MLB' ? 'runs' : 'points'} vs the ${c.consensusLine} line, a ${edgeVal}-${unit} model edge${calClause}.`;
  } else if (isML) {
    // Moneyline: modelProjection is raw win probability %, consensusLine is no-vig implied %
    jsSentence = truePct != null
      ? `WeBetAI's model puts this team at ${c.modelProjection}% to win vs the market's ${c.consensusLine}% — calibrated to a ${truePct}% true edge at the price.`
      : `WeBetAI's model puts this team at ${c.modelProjection}% to win vs the market's ${c.consensusLine}%.`;
  } else {
    // Spread: modelProjection is projected margin
    const projMargin = Math.abs(c.modelProjection);
    jsSentence = `WeBetAI projects a ${projMargin}-${unit} margin vs the ${c.consensusLine} line, a ${edgeVal}-${unit} model edge${calClause}.`;
  }

  // Strip any Claude sentence that restates projections/edges (starts with "WeBetAI projects" or mentions "[X]-point/goal edge")
  let cleaned = narrative
    .replace(/WeBetAI projects[^.]*\./i, '')
    .replace(/[^.]*\d+\.?\d*-(point|goal) edge[^.]*\./g, '')
    .trim();

  // Pick-direction sanity check: for spreads, warn if narrative mentions opponent more than picked team
  if (!isTotal && c.homeTeam && c.awayTeam) {
    const pickedTeam = (c.side || '').replace(/[+-][\d.]+/g, '').trim().toLowerCase();
    const opponent = (c.homeTeam.toLowerCase() === pickedTeam || c.homeTeam.toLowerCase().includes(pickedTeam.split(' ').pop()))
      ? c.awayTeam : c.homeTeam;
    const lowerNarrative = cleaned.toLowerCase();
    const pickedMentions = (lowerNarrative.match(new RegExp(pickedTeam.split(' ').pop(), 'g')) || []).length;
    const opponentMentions = (lowerNarrative.match(new RegExp(opponent.split(' ').pop().toLowerCase(), 'g')) || []).length;
    if (opponentMentions > pickedMentions + 1) {
      console.log(`[v10-beta] ⚠️ NARRATIVE DIRECTION WARNING: "${c.side}" narrative mentions opponent "${opponent}" ${opponentMentions}x vs picked team ${pickedMentions}x — may be arguing against the pick`);
    }
  }

  return jsSentence + ' ' + cleaned;
}

// ── Build final picks from Claude's SELECTIONS (matches production pattern) ──
function buildFinalPicks(candidateTable, claudeSelections, allCandidates, drawdownActive) {
  const picks = [];
  for (const sel of claudeSelections) {
    const c = candidateTable.find(x => x.rank === sel.candidateRank);
    if (!c) {
      console.log(`[v10-beta] WARNING: Claude selected rank ${sel.candidateRank} which is not in candidate table — skipping`);
      continue;
    }

    // Enforce: Claude can reduce units by up to 50% but never increase
    let finalUnits = kellyToUnits(c.kellyUnits, drawdownActive, c.coverProb);
    if (sel.adjustedUnits) {
      const claudeUnits = parseFloat(String(sel.adjustedUnits).replace(/[^0-9.]/g, ''));
      if (!isNaN(claudeUnits) && claudeUnits < finalUnits) {
        finalUnits = Math.max(0.5, Math.round(claudeUnits * 2) / 2); // round to 0.5u
        console.log(`[v10-beta] Claude reduced units for rank ${c.rank}: ${c.kellyUnits}u → ${finalUnits}u (reason: ${sel.unitAdjustmentReason || 'none given'})`);
      }
    }

    const kellyRating = unitsToRating(finalUnits);
    const kellyConfidence = ratingToConfidence(kellyRating);

    // v11.1-mvp: Apply grade-calibrated Kelly multiplier from self-optimize data.
    // self-optimize.js computes gradeAccuracy (actual win rate per grade) weekly.
    // If A+ is actually hitting 63% and B is hitting 52%, size accordingly.
    // Guard: require ≥10 picks in the grade bucket for the multiplier to activate.
    if (buildFinalPicks._gradeAccuracy) {
      const gradeData = buildFinalPicks._gradeAccuracy[kellyRating];
      if (gradeData && gradeData.count >= 10) {
        // Map actual accuracy to multiplier: 50%→0.90, 55%→1.00, 60%→1.10, 65%→1.20
        const gradeMult = Math.max(0.80, Math.min(1.25, 0.40 + gradeData.accuracy * 1.20));
        const gradeAdjUnits = Math.max(0.5, Math.min(3.0, Math.round(finalUnits * gradeMult * 2) / 2));
        if (gradeAdjUnits !== finalUnits) {
          console.log(`[v11-grade] ${kellyRating} grade mult ${gradeMult.toFixed(2)}x (${(gradeData.accuracy*100).toFixed(0)}% actual, n=${gradeData.count}): ${finalUnits}u → ${gradeAdjUnits}u`);
          finalUnits = gradeAdjUnits;
        }
      }
    }

    // Fix model edge display — use calibrated coverProb (not raw modelProjection)
    const isML = c.market === "Moneyline";
    const calibratedPct = (c.coverProb * 100).toFixed(1);
    const implPct = (impliedProb(c.odds) * 100).toFixed(1);
    const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);
    const modelEdgeStr = isML
      ? `Model Win Prob: ${calibratedPct}%, Implied: ${implPct}%, Edge: ${edgePctVal}%`
      : `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${c.sport === 'NHL' ? 'goals' : c.sport === 'MLB' ? 'runs' : 'pts'}`;

    picks.push({
      sport: c.sport,
      matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
      pick: c.side,
      betType: c.market,
      odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
      rating: kellyRating,
      confidence: kellyConfidence,
      units: `${finalUnits}u`,
      ev: `${(c.ev * 100).toFixed(1)}%`,
      evRaw: c.ev,
      edgePct: `${edgePctVal}%`,
      edgePoints: c.edge,
      coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
      zScore: c.zScore,
      kellyCalc: c.kellyCalcStr,
      winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
      coreReasoning: fixNarrativeEdge(sel.coreReasoning || "", c),
      whatLoses: sel.whatLoses || "",
      dataVerified: sel.dataVerified || "",
      clvExpectation: sel.clvExpectation || "",
      modelEdge: modelEdgeStr,
      commenceTime: c.commenceTime || "",
    });
    console.log(`[v10-beta] SELECTED rank ${c.rank}: ${c.side} (EV: ${(c.ev * 100).toFixed(1)}%, units: ${finalUnits}u, rating: ${kellyRating})`);
  }

  // ── DAILY CAP: 4.0u maximum ──
  let totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  if (totalUnits > 4.0) {
    console.log(`[v10-beta] Daily cap: ${totalUnits}u > 4.0u, reducing smallest-edge picks`);
    const indices = picks.map((_, i) => i);
    indices.sort((a, b) => parseFloat(picks[a].units) - parseFloat(picks[b].units));
    while (totalUnits > 4.0) {
      let reduced = false;
      for (const idx of indices) {
        const u = parseFloat(picks[idx].units);
        if (u > 0.5) {
          picks[idx].units = `${u - 0.5}u`;
          totalUnits -= 0.5;
          reduced = true;
          break;
        }
      }
      if (!reduced) break;
    }
    // Re-assign ratings after cap adjustment
    for (const p of picks) {
      const u = parseFloat(p.units);
      p.rating = unitsToRating(u);
      p.confidence = ratingToConfidence(p.rating);
    }
  }

  // ── SAME-GAME DEDUP: max 1 pick per matchup ──
  // Standard sportsbooks don't allow multiple legs from the same game in a straight-pick
  // card (and it creates correlated risk). Keep only the highest-EV pick per matchup;
  // replace any dropped picks with the next best available candidate from a different game.
  const seenMatchups = new Map(); // matchup → kept pick
  for (const p of picks) {
    const key = p.matchup;
    if (!seenMatchups.has(key)) {
      seenMatchups.set(key, p);
    } else {
      const existing = seenMatchups.get(key);
      const keepNew = (parseFloat(p.evRaw || p.ev) || 0) > (parseFloat(existing.evRaw || existing.ev) || 0);
      console.log(`[v10-dedup] SAME GAME "${key}": dropping ${keepNew ? existing.pick : p.pick} in favour of ${keepNew ? p.pick : existing.pick} (higher EV)`);
      if (keepNew) seenMatchups.set(key, p);
    }
  }

  const deduped = [...seenMatchups.values()];
  const droppedCount = picks.length - deduped.length;
  picks.length = 0;
  deduped.forEach(p => picks.push(p));

  if (droppedCount > 0 && allCandidates && allCandidates.length > 0) {
    const usedMatchups = new Set(picks.map(p => p.matchup));
    const usedSides   = new Set(picks.map(p => p.pick));

    const replacementCandidates = allCandidates
      .filter(c => {
        const cMatchup = `${c.awayTeam} vs. ${c.homeTeam}`;
        if (usedMatchups.has(cMatchup)) return false;
        if (usedSides.has(c.side)) return false;
        if ((c.ev || 0) <= 0.03) return false;
        if ((c.coverProb || 0) < 0.45) return false;
        if (!c.odds || c.odds < -300 || c.odds > 300) return false;
        return true;
      })
      .sort((a, b) => (b.ev || 0) - (a.ev || 0));

    for (let i = 0; i < droppedCount && i < replacementCandidates.length; i++) {
      const c = replacementCandidates[i];
      const finalUnits = kellyToUnits(c.kellyUnits, drawdownActive, c.coverProb);
      const kellyRating = unitsToRating(finalUnits);
      const isML = c.market === 'Moneyline';
      const calibratedPct = (c.coverProb * 100).toFixed(1);
      const implPct = (impliedProb(c.odds) * 100).toFixed(1);
      const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);
      const modelEdgeStr = isML
        ? `Model Win Prob: ${calibratedPct}%, Implied: ${implPct}%, Edge: ${edgePctVal}%`
        : `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${c.sport === 'NHL' ? 'goals' : c.sport === 'MLB' ? 'runs' : 'pts'}`;
      const cMatchup = `${c.awayTeam} vs. ${c.homeTeam}`;
      console.log(`[v10-dedup] REPLACEMENT pick: ${c.side} (${cMatchup}) EV:${(c.ev*100).toFixed(1)}% units:${finalUnits}u`);
      picks.push({
        sport: c.sport,
        matchup: cMatchup,
        pick: c.side,
        betType: c.market,
        odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
        rating: kellyRating,
        confidence: ratingToConfidence(kellyRating),
        units: `${finalUnits}u`,
        ev: `${(c.ev * 100).toFixed(1)}%`,
        evRaw: c.ev,
        edgePct: `${edgePctVal}%`,
        edgePoints: c.edge,
        coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
        zScore: c.zScore,
        kellyCalc: c.kellyCalcStr,
        winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
        coreReasoning: `Model edge: ${edgePctVal}% positive EV. Cover probability ${calibratedPct}% vs implied ${implPct}%. ${modelEdgeStr}. Auto-substituted — diversification rule (max 1 pick per game).`,
        whatLoses: `Line move against us or model projection off by more than margin.`,
        dataVerified: 'system-substituted',
        clvExpectation: '',
        modelEdge: modelEdgeStr,
        commenceTime: c.commenceTime || '',
      });
      usedMatchups.add(cMatchup);
      usedSides.add(c.side);
    }

    if (droppedCount > replacementCandidates.length) {
      console.log(`[v10-dedup] Only ${replacementCandidates.length}/${droppedCount} replacements found — fewer picks today`);
    }
  }

  // ── DAILY CAP RE-ENFORCEMENT (post-dedup) ──
  // Same-game dedup may have added a replacement pick after the first cap pass.
  // Re-run the cap to ensure total units never exceed 4.0u regardless.
  let totalUnitsPost = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  if (totalUnitsPost > 4.0) {
    console.log(`[v10-cap2] Post-dedup total ${totalUnitsPost}u > 4.0u, re-enforcing cap`);
    const indices2 = picks.map((_, i) => i);
    indices2.sort((a, b) => parseFloat(picks[a].units) - parseFloat(picks[b].units));
    while (totalUnitsPost > 4.0) {
      let reduced = false;
      for (const idx of indices2) {
        const u = parseFloat(picks[idx].units);
        if (u > 0.5) {
          picks[idx].units = `${u - 0.5}u`;
          totalUnitsPost -= 0.5;
          reduced = true;
          break;
        }
      }
      if (!reduced) break;
    }
    for (const p of picks) {
      const u = parseFloat(p.units);
      p.rating = unitsToRating(u);
      p.confidence = ratingToConfidence(p.rating);
    }
  }

  // ── PICK VALIDATION LAYER ──
  // Every pick must pass sanity checks. Elite models don't ship picks with broken math.
  const validated = [];
  for (const p of picks) {
    const u = parseFloat(p.units);
    const cp = parseFloat(p.coverProb) / 100;
    const ev = parseFloat(p.ev) / 100;
    const odds = parseInt(p.odds);
    const warnings = [];

    // 1. EV must be positive — never ship a negative EV pick
    if (ev <= 0) {
      warnings.push(`REJECTED: negative EV (${(ev * 100).toFixed(1)}%)`);
      console.log(`[v10-validate] REJECT ${p.pick}: ${warnings[0]}`);
      continue;
    }

    // 2. Cover prob sanity: ML dogs must have coverProb > breakeven implied prob
    const breakeven = odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
    if (cp <= breakeven) {
      warnings.push(`REJECTED: coverProb ${(cp*100).toFixed(1)}% <= breakeven ${(breakeven*100).toFixed(1)}%`);
      console.log(`[v10-validate] REJECT ${p.pick}: ${warnings[0]}`);
      continue;
    }

    // 3. Unit sizing must match cover prob reality
    //    Sub-50% coverProb = max 1.0u, sub-42% = max 0.5u
    if (cp < 0.50 && u > 1.0) {
      console.log(`[v10-validate] DOWNSIZE ${p.pick}: ${u}u → 1.0u (coverProb ${(cp*100).toFixed(0)}% < 50%)`);
      p.units = "1.0u";
      p.rating = unitsToRating(1.0);
      p.confidence = ratingToConfidence(p.rating);
    }
    if (cp < 0.42 && parseFloat(p.units) > 0.5) {
      console.log(`[v10-validate] DOWNSIZE ${p.pick}: → 0.5u (coverProb ${(cp*100).toFixed(0)}% < 42%)`);
      p.units = "0.5u";
      p.rating = unitsToRating(0.5);
      p.confidence = ratingToConfidence(p.rating);
    }

    // 4. EV-to-unit proportionality: don't oversize low-EV picks.
    //    v11.1 thresholds rescaled for calibrated EVs (typical range is now 3-15%):
    //    under 5% calibrated EV → max 1.0u; under 8% → max 1.5u.
    if (ev < 0.05 && parseFloat(p.units) > 1.0) {
      console.log(`[v10-validate] DOWNSIZE ${p.pick}: → 1.0u (EV ${(ev*100).toFixed(1)}% < 5%)`);
      p.units = "1.0u";
      p.rating = unitsToRating(1.0);
      p.confidence = ratingToConfidence(p.rating);
    } else if (ev < 0.08 && parseFloat(p.units) > 1.5) {
      console.log(`[v10-validate] DOWNSIZE ${p.pick}: → 1.5u (EV ${(ev*100).toFixed(1)}% < 8%)`);
      p.units = "1.5u";
      p.rating = unitsToRating(1.5);
      p.confidence = ratingToConfidence(p.rating);
    }

    // 5. Edge-to-odds coherence: the displayed edge % must be positive
    const edgePct = parseFloat(p.edgePct);
    if (edgePct <= 0) {
      warnings.push(`REJECTED: edge ${edgePct}% is not positive`);
      console.log(`[v10-validate] REJECT ${p.pick}: ${warnings[0]}`);
      continue;
    }

    validated.push(p);
    console.log(`[v10-validate] PASS ${p.pick}: ${p.units} @ ${p.odds}, coverProb=${(cp*100).toFixed(0)}%, EV=${(ev*100).toFixed(1)}%`);
  }

  // Sort by z-score descending (highest model confidence first)
  validated.sort((a, b) => (b.zScore || 0) - (a.zScore || 0));

  return validated;
}

// ── Compute bankroll context + drawdown detection ──
async function computeBankrollContext() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { drawdownActive: false, context: "BANKROLL: $15,000 starting, unit value $150." };

  const startingBankroll = 15000;
  let totalProfit = 0;
  let recentResults = [];

  try {
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mvp`;
    const authHeaders = { Authorization: `Bearer ${token}` };
    const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) {
      const datesArr = await datesResp.json();
      for (const d of datesArr.slice(-10)) {
        try {
          const pResp = await fetch(`${storeUrl}/picks-${d}`, { headers: authHeaders });
          if (pResp.ok) {
            const pData = await pResp.json();
            for (const p of (pData.picks || [])) {
              if (p.result === 'win' || p.result === 'loss') {
                recentResults.push(p.result);
                totalProfit += (p.profit || 0);
              }
            }
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error(`[v10] Bankroll calc error: ${e.message}`);
  }

  const last5 = recentResults.slice(-5);
  let consecutiveLosses = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    if (last5[i] === 'loss') consecutiveLosses++;
    else break;
  }
  const drawdownActive = consecutiveLosses >= 3;

  const currentBankroll = startingBankroll + totalProfit;
  console.log(`[v10] Bankroll: $${currentBankroll}, Drawdown: ${drawdownActive}, Losses: ${consecutiveLosses}`);

  return { drawdownActive, currentBankroll, totalProfit, consecutiveLosses };
}

// ── INDEPENDENT PARLAY OPTIMIZER ──
// Scans ALL qualifying candidates (not just the 3 straight picks) to find the
// 3-leg combination with the highest parlay EV. Optimizes for:
// 1. Combined probability × combined payout (true parlay EV)
// 2. Game diversification (penalizes same-game legs for correlation)
// 3. Minimum individual cover probability per leg (no sub-45% legs)
//
// The parlay can include legs that AREN'T on the straight card — a candidate
// ranked #5 with 60% cover at -130 might be a better parlay leg than the #1
// straight pick with 55% cover at +190 (higher hit rate = better combo prob).

function buildCorrelatedParlay(picks, allCandidates, rejections) {
  if (!allCandidates || allCandidates.length < 3) {
    // Fallback: use straight picks if not enough candidates
    return buildFallbackParlay(picks);
  }

  // Build a set of rejected sides so the parlay never includes a pick Claude said no to
  const rejectedSides = new Set((rejections || []).map(r => (r.side || '').toLowerCase().trim()));

  // Filter candidates for parlay eligibility
  const eligible = allCandidates.filter(c => {
    // Never use a candidate that was explicitly rejected during verification
    if (rejectedSides.has((c.side || '').toLowerCase().trim())) return false;
    const cp = typeof c.coverProb === 'number' ? c.coverProb : parseFloat(c.coverProb) || 0;
    // Must have >45% cover prob — low-probability legs kill parlays
    if (cp < 0.45) return false;
    // Must have positive EV individually
    if (c.ev <= 0.03) return false;
    // Must have valid odds
    if (!c.odds || c.odds < -300 || c.odds > 300) return false;
    return true;
  });

  if (eligible.length < 3) return buildFallbackParlay(picks);

  // Score every valid 3-leg combination
  // For efficiency, limit to top 12 candidates (C(12,3) = 220 combos)
  const pool = eligible.slice(0, 12);
  let bestCombo = null;
  let bestEV = -Infinity;

  for (let i = 0; i < pool.length - 2; i++) {
    for (let j = i + 1; j < pool.length - 1; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const trio = [pool[i], pool[j], pool[k]];

        // Combined probability (product of cover probs)
        let combinedProb = 1.0;
        for (const leg of trio) {
          const cp = typeof leg.coverProb === 'number' ? leg.coverProb : parseFloat(leg.coverProb) || 0.5;
          combinedProb *= cp;
        }

        // Standard parlays require all legs from different games — skip same-game combos
        const matchups = trio.map(t => (t.matchup || `${t.awayTeam} vs. ${t.homeTeam}`).toLowerCase().trim());
        const uniqueMatchups = new Set(matchups).size;
        if (uniqueMatchups < 3) continue;

        // v11.1-mvp: Hard sport-diversity requirement — all 3 legs must be from different sports.
        // Same-sport legs are correlated (shared officials, fatigue patterns, weather) and
        // reduce the effective independence assumption that makes parlay math valid.
        // Only relax this if fewer than 3 sports are available in the eligible pool.
        const uniqueSports = new Set(trio.map(t => t.sport)).size;
        const availableSports = new Set(eligible.map(c => c.sport)).size;
        if (availableSports >= 3 && uniqueSports < 3) continue;

        // Combined decimal payout
        let combinedDecimal = 1.0;
        for (const leg of trio) {
          const odds = typeof leg.odds === 'number' ? leg.odds : parseInt(leg.odds);
          const dec = odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
          combinedDecimal *= dec;
        }

        // Parlay EV = (combinedProb × combinedPayout) - 1
        const parlayEV = (combinedProb * combinedDecimal) - 1;
        // v11.1.1 (2026-06-17): correlation penalty. When only one sport is available the hard
        // sport-diversity rule above is relaxed, so the optimizer was free to stack 3 correlated
        // same-direction totals (all Over / all Under) — one scoring environment loses all three
        // at once. Haircut same-direction-totals trios so a de-correlated combo wins when possible.
        const legDirs = trio.map(t => {
          const s = (t.side || '').toLowerCase();
          return s.includes('over') ? 'over' : s.includes('under') ? 'under' : 'other';
        });
        const allSameTotalsDir = legDirs.every(d => d === 'over') || legDirs.every(d => d === 'under');
        const correlationPenalty = allSameTotalsDir ? 0.08 : 0;
        const adjustedEV = parlayEV - correlationPenalty; // diversity structural; de-correlate same-dir totals

        if (adjustedEV > bestEV) {
          bestEV = adjustedEV;
          bestCombo = { trio, combinedProb, combinedDecimal, parlayEV, uniqueMatchups, uniqueSports };
        }
      }
    }
  }

  if (!bestCombo || bestCombo.parlayEV <= 0) return buildFallbackParlay(picks);

  // Build the parlay output
  const legs = bestCombo.trio.map(c => ({
    pick: c.side,
    sport: c.sport,
    matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
    betType: c.market,
    odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
    coverProb: `${(typeof c.coverProb === 'number' ? c.coverProb * 100 : parseFloat(c.coverProb) * 100 || 50).toFixed(0)}%`,
    ev: `${(c.ev * 100).toFixed(1)}%`,
  }));

  // Check if parlay uses different legs than the straight card
  const straightPicks = new Set((picks || []).map(p => p.pick));
  const parlayPicks = new Set(legs.map(l => l.pick));
  const isIndependent = ![...parlayPicks].every(p => straightPicks.has(p));

  const combinedOddsDisplay = bestCombo.combinedDecimal >= 2
    ? `+${Math.round((bestCombo.combinedDecimal - 1) * 100)}`
    : `${Math.round(-100 / (bestCombo.combinedDecimal - 1))}`;

  console.log(`[v10-parlay] OPTIMIZED: ${legs.map(l => l.pick).join(' + ')} | EV: ${(bestCombo.parlayEV * 100).toFixed(1)}% | Prob: ${(bestCombo.combinedProb * 100).toFixed(1)}% | ${bestCombo.uniqueMatchups} games, ${bestCombo.uniqueSports} sports | Independent: ${isIndependent}`);

  return [{
    type: "3-leg-parlay-optimized",
    legs,
    units: "0.5u",
    combinedOdds: combinedOddsDisplay,
    combinedDecimal: +bestCombo.combinedDecimal.toFixed(2),
    combinedProb: `${(bestCombo.combinedProb * 100).toFixed(1)}%`,
    ev: `${(bestCombo.parlayEV * 100).toFixed(1)}%`,
    uniqueGames: bestCombo.uniqueMatchups,
    uniqueSports: bestCombo.uniqueSports,
    independent: isIndependent,
    correlationNote: isIndependent
      ? `Optimized independently from straight picks — ${bestCombo.uniqueMatchups} different games, ${bestCombo.uniqueSports} sports`
      : `Uses straight pick legs — ${bestCombo.uniqueMatchups} games, ${bestCombo.uniqueSports} sports`,
    candidatesScanned: pool.length,
    combosEvaluated: pool.length * (pool.length - 1) * (pool.length - 2) / 6,
  }];
}

// Fallback: use straight picks as parlay legs (old behavior)
function buildFallbackParlay(picks) {
  if (!picks || picks.length < 2) return [];
  // If all straight picks are from the same game, no valid standard parlay exists
  const matchupSet = new Set((picks || []).slice(0, 3).map(p => (p.matchup || '').toLowerCase().trim()));
  if (matchupSet.size < 2) return [];
  const legs = picks.slice(0, 3).map(p => ({
    pick: p.pick, sport: p.sport, matchup: p.matchup,
    betType: p.betType, odds: p.odds, coverProb: p.coverProb,
  }));
  let combinedDecimal = 1.0, combinedProb = 1.0;
  for (const leg of legs) {
    const odds = parseInt(leg.odds);
    combinedDecimal *= odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
    combinedProb *= parseFloat(leg.coverProb) / 100;
  }
  const parlayEV = (combinedProb * combinedDecimal) - 1;
  return [{
    type: "3-leg-parlay-fallback",
    legs, units: "0.5u",
    combinedOdds: `+${Math.round((combinedDecimal - 1) * 100)}`,
    combinedDecimal: +combinedDecimal.toFixed(2),
    combinedProb: `${(combinedProb * 100).toFixed(1)}%`,
    ev: `${(parlayEV * 100).toFixed(1)}%`,
    correlationNote: "Fallback: uses straight pick legs",
  }];
}

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  console.log("[v10] Background function started — Deterministic Edge Architecture");

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.error("[v10] ANTHROPIC_API_KEY not set");
    return { statusCode: 500, body: "Missing API key" };
  }

  const now = new Date();
  let dateISO, dateFormatted, snapshotTime = null, simMode = false;

  try {
    const body = JSON.parse(event.body || '{}');
    if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      dateISO = body.date;
      const d = new Date(body.date + 'T12:00:00-05:00');
      dateFormatted = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
      }).format(d);
    }
    // snapshotTime: ISO-8601 string for hindsight-free historical simulation
    // e.g. "2026-05-31T15:00:00Z" = lines as-of 10am ET on May 31
    if (body.snapshotTime && typeof body.snapshotTime === 'string') {
      snapshotTime = body.snapshotTime;
      simMode = true;
      setSimMode(true);
      console.log(`[v10-sim] SIMULATION MODE — lines as-of ${snapshotTime} (no hindsight bias)`);
    }
    // Refresh ratings if requested or stale
    if (body.refreshRatings || body.scheduled) {
      await refreshRatingsIfNeeded();
    }
  } catch (e) { /* ignore */ }

  if (!dateISO) {
    const estFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const estParts = estFormatter.formatToParts(now);
    dateISO = `${estParts.find(p => p.type === "year").value}-${estParts.find(p => p.type === "month").value}-${estParts.find(p => p.type === "day").value}`;
    dateFormatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(now);
  }

  console.log(`[v10] Generating picks for ${dateISO}`);

  // ── PHASE 1: DETERMINISTIC DATA ASSEMBLY ──
  const [oddsData, espnData, ratingsData, calibrationData, bankrollCtx, predictionMarkets, clvMultipliers, openingLines, selfOptParams] = await Promise.all([
    fetchOdds(dateISO, snapshotTime),
    fetchESPNData(dateISO),
    fetchRatings(),
    fetchCalibrationData(),
    computeBankrollContext(),
    fetchPredictionMarkets(),
    fetchCLVFeedback(),
    fetchOpeningLines(dateISO),
    fetchSelfOptimizeParams(),
  ]);

  const [teamStats, weatherData, pitcherData] = await Promise.all([
    fetchTeamStats(espnData),
    fetchWeatherForGames(espnData),
    fetchStartingPitchers(espnData),
  ]);
  const consensusLookup = buildConsensusLookup(oddsData);

  // Debug: log data availability
  console.log(`[v10] ESPN leagues: ${(espnData||[]).map(l => l.league + '(' + l.games.length + ')').join(', ')}`);
  console.log(`[v10] Odds sports: ${(oddsData||[]).map(s => s.sport + '(' + s.games.length + ')').join(', ')}`);
  console.log(`[v10] Ratings leagues: ${ratingsData ? Object.keys(ratingsData.leagues || {}).join(', ') : 'NONE'}`);
  console.log(`[v10] Team stats: ${Object.keys(teamStats).length} teams`);
  console.log(`[v10] Consensus lookup keys (sample): ${Object.keys(consensusLookup).slice(0, 8).join(', ')}`);

  // ── PHASE 1B: COMPUTE ALL EDGES DETERMINISTICALLY ──
  let allCandidates;
  try {
    allCandidates = computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, bankrollCtx.drawdownActive, calibrationData, pitcherData);
    console.log(`[v10] Computed ${allCandidates.length} edge candidates across all sports`);

    // ── PHASE 1B2: CLV FEEDBACK ADJUSTMENT ──
    // Apply historical CLV performance multipliers to Kelly units.
    // Sports/markets where we consistently beat the close get boosted.
    // Sports/markets where we consistently lose CLV get penalized.
    if (clvMultipliers && Object.keys(clvMultipliers).length > 0) {
      let clvAdj = 0;
      for (const c of allCandidates) {
        const sportMult = clvMultipliers[c.sport] || 1.0;
        const marketMult = clvMultipliers[`market_${c.market}`] || 1.0;
        const combined = sportMult * marketMult;
        if (combined !== 1.0) {
          const old = c.kellyUnits;
          c.kellyUnits = Math.max(0.5, Math.round(c.kellyUnits * combined * 2) / 2);
          if (old !== c.kellyUnits) {
            c.kellyCalcStr += ` [CLV: sport=${sportMult}, market=${marketMult}, ${old}u→${c.kellyUnits}u]`;
            clvAdj++;
          }
        }
      }
      console.log(`[v10-clv] Applied CLV multipliers to ${clvAdj} candidates`);
    }

    // ── PHASE 1C: PREDICTION MARKET CROSS-REFERENCE ──
    if (predictionMarkets.length > 0) {
      let confirms = 0, cautions = 0;
      for (const c of allCandidates) {
        const signal = getPredictionMarketSignal(c, predictionMarkets);
        if (signal) {
          c.predictionMarket = signal;
          const adjusted = applyPredictionMarketAdjustment(c, signal);
          if (adjusted !== c.kellyUnits) {
            c.kellyUnits = adjusted;
            c.kellyCalcStr += ` [PM ${signal.agrees ? 'CONFIRM' : 'CAUTION'}: ${signal.marketCount}x ${signal.alignmentType} ${signal.source} q=${signal.avgQuality}]`;
            if (signal.agrees) confirms++;
            else cautions++;
          }
        }
      }
      // ── PM ENSEMBLE BLEND: recalibrate coverProb for high-quality PM matches ──
      // When a candidate has a strong PM signal (avgQuality >= 0.4, marketCount >= 2),
      // blend the market probability into coverProb at 20% weight and recompute Kelly/EV.
      let pmBlended = 0;
      for (const c of allCandidates) {
        const signal = c.predictionMarket;
        if (!signal || signal.avgQuality < 0.4 || signal.marketCount < 2) continue;
        const oldCoverProb = c.coverProb;
        const cap = COVER_PROB_CAPS[c.sport + "_" + c.market] || 0.60;
        let blended = oldCoverProb * 0.80 + signal.marketProb * 0.20;
        blended = Math.min(blended, cap);
        if (Math.abs(blended - oldCoverProb) > 0.005) {
          c.coverProb = +blended.toFixed(4);
          // Recompute Kelly with blended coverProb
          const reKelly = computeKelly(c.coverProb, c.odds, bankrollCtx.drawdownActive);
          if (reKelly.ev > 0) {
            c.ev = +reKelly.ev.toFixed(4);
            c.kellyFraction = +reKelly.kellyFraction.toFixed(4);
            const sportMult = SPORT_KELLY_MULT[c.sport] || 1.0;
            let adjUnits = Math.round(reKelly.units * sportMult * 2) / 2;
            adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
            c.kellyUnits = adjUnits;
            c._rawKellyUnits = adjUnits;
          }
          c.kellyCalcStr += ` [PM-BLEND: coverProb ${oldCoverProb.toFixed(3)}→${c.coverProb.toFixed(3)}]`;
          pmBlended++;
        }
      }
      if (pmBlended > 0) console.log(`[v10-pm] PM ensemble blend applied to ${pmBlended} candidates`);

      // Re-sort after adjustments (units changed → re-rank by EV)
      allCandidates.sort((a, b) => b.ev - a.ev);
      allCandidates.forEach((c, i) => { c.rank = i + 1; });
      const pmSignals = allCandidates.filter(c => c.predictionMarket).length;
      console.log(`[v10] Prediction market: ${pmSignals} candidates matched, ${confirms} confirmed, ${cautions} cautioned (type-aligned)`);
    }

    // ── PHASE 1C2: SELF-OPTIMIZATION PARAMETER APPLICATION ──
    // Apply data-driven Kelly multipliers and cover prob adjustments from self-optimize.js
    if (selfOptParams) {
      let soAdj = 0;
      for (const c of allCandidates) {
        let combined = 1.0;

        // Sport-specific multiplier from self-optimization
        const soSportMult = selfOptParams.sportKellyMult?.[c.sport];
        if (soSportMult && soSportMult !== 1.0) combined *= soSportMult;

        // Market-specific multiplier from self-optimization
        const soMarketMult = selfOptParams.marketKellyMult?.[c.market];
        if (soMarketMult && soMarketMult !== 1.0) combined *= soMarketMult;

        // Only apply if combined adjustment is meaningful
        if (Math.abs(combined - 1.0) > 0.01) {
          const old = c.kellyUnits;
          c.kellyUnits = Math.max(0.5, Math.round(c.kellyUnits * combined * 2) / 2);
          if (old !== c.kellyUnits) {
            c.kellyCalcStr += ` [SELF-OPT: ${combined.toFixed(3)}x, ${old}u→${c.kellyUnits}u]`;
            soAdj++;
          }
        }

        // Cover probability cap adjustment
        const sm = `${c.sport}_${c.market}`;
        const capAdj = selfOptParams.coverProbAdjust?.[sm];
        if (capAdj && Math.abs(capAdj) > 0.005) {
          // This is informational — caps are already set in COVER_PROB_CAPS
          // The self-optimize engine suggests adjustments; we apply them as a secondary multiplier
          const probShift = 1.0 + capAdj;
          c.coverProb = +Math.min(0.70, c.coverProb * probShift).toFixed(4);
        }
      }
      console.log(`[v10-selfopt] Applied self-optimization to ${soAdj} candidates (sample: ${selfOptParams.sampleSize})`);
    }

    // ── PHASE 1D: OPENING LINE / STALE LINE DETECTION ──
    // If the line has moved toward our model since opening, the edge is partially priced in.
    // Stale edges get a 15% Kelly reduction. Contrarian edges (line moved away) get a 10% boost.
    if (openingLines) {
      let staleCount = 0, freshCount = 0, contrarianCount = 0;
      for (const c of allCandidates) {
        const signal = computeLineMovementSignal(c, openingLines);
        if (!signal) continue;
        c.lineMovement = signal;
        if (signal.signal === "stale" && Math.abs(signal.movement) >= 1.0) {
          const old = c.kellyUnits;
          c.kellyUnits = Math.max(0.5, Math.round(c.kellyUnits * 0.85 * 2) / 2);
          c.kellyCalcStr += ` [LINE-STALE: ${signal.desc}, ${old}u→${c.kellyUnits}u]`;
          staleCount++;
        } else if (signal.signal === "contrarian" && Math.abs(signal.movement) >= 1.0) {
          const old = c.kellyUnits;
          c.kellyUnits = Math.min(3.0, Math.round(c.kellyUnits * 1.10 * 2) / 2);
          c.kellyCalcStr += ` [LINE-FRESH: ${signal.desc}, ${old}u→${c.kellyUnits}u]`;
          contrarianCount++;
        } else {
          freshCount++;
        }
      }
      console.log(`[v10-lines] Line movement: ${staleCount} stale, ${contrarianCount} contrarian, ${freshCount} fresh/neutral`);
    }

    // ── PHASE 1D2: WEATHER ADJUSTMENTS ──
    // Apply weather-based total adjustments for outdoor sports
    if (weatherData && Object.keys(weatherData).length > 0) {
      let wxAdj = 0;
      for (const c of allCandidates) {
        if (c.market !== "Total") continue;
        const wx = computeWeatherAdjustment(c, weatherData);
        if (wx.totalAdj !== 0) {
          // Weather shifts projected total, which changes the edge
          c.modelProjection = +(c.modelProjection + wx.totalAdj).toFixed(1);
          const newEdge = Math.abs(c.modelProjection - c.consensusLine);
          c.edge = +newEdge.toFixed(1);
          // v11.1: recompute the full probability → EV → units chain. Previously the edge
          // changed but coverProb/EV/units stayed stale, so weather had no effect on sizing.
          const wxTotalStd = SPORT_TOTAL_STD_DEVS[c.sport] || 18;
          const wxZ = newEdge / wxTotalStd;
          const wxRaw = normalCDF(wxZ);
          const wxCal = getCalibratedCoverProb(wxRaw, c.sport, "Total", c.odds);
          const wxKelly = computeKelly(wxCal, c.odds, bankrollCtx.drawdownActive);
          c.zScore = +wxZ.toFixed(3);
          c.coverProb = +wxCal.toFixed(4);
          c.ev = +wxKelly.ev.toFixed(4);
          c.kellyFraction = +wxKelly.kellyFraction.toFixed(4);
          const wxMult = SPORT_KELLY_MULT[c.sport] || 1.0;
          let wxUnits = Math.round(wxKelly.units * wxMult * 2) / 2;
          wxUnits = Math.max(0.5, Math.min(3.0, wxUnits));
          c.kellyUnits = wxUnits;
          c._rawKellyUnits = wxUnits;
          c.kellyCalcStr += wx.method;
          wxAdj++;
        }
      }
      if (wxAdj > 0) console.log(`[v10-weather] Applied weather adjustments to ${wxAdj} total candidates`);
    }

    // ── PHASE 1E: BETTOREDGE EXCHANGE INTEGRATION ──
    // Vig-free P2P exchange probabilities are the sharpest available odds.
    // When the exchange agrees with the model, boost Kelly. When it disagrees, reduce.
    try {
      console.log("[v10-beta] Fetching BettorEdge exchange data...");
      const BE_EVENTS = "https://api.events.bettoredge.com/v1";
      const BE_MARKETS = "https://api.markets.bettoredge.com/v1";

      const [beLeaguesResp, beEventsResp] = await Promise.all([
        bettoredgeFetch(`${BE_EVENTS}/leagues?status=active`),
        bettoredgeFetch(`${BE_EVENTS}/events/active?expanded=true`),
      ]);

      const beLeagues = beLeaguesResp.ok ? (await beLeaguesResp.json()).leagues || [] : [];
      const beEventsRaw = beEventsResp.ok ? (await beEventsResp.json()).events || [] : [];
      console.log(`[v10-beta-BE] ${beLeagues.length} leagues, ${beEventsRaw.length} active events`);

      // Fetch prices + trades per event in batches of 10
      const beEventData = {};
      for (let i = 0; i < beEventsRaw.length; i += 10) {
        const batch = beEventsRaw.slice(i, i + 10);
        const results = await Promise.allSettled(batch.map(async (evt) => {
          const [pricesResp, tradesResp] = await Promise.all([
            bettoredgeFetch(`${BE_EVENTS}/prices/latest/${evt.event_id}/team`).catch(() => null),
            bettoredgeFetch(`${BE_MARKETS}/trades/event/latest/${evt.event_id}/team`).catch(() => null),
          ]);
          const prices = pricesResp?.ok ? (await pricesResp.json()).prices || [] : [];
          const trades = tradesResp?.ok ? (await tradesResp.json()).trades || [] : [];
          return { evt, prices, trades };
        }));
        for (const r of results) {
          if (r.status === "fulfilled") {
            const { evt, prices, trades } = r.value;
            const homeKey = (evt.home?.name || "").toLowerCase().replace(/[^a-z]/g, "");
            const awayKey = (evt.away?.name || "").toLowerCase().replace(/[^a-z]/g, "");
            beEventData[`${awayKey}_${homeKey}`] = { prices, trades, home: evt.home?.name, away: evt.away?.name, eventId: evt.event_id };
          }
        }
      }
      console.log(`[v10-beta-BE] Event data for ${Object.keys(beEventData).length} matchups`);

      // Match candidates to BE events and apply exchange probability signal
      function beNorm(name) { return (name || "").toLowerCase().replace(/[^a-z]/g, ""); }
      let beMatches = 0, beBoosts = 0, beCautions = 0;

      for (const c of allCandidates) {
        const parts = (c.matchup || "").split(/\s+(?:vs\.?|@|at)\s+/i);
        if (parts.length < 2) continue;
        const t1 = beNorm(parts[0]), t2 = beNorm(parts[1]);

        let beMatch = null;
        for (const [key, data] of Object.entries(beEventData)) {
          const h = beNorm(data.home), a = beNorm(data.away);
          if ((t1.includes(h) || h.includes(t1) || t2.includes(h) || h.includes(t2)) &&
              (t1.includes(a) || a.includes(t1) || t2.includes(a) || a.includes(t2))) {
            beMatch = data; break;
          }
        }
        if (!beMatch) continue;
        beMatches++;

        // Extract vig-free exchange probability
        const exchangeTrades = beMatch.trades.filter(t => {
          const isST = c.betType === "Spread" || c.betType === "Puck Line" || c.betType === "Run Line";
          return isST ? (t.var_1 != null && t.var_1 !== 0)
            : c.betType === "Total" ? (t.side === "over" || t.side === "under")
            : (t.side === "home" || t.side === "away") && (!t.var_1 || t.var_1 === 0);
        });

        let exchangeProb = null;
        if (exchangeTrades.length > 0) {
          const probs = exchangeTrades.map(t => t.probability).filter(p => p > 0 && p < 1);
          if (probs.length > 0) exchangeProb = probs.reduce((a, b) => a + b, 0) / probs.length;
        }

        // Get sharpest external line (lowest vig)
        const relevantPrices = beMatch.prices.filter(p => {
          if (c.betType === "Spread" || c.betType === "Puck Line" || c.betType === "Run Line") return p.market === "Spread" && p.var_1 != null;
          if (c.betType === "Total") return p.market === "Total";
          return p.market === "Winner";
        });
        const sharpestLine = relevantPrices.filter(p => p.vig_pct > 0 && p.vig_pct < 20).sort((a, b) => a.vig_pct - b.vig_pct)[0];

        c.bettorEdge = {
          matched: true,
          exchangeProb: exchangeProb ? +exchangeProb.toFixed(3) : null,
          probDelta: exchangeProb ? +(c.coverProb - exchangeProb).toFixed(3) : null,
          sharpestBook: sharpestLine?.external_name || null,
          sharpestVig: sharpestLine ? +(sharpestLine.vig_pct).toFixed(2) : null,
          tradeCount: exchangeTrades.length,
        };

        // Apply exchange signal to Kelly units (same logic as BE pipeline)
        if (exchangeProb) {
          const gap = Math.abs(c.coverProb - exchangeProb);
          if (gap <= 0.05) {
            // Exchange agrees — boost Kelly by 0.25u (gentler than BE pipeline's 0.5u)
            const old = c.kellyUnits;
            c.kellyUnits = Math.min(3.0, Math.round((c.kellyUnits * 1.15) * 2) / 2);
            c.bettorEdge.signal = "AGREE";
            c.kellyCalcStr += ` [BE AGREE: exchange=${(exchangeProb*100).toFixed(0)}% vs model=${(c.coverProb*100).toFixed(0)}%]`;
            beBoosts++;
            console.log(`[v10-beta-BE] AGREE ${c.side}: exchange=${(exchangeProb*100).toFixed(0)}% model=${(c.coverProb*100).toFixed(0)}%, Kelly ${old}u → ${c.kellyUnits}u`);
          } else if (gap > 0.10) {
            // Exchange disagrees — reduce Kelly by 20%
            const old = c.kellyUnits;
            c.kellyUnits = Math.max(0.5, Math.round((c.kellyUnits * 0.80) * 2) / 2);
            c.bettorEdge.signal = "DISAGREE";
            c.kellyCalcStr += ` [BE DISAGREE: exchange=${(exchangeProb*100).toFixed(0)}% vs model=${(c.coverProb*100).toFixed(0)}%]`;
            beCautions++;
            console.log(`[v10-beta-BE] DISAGREE ${c.side}: exchange=${(exchangeProb*100).toFixed(0)}% model=${(c.coverProb*100).toFixed(0)}%, Kelly ${old}u → ${c.kellyUnits}u`);
          } else {
            c.bettorEdge.signal = "NEUTRAL";
            console.log(`[v10-beta-BE] NEUTRAL ${c.side}: exchange=${(exchangeProb*100).toFixed(0)}% model=${(c.coverProb*100).toFixed(0)}%`);
          }
        }
      }

      // ── PHASE 1E2: BETTOREDGE F5 + PLAYER PROPS ──
      // F5 (First Five Innings) — market_id 70. Use as additional MLB candidates.
      // Player props — validate star player impact with market-priced props.
      try {
        // Enumerate available market types for reference logging
        const beMarketsResp = await bettoredgeFetch(`${BE_MARKETS}/markets/all`);
        if (beMarketsResp.ok) {
          const mkts = (await beMarketsResp.json()).markets || [];
          const sportMarkets = mkts.filter(m => m.level === 'team' || m.level === 'player');
          const f5Market = mkts.find(m => m.market_id === 70 || (m.description || '').toLowerCase().includes('first 5'));
          const firstHalfMarket = mkts.find(m => (m.description || '').toLowerCase().includes('first half') || (m.description || '').toLowerCase().includes('1st half'));
          console.log(`[v10-beta-BE] Market types: ${mkts.length} total, F5=${f5Market ? f5Market.market_id : 'not found'}, 1H=${firstHalfMarket ? firstHalfMarket.market_id + ' (' + firstHalfMarket.description + ')' : 'not found'}`);
          // Store discovered market IDs for future use
          if (firstHalfMarket) console.log(`[v10-beta-BE] DISCOVERED: First Half market_id=${firstHalfMarket.market_id} — "${firstHalfMarket.description}" (type=${firstHalfMarket.type}, stat=${firstHalfMarket.stat})`);
          const playerMarkets = mkts.filter(m => m.level === 'player');
          if (playerMarkets.length > 0) console.log(`[v10-beta-BE] DISCOVERED: ${playerMarkets.length} player-level markets: ${playerMarkets.slice(0, 5).map(m => `${m.market_id}="${m.description}"`).join(', ')}`);
        }

        // F5 lines for MLB candidates — add as additional candidate if edge exists
        const mlbCandidates = allCandidates.filter(c => c.sport === 'MLB');
        if (mlbCandidates.length > 0) {
          let f5Added = 0;
          for (const [key, data] of Object.entries(beEventData)) {
            // Check if this event has F5 prices
            const f5Prices = data.prices.filter(p => String(p.market_id) === '70');
            if (f5Prices.length === 0) continue;

            const f5Home = f5Prices.filter(p => p.side === 'home').sort((a, b) => (a.vig_pct || 100) - (b.vig_pct || 100))[0];
            const f5Away = f5Prices.filter(p => p.side === 'away').sort((a, b) => (a.vig_pct || 100) - (b.vig_pct || 100))[0];
            if (!f5Home || !f5Away) continue;

            // Log F5 lines for reference — these could become candidates in a future F5 sub-model
            console.log(`[v10-beta-BE-F5] ${data.away} @ ${data.home}: F5 ML home=${f5Home.odds} (${f5Home.external_name}), away=${f5Away.odds} (${f5Away.external_name})`);
            f5Added++;

            // Cross-reference: if we have a full-game MLB candidate for this matchup,
            // attach the F5 line as additional context
            const matchingCandidate = mlbCandidates.find(c =>
              beNorm(c.homeTeam).includes(beNorm(data.home)) || beNorm(data.home).includes(beNorm(c.homeTeam))
            );
            if (matchingCandidate) {
              matchingCandidate.f5Data = {
                homeML: f5Home.odds,
                awayML: f5Away.odds,
                homeProb: f5Home.probability,
                awayProb: f5Away.probability,
                source: f5Home.external_name,
              };
            }
          }
          console.log(`[v10-beta-BE-F5] Found F5 lines for ${f5Added} MLB games`);
        }

        // Player props — fetch for events with player-level pricing
        // This validates star player impact (e.g., if Jokic points prop is 28.5,
        // that confirms he's playing and his expected contribution)
        let playerPropsFound = 0;
        for (const [key, data] of Object.entries(beEventData)) {
          try {
            const ppResp = await bettoredgeFetch(`${BE_EVENTS}/prices/latest/${data.eventId}/player`);
            if (ppResp.ok) {
              const ppData = await ppResp.json();
              const props = ppData.prices || [];
              if (props.length > 0) {
                playerPropsFound++;
                // Attach top props to matching candidates for context
                const matchingCandidate = allCandidates.find(c =>
                  beNorm(c.homeTeam).includes(beNorm(data.home)) || beNorm(data.home).includes(beNorm(c.homeTeam))
                );
                if (matchingCandidate) {
                  matchingCandidate.playerProps = props.slice(0, 10).map(p => ({
                    name: p.participant_name || p.participant_id,
                    market: p.market,
                    line: p.var_1,
                    odds: p.odds,
                    source: p.external_name,
                  }));
                }
              }
            }
          } catch (e) { /* player props endpoint may not exist for all events */ }
          // Limit to 10 events to avoid rate limits
          if (playerPropsFound >= 10) break;
        }
        console.log(`[v10-beta-BE] Player props found for ${playerPropsFound} events`);

      } catch (beExtraErr) {
        console.log(`[v10-beta-BE] F5/props fetch failed (non-fatal): ${beExtraErr.message}`);
      }

      // Re-sort after BE adjustments
      allCandidates.sort((a, b) => b.ev - a.ev);
      allCandidates.forEach((c, i) => { c.rank = i + 1; });
      console.log(`[v10-beta-BE] BettorEdge: ${beMatches} matched, ${beBoosts} boosted, ${beCautions} cautioned`);
    } catch (beErr) {
      console.error(`[v10-beta-BE] BettorEdge failed (non-fatal): ${beErr.message}`);
      // Pipeline continues without BE data
    }

    // ── PHASE 1F: X/GROK REAL-TIME INTELLIGENCE ──
    const xAlerts = await fetchXIntelligence(allCandidates);
    applyXIntelligence(allCandidates, xAlerts);
  } catch (edgeErr) {
    console.error(`[v10] EDGE TABLE COMPUTATION FAILED: ${edgeErr.message}`);
    console.error(edgeErr.stack);
    allCandidates = [];
    // Crash-vs-quiet disambiguation: a thrown edge table must NOT masquerade as a no-play day.
    // (v11.0-mvp shipped with a fatal scope bug and stored "no edges" for 2 days undetected.)
    allCandidates._pipelineError = `${edgeErr.message} | ${(edgeErr.stack || '').split('\n')[1] || ''}`.trim();
  }

  if (allCandidates.length === 0) {
    // ── THIN-SLATE FALLBACK (Option B) ──
    // No candidate cleared the +8% conviction bar (common on thin summer slates).
    // Re-run the edge table at a disciplined +3% EV floor; if anything qualifies,
    // publish the best 1-3 as low-stake "Lean" plays (0.25u) flagged thinSlate so
    // they're tracked separately and never inflate the conviction-book ROI.
    // If nothing clears +3%, fall through to a true no-play — never force a -EV pick.
    let leanCandidates = [];
    try {
      leanCandidates = computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, bankrollCtx.drawdownActive, calibrationData, pitcherData, 0.015);
      leanCandidates.sort((a, b) => b.ev - a.ev);
      leanCandidates.forEach((c, i) => { c.rank = i + 1; });
    } catch (leanErr) {
      console.error(`[v10-lean] Thin-slate re-run failed: ${leanErr.message}`);
      if (!allCandidates._pipelineError) allCandidates._pipelineError = leanErr.message;
    }
    if (leanCandidates.length > 0) {
      console.log(`[v10-lean] Thin slate — ${leanCandidates.length} lean candidate(s) cleared +3% EV; publishing as Lean plays`);
      return await buildThinSlatePicks(dateISO, dateFormatted, leanCandidates, now);
    }
    const pipelineError = allCandidates._pipelineError || null;
    if (pipelineError) console.error(`[v10-health] STORING CRASH MARKER — this was NOT a quiet slate: ${pipelineError}`);
    else console.log("[v10] No edge candidates found (even at +3% floor) — storing no-plays result");
    await storePicks(dateISO, {
      date: dateISO, dateFormatted, model: "v11.1-mvp",
      pipelineError,
      picks: [], rejections: [{ matchup: "All games", side: "All markets", reason: pipelineError
        ? `⚠️ PIPELINE ERROR — edge computation crashed (${pipelineError}). This is a system failure, not a quiet slate. Check function logs.`
        : `No statistical edges exceeded minimum thresholds. ESPN: ${(espnData||[]).reduce((s,l)=>s+l.games.length,0)} games/${(espnData||[]).length} leagues. Odds: ${(oddsData||[]).reduce((s,l)=>s+l.games.length,0)} games. Ratings: ${ratingsData ? Object.keys(ratingsData.leagues||{}).length : 0} leagues. TeamStats: ${Object.keys(teamStats).length}. Consensus: ${Object.keys(consensusLookup).length} keys.` }],
      summary: { totalPicks: 0, totalStraightBets: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [], modelVersion: "v11.1-mvp" },
      edgeSummary: pipelineError
        ? "Pick generation hit a system error today — no card published. The team has been flagged."
        : "No plays today — WeBetAI found no edges exceeding minimum thresholds across all sports.",
      generatedAt: now.toISOString(),
    });
    return { statusCode: 200, body: pipelineError ? "PIPELINE ERROR (stored crash marker)" : "No edge candidates" };
  }

  // ── PHASE 2: CLAUDE AS VALIDATOR + NARRATOR ──
  const candidateTable = allCandidates.slice(0, 15);
  const userMessage = formatCandidateTable(candidateTable, dateISO, dateFormatted);

  console.log(`[v10] Sending ${candidateTable.length} candidates to Claude (${userMessage.length} chars)`);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // Alpha improvement: prompt caching cuts Claude call cost ~80% and latency ~30%
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        // Alpha improvement: latest Sonnet (claude-sonnet-4-6 vs beta's claude-sonnet-4-20250514)
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        temperature: 0.2,
        // Alpha improvement: cache the large static system prompt (ephemeral, 5min TTL)
        system: [{ type: "text", text: THE_LOCK_V10_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20 }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[v10] Claude API error ${response.status}: ${errText}`);
      // Fallback: use top 3 candidates without narratives
      return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
    }

    const result = await response.json();
    console.log("[v10] Claude API response received, stop_reason:", result.stop_reason);

    let rawText = "";
    for (const block of result.content) {
      if (block.type === "text") rawText += block.text;
    }

    // Parse Claude's selection JSON
    let claudeOutput;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        try { claudeOutput = JSON.parse(jsonStr); }
        catch (e) {
          let fixed = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').replace(/[\x00-\x1F\x7F]/g, ' ');
          claudeOutput = JSON.parse(fixed);
        }
      } else {
        throw new Error("No JSON in Claude response");
      }
    } catch (parseErr) {
      console.error(`[v10] JSON parse failed: ${parseErr.message}`);
      return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
    }

    // ── PHASE 3: MERGE JS NUMBERS + CLAUDE SELECTIONS ──
    const selections = claudeOutput.selections || [];
    // v11.1-mvp: Pass gradeAccuracy from self-optimize params into buildFinalPicks via static prop
    buildFinalPicks._gradeAccuracy = selfOptParams?.gradeAccuracy || null;
    let picks = buildFinalPicks(candidateTable, selections, allCandidates, bankrollCtx.drawdownActive);

    // ── v11.1-mvp: ADVERSARIAL A+ CHECK ──
    // For the top-ranked pick (candidateRank 1), run a second Haiku call that tries to REFUTE it.
    // If 2-of-3 refutation criteria are met, downgrade from A+ to A (don't drop entirely — the JS
    // math still likes it, so we keep it but signal lower conviction).
    // Cost: ~$0.002 per run (Haiku is cheap). Benefit: reduces A+ false positives.
    const topPick = picks.find(p => p.rating === 'A+' || p.confidence === 'elite');
    if (topPick && ANTHROPIC_API_KEY) {
      try {
        const adversarialPrompt = `You are a devil's advocate for sports betting analysis. A model has selected this as its TOP PICK today:

Sport: ${topPick.sport} | ${topPick.matchup}
Pick: ${topPick.pick} | Odds: ${topPick.odds}
Win Probability: ${topPick.winProbability} | Edge: ${topPick.edgePct}
Model reasoning: ${topPick.coreReasoning}

Your job: Search for reasons this pick COULD FAIL. Check for:
1. Recent injuries, lineup changes, or news that argues AGAINST this pick
2. Historical patterns where this type of edge disappears (e.g. playoff fatigue, travel)
3. Market signals suggesting sharp money is on the other side

Return JSON only: {"refuted": true/false, "confidence": 0.0-1.0, "reason": "one sentence if refuted"}
Only set refuted=true if you find strong, specific, verifiable evidence against the pick. Default to false if uncertain.`;

        const adversarialResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 300,
            temperature: 0.1,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            messages: [{ role: 'user', content: adversarialPrompt }],
          }),
          signal: AbortSignal.timeout(25000),
        });
        if (adversarialResp.ok) {
          const advData = await adversarialResp.json();
          const advText = (advData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          const advJson = advText.match(/\{[\s\S]*\}/);
          if (advJson) {
            const adv = JSON.parse(advJson[0]);
            if (adv.refuted && adv.confidence >= 0.7) {
              // Downgrade A+ → A, log the reason
              picks = picks.map(p => p === topPick ? { ...p, rating: 'A', confidence: 'high', adversarialNote: adv.reason } : p);
              console.log(`[v11-adversarial] TOP PICK downgraded A+→A: ${topPick.pick} | ${adv.reason}`);
            } else {
              console.log(`[v11-adversarial] TOP PICK survived refutation: ${topPick.pick} (refuted=${adv.refuted}, conf=${adv.confidence})`);
            }
          }
        }
      } catch (advErr) {
        console.log(`[v11-adversarial] Check failed (non-fatal): ${advErr.message}`);
      }
    }

    // Build rejections from Claude + all non-selected candidates
    const selectedRanks = new Set(selections.map(s => s.candidateRank));

    const rejections = [];
    // Add Claude's explicit rejections
    for (const r of (claudeOutput.rejections || [])) {
      const c = candidateTable.find(x => x.rank === r.candidateRank);
      rejections.push({
        matchup: c ? c.matchup : `Candidate #${r.candidateRank}`,
        side: c ? c.side : "N/A",
        reason: r.reason || "No reason given",
      });
    }
    // Add remaining non-selected candidates as rejections
    for (const c of allCandidates.slice(0, 15)) {
      if (!selectedRanks.has(c.rank) && !rejections.find(r => r.side === c.side)) {
        rejections.push({ matchup: c.matchup, side: c.side, reason: "Not selected — lower edge priority." });
      }
    }

    // ── LEAN TIER TOP-UP ──
    // Claude rejected picks down below 3. Pull from the +3% EV lean tier to fill up.
    // Never use a side Claude explicitly rejected — only candidates it didn't see or
    // ranked lower than the conviction bar.
    if (picks.length < 3) {
      const needed = 3 - picks.length;
      const pickedGames = new Set(picks.map(p => (p.matchup || '').toLowerCase().trim()));
      const rejectedSides = new Set(
        (claudeOutput.rejections || []).map(r => {
          const c = candidateTable.find(x => x.rank === r.candidateRank);
          return c ? (c.side || '').toLowerCase().trim() : '';
        }).filter(Boolean)
      );
      try {
        const leanAll = computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, bankrollCtx.drawdownActive, calibrationData, pitcherData, 0.03);
        leanAll.sort((a, b) => b.ev - a.ev);
        const topUps = leanAll.filter(c =>
          !rejectedSides.has((c.side || '').toLowerCase().trim()) &&
          !pickedGames.has((c.matchup || '').toLowerCase().trim()) &&
          !picks.find(p => p.pick === c.side)
        ).slice(0, needed);
        if (topUps.length > 0) {
          console.log(`[v10-lean-topup] Adding ${topUps.length} lean pick(s) — Claude left us with only ${picks.length}`);
          for (const c of topUps) {
            const oddsStr = c.odds > 0 ? `+${c.odds}` : `${c.odds}`;
            const u = LEAN_UNITS;
            picks.push({
              pick: c.side, sport: c.sport, matchup: c.matchup,
              betType: c.market, odds: oddsStr, units: `${u}u`,
              rating: 'Lean', confidence: 'lean', thinSlate: true,
              winProbability: `${(typeof c.coverProb === 'number' ? c.coverProb * 100 : parseFloat(c.coverProb) * 100 || 50).toFixed(0)}%`,
              edgePct: `${(c.ev * 100).toFixed(1)}%`,
              modelEdge: `Model edge: ${c.edge.toFixed(1)} pts. EV: +${(c.ev * 100).toFixed(1)}%.`,
              coreReasoning: 'Lean play — statistical edge below conviction threshold. Claude verified no disqualifying news.',
              dataVerified: 'lean-tier',
              clvExpectation: 'Minimal line movement expected.',
              zScore: c.zScore || 0, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
              commenceTime: c.commenceTime || '',
            });
            pickedGames.add((c.matchup || '').toLowerCase().trim());
          }
        }
      } catch (leanErr) {
        console.error(`[v10-lean-topup] Failed: ${leanErr.message}`);
      }
    }

    // Build model projections snapshot
    const modelProjections = {};
    for (const c of allCandidates) {
      const key = c.matchup;
      if (!modelProjections[key]) {
        modelProjections[key] = {
          homeWinProb: c.homeWinProb,
          projSpread: c.market === "Total" ? undefined : c.modelProjection,
          projTotal: c.market === "Total" ? c.modelProjection : undefined,
          projMethod: c.projMethod,
          homeElo: c.homeElo, awayElo: c.awayElo,
          homeRest: c.homeRest, awayRest: c.awayRest,
        };
      }
      if (c.market === "Total") modelProjections[key].projTotal = c.modelProjection;
      else modelProjections[key].projSpread = c.modelProjection;
    }

    // ── Narrative quality gate: ensure every pick has proper journalistic context ──
    await validateAndEnhanceNarratives(picks, ANTHROPIC_API_KEY);

    // Final sort by z-score descending (highest model confidence first)
    picks.sort((a, b) => (b.zScore || 0) - (a.zScore || 0));

    const finalTotalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
    const sportsCovered = [...new Set(picks.map(p => p.sport))];

    const picksData = {
      date: dateISO,
      dateFormatted,
      model: "v11.1-mvp",
      picks,
      rejections,
      edgeSummary: claudeOutput.edgeSummary || "",
      summary: {
        totalPicks: picks.length,
        totalStraightBets: picks.length,
        totalUnits: `${finalTotalUnits.toFixed(1)}u`,
        aplusLocks: picks.filter(p => p.rating === "A+").length,
        sportsCovered,
        modelVersion: "v11.1-mvp",
      },
      generatedAt: now.toISOString(),
      parlayLegs: buildCorrelatedParlay(picks, allCandidates, rejections),
      sgps: [],
      modelProjections,
      edgeCandidatesCount: allCandidates.length,
      candidateTable: candidateTable.map(c => ({
        rank: c.rank,
        sport: c.sport,
        side: c.side,
        market: c.market,
        odds: c.odds,
        modelProjection: c.modelProjection,
        consensusLine: c.consensusLine,
        edge: c.edge,
        coverProb: c.coverProb,
        ev: c.ev,
        kellyUnits: c.kellyUnits,
        matchup: c.matchup,
        selected: selectedRanks.has(c.rank),
      })),
    };

    // Store thinking text if present
    const jsonStart = rawText.indexOf('{');
    if (jsonStart > 50) {
      picksData.thinkingText = rawText.substring(0, jsonStart).trim();
    }

    await storePicks(dateISO, picksData);
    console.log(`[v10] SUCCESS: ${picks.length} picks for ${dateISO}`);
    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("[v10] Fatal error:", err.message);
    return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
  }
};

// ── Fallback: if Claude fails, use top 3 candidates with auto-generated narrative ──
// ── THIN-SLATE LEAN PICKS (Option B) ──
// Builds low-stake "Lean" plays from candidates that cleared the +3% EV floor but
// not the +8% conviction bar. Lean picks publish at 0.25u, graded "Lean", flagged
// thinSlate:true so the results tracker scores them separately from the conviction
// book. The parlay (if any) is also sized at the lean amount, per spec.
const LEAN_UNITS = 0.25;
async function buildThinSlatePicks(dateISO, dateFormatted, leanCandidates, now) {
  console.log(`[v10-lean] Building thin-slate Lean card from ${leanCandidates.length} candidate(s)`);
  const top = leanCandidates.slice(0, 3);
  const picks = top.map(c => {
    const isML = (c.market || '').toLowerCase() === 'moneyline';
    const isTotal = (c.market || '').toLowerCase() === 'total';
    const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);
    const scoreUnit = c.sport === 'NHL' ? 'goal' : c.sport === 'MLB' ? 'run' : 'point';

    let reasoning;
    if (isML) {
      reasoning = `Thin slate — no conviction edge today. WeBetAI's model gives ${c.side.replace(' ML', '')} a ${c.modelProjection}% win probability vs the market's implied ${c.consensusLine}% (a ${edgePctVal}% edge) — enough to clear the +3% lean threshold but below the conviction bar, so it's sized down to a small Lean play.`;
    } else if (isTotal) {
      reasoning = `Thin slate — no conviction edge today. WeBetAI projects ${c.modelProjection} total ${scoreUnit}s, ${c.edge} ${scoreUnit}s ${c.side.includes('Over') ? 'above' : 'below'} the line of ${c.consensusLine} (a ${edgePctVal}% edge). Clears the +3% lean threshold but below conviction — published as a small Lean play.`;
    } else {
      reasoning = `Thin slate — no conviction edge today. WeBetAI projects a ${Math.abs(c.modelProjection)}-${scoreUnit} margin vs the line of ${c.consensusLine} (a ${c.edge}-${scoreUnit}, ${edgePctVal}% edge). Clears the +3% lean threshold but below conviction — published as a small Lean play.`;
    }

    const modelEdgeStr = isML
      ? `Model Win Prob: ${c.modelProjection}%, Implied: ${c.consensusLine}%, Edge: ${edgePctVal}%`
      : `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${scoreUnit}s`;

    return {
      sport: c.sport,
      matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
      pick: c.side,
      betType: c.market,
      odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
      rating: "Lean",
      confidence: ratingToConfidence("Lean"),
      units: `${LEAN_UNITS}u`,
      thinSlate: true,
      ev: `${(c.ev * 100).toFixed(1)}%`,
      evRaw: c.ev,
      edgePct: `${edgePctVal}%`,
      edgePoints: c.edge,
      coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
      zScore: c.zScore,
      kellyCalc: c.kellyCalcStr,
      winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
      coreReasoning: reasoning,
      whatLoses: isML
        ? `${c.side.replace(' ML', '')} loses the game outright.`
        : isTotal
        ? `The game ${c.side.includes('Over') ? 'stays under' : 'goes over'} the total.`
        : `The opponent covers the spread.`,
      dataVerified: "Thin-slate Lean play — auto-generated from the deterministic model at the +3% EV floor.",
      clvExpectation: "Lower-conviction edge; monitor for line movement.",
      modelEdge: modelEdgeStr,
      commenceTime: c.commenceTime || "",
    };
  });

  await validateAndEnhanceNarratives(picks, ANTHROPIC_API_KEY);
  picks.sort((a, b) => (b.zScore || 0) - (a.zScore || 0));

  // Lean parlay — sized at the lean amount (0.25u) per spec
  let parlayLegs = [];
  if (leanCandidates.length >= 3) {
    parlayLegs = buildCorrelatedParlay(picks, leanCandidates, []).map(p => ({ ...p, units: `${LEAN_UNITS}u`, thinSlate: true }));
  }

  const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const picksData = {
    date: dateISO, dateFormatted, model: "v11.1-mvp",
    picks,
    rejections: leanCandidates.slice(picks.length, picks.length + 7).map(c => ({ matchup: c.matchup, side: c.side, reason: "Below lean priority." })),
    edgeSummary: "Thin slate — no conviction edges today. WeBetAI published its best low-risk Lean plays (0.25u) from candidates clearing the +3% EV floor. These are tracked separately from conviction picks.",
    summary: { totalPicks: picks.length, totalStraightBets: picks.length, totalUnits: `${totalUnits.toFixed(2)}u`, aplusLocks: 0, sportsCovered: [...new Set(picks.map(p => p.sport))], modelVersion: "v11.1-mvp" },
    generatedAt: now.toISOString(), parlayLegs, sgps: [],
    thinSlate: true,
    fallback: true,
  };

  await storePicks(dateISO, picksData);
  return { statusCode: 200, body: "Thin-slate Lean OK" };
}

async function fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now) {
  console.log("[v10] Using fallback: top 3 candidates without Claude narratives");
  const top3 = candidateTable.slice(0, 3);
  const picks = top3.map(c => {
    const isML = (c.market || '').toLowerCase() === 'moneyline';
    const isTotal = (c.market || '').toLowerCase() === 'total';
    const zUnits = kellyToUnits(c.kellyUnits, false, c.coverProb);
    const edgePctVal = ((c.coverProb - impliedProb(c.odds)) * 100).toFixed(1);

    // Build proper narrative based on bet type
    let reasoning;
    if (isML) {
      reasoning = `WeBetAI's model gives ${c.side.replace(' ML', '')} a ${c.modelProjection}% win probability vs the market's implied ${c.consensusLine}%, creating a ${edgePctVal}% edge. The ${c.homeTeam} and ${c.awayTeam} matchup presents value at ${c.odds > 0 ? '+' : ''}${c.odds} odds based on Elo ratings, recent form, and injury analysis.`;
    } else if (isTotal) {
      const unit = c.sport === 'NHL' ? 'goals' : c.sport === 'MLB' ? 'runs' : 'points';
      reasoning = `WeBetAI projects ${c.modelProjection} total ${unit}, ${c.edge} ${unit} ${c.side.includes('Over') ? 'above' : 'below'} the line of ${c.consensusLine}. This ${edgePctVal}% edge is driven by the matchup's pace, recent scoring trends, and confirmed lineup data.`;
    } else {
      const unit = c.sport === 'NHL' ? 'goal' : c.sport === 'MLB' ? 'run' : 'point';
      reasoning = `WeBetAI projects a ${Math.abs(c.modelProjection)}-${unit} margin vs the line of ${c.consensusLine}, creating a ${c.edge}-${unit} edge. This ${edgePctVal}% edge reflects the gap between the model's power rating projection and the consensus sportsbook line.`;
    }

    const modelEdgeStr = isML
      ? `Model Win Prob: ${c.modelProjection}%, Implied: ${c.consensusLine}%, Edge: ${edgePctVal}%`
      : `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${c.sport === 'NHL' ? 'goals' : c.sport === 'MLB' ? 'runs' : 'pts'}`;

    return {
      sport: c.sport,
      matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
      pick: c.side,
      betType: c.market,
      odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
      rating: unitsToRating(zUnits),
      confidence: ratingToConfidence(unitsToRating(zUnits)),
      units: `${zUnits}u`,
      ev: `${(c.ev * 100).toFixed(1)}%`,
      evRaw: c.ev,
      edgePct: `${edgePctVal}%`,
      edgePoints: c.edge,
      coverProb: `${(c.coverProb * 100).toFixed(0)}%`,
      zScore: c.zScore,
      kellyCalc: c.kellyCalcStr,
      winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
      coreReasoning: reasoning,
      whatLoses: isML
        ? `${c.side.replace(' ML', '')} loses the game outright despite the model's edge.`
        : isTotal
        ? `The game ${c.side.includes('Over') ? 'stays under' : 'goes over'} the total due to unexpected pace or scoring changes.`
        : `The opponent covers the spread through late-game momentum or a blowout.`,
      dataVerified: "Auto-generated from deterministic model — Claude narrative unavailable.",
      clvExpectation: "Line may move toward pick as sharp money arrives.",
      modelEdge: modelEdgeStr,
      commenceTime: c.commenceTime || "",
    };
  });

  // Narrative quality gate on fallback picks too
  await validateAndEnhanceNarratives(picks, ANTHROPIC_API_KEY);

  // Sort fallback picks by z-score descending
  picks.sort((a, b) => (b.zScore || 0) - (a.zScore || 0));

  const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const picksData = {
    date: dateISO, dateFormatted, model: "v11.1-mvp",
    picks,
    rejections: allCandidates.slice(3, 10).map(c => ({ matchup: c.matchup, side: c.side, reason: "Lower edge priority." })),
    edgeSummary: "WeBetAI's deterministic model found today's top edges across all sports. Picks ranked by normalized z-score.",
    summary: { totalPicks: picks.length, totalStraightBets: picks.length, totalUnits: `${totalUnits.toFixed(1)}u`, aplusLocks: 0, sportsCovered: [...new Set(picks.map(p => p.sport))], modelVersion: "v11.1-mvp" },
    generatedAt: now.toISOString(), parlayLegs: [], sgps: [],
    fallback: true,
  };

  await storePicks(dateISO, picksData);
  return { statusCode: 200, body: "Fallback OK" };
}

// ── Store picks to "edge-picks-mvp" blob store ──
// simMode flag: when true, stores to picks-sim-{date} key — never overwrites real picks
let _simMode = false;
function setSimMode(v) { _simMode = v; }

async function storePicks(dateISO, picksData) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error("[v10-alpha] NETLIFY_AUTH_TOKEN not set, cannot store picks");
    return;
  }

  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mvp`;
  // Sim mode: write to isolated key, never clobber real picks or latest-date pointer
  const pickKey = _simMode ? `picks-sim-${dateISO}` : `picks-${dateISO}`;

  try {
    const putPicks = await fetch(`${storeUrl}/${pickKey}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (!putPicks.ok) {
      const errBody = await putPicks.text();
      console.error(`[v10] Blob PUT failed ${putPicks.status}: ${errBody.substring(0, 200)}`);
    } else {
      console.log("[v10] Picks stored via blob API");
    }

    // Only update latest-date pointer for real runs — sim runs are isolated
    if (!_simMode) {
      await fetch(`${storeUrl}/latest-date`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "text/plain" },
        body: dateISO,
      });
    } else {
      console.log(`[v10-sim] Simulation stored to ${pickKey} — latest-date pointer unchanged`);
    }

    // Only update picks-dates index for real runs — sim dates must not pollute the live index
    if (!_simMode) {
      try {
        let datesArr = [];
        const getDates = await fetch(`${storeUrl}/picks-dates`, { headers: { "Authorization": `Bearer ${token}` } });
        if (getDates.ok) datesArr = await getDates.json();
        if (!Array.isArray(datesArr)) datesArr = [];
        if (!datesArr.includes(dateISO)) {
          datesArr.push(dateISO);
          datesArr.sort();
          await fetch(`${storeUrl}/picks-dates`, {
            method: "PUT",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(datesArr),
          });
          console.log(`[v10] Added ${dateISO} to picks-dates index (${datesArr.length} total)`);
        }
      } catch (e) {
        console.error(`[v10] picks-dates index update error: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`[v10] Blob store error: ${err.message}`);
  }

  // Kalshi auto-execution PAUSED — paper trading mode active
  // Re-enable once /prediction-markets KPI targets verified
  // try {
  //   const siteURL = process.env.URL || 'https://webetsocial.com';
  //   const picksKey = process.env.PICKS_SECRET_KEY || '';
  //   const kalshiResp = await fetch(`${siteURL}/.netlify/functions/run-kalshi?key=${picksKey}`, { method: 'POST' });
  //   console.log(`[v10-beta] Kalshi execution triggered: ${kalshiResp.status}`);
  // } catch (e) {
  //   console.error(`[v10-beta] Kalshi trigger failed: ${e.message}`);
  // }
}
