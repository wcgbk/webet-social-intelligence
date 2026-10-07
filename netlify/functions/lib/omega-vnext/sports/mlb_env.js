'use strict';

/**
 * MLB starter quality + park factor.
 * Quality is runs per 9 better than league (positive = better pitcher).
 * Missing SP/park leaves the Pythag margin and total unchanged.
 */

const { clamp } = require('../odds_math');
const { ENGINE_SOFT, SPORT_SPREAD_STD, HFA, SHARP_BOOKS } = require('../config');
const { rowByIdentityOrFuzzy } = require('./team_identity');

function mlbTableRow(table, teamName, fallbackSeen) {
  return rowByIdentityOrFuzzy('MLB', table, teamName, { fallbackSeen });
}

const LEAGUE_FIP = 4.15;
const FIP_C = 3.10;
const LG_HR_FB = 0.115;
const MIN_IP = { player: 12, team: 200 };
/** Team ERA/FIP is already inside Pythag. Use only a fraction when the named SP has no line. */
const TEAM_PRIOR_WEIGHT = 0.45;
const SP_MARGIN_PER_RUN = 0.55;
const SP_TOTAL_PER_RUN = 0.45;
const PARK_MIN = 0.75;
const PARK_MAX = 1.40;
/** Existing run-environment band. Engine deepen must not leave it. */
const MLB_TOTAL_MIN = 5.5;
const MLB_TOTAL_MAX = 14.5;

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Baseball IP strings: "142.1" = 142 + 1 out. */
function parseIp(ip) {
  if (ip == null || ip === '') return null;
  const s = String(ip).trim();
  const m = s.match(/^(\d+)\.(\d)$/);
  if (m) {
    const outs = Number(m[2]);
    if (outs <= 2) return Number(m[1]) + outs / 3;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseEra(era) {
  if (era == null) return null;
  const s = String(era).trim();
  if (!s || s.includes('-')) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fipFromCounting(stat) {
  if (!stat) return null;
  const hr = num(stat.homeRuns);
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  const ip = parseIp(stat.inningsPitched);
  if ([hr, bb, k, ip].some(v => v == null) || ip <= 0) return null;
  const hbpN = hbp == null ? 0 : hbp;
  return (13 * hr + 3 * (bb + hbpN) - 2 * k) / ip + FIP_C;
}

function xfipFromCounting(stat) {
  if (!stat) return null;
  const hr = num(stat.homeRuns);
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  const air = num(stat.airOuts);
  const ip = parseIp(stat.inningsPitched);
  if ([hr, bb, k, air, ip].some(v => v == null) || ip <= 0) return null;
  const hbpN = hbp == null ? 0 : hbp;
  const fb = air + hr;
  if (fb <= 0) return null;
  const expectedHr = fb * LG_HR_FB;
  return (13 * expectedHr + 3 * (bb + hbpN) - 2 * k) / ip + FIP_C;
}

/** xFIP, else FIP, lightly blended with ERA when both exist. */
function pitcherRate(stat) {
  if (!stat) return null;
  const xfip = xfipFromCounting(stat);
  const fip = fipFromCounting(stat);
  const era = parseEra(stat.era);
  const primary = xfip != null ? xfip : fip;
  if (primary != null && era != null) return 0.8 * primary + 0.2 * era;
  if (primary != null) return primary;
  return era;
}

function emptyPitcherIndex() {
  return { byId: {}, byName: {}, byTeam: {} };
}

function recordFromSplit(split, source) {
  const stat = split && split.stat;
  if (!stat) return null;
  const ip = parseIp(stat.inningsPitched);
  const minIp = MIN_IP[source] != null ? MIN_IP[source] : MIN_IP.player;
  if (ip == null || ip < minIp) return null;
  const rate = pitcherRate(stat);
  if (!Number.isFinite(rate)) return null;
  const player = split.player || {};
  const name = player.fullName || split.name || (split.team && split.team.name) || null;
  const id = player.id != null ? String(player.id) : null;
  return {
    id,
    name,
    nameKey: normName(name),
    ip,
    era: parseEra(stat.era),
    fip: fipFromCounting(stat),
    xfip: xfipFromCounting(stat),
    quality: clamp(LEAGUE_FIP - rate, -2.5, 2.5),
    source,
  };
}

function preferRicher(prev, next) {
  if (!prev) return next;
  return (next.ip || 0) >= (prev.ip || 0) ? next : prev;
}

function buildPitcherIndex(playerPayload, teamPayload) {
  const idx = emptyPitcherIndex();
  const playerSplits = (((playerPayload || {}).stats || [])[0] || {}).splits || [];
  for (const split of playerSplits) {
    const rec = recordFromSplit(split, 'player');
    if (!rec) continue;
    if (rec.id) idx.byId[rec.id] = preferRicher(idx.byId[rec.id], rec);
    if (rec.nameKey) idx.byName[rec.nameKey] = preferRicher(idx.byName[rec.nameKey], rec);
  }
  const teamSplits = (((teamPayload || {}).stats || [])[0] || {}).splits || [];
  for (const split of teamSplits) {
    const teamName = split.team && split.team.name;
    if (!teamName) continue;
    const rec = recordFromSplit(split, 'team');
    if (!rec) continue;
    idx.byTeam[teamName] = rec;
  }
  return idx;
}

function coerceQualityRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (Number.isFinite(Number(row.quality))) {
    return {
      id: row.id != null ? String(row.id) : null,
      name: row.name || null,
      quality: clamp(Number(row.quality), -2.5, 2.5),
      source: row.source || 'player',
    };
  }
  return null;
}

/**
 * Individual FIP/xFIP/ERA when the probable matches.
 * If the starter is named but has no line, a discounted team rate is the prior.
 * No named probable → null (do not double-count team pitching already in Pythag).
 */
function resolveSpQuality(probable, stats, teamName, fallbackSeen) {
  const bag = stats && typeof stats === 'object' ? stats : {};
  const byId = bag.byId || {};
  const byName = bag.byName || {};
  if (probable && probable.id != null && byId[String(probable.id)]) {
    const row = coerceQualityRow(byId[String(probable.id)]);
    if (row) return { ...row, source: row.source === 'team' ? 'team' : 'player' };
  }
  const nameKey = normName(probable && probable.name);
  if (nameKey && byName[nameKey]) {
    const row = coerceQualityRow(byName[nameKey]);
    if (row) return { ...row, source: 'player', name: row.name || probable.name };
  }
  if (!probable || !probable.name) return null;
  const teamRow = coerceQualityRow(mlbTableRow(bag.byTeam || {}, teamName, fallbackSeen));
  if (!teamRow) return null;
  return {
    ...teamRow,
    quality: clamp(teamRow.quality * TEAM_PRIOR_WEIGHT, -2.5, 2.5),
    source: 'team',
    name: probable.name,
  };
}

function factorOf(row) {
  if (row == null) return null;
  if (typeof row === 'number') return Number.isFinite(row) ? row : null;
  if (typeof row === 'string') {
    const n = Number(row);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof row !== 'object') return null;
  const raw = row.park != null ? row.park : row.factor;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function splitParkTable(parkFactors) {
  const nameTable = {};
  const abbrTable = {};
  const src = parkFactors && typeof parkFactors === 'object' ? parkFactors : {};
  for (const [k, v] of Object.entries(src)) {
    if (!k || k.startsWith('_')) continue;
    const factor = factorOf(v);
    if (!Number.isFinite(factor) || factor < PARK_MIN || factor > PARK_MAX) continue;
    const row = {
      factor,
      venue: v && typeof v === 'object' ? (v.venue || null) : null,
      abbr: v && typeof v === 'object' && v.abbr ? String(v.abbr).toUpperCase() : null,
      team: v && typeof v === 'object' && v.team ? v.team : k,
    };
    const upper = k.toUpperCase();
    if (k.length <= 4 && k === upper) abbrTable[upper] = row;
    else nameTable[k] = row;
    if (row.abbr) abbrTable[row.abbr] = row;
    if (v && typeof v === 'object' && v.team) nameTable[v.team] = row;
  }
  return { nameTable, abbrTable };
}

function resolvePark(homeTeam, parkFactors, espnGame, fallbackSeen) {
  const { nameTable, abbrTable } = splitParkTable(parkFactors);
  let row = mlbTableRow(nameTable, homeTeam, fallbackSeen);
  if (!row && espnGame && espnGame.homeAbbr) {
    row = abbrTable[String(espnGame.homeAbbr).toUpperCase()] || null;
  }
  if (!row && homeTeam && String(homeTeam).length <= 4) {
    row = abbrTable[String(homeTeam).toUpperCase()] || null;
  }
  return row || null;
}

/** One multiplier per park row. Name and abbr keys share a row and count once. */
function parkFactorValues(parkFactors) {
  const { nameTable, abbrTable } = splitParkTable(parkFactors);
  const seen = new Set();
  const out = [];
  const rows = Object.values(nameTable).concat(Object.values(abbrTable));
  for (const row of rows) {
    if (!row || seen.has(row)) continue;
    seen.add(row);
    if (Number.isFinite(row.factor)) out.push(row.factor);
  }
  return out;
}

/**
 * Home-park exposure for a club's season rates.
 * About half the games are at pfOwn and half on the road, so
 * teamParkAdj = (pfOwn + pfRoad) / 2.
 * pfRoad is the mean of the other parks in the table, (sum − pfOwn) / (n − 1).
 * A single-row table has no road sample, so pfRoad is 1.
 * Missing or non-positive own park → 1 (rates unchanged).
 */
function teamParkAdj(pfOwn, parkFactors) {
  const own = Number(pfOwn);
  if (!Number.isFinite(own) || own <= 0) return 1;
  const factors = parkFactorValues(parkFactors);
  let pfRoad = 1;
  let ownIndex = -1;
  for (let i = 0; i < factors.length; i++) {
    if (Math.abs(factors[i] - own) < 1e-9) { ownIndex = i; break; }
  }
  if (ownIndex >= 0 && factors.length >= 2) {
    let sumOthers = 0;
    for (let i = 0; i < factors.length; i++) {
      if (i === ownIndex) continue;
      sumOthers += factors[i];
    }
    const road = sumOthers / (factors.length - 1);
    if (Number.isFinite(road)) pfRoad = road;
  }
  const adj = (own + pfRoad) / 2;
  if (!Number.isFinite(adj) || adj <= 0) return 1;
  return adj;
}

/**
 * Club's own home park, not today's venue. Missing row → 1.
 * espn home abbr is intentionally not consulted: it is the venue, and
 * would stick the visitor with the host's park.
 */
function clubParkAdj(teamName, parkFactors, fallbackSeen) {
  if (!teamName || !parkFactors) return 1;
  const row = resolvePark(teamName, parkFactors, null, fallbackSeen);
  if (!row || !Number.isFinite(row.factor) || row.factor <= 0) return 1;
  return teamParkAdj(row.factor, parkFactors);
}

/**
 * Better SP (positive quality) adds margin for that side and lowers the total.
 * Park factor multiplies the run environment once (Coors > 1).
 * The total passed in is already park-neutral. This is the only venue multiply.
 * Margin is not scaled by the venue.
 */
function applySpPark({ modelMargin, modelTotal, homeQ, awayQ, parkFactor }) {
  let margin = Number(modelMargin);
  let total = Number(modelTotal);
  if (!Number.isFinite(margin)) margin = 0;
  if (!Number.isFinite(total)) total = 8.6;
  const hq = homeQ && Number.isFinite(homeQ.quality) ? homeQ.quality : null;
  const aq = awayQ && Number.isFinite(awayQ.quality) ? awayQ.quality : null;
  const usedSp = hq != null || aq != null;
  if (usedSp) {
    const h = hq == null ? 0 : hq;
    const a = aq == null ? 0 : aq;
    margin += (h - a) * SP_MARGIN_PER_RUN;
    total += -(h + a) * SP_TOTAL_PER_RUN;
  }
  const usedPark = Number.isFinite(parkFactor);
  if (usedPark) total *= parkFactor;
  total = clamp(total, MLB_TOTAL_MIN, MLB_TOTAL_MAX);
  return { modelMargin: margin, modelTotal: total, usedSp, usedPark };
}


/**
 * Bullpen residual ≈ team pitching quality − named SP quality.
 * Only when SP is player-source (named line) and team rate exists.
 * Soft-fail → null.
 */
function resolveBullpenQuality(spQ, teamName, stats, fallbackSeen) {
  if (!spQ || spQ.source !== 'player' || !Number.isFinite(spQ.quality)) return null;
  const bag = stats && typeof stats === 'object' ? stats : {};
  const teamRow = coerceQualityRow(mlbTableRow(bag.byTeam || {}, teamName, fallbackSeen));
  if (!teamRow || !Number.isFinite(teamRow.quality)) return null;
  return {
    quality: clamp(teamRow.quality - spQ.quality, -1.5, 1.5),
    source: 'bullpen',
    teamQuality: teamRow.quality,
    spQuality: spQ.quality,
  };
}

/**
 * Apply capped bullpen residual to margin/total.
 * Caps are HARD on the bullpen-only contribution (ENGINE_SOFT.MLB).
 */
function applyBullpenAdj({ modelMargin, modelTotal, homeBullpen, awayBullpen, caps } = {}) {
  const cfg = caps || (ENGINE_SOFT && ENGINE_SOFT.MLB) || {};
  const maxM = Number.isFinite(Number(cfg.maxAbsMarginAdj)) ? Math.abs(Number(cfg.maxAbsMarginAdj)) : 0.35;
  const maxT = Number.isFinite(Number(cfg.maxAbsTotalAdj)) ? Math.abs(Number(cfg.maxAbsTotalAdj)) : 0.40;
  const w = Number.isFinite(Number(cfg.bullpenWeight)) ? Number(cfg.bullpenWeight) : 0.35;
  let margin = Number(modelMargin);
  let total = Number(modelTotal);
  if (!Number.isFinite(margin)) margin = 0;
  if (!Number.isFinite(total)) total = 8.6;
  const hq = homeBullpen && Number.isFinite(homeBullpen.quality) ? homeBullpen.quality : null;
  const aq = awayBullpen && Number.isFinite(awayBullpen.quality) ? awayBullpen.quality : null;
  if (hq == null && aq == null) {
    return {
      modelMargin: margin,
      modelTotal: total,
      usedBullpen: false,
      marginAdj: 0,
      totalAdj: 0,
      capped: false,
    };
  }
  // Missing side is 0 (league-average residual), same as the SP margin path.
  const h = hq == null ? 0 : hq;
  const a = aq == null ? 0 : aq;
  let marginAdj = (h - a) * w * SP_MARGIN_PER_RUN;
  let totalAdj = -(h + a) * w * SP_TOTAL_PER_RUN * 0.5;
  const rawM = marginAdj;
  const rawT = totalAdj;
  marginAdj = clamp(marginAdj, -maxM, maxM);
  totalAdj = clamp(totalAdj, -maxT, maxT);
  const nextTotal = clamp(total + totalAdj, MLB_TOTAL_MIN, MLB_TOTAL_MAX);
  const appliedTotalAdj = nextTotal - total;
  const bandCapped = Math.abs(appliedTotalAdj - totalAdj) > 1e-12;
  const used = Math.abs(marginAdj) > 1e-9 || Math.abs(appliedTotalAdj) > 1e-9;
  return {
    modelMargin: margin + marginAdj,
    modelTotal: nextTotal,
    usedBullpen: used,
    marginAdj,
    totalAdj: appliedTotalAdj,
    capped: Math.abs(rawM) > maxM + 1e-12 || Math.abs(rawT) > maxT + 1e-12 || bandCapped,
  };
}

/**
 * Spread/ML std when both SPs have player-source quality.
 * Soft-fail → null (caller keeps SPORT_SPREAD_STD.MLB). Totals std is unchanged.
 * Tighten of 0 is a real "no shrink", not a missing config.
 * Hard ceiling is 10% even if the config is set higher.
 */
function mlbSpKnownStd(homeQ, awayQ, caps) {
  const cfg = caps || (ENGINE_SOFT && ENGINE_SOFT.MLB) || {};
  const bothPlayer = !!(
    homeQ && homeQ.source === 'player' && Number.isFinite(homeQ.quality)
    && awayQ && awayQ.source === 'player' && Number.isFinite(awayQ.quality)
  );
  if (!bothPlayer) return null;
  const requested = finiteOr(cfg.spKnownStdTighten, 0.08);
  const maxTighten = finiteOr(cfg.maxStdTighten, 0.10);
  const tighten = clamp(Math.min(requested, maxTighten), 0, 0.10);
  if (tighten <= 1e-12) return null;
  const base = Number(SPORT_SPREAD_STD && SPORT_SPREAD_STD.MLB);
  if (!Number.isFinite(base) || base <= 0) return null;
  return base * (1 - tighten);
}

const MLB_RPG_FLOOR = 2;
const MLB_RPG_CAP = 8;
/** Above any real per-game rate. ESPN pointsFor above this is a season total. */
const MLB_SEASON_TOTAL_MIN = 8.1;
const MLB_MIN_GAMES_FOR_SEASON = 8;

function standingsGames(st) {
  if (!st || typeof st !== 'object') return 0;
  if (Number.isFinite(Number(st.games)) && Number(st.games) > 0) return Number(st.games);
  const w = Number(st.wins);
  const l = Number(st.losses);
  const t = Number(st.ties);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  return w + l + (Number.isFinite(t) ? t : 0);
}

/**
 * Runs scored / allowed per game.
 * Season totals (pf 700) require a game count. Per-game rates (pf 4.6) pass through.
 * These rates still include the club's own home park (about half its games).
 * Unclean rows return null so the caller keeps the 8.6 / HFA baseline.
 */
function teamRpg(st) {
  if (!st || typeof st !== 'object') return null;
  const pf = Number(st.pf);
  const pa = Number(st.pa);
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || pf <= 0 || pa <= 0) return null;
  let rs = pf;
  let ra = pa;
  if (pf > MLB_SEASON_TOTAL_MIN || pa > MLB_SEASON_TOTAL_MIN) {
    const g = standingsGames(st);
    if (g < MLB_MIN_GAMES_FOR_SEASON) return null;
    rs = pf / g;
    ra = pa / g;
  }
  if (!(rs >= MLB_RPG_FLOOR && rs <= MLB_RPG_CAP && ra >= MLB_RPG_FLOOR && ra <= MLB_RPG_CAP)) return null;
  return { rs, ra };
}

/** rs and ra divided by home-park exposure. adj 1 leaves the rates unchanged. */
function neutralizeRpg(rpg, adj) {
  if (!rpg || !Number.isFinite(rpg.rs) || !Number.isFinite(rpg.ra)) return null;
  const a = Number(adj);
  const d = Number.isFinite(a) && a > 0 ? a : 1;
  return { rs: rpg.rs / d, ra: rpg.ra / d };
}

/**
 * Pregame run environment from team offense and opponent runs allowed.
 * Season rates are neutralized by each club's home-park exposure first.
 * Home margin = (neutral home runs − neutral away runs) + HFA. Total = the sum.
 * The venue park is not applied here. applySpPark multiplies the total once.
 * Equal clubs land on HFA and their own run environment, not a season-RD spike.
 * Missing either side → neutral { HFA, 8.6 }, which is the old zero-power baseline.
 * opts is optional: { parkFactors, homeTeam, awayTeam, fallbackSeen }.
 * No opts, or a club with no park row, uses adj 1 (previous rates).
 */
function mlbStandingsEnv(homeSt, awaySt, opts) {
  const hfa = Number.isFinite(Number(HFA && HFA.MLB)) ? Number(HFA.MLB) : 0.12;
  const neutral = { modelMargin: hfa, modelTotal: 8.6, usedStandings: false };
  const hRaw = teamRpg(homeSt);
  const aRaw = teamRpg(awaySt);
  if (!hRaw || !aRaw) return neutral;
  const parkFactors = opts && opts.parkFactors;
  const seen = opts && opts.fallbackSeen;
  const homeParkAdj = clubParkAdj(opts && opts.homeTeam, parkFactors, seen);
  const awayParkAdj = clubParkAdj(opts && opts.awayTeam, parkFactors, seen);
  const h = neutralizeRpg(hRaw, homeParkAdj);
  const a = neutralizeRpg(aRaw, awayParkAdj);
  const homeRuns = (h.rs + a.ra) / 2;
  const awayRuns = (a.rs + h.ra) / 2;
  const modelTotal = homeRuns + awayRuns;
  const modelMargin = (homeRuns - awayRuns) + hfa;
  if (!Number.isFinite(modelTotal) || !Number.isFinite(modelMargin)) return neutral;
  return {
    modelMargin,
    modelTotal,
    usedStandings: true,
    homeRs: h.rs,
    homeRa: h.ra,
    awayRs: a.rs,
    awayRa: a.ra,
    homeParkAdj,
    awayParkAdj,
  };
}

/**
 * Fixed prior for (model total − sharp no-vig total), in runs.
 * Frozen snaps 2026-09-22..2026-10-08, one row per MLB game with a sharp
 * total (Pinnacle when Circa is absent; else the other sharp books).
 * n=106, mean of (finished model total − sharp total) +1.185, SD 0.833,
 * SE 0.081. Pitcher lines are the season StatsAPI pull the generator
 * already makes (gameType=R), not a refit. Circa posted no totals here.
 *
 * Where the +1.185 comes from, on all 113 priced games (means):
 *   standings run environment                              8.895
 *   starter quality                                        −0.081
 *   park multiply (mean park 0.999)                        −0.002
 *   bullpen residual                                       +0.021
 *   game-day total / weather                               0
 *   finished total                                         8.834
 *   sharp total on the 106 games that have one            7.637
 *   8.6 fallback                                           0 games
 *   season-sum divide (pf/pa already per game, all ≤ 5.4)  0 games
 * Home/away run splits are not on the standings feed. A symmetric
 * home/road split moves the margin, not this total level.
 * Park neutralization (the single-apply fix) moves the mean by about
 * −0.04 and leaves the lean. It is not re-applied here.
 *
 * The prior is that level. It is not fit per game. A slate with at least
 * MLB_TOTAL_RECENTER_MIN sharp totals replaces it with that slate's own
 * mean. After the prior is removed, the expected leftover is 0, so a
 * short slate does not subtract the prior a second time.
 */
const MLB_TOTAL_PRIOR_OFFSET = 1.185;
const MLB_TOTAL_RECENTER_MIN = 3;

function mlbToggleOn(name) {
  const raw = process.env[name];
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'off') return false;
  return true;
}

/** Read at call time. Unset is on. "0" and "off" disable. */
function mlbTotalFlags() {
  return {
    rootfix: mlbToggleOn('OMEGA_MLB_ROOTFIX'),
    recenter: mlbToggleOn('OMEGA_MLB_TOTAL_RECENTER'),
  };
}

function totalPointForBook(event, book) {
  const want = String(book || '').toLowerCase();
  const bk = (event && event.bookmakers || []).find(b => String(b.key || '').toLowerCase() === want);
  if (!bk) return null;
  const mkt = (bk.markets || []).find(m => m.key === 'totals');
  if (!mkt) return null;
  const over = (mkt.outcomes || []).find(o => /^over$/i.test(o.name) && o.point != null);
  if (over && Number.isFinite(Number(over.point))) return Number(over.point);
  const any = (mkt.outcomes || []).find(o => o.point != null && Number.isFinite(Number(o.point)));
  return any ? Number(any.point) : null;
}

/**
 * Sharp no-vig total: the run line, not a probability.
 * Pinnacle and Circa (circa, else circasports) at equal weight when both
 * post a total. One of them alone when the other is missing. Otherwise
 * the median of the other sharp books. No sharp total → null (that game
 * does not enter the slate mean).
 */
function sharpNoVigTotal(event) {
  if (!event) return null;
  const pin = totalPointForBook(event, 'pinnacle');
  let circa = totalPointForBook(event, 'circa');
  if (circa == null) circa = totalPointForBook(event, 'circasports');
  const anchored = [pin, circa].filter(v => Number.isFinite(v));
  if (anchored.length === 2) return (anchored[0] + anchored[1]) / 2;
  if (anchored.length === 1) return anchored[0];
  const sharpSet = new Set((SHARP_BOOKS || []).map(b => String(b).toLowerCase()));
  const pts = [];
  const seen = new Set();
  for (const bk of event.bookmakers || []) {
    const key = String(bk.key || '').toLowerCase();
    if (!key || seen.has(key) || !sharpSet.has(key)) continue;
    seen.add(key);
    const p = totalPointForBook(event, key);
    if (Number.isFinite(p)) pts.push(p);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a - b);
  return pts[Math.floor(pts.length / 2)];
}

/**
 * Runs to subtract from every MLB modelTotal this generate.
 * rows: { total, sharp } for each game. sharp may be null.
 * Root fix subtracts MLB_TOTAL_PRIOR_OFFSET (the 2026 environment gap).
 * Recenter, when n >= 3 sharp totals, replaces that fixed gap with the
 * slate mean of (raw total − sharp). The prior is not added on top of
 * the slate mean. n < 3 uses the prior once.
 * Both flags off → 0.
 */
function mlbTotalLevelShift(rows, flags) {
  const rootfix = !!(flags && flags.rootfix);
  const recenter = !!(flags && flags.recenter);
  if (!rootfix && !recenter) return 0;
  const prior = MLB_TOTAL_PRIOR_OFFSET;
  const base = rootfix ? prior : 0;
  if (!recenter) return base;
  const gaps = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.total) || !Number.isFinite(row.sharp)) continue;
    gaps.push((row.total - base) - row.sharp);
  }
  if (gaps.length >= MLB_TOTAL_RECENTER_MIN) {
    const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    return base + mean;
  }
  // Short slate: the prior stands in for the mean. Root fix already
  // applied it, so the residual prior is 0.
  return base + (rootfix ? 0 : prior);
}

