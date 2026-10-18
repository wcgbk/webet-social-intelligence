'use strict';

/**
 * Short-card top-up. Pure. No odds pull, no blob, no model-math change.
 *
 * Fill order matches selectStraights over the reserve: floor rows by
 * anchored stake EV (compareByEv), then positive-EV leans, then any
 * pregame lean, then same-line Pinnacle pairs. ratingSe is not a rank
 * or size term. A row that misses the floor is tier 'lean'. Stake is
 * the Kelly unit already on the pick. A blocked side never returns. A
 * side already on the card is not added. One straight per game unless
 * allowSameGame, and
 * that fill is only after distinct-game rows are exhausted
 * (sameGameFill: true). An exhausted reserve still returns the card.
 */

const config = require('./config');
const {
  MAX_STRAIGHTS,
} = config;
const {
  passesPublishFloor,
  passesLeanFill,
  eligibleForLeanPool,
  eligiblePairedFill,
  compareByEv,
  matchupKey,
  toPickObject,
  applyDailyUnitCap,
} = require('./select');
const { parlayFromStraights } = require('./parlay');
const { passesSheetMinimums } = require('./bet_check_gate');
const { verifyPlaceabilityDecision } = require('./edge');

const RESERVE_CAP = 12;
const MAX_PLACEABILITY_ROUNDS = 3;

function numericEv(row) {
  if (!row) return null;
  if (row.evRaw != null && Number.isFinite(Number(row.evRaw))) return Number(row.evRaw);
  if (typeof row.ev === 'number' && Number.isFinite(row.ev)) return row.ev;
  if (typeof row.ev === 'string' && row.ev.trim()) {
    const n = parseFloat(row.ev);
    if (!Number.isFinite(n)) return null;
    return row.ev.includes('%') || Math.abs(n) > 1 ? n / 100 : n;
  }
  const n = Number(row.ev);
  return Number.isFinite(n) ? n : null;
}

function numericCover(row) {
  if (!row || row.coverProb == null || row.coverProb === '') return null;
  if (typeof row.coverProb === 'number' && Number.isFinite(row.coverProb)) {
    return row.coverProb > 1 ? row.coverProb / 100 : row.coverProb;
  }
  const text = String(row.coverProb).trim();
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return null;
  if (text.includes('%') || n > 1) return n / 100;
  return n;
}

function numericOdds(row) {
  if (!row || row.odds == null || row.odds === '') return null;
  if (typeof row.odds === 'number' && Number.isFinite(row.odds)) return row.odds;
  const n = parseInt(String(row.odds).replace(/[^0-9\-+]/g, ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function sideLabel(row) {
  return String((row && (row.side || row.pick)) || '')
    .trim()
    .toLowerCase()
    .replace(/\s+ml$/, '')
    .replace(/\s+/g, ' ');
}

/** Name only. Commence time is not part of this key. */
function gameName(row) {
  if (!row || typeof row !== 'object') return '';
  return matchupKey({
    matchup: row.matchup,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
  });
}

function clockOf(row) {
  if (!row) return '';
  return String(row.commenceTime || row.commence_time || '');
}

function asCandidate(row) {
  if (!row || typeof row !== 'object') return null;
  const ev = numericEv(row);
  const cover = numericCover(row);
  const odds = numericOdds(row);
  const edge = row.edgePct != null ? row.edgePct : row.edge;
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    ev,
    edgePct: edge,
    coverProb: cover != null ? cover : row.coverProb,
    odds: odds != null ? odds : row.odds,
  };
}

function isVoidBlock(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.void === true || item.voided === true || item.postponed === true) return true;
  if (item.status === 'void-pregame') return true;
  return false;
}

/**
 * blocked entries are narrate rejections, hard-fails, placeability vetoes,
 * late-news drops, or voided games. A void with no side blocks the game.
 * A string is a side label, or "matchup|side".
 */
function blockedIndex(blocked) {
  const sides = [];
  const games = new Set();
  const labels = new Set();
  for (const item of blocked || []) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const text = item.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!text) continue;
      if (text.includes('|')) sides.push({ raw: text });
      else labels.add(text.replace(/\s+ml$/, ''));
      continue;
    }
    const side = sideLabel(item);
    const named = !!(item.matchup || item.homeTeam || item.awayTeam);
    if (isVoidBlock(item)) {
      if (clockOf(item)) games.add(matchupKey(item));
      else if (named) games.add(gameName(item));
      else if (side) labels.add(side);
      if (side && named) sides.push(item);
      continue;
    }
    if (!named) {
      if (side) labels.add(side);
      continue;
    }
    if (side) sides.push(item);
  }
  return { sides, games, labels };
}

