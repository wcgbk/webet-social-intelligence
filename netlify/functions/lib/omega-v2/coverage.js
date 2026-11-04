'use strict';

/**
 * Pre-publish sport coverage for the five model sports.
 * Logs board games, scored rows, and candidates, plus the mean
 * (pCal - Pinnacle no-vig).
 * Auto-corrects and still publishes:
 *   - a fitted map on a sport under its sample floor is dropped back to
 *     the sharp-anchored shrink (pShrink)
 *   - a slate of 3+ scored rows whose mean gap vs no-vig is past 10pp
 *     is re-scored at k = 1 (full sharp anchor)
 *   - a sport with board games (or raw rows) and 0 scored candidates
 *     gets one market-anchored rescore. p is the Pinnacle no-vig fair.
 *     The price edge is p minus the break-even of the best DraftKings
 *     or Hard Rock number. Those rows are appended and graded later.
 *     Nothing is forced onto the card.
 * One fat row is left to the per-bet 10pp screen. A prior-shrink edge
 * inside that screen is a bet, not a calibration failure.
 * A sport with no board is recorded and is not a failure.
 * A rescore that throws is a warning. It does not block the card.
 */

const { MODEL_SPORTS, MIN_SPORT } = require('./constants');
const { americanToImplied } = require('../omega-vnext/odds_math');
const {
  collectMarketOutcomes, sharpFairForSide, bestDkHrPrice, oppositeBundle,
} = require('../omega-vnext/edge');

/** Mean |pCal - no-vig| on a real slate that falls back to k = 1. */
const BIAS_LIMIT = 0.10;
/** One or two rows are the per-bet screen. A sport correction needs a slate. */
const MIN_SLATE = 3;

const ANCHOR_MARKETS = [
  { key: 'h2h', family: 'Moneyline' },
  { key: 'spreads', family: 'Spread' },
  { key: 'totals', family: 'Total' },
];

function countSport(list, sport) {
  let n = 0;
  for (const row of list || []) {
    if (String(row && row.sport || '').toUpperCase() === sport) n += 1;
  }
  return n;
}

function posted(bundle, book) {
  const want = String(book || '').toLowerCase();
  return (bundle && bundle.prices || []).some((p) => (
    String(p && p.book || '').toLowerCase() === want
    && Number.isFinite(Number(p.american))
    && Number(p.american) !== 0
  ));
}

function sidePick(family, bundle) {
  const name = bundle && bundle.side != null ? String(bundle.side) : '';
  if (family === 'Total') {
    return bundle.point == null ? name : `${name} ${bundle.point}`;
  }
  if (family === 'Spread') {
    if (bundle.point == null) return name;
    const n = Number(bundle.point);
    const text = n > 0 ? `+${n}` : String(n);
    return `${name} ${text}`;
  }
  return name ? `${name} ML` : '';
}

function eventsFor(ctx, sport) {
  const map = ctx && ctx.boardBySport;
  if (Array.isArray(map)) {
    return map.filter((ev) => String((ev && (ev.sport || ev.league)) || '').toUpperCase() === sport);
  }
  if (!map || typeof map !== 'object') return [];
  const rows = map[sport] || map[String(sport).toLowerCase()] || map[String(sport).toUpperCase()];
  return Array.isArray(rows) ? rows : [];
}

/**
 * One market-anchored pass over a sport's board games.
 * p = Pinnacle two-way no-vig. Price edge = p - break-even(best DK/HR).
 * A game that cannot be priced is skipped. The caller catches a throw.
 */
function marketAnchorBoard(sport, events) {
  const out = [];
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    try {
      appendAnchored(out, sport, event);
    } catch (_) {
      // One bad game does not stop the rest of this attempt.
    }
  }
  return out;
}

