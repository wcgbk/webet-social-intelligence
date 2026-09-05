#!/usr/bin/env node
// Smoke checks for Omega/NFL/CFB live-score + KPI + payload-trim changes.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { ESPN_ENDPOINTS, scoreboardUrls, scoreboardDates } = require('./netlify/functions/lib/espn-scoreboard');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { cacheTtlMs, cacheControlFor, cacheIsFresh } = require('./netlify/functions/lib/kpi-cache');
const {
  formatCfbSchoolName,
  formatCfbMatchupDisplay,
  formatCfbPickDisplay,
  isCfbSport,
} = require('./netlify/functions/lib/cfb-school-name');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

console.log('espn-scoreboard');
check('NFL + NCAAF endpoints exist', () => {
  assert.strictEqual(ESPN_ENDPOINTS.NFL, 'football/nfl');
  assert.strictEqual(ESPN_ENDPOINTS.NCAAF, 'football/college-football');
  assert.strictEqual(ESPN_ENDPOINTS.MLB, 'baseball/mlb');
});
check('NCAAF URLs include groups 80 and 90 plus adjacent dates', () => {
  const urls = scoreboardUrls('NCAAF', '2026-09-05');
  assert.ok(urls.some(u => u.includes('groups=90')));
  assert.ok(urls.some(u => u.includes('groups=80')));
  assert.ok(urls.some(u => u.includes('dates=20260905')));
  assert.ok(urls.some(u => u.includes('dates=20260904')));
  assert.ok(urls.some(u => u.includes('dates=20260906')));
  assert.ok(urls.every(u => u.includes('college-football')));
});
check('NFL URLs are dated, no college groups', () => {
  const urls = scoreboardUrls('NFL', '2026-09-05');
  assert.ok(urls.length >= 3);
  assert.ok(urls.every(u => u.includes('/football/nfl/')));
  assert.ok(urls.every(u => !u.includes('groups=')));
});
check('unknown sport returns no URLs', () => {
  assert.deepStrictEqual(scoreboardUrls('XYZ', '2026-09-05'), []);
});
check('scoreboardDates spans D-1..D+1', () => {
  assert.deepStrictEqual(scoreboardDates('2026-09-05'), ['2026-09-04', '2026-09-05', '2026-09-06']);
});

console.log('cfb-school-name');
check('strips mascot, keeps school (examples + brands + apostrophes)', () => {
  const cases = [
    ['UNLV Rebels', 'UNLV'],
    ["Hawai'i Rainbow Warriors", "Hawai'i"],
    ['Hawaii Rainbow Warriors', 'Hawaii'],
    ['Western Kentucky Hilltoppers', 'Western Kentucky'],
    ['Mississippi Valley State Delta Devils', 'Mississippi Valley State'],
    ['LSU Tigers', 'LSU'],
    ['USC Trojans', 'USC'],
    ['UCF Knights', 'UCF'],
    ['Notre Dame Fighting Irish', 'Notre Dame'],
    ['Texas A&M Aggies', 'Texas A&M'],
    ['Ole Miss Rebels', 'Ole Miss'],
    ['Nevada Wolf Pack', 'Nevada'],
    ["Louisiana Ragin' Cajuns", 'Louisiana'],
    ['UNLV', 'UNLV'],
  ];
  for (const [full, school] of cases) {
    assert.strictEqual(formatCfbSchoolName(full), school, full);
  }
});
check('matchup + pick display keep Over/Under; NFL sport is not CFB', () => {
  assert.strictEqual(
    formatCfbMatchupDisplay("UNLV Rebels @ Hawai'i Rainbow Warriors"),
    "UNLV vs Hawai'i"
  );
  assert.strictEqual(formatCfbPickDisplay('UNLV Rebels -3.5'), 'UNLV -3.5');
  assert.strictEqual(formatCfbPickDisplay('Western Kentucky Hilltoppers +7'), 'Western Kentucky +7');
  assert.strictEqual(formatCfbPickDisplay('Over 55.5'), 'Over 55.5');
  assert.strictEqual(formatCfbPickDisplay('LSU Tigers ML'), 'LSU ML');
  assert.strictEqual(isCfbSport('NCAAF'), true);
  assert.strictEqual(isCfbSport('NFL'), false);
  assert.strictEqual(isCfbSport('MLB'), false);
});

