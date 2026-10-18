'use strict';
/**
 * NFL — EPA-style off/def prior when both teams match (nfl-epa-v1*),
 * else standings power + HFA (nfl-normal-*). Game-day rest/QB soft adj
 * may tag nfl-epa-v1-gameday-* / nfl-normal-*-gameday. Blend weights
 * unchanged. ML, spread, and total anchors are no-vig Pinnacle.
 * Totals and margins shrink toward the sharp line in points before the
 * CDF. Calibrate shrink runs later on that probability.
 * An NWS row on gameDay.weatherByGame adjusts the total only. When that
 * row is missing or a soft-fail, the free ESPN scoreboard path
 * (WEATHER_NFL) still runs. A dome, or a game with no weather, stays put.
 * The margin is not moved.
 * After rest, QB, and the engine stack, the home margin is blended with
 * Elo. Injury points sit on gameDay.injuryMarginAdj (positive toward
 * home). They are removed from the stat margin, the rest is blended, and
 * the same injury points are added back once at full weight:
 *   statCore = stacked - injuryMarginAdj
 *   margin = (1 - w) * statCore + w * eloMargin + injuryMarginAdj
 * w is NFL_ELO_WEIGHT (OMEGA_NFL_ELO_WEIGHT). w = 0, or a missing Elo
 * margin, leaves the stacked margin unchanged. A non-finite injury
 * adjustment is treated as 0. The total is not blended. Point shrink
 * toward the market is unchanged.
 */
const {
  formatMatchup, mapGamesSoft, matchEspnGameByIdentity, bindEspnGameByTeamAndTime,
  spreadDetail, totalDetail, mlDetail,
  sharpMarketLine, footballPointState, footballAudit, pricedFootball, pureFootballCover, pureForecastPoint,
  nflSpreadExcludesGame,
} = require('./_common');
const { footballProjection, applyEngineStack } = require('./epa');
const { blendNflRecency } = require('./nfl_recency');
const { eloMargin } = require('./nfl_elo');
const { applyGameDayAdjustments, applyNflWeatherTotalAdj, stampRestAudit } = require('./game_day');
const { stampPersonnel } = require('../personnel');
const { footballTotalFromGameDay } = require('./football_weather');
const { HFA, nflEloWeight, NFL_TOTAL_MODEL_WEIGHT, NFL_MODEL_WEIGHT, nflMarginBiasCorrectionPts } = require('../config');
const { homeFieldPoints } = require('./altitude');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleImplied } = require('../edge');
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

// Id pair and nearest commence. One row is kept even with no ET date
// (weather on a clock-skewed board). Two rows must clear 75 minutes.
// Neutral HFA uses the same-ET-date row, or this fallback when that
// row's neutralSite is boolean true.
function findEspnGameByTeam(ev, espnGames) {
  return bindEspnGameByTeamAndTime(SPORT, ev, espnGames);
}

