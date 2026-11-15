'use strict';

const { normCdf, clamp, americanToImplied } = require('../odds_math');
const { SPORT_SPREAD_STD, SPORT_TOTAL_STD, HFA } = require('../config');

function formatMatchup(away, home) {
  return `${away} @ ${home}`;
}

function fuzzyTeam(name, ratings) {
  if (!name || !ratings) return null;
  if (ratings[name]) return ratings[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase() === lower) return ratings[k];
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return ratings[k];
  }
  // last word (mascot) match
  const last = lower.split(' ').pop();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase().split(' ').pop() === last) return ratings[k];
  }
  return null;
}

/** League scoring per game. Used only to tell season totals from per-game rates. */
const LEAGUE_PPG = { MLB: 4.5, NFL: 22, NCAAF: 27.5, NBA: 114, NHL: 3.1, NCAAM: 73 };

function gamesPlayed(st) {
  if (!st || typeof st !== 'object') return 0;
  if (Number.isFinite(Number(st.games)) && Number(st.games) > 0) return Number(st.games);
  const w = Number(st.wins);
  const l = Number(st.losses);
  const t = Number(st.ties);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  return w + l + (Number.isFinite(t) ? t : 0);
}

/**
 * Point / run differential.
 * Pass `sport` so a season total (ESPN pointsFor) becomes per game.
 * Without a sport, the raw pf − pa is kept — callers that already stored
 * per-game rates stay on that path.
 */
function powerFromStandings(st, sport) {
  if (!st) return 0;
  const pf = Number(st.pf);
  const pa = Number(st.pa);
  if (Number.isFinite(pf) && Number.isFinite(pa) && pa !== 0) {
    const league = LEAGUE_PPG[sport];
    const g = gamesPlayed(st);
    if (league && g >= 2 && (pf > league * 1.8 || pa > league * 1.8)) {
      return (pf - pa) / g;
    }
    return pf - pa;
  }
  if (st.winPct != null && Number.isFinite(Number(st.winPct))) return (Number(st.winPct) - 0.5) * 20;
  return 0;
}

function resolveSpreadStd(sport, stdOverride) {
  if (Number.isFinite(stdOverride) && stdOverride > 0) return stdOverride;
  return SPORT_SPREAD_STD[sport] || 13.5;
}

/**
 * Spread cover approx via normal.
 * Optional 4th arg stdOverride (v12.3.7 MLB SP-known tighten).
 */
function spreadCoverProb(modelSpreadHome, marketLineHome, sport, stdOverride) {
  const std = resolveSpreadStd(sport, stdOverride);
  const z = (modelSpreadHome + marketLineHome) / std;
  return normCdf(z);
}

function totalCoverProb(modelTotal, marketTotal, side, sport) {
  const std = SPORT_TOTAL_STD[sport] || 10;
  const z = (modelTotal - marketTotal) / std;
  if (/over/i.test(side)) return normCdf(z);
  return normCdf(-z);
}

/** Optional 3rd arg stdOverride (v12.3.7 MLB SP-known tighten). */
function mlFromSpread(modelSpreadHome, sport, stdOverride) {
  const std = resolveSpreadStd(sport, stdOverride);
  return clamp(normCdf(modelSpreadHome / std), 0.05, 0.95);
}

/** Mild market-anchored lean: blend model with market implied. */
function blendWithMarket(pModel, marketImplied, wModel = 0.55) {
  if (!Number.isFinite(marketImplied)) return pModel;
  return clamp(wModel * pModel + (1 - wModel) * marketImplied, 0.05, 0.95);
}

/**
 * One bad event must not blank the rest of the sport. Engine deepen soft-fails.
 */
function espnCommenceIso(game) {
  if (!game || typeof game !== 'object') return null;
  return game.commenceTime || game.commence_time || game.date || null;
}

/** Same gap get-results-omega.js names IDENTITY_CLEAR_MARGIN_MS. */
const ESPN_ROW_CLEAR_MARGIN_MS = 75 * 60 * 1000;

function espnRows(espnGames) {
  if (!espnGames) return [];
  if (Array.isArray(espnGames)) return espnGames;
  if (Array.isArray(espnGames.games)) return espnGames.games;
  return [];
}

