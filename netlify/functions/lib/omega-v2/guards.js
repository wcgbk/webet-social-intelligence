'use strict';

const {
  MODEL_VERSION, MAX_STRAIGHTS, PER_BET_CAP, STRAIGHT_BUDGET, CARD_BUDGET, PARLAY_STAKE_CAP,
} = require('./constants');
const { assertNoLeakage } = require('./calibrate');
const { marketFamily } = require('./select');
const { bannedPairReason } = require('./parlay');
const { americanJuiceDelta, ratingToConfidence } = require('../omega-vnext/odds_math');

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
    edgeNovig: row.edgeNovig != null ? row.edgeNovig : null,
    ev: pct(row.ev),
    evRaw: row.ev,
    confidence: ratingToConfidence(rating),
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

function unitsOf(row) {
  const n = Number(row && row.unitsNum != null ? row.unitsNum : String(row && row.units || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * QA never withholds a straight card. Round stakes, cap them, drop a
 * duplicate game. A parlay whose stake rounds under 0.25u is removed.
 * It is not floored back up to 0.25u.
 */
function autoCorrectCard(card) {
  const notes = [];
  const out = {
    ...(card || {}),
    picks: [...((card && card.picks) || [])],
    parlayLegs: [...((card && card.parlayLegs) || [])],
  };
  if (out.modelVersion !== MODEL_VERSION) {
    notes.push('stamped model version');
    out.modelVersion = MODEL_VERSION;
  }
  if (out.leakageChecked !== true) {
    notes.push('marked leakage checked');
    out.leakageChecked = true;
  }
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
      notes.push(`dropped dust stake ${p.pick || p.side}`);
      continue;
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
    } else {
      notes.push(`budget dropped ${victim.pick || victim.side}`);
      picks.shift();
    }
  }
  out.picks = picks;
  if (out.parlayLegs.length > 1) {
    notes.push('kept one parlay');
    out.parlayLegs = out.parlayLegs.slice(0, 1);
  }
  if (out.parlayLegs[0]) {
    const pl = { ...out.parlayLegs[0], legs: (out.parlayLegs[0].legs || []).map((leg) => ({ ...leg, modelVersion: MODEL_VERSION })) };
    let u = Math.round(unitsOf(pl) * 4) / 4;
    if (u > PARLAY_STAKE_CAP) u = PARLAY_STAKE_CAP;
    if (!(u >= 0.25)) {
      notes.push('parlay stake rounded to 0');
      out.parlayLegs = [];
    } else {
      pl.unitsNum = u;
      pl.units = `${u}u`;
      pl.modelVersion = MODEL_VERSION;
      pl.stakeUsd = Math.ceil(u * 150 - 1e-9);
      out.parlayLegs = [pl];
    }
  }
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
    const banned = bannedPairReason(parlay.legs);
    if (banned) errors.push(banned);
    for (const leg of parlay.legs || []) {
      const edge = Number(leg.edgeNovig != null ? leg.edgeNovig : leg.edge);
      if (Number.isFinite(edge) && !(edge > 0)) errors.push(`parlay leg edge is not positive (${leg.pick})`);
    }
  }
  if ((card.straightUnits || 0) > STRAIGHT_BUDGET + 1e-9) errors.push('straight budget exceeded');
  if ((card.totalUnits || 0) > CARD_BUDGET + 1e-9) errors.push('card budget exceeded');
  return errors;
}

function normQuote(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchOutcome(outcomes, leg) {
  const pick = normQuote(leg && (leg.pick || leg.side));
  const wantTotal = /^\s*over\b/.test(pick) ? 'over' : (/^\s*under\b/.test(pick) ? 'under' : null);
  const line = leg && leg.line != null && leg.line !== '' ? Number(leg.line) : null;
  for (const o of outcomes || []) {
    const name = normQuote(o && o.name);
    if (wantTotal) {
      if (name !== wantTotal) continue;
    } else if (pick && name && !pick.includes(name) && !name.includes(pick.split(' ')[0])) {
      continue;
    }
    if (line != null && o.point != null && Math.abs(Number(o.point) - line) > 0.51 && !wantTotal && marketFamily(leg.market, leg.pick) !== 'Moneyline') {
      continue;
    }
    if (Number.isFinite(Number(o.price))) return o;
  }
  return null;
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
    const order = [leg.book, 'draftkings', 'hardrockbet', 'hardrock', 'pinnacle', 'fanduel', 'betmgm'];
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
  assertNoLeakage,
  recheckPrices,
  toPick,
  toParlay,
  validateCard,
  autoCorrectCard,
  recheckFromCachedBoard,
  parseAmerican,
  ratingFor,
  fmtU,
};
