'use strict';

const {
  SELECT_WEIGHTS, MAX_STRAIGHTS, KELLY_FRACTION,
  DAILY_UNIT_CAP, STRAIGHT_UNIT_BUDGET, PARLAY_FIXED_UNITS,
  MAX_STRAIGHT_UNITS_PER_PICK, PM_SOFT,
} = require('./config');
const {
  kellyFraction, kellyToUnits, ratingToConfidence, formatAmerican,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
  parseEdgeFraction, qualityScore, qualityToRating, pickQualityScore, evAtOdds,
} = require('./odds_math');

function matchupKey(c) {
  return String(c.matchup || `${c.awayTeam} @ ${c.homeTeam}`).toLowerCase().trim();
}

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

function scoreCandidate(c, selectedSports) {
  const w = SELECT_WEIGHTS;
  const ev = c.ev || 0;
  // Same number the letter grade uses: calibrated edge vs no-vig sharp,
  // plus a small residual-CLV nudge. Raw EV is not the rank — a +180 dog
  // inflates EV without a better close. Steam and PM stay score-only.
  const clvRaw = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  let s = qualityScore(c.edgePct, clvRaw, c.uncertainty);
  if (typeof c._steamScoreAdj === 'number') s += c._steamScoreAdj;
  s += clampPmScoreAdj(c._pmScoreAdj);
  if (c.steamToward && ev > 0) s += (w.softSportMixBonus || 0.02);
  if (selectedSports && selectedSports.size && !selectedSports.has(c.sport)) {
    s += w.softSportMixBonus;
  }
  // Alternate lines are the same bet as the main line and rank below every main.
  if (c && c.alternate) s -= 1;
  return s;
}

/** Edge as a probability fraction. > 0.10 is more than 10 percentage points. */
function edgeFractionOf(c) {
  return parseEdgeFraction(c && c.edgePct);
}

/**
 * Side family for one bet. Spread/total ladders share a family; the point does not.
 * Packers -3 and Packers -7.5 are one bet. Packers +3 is the other side.
 */