function projectGame(event, standings, efficiency, gameDay, espnGame, neutralGame) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const neutral = !!(neutralGame && neutralGame.neutralSite === true);
  const hfaPts = homeFieldPoints(HFA.NFL, { home, neutral, espnGame: neutralGame }).hfa;
  const env = footballProjection({ sport: SPORT, home, away, standings, efficiency, hfa: hfaPts });
  // Last-5 residual is part of the team rating, before game-day and before
  // the market blend. The older raw-margin blend in game_day is not also applied.
  const recency = blendNflRecency({
    modelMargin: env.modelMargin,
    home,
    away,
    standings,
    efficiency,
    last5ByTeam: (gameDay && gameDay.last5ByTeam) || null,
    commenceTime,
  });
  // SIMPLIFIED (2026-10-18): last-5 recency blend stripped (log-only).
  if (false && recency.applied) env.modelMargin = recency.modelMargin;
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
    last5ByTeam: null,
    personnelByTeam: null, // SIMPLIFIED: personnel points stripped
    depthByTeam: (gameDay && gameDay.depthCharts && gameDay.depthCharts.NFL) || null,
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
  // SIMPLIFIED (2026-10-18): weather total tweaks stripped.
  const wx = { modelTotal: gd.modelTotal, applied: false };
  void fb; void applyNflWeatherTotalAdj;
  const eloPack = gameDay && gameDay.nflElo;
  const eloW = nflEloWeight();
  let eloPts = null;
  let modelMargin = stacked.modelMargin;
  const rawInj = stacked.gameDay ? stacked.gameDay.injuryMarginAdj : null;
  const injuryMarginAdj = Number.isFinite(Number(rawInj)) ? Number(rawInj) : 0;
  if (eloW > 0 && Number.isFinite(modelMargin)) {
    eloPts = eloMargin(home, away, neutral, eloPack && eloPack.ratings);
    if (Number.isFinite(eloPts)) {
      const statCore = modelMargin - injuryMarginAdj;
      const blended = (1 - eloW) * statCore + eloW * eloPts + injuryMarginAdj;
      if (Number.isFinite(blended)) modelMargin = blended;
    }
  }
  // Interim measured-bias correction (see config NFL_MARGIN_BIAS_CORRECTION_PTS):
  // health.js biasFor() measured the home model margin +1.484 pts vs market
  // on 2026-10-18 (n=11). Subtract it before any probability is priced.
  const biasCorrPts = nflMarginBiasCorrectionPts();
  // Interim correction is measured on the 2026-10-18 slate. It must not
  // rewrite historical replays of earlier slates.
  const _bw = require('../config').NFL_MARGIN_BIAS_WINDOW || { from: '2026-10-18', to: '2026-10-25' };
  const _day = String(commenceTime || '').slice(0, 10);
  const biasDateOk = !_day || (_day >= _bw.from && _day <= _bw.to);
  if (Number.isFinite(modelMargin) && biasCorrPts && biasDateOk) modelMargin -= biasCorrPts;
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
  if (fb.used && fb.fbWeather) {
    gameDayMeta = {
      ...(gameDayMeta || {}),
      fbWeather: fb.fbWeather,
      weatherSource: fb.fbWeather.source,
      weatherFetchedAt: fb.fbWeather.fetchedAt,
    };
  }
  const methods = tagMethods(env.methods, gameDayApplied, stacked.enginesOn);
  function stampCardInputs(raw) {
    stampPersonnel(raw, gd);
    if (gd.startingQbOut) raw.startingQbOut = true;
    if (gd.last5 && gd.last5.applied) raw.last5 = gd.gameDay && gd.gameDay.last5;
    if (recency.applied) raw.recencyLast5 = recency.stamp;
    if (eloW > 0 && Number.isFinite(eloPts)) {
      raw.nflElo = { w: eloW, margin: +eloPts.toFixed(3) };
    }
    if (nflSpreadExcludesGame(pts.modelMarginRaw, pts.marketMargin)) raw.nflGameProjectionGap = true;
    return raw;
  }
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
      const detailAt = (proj) => {
        const q = mlDetail(proj, SPORT);
        if (isHome) return q;
        return { ...q, coverProb: 1 - q.coverProb, pWin: q.pLoss, pLoss: q.pWin };
      };
      const priced = pricedFootball(
        detailAt,
        pts.modelMarginRaw,
        pts.modelMarginShrunk,
        null,
        noVigPinnacleImplied(bundles, b),
        0.5,
      );
      const pureAt = (proj) => {
        const q = mlDetail(proj, SPORT, undefined, { distribution: 'normal' });
        if (isHome) return q;
        return { ...q, coverProb: 1 - q.coverProb, pWin: q.pLoss, pLoss: q.pWin };
      };
      // NFL-CHANGE: weight 1. The probability anchor is the only market pull.
      const homeForecast = pureForecastPoint(pts.modelMarginRaw, pts.marketMargin, NFL_MODEL_WEIGHT.ml);
      // pureAt already flips the away side. Negating the margin here too
      // priced both moneylines at the home win probability.
      const modelPureP = pureFootballCover(pureAt, homeForecast, null);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: priced.p, modelPureP, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2), betProjection: homeForecast,
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Moneyline'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      if (b.point == null) continue;
      const isHome = b.side === home;
      const projRaw = isHome ? pts.modelMarginRaw : -pts.modelMarginRaw;
      const detailAt = (proj, line) => spreadDetail(proj, line, SPORT);
      const priced = pricedFootball(
        detailAt,
        projRaw,
        isHome ? pts.modelMarginShrunk : -pts.modelMarginShrunk,
        b.point,
        noVigPinnacleImplied(bundles, b),
        0.5,
      );
      const pureAt = (proj, line) => spreadDetail(proj, line, SPORT, undefined, { distribution: 'normal' });
      // NFL-CHANGE: weight 1. The probability anchor is the only market pull.
      const homeForecast = pureForecastPoint(pts.modelMarginRaw, pts.marketMargin, NFL_MODEL_WEIGHT.spread);
      const modelPureP = pureFootballCover(pureAt, isHome ? homeForecast : -homeForecast, b.point);
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: priced.p, modelPureP, projMethod: methods.spread, uncertainty,
        consensusLine: b.point, modelProjection: +modelMargin.toFixed(2), betProjection: homeForecast,
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Spread'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      if (b.point == null) continue;
      const detailAt = (proj, line) => totalDetail(proj, line, b.side, SPORT);
      const priced = pricedFootball(
        detailAt,
        pts.modelTotalRaw,
        pts.modelTotalShrunk,
        b.point,
        noVigPinnacleImplied(bundles, b),
        NFL_TOTAL_MODEL_WEIGHT,
      );
      const totalForecast = pureForecastPoint(pts.modelTotalRaw, pts.marketTotal, NFL_TOTAL_MODEL_WEIGHT);
      const modelPureP = pureFootballCover(detailAt, totalForecast, b.point);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: priced.p, modelPureP,
        projMethod: methods.total, uncertainty: uncertainty + env.totalUncBump,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2), betProjection: totalForecast,
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Total'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
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
    const fallback = dated ? null : findEspnGameByTeam(ev, games);
    const eg = dated || fallback;
    const neutralGame = dated || (fallback && fallback.neutralSite === true ? fallback : null);
    return projectGame(ev, standings || {}, efficiency || {}, gameDay || {}, eg, neutralGame);
  });
}

module.exports = { project, SPORT };
