'use strict';

/**
 * Historical parlayFromStraights closure from d9d53c6.
 * Loaded only when OMEGA_FIX_MISSING_IMPORTS_C is on.
 * Frozen parlay.js, select.js, and odds_math.js are not edited.
 * marketAnchorOn stays false (the historical switch).
 */

const {
  PARLAY_FIXED_UNITS,
  UNIT_DOLLARS,
  QUALITY_GRADE,
  PM_SOFT,
  MARKET_ANCHOR_MODEL_WEIGHT,
} = require('./config');
const { parlayCorrEnabled, PARLAY_TOTAL_RHO } = require('./gaps_flags');

function marketAnchorOn() {
  return false;
}

const CORR_HAIRCUT_PER_LEG = 0.95;
const EV_CAP_ALL = 0.10;
const LEAN_PARLAY_UNITS = 0.25;
const PARLAY_MIN_COVER = 0.45;
const PARLAY_TOTAL_HAIRCUT = { 2: 0.95, 3: 0.92 };
const NO_QUALIFYING_PARLAY = 'no qualifying parlay';
const FAIR_LEAN_LABEL = 'lean - negative EV at fair price';
const EDGE_EV_BAND = 0.002;
const SCORE_NUDGE_CAP = 0.002;
const THRESHOLDS = {
  minEdgePts: 2,
  minEv: 0.02,
  realisticEdgePts: 5,
  auditEdgePts: 10,
  auditEv: 0.10,
  implausibleEdgePts: 24,
  implausibleEv: 0.40,
  unitDollars: 150,
  minProfitDollars: 3,
  minRoi: 0.02,
};

function evAtOdds(p, american) {
  const dec = americanToDecimal(american);
  if (dec == null || !Number.isFinite(p)) return null;
  return p * dec - 1;
}

function pushAwareEv(p, american, pPush) {
  void pPush;
  return evAtOdds(p, american);
}

function parlayFromStraights(straights, opts = {}) {
  const rows = (straights || []).filter(Boolean);
  const pool = (opts && opts.pool) || [];
  if (!rows.length && !(pool && pool.length)) return [];
  const anchorOn = marketAnchorOn();
  // Two published straights are the ticket. Do not pull a third game from the pool.
  if (!anchorOn && rows.length === 2) {
    const pair = twoTeamFromPublished(rows);
    if (!pair) {
      return [noQualifyingParlay('two published straights did not clear as a 2-team parlay')];
    }
    const _pair = ticketFromLegs(pair, rows, opts);
    const _pev = _pair[0] && (_pair[0].evRaw != null ? Number(_pair[0].evRaw) : parseFloat(_pair[0].ev));
    if (_pair[0] && _pair[0].qualifying !== false && !(_pev > 0)) return [noQualifyingParlay('combined parlay EV not positive')];
    return _pair;
  }
  const merged = [];
  const seenId = new Set();
  for (const row of pool.concat(rows)) {
    const priced = priceCardLeg(row);
    if (!priced) continue;
    const id = parlaySideId(priced);
    if (seenId.has(id)) continue;
    seenId.add(id);
    merged.push(priced);
  }
  const anchor = marketAnchorOn();
  if (anchor) {
    merged.sort((a, b) => {
      const d = (Number(b.ev) || 0) - (Number(a.ev) || 0);
      if (Math.abs(d) > 1e-12) return d;
      return (Number(b.edgePct) || 0) - (Number(a.edgePct) || 0);
    });
  } else {
    merged.sort(compareByEdge);
  }
  const chosen = [];
  const games = new Set();
  const straightIdSet = new Set(rows.map((row) => parlaySideId(row)));
  // Anchor path: qualifying straights with positive EV.
  // Pure path: cover, EV band, and the margin ban. Edge rank is already applied.
  const legPool = anchor
    ? merged.filter((l) => Number(l.ev) > 0 && straightIdSet.has(parlaySideId(l)))
    : merged.filter(parlayLegQualifies);
  for (const leg of legPool) {
    const key = matchupKey(leg);
    if (!key || games.has(key)) continue;
    games.add(key);
    chosen.push(leg);
    if (chosen.length === 3) break;
  }
  if (anchor && chosen.length < 2) {
    return [noQualifyingParlay('fewer than 2 qualifying positive-EV legs')];
  }
  if (!anchor && chosen.length < 3) {
    return [noQualifyingParlay('fewer than 3 games with cover >= 45% and positive stake EV at or under the EV cap')];
  }
  const ticket = ticketFromLegs(chosen, rows, opts);
  // Sheet-aligned (2026-10-18): no parlay publishes at combined EV <= 0
  // (after the 0.95^(n-1) haircut inside comboStats).
  const _tev = ticket[0] && (ticket[0].evRaw != null ? Number(ticket[0].evRaw) : parseFloat(ticket[0].ev));
  if (ticket[0] && ticket[0].qualifying !== false && !( _tev > 0)) {
    return [noQualifyingParlay('combined parlay EV not positive')];
  }
  if (ticket[0] && ticket[0].qualifying !== false) ticket[0].candidatesScanned = merged.length;
  return ticket;
}

