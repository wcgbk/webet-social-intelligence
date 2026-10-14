'use strict';
/**
 * NCAAF/CFB — EPA-style off/def prior when both teams match (cfb-epa-v1*),
 * else standings power + HFA (cfb-normal-*). Game-day rest/QB soft adj
 * may tag cfb-epa-v1-gameday-* / cfb-normal-*-gameday. Blend weights
 * unchanged. ML, spread, and total anchors are no-vig Pinnacle.
 * Totals and margins shrink toward the sharp line in points before the
 * CDF. Calibrate shrink runs later on that probability.
 * A tempo total (plays x points per play) blends into the total when the
 * tempo weight is above 0 (default 0.25) and a pregame table is already in hand.
 * A frozen snap does not fetch that table.
 * Wind still adjusts that blended total on the existing football weather path.
 */
const {
  formatMatchup, mapGamesSoft, matchEspnGameByIdentity,
  spreadDetail, totalDetail, mlDetail,
  sharpMarketLine, footballPointState, footballAudit, pricedFootball, pureFootballCover,
} = require('./_common');
const { footballProjection, applyEngineStack, blendNcaafTempo } = require('./epa');
const { applyGameDayAdjustments, stampRestAudit } = require('./game_day');
const { stampPersonnel } = require('../personnel');
const { footballTotalFromGameDay } = require('./football_weather');
const { HFA, NCAAF_FCS, SPORT_SPREAD_STD, SPORT_TOTAL_STD, NCAAF_MODEL_WEIGHT } = require('../config');
const { homeFieldPoints } = require('./altitude');
const { resolveTeamId, isFbsTeamId } = require('./team_identity');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleImplied } = require('../edge');

const SPORT = 'NCAAF';

/** Unset is on. OMEGA_NCAAF_FCS=0 disables the FCS std and point pull. */
function ncaafFcsOn() {
  const raw = process.env.OMEGA_NCAAF_FCS;
  if (raw == null) return true;
  return String(raw).trim() !== '0';
}

