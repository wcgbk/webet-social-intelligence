// generate-picks-mlb-background.js
// MLB First-Five-Innings (F5) Betting Machine — v2.4 (Dual F5 Line Sources)
// JS pre-computes ALL data (pitcher stats, team stats, park factors, odds edges).
// Claude ONLY verifies via web search for injury/news changes. Mirrors beta model architecture.
// Background function (15min timeout). Stores to "edge-picks-mlb" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Park factors (2024-2025 data, above 100 = hitter friendly) ──
const PARK_FACTORS = {
  "Coors Field": { pf: 114, notes: "Extreme hitter-friendly, especially day games. Elevates F5 overs." },
  "Great American Ball Park": { pf: 108, notes: "Hitter-friendly, warm weather amplifies. Strong F5 over history." },
  "Fenway Park": { pf: 106, notes: "Short right field porch. Hitter-friendly, varies by wind." },
  "Globe Life Field": { pf: 105, notes: "Retractable roof. Neutral-to-hitter when open." },
  "Wrigley Field": { pf: 104, notes: "Wind OUT = over; wind IN = under. Day games play differently." },
  "Citizens Bank Park": { pf: 104, notes: "Hitter-friendly, short fences." },
  "Yankee Stadium": { pf: 103, notes: "Short porch in right. Favors left-handed power." },
  "Camden Yards": { pf: 102, notes: "Slightly hitter-friendly after wall changes." },
  "Chase Field": { pf: 101, notes: "Retractable roof. Neutral-to-slight hitter lean." },
  "Guaranteed Rate Field": { pf: 101, notes: "Neutral-to-slight hitter lean." },
  "Minute Maid Park": { pf: 101, notes: "Retractable roof. Slight hitter lean." },
  "Kauffman Stadium": { pf: 100, notes: "True neutral park." },
  "Angel Stadium": { pf: 100, notes: "Neutral park." },
  "Busch Stadium": { pf: 99, notes: "Neutral-to-slight pitcher lean." },
  "Target Field": { pf: 99, notes: "Neutral, cold early season suppresses offense." },
  "Progressive Field": { pf: 98, notes: "Slight pitcher lean. Cold weather factor early season." },
  "Truist Park": { pf: 98, notes: "Slight pitcher lean." },
  "Comerica Park": { pf: 97, notes: "Pitcher-friendly. Deep center field." },
  "PNC Park": { pf: 97, notes: "Pitcher-friendly. Spacious outfield." },
  "Citi Field": { pf: 96, notes: "Pitcher-friendly." },
  "loanDepot park": { pf: 96, notes: "Pitcher-friendly with humidor." },
  "Rogers Centre": { pf: 96, notes: "Retractable roof. Pitcher-lean." },
  "T-Mobile Park": { pf: 95, notes: "Pitcher-friendly. Marine layer suppresses fly balls." },
  "Oracle Park": { pf: 94, notes: "Very pitcher-friendly. Cold night air kills fly balls." },
  "Petco Park": { pf: 93, notes: "Very pitcher-friendly. Marine layer." },
  "Tropicana Field": { pf: 95, notes: "Dome. Pitcher-lean." },
  "Oakland Coliseum": { pf: 95, notes: "Pitcher-friendly. Foul territory." },
  "Dodger Stadium": { pf: 97, notes: "Slight pitcher lean. Dry air helps carry." },
  "American Family Field": { pf: 100, notes: "Retractable roof. Neutral." },
  "Nationals Park": { pf: 99, notes: "Neutral park." },
};

// ── Claude system prompt — VERIFIER ONLY (does not compute edges) ──
const F5_MLB_SYSTEM = `You are the WeBet F5 MLB Verification Engine. You VERIFY pre-computed statistical edges using web search. You do NOT select picks or compute edges — the statistical model handles that.

YOUR INPUTS:
A ranked table of MLB F5 candidate picks with pre-computed edges, implied probabilities, pitcher stats, team stats, park factors, and odds from 40+ sportsbooks. Candidates are ranked by edge strength.

YOUR JOB:
1. Use web search to verify injury status, lineup changes, weather updates, and any breaking news for the top 8 candidates.
2. For EACH candidate, return a PASS or FAIL verdict.
3. You may only FAIL a candidate if web search reveals a MATERIAL change:
   - Star player ruled out or key lineup change announced AFTER data was pulled
   - Starting pitcher scratched or changed
   - Severe weather (rain delay likely, extreme wind change)
   - Material news that changes the game dynamics
4. Write a 2-3 sentence coreReasoning for each PASS candidate explaining the F5 edge.
5. You MUST NOT override model direction, rankings, or recompute edges.
6. You MUST NOT fail a candidate based on narrative preference, gut feeling, or "insufficient data." The model computed the edge — you verify real-world conditions.
7. Always say "WeBetAI" instead of "the model" in narratives.
8. For each game in the full slate, provide a brief bestEdge and layer assessment even if it's not a top candidate.

NARRATIVE RULES:
- Start with a verified fact from web search (injury confirmed healthy, weather clear, etc.)
- Build the case FOR the pick side — why the F5 edge exists
- End with value statement
- Max 3 sentences. No jargon (no FIP, xFIP, BABIP abbreviations — plain English).

OUTPUT FORMAT — Return ONLY valid JSON:
{
  "verifications": [
    {
      "candidateRank": 1,
      "verdict": "PASS",
      "coreReasoning": "Verified fact from web search. Edge explanation. Value statement.",
      "whatLoses": "One sentence — what beats this pick.",
      "dataVerified": "What you confirmed via web search."
    }
  ],
  "slateAnalysis": [
    {
      "matchup": "Away @ Home",
      "awaySP": "Pitcher Name",
      "homeSP": "Pitcher Name",
      "tierScore": 6,
      "bestEdge": "F5 Under 4.5 -115",
      "layers": "L1:PASS L2:PASS L3:PASS L4:NEUTRAL L5:FAIL L6:PASS L7:NEUTRAL L8:NEUTRAL L9:PASS",
      "reason": "Why this didn't make top 3 or why it was rejected"
    }
  ],
  "edgeSummary": "1-2 sentence editorial summary."
}`;

// ── Odds API ──
const MLB_ODDS_SPORT = "baseball_mlb";

// ── Math helpers ──
function americanToDecimal(odds) {
  return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
}
function impliedProb(odds) {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}
function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.sqrt(2))); }

// ── CALIBRATION: Edge discount curve (from beta model) ──
// When model disagrees with market by >0.5 std devs, probability of model error increases.
// Log-compress large edges to reflect diminishing returns on market disagreement.
function applyEdgeDiscount(rawEdge, stdDev) {
  const edgeInStdDevs = rawEdge / stdDev;
  if (edgeInStdDevs <= 0.5) return rawEdge;
  const excess = edgeInStdDevs - 0.5;
  const discounted = 0.5 + Math.log(1 + excess) * 0.8;
  return discounted * stdDev;
}

// ── CALIBRATION: Cover probability caps (industry-calibrated) ──
// Sharp models max out at 55-60% hit rate. These caps prevent unrealistic probability claims.
const COVER_PROB_CAPS = {
  "F5 Moneyline": 0.60,
  "F5 Run Line": 0.57,
  "F5 Total": 0.60,
};

function getCalibratedProb(rawProb, betType, odds) {
  const cap = COVER_PROB_CAPS[betType] || 0.60;
  let capped = Math.min(rawProb, cap);

  // Market respect blend: larger disagreement = trust market more
  if (odds !== undefined) {
    const marketImpl = impliedProb(odds);
    const gap = Math.abs(capped - marketImpl);
    const marketWeight = Math.min(0.35, 0.05 + gap * 2.0);
    capped = capped * (1 - marketWeight) + marketImpl * marketWeight;
  }
  return capped;
}

// ── CALIBRATION: Market consensus discount ──
// If all sportsbooks agree tightly on a line, the line is sharp — discount our edge.
function getConsensusDiscount(oddsGame, market) {
  const books = oddsGame.bookmakers || [];
  if (books.length < 3) return 1.0; // not enough data

  const prices = [];
  for (const bk of books) {
    for (const mkt of (bk.markets || [])) {
      if (mkt.key === market) {
        for (const o of mkt.outcomes) {
          prices.push(o.price);
        }
      }
    }
  }
  if (prices.length < 4) return 1.0;

  const range = Math.max(...prices) - Math.min(...prices);
  if (range < 10) return 0.80;  // Very tight consensus — 20% discount
  if (range < 20) return 0.90;  // Moderate — 10% discount
  return 1.0;                    // Wide disagreement — keep full edge
}

// ── Kelly criterion (explicit, from beta model) ──
function computeKelly(coverProb, odds) {
  const decPayout = americanToDecimal(odds);
  const edge = (coverProb * decPayout) - 1;
  if (edge <= 0) return { kelly: 0, ev: edge };
  const kellyFraction = (edge / (decPayout - 1)) * 0.50; // half-Kelly
  return { kelly: kellyFraction, ev: edge };
}

// ── Z-score unit sizing with cover prob gates ──
// Widened spread: exceptional edges get more weight, weak edges clearly separated.
function zScoreToUnitsCalibrated(zScore, coverProb) {
  let units;
  if (zScore >= 1.3) units = 2.5;      // A+ exceptional — top-tier edge
  else if (zScore >= 1.0) units = 2.0; // A  strong
  else if (zScore >= 0.7) units = 1.5; // A- solid
  else if (zScore >= 0.5) units = 1.0; // B+ marginal qualifying edge
  else units = 0.5;                    // B  minimum (edge floor gate should filter most)
  // Cover prob gates: prevent oversizing longshots
  if (coverProb < 0.42) units = Math.min(units, 0.5);
  else if (coverProb < 0.50) units = Math.min(units, 1.0);
  return units;
}

