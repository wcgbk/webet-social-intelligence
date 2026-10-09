'use strict';

/**
 * No-vig closes for non-published Omega sides.
 *
 * Writes clv-candidates-{date} only. Never reads or writes clv-{date},
 * picks-{date}, KPI buckets, or selection. Published-pick snapshots already
 * in memory (same sport + same commence timestamp) cost 0 extra Odds credits.
 *
 * Odds API v4 prices used here match track-clv-omega fetchBulk
 * (regions us,us2,eu × markets h2h,spreads,totals, no bookmakers param):
 *   live = 3 × 3 = 9 credits
 *   historical = 10 × 9 = 90 credits
 * GET /events is 0. A hard cap (default 150) stops the next extra pull that
 * would pass it, so one historical close (90) fits and a second (180) does not.
 *
 * Full-slate sharp closes live in clv-candidates-v2 (capture-candidate-closes).
 * This capped sample still writes clv-candidates-{date}. The v1 lambda-compat
 * handler's getStore() has no blobs context: setJSON throws, and the published
 * clv-{date} path already falls back to the Netlify REST API. This write does
 * the same. A thrown getBulk is per commence group, so one sport cannot drop
 * the rest of the batch.
 */

const { GATES, ODDS_SPORT_KEYS, SITE_ID, BLOB_STORE } = require('./config');
const { parseEdgeFraction, qualityScore, formatMoneylinePick } = require('./odds_math');
const { candidateSideSeed } = require('./clv_log');
const { closingNoVigFromRaw, clvFromNoVig, americanToImplied } = require('./clv_grade');
const { hasTrueClosingCapture } = require('./fetch_memo');

/** Yes-pool unselected + near-misses, after the quality sort. */
const CANDIDATE_SIDE_CAP = 20;
/** Gate miss within this fraction (1.5 percentage points) counts as a near-miss. */
const NEAR_MISS_PP = 0.015;
const NEAR_MISS_REASONS = new Set(['ev-floor', 'coverProb-floor', 'nonpositive-edge', 'edge']);
const LIVE_CREDITS = 9;
const HISTORICAL_CREDITS = 90;
/** One historical pull is 90. Two would be 180, above the ~150/day ceiling. */
const DEFAULT_EXTRA_CREDIT_CAP = 150;
/** A stored live snap is "near commence" inside this many ms before first pitch. */
const NEAR_COMMENCE_MS = 20 * 60 * 1000;
const PRE_PITCH_BUFFER_MIN = 3;
const CANDIDATE_BLOB_PREFIX = 'clv-candidates-';

function sportFloor(map, sport) {
  if (!map) return null;
  const v = map[sport] != null ? map[sport] : map.default;
  return Number.isFinite(v) ? v : null;
}

function sportKeyFor(sport) {
  if (!sport) return null;
  if (sport === 'CFB') return ODDS_SPORT_KEYS.NCAAF;
  return ODDS_SPORT_KEYS[sport] || null;
}

function snapshotKey(sportKey, atISO) {
  return `${sportKey}|${atISO || 'live'}`;
}

function sideKey(row) {
  return [
    row.sport || '',
    row.matchup || '',
    row.market || '',
    row.side || '',
    row.line == null ? '' : String(row.line),
  ].join('|').toLowerCase();
}

function extraCreditCap(override) {
  if (Number.isFinite(override) && override >= 0) return override;
  const env = Number(process.env.OMEGA_CLV_CANDIDATE_CREDIT_CAP);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_EXTRA_CREDIT_CAP;
}

function isPublishedStraight(row, picks) {
  const side = row.side || row.pick || '';
  const matchup = row.matchup;
  if (!matchup) return false;
  const labeled = formatMoneylinePick(side, row.market || row.betType);
  return (picks || []).some((p) => {
    if (!p || p.matchup !== matchup) return false;
    const name = p.pick || p.side || '';
    return name === side || name === labeled || name === row.pick;
  });
}

/**
 * Distance to the passing line of the recorded gate, in probability points.
 * Null when the row was not rejected only by ev-floor / edge / coverProb,
 * or the stored sample has no number to measure. Positive and ≤ 1.5pp is a near-miss.
 */
