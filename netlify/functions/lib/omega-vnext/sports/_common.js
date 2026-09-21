'use strict';

const { normCdf, clamp, americanToImplied } = require('../odds_math');
const { SPORT_SPREAD_STD, SPORT_TOTAL_STD, HFA } = require('../config');

function formatMatchup(away, home) {
  return `${away} @ ${home}`;
}

function fuzzyTeam(name, ratings) {
  if (!name || !ratings) return null;
  if (ratings[name]) return ratings[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase() === lower) return ratings[k];
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return ratings[k];
  }
  // last word (mascot) match
  const last = lower.split(' ').pop();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase().split(' ').pop() === last) return ratings[k];
  }
  return null;
}

function powerFromStandings(st) {
  if (!st) return 0;
  if (st.pf != null && st.pa != null && st.pa !== 0) {
    // Pythagorean-ish differential proxy
    return (Number(st.pf) - Number(st.pa));
  }
  if (st.winPct != null) return (Number(st.winPct) - 0.5) * 20;
  return 0;
}

/**
 * Spread cover approx via normal: favorite covers if margin > -line for home favorite etc.
 * model spread = homePower - awayPower + HFA (home perspective; negative => home favored)
 */
function spreadCoverProb(modelSpreadHome, marketLineHome, sport) {
  // marketLineHome: home team spread number (e.g. -3.5)
  const std = SPORT_SPREAD_STD[sport] || 13.5;
  // P(home margin > -marketLine) roughly; use residual vs market
  const edgePts = modelSpreadHome - (-marketLineHome); // if model says home -6 and market -3, edge = -6 - 3? 
  // Define modelSpreadHome as expected home margin (positive = home wins by that).
  // Home covers if homeMargin + marketLineHome > 0 ⇒ homeMargin > -marketLineHome
  const z = (modelSpreadHome + marketLineHome) / std;
  return normCdf(z);
}

function totalCoverProb(modelTotal, marketTotal, side, sport) {
  const std = SPORT_TOTAL_STD[sport] || 10;
  const z = (modelTotal - marketTotal) / std;
  if (/over/i.test(side)) return normCdf(z);
  return normCdf(-z);
}

function mlFromSpread(modelSpreadHome, sport) {
  const std = SPORT_SPREAD_STD[sport] || 13.5;
  return clamp(normCdf(modelSpreadHome / std), 0.05, 0.95);
}

/** Mild market-anchored lean: blend model with market implied. */
function blendWithMarket(pModel, marketImplied, wModel = 0.55) {
  if (!Number.isFinite(marketImplied)) return pModel;
  return clamp(wModel * pModel + (1 - wModel) * marketImplied, 0.05, 0.95);
}

module.exports = {
  formatMatchup,
  fuzzyTeam,
  powerFromStandings,
  spreadCoverProb,
  totalCoverProb,
  mlFromSpread,
  blendWithMarket,
  HFA,
};
