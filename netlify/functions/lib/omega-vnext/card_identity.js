'use strict';

const { americanToImplied, americanToDecimal, formatEdgePct } = require('./odds_math');

// Printed edge and EV have to be the one-decimal win rate at the printed
// American price. The parlay has to be the published straights: none when
// there is one, those two teams when there are two, and not a 2-leg shortcut
// when there are three. This does not change the card.

function parsePct(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) > 1 ? v / 100 : v;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  if (s.includes('%') || Math.abs(n) > 1) return n / 100;
  return n;
}

function parseAmerican(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0 ? v : null;
  const s = String(v == null ? '' : v).trim().replace(/[−–]/g, '-');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function normName(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function gameKey(row) {
  const away = normName(row && (row.awayTeam || row.away_team));
  const home = normName(row && (row.homeTeam || row.home_team));
  if (away && home) return `${away}|${home}`;
  return normName(row && row.matchup);
}

function normPick(row) {
  return String((row && (row.pick || row.side)) || '')
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, ' ')
    .trim();
}

function evFraction(row) {
  if (!row) return null;
  if (row.ev != null && String(row.ev).trim() !== '') return parsePct(row.ev);
  if (row.evRaw != null && row.evRaw !== '') return parsePct(row.evRaw);
  return null;
}

function straightsOf(card) {
  return ((card && card.picks) || []).filter((row) => {
    if (!row) return false;
    return String(row.sport || '').toUpperCase() !== 'PARLAY';
  });
}

function publishedTicket(card) {
  const list = card && card.parlayLegs;
  if (!Array.isArray(list) || list.length === 0) return null;
  const ticket = list[0];
  if (!ticket || typeof ticket !== 'object') return null;
  if (ticket.qualifying === false) return null;
  if (ticket.status === 'no qualifying parlay') return null;
  if (ticket.type === 'no-qualifying-parlay') return null;
  const legs = Array.isArray(ticket.legs) ? ticket.legs.filter(Boolean) : [];
  if (legs.length < 2) return null;
  return ticket;
}

function checkPrinted(row, issues, label) {
  if (!row) return;
  const coverRaw = row.coverProb != null && String(row.coverProb).trim() !== ''
    ? row.coverProb
    : row.winProbability;
  const cover = parsePct(coverRaw);
  const american = parseAmerican(row.odds);
  if (cover == null || american == null) return;
  const implied = americanToImplied(american);
  const dec = americanToDecimal(american);
  if (implied == null || dec == null) return;
  const edge = formatEdgePct(cover - implied);
  const ev = formatEdgePct((cover * dec) - 1);
  const printedEdge = row.edge != null && String(row.edge).trim() !== ''
    ? String(row.edge)
    : (row.edgePct != null && String(row.edgePct).trim() !== '' ? String(row.edgePct) : null);
  if (printedEdge && edge && printedEdge !== edge) {
    issues.push(`${label} edge ${printedEdge} is ${edge} at ${row.odds}`);
  }
  if (row.edge != null && row.edgePct != null
    && String(row.edge).trim() !== '' && String(row.edgePct).trim() !== ''
    && String(row.edge) !== String(row.edgePct)) {
    issues.push(`${label} edge ${row.edge} and edgePct ${row.edgePct} disagree`);
  }
  if (row.ev != null && String(row.ev).trim() !== '' && ev && String(row.ev) !== ev) {
    issues.push(`${label} EV ${row.ev} is ${ev} at ${row.odds}`);
  }
}

function gamesAgree(a, b) {
  const left = gameKey(a);
  const right = gameKey(b);
  if (!left || !right) return true;
  return left === right;
}

function legsAreTheStraights(picks, legs) {
  if (!Array.isArray(picks) || !Array.isArray(legs) || picks.length !== legs.length) return false;
  const used = new Set();
  for (const pick of picks) {
    const pickName = normPick(pick);
    if (!pickName) return false;
    let found = -1;
    for (let i = 0; i < legs.length; i += 1) {
      if (used.has(i)) continue;
      if (normPick(legs[i]) !== pickName) continue;
      if (!gamesAgree(pick, legs[i])) continue;
      found = i;
      break;
    }
    if (found < 0) return false;
    used.add(found);
  }
  return true;
}

function checkCardIdentity(card) {
  const issues = [];
  const picks = straightsOf(card);
  picks.forEach((pick, i) => checkPrinted(pick, issues, `straight ${i + 1}`));
  const ticket = publishedTicket(card);
  if (ticket) {
    const legs = Array.isArray(ticket.legs) ? ticket.legs.filter(Boolean) : [];
    legs.forEach((leg, i) => checkPrinted(leg, issues, `parlay leg ${i + 1}`));
    if (ticket.combinedProb != null && String(ticket.combinedProb).trim() !== ''
      && ticket.combinedOdds != null && String(ticket.combinedOdds).trim() !== ''
      && ticket.ev != null && String(ticket.ev).trim() !== '') {
      checkPrinted({
        coverProb: ticket.combinedProb,
        odds: ticket.combinedOdds,
        ev: ticket.ev,
      }, issues, 'parlay');
    }
  }

  const n = picks.length;
  if (n <= 1 && ticket) issues.push(`${n} straight published a parlay`);
  if (n === 2) {
    const keys = picks.map(gameKey);
    const sameGame = keys.length === 2 && keys[0] && keys[0] === keys[1];
    const evs = picks.map(evFraction);
    const evKnown = evs.every((v) => v != null);
    const bothPositive = evKnown && evs.every((v) => v > 1e-12);
    if (sameGame && ticket) issues.push('same-game pair published a parlay');
    if (!sameGame && ticket && evKnown && !bothPositive) {
      issues.push('2-team parlay includes a non-positive leg');
    }
    if (!sameGame && bothPositive && keys[0] && keys[1] && keys[0] !== keys[1]) {
      const legs = ticket && Array.isArray(ticket.legs) ? ticket.legs.filter(Boolean) : [];
      const type = String((ticket && ticket.type) || '');
      if (!ticket) issues.push('two positive-EV straights have no parlay');
      else if (legs.length !== 2 || /^3-leg/.test(type)) {
        issues.push('two straights published a parlay that is not those two teams');
      } else if (!legsAreTheStraights(picks, legs)) {
        issues.push('2-team parlay is not the two published straights');
      }
    }
  }
  if (n >= 3 && ticket) {
    const legs = Array.isArray(ticket.legs) ? ticket.legs.filter(Boolean) : [];
    const type = String(ticket.type || '');
    if (legs.length === 2 || /^2-leg/.test(type)) {
      issues.push('three or more straights published a 2-leg parlay');
    }
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  checkCardIdentity,
  parsePct,
  gameKey,
};
