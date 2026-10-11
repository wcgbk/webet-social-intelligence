'use strict';
/**
 * MLB projection — Pythag/Elo-lite + HFA, then SP quality and park when present.
 * v12.3.8: capped bullpen residual + SP-known std tighten (ENGINE_SOFT.MLB).
 * ML / spread / total blend weights unchanged. Every anchor is no-vig
 * Pinnacle/Circa (one book alone if the other is missing; else sharp no-vig).
 * Base margin and total come from per-game runs, not season run differential.
 * Season rates are neutralized by each club's home park, then the venue factor is applied once.
 * The finished total then loses the 2026 environment gap (OMEGA_MLB_ROOTFIX)
 * and, when the slate has a sharp total on at least 3 games, the slate mean
 * of (model − posted sharp total) instead (OMEGA_MLB_TOTAL_RECENTER).
 * Both off leaves this total on the pre-correction number. Margin is not shifted.
 * assumedStarter stays tagged for QA hard-fail.
 */
const { HFA, ENGINE_SOFT } = require('../config');
const {
  formatMatchup, bindEspnGameByTeamAndTime,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { rowByIdentityOrFuzzy } = require('./team_identity');
const {
  resolvePark, resolveSpQuality, applySpPark,
  resolveBullpenQuality, applyBullpenAdj, mlbSpKnownStd, mlbStandingsEnv,
  sharpPostedTotal, mlbTotalLevelShift, mlbTotalFlags, applyMlbTotalShift,
} = require('./mlb_env');
const { applyGameDayAdjustments, applyWeatherTotalAdj } = require('./game_day');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');

const SPORT = 'MLB';

function buildMethods({ usedSp, usedPark, enginesOn, usedGameday }) {
  let base;
  if (usedSp || usedPark || enginesOn) {
    base = {
      ml: enginesOn ? 'mlb-sp-park-v1-engines-ml' : 'mlb-sp-park-v1-ml',
      spread: enginesOn ? 'mlb-sp-park-v1-engines-spread' : 'mlb-sp-park-v1-spread',
      total: enginesOn ? 'mlb-sp-park-v1-engines-total' : 'mlb-sp-park-v1-total',
      family: enginesOn ? 'mlb-sp-park-v1-engines' : 'mlb-sp-park-v1',
    };
  } else {
    base = {
      ml: 'mlb-pythag-lite+hfa',
      spread: 'mlb-normal-rl',
      total: 'mlb-total-baseline',
      family: null,
    };
  }
  if (usedGameday) {
    for (const k of ['ml', 'spread', 'total']) {
      if (base[k] && !String(base[k]).includes('gameday')) base[k] = `${base[k]}-gameday`;
    }
    if (base.family && !String(base.family).includes('gameday')) {
      base.family = `${base.family}-gameday`;
    } else if (!base.family) {
      base.family = 'mlb-gameday';
    }
  }
  return base;
}

function deriveGame(event, standings, espnGame, ctx) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const seen = ctx && ctx.fallbackSeen;
  const bag = ctx || {};
  const homeSt = rowByIdentityOrFuzzy('MLB', standings, home, { fallbackSeen: seen });
  const awaySt = rowByIdentityOrFuzzy('MLB', standings, away, { fallbackSeen: seen });
  const env0 = mlbStandingsEnv(homeSt, awaySt, {
    parkFactors: bag.parkFactors,
    homeTeam: home,
    awayTeam: away,
    fallbackSeen: seen,
  });
  const baseMargin = env0.modelMargin;
  const baseTotal = env0.modelTotal;

  let uncertainty = (homeSt && awaySt) ? 0.18 : 0.28;
  const homeSp = espnGame && espnGame.homeProbable;
  const awaySp = espnGame && espnGame.awayProbable;
  if (homeSp && awaySp) uncertainty = Math.max(0.12, uncertainty - 0.04);
  else if (homeSp || awaySp) uncertainty = Math.max(0.14, uncertainty - 0.02);

  const park = resolvePark(home, bag.parkFactors, espnGame, seen);
  const homeQ = resolveSpQuality(homeSp, bag.mlbPitcherStats, home, seen);
  const awayQ = resolveSpQuality(awaySp, bag.mlbPitcherStats, away, seen);
  const adj = applySpPark({
    modelMargin: baseMargin,
    modelTotal: baseTotal,
    homeQ,
    awayQ,
    parkFactor: park ? park.factor : null,
  });
  let modelMargin = adj.modelMargin;
  let modelTotal = adj.modelTotal;

  const homeBp = resolveBullpenQuality(homeQ, home, bag.mlbPitcherStats, seen);
  const awayBp = resolveBullpenQuality(awayQ, away, bag.mlbPitcherStats, seen);
  const bp = applyBullpenAdj({
    modelMargin,
    modelTotal,
    homeBullpen: homeBp,
    awayBullpen: awayBp,
    caps: ENGINE_SOFT && ENGINE_SOFT.MLB,
  });
  modelMargin = bp.modelMargin;
  modelTotal = bp.modelTotal;

  const gdBag = (ctx && ctx.gameDay) || {};
  const restTable = (gdBag.restByTeam && (gdBag.restByTeam.MLB || gdBag.restByTeam)) || {};
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin,
    modelTotal,
    uncertainty,
    home,
    away,
    restByTeam: restTable,
    qbByTeam: {},
    hfaBase: HFA.MLB,
    fallbackSeen: seen,
  });
  modelMargin = gd.modelMargin;
  modelTotal = gd.modelTotal;
  uncertainty = gd.uncertainty;
  const nameKey = `${away}|${home}`;
  const timedKey = commenceTime ? `${nameKey}|${commenceTime}` : null;
  const wxMap = (ctx && ctx.weatherByGame) || {};
  // Timed key, then the row this game bound, then a legacy name key.
  // A doubleheader name key is dropped on collision so the second game
  // cannot paint the first.
  const weather = (timedKey && wxMap[timedKey])
    || (espnGame && espnGame.weather)
    || wxMap[nameKey]
    || wxMap[home]
    || null;
  const wx = applyWeatherTotalAdj(modelTotal, weather);
  modelTotal = wx.modelTotal;

  const effStd = mlbSpKnownStd(homeQ, awayQ, ENGINE_SOFT && ENGINE_SOFT.MLB);
  const enginesOn = !!(bp.usedBullpen || effStd != null);
  const usedGameday = !!(gd.gameDay && gd.gameDay.applied) || wx.applied;
  const gameDayMeta = {
    ...(gd.gameDay || {}),
    weatherNote: wx.weatherNote,
    applied: usedGameday,
    bullpenAdj: bp.usedBullpen ? { marginAdj: bp.marginAdj, totalAdj: bp.totalAdj, capped: bp.capped } : null,
    spKnownStd: effStd,
    enginesApplied: enginesOn,
  };
  if (Number.isFinite(env0.homeParkAdj)) gameDayMeta.homeParkAdj = env0.homeParkAdj;
  if (Number.isFinite(env0.awayParkAdj)) gameDayMeta.awayParkAdj = env0.awayParkAdj;
  const methods = buildMethods({
    usedSp: adj.usedSp,
    usedPark: adj.usedPark,
    enginesOn,
    usedGameday,
  });
  const stdOpt = effStd != null ? effStd : undefined;
  return {
    event, home, away, commenceTime, modelMargin, modelTotal, uncertainty,
    methods, gameDayMeta, stdOpt,
  };
}

