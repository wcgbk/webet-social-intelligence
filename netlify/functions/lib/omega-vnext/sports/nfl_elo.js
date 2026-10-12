'use strict';

/**
 * NFL Elo, FiveThirtyEight forecast.py shape.
 *
 * K = 20. Win probability is 1 / (10^(-diff/400) + 1).
 * Margin of victory multiplier matches forecast.py, including the tie
 * branch that divides by 1 instead of (winnerDiff * 0.001 + 2.2).
 * Home field is this repo's HFA.NFL (2.0 points) times 25 Elo per point,
 * so 50 Elo, and 0 on a neutral site. It is not 538's 65.
 * One point of spread is 25 Elo.
 *
 * The shipped prior is end-of-2025, regressed 1/3 of the way to 1505,
 * then blended 2:1 toward the win-total Elo. This module applies 2026
 * finals strictly before the card's ET date on top of that prior.
 * A finite NFL prior K shrinks only that preseason deviation from 1505.
 * The Elo shift from games stays whole. Null K leaves the walk unchanged.
 * OMEGA_FROZEN_SNAP never hits the network. A missing frozen board
 * leaves every club on the prior.
 */

const fs = require('fs');
const path = require('path');
const { HFA, priorW, sportPriorK } = require('../config');
const { memoFetchJson, memoValue } = require('../fetch_memo');
const { etCalendarDate } = require('../odds_math');
const { resolveTeamId } = require('./team_identity');

const MEAN_ELO = 1505;
const K_FACTOR = 20;
const REVERT = 1 / 3;
const ELO_PER_POINT = 25;
const SEASON_GAMES = 17;
const RUNTIME_SEASON = 2026;
const PRIOR_FILE = path.join(__dirname, 'data', 'nfl_elo_prior_2026.json');
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

let teamIdSet = null;
let priorCache = null;
let state = null;

function nflIds() {
  if (!teamIdSet) {
    const table = require('./data/nfl-team-ids.json');
    teamIdSet = new Set(Object.keys(table.teams || {}));
  }
  return teamIdSet;
}

function isNflId(id) {
  return id != null && id !== '' && nflIds().has(String(id));
}

function hfaElo(neutral) {
  if (neutral) return 0;
  const pts = Number(HFA && HFA.NFL);
  const points = Number.isFinite(pts) ? pts : 2;
  return points * ELO_PER_POINT;
}

/** forecast.py: 1 / (10^(-diff/400) + 1). diff is home minus away plus HFA. */
function eloProb(eloDiff) {
  return 1 / (Math.pow(10, -eloDiff / 400) + 1);
}

/**
 * forecast.py margin multiplier.
 * resultHome is 1, 0, or 0.5. eloDiff is the pre-game home advantage,
 * home field included. A tie uses denominator 1, not 2.2.
 */
function movMultiplier(pointDiff, eloDiff, resultHome) {
  const pd = Math.abs(Number(pointDiff));
  const ln = Math.log(Math.max(pd, 1) + 1);
  if (resultHome === 0.5) return ln * (2.2 / 1);
  const winnerDiff = resultHome === 1 ? eloDiff : -eloDiff;
  return ln * (2.2 / (winnerDiff * 0.001 + 2.2));
}

/** Move one third of the way from elo to the mean. Retains two thirds. */
function regressElo(elo, mean = MEAN_ELO, revert = REVERT) {
  return mean * revert + elo * (1 - revert);
}

/**
 * Win total → Elo against a 1505 opponent, HFA left out.
 * A balanced home/away schedule cancels home field at the first order,
 * and the published totals already sum to 8.5 wins times 32 clubs.
 * p = wins/17, diff = -400 * log10((1-p)/p), raw = 1505 + diff.
 */
function winTotalEloRaw(wins, games = SEASON_GAMES) {
  const w = Number(wins);
  const g = Number(games);
  if (!Number.isFinite(w) || !(g > 0)) return null;
  const p = Math.min(0.999, Math.max(0.001, w / g));
  const diff = -400 * Math.log10((1 - p) / p);
  return MEAN_ELO + diff;
}

