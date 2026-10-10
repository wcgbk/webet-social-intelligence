'use strict';

const { normCdf, clamp, americanToImplied, etCalendarDate } = require('../odds_math');
const {
  SPORT_SPREAD_STD, SPORT_TOTAL_STD, HFA, SHARP_BOOKS, POINT_SHRINK, MODEL_LINE_GAP,
  NFL_KEY_NUMBERS, ncaafGpFixEnabled, ncaafShrinkK, fbGapGuardEnabled, fbMarketGapLimits,
} = require('../config');
const { resolveTeamId } = require('./team_identity');
const { keyMassEnabled } = require('../gaps_flags');
const { spreadQuote, totalQuote, mlQuote } = require('../key_mass');

function formatMatchup(away, home) {
  return `${away} @ ${home}`;
}

function espnCommenceIso(game) {
  if (!game || typeof game !== 'object') return null;
  return game.commenceTime || game.commence_time || game.date || null;
}

/**
 * Same gap get-results-omega.js names IDENTITY_CLEAR_MARGIN_MS.
 * Not imported from that grader: the model must not depend on it.
 * Two ESPN rows for one club pair are a bind only when the nearest
 * commence is within this window AND at least this much closer than
 * the next row. A single row is returned even if the clock is far.
 */
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
 * Otherwise null. Do not fall back to a last-word or first-row guess.
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

/**
 * Odds event → ESPN game by resolved team ids and the same America/New_York
 * calendar date. Exact alias lookup only (resolveTeamId). Missing id or
 * missing date is a miss. One same-date row is returned. Two or more
 * same-date rows use disambiguateEspnRows. No fuzzy or last-word match.
 */
function matchEspnGameByIdentity(sport, ev, espnGames) {
  const games = espnRows(espnGames);
  if (!ev || !games.length) return null;
  const evDate = etCalendarDate(ev.commence_time || ev.commenceTime);
  if (!evDate) return null;
  const hits = orderedIdHits(sport, ev, games).filter((g) => {
    const gd = etCalendarDate(espnCommenceIso(g));
    return gd != null && gd === evDate;
  });
  return disambiguateEspnRows(ev, hits);
}

// MLB and NHL only. NFL/NCAAF identity is team_identity.js (exact ESPN id).
// Do not send a football name through the substring or mascot branch.
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

function fuzzyTeam(name, ratings) {
  const key = fuzzyTeamKey(name, ratings);
  return key ? ratings[key] : null;
}

/**
 * League scoring per game. NFL/NCAAF no longer use this as a divide trigger.
 * NCAAF is 26 so two league games equal SPORT_CFG.NCAAF.baseTotal (52).
 * A season close-game mean replaces both when the board has one.
 */
const LEAGUE_PPG = { MLB: 4.5, NFL: 22, NCAAF: 26, NBA: 114, NHL: 3.1 };

/**
 * A count ESPN actually sent. null and '' are unknown.
 * Number(null) is 0, so a missing loss must not go through Number().
 * 0 is real (an unbeaten team has losses 0).
 */
function knownCount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * "W-L" or "W-L-T". Accepts the string or an ESPN stat object whose
 * displayValue (or summary) is that string. Ties are 0 when the third
 * number is omitted.
 */
