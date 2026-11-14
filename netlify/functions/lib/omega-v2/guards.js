'use strict';

const {
  MODEL_VERSION, MAX_STRAIGHTS, PER_BET_CAP, STRAIGHT_BUDGET, CARD_BUDGET, PARLAY_STAKE_CAP, UNIT_DOLLARS,
  fillerEnabled,
} = require('./constants');
const { assertNoLeakage } = require('./calibrate');
const { marketFamily, pastPregameCutoff, pregameClockMs, annotateCandidate } = require('./select');
const { bannedPairReason, sizeParlay, quotedLeg, canonicalPlaceBook, PLACEABLE_BOOKS } = require('./parlay');
const { dkHrLineAgrees } = require('./board');
const { quarterKellyFromDecimal, priceEvAtBet } = require('./size');
const { americanJuiceDelta, americanToDecimal, ratingToConfidence, EDGE_B_UNIT_CAP, isEdgeGradeB } = require('../omega-vnext/odds_math');
const { letterFromPrintedEdge } = require('./letter');

const STALE_CENTS = 15;

function parseAmerican(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw !== 0) return raw;
  const n = Number(String(raw).trim().replace(/[−–]/g, '-').replace(/^\+/, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * Pre-publish price recheck. `recheck` is injected by the caller.
 * This module never calls The Odds API or any other network price source.
 * A quote whose number differs from the edge line is dropped. Juice more
 * than 15 cents worse is dropped. A smaller DK/HR move is re-annotated
 * with the same bet probability as selection (sharp no-vig when
 * OMEGA_V2_MARKET_P is on, calibrated probability when it is off, then
 * the longshot penalty). The leg stays while that annotation still
 * qualifies. A price that moves shorter than -300 is not dropped here:
 * it remains in the kept pool so it can fill an empty slot. Callers
 * must run selectForcedTop3 on that pool afterward. Pipeline does.
 * An in-band row then takes the slot, and the heavy favorite is marked
 * favCapFill only when fewer than 3 in-band games remain. A null quote,
 * or a quote from any other book, leaves the locked price in place.
 */
async function recheckPrices(candidates, recheck) {
  if (typeof recheck !== 'function') {
    return { checked: false, dropped: [], kept: candidates || [] };
  }
  const kept = [];
  const dropped = [];
  for (const cand of candidates || []) {
    const quote = await recheck({
      pick: cand.pick,
      matchup: cand.matchup,
      sport: cand.sport,
      market: cand.market,
      odds: cand.odds,
      line: cand.line,
      book: cand.book,
      commenceTime: cand.commenceTime,
    });
    if (quote == null) {
      kept.push(cand);
      continue;
    }
    if (quote.ok === false) {
      dropped.push({ pick: cand.pick, matchup: cand.matchup, reason: quote.reason || 'price-recheck' });
      continue;
    }
    const quoteBook = String(quote.book || '').toLowerCase();
    if (quoteBook && !PLACEABLE_BOOKS.has(quoteBook)) {
      kept.push(cand);
      continue;
    }
    const quoteLine = quote.line != null && quote.line !== '' ? quote.line : quote.point;
    if (!dkHrLineAgrees(cand.line, quoteLine)) {
      dropped.push({
        pick: cand.pick,
        matchup: cand.matchup,
        market: cand.market,
        reason: 'dk-hr-line-mismatch',
        line: cand.line != null ? cand.line : null,
        quoteLine: quoteLine != null ? quoteLine : null,
      });
      continue;
    }
    const nextOdds = parseAmerican(quote.american);
    const curOdds = parseAmerican(cand.odds);
    const cents = americanJuiceDelta(curOdds, nextOdds);
    if (cents != null && cents > STALE_CENTS) {
      dropped.push({
        pick: cand.pick,
        matchup: cand.matchup,
        market: cand.market,
        reason: 'price-recheck',
        cents,
        lineDrift: 0,
      });
      continue;
    }
    if (nextOdds == null || nextOdds === curOdds) {
      kept.push(cand);
      continue;
    }
    const nextBook = canonicalPlaceBook(quote.book) || cand.book;
    const repriced = annotateCandidate({
      ...cand,
      odds: nextOdds,
      book: nextBook,
      bestDkHr: {
        ...(cand.bestDkHr && typeof cand.bestDkHr === 'object' ? cand.bestDkHr : {}),
        american: nextOdds,
        book: nextBook,
      },
    }, cand && cand.forced ? { forceTop3: true } : undefined);
    if (repriced.qualified || (repriced.ev > 0 && repriced.parlayQualified)) {
      kept.push(repriced);
      continue;
    }
    dropped.push({
      pick: cand.pick,
      matchup: cand.matchup,
      market: cand.market,
      reason: repriced.forced && repriced.rejectReason ? repriced.rejectReason : 'price-recheck',
      cents,
      lineDrift: 0,
    });
  }
  return { checked: true, dropped, kept };
}

function fmtU(units) {
  const q = Math.round(Number(units) * 4) / 4;
  if (!Number.isFinite(q)) return '0u';
  return `${q}u`;
}

function pct(p) {
  return `${(Number(p) * 100).toFixed(1)}%`;
}

function ratingFor(edge) {
  // Same tenth the card prints in edgePct. Exact 5.0, 3.5, and 2.0 take the higher letter.
  return letterFromPrintedEdge(edge) || 'b';
}

/**
 * Rewrite rating, grade, qualityGrade, and confidence from the printed edgePct.
 * Missing edgePct leaves the stored letter alone. Returns true when a field changes.
 */
function stampPrintedLetter(row, notes) {
  if (!row || row.edgePct == null || row.edgePct === '') return false;
  const letter = letterFromPrintedEdge(row.edgePct);
  if (!letter) return false;
  const conf = ratingToConfidence(letter);
  if (row.rating === letter && row.grade === letter && row.qualityGrade === letter && Number(row.confidence) === conf) {
    return false;
  }
  const from = row.rating || row.grade || '?';
  row.rating = letter;
  row.grade = letter;
  row.qualityGrade = letter;
  row.confidence = conf;
  if (notes) notes.push(`letter ${row.pick || row.side || row.matchup} ${from} -> ${letter}`);
  return true;
}

function toPick(row) {
  const forced = !!row.forced;
  const rating = ratingFor(forced ? row.edge : row.edgeNovig);
  const coverP = forced && row.pBet != null ? row.pBet : row.calibration.pCal;
  const edgePct = forced
    ? (row.edge != null ? pct(row.edge) : null)
    : (row.edgeNovig != null ? pct(row.edgeNovig) : null);
  const pick = {
    sport: row.sport,
    matchup: row.matchup,
    pick: row.pick,
    pickDisplay: row.pick,
    betType: row.marketFamily || row.market,
    market: row.market,
    odds: typeof row.odds === 'number' ? (row.odds > 0 ? `+${row.odds}` : String(row.odds)) : String(row.odds),
    line: row.line != null ? row.line : null,
    units: fmtU(row.units),
    unitsNum: row.units,
    stakeUsd: row.stakeUsd,
    rating,
    grade: rating,
    qualityGrade: rating,
    commenceTime: row.commenceTime || '',
    edgePct,
    priceEdgePct: row.edge != null ? pct(row.edge) : null,
    edgeNovig: row.edgeNovig != null ? row.edgeNovig : null,
    ev: pct(row.ev),
    evRaw: row.ev,
    confidence: ratingToConfidence(rating),
    coverProb: pct(coverP),
    winProbability: pct(coverP),
    pModel: row.calibration.pModel,
    pMkt: row.calibration.pMkt,
    pCal: row.calibration.pCal,
    p_model: row.calibration.pModel != null
      ? row.calibration.pModel
      : (row.pModel != null ? row.pModel : (row.p_model != null ? row.p_model : null)),
    fair_sharp_p: row.calibration.pMkt != null
      ? row.calibration.pMkt
      : (row.pMkt != null ? row.pMkt : (row.fair_sharp_p != null ? row.fair_sharp_p : null)),
    openPrint: row.openPrint != null ? row.openPrint : null,
    lineMove: row.lineMove != null ? row.lineMove : null,
    book: row.book || null,
    homeTeam: row.homeTeam || null,
    awayTeam: row.awayTeam || null,
    source: 'omega-v2',
    modelVersion: MODEL_VERSION,
    coreReasoning: row.coreReasoning || '',
    result: row.result || null,
    clvPp: row.clvPp != null ? row.clvPp : null,
    calibrationMethod: row.calibration.method,
  };
  // pModelCal is the calibrated probability. winProbability above is pBet
  // on this path, which may be the sharp no-vig price rather than that number.
  if (row.pModelCal != null) pick.pModelCal = row.pModelCal;
  else if (row.calibration && row.calibration.pCal != null) pick.pModelCal = row.calibration.pCal;
  if (forced) {
    pick.forced = true;
    if (row.pBet != null) pick.pBet = row.pBet;
    if (row.favCapFill) pick.favCapFill = true;
    if (row.filler === true) {
      pick.filler = true;
      pick.fillerReason = row.fillerReason || 'negative-ev';
    }
  }
  return pick;
}

function toParlay(ticket, scanned) {
  if (!ticket || !ticket.publish) return [];
  const legs = ticket.legs.map((leg) => toPick({ ...leg, units: ticket.units, stakeUsd: ticket.stakeUsd }));
  const markets = legs.map((leg) => marketFamily(leg.betType || leg.market, leg.pick));
  return [{
    type: `${ticket.legs.length}-leg`,
    units: fmtU(ticket.units),
    unitsNum: ticket.units,
    stakeUsd: ticket.stakeUsd,
    combinedOdds: ticket.combinedOdds,
    combinedDecimal: +ticket.decimal.toFixed(4),
    combinedProb: pct(ticket.pJoint),
    ev: pct(ticket.ev),
    evRaw: ticket.ev,
    uniqueGames: new Set(ticket.legs.map((leg) => leg.gameKey)).size,
    uniqueSports: new Set(ticket.legs.map((leg) => String(leg.sport || '').toUpperCase())).size,
    independent: ticket.factor === 1,
    legMarkets: markets,
    correlationNote: ticket.correlationNote
      || (ticket.correlated
        ? `correlation factor ${ticket.factor}`
        : 'Distinct games. Joint probability is the product.'),
    correlationHaircut: String(ticket.factor),
    pJoint: ticket.pJoint,
    correlationFactor: ticket.factor,
    candidatesScanned: scanned,
    source: 'omega-v2',
    modelVersion: MODEL_VERSION,
    legs,
  }];
}

function wholeDollarStake(units) {
  const u = Number(units);
  return u > 0 ? Math.ceil(u * UNIT_DOLLARS - 1e-9) : 0;
}

function unitsOf(row) {
  const n = Number(row && row.unitsNum != null ? row.unitsNum : String(row && row.units || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Drop straights and parlay tickets that include a started game.
 * commenceTime <= asOf + 5 minutes is started. The ticket is removed
 * rather than repriced. This never throws and never blocks the card.
 */
function removeStartedLegs(card, opts) {
  const asOfMs = pregameClockMs(opts);
  const notes = [];
  const picks = [];
  for (const pick of (card && card.picks) || []) {
    if (pastPregameCutoff(pick && pick.commenceTime, asOfMs)) {
      notes.push(`removed started straight ${pick.pick || pick.side || pick.matchup}`);
      continue;
    }
    picks.push(pick);
  }
  const parlayLegs = [];
  for (const ticket of (card && card.parlayLegs) || []) {
    const legs = (ticket && ticket.legs) || [];
    const started = legs.filter((leg) => pastPregameCutoff(leg && leg.commenceTime, asOfMs));
    if (!started.length) {
      parlayLegs.push(ticket);
      continue;
    }
    for (const leg of started) {
      notes.push(`removed started parlay leg ${leg.pick || leg.side || leg.matchup}`);
    }
  }
  return { picks, parlayLegs, notes };
}

function rowId(row) {
  return `${String(row && row.matchup || '').toLowerCase()}|${String((row && (row.pick || row.side)) || '').toLowerCase()}`;
}

function pCalOfRow(row, pool) {
  if (!row) return null;
  if (Number.isFinite(Number(row.pCal))) return Number(row.pCal);
  if (row.calibration && Number.isFinite(Number(row.calibration.pCal))) return Number(row.calibration.pCal);
  const hit = (pool || []).find((r) => r && r.pick === row.pick && r.matchup === row.matchup);
  return hit && Number.isFinite(Number(hit.pCal)) ? Number(hit.pCal) : null;
}

/**
 * Quarter-Kelly units for a stored ticket, or null when a leg has no pCal.
 * Null leaves the printed stake alone. 0 means the nearest step is no bet.
 */
function probForLeg(leg, pool, force) {
  if (force) {
    if (leg && Number.isFinite(Number(leg.pBet))) return Number(leg.pBet);
    const hit = (pool || []).find((r) => r && r.pick === (leg && leg.pick) && r.matchup === (leg && leg.matchup));
    if (hit && Number.isFinite(Number(hit.pBet))) return Number(hit.pBet);
  }
  return pCalOfRow(leg, pool);
}

function parlayQuarterKellyUnits(ticket, pool, opts) {
  const legs = (ticket && ticket.legs) || [];
  if (legs.length < 2) return null;
  const force = !!(opts && opts.forceTop3);
  let joint = 1;
  let dec = 1;
  for (const leg of legs) {
    const p = probForLeg(leg, pool, force);
    const d = americanToDecimal(parseAmerican(leg.odds));
    if (!(p > 0 && p < 1) || d == null) return null;
    joint *= p;
    dec *= d;
  }
  const sized = quarterKellyFromDecimal(
    joint,
    dec,
    PARLAY_STAKE_CAP,
    force ? { floorToQuarter: true } : null,
  );
  if (force && !(sized.units >= 0.25)) return 0.25;
  return sized.units;
}

function forceTop3Card(card) {
  return !!(card && card.selectionRule === 'force-top3');
}

/** A DK/HR quote that is actually on the row. A missing book is not one. */
function explicitQuoted(row) {
  if (!row) return null;
  const px = row.bestDkHr;
  const pxBook = px && typeof px === 'object' ? String(px.book || '').toLowerCase() : '';
  const pxAmerican = px && typeof px === 'object' ? parseAmerican(px.american) : null;
  const hasBest = pxAmerican != null && PLACEABLE_BOOKS.has(pxBook);
  const posted = String(row.book || '').toLowerCase();
  if (!hasBest && !PLACEABLE_BOOKS.has(posted)) return null;
  const quoted = quotedLeg(row);
  if (!quoted || !PLACEABLE_BOOKS.has(String(quoted.book || '').toLowerCase())) return null;
  return quoted;
}

function needsPlaceableRepair(legs) {
  return (legs || []).some((leg) => {
    const quoted = quotedLeg(leg);
    if (!quoted) return String(leg && leg.book || '').length > 0;
    const posted = String(leg.book || '').toLowerCase();
    if (!posted) return false;
    if (quoted.book !== canonicalPlaceBook(posted)) return true;
    const postedOdds = parseAmerican(leg.odds);
    const quotedOdds = parseAmerican(quoted.odds);
    return postedOdds != null && quotedOdds != null && postedOdds !== quotedOdds;
  });
}

/**
 * Drop a leg whose posted book is not DraftKings or Hard Rock and rebuild
 * from the remaining DK/HR prices (straights and ticket legs that quote).
 * A pool row with no book is not treated as placeable. No replacement
 * means the ticket comes off.
 */
function replaceIllegalParlayBooks(card, picks, clockOpts, notes) {
  const ticket = card.parlayLegs && card.parlayLegs[0];
  if (!ticket || !needsPlaceableRepair(ticket.legs)) return;
  const illegal = (ticket.legs || []).filter((leg) => !explicitQuoted(leg) && String(leg.book || '').length > 0);
  const poolRows = Array.isArray(card.parlayPool) ? card.parlayPool : [];
  const poolById = new Map();
  for (const row of poolRows) poolById.set(rowId(row), row);
  const seen = new Set();
  const pool = [];
  const consider = (row) => {
    const quoted = explicitQuoted(row);
    if (!quoted) return;
    const id = rowId(quoted);
    if (!id || seen.has(id)) return;
    const pooled = poolById.get(id);
    const p = pCalOfRow(quoted, poolRows);
    const edgeNovig = Number.isFinite(Number(quoted.edgeNovig))
      ? Number(quoted.edgeNovig)
      : (pooled && Number(pooled.edgeNovig));
    const odds = parseAmerican(quoted.odds);
    if (!(p > 0 && p < 1) || !(edgeNovig > 0) || odds == null) return;
    const dec = americanToDecimal(odds);
    seen.add(id);
    pool.push({
      sport: quoted.sport || (pooled && pooled.sport) || null,
      matchup: quoted.matchup,
      pick: quoted.pick || quoted.side,
      market: quoted.market || quoted.betType || (pooled && pooled.market) || null,
      odds,
      book: quoted.book,
      edgeNovig,
      parlayQualified: true,
      commenceTime: quoted.commenceTime || (pooled && pooled.commenceTime) || '',
      calibration: {
        pCal: p,
        pMkt: quoted.pMkt != null ? quoted.pMkt : (pooled && pooled.pMkt != null ? pooled.pMkt : null),
      },
      homeTeam: quoted.homeTeam || null,
      awayTeam: quoted.awayTeam || null,
      line: quoted.line != null ? quoted.line : null,
      ev: dec != null ? p * dec - 1 : null,
    });
  };
  for (const pick of picks || []) consider(pick);
  for (const leg of ticket.legs || []) consider(leg);
  const sized = sizeParlay(pool, picks, clockOpts);
  const dropped = illegal.map((leg) => `${leg.pick || leg.side} ${leg.book}`).join(', ') || 'non-DK/HR leg';
  if (!sized.publish) {
    notes.push(`dropped non-DK/HR parlay (${dropped})`);
    card.parlayLegs = [];
    return;
  }
  card.parlayLegs = toParlay(sized, ticket.candidatesScanned);
  notes.push(`replaced non-DK/HR parlay leg ${dropped}`);
}

/**
 * QA never withholds a straight card. Round stakes, cap them, drop a
 * duplicate game. The letter is the printed edgePct tenth. A true B above
 * 0.5u is capped after that rewrite. A parlay leg off DraftKings and Hard
 * Rock is replaced with the next +EV DK/HR leg, or the ticket is dropped.
 * A parlay whose quarter-Kelly rounds under 0.25u is removed. It is not
 * floored back up to 0.25u. A started leg is removed here. That correction
 * is not a validation error. On a force-top3 card, a straight with negative
 * price EV is a filler: stake 0.25u, letter and price left as they are.
 * The parlay legs and the parlay stake are not part of that cap.
 */
function autoCorrectCard(card, opts) {
  const notes = [];
  const clockOpts = opts && Number.isFinite(Number(opts.pregameAsOfMs))
    ? opts
    : (card && Number.isFinite(Number(card.pregameAsOfMs)) ? card : {});
  const removed = removeStartedLegs(card, clockOpts);
  notes.push(...removed.notes);
  const out = {
    ...(card || {}),
    picks: removed.picks,
    parlayLegs: removed.parlayLegs,
  };
  if (out.modelVersion !== MODEL_VERSION) {
    notes.push('stamped model version');
    out.modelVersion = MODEL_VERSION;
  }
  if (out.leakageChecked !== true) {
    notes.push('marked leakage checked');
    out.leakageChecked = true;
  }
  const forceCard = forceTop3Card(out);
  const ranked = out.picks.slice().sort((a, b) => (Number(b.evRaw) || 0) - (Number(a.evRaw) || 0));
  const picks = [];
  const seen = new Set();
  for (const p of ranked) {
    const g = String(p.matchup || '').toLowerCase();
    if (g && seen.has(g)) {
      notes.push(`dropped duplicate game ${p.matchup}`);
      continue;
    }
    let u = Math.round(unitsOf(p) * 4) / 4;
    if (u > PER_BET_CAP) {
      notes.push(`capped ${p.pick || p.side}`);
      u = PER_BET_CAP;
    }
    if (!(u >= 0.25)) {
      if (forceCard) {
        notes.push(`floored dust stake ${p.pick || p.side}`);
        u = 0.25;
      } else {
        notes.push(`dropped dust stake ${p.pick || p.side}`);
        continue;
      }
    }
    if (g) seen.add(g);
    picks.push({
      ...p,
      unitsNum: u,
      units: `${u}u`,
      modelVersion: MODEL_VERSION,
      stakeUsd: u > 0 ? Math.ceil(u * 150 - 1e-9) : 0,
    });
    if (picks.length >= MAX_STRAIGHTS) break;
  }
  if (ranked.length > picks.length) notes.push('trimmed straights');
  let guard = 0;
  const straightSum = () => picks.reduce((s, p) => s + unitsOf(p), 0);
  while (straightSum() > STRAIGHT_BUDGET + 1e-9 && guard < 40) {
    guard += 1;
    picks.sort((a, b) => unitsOf(a) - unitsOf(b) || String(a.pick).localeCompare(String(b.pick)));
    const victim = picks[0];
    const next = Math.round((unitsOf(victim) - 0.25) * 4) / 4;
    if (next >= 0.25) {
      victim.unitsNum = next;
      victim.units = `${next}u`;
      victim.stakeUsd = Math.ceil(next * 150 - 1e-9);
    } else if (forceCard) {
      break;
    } else {
      notes.push(`budget dropped ${victim.pick || victim.side}`);
      picks.shift();
    }
  }
  // Letter first, then the B cap, so a mislabeled A is not cut to 0.5u.
  // Parlay legs, ticket units, and prices are not this cap. Repeat until the
  // letter and the cap stop moving, at most 3 passes.
  let gradeGuard = 0;
  let gradeMoved = true;
  while (gradeMoved && gradeGuard < 3) {
    gradeGuard += 1;
    gradeMoved = false;
    for (const p of picks) {
      if (stampPrintedLetter(p, notes)) gradeMoved = true;
      if (!(isEdgeGradeB(p.rating) || isEdgeGradeB(p.grade) || isEdgeGradeB(p.qualityGrade))) continue;
      if (!(unitsOf(p) > EDGE_B_UNIT_CAP)) continue;
      p.units = '0.5u';
      if (Object.prototype.hasOwnProperty.call(p, 'unitsNum')) p.unitsNum = EDGE_B_UNIT_CAP;
      const stake = Math.ceil(0.5 * 150);
      if (Object.prototype.hasOwnProperty.call(p, 'stakeUsd')) p.stakeUsd = stake;
      if (Object.prototype.hasOwnProperty.call(p, 'stakeDollars')) p.stakeDollars = stake;
      notes.push(`b-grade cap ${p.pick || p.side}`);
      gradeMoved = true;
    }
  }
  // After the letter and the B cap. A negative price EV (pBet × DK/HR
  // decimal − 1) that still sits above 0.25u drops to that minimum.
  // Already-0.25u fillers are marked and not noted. Positive-EV stakes,
  // letters, and the parlay are left for the code above and below.
  if (fillerEnabled() && forceCard) {
    for (const p of picks) {
      const priceEv = priceEvAtBet(p);
      if (priceEv == null || !(priceEv < 0)) continue;
      p.filler = true;
      p.fillerReason = 'negative-ev';
      if (unitsOf(p) > 0.25 + 1e-9) {
        notes.push(`filler cap ${p.pick || p.side}`);
        p.unitsNum = 0.25;
        p.units = '0.25u';
        if (Object.prototype.hasOwnProperty.call(p, 'stakeDollars')) {
          p.stakeDollars = Math.ceil(0.25 * UNIT_DOLLARS - 1e-9);
        }
      }
    }
  }
  out.picks = picks;
  if (out.parlayLegs.length > 1) {
    notes.push('kept one parlay');
    out.parlayLegs = out.parlayLegs.slice(0, 1);
  }
  replaceIllegalParlayBooks(out, picks, clockOpts, notes);
  if (out.parlayLegs[0]) {
    const banned = bannedPairReason(out.parlayLegs[0].legs);
    if (banned) {
      notes.push(`dropped correlated parlay (${banned})`);
      out.parlayLegs = [];
    }
  }
  if (out.parlayLegs[0]) {
    const pl = {
      ...out.parlayLegs[0],
      legs: (out.parlayLegs[0].legs || []).map((leg) => {
        const next = { ...leg, modelVersion: MODEL_VERSION };
        stampPrintedLetter(next, notes);
        return next;
      }),
    };
    let u = Math.round(unitsOf(pl) * 4) / 4;
    if (u > PARLAY_STAKE_CAP) u = PARLAY_STAKE_CAP;
    const kelly = parlayQuarterKellyUnits(pl, out.parlayPool, { forceTop3: forceCard });
    if (!forceCard && kelly != null && !(kelly >= 0.25)) {
      notes.push('parlay stake rounded to 0');
      out.parlayLegs = [];
    } else {
      if (kelly != null && u > kelly + 1e-9) {
        notes.push(`parlay stake snapped to quarter-Kelly ${kelly}u`);
        u = kelly;
      }
      if (!(u >= 0.25)) {
        if (forceCard) {
          notes.push('parlay stake floored to 0.25u');
          u = 0.25;
        } else {
          notes.push('parlay stake rounded to 0');
          out.parlayLegs = [];
        }
      }
      if (out.parlayLegs.length) {
        pl.unitsNum = u;
        pl.units = `${u}u`;
        pl.modelVersion = MODEL_VERSION;
        pl.stakeUsd = Math.ceil(u * 150 - 1e-9);
        out.parlayLegs = [pl];
      }
    }
  }
  // Whole-dollar stake on every straight and the ticket: final units x $150, rounded up.
  for (const p of picks) p.stakeUsd = wholeDollarStake(unitsOf(p));
  if (out.parlayLegs[0]) out.parlayLegs[0].stakeUsd = wholeDollarStake(unitsOf(out.parlayLegs[0]));
  const straightUnits = +picks.reduce((s, p) => s + unitsOf(p), 0).toFixed(2);
  const parlayUnits = out.parlayLegs[0] ? unitsOf(out.parlayLegs[0]) : 0;
  out.straightUnits = straightUnits;
  out.parlayUnits = parlayUnits;
  out.totalUnits = +(straightUnits + parlayUnits).toFixed(2);
  out.pass = picks.length === 0 && out.parlayLegs.length === 0;
  out.short = picks.length > 0 && picks.length < MAX_STRAIGHTS;
  out.qaNotes = notes;
  out.qaCorrected = notes.length > 0;
  return out;
}

function validateCard(card) {
  const errors = [];
  const forceCard = forceTop3Card(card);
  if (!card || card.modelVersion !== MODEL_VERSION) errors.push('model version is not stamped');
  if (card.leakageChecked !== true) errors.push('leakage was not checked');
  const picks = card.picks || [];
  if (picks.length > MAX_STRAIGHTS) errors.push('more than 3 straights');
  const games = new Set();
  for (const pick of picks) {
    const u = unitsOf(pick);
    if (!(u > 0)) errors.push(`straight stake is not positive (${pick.pick})`);
    if (Math.abs(u * 4 - Math.round(u * 4)) > 1e-6) errors.push(`stake is not a 0.25u tier (${pick.pick})`);
    if (u > PER_BET_CAP + 1e-9) errors.push(`stake exceeds per-bet cap (${pick.pick})`);
    const g = String(pick.matchup || '').toLowerCase();
    if (games.has(g)) errors.push(`two straights in ${pick.matchup}`);
    games.add(g);
    if (pick.modelVersion !== MODEL_VERSION) errors.push('pick missing model version');
  }
  const parlays = card.parlayLegs || [];
  if (parlays.length > 1) errors.push('more than one parlay');
  for (const parlay of parlays) {
    const n = (parlay.legs || []).length;
    if (n !== 2 && n !== 3) errors.push('parlay is not 2 or 3 legs');
    const u = unitsOf(parlay);
    if (!(u >= 0.25)) errors.push('parlay stake is below 0.25u');
    if (u > PARLAY_STAKE_CAP + 1e-9) errors.push('parlay stake is above the cap');
    const kelly = parlayQuarterKellyUnits(parlay, card.parlayPool, { forceTop3: forceCard });
    if (!forceCard && kelly === 0 && u >= 0.25) errors.push('parlay stake floors sub-0.25u quarter-Kelly');
    else if (kelly != null && kelly >= 0.25 && u > kelly + 1e-9) {
      errors.push(`parlay stake ${u}u is above quarter-Kelly ${kelly}u`);
    }
    const banned = bannedPairReason(parlay.legs);
    if (banned) errors.push(banned);
    for (const leg of parlay.legs || []) {
      const posted = String(leg.book || '').toLowerCase();
      if (posted && !PLACEABLE_BOOKS.has(posted)) {
        errors.push(`parlay leg book is not DK/Hard Rock (${leg.pick} ${leg.book})`);
      }
      if (!forceCard) {
        const edge = Number(leg.edgeNovig != null ? leg.edgeNovig : leg.edge);
        if (Number.isFinite(edge) && !(edge > 0)) errors.push(`parlay leg edge is not positive (${leg.pick})`);
      }
    }
  }
  if ((card.straightUnits || 0) > STRAIGHT_BUDGET + 1e-9) errors.push('straight budget exceeded');
  if ((card.totalUnits || 0) > CARD_BUDGET + 1e-9) errors.push('card budget exceeded');
  return errors;
}

function normQuote(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** "tennessee volunteers 3 5" (norm of "… -3.5") → "tennessee volunteers". */
function stripTrailingLineToken(normalized) {
  return String(normalized || '').replace(/\s+\d+(?:\s+\d+)?$/, '').trim();
}

function exactOutcomeName(name, pick) {
  if (!name || !pick) return false;
  if (name === pick) return true;
  const stripped = stripTrailingLineToken(pick);
  return stripped !== pick && stripped === name;
}

/** Old containment: full name inside the pick, or the pick's first word inside the name. */
function looseOutcomeName(name, pick) {
  if (!pick || !name) return false;
  return pick.includes(name) || name.includes(pick.split(' ')[0]);
}

function sharesFirstWord(name, pick) {
  const word = String(pick || '').split(' ')[0];
  if (!word || !name) return false;
  return name.includes(word);
}

function lineAgrees(o, family, line) {
  if (family === 'Moneyline') return true;
  const point = o && o.point != null && o.point !== '' ? Number(o.point) : null;
  if (line == null || point == null || !Number.isFinite(point) || Math.abs(point - line) > 1e-6) return false;
  return true;
}

/**
 * Join a DK/HR outcome to a leg.
 * Totals stay over/under plus the line. Other markets take an exact
 * normalized name first (a trailing line token on the pick does not count).
 * The old first-word containment is used only when exactly one outcome
 * matches loosely and no other outcome shares that first word. Anything
 * else returns null so the recheck keeps the locked price.
 */
function matchOutcome(outcomes, leg) {
  const pick = normQuote(leg && (leg.pick || leg.side));
  const wantTotal = /^\s*over\b/.test(pick) ? 'over' : (/^\s*under\b/.test(pick) ? 'under' : null);
  const family = marketFamily(leg && leg.market, leg && (leg.pick || leg.side));
  const line = leg && leg.line != null && leg.line !== '' ? Number(leg.line) : null;
  const list = outcomes || [];
  if (wantTotal) {
    for (const o of list) {
      const name = normQuote(o && o.name);
      if (name !== wantTotal) continue;
      if (!lineAgrees(o, family, line)) continue;
      if (Number.isFinite(Number(o.price))) return o;
    }
    return null;
  }
  const exact = [];
  for (const o of list) {
    if (exactOutcomeName(normQuote(o && o.name), pick)) exact.push(o);
  }
  if (exact.length) {
    for (const o of exact) {
      if (!lineAgrees(o, family, line)) continue;
      if (Number.isFinite(Number(o.price))) return o;
    }
    return null;
  }
  const loose = [];
  for (const o of list) {
    if (looseOutcomeName(normQuote(o && o.name), pick)) loose.push(o);
  }
  if (loose.length !== 1) return null;
  const wordShared = list.some((o) => o !== loose[0] && sharesFirstWord(normQuote(o && o.name), pick));
  if (wordShared) return null;
  const o = loose[0];
  if (!lineAgrees(o, family, line)) return null;
  if (Number.isFinite(Number(o.price))) return o;
  return null;
}

const DK_HR_RECHECK = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

/**
 * Quote books a recheck may use. The leg's own book only when it is
 * DraftKings or Hard Rock, then those books. Never Pinnacle, FanDuel,
 * BetMGM, or an offshore book. A missing quote leaves the locked price.
 */
function recheckBookOrder(book) {
  const order = [];
  const posted = String(book || '').toLowerCase();
  if (DK_HR_RECHECK.has(posted)) order.push(posted);
  for (const key of ['draftkings', 'hardrockbet', 'hardrock']) {
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

/**
 * Pre-publish quote from an already-loaded odds board.
 * No network. A missing event leaves the locked price alone.
 */
function recheckFromCachedBoard(oddsBySport) {
  const events = [];
  for (const list of Object.values(oddsBySport || {})) {
    if (Array.isArray(list)) events.push(...list);
  }
  return async function recheck(leg) {
    const matchup = normQuote(leg && leg.matchup);
    const ev = events.find((row) => {
      const home = normQuote(row.home_team || row.homeTeam);
      const away = normQuote(row.away_team || row.awayTeam);
      if (!home || !away || !matchup) return false;
      return matchup.includes(home) && matchup.includes(away);
    });
    if (!ev) return null;
    const mk = marketFamily(leg.market, leg.pick) === 'Total'
      ? 'totals'
      : (marketFamily(leg.market, leg.pick) === 'Spread' ? 'spreads' : 'h2h');
    const books = ev.bookmakers || [];
    const order = recheckBookOrder(leg && leg.book);
    for (const want of order) {
      if (!want) continue;
      const book = books.find((b) => String(b.key || '').toLowerCase() === String(want).toLowerCase());
      if (!book) continue;
      const market = (book.markets || []).find((m) => m.key === mk);
      const outcome = market && matchOutcome(market.outcomes, leg);
      if (!outcome) continue;
      return {
        american: Number(outcome.price),
        line: outcome.point != null ? Number(outcome.point) : null,
        book: book.key,
      };
    }
    return null;
  };
}

module.exports = {
  wholeDollarStake,
  assertNoLeakage,
  recheckPrices,
  toPick,
  toParlay,
  validateCard,
  autoCorrectCard,
  removeStartedLegs,
  recheckFromCachedBoard,
  matchOutcome,
  parseAmerican,
  ratingFor,
  fmtU,
};