/** Shift a map so its mean is 1505. Relative gaps stay put. */
function centerEloMap(rawById, mean = MEAN_ELO) {
  const ids = Object.keys(rawById || {}).filter((id) => Number.isFinite(rawById[id]));
  const out = {};
  if (!ids.length) return out;
  const avg = ids.reduce((sum, id) => sum + rawById[id], 0) / ids.length;
  for (const id of ids) out[id] = rawById[id] - avg + mean;
  return out;
}

/** 538 weights the win-total rating 2 and the regressed Elo 1. */
function blendWinTotal(regressed, winTotalElo) {
  return (2 * winTotalElo + regressed) / 3;
}

function resultHome(homeScore, awayScore) {
  if (homeScore > awayScore) return 1;
  if (homeScore < awayScore) return 0;
  return 0.5;
}

/**
 * Update home and away in place. team1 is the home club, as in forecast.py.
 * Returns the shift added to the home rating (the away rating loses it).
 */
function applyEloGame(ratings, game) {
  const homeId = String(game.homeId);
  const awayId = String(game.awayId);
  const home = Number.isFinite(ratings[homeId]) ? ratings[homeId] : MEAN_ELO;
  const away = Number.isFinite(ratings[awayId]) ? ratings[awayId] : MEAN_ELO;
  const neutral = game.neutral === true || game.neutral === 1;
  const eloDiff = home - away + hfaElo(neutral);
  const hs = Number(game.homeScore);
  const as = Number(game.awayScore);
  const result = resultHome(hs, as);
  const pd = Math.abs(hs - as);
  const pHome = eloProb(eloDiff);
  const mult = movMultiplier(pd, eloDiff, result);
  const shift = K_FACTOR * mult * (result - pHome);
  ratings[homeId] = home + shift;
  ratings[awayId] = away - shift;
  return { eloDiff, pHome, mult, shift, result };
}

function weekScoreboardUrl(year, seasonType, week) {
  return `${SCOREBOARD}?seasontype=${encodeURIComponent(seasonType)}&week=${encodeURIComponent(week)}&dates=${encodeURIComponent(year)}`;
}

function skippedStatus(comp, ev) {
  const st = (comp && comp.status && comp.status.type)
    || (ev && ev.status && ev.status.type)
    || {};
  const name = `${st.name || ''} ${st.description || ''} ${st.shortDetail || ''}`;
  return /cancel|postponed|forfeit/i.test(name);
}

function isFinal(comp, ev) {
  const st = (comp && comp.status && comp.status.type)
    || (ev && ev.status && ev.status.type)
    || {};
  const name = `${st.name || ''} ${st.state || ''} ${st.description || ''}`;
  return st.completed === true || st.name === 'STATUS_FINAL' || /\bfinal\b/i.test(name);
}

/** Completed NFL games on one ESPN scoreboard body. Preseason is dropped. */
function gamesFromEspnBoard(board) {
  const seasonYear = board && board.season ? Number(board.season.year) : null;
  const seasonType = board && board.season ? Number(board.season.type) : null;
  const week = board && board.week ? Number(board.week.number) : null;
  const out = [];
  if (seasonType === 1) return out;
  for (const ev of (board && board.events) || []) {
    if (!ev || typeof ev !== 'object') continue;
    const name = `${ev.name || ''} ${ev.shortName || ''}`;
    if (/pro bowl/i.test(name)) continue;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    if (skippedStatus(comp, ev) || !isFinal(comp, ev)) continue;
    const comps = comp.competitors || [];
    const home = comps.find((c) => c && c.homeAway === 'home');
    const away = comps.find((c) => c && c.homeAway === 'away');
    if (!home || !away) continue;
    const homeId = home.team && home.team.id != null ? String(home.team.id) : '';
    const awayId = away.team && away.team.id != null ? String(away.team.id) : '';
    if (!isNflId(homeId) || !isNflId(awayId) || homeId === awayId) continue;
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const date = ev.date || comp.date || null;
    if (!date || !Number.isFinite(Date.parse(date))) continue;
    out.push({
      id: ev.id != null && ev.id !== '' ? String(ev.id) : `${date}|${awayId}|${homeId}`,
      season: Number.isInteger(seasonYear) ? seasonYear : null,
      seasonType: Number.isFinite(seasonType) ? seasonType : null,
      week: Number.isInteger(week) ? week : null,
      date,
      homeId,
      awayId,
      homeScore,
      awayScore,
      neutral: comp.neutralSite === true,
    });
  }
  return out;
}

