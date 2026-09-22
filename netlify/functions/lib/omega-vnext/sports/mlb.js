'use strict';
/**
 * MLB projection — Pythag/Elo-lite + HFA, then SP quality and park when present.
 * projMethod mlb-sp-park-v1-* when a starter rate or park factor is used;
 * otherwise mlb-pythag-lite+hfa / mlb-normal-rl / mlb-total-baseline.
 * Market blend unchanged. assumedStarter stays tagged for QA hard-fail.
 */
const { HFA } = require('../config');
const {
  formatMatchup, fuzzyTeam, powerFromStandings,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { resolvePark, resolveSpQuality, applySpPark } = require('./mlb_env');
const { collectMarketOutcomes, enrichCandidateWithEdge } = require('../edge');
const { americanToImplied } = require('../odds_math');

const SPORT = 'MLB';

function projectGame(event, standings, espnGame, ctx) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const hPow = powerFromStandings(fuzzyTeam(home, standings));
  const aPow = powerFromStandings(fuzzyTeam(away, standings));
  const baseMargin = (hPow - aPow) * 0.35 + HFA.MLB;
  const baseTotal = 8.6 + Math.abs(hPow + aPow) * 0.02;

  const out = [];
  let uncertainty = (fuzzyTeam(home, standings) && fuzzyTeam(away, standings)) ? 0.18 : 0.28;
  const homeSp = espnGame && espnGame.homeProbable;
  const awaySp = espnGame && espnGame.awayProbable;
  if (homeSp && awaySp) uncertainty = Math.max(0.12, uncertainty - 0.04);
  else if (homeSp || awaySp) uncertainty = Math.max(0.14, uncertainty - 0.02);

  const bag = ctx || {};
  const park = resolvePark(home, bag.parkFactors, espnGame);
  const homeQ = resolveSpQuality(homeSp, bag.mlbPitcherStats, home);
  const awayQ = resolveSpQuality(awaySp, bag.mlbPitcherStats, away);
  const adj = applySpPark({
    modelMargin: baseMargin,
    modelTotal: baseTotal,
    homeQ,
    awayQ,
    parkFactor: park ? park.factor : null,
  });
  const modelMargin = adj.modelMargin;
  const modelTotal = adj.modelTotal;
  const methods = (adj.usedSp || adj.usedPark)
    ? {
      ml: 'mlb-sp-park-v1-ml',
      spread: 'mlb-sp-park-v1-spread',
      total: 'mlb-sp-park-v1-total',
      family: 'mlb-sp-park-v1',
    }
    : {
      ml: 'mlb-pythag-lite+hfa',
      spread: 'mlb-normal-rl',
      total: 'mlb-total-baseline',
      family: null,
    };

  // Moneyline
  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
      const mktImp = americanToImplied(
        (b.prices.find(px => px.book === 'pinnacle') || b.prices[0] || {}).american
      );
      p = blendWithMarket(p, mktImp, 0.5);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null,
        modelRawP: p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +(modelMargin).toFixed(2),
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  // Run line (spreads)
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      const isHome = b.side === home;
      const line = b.point;
      if (line == null) continue;
      let pCover = spreadCoverProb(
        isHome ? modelMargin : -modelMargin,
        line,
        SPORT
      );
      const mktImp = americanToImplied((b.prices[0] || {}).american);
      pCover = blendWithMarket(pCover, mktImp, 0.5);
      const sideLabel = line > 0 ? `${b.side} +${line}` : `${b.side} ${line}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line,
        modelRawP: pCover, projMethod: methods.spread, uncertainty,
        consensusLine: line, modelProjection: +(modelMargin).toFixed(2),
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  // Totals
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      let p = totalCoverProb(modelTotal, line, b.side, SPORT);
      const mktImp = americanToImplied((b.prices[0] || {}).american);
      p = blendWithMarket(p, mktImp, 0.45);
      const sideLabel = `${b.side} ${line}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: sideLabel, line,
        modelRawP: p, projMethod: methods.total, uncertainty: uncertainty + 0.05,
        consensusLine: line, modelProjection: +modelTotal.toFixed(2),
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  return out;
}

function findEspnGame(ev, espnGames) {
  if (!espnGames || !espnGames.length) return null;
  const home = (ev.home_team || '').toLowerCase();
  const away = (ev.away_team || '').toLowerCase();
  return espnGames.find(g => {
    const gh = (g.homeTeam || '').toLowerCase();
    const ga = (g.awayTeam || '').toLowerCase();
    return (gh.includes(home.split(' ').pop()) || home.includes(gh.split(' ').pop()))
      && (ga.includes(away.split(' ').pop()) || away.includes(ga.split(' ').pop()));
  }) || null;
}

function project({ oddsEvents, standings, espnGames, mlbPitcherStats, parkFactors } = {}) {
  const all = [];
  const games = (espnGames && espnGames.games) || espnGames || [];
  const ctx = {
    mlbPitcherStats: mlbPitcherStats || {},
    parkFactors: parkFactors || {},
  };
  for (const ev of oddsEvents || []) {
    const eg = findEspnGame(ev, games);
    const cands = projectGame(ev, standings || {}, eg, ctx);
    if (eg && (eg.homeProbable || eg.awayProbable)) {
      for (const c of cands) {
        if (/moneyline|spread/i.test(c.market || '')) {
          c.assumedStarter = eg.homeProbable
            ? { name: eg.homeProbable.name, teamSide: 'home', id: eg.homeProbable.id }
            : (eg.awayProbable ? { name: eg.awayProbable.name, teamSide: 'away', id: eg.awayProbable.id } : null);
          c.probablePitcher = c.assumedStarter;
          c.startersKnown = !!(eg.homeProbable && eg.awayProbable);
        }
      }
    }
    all.push(...cands);
  }
  return all;
}

module.exports = { project, SPORT };
