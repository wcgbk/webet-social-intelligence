'use strict';

const { MODEL_VERSION, MAX_STRAIGHTS, PER_BET_CAP, PARLAY_MIN_EV } = require('./constants');
const { assertNoLeakage } = require('./calibrate');
const { marketFamily } = require('./select');
const { americanJuiceDelta } = require('../omega-vnext/odds_math');

const STALE_CENTS = 15;
const STALE_POINTS = 1;

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
 * A quote that is more than 15 juice cents worse, or more than 1 point off
 * the number, drops the leg. A null quote leaves the locked price in place.
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
    const cents = americanJuiceDelta(parseAmerican(cand.odds), parseAmerican(quote.american));
    const lineCap = marketFamily(cand.market, cand.pick) === 'Moneyline' ? null : STALE_POINTS;
    const lineDrift = cand.line != null && quote.line != null
      ? Math.abs(Number(cand.line) - Number(quote.line))
      : 0;
    const juiceWorse = cents != null && cents > STALE_CENTS;
    const lineWorse = lineCap != null && lineDrift > lineCap + 1e-9;
    if (juiceWorse || lineWorse) {
      dropped.push({
        pick: cand.pick,
        matchup: cand.matchup,
        market: cand.market,
        reason: 'price-recheck',
        cents,
        lineDrift,
      });
      continue;
    }
    kept.push(cand);
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
  if (edge >= 0.05) return 'aplus';
  if (edge >= 0.035) return 'a';
  if (edge >= 0.02) return 'aminus';
  return 'b';
}

function toPick(row) {
  const rating = ratingFor(row.edge);
  return {
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
    edgePct: pct(row.edge),
    ev: pct(row.ev),
    evRaw: row.ev,
    coverProb: pct(row.calibration.pCal),
    winProbability: pct(row.calibration.pCal),
    pModel: row.calibration.pModel,
    pMkt: row.calibration.pMkt,
    pCal: row.calibration.pCal,
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
}

function toParlay(ticket, scanned) {
  if (!ticket || !ticket.publish) return [];
  const legs = ticket.legs.map((leg) => toPick({ ...leg, units: ticket.units, stakeUsd: ticket.stakeUsd }));
  const markets = legs.map((leg) => marketFamily(leg.betType || leg.market, leg.pick));
  return [{
    type: `${ticket.legs.length}-leg-ml-total`,
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
    correlationNote: ticket.correlated
      ? `correlation haircut ${ticket.factor}`
      : 'distinct sports, no same-direction total stack',
    correlationHaircut: String(ticket.factor),
    correlationFactor: ticket.factor,
    candidatesScanned: scanned,
    source: 'omega-v2',
    modelVersion: MODEL_VERSION,
    legs,
  }];
}

function validateCard(card) {
  const errors = [];
  if (!card || card.modelVersion !== MODEL_VERSION) errors.push('model version is not stamped');
  if (card.leakageChecked !== true) errors.push('leakage was not checked');
  const picks = card.picks || [];
  if (picks.length > MAX_STRAIGHTS) errors.push('more than 3 straights');
  const games = new Set();
  for (const pick of picks) {
    const u = Number(pick.unitsNum != null ? pick.unitsNum : String(pick.units || '').replace(/[^0-9.]/g, ''));
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
    const mk = (parlay.legs || []).map((leg) => marketFamily(leg.betType || leg.market, leg.pick));
    if (!mk.includes('Moneyline') || !mk.includes('Total')) errors.push('parlay is not ML+total');
    const seen = new Set();
    for (const leg of parlay.legs || []) {
      const g = String(leg.matchup || '').toLowerCase();
      if (seen.has(g)) errors.push('parlay repeats a game');
      seen.add(g);
    }
    const factor = Number(parlay.correlationFactor != null ? parlay.correlationFactor : parlay.correlationHaircut);
    if (parlay.independent === false && !(factor < 1)) errors.push('correlated parlay haircut is not below 1');
    if (!(Number(parlay.evRaw) >= PARLAY_MIN_EV)) errors.push('parlay EV is under 3%');
  }
  if ((card.straightUnits || 0) > 3.5 + 1e-9) errors.push('straight budget exceeded');
  if ((card.totalUnits || 0) > 4 + 1e-9) errors.push('card budget exceeded');
  return errors;
}

module.exports = {
  assertNoLeakage,
  recheckPrices,
  toPick,
  toParlay,
  validateCard,
  parseAmerican,
  ratingFor,
  fmtU,
};
