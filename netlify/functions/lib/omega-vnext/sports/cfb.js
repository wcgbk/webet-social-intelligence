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
  formatMatchup, mapGamesSoft, matchEspnGameByIdentity,
  spreadDetail, totalDetail, mlDetail,
  sharpMarketLine, footballPointState, footballAudit, pricedFootball,
} = require('./_common');
const { footballProjection, applyEngineStack } = require('./epa');
const { applyGameDayAdjustments, stampRestAudit } = require('./game_day');
const { footballTotalFromGameDay } = require('./football_weather');
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

function projectGame(event, standings, efficiency, gameDay, espnGame) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const neutral = !!(espnGame && espnGame.neutralSite === true);
  const hfaPts = neutral ? 0 : HFA.NCAAF;
  const env = footballProjection({ sport: SPORT, home, away, standings, efficiency, hfa: hfaPts });
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin: env.modelMargin,
    modelTotal: env.modelTotal,
    uncertainty: env.uncertainty,
    home,
    away,
    restByTeam: (gameDay && gameDay.restByTeam && gameDay.restByTeam.NCAAF) || (gameDay && gameDay.restByTeam) || {},
    qbByTeam: (gameDay && gameDay.qbStatusBySport && gameDay.qbStatusBySport.NCAAF) || (gameDay && gameDay.qbByTeam) || {},
    hfaBase: hfaPts,
    commenceTime,
    restSchedule: (gameDay && gameDay.restSchedule && gameDay.restSchedule.NCAAF) || null,
    neutralSite: neutral,
  });
  const stacked = applyEngineStack({
    sport: SPORT,
    modelMargin: gd.modelMargin,
    engineSoft: env.engineSoft,
    gameDay: gd.gameDay,
  });
  const fb = footballTotalFromGameDay({
    sport: SPORT,
    modelTotal: gd.modelTotal,
    gameDay,
    event,
    espnGame,
  });
  const modelMargin = stacked.modelMargin;
  const modelTotal = fb.used ? fb.modelTotal : gd.modelTotal;
  const uncertainty = gd.uncertainty;
  let gameDayApplied = !!(stacked.gameDay && stacked.gameDay.applied);
  let gameDayMeta = stacked.gameDay;
  if (fb.used && fb.applied) {
    gameDayApplied = true;
    gameDayMeta = {
      ...(stacked.gameDay || {}),
      weatherNote: fb.weatherNote,
      weatherTotalAdj: fb.totalAdj,
      applied: true,
    };
  }
  if (fb.used && fb.fbWeather) {
    gameDayMeta = {
      ...(gameDayMeta || {}),
      fbWeather: fb.fbWeather,
      weatherSource: fb.fbWeather.source,
      weatherFetchedAt: fb.fbWeather.fetchedAt,
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
      const priced = pricedFootball(
        (proj) => {
          const q = mlDetail(proj, SPORT);
          if (isHome) return q;
          return { ...q, coverProb: 1 - q.coverProb, pWin: q.pLoss, pLoss: q.pWin };
        },
        pts.modelMarginRaw,
        pts.modelMarginShrunk,
        null,
        noVigPinnacleCircaImplied(bundles, b),
        0.45,
      );
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: priced.p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Moneyline'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      out.push(enrichCandidateWithEdge(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      if (b.point == null) continue;
      const isHome = b.side === home;
      const priced = pricedFootball(
        (proj, line) => spreadDetail(proj, line, SPORT),
        isHome ? pts.modelMarginRaw : -pts.modelMarginRaw,
        isHome ? pts.modelMarginShrunk : -pts.modelMarginShrunk,
        b.point,
        noVigPinnacleCircaImplied(bundles, b),
        0.45,
      );
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: priced.p, projMethod: methods.spread, uncertainty,
        consensusLine: b.point, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Spread'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      out.push(enrichCandidateWithEdge(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      if (b.point == null) continue;
      const priced = pricedFootball(
        (proj, line) => totalDetail(proj, line, b.side, SPORT),
        pts.modelTotalRaw,
        pts.modelTotalShrunk,
        b.point,
        noVigPinnacleCircaImplied(bundles, b),
        0.4,
      );
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: priced.p,
        projMethod: methods.total, uncertainty: uncertainty + env.totalUncBump,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Total'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
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
    const eg = matchEspnGameByIdentity(SPORT, ev, games);
    return projectGame(ev, standings || {}, efficiency || {}, gameDay || {}, eg);
  });
}

module.exports = { project, SPORT };
