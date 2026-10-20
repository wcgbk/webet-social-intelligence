'use strict';
/**
 * NBA projection. The shadow observer and the daily card share this model.
 *
 * Shadow (project without forCard): BLEND is 0, so p_fair is de-vigged
 * Pinnacle on the same line and p_model is only logged. Rows are shadowOnly.
 * The 2025-10-21..2025-12-17 tune rejected every observer weight above 0.
 * A Pinnacle number on a different point is not shifted onto this line.
 *
 * Card (forCard): modelRawP is that same model probability. The shared
 * calibrate shrink (SHRINK_K, then the isotonic band) anchors it to the
 * same-point de-vigged sharp fair. Pinnacle wins when it posts the point;
 * the other sharp books are the fallback. The price is attached as
 * bestDkHr and the card reprices to the better of DraftKings and Hard Rock.
 * No shadow flag, no observer EV cap, no separate unit cap.
 *
 * The logged margin still includes a back-to-back note. That note does
 * not move p_model or p_fair. Pace stays in the logged total. Injuries
 * are not an input. There is no pre-bet injury feed in the tape.
 *
 * Total residual is 18 inside this file. config SPORT_TOTAL_STD.NBA stays
 * 14 so the shared table is unchanged. Spread residual is SPORT_SPREAD_STD.NBA
 * (12). De-vig is the current power de-vig (noVigTwoWay).
 *
 * Team identity is the ESPN id table. Exact normalized name only.
 * "Lakers" is not the Lakers. "Los Angeles" is not a team.
 */
const { clamp, normCdf, noVigTwoWay, evAtOdds } = require('../odds_math');
const { HFA, SPORT_SPREAD_STD } = require('../config');
const {
  formatMatchup, gamesPlayed, LEAGUE_PPG, mapGamesSoft, spreadCoverProb, mlFromSpread,
} = require('./_common');
const { bestDkHrPrice, enrichCandidateWithEdge, collectLinesForEdge } = require('../edge');

const SPORT = 'NBA';
const BLEND = { ml: 0, spread: 0, total: 0 };
const NBA_TOTAL_SD = 18;
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
/** Home back-to-back, away back-to-back, absolute cap. Log only. */
const NBA_REST = { homeB2b: -1.5, awayB2b: 1.8, cap: 2.5 };

/**
 * Odds API names that are not in the ESPN lookup. Not mascot-only keys.
 * "Lakers", "Clippers", "76ers", and "Trail Blazers" stay unmapped.
 */
const EXTRA_ALIASES = {
  sixers: '20',
  'portland trailblazers': '22',
};

let priorCache = null;
let idCache = null;

function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function round4(n) {
  const v = Number(n);
  return Number.isFinite(v) ? +v.toFixed(4) : null;
}

function inPpgBand(n) {
  return n >= NBA_PPG_MIN && n <= NBA_PPG_MAX;
}

function inPaceBand(n) {
  return n >= NBA_PACE_MIN && n <= NBA_PACE_MAX;
}

function normalizeTeamName(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\u02bb\u02bc\u02b9\u02be\u02bf\u2018\u2019\u201a\u201b\u2032\u0060\u00b4']/g, '');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function idTable() {
  if (idCache) return idCache;
  idCache = require('./data/nba-team-ids.json');
  return idCache;
}

/** Exact ESPN id. Unknown names return null. No mascot or substring match. */
function resolveTeamId(name) {
  const table = idTable();
  const key = normalizeTeamName(name);
  if (!key || !table.lookup) return null;
  if (table.lookup[key]) return String(table.lookup[key]);
  if (EXTRA_ALIASES[key]) return String(EXTRA_ALIASES[key]);
  return null;
}

function sameClub(a, b) {
  if (a == null || b == null) return false;
  if (String(a) === String(b)) return true;
  const ia = resolveTeamId(a);
  const ib = resolveTeamId(b);
  return !!(ia && ib && ia === ib);
}

function logUnknownTeam(name) {
  console.warn(`[omega-nba] unknown_team name=${name}`);
}

/**
 * Seed or standings row for this club. A name with no id returns null.
 * Rows match on espnId, then on a key that resolves to the same id.
 */
function rowByIdentity(table, teamName) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const id = resolveTeamId(teamName);
  if (!id) return null;
  for (const [key, row] of Object.entries(table)) {
    if (!key || key.startsWith('_') || !row || typeof row !== 'object') continue;
    if (row.espnId != null && String(row.espnId) === id) return row;
    if (resolveTeamId(key) === id) return row;
  }
  return null;
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

