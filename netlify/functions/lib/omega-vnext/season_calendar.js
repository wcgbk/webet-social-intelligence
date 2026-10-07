'use strict';

/**
 * Season calendar — single source of sport phase and card eligibility.
 * Pure data and pure functions. No I/O.
 *
 * Every date is an America/New_York calendar date (YYYY-MM-DD, inclusive).
 * Callers must pass the CARD date (generate's `date`), never wall-clock,
 * so a replay of a past date behaves as it did on that date.
 *
 * phase.eligible is whether that phase is a card phase. NBA still needs
 * the explicit live flag (NBA_CARD_LIVE or OMEGA_NBA_LIVE=1). Preseason
 * is never card-eligible, including NBA with the flag on.
 *
 * Neutral-site home-field advantage is NOT applied here and is NOT a model
 * change. NFL Super Bowl and NCAAF bowls/CFP notes record that follow-up.
 *
 * Dates outside every encoded phase are phase 'unknown' and fail open to
 * the kill switch (SPORTS_ENABLED, or the NBA live flag in its place) so a
 * stale calendar cannot silently empty the card.
 */

const { SPORTS_ENABLED, NBA_CARD_LIVE } = require('./config');

const PHASES = ['preseason', 'regular', 'conf_champ', 'bowls', 'playin', 'postseason', 'offseason'];

/**
 * Replay window the two-week gate compares byte-for-byte.
 * NHL preseason runs through 2026-09-28 inside this window. The live card
 * already publishes NHL on those dates (SPORTS_ENABLED.NHL, no calendar
 * gate). sportsForCard keeps that set. phaseFor / isCardEligible stay
 * honest: NHL 2026-09-28 is preseason and not eligible.
 */
const REPLAY_LOCK_FROM = '2026-09-22';
const REPLAY_LOCK_THROUGH = '2026-10-06';

const CARD_SPORTS = ['MLB', 'NFL', 'NCAAF', 'NHL', 'NBA'];

const MLB_SOURCE = 'MLB StatsAPI 2026 regularSeasonEndDate; postseason WC 09-29..10-01, DS 10-03..10-10, LCS 10-11..10-20, World Series 10-23..10-31';
const NFL_SOURCE = 'ESPN NFL core API seasons/2026/types; NFL 2026-27 schedule (Week 18 ends 2027-01-10, Super Bowl LXI 2027-02-14 SoFi)';
const NCAAF_SOURCE = 'ESPN college-football scoreboard season; CFP/bowl press slate (Celebration Bowl 12-12, CFP first round 12-18..12-19, QF 12-30 and 2027-01-01, SF 2027-01-14/01-15, National Championship 2027-01-25 Las Vegas)';
const NHL_SOURCE = 'NHL api-web 2026-27 regularSeasonStartDate 2026-09-29 / regularSeasonEndDate 2027-04-10; preseason 2026-09-19..09-28';
const NBA_SOURCE = 'ESPN NBA scoreboard / 2026-27 schedule (preseason 2026-10-02..10-19, opener 2026-10-20 BOS@DET and PHI@NY, play-in 2027-04-12..04-16, postseason through 2027-06-25)';

