'use strict';

/**
 * Drop a candidate before top-3 selection. Both flags off returns the same row.
 * NBA: OMEGA_V2_NBA_INJURY. A game with an important player whose status is
 * still Questionable, Doubtful, Day-To-Day, or Game-Time-Decision is out.
 * Announced Out is not a veto. No report, or a soft-fail report, is a no-op.
 * NHL: OMEGA_V2_NHL_GOALIE. veto drops a game when either starter is
 * unconfirmed. shadow only stamps statusShadow. A game missing from the
 * scoreboard is not a veto. Soft-fail does not drop the slate.
 */

const { nbaInjuryEnabled, nhlGoalieMode } = require('./constants');
const { normTeamName } = require('../omega-vnext/status_pull');

function teamsOf(row) {
  let home = row && row.homeTeam;
  let away = row && row.awayTeam;
  if (!home && !away) {
    const parts = String((row && row.matchup) || '').split(/\s+@\s+/);
    if (parts.length === 2) {
      away = parts[0];
      home = parts[1];
    }
  }
  return { home: home || '', away: away || '' };
}

function uncertainOnTeam(report, teamName) {
  if (!report || !report.teams || !teamName) return [];
  const hit = report.teams[normTeamName(teamName)];
  if (!hit || !Array.isArray(hit.uncertain)) return [];
  return hit.uncertain.map((p) => ({
    team: hit.team || teamName,
    name: p.name,
    status: p.status,
    mpgRank: p.mpgRank != null ? p.mpgRank : null,
    ppgRank: p.ppgRank != null ? p.ppgRank : null,
  }));
}

function nbaHit(row, report) {
  if (String(row && row.sport || '').toUpperCase() !== 'NBA') return null;
  if (!report || report.ok === false || report.softFail === true) return null;
  const sides = teamsOf(row);
  const players = uncertainOnTeam(report, sides.away).concat(uncertainOnTeam(report, sides.home));
  if (!players.length) return null;
  return players;
}

function nhlGame(report, row) {
  if (String(row && row.sport || '').toUpperCase() !== 'NHL') return null;
  if (!report || report.ok === false || report.softFail === true) return null;
  const sides = teamsOf(row);
  const away = normTeamName(sides.away);
  const home = normTeamName(sides.home);
  if (!away || !home || away === home) return null;
  const games = Array.isArray(report.games) ? report.games : [];
  for (const game of games) {
    const gAway = game.awayKey || normTeamName(game.away);
    const gHome = game.homeKey || normTeamName(game.home);
    const sameOrder = gAway === away && gHome === home;
    const swapped = gAway === home && gHome === away;
    if (sameOrder || swapped) return game;
  }
  return null;
}

function nhlUnconfirmed(row, report) {
  const game = nhlGame(report, row);
  if (!game || game.bothConfirmed) return null;
  return {
    matchup: row.matchup || null,
    pick: row.pick || row.side || null,
    market: row.market || null,
    sport: 'NHL',
    away: game.away || null,
    home: game.home || null,
    awayGoalie: game.awayGoalie || null,
    homeGoalie: game.homeGoalie || null,
  };
}

function applyStatusVeto(row, opts) {
  if (!row) return row;
  const env = opts && opts.env;
  const nbaOn = nbaInjuryEnabled(env);
  const mode = nhlGoalieMode(env);
  if (!nbaOn && mode === 'off') return row;
  if (nbaOn) {
    const players = nbaHit(row, opts && opts.nbaInjury);
    if (players) {
      const dropped = row.qualified === true;
      return {
        ...row,
        qualified: false,
        parlayQualified: false,
        forcePlaceable: false,
        rejectReason: dropped ? 'nba-uncertain-star' : (row.rejectReason || 'nba-uncertain-star'),
        statusVeto: {
          kind: 'nba-uncertain-star',
          dropped,
          matchup: row.matchup || null,
          pick: row.pick || row.side || null,
          market: row.market || null,
          sport: 'NBA',
          players,
        },
      };
    }
  }
  if (mode === 'off') return row;
  const goalies = nhlUnconfirmed(row, opts && opts.nhlGoalies);
  if (!goalies) return row;
  if (mode === 'shadow') {
    return {
      ...row,
      statusShadow: {
        kind: 'nhl-goalie-unconfirmed',
        dropped: false,
        ...goalies,
      },
    };
  }
  const dropped = row.qualified === true;
  return {
    ...row,
    qualified: false,
    parlayQualified: false,
    forcePlaceable: false,
    rejectReason: dropped ? 'nhl-goalie-unconfirmed' : (row.rejectReason || 'nhl-goalie-unconfirmed'),
    statusVeto: {
      kind: 'nhl-goalie-unconfirmed',
      dropped,
      ...goalies,
    },
  };
}

/**
 * Non-display card field. Null when the flag is off so the card object
 * stays the same shape as today.
 */
function statusDiagnostics(annotated, opts) {
  const env = opts && opts.env;
  const nbaOn = nbaInjuryEnabled(env);
  const mode = nhlGoalieMode(env);
  if (!nbaOn && mode === 'off') return null;
  const out = {};
  if (nbaOn) {
    const report = opts && opts.nbaInjury;
    const vetoes = [];
    for (const row of annotated || []) {
      const veto = row && row.statusVeto;
      if (veto && veto.kind === 'nba-uncertain-star') vetoes.push(veto);
    }
    out.nbaInjury = {
      pulledAt: report && report.pulledAt ? report.pulledAt : null,
      source: report && report.source ? report.source : null,
      importanceSource: report && report.importanceSource ? report.importanceSource : null,
      importance: report && report.importance ? report.importance : 'top3-mpg-or-ppg',
      softFail: !report || report.ok === false || report.softFail === true,
      uncertainPlayers: report && Number.isFinite(Number(report.uncertainPlayers))
        ? Number(report.uncertainPlayers)
        : 0,
      vetoes,
    };
  }
  if (mode !== 'off') {
    const report = opts && opts.nhlGoalies;
    const vetoes = [];
    const wouldVeto = [];
    for (const row of annotated || []) {
      const veto = row && row.statusVeto;
      if (veto && veto.kind === 'nhl-goalie-unconfirmed') vetoes.push(veto);
      const shadow = row && row.statusShadow;
      if (shadow && shadow.kind === 'nhl-goalie-unconfirmed') wouldVeto.push(shadow);
    }
    out.nhlGoalie = {
      mode,
      pulledAt: report && report.pulledAt ? report.pulledAt : null,
      source: report && report.source ? report.source : null,
      softFail: !report || report.ok === false || report.softFail === true,
      gamesOnBoard: report && Number.isFinite(Number(report.gamesOnBoard))
        ? Number(report.gamesOnBoard)
        : 0,
      confirmedGames: report && Number.isFinite(Number(report.confirmedGames))
        ? Number(report.confirmedGames)
        : 0,
      vetoes,
      wouldVeto,
    };
  }
  return out;
}

module.exports = {
  applyStatusVeto,
  statusDiagnostics,
};