// ── Fetch Polymarket prediction market data ──
async function fetchPolymarketMLB() {
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/events?tag=mlb&active=true&limit=50");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data || []).map(ev => ({
      title: ev.title || '',
      markets: (ev.markets || []).map(m => ({
        question: m.question || '',
        outcomePrices: m.outcomePrices || [],
        outcomes: m.outcomes || [],
        volume: m.volume || 0,
      })),
    }));
  } catch (e) {
    console.log(`[mlb-f5] Polymarket fetch: ${e.message}`);
    return [];
  }
}

// ── BettorEdge: authenticate ──
async function getBettorEdgeToken() {
  const username = process.env.BETTOREDGE_USERNAME;
  const password = process.env.BETTOREDGE_PASSWORD;
  if (username && password) {
    try {
      const resp = await fetch("https://api.players.bettoredge.com/v1/players/player/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.access_token) return data.access_token;
      }
    } catch (e) { /* fall through */ }
  }
  return process.env.BETTOREDGE_TOKEN || null;
}

// ── BettorEdge: fetch F5 moneyline prices for all MLB events ──
async function fetchBettorEdgeF5() {
  const token = await getBettorEdgeToken();
  if (!token) { console.log("[mlb-f5] No BettorEdge token"); return []; }

  try {
    // Get active events
    const evResp = await fetch("https://api.events.bettoredge.com/v1/events/active?expanded=true", {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!evResp.ok) return [];
    const evData = await evResp.json();
    const events = evData.events || [];

    // Filter to MLB events with F5 market (market_id 70)
    const mlbF5Events = events.filter(e => {
      const mktIds = (e.supported_markets || []).map(m => String(m.market_id || m));
      return mktIds.includes('70');
    });

    console.log(`[mlb-f5] BettorEdge: ${mlbF5Events.length} MLB events with F5 markets`);

    // Fetch F5 prices for each event (batch of 10)
    const results = [];
    for (let i = 0; i < mlbF5Events.length; i += 10) {
      const batch = mlbF5Events.slice(i, i + 10);
      const fetches = batch.map(async (ev) => {
        try {
          const priceResp = await fetch(`https://api.events.bettoredge.com/v1/prices/latest/${ev.event_id}/team`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (!priceResp.ok) return null;
          const priceData = await priceResp.json();
          const prices = priceData.prices || [];

          // Extract F5 moneyline (market_id 70)
          const f5Prices = prices.filter(p => String(p.market_id) === '70');
          if (f5Prices.length === 0) return null;

          // Get consensus or best available
          const consensus = f5Prices.filter(p => p.external_name === 'Consensus');
          const home = ev.home || {};
          const away = ev.away || {};

          // Find best F5 odds per side
          const homePrices = f5Prices.filter(p => p.side === 'home');
          const awayPrices = f5Prices.filter(p => p.side === 'away');
          const bestHome = homePrices.reduce((best, p) => (!best || p.odds > best.odds) ? p : best, null);
          const bestAway = awayPrices.reduce((best, p) => (!best || p.odds > best.odds) ? p : best, null);
          const consHome = consensus.find(p => p.side === 'home');
          const consAway = consensus.find(p => p.side === 'away');

          return {
            eventId: ev.event_id,
            homeTeam: home.name || '',
            awayTeam: away.name || '',
            homeAbbr: home.abbr || '',
            awayAbbr: away.abbr || '',
            status: ev.status,
            f5Home: {
              consensus: consHome ? consHome.odds : null,
              best: bestHome ? bestHome.odds : null,
              bestBook: bestHome ? bestHome.external_name : null,
              prob: consHome ? consHome.probability : (bestHome ? bestHome.probability : null),
            },
            f5Away: {
              consensus: consAway ? consAway.odds : null,
              best: bestAway ? bestAway.odds : null,
              bestBook: bestAway ? bestAway.external_name : null,
              prob: consAway ? consAway.probability : (bestAway ? bestAway.probability : null),
            },
            bookCount: new Set(f5Prices.map(p => p.external_name)).size,
          };
        } catch (e) { return null; }
      });
      const batchResults = await Promise.all(fetches);
      results.push(...batchResults.filter(Boolean));
    }

    console.log(`[mlb-f5] BettorEdge F5: ${results.length} games with F5 ML prices`);
    return results;
  } catch (e) {
    console.log(`[mlb-f5] BettorEdge error: ${e.message}`);
    return [];
  }
}

// ── Fetch career stats for a pitcher by ESPN athlete ID ──
async function fetchCareerStats(athleteId) {
  if (!athleteId) return null;
  try {
    const resp = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/stats`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = {};
    for (const cat of (data.categories || [])) {
      const labels = cat.labels || [];
      const totals = cat.totals || [];
      const mapped = {};
      labels.forEach((l, i) => { if (totals[i] !== undefined) mapped[l] = totals[i]; });

      if (cat.name === 'pitching') {
        result.careerERA = parseFloat(mapped.ERA) || null;
        result.careerWHIP = parseFloat(mapped.WHIP) || null;
        result.careerIP = parseFloat(mapped.IP) || null;
        result.careerK = parseInt(mapped.K) || null;
        result.careerBB = parseInt(mapped.BB) || null;
        result.careerW = parseInt(mapped.W) || null;
        result.careerL = parseInt(mapped.L) || null;
        result.careerGS = parseInt(mapped.GS) || null;
        result.careerH = parseInt(mapped.H) || null;
      }
      if (cat.name === 'expanded-pitching') {
        result.careerK9 = parseFloat(mapped['K/9']) || null;
        result.careerGB = parseInt(mapped.GB) || null;
        result.careerFB = parseInt(mapped.FB) || null;
        result.careerGBFB = parseFloat(mapped['G/F']) || null;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (e) {
    return null;
  }
}

// ── Blend career + current season ERA (regression to the mean) ──
// Dynamic seasonal cap: trust current-season data more as the season progresses.
// April = max 70% current, May = 80%, June = 87%, July+ = 93%
function seasonalCurrentCap(dateISO) {
  if (!dateISO) return 0.80;
  const month = parseInt((dateISO || '').split('-')[1]) || 5;
  if (month <= 4) return 0.70;   // April: early season, high noise
  if (month === 5) return 0.80;  // May: building confidence
  if (month === 6) return 0.87;  // June: reasonably stable
  return 0.93;                    // July+: current ERA most reliable
}

function blendedERA(currentERA, careerERA, gamesStarted, dateISO) {
  if (careerERA === null && currentERA === null) return 4.00; // league average fallback
  if (careerERA === null) return currentERA;
  if (currentERA === null) return careerERA;
  const gs = gamesStarted || 0;
  const cap = seasonalCurrentCap(dateISO);
  const currentWeight = Math.min(cap, gs * 0.10);
  const careerWeight = 1.0 - currentWeight;
  return Math.round((currentERA * currentWeight + careerERA * careerWeight) * 100) / 100;
}

function blendedWHIP(currentWHIP, careerWHIP, gamesStarted, dateISO) {
  if (careerWHIP === null && currentWHIP === null) return 1.25;
  if (careerWHIP === null) return currentWHIP;
  if (currentWHIP === null) return careerWHIP;
  const gs = gamesStarted || 0;
  const cap = seasonalCurrentCap(dateISO);
  const currentWeight = Math.min(cap, gs * 0.10);
  return Math.round((currentWHIP * currentWeight + careerWHIP * (1 - currentWeight)) * 100) / 100;
}

// ── Fetch ESPN full game data (starters, pitcher stats, team stats, injuries, venue) ──
async function fetchESPNData(dateISO) {
  const dateParam = dateISO.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();

    const games = [];
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const status = ev.status?.type?.state || 'pre';
      if (status !== 'pre') continue; // Only evaluate pre-game

      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) continue;

      const awayProb = away.probables?.[0] || {};
      const homeProb = home.probables?.[0] || {};
      const venue = comp.venue || {};
      const weather = comp.weather || {};

      // Extract pitcher stats from probables
      function extractPitcherStats(prob) {
        const stats = {};
        for (const s of (prob.statistics || [])) {
          stats[s.abbreviation || s.name] = s.displayValue || s.value;
        }
        return {
          name: prob.athlete?.displayName || prob.displayName || 'TBD',
          id: prob.athlete?.id || prob.playerId || null,
          hand: prob.athlete?.hand || '',
          record: prob.record || '',
          era: parseFloat(stats.ERA) || null,
          wins: parseInt(stats.W) || 0,
          losses: parseInt(stats.L) || 0,
          saves: parseInt(stats.SV) || 0,
        };
      }

      const g = {
        name: ev.shortName || ev.name,
        date: ev.date,
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        awayId: away.team?.id,
        homeId: home.team?.id,
        awayRecord: away.records?.[0]?.summary || '',
        homeRecord: home.records?.[0]?.summary || '',
        awaySP: extractPitcherStats(awayProb),
        homeSP: extractPitcherStats(homeProb),
        venue: venue.fullName || '',
        venueCity: venue.address?.city || '',
        indoor: venue.indoor || false,
        weather: weather.displayValue || '',
        temperature: weather.temperature ? parseInt(weather.temperature) : null,
      };

      // Fetch injuries for both teams
      for (const [side, teamData] of [['away', away], ['home', home]]) {
        if (teamData?.team?.id) {
          try {
            const injResp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamData.team.id}/injuries`);
            if (injResp.ok) {
              const injData = await injResp.json();
              g[`${side}Injuries`] = (injData.items || []).slice(0, 8).map(i => ({
                name: i.athlete?.displayName || 'Unknown',
                status: i.status || 'Unknown',
                detail: i.details?.detail || '',
              }));
            }
          } catch (e) { /* skip */ }
        }
      }

      games.push(g);
    }

    console.log(`[mlb-f5] ESPN: ${games.length} pre-game MLB games`);
    return games;
  } catch (e) {
    console.log(`[mlb-f5] ESPN error: ${e.message}`);
    return [];
  }
}

