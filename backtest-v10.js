#!/usr/bin/env node
// backtest-v10.js — 97-day historical backtest of v10 deterministic edge model
// Runs locally. No Claude, no LLM calls. Pure JS math against historical data.
//
// Usage: node backtest-v10.js
//
// Window: Dec 20, 2025 → Mar 27, 2026
//   Days 1-30: Elo warm-up (no picks)
//   Days 31-97: Generate 3 picks/day → ~200 graded picks
//
// Requires: ODDS_API_KEY env var (historical odds endpoint)

const fs = require('fs');

const ODDS_API_KEY = process.env.ODDS_API_KEY || 'e571f08f57dfedb82b3004e63d27aa15';
const OUTPUT_FILE = './finalboss/backtest-results.json';

// ── Sport config ──
const SPORTS = [
  { oddsKey: 'basketball_nba', espnSport: 'basketball', espnLeague: 'nba', label: 'NBA', std: 12, homeAdv: 100, kFactor: 20 },
  { oddsKey: 'icehockey_nhl', espnSport: 'hockey', espnLeague: 'nhl', label: 'NHL', std: 1.2, homeAdv: 60, kFactor: 20 },
  { oddsKey: 'basketball_ncaab', espnSport: 'basketball', espnLeague: 'mens-college-basketball', label: 'NCAAB', std: 11, homeAdv: 120, kFactor: 32 },
];

const COVER_CAPS = { 'NHL_Puck Line': 0.60, NHL_Total: 0.75, NBA_Spread: 0.72, NBA_Total: 0.75, NCAAB_Spread: 0.72, NCAAB_Total: 0.75 };

// ── Math ──
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

// ── Fetch ESPN scores for a date (completed games only) ──
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
        venue: comp.venue?.fullName || '',
      });
    }
    return games;
  } catch (e) { return []; }
}

