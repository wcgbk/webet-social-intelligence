'use strict';

/**
 * 10:30 draft and Hard Rock check, 10:45 summaries, 11:00 finalization.
 * Uses the prices already on the card. Does not call the Odds API.
 * A failed check never blocks publish and never removes a straight.
 */

const { parseEdgeFraction } = require('./odds_math');
const { matchupKey } = require('./select');
const { parlayFromStraights, isNoQualifyingParlay } = require('./parlay');
const {
  applySilentSortCheck,
  reviewHardRock,
  placeableAtDisplayed,
} = require('./selection_pass');

const CONTEXT_INPUTS = ['news', 'weather', 'injury', 'depth-chart', 'team-form', 'stadium'];

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? {} : value));
}

function poolFrom(card) {
  const rows = [];
  const push = (list) => {
    for (const row of list || []) {
      if (row) rows.push(row);
    }
  };
  push(card && card.candidateTable);
  push(card && card.selection && card.selection.top10);
  push(card && card.picks);
  return rows;
}

function sideOf(row) {
  return String((row && (row.side || row.pick)) || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sameBet(a, b) {
  if (!a || !b) return false;
  return matchupKey(a) === matchupKey(b) && sideOf(a) === sideOf(b);
}

function americanOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return null;
  const n = parseInt(String(value).replace(/[^0-9\-+]/g, ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function hrAmericanFor(row) {
  const direct = row && row.hardRock;
  if (direct && Number.isFinite(Number(direct.american != null ? direct.american : direct.price))) {
    return Number(direct.american != null ? direct.american : direct.price);
  }
  const prices = row && row.bookPrices;
  if (!Array.isArray(prices)) return null;
  const hit = prices.find((p) => /hardrock/i.test(String((p && (p.book || p.key)) || '')));
  if (!hit) return null;
  const n = Number(hit.american != null ? hit.american : hit.price);
  return Number.isFinite(n) ? n : null;
}

function byKind(lines, kind) {
  return (lines || []).filter((row) => row && row.kind === kind);
}

function ticketEv(ticket) {
  if (!ticket) return null;
  if (ticket.evRaw != null && Number.isFinite(Number(ticket.evRaw))) return Number(ticket.evRaw);
  return parseEdgeFraction(ticket.ev);
}

function legEdge(leg) {
  return parseEdgeFraction(leg && (leg.edgePct != null ? leg.edgePct : leg.edge));
}

function legEv(leg) {
  if (!leg) return null;
  if (leg.evRaw != null && Number.isFinite(Number(leg.evRaw))) return Number(leg.evRaw);
  return parseEdgeFraction(leg.ev);
}

function ticketPositive(ticket) {
  if (!ticket || isNoQualifyingParlay(ticket)) return false;
  if (!(ticketEv(ticket) > 0)) return false;
  const legs = ticket.legs || [];
  if (legs.length !== 3) return false;
  return legs.every((leg) => legEdge(leg) > 0 && legEv(leg) > 0);
}

/**
 * A remedy leg is placeable when its displayed price is the Hard Rock price.
 * hardRockRepriced means parlayFromStraights already swapped in that price
 * and kept positive edge and EV. A leg that was not repriced must still
 * match a saved Hard Rock quote on the same bet.
 */
function legsPlaceable(ticket, card) {
  const legs = (ticket && ticket.legs) || [];
  if (legs.length !== 3) return false;
  const sources = poolFrom(card);
  return legs.every((leg) => {
    const shown = americanOf(leg && leg.odds);
    if (shown == null) return false;
    if (leg && leg.hardRockRepriced) return true;
    const direct = placeableAtDisplayed(leg, {});
    if (direct.placeable) return true;
    const source = sources.find((row) => sameBet(row, leg) && hrAmericanFor(row) != null);
    return !!(source && hrAmericanFor(source) === shown);
  });
}

function verdictOf(data, lines) {
  const picks = Array.isArray(data && data.picks) ? data.picks : [];
  if (!picks.length) return 'FAIL';
  const straightFail = byKind(lines, 'straight').some((row) => !row.placeable);
  const parlayFail = byKind(lines, 'parlay').some((row) => !row.placeable);
  return !straightFail && !parlayFail ? 'PASS' : 'FAIL';
}

/**
 * Rough draft of the top 3 plus the parlay, then the Hard Rock check at the
 * displayed best US price. Straights are flagged only. A failed parlay is
 * re-priced or swapped only while edge and EV stay positive. Never blocks
 * publish. No Odds API pull.
 */
function draftAndCheckHardRock(card, opts = {}) {
  const data = clone(card);
  const sort = applySilentSortCheck(data);
  if (sort.changed && Array.isArray(sort.picks) && sort.picks.length) {
    data.picks = sort.picks;
    data.bugLog = (data.bugLog || []).concat(sort.entry ? [sort.entry] : []);
    data.parlayLegs = parlayFromStraights(data.picks, { pool: poolFrom(data) });
  }
  const sportGames = (opts && opts.sportGames) || {};
  let reviewed = (opts && opts.reviewed && opts.reviewed.lines)
    ? reviewHardRock(data, sportGames)
    : reviewHardRock(data, sportGames);
  const ticket = (data.parlayLegs || [])[0];
  const parlayFail = ticket && !isNoQualifyingParlay(ticket)
    && byKind(reviewed.lines, 'parlay').some((row) => !row.placeable);
  let repriced = false;
  if (parlayFail) {
    const remedy = parlayFromStraights(data.picks, { pool: poolFrom(data) });
    const next = remedy && remedy[0];
    if (ticketPositive(next) && legsPlaceable(next, data)) {
      data.parlayLegs = remedy.map((row) => {
        if (!row || isNoQualifyingParlay(row)) return row;
        return {
          ...row,
          legs: (row.legs || []).map((leg) => {
            const shown = americanOf(leg && leg.odds);
            return {
              ...leg,
              book: 'hardrockbet',
              priceBook: 'hardrockbet',
              hardRock: { american: shown, point: leg && leg.line != null ? leg.line : null },
            };
          }),
        };
      });
      repriced = true;
      reviewed = reviewHardRock(data, sportGames);
    }
  }
  const verdict = verdictOf(data, reviewed.lines);
  data.cardStatus = 'draft';
  data.finalized = false;
  data.timelineStep = '10:30';
  data.selection = data.selection && typeof data.selection === 'object' ? data.selection : {};
  data.selection.stage = 'draft';
  data.selection.sortedAt = '10:30';
  data.hardRockCheck = {
    verdict,
    blocksPublish: false,
    repriced,
    lines: reviewed.lines,
    source: 'saved-10:00',
    oddsApi: false,
  };
  const before = card || {};
  const changed = JSON.stringify({
    picks: data.picks,
    parlayLegs: data.parlayLegs,
    hardRockCheck: data.hardRockCheck,
    timelineStep: data.timelineStep,
  }) !== JSON.stringify({
    picks: before.picks,
    parlayLegs: before.parlayLegs,
    hardRockCheck: before.hardRockCheck,
    timelineStep: before.timelineStep,
  });
  return {
    card: data,
    changed,
    verdict,
    lines: reviewed.lines,
    corrections: repriced ? [{ action: 'reprice-or-swap', reason: 'hard-rock-displayed-price' }] : [],
    oddsApi: false,
  };
}

function sentenceFor(pick) {
  const book = (pick && (pick.book || pick.priceBook)) || 'the displayed US book';
  const edge = (pick && (pick.edgePct || pick.edge)) || '';
  const ev = (pick && pick.ev) || '';
  const label = (pick && (pick.pick || pick.side)) || 'Side';
  const odds = pick && pick.odds != null ? pick.odds : '';
  return `${label} at ${odds} on ${book}. Edge ${edge}. Stake EV ${ev}. Prices are the 10:00 snapshot.`;
}

/** Offline written context. Does not call a model and does not finalize. */
function writeSummaries(card) {
  const data = clone(card);
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const summaries = picks.map((pick) => {
    const existing = pick && pick.coreReasoning && String(pick.coreReasoning).trim();
    const text = existing || sentenceFor(pick);
    if (pick && !existing) pick.coreReasoning = text;
    return {
      matchup: pick && pick.matchup ? pick.matchup : null,
      pick: pick && (pick.pick || pick.side) ? (pick.pick || pick.side) : null,
      text,
    };
  });
  if (!data.edgeSummary) {
    data.edgeSummary = summaries.length
      ? summaries.map((row) => `${row.matchup || 'Game'}: ${row.text}`).join(' ')
      : 'No straights on the draft.';
  }
  if (!data.insights) {
    data.insights = `Context for ${data.date || 'the slate'}. The 10:00 prices stand. This note does not pull odds and does not finalize the card.`;
  }
  data.writtenContext = {
    at: '10:45',
    source: 'offline-template',
    oddsApi: false,
    summaries,
  };
  data.cardStatus = 'draft';
  data.finalized = false;
  data.timelineStep = '10:45';
  data.selection = data.selection && typeof data.selection === 'object' ? data.selection : {};
  data.selection.stage = 'summaries';
  data.selection.contextInputs = data.selection.contextInputs || CONTEXT_INPUTS.slice();
  return { card: data, changed: true, oddsApi: false };
}

/** 11:00 is the only step that marks the card final. */
function finalizeCard(card, now) {
  const integrity = require('./card_integrity').applyCardIntegrity(clone(card));
  const data = integrity.card;
  const when = now instanceof Date ? now : new Date(now || Date.now());
  data.cardStatus = 'final';
  data.finalized = true;
  data.timelineStep = '11:00';
  data.selection = data.selection && typeof data.selection === 'object' ? data.selection : {};
  data.selection.stage = 'final';
  if (!data.publishedAt) data.publishedAt = Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString();
  const before = card || {};
  const changed = integrity.changed || before.finalized !== true || before.timelineStep !== '11:00' || before.cardStatus !== 'final';
  return { card: data, changed };
}

module.exports = {
  CONTEXT_INPUTS,
  draftAndCheckHardRock,
  writeSummaries,
  finalizeCard,
};