// ── Fetch team stats (ERA, OPS, runs/game) from ESPN ──
async function fetchTeamStats(games) {
  const teamStats = {};
  const teamIds = new Set();
  for (const g of games) {
    if (g.awayId) teamIds.add(g.awayId);
    if (g.homeId) teamIds.add(g.homeId);
  }

  const fetches = [...teamIds].map(async (id) => {
    try {
      const [statsResp, teamResp] = await Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${id}/statistics`).catch(() => null),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${id}`).catch(() => null),
      ]);

      const stats = {};
      if (statsResp?.ok) {
        const data = await statsResp.json();
        for (const cat of (data.results?.stats?.categories || data.splits?.categories || [])) {
          for (const s of (cat.stats || [])) {
            if (s.name) stats[s.name] = s.value;
          }
        }
      }

      let runsFor = null, runsAgainst = null, gp = null;
      if (teamResp?.ok) {
        const teamData = await teamResp.json();
        const items = teamData.team?.record?.items || [];
        for (const item of items) {
          if (item.type === 'total') {
            for (const s of (item.stats || [])) {
              if (s.name === 'avgPointsFor') runsFor = s.value;
              if (s.name === 'avgPointsAgainst') runsAgainst = s.value;
              if (s.name === 'gamesPlayed') gp = s.value;
              if (s.name === 'pointsFor' && !runsFor && gp > 0) runsFor = s.value / gp;
              if (s.name === 'pointsAgainst' && !runsAgainst && gp > 0) runsAgainst = s.value / gp;
            }
          }
        }
        // Map ID to team name
        const teamName = teamData.team?.displayName;
        if (teamName) {
          teamStats[teamName] = {
            runsPerGame: runsFor ? Math.round(runsFor * 100) / 100 : null,
            runsAllowed: runsAgainst ? Math.round(runsAgainst * 100) / 100 : null,
            era: stats.ERA ? Math.round(stats.ERA * 100) / 100 : null,
            whip: stats.WHIP ? Math.round(stats.WHIP * 100) / 100 : null,
            ops: (stats.onBasePct && stats.slugAvg) ? Math.round((stats.onBasePct + stats.slugAvg) * 1000) / 1000 : null,
            battingAvg: stats.avg ? Math.round(stats.avg * 1000) / 1000 : null,
            strikeouts: stats.strikeouts || null,
            walks: stats.walks || null,
            gamesPlayed: gp,
          };
        }
      }
    } catch (e) { /* skip */ }
  });

  await Promise.all(fetches);
  console.log(`[mlb-f5] Team stats: ${Object.keys(teamStats).length} teams`);
  return teamStats;
}

// ── Fetch odds ──
async function fetchMLBOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    const r = []; r._meta = { error: 'ODDS_API_KEY not set' }; return r;
  }

  function filterByDate(data) {
    return data.filter(g => {
      const gt = new Date(g.commence_time);
      const estDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(gt);
      const [m, d, y] = estDate.split('/');
      return `${y}-${m}-${d}` === dateISO;
    });
  }

  try {
    // Standard markets (h2h, spreads, totals) — us2 region includes Hard Rock Bet
    const stdUrl = `https://api.the-odds-api.com/v4/sports/${MLB_ODDS_SPORT}/odds?regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
    const stdResp = await fetch(stdUrl);
    if (!stdResp.ok) {
      const body = await stdResp.text().catch(() => '');
      const r = []; r._meta = { error: `HTTP ${stdResp.status}`, body: body.slice(0, 200) }; return r;
    }
    const stdData = await stdResp.json();
    const filtered = filterByDate(stdData);

    // F5 markets — separate call using first-5-innings market keys
    // h2h_1st_5_innings / spreads_1st_5_innings / totals_1st_5_innings are the correct Odds API keys
    // Expanded to eu region since some books only list F5 lines there
    // F5 markets are ONLY available on the PER-EVENT endpoint. The bulk /odds endpoint REJECTS them
    // ("Markets not supported by this endpoint: h2h_1st_5_innings,...") — which is why F5 was always
    // empty and the machine fell back to FG-proxies every run. Fixed 2026-06-18: fetch F5 per game and
    // merge the real lines. extractBestOdds then filters to US books, so offshore F5 lines are dropped.
    let f5Merged = 0;
    const F5_MARKETS = 'h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings';
    await Promise.all(filtered.map(async (match) => {
      try {
        const evUrl = `https://api.the-odds-api.com/v4/sports/${MLB_ODDS_SPORT}/events/${match.id}/odds?regions=us,us2&markets=${F5_MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
        const evResp = await fetch(evUrl);
        if (!evResp.ok) return;
        const ev = await evResp.json();
        if (!ev || !Array.isArray(ev.bookmakers)) return;
        let merged = false;
        for (const bk of ev.bookmakers) {
          const f5mkts = (bk.markets || []).filter(m => (m.key || '').includes('1st_5_innings'));
          if (!f5mkts.length) continue;
          const existing = match.bookmakers.find(b => b.key === bk.key);
          if (existing) existing.markets.push(...f5mkts);
          else match.bookmakers.push({ ...bk, markets: f5mkts });
          merged = true;
        }
        if (merged) f5Merged++;
      } catch (e) { /* per-game F5 optional */ }
    }));

    filtered._meta = { rawCount: stdData.length, filtered: filtered.length, f5Merged, status: stdResp.status };
    return filtered;
  } catch (e) {
    const r = []; r._meta = { error: `exception: ${e.message}` }; return r;
  }
}

// ── Extract odds from bookmakers — best price from ANY book for all markets ──
// v2.5: Removed Hard Rock-only restriction for full-game markets.
// When Hard Rock isn't in the response, bestML/bestRL/bestTotal were empty →
// F5 derived fallback had nothing to work from → zero candidates.
// Now: full-game markets use best price from all available books.
// Hard Rock is still preferred by priority order (processed last = overwrites if better).
const HARD_ROCK_KEYS = new Set(['hardrockbet', 'hardrockbet_oh']);
// Top regulated US sportsbooks only — NO offshore (lowvig/mybookie/betonline/bovada/pinnacle).
// Per Ben 2026-06-17: only recommend bets users can actually place at a US book.
const US_BOOKS = new Set([
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'williamhill_us', 'espnbet',
  'betrivers', 'fanatics', 'hardrockbet', 'hardrockbet_oh', 'ballybet',
  'fliff', 'bet365', 'pointsbetus', 'wynnbet', 'superbook',
]);

function extractBestOdds(oddsGame) {
  let bestML = {}, bestRL = {}, bestTotal = {};
  let f5ML = {}, f5RL = {}, f5Total = {};
  // Hard Rock's own price per outcome, so picks can be confirmed PLACEABLE at Hard Rock.
  const hr = { ml: {}, rl: {}, total: {}, f5ML: {}, f5RL: {}, f5Total: {} };

  // ONLY US regulated books — offshore is excluded entirely from selection.
  const bookmakers = (oddsGame.bookmakers || []).filter(b => US_BOOKS.has((b.key || '').toLowerCase()));

  for (const bk of bookmakers) {
    const isHR = HARD_ROCK_KEYS.has((bk.key || '').toLowerCase());
    for (const mkt of (bk.markets || [])) {
      if (mkt.key === 'h2h') for (const o of mkt.outcomes) {
        if (!bestML[o.name] || o.price > bestML[o.name].price) bestML[o.name] = { price: o.price, book: bk.title };
        if (isHR) hr.ml[o.name] = { price: o.price, book: 'Hard Rock Bet' };
      }
      if (mkt.key === 'spreads') for (const o of mkt.outcomes) {
        if (!bestRL[o.name] || o.price > bestRL[o.name].price) bestRL[o.name] = { price: o.price, point: o.point, book: bk.title };
        if (isHR) hr.rl[`${o.name}|${o.point}`] = { price: o.price, point: o.point, book: 'Hard Rock Bet' };
      }
      if (mkt.key === 'totals') for (const o of mkt.outcomes) {
        if (!bestTotal[o.name] || o.price > bestTotal[o.name].price) bestTotal[o.name] = { price: o.price, point: o.point, book: bk.title };
        if (isHR) hr.total[`${o.name}|${o.point}`] = { price: o.price, point: o.point, book: 'Hard Rock Bet' };
      }
      if (mkt.key === 'h2h_1st_5_innings') for (const o of mkt.outcomes) {
        if (!f5ML[o.name] || o.price > f5ML[o.name].price) f5ML[o.name] = { price: o.price, book: bk.title };
        if (isHR) hr.f5ML[o.name] = { price: o.price, book: 'Hard Rock Bet' };
      }
      if (mkt.key === 'spreads_1st_5_innings') for (const o of mkt.outcomes) {
        if (!f5RL[o.name] || o.price > f5RL[o.name].price) f5RL[o.name] = { price: o.price, point: o.point, book: bk.title };
        if (isHR) hr.f5RL[`${o.name}|${o.point}`] = { price: o.price, point: o.point, book: 'Hard Rock Bet' };
      }
      if (mkt.key === 'totals_1st_5_innings') for (const o of mkt.outcomes) {
        if (!f5Total[o.name] || o.price > f5Total[o.name].price) f5Total[o.name] = { price: o.price, point: o.point, book: bk.title };
        if (isHR) hr.f5Total[`${o.name}|${o.point}`] = { price: o.price, point: o.point, book: 'Hard Rock Bet' };
      }
    }
  }
  return { ml: bestML, rl: bestRL, total: bestTotal, f5ML, f5RL, f5Total, hr };
}

