'use strict';

// Forward-only grading rules. Card dates before this ET date (the picks blob
// dateISO) must grade exactly as they did on 50d3eb9. Do not retune past KPIs.
const GRADING_RULES_V2_FROM = '2026-10-07';
// Id matching for every sport (and the White Sox / Red Sox split) starts on
// this card date. Earlier dates keep the matcher they were graded with.
const IDENTITY_V2_FROM = '2026-10-07';
// Point-aware realized CLV. Earlier card dates keep the price-only CLV that
// was stored, even when the closing number moved. Do not rewrite those rows.
const CLV_POINT_AWARE_FROM = '2026-10-09';
const POSTPONE_CUTOFF_MS = 24 * 60 * 60 * 1000;

function rulesV2(dateISO) {
  return typeof dateISO === 'string' && dateISO >= GRADING_RULES_V2_FROM;
}

function identityV2(dateISO) {
  return typeof dateISO === 'string' && dateISO >= IDENTITY_V2_FROM;
}

function clvPointAware(dateISO) {
  return typeof dateISO === 'string' && dateISO >= CLV_POINT_AWARE_FROM;
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

function scoreNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function sumLine(line) {
  let sum = 0;
  for (const n of line || []) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

function lineArray(primary, alt) {
  if (Array.isArray(primary)) return primary;
  if (Array.isArray(alt)) return alt;
  return null;
}

function noInnings() {
  return { awayN: 0, homeN: 0, has: false, awayLine: null, homeLine: null };
}

// Linescores count only when both sides played and each line adds up to that
// side's final score. A one-sided or inconsistent line is missing data, so the
// snapshot stays null and the ticket grades as it did before (never a void).
// Empty arrays are missing, not 0 innings.
// Track-clv stores awayInnings/homeInnings instead of lines. Use those only when
// both are > 0. awayScoreF5/homeScoreF5 are a 5-inning sum, not a checksum, so
// a missing pair does not relax that: both counts still have to be > 0.
function inningCounts(game) {
  if (!game) return noInnings();
  const awayLine = lineArray(game.awayLine, game.awayLinescores);
  const homeLine = lineArray(game.homeLine, game.homeLinescores);
  const awayHas = !!(awayLine && awayLine.length > 0);
  const homeHas = !!(homeLine && homeLine.length > 0);
  if (awayHas && homeHas) {
    const awaySum = sumLine(awayLine);
    const homeSum = sumLine(homeLine);
    if (awaySum === scoreNum(game.awayScore) && homeSum === scoreNum(game.homeScore)) {
      return { awayN: awayLine.length, homeN: homeLine.length, has: true, awayLine, homeLine };
    }
    return noInnings();
  }
  // One side posted a line and the other did not. Do not fill the gap from
  // awayInnings/homeInnings, which may themselves be the bad lengths.
  if (awayHas || homeHas) return noInnings();

  const ai = Number(game.awayInnings);
  const hi = Number(game.homeInnings);
  if (!(Number.isFinite(ai) && Number.isFinite(hi) && ai > 0 && hi > 0)) return noInnings();
  return { awayN: ai, homeN: hi, has: true, awayLine: null, homeLine: null };
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
  IDENTITY_V2_FROM,
  CLV_POINT_AWARE_FROM,
  POSTPONE_CUTOFF_MS,
  rulesV2,
  identityV2,
  clvPointAware,
  nowMs,
  scheduledStartMs,
  isRescheduled,
  isStaleUnstarted,
  earlyPush,
  isPpdScore,
  inningCounts,
  mlbSnapshot,
};