function appendAnchored(out, sport, event) {
  if (!event || typeof event !== 'object') return;
  const home = event.home_team || event.homeTeam || '';
  const away = event.away_team || event.awayTeam || '';
  const matchup = event.matchup || (away && home ? `${away} @ ${home}` : '');
  if (!matchup) return;
  const commenceTime = event.commence_time || event.commenceTime || '';
  for (const market of ANCHOR_MARKETS) {
    const bundles = collectMarketOutcomes(event, market.key);
    if (!bundles.length) continue;
    for (const side of bundles) {
      const opp = oppositeBundle(bundles, side);
      if (!opp || !posted(side, 'pinnacle') || !posted(opp, 'pinnacle')) continue;
      const p = sharpFairForSide(bundles, side.side, side.point);
      const dk = bestDkHrPrice(side.prices);
      if (!(p > 0 && p < 1) || !dk || !Number.isFinite(Number(dk.american))) continue;
      const breakEven = americanToImplied(dk.american);
      if (!(breakEven > 0 && breakEven < 1)) continue;
      const pick = sidePick(market.family, side);
      if (!pick) continue;
      out.push({
        sport,
        matchup,
        pick,
        side: pick,
        market: market.family,
        odds: dk.american,
        book: dk.book,
        bestDkHr: { american: dk.american, book: dk.book },
        pModel: p,
        pMkt: p,
        fair_sharp_p: p,
        priceEdge: p - breakEven,
        commenceTime,
        homeTeam: home || null,
        awayTeam: away || null,
        line: side.point != null ? side.point : null,
        autoCorrected: true,
      });
    }
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function countOf(map, sport) {
  if (!map || typeof map !== 'object') return 0;
  const n = num(map[sport]);
  return n == null ? 0 : n;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Mutates calibration on `prepared` when a sport must fall back.
 * Returns the report to store on the card. Does not drop the publish.
 */
function applySportCoverage(prepared, stageCounts, ctx) {
  const stages = stageCounts || {};
  const context = ctx || {};
  const rows = [];
  const corrected = [];
  const added = [];
  for (const sport of MODEL_SPORTS) {
    const mine = (prepared || []).filter((c) => String(c.sport || '').toUpperCase() === sport);
    const biases = [];
    for (const cand of mine) {
      const cal = cand.calibration;
      if (!cal) continue;
      const pCal = num(cal.pCal);
      const pMkt = num(cal.pMkt);
      if (pCal != null && pMkt != null) biases.push(pCal - pMkt);
    }
    const meanBias = mean(biases);
    let action = 'none';
    let rescuedN = 0;
    const board = countOf(stages.board, sport);
    const raw = countOf(stages.raw, sport);
    const leakedMap = mine.some((cand) => {
      const cal = cand.calibration;
      if (!cal || !cal.mapApplied) return false;
      const floor = num(cal.sportFloor);
      const trainN = num(cal.trainN);
      return trainN == null || trainN < (floor == null ? MIN_SPORT : floor);
    });
    const slateBlowout = mine.length >= MIN_SLATE && meanBias != null && Math.abs(meanBias) > BIAS_LIMIT;
    const onBoard = board > 0 || raw > 0;
    if (!onBoard && mine.length === 0) action = 'no-board';
    else if (onBoard && mine.length === 0) {
      console.warn(`[coverage] ${sport}: board games=${board}, raw=${raw}, scored=0. One market-anchored rescore will run.`);
      try {
        const extra = marketAnchorBoard(sport, eventsFor(context, sport));
        const usable = (Array.isArray(extra) ? extra : []).filter((row) => row && typeof row === 'object');
        if (usable.length) {
          action = 'auto-corrected';
          rescuedN = usable.length;
          for (const row of usable) added.push(row);
        } else {
          action = 'no-score-warn';
        }
      } catch (err) {
        action = 'no-score-warn';
        const msg = err && err.message ? err.message : String(err);
        console.warn(`[coverage] ${sport} auto-correct failed: ${msg}`);
      }
    } else if (leakedMap || slateBlowout) {
      action = 'sharp-anchor';
      corrected.push(sport);
      for (const cand of mine) {
        const cal = cand.calibration;
        if (!cal || num(cal.pMkt) == null) continue;
        const pMkt = num(cal.pMkt);
        const pShrink = num(cal.pShrink);
        // A leaked map falls back to the shrink. A slate already past 10pp
        // after the shrink goes all the way to the no-vig number.
        const anchor = slateBlowout || pShrink == null ? pMkt : pShrink;
        cand.calibration = {
          ...cal,
          pCal: anchor,
          shrinkK: anchor === pMkt ? 1 : cal.shrinkK,
          method: 'sharp-anchor',
          mapApplied: false,
          corrected: true,
        };
      }
    }
    const after = mine
      .map((c) => (c.calibration ? num(c.calibration.pCal) - num(c.calibration.pMkt) : null))
      .filter((v) => v != null && Number.isFinite(v));
    const incoming = Object.prototype.hasOwnProperty.call(context, 'candidates')
      ? countSport(context.candidates, sport)
      : mine.length;
    const candidates = incoming + rescuedN;
    console.log(`[coverage] ${sport} board games=${board} scored=${mine.length} candidates=${candidates}`);
    rows.push({
      sport,
      board,
      raw,
      afterMiscal: countOf(stages.afterMiscal, sport),
      gated: countOf(stages.gated, sport),
      scored: mine.length,
      candidates,
      rescued: rescuedN,
      meanBias,
      meanBiasAfter: mean(after),
      action,
    });
  }
  return {
    sports: MODEL_SPORTS.slice(),
    biasLimit: BIAS_LIMIT,
    corrected,
    rows,
    added,
  };
}

function stampQualified(report, annotated) {
  if (!report || !Array.isArray(report.rows)) return report;
  for (const row of report.rows) {
    row.qualified = (annotated || []).filter((c) => (
      String(c.sport || '').toUpperCase() === row.sport && (c.qualified || c.parlayQualified)
    )).length;
  }
  return report;
}

module.exports = {
  BIAS_LIMIT,
  MIN_SLATE,
  applySportCoverage,
  marketAnchorBoard,
  stampQualified,
};
