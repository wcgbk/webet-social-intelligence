'use strict';

const { resolveTeamId } = require('./sports/team_identity');

/**
 * Last-5 margins are a shrunk feature of the pre-market rating.
 * They are not an edge add-on after the market blend.
 *
 * ASSUMPTION: prior weight K = 8. With n = min(home games, away games),
 *   w = n / (n + K)
 *   raw = (1 - w) * seasonMargin + w * (homeLast5Mean - awayLast5Mean)
 * The move from seasonMargin is then capped at ±1.5 points so a short
 * streak cannot invent a large number. Either side missing games is a no-op
 * and the season margin is returned unchanged.
 */
const LAST5_K = 8;
const LAST5_CAP = 1.5;

function shrinkLast5IntoRating(seasonMargin, homeRec, awayRec) {
  const base = Number(seasonMargin);
  const unchanged = { margin: seasonMargin, applied: false, delta: 0, w: 0, note: null };
  if (!Number.isFinite(base)) return unchanged;
  if (!homeRec || !awayRec) return unchanged;
  const hn = Number(homeRec.n);
  const an = Number(awayRec.n);
  const hm = Number(homeRec.meanMargin);
  const am = Number(awayRec.meanMargin);
  if (!(hn > 0) || !(an > 0) || !Number.isFinite(hm) || !Number.isFinite(am)) return unchanged;
  const n = Math.min(hn, an);
  const w = n / (n + LAST5_K);
  const recent = hm - am;
  const raw = (1 - w) * base + w * recent;
  let delta = raw - base;
  if (delta > LAST5_CAP) delta = LAST5_CAP;
  if (delta < -LAST5_CAP) delta = -LAST5_CAP;
  const applied = Math.abs(delta) > 1e-9;
  return {
    margin: base + delta,
    applied,
    delta,
    w,
    note: applied ? `last5 w=${w.toFixed(3)} delta=${delta.toFixed(2)}` : null,
  };
}

/** Completed rows only. commence at or after kickoffMs is excluded. */
function recordBefore(games, kickoffMs, limit) {
  const cap = limit == null ? 5 : limit;
  const prior = [];
  for (const g of games || []) {
    if (!g || g.margin == null || !Number.isFinite(Number(g.margin))) continue;
    const t = Date.parse(g.commence || g.commenceTime || '');
    if (!Number.isFinite(t)) continue;
    if (kickoffMs != null && Number.isFinite(kickoffMs) && !(t < kickoffMs)) continue;
    prior.push({ t, margin: Number(g.margin) });
  }
  prior.sort((a, b) => b.t - a.t);
  const used = prior.slice(0, cap);
  if (!used.length) return null;
  const mean = used.reduce((s, g) => s + g.margin, 0) / used.length;
  return { n: used.length, meanMargin: mean };
}

/**
 * restSchedule shape: { NFL: { games: [...] }, NCAAF: { games } }.
 * Games without a numeric margin are ignored (incomplete or unscored).
 */
function last5ByTeamFromSchedule(restSchedule) {
  const out = {};
  if (!restSchedule || typeof restSchedule !== 'object') return out;
  for (const sport of Object.keys(restSchedule)) {
    const pack = restSchedule[sport];
    const games = pack && Array.isArray(pack.games) ? pack.games : (Array.isArray(pack) ? pack : []);
    const byTeam = {};
    for (const g of games) {
      if (!g || g.teamId == null) continue;
      if (g.margin == null || !Number.isFinite(Number(g.margin))) continue;
      const id = String(g.teamId);
      if (!byTeam[id]) byTeam[id] = [];
      byTeam[id].push(g);
    }
    out[sport] = byTeam;
  }
  return out;
}

function lookupLast5(sport, teamName, last5ByTeam, commenceTime) {
  if (!last5ByTeam || !teamName || !sport) return null;
  const table = last5ByTeam[sport];
  if (!table || typeof table !== 'object') return null;
  const id = resolveTeamId(sport, teamName);
  if (id == null || id === '') return null;
  const games = table[String(id)];
  if (!Array.isArray(games) || !games.length) return null;
  const kick = commenceTime ? Date.parse(commenceTime) : NaN;
  return recordBefore(games, Number.isFinite(kick) ? kick : null, 5);
}

module.exports = {
  LAST5_K,
  LAST5_CAP,
  shrinkLast5IntoRating,
  recordBefore,
  last5ByTeamFromSchedule,
  lookupLast5,
};