console.log('public-picks');
check('strips candidateTable / thinkingText / rejections fat', () => {
  const fat = {
    date: '2026-09-05',
    picks: [{ pick: 'Over 7', sport: 'MLB', matchup: 'DET @ CLE', kellyCalc: 'secret', zScore: 1.2, whatLoses: 'x', coreReasoning: 'edge' }],
    candidateTable: [{ rank: 1 }],
    thinkingText: 'long',
    modelProjections: { a: 1 },
    rejections: [{ reason: 'no' }],
    parlayLegs: [{ type: '3-leg', combinedOdds: '+600', legs: [{ pick: 'Under 55.5', sport: 'NCAAF', kellyCalc: 'no' }] }],
  };
  const pub = publicPicksPayload(fat);
  assert.strictEqual(pub.picks[0].pick, 'Over 7');
  assert.strictEqual(pub.picks[0].coreReasoning, 'edge');
  assert.strictEqual(pub.picks[0].kellyCalc, undefined);
  assert.strictEqual(pub.picks[0].zScore, undefined);
  assert.strictEqual(pub.candidateTable, undefined);
  assert.strictEqual(pub.thinkingText, undefined);
  assert.deepStrictEqual(pub.rejections, []);
  assert.strictEqual(pub.parlayLegs[0].combinedOdds, '+600');
  assert.strictEqual(pub.parlayLegs[0].legs[0].pick, 'Under 55.5');
  assert.strictEqual(pub.parlayLegs[0].legs[0].kellyCalc, undefined);
});
check('NCAAF gets school-only display fields; pick/matchup stay full for ESPN match', () => {
  const pub = publicPicksPayload({
    picks: [{
      pick: 'UNLV Rebels -3.5',
      matchup: "UNLV Rebels @ Hawai'i Rainbow Warriors",
      sport: 'NCAAF',
      odds: '-110',
    }],
    parlayLegs: [{
      type: '3-leg',
      legs: [{ pick: 'Western Kentucky Hilltoppers +3.5', sport: 'NCAAF', matchup: 'Western Kentucky Hilltoppers vs. Nevada Wolf Pack' }],
    }],
  });
  assert.strictEqual(pub.picks[0].pick, 'UNLV Rebels -3.5');
  assert.strictEqual(pub.picks[0].matchup, "UNLV Rebels @ Hawai'i Rainbow Warriors");
  assert.strictEqual(pub.picks[0].pickDisplay, 'UNLV -3.5');
  assert.strictEqual(pub.picks[0].matchupDisplay, "UNLV vs Hawai'i");
  assert.strictEqual(pub.parlayLegs[0].legs[0].pick, 'Western Kentucky Hilltoppers +3.5');
  assert.strictEqual(pub.parlayLegs[0].legs[0].pickDisplay, 'Western Kentucky +3.5');
  assert.strictEqual(pub.parlayLegs[0].legs[0].matchupDisplay, 'Western Kentucky vs Nevada');
});
check('NFL pick names are not rewritten', () => {
  const pub = publicPicksPayload({
    picks: [{ pick: 'Kansas City Chiefs -3.5', matchup: 'Kansas City Chiefs vs. Buffalo Bills', sport: 'NFL' }],
    parlayLegs: [],
  });
  assert.strictEqual(pub.picks[0].pick, 'Kansas City Chiefs -3.5');
  assert.strictEqual(pub.picks[0].matchup, 'Kansas City Chiefs vs. Buffalo Bills');
  assert.strictEqual(pub.picks[0].pickDisplay, undefined);
  assert.strictEqual(pub.picks[0].matchupDisplay, undefined);
});