function nearMissGap(row) {
  const reason = String((row && (row.reason || row.rejectReason)) || '');
  if (!NEAR_MISS_REASONS.has(reason)) return null;
  if (reason === 'ev-floor') {
    const ev = Number(row.ev);
    const floor = sportFloor(GATES.minEV, row.sport || 'default');
    if (!Number.isFinite(ev) || floor == null) return null;
    return floor - ev;
  }
  if (reason === 'coverProb-floor') {
    const cp = Number(row.coverProb);
    const floor = sportFloor(GATES.minCoverProb, row.sport || 'default');
    if (!Number.isFinite(cp) || floor == null) return null;
    return floor - cp;
  }
  const edge = parseEdgeFraction(row.edge != null ? row.edge : row.edgePct);
  if (edge == null) return null;
  return edge <= 0 ? -edge : null;
}

function isNearMissRejection(row) {
  const gap = nearMissGap(row);
  return gap != null && gap >= 0 && gap <= NEAR_MISS_PP + 1e-12;
}

function normalizeSide(row, rejectReason, date) {
  const seed = candidateSideSeed(row, { date, rejectReason });
  const edge = parseEdgeFraction(seed.edge);
  seed.edge = edge == null ? seed.edge : edge;
  seed.qualityScore = qualityScore(seed.edge, seed.predictedClv, seed.uncertainty);
  seed.sportKey = sportKeyFor(seed.sport);
  return seed;
}

/**
 * Non-published sides from the stored card.
 * Yes-pool: candidateTable (top 15), excluding rows that are published straights.
 * Near-miss: stored per-sport rejection sample, ev-floor / edge / coverProb only,
 * within 1.5pp of that gate. Cap is quality score, highest first.
 */
function selectCandidateSides(picksData, { cap = CANDIDATE_SIDE_CAP, date = null } = {}) {
  const picks = (picksData && picksData.picks) || [];
  const table = Array.isArray(picksData && picksData.candidateTable) ? picksData.candidateTable : [];
  const rejections = Array.isArray(picksData && picksData.rejections) ? picksData.rejections : [];
  const dateISO = date || (picksData && picksData.date) || null;
  const out = [];
  const seen = new Set();
  const add = (row, rejectReason) => {
    if (!row || isPublishedStraight(row, picks)) return;
    const side = normalizeSide(row, rejectReason, dateISO);
    if (!side.side || !side.matchup) return;
    const key = sideKey(side);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(side);
  };
  for (const c of table) {
    if (c && c.selected === true) continue;
    add(c, 'yes-pool-unselected');
  }
  for (const r of rejections) {
    if (!isNearMissRejection(r)) continue;
    add(r, r.reason || r.rejectReason);
  }
  out.sort((a, b) => {
    const q = (b.qualityScore || 0) - (a.qualityScore || 0);
    if (Math.abs(q) > 1e-12) return q;
    return (b.edge || 0) - (a.edge || 0);
  });
  const limited = Number.isFinite(cap) && cap >= 0 ? cap : CANDIDATE_SIDE_CAP;
  return out.slice(0, limited);
}