/** Shift 0 returns the same total. Any other shift stays inside the existing band. */
function applyMlbTotalShift(modelTotal, shift) {
  const s = Number(shift);
  if (!Number.isFinite(s) || s === 0) return modelTotal;
  const t = Number(modelTotal);
  if (!Number.isFinite(t)) return modelTotal;
  return clamp(t - s, MLB_TOTAL_MIN, MLB_TOTAL_MAX);
}

/** MLB season year. Jan/Feb still belong to the previous season. */
function mlbSeasonFromDate(dateISO) {
  const raw = String(dateISO || '');
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7));
  const year = Number.isFinite(y) && y > 1990 ? y : new Date().getUTCFullYear();
  if (Number.isFinite(m) && m >= 1 && m < 3) return year - 1;
  return year;
}

module.exports = {
  LEAGUE_FIP,
  FIP_C,
  TEAM_PRIOR_WEIGHT,
  SP_MARGIN_PER_RUN,
  SP_TOTAL_PER_RUN,
  MLB_TOTAL_MIN,
  MLB_TOTAL_MAX,
  parseIp,
  fipFromCounting,
  xfipFromCounting,
  pitcherRate,
  normName,
  emptyPitcherIndex,
  buildPitcherIndex,
  resolveSpQuality,
  resolvePark,
  applySpPark,
  resolveBullpenQuality,
  applyBullpenAdj,
  mlbSpKnownStd,
  mlbSeasonFromDate,
  teamRpg,
  teamParkAdj,
  neutralizeRpg,
  mlbStandingsEnv,
  MLB_TOTAL_PRIOR_OFFSET,
  MLB_TOTAL_RECENTER_MIN,
  mlbToggleOn,
  mlbTotalFlags,
  sharpNoVigTotal,
  mlbTotalLevelShift,
  applyMlbTotalShift,
};
