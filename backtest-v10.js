#!/usr/bin/env node
// backtest-v10.js — Historical backtest of v10 deterministic edge model
// Mirrors EXACT production logic from generate-picks-background.js:
//   - Same computeKelly (quarter-Kelly, 0.5u steps, 0.5–3.0u clamp)
//   - Same calibration caps, same 4u daily exposure cap
//   - Same drawdown detection (3+ consecutive losing days → 0.75× Kelly)
//   - 3 straight picks + 0.5u 3-leg parlay per day (as /edge does)
//   - $150/unit bankroll sizing
//
// Usage: node backtest-v10.js
// Window: Dec 20 2025 → Mar 27 2026 (30 warmup + 68 pick days)

const fs = require('fs');

const ODDS_API_KEY = process.env.ODDS_API_KEY || '095eca920f14406aa61f02718c189c93';
const OUTPUT_FILE = './finalboss/backtest-results.json';
const DOLLAR_PER_UNIT = 150;

// ── Sport config ──
const SPORTS = [
  { oddsKey: 'basketball_nba', espnSport: 'basketball', espnLeague: 'nba', label: 'NBA', std: 12, homeAdv: 100, kFactor: 20 },
  { oddsKey: 'icehockey_nhl', espnSport: 'hockey', espnLeague: 'nhl', label: 'NHL', std: 1.2, homeAdv: 60, kFactor: 20 },
  { oddsKey: 'basketball_ncaab', espnSport: 'basketball', espnLeague: 'mens-college-basketball', label: 'NCAAB', std: 11, homeAdv: 120, kFactor: 32 },
];

// ── Calibration caps (identical to production COVER_PROB_CAPS) ──
const COVER_CAPS = {
  'NHL_Puck Line': 0.60, 'NHL_Total': 0.75,
  'NBA_Spread': 0.72, 'NBA_Total': 0.75,
  'NCAAB_Spread': 0.72, 'NCAAB_Total': 0.75,
};

// ── Minimum edge thresholds (identical to production SPORT_MIN_EDGE + totalMinEdge) ──
const SPORT_MIN_EDGE = { NBA: 2.0, NCAAB: 2.0, NHL: 0.3 };
function getTotalMinEdge(sport) {
  if (sport === 'NHL') return 0.5;
  if (sport === 'MLB') return 0.8;
  return 3.0; // NBA, NCAAB
}

// ── Math (identical to production) ──
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1; const t=1/(1+p*Math.abs(x));
  const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normalCDF(z) { return 0.5*(1+erf(z/Math.sqrt(2))); }