/**
 * Zero-sum the netRtg column and rebuild points around each row's level.
 * Does not mutate the input. Idempotent when the column is already centered.
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

function loadPrior() {
  if (priorCache) return priorCache;
  const raw = require('./data/nba-net-rating-seed.json');
  priorCache = centerNbaSeed(raw);
  return priorCache;
}

function nbaGamesPlayed(st) {
  if (!st || typeof st !== 'object') return 0;
  const named = finite(st.gamesPlayed);
  if (named != null && named > 0) return named;
  return gamesPlayed(st);
}

function explicitPointsPerGame(st) {
  if (!st || typeof st !== 'object') return null;
  const pairs = [
    ['avgPointsFor', 'avgPointsAgainst'],
    ['avgPf', 'avgPa'],
    ['pointsPerGame', 'pointsAllowedPerGame'],
    ['pfPerGame', 'paPerGame'],
  ];
  for (const [fk, ak] of pairs) {
    if (st[fk] == null || st[ak] == null) continue;
    const pfPg = Number(st[fk]);
    const paPg = Number(st[ak]);
    if (Number.isFinite(pfPg) && Number.isFinite(paPg)) return { pfPg, paPg };
  }
  return null;
}

/**
 * Current offensive / defensive points per game.
 * Ratings win when both are in band. An explicit average is not divided.
 * A season sum is divided only when games >= 2 and the quotient is in band.
 */