/** @type {Record<string, Array<{phase:string,start:string,end:string,eligible:boolean,note:string,source:string}>>} */
const SEASONS = {
  MLB: [
    {
      phase: 'regular',
      start: '2026-03-25',
      end: '2026-09-27',
      eligible: true,
      note: 'MLB regular season. StatsAPI regularSeasonEndDate 2026-09-27.',
      source: MLB_SOURCE,
    },
    {
      phase: 'postseason',
      start: '2026-09-28',
      end: '2026-10-31',
      eligible: true,
      note: 'Postseason eligible (same engine already publishing, e.g. 2026-10-06 Dodgers@Braves). Wild Card 09-29..10-01, DS 10-03..10-10, LCS 10-11..10-20, World Series 10-23..10-31 max.',
      source: MLB_SOURCE,
    },
    {
      phase: 'offseason',
      start: '2026-11-01',
      end: '2027-03-24',
      eligible: false,
      note: 'Offseason from 2026-11-01. Not card-eligible. The 2027 season is not encoded; dates after 2027-03-24 are unknown and fail open.',
      source: MLB_SOURCE,
    },
  ],
  NFL: [
    {
      phase: 'preseason',
      start: '2026-08-06',
      end: '2026-09-05',
      eligible: false,
      note: 'NFL preseason. Not card-eligible.',
      source: NFL_SOURCE,
    },
    {
      phase: 'regular',
      start: '2026-09-06',
      end: '2027-01-12',
      eligible: true,
      note: 'NFL regular season. Week 18 ends 2027-01-10; phase runs through 2027-01-12.',
      source: NFL_SOURCE,
    },
    {
      phase: 'postseason',
      start: '2027-01-13',
      end: '2027-02-15',
      eligible: true,
      note: 'Postseason eligible (same engine). Wild Card 2027-01-16..01-18, Divisional 01-23..01-24, Conference Championships 01-31, Super Bowl LXI 2027-02-14 SoFi (neutral site). Neutral-site HFA is NOT handled — follow-up; do not change HFA.',
      source: NFL_SOURCE,
    },
    {
      phase: 'offseason',
      start: '2027-02-16',
      end: '2027-08-05',
      eligible: false,
      note: 'Offseason from 2027-02-16. Not card-eligible. Dates after 2027-08-05 are unknown and fail open until the next season is encoded.',
      source: NFL_SOURCE,
    },
  ],
  NCAAF: [
    {
      phase: 'regular',
      start: '2026-08-22',
      end: '2026-11-28',
      eligible: true,
      note: 'NCAAF regular season. Last full regular Saturday 2026-11-28.',
      source: NCAAF_SOURCE,
    },
    {
      phase: 'conf_champ',
      start: '2026-12-04',
      end: '2026-12-06',
      eligible: true,
      note: 'Conference championships eligible. ACC/SEC/MAC 2026-12-05; Big Ten / American that weekend.',
      source: NCAAF_SOURCE,
    },
    {
      phase: 'regular',
      start: '2026-12-07',
      end: '2026-12-12',
      eligible: true,
      note: 'Army-Navy week. ESPN regular season through 2026-12-12 (Army-Navy 2026-12-12, week 15).',
      source: NCAAF_SOURCE,
    },
    {
      phase: 'bowls',
      start: '2026-12-12',
      end: '2027-01-25',
      eligible: true,
      note: 'Bowls/CFP eligible. Celebration Bowl 2026-12-12, CFP first round 12-18..12-19, CFP quarterfinals 12-30 and 2027-01-01, semifinals 2027-01-14/01-15, CFP National Championship 2027-01-25 Las Vegas (neutral). Neutral-site HFA is NOT handled (follow-up; do not change HFA). TBD/TBA and winner-of/loser-of names are skipped before candidates. 2026-12-12 also sits on the regular-season Army-Navy date; eligible either way.',
      source: NCAAF_SOURCE,
    },
    {
      phase: 'offseason',
      start: '2027-01-26',
      end: '2027-08-21',
      eligible: false,
      note: 'Offseason from 2027-01-26. Not card-eligible. Dates after 2027-08-21 are unknown and fail open until the next season is encoded.',
      source: NCAAF_SOURCE,
    },
  ],
  NHL: [
    {
      phase: 'preseason',
      start: '2026-09-19',
      end: '2026-09-28',
      eligible: false,
      note: 'NHL preseason. Not card-eligible.',
      source: NHL_SOURCE,
    },
    {
      phase: 'regular',
      start: '2026-09-29',
      end: '2027-04-10',
      eligible: true,
      note: 'NHL regular season. api-web regularSeasonStartDate 2026-09-29, regularSeasonEndDate 2027-04-10.',
      source: NHL_SOURCE,
    },
    {
      phase: 'postseason',
      start: '2027-04-11',
      end: '2027-06-30',
      eligible: true,
      note: 'NHL postseason eligible (same engine).',
      source: NHL_SOURCE,
    },
    {
      phase: 'offseason',
      start: '2027-07-01',
      end: '2027-09-18',
      eligible: false,
      note: 'Offseason after 2027-06-30. Not card-eligible. Dates after 2027-09-18 are unknown and fail open until the next season is encoded.',
      source: NHL_SOURCE,
    },
  ],
  NBA: [
    {
      phase: 'offseason',
      start: '2025-07-01',
      end: '2026-10-01',
      eligible: false,
      note: 'Before the encoded 2026-27 preseason. Not card-eligible. The prior NBA season is not encoded game-by-game; this window keeps those dates from looking like a stale calendar.',
      source: NBA_SOURCE,
    },
    {
      phase: 'preseason',
      start: '2026-10-02',
      end: '2026-10-19',
      eligible: false,
      note: 'NBA preseason. Never card-eligible, even if OMEGA_NBA_LIVE=1 or NBA_CARD_LIVE is turned on. Shadow job is unchanged.',
      source: NBA_SOURCE,
    },
    {
      phase: 'regular',
      start: '2026-10-20',
      end: '2027-04-11',
      eligible: true,
      note: 'NBA regular season (opener 2026-10-20 BOS@DET, PHI@NY). Phase qualifies for the card only together with the explicit live flag. The date does not flip the card by itself. WeBet has not approved an automatic flip.',
      source: NBA_SOURCE,
    },
    {
      phase: 'playin',
      start: '2027-04-12',
      end: '2027-04-16',
      eligible: true,
      note: 'NBA play-in. Card-eligible only with the explicit live flag.',
      source: NBA_SOURCE,
    },
    {
      phase: 'postseason',
      start: '2027-04-17',
      end: '2027-06-25',
      eligible: true,
      note: 'NBA postseason. Card-eligible only with the explicit live flag.',
      source: NBA_SOURCE,
    },
    {
      phase: 'offseason',
      start: '2027-06-26',
      end: '2027-10-01',
      eligible: false,
      note: 'Offseason after 2027-06-25. Not card-eligible. Dates after 2027-10-01 are unknown and fail open to the live flag.',
      source: NBA_SOURCE,
    },
  ],
};

