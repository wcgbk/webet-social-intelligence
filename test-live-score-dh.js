#!/usr/bin/env node
// Live scoring: ESPN web host, doubleheader split, instant KPI merge.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const live = require('./js/live-score');
const { scoreboardUrls } = require('./netlify/functions/lib/espn-scoreboard');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const g1 = { startISO: '2026-09-25T20:05:00Z', state: 'post', awayScore: 10, homeScore: 2, awayTeam: 'Baltimore Orioles', homeTeam: 'New York Yankees' };
const g2 = { startISO: '2026-09-25T23:30:00Z', state: 'pre', awayScore: 0, homeScore: 0, awayTeam: 'Baltimore Orioles', homeTeam: 'New York Yankees' };
const straight = { pick: 'Over 6.5', matchup: 'Baltimore Orioles @ New York Yankees', sport: 'MLB', commenceTime: '2026-09-25T23:06:00Z' };
const parlay = { pick: 'Over 6.5', matchup: 'Baltimore Orioles @ New York Yankees', sport: 'MLB', commenceTime: '2026-09-25T20:05:00Z' };

console.log('doubleheader');
check('straight 23:06 stays on G2 (clear nightcap, even if pre)', () => {
  const g = live.disambiguateDoubleheader([g1, g2], straight);
  assert.strictEqual(g.startISO, g2.startISO);
});
check('parlay 20:05 stays on G1 final', () => {
  const g = live.disambiguateDoubleheader([g1, g2], parlay);
  assert.strictEqual(g.startISO, g1.startISO);
});
check('skewed time between games prefers in/post opener over pre nightcap', () => {
  const skewed = { ...straight, commenceTime: '2026-09-25T22:00:00Z' };
  const g = live.disambiguateDoubleheader([g1, g2], skewed);
  assert.strictEqual(g.startISO, g1.startISO);
});
check('clear nightcap is not pulled onto the opener', () => {
  const g = live.resolveDoubleheader([g1, g2], straight, Date.parse('2026-09-25T21:00:00Z'));
  assert.strictEqual(g.startISO, g2.startISO);
});
check('single future pick does not settle on a lone final', () => {
  const future = { ...straight, commenceTime: '2026-09-26T23:00:00Z' };
  const g = live.resolveDoubleheader([g1], future, Date.parse('2026-09-25T21:00:00Z'));
  assert.strictEqual(g, null);
});
check('inherit keeps a leg commenceTime (DH split)', () => {
  const leg = live.inheritCommenceTime(parlay, [straight]);
  assert.strictEqual(leg.commenceTime, parlay.commenceTime);
});
check('inherit does not glue a timeless leg across split DH times', () => {
  const bare = { pick: 'Over 6.5', matchup: straight.matchup };
  const leg = live.inheritCommenceTime(bare, [straight, parlay]);
  assert.strictEqual(leg.commenceTime, undefined);
});
check('same pick text on different games is not one grade target', () => {
  assert.strictEqual(live.sameGradeTarget(straight, parlay), false);
  assert.strictEqual(live.sameGradeTarget(straight, { ...straight }), true);
});

console.log('kpi merge');
check('today client win replaces a stale server pending day without dropping history', () => {
  const snap = {
    straight: { wins: 4, losses: 2 },
    cumulative: { totalProfit: 100, totalWagered: 500 },
    days: [{ date: '2026-09-25', wins: 0, losses: 0, profit: 0, wagered: 0 }],
  };
  const today = { date: '2026-09-25', wins: 1, losses: 0, pushes: 0, profit: 80, wagered: 150 };
  const view = live.mergeTodayKpi(snap, today);
  assert.strictEqual(view.wins, 5);
  assert.strictEqual(view.losses, 2);
  assert.strictEqual(view.profit, 180);
  assert.strictEqual(view.todayProfit, 80);
});
check('parlay and straight on different games both contribute when each is decided', () => {
  const straights = [{ status: 'loss', risk: 150, winAmt: 130 }];
  const parlay = { risk: 75, legs: [{ status: 'win', odds: '-115' }, { status: 'win', odds: '-112' }, { status: 'win', odds: '-125' }] };
  const totals = live.ledgerTotals(straights, parlay);
  assert.strictEqual(totals.wins, 0);
  assert.strictEqual(totals.losses, 1);
  assert.strictEqual(totals.parlayResult, 'win');
  assert.ok(totals.profit > -150, 'parlay win should offset part of the straight loss');
});

console.log('espn host');
check('scoreboard URLs use site.web.api and keep NFL/NCAAF dates', () => {
  const urls = scoreboardUrls('NCAAF', '2026-09-25');
  assert.ok(urls.length > 0);
  assert.ok(urls.every(u => u.startsWith('https://site.web.api.espn.com/')));
  assert.ok(urls.some(u => u.includes('groups=80')));
  assert.ok(urls.some(u => u.includes('dates=20260925')));
  const nfl = scoreboardUrls('NFL', '2026-09-25');
  assert.ok(nfl.every(u => u.includes('/football/nfl/scoreboard')));
});
check('fetch helper falls back to site.api', () => {
  assert.strictEqual(live.ESPN_API_HOST, 'https://site.api.espn.com');
  assert.ok(fs.readFileSync(path.join(__dirname, 'js/live-score.js'), 'utf8').includes('ESPN_API_HOST'));
});

console.log('pages');
for (const page of ['daily-omega/index.html', 'alpha/index.html', 'alpha/dashboard/index.html', 'nfl/index.html', 'cfb/index.html', 'circa/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
  check(page + ' ships site.web.api + shared live-score', () => {
    assert.ok(html.includes('https://site.web.api.espn.com'));
    assert.ok(!html.includes('https://site.api.espn.com'));
    assert.ok(html.includes('/js/live-score.js'));
  });
}
for (const page of ['daily-omega/index.html', 'alpha/index.html', 'nfl/index.html', 'cfb/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
  check(page + ' paints KPI from the card grades', () => {
    assert.ok(html.includes('function applyLiveKpi'));
    assert.ok(html.includes('function clientTodayLedger'));
    assert.ok(html.includes('WeBetLive.paintKpi'));
    assert.ok(html.includes('sameGradeTarget'));
    assert.ok(html.includes('resolveDoubleheader'));
  });
}
check('alpha maps NFL + NCAAF and busts KPI', () => {
  const html = fs.readFileSync(path.join(__dirname, 'alpha/index.html'), 'utf8');
  assert.ok(html.includes("'NFL': 'football/nfl'"));
  assert.ok(html.includes("'NCAAF': 'football/college-football'"));
  assert.ok(html.includes('loadResults({ bust: true })'));
  assert.ok(html.includes("push(d, '90')"));
  const dash = fs.readFileSync(path.join(__dirname, 'alpha/dashboard/index.html'), 'utf8');
  assert.ok(dash.includes("NFL:'football/nfl'"));
  assert.ok(dash.includes('college-football'));
});
check('circa discord path stays removed', () => {
  const html = fs.readFileSync(path.join(__dirname, 'circa/index.html'), 'utf8');
  const grade = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/circa-live-grade.js'), 'utf8');
  assert.ok(!/discord/i.test(html));
  assert.ok(!/discord/i.test(grade));
});
check('get-results graders share the DH helper', () => {
  for (const f of ['get-results-omega.js', 'get-results-alpha.js', 'get-results-nfl.js', 'get-results-cfb.js']) {
    const src = fs.readFileSync(path.join(__dirname, 'netlify/functions', f), 'utf8');
    assert.ok(src.includes('js/live-score'), f);
    assert.ok(!src.includes('site.api.espn.com'), f);
  }
});

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
