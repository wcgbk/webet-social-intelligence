'use strict';
// Shared "No Qualifying Plays Today" card (2026-09-28).
// Rule: a run that COMPLETES with zero qualifying plays writes this card. The site keeps
// showing the previous card until a run completes; a started or failed run writes nothing.
// Copy: title-case headline + one or two short sentences of reason. No timestamp.

const NO_PLAYS_TITLE = 'No Qualifying Plays Today';

const MODEL_LABEL = { omega: 'Omega', nfl: "Omega's NFL model", cfb: "Omega's college football model" };
const SPORT_WORD = { MLB: 'baseball', NFL: 'NFL', NCAAF: 'college football', NHL: 'hockey', NBA: 'basketball' };

function gamesWord(n) { return n === 1 ? 'game' : 'games'; }

function mlbOffClause(dateISO) {
  const [, m, d] = String(dateISO || '').split('-').map(Number);
  if (m === 9 && d >= 25) return 'Baseball is off today ahead of the postseason.';
  if (m === 10 || m === 11) return 'Baseball has a postseason off day.';
  if (m >= 3 && m <= 9) return "There's no baseball today.";
  return null; // offseason: not worth mentioning
}

/** Omega (multi-sport) reason. counts = { MLB, NFL, NCAAF, NHL, NBA? } same-day games. */
function omegaReason({ counts = {}, dateISO, hardFails = 0 } = {}) {
  const c = { MLB: +counts.MLB || 0, NFL: +counts.NFL || 0, NCAAF: +counts.NCAAF || 0, NHL: +counts.NHL || 0 };
  if (+counts.NBA > 0) c.NBA = +counts.NBA;
  const total = c.MLB + c.NFL + c.NCAAF + c.NHL + (c.NBA || 0);
  if (!total) return "There are no baseball or football games on today's board, so Omega has nothing to price.";
  const only = Object.keys(c).filter(k => c[k] > 0);
  let core;
  if (total === 1) {
    core = `the one ${SPORT_WORD[only[0]]} game on today's board didn't ${hardFails ? "hold up through Omega's late checks" : "clear Omega's edge floors"}`;
  } else if (only.length === 1 && (only[0] === 'NHL' || only[0] === 'NBA')) {
    const word = SPORT_WORD[only[0]];
    core = hardFails
      ? `none of the ${total} ${word} games on today's board held up through Omega's edge floors and late checks`
      : `none of the ${total} ${word} games on today's board cleared Omega's edge floors`;
  } else {
    core = hardFails
      ? `none of the ${total} games on today's board held up through Omega's edge floors and late checks`
      : `none of the ${total} games on today's board cleared Omega's edge floors`;
  }
  // Baseball off-day copy stays on football-only days. A hockey or basketball slate does not use it.
  const off = !c.MLB && (c.NFL || c.NCAAF) ? mlbOffClause(dateISO) : null;
  const sentence = `${core.charAt(0).toUpperCase()}${core.slice(1)}.`;
  return off ? `${off} ${sentence}` : sentence;
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
  if (!card || (Array.isArray(card.picks) && card.picks.length)) return card;
  if (card.noPlaysTitle && card.noPlaysReason) return card;
  const noGames = card.noGames === true || /Games Scheduled/i.test(card.noPlays || '');
  let reason;
  if (model === 'edge') {
    reason = card.noGames === true
      ? "There are no games on today's board, so Edge has nothing to price."
      : "None of today's games cleared Edge's minimum edge thresholds.";
  } else if (model === 'alpha') {
    reason = "None of today's games cleared Alpha's edge thresholds.";
  } else if (model === 'omega') {
    reason = /late checks/i.test(card.noPlays || '')
      ? "Omega's late checks removed every candidate on today's board."
      : "None of today's games cleared Omega's edge floors.";
  } else {
    reason = sportReason(model, { noGames, gamesPriced: (card.debug && card.debug.gamesPriced) || 0 });
  }
  return { ...card, ...noPlaysFields(reason, { noGames }) };
}

module.exports = { NO_PLAYS_TITLE, omegaReason, sportReason, noPlaysFields, normalizeEmptyCard };
