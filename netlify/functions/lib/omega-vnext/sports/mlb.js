'use strict';
/**
 * MLB v1 projection — Pythag/Elo-lite + HFA. NOT legacy FIP/ensemble spaghetti.
 * Limitations: no pitcher FIP/weather park factors in v1; market-anchored blend.
 */
const { HFA } = require('../config');
const {
  formatMatchup, fuzzyTeam, powerFromStandings,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { collectMarketOutcomes, enrichCandidateWithEdge } = require('../edge');
const { americanToImplied } = require('../odds_math');

const SPORT = 'MLB';

function projectGame(event, standings) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const hPow = powerFromStandings(fuzzyTeam(home, standings));
  const aPow = powerFromStandings(fuzzyTeam(away, standings));
  // runs-ish differential
  const modelMargin = (hPow - aPow) * 0.35 + HFA.MLB;
  const modelTotal = 8.6 + Math.abs(hPow + aPow) * 0.02; // league-ish

  const out = [];
  const uncertainty = (fuzzyTeam(home, standings) && fuzzyTeam(away, standings)) ? 0.18 : 0.28;

  // Moneyline
  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
      const mktImp = americanToImplied(
        (b.prices.find(p => p.book === 'pinnacle') || b.prices[0] || {}).american
      );
      p = blendWithMarket(p, mktImp, 0.5);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null,
        modelRawP: p, projMethod: 'mlb-pythag-lite+hfa', uncertainty,
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
      // Convert to home-line perspective for cover formula
      const marketLineHome = isHome ? line : -line;
      let pCover = spreadCoverProb(modelMargin, marketLineHome, SPORT);
      if (!isHome) pCover = 1 - spreadCoverProb(modelMargin, -marketLineHome, SPORT);
      // simpler: if picking this side's line
      pCover = spreadCoverProb(
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
        modelRawP: pCover, projMethod: 'mlb-normal-rl', uncertainty,
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
        modelRawP: p, projMethod: 'mlb-total-baseline', uncertainty: uncertainty + 0.05,
        consensusLine: line, modelProjection: +modelTotal.toFixed(2),
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  return out;
}

function project({ oddsEvents, standings }) {
  const all = [];
  for (const ev of oddsEvents || []) {
    all.push(...projectGame(ev, standings || {}));
  }
  return all;
}

module.exports = { project, SPORT };