function oddsCommenceMs(ev) {
  const iso = ev && (ev.commence_time || ev.commenceTime);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Resolved name wins. Else the competitor id already on the row. */
function espnSideId(sport, game, side) {
  if (!game) return null;
  const { resolveTeamId } = require('./team_identity');
  const name = side === 'home'
    ? (game.homeTeam || game.home_team)
    : (game.awayTeam || game.away_team);
  const fromName = resolveTeamId(sport, name);
  if (fromName) return String(fromName);
  const raw = side === 'home'
    ? (game.homeId != null ? game.homeId : game.home_id)
    : (game.awayId != null ? game.awayId : game.away_id);
  if (raw == null || raw === '') return null;
  return String(raw);
}

function orderedIdHits(sport, ev, games) {
  if (!ev) return [];
  const { resolveTeamId } = require('./team_identity');
  const hid = resolveTeamId(sport, ev.home_team || ev.homeTeam);
  const aid = resolveTeamId(sport, ev.away_team || ev.awayTeam);
  if (!hid || !aid || String(hid) === String(aid)) return [];
  const hits = [];
  for (const g of games || []) {
    if (!g) continue;
    const gh = espnSideId(sport, g, 'home');
    const ga = espnSideId(sport, g, 'away');
    if (gh === String(hid) && ga === String(aid)) hits.push(g);
  }
  return hits;
}

/**
 * 0 hits → null. 1 hit → that row (no absolute clock cap).
 * 2+ hits → nearest commence only when it is finite, within 75 minutes
 * of the odds commence, and at least 75 minutes clearer than the next.
 */
function disambiguateEspnRows(ev, hits) {
  if (!hits || !hits.length) return null;
  if (hits.length === 1) return hits[0];
  const ct = oddsCommenceMs(ev);
  const ranked = hits.map((g) => {
    const iso = espnCommenceIso(g);
    const gt = iso ? Date.parse(iso) : NaN;
    const diff = Number.isFinite(ct) && Number.isFinite(gt) ? Math.abs(gt - ct) : Infinity;
    return { g, diff };
  }).sort((a, b) => a.diff - b.diff);
  const best = ranked[0];
  const second = ranked[1];
  if (!(Number.isFinite(best.diff) && best.diff <= ESPN_ROW_CLEAR_MARGIN_MS)) return null;
  if (!(second.diff - best.diff >= ESPN_ROW_CLEAR_MARGIN_MS)) return null;
  return best.g;
}

/**
 * Odds event → ESPN row by resolved team ids and nearest commence.
 * No same-day requirement. No last-word match.
 */
function bindEspnGameByTeamAndTime(sport, ev, espnGames) {
  return disambiguateEspnRows(ev, orderedIdHits(sport, ev, espnRows(espnGames)));
}

// MLB and NHL only. NFL/NCAAF identity is team_identity.js (exact ESPN id).
function fuzzyTeamKey(name, ratings) {
  if (!name || !ratings) return null;
  if (ratings[name]) return name;
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase() === lower) return k;
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return k;
  }
  const last = lower.split(' ').pop();
  for (const k of Object.keys(ratings)) {
    if (k.toLowerCase().split(' ').pop() === last) return k;
  }
  return null;
}

function mapGamesSoft(events, projectGame) {
  const all = [];
  for (const ev of events || []) {
    try {
      const rows = projectGame(ev);
      if (Array.isArray(rows) && rows.length) all.push(...rows);
    } catch (err) {
      const home = ev && ev.home_team;
      const away = ev && ev.away_team;
      console.error(`[omega-vnext] project soft-fail ${away || '?'} @ ${home || '?'}: ${err && err.message}`);
    }
  }
  return all;
}

module.exports = {
  formatMatchup,
  fuzzyTeam,
  gamesPlayed,
  LEAGUE_PPG,
  powerFromStandings,
  resolveSpreadStd,
  spreadCoverProb,
  totalCoverProb,
  mlFromSpread,
  blendWithMarket,
  mapGamesSoft,
  HFA,
  bindEspnGameByTeamAndTime,
  fuzzyTeamKey,
};
