"use strict";

// Same QA as verify-picks.js (Ben-directed 2026-08-22): every published Grok Beta
// straight AND parlay leg must be a bet a user can place at Hard Rock Bet.
// Ballpark: market exists at HR; totals/spreads point within 0.5 of the published
// line; HR implied prob no more than 6pp worse than the published price.
// Unlike Alpha's advisory verify pass, Grok Beta GATES — unplaceable sides never
// make the card.

const HR_BOOK_KEYS = new Set(["hardrockbet", "hardrockbet_oh", "hardrock"]);
const HR_ODDS_WORSE_PP = 3.0;
const HR_ODDS_ERROR_PP = 6.0;
const HR_LINE_MAX = 0.5;

function lastWord(name) {
  return String(name || "").trim().split(/\s+/).pop().toLowerCase();
}
function impliedPct(american) {
  if (american == null || !Number.isFinite(american) || american === 0) return null;
  const p = american < 0
    ? Math.abs(american) / (Math.abs(american) + 100)
    : 100 / (american + 100);
  return p * 100;
}
function fmtOdds(o) {
  if (o == null || !Number.isFinite(o)) return null;
  return o > 0 ? `+${o}` : `${o}`;
}
function hrBookFrom(game) {
  return ((game && game.bookmakers) || []).find(b => HR_BOOK_KEYS.has(String(b.key || "").toLowerCase())) || null;
}
function hrMarketFrom(book, marketKey) {
  return ((book && book.markets) || []).find(mk => mk.key === marketKey) || null;
}

function findOutcome(market, pick) {
  const marketKey = pick.market === "h2h" ? "h2h" : pick.market === "totals" ? "totals" : "spreads";
  let outcome = null;
  let pubPoint = pick.line != null ? Number(pick.line) : null;
  if (marketKey === "h2h") {
    const team = pick.side === "home" ? pick.homeTeam : pick.awayTeam;
    const needle = lastWord(team || String(pick.pick || "").replace(/\s*ML\s*$/i, ""));
    outcome = (market.outcomes || []).find(o => lastWord(o.name) === needle || String(o.name).toLowerCase().includes(needle));
  } else if (marketKey === "totals") {
    const side = /under/i.test(pick.pick) || pick.side === "Under" ? "Under" : "Over";
    if (pubPoint == null) {
      const n = parseFloat(String(pick.pick).replace(/[^0-9.]/g, ""));
      pubPoint = Number.isFinite(n) ? n : null;
    }
    outcome = (market.outcomes || []).find(o => o.name === side);
  } else {
    const team = pick.side === "home" ? pick.homeTeam : pick.awayTeam;
    const needle = lastWord(team || String(pick.pick || "").replace(/[-+]?\d+(\.\d+)?\s*$/, ""));
    if (pubPoint == null) {
      const m = String(pick.pick || "").match(/([-+]?\d+(\.\d+)?)\s*$/);
      pubPoint = m ? parseFloat(m[1]) : null;
    }
    outcome = (market.outcomes || []).find(o => lastWord(o.name) === needle || String(o.name).toLowerCase().includes(needle));
  }
  return { outcome, pubPoint, marketKey };
}

function checkPickAtHardRock(pick, oddsGame) {
  const out = { available: false, hrOdds: null, hrPoint: null, american: null, warnings: [], errors: [], notes: [] };
  const book = hrBookFrom(oddsGame);
  if (!book) {
    out.errors.push("HardRock: Hard Rock Bet has no lines for this game — not placeable");
    return out;
  }
  const marketKey = pick.market === "h2h" ? "h2h" : pick.market === "totals" ? "totals" : "spreads";
  const market = hrMarketFrom(book, marketKey);
  if (!market) {
    out.errors.push(`HardRock: ${pick.betType || pick.market} not offered at Hard Rock Bet for this game`);
    return out;
  }
  const { outcome, pubPoint } = findOutcome(market, pick);
  if (!outcome || !Number.isFinite(outcome.price)) {
    out.errors.push(`HardRock: side "${pick.pick}" not found at Hard Rock Bet`);
    return out;
  }
  if (pubPoint != null && Number.isFinite(outcome.point) && Math.abs(outcome.point - pubPoint) > HR_LINE_MAX) {
    out.errors.push(`HardRock: line is ${outcome.point} vs published ${pubPoint} — different bet`);
    return out;
  }

  const pubOdds = Number(pick.oddsAmerican);
  const worsePP = Number.isFinite(pubOdds) ? (impliedPct(outcome.price) - impliedPct(pubOdds)) : 0;
  if (worsePP > HR_ODDS_ERROR_PP) {
    out.errors.push(`HardRock: price ${fmtOdds(outcome.price)} vs ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — outside ballpark`);
    return out;
  }
  if (worsePP > HR_ODDS_WORSE_PP) {
    out.warnings.push(`HardRock: price ${fmtOdds(outcome.price)} vs ${pick.odds} (+${worsePP.toFixed(1)}pp implied) — worse but in ballpark`);
  }

  out.available = true;
  out.american = outcome.price;
  out.hrOdds = fmtOdds(outcome.price);
  if (outcome.point !== undefined) out.hrPoint = outcome.point;
  out.notes.push(`Hard Rock Bet ${out.hrOdds}${out.hrPoint != null ? " @ " + out.hrPoint : ""}`);
  return out;
}

module.exports = {
  HR_BOOK_KEYS, checkPickAtHardRock, hrBookFrom,
};