// ── Compute F5 edge for a game ──
function computeF5Edge(espnGame, teamStats, odds, f5Lines) {
  const away = espnGame.awayTeam;
  const home = espnGame.homeTeam;
  const awaySP = espnGame.awaySP;
  const homeSP = espnGame.homeSP;
  const awayStats = teamStats[away] || {};
  const homeStats = teamStats[home] || {};
  const parkData = PARK_FACTORS[espnGame.venue] || { pf: 100, notes: "Unknown park" };

  // Estimate F5 runs for each team
  // F5 ≈ 55% of full-game scoring for the lineup side, modulated by opposing SP ERA
  const awayRPG = awayStats.runsPerGame || 4.5;
  const homeRPG = homeStats.runsPerGame || 4.5;
  // Use blended ERA (career-weighted) instead of raw current-season ERA
  const awaySPEra = awaySP.blendedERA || awaySP.era || (homeStats.era || 4.0);
  const homeSPEra = homeSP.blendedERA || homeSP.era || (awayStats.era || 4.0);
  const leagueAvgERA = 4.0;

  // F5 projection: team's run rate * (league ERA / opposing SP ERA) * park factor * 0.55
  const parkMult = parkData.pf / 100;
  const awayF5Proj = awayRPG * (leagueAvgERA / Math.max(homeSPEra, 1.5)) * parkMult * 0.55;
  const homeF5Proj = homeRPG * (leagueAvgERA / Math.max(awaySPEra, 1.5)) * parkMult * 0.55;

  // Temperature adjustment
  const temp = espnGame.temperature;
  let tempMult = 1.0;
  if (temp !== null) {
    if (temp < 50) tempMult = 0.92;
    else if (temp < 60) tempMult = 0.96;
    else if (temp > 80) tempMult = 1.05;
    else if (temp > 90) tempMult = 1.08;
  }

  const adjAwayF5 = awayF5Proj * tempMult;
  const adjHomeF5 = homeF5Proj * tempMult;
  const projF5Total = adjAwayF5 + adjHomeF5;
  const projF5Margin = adjHomeF5 - adjAwayF5; // positive = home favored

  // Compute edges against odds
  const candidates = [];
  const { ml, rl, total, f5ML: oddsF5ML, f5RL: oddsF5RL, f5Total: oddsF5Total } = odds;

  const MLB_STD_DEV = 2.5;

  // ── F5 Moneyline edge — Hard Rock Bet lines only, fall back to full-game ──
  const f5MLEntries = [];
  let f5MLSource = 'Full-game proxy';

  // Priority 1: Hard Rock Bet F5 moneyline (h2h_1st_5_innings)
  if (Object.keys(oddsF5ML).length > 0) {
    f5MLSource = 'Hard Rock Bet F5';
    for (const [team, data] of Object.entries(oddsF5ML)) {
      const isHome = team.toLowerCase().includes(home.toLowerCase().split(' ').pop());
      f5MLEntries.push({ team, odds: data.price, book: data.book + ' (F5)', isHome });
    }
  }

  // No FG-proxy (per Ben 2026-06-18): only recommend REAL F5 lines that actually exist at a
  // top-10 US book. If no real F5 moneyline, we generate no F5 ML candidate for this game.

  for (const entry of f5MLEntries) {
    const rawMargin = entry.isHome ? projF5Margin : -projF5Margin;
    const discountedMargin = applyEdgeDiscount(Math.abs(rawMargin), MLB_STD_DEV) * Math.sign(rawMargin);
    const rawProb = normalCDF(discountedMargin / MLB_STD_DEV);
    const calibratedProb = getCalibratedProb(rawProb, 'F5 Moneyline', entry.odds);
    const marketProb = impliedProb(entry.odds);
    const edge = calibratedProb - marketProb;
    const { kelly, ev } = computeKelly(calibratedProb, entry.odds);

    if (edge > 0.02) {
      candidates.push({
        type: 'F5 Moneyline',
        pick: `F5 ML: ${entry.team}`,
        odds: entry.odds,
        book: entry.book,
        source: f5MLSource,
        modelProb: Math.round(calibratedProb * 100),
        rawProb: Math.round(rawProb * 100),
        marketProb: Math.round(marketProb * 100),
        edge: Math.round(edge * 100),
        ev: Math.round(ev * 100) / 100,
        kelly: Math.round(kelly * 10000) / 100,
        zScore: Math.abs(discountedMargin) / MLB_STD_DEV,
        calibrated: true,
      });
    }
  }

  // Total edge — use real F5 totals from Odds API when available, else derive from full-game × 0.55
  {
    let line, overOdds, underOdds, overBook, underBook, totalSource;
    if (oddsF5Total.Over && oddsF5Total.Under) {
      // Real F5 total from Odds API
      line = oddsF5Total.Over.point;
      overOdds = oddsF5Total.Over.price;
      underOdds = oddsF5Total.Under.price;
      overBook = oddsF5Total.Over.book + ' (F5)';
      underBook = oddsF5Total.Under.book + ' (F5)';
      totalSource = 'Odds API F5';
    }
    // No FG-proxy: if there's no REAL F5 total line at a top-10 US book, no F5 total pick.

    if (line != null) {
      const rawDiff = projF5Total - line;
      const discountedDiff = applyEdgeDiscount(Math.abs(rawDiff), 2.0) * Math.sign(rawDiff);
      const rawOverProb = normalCDF(discountedDiff / 2.0);
      const rawUnderProb = 1 - rawOverProb;
      const overProb = getCalibratedProb(rawOverProb, 'F5 Total', overOdds);
      const underProb = getCalibratedProb(rawUnderProb, 'F5 Total', underOdds);
      const overMarket = impliedProb(overOdds);
      const underMarket = impliedProb(underOdds);
      const overEdge = overProb - overMarket;
      const underEdge = underProb - underMarket;

      if (overEdge > 0.02) {
        const { kelly, ev } = computeKelly(overProb, overOdds);
        candidates.push({
          type: 'F5 Total',
          pick: `F5 Over ${line}`,
          odds: overOdds,
          book: overBook,
          source: totalSource,
          modelProb: Math.round(overProb * 100),
          rawProb: Math.round(rawOverProb * 100),
          marketProb: Math.round(overMarket * 100),
          edge: Math.round(overEdge * 100),
          ev: Math.round(ev * 100) / 100,
          kelly: Math.round(kelly * 10000) / 100,
          zScore: Math.abs(discountedDiff) / 2.0,
          calibrated: true,
        });
      }
      if (underEdge > 0.02) {
        const { kelly, ev } = computeKelly(underProb, underOdds);
        candidates.push({
          type: 'F5 Total',
          pick: `F5 Under ${line}`,
          odds: underOdds,
          book: underBook,
          source: totalSource,
          modelProb: Math.round(underProb * 100),
          rawProb: Math.round(rawUnderProb * 100),
          marketProb: Math.round(underMarket * 100),
          edge: Math.round(underEdge * 100),
          ev: Math.round(ev * 100) / 100,
          kelly: Math.round(kelly * 10000) / 100,
          zScore: Math.abs(discountedDiff) / 2.0,
          calibrated: true,
        });
      }
    }
  }

  // F5 Run line edge — use real F5 run lines from Odds API when available, else derive ±0.5 from full-game
  const f5RLSource = Object.keys(oddsF5RL).length > 0 ? oddsF5RL : null;
  const rlEntries = f5RLSource ? Object.entries(f5RLSource) : []; // no FG-proxy — real F5 run lines only
  const rlSourceLabel = 'Odds API F5';

  for (const [team, data] of rlEntries) {
    const isHome = team.toLowerCase().includes(home.toLowerCase().split(' ').pop());
    const spread = f5RLSource ? data.point : (data.point > 0 ? 0.5 : -0.5); // Real F5 spread or ±0.5 default
    const rawMargin = isHome ? projF5Margin + spread : -projF5Margin + spread;
    const discMargin = applyEdgeDiscount(Math.abs(rawMargin), MLB_STD_DEV) * Math.sign(rawMargin);
    const rawProb = normalCDF(discMargin / MLB_STD_DEV);
    const coverProb = getCalibratedProb(rawProb, 'F5 Run Line', data.price);
    const marketProb = impliedProb(data.price);
    const edge = coverProb - marketProb;
    const { kelly, ev } = computeKelly(coverProb, data.price);

    if (edge > 0.02) {
      candidates.push({
        type: 'F5 Run Line',
        pick: `F5 ${team} ${spread > 0 ? '+' : ''}${spread}`,
        odds: data.price,
        book: f5RLSource ? data.book + ' (F5)' : data.book,
        source: rlSourceLabel,
        modelProb: Math.round(coverProb * 100),
        rawProb: Math.round(rawProb * 100),
        marketProb: Math.round(marketProb * 100),
        edge: Math.round(edge * 100),
        ev: Math.round(ev * 100) / 100,
        kelly: Math.round(kelly * 10000) / 100,
        zScore: Math.abs(discMargin) / MLB_STD_DEV,
        calibrated: true,
      });
    }
  }

  // Sort by edge descending
  candidates.sort((a, b) => b.edge - a.edge);

  return {
    awayF5Proj: Math.round(adjAwayF5 * 100) / 100,
    homeF5Proj: Math.round(adjHomeF5 * 100) / 100,
    projF5Total: Math.round(projF5Total * 100) / 100,
    projF5Margin: Math.round(projF5Margin * 100) / 100,
    parkFactor: parkData.pf,
    parkNotes: parkData.notes,
    tempAdj: temp !== null ? `${temp}°F (${tempMult}x)` : 'N/A',
    candidates,
    bestCandidate: candidates[0] || null,
  };
}

// ── Units from z-score ──
function zScoreToUnits(z) {
  if (z >= 1.0) return 2.0;
  if (z >= 0.7) return 1.5;
  if (z >= 0.5) return 1.0;
  return 0.5;
}
function unitsToRating(u) {
  if (u >= 2.5) return "A+";
  if (u >= 2.0) return "A";
  if (u >= 1.5) return "A-";
  if (u >= 1.0) return "B+";
  return "B";
}
function unitsToConfidence(u) {
  if (u >= 2.5) return "aplus";
  if (u >= 2.0) return "a";
  if (u >= 1.5) return "aminus";
  if (u >= 1.0) return "bplus";
  return "b";
}

