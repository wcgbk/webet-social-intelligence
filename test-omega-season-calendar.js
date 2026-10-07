'use strict';
// Season calendar phases, card eligibility, and TBD name skips. No network.
const assert = require('assert');
const { SPORTS_ENABLED, NBA_CARD_LIVE } = require('./netlify/functions/lib/omega-vnext/config');
const cal = require('./netlify/functions/lib/omega-vnext/season_calendar');

assert.strictEqual(SPORTS_ENABLED.NBA, false);
assert.strictEqual(NBA_CARD_LIVE, false);
assert.deepStrictEqual(cal.CARD_SPORTS, ['MLB', 'NFL', 'NCAAF', 'NHL', 'NBA']);

const OFF = { env: {} };
const LIVE = { env: { OMEGA_NBA_LIVE: '1' } };

function phase(sport, date, name, eligible) {
  const row = cal.phaseFor(sport, date);
  assert.strictEqual(row.phase, name, `${sport} ${date} phase`);
  assert.strictEqual(row.eligible, eligible, `${sport} ${date} phase.eligible`);
  assert.ok(row.note && row.source, `${sport} ${date} note/source`);
  return row;
}

function card(sport, date, opts, eligible) {
  const row = cal.isCardEligible(sport, date, opts || OFF);
  assert.strictEqual(row.eligible, eligible, `${sport} ${date} card eligible`);
  return row;
}

phase('MLB', '2026-09-27', 'regular', true);
card('MLB', '2026-09-27', OFF, true);
phase('MLB', '2026-09-28', 'postseason', true);
card('MLB', '2026-09-28', OFF, true);
phase('MLB', '2026-10-31', 'postseason', true);
card('MLB', '2026-10-31', OFF, true);
phase('MLB', '2026-11-01', 'offseason', false);
card('MLB', '2026-11-01', OFF, false);
assert.strictEqual(card('MLB', '2026-11-01', OFF, false).reason, 'phase-off');

phase('NFL', '2027-01-12', 'regular', true);
card('NFL', '2027-01-12', OFF, true);
phase('NFL', '2027-01-13', 'postseason', true);
card('NFL', '2027-01-13', OFF, true);
const sb = phase('NFL', '2027-02-14', 'postseason', true);
card('NFL', '2027-02-14', OFF, true);
assert.ok(/neutral/i.test(sb.note), 'Super Bowl note records neutral-site HFA follow-up');
phase('NFL', '2027-02-16', 'offseason', false);
card('NFL', '2027-02-16', OFF, false);
phase('NFL', '2026-09-05', 'preseason', false);
card('NFL', '2026-09-05', OFF, false);
phase('NFL', '2026-09-06', 'regular', true);

phase('NCAAF', '2026-11-28', 'regular', true);
card('NCAAF', '2026-11-28', OFF, true);
phase('NCAAF', '2026-12-05', 'conf_champ', true);
card('NCAAF', '2026-12-05', OFF, true);
const army = phase('NCAAF', '2026-12-12', 'bowls', true);
assert.ok(army.eligible);
assert.ok(army.overlap && army.overlap.indexOf('regular') !== -1 && army.overlap.indexOf('bowls') !== -1);
card('NCAAF', '2026-12-12', OFF, true);
const cfp = phase('NCAAF', '2026-12-19', 'bowls', true);
card('NCAAF', '2026-12-19', OFF, true);
assert.ok(/CFP/i.test(cfp.note));
const title = phase('NCAAF', '2027-01-25', 'bowls', true);
card('NCAAF', '2027-01-25', OFF, true);
assert.ok(/neutral/i.test(title.note), 'CFP title note records neutral-site HFA follow-up');
phase('NCAAF', '2027-01-26', 'offseason', false);
card('NCAAF', '2027-01-26', OFF, false);

phase('NHL', '2026-09-28', 'preseason', false);
assert.strictEqual(card('NHL', '2026-09-28', OFF, false).reason, 'phase-off');
phase('NHL', '2026-09-29', 'regular', true);
card('NHL', '2026-09-29', OFF, true);
phase('NHL', '2027-04-10', 'regular', true);
card('NHL', '2027-04-10', OFF, true);
phase('NHL', '2027-04-11', 'postseason', true);
card('NHL', '2027-04-11', OFF, true);

