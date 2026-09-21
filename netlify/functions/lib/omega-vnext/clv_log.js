'use strict';

const { MODEL_VERSION } = require('./config');

/** Attach bet-time CLV schema fields to straights. */
function attachClvFields(picks, modelVersion = MODEL_VERSION) {
  return (picks || []).map(p => ({
    ...p,
    modelVersion: p.modelVersion || modelVersion,
    p_model: p.p_model != null ? p.p_model : null,
    fair_sharp_p: p.fair_sharp_p != null ? p.fair_sharp_p : null,
    predictedClv: p.predictedClv != null ? p.predictedClv : null,
  }));
}

function attachClvToParlay(parlayLegs, modelVersion = MODEL_VERSION) {
  return (parlayLegs || []).map(pl => ({
    ...pl,
    legs: (pl.legs || []).map(leg => ({
      ...leg,
      modelVersion: leg.modelVersion || modelVersion,
      p_model: leg.p_model != null ? leg.p_model : null,
      fair_sharp_p: leg.fair_sharp_p != null ? leg.fair_sharp_p : null,
      predictedClv: leg.predictedClv != null ? leg.predictedClv : null,
    })),
  }));
}

/** Seed record shape for track-clv-omega compatibility (pick+matchup keys). */
function betTimeClvSeed(pick) {
  return {
    pick: pick.pick,
    matchup: pick.matchup,
    sport: pick.sport,
    market: pick.betType || pick.market,
    odds: pick.odds,
    book: pick.book || null,
    commenceTime: pick.commenceTime || '',
    modelVersion: pick.modelVersion || MODEL_VERSION,
    p_model: pick.p_model,
    fair_sharp_p: pick.fair_sharp_p,
    predictedClv: pick.predictedClv,
    capturedAt: new Date().toISOString(),
  };
}

module.exports = { attachClvFields, attachClvToParlay, betTimeClvSeed };
