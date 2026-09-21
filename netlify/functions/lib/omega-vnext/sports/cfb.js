'use strict';
/**
 * NCAAF/CFB v1 — normal-spread σ≈16 + HFA. Higher uncertainty than NFL.
 */
const { HFA } = require('../config');
const {
  formatMatchup, fuzzyTeam, powerFromStandings,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { collectMarketOutcomes, enrichCandidateWithEdge } = require('../edge');
const { americanToImplied } = require('../odds_math');

const SPORT = 'NCAAF';

function projectGame(event, standings) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const hPow = powerFromStandings(fuzzyTeam(home, standings));
  const aPow = powerFromStandings(fuzzyTeam(away, standings));
  const modelMargin = (hPow - aPow) + HFA.NCAAF;
  const modelTotal = 52 + Math.abs(hPow + aPow) * 0.04;
  const uncertainty = 0.22;
  const out = [];

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
      p = blendWithMarket(p, americanToImplied((b.prices.find(x => x.book === 'pinnacle') || b.prices[0] || {}).american), 0.45);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: p, projMethod: 'cfb-normal-ml', uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
      };
      out.push(enrichCandidateWithEdge(raw, b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      if (b.point == null) continue;
      const isHome = b.side === home;
      let p = spreadCoverProb(isHome ? modelMargin : -modelMargin, b.point, SPORT);
      p = blendWithMarket(p, americanToImplied((b.prices[0] || {}).american), 0.45);
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: p, projMethod: 'cfb-normal-spread', uncertainty,
        consensusLine: b.point, modelProjection: +modelMargin.toFixed(2),
      };
      out.push(enrichCandidateWithEdge(raw, b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      if (b.point == null) continue;
      let p = totalCoverProb(modelTotal, b.point, b.side, SPORT);
      p = blendWithMarket(p, americanToImplied((b.prices[0] || {}).american), 0.4);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: p,
        projMethod: 'cfb-total-baseline', uncertainty: uncertainty + 0.05,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2),
      };
      out.push(enrichCandidateWithEdge(raw, b, bundles));
    }
  }
  return out;
}

function project({ oddsEvents, standings }) {
  const all = [];
  for (const ev of oddsEvents || []) all.push(...projectGame(ev, standings || {}));
  return all;
}

module.exports = { project, SPORT };
