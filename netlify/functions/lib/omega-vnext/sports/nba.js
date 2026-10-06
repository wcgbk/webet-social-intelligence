'use strict';
/**
 * NBA projection — shadow only while SPORTS_ENABLED.NBA is false.
 * Moneyline, spread, and total. Blend matches MLB/NHL (0.50 / 0.50 / 0.45)
 * on no-vig Pinnacle/Circa. Calibrate and the shared gates run later.
 * This module does not read SPORTS_ENABLED. projectAll is the daily gate
 * and does not pass allowPreseason, so a preseason board cannot join the card.
 *
 * Team identity is the ESPN id table (exact normalized name). No substring,
 * last-word, or mascot match. "Lakers" is not the Lakers. "Los Angeles" is
 * not a team.
 *
 * Ratings: explicit offRtg/defRtg (per 100) when both are in band, else
 * explicit avg points (never divided), else a season sum divided by games
 * once games >= 2 and the raw total is above 1.8× league ppg. Anything else
 * is not a rate.
 *
 * Preseason and the first game stay on the prior-season net-rating seed
 * (_meta.season, zero-sum netRtg). From 2 regular-season games the current
 * rate ramps in as gp / 20, full weight at 20. That is the football rule
 * (gp < 2 keeps the seed) with a longer ramp, because an NBA year is 82 games.
 * A preseason flag forces weight 0 even when the exhibition table has 2+ games.
 *
 * Pace scales the points environment. Missing pace keeps the prior pace,
 * else _meta.leaguePace. Equal clubs at the league profile land on HFA.NBA
 * (2.5, top of the recent ~2.0–2.5 home-court band) and total 2× league ppg.
 *
 * Spread residual SD is SPORT_SPREAD_STD.NBA (12): the usual home-margin
 * residual. Total residual SD is SPORT_TOTAL_STD.NBA (18). Total = H+A and
 * margin = H−A, and pace shocks move both scores the same way, so the total
 * is wider than the margin. A pace-aware model still leaves a residual near
 * 18 (legacy omega used 18.5). The old 14 treated the total as barely noisier
 * than the spread. 18 pulls total probabilities toward 0.5. It is not a gate.
 *
 * Soft-clamp |margin| 25 and total 190–275, then still emit. One bad event
 * does not blank the slate.
 */
const { clamp } = require('../odds_math');
const { HFA, SPORT_SPREAD_STD, SPORT_TOTAL_STD } = require('../config');
const {
  formatMatchup, gamesPlayed, explicitPointsPerGame, LEAGUE_PPG, mapGamesSoft,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket,
} = require('./_common');
const { applyGameDayAdjustments } = require('./game_day');
const { resolveTeamId, rowByIdentity, logUnknownTeam } = require('./team_identity');
const { collectMarketOutcomes, enrichCandidateWithEdge, noVigPinnacleCircaImplied } = require('../edge');

const SPORT = 'NBA';
const BLEND = { ml: 0.50, spread: 0.50, total: 0.45 };
const NBA_RAMP_GAMES = 20;
const NBA_PPG_MIN = 90;
const NBA_PPG_MAX = 140;
const NBA_PACE_MIN = 90;
const NBA_PACE_MAX = 110;
const NBA_RTG_MIN = 95;
const NBA_RTG_MAX = 130;
const NBA_MARGIN_CAP = 25;
const NBA_TOTAL_MIN = 190;
const NBA_TOTAL_MAX = 275;
const SEASON_SUM_MULT = 1.8;

let priorCache = null;

function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function inPpgBand(n) {
  return n >= NBA_PPG_MIN && n <= NBA_PPG_MAX;
}

function inPaceBand(n) {
  return n >= NBA_PACE_MIN && n <= NBA_PACE_MAX;
}

function leagueOf(prior) {
  const meta = (prior && prior._meta) || {};
  const ppg = finite(meta.leaguePpg);
  const pace = finite(meta.leaguePace);
  return {
    ppg: ppg != null && ppg > 80 ? ppg : LEAGUE_PPG.NBA,
    pace: pace != null && inPaceBand(pace) ? pace : 99.5,
    season: meta.season || null,
  };
}

/**
 * Zero-sum the netRtg column (mean 0) and rebuild points around each row's
 * own scoring level, or _meta.leaguePpg when the row has no level.
 * Idempotent when the column is already centered. Does not mutate the input.
 */
