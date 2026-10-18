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
const LEAGUE_PPG = { MLB: 4.5, NFL: 22, NCAAF: 27.5, NBA: 114, NHL: 3.1 };

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
};