function sameGameRow(a, b) {
  if (!a || !b) return false;
  if (gameName(a) !== gameName(b)) return false;
  const ta = clockOf(a);
  const tb = clockOf(b);
  if (ta && tb && ta !== tb) return false;
  return gameName(a) !== '';
}

function sameSideRow(a, b) {
  if (!sameGameRow(a, b)) return false;
  const sa = sideLabel(a);
  const sb = sideLabel(b);
  return sa !== '' && sa === sb;
}

function isBlocked(row, index) {
  if (!row || !index) return false;
  if (index.games.has(matchupKey(row)) || index.games.has(gameName(row))) return true;
  const label = sideLabel(row);
  if (label && index.labels.has(label)) return true;
  for (const item of index.sides) {
    if (item && item.raw) {
      const raw = `${String(row.matchup || '').trim().toLowerCase()}|${label}`;
      const full = `${matchupKey(row)}||${label}`;
      if (item.raw === raw || item.raw === full || item.raw === `${gameName(row)}||${label}`) return true;
      continue;
    }
    if (sameSideRow(row, item)) return true;
  }
  return false;
}

function alreadyOnCard(row, picks) {
  return (picks || []).some((pick) => sameSideRow(pick, row));
}

/** True when a straight is a blocked side or sits on a voided game. */
function sideBlocked(row, blocked) {
  return isBlocked(row, blockedIndex(blocked));
}

function classifyReserveRow(row) {
  const candidate = asCandidate(row);
  if (!candidate || !sideLabel(candidate)) return null;
  const ev = numericEv(candidate);
  if (!Number.isFinite(ev)) return null;
  if (passesPublishFloor(candidate) && row.pairedFill !== true) {
    return { kind: 'floor', candidate };
  }
  if (row.pairedFill === true || eligiblePairedFill(candidate)) {
    return { kind: 'paired', candidate };
  }
  if (passesLeanFill(candidate)) return { kind: 'posLean', candidate };
  if (eligibleForLeanPool(candidate)) return { kind: 'anyLean', candidate };
  if (row.tier === 'lean' && ev > 0) return { kind: 'posLean', candidate };
  return null;
}

function bucketReserve(reserve) {
  const buckets = { floor: [], posLean: [], anyLean: [], paired: [] };
  for (const row of reserve || []) {
    const found = classifyReserveRow(row);
    if (!found || !buckets[found.kind]) continue;
    buckets[found.kind].push({ row, candidate: found.candidate, kind: found.kind });
  }
  for (const kind of Object.keys(buckets)) {
    buckets[kind].sort((a, b) => compareByEv(a.candidate, b.candidate));
  }
  return buckets;
}