function priceGame(derived, totalShift) {
  const {
    home, away, commenceTime, modelMargin, uncertainty,
    methods, gameDayMeta, stdOpt,
  } = derived;
  const modelTotal = applyMlbTotalShift(derived.modelTotal, totalShift);
  const out = [];
  const event = derived.event;

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT, stdOpt) : 1 - mlFromSpread(modelMargin, SPORT, stdOpt);
      p = blendWithMarket(p, noVigPinnacleCircaImplied(bundles, b), 0.5);
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Moneyline', side: b.side, line: null,
        modelRawP: p, projMethod: methods.ml, uncertainty,
        consensusLine: null, modelProjection: +(modelMargin).toFixed(2),
        gameDay: gameDayMeta,
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      const isHome = b.side === home;
      const line = b.point;
      if (line == null) continue;
      let pCover = spreadCoverProb(
        isHome ? modelMargin : -modelMargin,
        line,
        SPORT,
        stdOpt
      );
      const mktImp = noVigPinnacleCircaImplied(bundles, b);
      pCover = blendWithMarket(pCover, mktImp, 0.5);
      const sideLabel = line > 0 ? `${b.side} +${line}` : `${b.side} ${line}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Spread', side: sideLabel, line,
        modelRawP: pCover, projMethod: methods.spread, uncertainty,
        consensusLine: line, modelProjection: +(modelMargin).toFixed(2),
        gameDay: gameDayMeta,
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      let p = totalCoverProb(modelTotal, line, b.side, SPORT);
      const mktImp = noVigPinnacleCircaImplied(bundles, b);
      p = blendWithMarket(p, mktImp, 0.45);
      const sideLabel = `${b.side} ${line}`;
      let raw = {
        sport: SPORT, homeTeam: home, awayTeam: away,
        matchup: formatMatchup(away, home), commenceTime,
        market: 'Total', side: sideLabel, line,
        modelRawP: p, projMethod: methods.total, uncertainty: uncertainty + 0.05,
        consensusLine: line, modelProjection: +modelTotal.toFixed(2),
        gameDay: gameDayMeta,
      };
      raw = enrichCandidateWithEdge(raw, b, bundles);
      out.push(raw);
    }
  }

  return out;
}

function findEspnGame(ev, espnGames) {
  return bindEspnGameByTeamAndTime(SPORT, ev, espnGames);
}

function softFail(ev, err) {
  const home = ev && ev.home_team;
  const away = ev && ev.away_team;
  console.error(`[omega-vnext] project soft-fail ${away || '?'} @ ${home || '?'}: ${err && err.message}`);
}

function tagStarters(cands, eg) {
  if (!eg || !(eg.homeProbable || eg.awayProbable)) return;
  for (const c of cands) {
    if (/moneyline|spread/i.test(c.market || '')) {
      c.assumedStarter = eg.homeProbable
        ? { name: eg.homeProbable.name, teamSide: 'home', id: eg.homeProbable.id }
        : (eg.awayProbable ? { name: eg.awayProbable.name, teamSide: 'away', id: eg.awayProbable.id } : null);
      c.probablePitcher = c.assumedStarter;
      c.startersKnown = !!(eg.homeProbable && eg.awayProbable);
    }
  }
}

function project({ oddsEvents, standings, espnGames, mlbPitcherStats, parkFactors, gameDay, weatherByGame } = {}) {
  const games = (espnGames && espnGames.games) || espnGames || [];
  const ctx = {
    mlbPitcherStats: mlbPitcherStats || {},
    parkFactors: parkFactors || {},
    gameDay: gameDay || {},
    weatherByGame: weatherByGame || (gameDay && gameDay.weatherByGame) || {},
    fallbackSeen: new Set(),
  };
  const prepared = [];
  for (const ev of oddsEvents || []) {
    try {
      const eg = findEspnGame(ev, games);
      prepared.push({ ev, eg, derived: deriveGame(ev, standings || {}, eg, ctx) });
    } catch (err) {
      softFail(ev, err);
    }
  }
  const flags = mlbTotalFlags();
  let shift = 0;
  if (flags.rootfix || flags.recenter) {
    shift = mlbTotalLevelShift(prepared.map(p => ({
      total: p.derived.modelTotal,
      sharp: sharpPostedTotal(p.ev),
    })), flags);
  }
  const all = [];
  for (const p of prepared) {
    try {
      const cands = priceGame(p.derived, shift);
      tagStarters(cands, p.eg);
      if (cands.length) all.push(...cands);
    } catch (err) {
      softFail(p.ev, err);
    }
  }
  return all;
}

module.exports = { project, SPORT };
