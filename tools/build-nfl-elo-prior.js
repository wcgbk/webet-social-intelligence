'use strict';

/**
 * Build sports/data/nfl_elo_prior_2026.json.
 *
 * Pulls ESPN NFL scoreboards for 2023, 2024, and 2025, regular season
 * (seasontype=2, weeks 1-18) and postseason (seasontype=3, weeks 1-5).
 * Every club starts 2023 at 1505. There is no 2022 carry-in. Between
 * seasons each rating moves one third of the way to 1505. The 2026
 * preseason number is that regressed rating blended 2:1 toward the
 * DraftKings win-total Elo.
 *
 * Usage: node tools/build-nfl-elo-prior.js
 */

const fs = require('fs');
const path = require('path');
const elo = require('../netlify/functions/lib/omega-vnext/sports/nfl_elo');

const OUT = elo.PRIOR_FILE;
const SEASONS = [2023, 2024, 2025];
const WIN_TOTAL_SOURCE = {
  url: 'https://www.si.com/betting/2026-nfl-win-total-projections-for-every-team-lions-will-benefit-from-league-s-easiest-schedule-01m0xm77seqx',
  book: 'DraftKings Sportsbook',
  articleDate: '2026-08-30',
  fetched: '2026-10-11',
  note: 'Sports Illustrated, Iain MacMillan. Body is pre-Week-1: the opener named is Seattle vs New England and has not been played. Line on the page: "Odds via DraftKings Sportsbook". The 32 numbers were read from the fetched HTML on 2026-10-11 and match the 2026-08-30 index of the same URL (Ravens 11.5 +115/-140, Rams 11.5 -125/+105, Chiefs 10.5 +115/-140). The CMS last_published stamp is 2026-09-27; the board and the pre-opener prose are unchanged. The 32 totals sum to 272, which is 8.5 wins times 32.',
};

/**
 * DraftKings regular-season win totals, pre-Week-1 2026.
 * Keyed by the odds display name, resolved to an ESPN id at build time.
 */
const WIN_TOTALS_BY_NAME = {
  'Arizona Cardinals': 3.5,
  'Atlanta Falcons': 7.5,
  'Baltimore Ravens': 11.5,
  'Buffalo Bills': 10.5,
  'Carolina Panthers': 7.5,
  'Chicago Bears': 9.5,
  'Cincinnati Bengals': 10.5,
  'Cleveland Browns': 5.5,
  'Dallas Cowboys': 9.5,
  'Denver Broncos': 9.5,
  'Detroit Lions': 10.5,
  'Green Bay Packers': 9.5,
  'Houston Texans': 9.5,
  'Indianapolis Colts': 7.5,
  'Jacksonville Jaguars': 8.5,
  'Kansas City Chiefs': 10.5,
  'Las Vegas Raiders': 5.5,
  'Los Angeles Chargers': 9.5,
  'Los Angeles Rams': 11.5,
  'Miami Dolphins': 3.5,
  'Minnesota Vikings': 8.5,
  'New England Patriots': 10.5,
  'New Orleans Saints': 7.5,
  'New York Giants': 7.5,
  'New York Jets': 5.5,
  'Philadelphia Eagles': 10.5,
  'Pittsburgh Steelers': 8.5,
  'San Francisco 49ers': 9.5,
  'Seattle Seahawks': 10.5,
  'Tampa Bay Buccaneers': 8.5,
  'Tennessee Titans': 6.5,
  'Washington Commanders': 7.5,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status} ${url}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.json();
    } catch (e) {
      last = e;
      await sleep(400 * attempt);
    }
  }
  throw last;
}

async function fetchSeason(year) {
  const games = [];
  const seen = new Set();
  const fetched = [];
  for (const seasonType of [2, 3]) {
    const weeks = seasonType === 2 ? 18 : 5;
    for (let week = 1; week <= weeks; week += 1) {
      const url = elo.weekScoreboardUrl(year, seasonType, week);
      let board = null;
      try {
        board = await fetchJson(url);
      } catch (e) {
        if (seasonType === 3) {
          fetched.push({ year, seasonType, week, error: e.message, games: 0 });
          continue;
        }
        throw e;
      }
      const rows = elo.gamesFromEspnBoard(board);
      let added = 0;
      for (const game of rows) {
        if (seen.has(game.id)) continue;
        seen.add(game.id);
        games.push(game);
        added += 1;
      }
      fetched.push({ year, seasonType, week, games: added });
      process.stdout.write(`  ${year} type ${seasonType} week ${week}: ${added}\n`);
      await sleep(40);
    }
  }
  return { games, fetched };
}

function teamRows() {
  const table = require('../netlify/functions/lib/omega-vnext/sports/data/nfl-team-ids.json');
  return table.teams || {};
}

function resolveWinTotals(teams) {
  const { resolveTeamId } = require('../netlify/functions/lib/omega-vnext/sports/team_identity');
  const byId = {};
  const used = new Set();
  for (const [name, wins] of Object.entries(WIN_TOTALS_BY_NAME)) {
    const id = resolveTeamId('NFL', name);
    if (!id || !teams[id]) throw new Error(`win total name did not resolve: ${name}`);
    if (used.has(id)) throw new Error(`win total id collision: ${name} → ${id}`);
    used.add(id);
    byId[id] = wins;
  }
  if (used.size !== Object.keys(teams).length) {
    throw new Error(`win totals cover ${used.size} clubs, table has ${Object.keys(teams).length}`);
  }
  const sum = Object.values(byId).reduce((s, n) => s + n, 0);
  if (Math.abs(sum - 272) > 1e-9) throw new Error(`win totals sum to ${sum}, expected 272`);
  return byId;
}