function publishGatedLeg(leg, straights) {
  const base = { ...leg };
  // publishLeg returns a pick object unchanged. Price from the candidate
  // fields so the card leg does not carry the book ladder.
  delete base.pick;
  delete base.bookPrices;
  delete base.hardRock;
  const published = publishLeg(base);
  published.odds = formatAmerican(leg.odds);
  published.coverProb = `${(leg.coverProb * 100).toFixed(1)}%`;
  published.p_cal = +Number(leg.coverProb).toFixed(6);
  const shownLegEv = evAtShownPrice(leg.coverProb, published.odds);
  const shownEvStr = formatEdgePct(shownLegEv != null ? shownLegEv : Number(leg.ev))
    || `${(Number(leg.ev) * 100).toFixed(1)}%`;
  // evRaw stays the unrounded stake EV. Grading below uses that edge too.
  published.evRaw = +Number(leg.ev).toFixed(6);
  const cover = unifiedCoverProb(leg);
  const edgeFrac = edgeFractionOf(leg, cover);
  // Same one-decimal cover rule as the straight badge. The stored edge
  // used for rank and grade is edgeFrac, not this display string.
  const computed = printedEdgeEv({
    coverProb: cover,
    odds: numericAmerican(leg.odds),
    edgePct: edgeFrac,
    ev: leg.ev,
  });
  const straight = sameBetStraight(leg, straights);
  const straightEdge = printedPct(straight && (straight.edge != null && straight.edge !== '' ? straight.edge : straight.edgePct));
  const straightEv = printedPct(straight && straight.ev);
  // The straight badge already rounded this bet. Copy that cover string too,
  // so a p_cal that moved the tenth (0.64749 → 0.6475) does not print 64.8%
  // next to the straight's 5.5% edge. p_cal and evRaw stay on the leg.
  const straightCover = printedPct(straight && straight.coverProb);
  if (straightCover) published.coverProb = straightCover;
  const edgeStr = straightEdge || computed.edgePctStr || formatEdgePct(edgeFrac) || published.edgePct || null;
  published.ev = straightEv || shownEvStr;
  const rating = normalizeRatingKey(leg.rating || leg.qualityGrade || leg.grade)
    || qualityToRating(edgeFrac, null, null);
  published.edgePct = edgeStr || published.edgePct;
  published.edge = edgeStr;
  published.rating = rating;
  published.qualityGrade = rating;
  published.grade = ratingLetter(rating);
  published.book = published.book || leg.book || null;
  published.sport = published.sport || leg.sport || null;
  published.matchup = published.matchup || leg.matchup || null;
  published.pick = published.pick || formatMoneylinePick(leg.side || leg.pick, leg.market || leg.betType);
  if (published.confidence == null) published.confidence = ratingToConfidence(rating);
  if (!published.gameTime) {
    published.gameTime = formatGameTimeET(published.commenceTime || leg.commenceTime) || null;
  }
  published.probBasis = 'unified-adjusted-cover';
  if (leg.hardRockRepriced) published.hardRockRepriced = true;
  if (leg.tier) published.tier = leg.tier;
  Object.assign(published, fairPickFields(leg));
  return published;
}

function parlayLegQualifies(leg) {
  if (!leg || leg.marginBiasExtreme) return false;
  // Sheet gate (2026-10-18): a parlay leg must be a GOOD BET on core metrics.
  if (!passesSheetMinimums(leg)) return false;
  const cover = Number(leg.coverProb);
  if (!(Number.isFinite(cover) && cover + 1e-12 >= PARLAY_MIN_COVER)) return false;
  const ev = Number(leg.ev);
  if (!(Number.isFinite(ev) && ev > 1e-12)) return false;
  const maxEV = Number(EV_CAP_ALL);
  if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return false;
  return true;
}

function compareByEdge(a, b) {
  const ea = edgeRank(a);
  const eb = edgeRank(b);
  const bothEdges = Number.isFinite(ea) && Number.isFinite(eb);
  if (bothEdges && Math.abs(ea - eb) <= EDGE_EV_BAND) {
    const evd = finiteEv(b) - finiteEv(a);
    if (Math.abs(evd) > 1e-12) return evd;
  }
  const d = eb - ea;
  if (Math.abs(d) > 1e-12) return d;
  if (bothEdges) {
    const nd = selectionNudge(b) - selectionNudge(a);
    if (Math.abs(nd) > 1e-12) return nd;
  }
  return 0;
}

function twoTeamFromPublished(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) return null;
  const priced = [];
  const games = new Set();
  const maxEV = Number(EV_CAP_ALL);
  for (const row of rows) {
    if (row && row.marginBiasExtreme) return null;
    if (!passesSheetMinimums(row)) return null; // sheet gate: mirror legs too
    const leg = priceCardLeg(row);
    if (!leg || leg.marginBiasExtreme) return null;
    const ev = Number(leg.ev);
    if (!(ev > 1e-12)) return null;
    if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return null;
    const key = matchupKey(leg);
    if (!key || games.has(key)) return null;
    games.add(key);
    priced.push(leg);
  }
  return priced.length === 2 ? priced : null;
}

function noQualifyingParlay(reason) {
  const why = reason || 'no positive-EV 3-leg from distinct games';
  console.log(`[omega-vnext] parlay none — no qualifying parlay (${why})`);
  return {
    type: 'no-qualifying-parlay',
    status: NO_QUALIFYING_PARLAY,
    label: NO_QUALIFYING_PARLAY,
    qualifying: false,
    legs: [],
    units: null,
    ev: null,
    evRaw: null,
    combinedOdds: '',
    combinedProb: null,
    combinedProbRaw: null,
    reason: why,
    source: 'omega-vnext',
  };
}