// ── Fetch historical odds from Odds API ──
async function fetchHistoricalOdds(dateISO, sport) {
  try {
    const isoDate = dateISO + 'T15:00:00Z'; // 10am ET = 15:00 UTC
    const url = `https://api.the-odds-api.com/v4/historical/sports/${sport.oddsKey}/odds?date=${isoDate}&regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 422) return []; // no data for this date
      console.log(`  Odds API ${resp.status} for ${sport.label} on ${dateISO}`);
      return [];
    }
    const wrapper = await resp.json();
    const data = wrapper.data || wrapper;
    if (!Array.isArray(data)) return [];

    // Filter to games on this date (ET)
    return data.filter(g => {
      if (!g.commence_time) return false;
      const gt = new Date(g.commence_time);
      const estParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(gt).split('/');
      const gameDate = `${estParts[2]}-${estParts[0]}-${estParts[1]}`;
      return gameDate === dateISO;
    });
  } catch (e) {
    console.log(`  Odds fetch error for ${sport.label}: ${e.message}`);
    return [];
  }
}

// ── Build consensus from odds data ──
function getConsensus(game) {
  let spreads = [], totals = [], spreadOddsH = [], spreadOddsA = [];
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
          if (o.point !== undefined && o.name === 'Over') totals.push(o.point);
        }
      }
    }
  }
  if (spreads.length === 0) return null;
  spreads.sort((a,b) => a-b);
  spreadOddsH.sort((a,b) => a-b);
  spreadOddsA.sort((a,b) => a-b);
  totals.sort((a,b) => a-b);
  return {
    homeSpread: spreads[Math.floor(spreads.length/2)],
    awaySpread: -spreads[Math.floor(spreads.length/2)],
    total: totals.length > 0 ? totals[Math.floor(totals.length/2)] : null,
    homeSpreadOdds: spreadOddsH.length > 0 ? spreadOddsH[Math.floor(spreadOddsH.length/2)] : -110,
    awaySpreadOdds: spreadOddsA.length > 0 ? spreadOddsA[Math.floor(spreadOddsA.length/2)] : -110,
  };
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

(async () => {
  console.log('=== v10 BACKTEST — 97 days, Dec 20 2025 → Mar 27 2026 ===\n');

  const warmupStart = '2025-12-20';
  const warmupEnd = '2026-01-18';
  const picksStart = '2026-01-19';
  const picksEnd = '2026-03-27';

  const warmupDates = dateRange(warmupStart, warmupEnd);
  const picksDates = dateRange(picksStart, picksEnd);

  // ── ELO SYSTEM ──
  const elo = {}; // { teamName: { elo, homeAvgScored, homeAvgAllowed, awayAvgScored, awayAvgAllowed, games } }

  function getTeam(name) {
    if (!elo[name]) {
      elo[name] = { elo: 1500, games: 0, homeScored: [], homeAllowed: [], awayScored: [], awayAllowed: [] };
    }
    return elo[name];
  }

  function updateElo(homeName, awayName, homeScore, awayScore, kFactor, homeAdv) {
    const home = getTeam(homeName);
    const away = getTeam(awayName);

    const homeAdj = home.elo + homeAdv;
    const expHome = eloExpected(homeAdj, away.elo);
    const actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
    const margin = homeScore - awayScore;
    const mult = marginMultiplier(margin, home.elo - away.elo);

    home.elo += kFactor * mult * (actualHome - expHome);
    away.elo += kFactor * mult * ((1 - actualHome) - (1 - expHome));

    // Track scoring
    home.homeScored.push(homeScore);
    home.homeAllowed.push(awayScore);
    away.awayScored.push(awayScore);
    away.awayAllowed.push(homeScore);
    // Keep last 10
    if (home.homeScored.length > 10) { home.homeScored.shift(); home.homeAllowed.shift(); }
    if (away.awayScored.length > 10) { away.awayScored.shift(); away.awayAllowed.shift(); }
    home.games++;
    away.games++;
  }

  function getAvg(arr) { return arr.length > 0 ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

  // ── PHASE 1: ELO WARM-UP ──
  console.log(`Phase 1: Elo warm-up (${warmupDates.length} days)...`);
  for (const date of warmupDates) {
    for (const sport of SPORTS) {
      const games = await fetchESPNScores(date, sport);
      const completed = games.filter(g => g.state === 'post');
      for (const g of completed) {
        updateElo(g.home, g.away, g.homeScore, g.awayScore, sport.kFactor, sport.homeAdv);
      }
    }
    if (warmupDates.indexOf(date) % 10 === 0) {
      process.stdout.write(`  ${date} (${Object.keys(elo).length} teams)...\r`);
    }
    await sleep(100); // rate limit
  }
  console.log(`\n  Warm-up complete. ${Object.keys(elo).length} teams rated.\n`);

  // ── PHASE 2: GENERATE PICKS ──
  console.log(`Phase 2: Generating picks (${picksDates.length} days)...`);

  const allDays = [];
  let totalPicks = 0;

  for (const date of picksDates) {
    process.stdout.write(`  ${date}...`);

    // 2a: Fetch historical odds for this date
    const dayCandidates = [];
    for (const sport of SPORTS) {
      const oddsGames = await fetchHistoricalOdds(date, sport);
      await sleep(200); // rate limit

      // 2b: For each game with odds, compute projection from Elo
      for (const og of oddsGames) {
        const homeR = getTeam(og.home_team);
        const awayR = getTeam(og.away_team);
        if (homeR.games < 5 || awayR.games < 5) continue; // not enough data

        const cons = getConsensus(og);
        if (!cons) continue;

        const projH = ((getAvg(homeR.homeScored)||100) + (getAvg(awayR.awayAllowed)||100)) / 2;
        const projA = ((getAvg(awayR.awayScored)||100) + (getAvg(homeR.homeAllowed)||100)) / 2;
        const projSpread = -(projH - projA);
        const projTotal = projH + projA;

        const minEdge = sport.label === 'NHL' ? 0.3 : 2.0;

        // Spread candidate
        const sEdge = Math.abs(projSpread - cons.homeSpread);
        if (sEdge >= minEdge) {
          const mkt = sport.label === 'NHL' ? 'Puck Line' : 'Spread';
          const cover = cappedCover(normalCDF(sEdge / sport.std), sport.label, mkt);
          const isHome = projSpread < cons.homeSpread;
          const odds = isHome ? cons.homeSpreadOdds : cons.awaySpreadOdds;
          if (odds >= -250) {
            const dec = americanToDecimal(odds);
            const ev = (cover * dec) - 1;
            if (ev > 0.03) {
              const kelly = (ev / (dec-1)) * 0.25;
              let units = Math.round(kelly*10*2)/2;
              units = Math.max(0.5, Math.min(3.0, units));
              const side = isHome
                ? `${og.home_team} ${cons.homeSpread > 0 ? '+' : ''}${cons.homeSpread}`
                : `${og.away_team} ${cons.awaySpread > 0 ? '+' : ''}${cons.awaySpread}`;
              dayCandidates.push({
                sport: sport.label, home: og.home_team, away: og.away_team,
                market: mkt, side, odds, edge: sEdge, cover, ev, units,
                projSpread, consSpread: cons.homeSpread, projH, projA,
              });
            }
          }
        }

        // Total candidate
        if (cons.total) {
          const tEdge = Math.abs(projTotal - cons.total);
          const tMinEdge = sport.label === 'NHL' ? 0.3 : 3.0;
          if (tEdge >= tMinEdge) {
            const cover = cappedCover(normalCDF(tEdge / sport.std), sport.label, 'Total');
            const isOver = projTotal > cons.total;
            const odds = -110; // standard total odds
            const dec = americanToDecimal(odds);
            const ev = (cover * dec) - 1;
            if (ev > 0.03) {
              const kelly = (ev / (dec-1)) * 0.25;
              let units = Math.round(kelly*10*2)/2;
              units = Math.max(0.5, Math.min(3.0, units));
              dayCandidates.push({
                sport: sport.label, home: og.home_team, away: og.away_team,
                market: 'Total', side: `${isOver ? 'Over' : 'Under'} ${cons.total}`,
                odds, edge: tEdge, cover, ev, units,
                projTotal, consTotal: cons.total, projH, projA,
              });
            }
          }
        }
      }
    }

    // 2c: Select top 3 by EV (no duplicate games), 4u cap
    dayCandidates.sort((a,b) => b.ev - a.ev);
    const sel = [];
    for (const c of dayCandidates) {
      if (sel.length >= 3) break;
      if (sel.find(s => s.home === c.home && s.away === c.away)) continue;
      sel.push({...c});
    }
    let tot = sel.reduce((s,p) => s+p.units, 0);
    if (tot > 4.0) {
      const scale = 4.0/tot;
      for (const p of sel) p.units = Math.max(0.5, Math.round(p.units*scale*2)/2);
      tot = sel.reduce((s,p) => s+p.units, 0);
      while (tot > 4.0) { const sm = sel.reduce((a,b)=>a.units<=b.units?a:b); if(sm.units>0.5){sm.units-=0.5;tot-=0.5;}else break; }
    }

    // 2d: Grade picks against ESPN final scores
    const dayResults = [];
    for (const pick of sel) {
      // Find the actual game result
      let result = 'no_data';
      let actualHome = null, actualAway = null;

      for (const sport of SPORTS) {
        if (sport.label !== pick.sport) continue;
        const scores = await fetchESPNScores(date, sport);
        for (const g of scores) {
          if (g.state !== 'post') continue;
          const hLast = g.home.toLowerCase().split(' ').pop();
          const pHome = pick.home.toLowerCase().split(' ').pop();
          const pAway = pick.away.toLowerCase().split(' ').pop();
          if ((hLast === pHome || g.home.toLowerCase().includes(pHome)) ||
              (hLast === pAway)) {
            // Match found — determine home/away alignment
            if (hLast === pHome || g.home.toLowerCase().includes(pHome)) {
              actualHome = g.homeScore;
              actualAway = g.awayScore;
            } else {
              actualHome = g.awayScore;
              actualAway = g.homeScore;
            }
            break;
          }
        }
        break;
      }

      if (actualHome === null) {
        result = 'no_data';
      } else if (pick.market === 'Total') {
        const totalPoints = actualHome + actualAway;
        const line = parseFloat(pick.side.replace(/Over|Under/i, '').trim());
        const isOver = pick.side.toLowerCase().includes('over');
        if (totalPoints === line) result = 'push';
        else if (isOver && totalPoints > line) result = 'win';
        else if (!isOver && totalPoints < line) result = 'win';
        else result = 'loss';
      } else {
        // Spread/Puck Line
        const pickMatch = pick.side.match(/([+-]?\d+\.?\d*)$/);
        if (pickMatch) {
          const spread = parseFloat(pickMatch[1]);
          // Determine if pick is on home or away
          const pickTeamLast = pick.side.replace(/[+-]?\d+\.?\d*$/, '').trim().toLowerCase().split(' ').pop();
          const homeTeamLast = pick.home.toLowerCase().split(' ').pop();
          const isPickHome = pickTeamLast === homeTeamLast;
          const pickedScore = isPickHome ? actualHome : actualAway;
          const oppScore = isPickHome ? actualAway : actualHome;
          const adjustedScore = pickedScore + spread;
          if (adjustedScore === oppScore) result = 'push';
          else if (adjustedScore > oppScore) result = 'win';
          else result = 'loss';
        }
      }

      // Calculate profit
      let profit = 0;
      if (result === 'win') {
        const dec = americanToDecimal(pick.odds);
        profit = pick.units * 150 * (dec - 1);
      } else if (result === 'loss') {
        profit = -(pick.units * 150);
      }

      dayResults.push({
        sport: pick.sport,
        matchup: `${pick.away} vs. ${pick.home}`,
        pick: pick.side,
        market: pick.market,
        odds: `${pick.odds > 0 ? '+' : ''}${pick.odds}`,
        units: `${pick.units}u`,
        rating: pick.units >= 2.5 ? 'A+' : pick.units >= 1.5 ? 'A' : pick.units >= 1.0 ? 'A-' : 'B+',
        result,
        profit: Math.round(profit),
        score: actualHome !== null ? `${actualAway}-${actualHome}` : null,
        edge: pick.edge,
        cover: pick.cover,
        ev: pick.ev,
      });
    }

    // 2e: Update Elo with today's completed games (AFTER picks, no lookahead)
    for (const sport of SPORTS) {
      const games = await fetchESPNScores(date, sport);
      for (const g of games.filter(g => g.state === 'post')) {
        updateElo(g.home, g.away, g.homeScore, g.awayScore, sport.kFactor, sport.homeAdv);
      }
    }

    const dayWins = dayResults.filter(r => r.result === 'win').length;
    const dayLosses = dayResults.filter(r => r.result === 'loss').length;
    const dayProfit = dayResults.reduce((s,r) => s + r.profit, 0);
    const dayWagered = dayResults.filter(r => r.result !== 'no_data').reduce((s,r) => s + parseFloat(r.units) * 150, 0);

    allDays.push({
      date,
      picks: dayResults,
      wins: dayWins,
      losses: dayLosses,
      pushes: dayResults.filter(r => r.result === 'push').length,
      profit: dayProfit,
      wagered: dayWagered,
      roi: dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '0',
      accuracy: (dayWins + dayLosses) > 0 ? ((dayWins / (dayWins + dayLosses)) * 100).toFixed(0) : '-',
    });

    totalPicks += dayResults.filter(r => r.result !== 'no_data').length;
    process.stdout.write(` ${dayResults.length} picks (${dayWins}W-${dayLosses}L) $${dayProfit >= 0 ? '+' : ''}${dayProfit}\n`);

    await sleep(100); // rate limit
  }

  // ── PHASE 3: CUMULATIVE STATS ──
  const allPicks = allDays.flatMap(d => d.picks).filter(p => p.result !== 'no_data');
  const wins = allPicks.filter(p => p.result === 'win').length;
  const losses = allPicks.filter(p => p.result === 'loss').length;
  const pushes = allPicks.filter(p => p.result === 'push').length;
  const totalWagered = allPicks.reduce((s,p) => s + parseFloat(p.units) * 150, 0);
  const totalProfit = allPicks.reduce((s,p) => s + p.profit, 0);

  const cumulative = {
    totalPicks: allPicks.length,
    wins, losses, pushes,
    accuracy: ((wins / (wins + losses)) * 100).toFixed(1) + '%',
    totalWagered,
    totalProfit,
    roi: ((totalProfit / totalWagered) * 100).toFixed(1) + '%',
    avgDailyProfit: Math.round(totalProfit / picksDates.length),
    bestDay: allDays.reduce((a,b) => a.profit > b.profit ? a : b).date,
    worstDay: allDays.reduce((a,b) => a.profit < b.profit ? a : b).date,
    bestDayProfit: Math.max(...allDays.map(d => d.profit)),
    worstDayProfit: Math.min(...allDays.map(d => d.profit)),
  };

  // By sport
  const bySport = {};
  for (const p of allPicks) {
    if (!bySport[p.sport]) bySport[p.sport] = { wins: 0, losses: 0, profit: 0, wagered: 0 };
    if (p.result === 'win') bySport[p.sport].wins++;
    if (p.result === 'loss') bySport[p.sport].losses++;
    bySport[p.sport].profit += p.profit;
    bySport[p.sport].wagered += parseFloat(p.units) * 150;
  }
  for (const [sport, data] of Object.entries(bySport)) {
    data.accuracy = ((data.wins / (data.wins + data.losses)) * 100).toFixed(1) + '%';
    data.roi = ((data.profit / data.wagered) * 100).toFixed(1) + '%';
  }

  // By market
  const byMarket = {};
  for (const p of allPicks) {
    if (!byMarket[p.market]) byMarket[p.market] = { wins: 0, losses: 0, profit: 0, wagered: 0 };
    if (p.result === 'win') byMarket[p.market].wins++;
    if (p.result === 'loss') byMarket[p.market].losses++;
    byMarket[p.market].profit += p.profit;
    byMarket[p.market].wagered += parseFloat(p.units) * 150;
  }
  for (const [mkt, data] of Object.entries(byMarket)) {
    data.accuracy = ((data.wins / (data.wins + data.losses)) * 100).toFixed(1) + '%';
    data.roi = ((data.profit / data.wagered) * 100).toFixed(1) + '%';
  }

  // Longest losing streak
  let maxStreak = 0, curStreak = 0;
  for (const p of allPicks) {
    if (p.result === 'loss') { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
    else curStreak = 0;
  }

  const output = {
    model: 'v10.0-deterministic-edge',
    backtestWindow: { start: warmupStart, picksStart, end: picksEnd, warmupDays: warmupDates.length, picksDays: picksDates.length },
    cumulative,
    bySport,
    byMarket,
    longestLosingStreak: maxStreak,
    days: allDays,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== BACKTEST COMPLETE ===');
  console.log(`Record: ${wins}W-${losses}L-${pushes}P`);
  console.log(`Accuracy: ${cumulative.accuracy}`);
  console.log(`Total wagered: $${totalWagered.toLocaleString()}`);
  console.log(`Total profit: $${totalProfit >= 0 ? '+' : ''}${totalProfit.toLocaleString()}`);
  console.log(`ROI: ${cumulative.roi}`);
  console.log(`Longest losing streak: ${maxStreak}`);
  console.log(`\nBy sport:`, JSON.stringify(bySport, null, 2));
  console.log(`\nBy market:`, JSON.stringify(byMarket, null, 2));
  console.log(`\nResults saved to ${OUTPUT_FILE}`);
})();
