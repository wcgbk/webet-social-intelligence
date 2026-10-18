'use strict';
/**
 * Stored-board reader for V1 (shared low-level source, read-only):
 * reconstructs Odds-API-shaped events from the morning line-path polls
 * stored by Omega's capture (omega-line-path/{date} in edge-picks-omega).
 * No Odds API call, no credits, no live scores — the board is the stored
 * snapshot. Poll choice: latest slot at or before 10:00 ET (the stored
 * 10 AM board); if none exists at/before 1000, the earliest stored poll.
 */
function selectBoardPollV1(polls, cutoffHHMM = '1000') {
  const rows = (Array.isArray(polls) ? polls : [])
    .filter(p => p && p.games && Object.keys(p.games).length)
    .sort((a, b) => String(a.hhmm || a.slot).localeCompare(String(b.hhmm || b.slot)));
  if (!rows.length) return null;
  const atOrBefore = rows.filter(p => String(p.hhmm || p.slot) <= cutoffHHMM);
  return atOrBefore.length ? atOrBefore[atOrBefore.length - 1] : rows[0];
}
function reconstructEventsV1(games) {
  const events = [];
  for (const g of Object.values(games || {})) {
    if (!g || !g.homeTeam || !g.awayTeam || !g.books) continue;
    const bookmakers = [];
    for (const [key, row] of Object.entries(g.books)) {
      if (!row) continue;
      const markets = [];
      if (row.mlHome != null || row.mlAway != null) {
        const outcomes = [];
        if (row.mlAway != null) outcomes.push({ name: g.awayTeam, price: row.mlAway });
        if (row.mlHome != null) outcomes.push({ name: g.homeTeam, price: row.mlHome });
        markets.push({ key: 'h2h', outcomes });
      }
      if (row.spreadHome != null || row.spreadAway != null) {
        const outcomes = [];
        if (row.spreadAway != null) outcomes.push({ name: g.awayTeam, price: row.spreadAwayOdds, point: row.spreadAway });
        if (row.spreadHome != null) outcomes.push({ name: g.homeTeam, price: row.spreadHomeOdds, point: row.spreadHome });
        markets.push({ key: 'spreads', outcomes });
      }
      if (row.total != null && (row.overOdds != null || row.underOdds != null)) {
        const outcomes = [];
        if (row.overOdds != null) outcomes.push({ name: 'Over', price: row.overOdds, point: row.total });
        if (row.underOdds != null) outcomes.push({ name: 'Under', price: row.underOdds, point: row.total });
        markets.push({ key: 'totals', outcomes });
      }
      if (markets.length) bookmakers.push({ key, markets });
    }
    events.push({
      sport: g.sport || null,
      home_team: g.homeTeam, away_team: g.awayTeam,
      commence_time: g.commenceTime || null,
      bookmakers,
      openBooks: g.openBooks || null,
    });
  }
  return events;
}
module.exports = { selectBoardPollV1, reconstructEventsV1 };