function roll(games, ids) {
  const ratings = {};
  for (const id of ids) ratings[id] = elo.MEAN_ELO;
  const ordered = games.slice().sort((a, b) => {
    const dt = Date.parse(a.date) - Date.parse(b.date);
    if (dt) return dt;
    return String(a.id).localeCompare(String(b.id));
  });
  let season = null;
  const endBySeason = {};
  const countBySeason = {};
  for (const game of ordered) {
    if (game.season == null) continue;
    if (season != null && game.season !== season) {
      endBySeason[season] = Object.assign({}, ratings);
      for (const id of ids) ratings[id] = elo.regressElo(ratings[id]);
    }
    season = game.season;
    elo.applyEloGame(ratings, game);
    countBySeason[season] = (countBySeason[season] || 0) + 1;
  }
  if (season != null) endBySeason[season] = Object.assign({}, ratings);
  return { endBySeason, countBySeason };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

async function main() {
  const teams = teamRows();
  const ids = Object.keys(teams).sort((a, b) => Number(a) - Number(b));
  const winById = resolveWinTotals(teams);
  const games = [];
  const weeks = [];
  for (const year of SEASONS) {
    process.stdout.write(`season ${year}\n`);
    const pulled = await fetchSeason(year);
    games.push(...pulled.games);
    weeks.push(...pulled.fetched);
  }
  const { endBySeason, countBySeason } = roll(games, ids);
  const end2025 = endBySeason[2025];
  if (!end2025) throw new Error('no end-of-2025 ratings');
  const regressed = {};
  const rawWin = {};
  for (const id of ids) {
    regressed[id] = elo.regressElo(end2025[id]);
    rawWin[id] = elo.winTotalEloRaw(winById[id]);
  }
  const centered = elo.centerEloMap(rawWin);
  const hfaPoints = 2;
  const doc = {
    meta: {
      builtAt: new Date().toISOString(),
      meanElo: elo.MEAN_ELO,
      k: elo.K_FACTOR,
      revert: elo.REVERT,
      eloPerPoint: elo.ELO_PER_POINT,
      hfaPoints,
      hfaElo: hfaPoints * elo.ELO_PER_POINT,
      hfaNote: 'Repo HFA.NFL is 2.0 points. 2.0 * 25 = 50 Elo. Neutral games use 0. This is not FiveThirtyEight\'s 65.',
      initialElo: elo.MEAN_ELO,
      initialNote: 'All 32 clubs start the 2023 season at 1505. No 2022 ending Elo is carried in. 2023, 2024, and 2025 regular and postseason games are applied in kick order. At each new season, before the first game, every rating moves one third of the way to 1505.',
      seasons: SEASONS,
      seasonTypes: { regular: 2, post: 3 },
      gameCounts: countBySeason,
      scoreUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype={2|3}&week={n}&dates={year}',
      weeks,
      formulas: {
        probability: 'p = 1 / (10^(-eloDiff/400) + 1)',
        eloDiff: 'homeElo - awayElo + (neutral ? 0 : hfaElo)',
        mov: 'ln(max(|pd|, 1) + 1) * 2.2 / (winnerEloDiff * 0.001 + 2.2). A tie (result 0.5) uses denominator 1, matching forecast.py. winnerEloDiff is the pre-game eloDiff from the winner, home field included.',
        shift: 'K * mov * (resultHome - pHome), K = 20. Home gains the shift. Away loses it. resultHome is 1, 0, or 0.5.',
        regression: 'regressed = 1505 * (1/3) + end2025 * (2/3)',
        winTotalToElo: 'p = wins / 17. raw = 1505 + (-400 * log10((1 - p) / p)). HFA is not inside this map. winTotalElo recenters raw so the 32 ratings average 1505. The market totals sum to 272, so the mean win total is 8.5 and the uncentered mean sits near 1505. Recentering removes the logistic\'s Jensen gap.',
        blend: 'blended = (2 * winTotalElo + 1 * regressed) / 3. FiveThirtyEight weights the win-total rating twice the regressed Elo. The market is the heavier prior. The model earns any later deviation.',
        marginPoints: 'eloMargin = (homeElo - awayElo + hfaElo) / 25. Equal clubs at home are HFA.NFL (2.0). Neutral is 0.',
      },
      winTotalSource: WIN_TOTAL_SOURCE,
    },
    winTotals: {},
    teams: {},
  };
  for (const id of ids) {
    const row = teams[id];
    const blended = elo.blendWinTotal(regressed[id], centered[id]);
    doc.winTotals[id] = winById[id];
    doc.teams[id] = {
      espnId: id,
      abbreviation: row.abbreviation,
      name: row.displayName,
      end2025: round6(end2025[id]),
      regressed: round6(regressed[id]),
      winTotal: winById[id],
      winTotalEloRaw: round6(rawWin[id]),
      winTotalElo: round6(centered[id]),
      blended: round6(blended),
    };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  const blendVals = ids.map((id) => doc.teams[id].blended);
  const meanBlend = blendVals.reduce((s, n) => s + n, 0) / blendVals.length;
  process.stdout.write(`wrote ${OUT}\n`);
  process.stdout.write(`games ${JSON.stringify(countBySeason)} mean blended ${meanBlend.toFixed(3)}\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { WIN_TOTALS_BY_NAME, WIN_TOTAL_SOURCE };