function ticketFromLegs(chosen, rows, opts) {
  const st = comboStats(chosen);
  const anchor = marketAnchorOn();
  if (anchor && !(st.ev > 0) && !(chosen.length === 3 && Number.isFinite(st.evAtFair))) {
    return [noQualifyingParlay('combined EV not positive')];
  }
  const labeled = !(st.ev > 0);
  const straightIds = new Set(rows.map((row) => parlaySideId(row)));
  const mirrored = rows.length >= chosen.length
    && chosen.every((leg) => straightIds.has(parlaySideId(leg)));
  const labelInput = { ...st, legs: chosen };
  const evLabel = parlayEvLabel(labelInput);
  const publishedLegs = chosen.map((leg) => publishGatedLeg(leg, rows));
  const fromLegs = combinedFromLegOdds(publishedLegs);
  const combinedDecimal = fromLegs ? fromLegs.combinedDecimal : st.combinedDecimal;
  const combinedOdds = fromLegs
    ? fromLegs.combinedOdds
    : (decimalToAmerican(st.combinedDecimal) == null ? '' : formatAmerican(decimalToAmerican(st.combinedDecimal)));
  const stakeUnits = publishedParlayUnits(rows);
  const n = chosen.length;
  const modelEvStr = formatEdgePct(st.evAtModel != null ? st.evAtModel : st.ev);
  const ticket = {
    type: labeled ? `${n}-leg-parlay-labeled` : `${n}-leg-parlay`,
    legs: publishedLegs,
    units: `${stakeUnits}u`,
    ...(labeled ? { leanDay: true, label: 'combined EV not positive' } : {}),
    qualifying: true,
    combinedOdds,
    combinedDecimal: Number.isFinite(combinedDecimal) ? +combinedDecimal.toFixed(2) : null,
    evLabel,
    riskDollars: stakeDollars(stakeUnits),
    toWinDollars: toWinDollars(stakeUnits, combinedOdds),
    combinedProb: Number.isFinite(st.combinedProb) ? `${(st.combinedProb * 100).toFixed(1)}%` : '',
    combinedProbRaw: Number.isFinite(st.combinedProb) ? st.combinedProb : null,
    ev: modelEvStr || '',
    evAtModel: modelEvStr,
    evAtFair: st.evAtFair == null ? null : formatEdgePct(st.evAtFair),
    evRaw: Number.isFinite(st.ev) ? st.ev : null,
    uniqueGames: st.uniqueGames,
    uniqueSports: st.uniqueSports,
    independent: parlayIndependent(labelInput),
    mirrorsCard: mirrored,
    legMarkets: chosen.map((leg) => leg.market || leg.betType || null),
    correlationNote: evLabel,
    candidatesScanned: chosen.length,
    autoCorrected: !mirrored,
    probBasis: 'unified-adjusted-cover',
    evBasis: 'combined-prob-times-decimal-minus-1',
    source: 'omega-vnext',
  };
  if (opts && opts.hrPlaceabilityNote) ticket.hrPlaceabilityNote = opts.hrPlaceabilityNote;
  if (chosen.length === 3) stampFairParlay(ticket, st.evAtFair);
  if (!mirrored || labeled) {
    const names = chosen.map((leg) => leg.side || leg.pick).join(' | ');
    console.log(`[omega-vnext] parlay ${labeled ? 'labeled' : 'auto-correct'} ev=${ticket.ev} legs=${names}`);
  }
  return [ticket];
}

function priceCardLeg(row) {
  if (!row) return null;
  const prob = unifiedCoverProb(row);
  const odds = numericOdds(row.odds != null ? row.odds : row.oddsStr);
  if (!Number.isFinite(prob) || !Number.isFinite(odds)) return null;
  const dec = americanToDecimal(odds);
  if (!Number.isFinite(dec) || !(dec > 1)) return null;
  const edge = edgeFractionOf(row, prob);
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    odds,
    coverProb: prob,
    p_cal: prob,
    ev: prob * dec - 1,
    edgePct: Number.isFinite(edge) ? edge : row.edgePct,
    matchup: row.matchup || `${row.awayTeam} @ ${row.homeTeam}`,
  };
}

function parlaySideId(row) {
  const side = String((row && (row.side || row.pick)) || '').trim().toLowerCase();
  const market = String((row && (row.market || row.betType)) || '').trim().toLowerCase();
  return `${matchupKey(row)}|${market}|${side}`;
}

function matchupKey(c) {
  const name = canonicalGameName(c);
  const when = (c && (c.commenceTime || c.commence_time)) || '';
  // Doubleheader halves are different games. An empty commence stays
  // name-only so two undated legs of one matchup still conflict, and the
  // undated key has no "|" suffix.
  if (!when) return name;
  return `${name}|${String(when)}`;
}

function comboStats(legs) {
  const list = legs || [];
  let combinedDecimal = 1;
  let independent = 1;
  let fairProd = 1;
  let fairOk = list.length > 0;
  for (const l of list) {
    combinedDecimal *= americanToDecimal(l.odds);
    independent *= Number(l.coverProb);
    const fp = legFairP(l);
    if (fp == null) fairOk = false;
    else fairProd *= fp;
  }
  const n = list.length;
  const bias = n > 1 ? Math.pow(Number(CORR_HAIRCUT_PER_LEG) || 0.95, n - 1) : 1;
  let combinedProb = independent;
  let corrApplied = false;
  if (Number.isFinite(independent)) {
    combinedProb = independent * bias;
    if (parlayCorrEnabled() && sameDirectionSides(list)) {
      const corr = correlatedTotalFactor(list.map(l => Number(l.coverProb)));
      if (Number.isFinite(corr) && corr > 0 && corr < 1) {
        const lowered = independent * corr;
        if (Number.isFinite(lowered) && lowered < combinedProb) {
          combinedProb = lowered;
          corrApplied = true;
        }
      }
    }
    if (!Number.isFinite(combinedProb) || combinedProb > independent) combinedProb = independent;
  }
  const ev = combinedProb * combinedDecimal - 1;
  const evAtFair = fairOk && Number.isFinite(combinedDecimal) ? (fairProd * combinedDecimal) - 1 : null;
  const games = new Set(list.map(matchupKey)).size;
  const sports = new Set(list.map(l => l.sport)).size;
  return {
    combinedDecimal,
    combinedProb,
    ev,
    evAtModel: ev,
    evAtFair,
    uniqueGames: games,
    uniqueSports: sports,
    haircutApplied: {
      applied: Number.isFinite(bias) && bias < 1,
      factor: bias,
      kind: 'same-model-bias',
    },
    corrApplied,
  };
}