function groupByCommence(sides) {
  const groups = new Map();
  for (const side of sides || []) {
    const sportKey = side.sportKey || sportKeyFor(side.sport);
    const commenceISO = side.commenceTime || '';
    const id = sportKey ? `${sportKey}|${commenceISO}` : `unmapped|${side.sport}|${commenceISO}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        sportKey,
        sport: side.sport,
        commenceISO: commenceISO || null,
        sides: [],
        qualityScore: -Infinity,
      });
    }
    const g = groups.get(id);
    g.sides.push(side);
    if ((side.qualityScore || 0) > g.qualityScore) g.qualityScore = side.qualityScore || 0;
  }
  return [...groups.values()];
}

function commenceIsUpcoming(commenceISO, nowMs) {
  if (!commenceISO) return true;
  const commenceMs = Date.parse(commenceISO);
  if (!Number.isFinite(commenceMs)) return true;
  return commenceMs >= nowMs - PRE_PITCH_BUFFER_MIN * 60000;
}

function findSnapGame(snap, side) {
  if (!snap) return null;
  const games = snap.games || {};
  const want = String(side.matchup || '').toLowerCase().trim();
  if (want && games[want]) return games[want];
  const homeHint = String(side.homeTeam || '').toLowerCase();
  const awayHint = String(side.awayTeam || '').toLowerCase();
  for (const g of Object.values(games)) {
    if (!g) continue;
    const home = String(g.homeTeam || g.home_team || '').toLowerCase();
    const away = String(g.awayTeam || g.away_team || '').toLowerCase();
    if (homeHint && awayHint && home === homeHint && away === awayHint) return g;
    if (want && home && away && want.includes(away) && want.includes(home)) return g;
  }
  return null;
}

function findLateSnap(snaps, group) {
  const commenceMs = group.commenceISO ? Date.parse(group.commenceISO) : NaN;
  if (!Number.isFinite(commenceMs)) return null;
  for (const snap of snaps || []) {
    const at = Date.parse(snap && snap.capturedAt);
    if (!Number.isFinite(at)) continue;
    const delta = commenceMs - at;
    if (delta < -PRE_PITCH_BUFFER_MIN * 60000 || delta > NEAR_COMMENCE_MS) continue;
    for (const side of group.sides) {
      const game = findSnapGame(snap, side);
      if (game) return { snap, capturedAt: snap.capturedAt, commenceMs };
    }
  }
  return null;
}

function eventMatchesSide(ev, side, teamsMatch) {
  if (!ev || !side) return false;
  const home = ev.home_team || ev.homeTeam;
  const away = ev.away_team || ev.awayTeam;
  const matchup = side.matchup || '';
  if (!home || !away || !matchup) return false;
  if (typeof teamsMatch === 'function') {
    const homeHit = teamsMatch(home, matchup) || matchup.toLowerCase().includes(String(home).toLowerCase());
    const awayHit = teamsMatch(away, matchup) || matchup.toLowerCase().includes(String(away).toLowerCase());
    return !!(homeHit && awayHit);
  }
  const m = matchup.toLowerCase();
  return m.includes(String(home).toLowerCase()) && m.includes(String(away).toLowerCase());
}

function groupOnEvents(events, group, teamsMatch) {
  if (!Array.isArray(events)) return null;
  return events.some((ev) => group.sides.some((side) => eventMatchesSide(ev, side, teamsMatch)));
}

function storedCloseFor(side, storedByKey) {
  if (!storedByKey) return null;
  return storedByKey.get(sideKey(side)) || null;
}

function groupFullyClosed(group, storedByKey) {
  return group.sides.length > 0 && group.sides.every((side) => hasTrueClosingCapture(storedCloseFor(side, storedByKey)));
}

/**
 * Decide extra Odds pulls. `publishedSnapshotKeys` holds keys the published
 * close pass already fetched (`sportKey|commenceISO` or `sportKey|live`).
 * A key already in that set, or already chosen for an earlier candidate group
 * in this plan, is reuse at 0 credits.
 */
function planCandidatePulls({
  sides,
  publishedSnapshotKeys,
  nowMs = Date.now(),
  creditCap,
  lateSnaps = [],
  eventsBySportKey = {},
  storedByKey = new Map(),
  teamsMatch = null,
} = {}) {
  const cap = extraCreditCap(creditCap);
  const covered = new Set(publishedSnapshotKeys || []);
  const groups = groupByCommence(sides).sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
  const decisions = [];
  let extraCredits = 0;
  let extraPulls = 0;
  for (const group of groups) {
    const base = { groupId: group.id, sportKey: group.sportKey, commenceISO: group.commenceISO, sides: group.sides.length };
    if (!group.sportKey) {
      decisions.push({ ...base, action: 'skip-unmapped', credits: 0 });
      continue;
    }
    if (groupFullyClosed(group, storedByKey)) {
      decisions.push({ ...base, action: 'skip-stored-close', credits: 0 });
      continue;
    }
    const upcoming = commenceIsUpcoming(group.commenceISO, nowMs);
    const historicalKey = snapshotKey(group.sportKey, group.commenceISO);
    const liveKey = snapshotKey(group.sportKey, null);
    if (group.commenceISO && covered.has(historicalKey)) {
      decisions.push({ ...base, action: 'reuse', credits: 0, key: historicalKey });
      continue;
    }
    if (upcoming && covered.has(liveKey)) {
      decisions.push({ ...base, action: 'reuse', credits: 0, key: liveKey });
      continue;
    }
    const late = findLateSnap(lateSnaps, group);
    if (late) {
      decisions.push({
        ...base,
        action: 'existing-live',
        credits: 0,
        priceClass: LIVE_CREDITS,
        capturedAt: late.capturedAt,
      });
      continue;
    }
    const events = eventsBySportKey[group.sportKey];
    if (Array.isArray(events) && groupOnEvents(events, group, teamsMatch) === false) {
      const already = group.sides.some((side) => {
        const prev = storedCloseFor(side, storedByKey);
        return prev && (prev.closingNoVig != null || (typeof prev.clv === 'number' && Number.isFinite(prev.clv)));
      });
      if (already) {
        decisions.push({ ...base, action: 'skip-events', credits: 0 });
        continue;
      }
    }
    const pullCredits = upcoming ? LIVE_CREDITS : HISTORICAL_CREDITS;
    const pullKey = upcoming ? liveKey : historicalKey;
    if (!upcoming && !group.commenceISO) {
      decisions.push({ ...base, action: 'skip-no-commence', credits: 0 });
      continue;
    }
    if (extraCredits + pullCredits > cap) {
      decisions.push({ ...base, action: 'skip-cap', credits: 0, wouldCost: pullCredits });
      continue;
    }
    extraCredits += pullCredits;
    extraPulls += 1;
    covered.add(pullKey);
    decisions.push({
      ...base,
      action: upcoming ? 'pull-live' : 'pull-historical',
      credits: pullCredits,
      key: pullKey,
    });
  }
  return {
    decisions,
    extraCredits,
    extraPulls,
    cap,
    reused: decisions.filter((d) => d.action === 'reuse').length,
    skippedEvents: decisions.filter((d) => d.action === 'skip-events').length,
    skippedCap: decisions.filter((d) => d.action === 'skip-cap').length,
    existingLive: decisions.filter((d) => d.action === 'existing-live').length,
  };
}

function booksSnapToEvent(game) {
  if (!game) return null;
  if (Array.isArray(game.bookmakers) && (game.home_team || game.homeTeam)) {
    return game.home_team ? game : { ...game, home_team: game.homeTeam, away_team: game.awayTeam };
  }
  const home = game.homeTeam || game.home_team;
  const away = game.awayTeam || game.away_team;
  const bookmakers = [];
  for (const [key, row] of Object.entries(game.books || {})) {
    if (!row) continue;
    const markets = [];
    const h2h = [];
    if (row.mlHome != null) h2h.push({ name: home, price: row.mlHome });
    if (row.mlAway != null) h2h.push({ name: away, price: row.mlAway });
    if (h2h.length >= 2) markets.push({ key: 'h2h', outcomes: h2h });
    const spreads = [];
    if (row.spreadHome != null && row.spreadHomeOdds != null) {
      spreads.push({ name: home, price: row.spreadHomeOdds, point: row.spreadHome });
    }
    if (row.spreadAway != null && row.spreadAwayOdds != null) {
      spreads.push({ name: away, price: row.spreadAwayOdds, point: row.spreadAway });
    }
    if (spreads.length >= 2) markets.push({ key: 'spreads', outcomes: spreads });
    if (row.total != null && row.overOdds != null && row.underOdds != null) {
      markets.push({
        key: 'totals',
        outcomes: [
          { name: 'Over', price: row.overOdds, point: row.total },
          { name: 'Under', price: row.underOdds, point: row.total },
        ],
      });
    }
    if (markets.length) bookmakers.push({ key, title: key, markets });
  }
  return {
    home_team: home,
    away_team: away,
    commence_time: game.commenceTime || game.commence_time || null,
    bookmakers,
  };
}

function asClosePick(side) {
  return {
    pick: side.side,
    side: side.side,
    betType: side.market,
    market: side.market,
    matchup: side.matchup,
    sport: side.sport,
    odds: side.odds,
    commenceTime: side.commenceTime,
  };
}

function captureScoreFor(mins) {
  if (mins == null || !Number.isFinite(mins)) return 5e5;
  return mins >= -PRE_PITCH_BUFFER_MIN ? Math.max(0, mins) : 1e6 + Math.abs(mins);
}

function applyClose(side, close, { snapAt, nowMs, capturedAt }) {
  const commenceMs = side.commenceTime ? Date.parse(side.commenceTime) : NaN;
  let captureMinsToCommence = null;
  if (snapAt) captureMinsToCommence = 0;
  else if (capturedAt && Number.isFinite(commenceMs)) {
    captureMinsToCommence = Math.round((commenceMs - Date.parse(capturedAt)) / 60000);
  } else if (Number.isFinite(commenceMs)) {
    captureMinsToCommence = Math.round((commenceMs - nowMs) / 60000);
  }
  const captureScore = captureScoreFor(captureMinsToCommence);
  const betRaw = americanToImplied(side.odds);
  if (!close || !close.overround || close.sideRaw == null) {
    return {
      ...side,
      closingLine: close ? (close.closingLine ?? null) : null,
      closingOdds: close && close.sideOdds != null ? String(close.sideOdds) : null,
      closingNoVig: null,
      clv: null,
      clvCents: null,
      beatClose: null,
      captureMinsToCommence,
      captureScore: close ? captureScore : 5e5,
      anchor: close ? close.anchor : null,
      anchorBook: close ? close.anchorBook : null,
      closeSnapshotAt: null,
      result: side.result || null,
    };
  }
  const closingNoVig = closingNoVigFromRaw(close.sideRaw, close.overround);
  const pickTimeNoVig = betRaw != null ? closingNoVigFromRaw(betRaw, close.overround) : null;
  const graded = clvFromNoVig(closingNoVig, pickTimeNoVig);
  return {
    ...side,
    closingLine: close.closingLine ?? null,
    closingOdds: close.sideOdds != null ? String(close.sideOdds) : null,
    closingNoVig,
    pickTimeNoVig,
    closingOverround: +Number(close.overround).toFixed(4),
    clv: graded ? graded.clv : null,
    clvCents: graded ? graded.clvCents : null,
    beatClose: graded ? graded.beatClose : null,
    captureMinsToCommence,
    captureScore,
    anchor: close.anchor || null,
    anchorBook: close.anchorBook || null,
    closeSnapshotAt: snapAt || capturedAt || new Date(nowMs).toISOString(),
    result: side.result || null,
  };
}

function preferCloser(prev, next) {
  if (!prev) return next;
  if (hasTrueClosingCapture(prev)) {
    return {
      ...next,
      closingLine: prev.closingLine,
      closingOdds: prev.closingOdds,
      closingNoVig: prev.closingNoVig,
      pickTimeNoVig: prev.pickTimeNoVig,
      closingOverround: prev.closingOverround,
      clv: prev.clv,
      clvCents: prev.clvCents,
      beatClose: prev.beatClose,
      captureMinsToCommence: prev.captureMinsToCommence,
      captureScore: prev.captureScore,
      anchor: prev.anchor,
      anchorBook: prev.anchorBook,
      closeSnapshotAt: prev.closeSnapshotAt,
      result: next.result || prev.result || null,
    };
  }
  const prevScore = (prev.clv != null && typeof prev.captureScore === 'number') ? prev.captureScore : Infinity;
  if (next.clv != null && next.captureScore <= prevScore) return { ...next, result: next.result || prev.result || null };
  if (prev.clv != null) {
    return {
      ...next,
      closingLine: prev.closingLine,
      closingOdds: prev.closingOdds,
      closingNoVig: prev.closingNoVig,
      pickTimeNoVig: prev.pickTimeNoVig,
      closingOverround: prev.closingOverround,
      clv: prev.clv,
      clvCents: prev.clvCents,
      beatClose: prev.beatClose,
      captureMinsToCommence: prev.captureMinsToCommence,
      captureScore: prev.captureScore,
      anchor: prev.anchor,
      anchorBook: prev.anchorBook,
      closeSnapshotAt: prev.closeSnapshotAt,
      result: next.result || prev.result || null,
    };
  }
  return { ...next, result: next.result || prev.result || null };
}

function publicCandidateRow(row) {
  return {
    date: row.date || null,
    sport: row.sport || null,
    matchup: row.matchup || null,
    market: row.market || null,
    side: row.side || null,
    line: row.line == null ? null : row.line,
    odds: row.odds == null ? null : row.odds,
    fair_sharp_p: row.fair_sharp_p == null ? null : row.fair_sharp_p,
    coverProb: row.coverProb == null ? null : row.coverProb,
    edge: row.edge == null ? null : row.edge,
    ev: row.ev == null ? null : row.ev,
    rejectReason: row.rejectReason || null,
    closingLine: row.closingLine == null ? null : row.closingLine,
    closingOdds: row.closingOdds == null ? null : row.closingOdds,
    closingNoVig: row.closingNoVig == null ? null : row.closingNoVig,
    clvCents: row.clvCents == null ? null : row.clvCents,
    captureMinsToCommence: row.captureMinsToCommence == null ? null : row.captureMinsToCommence,
    result: row.result || null,
    commenceTime: row.commenceTime || null,
    clv: row.clv == null ? null : row.clv,
    captureScore: row.captureScore == null ? null : row.captureScore,
    anchor: row.anchor || null,
    anchorBook: row.anchorBook || null,
    closeSnapshotAt: row.closeSnapshotAt || null,
    qualityScore: row.qualityScore == null ? null : row.qualityScore,
  };
}

function indexStored(existing) {
  const map = new Map();
  const sides = existing && Array.isArray(existing.sides) ? existing.sides : [];
  for (const row of sides) map.set(sideKey(row), row);
  return map;
}

function blobRestUrl(key, siteId) {
  const site = siteId || process.env.SITE_ID || SITE_ID;
  return `https://api.netlify.com/api/v1/blobs/${site}/${BLOB_STORE}/${key}`;
}

/**
 * REST read/write used when getStore's setJSON/get throws (no Lambda blobs
 * context). Returns null on a missing blob or a transport failure so one
 * read cannot abort the batch. A PUT that fails still throws.
 */
async function restCandidate(key, { method = 'GET', body, fetchImpl, token, siteId } = {}) {
  const auth = token != null ? token : process.env.NETLIFY_AUTH_TOKEN;
  if (!auth) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(blobRestUrl(key, siteId), {
    method,
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return resp;
}

async function restGetCandidate(key, opts) {
  try {
    const resp = await restCandidate(key, { method: 'GET', ...opts });
    if (!resp || !resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error(`[track-clv] candidate REST get ${key} failed: ${e.message}`);
    return null;
  }
}

async function writeCandidateBlob(key, payload, opts) {
  if (opts.store && typeof opts.store.setJSON === 'function') {
    try {
      await opts.store.setJSON(key, payload);
      return { via: 'sdk' };
    } catch (e) {
      console.error(`[track-clv] candidate setJSON ${key} failed: ${e.message} — REST fallback`);
    }
  } else if (!opts.allowRest) {
    return { via: 'skipped' };
  }
  const resp = await restCandidate(key, { method: 'PUT', body: payload, ...opts });
  if (!resp || !resp.ok) {
    const status = resp ? resp.status : 'no-response';
    throw new Error(`blob PUT ${key} → ${status}`);
  }
  console.log(`[track-clv] candidate REST wrote ${key}`);
  return { via: 'rest' };
}

/**
 * Capture closes for the selected sides. `publishedSnapshotKeys` and `getBulk`
 * are the published pass's cache. This function does not receive clv-{date}
 * and will not write that key.
 */
async function captureCandidateCloses(opts = {}) {
  const dateISO = opts.dateISO;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const picksData = opts.picksData || {};
  const selected = Array.isArray(opts.sides) ? opts.sides : selectCandidateSides(picksData, { date: dateISO });
  let existing = opts.existing;
  const existingKey = `${CANDIDATE_BLOB_PREFIX}${dateISO}`;
  if (existing === undefined && opts.store && typeof opts.store.get === 'function') {
    try {
      existing = await opts.store.get(existingKey, { type: 'json' });
    } catch (e) {
      console.error(`[track-clv] candidate get ${existingKey} failed: ${e.message} — REST fallback`);
      existing = await restGetCandidate(existingKey, opts);
    }
  } else if (existing === undefined && opts.allowRest) {
    existing = await restGetCandidate(existingKey, opts);
  }
  const storedByKey = indexStored(existing);
  const espnBySport = { ...(opts.espnBySport || {}) };
  if (typeof opts.fetchESPNScores === 'function') {
    const sports = [...new Set(selected.map((s) => s.sport).filter(Boolean))];
    for (const sport of sports) {
      if (espnBySport[sport]) continue;
      try {
        espnBySport[sport] = await opts.fetchESPNScores(dateISO, sport);
      } catch (_) {
        espnBySport[sport] = [];
      }
    }
  }
  const publishedSnapshotKeys = opts.publishedSnapshotKeys || new Set();
  const lateSnaps = opts.lateSnaps || [];
  const teamsMatch = opts.teamsMatch || null;

  const eventsBySportKey = { ...(opts.eventsBySportKey || {}) };
  if (typeof opts.fetchEvents === 'function') {
    const need = new Set();
    for (const side of selected) {
      const sportKey = side.sportKey || sportKeyFor(side.sport);
      if (!sportKey) continue;
      const historicalKey = snapshotKey(sportKey, side.commenceTime);
      const liveKey = snapshotKey(sportKey, null);
      const upcoming = commenceIsUpcoming(side.commenceTime, nowMs);
      const covered = (side.commenceTime && publishedSnapshotKeys.has(historicalKey))
        || (upcoming && publishedSnapshotKeys.has(liveKey));
      if (!covered && eventsBySportKey[sportKey] === undefined) need.add(sportKey);
    }
    for (const sportKey of need) {
      try {
        const list = await opts.fetchEvents(sportKey);
        eventsBySportKey[sportKey] = Array.isArray(list) ? list : null;
      } catch (_) {
        eventsBySportKey[sportKey] = null;
      }
    }
  }

  const plan = planCandidatePulls({
    sides: selected,
    publishedSnapshotKeys,
    nowMs,
    creditCap: opts.creditCap,
    lateSnaps,
    eventsBySportKey,
    storedByKey,
    teamsMatch,
  });

  const bulkCache = opts.bulkCache || new Map();
  const fetchCounts = { pulls: 0, credits: 0 };
  const getBulk = opts.getBulk || (async (sportKey, atISO) => {
    const k = snapshotKey(sportKey, atISO);
    if (!bulkCache.has(k)) {
      if (typeof opts.fetchBulk !== 'function') throw new Error('fetchBulk missing');
      bulkCache.set(k, await opts.fetchBulk(sportKey, atISO));
    }
    return bulkCache.get(k);
  });

  const gamesByKey = new Map();
  for (const decision of plan.decisions) {
    try {
      if (decision.action === 'reuse' || decision.action === 'pull-live' || decision.action === 'pull-historical') {
        const atISO = decision.action === 'pull-live' || decision.key.endsWith('|live') ? null : decision.commenceISO;
        const before = bulkCache.has(decision.key) || publishedSnapshotKeys.has(decision.key);
        const games = await getBulk(decision.sportKey, atISO);
        gamesByKey.set(decision.key, games);
        if (!before && (decision.action === 'pull-live' || decision.action === 'pull-historical')) {
          fetchCounts.pulls += 1;
          fetchCounts.credits += decision.credits;
        }
      } else if (decision.action === 'existing-live') {
        const group = groupByCommence(selected).find((g) => g.id === decision.groupId);
        const late = group ? findLateSnap(lateSnaps, group) : null;
        if (late) {
          const events = [];
          for (const side of (group.sides || [])) {
            const game = findSnapGame(late.snap, side);
            if (!game) continue;
            events.push(booksSnapToEvent(game));
          }
          gamesByKey.set(`snap|${decision.groupId}`, events.filter(Boolean));
        }
      }
    } catch (e) {
      decision.error = e.message;
      console.error(`[track-clv] candidate group ${decision.groupId || decision.key || '?'} failed (continuing): ${e.message}`);
    }
  }

  const extractClose = opts.extractClose;
  const pickSideInfo = opts.pickSideInfo;
  const findMatchingGame = opts.findMatchingGame;
  const filled = [];
  for (const side of selected) {
    const sportKey = side.sportKey || sportKeyFor(side.sport);
    const decision = plan.decisions.find((d) => d.groupId === (sportKey ? `${sportKey}|${side.commenceTime || ''}` : `unmapped|${side.sport}|${side.commenceTime || ''}`));
    let gameObj = null;
    let snapAt = null;
    let capturedAt = null;
    if (decision && (decision.action === 'reuse' || decision.action === 'pull-live' || decision.action === 'pull-historical')) {
      const games = gamesByKey.get(decision.key) || [];
      if (typeof findMatchingGame === 'function') gameObj = findMatchingGame(asClosePick(side), games);
      if (decision.action === 'pull-historical' || (decision.action === 'reuse' && decision.key && !decision.key.endsWith('|live'))) {
        snapAt = side.commenceTime || null;
      }
    } else if (decision && decision.action === 'existing-live') {
      const games = gamesByKey.get(`snap|${decision.groupId}`) || [];
      if (typeof findMatchingGame === 'function') gameObj = findMatchingGame(asClosePick(side), games);
      capturedAt = decision.capturedAt || null;
    }
    let close = null;
    if (gameObj && typeof extractClose === 'function' && typeof pickSideInfo === 'function') {
      const info = pickSideInfo(asClosePick(side));
      close = extractClose(gameObj, info, asClosePick(side));
    }
    let row = applyClose(side, close, { snapAt, nowMs, capturedAt });
    if (opts.gradePick && opts.findGameForGrading) {
      const games = espnBySport[side.sport] || [];
      const game = opts.findGameForGrading(asClosePick(side), games);
      const result = opts.gradePick(asClosePick(side), game);
      if (result && result !== 'pending') row.result = result;
      else if (!row.result) row.result = result || null;
    }
    row = preferCloser(storedCloseFor(side, storedByKey), row);
    filled.push(publicCandidateRow(row));
  }

  const credits = {
    extraPulls: fetchCounts.pulls,
    extraCredits: fetchCounts.credits,
    plannedPulls: plan.extraPulls,
    plannedCredits: plan.extraCredits,
    cap: plan.cap,
    reused: plan.reused,
    skippedEvents: plan.skippedEvents,
    skippedCap: plan.skippedCap,
    existingLive: plan.existingLive,
    liveCredits: LIVE_CREDITS,
    historicalCredits: HISTORICAL_CREDITS,
  };
  const payload = {
    date: dateISO,
    capturedAt: new Date(nowMs).toISOString(),
    private: true,
    schema: 'clv-candidates-v1',
    note: 'Non-published candidate closes. Not a KPI. Not joined into clv-{date}.',
    cap: CANDIDATE_SIDE_CAP,
    credits,
    sides: filled,
  };
  const key = `${CANDIDATE_BLOB_PREFIX}${dateISO}`;
  console.log(`[track-clv] candidate closes date=${dateISO} sides=${filled.length} extraPulls=${credits.extraPulls} extraCredits=${credits.extraCredits} cap=${credits.cap} reused=${credits.reused} skippedEvents=${credits.skippedEvents} skippedCap=${credits.skippedCap} existingLive=${credits.existingLive}`);
  const write = await writeCandidateBlob(key, payload, opts);
  return { key, payload, plan, credits, write };
}

function candidateBlobKey(dateISO) {
  return `${CANDIDATE_BLOB_PREFIX}${dateISO}`;
}

module.exports = {
  CANDIDATE_SIDE_CAP,
  NEAR_MISS_PP,
  NEAR_MISS_REASONS,
  LIVE_CREDITS,
  HISTORICAL_CREDITS,
  DEFAULT_EXTRA_CREDIT_CAP,
  NEAR_COMMENCE_MS,
  CANDIDATE_BLOB_PREFIX,
  selectCandidateSides,
  isNearMissRejection,
  nearMissGap,
  planCandidatePulls,
  captureCandidateCloses,
  booksSnapToEvent,
  candidateBlobKey,
  snapshotKey,
  sportKeyFor,
  extraCreditCap,
  isPublishedStraight,
  sideKey,
};