function centerNbaSeed(table) {
  const src = table && typeof table === 'object' && !Array.isArray(table) ? table : {};
  const league = leagueOf(src);
  const names = Object.keys(src).filter((k) => k && !k.startsWith('_') && src[k] && typeof src[k] === 'object');
  const nets = names.map((name) => ({ name, net: rowNetRtg(src[name]) }));
  const finiteNets = nets.filter((x) => x.net != null);
  const mean = finiteNets.length
    ? finiteNets.reduce((sum, x) => sum + x.net, 0) / finiteNets.length
    : 0;
  const out = {};
  if (src._meta && typeof src._meta === 'object') out._meta = src._meta;
  for (const { name, net } of nets) {
    const row = src[name];
    if (net == null) {
      out[name] = { ...row };
      continue;
    }
    const pace = inPaceBand(finite(row.pace)) ? finite(row.pace) : league.pace;
    const centered = net - mean;
    const off0 = finite(row.offPpg);
    const def0 = finite(row.defPpg);
    const level = off0 != null && def0 != null ? (off0 + def0) / 2 : league.ppg;
    const netPpg = centered * pace / 100;
    const offPpg = level + netPpg / 2;
    const defPpg = level - netPpg / 2;
    out[name] = {
      ...row,
      pace,
      netRtg: centered,
      netPpg,
      offPpg,
      defPpg,
      offRtg: offPpg / pace * 100,
      defRtg: defPpg / pace * 100,
    };
  }
  return out;
}

function rowNetRtg(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = finite(row.netRtg);
  if (direct != null) return direct;
  const off = finite(row.offPpg);
  const def = finite(row.defPpg);
  const pace = finite(row.pace);
  if (off == null || def == null || pace == null || pace <= 0) return null;
  return (off - def) / pace * 100;
}

function loadPrior() {
  if (priorCache) return priorCache;
  const raw = require('./data/nba-net-rating-seed.json');
  priorCache = centerNbaSeed(raw);
  return priorCache;
}

/**
 * Current offensive / defensive points per game.
 * Ratings (per 100) win when both are in band. An explicit avg pair is a
 * rate and is not divided. A season sum (above 1.8× league ppg) is divided
 * only when games >= 2 and the quotient lands in band. gp < 2 keeps null
 * so the prior owns the row. Unclean rates return null.
 */
function resolveTeamRates(st, leaguePpg) {
  if (!st || typeof st !== 'object') return null;
  const league = Number.isFinite(Number(leaguePpg)) ? Number(leaguePpg) : LEAGUE_PPG.NBA;
  const gp = gamesPlayed(st);
  const pace = inPaceBand(finite(st.pace)) ? finite(st.pace) : null;
  const offRtg = finite(st.offRtg != null ? st.offRtg : st.offensiveRating);
  const defRtg = finite(st.defRtg != null ? st.defRtg : st.defensiveRating);
  if (offRtg != null && defRtg != null
    && offRtg >= NBA_RTG_MIN && offRtg <= NBA_RTG_MAX
    && defRtg >= NBA_RTG_MIN && defRtg <= NBA_RTG_MAX) {
    const p = pace || 100;
    const offPpg = offRtg * p / 100;
    const defPpg = defRtg * p / 100;
    if (inPpgBand(offPpg) && inPpgBand(defPpg)) {
      return { offPpg, defPpg, pace, games: gp, source: 'ratings' };
    }
  }
  const explicit = explicitPointsPerGame(st);
  if (explicit && inPpgBand(explicit.pfPg) && inPpgBand(explicit.paPg)) {
    return { offPpg: explicit.pfPg, defPpg: explicit.paPg, pace, games: gp, source: 'per-game' };
  }
  const pf = finite(st.pf != null ? st.pf : st.pointsFor);
  const pa = finite(st.pa != null ? st.pa : st.pointsAgainst);
  if (pf == null || pa == null || pf <= 0 || pa <= 0) return null;
  const seasonSum = pf > league * SEASON_SUM_MULT || pa > league * SEASON_SUM_MULT;
  if (seasonSum) {
    if (!(gp >= 2)) return null;
    const offPpg = pf / gp;
    const defPpg = pa / gp;
    if (!inPpgBand(offPpg) || !inPpgBand(defPpg)) return null;
    return { offPpg, defPpg, pace, games: gp, source: 'season-sum' };
  }
  if (inPpgBand(pf) && inPpgBand(pa)) {
    return { offPpg: pf, defPpg: pa, pace, games: gp, source: 'per-game' };
  }
  return null;
}