phase('NBA', '2026-10-19', 'preseason', false);
assert.strictEqual(card('NBA', '2026-10-19', OFF, false).reason, 'nba-preseason');
assert.strictEqual(card('NBA', '2026-10-19', LIVE, false).reason, 'nba-preseason');
phase('NBA', '2026-10-20', 'regular', true);
assert.strictEqual(card('NBA', '2026-10-20', OFF, false).reason, 'nba-live-off');
assert.strictEqual(card('NBA', '2026-10-20', LIVE, true).reason, 'ok');
assert.strictEqual(card('NBA', '2027-04-12', OFF, false).phase, 'playin');
assert.strictEqual(card('NBA', '2027-04-12', LIVE, true).phase, 'playin');
assert.strictEqual(card('NBA', '2027-04-17', LIVE, true).phase, 'postseason');
assert.strictEqual(card('NBA', '2027-06-26', LIVE, false).reason, 'nba-phase');

cal.resetStaleWarnings();
const warns = [];
const prevWarn = console.warn;
console.warn = (msg) => warns.push(String(msg));
try {
  for (const sport of cal.CARD_SPORTS) {
    const row = cal.phaseFor(sport, '2025-01-01');
    assert.strictEqual(row.phase, 'unknown', sport);
    assert.strictEqual(row.stale, true);
  }
  cal.phaseFor('MLB', '2025-01-01');
} finally {
  console.warn = prevWarn;
}
assert.strictEqual(warns.length, 1, 'one stale warning per date');
assert.ok(warns[0].indexOf('[omega-calendar] WARN stale calendar date=2025-01-01') !== -1);

assert.strictEqual(cal.isCardEligible('MLB', '2025-01-01', OFF).eligible, true);
assert.strictEqual(cal.isCardEligible('MLB', '2025-01-01', OFF).reason, 'stale-calendar-fail-open');
assert.strictEqual(cal.isCardEligible('NFL', '2025-01-01', OFF).eligible, true);
assert.strictEqual(cal.isCardEligible('NCAAF', '2025-01-01', OFF).eligible, true);
assert.strictEqual(cal.isCardEligible('NHL', '2025-01-01', OFF).eligible, true);
assert.strictEqual(cal.isCardEligible('NBA', '2025-01-01', OFF).eligible, false);
assert.strictEqual(cal.isCardEligible('NBA', '2025-01-01', OFF).reason, 'nba-live-off');
assert.strictEqual(cal.isCardEligible('NBA', '2025-01-01', LIVE).eligible, true);
assert.strictEqual(cal.isCardEligible('NBA', '2025-01-01', LIVE).reason, 'stale-calendar-fail-open');

