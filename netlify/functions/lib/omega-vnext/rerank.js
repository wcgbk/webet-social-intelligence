'use strict';

/**
 * 10:15 ET news re-rank.
 * Uses the prices already on the 10:00 card. Does not call the Odds API.
 *
 * Runtime before the helper restore: the module loads (missing exports are
 * `undefined`, not a load error). rerankCard then throws
 * `passesPublishFloor is not a function` at the v1 floor loop, after news
 * and before any write. The 10:15 handler does not catch it, so the 10:00
 * card stays. admin-run-omega-chain logs the throw and continues.
 * The helpers are restored in select_floor.js. select.js stays frozen
 * (omega-v2 gate vs a592e0b).
 *
 * A v2 card (engine omega-v2 or selectionRule force-top3) never takes that
 * v1 floor. OMEGA_V2_NEWS_RERANK defaults on. It drops a leg only for hard
 * news (ESPN postponed/canceled) or an already-stored QA hard-fail, refills
 * that slot from the card's own ranked pool in v2 order, and rebuilds the
 * same-3 parlay with the v2 builder. No stored pool keeps the 10:00 card.
 * =off rollback: a v2 card is returned unchanged and nothing is written.
 * That matches the pre-fix outcome (throw before write) without applying
 * v1 selection to the v2 card.
 *
 * A non-v2 card still uses the v1 floor path below. ESPN failure, or a
 * clock after 10:30 ET, keeps the 10:00 card (last known good).
 */

const { etParts } = require('../et-schedule');
const { runLateNews } = require('./late_news');
const {
  selectStraights,
  toPickObject,
  matchupKey,
} = require('./select');
const {
  passesPublishFloor,
  passesLeanFill,
  straightCardLabel,
  compareByEv,
} = require('./select_floor');
const { parlayFromStraights } = require('./parlay_straights');
const { finishShortCard } = require('./card_topup');
const { parseEdgeFraction } = require('./odds_math');
const { writeSummaryStakeDisplay } = require('./stake_display');
const { recordRankedList, top10Rows } = require('./selection_pass');
const { GATES } = require('./config');
const { CONTEXT_INPUTS } = require('./timeline');
const { defaultOnFlag } = require('../default_on_flag');
const { summaryFrom } = require('./assemble');
const { gameKey, orderForcedPool, favoriteOutOfBand } = require('../omega-v2/select');
const { missingImportsC } = require('./missing_import_flag');
const { sizeForcedStraights } = require('../omega-v2/size');
const { buildForcedParlay } = require('../omega-v2/parlay');
const { toPick, toParlay } = require('../omega-v2/guards');

/** Default on. OMEGA_V2_NEWS_RERANK=off / 0 / false keeps the 10:00 v2 card. */
function newsRerankEnabled(env) {
  return defaultOnFlag('OMEGA_V2_NEWS_RERANK', env);
}

function isV2Card(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.engine === 'omega-v2') return true;
  if (card.selectionRule === 'force-top3') return true;
  const pipe = card.pipelineV2;
  if (pipe && typeof pipe === 'object') {
    if (pipe.selectionRule === 'force-top3') return true;
    if (pipe.parlaySource === 'top3-straights') return true;
  }
  const model = String(card.model || card.modelVersion || '');
  return model.indexOf('omega-v2') !== -1;
}

const RERANK_WITHIN_MIN = 20 * 60;
const CUTOFF_MIN = 10 * 60 + 30;

function pastRerankCutoff(now) {
  const when = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(when.getTime())) return true;
  const parts = etParts(when);
  return parts.hour * 60 + parts.minute > CUTOFF_MIN;
}

function guardFetch(fetchImpl) {
  const base = fetchImpl || global.fetch;
  return async function rerankFetch(url, opts) {
    const text = String(url && url.url ? url.url : url || '');
    if (/the-odds-api\.com/i.test(text)) {
      throw new Error('rerank refused an Odds API pull');
    }
    if (typeof base !== 'function') {
      throw new Error('rerank has no news fetch');
    }
    return base(url, opts);
  };
}