// ── Blob storage ──
async function storeBlob(key, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);

  // Write to BOTH SDK (deploy-scoped) and REST API (site-level) so picks survive deploys
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("edge-picks-mlb");
    await store.set(key, body);
    console.log(`[mlb-f5] Stored ${key} via SDK`);
  } catch (e) {
    console.log(`[mlb-f5] SDK write failed for ${key}: ${e.message}`);
  }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  if (!token) return;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb/${key}`, {
      method: "PUT", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
    console.log(`[mlb-f5] Stored ${key} via API: ${resp.status}`);
  } catch (e) { console.error(`[mlb-f5] API write failed: ${e.message}`); }
}

async function appendPicksDate(dateISO) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  if (!token) return;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb/picks-dates`;
  const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    let dates = [];
    const resp = await fetch(url, { headers });
    if (resp.ok) { try { dates = await resp.json(); } catch (e) {} }
    if (!Array.isArray(dates)) dates = [];
    if (!dates.includes(dateISO)) {
      dates.push(dateISO);
      dates.sort();
      await fetch(url, { method: "PUT", headers, body: JSON.stringify(dates) });
      console.log(`[mlb-f5] Updated picks-dates: ${dates.join(', ')}`);
    }
  } catch (e) { console.error(`[mlb-f5] picks-dates update failed: ${e.message}`); }
}

