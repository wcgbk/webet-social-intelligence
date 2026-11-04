'use strict';

/**
 * 10:15 ET news re-rank.
 * Uses the prices already on the 10:00 card. Does not call the Odds API.
 * A postponed game or a main that falls under the 2% EV floor is replaced
 * from that priced pool. Rank is stake EV, then edge. ESPN failure, or a
 * clock after 10:30 ET, keeps the 10:00 card (last known good). A row
 * under the floor that is not ev-stale can fill as a lean.
 */

const { etParts } = require('../et-schedule');
const { runLateNews } = require('./late_news');
const {
  selectStraights,
  passesPublishFloor,
  passesLeanFill,
  toPickObject,
  straightCardLabel,
  matchupKey,
} = require('./select');
const { parlayFromStraights } = require('./parlay');
const { finishShortCard } = require('./card_topup');
const { parseEdgeFraction, writeSummaryStakeDisplay } = require('./odds_math');
const { recordRankedList, top10Rows } = require('./selection_pass');
const { compareByEv } = require('./select');
const { GATES } = require('./config');
const { CONTEXT_INPUTS } = require('./timeline');

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
  let parlayLegs = parlayFromStraights(nextPicks, { pool });
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
};
