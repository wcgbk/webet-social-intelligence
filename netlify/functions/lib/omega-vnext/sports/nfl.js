'use strict';
/**
 * NFL — EPA-style off/def prior when both teams match (nfl-epa-v1*),
 * else standings power + HFA (nfl-normal-*). Market blend unchanged;
 * calibrate shrink runs later in the pipeline.
 */
const {
  formatMatchup,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { footballProjection } = require('./epa');
const { collectMarketOutcomes, enrichCandidateWithEdge } = require('../edge');
const { americanToImplied } = require('../odds_math');

const SPORT = 'NFL';

function projectGame(event, standings, efficiency) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const env = footballProjection({ sport: SPORT, home, away, standings, efficiency });
  const modelMargin = env.modelMargin;
  const modelTotal = env.modelTotal;
  const uncertainty = env.uncertainty;
  const methods = env.methods;
  const out = [];

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
      p = blendWithMarket(p, americanToImplied((b.prices.find(x => x.book === 'pinnacle') || b.prices[0] || {}).american), 0.5);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: p, projMethod: methods.ml, uncertainty,
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
      p = blendWithMarket(p, americanToImplied((b.prices[0] || {}).american), 0.5);
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: p, projMethod: methods.spread, uncertainty,
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
      p = blendWithMarket(p, americanToImplied((b.prices[0] || {}).american), 0.45);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: p,
        projMethod: methods.total, uncertainty: uncertainty + env.totalUncBump,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2),
      };
      out.push(enrichCandidateWithEdge(raw, b, bundles));
    }
  }
  return out;
}

function project({ oddsEvents, standings, efficiency } = {}) {
  const all = [];
  for (const ev of oddsEvents || []) all.push(...projectGame(ev, standings || {}, efficiency || {}));
  return all;
}

module.exports = { project, SPORT };
