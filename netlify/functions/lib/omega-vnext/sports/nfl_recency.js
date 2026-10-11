'use strict';
/**
 * NFL last-five recency inside the team rating.
 * Performance on a completed game is the point margin minus the rating
 * expectation (stored expectedMargin, otherwise this team's point rating
 * minus the opponent's). The mean residual is shrunk hard toward 0 and
 * added to that team's rating before the game margin is priced.
 * Weight at five games is RECENCY_FULL_WEIGHT. Fewer than five games
 * multiplies by n/5, so a short sample shrinks toward 0. Each team and
 * the home-margin contribution are capped at ±RECENCY_CAP (1 point).
 * Missing games, a missing rating, or a non-finite margin contribute 0.
 * This is not added after the edge and it is not the fair price.
 */
const { SPORT_CFG, lookupEpa, sierraAdjust } = require('./epa');
const { powerFromStandings } = require('./_common');
const { resolveTeamId, modelRow } = require('./team_identity');

const RECENCY_GAMES = 5;
const RECENCY_FULL_WEIGHT = 0.05;
const RECENCY_CAP = 1;

function finite(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function clampCap(n) {
  if (n > RECENCY_CAP) return RECENCY_CAP;
  if (n < -RECENCY_CAP) return -RECENCY_CAP;
  return n;
}

function priorGames(games, kickoffMs) {
  const prior = [];
  for (const g of games || []) {
    if (!g) continue;
    const margin = finite(g.margin);
    if (margin == null) continue;
    const t = Date.parse(g.commence || g.commenceTime || '');
    if (!Number.isFinite(t)) continue;
    if (kickoffMs != null && Number.isFinite(kickoffMs) && !(t < kickoffMs)) continue;
    prior.push({
      t,
      margin,
      expectedMargin: finite(g.expectedMargin),
      opponentId: g.opponentId != null && g.opponentId !== '' ? String(g.opponentId) : null,
    });
  }
  prior.sort((a, b) => b.t - a.t);
  return prior.slice(0, RECENCY_GAMES);
}

/**
 * Points added to one team's rating. rating null, or no usable games, is 0.
 * ratingsById is opponentId → point rating. A missing opponent is an
 * average opponent (rating 0). A stored expectedMargin wins over that.
 */
function teamRecencyPoints(games, teamRating, ratingsById, kickoffMs) {
  const empty = { points: 0, n: 0, w: 0, mean: 0 };
  const rating = finite(teamRating);
  if (rating == null) return empty;
  const used = priorGames(games, kickoffMs);
  const residuals = [];
  for (const g of used) {
    let expected = g.expectedMargin;
    if (expected == null) {
      let opp = 0;
      if (g.opponentId) {
        const mapped = ratingsById ? finite(ratingsById[g.opponentId]) : null;
        if (mapped == null) continue;
        opp = mapped;
      }
      expected = rating - opp;
    }
    residuals.push(g.margin - expected);
  }
  const n = residuals.length;
  if (!n) return empty;
  const mean = residuals.reduce((s, x) => s + x, 0) / n;
  const w = (n / RECENCY_GAMES) * RECENCY_FULL_WEIGHT;
  return { points: clampCap(w * mean), n, w, mean };
}

function blendRecencyIntoMargin({
  modelMargin,
  homeGames,
  awayGames,
  homeRating,
  awayRating,
  ratingsById,
  kickoffMs,
} = {}) {
  const base = finite(modelMargin);
  const home = teamRecencyPoints(homeGames, homeRating, ratingsById, kickoffMs);
  const away = teamRecencyPoints(awayGames, awayRating, ratingsById, kickoffMs);
  if (base == null) {
    return { modelMargin, delta: 0, applied: false, home, away };
  }
  const delta = clampCap(home.points - away.points);
  const applied = Math.abs(delta) > 1e-12;
  return {
    modelMargin: base + delta,
    delta,
    applied,
    home,
    away,
  };
}

/** Point rating versus an average opponent. Null when this club has no rating. */
function nflTeamPointRating(name, standings, efficiency) {
  if (!name) return null;
  const plays = (SPORT_CFG.NFL && SPORT_CFG.NFL.plays) || 62;
  const seed = lookupEpa(name, efficiency || {}, 'NFL');
  if (seed) {
    const row = modelRow('NFL', standings || {}, name);
    const adj = sierraAdjust(seed, row, SPORT_CFG.NFL);
    const off = finite(adj && adj.offEpa);
    const def = finite(adj && adj.defEpa);
    if (off == null || def == null) return null;
    return (off + def) * plays;
  }
  const row = modelRow('NFL', standings || {}, name);
  if (!row) return null;
  const pow = finite(powerFromStandings(row, 'NFL'));
  return pow;
}

function gamesForTeam(last5ByTeam, teamName) {
  if (!last5ByTeam || !teamName) return null;
  const table = last5ByTeam.NFL && typeof last5ByTeam.NFL === 'object'
    ? last5ByTeam.NFL
    : last5ByTeam;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const id = resolveTeamId('NFL', teamName);
  if (id == null || id === '') return null;
  const games = table[String(id)];
  return Array.isArray(games) ? games : null;
}

function ratingsByTeamId(standings, efficiency) {
  const byId = {};
  for (const table of [efficiency, standings]) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const key of Object.keys(table)) {
      if (!key || key.startsWith('_')) continue;
      const id = resolveTeamId('NFL', key);
      if (id == null || id === '' || Object.prototype.hasOwnProperty.call(byId, String(id))) continue;
      const pts = nflTeamPointRating(key, standings, efficiency);
      if (pts == null) continue;
      byId[String(id)] = pts;
    }
  }
  return byId;
}

/**
 * Blend last-5 residuals into the pre-market home margin.
 * No last5 table, or a team with no rating, leaves that side at 0.
 */
function blendNflRecency({
  modelMargin,
  home,
  away,
  standings,
  efficiency,
  last5ByTeam,
  commenceTime,
} = {}) {
  const kick = commenceTime ? Date.parse(commenceTime) : NaN;
  const homeRating = nflTeamPointRating(home, standings, efficiency);
  const awayRating = nflTeamPointRating(away, standings, efficiency);
  const blended = blendRecencyIntoMargin({
    modelMargin,
    homeGames: gamesForTeam(last5ByTeam, home),
    awayGames: gamesForTeam(last5ByTeam, away),
    homeRating,
    awayRating,
    ratingsById: ratingsByTeamId(standings, efficiency),
    kickoffMs: Number.isFinite(kick) ? kick : null,
  });
  return {
    ...blended,
    homeRating,
    awayRating,
    stamp: blended.applied ? {
      delta: +blended.delta.toFixed(3),
      homePoints: +blended.home.points.toFixed(3),
      awayPoints: +blended.away.points.toFixed(3),
      homeN: blended.home.n,
      awayN: blended.away.n,
    } : null,
  };
}

module.exports = {
  RECENCY_GAMES,
  RECENCY_FULL_WEIGHT,
  RECENCY_CAP,
  teamRecencyPoints,
  blendRecencyIntoMargin,
  nflTeamPointRating,
  blendNflRecency,
};