function positionSide(c) {
  const market = String((c && c.market) || '');
  const side = String((c && c.side) || '').trim();
  if (/total/i.test(market)) {
    if (/^over\b/i.test(side)) return 'over';
    if (/^under\b/i.test(side)) return 'under';
    return side.toLowerCase();
  }
  if (/spread|puck|run line/i.test(market)) {
    const m = side.match(/^(.*)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (m) {
      const num = Number(m[2]);
      const sign = num > 0 ? 'plus' : num < 0 ? 'minus' : 'pk';
      return `${m[1].trim().toLowerCase()}|${sign}`;
    }
    return side.toLowerCase();
  }
  return side.replace(/\s+ml$/i, '').trim().toLowerCase();
}

function positionKey(c) {
  return `${matchupKey(c)}|${String((c && c.market) || '').toLowerCase()}|${positionSide(c)}`;
}

function priceAtBestDkHr(c) {
  const px = c && c.bestDkHr;
  if (!px || !Number.isFinite(Number(px.american))) return c;
  const odds = Number(px.american);
  const ev = evAtOdds(c.coverProb, odds);
  return {
    ...c,
    odds,
    oddsStr: formatAmerican(odds),
    book: px.book,
    ev: ev != null ? +ev.toFixed(4) : c.ev,
    pricedAt: 'dk-hr',
  };
}

const EDGE_MISCAL_CAP = 0.10;

function miscalibrationRecord(c, edgePct, stage) {
  const fairRaw = c && (c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP);
  const fair = Number(fairRaw);
  const rawP = Number(c && c.modelRawP);
  return {
    matchup: c.matchup || null,
    side: c.side || null,
    market: c.market || null,
    sport: c.sport || null,
    line: c.line != null ? c.line : null,
    edgePct,
    ...(Number.isFinite(rawP) ? { modelRawP: +rawP.toFixed(4) } : {}),
    ...(Number.isFinite(fair) ? { fair: +fair.toFixed(4) } : {}),
    odds: c.odds != null ? c.odds : null,
    book: c.book || null,
    reason: 'edge-over-10pp',
    stage,
  };
}

/** Raw model probability minus no-vig fair, before shrink. Null when either side is missing. */
function rawModelEdge(c) {
  const p = c && Number(c.modelRawP);
  const fairRaw = c && (c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP);
  const fair = Number(fairRaw);
  if (!Number.isFinite(p) || !Number.isFinite(fair)) return null;
  return p - fair;
}

/**
 * Drop raw model-vs-fair edges above 10pp before shrink/clip.
 * Shrink can hide a 12pp disagreement inside a 4pp calibrated edge.
 * Those rows are miscalibration, not a bet. Callers merge `miscalibrated`
 * into diagnostics and rejections alongside the post-calibration gate.
 */
function splitRawMiscalibrated(candidates) {
  const miscalibrated = [];
  const kept = [];
  for (const c of candidates || []) {
    const ef = rawModelEdge(c);
    if (ef != null && ef > EDGE_MISCAL_CAP + 1e-12) {
      miscalibrated.push(miscalibrationRecord(c, +ef.toFixed(4), 'pre-calibration'));
      continue;
    }
    kept.push(c);
  }
  return { candidates: kept, miscalibrated };
}

/**
 * One position per game+market+side, priced at the best real DK/Hard Rock number.
 * Main line wins the collapse. Calibrated edge above 10 percentage points is
 * miscalibration: it leaves the ranked pool and is listed on diagnostics.miscalibrated.
 * Raw modelRawP-vs-fair exclusions are splitRawMiscalibrated, run before this.
 */
function prepareEdgePositions(candidates) {
  const miscalibrated = [];
  const groups = new Map();
  for (const c of candidates || []) {
    const ef = edgeFractionOf(c);
    if (ef != null && ef > EDGE_MISCAL_CAP + 1e-12) {
      miscalibrated.push(miscalibrationRecord(c, c.edgePct, 'post-calibration'));
      continue;
    }
    const key = positionKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const positions = [];
  for (const [key, rows] of groups) {
    const mains = rows.filter(r => !r.alternate);
    const pool = mains.length ? mains : rows;
    pool.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const chosen = priceAtBestDkHr({
      ...pool[0],
      alternate: mains.length ? false : true,
      positionKey: key,
      collapsedFrom: rows.length,
    });
    positions.push(chosen);
  }
  return { positions, diagnostics: { miscalibrated } };
}

/** Per-game straight exposure ≤ 1u. The fixed parlay stake is a separate ticket and is not charged here. Slate ≤ 6u, parlay included. Grades stay. */
const PER_GAME_EXPOSURE_U = 1;
const SLATE_EXPOSURE_U = 6;

function applyExposureCaps(picks, parlayLegs) {
  let out = (picks || []).map(p => ({ ...p }));
  const parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];
  const parlayU = parlays.reduce((s, pl) => s + parseU(pl.units), 0);
  const parlayGames = new Set();
  for (const pl of parlays) {
    for (const leg of pl.legs || []) parlayGames.add(matchupKey(leg));
  }
  // PARLAY_FIXED_UNITS (0.5u) does not consume the 1u per-game straight cap.
  // A non-fixed parlay stake still does. Slate exposure below still counts the parlay.
  const chargeParlayOnGame = parlays.some(pl => {
    const u = parseU(pl.units);
    return u > 1e-9 && Math.abs(u - PARLAY_FIXED_UNITS) > 1e-9;
  });
  for (const p of out) {
    const extra = chargeParlayOnGame && parlayGames.has(matchupKey(p)) ? parlayU : 0;
    const room = PER_GAME_EXPOSURE_U - extra;
    let u = parseU(p.units);
    if (!(room > 0)) u = 0;
    else if (u > room) u = Math.floor((room + 1e-9) * 4) / 4;
    p.units = fmtU(Math.max(0, u));
  }
  const totalOf = () => out.reduce((s, p) => s + parseU(p.units), 0) + parlayU;
  let guard = 0;
  while (totalOf() > SLATE_EXPOSURE_U + 1e-9 && guard++ < 400) {
    let idx = -1;
    for (let i = 0; i < out.length; i++) {
      const u = parseU(out[i].units);
      if (u <= 0) continue;
      if (idx < 0 || u > parseU(out[idx].units) + 1e-9) idx = i;
    }
    if (idx < 0) break;
    const u = parseU(out[idx].units);
    const nu = Math.max(0, Math.round((u - 0.25) * 4) / 4);
    if (nu >= u - 1e-9) break;
    out[idx].units = fmtU(nu);
  }
  return { picks: out, parlayLegs: parlays };
}

/**
 * Greedy diversify: ≤1 per game, up to MAX_STRAIGHTS, EV first.
 * Positive-EV sides fill before any negative-EV row. A shorter pool stays
 * short. This does not pad; fillNeverBlock does.
 */
function selectStraights(yesPool, maxN = MAX_STRAIGHTS) {
  const pool = [...(yesPool || [])].sort((a, b) => compareForStraight(a, b));
  const picked = [];
  const usedGames = new Set();
  const sports = new Set();

  for (const c of pool) {
    if (picked.length >= maxN) break;
    const g = matchupKey(c);
    if (usedGames.has(g)) continue;
    const scored = { ...c, _score: scoreCandidate(c, sports) };
    picked.push(scored);
    usedGames.add(g);
    sports.add(c.sport);
  }

  picked.sort((a, b) => compareForStraight(a, b, sports));
  return picked;
}

function numericEv(c) {
  const n = Number(c && c.ev);
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Published straight order. Positive EV before any negative-EV lean, mains
 * before alternates inside that group, then higher EV. Quality score only
 * breaks an EV tie, so a plus-money dog does not jump a better price when
 * the EV is the same, and an alternate does not jump a main of the same sign.
 */
function compareForStraight(a, b, selectedSports) {
  const posA = numericEv(a) > 1e-12 ? 0 : 1;
  const posB = numericEv(b) > 1e-12 ? 0 : 1;
  if (posA !== posB) return posA - posB;
  const altA = a && a.alternate ? 1 : 0;
  const altB = b && b.alternate ? 1 : 0;
  if (altA !== altB) return altA - altB;
  const ev = numericEv(b) - numericEv(a);
  if (Math.abs(ev) > 1e-12) return ev;
  return scoreCandidate(b, selectedSports) - scoreCandidate(a, selectedSports);
}

/** Quality-score order. The published card uses compareForStraight, not this. */
function orderedByScore(pool) {
  return [...(pool || [])].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

function parseU(u) {
  return parseFloat(String(u || '0').replace(/[^0-9.]/g, '')) || 0;
}

function fmtU(n) {
  const nu = Math.round(n * 4) / 4;
  return `${nu}u`;
}

function toPickObject(c, opts = {}) {
  const kFrac = kellyFraction(c.coverProb, c.odds, KELLY_FRACTION);
  const perPickCap = opts.perPickCap != null ? opts.perPickCap : MAX_STRAIGHT_UNITS_PER_PICK;
  let units = kellyToUnits(kFrac, perPickCap);
  if (opts.drawdown) units = Math.max(0.25, units * 0.75);
  // Never-block fill: a gate miss published to complete the card is a 0.5u lean.
  // The quality grade of a real selection is unchanged.
  const lean = !!(c && c.leanFill);
  if (lean) units = 0.5;

  // Honest Edge badge = model edge after shrink vs no-vig sharp (fraction on c.edgePct).
  // Fallback: coverProb - book implied. Never predictedClv cents / raw coverProb.
  const edgeFrac = parseEdgeFraction(c.edgePct);
  const edgePctStr = formatEdgePct(edgeFrac) || '0.0%';
  const qualityClv = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  const pickQuality = qualityScore(edgeFrac, qualityClv, c.uncertainty);
  const rating = lean ? 'b' : qualityToRating(edgeFrac, qualityClv, c.uncertainty);
  const grade = rating;
  const evStr = formatEdgePct(c.ev) || edgePctStr;

  const isML = /moneyline/i.test(c.market || '');
  const pickLabel = formatMoneylinePick(c.side, c.market);
  const calibratedPct = ((c.coverProb || 0) * 100).toFixed(1);
  const modelEdge = isML
    ? `Model Win Prob: ${calibratedPct}%, Edge: ${edgePctStr}`
    : `Model p: ${calibratedPct}%, Line: ${c.line != null ? c.line : c.consensusLine}, Edge: ${edgePctStr}`;

  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
    pick: pickLabel,
    pickDisplay: pickLabel,
    betType: c.market,
    odds: c.oddsStr || formatAmerican(c.odds),
    rating,
    grade,
    qualityGrade: rating,
    qualityScore: +pickQuality.toFixed(6),
    confidence: ratingToConfidence(rating),
    units: `${units}u`,
    ev: evStr,
    evRaw: c.ev != null ? c.ev : edgeFrac,
    edgePct: edgePctStr,
    // Display fix (2026-10-18): print p to a tenth. Whole-% p next to
    // tenth-% EV made readers recompute a wrong EV (57% vs the 56.7% used).
    coverProb: `${((c.coverProb || 0) * 100).toFixed(1)}%`,
    winProbability: `${((c.coverProb || 0) * 100).toFixed(1)}%`,
    coreReasoning: c.coreReasoning || '',
    whatLoses: c.whatLoses || '',
    dataVerified: c.dataVerified || '',
    clvExpectation: c.clvExpectation || '',
    modelEdge,
    commenceTime: c.commenceTime || '',
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    source: 'omega-vnext',
    p_model: c.p_model != null ? +Number(c.p_model).toFixed(4) : null,
    fair_sharp_p: c.fair_sharp_p != null ? +Number(c.fair_sharp_p).toFixed(4) : null,
    predictedClv: c.predictedClv,
    modelVersion: opts.modelVersion,
    book: c.book,
    // NFL/NCAAF Lock receipt (2026-10-18): Grade A only for the verified
    // standard bet — formula + receipt present (gate-enforced) and the pick
    // cleared era floors by being selected. Era letter rating is untouched.
    ...((c && /^(NFL|NCAAF)$/.test(String(c.sport || '')) && !c.lockPass && c.lockFormulaLine != null)
      ? { lockGrade: 'A', lockFormulaLine: c.lockFormulaLine, lockReceiptLine: c.lockReceiptLine != null ? c.lockReceiptLine : null, lockAvailability: c.qbNote || c.lockAvailability || null }
      : {}),
    line: c.line != null ? c.line : null,
    projMethod: c.projMethod || '',
    uncertainty: c.uncertainty,
    steamToward: !!c.steamToward,
    steamAgainst: !!c.steamAgainst,
    predictedResidualClv: c.predictedResidualClv != null ? c.predictedResidualClv : null,
    openPrint: c.openPrint || null,
    lineMove: c.lineMove || null,
    ...(Array.isArray(c.placeableBooks) ? { placeableBooks: c.placeableBooks.slice() } : {}),
    ...(c.bestPlaceable ? { bestPlaceable: c.bestPlaceable } : {}),
    ...(c.pmFeatures && typeof c.pmFeatures === 'object' ? { pmFeatures: { ...c.pmFeatures } } : {}),
    ...(lean ? { lean: true, fallback: true } : {}),
  };
}

/** DraftKings or Hard Rock is on this side. bestDkHr wins; the posted book counts too. */
function dkHrPriced(c) {
  if (!c) return false;
  const px = c.bestDkHr;
  if (px && Number.isFinite(Number(px.american))) return true;
  const book = String(c.book || '').toLowerCase();
  return book === 'draftkings' || book === 'hardrockbet' || book === 'hardrock' || book === 'hardrockbet_oh';
}

function edgeWithinTen(c) {
  const ef = edgeFractionOf(c);
  return !(ef != null && ef > 0.10 + 1e-12);
}

/**
 * Never-block fill. Seeds stay. When the priced board has enough DraftKings /
 * Hard Rock games, top the card up to maxN. New games first. A second market
 * from a game is allowed only when fewer than maxN distinct priced games exist.
 * Fills are marked leanFill so toPickObject sizes them at 0.5u.
 * Rank is EV: every positive-EV side (one per game) is taken before a
 * negative-EV lean. Miscalibration is already out of `positions`.
 */
function fillNeverBlock(selected, positions, maxN = MAX_STRAIGHTS) {
  const picked = (selected || []).map(c => ({ ...c }));
  const selectedKeys = new Set(picked.map(positionKey));
  const usedKeys = new Set(selectedKeys);
  const usedGames = new Set(picked.map(matchupKey));
  const priced = (positions || []).filter(c => dkHrPriced(c) && edgeWithinTen(c));
  const games = new Set(priced.map(matchupKey));
  const ranked = [...priced].sort((a, b) => compareForStraight(a, b));
  const take = (allowSameGame) => {
    for (const c of ranked) {
      if (picked.length >= maxN) return;
      const key = positionKey(c);
      if (usedKeys.has(key)) continue;
      const g = matchupKey(c);
      if (usedGames.has(g) && !allowSameGame) continue;
      picked.push({ ...c });
      usedKeys.add(key);
      usedGames.add(g);
    }
  };
  take(false);
  if (picked.length < maxN && games.size < maxN) take(true);
  return picked.map(c => ({
    ...c,
    leanFill: !selectedKeys.has(positionKey(c)),
  }));
}

function samePublished(pick, cand) {
  if (!pick || !cand) return false;
  const game = String(pick.matchup || '').trim().toLowerCase();
  if (game && game !== matchupKey(cand)) return false;
  const labeled = formatMoneylinePick(cand.side, cand.market);
  const pickName = String(pick.pick || pick.side || '').trim().toLowerCase();
  const side = String(cand.side || '').trim().toLowerCase();
  const lab = String(labeled || '').trim().toLowerCase();
  return pickName !== '' && (pickName === side || pickName === lab);
}

/**
 * One reason for every candidate that did not make the card.
 * Miscalibration (>10pp) is included; it never reaches the gate list.
 */
function droppedRejections(positions, selected, gateRejected, miscalibrated) {
  const chosen = new Set((selected || []).map(positionKey));
  const gateReason = new Map();
  for (const r of gateRejected || []) {
    const key = positionKey(r);
    if (!gateReason.has(key)) gateReason.set(key, r.rejectReason || 'gate');
  }
  const out = [];
  const seen = new Set();
  for (const m of miscalibrated || []) {
    const key = `mis|${m.matchup || ''}|${m.side || ''}|${m.market || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      matchup: m.matchup || null,
      side: m.side || null,
      market: m.market || null,
      sport: m.sport || null,
      reason: m.reason || 'edge-over-10pp',
    });
  }
  for (const c of positions || []) {
    const key = positionKey(c);
    if (chosen.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      matchup: c.matchup || null,
      side: c.side || null,
      market: c.market || null,
      sport: c.sport || null,
      reason: gateReason.get(key) || 'not-selected',
    });
  }
  return out;
}

/**
 * Cap straights only (legacy). Prefer applyDailyUnitCap with parlay.
 */
function applyDailyCap(picks) {
  return applyDailyUnitCap(picks, null).picks;
}

/**
 * Unit structure (v12.0.9):
 * - Parlay fixed at PARLAY_FIXED_UNITS (0.5u) when present — never scaled
 * - Straights combined ≤ STRAIGHT_UNIT_BUDGET (3.5u)
 * - Total ≤ DAILY_UNIT_CAP (4.0u)
 * Overage: reduce lowest-quality straights in 0.25u steps (floor 0.25u).
 * Preserve quality grades; align grade/stake hierarchy; never force-fill to max.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => ({ ...p }));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  // Lock published parlays to fixed 0.5u
  for (const pl of parlays) {
    pl.units = fmtU(PARLAY_FIXED_UNITS);
  }

  const straightTotalOf = () => out.reduce((acc, p) => acc + parseU(p.units), 0);
  const parlayTotalOf = () => parlays.reduce((acc, pl) => acc + parseU(pl.units), 0);
  const totalOf = () => straightTotalOf() + parlayTotalOf();

  const reduceStraightsTo = (budget) => {
    let st = straightTotalOf();
    while (st > budget + 1e-9 && out.length) {
      const order = out
        .map((_, i) => i)
        .sort((a, b) => {
          const ra = ratingRank(out[a].rating);
          const rb = ratingRank(out[b].rating);
          if (ra !== rb) return rb - ra; // lowest grade first
          const qa = pickQualityScore(out[a]);
          const qb = pickQualityScore(out[b]);
          if (Math.abs(qa - qb) > 1e-12) return qa - qb;
          return parseU(out[a].units) - parseU(out[b].units);
        });
      let reduced = false;
      for (const idx of order) {
        const u = parseU(out[idx].units);
        if (u > 0.25) {
          const nu = Math.max(0.25, Math.round((u - 0.25) * 4) / 4);
          out[idx].units = fmtU(nu);
          // Rating/confidence describe quality, not stake size. Never downgrade on trim.
          st = straightTotalOf();
          reduced = true;
          break;
        }
      }
      if (!reduced) break;
    }
  };

  // 1) Straights ≤ 3.5u
  reduceStraightsTo(STRAIGHT_UNIT_BUDGET);

  // 2) Total ≤ 4.0u (parlay fixed — only straights can absorb remaining overage)
  const maxStraightsForTotal = Math.max(0, DAILY_UNIT_CAP - parlayTotalOf());
  const finalStraightBudget = Math.min(STRAIGHT_UNIT_BUDGET, maxStraightsForTotal);
  reduceStraightsTo(finalStraightBudget);

  // A higher quality grade must never carry less stake than a lower one. Use any
  // remaining budget to lift the better pick first; if that cannot fully resolve
  // the inversion, trim the lower-grade pick. Grades themselves never change.
  let straightTotal = straightTotalOf();
  const ordered = out.map((_, i) => i).sort((a, b) => {
    const rankDelta = ratingRank(out[a].rating) - ratingRank(out[b].rating);
    if (rankDelta) return rankDelta;
    return pickQualityScore(out[b]) - pickQualityScore(out[a]);
  });
  for (let hiPos = 0; hiPos < ordered.length; hiPos++) {
    for (let loPos = hiPos + 1; loPos < ordered.length; loPos++) {
      const hi = out[ordered[hiPos]];
      const lo = out[ordered[loPos]];
      if (ratingRank(hi.rating) >= ratingRank(lo.rating)) continue;
      let hiUnits = parseU(hi.units);
      let loUnits = parseU(lo.units);
      if (hiUnits >= loUnits) continue;

      const headroom = Math.max(0, finalStraightBudget - straightTotal);
      const lift = Math.floor(Math.min(loUnits - hiUnits, headroom, Math.max(0, MAX_STRAIGHT_UNITS_PER_PICK - hiUnits)) * 4 + 1e-9) / 4;
      if (lift > 0) {
        hiUnits += lift;
        hi.units = fmtU(hiUnits);
        straightTotal += lift;
      }
      if (hiUnits < loUnits) {
        lo.units = fmtU(hiUnits);
        straightTotal -= (loUnits - hiUnits);
      }
    }
  }

  out = sortByGradeThenUnits(out);
  return { picks: out, parlayLegs: parlays };
}

module.exports = {
  scoreCandidate,
  compareForStraight,
  selectStraights,
  orderedByScore,
  toPickObject,
  applyDailyCap,
  applyDailyUnitCap,
  applyExposureCaps,
  prepareEdgePositions,
  splitRawMiscalibrated,
  rawModelEdge,
  positionKey,
  matchupKey,
  dkHrPriced,
  fillNeverBlock,
  droppedRejections,
  samePublished,
  formatMoneylinePick,
  sortByGradeThenUnits,
  PER_GAME_EXPOSURE_U,
  SLATE_EXPOSURE_U,
};
