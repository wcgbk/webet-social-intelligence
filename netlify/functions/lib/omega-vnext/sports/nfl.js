'use strict';
/**
 * NFL — EPA-style off/def prior when both teams match (nfl-epa-v1*),
 * else standings power + HFA (nfl-normal-*). Game-day rest/QB soft adj
 * may tag nfl-epa-v1-gameday-* / nfl-normal-*-gameday. Blend weights
 * unchanged. ML, spread, and total anchors are no-vig Pinnacle/Circa.
 * Totals and margins shrink toward the sharp line in points before the
 * CDF. Calibrate shrink runs later on that probability.
 * Wind and cold from the free ESPN scoreboard adjust the total only
 * (WEATHER_NFL). A dome, or a game with no weather object, stays put.
 * The margin is not moved.
 */
const {
  formatMatchup, mapGamesSoft, matchEspnGameByIdentity,
  spreadCoverProb, totalCoverProb, mlFromSpread,
  sharpMarketLine, footballPointState, footballAudit, pricedFromPointShrink,
} = require('./_common');
const { footballProjection, applyEngineStack } = require('./epa');
const { applyGameDayAdjustments, applyNflWeatherTotalAdj, stampRestAudit } = require('./game_day');
const { HFA } = require('../config');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');
const { resolveTeamId } = require('./team_identity');

const SPORT = 'NFL';

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

// Weather still uses a resolved id pair when the board row has no ET date.
// Neutral HFA does not: that needs matchEspnGameByIdentity (same ET date).
function findEspnGameByTeam(ev, espnGames) {
  const games = (espnGames && espnGames.games) || espnGames || [];
  if (!ev || !games.length) return null;
  const hid = resolveTeamId(SPORT, ev.home_team);
  const aid = resolveTeamId(SPORT, ev.away_team);
  if (!hid || !aid) return null;
  return games.find((g) => {
    if (!g) return false;
    const gh = resolveTeamId(SPORT, g.homeTeam || g.home_team);
    const ga = resolveTeamId(SPORT, g.awayTeam || g.away_team);
    return gh === hid && ga === aid;
  }) || null;
}

function projectGame(event, standings, efficiency, gameDay, espnGame, neutralGame) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const neutral = !!(neutralGame && neutralGame.neutralSite === true);
  const hfaPts = neutral ? 0 : HFA.NFL;
  const env = footballProjection({ sport: SPORT, home, away, standings, efficiency, hfa: hfaPts });
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin: env.modelMargin,
    modelTotal: env.modelTotal,
    uncertainty: env.uncertainty,
    home,
    away,
    restByTeam: (gameDay && gameDay.restByTeam && gameDay.restByTeam.NFL) || (gameDay && gameDay.restByTeam) || {},
    qbByTeam: (gameDay && gameDay.qbStatusBySport && gameDay.qbStatusBySport.NFL) || (gameDay && gameDay.qbByTeam) || {},
    hfaBase: hfaPts,
    commenceTime,
    restSchedule: (gameDay && gameDay.restSchedule && gameDay.restSchedule.NFL) || null,
    neutralSite: neutral,
  });
  const stacked = applyEngineStack({
    sport: SPORT,
    modelMargin: gd.modelMargin,
    engineSoft: env.engineSoft,
    gameDay: gd.gameDay,
  });
  const wx = applyNflWeatherTotalAdj(gd.modelTotal, espnGame && espnGame.weather, {
    indoor: !!(espnGame && espnGame.indoor === true),
  });
  const modelMargin = stacked.modelMargin;
  const modelTotal = wx.modelTotal;
  const uncertainty = gd.uncertainty;
  let gameDayApplied = !!(stacked.gameDay && stacked.gameDay.applied);
  let gameDayMeta = stacked.gameDay;
  if (wx.applied) {
    gameDayApplied = true;
    gameDayMeta = {
      ...(stacked.gameDay || {}),
      weatherNote: wx.weatherNote,
      weatherTotalAdj: wx.totalAdj,
      applied: true,
    };
  }
  const methods = tagMethods(env.methods, gameDayApplied, stacked.enginesOn);
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
        0.5,
      );
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Moneyline'),
      };
      out.push(enrichCandidateWithEdge(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral), b, bundles));
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
        0.5,
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
      out.push(enrichCandidateWithEdge(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral), b, bundles));
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
        0.45,
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
      out.push(enrichCandidateWithEdge(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral), b, bundles));
    }
  }
  return out;
}

function stampNeutral(raw, neutral) {
  if (neutral) raw.diag = { neutralSite: true };
  return raw;
}

function project({ oddsEvents, standings, efficiency, gameDay, espnGames } = {}) {
  const games = (espnGames && espnGames.games) || espnGames || [];
  return mapGamesSoft(oddsEvents, (ev) => {
    const dated = matchEspnGameByIdentity(SPORT, ev, games);
    const eg = dated || findEspnGameByTeam(ev, games);
    return projectGame(ev, standings || {}, efficiency || {}, gameDay || {}, eg, dated);
  });
}

module.exports = { project, SPORT };