function publishLeg(leg) {
  if (leg && leg.pick && (leg.betType || leg.odds)) return { ...leg };
  const cover = coverFraction(leg && leg.coverProb);
  const american = numericAmerican(leg && leg.odds);
  const edgeRaw = leg && leg.edgePct;
  let edgePct = edgeRaw;
  if (typeof edgeRaw === 'number') {
    edgePct = formatEdgePct(edgeRaw <= 1 ? edgeRaw : edgeRaw / 100) || undefined;
  }
  return {
    pick: formatMoneylinePick(leg.side, leg.market),
    pickDisplay: formatMoneylinePick(leg.side, leg.market),
    sport: leg.sport,
    matchup: leg.matchup || `${leg.awayTeam || ''} @ ${leg.homeTeam || ''}`,
    betType: leg.market,
    odds: american == null ? '' : formatAmerican(american),
    commenceTime: leg.commenceTime || '',
    coverProb: cover == null ? '' : `${(cover * 100).toFixed(1)}%`,
    ev: Number.isFinite(Number(leg.ev)) ? `${(Number(leg.ev) * 100).toFixed(1)}%` : (leg.ev != null ? String(leg.ev) : ''),
    edgePct,
    homeTeam: leg.homeTeam,
    awayTeam: leg.awayTeam,
    book: leg.book || null,
    line: leg.line != null ? leg.line : null,
    tier: leg.tier || 'floor',
    coreReasoning: leg.coreReasoning || '',
    source: 'omega-vnext',
  };
}

function formatAmerican(american) {
  const a = Math.round(Number(american));
  if (!Number.isFinite(a)) return '';
  return a > 0 ? `+${a}` : `${a}`;
}

function evAtShownPrice(prob, american) {
  const shown = shownFraction(prob);
  const dec = americanToDecimal(numericAmerican(american));
  if (shown == null || !Number.isFinite(dec) || !(dec > 1)) return null;
  return shown * dec - 1;
}

function formatEdgePct(edgeFrac) {
  if (!Number.isFinite(edgeFrac)) return null;
  const negative = edgeFrac < 0;
  const tenths = Math.round(Math.abs(edgeFrac) * 1000 + 1e-8);
  const whole = Math.trunc(tenths / 10);
  const frac = tenths % 10;
  return `${negative && tenths !== 0 ? '-' : ''}${whole}.${frac}%`;
}

function unifiedCoverProb(row) {
  if (!row) return null;
  const raw = row.coverProb;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  const calibrated = Number(row.p_cal);
  if (Number.isFinite(calibrated) && calibrated > 0 && calibrated <= 1) return calibrated;
  const parsed = numericProb(raw != null ? raw : row.winProbability);
  if (parsed != null && parsed > 0 && parsed <= 1) return parsed;
  return null;
}

function edgeFractionOf(row, prob) {
  const parsed = parseEdgeFraction(row && (row.edgePct != null ? row.edgePct : row.edge));
  if (Number.isFinite(parsed)) return parsed;
  const fair = Number(row && (row.fair_sharp_p != null ? row.fair_sharp_p : row.sharpFairP));
  if (Number.isFinite(prob) && Number.isFinite(fair)) return prob - fair;
  return null;
}

function printedEdgeEv(c) {
  const edgeFrac = parseEdgeFraction(c && c.edgePct);
  const fullCover = Number(c && c.coverProb);
  const shownCover = Number.isFinite(fullCover)
    ? Number((fullCover * 100).toFixed(1)) / 100
    : null;
  const price = Number(c && c.odds);
  const canPrice = shownCover != null && Number.isFinite(price);
  const fullImplied = canPrice ? americanToImplied(price) : null;
  const shownDecimal = canPrice ? americanToDecimal(price) : null;
  const fullEdge = canPrice ? fullCover - fullImplied : null;
  const shownEdge = canPrice ? shownCover - fullImplied : null;
  // Half a tenth: the stored edge is this cover minus the price.
  // 1e-9 absorbs a float that lands one ulp over 0.0005 (32.8% at +220).
  const edgeFromShown = fullEdge != null && shownEdge != null
    && Number.isFinite(edgeFrac) && Math.abs(edgeFrac - fullEdge) <= 0.0005 + 1e-9;
  const displayEdge = edgeFromShown ? shownEdge : edgeFrac;
  const edgePctStr = formatEdgePct(displayEdge) || '0.0%';
  const evParsed = c && (c.ev == null || c.ev === '') ? null : Number(c && c.ev);
  const fullEv = canPrice ? (fullCover * shownDecimal) - 1 : null;
  const shownEv = canPrice ? (shownCover * shownDecimal) - 1 : null;
  // 0.0015 covers a reserve fill that reprints the one-decimal win rate
  // with the unrounded stake EV (about 0.1pp under). A stored 0 stays 0.
  // An edge that is not this cover minus the price does not snap.
  const evFromShown = edgeFromShown && fullEv != null && shownEv != null
    && Number.isFinite(evParsed) && evParsed !== 0
    && Math.abs(evParsed - fullEv) <= 0.0015;
  // EV print fix (2026-10-18): print EV from the UNROUNDED final p, not the
  // one-decimal shown cover (that snap caused a ~0.25pt drift vs hand math).
  const evNum = Number.isFinite(fullEv) ? fullEv : (Number.isFinite(evParsed) ? evParsed : null);
  void evFromShown;
  const evStr = evNum == null || !Number.isFinite(evNum) ? null : formatEdgePct(evNum);
  return { edgeFrac, edgeFromShown, displayEdge, edgePctStr, evNum, evStr };
}