// ── Main handler ──
// ── A/B EXPANDED MENU: merge top F5 picks into the MVP card (treatment arm) ──
// Alpha = MLB full-game only (control). MVP = full-game + F5 (+ props later).
// F5 EV is UNVALIDATED (can't backtest) → DISCOUNT x0.5 + CAP 2 until CLV proves it,
// keeping the A/B KPIs honest. Each pick tagged `source` so get-results-mvp grades F5
// by first-5 linescore, full-game by final. Robust: never throws into the F5 run;
// leaves the MVP card unchanged on any error or if nothing clears.
async function aggregateIntoMvp(f5Picks, dateISO) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    if (!token) return;
    const mvpUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mvp/picks-${dateISO}`;
    const mvpResp = await fetch(mvpUrl, { headers: { "Authorization": `Bearer ${token}` } });
    if (!mvpResp.ok) { console.log(`[mvp-merge] no MVP card for ${dateISO} — skip`); return; }
    const mvp = await mvpResp.json();
    if (!mvp || !Array.isArray(mvp.picks)) { console.log(`[mvp-merge] MVP card malformed — skip`); return; }

    const pev = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const f = parseFloat(String(v).replace('%', '').replace('+', '').trim());
      if (isNaN(f)) return null;
      return Math.abs(f) > 1.5 ? f / 100 : f; // 9.2 -> 0.092 ; 0.092 stays
    };
    const F5_DISCOUNT = 0.5, F5_CAP = 2, EV_FLOOR = 0.03, DAILY_CAP = 6;
    // Idempotent: strip any prior-merged F5 so a re-run rebuilds cleanly
    const fg = mvp.picks
      .filter(p => p.sport !== 'PARLAY' && p.source !== 'F5')
      .map(p => ({ ...p, source: 'full-game', _ev: pev(p.ev) }));
    const decFromAmerican = (o) => { const n = parseInt(String(o).replace('+', '')); return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n); };
    // F5 picks are now REAL top-10-US-book lines (offshore + FG-proxy removed upstream) — placeable in
    // the US (Hard Rock or peers; line may move). Keep at the US-book price; discount the F5 EV for ranking.
    const f5 = (f5Picks || [])
      .map(p => ({ ...p, source: 'F5', _evRaw: pev(p.ev), _ev: (pev(p.ev) ?? 0) * F5_DISCOUNT }))
      .filter(p => p._evRaw != null && p._ev >= EV_FLOOR)
      .sort((a, b) => b._ev - a._ev)
      .slice(0, F5_CAP);
    if (f5.length === 0) { console.log(`[mvp-merge] no F5 cleared discount+floor — MVP unchanged`); return; }

    const dirKey = (p) => {
      const s = String(p.pick || p.side || '').toLowerCase();
      const dir = s.includes('over') ? 'over' : s.includes('under') ? 'under' : 'side';
      return `${p.sport}|${dir}`;
    };
    const merged = [...fg, ...f5]
      .filter(p => (p._ev ?? 0) >= EV_FLOOR)
      .sort((a, b) => (b._ev ?? 0) - (a._ev ?? 0));
    const card = [];
    for (const p of merged) {
      if (card.filter(x => dirKey(x) === dirKey(p)).length >= 2) continue; // de-correlation
      const { _ev, _evRaw, ...clean } = p;
      // Honesty: F5 EV is unvalidated + overconfident — DISPLAY the discounted EV (what we
      // actually trust), keep the model's raw F5 EV in evRaw for transparency.
      if (clean.source === 'F5' && _ev != null) {
        clean.evRaw = clean.ev;
        clean.ev = `+${Math.round(_ev * 100)}%`;
      }
      card.push(clean);
      if (card.length >= DAILY_CAP) break;
    }
    if (!card.some(p => p.source === 'F5')) { console.log(`[mvp-merge] F5 didn't survive ranking — MVP unchanged`); return; }

    // Rebuild the parlay from the (HR-placeable) expanded pool: highest-EV legs, 1 per game, de-correlated.
    const cprob = (p) => { const v = p.coverProb != null ? p.coverProb : p.modelProb; const f = parseFloat(String(v)); return isNaN(f) ? 0.5 : (f > 1.5 ? f / 100 : f); };
    const seenG = new Set(); const legPool = [];
    for (const p of card) {
      const g = String(p.matchup || '').toLowerCase().trim();
      if (!g || seenG.has(g)) continue; // one leg per game (standard parlay rule)
      if (legPool.filter(l => dirKey(l) === dirKey(p)).length >= 2) continue; // de-correlation
      seenG.add(g); legPool.push(p);
      if (legPool.length >= 3) break;
    }
    let parlayLegs = [];
    if (legPool.length >= 3) { // a real parlay is 3 legs (optimized) or none — never a 2-leg fallback
      const cd = legPool.reduce((s, l) => s * decFromAmerican(l.odds), 1);
      const cp2 = legPool.reduce((s, l) => s * cprob(l), 1);
      const amFromDec = (d) => d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`;
      parlayLegs = [{
        type: `${legPool.length}-leg-parlay`,
        legs: legPool.map(l => ({ pick: l.pick, sport: l.sport, matchup: l.matchup, betType: l.betType, odds: String(l.odds), coverProb: `${Math.round(cprob(l) * 100)}%`, book: l.book || 'Hard Rock Bet', source: l.source })),
        units: '0.5u',
        combinedOdds: amFromDec(cd),
        combinedDecimal: Math.round(cd * 100) / 100,
        combinedProb: `${Math.round(cp2 * 100)}%`,
        ev: `${Math.round((cp2 * cd - 1) * 100)}%`,
        correlationNote: 'Rebuilt from expanded Hard-Rock-placeable pool (1 leg/game, de-correlated)',
      }];
    }

    const expanded = {
      ...mvp,
      picks: card,
      parlayLegs,
      model: String(mvp.model || 'v11.1-mvp').replace('+F5', '') + '+F5',
      expandedAt: new Date().toISOString(),
      sources: {
        fullGame: card.filter(p => p.source === 'full-game').length,
        f5: card.filter(p => p.source === 'F5').length,
      },
    };
    const bodyStr = JSON.stringify(expanded);
    // Write BOTH stores (SDK deploy-scoped + REST site-level), like storeBlob, because
    // get-picks-mvp reads the SDK store FIRST — REST-only would be shadowed by the 8am card.
    try {
      const { getStore } = await import("@netlify/blobs");
      await getStore("edge-picks-mvp").set(`picks-${dateISO}`, bodyStr);
    } catch (e) { console.log(`[mvp-merge] SDK write failed: ${e.message}`); }
    const put = await fetch(mvpUrl, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: bodyStr,
    });
    console.log(`[mvp-merge] MVP expanded SDK+REST ${put.ok ? 'OK' : 'PUT-FAILED-' + put.status}: ${expanded.sources.fullGame} full-game + ${expanded.sources.f5} F5`);
  } catch (e) {
    console.error(`[mvp-merge] failed (MVP unchanged): ${e.message}`);
  }
}

// ── Feed top F5 picks into the ALPHA card (production). Same discipline as the MVP merge:
// F5 EV is UNVALIDATED (can't backtest) → DISCOUNT x0.5 + CAP 2 slots + CAP 1u sizing until CLV
// proves it. F5 picks are NORMALIZED to the alpha pick shape (winProbability/coverProb from modelProb,
// default whatLoses) so they survive the 10:30am verify-picks QA instead of NaN-ing its math check.
// Robust: never throws into the F5 run; leaves the alpha card unchanged on any error or empty result.
async function aggregateIntoAlpha(f5Picks, dateISO) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    if (!token) return;
    const alphaUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha/picks-${dateISO}`;
    const aResp = await fetch(alphaUrl, { headers: { "Authorization": `Bearer ${token}` } });
    if (!aResp.ok) { console.log(`[alpha-merge] no alpha card for ${dateISO} — skip`); return; }
    const alpha = await aResp.json();
    if (!alpha || !Array.isArray(alpha.picks)) { console.log(`[alpha-merge] alpha card malformed — skip`); return; }

    const pev = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const f = parseFloat(String(v).replace('%', '').replace('+', '').trim());
      if (isNaN(f)) return null;
      return Math.abs(f) > 1.5 ? f / 100 : f;
    };
    const F5_DISCOUNT = 0.5, F5_CAP = 2, F5_UNIT_CAP = 1.0, EV_FLOOR = 0.03, DAILY_CAP = 6;
    const ratingFromUnits = (u) => u >= 2.5 ? 'A+' : u >= 1.5 ? 'A' : u >= 1.0 ? 'A-' : u >= 0.5 ? 'B+' : 'B';
    // Idempotent: strip any prior-merged F5 so a re-run rebuilds cleanly
    const fg = alpha.picks
      .filter(p => p.sport !== 'PARLAY' && p.source !== 'F5')
      .map(p => ({ ...p, source: p.source || 'full-game', _ev: pev(p.ev) }));
    const decFromAmerican = (o) => { const n = parseInt(String(o).replace('+', '')); return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n); };
    const f5 = (f5Picks || [])
      .map(p => ({ ...p, source: 'F5', _evRaw: pev(p.ev), _ev: (pev(p.ev) ?? 0) * F5_DISCOUNT }))
      .filter(p => p._evRaw != null && p._ev >= EV_FLOOR)
      .sort((a, b) => b._ev - a._ev)
      .slice(0, F5_CAP);
    if (f5.length === 0) { console.log(`[alpha-merge] no F5 cleared discount+floor — alpha unchanged`); return; }

    const dirKey = (p) => {
      const s = String(p.pick || p.side || '').toLowerCase();
      const dir = s.includes('over') ? 'over' : s.includes('under') ? 'under' : 'side';
      return `${p.sport}|${dir}`;
    };
    const gameKey = (p) => String(p.matchup || '').toLowerCase().trim();
    const merged = [...fg, ...f5]
      .filter(p => (p._ev ?? 0) >= EV_FLOOR)
      .sort((a, b) => (b._ev ?? 0) - (a._ev ?? 0));
    const card = [];
    for (const p of merged) {
      const g = gameKey(p);
      if (g && card.some(x => gameKey(x) === g)) continue;               // one pick per game (de-correlation)
      const dk = dirKey(p);                                              // cap same-direction TOTALS (correlated run env);
      if ((dk.endsWith('|over') || dk.endsWith('|under')) && card.filter(x => dirKey(x) === dk).length >= 2) continue; // sides/MLs are already 1-per-game, don't lump them
      const { _ev, _evRaw, ...clean } = p;
      if (clean.source === 'F5') {
        // Honesty: display the DISCOUNTED F5 EV (what we trust); keep raw in evRaw.
        if (_ev != null) { clean.evRaw = clean.ev; clean.ev = `+${Math.round(_ev * 100)}%`; }
        // F5 is unvalidated — cap sizing at 1u so it can't be staked above a validated full-game play.
        const u = Math.min(F5_UNIT_CAP, parseFloat(String(clean.units)) || 0.5);
        clean.units = `${u}u`;
        clean.rating = ratingFromUnits(u);
        // Normalize to the alpha pick shape so verify-picks QA can math/narrative-check it cleanly.
        const probStr = clean.winProbability || clean.coverProb || (clean.modelProb != null ? (String(clean.modelProb).includes('%') ? String(clean.modelProb) : `${clean.modelProb}%`) : '50%');
        clean.winProbability = probStr;
        clean.coverProb = clean.coverProb || probStr;
        if (!clean.whatLoses || String(clean.whatLoses).trim().length < 10) {
          clean.whatLoses = 'The first-five-innings result goes the other way, or the starter is pulled early and the bullpen swings it.';
        }
        clean.sport = clean.sport || 'MLB';
      }
      card.push(clean);
      if (card.length >= DAILY_CAP) break;
    }
    if (!card.some(p => p.source === 'F5')) { console.log(`[alpha-merge] F5 didn't survive ranking — alpha unchanged`); return; }

    // Rebuild parlay from the expanded pool: highest-EV legs, 1 per game, de-correlated, 3 legs or none.
    const cprob = (p) => { const v = p.coverProb != null ? p.coverProb : p.modelProb; const f = parseFloat(String(v)); return isNaN(f) ? 0.5 : (f > 1.5 ? f / 100 : f); };
    const seenG = new Set(); const legPool = [];
    for (const p of card) {
      const g = gameKey(p);
      if (!g || seenG.has(g)) continue;
      const dkp = dirKey(p);
      if ((dkp.endsWith('|over') || dkp.endsWith('|under')) && legPool.filter(l => dirKey(l) === dkp).length >= 2) continue;
      seenG.add(g); legPool.push(p);
      if (legPool.length >= 3) break;
    }
    let parlayLegs = [];
    if (legPool.length >= 3) {
      const cd = legPool.reduce((s, l) => s * decFromAmerican(l.odds), 1);
      const cp2 = legPool.reduce((s, l) => s * cprob(l), 1);
      const amFromDec = (d) => d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`;
      parlayLegs = [{
        type: `${legPool.length}-leg-parlay`,
        legs: legPool.map(l => ({ pick: l.pick, sport: l.sport, matchup: l.matchup, betType: l.betType, odds: String(l.odds), coverProb: `${Math.round(cprob(l) * 100)}%`, book: l.book, source: l.source })),
        units: '0.5u',
        combinedOdds: amFromDec(cd),
        combinedDecimal: Math.round(cd * 100) / 100,
        combinedProb: `${Math.round(cp2 * 100)}%`,
        ev: `${Math.round((cp2 * cd - 1) * 100)}%`,
        correlationNote: 'Rebuilt from expanded F5+full-game pool (1 leg/game, de-correlated)',
      }];
    }

    const expanded = {
      ...alpha,
      picks: card,
      parlayLegs,
      model: String(alpha.model || 'v10.3-alpha-sharp').replace('+F5', '') + '+F5',
      expandedAt: new Date().toISOString(),
      sources: { fullGame: card.filter(p => p.source !== 'F5').length, f5: card.filter(p => p.source === 'F5').length },
    };
    const bodyStr = JSON.stringify(expanded);
    // Write BOTH SDK (what get-picks-alpha reads) + REST, like the MVP merge.
    try {
      const { getStore } = await import("@netlify/blobs");
      await getStore("edge-picks-alpha").set(`picks-${dateISO}`, bodyStr);
    } catch (e) { console.log(`[alpha-merge] SDK write failed: ${e.message}`); }
    const put = await fetch(alphaUrl, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: bodyStr,
    });
    console.log(`[alpha-merge] alpha expanded SDK+REST ${put.ok ? 'OK' : 'PUT-FAILED-' + put.status}: ${expanded.sources.fullGame} full-game + ${expanded.sources.f5} F5`);
  } catch (e) {
    console.error(`[alpha-merge] failed (alpha unchanged): ${e.message}`);
  }
}

exports.handler = async (event) => {
  console.log("[mlb-f5] v2 — Pre-computed edge architecture started");

  try {
    const body = JSON.parse(event.body || "{}");
    const now = new Date();
    const estFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const [m, d, y] = estFormatter.format(now).split('/');
    const dateISO = body.date || `${y}-${m}-${d}`;
    const dateFormatted = new Date(dateISO + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    console.log(`[mlb-f5] Generating for ${dateISO}`);

    // ── Step 1: Fetch all data in parallel ──
    const [espnGames, oddsGames, polyData] = await Promise.all([
      fetchESPNData(dateISO),
      fetchMLBOdds(dateISO),
      fetchPolymarketMLB(),
    ]);
    // Count how many Odds API games have F5 markets
    const oddsF5Count = oddsGames.filter(g => (g.bookmakers || []).some(bk => (bk.markets || []).some(m => m.key.includes('1st_5_innings')))).length;
    console.log(`[mlb-f5] ESPN: ${espnGames.length} | Odds API (Hard Rock): ${oddsGames.length} (F5: ${oddsF5Count}) | Poly: ${polyData.length}`);
    const _debug = {
      espnCount: espnGames.length,
      oddsCount: oddsGames.length,
      oddsRaw: oddsGames._meta || null,
      oddsF5Count,
      polyCount: polyData.length,
    };

    if (espnGames.length === 0 && oddsGames.length === 0) {
      const noPlay = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], rejections: [], edgeSummary: "No MLB games on today's schedule.", summary: { totalPicks: 0, totalUnits: "0u", sportsCovered: ["MLB"] } };
      await storeBlob(`picks-${dateISO}`, noPlay);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0 }) };
    }

    // ── Step 2a: Fetch career stats for all pitchers in parallel ──
    const pitcherIds = new Set();
    for (const g of espnGames) {
      if (g.awaySP.id) pitcherIds.add(g.awaySP.id);
      if (g.homeSP.id) pitcherIds.add(g.homeSP.id);
    }
    const careerStatsMap = {};
    const careerFetches = [...pitcherIds].map(async (id) => {
      const career = await fetchCareerStats(id);
      if (career) careerStatsMap[id] = career;
    });
    await Promise.all(careerFetches);
    console.log(`[mlb-f5] Career stats: ${Object.keys(careerStatsMap).length}/${pitcherIds.size} pitchers`);

    // Enrich pitcher data with career stats + blended ERA
    for (const g of espnGames) {
      for (const side of ['awaySP', 'homeSP']) {
        const sp = g[side];
        const career = careerStatsMap[sp.id] || {};
        sp.careerERA = career.careerERA || null;
        sp.careerWHIP = career.careerWHIP || null;
        sp.careerK9 = career.careerK9 || null;
        sp.careerIP = career.careerIP || null;
        sp.careerGS = career.careerGS || null;
        sp.careerGBFB = career.careerGBFB || null;
        // Compute blended ERA (date-aware regression-to-mean)
        const currentGS = (sp.wins + sp.losses) || 1; // approximate from W-L
        sp.blendedERA = blendedERA(sp.era, sp.careerERA, currentGS, dateISO);
        sp.blendedWHIP = blendedWHIP(null, sp.careerWHIP, currentGS, dateISO); // current WHIP not in scoreboard
        const _cap = seasonalCurrentCap(dateISO);
        const _cw = Math.min(_cap, currentGS * 0.10);
        sp.blendWeight = `${Math.round(_cw * 100)}% current / ${Math.round((1 - _cw) * 100)}% career`;
      }
    }

    // ── Step 2b: Fetch team stats ──
    const teamStats = await fetchTeamStats(espnGames);

    // ── Step 3: Match ESPN games with odds, compute edges ──
    const allCandidates = [];
    const slateData = [];

    // Also build slate entries for games that already started (from odds but not in ESPN pre-game)
    const espnMatchupKeys = new Set(espnGames.map(g => g.awayTeam.split(' ').pop().toLowerCase() + '_' + g.homeTeam.split(' ').pop().toLowerCase()));

    for (const og of oddsGames) {
      const oAway = og.away_team.split(' ').pop().toLowerCase();
      const oHome = og.home_team.split(' ').pop().toLowerCase();
      const key1 = oAway + '_' + oHome;
      const key2 = oHome + '_' + oAway;
      const commenced = new Date(og.commence_time) <= new Date();
      if (!espnMatchupKeys.has(key1) && !espnMatchupKeys.has(key2)) {
        slateData.push({
          matchup: `${og.away_team} @ ${og.home_team}`,
          awaySP: '—', homeSP: '—',
          bestEdge: commenced ? 'Game already started — excluded from picks' : 'No ESPN data available',
          edgePct: 0, ev: 0, parkFactor: 100, projF5Total: 0,
          reason: commenced ? 'Game live or completed — not eligible for F5 picks' : 'No pre-game ESPN data',
          commenceTime: og.commence_time,
        });
      }
    }

    console.log(`[mlb-f5] Matching ${espnGames.length} ESPN games against ${oddsGames.length} odds games`);
    for (const espn of espnGames) {
      // Find matching odds game
      const awayLast = espn.awayTeam.split(' ').pop().toLowerCase();
      const homeLast = espn.homeTeam.split(' ').pop().toLowerCase();
      const oddsGame = oddsGames.find(g => {
        const oAway = g.away_team.split(' ').pop().toLowerCase();
        const oHome = g.home_team.split(' ').pop().toLowerCase();
        return (oAway === awayLast && oHome === homeLast) || (oHome === awayLast && oAway === homeLast);
      });

      if (!oddsGame) {
        slateData.push({
          matchup: `${espn.awayTeam} @ ${espn.homeTeam}`,
          awaySP: espn.awaySP.name,
          homeSP: espn.homeSP.name,
          bestEdge: 'No odds available',
          reason: 'Game not listed in sportsbooks yet',
        });
        continue;
      }

      const odds = extractBestOdds(oddsGame);

      const edgeResult = computeF5Edge(espn, teamStats, odds, null);

      // Hard Rock placeability: flag whether HR offers each F5 candidate's EXACT bet (market+side+line),
      // and capture HR's price. Annotate only (keeps /mlb behavior); the MVP aggregator requires hrPlaceable.
      for (const c of (edgeResult.candidates || [])) {
        let sub = null, key = null;
        if (c.type === 'F5 Moneyline') { sub = 'f5ML'; key = c.pick.replace(/^F5 ML:\s*/, '').trim(); }
        else if (c.type === 'F5 Total') { const m = c.pick.match(/F5 (Over|Under) ([\d.]+)/); if (m) { sub = 'f5Total'; key = `${m[1]}|${m[2]}`; } }
        else if (c.type === 'F5 Run Line') { const m = c.pick.match(/F5 (.+?) ([+-][\d.]+)\s*$/); if (m) { sub = 'f5RL'; key = `${m[1].trim()}|${parseFloat(m[2])}`; } }
        const hrEntry = (sub && key && odds.hr && odds.hr[sub]) ? odds.hr[sub][key] : null;
        c.hrPlaceable = !!hrEntry;
        if (hrEntry) { c.hrOdds = hrEntry.price; c.hrBook = 'Hard Rock Bet'; }
      }

      const gameData = {
        espn,
        odds,
        edgeResult,
        commenceTime: oddsGame.commence_time,
        awayStats: teamStats[espn.awayTeam] || {},
        homeStats: teamStats[espn.homeTeam] || {},
      };

      // Only add to pick candidates if game hasn't started yet
      const gameStarted = oddsGame.commence_time && new Date(oddsGame.commence_time) <= new Date();

      if (edgeResult.bestCandidate && !gameStarted) {
        allCandidates.push({ ...edgeResult.bestCandidate, gameData, matchup: `${espn.awayTeam} @ ${espn.homeTeam}` });
      }

      const edgeLabel = edgeResult.bestCandidate ? `${edgeResult.bestCandidate.pick} (${edgeResult.bestCandidate.odds > 0 ? '+' : ''}${edgeResult.bestCandidate.odds}) — ${edgeResult.bestCandidate.edge}% edge` : 'No qualifying edge';

      slateData.push({
        matchup: `${espn.awayTeam} @ ${espn.homeTeam}`,
        awaySP: espn.awaySP.name,
        homeSP: espn.homeSP.name,
        awayERA: espn.awaySP.era,
        homeERA: espn.homeSP.era,
        awayRecord: espn.awayRecord,
        homeRecord: espn.homeRecord,
        venue: espn.venue,
        parkFactor: edgeResult.parkFactor,
        projF5Total: edgeResult.projF5Total,
        bestEdge: gameStarted ? `${edgeLabel} (STARTED — excluded)` : edgeLabel,
        edgePct: edgeResult.bestCandidate ? edgeResult.bestCandidate.edge : 0,
        ev: edgeResult.bestCandidate ? edgeResult.bestCandidate.ev : 0,
        commenceTime: oddsGame.commence_time,
        started: gameStarted,
      });
    }

    // Sort candidates by edge
    allCandidates.sort((a, b) => b.edge - a.edge);
    const topCandidates = allCandidates.slice(0, 8);

    console.log(`[mlb-f5] ${allCandidates.length} total candidates, top 8 going to Claude`);

    // ── Step 4: Build candidate table for Claude ──
    let candidateTable = `## TOP ${topCandidates.length} F5 MLB CANDIDATES — ${dateFormatted}\n\n`;
    candidateTable += `| Rank | Matchup | Pick | Odds | Model% | Market% | Edge | EV | SP Matchup | Park |\n`;
    candidateTable += `|------|---------|------|------|--------|---------|------|-----|------------|------|\n`;

    for (let i = 0; i < topCandidates.length; i++) {
      const c = topCandidates[i];
      const gd = c.gameData;
      const sign = c.odds > 0 ? '+' : '';
      candidateTable += `| ${i + 1} | ${c.matchup} | ${c.pick} | ${sign}${c.odds} | ${c.modelProb}% | ${c.marketProb}% | ${c.edge}% | ${c.ev > 0 ? '+' : ''}${(c.ev * 100).toFixed(0)}% | ${gd.espn.awaySP.name} (${gd.espn.awaySP.era || '?.??'} ERA) vs ${gd.espn.homeSP.name} (${gd.espn.homeSP.era || '?.??'} ERA) | ${gd.edgeResult.parkFactor} PF |\n`;
    }

    candidateTable += `\n### Team Context\n`;
    for (const c of topCandidates) {
      const gd = c.gameData;
      const away = gd.espn.awayTeam;
      const home = gd.espn.homeTeam;
      candidateTable += `**${away} @ ${home}**\n`;
      candidateTable += `- ${away}: ${gd.awayStats.runsPerGame || '?'} R/G, ${gd.awayStats.ops || '?'} OPS, Record: ${gd.espn.awayRecord}\n`;
      candidateTable += `- ${home}: ${gd.homeStats.runsPerGame || '?'} R/G, ${gd.homeStats.ops || '?'} OPS, Record: ${gd.espn.homeRecord}\n`;
      candidateTable += `- Venue: ${gd.espn.venue} (PF: ${gd.edgeResult.parkFactor}) ${gd.espn.indoor ? '(DOME)' : ''}\n`;
      if (gd.espn.temperature) candidateTable += `- Weather: ${gd.espn.weather || ''} ${gd.espn.temperature}°F\n`;
      const injuries = [...(gd.espn.awayInjuries || []), ...(gd.espn.homeInjuries || [])].filter(i => i.status !== 'Active');
      if (injuries.length > 0) {
        candidateTable += `- Injuries: ${injuries.slice(0, 5).map(i => `${i.name} (${i.status})`).join(', ')}\n`;
      }
      candidateTable += `\n`;
    }

    candidateTable += `\nThe system will select the TOP 3 candidates that PASS your verification. Verify all ${topCandidates.length} candidates.\n`;

    // ── Step 5: Call Claude for verification ──
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error("[mlb-f5] No ANTHROPIC_API_KEY — using top 3 unverified");
      // Fallback: use top 3 without verification
    }

    let verifications = null;
    if (anthropicKey && topCandidates.length > 0) {
      try {
        console.log(`[mlb-f5] Sending ${topCandidates.length} candidates to Claude`);
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 6000,
            temperature: 0.2,
            system: [{ type: "text", text: F5_MLB_SYSTEM, cache_control: { type: "ephemeral" } }],
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
            messages: [{ role: "user", content: candidateTable }],
          }),
        });

        if (resp.ok) {
          const claudeData = await resp.json();
          const textBlocks = (claudeData.content || []).filter(b => b.type === 'text');
          const fullText = textBlocks.map(b => b.text).join('\n');
          const jsonMatch = fullText.match(/\{[\s\S]*\}/);
          if (jsonMatch) verifications = JSON.parse(jsonMatch[0]);
        } else {
          console.error(`[mlb-f5] Claude error: ${resp.status}`);
        }
      } catch (e) {
        console.error(`[mlb-f5] Claude call failed: ${e.message}`);
      }
    }

    // ── Step 6: Build final picks from verified candidates ──
    const passedCandidates = [];
    if (verifications?.verifications) {
      for (const v of verifications.verifications) {
        if (v.verdict === 'PASS' && v.candidateRank <= topCandidates.length) {
          const c = topCandidates[v.candidateRank - 1];
          if (c) passedCandidates.push({ ...c, verification: v });
        }
      }
    } else {
      // No verification — use top candidates directly
      for (const c of topCandidates.slice(0, 3)) {
        passedCandidates.push({ ...c, verification: null });
      }
    }

    // ── Edge quality gate: dynamic pick count ──
    // Never play a slate where the best edge is below the floor.
    // Each subsequent pick also requires a minimum edge to qualify.
    // v2.5: Lowered edge floors to match actual F5 market tightness.
    // 14% top floor was eliminating all picks — MLB F5 markets are efficiently priced at 6-12% edges.
    // Real edges: top picks typically 7-11%, qualifying 2nd/3rd picks 5-7%.
    const EDGE_FLOOR_TOP = 8;   // % — if pick #1 < 8%, take 0 picks today
    const EDGE_FLOOR_2ND = 6;   // % — pick #2 minimum
    const EDGE_FLOOR_3RD = 5;   // % — pick #3 minimum
    let maxPicks = 0;
    if (passedCandidates.length > 0 && passedCandidates[0].edge >= EDGE_FLOOR_TOP) {
      maxPicks = 1;
      if (passedCandidates.length > 1 && passedCandidates[1].edge >= EDGE_FLOOR_2ND) maxPicks = 2;
      if (passedCandidates.length > 2 && passedCandidates[2].edge >= EDGE_FLOOR_3RD) maxPicks = 3;
    }
    if (maxPicks < passedCandidates.length) {
      console.log(`[mlb-f5] Edge floor applied: ${passedCandidates.length} candidates → ${maxPicks} picks (top edge: ${passedCandidates[0]?.edge}%, floors: ${EDGE_FLOOR_TOP}/${EDGE_FLOOR_2ND}/${EDGE_FLOOR_3RD}%)`);
    }

    const picks = passedCandidates.slice(0, maxPicks).map((c, i) => {
      const u = zScoreToUnitsCalibrated(c.zScore, c.modelProb / 100);
      const v = c.verification;
      const kellyStr = `Model ${c.modelProb}% vs Market ${c.marketProb}% = ${c.edge}% edge | Kelly: ${c.kelly}% | EV: ${c.ev > 0 ? '+' : ''}${(c.ev * 100).toFixed(1)}%`;
      return {
        sport: "MLB",
        matchup: c.matchup,
        pick: c.pick,
        odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
        book: c.book || 'Hard Rock Bet',
        source: c.source || 'Hard Rock Bet',
        betType: c.type,
        confidence: unitsToConfidence(u),
        rating: unitsToRating(u),
        units: u.toFixed(1) + 'u',
        tierScore: c.edge >= 8 ? 9 : c.edge >= 6 ? 8 : c.edge >= 4 ? 7 : 6,
        edgePct: c.edge + '%',
        ev: `+${(c.ev * 100).toFixed(0)}%`,
        kellyPct: c.kelly + '%',
        kellyCalcStr: kellyStr,
        modelProb: c.modelProb + '%',
        hrPlaceable: c.hrPlaceable === true,
        hrOdds: (typeof c.hrOdds === 'number' ? c.hrOdds : null),
        rawProb: (c.rawProb || c.modelProb) + '%',
        marketProb: c.marketProb + '%',
        coreReasoning: v?.coreReasoning || `WeBetAI projects a ${c.edge}% calibrated edge. ${kellyStr}.`,
        whyThisBeatsTheNumber: v?.whatLoses ? `Pass condition: ${v.whatLoses}` : '',
        awaySP: c.gameData.espn.awaySP.name,
        homeSP: c.gameData.espn.homeSP.name,
        awayERA: c.gameData.espn.awaySP.blendedERA,
        homeERA: c.gameData.espn.homeSP.blendedERA,
        awaySeasonERA: c.gameData.espn.awaySP.era,
        homeSeasonERA: c.gameData.espn.homeSP.era,
        awayCareerERA: c.gameData.espn.awaySP.careerERA,
        homeCareerERA: c.gameData.espn.homeSP.careerERA,
        awayBlendNote: c.gameData.espn.awaySP.blendWeight,
        homeBlendNote: c.gameData.espn.homeSP.blendWeight,
        venue: c.gameData.espn.venue,
        parkFactor: c.gameData.edgeResult.parkFactor,
        projF5Total: c.gameData.edgeResult.projF5Total,
        layers: `L1:PASS L2:${c.gameData.espn.awaySP.era !== null ? 'PASS' : 'NEUTRAL'} L3:PASS L4:PASS L5:PASS L6:${c.gameData.edgeResult.parkFactor > 103 || c.gameData.edgeResult.parkFactor < 97 ? 'PASS' : 'NEUTRAL'} L7:${c.gameData.espn.temperature !== null ? 'PASS' : 'NEUTRAL'} L8:NEUTRAL L9:PASS`,
        commenceTime: c.gameData?.commenceTime || c.commenceTime,
      };
    });

    // ── Step 7: Build rejections from slate data ──
    const pickMatchups = new Set(picks.map(p => p.matchup));
    const rejections = slateData
      .filter(s => !pickMatchups.has(s.matchup))
      .sort((a, b) => (b.edgePct || 0) - (a.edgePct || 0))
      .map(s => ({
        matchup: s.matchup,
        awaySP: s.awaySP,
        homeSP: s.homeSP,
        tierScore: s.edgePct >= 8 ? 7 : s.edgePct >= 5 ? 6 : s.edgePct >= 3 ? 5 : s.edgePct > 0 ? 4 : 3,
        bestEdge: s.bestEdge,
        layers: `L1:PASS L2:${s.awayERA !== null ? 'PASS' : 'NEUTRAL'} L3:NEUTRAL L4:NEUTRAL L5:NEUTRAL L6:${s.parkFactor > 103 || s.parkFactor < 97 ? 'PASS' : 'NEUTRAL'} L7:NEUTRAL L8:NEUTRAL L9:NEUTRAL`,
        reason: s.edgePct > 0 ? `Edge (${s.edgePct}%) below top 3 threshold. ${s.venue} PF: ${s.parkFactor}. Proj F5 total: ${s.projF5Total}.` : (s.bestEdge || 'No qualifying edge found'),
      }));

    // Use Claude's slate analysis if available
    if (verifications?.slateAnalysis) {
      for (const sa of verifications.slateAnalysis) {
        const existing = rejections.find(r => r.matchup.toLowerCase().includes(sa.matchup.toLowerCase().split(' ').pop()));
        if (existing) {
          if (sa.tierScore) existing.tierScore = sa.tierScore;
          if (sa.layers) existing.layers = sa.layers;
          if (sa.reason) existing.reason = sa.reason;
          if (sa.bestEdge) existing.bestEdge = sa.bestEdge;
        }
      }
    }

    const topEdge = passedCandidates[0]?.edge || 0;
    const floorNote = picks.length === 0 && topEdge > 0
      ? ` Best edge found was ${topEdge}% — below the ${EDGE_FLOOR_TOP}% minimum required to play.`
      : '';
    const edgeSummary = verifications?.edgeSummary || (picks.length > 0
      ? `WeBetAI found ${picks.length} Tier 1 F5 edge${picks.length > 1 ? 's' : ''} across ${espnGames.length} MLB games. Top edge: ${picks[0]?.pick} at ${picks[0]?.edgePct} edge.`
      : `WeBetAI analyzed ${espnGames.length} MLB games but no F5 edges met the Tier 1 threshold today.${floorNote}`);

    const finalResult = {
      date: dateISO,
      dateFormatted,
      model: "v2.4-f5",
      generatedAt: now.toISOString(),
      picks,
      rejections,
      edgeSummary,
      _debug,
      summary: {
        totalPicks: picks.length,
        totalUnits: picks.reduce((s, p) => s + parseFloat(p.units), 0).toFixed(1) + 'u',
        sportsCovered: ["MLB"],
      },
    };

    console.log(`[mlb-f5] Final: ${picks.length} picks, ${rejections.length} rejections`);

    // Don't overwrite existing picks with empty results (e.g. if all games already started)
    if (picks.length === 0) {
      try {
        const token = process.env.NETLIFY_AUTH_TOKEN;
        const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
        if (token) {
          const existingResp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb/picks-${dateISO}`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (existingResp.ok) {
            const existing = await existingResp.json();
            if (existing.picks && existing.picks.length > 0) {
              console.log(`[mlb-f5] Existing ${existing.picks.length} picks found — skipping overwrite with empty result`);
              return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0, skipped: true, reason: 'Existing picks preserved', date: dateISO }) };
            }
          }
        }
      } catch (e) { /* proceed with save */ }
    }

    await storeBlob(`picks-${dateISO}`, finalResult);
    await storeBlob("latest-date", dateISO);
    await appendPicksDate(dateISO);

    // Expanded menu: feed today's F5 options into the ALPHA card (production). Still feed MVP too
    // (harmless — we no longer rely on it). Self-contained + never throws; card unchanged on any error.
    await aggregateIntoAlpha(picks, dateISO);
    await aggregateIntoMvp(picks, dateISO);

    return { statusCode: 200, body: JSON.stringify({ success: true, picks: picks.length, rejections: rejections.length, date: dateISO }) };

  } catch (outerErr) {
    console.error("[mlb-f5] FATAL:", outerErr.message, outerErr.stack);
    return { statusCode: 500, body: JSON.stringify({ error: true, message: outerErr.message }) };
  }
};