/** Either side not FBS. A missing id is not FBS. Disabled env returns false. */
function isFcsGame(home, away) {
  if (!ncaafFcsOn()) return false;
  return !isFbsTeamId(resolveTeamId(SPORT, home)) || !isFbsTeamId(resolveTeamId(SPORT, away));
}

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
  const hfaPts = homeFieldPoints(HFA.NCAAF, { home, neutral, espnGame }).hfa;
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
    last5ByTeam: (gameDay && gameDay.last5ByTeam) || null,
    personnelByTeam: (gameDay && gameDay.personnelBySport) || null,
    depthByTeam: (gameDay && gameDay.depthCharts && gameDay.depthCharts.NCAAF) || null,
  });
  const stacked = applyEngineStack({
    sport: SPORT,
    modelMargin: gd.modelMargin,
    engineSoft: env.engineSoft,
    gameDay: gd.gameDay,
  });
  const tempo = blendNcaafTempo({
    modelTotal: gd.modelTotal,
    home,
    away,
    gameDay,
  });
  const fb = footballTotalFromGameDay({
    sport: SPORT,
    modelTotal: tempo.modelTotal,
    gameDay,
    event,
    espnGame,
  });
  const modelMargin = stacked.modelMargin;
  // Weather off keeps the tempo blend. Weight 0 leaves tempo.modelTotal equal to the pre-blend total.
  const modelTotal = fb.used ? fb.modelTotal : tempo.modelTotal;
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
  function stampCardInputs(raw) {
    stampPersonnel(raw, gd);
    if (gd.startingQbOut) raw.startingQbOut = true;
    if (gd.last5 && gd.last5.applied) raw.last5 = gd.gameDay && gd.gameDay.last5;
    return raw;
  }
  const engineSoft = stacked.engineSoft;
  const fcs = isFcsGame(home, away);
  const spreadStd = fcs ? SPORT_SPREAD_STD.NCAAF * NCAAF_FCS.stdMult : undefined;
  const totalStd = fcs ? SPORT_TOTAL_STD.NCAAF * NCAAF_FCS.stdMult : undefined;
  const pts = footballPointState(
    SPORT,
    modelTotal,
    modelMargin,
    sharpMarketLine(event, 'total'),
    sharpMarketLine(event, 'spreadHome'),
    fcs ? NCAAF_FCS.pointLambda : undefined,
  );
  const out = [];

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      const detailAt = (proj) => {
        const q = mlDetail(proj, SPORT, spreadStd);
        if (isHome) return q;
        return { ...q, coverProb: 1 - q.coverProb, pWin: q.pLoss, pLoss: q.pWin };
      };
      const priced = pricedFootball(
        detailAt,
        pts.modelMarginRaw,
        pts.modelMarginShrunk,
        null,
        noVigPinnacleImplied(bundles, b),
        NCAAF_MODEL_WEIGHT.ml,
      );
      const modelPureP = pureFootballCover(detailAt, pts.modelMarginRaw, null);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null, modelRawP: priced.p, modelPureP, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Moneyline'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      if (fcs) raw.fcsGame = true;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      if (b.point == null) continue;
      const isHome = b.side === home;
      const projRaw = isHome ? pts.modelMarginRaw : -pts.modelMarginRaw;
      const detailAt = (proj, line) => spreadDetail(proj, line, SPORT, spreadStd);
      const priced = pricedFootball(
        detailAt,
        projRaw,
        isHome ? pts.modelMarginShrunk : -pts.modelMarginShrunk,
        b.point,
        noVigPinnacleImplied(bundles, b),
        NCAAF_MODEL_WEIGHT.spread,
      );
      const modelPureP = pureFootballCover(detailAt, projRaw, b.point);
      const sideLabel = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line: b.point, modelRawP: priced.p, modelPureP, projMethod: methods.spread, uncertainty,
        consensusLine: b.point, modelProjection: +modelMargin.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Spread'),
      };
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      if (fcs) raw.fcsGame = true;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
    }
  }
  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      if (b.point == null) continue;
      const detailAt = (proj, line) => totalDetail(proj, line, b.side, SPORT, totalStd);
      const priced = pricedFootball(
        detailAt,
        pts.modelTotalRaw,
        pts.modelTotalShrunk,
        b.point,
        noVigPinnacleImplied(bundles, b),
        NCAAF_MODEL_WEIGHT.total,
      );
      const modelPureP = pureFootballCover(detailAt, pts.modelTotalRaw, b.point);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away, matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: `${b.side} ${b.point}`, line: b.point, modelRawP: priced.p, modelPureP,
        projMethod: tempo.applied ? `${methods.total}-tempo` : methods.total,
        uncertainty: uncertainty + env.totalUncBump,
        consensusLine: b.point, modelProjection: +modelTotal.toFixed(2),
        gameDay: gameDayMeta,
        engineSoft,
        ...footballAudit(pts, 'Total'),
      };
      if (tempo.applied) {
        raw.ncaafTempo = {
          weight: tempo.weight,
          tempoTotal: +Number(tempo.tempoTotal).toFixed(2),
          proxy: tempo.proxy,
          source: tempo.source,
          fcs: tempo.fcs === true,
        };
      }
      if (priced.pPush >= 0.001) raw.pPush = priced.pPush;
      if (fcs) raw.fcsGame = true;
      out.push(enrichCandidateWithEdge(stampCardInputs(stampNeutral(stampRestAudit(withIdentity(raw, env), gameDayMeta), neutral)), b, bundles));
    }
  }
  const conf = conferenceStamp(espnGame);
  if (conf) {
    for (const row of out) Object.assign(row, conf);
  }
  return out;
}

/** Copy scoreboard conference tokens onto the candidate. Missing stays missing. */
function conferenceStamp(espnGame) {
  if (!espnGame) return null;
  const home = espnGame.homeConference || null;
  const away = espnGame.awayConference || null;
  let conference = espnGame.conference || null;
  if (!conference && home && away && String(home).toLowerCase() === String(away).toLowerCase()) {
    conference = home;
  }
  if (!home && !away && !conference) return null;
  const out = {};
  if (home) out.homeConference = String(home);
  if (away) out.awayConference = String(away);
  if (conference) out.conference = String(conference);
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