function materialize(entry, { sameGame }) {
  const row = entry.row || {};
  const candidate = entry.candidate || {};
  const lean = entry.kind !== 'floor';
  const want = lean ? 'lean' : 'floor';
  const src = {
    ...row,
    ...candidate,
    side: candidate.side || row.side || row.pick,
    market: candidate.market || row.market || row.betType,
    matchup: row.matchup || candidate.matchup,
    sport: row.sport || candidate.sport,
    homeTeam: row.homeTeam || candidate.homeTeam,
    awayTeam: row.awayTeam || candidate.awayTeam,
    commenceTime: row.commenceTime || candidate.commenceTime || '',
    book: row.book || candidate.book || row.executionBook || null,
    odds: numericOdds(candidate) != null ? numericOdds(candidate) : numericOdds(row),
    ev: numericEv(candidate),
    edgePct: candidate.edgePct != null ? candidate.edgePct : row.edgePct,
    coverProb: numericCover(candidate) != null ? numericCover(candidate) : numericCover(row),
    tier: want,
    placeableBooks: row.placeableBooks || candidate.placeableBooks,
    bestPlaceable: row.bestPlaceable || candidate.bestPlaceable,
    coreReasoning: row.coreReasoning || '',
    line: row.line != null ? row.line : candidate.line,
  };
  if (lean) {
    src.label = 'lean';
    if (entry.kind === 'paired' || row.pairedFill) {
      src.pairedFill = true;
      src.leanReason = row.leanReason || 'paired-ev';
    }
  }
  const pick = toPickObject(src, { modelVersion: row.modelVersion || candidate.modelVersion });
  if (row.pairedFill || entry.kind === 'paired') {
    pick.pairedFill = true;
    pick.leanReason = row.leanReason || pick.leanReason || 'paired-ev';
  }
  if (row.sharpFairPriced === true || candidate.sharpFairPriced === true) pick.sharpFairPriced = true;
  if (row.sharpFairReject || candidate.sharpFairReject) {
    pick.sharpFairReject = row.sharpFairReject || candidate.sharpFairReject;
  }
  if (row.hardRockPriced === true || row.hardRockPriced === false) pick.hardRockPriced = row.hardRockPriced === true;
  if (sameGame) pick.sameGameFill = true;
  if (lean) {
    pick.tier = 'lean';
    pick.label = 'lean';
  }
  return pick;
}

/**
 * @param {{ picks?: object[], reserve?: object[], blocked?: any[], target?: number, allowSameGame?: boolean }} opts
 * @returns {{ picks: object[], added: object[], exhausted: boolean }}
 */
function topUpStraights(opts = {}) {
  const target = Number.isFinite(Number(opts.target)) ? Number(opts.target) : MAX_STRAIGHTS;
  const allow = opts.allowSameGame == null
    ? config.ALLOW_SAME_GAME_TOPUP === true
    : opts.allowSameGame === true;
  const card = (opts.picks || []).map((pick) => ({ ...pick }));
  const index = blockedIndex(opts.blocked);
  const usedGames = new Set(card.map((pick) => matchupKey(pick)).filter(Boolean));
  const added = [];
  const buckets = bucketReserve(opts.reserve);
  const order = ['floor', 'posLean', 'anyLean', 'paired'];

  const take = (entry, sameGame) => {
    if (card.length >= target) return;
    const row = entry.row;
    if (isBlocked(row, index) || isBlocked(entry.candidate, index)) return;
    if (alreadyOnCard(row, card) || alreadyOnCard(entry.candidate, card)) return;
    const gameKey = matchupKey(entry.candidate.commenceTime || entry.candidate.matchup ? entry.candidate : row);
    const gameTaken = gameKey && usedGames.has(gameKey);
    if (sameGame) {
      if (!gameTaken) return;
    } else if (gameTaken) return;
    const pick = materialize(entry, { sameGame });
    card.push(pick);
    added.push(pick);
    const takenKey = matchupKey(pick);
    if (takenKey) usedGames.add(takenKey);
  };

  for (const kind of order) {
    for (const entry of buckets[kind]) take(entry, false);
  }
  if (allow && card.length < target) {
    for (const kind of order) {
      for (const entry of buckets[kind]) take(entry, true);
    }
  }
  return {
    picks: card,
    added,
    exhausted: card.length < target,
  };
}

function stampReservePick(row, kind, modelVersion) {
  const lean = false; // NO LEANS on the 2026-10-18 rerun card: all straights.
  const src = {
    ...row,
    tier: lean ? 'lean' : 'floor',
  };
  if (kind === 'paired') {
    src.pairedFill = true;
    src.label = 'floor';
    src.leanReason = row.leanReason || 'paired-ev';
  }
  const pick = toPickObject(src, { modelVersion: modelVersion || row.modelVersion });
  if (kind === 'paired' || row.pairedFill) {
    pick.pairedFill = true;
    pick.leanReason = row.leanReason || 'paired-ev';
  }
  if (row.sharpFairPriced === true) pick.sharpFairPriced = true;
  if (row.sharpFairReject) pick.sharpFairReject = row.sharpFairReject;
  if (typeof row.ev === 'number' && Number.isFinite(row.ev)) pick.evRaw = row.ev;
  if (row.hardRockPriced === true || row.hardRockPriced === false) pick.hardRockPriced = row.hardRockPriced === true;
  return pick;
}