/**
 * Football keeps the seed below 2 games (sierraAdjust). NBA does the same,
 * then ramps the current rate up to full weight at NBA_RAMP_GAMES.
 * Preseason is always weight 0.
 */
function seasonWeight(gp, preseason) {
  if (preseason) return 0;
  const g = Number(gp);
  if (!(g >= 2)) return 0;
  return Math.min(1, g / NBA_RAMP_GAMES);
}

function priorProfile(row, league) {
  if (!row || typeof row !== 'object') return null;
  const off = finite(row.offPpg);
  const def = finite(row.defPpg);
  if (off == null || def == null || !inPpgBand(off) || !inPpgBand(def)) return null;
  const pace = inPaceBand(finite(row.pace)) ? finite(row.pace) : league.pace;
  return { offPpg: off, defPpg: def, pace, source: 'prior' };
}

function blendProfile(prior, current, preseason) {
  const w = current && seasonWeight(current.games, preseason);
  const weight = current && prior ? w : (current && !prior ? 1 : 0);
  if (!current || weight === 0 || !prior) {
    if (prior && (!current || weight === 0)) return { ...prior, weight: 0, source: 'prior' };
    if (current && !prior) {
      return {
        offPpg: current.offPpg,
        defPpg: current.defPpg,
        pace: current.pace,
        weight: 1,
        source: current.source || 'current',
      };
    }
    return null;
  }
  if (weight >= 1) {
    return {
      offPpg: current.offPpg,
      defPpg: current.defPpg,
      pace: current.pace != null ? current.pace : prior.pace,
      weight: 1,
      source: current.source || 'current',
    };
  }
  const pace = current.pace != null && prior.pace != null
    ? (1 - weight) * prior.pace + weight * current.pace
    : (current.pace != null ? current.pace : prior.pace);
  return {
    offPpg: (1 - weight) * prior.offPpg + weight * current.offPpg,
    defPpg: (1 - weight) * prior.defPpg + weight * current.defPpg,
    pace,
    weight,
    source: 'ramp',
  };
}

function cleanPace(pace, fallback) {
  return inPaceBand(finite(pace)) ? finite(pace) : fallback;
}

/**
 * Home points = (home off + away def) / 2, scaled by expected pace / league pace.
 * Equal clubs at the league profile: margin HFA, total 2 × league ppg.
 */
function projectEnvironment({ homeProfile, awayProfile, league, hfa } = {}) {
  const L = league || { ppg: LEAGUE_PPG.NBA, pace: 99.5, season: null };
  const h = homeProfile || { offPpg: L.ppg, defPpg: L.ppg, pace: L.pace, source: 'league', weight: 0 };
  const a = awayProfile || { offPpg: L.ppg, defPpg: L.ppg, pace: L.pace, source: 'league', weight: 0 };
  const hp = cleanPace(h.pace, L.pace);
  const ap = cleanPace(a.pace, L.pace);
  const expPace = (hp + ap) / 2;
  const factor = L.pace > 0 ? expPace / L.pace : 1;
  const homePts = ((h.offPpg + a.defPpg) / 2) * factor;
  const awayPts = ((a.offPpg + h.defPpg) / 2) * factor;
  const baseHfa = Number.isFinite(Number(hfa)) ? Number(hfa) : (Number(HFA.NBA) || 2.5);
  return {
    modelMargin: (homePts - awayPts) + baseHfa,
    modelTotal: homePts + awayPts,
    homePts,
    awayPts,
    expPace,
    paceFactor: factor,
  };
}

function familyFor(homeSource, awaySource) {
  const sources = [homeSource, awaySource];
  if (sources.every((s) => s === 'league' || s == null)) return 'nba-league-hfa';
  if (sources.every((s) => s === 'prior' || s === 'league' || s == null)) return 'nba-net-prior';
  if (sources.some((s) => s === 'ramp')) return 'nba-net-ramp';
  if (sources.some((s) => s === 'ratings')) return 'nba-ortg-pace';
  return 'nba-ppg-pace';
}