function eloExpected(a,b) { return 1/(1+Math.pow(10,(b-a)/400)); }
function americanToDecimal(o) { return o>0?1+o/100:1+100/Math.abs(o); }
function cappedCover(raw,sport,market) { return Math.min(raw, COVER_CAPS[sport+'_'+market]||0.75); }
function marginMultiplier(mov, eloDiff) { return Math.log(Math.abs(mov)+1) * (2.2/((Math.abs(eloDiff)*0.001)+2.2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dateRange(startStr, endStr) {
  const dates = [];
  const d = new Date(startStr + 'T12:00:00Z');
  const end = new Date(endStr + 'T12:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function unitsToRating(u) {
  if (u >= 2.5) return "A+";
  if (u >= 1.5) return "A";
  if (u >= 1.0) return "A-";
  if (u >= 0.5) return "B+";
  return "B";
}

// ── Production computeKelly (EXACT copy from generate-picks-background.js) ──
function computeKelly(coverProb, odds, drawdownActive) {
  const decPayout = americanToDecimal(odds);
  const edge = (coverProb * decPayout) - 1;
  if (edge <= 0) return { kellyFraction: 0, units: 0, ev: edge, decPayout };
  let kellyQuarter = (edge / (decPayout - 1)) * 0.25;
  if (drawdownActive) kellyQuarter *= 0.75;
  let units = kellyQuarter * 10; // 10u bankroll basis
  units = Math.round(units * 2) / 2; // round to 0.5u steps
  units = Math.max(0.5, Math.min(3.0, units));
  return { kellyFraction: kellyQuarter, units, ev: edge, decPayout };
}

// ── Parlay math ──
function computeParlayOdds(legs) {
  let combinedDec = 1;
  for (const leg of legs) {
    combinedDec *= americanToDecimal(leg.oddsNum);
  }
  return combinedDec;
}

function parlayAmericanOdds(decOdds) {
  if (decOdds >= 2.0) return '+' + Math.round((decOdds - 1) * 100);
  return '-' + Math.round(100 / (decOdds - 1));
}

// ── Fetch ESPN scores ──
async function fetchESPNScores(dateISO, sport) {
  const dateParam = dateISO.replace(/-/g, '');
  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.espnSport}/${sport.espnLeague}/scoreboard?dates=${dateParam}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const games = [];
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      const state = ev.status?.type?.state;
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      games.push({
        home: home.team?.displayName || '?',
        away: away.team?.displayName || '?',
        homeScore: parseInt(home.score || '0'),
        awayScore: parseInt(away.score || '0'),
        state: state || 'pre',
      });
    }
    return games;
  } catch (e) { return []; }
}

// ── Fetch historical odds ──
async function fetchHistoricalOdds(dateISO, sport) {
  try {
    const isoDate = dateISO + 'T15:00:00Z'; // 10am ET = 15:00 UTC
    const url = `https://api.the-odds-api.com/v4/historical/sports/${sport.oddsKey}/odds?date=${isoDate}&regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) { if (resp.status !== 422) console.log(`  Odds API ${resp.status} for ${sport.label} on ${dateISO}`); return []; }
    const wrapper = await resp.json();
    const data = wrapper.data || wrapper;
    if (!Array.isArray(data)) return [];
    return data.filter(g => {
      if (!g.commence_time) return false;
      const gt = new Date(g.commence_time);
      const estParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(gt).split('/');
      return `${estParts[2]}-${estParts[0]}-${estParts[1]}` === dateISO;
    });
  } catch (e) { console.log(`  Odds error ${sport.label}: ${e.message}`); return []; }
}

// ── Build consensus from odds ──
function getConsensus(game) {
  let spreads = [], totals = [], spreadOddsH = [], spreadOddsA = [], totalOddsOver = [], totalOddsUnder = [];
  for (const b of (game.bookmakers || [])) {
    for (const m of (b.markets || [])) {
      if (m.key === 'spreads') {
        for (const o of m.outcomes) {
          if (o.point !== undefined) {
            if (o.name === game.home_team) { spreads.push(o.point); spreadOddsH.push(o.price); }
            else { spreadOddsA.push(o.price); }
          }
        }
      }
      if (m.key === 'totals') {
        for (const o of m.outcomes) {
          if (o.point !== undefined) {
            if (o.name === 'Over') { totals.push(o.point); totalOddsOver.push(o.price); }
            if (o.name === 'Under') { totalOddsUnder.push(o.price); }
          }
        }
      }
    }
  }
  if (spreads.length === 0) return null;
  const med = arr => { arr.sort((a,b) => a-b); return arr[Math.floor(arr.length/2)]; };
  return {
    homeSpread: med(spreads),
    awaySpread: -med(spreads),
    total: totals.length > 0 ? med(totals) : null,
    homeSpreadOdds: spreadOddsH.length > 0 ? med(spreadOddsH) : -110,
    awaySpreadOdds: spreadOddsA.length > 0 ? med(spreadOddsA) : -110,
    overOdds: totalOddsOver.length > 0 ? med(totalOddsOver) : -110,
    underOdds: totalOddsUnder.length > 0 ? med(totalOddsUnder) : -110,
  };
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

(async () => {
  console.log('=== v10 BACKTEST — Production Mirror ===\n');

  const warmupStart = '2025-12-20';
  const warmupEnd   = '2026-01-18';
  const picksStart  = '2026-01-19';
  const picksEnd    = '2026-03-28'; // Extended through latest available data

  const warmupDates = dateRange(warmupStart, warmupEnd);
  const allStarExclude = new Set(['2026-02-13', '2026-02-15', '2026-02-16']);
  const picksDates  = dateRange(picksStart, picksEnd).filter(d => !allStarExclude.has(d));

  // ── DRAWDOWN TRACKING (matches production: 3+ consecutive losing days) ──
  let consecutiveLossDays = 0;
  let drawdownActive = false;

  // ── ELO SYSTEM ──
  const elo = {};

  function getTeam(name) {
    if (!elo[name]) elo[name] = { elo: 1500, games: 0, homeScored: [], homeAllowed: [], awayScored: [], awayAllowed: [] };
    return elo[name];
  }

  function updateElo(homeName, awayName, homeScore, awayScore, kFactor, homeAdv) {
    const home = getTeam(homeName), away = getTeam(awayName);
    const homeAdj = home.elo + homeAdv;
    const expHome = eloExpected(homeAdj, away.elo);
    const actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
    const mult = marginMultiplier(homeScore - awayScore, home.elo - away.elo);
    home.elo += kFactor * mult * (actualHome - expHome);
    away.elo += kFactor * mult * ((1 - actualHome) - (1 - expHome));
    home.homeScored.push(homeScore); home.homeAllowed.push(awayScore);
    away.awayScored.push(awayScore); away.awayAllowed.push(homeScore);
    if (home.homeScored.length > 10) { home.homeScored.shift(); home.homeAllowed.shift(); }
    if (away.awayScored.length > 10) { away.awayScored.shift(); away.awayAllowed.shift(); }
    home.games++; away.games++;
  }

  function getAvg(arr) { return arr.length > 0 ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

  // ── PHASE 1: ELO WARM-UP ──
  console.log(`Phase 1: Elo warm-up (${warmupDates.length} days)...`);
  for (const date of warmupDates) {
    for (const sport of SPORTS) {
      const games = await fetchESPNScores(date, sport);
      for (const g of games.filter(g => g.state === 'post'))
        updateElo(g.home, g.away, g.homeScore, g.awayScore, sport.kFactor, sport.homeAdv);
    }
    if (warmupDates.indexOf(date) % 10 === 0) process.stdout.write(`  ${date} (${Object.keys(elo).length} teams)...\r`);
    await sleep(100);
  }
  console.log(`\n  Warm-up complete. ${Object.keys(elo).length} teams rated.\n`);

  // ── PHASE 2: PICKS ──
  console.log(`Phase 2: Generating picks (${picksDates.length} days)...\n`);

  const allDays = [];

  for (const date of picksDates) {
    process.stdout.write(`  ${date}...`);

    // 2a: Build all candidates
    const dayCandidates = [];
    for (const sport of SPORTS) {
      const oddsGames = await fetchHistoricalOdds(date, sport);
      await sleep(200);

      for (const og of oddsGames) {
        const homeR = getTeam(og.home_team), awayR = getTeam(og.away_team);
        if (homeR.games < 3 || awayR.games < 3) continue;

        const cons = getConsensus(og);
        if (!cons) continue;

        const projH = ((getAvg(homeR.homeScored)||100) + (getAvg(awayR.awayAllowed)||100)) / 2;
        const projA = ((getAvg(awayR.awayScored)||100) + (getAvg(homeR.homeAllowed)||100)) / 2;
        const projSpread = -(projH - projA);
        const projTotal = projH + projA;

        // ── SPREAD CANDIDATE ──
        const sEdge = Math.abs(projSpread - cons.homeSpread);
        const spreadMinEdge = SPORT_MIN_EDGE[sport.label] || 2.0;
        if (sEdge >= spreadMinEdge) {
          const mkt = sport.label === 'NHL' ? 'Puck Line' : 'Spread';
          const cover = cappedCover(normalCDF(sEdge / sport.std), sport.label, mkt);
          const isHome = projSpread < cons.homeSpread;
          const odds = isHome ? cons.homeSpreadOdds : cons.awaySpreadOdds;
          if (odds >= -250) {
            const k = computeKelly(cover, odds, drawdownActive);
            if (k.ev > 0.03) {
              const side = isHome
                ? `${og.home_team} ${cons.homeSpread > 0 ? '+' : ''}${cons.homeSpread}`
                : `${og.away_team} ${cons.awaySpread > 0 ? '+' : ''}${cons.awaySpread}`;
              dayCandidates.push({
                sport: sport.label, home: og.home_team, away: og.away_team,
                market: mkt, side, odds, edge: +sEdge.toFixed(1), cover: +cover.toFixed(4),
                ev: +k.ev.toFixed(4), units: k.units, zScore: +(sEdge / sport.std).toFixed(3),
                winProb: `${(cover * 100).toFixed(0)}%`,
                modelProjection: +projSpread.toFixed(1), consensusLine: cons.homeSpread,
                projH: +projH.toFixed(1), projA: +projA.toFixed(1),
                kellyCalc: `cover=${cover.toFixed(3)}, dec=${k.decPayout.toFixed(3)}, edge=${k.ev.toFixed(3)}, qK=${k.kellyFraction.toFixed(4)}, units=${k.units}u`,
              });
            }
          }
        }

        // ── TOTAL CANDIDATE ──
        if (cons.total) {
          const tEdge = Math.abs(projTotal - cons.total);
          const totalMinEdge = getTotalMinEdge(sport.label);
          if (tEdge >= totalMinEdge) {
            const cover = cappedCover(normalCDF(tEdge / sport.std), sport.label, 'Total');
            const isOver = projTotal > cons.total;
            const odds = isOver ? (cons.overOdds || -110) : (cons.underOdds || -110);
            const k = computeKelly(cover, odds, drawdownActive);
            if (k.ev > 0.03) {
              dayCandidates.push({
                sport: sport.label, home: og.home_team, away: og.away_team,
                market: 'Total', side: `${isOver ? 'Over' : 'Under'} ${cons.total}`,
                odds, edge: +tEdge.toFixed(1), cover: +cover.toFixed(4),
                ev: +k.ev.toFixed(4), units: k.units, zScore: +(tEdge / sport.std).toFixed(3),
                winProb: `${(cover * 100).toFixed(0)}%`,
                modelProjection: +projTotal.toFixed(1), consensusLine: cons.total,
                projH: +projH.toFixed(1), projA: +projA.toFixed(1),
                kellyCalc: `cover=${cover.toFixed(3)}, dec=${k.decPayout.toFixed(3)}, edge=${k.ev.toFixed(3)}, qK=${k.kellyFraction.toFixed(4)}, units=${k.units}u`,
              });
            }
          }
        }
      }
    }

    // 2b: Select top 3 (always 3, relaxing threshold if needed)
    dayCandidates.sort((a,b) => b.ev - a.ev);
    const sel = [];
    const usedGames = new Set();
    const thresholds = [0.03, 0.01, 0];
    for (const thr of thresholds) {
      for (const c of dayCandidates) {
        if (sel.length >= 3) break;
        const gk = `${c.home}|${c.away}`;
        if (usedGames.has(gk)) continue;
        if (c.ev > thr) { sel.push({...c}); usedGames.add(gk); }
      }
      if (sel.length >= 3) break;
    }

    // 2c: 4u daily exposure cap (production logic: reduce smallest-unit picks by 0.5u)
    let totUnits = sel.reduce((s,p) => s+p.units, 0);
    if (totUnits > 4.0) {
      sel.sort((a,b) => a.units - b.units); // smallest first
      while (totUnits > 4.0) {
        let reduced = false;
        for (const p of sel) {
          if (p.units > 0.5) { p.units -= 0.5; totUnits -= 0.5; reduced = true; break; }
        }
        if (!reduced) break;
      }
    }

    // 2d: Grade each pick against ESPN final scores
    const dayPicks = [];
    for (const pick of sel) {
      let result = 'no_data', actualHome = null, actualAway = null;

      for (const sport of SPORTS) {
        if (sport.label !== pick.sport) continue;
        const scores = await fetchESPNScores(date, sport);
        for (const g of scores) {
          if (g.state !== 'post') continue;
          const hLast = g.home.toLowerCase().split(' ').pop();
          const pHome = pick.home.toLowerCase().split(' ').pop();
          const pAway = pick.away.toLowerCase().split(' ').pop();
          if ((hLast === pHome || g.home.toLowerCase().includes(pHome)) || hLast === pAway) {
            if (hLast === pHome || g.home.toLowerCase().includes(pHome)) {
              actualHome = g.homeScore; actualAway = g.awayScore;
            } else {
              actualHome = g.awayScore; actualAway = g.homeScore;
            }
            break;
          }
        }
        break;
      }

      if (actualHome === null) {
        result = 'no_data';
      } else if (pick.market === 'Total') {
        const totalPts = actualHome + actualAway;
        const line = parseFloat(pick.side.replace(/Over|Under/i, '').trim());
        const isOver = pick.side.toLowerCase().includes('over');
        result = totalPts === line ? 'push' : (isOver ? totalPts > line : totalPts < line) ? 'win' : 'loss';
      } else {
        const spreadMatch = pick.side.match(/([+-]?\d+\.?\d*)$/);
        if (spreadMatch) {
          const spread = parseFloat(spreadMatch[1]);
          const pickTeamLast = pick.side.replace(/[+-]?\d+\.?\d*$/, '').trim().toLowerCase().split(' ').pop();
          const isPickHome = pickTeamLast === pick.home.toLowerCase().split(' ').pop();
          const pickedScore = isPickHome ? actualHome : actualAway;
          const oppScore = isPickHome ? actualAway : actualHome;
          const adj = pickedScore + spread;
          result = adj === oppScore ? 'push' : adj > oppScore ? 'win' : 'loss';
        }
      }

      // Profit calc ($150/unit)
      let profit = 0;
      const dec = americanToDecimal(pick.odds);
      if (result === 'win') profit = pick.units * DOLLAR_PER_UNIT * (dec - 1);
      else if (result === 'loss') profit = -(pick.units * DOLLAR_PER_UNIT);

      dayPicks.push({
        sport: pick.sport,
        matchup: `${pick.away} @ ${pick.home}`,
        pick: pick.side,
        betType: pick.market,
        odds: `${pick.odds > 0 ? '+' : ''}${pick.odds}`,
        oddsNum: pick.odds,
        units: `${pick.units}u`,
        unitsNum: pick.units,
        rating: unitsToRating(pick.units),
        winProbability: pick.winProb,
        result,
        profit: Math.round(profit),
        risk: Math.round(pick.units * DOLLAR_PER_UNIT),
        toWin: Math.round(pick.units * DOLLAR_PER_UNIT * (dec - 1)),
        score: actualHome !== null ? `${actualAway}-${actualHome}` : null,
        edge: pick.edge,
        cover: pick.cover,
        ev: pick.ev,
        zScore: pick.zScore,
        modelEdge: `Model: ${pick.modelProjection}, Line: ${pick.consensusLine}, Edge: ${pick.edge}`,
        kellyCalc: pick.kellyCalc,
      });
    }

    // 2e: Build 3-leg parlay (0.5u risk — matches /edge production)
    // Parlay is ALWAYS created when we have 3 picks (as production does at pick time).
    // Grading: all 3 win → parlay wins. Any loss → parlay loses.
    // no_data/push legs → void (reduce to remaining legs, or void entire parlay).
    let parlay = null;
    if (dayPicks.length === 3) {
      const parlayDec = computeParlayOdds(dayPicks);
      const parlayRisk = 0.5 * DOLLAR_PER_UNIT; // $75
      const parlayWinnings = Math.round(parlayRisk * (parlayDec - 1));

      // Grade parlay: count live legs (exclude no_data/push as voided)
      const liveLegs = dayPicks.filter(l => l.result === 'win' || l.result === 'loss');
      const voidLegs = dayPicks.filter(l => l.result === 'no_data' || l.result === 'push');
      const anyLoss = liveLegs.some(l => l.result === 'loss');
      const allLiveWin = liveLegs.length > 0 && liveLegs.every(l => l.result === 'win');

      let parlayResult, parlayProfit;
      if (anyLoss) {
        parlayResult = 'loss';
        parlayProfit = -parlayRisk;
      } else if (allLiveWin && voidLegs.length === 0) {
        // All 3 legs won — full parlay payout
        parlayResult = 'win';
        parlayProfit = parlayWinnings;
      } else if (allLiveWin && voidLegs.length > 0) {
        // Some legs voided, remaining won — reduced parlay at live legs' combined odds
        const liveDec = liveLegs.reduce((acc, l) => acc * americanToDecimal(l.oddsNum), 1);
        parlayResult = 'win';
        parlayProfit = Math.round(parlayRisk * (liveDec - 1));
      } else if (liveLegs.length === 0) {
        // All legs voided — push
        parlayResult = 'push';
        parlayProfit = 0;
      } else {
        parlayResult = 'push';
        parlayProfit = 0;
      }

      parlay = {
        legs: dayPicks.map(l => ({ pick: l.pick, odds: l.odds, result: l.result, sport: l.sport, matchup: l.matchup, score: l.score })),
        combinedOdds: parlayAmericanOdds(parlayDec),
        combinedDec: +parlayDec.toFixed(3),
        units: '0.5u',
        risk: parlayRisk,
        toWin: parlayWinnings,
        result: parlayResult,
        profit: Math.round(parlayProfit),
      };
    }

    // 2f: Update Elo with today's results (AFTER picks — no lookahead)
    for (const sport of SPORTS) {
      const games = await fetchESPNScores(date, sport);
      for (const g of games.filter(g => g.state === 'post'))
        updateElo(g.home, g.away, g.homeScore, g.awayScore, sport.kFactor, sport.homeAdv);
    }

    // Day summary
    const graded = dayPicks.filter(r => r.result !== 'no_data');
    const dayWins = graded.filter(r => r.result === 'win').length;
    const dayLosses = graded.filter(r => r.result === 'loss').length;
    const dayPushes = graded.filter(r => r.result === 'push').length;
    const straightProfit = graded.reduce((s,r) => s + r.profit, 0);
    const parlayProfit = parlay ? parlay.profit : 0;
    const dayProfit = straightProfit + parlayProfit;
    const straightWagered = graded.reduce((s,r) => s + r.risk, 0);
    const parlayWagered = parlay ? parlay.risk : 0;
    const dayWagered = straightWagered + parlayWagered;
    const totalDayUnits = graded.reduce((s,r) => s + r.unitsNum, 0) + (parlay ? 0.5 : 0);

    // Drawdown tracking
    if (dayProfit < 0) consecutiveLossDays++;
    else if (dayProfit > 0) consecutiveLossDays = 0;
    drawdownActive = consecutiveLossDays >= 3;

    allDays.push({
      date,
      picks: dayPicks,
      parlay,
      numPicks: dayPicks.length,
      wins: dayWins,
      losses: dayLosses,
      pushes: dayPushes,
      straightProfit,
      parlayResult: parlay ? parlay.result : null,
      parlayProfit,
      profit: dayProfit,
      wagered: dayWagered,
      totalUnits: +totalDayUnits.toFixed(1),
      roi: dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '0',
      accuracy: (dayWins + dayLosses) > 0 ? ((dayWins / (dayWins + dayLosses)) * 100).toFixed(0) : '-',
      drawdownActive,
    });

    const pStr = parlay ? ` | Parlay: ${parlay.result.toUpperCase()} $${parlayProfit >= 0 ? '+' : ''}${parlayProfit}` : '';
    process.stdout.write(` ${dayPicks.length} picks (${dayWins}W-${dayLosses}L) Straight:$${straightProfit >= 0 ? '+' : ''}${straightProfit}${pStr} ${drawdownActive ? '⚠ DRAWDOWN' : ''}\n`);

    await sleep(100);
  }

  // ══════════════════════════════════════════════════
  // PHASE 3: CUMULATIVE STATS
  // ══════════════════════════════════════════════════

  const allStraights = allDays.flatMap(d => d.picks).filter(p => p.result !== 'no_data');
  const allParlays = allDays.filter(d => d.parlay).map(d => d.parlay);

  const sWins = allStraights.filter(p => p.result === 'win').length;
  const sLosses = allStraights.filter(p => p.result === 'loss').length;
  const sPushes = allStraights.filter(p => p.result === 'push').length;
  const sWagered = allStraights.reduce((s,p) => s + p.risk, 0);
  const sProfit = allStraights.reduce((s,p) => s + p.profit, 0);

  const pWins = allParlays.filter(p => p.result === 'win').length;
  const pLosses = allParlays.filter(p => p.result === 'loss').length;
  const pPushes = allParlays.filter(p => p.result === 'push').length;
  const pWagered = allParlays.reduce((s,p) => s + p.risk, 0);
  const pProfit = allParlays.reduce((s,p) => s + p.profit, 0);

  const totalWagered = sWagered + pWagered;
  const totalProfit = sProfit + pProfit;

  const cumulative = {
    // Straights
    totalPicks: allStraights.length,
    wins: sWins, losses: sLosses, pushes: sPushes,
    accuracy: ((sWins / (sWins + sLosses)) * 100).toFixed(1) + '%',
    straightWagered: sWagered,
    straightProfit: sProfit,
    straightROI: ((sProfit / sWagered) * 100).toFixed(1) + '%',
    // Parlays
    parlayTotal: allParlays.length,
    parlayWins: pWins, parlayLosses: pLosses, parlayPushes: pPushes,
    parlayWagered: pWagered,
    parlayProfit: pProfit,
    parlayROI: pWagered > 0 ? ((pProfit / pWagered) * 100).toFixed(1) + '%' : '0%',
    // Combined
    totalWagered,
    totalProfit: Math.round(totalProfit),
    roi: ((totalProfit / totalWagered) * 100).toFixed(1) + '%',
    avgDailyProfit: Math.round(totalProfit / picksDates.length),
    bestDayProfit: Math.max(...allDays.map(d => d.profit)),
    worstDayProfit: Math.min(...allDays.map(d => d.profit)),
  };

  // By sport
  const bySport = {};
  for (const p of allStraights) {
    if (!bySport[p.sport]) bySport[p.sport] = { wins: 0, losses: 0, pushes: 0, profit: 0, wagered: 0 };
    if (p.result === 'win') bySport[p.sport].wins++;
    if (p.result === 'loss') bySport[p.sport].losses++;
    if (p.result === 'push') bySport[p.sport].pushes++;
    bySport[p.sport].profit += p.profit;
    bySport[p.sport].wagered += p.risk;
  }
  for (const d of Object.values(bySport)) {
    d.accuracy = ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + '%';
    d.roi = ((d.profit / d.wagered) * 100).toFixed(1) + '%';
  }

  // By market
  const byMarket = {};
  for (const p of allStraights) {
    if (!byMarket[p.betType]) byMarket[p.betType] = { wins: 0, losses: 0, pushes: 0, profit: 0, wagered: 0 };
    if (p.result === 'win') byMarket[p.betType].wins++;
    if (p.result === 'loss') byMarket[p.betType].losses++;
    if (p.result === 'push') byMarket[p.betType].pushes++;
    byMarket[p.betType].profit += p.profit;
    byMarket[p.betType].wagered += p.risk;
  }
  for (const d of Object.values(byMarket)) {
    d.accuracy = ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + '%';
    d.roi = ((d.profit / d.wagered) * 100).toFixed(1) + '%';
  }

  // Unit distribution
  const unitDist = {};
  for (const p of allStraights) { const u = p.unitsNum; unitDist[u] = (unitDist[u]||0) + 1; }

  // Longest losing streak
  let maxStreak = 0, curStreak = 0;
  for (const p of allStraights) {
    if (p.result === 'loss') { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
    else curStreak = 0;
  }

  const output = {
    model: 'v10.0-deterministic-edge',
    backtestWindow: { start: warmupStart, picksStart, end: picksEnd, warmupDays: warmupDates.length, picksDays: picksDates.length },
    cumulative,
    bySport,
    byMarket,
    unitDistribution: unitDist,
    longestLosingStreak: maxStreak,
    dollarPerUnit: DOLLAR_PER_UNIT,
    days: allDays,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== BACKTEST COMPLETE ===');
  console.log(`Straights: ${sWins}W-${sLosses}L-${sPushes}P (${cumulative.accuracy}) | $${sProfit >= 0 ? '+' : ''}${sProfit.toLocaleString()} (${cumulative.straightROI} ROI)`);
  console.log(`Parlays:   ${pWins}W-${pLosses}L-${pPushes}P | $${pProfit >= 0 ? '+' : ''}${pProfit.toLocaleString()} (${cumulative.parlayROI} ROI)`);
  console.log(`Combined:  $${totalProfit >= 0 ? '+' : ''}${Math.round(totalProfit).toLocaleString()} on $${totalWagered.toLocaleString()} wagered (${cumulative.roi} ROI)`);
  console.log(`Unit distribution:`, unitDist);
  console.log(`Longest losing streak: ${maxStreak}`);
  console.log(`\nBy sport:`, JSON.stringify(bySport, null, 2));
  console.log(`By market:`, JSON.stringify(byMarket, null, 2));
  console.log(`\nResults saved to ${OUTPUT_FILE}`);
})();