console.log('kpi-cache');
check('pending TTL is 30s, settled is 5 min', () => {
  const pending = { cumulative: { pending: 2 }, days: [{ pending: 2, parlayResult: 'pending' }], cachedAt: Date.now() };
  const settled = { cumulative: { pending: 0 }, days: [{ pending: 0, parlayResult: 'win' }], cachedAt: Date.now() };
  assert.strictEqual(cacheTtlMs(pending), 30000);
  assert.strictEqual(cacheTtlMs(settled), 300000);
  assert.ok(cacheControlFor(pending).includes('max-age=30'));
  assert.ok(cacheControlFor(settled).includes('max-age=300'));
  assert.strictEqual(cacheIsFresh(pending, { queryStringParameters: { refresh: '1' } }), false);
  assert.strictEqual(cacheIsFresh(settled, { queryStringParameters: {} }), true);
});

console.log('pages + graders');
for (const page of ['daily-omega/index.html', 'nfl/index.html', 'cfb/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
  check(page + ' maps NFL + NCAAF', () => {
    assert.ok(html.includes("'NFL': 'football/nfl'"));
    assert.ok(html.includes("'NCAAF': 'football/college-football'"));
    assert.ok(html.includes("groups=' + groups"));
    assert.ok(html.includes('pick-score-bar'));
    assert.ok(html.includes('pick-footer'));
    assert.ok(html.includes('@media (max-width: 400px)'));
    assert.ok(html.includes('refresh=1'));
    assert.ok(!html.includes("cache: 'no-store'"));
  });
}
check('get-results-omega KPI_START + v3 cache + NCAAF school match', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-omega.js'), 'utf8');
  assert.ok(src.includes('KPI_START = "2026-09-05"'));
  assert.ok(src.includes('results-omega-cache-v3'));
  assert.ok(src.includes("sport === 'NCAAF'"));
  assert.ok(src.includes("require('./lib/espn-scoreboard')"));
});
check('v11.2 F5 flag untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
  assert.ok(src.includes('const ALLOW_F5_ON_CARD = false'));
});
for (const page of ['daily-omega/index.html', 'cfb/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
  check(page + ' hamburger nav at phone + tablet', () => {
    assert.ok(html.includes('@media (max-width: 900px)'));
    assert.ok(html.includes('.header-dash { display: none; }'));
    assert.ok(html.includes('class="header-dash"'));
    assert.ok(html.includes('class="mobile-menu-btn"'));
    assert.ok(html.includes('id="mobileDropdown"'));
    assert.ok(!html.includes('.header-nav { display: flex; gap: .5rem; align-items: center; flex-wrap: nowrap; overflow-x: auto; }'));
  });
}
for (const page of ['daily-omega/index.html', 'cfb/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
  check(page + ' CFB school-only display, full names for match keys', () => {
    assert.ok(html.includes('function formatCfbSchoolName'));
    assert.ok(html.includes('function displayPick'));
    assert.ok(html.includes("data-wb-pick=\"${esc(p.pick)}\""));
    assert.ok(html.includes('function teamsMatch'));
    assert.ok(html.includes('function findGame'));
    assert.ok(html.includes('function schoolKey'));
  });
}
check('nfl/index.html does not use CFB school-only formatter', () => {
  const html = fs.readFileSync(path.join(__dirname, 'nfl/index.html'), 'utf8');
  assert.ok(!html.includes('function formatCfbSchoolName'));
  assert.ok(!html.includes('function displayPick'));
});
check('nfl/index.html hamburger nav at phone widths (no header overflow)', () => {
  const html = fs.readFileSync(path.join(__dirname, 'nfl/index.html'), 'utf8');
  assert.ok(html.includes('@media (max-width: 640px)'));
  assert.ok(html.includes('.header-dash { display: none; }'));
  assert.ok(html.includes('class="header-dash"'));
  assert.ok(html.includes('class="header-auth"'));
  assert.ok(html.includes('class="mobile-menu-btn"'));
  assert.ok(html.includes('id="mobileDropdown"'));
  assert.ok(!html.includes('overflow-x: auto'));
  assert.ok(!html.includes('margin-left:auto;margin-right:8px;">Dashboard</a>'));
});

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