function clampBoard(margin, total, leaguePpg) {
  const neutral = 2 * (Number.isFinite(Number(leaguePpg)) ? Number(leaguePpg) : LEAGUE_PPG.NBA);
  const m0 = Number(margin);
  const t0 = Number(total);
  const m = clamp(Number.isFinite(m0) ? m0 : 0, -NBA_MARGIN_CAP, NBA_MARGIN_CAP);
  const t = clamp(Number.isFinite(t0) ? t0 : neutral, NBA_TOTAL_MIN, NBA_TOTAL_MAX);
  return {
    modelMargin: m,
    modelTotal: t,
    clamped: Math.abs(m - (Number.isFinite(m0) ? m0 : 0)) > 1e-6
      || Math.abs(t - (Number.isFinite(t0) ? t0 : neutral)) > 1e-6,
  };
}

function nbaRestTable(gameDay) {
  const bag = (gameDay && gameDay.restByTeam) || {};
  if (bag.NBA && typeof bag.NBA === 'object') return bag.NBA;
  return bag;
}

function findEspnGame(ev, espnGames) {
  if (!ev || !espnGames || !espnGames.length) return null;
  const hid = resolveTeamId(SPORT, ev.home_team);
  const aid = resolveTeamId(SPORT, ev.away_team);
  if (!hid || !aid) return null;
  return espnGames.find((g) => {
    return resolveTeamId(SPORT, g.homeTeam) === hid && resolveTeamId(SPORT, g.awayTeam) === aid;
  }) || null;
}

function eventIsPreseason(ev, espnGame, opts) {
  if (opts && opts.preseason) return true;
  if (ev && (ev.preseason === true || Number(ev.seasonType) === 1)) return true;
  if (espnGame && (espnGame.preseason === true || Number(espnGame.seasonType) === 1)) return true;
  return false;
}

function uncertaintyFor(source) {
  if (source === 'nba-net-prior' || source === 'nba-league-hfa') return 0.30;
  if (source === 'nba-net-ramp') return 0.22;
  return 0.18;
}