function numericAmerican(odds) {
  if (typeof odds === 'number' && Number.isFinite(odds) && odds !== 0) return odds;
  if (odds == null || odds === '') return null;
  const n = Number(String(odds).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function sameBetStraight(leg, straights) {
  if (!leg || !Array.isArray(straights)) return null;
  for (const straight of straights) {
    if (!straight || !parlayIsCardMirror([leg], [straight])) continue;
    const legOdds = numericAmerican(leg.odds);
    const straightOdds = numericAmerican(straight.odds != null ? straight.odds : straight.oddsStr);
    if (legOdds != null && straightOdds != null && legOdds !== straightOdds) continue;
    const legLine = leg.line != null && leg.line !== '' ? Number(leg.line) : null;
    const straightLine = straight.line != null && straight.line !== '' ? Number(straight.line) : null;
    if (Number.isFinite(legLine) && Number.isFinite(straightLine) && Math.abs(legLine - straightLine) > 1e-9) continue;
    return straight;
  }
  return null;
}

function printedPct(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text.includes('%') ? text : null;
}

function normalizeRatingKey(rating) {
  const r = String(rating == null ? '' : rating).trim().toLowerCase().replace(/\s+/g, '');
  if (r === 'a+' || r === 'aplus') return 'aplus';
  if (r === 'a') return 'a';
  if (r === 'a-' || r === 'aminus') return 'aminus';
  if (r === 'b+' || r === 'bplus') return 'bplus';
  if (r === 'b') return 'b';
  if (r === 'lean') return 'lean';
  return '';
}

function qualityToRating(edgeFrac, predictedClv, uncertainty) {
  const edge = parseEdgeFraction(edgeFrac);
  if (edge == null) return 'b';
  const score = qualityScore(edge, predictedClv, uncertainty);
  if (score >= QUALITY_GRADE.aplus) return 'aplus';
  if (score >= QUALITY_GRADE.a) return 'a';
  if (score >= QUALITY_GRADE.aminus) return 'aminus';
  return 'b'; // <2.0% — B only (no B+ on quality path)
}

function ratingLetter(rating) {
  const key = normalizeRatingKey(rating);
  return ({
    aplus: 'A+', a: 'A', aminus: 'A-', bplus: 'B+', b: 'B', lean: 'Lean',
  })[key] || null;
}

function formatMoneylinePick(side, market) {
  const s = String(side || '').trim();
  if (!s) return s;
  const m = String(market || '');
  const isML = /moneyline/i.test(m) || (/\bml\b/i.test(m) && !/spread|total|run line/i.test(m));
  if (!isML) return s;
  if (/\bML\b/i.test(s)) return s;
  if (/[+-]\d/.test(s)) return s;
  if (/^(?:F5\s+)?(?:Over|Under)\b/i.test(s)) return s;
  return `${s} ML`;
}

function ratingToConfidence(rating) {
  return ({ aplus: 90, a: 82, aminus: 75, bplus: 68, b: 60, lean: 52 })[rating] || 60;
}

function formatGameTimeET(iso) {
  if (iso == null || iso === '') return null;
  try {
    const d = iso instanceof Date ? iso : new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const clock = d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return clock ? `${clock} ET` : null;
  } catch (_) {
    return null;
  }
}

function fairPickFields(c) {
  const fair = fairNumber(c);
  const dec = americanToDecimal(c && (c.odds != null ? c.odds : c.oddsStr));
  const evFair = fair != null && dec != null
    ? pushAwareEv(fair, c && (c.odds != null ? c.odds : c.oddsStr), c && c.pPush)
    : null;
  const raw = c && c.p_model != null ? Number(c.p_model) : null;
  const weight = c && c.anchorWeight != null ? Number(c.anchorWeight) : null;
  return {
    fairP: pctString(fair),
    // Published picks rename these fields (fairSource/modelWeight). Accept
    // either spelling so parlay legs rebuilt from a published pick do not
    // lose their fair source/weight (2026-10-18 card: legs printed
    // fairSource 'none', modelWeight null, evAtFair -4.7% vs straight -4.6%).
    fairSource: (c && (c.anchorFairSource || c.fairSource)) || 'none',
    evAtFair: evFair == null || !Number.isFinite(evFair) ? null : formatEdgePct(evFair),
    p_model: raw != null && Number.isFinite(raw) ? +raw.toFixed(4) : null,
    p_fair: fair != null ? +Number(fair).toFixed(6) : null,
    modelWeight: (weight != null && Number.isFinite(weight))
      ? weight
      : (c && c.modelWeight != null && Number.isFinite(Number(c.modelWeight)) ? Number(c.modelWeight) : null),
  };
}

function passesSheetMinimums(c) { return sheetCheckForCandidate(c).verdict === 'GOOD BET'; }

function edgeRank(c) {
  const e = parseEdgeFraction(c && c.edgePct);
  return Number.isFinite(e) ? e : -Infinity;
}

function finiteEv(c) {
  const n = Number(c && c.ev);
  return Number.isFinite(n) ? n : -Infinity;
}

function selectionNudge(c) {
  if (!c || typeof c !== 'object') return 0;
  let nudge = clampPmScoreAdj(c._pmScoreAdj);
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return nudge;
}

function parlayEvLabel(ticketOrStats) {
  const info = adjustmentOf(ticketOrStats);
  let label = '';
  if (info.share) label = 'legs share a game: not independent';
  else if (info.corr) label = 'correlation-adjusted';
  else if (info.hair.applied) {
    const kind = info.hair.kind === 'same-model-bias' ? 'same-model-bias' : 'same-direction totals';
    label = `${kind} haircut x${formatHaircutFactor(info.hair.factor)} applied`;
  } else if (info.distinct) label = 'assumes independent legs (different games)';
  const plain = !!(ticketOrStats && ticketOrStats.plainProduct === true);
  if (plain && label && (info.hair.applied || info.corr)) {
    const which = info.corr && info.hair.applied
      ? 'haircut and correlation adjustment were not applied'
      : (info.corr ? 'correlation adjustment was not applied' : 'haircut was not applied');
    label = `${label}; displayed EV is a plain product of the leg probabilities (${which})`;
  }
  return label;
}

function combinedFromLegOdds(legs) {
  let dec = 1;
  for (const leg of legs || []) {
    const american = numericAmerican(leg && leg.odds);
    const d = americanToDecimal(american);
    if (!(d > 1)) return null;
    dec *= d;
  }
  if (!(dec > 1)) return null;
  const american = decimalToAmerican(dec);
  return {
    combinedDecimal: dec,
    combinedOdds: american == null ? '' : formatAmerican(american),
  };
}

function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function publishedParlayUnits(picks) {
  const rows = (picks || []).filter(Boolean);
  const leanOnly = rows.length > 0 && rows.every((p) => p.tier === 'lean');
  if (leanOnly || !cardHasFullGrade(rows)) return LEAN_PARLAY_UNITS;
  return PARLAY_FIXED_UNITS;
}

function stakeDollars(units) {
  const n = typeof units === 'number' && Number.isFinite(units) ? units : parseStakeUnits(units);
  if (n == null) return 0;
  return wholeUpNumber(n * UNIT_DOLLARS);
}

function toWinDollars(units, american) {
  const risk = stakeDollars(units);
  if (!risk) return 0;
  const a = Number(String(american == null ? '' : american).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(a) || a === 0) return 0;
  const profit = a > 0 ? risk * (a / 100) : risk * (100 / Math.abs(a));
  return wholeUpNumber(profit);
}

function parlayIndependent(ticketOrStats) {
  const info = adjustmentOf(ticketOrStats);
  return info.distinct && !info.share && !info.hair.applied && !info.corr;
}

function stampFairParlay(ticket, evAtFair) {
  if (!ticket || !Array.isArray(ticket.legs) || ticket.legs.length !== 3) return ticket;
  // null is a missing fair price. Number(null) is 0, which would fake a lean.
  if (evAtFair == null || evAtFair === '') return ticket;
  const fair = Number(evAtFair);
  if (!Number.isFinite(fair)) return ticket;
  const n = ticket.legs.length;
  if (fair > 0) {
    ticket.isLean = false;
    if (ticket.label === 'combined EV not positive') {
      delete ticket.label;
      delete ticket.leanDay;
      if (typeof ticket.type === 'string' && ticket.type.endsWith('-labeled')) {
        ticket.type = `${n}-leg-parlay`;
      }
    }
    return ticket;
  }
  const stake = Number(LEAN_PARLAY_UNITS);
  const units = Number.isFinite(stake) ? stake : 0.25;
  ticket.isLean = true;
  ticket.leanDay = true;
  ticket.label = FAIR_LEAN_LABEL;
  ticket.qualifying = true;
  ticket.type = `${n}-leg-parlay-labeled`;
  ticket.units = `${units}u`;
  ticket.riskDollars = stakeDollars(units);
  if (ticket.combinedOdds) ticket.toWinDollars = toWinDollars(units, ticket.combinedOdds);
  return ticket;
}

function numericOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

function canonicalGameName(c) {
  const row = c || {};
  const fromParts = (left, right) => [cleanTeam(left), cleanTeam(right)].filter(Boolean).sort().join(' @ ');
  const splitTeams = (raw) => {
    const parts = cleanTeam(raw).split(/\s+(?:@|vs\.?|at)\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return '';
    return fromParts(parts[0], parts.slice(1).join(' '));
  };
  const fromMatchup = splitTeams(row.matchup);
  if (fromMatchup) return fromMatchup;
  const home = cleanTeam(row.homeTeam);
  const away = cleanTeam(row.awayTeam);
  if (home && away && home !== 'undefined' && away !== 'undefined') return fromParts(away, home);
  const built = cleanTeam(`${row.awayTeam} @ ${row.homeTeam}`);
  return splitTeams(built) || built || cleanTeam(row.matchup);
}

function legFairP(l) {
  const direct = Number(l && l.p_fair);
  if (Number.isFinite(direct) && direct > 0 && direct < 1) return direct;
  const text = l && l.fairP;
  if (text == null || text === '') return null;
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  const p = String(text).includes('%') || n > 1 ? n / 100 : n;
  return p > 0 && p < 1 ? p : null;
}

function sameDirectionSides(legs) {
  const list = Array.isArray(legs) ? legs : [];
  if (list.length < 2) return null;
  const sides = [];
  for (const leg of list) {
    const side = totalDirection(leg);
    if (!side) return null;
    sides.push(side);
  }
  if (!sides.every(s => s === sides[0])) return null;
  return sides;
}

function correlatedTotalFactor(probs) {
  if (!Array.isArray(probs) || probs.length < 2) return 1;
  for (const p of probs) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 1;
  }
  let joint = probs[0];
  let indep = probs[0];
  for (let i = 1; i < probs.length; i++) {
    const p = joint;
    const q = probs[i];
    const cov = PARLAY_TOTAL_RHO * Math.sqrt(Math.max(0, p * (1 - p) * q * (1 - q)));
    let next = p * q + cov;
    const lo = Math.max(0, p + q - 1);
    const hi = Math.min(p, q);
    if (next < lo) next = lo;
    if (next > hi) next = hi;
    joint = next;
    indep *= q;
  }
  if (!(indep > 0) || !Number.isFinite(joint)) return 1;
  return joint / indep;
}

function coverFraction(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1 && v <= 100) return v / 100;
    return v;
  }
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return (s.includes('%') || n > 1) ? n / 100 : n;
}