const warnedStaleDates = new Set();

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function nbaLive(env) {
  const e = env || {};
  if (e.OMEGA_NBA_LIVE === '1') return true;
  if (NBA_CARD_LIVE === true) return true;
  return false;
}

function warnStale(dateET) {
  const key = String(dateET || '');
  if (warnedStaleDates.has(key)) return;
  warnedStaleDates.add(key);
  console.warn(`[omega-calendar] WARN stale calendar date=${key}`);
}

function resetStaleWarnings() {
  warnedStaleDates.clear();
}

function unknownPhase(sport, dateET, { warn = true } = {}) {
  if (warn && isYmd(dateET)) warnStale(dateET);
  return {
    phase: 'unknown',
    eligible: sport === 'NBA' ? false : !!SPORTS_ENABLED[sport],
    note: 'Outside every encoded phase. Fail-open to the kill switch so a stale calendar does not empty the card.',
    source: (SEASONS[sport] && SEASONS[sport][0] && SEASONS[sport][0].source) || 'unencoded',
    stale: true,
  };
}

/**
 * @param {string} sport
 * @param {string} dateET YYYY-MM-DD America/New_York card date
 * @returns {{phase:string,eligible:boolean,note:string,source:string,stale?:boolean,overlap?:string[]}}
 */
function phaseFor(sport, dateET) {
  const key = String(sport || '').toUpperCase();
  const date = String(dateET || '');
  const rows = SEASONS[key];
  if (!rows || !isYmd(date)) return unknownPhase(key, date, { warn: isYmd(date) && !!rows });
  const hits = rows.filter((row) => date >= row.start && date <= row.end);
  if (!hits.length) return unknownPhase(key, date);
  const eligibleHits = hits.filter((row) => row.eligible);
  const chosen = eligibleHits[eligibleHits.length - 1] || hits[hits.length - 1];
  const overlap = hits.length > 1 ? hits.map((row) => row.phase) : null;
  let note = chosen.note;
  if (overlap) {
    note = `${overlap.join('+')}: ${hits.map((row) => row.note).join(' | ')}`;
  }
  return {
    phase: chosen.phase,
    eligible: hits.some((row) => row.eligible),
    note,
    source: chosen.source,
    stale: false,
    overlap: overlap || undefined,
  };
}