function nextDay(ymd) {
  const parts = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

const enabledToday = cal.CARD_SPORTS.filter((sport) => sport !== 'NBA' && SPORTS_ENABLED[sport]);
assert.deepStrictEqual(enabledToday, ['MLB', 'NFL', 'NCAAF', 'NHL']);
for (let date = '2026-09-22'; date <= '2026-10-06'; date = nextDay(date)) {
  assert.strictEqual(cal.isReplayLockDate(date), true, date);
  assert.deepStrictEqual(cal.sportsForCard(date, OFF), enabledToday, date);
  assert.ok(cal.sportsForCard(date, OFF).indexOf('NBA') === -1, date);
}
assert.strictEqual(cal.isCardEligible('NHL', '2026-09-22', OFF).eligible, false);
assert.strictEqual(cal.isCardEligible('NHL', '2026-09-28', OFF).eligible, false);
assert.ok(cal.eligibleSports('2026-09-28', OFF).indexOf('NHL') === -1);
for (let date = '2026-09-29'; date <= '2026-10-06'; date = nextDay(date)) {
  const honest = cal.eligibleSports(date, OFF);
  for (const sport of enabledToday) assert.ok(honest.indexOf(sport) !== -1, `${date} ${sport}`);
  assert.ok(honest.indexOf('NBA') === -1, date);
}
assert.deepStrictEqual(cal.sportsForCard('2026-10-07', OFF), enabledToday);
assert.strictEqual(cal.isReplayLockDate('2026-10-07'), false);

const health = cal.calendarHealth('2026-10-06', OFF);
assert.strictEqual(health.stale, false);
assert.strictEqual(health.bySport.MLB.phase, 'postseason');
assert.strictEqual(health.bySport.NFL.phase, 'regular');
assert.strictEqual(health.bySport.NCAAF.phase, 'regular');
assert.strictEqual(health.bySport.NHL.phase, 'regular');
assert.strictEqual(health.bySport.NBA.phase, 'preseason');
assert.deepStrictEqual(health.onCard, enabledToday);
assert.strictEqual(health.bySport.NBA.eligible, false);

assert.strictEqual(cal.isUnresolvedName(''), true);
assert.strictEqual(cal.isUnresolvedName('   '), true);
assert.strictEqual(cal.isUnresolvedName(null), true);
assert.strictEqual(cal.isUnresolvedName('TBD'), true);
assert.strictEqual(cal.isUnresolvedName('tba'), true);
assert.strictEqual(cal.isUnresolvedName('To Be Determined'), true);
assert.strictEqual(cal.isUnresolvedName('Winner of NFC'), true);
assert.strictEqual(cal.isUnresolvedName('loser of AFC West'), true);
assert.strictEqual(cal.isUnresolvedName('Kansas City Chiefs'), false);
assert.strictEqual(cal.isUnresolvedName('Studio'), false);

const raw = {
  oddsBySport: {
    NFL: [
      { home_team: 'TBD', away_team: 'Kansas City Chiefs' },
      { home_team: 'Buffalo Bills', away_team: 'Winner of AFC West' },
      { home_team: '', away_team: 'Detroit Lions' },
      { home_team: 'To Be Determined', away_team: 'Dallas Cowboys' },
      { home_team: 'TBA', away_team: 'Green Bay Packers' },
      { home_team: 'Philadelphia Eagles', away_team: 'loser of NFC East' },
      { home_team: 'Baltimore Ravens', away_team: 'Cincinnati Bengals' },
    ],
    MLB: [
      { home_team: 'Los Angeles Dodgers', away_team: 'Atlanta Braves' },
    ],
  },
  espnBySport: {
    NCAAF: {
      games: [
        { homeTeam: 'TBD', awayTeam: 'Alabama', neutralSite: true },
        { homeTeam: 'Georgia', awayTeam: 'Ohio State', neutralSite: true },
        { homeTeam: 'Michigan', awayTeam: 'Oregon', neutralSite: false },
      ],
    },
  },
};
const skipped = cal.applyUnresolvedSkip(raw);
assert.strictEqual(raw.oddsBySport.NFL.length, 7, 'source odds list is not mutated');
assert.strictEqual(skipped.oddsBySport.NFL.length, 1);
assert.strictEqual(skipped.oddsBySport.NFL[0].home_team, 'Baltimore Ravens');
assert.strictEqual(skipped.oddsBySport.MLB.length, 1);
assert.strictEqual(skipped.unresolvedSkipped.NFL, 6);
assert.strictEqual(skipped.espnBySport.NCAAF.games.length, 2);
assert.strictEqual(skipped.unresolvedSkipped.NCAAF, 1);
assert.strictEqual(skipped.neutralSiteCounts.NCAAF, 2);
assert.ok(skipped.espnBySport.NCAAF.games.some((g) => g.homeTeam === 'Georgia'));
const line = cal.formatSkipLog(skipped.unresolvedSkipped, skipped.neutralSiteCounts);
assert.ok(line.indexOf('[omega-calendar] unresolved ') === 0);
assert.ok(line.indexOf('NFL:skip=6,neutral=0') !== -1);
assert.ok(line.indexOf('NCAAF:skip=1,neutral=2') !== -1);
assert.ok(line.indexOf('MLB:skip=0,neutral=0') !== -1);

console.log('PASS test-omega-season-calendar');
