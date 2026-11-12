'use strict';
// Shared "No Qualifying Plays Today" card (2026-09-28).
// Rule: a run that COMPLETES with zero qualifying plays writes this card. The site keeps
// showing the previous card until a run completes; a started or failed run writes nothing.
// Copy: title-case headline + one or two short sentences of reason. No timestamp.
// Daily Edge read path (model 'omega') rewrites a stored empty reason from board counts
// so an old blob tells the truth without a republish.

const NO_PLAYS_TITLE = 'No Qualifying Plays Today';

const MODEL_LABEL = { omega: 'Omega', nfl: "Omega's NFL model", cfb: "Omega's college football model" };
const SPORT_WORD = {
  MLB: 'baseball',
  NFL: 'NFL',
  NCAAF: 'college football',
  NBA: 'NBA',
  NHL: 'NHL',
  NCAAM: 'college basketball',
};
const SPORT_ORDER = ['NBA', 'NHL', 'NCAAM', 'NFL', 'NCAAF', 'MLB'];
const CODENAME = /\b(Omega|Alpha)\b/;
const BASEBALL_STARTERS = /probable starters in baseball/i;
const BASEBALL_WATCH_SENTENCE = /If you are still shopping, watch probable starters in baseball, quarterback status in football, and the weather on outdoor games\./i;

function gamesWord(n) { return n === 1 ? 'game' : 'games'; }

function mlbOffClause(dateISO) {
  const [, m, d] = String(dateISO || '').split('-').map(Number);
  if (m === 9 && d >= 25) return 'Baseball is off today ahead of the postseason.';
  if (m === 10 || m === 11) return 'Baseball has a postseason off day.';
  if (m >= 3 && m <= 9) return "There's no baseball today.";
  return null; // offseason: not worth mentioning
}

function sportName(code) {
  const key = String(code || '').toUpperCase();
  return SPORT_WORD[key] || key.replace(/_/g, ' ').trim();
}