function projectGame(event, standings, espnGame, gameDay, opts) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const prior = opts.prior || loadPrior();
  const league = leagueOf(prior);
  const preseason = !!opts.preseason;
  const homeId = resolveTeamId(SPORT, home);
  const awayId = resolveTeamId(SPORT, away);
  const unknownNames = [];
  if (!homeId) unknownNames.push(home);
  if (!awayId) unknownNames.push(away);
  for (const name of unknownNames) logUnknownTeam(SPORT, name);

  const homePrior = homeId ? priorProfile(rowByIdentity(SPORT, prior, home), league) : null;
  const awayPrior = awayId ? priorProfile(rowByIdentity(SPORT, prior, away), league) : null;
  const homeCur = homeId ? resolveTeamRates(rowByIdentity(SPORT, standings, home), league.ppg) : null;
  const awayCur = awayId ? resolveTeamRates(rowByIdentity(SPORT, standings, away), league.ppg) : null;
  const homeBlend = unknownNames.length ? null : blendProfile(homePrior, homeCur, preseason);
  const awayBlend = unknownNames.length ? null : blendProfile(awayPrior, awayCur, preseason);
  const env = projectEnvironment({
    homeProfile: homeBlend,
    awayProfile: awayBlend,
    league,
    hfa: HFA.NBA,
  });
  const family = unknownNames.length ? 'nba-unknown-team' : familyFor(
    homeBlend && homeBlend.source,
    awayBlend && awayBlend.source
  );
  let uncertainty = uncertaintyFor(family);
  const gd = applyGameDayAdjustments({
    sport: SPORT,
    modelMargin: env.modelMargin,
    modelTotal: env.modelTotal,
    uncertainty,
    home,
    away,
    restByTeam: nbaRestTable(gameDay),
    qbByTeam: {},
    hfaBase: HFA.NBA,
  });
  const board = clampBoard(gd.modelMargin, gd.modelTotal, league.ppg);
  const modelMargin = board.modelMargin;
  const modelTotal = board.modelTotal;
  uncertainty = gd.uncertainty;
  const usedGameday = !!(gd.gameDay && gd.gameDay.applied);
  const tag = (market) => {
    let m = `${family}-${market}`;
    if (usedGameday) m += '-gameday';
    return m;
  };
  const nbaMeta = {
    season: league.season,
    preseason,
    shadowOnly: preseason,
    family,
    homeSource: homeBlend ? homeBlend.source : 'league',
    awaySource: awayBlend ? awayBlend.source : 'league',
    homeWeight: homeBlend ? homeBlend.weight : 0,
    awayWeight: awayBlend ? awayBlend.weight : 0,
    expPace: +env.expPace.toFixed(2),
    spreadSd: SPORT_SPREAD_STD.NBA,
    totalSd: SPORT_TOTAL_STD.NBA,
    sanityClamped: board.clamped,
  };
  const gameDayMeta = { ...(gd.gameDay || {}), applied: usedGameday, nba: nbaMeta };
  const out = [];
  const base = {
    sport: SPORT,
    homeTeam: home,
    awayTeam: away,
    matchup: formatMatchup(away, home),
    commenceTime,
    unknownTeam: unknownNames.length > 0,
    unknownNames,
    preseason,
    shadowOnly: preseason,
    gameDay: gameDayMeta,
  };

  {
    const bundles = collectMarketOutcomes(event, 'h2h');
    for (const b of bundles) {
      const isHome = b.side === home;
      let p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
      p = blendWithMarket(p, noVigPinnacleCircaImplied(bundles, b), BLEND.ml);
      out.push(enrichCandidateWithEdge({
        ...base,
        market: 'Moneyline',
        side: b.side,
        line: null,
        pickSide: isHome ? 'home' : 'away',
        modelRawP: p,
        projMethod: tag('ml'),
        uncertainty,
        consensusLine: null,
        modelProjection: +modelMargin.toFixed(2),
      }, b, bundles));
    }
  }

  {
    const bundles = collectMarketOutcomes(event, 'spreads');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const isHome = b.side === home;
      let pCover = spreadCoverProb(isHome ? modelMargin : -modelMargin, line, SPORT);
      pCover = blendWithMarket(pCover, noVigPinnacleCircaImplied(bundles, b), BLEND.spread);
      const sideLabel = line > 0 ? `${b.side} +${line}` : `${b.side} ${line}`;
      out.push(enrichCandidateWithEdge({
        ...base,
        market: 'Spread',
        side: sideLabel,
        line,
        pickSide: isHome ? 'home' : 'away',
        modelRawP: pCover,
        projMethod: tag('spread'),
        uncertainty,
        consensusLine: line,
        modelProjection: +modelMargin.toFixed(2),
      }, b, bundles));
    }
  }

  {
    const bundles = collectMarketOutcomes(event, 'totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const over = /over/i.test(b.side);
      let p = totalCoverProb(modelTotal, line, b.side, SPORT);
      p = blendWithMarket(p, noVigPinnacleCircaImplied(bundles, b), BLEND.total);
      out.push(enrichCandidateWithEdge({
        ...base,
        market: 'Total',
        side: `${b.side} ${line}`,
        line,
        pickSide: over ? 'over' : 'under',
        modelRawP: p,
        projMethod: tag('total'),
        uncertainty: uncertainty + 0.05,
        consensusLine: line,
        modelProjection: +modelTotal.toFixed(2),
      }, b, bundles));
    }
  }

  return out;
}

function project({
  oddsEvents, standings, gameDay, espnGames, prior, allowPreseason, preseason,
} = {}) {
  const games = (espnGames && espnGames.games) || espnGames || [];
  const table = prior ? centerNbaSeed(prior) : null;
  return mapGamesSoft(oddsEvents, (ev) => {
    const eg = findEspnGame(ev, games);
    const isPre = eventIsPreseason(ev, eg, { preseason });
    if (isPre && !allowPreseason) return [];
    return projectGame(ev, standings || {}, eg, gameDay || {}, {
      prior: table || loadPrior(),
      preseason: isPre,
    });
  });
}

module.exports = {
  project,
  SPORT,
  centerNbaSeed,
  loadPrior,
  resolveTeamRates,
  seasonWeight,
  projectEnvironment,
  blendProfile,
  NBA_RAMP_GAMES,
  NBA_PPG_MIN,
  NBA_PPG_MAX,
  NBA_MARGIN_CAP,
  NBA_TOTAL_MIN,
  NBA_TOTAL_MAX,
  BLEND,
};
