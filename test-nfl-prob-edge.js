#!/usr/bin/env node
// NFL v2.0-nfl-omega: the /nfl card runs Omega's EXACT engine (computeEdgeTable + gates), NFL only.
// This test exercises the integration on synthetic Odds-API-shaped input (no network / no API key).
const assert = require('assert');
const nfl = require('./netlify/functions/generate-picks-nfl-background');

let failed = 0;
function check(name, fn) {
  const run = (v) => { try { v; console.log('  ok  ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); } };
  return fn().then(() => run(true)).catch(e => { failed++; console.error('  FAIL ' + name + ': ' + e.message); });
}

function book(key, home, away, o) {
  return { key, title: key, markets: [
    { key: 'spreads', outcomes: [ { name: home, price: o.spHo, point: o.spH }, { name: away, price: o.spAo, point: -o.spH } ] },
    { key: 'totals', outcomes: [ { name: 'Over', price: o.ov, point: o.total }, { name: 'Under', price: o.un, point: o.total } ] },
    { key: 'h2h', outcomes: [ { name: home, price: o.mlH }, { name: away, price: o.mlA } ] },
  ] };
}
function game(id, home, away, line, books = ['draftkings','fanduel','betmgm','pinnacle']) {
  const o = { spH: 3, spHo: -110, spAo: -110, total: line, ov: -110, un: -110, mlH: 150, mlA: -170 };
  return { id, commence_time: '2026-11-15T18:00:00Z', home_team: home, away_team: away,
    bookmakers: books.map(k => book(k, home, away, o)) };
}
function espn(home, away, state = 'pre') {
  return { homeTeam: home, awayTeam: away, venue: 'Test Stadium, Chicago', indoor: false,
    date: '2026-11-15T18:00:00Z', homeRecord: '', awayRecord: '', state };
}

(async () => {
  console.log('\nNFL v2.0-nfl-omega (Omega engine integration)');

  await check('MODEL_VERSION is v2.0-nfl-omega', async () => {
    assert.strictEqual(nfl.MODEL_VERSION, 'v2.0-nfl-omega');
  });

  await check('buildEspnData drops started games (Omega prices pre-game only)', async () => {
    const es = nfl.buildEspnData([espn('Carolina Panthers', 'Chicago Bears', 'pre'), espn('X', 'Y', 'in')]);
    assert.strictEqual(es[0].games.length, 1);
    assert.strictEqual(es[0].games[0].home, 'Carolina Panthers');
  });

  await check('runOmegaNfl runs Omega engine and applies the 2.5% EV / 52% cover floors', async () => {
    // Weak edge (total 47 ~ projection) → below floor → rejected.
    const weak = await nfl.runOmegaNfl([espn('Carolina Panthers', 'Chicago Bears')], [game('w', 'Carolina Panthers', 'Chicago Bears', 47)], {}, {}, true);
    assert.ok(weak.selected.length === 0, 'a ~2pt total edge should not clear Omega conviction floors');
  });

  await check('a strong-edge total clears Omega floors and is selected as conviction', async () => {
    // Line 52 vs a ~47 projection → ~5pt Under edge → clears 2.5% EV + 52% cover.
    // Retail-only books (no Pinnacle) so the predCLV gate is absent (as on real games with no sharp
    // price in the feed) and the EV/cover path is what decides — Omega's exact behavior.
    const retail = ['draftkings','fanduel','betmgm','caesars'];
    const strong = await nfl.runOmegaNfl([espn('Carolina Panthers', 'Chicago Bears')], [game('s', 'Carolina Panthers', 'Chicago Bears', 52, retail)], {}, {}, true);
    assert.ok(strong.candidates.length >= 1, 'engine should produce >=1 candidate');
    assert.ok(strong.selected.length >= 1, 'strong Under should be selected');
    const picks = nfl.buildFinalPicks(strong.selected, false, 'regular');
    assert.ok(picks.every(p => !/Lean/.test(p.rating)), 'Omega football = conviction only, never Lean');
    assert.ok(picks.every(p => parseInt(p.coverProb) >= 52), 'every pick cover >= 52%');
  });

  await check('no picks when there are no pre-game games', async () => {
    const none = await nfl.runOmegaNfl([espn('A', 'B', 'in')], [], {}, {}, false);
    assert.strictEqual(none.selected.length, 0);
  });

  if (failed) { console.error('\n' + failed + ' failed'); process.exit(1); }
  console.log('\nall passed');
})();