function listNames(codes) {
  const names = (codes || []).map(sportName).filter(Boolean);
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function normalizeCounts(counts) {
  const c = {};
  for (const [k, v] of Object.entries(counts || {})) {
    const n = +v;
    if (!Number.isFinite(n)) continue;
    c[String(k).toUpperCase()] = n > 0 ? n : 0;
  }
  return c;
}

function sportsOnBoard(counts) {
  const c = counts || {};
  const keys = Object.keys(c).filter((k) => (+c[k] || 0) > 0);
  keys.sort((a, b) => {
    const ia = SPORT_ORDER.indexOf(a);
    const ib = SPORT_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return keys;
}

/** Daily Edge reason. counts includes every sport on the slate, not just football. */
function omegaReason({ counts = {}, dateISO, hardFails = 0 } = {}) {
  const c = normalizeCounts(counts);
  const on = sportsOnBoard(c);
  const total = on.reduce((sum, k) => sum + c[k], 0);
  if (!total) {
    // Baseball off-day copy only when no other sport is on the board either.
    const off = mlbOffClause(dateISO);
    const none = "There are no games on today's board, so there is nothing to price.";
    return off ? `${off} ${none}` : none;
  }
  const named = `${total} ${gamesWord(total)} (${listNames(on)})`;
  if (total === 1) {
    const one = sportName(on[0]);
    return hardFails
      ? `The one ${one} game on today's board didn't hold up through the model's late checks.`
      : `The one ${one} game on today's board didn't clear the model's edge floors.`;
  }
  return hardFails
    ? `None of the ${named} on today's board held up through the model's edge floors and late checks.`
    : `None of the ${named} on today's board cleared the model's edge floors.`;
}

/**
 * What to watch before lock. `sports` is the board (or null when unknown).
 * Baseball starters are named only when MLB itself is on that list.
 */
function sportWatchSentence(sports) {
  const neutral = 'If you are still shopping, watch injuries, lineup changes, and any news that moves a number after the morning line.';
  if (!Array.isArray(sports)) return neutral;
  const list = sports.map((s) => String(s || '').toUpperCase()).filter(Boolean);
  const has = (codes) => list.some((s) => codes.includes(s));
  const parts = [];
  if (has(['NBA', 'NHL', 'NCAAM', 'NCAAB'])) parts.push('injuries and starting lineups');
  if (has(['NFL', 'NCAAF', 'CFB'])) parts.push('quarterback status and the weather on outdoor games');
  if (has(['MLB'])) parts.push('probable starters');
  if (!parts.length) return neutral;
  const watch = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', plus ')}, plus ${parts[parts.length - 1]}`;
  return `If you are still shopping, watch ${watch}.`;
}

function stripModelCodenames(text) {
  if (text == null || text === '') return text;
  const s = String(text);
  if (!CODENAME.test(s)) return text;
  return s
    .replace(/\bOmega's\b/g, "Edge's")
    .replace(/\bAlpha's\b/g, "Edge's")
    .replace(/\bOmega\b/g, 'Edge')
    .replace(/\bAlpha\b/g, 'Edge');
}

function rowBoardCount(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['board', 'games', 'count', 'n']) {
    if (row[key] == null || row[key] === '') continue;
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n > 0 ? n : 0;
  }
  return null;
}

/** Board counts from sportCoverage rows or a sibling counts bag. Null when absent. */
function boardCountsFromCard(card) {
  if (!card || typeof card !== 'object') return null;
  const counts = {};
  let found = false;
  const rows = card.sportCoverage && Array.isArray(card.sportCoverage.rows)
    ? card.sportCoverage.rows
    : (Array.isArray(card.sportCoverage) ? card.sportCoverage : null);
  if (rows && rows.length) {
    for (const row of rows) {
      if (!row || !row.sport) continue;
      const n = rowBoardCount(row);
      if (n == null) continue;
      found = true;
      counts[String(row.sport).toUpperCase()] = n;
    }
  }
  const bags = [];
  if (card.counts && typeof card.counts === 'object') bags.push(card.counts);
  if (card.boardCounts && typeof card.boardCounts === 'object') bags.push(card.boardCounts);
  if (card.slateCounts && typeof card.slateCounts === 'object') {
    bags.push(card.slateCounts.bySport && typeof card.slateCounts.bySport === 'object'
      ? card.slateCounts.bySport
      : card.slateCounts);
  }
  if (card.debug && card.debug.counts && typeof card.debug.counts === 'object') bags.push(card.debug.counts);
  for (const bag of bags) {
    for (const [k, v] of Object.entries(bag)) {
      if (k === 'total' || k === 'espn' || k === 'odds' || k === 'bySport') continue;
      const sport = String(k).toUpperCase();
      if (!/^[A-Z0-9]{2,8}$/.test(sport)) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      found = true;
      if (counts[sport] == null) counts[sport] = n > 0 ? n : 0;
    }
  }
  return found ? counts : null;
}

function rewriteBaseballWatch(text, sports) {
  if (text == null || text === '') return text;
  const mlb = Array.isArray(sports) && sports.some((s) => String(s).toUpperCase() === 'MLB');
  if (mlb || !BASEBALL_STARTERS.test(String(text))) return text;
  const sentence = sportWatchSentence(Array.isArray(sports) ? sports : null);
  let out = String(text).replace(BASEBALL_WATCH_SENTENCE, sentence);
  if (BASEBALL_STARTERS.test(out)) {
    out = out.replace(/[^.?!]*probable starters in baseball[^.?!]*[.?!]/i, ` ${sentence} `);
    out = out.replace(/\s+/g, ' ').trim();
  }
  return out;
}

function stripLiveCopyFields(card) {
  if (!card || typeof card !== 'object') return card;
  const noPlaysReason = stripModelCodenames(card.noPlaysReason);
  const edgeSummary = stripModelCodenames(card.edgeSummary);
  let insights = card.insights;
  if (typeof insights === 'string' && insights) insights = stripModelCodenames(insights);
  if (noPlaysReason === card.noPlaysReason && edgeSummary === card.edgeSummary && insights === card.insights) {
    return card;
  }
  return { ...card, noPlaysReason, edgeSummary, insights };
}

function hardFailFlag(card) {
  if (!card) return 0;
  if (Array.isArray(card.qaHardFails) && card.qaHardFails.length) return 1;
  if (typeof card.hardFails === 'number' && card.hardFails > 0) return 1;
  if (Array.isArray(card.hardFails) && card.hardFails.length) return 1;
  if (/late checks/i.test(card.noPlaysReason || card.noPlays || '')) return 1;
  return 0;
}

/** Read-side repair for a stored Daily Edge empty card. Does not write the blob. */
function repairOmegaEmptyCard(card) {
  const counts = boardCountsFromCard(card);
  const previousReason = card.noPlaysReason || '';
  let reason;
  if (counts) {
    reason = omegaReason({
      counts,
      dateISO: card.date || card.dateISO,
      hardFails: hardFailFlag(card),
    });
  } else if (previousReason) {
    reason = previousReason;
  } else {
    reason = /late checks/i.test(card.noPlays || '')
      ? "Late checks removed every candidate on today's board."
      : "None of today's games cleared the model's edge floors.";
  }
  reason = stripModelCodenames(reason);
  const sports = counts ? sportsOnBoard(counts) : null;
  let insights = card.insights;
  if (typeof insights === 'string' && insights) {
    insights = rewriteBaseballWatch(insights, sports);
    insights = stripModelCodenames(insights);
  }
  let edgeSummary = card.edgeSummary;
  if (edgeSummary == null || edgeSummary === '' || edgeSummary === previousReason) {
    edgeSummary = reason;
  } else {
    edgeSummary = stripModelCodenames(edgeSummary);
  }
  const noGames = counts
    ? sports.length === 0
    : (card.noGames === true || /Games Scheduled/i.test(card.noPlays || ''));
  const repaired = {
    ...card,
    ...noPlaysFields(reason, { noGames }),
    edgeSummary,
    insights,
  };
  // Read path only: clear a false verify stamp without writing the blob.
  unstampEmptyCard(repaired);
  return repaired;
}

/**
 * A stored empty card that was stamped verified did not go through Claude.
 * Mutates and returns true only when a true stamp (or an 'ok' narration) is cleared.
 */
function unstampEmptyCard(picksData) {
  if (!picksData || typeof picksData !== 'object') return false;
  if (Array.isArray(picksData.picks) && picksData.picks.length > 0) return false;
  const narrationOk = !!(picksData.narration && picksData.narration.status === 'ok');
  if (picksData.claudeVerified !== true && !narrationOk) return false;
  picksData.claudeVerified = false;
  picksData.fallback = true;
  picksData.verified = false;
  picksData.narration = { ...(picksData.narration || {}), status: 'empty' };
  return true;
}

/** Single-sport reason for the NFL-only and college football cards. */
function sportReason(model, { noGames = false, gamesPriced = 0 } = {}) {
  const sport = model === 'cfb' ? 'college football' : 'NFL';
  if (noGames) return `There are no ${sport} games on today's schedule.`;
  const who = MODEL_LABEL[model] || 'Omega';
  if (gamesPriced === 1) return `${who} priced today's only game, and it didn't clear the cover and edge floors.`;
  if (gamesPriced > 1) return `${who} priced all ${gamesPriced} ${gamesWord(gamesPriced)} today, and none cleared the cover and edge floors.`;
  return `${who} priced today's slate, and nothing cleared the cover and edge floors.`;
}

/** Fields merged into a completed empty card. */
function noPlaysFields(reason, { noGames = false } = {}) {
  return {
    noPlays: NO_PLAYS_TITLE,
    noPlaysTitle: NO_PLAYS_TITLE,
    noPlaysReason: reason,
    noGames: !!noGames,
    runComplete: true,
  };
}

/** Read-side: give an older completed empty blob the same headline + a reason. */
function normalizeEmptyCard(card, model) {
  if (!card || typeof card !== 'object') return card;
  const hasPicks = Array.isArray(card.picks) && card.picks.length > 0;
  if (model === 'omega') {
    if (hasPicks) return stripLiveCopyFields(card);
    return repairOmegaEmptyCard(card);
  }
  if (hasPicks) return card;
  if (card.noPlaysTitle && card.noPlaysReason) return card;
  const noGames = card.noGames === true || /Games Scheduled/i.test(card.noPlays || '');
  let reason;
  if (model === 'edge') {
    reason = card.noGames === true
      ? "There are no games on today's board, so Edge has nothing to price."
      : "None of today's games cleared Edge's minimum edge thresholds.";
  } else if (model === 'alpha') {
    reason = "None of today's games cleared Alpha's edge thresholds.";
  } else {
    reason = sportReason(model, { noGames, gamesPriced: (card.debug && card.debug.gamesPriced) || 0 });
  }
  return { ...card, ...noPlaysFields(reason, { noGames }) };
}

module.exports = {
  NO_PLAYS_TITLE,
  omegaReason,
  sportReason,
  sportWatchSentence,
  noPlaysFields,
  normalizeEmptyCard,
  unstampEmptyCard,
  stripModelCodenames,
};
