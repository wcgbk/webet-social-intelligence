'use strict';
/**
 * NCAAF/CFB — EPA-style off/def prior when both teams match (cfb-epa-v1*),
 * else standings power + HFA (cfb-normal-*). Game-day rest/QB soft adj
 * may tag cfb-epa-v1-gameday-* / cfb-normal-*-gameday. Blend weights
 * unchanged. ML, spread, and total anchors are no-vig Pinnacle/Circa.
 * Totals and margins shrink toward the sharp line in points before the
 * CDF. Calibrate shrink runs later on that probability.
 */
const {
  formatMatchup, mapGamesSoft,
  spreadCoverProb, totalCoverProb, mlFromSpread,
  sharpMarketLine, footballPointState, footballAudit, pricedFromPointShrink,
} = require('./_common');
const { footballProjection, applyEngineStack } = require('./epa');
const { applyGameDayAdjustments } = require('./game_day');
const { HFA } = require('../config');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');

const SPORT = 'NCAAF';

function withIdentity(raw, env) {
  if (env && env.unknownTeam) {
    raw.unknownTeam = true;
    raw.unknownNames = env.unknownNames || [];
  }
  return raw;
}

function tagMethods(methods, gameDayApplied, enginesOn) {
  let out = methods ? { ...methods } : methods;
  if (enginesOn && out) {
    for (const k of ['ml', 'spread', 'total']) {
      if (out[k] && !String(out[k]).includes('engines')) {
        out[k] = String(out[k]).replace(/-v1/, '-v1-engines');
        if (!String(out[k]).includes('engines')) out[k] = `${out[k]}-engines`;
      }
    }
    if (out.family && !String(out.family).includes('engines')) {
      out.family = String(out.family).includes('-v1')
        ? String(out.family).replace(/-v1/, '-v1-engines')
        : `${out.family}-engines`;
    }
  }
  if (gameDayApplied && out) {
    for (const k of ['ml', 'spread', 'total']) {
      if (out[k] && !String(out[k]).includes('gameday')) out[k] = `${out[k]}-gameday`;
    }
    if (out.family && !String(out.family).includes('gameday')) out.family = `${out.family}-gameday`;
  }
  return out;
}

function projectGame(event, standings, efficiency, gameDay) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const env = footballProjection({ sport: SPORT, home, away, standings, efficiency });
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin: env.modelMargin,
    modelTotal: env.modelTotal,
    uncertainty: env.uncertainty,
    home,
    away,
    restByTeam: (gameDay && gameDay.restByTeam && gameDay.restByTeam.NCAAF) || (gameDay && gameDay.restByTeam) || {},
    qbByTeam: (gameDay && gameDay.qbStatusBySport && gameDay.qbStatusBySport.NCAAF) || (gameDay && gameDay.qbByTeam) || {},
    hfaBase: HFA.NCAAF,
  });
  const stacked = applyEngineStack({
    sport: SPORT,
    modelMargin: gd.modelMargin,
    engineSoft: env.engineSoft,
    gameDay: gd.gameDay,
  });
  const modelMargin = stacked.modelMargin;
  const modelTotal = gd.modelTotal;
  const uncertainty = gd.uncertainty;
  const methods = tagMethods(env.methods, gd.gameDay && gd.gameDay.applied, stacked.enginesOn);
  const gameDayMeta = stacked.gameDay;
  const engineSoft = stacked.engineSoft;
  const pts = footballPointState(
    SPORT,
    modelTotal,
    modelMargin,
    sharpMarketLine(event, 'total'),
    sharpMarketLine(event, 'spreadHome'),
  );
  const out = [];

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      const p = pricedFromPointShrink(
        (proj) => (isHome ? mlFromSpread(proj, SPORT) : 1 - mlFromSpread(proj, SPORT)),
        pts.modelMarginRaw,
        pts.modelMarginShrunk,
        null,
        noVigPinnacleCircaImplied(bundles, b),
        0.45,
      );
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Moneyline'),
      };
      out.push(enrichCandidateWithEdge(withIdentity(raw, env), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      if (b.point == null) continue;
      const isHome = b.side === home;
      const p = pricedFromPointShrink(
        (proj, line) => spreadCoverProb(proj, line, SPORT),
        isHome ? pts.modelMarginRaw : -pts.modelMarginRaw,
        isHome ? pts.modelMarginShrunk : -pts.modelMarginShrunk,
        b.point,
        noVigPinnacleCircaImplied(bundles, b),
        0.45,
      );
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: p, projMethod: methods.spread, uncertainty,
        consensusLine: b.point, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Spread'),
      };
      out.push(enrichCandidateWithEdge(withIdentity(raw, env), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      if (b.point == null) continue;
      const p = pricedFromPointShrink(
        (proj, line) => totalCoverProb(proj, line, b.side, SPORT),
        pts.modelTotalRaw,
        pts.modelTotalShrunk,
        b.point,
        noVigPinnacleCircaImplied(bundles, b),
        0.4,
      );
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: p,
        projMethod: methods.total, uncertainty: uncertainty + env.totalUncBump,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Total'),
      };
      out.push(enrichCandidateWithEdge(withIdentity(raw, env), b, bundles));
    }
  }
  return out;
}

function project({ oddsEvents, standings, efficiency, gameDay } = {}) {
  return mapGamesSoft(oddsEvents, (ev) => projectGame(ev, standings || {}, efficiency || {}, gameDay || {}));
}

module.exports = { project, SPORT };