/**
 * Next-best rows not on the card, in selectStraights order. Cap 12.
 * One-per-game is not applied here so a later drop can free that game.
 * Does not change which rows selectStraights would publish.
 */
function buildReserve(opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : RESERVE_CAP;
  const index = blockedIndex(opts.blocked);
  const onCard = opts.picks || [];
  const seen = [];
  const ranked = [];
  const push = (row, kind) => {
    if (!row) return;
    // Sheet gate (2026-10-18 rerun): reserve top-ups are published picks.
    // No sub-sheet candidate fills a short card from any reserve kind.
    if (!passesSheetMinimums(row)) return;
    if (isBlocked(row, index)) return;
    if (onCard.some((pick) => sameSideRow(pick, row))) return;
    if (seen.some((prev) => sameSideRow(prev, row))) return;
    seen.push(row);
    ranked.push({ row, kind });
  };
  const floors = [...(opts.yesPool || [])].filter((row) => passesPublishFloor(row)).sort(compareByEv);
  for (const row of floors) push(row, 'floor');
  const leans = [...(opts.leanPool || [])].sort(compareByEv);
  for (const row of leans) {
    if (passesLeanFill(row)) push(row, 'posLean');
  }
  for (const row of leans) {
    if (eligibleForLeanPool(row)) push(row, 'anyLean');
  }
  const paired = [...(opts.pairedPool || [])].sort(compareByEv);
  for (const row of paired) {
    if (row && (row.pairedFill === true || eligiblePairedFill(row))) push(row, 'paired');
  }
  return ranked.slice(0, Math.max(0, limit)).map((item) => stampReservePick(item.row, item.kind, opts.modelVersion));
}

/**
 * Hard Rock + majors decision for one new reserve row. No odds pull.
 * Unknown Hard Rock does not drop. A failed Hard Rock drops only when
 * stored majors coverage also fails.
 */
function reservePlaceabilityDecision(pick) {
  if (!pick) return { drop: false, reason: null };
  let hr;
  if (pick.hardRockPriced === true) hr = { available: true, errors: [], warnings: [] };
  else if (pick.hardRockPriced === false) hr = { available: false, errors: ['Hard Rock missed'], warnings: [] };
  else hr = { unknowable: true };
  return verifyPlaceabilityDecision({
    pick,
    hr,
    apiDown: false,
    feedDown: false,
    gameMissing: false,
  });
}

function topUpReason(pick) {
  return pick && pick.sameGameFill ? 'same-game' : 'short-card';
}

function topUpRecord(pick) {
  return {
    pick: (pick && (pick.pick || pick.side)) || '',
    from: 'reserve',
    reason: topUpReason(pick),
  };
}

/**
 * Placeability on the rows just added. A failure is blocked and the next
 * reserve row is tried. maxRounds stops the loop.
 */