/**
 * Card eligibility for one sport on a card date.
 * Non-NBA: SPORTS_ENABLED[sport] && phase eligible (unknown fails open to SPORTS_ENABLED).
 * NBA: live flag in place of SPORTS_ENABLED.NBA, and phase in {regular, playin, postseason}.
 * Preseason is never eligible, even with the flag. Unknown NBA fails open to the live flag.
 */
function isCardEligible(sport, dateET, opts = {}) {
  const env = opts.env || process.env;
  const key = String(sport || '').toUpperCase();
  const phase = phaseFor(key, dateET);
  if (key === 'NBA') {
    const live = nbaLive(env);
    if (phase.phase === 'unknown') {
      return {
        eligible: live,
        phase: 'unknown',
        reason: live ? 'stale-calendar-fail-open' : 'nba-live-off',
        note: phase.note,
        source: phase.source,
      };
    }
    const phaseOk = phase.phase === 'regular' || phase.phase === 'playin' || phase.phase === 'postseason';
    let reason = 'ok';
    if (!phaseOk) reason = phase.phase === 'preseason' ? 'nba-preseason' : 'nba-phase';
    else if (!live) reason = 'nba-live-off';
    return {
      eligible: phaseOk && live,
      phase: phase.phase,
      reason,
      note: phase.note,
      source: phase.source,
    };
  }
  const kill = !!SPORTS_ENABLED[key];
  if (phase.phase === 'unknown') {
    return {
      eligible: kill,
      phase: 'unknown',
      reason: kill ? 'stale-calendar-fail-open' : 'sports-enabled-off',
      note: phase.note,
      source: phase.source,
    };
  }
  const eligible = kill && !!phase.eligible;
  let reason = 'ok';
  if (!kill) reason = 'sports-enabled-off';
  else if (!phase.eligible) reason = 'phase-off';
  return {
    eligible,
    phase: phase.phase,
    reason,
    note: phase.note,
    source: phase.source,
  };
}

function isReplayLockDate(dateET) {
  const date = String(dateET || '');
  return isYmd(date) && date >= REPLAY_LOCK_FROM && date <= REPLAY_LOCK_THROUGH;
}

/**
 * Sports the daily card may price on dateET.
 * Inside 2026-09-22..2026-10-06 this matches SPORTS_ENABLED (NBA stays off
 * unless the live flag and a card phase both say yes — they do not).
 * Outside that window it is isCardEligible.
 */
function sportsForCard(dateET, opts = {}) {
  const env = opts.env || process.env;
  if (isReplayLockDate(dateET)) {
    const out = [];
    for (const sport of CARD_SPORTS) {
      if (sport === 'NBA') {
        if (isCardEligible('NBA', dateET, { env }).eligible) out.push('NBA');
        continue;
      }
      if (SPORTS_ENABLED[sport]) out.push(sport);
    }
    return out;
  }
  return eligibleSports(dateET, { env });
}

function eligibleSports(dateET, opts = {}) {
  const env = opts.env || process.env;
  const out = [];
  for (const sport of CARD_SPORTS) {
    if (isCardEligible(sport, dateET, { env }).eligible) out.push(sport);
  }
  return out;
}

/** Private health payload: phase per sport for the card date. No model fields. */
function calendarHealth(dateET, opts = {}) {
  const env = opts.env || process.env;
  const bySport = {};
  let stale = false;
  for (const sport of CARD_SPORTS) {
    const phase = phaseFor(sport, dateET);
    const card = isCardEligible(sport, dateET, { env });
    if (phase.phase === 'unknown') stale = true;
    bySport[sport] = {
      phase: phase.phase,
      eligible: card.eligible,
      phaseEligible: !!phase.eligible,
      reason: card.reason,
      note: phase.note,
      source: phase.source,
      overlap: phase.overlap || null,
    };
  }
  const onCard = isYmd(dateET) ? sportsForCard(dateET, { env }) : [];
  return { date: isYmd(dateET) ? dateET : null, stale, bySport, onCard };
}

module.exports = {
  PHASES,
  SEASONS,
  CARD_SPORTS,
  REPLAY_LOCK_FROM,
  REPLAY_LOCK_THROUGH,
  phaseFor,
  isCardEligible,
  eligibleSports,
  sportsForCard,
  isReplayLockDate,
  calendarHealth,
  nbaLive,
  resetStaleWarnings,
};