function compareGames(a, b) {
  const dt = Date.parse(a.date) - Date.parse(b.date);
  if (dt) return dt;
  return String(a.id).localeCompare(String(b.id));
}

function loadPrior() {
  if (!priorCache) priorCache = require('./data/nfl_elo_prior_2026.json');
  return priorCache;
}

function priorRatings() {
  const file = loadPrior();
  const teams = (file && file.teams) || {};
  const out = {};
  for (const id of nflIds()) {
    const row = teams[id];
    const blended = row && Number(row.blended);
    const regressed = row && Number(row.regressed);
    if (Number.isFinite(blended)) out[id] = blended;
    else if (Number.isFinite(regressed)) out[id] = regressed;
    else out[id] = MEAN_ELO;
  }
  return out;
}

function ratingsAfterGames(games, start) {
  const ratings = Object.assign({}, start || priorRatings());
  const ordered = (games || []).slice().sort(compareGames);
  for (const game of ordered) {
    if (!game || !isNflId(game.homeId) || !isNflId(game.awayId)) continue;
    applyEloGame(ratings, game);
  }
  return ratings;
}

function gamesPlayedById(games) {
  const counts = new Map();
  for (const game of games || []) {
    if (!game || !isNflId(game.homeId) || !isNflId(game.awayId)) continue;
    const homeId = String(game.homeId);
    const awayId = String(game.awayId);
    counts.set(homeId, (counts.get(homeId) || 0) + 1);
    counts.set(awayId, (counts.get(awayId) || 0) + 1);
  }
  return counts;
}

/**
 * Shrink only the preseason deviation from MEAN_ELO.
 * rating = MEAN + priorW(g, k) * (prior - MEAN) + (walked - prior).
 * k null or non-finite is the legacy intercept (deviation weight 1).
 */
function applyNflPriorDecay(prior, walked, games, k) {
  const base = Object.assign({}, walked || {});
  if (k == null || !Number.isFinite(Number(k))) return base;
  const counts = gamesPlayedById(games);
  const ids = new Set([
    ...Object.keys(prior || {}),
    ...Object.keys(base),
  ]);
  const out = {};
  for (const id of ids) {
    const p = prior && Number.isFinite(Number(prior[id])) ? Number(prior[id]) : MEAN_ELO;
    const walkedElo = Number.isFinite(Number(base[id])) ? Number(base[id]) : p;
    const g = counts.get(String(id)) || 0;
    const w = priorW(g, k);
    out[id] = MEAN_ELO + w * (p - MEAN_ELO) + (walkedElo - p);
  }
  return out;
}

function gamesBeforeCard(games, cardDate) {
  const card = String(cardDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card)) return [];
  const out = [];
  for (const game of games || []) {
    if (!game) continue;
    if (game.season != null && game.season !== RUNTIME_SEASON) continue;
    if (game.seasonType === 1) continue;
    const et = etCalendarDate(game.date);
    if (et && et < card) out.push(game);
  }
  return out;
}

function scheduleDirFromEnv() {
  const env = process.env.OMEGA_REST_SCHEDULE_DIR;
  if (env == null || String(env).trim() === '') return null;
  return String(env).trim();
}

function frozenSnapOn() {
  return process.env.OMEGA_FROZEN_SNAP != null && String(process.env.OMEGA_FROZEN_SNAP).trim() !== '';
}

/**
 * Read nfl-wN.json ESPN boards from a directory. null when the directory
 * has no week file. An empty list means the files were there and no
 * completed game was on them.
 */
function readWeekDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const games = [];
  const seen = new Set();
  let files = 0;
  for (let week = 1; week <= 23; week += 1) {
    const file = path.join(dir, `nfl-w${week}.json`);
    if (!fs.existsSync(file)) continue;
    files += 1;
    let board = null;
    try {
      board = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      board = null;
    }
    for (const game of gamesFromEspnBoard(board)) {
      if (seen.has(game.id)) continue;
      seen.add(game.id);
      games.push(game);
    }
  }
  if (!files) return null;
  return games;
}

