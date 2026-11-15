'use strict';

/**
 * Drop a candidate before top-3 selection. Flag off returns the same row.
 * NBA: OMEGA_V2_NBA_INJURY. A game with an important player whose status is
 * still Questionable, Doubtful, Day-To-Day, or Game-Time-Decision is out.
 * Announced Out is not a veto. No report, or a soft-fail report, is a no-op.
 */

const { nbaInjuryEnabled } = require('./constants');
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

function applyStatusVeto(row, opts) {
  if (!row || !nbaInjuryEnabled(opts && opts.env)) return row;
  const players = nbaHit(row, opts && opts.nbaInjury);
  if (!players) return row;
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

/**
 * Non-display card field. Null when the flag is off so the card object
 * stays the same shape as today.
 */
function statusDiagnostics(annotated, opts) {
  if (!nbaInjuryEnabled(opts && opts.env)) return null;
  const report = opts && opts.nbaInjury;
  const vetoes = [];
  for (const row of annotated || []) {
    const veto = row && row.statusVeto;
    if (veto && veto.kind === 'nba-uncertain-star') vetoes.push(veto);
  }
  return {
    nbaInjury: {
      pulledAt: report && report.pulledAt ? report.pulledAt : null,
      source: report && report.source ? report.source : null,
      importanceSource: report && report.importanceSource ? report.importanceSource : null,
      importance: report && report.importance ? report.importance : 'top3-mpg-or-ppg',
      softFail: !report || report.ok === false || report.softFail === true,
      uncertainPlayers: report && Number.isFinite(Number(report.uncertainPlayers))
        ? Number(report.uncertainPlayers)
        : 0,
      vetoes,
    },
  };
}

module.exports = {
  applyStatusVeto,
  statusDiagnostics,
};