function topUpWithPlaceability(opts = {}) {
  const target = Number.isFinite(Number(opts.target)) ? Number(opts.target) : MAX_STRAIGHTS;
  const maxRounds = Number.isFinite(Number(opts.maxRounds)) ? Number(opts.maxRounds) : MAX_PLACEABILITY_ROUNDS;
  const decide = typeof opts.decide === 'function' ? opts.decide : reservePlaceabilityDecision;
  let card = (opts.picks || []).slice();
  let pool = (opts.reserve || []).slice();
  const blockedRows = (opts.blocked || []).slice();
  const added = [];
  const topUps = [];
  let rounds = 0;
  while (card.length < target && pool.length && rounds < maxRounds) {
    rounds += 1;
    const up = topUpStraights({
      picks: card,
      reserve: pool,
      blocked: blockedRows,
      target,
      allowSameGame: opts.allowSameGame,
    });
    const fresh = up.added || [];
    if (!fresh.length) {
      card = up.picks;
      break;
    }
    const failed = [];
    const kept = [];
    for (const row of fresh) {
      let decision = { drop: false };
      try {
        decision = decide(row) || { drop: false };
      } catch (err) {
        decision = { drop: false };
      }
      if (decision.drop) {
        failed.push(row);
        blockedRows.push(row);
      } else {
        kept.push(row);
        topUps.push(topUpRecord(row));
      }
    }
    const freshIds = fresh.map((row) => `${gameName(row)}||${sideLabel(row)}`);
    pool = pool.filter((row) => !freshIds.includes(`${gameName(row)}||${sideLabel(row)}`));
    card = card.concat(kept);
    added.push(...kept);
    if (!failed.length) break;
  }
  return {
    picks: card,
    added,
    exhausted: card.length < target,
    reserve: pool,
    topUps,
    blocked: blockedRows,
  };
}

function filterBlocked(rows, blocked) {
  const index = blockedIndex(blocked);
  return (rows || []).filter((row) => row && !isBlocked(row, index));
}

function reserveLeft(reserve, picks, blocked) {
  const index = blockedIndex(blocked);
  return (reserve || []).filter((row) => {
    if (!row) return false;
    if (isBlocked(row, index)) return false;
    if ((picks || []).some((pick) => sameSideRow(pick, row))) return false;
    return true;
  });
}

/**
 * Top up, rebuild the parlay from the straights plus the same pool with
 * blocked sides removed, then apply the daily unit cap. Placeability
 * rounds run only when `decide` or `checkPlaceability` is set.
 */
function finishShortCard(opts = {}) {
  const target = Number.isFinite(Number(opts.target)) ? Number(opts.target) : MAX_STRAIGHTS;
  const checking = typeof opts.decide === 'function' || opts.checkPlaceability === true;
  const up = checking
    ? topUpWithPlaceability(opts)
    : topUpStraights(opts);
  const blocked = up.blocked || opts.blocked;
  const pool = filterBlocked(opts.parlayPool || [], blocked);
  const parlayLegs = parlayFromStraights(up.picks, {
    pool,
    hrPlaceabilityNote: opts.hrNote,
  });
  const capped = applyDailyUnitCap(up.picks, parlayLegs);
  const added = (up.added || []).map((row) => {
    const match = capped.picks.find((pick) => sameSideRow(pick, row));
    return match || row;
  });
  const topUps = added.map(topUpRecord);
  return {
    picks: capped.picks,
    parlayLegs: capped.parlayLegs,
    added,
    exhausted: capped.picks.length < target,
    reserve: reserveLeft(opts.reserve, capped.picks, blocked),
    topUps,
    rebuilt: true,
  };
}

/**
 * Generate hook. Reserve is always built. The parlay is rebuilt only when
 * the card is short of 3, so a full card's ticket is left as generate set it.
 */
function applyGenerateReserve(opts = {}) {
  const picks = Array.isArray(opts.picks) ? opts.picks : [];
  const reserve = buildReserve({
    yesPool: opts.yesPool,
    leanPool: opts.leanPool,
    pairedPool: opts.pairedPool,
    picks,
    blocked: opts.blocked,
    modelVersion: opts.modelVersion,
    limit: opts.limit,
  });
  if (picks.length >= MAX_STRAIGHTS) {
    return {
      picks,
      parlayLegs: null,
      reserve,
      added: [],
      topUps: [],
      exhausted: false,
      rebuilt: false,
    };
  }
  const finished = finishShortCard({
    picks,
    reserve,
    blocked: opts.blocked,
    parlayPool: opts.parlayPool,
    hrNote: opts.hrNote,
    allowSameGame: opts.allowSameGame,
    target: opts.target,
  });
  return finished;
}

module.exports = {
  RESERVE_CAP,
  MAX_PLACEABILITY_ROUNDS,
  topUpStraights,
  buildReserve,
  finishShortCard,
  applyGenerateReserve,
  reservePlaceabilityDecision,
  topUpWithPlaceability,
  sideBlocked,
};