function resolveTeamRates(st, leaguePpg) {
  if (!st || typeof st !== 'object') return null;
  const league = Number.isFinite(Number(leaguePpg)) ? Number(leaguePpg) : LEAGUE_PPG.NBA;
  const gp = nbaGamesPlayed(st);
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

/** Below 2 regular-season games the prior owns the row. Preseason is weight 0. */
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

function teamPlayedYesterday(name, table) {
  if (!table || typeof table !== 'object') return false;
  const id = resolveTeamId(name);
  for (const [key, row] of Object.entries(table)) {
    if (!row || row.playedYesterday !== true) continue;
    if (key === name) return true;
    if (id && resolveTeamId(key) === id) return true;
  }
  return false;
}

/** Logged margin only. p_model is computed before this adjustment. */
function restMarginAdj(home, away, gameDay) {
  const table = nbaRestTable(gameDay);
  const homeB2b = teamPlayedYesterday(home, table);
  const awayB2b = teamPlayedYesterday(away, table);
  let adj = 0;
  if (homeB2b) adj += NBA_REST.homeB2b;
  if (awayB2b) adj += NBA_REST.awayB2b;
  adj = clamp(adj, -NBA_REST.cap, NBA_REST.cap);
  return { adj, homeB2b, awayB2b };
}

function eventIsPreseason(ev, opts) {
  if (opts && opts.preseason) return true;
  if (ev && (ev.preseason === true || Number(ev.seasonType) === 1)) return true;
  return false;
}

function uncertaintyFor(source) {
  if (source === 'nba-net-prior' || source === 'nba-league-hfa') return 0.30;
  if (source === 'nba-net-ramp') return 0.22;
  return 0.18;
}

function bookAmerican(prices, book) {
  const want = String(book || '').toLowerCase();
  const row = (prices || []).find((p) => String(p.book || '').toLowerCase() === want
    && Number.isFinite(Number(p.american)));
  return row ? Number(row.american) : null;
}

function oppositeBundle(bundles, target) {
  if (!target) return null;
  if (target.point == null) {
    return (bundles || []).find((s) => s !== target && s.side !== target.side && s.point == null) || null;
  }
  return (bundles || []).find((s) => {
    if (s === target) return false;
    if (/over|under/i.test(target.side) && /over|under/i.test(s.side)) return s.point === target.point;
    return s.point === -target.point;
  }) || null;
}

/** Power de-vig of Pinnacle on this bundle's point. A different point is absent. */
function pinnacleFair(bundles, bundle) {
  const opp = oppositeBundle(bundles, bundle);
  if (!opp) return null;
  const a1 = bookAmerican(bundle.prices, 'pinnacle');
  const a2 = bookAmerican(opp.prices, 'pinnacle');
  if (a1 == null || a2 == null) return null;
  const nv = noVigTwoWay(a1, a2);
  return nv ? nv.p1 : null;
}

/**
 * w * model + (1 - w) * Pinnacle. Missing Pinnacle leaves the model.
 * The locked weight is 0, so a present sharp price is the fair price.
 */
function combineFair(pModel, pPin, w) {
  if (!Number.isFinite(pPin)) return Number.isFinite(pModel) ? pModel : null;
  if (!Number.isFinite(pModel)) return pPin;
  const weight = Number.isFinite(Number(w)) ? Number(w) : 0;
  return clamp(weight * pModel + (1 - weight) * pPin, 0.02, 0.98);
}

function totalCoverProb(modelTotal, line, side) {
  const z = (Number(modelTotal) - Number(line)) / NBA_TOTAL_SD;
  if (/over/i.test(side)) return normCdf(z);
  return normCdf(-z);
}

function collectBundles(event, marketKey) {
  const books = event.bookmakers || [];
  const bySide = new Map();
  for (const bk of books) {
    const key = String(bk.key || '').toLowerCase();
    const mkt = (bk.markets || []).find((m) => m.key === marketKey);
    if (!mkt) continue;
    for (const o of mkt.outcomes || []) {
      const point = o.point != null ? Number(o.point) : null;
      const sideName = o.name;
      const sideKey = point == null ? sideName : `${sideName}|${point}`;
      if (!bySide.has(sideKey)) bySide.set(sideKey, { side: sideName, point, prices: [] });
      bySide.get(sideKey).prices.push({ book: key, american: Number(o.price) });
    }
  }
  return [...bySide.values()];
}

function priceRow(base, bundle, bundles, modelP, blendW, fields) {
  const pModel = Number.isFinite(modelP) ? modelP : null;
  const pPin = pinnacleFair(bundles, bundle);
  const pFair = combineFair(pModel, pPin, blendW);
  const quote = bestDkHrPrice(bundle.prices);
  const price = quote && Number.isFinite(quote.american) ? quote.american : null;
  const ev = price != null && pFair != null ? evAtOdds(pFair, price) : null;
  return {
    ...base,
    ...fields,
    p_model: pModel,
    p_pinnacle: pPin,
    p_fair: pFair,
    fair_sharp_p: pPin,
    pinnacleNoVig: pPin,
    sharpAnchorBook: pPin != null ? 'pinnacle' : null,
    modelRawP: pFair,
    blendWeight: blendW,
    price,
    odds: price,
    book: quote ? quote.book : null,
    ev: ev != null ? +Number(ev).toFixed(4) : null,
    shadowObserver: true,
  };
}

/**
 * Card row. modelRawP stays the model. enrichCandidateWithEdge sets
 * fair_sharp_p from the same point (Pinnacle, then the other sharp books)
 * and bestDkHr from DraftKings / Hard Rock. calibrate shrinks afterward.
 */
function cardRow(base, bundle, bundles, modelP, fields) {
  const pModel = Number.isFinite(modelP) ? modelP : null;
  const pPin = pinnacleFair(bundles, bundle);
  return enrichCandidateWithEdge({
    ...base,
    ...fields,
    shadowOnly: false,
    shadowObserver: false,
    modelRawP: pModel,
    p_model: pModel,
    p_pinnacle: pPin,
    sharpAnchorBook: pPin != null ? 'pinnacle' : null,
  }, bundle, bundles);
}

function projectGame(event, standings, gameDay, opts) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const prior = opts.prior || loadPrior();
  const league = leagueOf(prior);
  const preseason = !!opts.preseason;
  const homeId = resolveTeamId(home);
  const awayId = resolveTeamId(away);
  const unknownNames = [];
  if (!homeId) unknownNames.push(home);
  if (!awayId) unknownNames.push(away);
  for (const name of unknownNames) logUnknownTeam(name);

  const homePrior = homeId ? priorProfile(rowByIdentity(prior, home), league) : null;
  const awayPrior = awayId ? priorProfile(rowByIdentity(prior, away), league) : null;
  const homeCur = homeId ? resolveTeamRates(rowByIdentity(standings, home), league.ppg) : null;
  const awayCur = awayId ? resolveTeamRates(rowByIdentity(standings, away), league.ppg) : null;
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
  const uncertainty = uncertaintyFor(family);
  const rest = restMarginAdj(home, away, gameDay);
  const priceBoard = clampBoard(env.modelMargin, env.modelTotal, league.ppg);
  const logBoard = clampBoard(env.modelMargin + rest.adj, env.modelTotal, league.ppg);
  const tag = (market) => {
    let m = `${family}-${market}`;
    if (rest.homeB2b || rest.awayB2b) m += '-b2b';
    return m;
  };
  const base = {
    sport: SPORT,
    homeTeam: home,
    awayTeam: away,
    matchup: formatMatchup(away, home),
    commenceTime,
    unknownTeam: unknownNames.length > 0,
    unknownNames,
    preseason,
    shadowOnly: true,
    gameDay: {
      nba: {
        season: league.season,
        preseason,
        family,
        homeSource: homeBlend ? homeBlend.source : 'league',
        awaySource: awayBlend ? awayBlend.source : 'league',
        homeWeight: homeBlend ? homeBlend.weight : 0,
        awayWeight: awayBlend ? awayBlend.weight : 0,
        expPace: +env.expPace.toFixed(2),
        spreadSd: SPORT_SPREAD_STD.NBA,
        totalSd: NBA_TOTAL_SD,
        restAdj: rest.adj,
        homeB2b: rest.homeB2b,
        awayB2b: rest.awayB2b,
        sanityClamped: priceBoard.clamped || logBoard.clamped,
      },
    },
  };
  const out = [];
  const margin = priceBoard.modelMargin;
  const total = priceBoard.modelTotal;
  const loggedMargin = logBoard.modelMargin;
  const forCard = !!(opts && opts.forCard);
  const marketBundles = (key) => (forCard ? collectLinesForEdge(event, key) : collectBundles(event, key));
  const emit = (bundle, bundles, modelP, blendW, fields) => {
    out.push(forCard
      ? cardRow(base, bundle, bundles, modelP, fields)
      : priceRow(base, bundle, bundles, modelP, blendW, fields));
  };

  {
    const bundles = marketBundles('h2h');
    for (const b of bundles) {
      const isHome = sameClub(b.side, home);
      const p = isHome ? mlFromSpread(margin, SPORT) : 1 - mlFromSpread(margin, SPORT);
      emit(b, bundles, p, BLEND.ml, {
        market: 'Moneyline',
        side: b.side,
        line: null,
        pickSide: isHome ? 'home' : 'away',
        projMethod: tag('ml'),
        uncertainty,
        modelProjection: +loggedMargin.toFixed(2),
      });
    }
  }

  {
    const bundles = marketBundles('spreads');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const isHome = sameClub(b.side, home);
      const pCover = spreadCoverProb(isHome ? margin : -margin, line, SPORT);
      const sideLabel = line > 0 ? `${b.side} +${line}` : `${b.side} ${line}`;
      emit(b, bundles, pCover, BLEND.spread, {
        market: 'Spread',
        side: sideLabel,
        line,
        pickSide: isHome ? 'home' : 'away',
        projMethod: tag('spread'),
        uncertainty,
        modelProjection: +loggedMargin.toFixed(2),
      });
    }
  }

  {
    const bundles = marketBundles('totals');
    for (const b of bundles) {
      const line = b.point;
      if (line == null) continue;
      const over = /over/i.test(b.side);
      const p = totalCoverProb(total, line, b.side);
      emit(b, bundles, p, BLEND.total, {
        market: 'Total',
        side: `${b.side} ${line}`,
        line,
        pickSide: over ? 'over' : 'under',
        projMethod: tag('total'),
        uncertainty: uncertainty + 0.05,
        modelProjection: +total.toFixed(2),
      });
    }
  }

  return out;
}

/**
 * Empty input returns []. Preseason is omitted unless allowPreseason is set.
 * The daily card does not pass allowPreseason.
 */
function project({
  oddsEvents, standings, gameDay, prior, allowPreseason, preseason, forCard,
} = {}) {
  const table = prior ? centerNbaSeed(prior) : null;
  return mapGamesSoft(oddsEvents, (ev) => {
    const isPre = eventIsPreseason(ev, { preseason });
    if (isPre && !allowPreseason) return [];
    return projectGame(ev, standings || {}, gameDay || {}, {
      prior: table || loadPrior(),
      preseason: isPre,
      forCard: !!forCard,
    });
  });
}

module.exports = {
  project,
  SPORT,
  centerNbaSeed,
  loadPrior,
  resolveTeamId,
  resolveTeamRates,
  seasonWeight,
  projectEnvironment,
  blendProfile,
  combineFair,
  pinnacleFair,
  NBA_RAMP_GAMES,
  NBA_PPG_MIN,
  NBA_PPG_MAX,
  NBA_MARGIN_CAP,
  NBA_TOTAL_MIN,
  NBA_TOTAL_MAX,
  NBA_TOTAL_SD,
  NBA_REST,
  BLEND,
  EXTRA_ALIASES,
};
