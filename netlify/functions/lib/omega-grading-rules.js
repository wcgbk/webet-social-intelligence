'use strict';

// Forward-only grading rules. Card dates before this ET date (the picks blob
// dateISO) must grade exactly as they did on 50d3eb9. Do not retune past KPIs.
const GRADING_RULES_V2_FROM = '2026-10-07';
const POSTPONE_CUTOFF_MS = 24 * 60 * 60 * 1000;

function rulesV2(dateISO) {
  return typeof dateISO === 'string' && dateISO >= GRADING_RULES_V2_FROM;
}

function nowMs(opts) {
  if (opts && opts.now != null) {
    const n = typeof opts.now === 'function' ? opts.now() : Number(opts.now);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function dateOf(opts) {
  return (opts && opts.dateISO) || null;
}

// Prefer the pick's commenceTime. Fall back to the matched game's start.
function scheduledStartMs(pick, game) {
  const c = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
  if (Number.isFinite(c)) return c;
  const s = game && game.startISO ? Date.parse(game.startISO) : NaN;
  return Number.isFinite(s) ? s : null;
}

// Matched game moved more than 24h after the ticket's commenceTime.
function isRescheduled(pick, game) {
  const c = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
  const s = game && game.startISO ? Date.parse(game.startISO) : NaN;
  if (!Number.isFinite(c) || !Number.isFinite(s)) return false;
  return (s - c) > POSTPONE_CUTOFF_MS;
}

// Still unstarted (pre, postponed, or scheduled) after start + 24h.
function isStaleUnstarted(pick, game, now) {
  if (!game) return false;
  const name = game.statusName || '';
  const unstarted = game.state === 'pre' || /POSTPONED|SCHEDULED/i.test(name);
  if (!unstarted) return false;
  const start = scheduledStartMs(pick, game);
  if (start == null || !Number.isFinite(now)) return false;
  return now > start + POSTPONE_CUTOFF_MS;
}

// 'push' when a v2 card should void for a stale pre or a next-day reschedule.
// Null leaves the existing postponed/canceled rule (all dates) in charge.
function earlyPush(pick, game, opts) {
  if (!rulesV2(dateOf(opts)) || !pick || !game) return null;
  if (isRescheduled(pick, game)) return 'push';
  if (isStaleUnstarted(pick, game, nowMs(opts))) return 'push';
  return null;
}

// Score label for a voided ticket. Legacy postponed/canceled stays for every date.
function isPpdScore(pick, game, opts) {
  if (!game) return false;
  const name = game.statusName || '';
  if (game.state === 'post' && (/POSTPONED|CANCELL?ED/i.test(name) || !game.completed)) return true;
  if (!rulesV2(dateOf(opts))) return false;
  if (isRescheduled(pick, game)) return true;
  if (isStaleUnstarted(pick, game, nowMs(opts))) return true;
  return false;
}

// Linescore length is the inning count. Empty arrays are missing data, not 0 innings.
function inningCounts(game) {
  const awayLine = Array.isArray(game.awayLine) ? game.awayLine
    : (Array.isArray(game.awayLinescores) ? game.awayLinescores : null);
  const homeLine = Array.isArray(game.homeLine) ? game.homeLine
    : (Array.isArray(game.homeLinescores) ? game.homeLinescores : null);
  if (awayLine && homeLine && (awayLine.length > 0 || homeLine.length > 0)) {
    return { awayN: awayLine.length, homeN: homeLine.length, has: true, awayLine, homeLine };
  }
  const ai = Number(game.awayInnings);
  const hi = Number(game.homeInnings);
  if (Number.isFinite(ai) && Number.isFinite(hi) && (ai > 0 || hi > 0)) {
    return { awayN: ai, homeN: hi, has: true, awayLine: null, homeLine: null };
  }
  return { awayN: 0, homeN: 0, has: false, awayLine: null, homeLine: null };
}

function sumLine(line) {
  return (line || []).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

function partialF5Scores(game, info) {
  if (info.awayLine && info.homeLine) {
    return { awayScore: sumLine(info.awayLine), homeScore: sumLine(info.homeLine) };
  }
  if (game.awayScoreF5 != null && game.homeScoreF5 != null) {
    return { awayScore: Number(game.awayScoreF5) || 0, homeScore: Number(game.homeScoreF5) || 0 };
  }
  return { awayScore: Number(game.awayScore) || 0, homeScore: Number(game.homeScore) || 0 };
}

// MLB snapshot for a v2 card. Null means "grade exactly as before"
// (not MLB, not a completed final, or linescores are missing).
// f5Mode: 'normal' (>=5 each), 'partial' (4.5 and home leads), 'void' (shorter final).
// mlOfficial: 5 innings, or 4.5 with the home team ahead.
// fullOfficial: 9 innings, or 8.5 with the home team ahead (totals and run lines).
function mlbSnapshot(pick, game, opts) {
  if (!rulesV2(dateOf(opts)) || !pick || !game) return null;
  if ((pick.sport || '') !== 'MLB') return null;
  if (game.state !== 'post' || game.completed === false) return null;
  if (/POSTPONED|CANCELL?ED|SUSPENDED/i.test(game.statusName || '')) return null;
  const info = inningCounts(game);
  if (!info.has) return null;
  const awayScore = Number(game.awayScore) || 0;
  const homeScore = Number(game.homeScore) || 0;
  const half5 = info.awayN === 5 && info.homeN === 4 && homeScore > awayScore;
  const half9 = info.awayN === 9 && info.homeN === 8 && homeScore > awayScore;
  const mlOfficial = (info.awayN >= 5 && info.homeN >= 5) || half5;
  const fullOfficial = (info.awayN >= 9 && info.homeN >= 9) || half9;
  let f5Mode = 'void';
  let awayF5 = null;
  let homeF5 = null;
  if (info.awayN >= 5 && info.homeN >= 5) {
    f5Mode = 'normal';
  } else if (half5) {
    f5Mode = 'partial';
    const scores = partialF5Scores(game, info);
    awayF5 = scores.awayScore;
    homeF5 = scores.homeScore;
  }
  return { mlOfficial, fullOfficial, f5Mode, awayScore: awayF5, homeScore: homeF5 };
}

module.exports = {
  GRADING_RULES_V2_FROM,
  POSTPONE_CUTOFF_MS,
  rulesV2,
  nowMs,
  scheduledStartMs,
  isRescheduled,
  isStaleUnstarted,
  earlyPush,
  isPpdScore,
  inningCounts,
  mlbSnapshot,
};