function shownFraction(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Number((n * 100).toFixed(1)) / 100;
}

function numericProb(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1 ? value / 100 : value;
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const n = parseFloat(text.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return text.includes('%') || Math.abs(n) > 1 ? n / 100 : n;
}

function parseEdgeFraction(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) > 1 ? v / 100 : v;
  const s = String(v).trim();
  const n = parseFloat(s.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (s.includes('%') || Math.abs(n) > 1) return n / 100;
  return n;
}

function americanToImplied(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

function parlayIsCardMirror(legs, straights) {
  if (!Array.isArray(legs) || !legs.length || !Array.isArray(straights) || !straights.length) return false;
  return legs.every(leg => straights.some(straight => {
    const pick = ticketName(straight.pick || straight.side);
    const raw = ticketName(leg.side || leg.pick);
    const formatted = ticketName(formatMoneylinePick(leg.side || leg.pick, leg.market || leg.betType));
    if (!pick || (pick !== raw && pick !== formatted)) return false;
    const game = String(leg.matchup || '').trim().toLowerCase();
    const pg = String(straight.matchup || '').trim().toLowerCase();
    if (game && pg && game !== pg) return false;
    return true;
  }));
}

function qualityScore(edgeFrac, predictedClv, uncertainty) {
  const edge = parseEdgeFraction(edgeFrac);
  if (edge == null) return 0;

  // Edge remains decisive. CLV is expressed in cents-ish units and can move the
  // score by at most 0.15 percentage points; uncertainty is an even smaller nudge.
  const clv = Number(predictedClv);
  const clvBonus = Number.isFinite(clv) ? clamp(clv, -3, 3) * 0.0005 : 0;
  const unc = Number(uncertainty);
  const uncertaintyAdj = Number.isFinite(unc)
    ? clamp((0.18 - unc) * 0.005, -0.001, 0.001)
    : 0;
  return edge + clvBonus + uncertaintyAdj;
}

function fairNumber(c) {
  const direct = finiteProb(c && c.p_fair);
  if (direct != null) return direct;
  const text = c && c.fairP;
  if (text == null || text === '') return null;
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  const p = String(text).includes('%') || n > 1 ? n / 100 : n;
  return finiteProb(p);
}

function pctString(p) {
  if (p == null || !Number.isFinite(Number(p))) return null;
  return `${(Number(p) * 100).toFixed(1)}%`;
}

function sheetCheckForCandidate(c) {
  if (!c) return { verdict: 'NO BET', flagged: false, reason: 'missing-candidate' };
  // Published picks carry coverProb as a "55.0%" string; candidates as 0.55.
  let p = null;
  if (c.coverProb != null) {
    const raw = String(c.coverProb).trim();
    const n = Number(raw.replace('%', ''));
    p = Number.isFinite(n) ? (raw.includes('%') || n > 1 ? n / 100 : n) : null;
  }
  const odds = c.odds != null ? c.odds : c.oddsStr;
  if (p == null || !Number.isFinite(p)) return { verdict: 'NO BET', flagged: false, reason: 'missing-coverProb' };
  return checkCandidate(c, { pOverride: p });
}

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

function adjustmentOf(ticketOrStats) {
  const src = ticketOrStats && typeof ticketOrStats === 'object' && !Array.isArray(ticketOrStats)
    ? ticketOrStats
    : {};
  const legs = legListOf(ticketOrStats);
  let hair = src.haircutApplied && typeof src.haircutApplied === 'object'
    ? {
      applied: src.haircutApplied.applied === true,
      factor: Number(src.haircutApplied.factor),
      kind: src.haircutApplied.kind || null,
    }
    : null;
  let corr = typeof src.corrApplied === 'boolean' ? src.corrApplied : null;
  if (legs && (hair == null || corr == null)) {
    const numeric = legs.length > 0 && legs.every((leg) => leg && typeof leg.coverProb === 'number' && Number.isFinite(leg.coverProb));
    if (numeric) {
      const st = comboStats(legs);
      if (hair == null) hair = st.haircutApplied;
      if (corr == null) corr = st.corrApplied;
    } else if (legs.length) {
      // Printed covers are strings, so comboStats cannot rerun. The label
      // still uses the same-model-bias haircut: 0.95^(n-1) on every ticket.
      const n = legs.length;
      const per = Number(CORR_HAIRCUT_PER_LEG);
      const factor = n > 1 ? Math.pow(Number.isFinite(per) ? per : 0.95, n - 1) : 1;
      if (hair == null) hair = { applied: factor < 1, factor, kind: 'same-model-bias' };
      if (corr == null) corr = false;
    }
  }
  if (!hair) hair = { applied: false, factor: 1 };
  if (!Number.isFinite(hair.factor)) hair.factor = legs ? sameDirectionTotalFactor(legs) : 1;
  if (corr == null) corr = false;
  let share = false;
  let distinct = false;
  if (legs && legs.length) {
    const games = new Set(legs.map((leg) => matchupKey(leg)));
    share = games.size < legs.length;
    distinct = games.size === legs.length;
  }
  return { share, hair, corr, distinct };
}

function formatHaircutFactor(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n)) return String(factor);
  const text = String(n);
  if (!/[eE]/.test(text)) return text;
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function cardHasFullGrade(picks) {
  return (picks || []).some((p) => {
    if (!p) return false;
    const explicit = p.rating != null && String(p.rating).trim() !== ''
      ? p.rating
      : (p.qualityGrade != null && String(p.qualityGrade).trim() !== ''
        ? p.qualityGrade
        : p.grade);
    if (explicit != null && String(explicit).trim() !== '') return isFullCardGrade(explicit);
    const edge = parseEdgeFraction(p.edgePct != null ? p.edgePct : p.edge);
    if (edge != null) return edge + 1e-12 >= QUALITY_GRADE.aminus;
    return false;
  });
}

function parseStakeUnits(units) {
  if (units == null || units === '') return null;
  const n = parseFloat(String(units).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function wholeUpNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const up = Math.ceil(x - 1e-9);
  return Object.is(up, -0) ? 0 : up;
}

function cleanTeam(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function totalDirection(leg) {
  if (!leg) return null;
  const market = String(leg.market || leg.betType || '');
  const side = String(leg.side || leg.pick || '');
  const looksTotal = /total/i.test(market) || /^\s*(over|under)\b/i.test(side);
  if (!looksTotal) return null;
  if (/^\s*over\b/i.test(side)) return 'over';
  if (/^\s*under\b/i.test(side)) return 'under';
  return null;
}

function ticketName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+ml$/, '').trim();
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function checkCandidate(row, opts = {}) {
  const t = THRESHOLDS;
  const odds = row && (row.odds != null ? row.odds : row.oddsStr);
  // Simplified variant uses the anchored core p; caller may pass pOverride
  // (e.g. the already-published final coverProb) to audit a printed card.
  const p = opts.pOverride != null ? Number(opts.pOverride) : simplifiedProbability(row);
  const dec = americanToDecimal(odds);
  const implied = americanToImplied(odds);
  if (p == null || !Number.isFinite(p) || dec == null || implied == null) {
    return { verdict: 'NO BET', flagged: false, reason: 'missing-core-input', p: null };
  }
  const edgePts = (p - implied) * 100;
  const ev = p * dec - 1;
  const profitPerUnit = Math.sign(ev) * Math.ceil(Math.abs(ev * t.unitDollars) - 1e-9); // sheet ROUNDUP = away from zero
  const core = {
    edge: edgePts >= t.minEdgePts, ev: ev >= t.minEv,
    roi: ev >= t.minRoi, profit: profitPerUnit >= t.minProfitDollars,
  };
  const band = edgePts < t.minEdgePts ? 'BELOW BAND'
    : edgePts <= t.realisticEdgePts ? 'IN REALISTIC BAND' : 'ABOVE BAND';
  const credibility = (edgePts >= t.implausibleEdgePts || ev >= t.implausibleEv) ? 'IMPLAUSIBLE'
    : (edgePts > t.auditEdgePts || ev > t.auditEv) ? 'SUSPECT - AUDIT' : 'OK';
  const flagged = credibility !== 'OK';
  // Secondary weakness never changes the verdict; it is only reported.
  const secondaryWeak = !!(opts.secondaryWeak);
  let verdict = 'NO BET';
  if (!flagged && core.edge && core.ev && core.roi && core.profit) verdict = 'GOOD BET';
  else if (flagged) verdict = 'DO NOT BET - AUDIT';
  return { verdict, flagged, betCheckFlag: flagged ? credibility : null,
    band, credibility, core, secondaryWeak,
    p, edgePts: +edgePts.toFixed(3), ev: +ev.toFixed(4),
    profitPerUnit, kellyUnits: quarterKellyUnitsSimple(p, odds) };
}

function legListOf(ticketOrStats) {
  if (Array.isArray(ticketOrStats)) return ticketOrStats;
  if (ticketOrStats && Array.isArray(ticketOrStats.legs)) return ticketOrStats.legs;
  return null;
}

function sameDirectionTotalFactor(legs) {
  const sides = sameDirectionSides(legs);
  if (!sides) return 1;
  const table = PARLAY_TOTAL_HAIRCUT || {};
  const raw = Number(table[sides.length]);
  if (!Number.isFinite(raw) || raw > 1) return 1;
  if (raw < 0) return 0;
  return raw;
}

function isFullCardGrade(rating) {
  const key = normalizeRatingKey(rating);
  return key === 'aplus' || key === 'a' || key === 'aminus';
}

function simplifiedProbability(row) {
  const pm = Number(row && (row.modelPureP != null ? row.modelPureP : row.p_model));
  const pf = Number(row && (row.p_fair != null ? row.p_fair : row.fair_sharp_p));
  const w = modelWeightFor(row && row.sport, row && (row.market || row.betType));
  if (!Number.isFinite(pm) || !Number.isFinite(pf) || w == null) return null;
  return anchorProbability(pm, pf, w);
}

function quarterKellyUnitsSimple(p, odds) {
  const dec = americanToDecimal(odds); if (!(dec > 1)) return 0;
  const ev = p * dec - 1; if (!(ev > 0)) return 0;
  const raw = 0.25 * (ev / (dec - 1)) * 100;
  return Math.min(1.5, Math.round(raw * 4) / 4);
}

function modelWeightFor(sport, market) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  const key = String(sport || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const entry = table[key];
  let w;
  if (entry != null && typeof entry === 'object') {
    const mk = marketFamily(market);
    if (!Object.prototype.hasOwnProperty.call(entry, mk)) return null;
    w = Number(entry[mk]);
  } else {
    w = Number(entry);
  }
  if (!Number.isFinite(w)) return null;
  if (w < 0) return 0;
  if (w > 1) return 1;
  return w;
}

function anchorProbability(pModel, pFair, modelWeight) {
  const w = Number(modelWeight);
  const pm = Number(pModel);
  const pf = Number(pFair);
  if (!Number.isFinite(w) || !Number.isFinite(pm) || !Number.isFinite(pf)) return null;
  return (w * pm) + ((1 - w) * pf);
}

function marketFamily(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return 'total';
  if (/spread|puck|run/i.test(m)) return 'spread';
  return 'ml';
}

module.exports = { parlayFromStraights };