async function fetchSeasonBoards(year, fetchImpl) {
  const games = [];
  const seen = new Set();
  const impl = fetchImpl || fetch;
  for (const seasonType of [2, 3]) {
    const weeks = seasonType === 2 ? 18 : 5;
    for (let week = 1; week <= weeks; week += 1) {
      const url = weekScoreboardUrl(year, seasonType, week);
      let board = null;
      try {
        board = await memoFetchJson(url, 10000, impl);
      } catch (e) {
        if (seasonType === 3) continue;
        throw e;
      }
      for (const game of gamesFromEspnBoard(board)) {
        if (seen.has(game.id)) continue;
        seen.add(game.id);
        games.push(game);
      }
    }
  }
  return games;
}

function finishPack(cardDate, games, source) {
  const appliedGames = gamesBeforeCard(games, cardDate);
  const prior = priorRatings();
  const walked = ratingsAfterGames(appliedGames, prior);
  const ratings = applyNflPriorDecay(prior, walked, appliedGames, sportPriorK('NFL'));
  const pack = {
    cardDate: cardDate || null,
    source,
    applied: appliedGames.length,
    ratings,
    fetched: source === 'fetch',
  };
  state = pack;
  return pack;
}

/**
 * Ratings for one card date.
 * Ingested games win. Else a week-file directory (replay frozen boards).
 * Else, when OMEGA_FROZEN_SNAP is set, the prior and no network.
 * Else one memoized 2026 scoreboard fetch. A failed fetch stays on the prior.
 */
async function prepareNflElo(cardDate, opts = {}) {
  const frozen = frozenSnapOn();
  if (Array.isArray(opts.games)) {
    return finishPack(cardDate, opts.games, 'ingested');
  }
  const dir = Object.prototype.hasOwnProperty.call(opts, 'dir') ? opts.dir : scheduleDirFromEnv();
  const fromDir = dir ? readWeekDir(dir) : null;
  // An empty list is a real board with no finals. Do not fall through to a fetch.
  if (Array.isArray(fromDir)) {
    return finishPack(cardDate, fromDir, frozen ? 'frozen-weeks' : 'schedule-dir');
  }
  if (frozen) return finishPack(cardDate, [], 'prior');
  try {
    const games = await memoValue(
      `nfl-elo-games-${RUNTIME_SEASON}`,
      () => fetchSeasonBoards(RUNTIME_SEASON, opts.fetchImpl),
    );
    return finishPack(cardDate, games, 'fetch');
  } catch (e) {
    const pack = finishPack(cardDate, [], 'prior');
    pack.error = e && e.message ? String(e.message) : 'nfl elo fetch failed';
    return pack;
  }
}

function currentPack() {
  return state;
}

function resetNflEloState() {
  state = null;
}

/**
 * Home margin in points. Unknown clubs are the mean (1505).
 * ratings, when passed, is espnId → Elo. Otherwise the prepared pack,
 * otherwise the preseason prior with no 2026 games.
 */
function eloMargin(home, away, neutral, ratings) {
  const table = ratings || (state && state.ratings) || priorRatings();
  const homeId = resolveTeamId('NFL', home);
  const awayId = resolveTeamId('NFL', away);
  const h = homeId && Number.isFinite(table[homeId]) ? table[homeId] : MEAN_ELO;
  const a = awayId && Number.isFinite(table[awayId]) ? table[awayId] : MEAN_ELO;
  const diff = h - a + hfaElo(neutral === true);
  return diff / ELO_PER_POINT;
}

module.exports = {
  MEAN_ELO,
  K_FACTOR,
  REVERT,
  ELO_PER_POINT,
  SEASON_GAMES,
  RUNTIME_SEASON,
  PRIOR_FILE,
  hfaElo,
  eloProb,
  movMultiplier,
  regressElo,
  winTotalEloRaw,
  centerEloMap,
  blendWinTotal,
  applyEloGame,
  gamesFromEspnBoard,
  weekScoreboardUrl,
  loadPrior,
  priorRatings,
  ratingsAfterGames,
  applyNflPriorDecay,
  gamesBeforeCard,
  readWeekDir,
  fetchSeasonBoards,
  prepareNflElo,
  currentPack,
  resetNflEloState,
  eloMargin,
};