function parseWinLossRecord(value) {
  let text = '';
  if (typeof value === 'string') text = value.trim();
  else if (value && typeof value === 'object') {
    const dv = value.displayValue != null ? String(value.displayValue).trim() : '';
    const summary = value.summary != null ? String(value.summary).trim() : '';
    text = dv || summary;
  }
  if (!text) return null;
  const m = text.match(/^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const wins = Number(m[1]);
  const losses = Number(m[2]);
  const ties = m[3] != null ? Number(m[3]) : 0;
  if (![wins, losses, ties].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { text, wins, losses, ties, games: wins + losses + ties };
}

/** Pre-fix count. Number(null) losses become 0, so wins alone can be gp. */
function gamesPlayedLegacy(st) {
  if (!st || typeof st !== 'object') return 0;
  const explicit = Number(st.gamesPlayed);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const games = Number(st.games);
  if (Number.isFinite(games) && games > 0) return games;
  const w = Number(st.wins);
  const l = Number(st.losses);
  const t = Number(st.ties);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  return w + l + (Number.isFinite(t) ? t : 0);
}

function tagExplicitGp(st, gp, source) {
  const w = Number(st.wins);
  const l = Number(st.losses);
  if (Number.isFinite(w) && Number.isFinite(l) && l > 0 && gp === w) {
    const otlRaw = st.otLosses != null ? st.otLosses : st.otl;
    const otl = Number(otlRaw);
    const t = Number(st.ties);
    const full = w + l + (Number.isFinite(otl) ? otl : 0) + (Number.isFinite(t) ? t : 0);
    if (full !== gp) return { gp, source: 'winsOnly', known: false };
  }
  return { gp, source, known: true };
}

/**
 * Where gamesPlayed() got its number. One helper for the model and the
 * health guards.
 * gamesPlayed / games: an explicit count the model trusts.
 * wl: wins + losses + ties when both W and L were sent, including 0.
 * record: a W-L[-T] string on record, overall, or summary, same parse
 * the ratings fix uses. Read when losses was not sent as a number, so
 * ESPN "3-2" is 5 games and not the win total.
 * winsOnly: losses are missing and no record parsed, or the explicit
 * count equals wins while losses show more games. The model still
 * returns the explicit count when one is present; health treats
 * winsOnly as unknown.
 * unknown: no count.
 */
function gamesPlayedInfo(st) {
  if (!st || typeof st !== 'object') return { gp: 0, source: 'unknown', known: false };
  const explicit = knownCount(st.gamesPlayed);
  if (explicit != null && explicit > 0) return tagExplicitGp(st, explicit, 'gamesPlayed');
  const games = knownCount(st.games);
  if (games != null && games > 0) return tagExplicitGp(st, games, 'games');
  const losses = knownCount(st.losses);
  const wins = knownCount(st.wins);
  if (losses != null && wins != null) {
    const ties = knownCount(st.ties);
    return { gp: wins + losses + (ties != null ? ties : 0), source: 'wl', known: true };
  }
  const parsed = parseWinLossRecord(st.record)
    || parseWinLossRecord(st.overall)
    || parseWinLossRecord(st.summary);
  if (parsed && parsed.games > 0) return { gp: parsed.games, source: 'record', known: true };
  if (wins != null && losses == null) return { gp: 0, source: 'winsOnly', known: false };
  return { gp: 0, source: 'unknown', known: false };
}

/**
 * Games played. explicit gamesPlayed, then games, then wins+losses
 * (+ties) only when losses was actually sent, then a W-L[-T] record,
 * else 0. Wins alone are never a game count. OMEGA_NCAAF_GP_FIX=0
 * restores gamesPlayedLegacy. NFL rows that send losses or gp return
 * the same count either way.
 */
function gamesPlayed(st) {
  if (!ncaafGpFixEnabled()) return gamesPlayedLegacy(st);
  return gamesPlayedInfo(st).gp;
}

/**
 * Per-game points already stored under a name that says so.
 * Magnitude is not a signal. Both sides must be present.
 */
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

function applyNcaafShrink(raw, g) {
  if (!Number.isFinite(raw)) return 0;
  const k = ncaafShrinkK();
  if (!(k > 0) || !(g > 0)) return raw;
  return raw * (g / (g + k));
}

/**
 * NCAAF points per game versus an even team (0 = centered).
 * gp known: (pf − pa) / gp. An explicit per-game pair is used only when
 * gp >= 2, matching the NFL rule. gp unknown: 0, never the season sum.
 * OMEGA_NCAAF_SHRINK_K > 0 multiplies that rate by gp/(gp+K). Default K is 0.
 */
function ncaafPower(st) {
  if (!st) return 0;
  const g = gamesPlayed(st);
  const explicit = explicitPointsPerGame(st);
  const pf = Number(st.pf);
  const pa = Number(st.pa);
  const hasDiff = Number.isFinite(pf) && Number.isFinite(pa) && pa !== 0;
  if (g >= 2 && explicit) return applyNcaafShrink(explicit.pfPg - explicit.paPg, g);
  if (hasDiff) {
    if (g >= 1) return applyNcaafShrink((pf - pa) / g, g);
    return 0;
  }
  if (!Number.isFinite(Number(st.winPct))) return 0;
  const wp = Number(st.winPct);
  if (wp >= 0 && wp <= 1) return (wp - 0.5) * 20;
  return 0;
}

/**
 * Point / run differential.
 * NFL pointsFor/pointsAgainst are season sums: gp >= 2 divides both,
 * gp < 2 keeps the raw difference. An explicit per-game pair is not
 * divided. NCAAF with OMEGA_NCAAF_GP_FIX on uses ncaafPower (per-game,
 * 0 when games are unknown). The toggle off keeps this same NFL formula
 * for NCAAF, which is why a null loss used to publish the season sum.
 * Without a sport, the raw pf − pa is kept.
 * MLB, NHL, and NBA do not call this. Their branch still uses the 1.8×
 * league-ppg split so that latent path stays put.
 */
function powerFromStandings(st, sport) {
  if (!st) return 0;
  if (sport === 'NCAAF' && ncaafGpFixEnabled()) return ncaafPower(st);
  const pf = Number(st.pf);
  const pa = Number(st.pa);
  const hasDiff = Number.isFinite(pf) && Number.isFinite(pa) && pa !== 0;
  const football = sport === 'NFL' || sport === 'NCAAF';
  if (football) {
    const g = gamesPlayed(st);
    const explicit = explicitPointsPerGame(st);
    if (g >= 2 && explicit) return explicit.pfPg - explicit.paPg;
    if (hasDiff) return g >= 2 ? (pf - pa) / g : (pf - pa);
  } else if (hasDiff) {
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

function binMass(mean, std, k) {
  if (!(std > 0) || !Number.isFinite(mean) || !Number.isFinite(k)) return 0;
  return Math.max(0, normCdf((k + 0.5 - mean) / std) - normCdf((k - 0.5 - mean) / std));
}

function nearPoint(absLine, target) {
  return Math.abs(absLine - target) <= 1e-9;
}

/**
 * NFL 3/7 key-number cover. Same side convention as legacy
 * nflSpreadCoverProb: a favorite laying 2.5 (or 6.5) gains the key
 * number, a favorite laying 3.5 (or 7.5) gives it up, and the dog is
 * the mirror. Integer 3/7: coverProb = P(win) / (1 − P(push)).
 * Other sports and other lines are not handled here.
 */
function nflKeyNumberCover(modelMargin, line, std) {
  const normal = normCdf((modelMargin + line) / std);
  const plain = { coverProb: normal, pWin: normal, pPush: 0, normal, bump: 0 };
  if (!Number.isFinite(modelMargin) || !Number.isFinite(line) || !(std > 0)) return plain;
  const table = NFL_KEY_NUMBERS || {};
  const abs = Math.abs(line);
  let kn = null;
  let empirical = null;
  for (const key of Object.keys(table)) {
    const n = Number(key);
    if (!Number.isFinite(n)) continue;
    if (nearPoint(abs, n) || nearPoint(abs, n - 0.5) || nearPoint(abs, n + 0.5)) {
      kn = n;
      empirical = Number(table[key]);
      break;
    }
  }
  if (kn == null || !(empirical > 0)) return plain;

  const favorite = line < 0;
  if (line === 0) return plain;
  const onLow = nearPoint(abs, kn - 0.5);
  const onHigh = nearPoint(abs, kn + 0.5);
  const onInt = nearPoint(abs, kn);
  const keyMargin = favorite ? kn : -kn;
  const peak = binMass(kn, std, kn);
  const local = binMass(modelMargin, std, keyMargin);
  const excess = peak > 1e-12 ? Math.max(0, local * (empirical / peak) - local) : 0;
  const w = excess / 2;

  if (onLow || onHigh) {
    let delta = 0;
    if (onLow) delta = favorite ? w : -w;
    if (onHigh) delta = favorite ? -w : w;
    const coverProb = clamp(normal + delta, 0.001, 0.999);
    return { coverProb, pWin: coverProb, pPush: 0, normal, bump: delta };
  }

  if (!onInt) return plain;
  const insideLine = favorite ? -(kn + 0.5) : (kn - 0.5);
  const pWin = Math.max(0, normCdf((modelMargin + insideLine) / std) - w);
  const pPush = Math.min(0.5, Math.max(0, local + excess));
  let coverProb = pWin;
  if (pPush > 0 && pPush < 1) coverProb = pWin / (1 - pPush);
  coverProb = clamp(coverProb, 0.001, 0.999);
  return { coverProb, pWin, pPush, normal, bump: coverProb - normal };
}

/**
 * Spread cover. NFL/NCAAF use the keyed margin PMF when OMEGA_KEY_MASS is on.
 * OFF keeps the 2e0a803 path: NFL 3/7 via nflKeyNumberCover, everything else
 * a normal CDF. Optional 4th arg stdOverride (v12.3.7 MLB SP-known tighten).
 */
function spreadDetail(modelSpreadHome, marketLineHome, sport, stdOverride) {
  const std = resolveSpreadStd(sport, stdOverride);
  if ((sport === 'NFL' || sport === 'NCAAF') && keyMassEnabled()
      && Number.isFinite(modelSpreadHome) && Number.isFinite(marketLineHome)) {
    const q = spreadQuote(modelSpreadHome, marketLineHome, sport, std);
    if (q) return q;
  }
  if (sport === 'NFL' && Number.isFinite(modelSpreadHome) && Number.isFinite(marketLineHome)) {
    return nflKeyNumberCover(modelSpreadHome, marketLineHome, std);
  }
  const z = (modelSpreadHome + marketLineHome) / std;
  const p = normCdf(z);
  return { coverProb: p, pWin: p, pPush: 0, pLoss: Math.max(0, 1 - p) };
}

function spreadCoverProb(modelSpreadHome, marketLineHome, sport, stdOverride) {
  return spreadDetail(modelSpreadHome, marketLineHome, sport, stdOverride).coverProb;
}

function totalDetail(modelTotal, marketTotal, side, sport) {
  const std = SPORT_TOTAL_STD[sport] || 10;
  if (sport === 'NFL' && keyMassEnabled()
      && Number.isFinite(modelTotal) && Number.isFinite(marketTotal)) {
    const q = totalQuote(modelTotal, marketTotal, side, sport, std);
    if (q) return q;
  }
  const z = (modelTotal - marketTotal) / std;
  const p = /over/i.test(side) ? normCdf(z) : normCdf(-z);
  return { coverProb: p, pWin: p, pPush: 0, pLoss: Math.max(0, 1 - p) };
}

function totalCoverProb(modelTotal, marketTotal, side, sport) {
  return totalDetail(modelTotal, marketTotal, side, sport).coverProb;
}

/**
 * Moneyline from the home margin. The 0.05–0.95 clamp is the legacy bound.
 * NFL ties push when the keyed PMF is on. NCAAF splits the tie.
 * Optional 3rd arg stdOverride (v12.3.7 MLB SP-known tighten).
 */
function mlDetail(modelSpreadHome, sport, stdOverride) {
  const std = resolveSpreadStd(sport, stdOverride);
  if ((sport === 'NFL' || sport === 'NCAAF') && keyMassEnabled() && Number.isFinite(modelSpreadHome)) {
    const q = mlQuote(modelSpreadHome, sport, std);
    if (q) return { ...q, coverProb: clamp(q.coverProb, 0.05, 0.95) };
  }
  const p = clamp(normCdf(modelSpreadHome / std), 0.05, 0.95);
  return { coverProb: p, pWin: p, pPush: 0, pLoss: Math.max(0, 1 - p) };
}

function mlFromSpread(modelSpreadHome, sport, stdOverride) {
  return mlDetail(modelSpreadHome, sport, stdOverride).coverProb;
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

/** λ in [0, 1]. Missing → 1 (no pull). Above 1 would move past the raw model. */
function clampLambda(lambda) {
  const n = Number(lambda);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

/**
 * projected = line + λ·(model − line). λ = 1 leaves the model. λ = 0 is the line.
 */
function shrinkTowardMarketLine(model, line, lambda) {
  if (!Number.isFinite(model)) return model;
  if (!Number.isFinite(line)) return model;
  const lam = clampLambda(lambda);
  return line + lam * (model - line);
}

function medianPoint(nums) {
  const a = (nums || []).filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}

function bookPoint(event, book, kind) {
  const want = String(book || '').toLowerCase();
  const bk = (event && event.bookmakers || []).find(b => String(b.key || '').toLowerCase() === want);
  if (!bk) return null;
  if (kind === 'total') {
    const mkt = (bk.markets || []).find(m => m.key === 'totals');
    if (!mkt) return null;
    const over = (mkt.outcomes || []).find(o => /^over$/i.test(o.name) && o.point != null);
    if (over) return Number(over.point);
    const any = (mkt.outcomes || []).find(o => o.point != null);
    return any ? Number(any.point) : null;
  }
  const mkt = (bk.markets || []).find(m => m.key === 'spreads');
  if (!mkt) return null;
  const home = event.home_team;
  const row = (mkt.outcomes || []).find(o => o.name === home && o.point != null);
  return row ? Number(row.point) : null;
}

/**
 * Market total or home spread. Pinnacle, else Circa, else the median of
 * the other sharp books, else the median of every book that posts the number.
 */
function sharpMarketLine(event, kind) {
  if (!event) return null;
  for (const book of ['pinnacle', 'circa', 'circasports']) {
    const p = bookPoint(event, book, kind);
    if (Number.isFinite(p)) return p;
  }
  const sharpSet = new Set((SHARP_BOOKS || []).map(b => String(b).toLowerCase()));
  const sharp = [];
  const all = [];
  const seen = new Set();
  for (const bk of event.bookmakers || []) {
    const key = String(bk.key || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const p = bookPoint(event, key, kind);
    if (!Number.isFinite(p)) continue;
    all.push(p);
    if (sharpSet.has(key)) sharp.push(p);
  }
  const medSharp = medianPoint(sharp);
  if (Number.isFinite(medSharp)) return medSharp;
  return medianPoint(all);
}

/**
 * One shrink per game. Totals move toward the sharp total. Margins move
 * toward −homeSpread (the market-implied home margin). The returned
 * shrunk numbers are what the CDF sees. Stored audit fields are these
 * same rounded points.
 */
function footballPointState(sport, modelTotal, modelMargin, marketTotal, marketSpreadHome) {
  const spec = (POINT_SHRINK && POINT_SHRINK[sport]) || {};
  const totalRaw = round4(modelTotal);
  const marginRaw = round4(modelMargin);
  const totalLine = Number.isFinite(marketTotal) ? round4(marketTotal) : null;
  const spreadHome = Number.isFinite(marketSpreadHome) ? round4(marketSpreadHome) : null;
  const marketMargin = spreadHome == null ? null : round4(-spreadHome);
  const totalShrunk = totalLine == null || totalRaw == null
    ? totalRaw
    : round4(shrinkTowardMarketLine(totalRaw, totalLine, spec.total));
  const marginShrunk = marketMargin == null || marginRaw == null
    ? marginRaw
    : round4(shrinkTowardMarketLine(marginRaw, marketMargin, spec.margin));
  return {
    sport,
    modelTotalRaw: totalRaw,
    modelMarginRaw: marginRaw,
    modelTotalShrunk: totalShrunk,
    modelMarginShrunk: marginShrunk,
    marketTotal: totalLine,
    marketSpreadHome: spreadHome,
    marketMargin,
  };
}

const FOOTBALL_AUDIT_KEYS = [
  'modelTotalRaw', 'modelMarginRaw', 'modelTotalShrunk', 'modelMarginShrunk',
  'marketLine', 'modelLineGap', 'gapFlag',
];

/**
 * Reject reason when a football candidate's model and the sharp line
 * disagree past FB_MARKET_GAP. Totals use the total cap. Spreads and
 * moneylines use the margin cap. Missing market numbers do not reject.
 * OMEGA_FB_GAP_GUARD=0 restores the old "flag only" path.
 */
function footballMarketGapReason(c) {
  if (!fbGapGuardEnabled()) return null;
  if (!c || (c.sport !== 'NFL' && c.sport !== 'NCAAF')) return null;
  const lim = fbMarketGapLimits(c.sport);
  if (!lim) return null;
  const isTotal = /total/i.test(String(c.market || ''));
  let gap = null;
  if (isTotal) {
    if (c.modelTotalRaw != null && c.marketTotal != null
      && Number.isFinite(Number(c.modelTotalRaw)) && Number.isFinite(Number(c.marketTotal))) {
      gap = Math.abs(Number(c.modelTotalRaw) - Number(c.marketTotal));
    } else if (c.modelLineGap != null && Number.isFinite(Number(c.modelLineGap))) {
      gap = Math.abs(Number(c.modelLineGap));
    }
    if (gap != null && gap > lim.total + 1e-9) return 'model_market_gap';
    return null;
  }
  if (c.modelMarginRaw != null && c.marketMargin != null
    && Number.isFinite(Number(c.modelMarginRaw)) && Number.isFinite(Number(c.marketMargin))) {
    gap = Math.abs(Number(c.modelMarginRaw) - Number(c.marketMargin));
  } else if (c.modelLineGap != null && Number.isFinite(Number(c.modelLineGap))) {
    gap = Math.abs(Number(c.modelLineGap));
  }
  if (gap != null && gap > lim.margin + 1e-9) return 'model_market_gap';
  return null;
}

function footballAudit(state, market) {
  const label = String(market || '');
  const isTotal = /total/i.test(label);
  const isMl = /moneyline|^ml$/i.test(label);
  const gap = isTotal
    ? (state.marketTotal == null || state.modelTotalRaw == null ? null : round4(state.modelTotalRaw - state.marketTotal))
    : (state.marketMargin == null || state.modelMarginRaw == null ? null : round4(state.modelMarginRaw - state.marketMargin));
  const line = isTotal ? state.marketTotal : state.marketSpreadHome;
  const thresh = MODEL_LINE_GAP && MODEL_LINE_GAP[state.sport];
  const gapFlag = !isMl && gap != null && Number.isFinite(thresh) && Math.abs(gap) >= thresh - 1e-9;
  return {
    modelTotalRaw: state.modelTotalRaw,
    modelMarginRaw: state.modelMarginRaw,
    modelTotalShrunk: state.modelTotalShrunk,
    modelMarginShrunk: state.modelMarginShrunk,
    marketLine: line == null ? null : line,
    modelLineGap: gap,
    gapFlag,
  };
}

/** Copy private football audit fields onto a pick, candidate-table row, or rejection. */
function footballAuditFields(c) {
  if (!c || (c.sport !== 'NFL' && c.sport !== 'NCAAF')) return {};
  const out = {};
  for (const k of FOOTBALL_AUDIT_KEYS) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  return out;
}

/**
 * Blend the shrunk projection and the raw projection at the same weight.
 * Keep the lower probability. shrinkTowardSharp and isotonicClip are
 * increasing in this number, so the edge cannot exceed the pre-shrink
 * edge. The side the model likes is the shrunk probability; the other
 * side stays on the raw probability instead of gaining edge.
 */
function pricedFromPointShrink(probAt, projRaw, projShrunk, line, anchor, weight) {
  const pRaw = blendWithMarket(probAt(projRaw, line), anchor, weight);
  const pShrunk = blendWithMarket(probAt(projShrunk, line), anchor, weight);
  if (!Number.isFinite(pRaw)) return pShrunk;
  if (!Number.isFinite(pShrunk)) return pRaw;
  return pShrunk < pRaw ? pShrunk : pRaw;
}

/**
 * Push mass from the same raw-vs-shrunk choice pricedFromPointShrink made.
 * Strict less-than keeps the raw detail on a tie, matching that function.
 */
function footballPushMass(detailAt, projRaw, projShrunk, line, anchor, weight) {
  if (typeof detailAt !== 'function') return 0;
  const dRaw = detailAt(projRaw, line);
  const dShr = detailAt(projShrunk, line);
  const pRaw = blendWithMarket(dRaw && dRaw.coverProb, anchor, weight);
  const pShr = blendWithMarket(dShr && dShr.coverProb, anchor, weight);
  let useShrunk = false;
  if (!Number.isFinite(pRaw)) useShrunk = true;
  else if (!Number.isFinite(pShr)) useShrunk = false;
  else useShrunk = pShr < pRaw;
  const d = useShrunk ? dShr : dRaw;
  const mass = d && Number(d.pPush);
  return Number.isFinite(mass) && mass > 0 ? mass : 0;
}

/** Priced cover plus the push on that same projection. pPush is 0 under 0.001. */
function pricedFootball(detailAt, projRaw, projShrunk, line, anchor, weight) {
  const p = pricedFromPointShrink(
    (proj, ln) => {
      const d = detailAt(proj, ln);
      return d && d.coverProb;
    },
    projRaw,
    projShrunk,
    line,
    anchor,
    weight,
  );
  const mass = footballPushMass(detailAt, projRaw, projShrunk, line, anchor, weight);
  return { p, pPush: mass >= 0.001 ? mass : 0 };
}

module.exports = {
  formatMatchup,
  espnSideId,
  ESPN_ROW_CLEAR_MARGIN_MS,
  bindEspnGameByTeamAndTime,
  disambiguateEspnRows,
  matchEspnGameByIdentity,
  fuzzyTeam,
  fuzzyTeamKey,
  knownCount,
  parseWinLossRecord,
  gamesPlayed,
  gamesPlayedInfo,
  explicitPointsPerGame,
  LEAGUE_PPG,
  powerFromStandings,
  footballMarketGapReason,
  resolveSpreadStd,
  nflKeyNumberCover,
  spreadDetail,
  spreadCoverProb,
  totalDetail,
  totalCoverProb,
  mlDetail,
  mlFromSpread,
  footballPushMass,
  pricedFootball,
  blendWithMarket,
  mapGamesSoft,
  HFA,
  clampLambda,
  shrinkTowardMarketLine,
  sharpMarketLine,
  footballPointState,
  footballAudit,
  footballAuditFields,
  FOOTBALL_AUDIT_KEYS,
  pricedFromPointShrink,
};