function sideOf(row) {
  return String((row && (row.side || row.pick)) || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function betSame(a, b) {
  if (!a || !b) return false;
  return matchupKey(a) === matchupKey(b) && sideOf(a) === sideOf(b);
}

function numEv(row) {
  if (!row) return null;
  if (row.evRaw != null && Number.isFinite(Number(row.evRaw))) return Number(row.evRaw);
  if (typeof row.ev === 'number' && Number.isFinite(row.ev)) return row.ev;
  if (typeof row.ev === 'string' && row.ev.trim().endsWith('%')) {
    const n = parseFloat(row.ev);
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(row.ev);
  return Number.isFinite(n) ? n : null;
}

function numEdge(row) {
  if (!row) return null;
  return parseEdgeFraction(row.edgePct != null ? row.edgePct : row.edge);
}

function numCover(row) {
  if (!row || row.coverProb == null || row.coverProb === '') return null;
  if (typeof row.coverProb === 'string' && row.coverProb.trim().endsWith('%')) {
    const n = parseFloat(row.coverProb);
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(row.coverProb);
  if (!Number.isFinite(n)) return null;
  return n > 1 && n <= 100 ? n / 100 : n;
}

function asCandidate(row) {
  if (!row) return null;
  const edge = numEdge(row);
  const ev = numEv(row);
  const cover = numCover(row);
  const odds = typeof row.odds === 'number' ? row.odds : row.odds;
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    edgePct: edge,
    ev,
    coverProb: cover != null ? cover : row.coverProb,
    odds,
    tier: row.tier === 'lean' ? 'lean' : 'floor',
  };
}

function poolFromCard(card, extra) {
  const rows = [];
  const pushAll = (list) => {
    for (const row of list || []) {
      const c = asCandidate(row);
      if (!c || !c.side || !(c.matchup || (c.homeTeam && c.awayTeam))) continue;
      if (!rows.some((prev) => betSame(prev, c))) rows.push(c);
    }
  };
  pushAll(extra);
  pushAll(card && card.candidateTable);
  pushAll(card && card.selection && card.selection.top10);
  pushAll(card && card.picks);
  return rows;
}

function newsFailed(news) {
  if (!news || news.softFail) return true;
  const errors = Array.isArray(news.errors) ? news.errors : [];
  if (!errors.length) return false;
  const checks = Array.isArray(news.checks) ? news.checks : [];
  if (!checks.length) return true;
  return checks.every((row) => !row || !row.matched);
}

function edgeMoved(before, after) {
  const a = numEdge(before);
  const b = numEdge(after);
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > 1e-6;
}

/**
 * Late news can drop a straight. selectStraights refills from the priced
 * pool when that pool still has a row. If the card is still short, the
 * private reserve fills the open slots. A voided game stays blocked.
 */
function topUpFromReserve(working, news, pool) {
  const reserve = working && working.reserve;
  if (!working || !Array.isArray(working.picks) || working.picks.length >= 3) return null;
  if (!Array.isArray(reserve) || !reserve.length) return null;
  const blocked = [];
  for (const row of working.voidedPregame || []) {
    if (row) blocked.push({ ...row, void: true });
  }
  for (const name of (news && news.removed) || []) {
    if (name) blocked.push({ pick: name, side: name });
  }
  const allBlocked = require('./card_integrity').blockedRowsFor(working, blocked);
  const finished = finishShortCard({
    picks: working.picks,
    reserve,
    blocked: allBlocked,
    parlayPool: (pool || []).concat(working.picks, reserve),
  });
  if (!finished.added.length) return finished;
  working.picks = finished.picks;
  working.parlayLegs = finished.parlayLegs;
  working.reserve = finished.reserve;
  if (!working.summary || typeof working.summary !== 'object') working.summary = {};
  working.summary.topUps = finished.topUps;
  working.summary.totalPicks = finished.picks.length;
  working.summary.totalStraightBets = finished.picks.length;
  writeSummaryStakeDisplay(working.summary, finished.picks, finished.parlayLegs);
  const integrity = require('./card_integrity').applyCardIntegrity(working);
  Object.assign(working, integrity.card);
  return finished;
}

function hardStatus(action) {
  if (!action || action.action !== 'drop') return false;
  const code = String(action.code || '').toLowerCase();
  if (code === 'postponed' || code === 'canceled' || code === 'cancelled') return true;
  return /postpon|cancel/i.test(String(action.reason || ''));
}

function namesMatch(a, b) {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  return !!left && left === right;
}

function qaMatchesPick(pick, fail) {
  if (!fail || fail.hardFail === false) return false;
  const side = fail.side || fail.pick;
  const matchup = fail.matchup;
  if (!side && !matchup) return false;
  if (side && !namesMatch(side, pick.pick || pick.side)) return false;
  if (matchup && !namesMatch(matchup, pick.matchup)) return false;
  return true;
}

/** Indexes of legs hard news or a stored QA hard-fail says to drop. */
function hardDropIndexes(card, news) {
  const picks = (card && card.picks) || [];
  const drop = new Set();
  for (const action of (news && news.actions) || []) {
    if (!hardStatus(action)) continue;
    const name = action.pick || action.side;
    const matchup = action.matchup;
    picks.forEach((pick, i) => {
      if (name && !namesMatch(name, pick.pick || pick.side)) return;
      if (matchup && !namesMatch(matchup, pick.matchup)) return;
      if (!name && !matchup) return;
      drop.add(i);
    });
  }
  const fails = [].concat(card && card.qaHardFails || [], card && card.hardFails || []);
  picks.forEach((pick, i) => {
    if (fails.some((fail) => qaMatchesPick(pick, fail))) drop.add(i);
  });
  return drop;
}

function storedRankedPool(card, extra) {
  const lists = [
    extra,
    card && card.rankedPool,
    card && card.v2RankedPool,
    card && card.pipelineV2 && card.pipelineV2.rankedPool,
    card && card.selection && card.selection.rankedPool,
  ];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) return list;
  }
  return null;
}

function gameOf(row) {
  if (!row) return '';
  if (row.gameKey != null && row.gameKey !== '') return String(row.gameKey);
  return gameKey(row.matchup || `${row.awayTeam || ''} @ ${row.homeTeam || ''}`);
}

function unitsNum(row) {
  const n = Number(row && row.unitsNum != null ? row.unitsNum : String(row && row.units || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function fractionOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) > 1 ? v / 100 : v;
  const n = parseFloat(String(v).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return /%/.test(String(v)) || Math.abs(n) > 1 ? n / 100 : n;
}

function americanOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
  const n = Number(String(v == null ? '' : v).trim().replace(/[−–]/g, '-').replace(/^\+/, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Published straight → v2 leg for buildForcedParlay. Does not resize the straight. */
function publishedPickToLeg(pick) {
  const odds = americanOf(pick.odds);
  const pBet = Number(pick.pBet);
  const fromCover = fractionOf(pick.coverProb != null ? pick.coverProb : pick.winProbability);
  const pCal = Number(pick.pCal != null ? pick.pCal : pick.pModelCal);
  const p = Number.isFinite(pBet) ? pBet : (Number.isFinite(fromCover) ? fromCover : (Number.isFinite(pCal) ? pCal : null));
  const edge = fractionOf(pick.edgePct != null ? pick.edgePct : pick.edge);
  const ev = Number(pick.evRaw);
  const calP = Number.isFinite(pCal) ? pCal : p;
  return {
    sport: pick.sport,
    matchup: pick.matchup,
    pick: pick.pick || pick.side,
    market: pick.market || pick.betType,
    marketFamily: pick.betType || pick.market,
    odds: odds != null ? odds : pick.odds,
    line: pick.line != null ? pick.line : null,
    book: pick.book || null,
    homeTeam: pick.homeTeam || null,
    awayTeam: pick.awayTeam || null,
    commenceTime: pick.commenceTime || '',
    pBet: p,
    edge: edge != null ? edge : 0,
    ev: Number.isFinite(ev) ? ev : 0,
    edgeNovig: pick.edgeNovig != null ? pick.edgeNovig : null,
    forced: true,
    units: unitsNum(pick),
    stakeUsd: pick.stakeUsd,
    coreReasoning: pick.coreReasoning || '',
    gameKey: gameOf(pick),
    calibration: {
      pCal: Number.isFinite(calP) ? calP : 0.5,
      pMkt: Number.isFinite(Number(pick.pMkt)) ? Number(pick.pMkt) : (Number.isFinite(calP) ? calP : 0.5),
      pModel: Number.isFinite(Number(pick.pModel)) ? Number(pick.pModel) : (Number.isFinite(calP) ? calP : 0.5),
      method: pick.calibrationMethod || 'board',
    },
  };
}

function withCalibration(row) {
  if (row && row.calibration && row.calibration.pCal != null) return row;
  const p = Number(row && row.pBet);
  const fallback = Number.isFinite(p) ? p : 0.5;
  return {
    ...(row || {}),
    calibration: {
      pCal: fallback,
      pMkt: row && row.pMkt != null ? row.pMkt : fallback,
      pModel: row && row.pModel != null ? row.pModel : fallback,
      method: 'board',
    },
  };
}

function materializeReplacement(row) {
  const ready = withCalibration({ ...row, forced: true });
  let sized;
  try {
    sized = sizeForcedStraights([ready]);
  } catch (e) {
    return null;
  }
  const one = sized && sized[0];
  if (!one || one.skipped) return null;
  if (!one.calibration) one.calibration = ready.calibration;
  try {
    return { pick: toPick(one), leg: one };
  } catch (e) {
    return null;
  }
}

function refreshStakeSummary(card) {
  if (!card.summary || typeof card.summary !== 'object') card.summary = {};
  const next = summaryFrom(card.picks, card.parlayLegs, {});
  card.summary.totalPicks = next.totalPicks;
  card.summary.totalStraightBets = next.totalStraightBets;
  card.summary.totalUnits = next.totalUnits;
  card.summary.sportsCovered = next.sportsCovered;
  const parseU = (x) => parseFloat(String(x || '0').replace(/[^0-9.]/g, '')) || 0;
  const straightU = (card.picks || []).reduce((s, p) => s + parseU(p.units), 0);
  const parlayU = (card.parlayLegs || []).reduce((s, pl) => s + parseU(pl.units), 0);
  card.straightUnits = +straightU.toFixed(2);
  card.parlayUnits = +parlayU.toFixed(2);
  card.totalUnits = +(straightU + parlayU).toFixed(2);
}

function rowOutOfBand(row) {
  if (row && row.inBand === false) return true;
  if (row && row.inBand === true) return false;
  return favoriteOutOfBand(row);
}

/** Stored forced order, then in-band rows ahead of out-of-band when asked. */
function orderRefillPool(pool, opts) {
  const ordered = orderForcedPool(pool || [], {
    pregameAsOfMs: opts && opts.pregameAsOfMs,
    env: opts && opts.env,
  });
  if (!opts || opts.inBandFirst !== true) return ordered;
  const inBand = [];
  const outBand = [];
  for (const row of ordered) {
    if (rowOutOfBand(row)) outBand.push(row);
    else inBand.push(row);
  }
  return inBand.concat(outBand);
}

function actionIsPostponed(action) {
  if (!action) return false;
  const code = String(action.code || action.status || '').toLowerCase();
  if (code === 'postponed' || code === 'canceled' || code === 'cancelled') return true;
  return /postpon|cancel/i.test(String(action.reason || ''));
}

function newsMatchesPick(action, pick) {
  if (!action || !pick) return false;
  const name = action.pick || action.side;
  const matchup = action.matchup;
  if (name && !namesMatch(name, pick.pick || pick.side)) return false;
  if (matchup && !namesMatch(matchup, pick.matchup)) return false;
  if (!name && !matchup) return false;
  return true;
}

/** Every dropped index is a postponed or cancelled game, not a reprice. */
function dropsArePostponed(card, news, dropIndexes) {
  const picks = (card && card.picks) || [];
  const fails = [].concat((card && card.qaHardFails) || [], (card && card.hardFails) || []);
  for (const i of dropIndexes) {
    const pick = picks[i];
    if (!pick) return false;
    const fromNews = ((news && news.actions) || []).some((action) => (
      action && action.action === 'drop' && actionIsPostponed(action) && newsMatchesPick(action, pick)
    ));
    const fromQa = fails.some((fail) => qaMatchesPick(pick, fail) && actionIsPostponed(fail));
    if (!fromNews && !fromQa) return false;
  }
  return dropIndexes.size > 0;
}

function stampRefillCard(original, nextPicks, parlayLegs, meta) {
  const next = JSON.parse(JSON.stringify(original));
  next.picks = nextPicks;
  next.parlayLegs = parlayLegs;
  next.parlaySource = 'top3-straights';
  next.v2Refill = meta;
  refreshStakeSummary(next);
  return next;
}

function publishShortV2(original, drops) {
  const nextPicks = [];
  const sources = [];
  const removed = [];
  for (let i = 0; i < original.picks.length; i += 1) {
    if (drops.has(i)) {
      removed.push(original.picks[i].pick || original.picks[i].side || `leg ${i}`);
      continue;
    }
    const kept = JSON.parse(JSON.stringify(original.picks[i]));
    nextPicks.push(kept);
    sources.push(publishedPickToLeg(kept));
  }
  console.warn(`[omega-v2] v2 refill published ${nextPicks.length} straights: postponed/cancelled and ranked pool empty (${removed.join(', ')})`);
  let parlayLegs = [];
  if (sources.length >= 2) {
    try {
      const ticket = buildForcedParlay(sources);
      if (ticket && ticket.publish && (ticket.legs || []).length === sources.length) {
        parlayLegs = toParlay(ticket, sources.length);
      }
    } catch (e) {
      console.warn(`[omega-v2] v2 short parlay failed (${e && e.message ? e.message : 'error'})`);
      parlayLegs = [];
    }
  }
  const next = stampRefillCard(original, nextPicks, parlayLegs, {
    type: 'short',
    removed,
    reason: 'postponed-empty-pool',
  });
  return {
    changed: true,
    card: next,
    reason: 'v2-short',
    refilled: [],
    short: true,
    keptOriginal: false,
  };
}

/**
 * Replace dropped v2 straights from the stored ranked pool.
 * In-band rows go first when opts.inBandFirst is set. Started games are
 * already out of orderForcedPool. Same game and blocked games are skipped.
 * No eligible row keeps the original card. allowShort publishes fewer than
 * 3 only when the pool itself is missing.
 */
function refillV2Dropped(original, opts = {}) {
  const drops = opts.dropIndexes instanceof Set ? opts.dropIndexes : new Set(opts.dropIndexes || []);
  if (!original || !Array.isArray(original.picks) || !drops.size) {
    return {
      changed: false, card: original, reason: 'unchanged', refilled: [], short: false, keptOriginal: true,
    };
  }
  const pool = storedRankedPool(original, opts.pool);
  if (!pool) {
    if (opts.allowShort) return publishShortV2(original, drops);
    console.warn('[omega-v2] v2 refill kept card: no stored ranked pool');
    return {
      changed: false, card: original, reason: 'no-v2-pool', refilled: [], short: false, keptOriginal: true,
    };
  }
  const blocked = new Set();
  const used = new Set();
  for (let i = 0; i < original.picks.length; i += 1) {
    const g = gameOf(original.picks[i]);
    if (!g) continue;
    if (drops.has(i)) blocked.add(g);
    else used.add(g);
  }
  let ordered;
  try {
    ordered = orderRefillPool(pool, opts);
  } catch (e) {
    console.warn(`[omega-v2] v2 refill kept card: pool order failed (${e && e.message ? e.message : 'error'})`);
    return {
      changed: false, card: original, reason: 'no-v2-pool', refilled: [], short: false, keptOriginal: true,
    };
  }
  let cursor = 0;
  const takeNext = () => {
    while (cursor < ordered.length) {
      const row = ordered[cursor];
      cursor += 1;
      const g = gameOf(row);
      if (!g || blocked.has(g) || used.has(g)) continue;
      const built = materializeReplacement(row);
      if (!built) continue;
      used.add(g);
      return built;
    }
    return null;
  };
  const nextPicks = [];
  const sources = [];
  const refilled = [];
  for (let i = 0; i < original.picks.length; i += 1) {
    if (!drops.has(i)) {
      const kept = JSON.parse(JSON.stringify(original.picks[i]));
      nextPicks.push(kept);
      sources.push(publishedPickToLeg(kept));
      continue;
    }
    const built = takeNext();
    if (!built) {
      console.warn('[omega-v2] v2 refill kept card: ranked pool could not refill');
      return {
        changed: false, card: original, reason: 'pool-short', refilled: [], short: false, keptOriginal: true,
      };
    }
    nextPicks.push(built.pick);
    sources.push(built.leg);
    refilled.push(built.pick.pick || built.pick.side);
  }
  let ticket;
  try {
    ticket = buildForcedParlay(sources);
  } catch (e) {
    console.warn(`[omega-v2] v2 refill kept card: parlay builder failed (${e && e.message ? e.message : 'error'})`);
    return {
      changed: false, card: original, reason: 'parlay-rebuild-failed', refilled: [], short: false, keptOriginal: true,
    };
  }
  if (!ticket || !ticket.publish || (ticket.legs || []).length !== nextPicks.length) {
    console.warn('[omega-v2] v2 refill kept card: v2 parlay did not publish the same straights');
    return {
      changed: false, card: original, reason: 'parlay-rebuild-failed', refilled: [], short: false, keptOriginal: true,
    };
  }
  let parlayLegs;
  try {
    parlayLegs = toParlay(ticket, sources.length);
  } catch (e) {
    console.warn(`[omega-v2] v2 refill kept card: parlay format failed (${e && e.message ? e.message : 'error'})`);
    return {
      changed: false, card: original, reason: 'parlay-rebuild-failed', refilled: [], short: false, keptOriginal: true,
    };
  }
  if (!parlayLegs.length || (parlayLegs[0].legs || []).length !== nextPicks.length) {
    console.warn('[omega-v2] v2 refill kept card: parlay leg count drifted');
    return {
      changed: false, card: original, reason: 'parlay-rebuild-failed', refilled: [], short: false, keptOriginal: true,
    };
  }
  const next = stampRefillCard(original, nextPicks, parlayLegs, {
    type: 'refill',
    refilled,
    reason: 'ranked-pool',
  });
  return {
    changed: true,
    card: next,
    reason: 'v2-refill',
    refilled,
    short: false,
    keptOriginal: false,
  };
}

/**
 * v2 cards use the same-3 builder. Every other card still uses
 * parlayFromStraights, which throws while the flag is off.
 */
function parlayLegsForCard(card, picks, opts) {
  if (isV2Card(card) && missingImportsC()) {
    const legs = (picks || []).map((pick) => publishedPickToLeg(pick));
    try {
      const ticket = buildForcedParlay(legs);
      if (!ticket || !ticket.publish || (ticket.legs || []).length !== legs.length) {
        console.warn('[omega-v2] v2 parlay kept: same-3 builder did not publish');
        return Array.isArray(card && card.parlayLegs) ? card.parlayLegs : [];
      }
      const built = toParlay(ticket, legs.length);
      if (!built.length || (built[0].legs || []).length !== legs.length) {
        console.warn('[omega-v2] v2 parlay kept: same-3 leg count drifted');
        return Array.isArray(card && card.parlayLegs) ? card.parlayLegs : [];
      }
      return built;
    } catch (e) {
      console.warn(`[omega-v2] v2 parlay kept: same-3 builder failed (${e && e.message ? e.message : 'error'})`);
      return Array.isArray(card && card.parlayLegs) ? card.parlayLegs : [];
    }
  }
  return parlayFromStraights(picks, opts);
}

/**
 * 10:45 kill on a v2 card. Refill from the locked snapshot's ranked pool
 * and skip the locked-parlay resize. A miss restores that snapshot.
 */
function applyV2VerifyRefill(picksData, opts = {}) {
  if (!missingImportsC() || !isV2Card(picksData)) {
    return { handled: false, restored: false, changed: false, skipLockedParlay: false };
  }
  const snapshot = opts.snapshot;
  if (!snapshot || !Array.isArray(snapshot.picks)) {
    return { handled: false, restored: false, changed: false, skipLockedParlay: false };
  }
  const current = Array.isArray(picksData.picks) ? picksData.picks : [];
  const dropIndexes = new Set();
  snapshot.picks.forEach((pick, i) => {
    const still = current.some((row) => (
      namesMatch(row && (row.pick || row.side), pick && (pick.pick || pick.side))
      && (!pick.matchup || !(row && row.matchup) || namesMatch(row.matchup, pick.matchup))
    ));
    if (!still) dropIndexes.add(i);
  });
  if (!dropIndexes.size) {
    return { handled: true, restored: false, changed: false, skipLockedParlay: false, reason: 'unchanged' };
  }
  const source = {
    ...snapshot,
    rankedPool: snapshot.rankedPool || picksData.rankedPool,
    engine: snapshot.engine || picksData.engine,
    selectionRule: snapshot.selectionRule || picksData.selectionRule,
  };
  const postponed = opts.postponed === true || dropsArePostponed(source, opts.news, dropIndexes);
  const pool = storedRankedPool(source, opts.pool);
  const filled = refillV2Dropped(source, {
    dropIndexes,
    pool: opts.pool,
    env: opts.env,
    pregameAsOfMs: opts.pregameAsOfMs != null ? opts.pregameAsOfMs : Date.now(),
    allowShort: postponed && !pool,
    inBandFirst: true,
  });
  if (!filled.changed) {
    picksData.picks = JSON.parse(JSON.stringify(snapshot.picks));
    picksData.parlayLegs = JSON.parse(JSON.stringify(snapshot.parlayLegs || []));
    console.warn(`[omega-v2] verify kept locked v2 card: ${filled.reason}`);
    return {
      handled: true,
      restored: true,
      changed: false,
      skipLockedParlay: true,
      reason: filled.reason,
    };
  }
  picksData.picks = filled.card.picks;
  picksData.parlayLegs = filled.card.parlayLegs;
  picksData.parlaySource = 'top3-straights';
  picksData.v2Refill = filled.card.v2Refill;
  return {
    handled: true,
    restored: false,
    changed: true,
    skipLockedParlay: true,
    reason: filled.reason,
    refilled: filled.refilled,
    short: filled.short === true,
  };
}

/**
 * v2 card: hard news only. Surviving straights keep price, units, and grade.
 * The open slot is the next row in v2 order on a game that is still on.
 * The parlay is rebuilt from those straights by the v2 builder.
 */
async function rerankV2Card(original, opts, now) {
  const runNews = opts.runNews || runLateNews;
  const scratch = JSON.parse(JSON.stringify(original));
  let news;
  try {
    news = await runNews({
      picksData: scratch,
      now,
      fetchImpl: guardFetch(opts.fetchImpl),
      withinMin: RERANK_WITHIN_MIN,
      dateISO: original.date || null,
    });
  } catch (e) {
    return keepOriginal(original, 'news-failed', {
      error: e && e.message ? e.message : 'news failed',
    });
  }
  if (newsFailed(news)) {
    return keepOriginal(original, 'news-failed', {
      errors: (news && news.errors) || [],
    });
  }
  const drops = hardDropIndexes(original, news);
  if (!drops.size) {
    return {
      card: original,
      changed: false,
      lastKnownGood: false,
      reason: 'unchanged',
      oddsApi: false,
      dropped: 0,
    };
  }
  const pool = storedRankedPool(original, opts.pool);
  const flagOn = missingImportsC();
  const postponed = dropsArePostponed(original, news, drops);
  const filled = refillV2Dropped(original, {
    dropIndexes: drops,
    pool: opts.pool,
    env: opts.env,
    pregameAsOfMs: now.getTime(),
    allowShort: flagOn && postponed && !pool,
    inBandFirst: flagOn,
  });
  if (!filled.changed) {
    return keepOriginal(original, filled.reason, { dropped: drops.size });
  }
  const next = filled.card;
  const short = filled.short === true;
  next.selection = next.selection && typeof next.selection === 'object' ? next.selection : {};
  next.selection.window = '10:00-10:15';
  next.selection.rerankWindow = '10:15-10:30';
  next.selection.rerankedAt = now.toISOString();
  next.selection.rerankReason = short ? 'v2-short' : 'v2-hard-news';
  next.selection.rankedBy = 'v2-growth';
  next.selection.onePerGame = true;
  next.selection.oddsApi = false;
  next.selection.v2NewsRerank = true;
  next.newsRerank = {
    type: short ? 'v2-short' : 'v2-hard-news',
    dropped: drops.size,
    refilled: filled.refilled,
    oddsApi: false,
  };
  return {
    card: next,
    changed: true,
    lastKnownGood: false,
    reason: short ? 'v2-short' : 'v2-hard-news',
    oddsApi: false,
    dropped: drops.size,
    picks: next.picks.length,
    parlayLegs: next.parlayLegs.length ? (next.parlayLegs[0].legs || []).length : 0,
  };
}

function keepOriginal(original, reason, extra) {
  return {
    card: original,
    changed: false,
    lastKnownGood: true,
    reason,
    oddsApi: false,
    ...extra,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.card 10:00 card. Not mutated.
 * @param {Date|string|number} [opts.now]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.runNews] test double. Defaults to runLateNews.
 * @param {Array} [opts.pool] extra priced rows from the 10:00 candidate ledger.
 */
async function rerankCard(opts = {}) {
  const original = opts.card;
  if (!original || !Array.isArray(original.picks)) {
    return { card: original || null, changed: false, lastKnownGood: true, reason: 'no-card', oddsApi: false };
  }
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  if (pastRerankCutoff(now)) {
    return keepOriginal(original, 'after-1030');
  }
  if (isV2Card(original)) {
    if (!newsRerankEnabled(opts.env)) {
      return keepOriginal(original, 'v2-rerank-off');
    }
    return rerankV2Card(original, opts, now);
  }
  const working = JSON.parse(JSON.stringify(original));
  const runNews = opts.runNews || runLateNews;
  let news;
  try {
    news = await runNews({
      picksData: working,
      now,
      fetchImpl: guardFetch(opts.fetchImpl),
      withinMin: RERANK_WITHIN_MIN,
      dateISO: original.date || null,
    });
  } catch (e) {
    return keepOriginal(original, 'news-failed', {
      error: e && e.message ? e.message : 'news failed',
    });
  }
  if (newsFailed(news)) {
    return keepOriginal(original, 'news-failed', {
      errors: (news && news.errors) || [],
    });
  }

  if (original.timelineStep === '10:00' || (original.selection && original.selection.stage === 'top10')) {
    return rerankTop10(original, working, news, now);
  }

  const voidKeys = new Set();
  for (const row of working.voidedPregame || []) {
    if (row) voidKeys.add(matchupKey(row));
  }
  const survivors = (working.picks || []).map(asCandidate).filter(Boolean);
  const pool = poolFromCard(working, opts.pool).map((row) => {
    const hit = survivors.find((p) => betSame(p, row));
    if (!hit) return row;
    return {
      ...row,
      edgePct: hit.edgePct != null ? hit.edgePct : row.edgePct,
      ev: hit.ev != null ? hit.ev : row.ev,
      coverProb: hit.coverProb != null ? hit.coverProb : row.coverProb,
      tier: hit.tier || row.tier,
    };
  }).filter((row) => row && !voidKeys.has(matchupKey(row)));

  const floor = [];
  const leans = [];
  const seen = new Set();
  for (const row of pool) {
    const id = `${matchupKey(row)}|${sideOf(row)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = numEv(row);
    const maxEV = Number(GATES.maxEV);
    const stale = Number.isFinite(ev) && Number.isFinite(maxEV) && ev > maxEV + 1e-12;
    if (passesPublishFloor(row)) floor.push({ ...row, tier: 'floor' });
    else if (!stale && Number.isFinite(ev)) leans.push({ ...row, tier: 'lean' });
  }
  const selected = selectStraights(floor, 3, leans);
  const sameList = selected.length === original.picks.length
    && selected.every((row, i) => betSame(original.picks[i], row));
  const moved = (working.picks || []).some((row) => {
    const prev = (original.picks || []).find((p) => betSame(p, row));
    return prev && edgeMoved(prev, row);
  });
  if (sameList && !moved && !(news && news.dropped)) {
    return {
      card: original,
      changed: false,
      lastKnownGood: false,
      reason: 'unchanged',
      oddsApi: false,
      dropped: 0,
    };
  }

  let nextPicks = selected.map((row) => {
    const prev = (working.picks || []).find((p) => betSame(p, row));
    const prior = (original.picks || []).find((p) => betSame(p, row));
    if (prev && prior && !edgeMoved(prior, prev) && (prev.tier || 'floor') === (row.tier || 'floor')) {
      return prev;
    }
    const built = toPickObject({
      ...row,
      side: row.side || row.pick,
      market: row.market || row.betType,
      edgePct: numEdge(row),
      ev: numEv(row),
      coverProb: numCover(row),
      tier: row.tier || 'floor',
    }, { modelVersion: original.model || original.modelVersion });
    if (prev && prev.coreReasoning) built.coreReasoning = prev.coreReasoning;
    return built;
  });
  let parlayLegs = parlayLegsForCard(original, nextPicks, { pool });
  working.picks = nextPicks;
  working.parlayLegs = parlayLegs;
  const topped = topUpFromReserve(working, news, pool);
  if (topped && topped.added && topped.added.length) {
    nextPicks = working.picks;
    parlayLegs = working.parlayLegs;
  }
  working.selection = working.selection && typeof working.selection === 'object' ? working.selection : {};
  working.selection.window = '10:00-10:15';
  working.selection.rerankWindow = '10:15-10:30';
  working.selection.rankedBy = 'edge';
  working.selection.onePerGame = true;
  working.selection.top10 = recordRankedList(nextPicks, top10Rows(floor, 10));
  working.selection.rerankedAt = now.toISOString();
  working.selection.rerankReason = news && news.dropped ? 'news-drop' : 'news-reprice';
  working.selection.cardLabel = straightCardLabel(nextPicks);
  working.selection.oddsApi = false;
  if (working.summary && typeof working.summary === 'object') {
    working.summary.totalPicks = nextPicks.length;
    working.summary.totalStraightBets = nextPicks.length;
    writeSummaryStakeDisplay(working.summary, nextPicks, parlayLegs);
  }
  return {
    card: working,
    changed: true,
    lastKnownGood: false,
    reason: working.selection.rerankReason,
    oddsApi: false,
    dropped: (news && news.dropped) || 0,
    picks: nextPicks.length,
    parlayLegs: parlayLegs.length ? (parlayLegs[0].legs || []).length : 0,
  };
}

function rowId(row) {
  return `${matchupKey(row)}|${sideOf(row)}`;
}

/**
 * 10:15 on a 10:00 draft. Re-order the top 10. Do not cut the card to 3.
 * The new top 3 are marked selected so the 10:30 sort check can rebuild.
 * Prices stay the 10:00 snapshot.
 */
function rerankTop10(original, working, news, now) {
  const voidKeys = new Set();
  for (const row of working.voidedPregame || []) {
    if (row) voidKeys.add(matchupKey(row));
  }
  const top = JSON.parse(JSON.stringify((original.selection && original.selection.top10) || []));
  for (const row of top) {
    const hit = (working.picks || []).find((pick) => betSame(pick, row));
    if (!hit || !edgeMoved(
      (original.picks || []).find((pick) => betSame(pick, row)) || row,
      hit,
    )) continue;
    if (hit.edgePct != null) row.edgePct = hit.edgePct;
    if (hit.edge != null) row.edge = hit.edge;
    if (hit.ev != null) row.ev = hit.ev;
    if (hit.coverProb != null) row.coverProb = hit.coverProb;
  }
  const kept = top.filter((row) => row && !voidKeys.has(matchupKey(row)));
  kept.sort((a, b) => compareByEv(
    { edgePct: numEdge(a), ev: numEv(a) },
    { edgePct: numEdge(b), ev: numEv(b) },
  ));
  kept.forEach((row, i) => { row.selected = i < 3; });
  const before = ((original.selection && original.selection.top10) || []).map(rowId).join('|');
  const after = kept.map(rowId).join('|');
  working.selection = working.selection && typeof working.selection === 'object' ? working.selection : {};
  working.selection.top10 = kept;
  working.selection.contextInputs = CONTEXT_INPUTS.slice();
  working.selection.stage = 'reranked';
  working.selection.window = '10:00-10:15';
  working.selection.rerankWindow = '10:15-10:30';
  working.selection.rankedBy = 'edge';
  working.selection.onePerGame = true;
  working.selection.rerankedAt = now.toISOString();
  working.selection.rerankReason = news && news.dropped ? 'news-drop' : (before === after ? 'context' : 're-rank');
  working.selection.oddsApi = false;
  working.timelineStep = '10:15';
  working.cardStatus = 'draft';
  working.finalized = false;
  const topped = topUpFromReserve(working, news, kept);
  const changed = before !== after || original.timelineStep !== '10:15' || !!(topped && topped.added && topped.added.length);
  return {
    card: working,
    changed,
    lastKnownGood: false,
    reason: working.selection.rerankReason,
    oddsApi: false,
    dropped: (news && news.dropped) || 0,
    picks: (working.picks || []).length,
  };
}

module.exports = {
  RERANK_WITHIN_MIN,
  pastRerankCutoff,
  rerankCard,
  newsFailed,
  isV2Card,
  newsRerankEnabled,
  hardDropIndexes,
  refillV2Dropped,
  parlayLegsForCard,
  applyV2VerifyRefill,
  dropsArePostponed,
};
